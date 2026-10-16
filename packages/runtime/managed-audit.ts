import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BrainError, canonical } from "../domain/logic.ts";
import {
  readRootMarker,
  rootEpochMatches,
  assertTrustedManagedRoot,
} from "./managed-operator.ts";
import {
  centralSchemaDigest,
  managedControlInventoryDigest,
  managedControlSchemaVersion,
  managedMoneySchemaVersion,
} from "../storage/managed-activation-state.ts";
import type { ControlEpoch } from "../domain/managed-reconciliation.ts";
import type { DispatchStage } from "../domain/spend.ts";

/**
 * Bounded, read-only all-account managed history audit.
 *
 * It opens one validated read-only tenant database at a time (never the writable
 * `Storage`/`ManagedRuntime` acquisition path, so no migration, table, account or
 * epoch is created) after validating the tenant's provisioning marker against the
 * trusted control account. It reads only paid-journal tables plus control
 * id/hash/amount/config rows, never knowledge content, and stores only ids,
 * hashes and integer money.
 *
 * Every read is bounded (`LIMIT remaining+1`) on the central journal, the tenant
 * journal and the account inventory, and the global row budget spans all
 * accounts. The whole audit refuses on any legacy, unmapped, orphan,
 * non-terminal, mismatched, unsupported-schema or marker-mismatched state across
 * every active and suspended account. A record is written only after two complete
 * scans agree on the inventory, schema/config and file identity, and a short
 * write transaction re-reads the bounded central money/config/blocks before
 * inserting.
 */

export interface AuditControl {
  readonly db: DatabaseSync;
  readonly path: string;
}

export type AuditEvidence = "empty" | "matched";

export interface AuditAccountInventory {
  account_id: string;
  config_hash: string;
  baseline_digest: string;
}

export interface AuditInventory {
  root_epoch: number;
  control_schema_version: number;
  accounts: AuditAccountInventory[];
}

export interface AuditResult {
  ok: boolean;
  reason: string | null;
  audit_id: string | null;
  evidence: AuditEvidence;
  inventory: AuditInventory;
}

export interface AuditAccountRecord {
  account_id: string;
  config_digest: string;
  baseline_digest: string;
  financial_digest: string;
}

export interface AuditRecord {
  audit_id: string;
  epoch: number;
  control_schema_version: number;
  config_digest: string;
  schema_digest: string;
  inventory_digest: string;
  baseline_digest: string;
  root_nonce: string;
  created_at: string;
  evidence: AuditEvidence;
  accounts: AuditAccountRecord[];
}

export interface AuditValidation {
  valid: boolean;
  reason: string | null;
}

export interface AuditInput {
  root: string;
  offline: boolean;
  workers_terminated: boolean;
  control?: AuditControl;
  runtime?: { control: AuditControl };
  maxAccounts?: number;
  maxRows?: number;
  clock?: () => Date;
}

export interface AuditValidationInput {
  root: string;
  auditId: string;
  control?: AuditControl;
  runtime?: { control: AuditControl };
  maxAccounts?: number;
  maxRows?: number;
  clock?: () => Date;
}

/**
 * The exact current trusted attempt slot a scan may tolerate as nonterminal. It
 * carries BOTH central and tenant call ids; a null central id (before reserve) has
 * no representation here, so it can never widen tolerance.
 */
export interface SendGuardPermit {
  account_id: string;
  job_id: string;
  dispatch_key: string;
  stage: DispatchStage;
  central_call_id: string;
  tenant_call_id: string;
  /** The exact central state this slot may be nonterminal in. */
  state: "reserved" | "dispatched";
}

interface AuditRowDigest {
  call_id: string;
  central_digest: string;
  tenant_digest: string;
}

interface AccountScan {
  account_id: string;
  state: string;
  config_hash: string;
  baseline_digest: string;
  financial_digest: string;
  rows: AuditRowDigest[];
}

interface Scan {
  schema_version: number;
  schema_digest: string;
  config_digest: string;
  inventory_digest: string;
  baseline_digest: string;
  control_digest: string;
  file_digest: string;
  accounts: AccountScan[];
  total_rows: number;
  evidence: AuditEvidence;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DEFAULT_MAX_ACCOUNTS = 1000;
const MAX_MAX_ACCOUNTS = 10_000;
const DEFAULT_MAX_ROWS = 100_000;
const MAX_MAX_ROWS = 1_000_000;
const MAX_MARKER_BYTES = 4096;
const REQUIRED_TABLES = [
  "managed_reservations",
  "managed_control_epoch",
  "managed_audits",
  "managed_audit_accounts",
  "managed_audit_rows",
];

/**
 * Immutable central money authority fields. `managed_reservations` is the
 * authoritative record, so the baseline digest binds every retained field
 * (including the row identity hash, frozen binding and period id), not only the
 * amount.
 */
const CENTRAL_COLUMNS =
  "call_id,account_id,job_id,dispatch_key,stage,state,reserved_micro_usd,actual_micro_usd,content_hash,identity_hash,account_period_id,service,service_day,user_day,accounting_tz,stored_per_job_micro_usd,stored_user_daily_micro_usd,provider,model,price_version,request_hash,config_hash,projection_call_id,created_at,marked_at,settled_at";
const CENTRAL_FIELDS = [
  "account_id",
  "job_id",
  "dispatch_key",
  "stage",
  "state",
  "reserved_micro_usd",
  "actual_micro_usd",
  "content_hash",
  "identity_hash",
  "account_period_id",
  "service",
  "service_day",
  "user_day",
  "accounting_tz",
  "stored_per_job_micro_usd",
  "stored_user_daily_micro_usd",
  "provider",
  "model",
  "price_version",
  "request_hash",
  "config_hash",
  "projection_call_id",
  "created_at",
  "marked_at",
  "settled_at",
] as const;

const TENANT_COLUMNS =
  "call_id,job_id,dispatch_key,stage,state,reserved_micro_usd,actual_micro_usd,provider,model,price_version,request_hash,config_hash,identity_hash,budget_day,time_zone,created_at,dispatched_at,settled_at";
const TENANT_FIELDS = [
  "call_id",
  "job_id",
  "dispatch_key",
  "stage",
  "state",
  "reserved_micro_usd",
  "actual_micro_usd",
  "provider",
  "model",
  "price_version",
  "request_hash",
  "config_hash",
  "identity_hash",
  "budget_day",
  "time_zone",
  "created_at",
  "dispatched_at",
  "settled_at",
] as const;

/** Internal closed refusal. The reason is a static code, never user content. */
class AuditDeny extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

function actualOf(row: any): number | null {
  return row.actual_micro_usd === null || row.actual_micro_usd === undefined
    ? null
    : Number(row.actual_micro_usd);
}

function lstatOptional(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------- helpers

function tableExists(db: DatabaseSync, name: string): boolean {
  return !!db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?")
    .get(name);
}

function controlSchemaVersion(db: DatabaseSync): number {
  if (!tableExists(db, "managed_money_schema")) return 0;
  const row = db
    .prepare("SELECT max(version) AS version FROM managed_money_schema")
    .get() as { version: number | null } | undefined;
  return Number(row?.version ?? 0);
}

/** Read-only schema-version probe (shared). */
export { managedControlSchemaVersion };
/** Read-only bounded central-inventory digest (shared). */
export { managedControlInventoryDigest };

function servicePolicy(db: DatabaseSync): { daily_micro_usd: number; version: number } | null {
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

/** Money/service block singletons. They are freshness evidence, not approval. */
function blockSignature(db: DatabaseSync): unknown {
  const money = tableExists(db, "managed_money_blocks")
    ? (db
        .prepare("SELECT key,reason,at FROM managed_money_blocks ORDER BY key")
        .all() as any[]).map((row) => ({
        key: row.key,
        reason: row.reason,
        at: row.at,
      }))
    : [];
  const service = tableExists(db, "managed_service_blocks")
    ? (db
        .prepare(
          "SELECT service,call_id,account_id,over_micro_usd,at FROM managed_service_blocks ORDER BY service",
        )
        .all() as any[]).map((row) => ({
        service: row.service,
        call_id: row.call_id,
        account_id: row.account_id,
        over_micro_usd: Number(row.over_micro_usd),
        at: row.at,
      }))
    : [];
  return { money, service };
}

function schemaDigest(db: DatabaseSync): string {
  // Single implementation lives in the shared read-only state module.
  return centralSchemaDigest(db);
}

interface AccountRow {
  id: string;
  state: string;
  issuer: string;
  subject: string;
}

/** Bounded account inventory read; the caller rejects when it exceeds the bound. */
function accountRows(db: DatabaseSync, limit: number): AccountRow[] {
  return db
    .prepare(
      "SELECT id,state,issuer,subject FROM managed_accounts ORDER BY id LIMIT ?",
    )
    .all(limit) as unknown as AccountRow[];
}

function readEpochRow(db: DatabaseSync): ControlEpoch | undefined {
  if (!tableExists(db, "managed_control_epoch")) return undefined;
  const row = db
    .prepare("SELECT epoch,nonce,rotated_at FROM managed_control_epoch WHERE singleton=1")
    .get() as { epoch: number; nonce: string; rotated_at: string } | undefined;
  if (!row) return undefined;
  return {
    epoch: Number(row.epoch),
    nonce: String(row.nonce),
    rotated_at: String(row.rotated_at),
  };
}

function requireEpoch(control: AuditControl, root: string): ControlEpoch {
  const epoch = readEpochRow(control.db);
  if (!epoch) throw new AuditDeny("epoch_uninitialized");
  let marker;
  try {
    marker = readRootMarker(root);
  } catch {
    throw new AuditDeny("epoch_mismatch");
  }
  if (!rootEpochMatches(marker, epoch)) throw new AuditDeny("epoch_mismatch");
  return epoch;
}

function fileIdentity(path: string): string {
  const stat = lstatSync(path);
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
}

interface TenantFiles {
  dbPath: string;
  vaultPath: string;
  protectedPath: string;
  markerPath: string;
  markerDigest: string;
}

/**
 * Validates one tenant before any database read: the directory is a direct,
 * real, non-linked child of the root, the database/vault/protected paths are the
 * right real non-linked types, and the provisioning marker is a bounded, real,
 * non-linked `schema 1` file whose account/issuer/subject match the trusted
 * control row. A suspended account is included read-only and never reactivated.
 */
function assertTenant(root: string, account: AccountRow): TenantFiles {
  if (!UUID.test(account.id)) throw new AuditDeny("tenant_unavailable");
  const base = resolve(root);
  const dir = resolve(base, account.id);
  if (dirname(dir) !== base) throw new AuditDeny("tenant_unavailable");
  const dirStat = lstatOptional(dir);
  if (!dirStat || dirStat.isSymbolicLink() || !dirStat.isDirectory())
    throw new AuditDeny("tenant_unavailable");
  let real: string;
  try {
    real = realpathSync(dir);
  } catch {
    throw new AuditDeny("tenant_unavailable");
  }
  const same =
    process.platform === "win32"
      ? real.toLowerCase() === dir.toLowerCase()
      : real === dir;
  if (!same) throw new AuditDeny("tenant_unavailable");

  const assertFile = (path: string) => {
    const stat = lstatOptional(path);
    if (!stat || stat.isSymbolicLink() || !stat.isFile())
      throw new AuditDeny("tenant_unavailable");
  };
  const assertDir = (path: string) => {
    const stat = lstatOptional(path);
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory())
      throw new AuditDeny("tenant_unavailable");
  };

  const dbPath = resolve(dir, "brain.sqlite");
  const vaultPath = resolve(dir, "vault");
  const protectedPath = resolve(dir, "vault-protected");
  const markerPath = resolve(dir, "provisioned.json");
  assertFile(dbPath);
  assertDir(vaultPath);
  assertDir(protectedPath);
  assertFile(markerPath);

  const markerStat = lstatSync(markerPath);
  if (markerStat.size > MAX_MARKER_BYTES) throw new AuditDeny("tenant_unavailable");
  let raw: string;
  try {
    raw = readFileSync(markerPath, "utf8");
  } catch {
    throw new AuditDeny("tenant_unavailable");
  }
  let marker: any;
  try {
    marker = JSON.parse(raw);
  } catch {
    throw new AuditDeny("tenant_unavailable");
  }
  if (
    marker?.schema !== 1 ||
    marker.account_id !== account.id ||
    marker.issuer !== account.issuer ||
    marker.subject !== account.subject
  )
    throw new AuditDeny("tenant_marker_mismatch");
  return { dbPath, vaultPath, protectedPath, markerPath, markerDigest: sha256(raw) };
}

function readTenantPaidRows(path: string, limit: number): any[] {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch {
    throw new AuditDeny("tenant_unavailable");
  }
  try {
    if (!tableExists(db, "provider_dispatches")) throw new AuditDeny("tenant_unavailable");
    if (
      tableExists(db, "reservations") &&
      db.prepare("SELECT 1 AS present FROM reservations LIMIT 1").get()
    )
      throw new AuditDeny("legacy_history");
    return db
      .prepare(
        `SELECT ${TENANT_COLUMNS} FROM provider_dispatches ORDER BY call_id LIMIT ?`,
      )
      .all(limit) as any[];
  } finally {
    db.close();
  }
}

function sameRow(central: any, tenant: any): boolean {
  return (
    central.job_id === tenant.job_id &&
    central.dispatch_key === tenant.dispatch_key &&
    central.stage === tenant.stage &&
    central.state === tenant.state &&
    Number(central.reserved_micro_usd) === Number(tenant.reserved_micro_usd) &&
    actualOf(central) === actualOf(tenant) &&
    central.provider === tenant.provider &&
    central.model === tenant.model &&
    central.price_version === tenant.price_version &&
    central.request_hash === tenant.request_hash &&
    central.config_hash === tenant.config_hash
  );
}

/** Hash of every retained field of one journal row (central or tenant). */
function rowDigest(source: "central" | "tenant", row: any): string {
  const fields = source === "central" ? CENTRAL_FIELDS : TENANT_FIELDS;
  const out: Record<string, unknown> = { source };
  for (const field of fields) out[field] = row[field] ?? null;
  out.reserved_micro_usd = Number(row.reserved_micro_usd);
  out.actual_micro_usd = actualOf(row);
  return sha256(canonical(out));
}

/**
 * Bounded money validation for one journal row. A retained paid row must carry an
 * integer micro-USD hold; only a `settled` row may carry a nonnegative integer
 * actual, and a `released` row must keep its actual `null` (never a paid zero
 * invented by a corrupt write). A fractional or negative value is refused with a
 * static code and never coerced or trimmed.
 */
function assertJournalMoney(row: any): void {
  const reserved = row.reserved_micro_usd;
  if (!Number.isSafeInteger(reserved) || reserved < 0)
    throw new AuditDeny("invalid_money");
  if (row.state === "settled") {
    const actual = row.actual_micro_usd;
    if (!Number.isSafeInteger(actual) || actual < 0)
      throw new AuditDeny("invalid_money");
  } else if (row.actual_micro_usd !== null && row.actual_micro_usd !== undefined) {
    throw new AuditDeny("invalid_money");
  }
}

/** Central rows additionally bind their frozen stored money caps. */
function assertCentralMoney(row: any): void {
  assertJournalMoney(row);
  if (
    !Number.isSafeInteger(Number(row.stored_per_job_micro_usd)) ||
    Number(row.stored_per_job_micro_usd) < 0 ||
    !Number.isSafeInteger(Number(row.stored_user_daily_micro_usd)) ||
    Number(row.stored_user_daily_micro_usd) < 0
  )
    throw new AuditDeny("invalid_money");
}

function centralRowsFor(db: DatabaseSync, accountId: string, limit: number): any[] {
  return db
    .prepare(
      `SELECT ${CENTRAL_COLUMNS} FROM managed_reservations WHERE account_id=? ORDER BY call_id LIMIT ?`,
    )
    .all(accountId, limit) as any[];
}

/**
 * Per-account configuration fingerprint. It deliberately excludes the frozen
 * accounting time zone and monotonic policy version (legitimate admission side
 * effects) but binds the trusted account identity, the caps and each period id.
 */
function accountConfigHash(db: DatabaseSync, account: AccountRow): string {
  const policy = db
    .prepare(
      "SELECT per_job_micro_usd,user_daily_micro_usd FROM managed_account_policy WHERE account_id=?",
    )
    .get(account.id) as any;
  const periods = db
    .prepare(
      "SELECT period_id,starts_at,ends_at,allowance_micro_usd,state FROM managed_account_periods WHERE account_id=? ORDER BY starts_at,period_id",
    )
    .all(account.id) as any[];
  return sha256(
    canonical({
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
    }),
  );
}

// --------------------------------------------------------------------- scan

/**
 * True only when a nonterminal central+tenant pair is the exact permitted attempt
 * slot. The permit is derived internally from the trusted lease/spec, never from a
 * provider, browser, header or `ignoreCallIDs` input.
 */
function permitsAttempt(
  permit: SendGuardPermit | null,
  accountId: string,
  central: any,
  tenant: any,
): boolean {
  if (!permit) return false;
  return (
    permit.account_id === accountId &&
    permit.job_id === String(central.job_id) &&
    permit.dispatch_key === String(central.dispatch_key) &&
    permit.stage === central.stage &&
    permit.state === central.state &&
    permit.central_call_id === String(central.call_id) &&
    permit.tenant_call_id === String(tenant.call_id)
  );
}

function scanOnce(
  control: AuditControl,
  root: string,
  epoch: ControlEpoch,
  maxAccounts: number,
  maxRows: number,
  permit: SendGuardPermit | null = null,
): Scan {
  const db = control.db;
  const schema_version = controlSchemaVersion(db);
  if (schema_version <= 0) throw new AuditDeny("uninitialized");
  if (schema_version !== managedMoneySchemaVersion)
    throw new AuditDeny("unsupported_schema");
  for (const table of REQUIRED_TABLES)
    if (!tableExists(db, table)) throw new AuditDeny("uninitialized");
  const schema_digest = schemaDigest(db);

  const accounts = accountRows(db, maxAccounts + 1);
  if (accounts.length > maxAccounts) throw new AuditDeny("account_limit");

  const files: { path: string; identity: string }[] = [
    { path: "control.sqlite", identity: fileIdentity(control.path) },
  ];
  const accountScans: AccountScan[] = [];
  let totalRows = 0;

  for (const account of accounts) {
    const tenant = assertTenant(root, account);
    files.push({ path: `${account.id}/brain.sqlite`, identity: fileIdentity(tenant.dbPath) });
    files.push({ path: `${account.id}/vault`, identity: fileIdentity(tenant.vaultPath) });
    files.push({
      path: `${account.id}/vault-protected`,
      identity: fileIdentity(tenant.protectedPath),
    });
    files.push({
      path: `${account.id}/provisioned.json`,
      identity: `${fileIdentity(tenant.markerPath)} ${tenant.markerDigest}`,
    });

    const centralRemaining = maxRows - totalRows;
    const centralRows = centralRowsFor(db, account.id, centralRemaining + 1);
    for (const central of centralRows) assertCentralMoney(central);
    totalRows += centralRows.length;
    if (totalRows > maxRows) throw new AuditDeny("row_limit");

    const tenantRemaining = maxRows - totalRows;
    const tenantRows = readTenantPaidRows(tenant.dbPath, tenantRemaining + 1);
    for (const tenant of tenantRows) assertJournalMoney(tenant);
    totalRows += tenantRows.length;
    if (totalRows > maxRows) throw new AuditDeny("row_limit");

    const tenantByCall = new Map<string, any>(
      tenantRows.map((row) => [String(row.call_id), row]),
    );
    const centralByCall = new Map<string, any>(
      centralRows.map((row) => [String(row.call_id), row]),
    );
    const centralByProjection = new Map<string, any>();
    for (const central of centralRows)
      if (central.projection_call_id)
        centralByProjection.set(String(central.projection_call_id), central);
    const rows: AuditRowDigest[] = [];
    for (const central of centralRows) {
      const tenant = central.projection_call_id
        ? tenantByCall.get(String(central.projection_call_id))
        : undefined;
      if (!tenant) throw new AuditDeny("orphan_projection");
      if (central.state !== "settled" && central.state !== "released") {
        // Nonterminal tolerance is ONLY ever granted to the exact current trusted
        // attempt slot, derived internally — never a caller-supplied allow-list.
        if (!permitsAttempt(permit, account.id, central, tenant))
          throw new AuditDeny("nonterminal_call");
      }
      if (!sameRow(central, tenant)) throw new AuditDeny("row_mismatch");
      rows.push({
        call_id: String(central.call_id),
        central_digest: rowDigest("central", central),
        tenant_digest: rowDigest("tenant", tenant),
      });
    }
    for (const tenant of tenantRows) {
      if (!centralByProjection.has(String(tenant.call_id)))
        throw new AuditDeny("unmapped_tenant_row");
    }
    rows.sort((a, b) => a.call_id.localeCompare(b.call_id));
    const baseline_digest = sha256(
      canonical(
        rows.map((row) => ({
          call_id: row.call_id,
          central_digest: row.central_digest,
          tenant_digest: row.tenant_digest,
        })),
      ),
    );
    const financial_digest = sha256(
      canonical(
        rows.map((row) => {
          const central = centralByCall.get(row.call_id)!;
          return {
            call_id: row.call_id,
            state: central.state,
            reserved_micro_usd: Number(central.reserved_micro_usd),
            actual_micro_usd: actualOf(central),
          };
        }),
      ),
    );
    accountScans.push({
      account_id: account.id,
      state: account.state,
      config_hash: accountConfigHash(db, account),
      baseline_digest,
      financial_digest,
      rows,
    });
  }

  const globalHashes = accountScans
    .map((account) => ({
      account_id: account.account_id,
      config_hash: account.config_hash,
      baseline_digest: account.baseline_digest,
    }))
    .sort((a, b) => a.account_id.localeCompare(b.account_id));
  const control_digest = sha256(
    canonical({
      version: schema_version,
      service: servicePolicy(db),
      blocks: blockSignature(db),
      accounts: accountScans.map((account) => ({
        account_id: account.account_id,
        state: account.state,
        config_hash: account.config_hash,
        central_digests: account.rows.map((row) => row.central_digest),
      })),
    }),
  );
  const inventory_digest = sha256(
    canonical({
      root_epoch: epoch.epoch,
      root_nonce: epoch.nonce,
      control_schema_version: schema_version,
      accounts: globalHashes,
    }),
  );
  const baseline_digest = sha256(
    canonical(
      globalHashes.map((account) => ({
        account_id: account.account_id,
        baseline_digest: account.baseline_digest,
      })),
    ),
  );
  const config_digest = sha256(
    canonical({
      service: servicePolicy(db),
      accounts: globalHashes.map((account) => ({
        account_id: account.account_id,
        config_hash: account.config_hash,
      })),
    }),
  );
  const file_digest = sha256(
    canonical([...files].sort((a, b) => a.path.localeCompare(b.path))),
  );
  return {
    schema_version,
    schema_digest,
    config_digest,
    inventory_digest,
    baseline_digest,
    control_digest,
    file_digest,
    accounts: accountScans,
    total_rows: totalRows,
    evidence: totalRows === 0 ? "empty" : "matched",
  };
}

/**
 * Bounded re-read of the control money/config/blocks used to detect a race
 * between the second scan and the write transaction. It produces exactly the same
 * shape as `scanOnce`'s `control_digest` (no tenant access, no filesystem).
 */
function recomputeControlDigest(
  db: DatabaseSync,
  maxAccounts: number,
  maxRows: number,
): string {
  const accounts = accountRows(db, maxAccounts + 1);
  const accountDigests = accounts.map((account) => {
    const central = centralRowsFor(db, account.id, maxRows + 1);
    central.sort((a, b) => String(a.call_id).localeCompare(String(b.call_id)));
    return {
      account_id: account.id,
      state: account.state,
      config_hash: accountConfigHash(db, account),
      central_digests: central.map((row) => rowDigest("central", row)),
    };
  });
  return sha256(
    canonical({
      version: controlSchemaVersion(db),
      service: servicePolicy(db),
      blocks: blockSignature(db),
      accounts: accountDigests,
    }),
  );
}

// -------------------------------------------------------------------- write

function writeAudit(
  control: AuditControl,
  root: string,
  epoch: ControlEpoch,
  scan: Scan,
  audit_id: string,
  created_at: string,
  maxAccounts: number,
  maxRows: number,
): void {
  const db = control.db;
  db.exec("BEGIN IMMEDIATE");
  try {
    const epochNow = readEpochRow(db);
    if (!epochNow || epochNow.epoch !== epoch.epoch || epochNow.nonce !== epoch.nonce)
      throw new AuditDeny("epoch_mismatch");
    let marker;
    try {
      marker = readRootMarker(root);
    } catch {
      throw new AuditDeny("epoch_mismatch");
    }
    if (!rootEpochMatches(marker, epochNow)) throw new AuditDeny("epoch_mismatch");
    if (schemaDigest(db) !== scan.schema_digest)
      throw new AuditDeny("schema_changed");
    if (recomputeControlDigest(db, maxAccounts, maxRows) !== scan.control_digest)
      throw new AuditDeny("inventory_changed");

    db.prepare(
      "INSERT INTO managed_audits(audit_id,epoch,control_schema_version,config_digest,schema_digest,inventory_digest,baseline_digest,root_nonce,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
    ).run(
      audit_id,
      epoch.epoch,
      scan.schema_version,
      scan.config_digest,
      scan.schema_digest,
      scan.inventory_digest,
      scan.baseline_digest,
      epoch.nonce,
      created_at,
    );
    const insertAccount = db.prepare(
      "INSERT INTO managed_audit_accounts(audit_id,account_id,config_digest,baseline_digest,financial_digest) VALUES(?,?,?,?,?)",
    );
    const insertRow = db.prepare(
      "INSERT INTO managed_audit_rows(audit_id,account_id,call_id,central_digest,tenant_digest) VALUES(?,?,?,?,?)",
    );
    for (const account of scan.accounts) {
      insertAccount.run(
        audit_id,
        account.account_id,
        account.config_hash,
        account.baseline_digest,
        account.financial_digest,
      );
      for (const row of account.rows)
        insertRow.run(
          audit_id,
          account.account_id,
          row.call_id,
          row.central_digest,
          row.tenant_digest,
        );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

// ------------------------------------------------------------------- public

function resolveControl(input: {
  control?: AuditControl;
  runtime?: { control: AuditControl };
}): AuditControl {
  const control = input.control ?? input.runtime?.control;
  if (!control || !control.db || !control.path)
    throw new BrainError(
      "INVALID_INPUT",
      "A managed control database is required.",
      400,
    );
  return control;
}

function absoluteRoot(root: unknown): string {
  if (typeof root !== "string" || !root || !isAbsolute(root))
    throw new BrainError(
      "INVALID_INPUT",
      "Managed root must be one explicit absolute path.",
      400,
    );
  return resolve(root);
}

function validateLimit(value: unknown, name: string, max: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > max
  )
    throw new BrainError("INVALID_INPUT", `Invalid audit ${name}.`, 400);
  return value;
}

const emptyInventory = (
  rootEpoch: number,
  schemaVersion: number,
): AuditInventory => ({ root_epoch: rootEpoch, control_schema_version: schemaVersion, accounts: [] });

export function auditManagedHistory(input: AuditInput): AuditResult {
  const control = resolveControl(input);
  if (input.offline !== true || input.workers_terminated !== true)
    throw new BrainError(
      "BUDGET_BLOCKED",
      "Operator reconciliation requires an explicit offline acknowledgement that all managed workers are terminated.",
      409,
    );
  const root = absoluteRoot(input.root);
  const maxAccounts = validateLimit(
    input.maxAccounts ?? DEFAULT_MAX_ACCOUNTS,
    "maxAccounts",
    MAX_MAX_ACCOUNTS,
  );
  const maxRows = validateLimit(
    input.maxRows ?? DEFAULT_MAX_ROWS,
    "maxRows",
    MAX_MAX_ROWS,
  );
  let rootEpoch = 0;
  let schemaVersion = 0;
  try {
    assertTrustedManagedRoot(root, control.path);
    const epoch = requireEpoch(control, root);
    rootEpoch = epoch.epoch;
    const first = scanOnce(control, root, epoch, maxAccounts, maxRows);
    schemaVersion = first.schema_version;
    const second = scanOnce(control, root, epoch, maxAccounts, maxRows);
    if (
      first.inventory_digest !== second.inventory_digest ||
      first.control_digest !== second.control_digest ||
      first.baseline_digest !== second.baseline_digest ||
      first.file_digest !== second.file_digest ||
      first.schema_digest !== second.schema_digest
    )
      throw new AuditDeny("inventory_changed");

    const audit_id = randomUUID();
    const created_at = (input.clock ?? (() => new Date()))().toISOString();
    writeAudit(control, root, epoch, first, audit_id, created_at, maxAccounts, maxRows);
    return {
      ok: true,
      reason: null,
      audit_id,
      evidence: first.evidence,
      inventory: {
        root_epoch: epoch.epoch,
        control_schema_version: first.schema_version,
        accounts: first.accounts.map((account) => ({
          account_id: account.account_id,
          config_hash: account.config_hash,
          baseline_digest: account.baseline_digest,
        })),
      },
    };
  } catch (error) {
    if (error instanceof AuditDeny)
      return {
        ok: false,
        reason: error.reason,
        audit_id: null,
        evidence: "empty",
        inventory: emptyInventory(rootEpoch, schemaVersion),
      };
    if (error instanceof BrainError)
      return {
        ok: false,
        reason: "denied",
        audit_id: null,
        evidence: "empty",
        inventory: emptyInventory(rootEpoch, schemaVersion),
      };
    throw error;
  }
}

export function readManagedAudit(
  control: AuditControl,
  auditId: string,
): AuditRecord | undefined {
  if (typeof auditId !== "string" || !UUID.test(auditId)) return undefined;
  const db = control.db;
  if (!tableExists(db, "managed_audits")) return undefined;
  const row = db
    .prepare("SELECT * FROM managed_audits WHERE audit_id=?")
    .get(auditId) as any;
  if (!row) return undefined;
  const accounts = (
    db
      .prepare(
        "SELECT account_id,config_digest,baseline_digest,financial_digest FROM managed_audit_accounts WHERE audit_id=? ORDER BY account_id",
      )
      .all(auditId) as any[]
  ).map((account) => ({
    account_id: String(account.account_id),
    config_digest: String(account.config_digest),
    baseline_digest: String(account.baseline_digest),
    financial_digest: String(account.financial_digest),
  }));
  const rows = tableExists(db, "managed_audit_rows")
    ? Number(
        (
          db
            .prepare("SELECT count(*) AS n FROM managed_audit_rows WHERE audit_id=?")
            .get(auditId) as { n: number }
        ).n,
      )
    : 0;
  return {
    audit_id: String(row.audit_id),
    epoch: Number(row.epoch),
    control_schema_version: Number(row.control_schema_version),
    config_digest: String(row.config_digest),
    schema_digest: String(row.schema_digest),
    inventory_digest: String(row.inventory_digest),
    baseline_digest: String(row.baseline_digest),
    root_nonce: String(row.root_nonce),
    created_at: String(row.created_at),
    evidence: rows === 0 ? "empty" : "matched",
    accounts,
  };
}

export function validateManagedAudit(
  input: AuditValidationInput,
): AuditValidation {
  const control = resolveControl(input);
  const root = absoluteRoot(input.root);
  const maxAccounts = validateLimit(
    input.maxAccounts ?? DEFAULT_MAX_ACCOUNTS,
    "maxAccounts",
    MAX_MAX_ACCOUNTS,
  );
  const maxRows = validateLimit(
    input.maxRows ?? DEFAULT_MAX_ROWS,
    "maxRows",
    MAX_MAX_ROWS,
  );
  const stored = readManagedAudit(control, input.auditId);
  if (!stored) return { valid: false, reason: "unknown_audit" };
  try {
    assertTrustedManagedRoot(root, control.path);
    const epoch = requireEpoch(control, root);
    if (epoch.epoch !== stored.epoch || epoch.nonce !== stored.root_nonce)
      return { valid: false, reason: "epoch_mismatch" };
    const scan = scanOnce(control, root, epoch, maxAccounts, maxRows);
    // A changed schema or strict configuration fingerprint invalidates the audit
    // rather than inheriting its approval. Account membership is checked before the
    // global config digest so a new unsurveyed account is reported precisely. The
    // baseline digest is not compared wholesale here because legitimate new
    // terminal rows extend it.
    if (
      scan.schema_version !== stored.control_schema_version ||
      scan.schema_digest !== stored.schema_digest
    )
      return { valid: false, reason: "schema_changed" };
    for (const account of stored.accounts) {
      const live = scan.accounts.find(
        (candidate) => candidate.account_id === account.account_id,
      );
      if (!live) return { valid: false, reason: "account_missing" };
      if (live.config_hash !== account.config_digest)
        return { valid: false, reason: "config_changed" };
    }
    for (const live of scan.accounts)
      if (!stored.accounts.some((account) => account.account_id === live.account_id))
        return { valid: false, reason: "unsurveyed_account" };
    if (scan.config_digest !== stored.config_digest)
      return { valid: false, reason: "config_changed" };

    const db = control.db;
    const storedRows = tableExists(db, "managed_audit_rows")
      ? (db
          .prepare(
            "SELECT account_id,call_id,central_digest,tenant_digest FROM managed_audit_rows WHERE audit_id=?",
          )
          .all(input.auditId) as any[])
      : [];
    const liveRows = new Map<string, AuditRowDigest>();
    for (const account of scan.accounts)
      for (const row of account.rows)
        liveRows.set(`${account.account_id}:${row.call_id}`, row);
    for (const row of storedRows) {
      const live = liveRows.get(`${row.account_id}:${row.call_id}`);
      if (
        !live ||
        live.central_digest !== String(row.central_digest) ||
        live.tenant_digest !== String(row.tenant_digest)
      )
        return { valid: false, reason: "baseline_changed" };
    }
    return { valid: true, reason: null };
  } catch (error) {
    if (error instanceof AuditDeny) return { valid: false, reason: error.reason };
    if (error instanceof BrainError) return { valid: false, reason: "denied" };
    throw error;
  }
}

/**
 * Bounded, read-only enrollment-baseline snapshot for the shared activation
 * loader. It proves the immutable known baseline still matches the CURRENT
 * control configuration WITHOUT requiring current terminality and without opening
 * any tenant database, so it is safe to call on a read path while a worker holds a
 * marked call. New actual mapped terminal rows are permitted; a changed service
 * policy, account cap/period, new unsurveyed account, changed epoch/schema or a
 * changed/removed baseline row denies.
 */
export function readEnrollmentBaseline(
  control: AuditControl,
  root: string,
  auditId: string,
): { valid: boolean; reason: string | null } {
  const db = control.db;
  const stored = readManagedAudit(control, auditId);
  if (!stored) return { valid: false, reason: "unknown_audit" };
  try {
    assertTrustedManagedRoot(root, control.path);
    const epoch = requireEpoch(control, root);
    if (epoch.epoch !== stored.epoch || epoch.nonce !== stored.root_nonce)
      return { valid: false, reason: "epoch_mismatch" };
    const schema_version = controlSchemaVersion(db);
    if (
      schema_version !== managedMoneySchemaVersion ||
      schema_version !== stored.control_schema_version
    )
      return { valid: false, reason: "schema_changed" };
    if (schemaDigest(db) !== stored.schema_digest)
      return { valid: false, reason: "schema_changed" };
    const accounts = accountRows(db, DEFAULT_MAX_ACCOUNTS + 1);
    if (accounts.length > DEFAULT_MAX_ACCOUNTS)
      return { valid: false, reason: "account_limit" };
    for (const account of stored.accounts) {
      const live = accounts.find((candidate) => candidate.id === account.account_id);
      if (!live) return { valid: false, reason: "account_missing" };
      if (accountConfigHash(db, live) !== account.config_digest)
        return { valid: false, reason: "config_changed" };
    }
    for (const live of accounts)
      if (!stored.accounts.some((account) => account.account_id === live.id))
        return { valid: false, reason: "unsurveyed_account" };
    const globalHashes = accounts
      .map((account) => ({
        account_id: account.id,
        config_hash: accountConfigHash(db, account),
      }))
      .sort((a, b) => a.account_id.localeCompare(b.account_id));
    const config_digest = sha256(
      canonical({ service: servicePolicy(db), accounts: globalHashes }),
    );
    if (config_digest !== stored.config_digest)
      return { valid: false, reason: "config_changed" };
    const storedRows = tableExists(db, "managed_audit_rows")
      ? (db
          .prepare(
            "SELECT account_id,call_id,central_digest FROM managed_audit_rows WHERE audit_id=?",
          )
          .all(auditId) as any[])
      : [];
    for (const row of storedRows) {
      const live = db
        .prepare(
          `SELECT ${CENTRAL_COLUMNS} FROM managed_reservations WHERE account_id=? AND call_id=?`,
        )
        .get(String(row.account_id), String(row.call_id)) as any;
      if (!live || rowDigest("central", live) !== String(row.central_digest))
        return { valid: false, reason: "baseline_changed" };
    }
    return { valid: true, reason: null };
  } catch (error) {
    if (error instanceof AuditDeny) return { valid: false, reason: error.reason };
    if (error instanceof BrainError) return { valid: false, reason: "denied" };
    throw error;
  }
}

/**
 * Per-send baseline check. It never runs the full terminal `validateManagedAudit`
 * at send time. It proves: the stored known baseline is unchanged (config, account
 * inventory, epoch/schema, and BOTH the central and tenant digests of every known
 * audit row, so tenant-only field tamper is caught); the only nonterminal rows are
 * those of the exact permitted current attempt slot; two bounded scans agree on
 * every digest; and the central inventory digest is stable before and after. New
 * post-baseline known/terminal/mapped rows are allowed, so a second legitimate paid
 * call needs no re-audit. It opens no writer and no nested transaction.
 */
export function readSendGuardBaseline(
  control: AuditControl,
  root: string,
  auditId: string,
  permit: SendGuardPermit | null,
): { valid: boolean; reason: string | null; central_inventory_digest?: string } {
  const known = readEnrollmentBaseline(control, root, auditId);
  if (!known.valid) return { valid: false, reason: known.reason };
  try {
    const epoch = requireEpoch(control, root);
    const before = managedControlInventoryDigest(control.db);
    const first = scanOnce(control, root, epoch, DEFAULT_MAX_ACCOUNTS, DEFAULT_MAX_ROWS, permit);
    const second = scanOnce(control, root, epoch, DEFAULT_MAX_ACCOUNTS, DEFAULT_MAX_ROWS, permit);
    if (
      first.inventory_digest !== second.inventory_digest ||
      first.control_digest !== second.control_digest ||
      first.baseline_digest !== second.baseline_digest ||
      first.file_digest !== second.file_digest ||
      first.schema_digest !== second.schema_digest
    )
      return { valid: false, reason: "inventory_changed" };
    const after = managedControlInventoryDigest(control.db);
    if (before !== after) return { valid: false, reason: "inventory_changed" };

    const live = new Map<string, { central_digest: string; tenant_digest: string }>();
    for (const account of first.accounts)
      for (const row of account.rows)
        live.set(`${account.account_id}:${row.call_id}`, row);
    const storedRows = tableExists(control.db, "managed_audit_rows")
      ? (control.db
          .prepare(
            "SELECT account_id,call_id,central_digest,tenant_digest FROM managed_audit_rows WHERE audit_id=?",
          )
          .all(auditId) as any[])
      : [];
    for (const row of storedRows) {
      const match = live.get(`${row.account_id}:${row.call_id}`);
      if (
        !match ||
        match.central_digest !== String(row.central_digest) ||
        match.tenant_digest !== String(row.tenant_digest)
      )
        return { valid: false, reason: "baseline_changed" };
    }
    return { valid: true, reason: null, central_inventory_digest: after };
  } catch (error) {
    if (error instanceof AuditDeny) return { valid: false, reason: error.reason };
    if (error instanceof BrainError) return { valid: false, reason: "denied" };
    throw error;
  }
}
