import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { BrainError } from "../domain/logic.ts";
import { canonical } from "../domain/logic.ts";

/**
 * Closed schema variants for the B0 billing authority.
 *
 * This module owns both constant DDL strings and their reference catalogs. It is the
 * single source of the journal DDL (re-exported by `billing-journal.ts` for existing
 * callers) and of the full authority DDL. No constructor here executes DDL; fixtures
 * alone install it into their own disposable database. There is no B1 inbox or checkout
 * table.
 */

export const BILLING_JOURNAL_DDL = `
CREATE TABLE IF NOT EXISTS control_billing_log(
  epoch INTEGER NOT NULL CHECK(epoch>=1),
  ordinal INTEGER NOT NULL CHECK(ordinal>=0),
  frame_json TEXT NOT NULL,
  mac TEXT NOT NULL,
  PRIMARY KEY(epoch,ordinal));
CREATE TABLE IF NOT EXISTS control_billing_head(
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  epoch INTEGER NOT NULL CHECK(epoch>=1),
  ordinal INTEGER NOT NULL CHECK(ordinal>=0),
  mac TEXT NOT NULL,
  FOREIGN KEY(epoch,ordinal) REFERENCES control_billing_log(epoch,ordinal));
CREATE TRIGGER IF NOT EXISTS control_billing_log_no_update BEFORE UPDATE ON control_billing_log
  BEGIN SELECT RAISE(ABORT,'managed billing journal is immutable'); END;
CREATE TRIGGER IF NOT EXISTS control_billing_log_no_delete BEFORE DELETE ON control_billing_log
  BEGIN SELECT RAISE(ABORT,'managed billing journal is immutable'); END;
`;

export const BILLING_AUTHORITY_DDL = `${BILLING_JOURNAL_DDL}
CREATE TABLE IF NOT EXISTS control_billing_policy(
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  policy_json TEXT NOT NULL,
  policy_digest TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS control_billing_account(
  account_id TEXT PRIMARY KEY REFERENCES managed_accounts(id),
  binding_json TEXT NOT NULL,
  binding_digest TEXT NOT NULL,
  admission_ordinal INTEGER NOT NULL,
  adverse_generation INTEGER NOT NULL CHECK(adverse_generation>=0));
CREATE TABLE IF NOT EXISTS control_billing_terms(
  term_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES managed_accounts(id),
  receipt_json TEXT NOT NULL,
  receipt_digest TEXT NOT NULL UNIQUE,
  epoch INTEGER NOT NULL CHECK(epoch>=1),
  journal_ordinal INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(epoch,journal_ordinal) REFERENCES control_billing_log(epoch,ordinal));
CREATE TRIGGER IF NOT EXISTS control_billing_terms_no_update BEFORE UPDATE ON control_billing_terms
  BEGIN SELECT RAISE(ABORT,'managed billing terms are immutable'); END;
CREATE TRIGGER IF NOT EXISTS control_billing_terms_no_delete BEFORE DELETE ON control_billing_terms
  BEGIN SELECT RAISE(ABORT,'managed billing terms are immutable'); END;
CREATE TABLE IF NOT EXISTS control_billing_period(
  grant_id TEXT PRIMARY KEY,
  window_id TEXT NOT NULL UNIQUE,
  period_id TEXT NOT NULL UNIQUE REFERENCES managed_account_periods(period_id),
  account_id TEXT NOT NULL REFERENCES managed_accounts(id),
  term_id TEXT NOT NULL REFERENCES control_billing_terms(term_id),
  epoch INTEGER NOT NULL CHECK(epoch>=1),
  journal_ordinal INTEGER NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  allowance_micro_usd INTEGER NOT NULL CHECK(allowance_micro_usd>=0),
  FOREIGN KEY(epoch,journal_ordinal) REFERENCES control_billing_log(epoch,ordinal));
CREATE TRIGGER IF NOT EXISTS control_billing_period_no_update BEFORE UPDATE ON control_billing_period
  BEGIN SELECT RAISE(ABORT,'managed billing grants are immutable'); END;
CREATE TRIGGER IF NOT EXISTS control_billing_period_no_delete BEFORE DELETE ON control_billing_period
  BEGIN SELECT RAISE(ABORT,'managed billing grants are immutable'); END;
CREATE TABLE IF NOT EXISTS control_billing_freshness(
  account_id TEXT PRIMARY KEY REFERENCES managed_accounts(id),
  term_id TEXT NOT NULL REFERENCES control_billing_terms(term_id),
  observation_json TEXT NOT NULL,
  frame_json TEXT NOT NULL,
  mac TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>=1),
  adverse_generation INTEGER NOT NULL CHECK(adverse_generation>=0));
CREATE TABLE IF NOT EXISTS control_billing_denials(
  observation_digest TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES managed_accounts(id),
  observation_json TEXT NOT NULL,
  epoch INTEGER NOT NULL CHECK(epoch>=1),
  journal_ordinal INTEGER NOT NULL,
  FOREIGN KEY(epoch,journal_ordinal) REFERENCES control_billing_log(epoch,ordinal));
CREATE TRIGGER IF NOT EXISTS control_billing_denials_no_update BEFORE UPDATE ON control_billing_denials
  BEGIN SELECT RAISE(ABORT,'managed billing denials are immutable'); END;
CREATE TRIGGER IF NOT EXISTS control_billing_denials_no_delete BEFORE DELETE ON control_billing_denials
  BEGIN SELECT RAISE(ABORT,'managed billing denials are immutable'); END;
`;

const NAMESPACE_PREFIX = "control_billing_";
const JOURNAL_TABLES = ["control_billing_log", "control_billing_head"] as const;
const AUTHORITY_TABLES = [
  ...JOURNAL_TABLES,
  "control_billing_policy",
  "control_billing_account",
  "control_billing_terms",
  "control_billing_period",
  "control_billing_freshness",
  "control_billing_denials",
] as const;

/**
 * The six T3 integration tables. They compose with the frozen standalone authority
 * variant; the authority DDL above is never widened, so existing accepted digests
 * and the 430 standalone tests stay byte-identical.
 */
export const BILLING_INTEGRATION_DDL = `
CREATE TABLE IF NOT EXISTS control_billing_install(
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  schema INTEGER NOT NULL CHECK(schema=1), version INTEGER NOT NULL CHECK(version=5),
  nonfunding INTEGER NOT NULL CHECK(nonfunding=1),
  offline INTEGER NOT NULL CHECK(offline=1), workers_terminated INTEGER NOT NULL CHECK(workers_terminated=1),
  installed_at TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS control_billing_install_immutable
  BEFORE UPDATE ON control_billing_install BEGIN SELECT RAISE(ABORT,'billing install is immutable'); END;
CREATE TABLE IF NOT EXISTS control_billing_enrollment(
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  schema INTEGER NOT NULL, version INTEGER NOT NULL,
  epoch INTEGER NOT NULL CHECK(epoch>=1), root_nonce TEXT NOT NULL CHECK(length(root_nonce)=64),
  policy_digest TEXT NOT NULL CHECK(length(policy_digest)=64),
  key_commitment TEXT NOT NULL CHECK(length(key_commitment)=64),
  mode TEXT NOT NULL CHECK(mode IN ('sandbox','live')),
  baseline_digest TEXT NOT NULL CHECK(length(baseline_digest)=64),
  roster_digest TEXT NOT NULL CHECK(length(roster_digest)=64),
  enrollment_digest TEXT NOT NULL CHECK(length(enrollment_digest)=64),
  enrolled_at TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS control_billing_enrollment_immutable
  BEFORE UPDATE ON control_billing_enrollment BEGIN SELECT RAISE(ABORT,'billing enrollment is immutable'); END;
CREATE TABLE IF NOT EXISTS control_billing_manual_baseline(
  account_id TEXT PRIMARY KEY REFERENCES managed_accounts(id),
  config_digest TEXT NOT NULL CHECK(length(config_digest)=64),
  baseline_digest TEXT NOT NULL CHECK(length(baseline_digest)=64),
  captured_at TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS control_billing_manual_baseline_immutable
  BEFORE UPDATE ON control_billing_manual_baseline BEGIN SELECT RAISE(ABORT,'billing manual baseline is immutable'); END;
CREATE TABLE IF NOT EXISTS control_billing_preflight(
  preflight_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES managed_accounts(id),
  incarnation TEXT NOT NULL CHECK(length(incarnation)=64),
  provisioning_generation INTEGER NOT NULL CHECK(provisioning_generation>=1),
  identity_digest TEXT NOT NULL CHECK(length(identity_digest)=64),
  binding_digest TEXT NOT NULL CHECK(length(binding_digest)=64),
  binding_json TEXT NOT NULL,
  baseline_json TEXT NOT NULL,
  policy_id TEXT NOT NULL, policy_digest TEXT NOT NULL CHECK(length(policy_digest)=64),
  root_epoch INTEGER NOT NULL CHECK(root_epoch>=1), root_nonce TEXT NOT NULL CHECK(length(root_nonce)=64),
  proof_json TEXT NOT NULL, proof_mac TEXT NOT NULL CHECK(length(proof_mac)=64),
  mode TEXT NOT NULL CHECK(mode IN ('sandbox','live')),
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  consumed_at TEXT, admission_ordinal INTEGER,
  UNIQUE(account_id, incarnation, provisioning_generation));
CREATE TRIGGER IF NOT EXISTS control_billing_preflight_frozen
  BEFORE UPDATE ON control_billing_preflight
  WHEN NEW.preflight_id<>OLD.preflight_id OR NEW.account_id<>OLD.account_id
    OR NEW.incarnation<>OLD.incarnation OR NEW.provisioning_generation<>OLD.provisioning_generation
    OR NEW.binding_digest<>OLD.binding_digest OR NEW.binding_json<>OLD.binding_json
    OR NEW.proof_json<>OLD.proof_json OR NEW.proof_mac<>OLD.proof_mac OR NEW.created_at<>OLD.created_at
    OR (OLD.consumed_at IS NOT NULL AND NEW.consumed_at<>OLD.consumed_at)
  BEGIN SELECT RAISE(ABORT,'billing preflight is immutable'); END;
CREATE TABLE IF NOT EXISTS managed_account_incarnation(
  account_id TEXT PRIMARY KEY REFERENCES managed_accounts(id),
  incarnation TEXT NOT NULL CHECK(length(incarnation)=64),
  provisioning_generation INTEGER NOT NULL CHECK(provisioning_generation>=1),
  source TEXT NOT NULL CHECK(source IN ('provision','restore','rebuild','enroll')),
  minted_at TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS managed_account_incarnation_monotonic
  BEFORE UPDATE ON managed_account_incarnation
  WHEN NEW.account_id<>OLD.account_id OR NEW.provisioning_generation<=OLD.provisioning_generation
    OR length(NEW.incarnation)<>64
  BEGIN SELECT RAISE(ABORT,'account incarnation must advance monotonically'); END;
CREATE TABLE IF NOT EXISTS managed_account_fence(
  account_id TEXT PRIMARY KEY REFERENCES managed_accounts(id),
  generation INTEGER NOT NULL CHECK(generation>=1),
  reason TEXT NOT NULL CHECK(reason IN ('rebuild','restore','replace')),
  fenced_at TEXT NOT NULL, cleared_at TEXT);
CREATE TABLE IF NOT EXISTS control_billing_reservation(
  call_id TEXT PRIMARY KEY REFERENCES managed_reservations(call_id),
  account_id TEXT NOT NULL REFERENCES managed_accounts(id),
  epoch INTEGER NOT NULL CHECK(epoch>=1),
  admission_ordinal INTEGER NOT NULL,
  tenant_incarnation TEXT NOT NULL CHECK(length(tenant_incarnation)=64),
  provisioning_generation INTEGER NOT NULL CHECK(provisioning_generation>=1),
  term_id TEXT NOT NULL,
  window_id TEXT NOT NULL,
  period_id TEXT NOT NULL,
  grant_ordinal INTEGER NOT NULL,
  grant_mac TEXT NOT NULL CHECK(length(grant_mac)=64),
  root_nonce TEXT NOT NULL CHECK(length(root_nonce)=64),
  policy_digest TEXT NOT NULL CHECK(length(policy_digest)=64),
  binding_digest TEXT NOT NULL CHECK(length(binding_digest)=64),
  reservation_identity_hash TEXT NOT NULL,
  proof_json TEXT NOT NULL,
  proof_mac TEXT NOT NULL CHECK(length(proof_mac)=64),
  created_at TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS control_billing_reservation_no_update
  BEFORE UPDATE ON control_billing_reservation
  BEGIN SELECT RAISE(ABORT,'billing reservation proofs are immutable'); END;
CREATE TRIGGER IF NOT EXISTS control_billing_reservation_no_delete
  BEFORE DELETE ON control_billing_reservation
  BEGIN SELECT RAISE(ABORT,'billing reservation proofs are immutable'); END;
`;

/** The full reviewed v5 install text: the frozen authority namespace plus integration. */
export const BILLING_INTEGRATED_DDL = `${BILLING_AUTHORITY_DDL}${BILLING_INTEGRATION_DDL}`;

const INTEGRATION_TABLES = [
  ...AUTHORITY_TABLES,
  "control_billing_install",
  "control_billing_enrollment",
  "control_billing_manual_baseline",
  "control_billing_preflight",
  "control_billing_reservation",
  "managed_account_incarnation",
  "managed_account_fence",
] as const;

/** Non-`control_billing_` control tables that participate in the integrated catalog. */
const INTEGRATION_OBJECT_NAMES = new Set([
  "managed_account_incarnation",
  "managed_account_fence",
]);

export type BillingSchemaVariant = "journal" | "authority" | "integrated" | "unknown";

const corrupt = (message = "The billing schema does not match a frozen shape.") =>
  new BrainError("UNAVAILABLE", message, 503);

interface MasterRow {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

function namespaceObjects(db: DatabaseSync, variant: "journal" | "authority" | "integrated"): unknown[] {
  const rows = db
    .prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE type IN ('table','index','trigger','view') ORDER BY type,name",
    )
    .all() as unknown as MasterRow[];
  const extra =
    variant === "integrated" ? INTEGRATION_OBJECT_NAMES : new Set<string>();
  return rows
    .filter(
      (row) =>
        row.name.startsWith(NAMESPACE_PREFIX) ||
        row.tbl_name.startsWith(NAMESPACE_PREFIX) ||
        extra.has(row.name) ||
        extra.has(row.tbl_name),
    )
    .map((row) => ({ type: row.type, name: row.name, tbl_name: row.tbl_name, sql: row.sql }));
}

function tableDetails(db: DatabaseSync, name: string): unknown {
  return {
    name,
    columns: db.prepare(`PRAGMA table_info(${name})`).all(),
    indexes: db.prepare(`PRAGMA index_list(${name})`).all(),
    foreign_keys: db.prepare(`PRAGMA foreign_key_list(${name})`).all(),
  };
}

function catalogOf(db: DatabaseSync, variant: "journal" | "authority" | "integrated"): string {
  const tables =
    variant === "journal"
      ? JOURNAL_TABLES
      : variant === "authority"
        ? AUTHORITY_TABLES
        : INTEGRATION_TABLES;
  return canonical({
    objects: namespaceObjects(db, variant),
    tables: tables.map((name) => tableDetails(db, name)),
  });
}

const referenceCache = new Map<"journal" | "authority" | "integrated", string>();

function referenceCatalog(variant: "journal" | "authority" | "integrated"): string {
  const cached = referenceCache.get(variant);
  if (cached !== undefined) return cached;
  const reference = new DatabaseSync(":memory:");
  try {
    reference.exec(
      variant === "journal"
        ? BILLING_JOURNAL_DDL
        : variant === "authority"
          ? BILLING_AUTHORITY_DDL
          : BILLING_INTEGRATED_DDL,
    );
    const catalog = catalogOf(reference, variant);
    referenceCache.set(variant, catalog);
    return catalog;
  } finally {
    reference.close();
  }
}

function matches(db: DatabaseSync, variant: "journal" | "authority" | "integrated"): boolean {
  return catalogOf(db, variant) === referenceCatalog(variant);
}

export function billingSchemaVariant(db: DatabaseSync): BillingSchemaVariant {
  if (matches(db, "journal")) return "journal";
  if (matches(db, "authority")) return "authority";
  if (matches(db, "integrated")) return "integrated";
  return "unknown";
}

function digest(db: DatabaseSync, variant: "journal" | "authority" | "integrated"): string {
  const catalog = catalogOf(db, variant);
  if (catalog !== referenceCatalog(variant)) throw corrupt();
  return createHash("sha256").update(catalog).digest("hex");
}

export function billingJournalSchemaDigest(db: DatabaseSync): string {
  return digest(db, "journal");
}

export function billingAuthoritySchemaDigest(db: DatabaseSync): string {
  return digest(db, "authority");
}

export function billingIntegratedSchemaDigest(db: DatabaseSync): string {
  return digest(db, "integrated");
}

export { NAMESPACE_PREFIX };
