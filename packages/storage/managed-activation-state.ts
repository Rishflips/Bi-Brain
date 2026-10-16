import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BrainError, canonical } from "../domain/logic.ts";
import { managedMoneySchemaVersion } from "../domain/managed-spend.ts";
import {
  validateActivationProfile,
  type ActivationProfile,
} from "../domain/managed-activation.ts";
import { assertTrustedManagedRoot, readRootMarker, rootEpochMatches } from "../runtime/managed-operator.ts";

/**
 * Cohesive, READ-ONLY activation state primitives shared by the money store,
 * the runtime audit, the runtime activation loader and the operator store.
 *
 * It deliberately imports no store or runtime writer class (only the pure domain
 * layer and the `managed-operator` path helper, which imports no storage), so the
 * money store can use it without the money→activation→money import cycle. Nothing
 * here opens a transaction, creates a table, or mutates the filesystem.
 */

export const ACTIVATION_MIRROR_FILE = "activation.json";
const MAX_MIRROR_BYTES = 256 * 1024;

const invalid = (message: string) => new BrainError("INVALID_INPUT", message, 400);
const sha = (value: unknown): string =>
  createHash("sha256").update(canonical(value)).digest("hex");

function tableExists(db: DatabaseSync, name: string): boolean {
  return !!db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?")
    .get(name);
}

function lstatOptional(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

export function activationMirrorPath(root: string): string {
  return resolve(root, ACTIVATION_MIRROR_FILE);
}

/**
 * Reads the mirror strictly. A link, non-file, oversized, unreadable or invalid
 * profile throws; the loader catches this and treats it as a mismatch.
 */
export function readActivationMirror(root: string): ActivationProfile | undefined {
  const path = activationMirrorPath(root);
  const stat = lstatOptional(path);
  if (!stat) return undefined;
  if (stat.isSymbolicLink() || !stat.isFile())
    throw new BrainError("UNAUTHORIZED", "The activation mirror is not a real file.", 401);
  if (stat.size > MAX_MIRROR_BYTES)
    throw new BrainError("INVALID_INPUT", "The activation mirror is too large.", 400);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new BrainError("INVALID_INPUT", "The activation mirror is unreadable.", 400);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BrainError("INVALID_INPUT", "The activation mirror is not valid JSON.", 400);
  }
  return validateActivationProfile(parsed);
}

export function readActivationRow(db: DatabaseSync): ActivationProfile | undefined {
  if (!tableExists(db, "managed_activation")) return undefined;
  const row = db.prepare("SELECT * FROM managed_activation WHERE singleton=1").get() as any;
  if (!row) return undefined;
  let accepted: unknown;
  try {
    accepted = JSON.parse(String(row.accepted_response_models));
  } catch {
    throw invalid("The stored activation profile is not readable.");
  }
  return validateActivationProfile({
    schema: Number(row.schema),
    version: Number(row.version),
    enabled: Number(row.enabled) === 1,
    provider: row.provider,
    model: row.model,
    price_version: row.price_version,
    input_micro_usd_per_million: Number(row.input_micro_usd_per_million),
    output_micro_usd_per_million: Number(row.output_micro_usd_per_million),
    accepted_response_models: accepted,
    max_output_tokens: Number(row.max_output_tokens),
    endpoint_class: row.endpoint_class,
    config_digest: row.config_digest,
    audit_digest: row.audit_digest,
    audit_id: row.audit_id,
    epoch: Number(row.epoch),
    root_nonce: row.root_nonce,
    fingerprint: row.fingerprint,
    updated_at: row.updated_at,
  });
}

export function managedControlSchemaVersion(db: DatabaseSync): number {
  if (!tableExists(db, "managed_money_schema")) return 0;
  const row = db
    .prepare("SELECT max(version) AS version FROM managed_money_schema")
    .get() as { version: number | null } | undefined;
  return Number(row?.version ?? 0);
}

function columnNames(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
    (column) => column.name,
  );
}

/**
 * Closed, versioned control-schema shape used by the audit and the activation
 * guard. It is the SINGLE implementation (the audit imports it), so a column
 * added to `managed_reservations` (or any guarded table) without a version bump is
 * still detected as a shape change.
 */
function controlSchemaSignature(db: DatabaseSync): unknown {
  return {
    version: managedControlSchemaVersion(db),
    managed_reservations: columnNames(db, "managed_reservations"),
    managed_resolutions: columnNames(db, "managed_resolutions"),
    managed_control_epoch: columnNames(db, "managed_control_epoch"),
    managed_audits: columnNames(db, "managed_audits"),
    managed_audit_accounts: columnNames(db, "managed_audit_accounts"),
    managed_audit_rows: columnNames(db, "managed_audit_rows"),
    managed_activation: columnNames(db, "managed_activation"),
  };
}

/** Read-only digest of the live control schema shape (columns + version). */
export function centralSchemaDigest(db: DatabaseSync): string {
  return sha(controlSchemaSignature(db));
}

/** Digest of the WHOLE chosen stored audit (row + ordered accounts + rows). */
export function activationAuditDigest(
  db: DatabaseSync,
  auditId: string,
): string | undefined {
  if (!tableExists(db, "managed_audits")) return undefined;
  const audit = db.prepare("SELECT * FROM managed_audits WHERE audit_id=?").get(auditId) as any;
  if (!audit) return undefined;
  const accounts = (
    db
      .prepare(
        "SELECT account_id,config_digest,baseline_digest,financial_digest FROM managed_audit_accounts WHERE audit_id=? ORDER BY account_id",
      )
      .all(auditId) as any[]
  ).map((row) => ({
    account_id: String(row.account_id),
    config_digest: String(row.config_digest),
    baseline_digest: String(row.baseline_digest),
    financial_digest: String(row.financial_digest),
  }));
  const rows = (
    db
      .prepare(
        "SELECT account_id,call_id,central_digest,tenant_digest FROM managed_audit_rows WHERE audit_id=? ORDER BY account_id,call_id",
      )
      .all(auditId) as any[]
  ).map((row) => ({
    account_id: String(row.account_id),
    call_id: String(row.call_id),
    central_digest: String(row.central_digest),
    tenant_digest: String(row.tenant_digest),
  }));
  return sha({
    audit: {
      audit_id: String(audit.audit_id),
      epoch: Number(audit.epoch),
      control_schema_version: Number(audit.control_schema_version),
      config_digest: String(audit.config_digest),
      schema_digest: String(audit.schema_digest),
      inventory_digest: String(audit.inventory_digest),
      baseline_digest: String(audit.baseline_digest),
      root_nonce: String(audit.root_nonce),
      created_at: String(audit.created_at),
    },
    accounts,
    rows,
  });
}

export function activationControlConfigDigest(db: DatabaseSync): string {
  const accounts = db
    .prepare("SELECT id,state,issuer,subject FROM managed_accounts ORDER BY id")
    .all() as { id: string; state: string; issuer: string; subject: string }[];
  const globalHashes = accounts
    .map((account) => ({ account_id: account.id, config_hash: accountConfigHash(db, account) }))
    .sort((a, b) => a.account_id.localeCompare(b.account_id));
  return sha({ service: servicePolicy(db), accounts: globalHashes });
}

function servicePolicy(
  db: DatabaseSync,
): { daily_micro_usd: number; version: number } | null {
  if (!tableExists(db, "managed_service_policy")) return null;
  const row = db
    .prepare(
      "SELECT daily_micro_usd,version FROM managed_service_policy WHERE service='managed-processing'",
    )
    .get() as { daily_micro_usd: number; version: number } | undefined;
  return row
    ? { daily_micro_usd: Number(row.daily_micro_usd), version: Number(row.version) }
    : null;
}

function accountConfigHash(
  db: DatabaseSync,
  account: { id: string; state: string; issuer: string; subject: string },
): string {
  const policy = db
    .prepare("SELECT per_job_micro_usd,user_daily_micro_usd FROM managed_account_policy WHERE account_id=?")
    .get(account.id) as any;
  const periods = db
    .prepare(
      "SELECT period_id,starts_at,ends_at,allowance_micro_usd,state FROM managed_account_periods WHERE account_id=? ORDER BY starts_at,period_id",
    )
    .all(account.id) as any[];
  return sha({
    account_id: account.id,
    issuer: account.issuer,
    subject: account.subject,
    state: account.state,
    policy: policy
      ? {
          per_job_micro_usd: Number(policy.per_job_micro_usd),
          user_daily_micro_usd: Number(policy.user_daily_micro_usd),
        }
      : null,
    periods: periods.map((period) => ({
      period_id: period.period_id,
      starts_at: period.starts_at,
      ends_at: period.ends_at,
      allowance_micro_usd: Number(period.allowance_micro_usd),
      state: period.state,
    })),
  });
}

function blockSignature(db: DatabaseSync): unknown {
  const money = tableExists(db, "managed_money_blocks")
    ? (db.prepare("SELECT key,reason,at FROM managed_money_blocks ORDER BY key").all() as any[]).map(
        (row) => ({ key: row.key, reason: row.reason, at: row.at }),
      )
    : [];
  const service = tableExists(db, "managed_service_blocks")
    ? (
        db
          .prepare("SELECT service,call_id,account_id,over_micro_usd,at FROM managed_service_blocks ORDER BY service")
          .all() as any[]
      ).map((row) => ({
        service: row.service,
        call_id: row.call_id,
        account_id: row.account_id,
        over_micro_usd: Number(row.over_micro_usd),
        at: row.at,
      }))
    : [];
  return { money, service };
}

const CENTRAL_FIELDS = [
  "account_id", "job_id", "dispatch_key", "stage", "state", "reserved_micro_usd",
  "actual_micro_usd", "content_hash", "identity_hash", "account_period_id", "service",
  "service_day", "user_day", "accounting_tz", "stored_per_job_micro_usd",
  "stored_user_daily_micro_usd", "provider", "model", "price_version", "request_hash",
  "config_hash", "projection_call_id", "created_at", "marked_at", "settled_at",
] as const;
const CENTRAL_COLUMNS = `call_id,${CENTRAL_FIELDS.join(",")}`;

function centralRowDigest(row: any): string {
  const out: Record<string, unknown> = { source: "central" };
  for (const field of CENTRAL_FIELDS) out[field] = row[field] ?? null;
  out.reserved_micro_usd = Number(row.reserved_micro_usd);
  out.actual_micro_usd =
    row.actual_micro_usd === null || row.actual_micro_usd === undefined
      ? null
      : Number(row.actual_micro_usd);
  return sha(out);
}

/**
 * Pure, bounded central-inventory digest (schema version, service policy, blocks,
 * per-account config fingerprints and central row digests). It reads no tenant
 * database and is safe to recompute inside a write transaction.
 */
export function managedControlInventoryDigest(
  db: DatabaseSync,
  maxAccounts = 1000,
  maxRows = 100_000,
): string {
  const accounts = (
    db.prepare("SELECT id,state,issuer,subject FROM managed_accounts ORDER BY id LIMIT ?").all(
      maxAccounts + 1,
    ) as { id: string; state: string; issuer: string; subject: string }[]
  );
  const accountDigests = accounts.map((account) => {
    const central = (
      db
        .prepare(`SELECT ${CENTRAL_COLUMNS} FROM managed_reservations WHERE account_id=? ORDER BY call_id LIMIT ?`)
        .all(account.id, maxRows + 1) as any[]
    );
    return {
      account_id: account.id,
      state: account.state,
      config_hash: accountConfigHash(db, account),
      central_digests: central.map((row) => centralRowDigest(row)),
    };
  });
  return sha({
    version: managedControlSchemaVersion(db),
    service: servicePolicy(db),
    blocks: blockSignature(db),
    accounts: accountDigests,
  });
}

export type GuardSnapshot =
  | { state: "absent" }
  | { state: "mismatch" }
  | {
      state: "active";
      profile: ActivationProfile;
      epoch: { epoch: number; nonce: string };
      audit_digest: string;
      central_inventory_digest: string;
      schema_digest: string;
    };

export type ActivationReadState =
  | { state: "absent" }
  | { state: "mismatch" }
  | { state: "active"; profile: ActivationProfile };

/**
 * Full read-only guard snapshot: the SQL profile MUST match the mirror, and the
 * live epoch row/marker plus the whole-audit digest and central-inventory digest
 * are returned. Used by the money store's in-transaction seam and the loader.
 */
export function readGuardSnapshot(
  control: { db: DatabaseSync; path: string },
  root: string,
): GuardSnapshot {
  let row: ActivationProfile | undefined;
  let mirror: ActivationProfile | undefined;
  let malformed = false;
  try {
    // Fresh root/control containment on every snapshot; no DDL, no writer.
    assertTrustedManagedRoot(root, control.path);
  } catch {
    return { state: "mismatch" };
  }
  try {
    row = readActivationRow(control.db);
  } catch {
    malformed = true;
  }
  try {
    mirror = readActivationMirror(root);
  } catch {
    malformed = true;
  }
  if (malformed) return { state: "mismatch" };
  if (!row && !mirror) return { state: "absent" };
  if (!row || !mirror) return { state: "mismatch" };
  if (canonical(row) !== canonical(mirror)) return { state: "mismatch" };
  // The control schema must be the exact supported version, not a caller-chosen
  // future integer.
  if (managedControlSchemaVersion(control.db) !== managedMoneySchemaVersion)
    return { state: "mismatch" };
  const epoch = readLiveEpoch(control.db);
  if (!epoch) return { state: "mismatch" };
  let marker;
  try {
    marker = readRootMarker(root);
  } catch {
    return { state: "mismatch" };
  }
  if (!rootEpochMatches(marker, { ...epoch, rotated_at: "" })) return { state: "mismatch" };
  // The stored profile ROW must bind the live epoch, not merely the file marker.
  if (row.epoch !== epoch.epoch || row.root_nonce !== epoch.nonce)
    return { state: "mismatch" };
  const audit = activationAuditDigest(control.db, row.audit_id);
  if (!audit) return { state: "mismatch" };
  return {
    state: "active",
    profile: row,
    epoch,
    audit_digest: audit,
    central_inventory_digest: managedControlInventoryDigest(control.db),
    schema_digest: centralSchemaDigest(control.db),
  };
}

function readLiveEpoch(
  db: DatabaseSync,
): { epoch: number; nonce: string } | undefined {
  if (!tableExists(db, "managed_control_epoch")) return undefined;
  const row = db
    .prepare("SELECT epoch,nonce FROM managed_control_epoch WHERE singleton=1")
    .get() as { epoch: number; nonce: string } | undefined;
  if (!row) return undefined;
  return { epoch: Number(row.epoch), nonce: String(row.nonce) };
}

export { managedMoneySchemaVersion };
