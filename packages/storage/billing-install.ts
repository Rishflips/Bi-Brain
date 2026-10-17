import type { DatabaseSync } from "node:sqlite";
import { DatabaseSync as Sqlite } from "node:sqlite";
import { assertExactKeys, invalid, isPlainObject } from "../domain/billing-authority.ts";
import { BrainError, canonical } from "../domain/logic.ts";
import { ControlStore } from "./control.ts";
import {
  BILLING_INTEGRATED_DDL,
  billingSchemaVariant,
} from "./billing-schema.ts";
import { MONEY_LEGACY_DDL } from "./managed-spending.ts";
import { assertTrustedManagedRoot } from "../runtime/managed-operator.ts";

const LEGACY_MONEY_TABLES = [
  "managed_account_periods",
  "managed_service_policy",
  "managed_account_policy",
  "managed_reservations",
  "managed_service_blocks",
  "managed_money_blocks",
  "managed_resolutions",
  "managed_control_epoch",
  "managed_audits",
  "managed_audit_accounts",
  "managed_audit_rows",
  "managed_activation",
  "managed_decision_activation",
  "managed_decision_activation_events",
] as const;

/**
 * Explicit, offline, non-funding money 4 -> 5 installation.
 *
 * This is the ONLY path to the billing (v5) schema. The normal
 * `ManagedSpendingStore` constructor never promotes a genuine v4 database. The two
 * acknowledgements are required attestations; they are necessary, not proof that
 * old workers ended. The install writes the full reviewed v5 DDL plus one durable
 * non-funding install record and the version marker. It mints NO key, policy,
 * admission, enrollment anchor or generation row, so an installed root stays
 * non-funding until a separately reviewed offline enrollment exists.
 */

const INSTALL_KEYS = ["control", "root", "offline", "workers_terminated"] as const;
const unavailable = (message: string) => new BrainError("UNAVAILABLE", message, 503);

/** The full reviewed v5 install text: the frozen v4 money tables plus integration. */
export const BILLING_MONEY_V5_DDL = `${MONEY_LEGACY_DDL}${BILLING_INTEGRATED_DDL}`;

export interface InstallBillingMoney5Input {
  control: ControlStore;
  root: string;
  offline: boolean;
  workers_terminated: boolean;
}

export function verifyBillingMoney5Schema(db: DatabaseSync): void {
  if (billingSchemaVariant(db) !== "integrated")
    throw unavailable(
      "The managed billing schema is not the strict integrated variant; refusing to heal it.",
    );
  assertExactLegacyMoneySchema(db, true);
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return !!db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?")
    .get(name);
}

function installedVersion(db: DatabaseSync): { version: number; present: boolean } {
  if (!tableExists(db, "managed_money_schema")) return { version: 0, present: false };
  const row = db
    .prepare("SELECT max(version) AS version FROM managed_money_schema")
    .get() as { version: number | null } | undefined;
  return { version: Number(row?.version ?? 0), present: true };
}

/**
 * The complete frozen catalog of the legacy money tables: columns (name/type/not-null/
 * default/pk), foreign keys and triggers. A missing immutable-money trigger, an added
 * column, a changed FK or a type change all diverge. The reference is the frozen DDL in an
 * in-memory database, never a self-asserted constant.
 */
function moneyCatalog(db: DatabaseSync): string {
  const placeholders = LEGACY_MONEY_TABLES.map(() => "?").join(",");
  return canonical({
    tables: LEGACY_MONEY_TABLES.map((name) => ({
      name,
      columns: db.prepare(`PRAGMA table_info(${name})`).all(),
      foreign_keys: db.prepare(`PRAGMA foreign_key_list(${name})`).all(),
    })),
    triggers: db
      .prepare(
        `SELECT name,tbl_name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name IN (${placeholders}) ORDER BY name`,
      )
      .all(...LEGACY_MONEY_TABLES),
  });
}

function assertExactLegacyMoneySchema(db: DatabaseSync, allowBillingNamespace: boolean): void {
  if (
    !allowBillingNamespace &&
    db
      .prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type IN ('table','trigger','index','view') AND (name LIKE 'control_billing_%' OR tbl_name LIKE 'control_billing_%') LIMIT 1",
      )
      .get()
  )
    throw unavailable("The billing schema already exists under a different version.");
  for (const table of LEGACY_MONEY_TABLES)
    if (!tableExists(db, table))
      throw new BrainError(
        "INVALID_INPUT",
        "The billing money-5 install requires an exact v4 managed money schema.",
        400,
      );
  const reference = new Sqlite(":memory:");
  try {
    reference.exec(MONEY_LEGACY_DDL);
    if (moneyCatalog(db) !== moneyCatalog(reference))
      throw new BrainError(
        "INVALID_INPUT",
        "The managed money schema does not match the frozen v4 shape.",
        400,
      );
  } finally {
    reference.close();
  }
}

export function installBillingMoney5(input: InstallBillingMoney5Input): {
  version: 5;
  installed_at: string;
  nonfunding: true;
} {
  if (!isPlainObject(input)) invalid("The billing money-5 install request is required.");
  assertExactKeys(input, INSTALL_KEYS);
  const { control, root, offline, workers_terminated } = input as unknown as {
    control: ControlStore;
    root: string;
    offline: unknown;
    workers_terminated: unknown;
  };
  if (offline !== true || workers_terminated !== true)
    invalid(
      "The billing money-5 install requires explicit offline and workers-terminated acknowledgements.",
    );
  if (!control || typeof control !== "object" || !control.db)
    invalid("The billing money-5 install requires a control store.");
  assertTrustedManagedRoot(root, control.path);
  const db = control.db;
  // A caller-owned transaction is left completely untouched: refuse BEFORE any BEGIN.
  if (db.isTransaction)
    throw new BrainError(
      "INVALID_INPUT",
      "The billing money-5 install cannot run inside a caller-owned transaction.",
      409,
    );

  const now = control.clock().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = installedVersion(db);
    if (current.version === 5) {
      const row = db
        .prepare("SELECT installed_at FROM control_billing_install WHERE singleton=1")
        .get() as { installed_at: string } | undefined;
      if (!row) throw unavailable("The billing install record is missing.");
      verifyBillingMoney5Schema(db);
      db.exec("COMMIT");
      if (db.isTransaction)
        throw unavailable("The billing install commit was not applied.");
      return { version: 5, installed_at: row.installed_at, nonfunding: true };
    }
    if (current.version !== 4)
      throw new BrainError(
        "INVALID_INPUT",
        "The billing money-5 install requires an exact v4 managed money schema.",
        400,
      );
    assertExactLegacyMoneySchema(db, false);
    db.exec(BILLING_MONEY_V5_DDL);
    db.prepare(
      `INSERT INTO control_billing_install(
         singleton,schema,version,nonfunding,offline,workers_terminated,installed_at)
       VALUES(1,1,5,1,1,1,?)`,
    ).run(now);
    db.prepare("INSERT OR IGNORE INTO managed_money_schema(version,applied_at) VALUES(5,?)").run(now);
    const versionRow = installedVersion(db);
    if (versionRow.version !== 5)
      throw unavailable("The managed money schema version did not advance to 5.");
    const record = db
      .prepare("SELECT installed_at FROM control_billing_install WHERE singleton=1")
      .get() as { installed_at: string } | undefined;
    if (!record) throw unavailable("The billing install record was not written.");
    verifyBillingMoney5Schema(db);
    db.exec("COMMIT");
    if (db.isTransaction)
      throw unavailable("The billing install commit was not applied.");
    return { version: 5, installed_at: record.installed_at, nonfunding: true };
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}
