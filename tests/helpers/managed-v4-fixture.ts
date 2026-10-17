import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { canonical } from "../../packages/domain/logic.ts";

/**
 * FROZEN literal snapshot of the ACTUAL current control-plane money schema 4.
 *
 * Frozen from the worktree on 2026-10-17 (S1 locally accepted). It is deliberately a
 * literal copy — it must NOT import the live `MONEY_DDL`, the current
 * `ManagedSpendingStore` constructor, or `git show HEAD` (HEAD is pre-S1 schema 3).
 * Fixtures are SYNTHETIC. Creating a money-4 database here is fixture preparation, not
 * a migration and not proof that schema 5 is applied or verified.
 */

const SEED_AT = "2026-10-17T00:00:00.000Z";

/** Literal copy of `ControlStore` identity DDL (`packages/storage/control.ts`). */
export const MANAGED_CONTROL_IDENTITY_DDL = `
CREATE TABLE IF NOT EXISTS managed_accounts(
  id TEXT PRIMARY KEY,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('active','suspended')),
  created_at TEXT NOT NULL,
  UNIQUE(issuer, subject));
CREATE TABLE IF NOT EXISTS managed_sessions(
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES managed_accounts(id),
  csrf TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS managed_agent_tokens(
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES managed_accounts(id),
  grant_id TEXT NOT NULL,
  created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS managed_sessions_account ON managed_sessions(account_id);
CREATE INDEX IF NOT EXISTS managed_agent_tokens_account ON managed_agent_tokens(account_id);
`;

/** Literal copy of the current money-4 `MONEY_DDL` (`packages/storage/managed-spending.ts`). */
export const MANAGED_V4_MONEY_DDL = `
CREATE TABLE IF NOT EXISTS managed_account_periods(
  period_id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES managed_accounts(id),
  starts_at TEXT NOT NULL, ends_at TEXT NOT NULL,
  allowance_micro_usd INTEGER NOT NULL CHECK(allowance_micro_usd>=0),
  state TEXT NOT NULL CHECK(state IN ('active','revoked')),
  granted_at TEXT NOT NULL, revoked_at TEXT,
  UNIQUE(account_id, starts_at, ends_at));
CREATE TABLE IF NOT EXISTS managed_service_policy(
  service TEXT PRIMARY KEY CHECK(service='managed-processing'),
  daily_micro_usd INTEGER NOT NULL CHECK(daily_micro_usd>=0), version INTEGER NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS managed_account_policy(
  account_id TEXT PRIMARY KEY REFERENCES managed_accounts(id),
  per_job_micro_usd INTEGER NOT NULL CHECK(per_job_micro_usd>=0),
  user_daily_micro_usd INTEGER NOT NULL CHECK(user_daily_micro_usd>=0),
  accounting_tz TEXT, version INTEGER NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS managed_reservations(
  call_id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES managed_accounts(id),
  job_id TEXT NOT NULL, dispatch_key TEXT NOT NULL,
  service TEXT NOT NULL CHECK(service='managed-processing'),
  stage TEXT NOT NULL CHECK(stage IN ('decision','reasoning','repair')),
  state TEXT NOT NULL CHECK(state IN ('reserved','dispatched','settled','released')),
  reserved_micro_usd INTEGER NOT NULL CHECK(reserved_micro_usd>=0),
  actual_micro_usd INTEGER CHECK(actual_micro_usd IS NULL OR actual_micro_usd>=0),
  content_hash TEXT NOT NULL, identity_hash TEXT NOT NULL,
  account_period_id TEXT NOT NULL REFERENCES managed_account_periods(period_id),
  service_day TEXT NOT NULL, user_day TEXT NOT NULL, accounting_tz TEXT NOT NULL,
  stored_per_job_micro_usd INTEGER NOT NULL CHECK(stored_per_job_micro_usd>=0),
  stored_user_daily_micro_usd INTEGER NOT NULL CHECK(stored_user_daily_micro_usd>=0),
  provider TEXT NOT NULL, model TEXT NOT NULL, price_version TEXT NOT NULL,
  request_hash TEXT NOT NULL, config_hash TEXT NOT NULL,
  projection_call_id TEXT, reconciliation_required INTEGER NOT NULL DEFAULT 0 CHECK(reconciliation_required IN (0,1)),
  created_at TEXT NOT NULL, marked_at TEXT, settled_at TEXT,
  UNIQUE(account_id, job_id, dispatch_key));
CREATE TABLE IF NOT EXISTS managed_service_blocks(
  service TEXT PRIMARY KEY CHECK(service='managed-processing'),
  call_id TEXT NOT NULL, account_id TEXT NOT NULL,
  over_micro_usd INTEGER NOT NULL CHECK(over_micro_usd>=0), at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS managed_money_blocks(key TEXT PRIMARY KEY, reason TEXT NOT NULL, at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS managed_reservations_account ON managed_reservations(account_id,state);
CREATE INDEX IF NOT EXISTS managed_reservations_job ON managed_reservations(account_id,job_id,state);
CREATE INDEX IF NOT EXISTS managed_reservations_service_day ON managed_reservations(service_day,state);
CREATE UNIQUE INDEX IF NOT EXISTS managed_reservations_projection ON managed_reservations(projection_call_id);
CREATE TABLE IF NOT EXISTS managed_resolutions(
  resolution_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('settled','zero','dispute')),
  account_id TEXT NOT NULL REFERENCES managed_accounts(id),
  call_id TEXT NOT NULL REFERENCES managed_reservations(call_id),
  method TEXT NOT NULL CHECK(method IN ('usage_response','call_statement')),
  evidence_digest TEXT NOT NULL, binding_digest TEXT NOT NULL,
  cost_micro_usd INTEGER NOT NULL CHECK(cost_micro_usd>=0),
  currency TEXT NOT NULL CHECK(currency='USD'),
  provider_request_id TEXT NOT NULL, actor TEXT NOT NULL, checked_at TEXT NOT NULL,
  epoch INTEGER NOT NULL CHECK(epoch>=1), decided_at TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS managed_resolutions_no_update BEFORE UPDATE ON managed_resolutions
  BEGIN SELECT RAISE(ABORT,'managed resolutions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS managed_resolutions_no_delete BEFORE DELETE ON managed_resolutions
  BEGIN SELECT RAISE(ABORT,'managed resolutions are immutable'); END;
CREATE INDEX IF NOT EXISTS managed_resolutions_call ON managed_resolutions(call_id);
CREATE TABLE IF NOT EXISTS managed_control_epoch(
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  epoch INTEGER NOT NULL CHECK(epoch>=1), nonce TEXT NOT NULL, rotated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS managed_audits(
  audit_id TEXT PRIMARY KEY, epoch INTEGER NOT NULL CHECK(epoch>=1),
  control_schema_version INTEGER NOT NULL,
  config_digest TEXT NOT NULL, schema_digest TEXT NOT NULL,
  inventory_digest TEXT NOT NULL, baseline_digest TEXT NOT NULL,
  root_nonce TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS managed_audit_accounts(
  audit_id TEXT NOT NULL REFERENCES managed_audits(audit_id),
  account_id TEXT NOT NULL, config_digest TEXT NOT NULL,
  baseline_digest TEXT NOT NULL, financial_digest TEXT NOT NULL,
  PRIMARY KEY(audit_id, account_id));
CREATE TABLE IF NOT EXISTS managed_audit_rows(
  audit_id TEXT NOT NULL REFERENCES managed_audits(audit_id),
  account_id TEXT NOT NULL, call_id TEXT NOT NULL,
  central_digest TEXT NOT NULL, tenant_digest TEXT NOT NULL,
  PRIMARY KEY(audit_id, account_id, call_id));
CREATE TABLE IF NOT EXISTS managed_activation(
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  schema INTEGER NOT NULL, version INTEGER NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  provider TEXT NOT NULL, model TEXT NOT NULL, price_version TEXT NOT NULL,
  input_micro_usd_per_million INTEGER NOT NULL CHECK(input_micro_usd_per_million>=0),
  output_micro_usd_per_million INTEGER NOT NULL CHECK(output_micro_usd_per_million>=0),
  accepted_response_models TEXT NOT NULL, max_output_tokens INTEGER NOT NULL,
  endpoint_class TEXT NOT NULL CHECK(endpoint_class='openai_responses'),
  config_digest TEXT NOT NULL, audit_digest TEXT NOT NULL, audit_id TEXT NOT NULL, epoch INTEGER NOT NULL,
  root_nonce TEXT NOT NULL, fingerprint TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS managed_decision_activation(
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  schema INTEGER NOT NULL, version INTEGER NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  provider TEXT NOT NULL CHECK(provider IN ('typesafe','cloudflare')),
  model TEXT NOT NULL, accepted_response_models TEXT NOT NULL,
  endpoint TEXT NOT NULL, endpoint_digest TEXT NOT NULL,
  price_version TEXT NOT NULL,
  input_micro_usd_per_million INTEGER NOT NULL CHECK(input_micro_usd_per_million>=0),
  output_micro_usd_per_million INTEGER NOT NULL CHECK(output_micro_usd_per_million=0),
  timeout_ms INTEGER NOT NULL, max_request_bytes INTEGER NOT NULL, max_response_bytes INTEGER NOT NULL,
  request_overhead_bytes INTEGER NOT NULL,
  config_digest TEXT NOT NULL, audit_digest TEXT NOT NULL, audit_id TEXT NOT NULL, epoch INTEGER NOT NULL,
  root_nonce TEXT NOT NULL, fingerprint TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS managed_decision_activation_events(
  event_id TEXT PRIMARY KEY,
  stage TEXT NOT NULL CHECK(stage IN ('reasoning','decision')),
  action TEXT NOT NULL CHECK(action IN ('enabled','disabled','restored_disabled')),
  version INTEGER NOT NULL CHECK(version>=1),
  fingerprint TEXT NOT NULL, epoch INTEGER NOT NULL CHECK(epoch>=1), at TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS managed_decision_activation_events_no_update
  BEFORE UPDATE ON managed_decision_activation_events
  BEGIN SELECT RAISE(ABORT,'managed decision activation events are immutable'); END;
CREATE TRIGGER IF NOT EXISTS managed_decision_activation_events_no_delete
  BEFORE DELETE ON managed_decision_activation_events
  BEGIN SELECT RAISE(ABORT,'managed decision activation events are immutable'); END;
`;

/** Tables whose retained rows the canonical money digest covers. */
const MONEY_DIGEST_TABLES = [
  "managed_accounts",
  "managed_sessions",
  "managed_agent_tokens",
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

function tableExists(db: DatabaseSync, name: string): boolean {
  return !!db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?")
    .get(name);
}

/**
 * Creates a synthetic money-4 control database (identity DDL + money-4 DDL + the
 * historical `managed_money_schema` rows 3 and 4). The caller owns and closes it.
 * It seeds NO financial rows: tests must seed explicitly.
 */
export function createMoneyV4Control(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(MANAGED_CONTROL_IDENTITY_DDL);
  db.exec("CREATE TABLE IF NOT EXISTS managed_money_schema(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);");
  db.exec(MANAGED_V4_MONEY_DDL);
  const marker = db.prepare("INSERT OR IGNORE INTO managed_money_schema(version,applied_at) VALUES(?,?)");
  marker.run(3, SEED_AT);
  marker.run(4, SEED_AT);
  return db;
}

/**
 * Canonical digest of every retained money/control row and the schema-version history.
 * It excludes ONLY a future additive version-5 bookkeeping row; no other row is ever
 * filtered. Ordering is by rowid so the digest is deterministic.
 */
export function moneyBytesDigest(db: DatabaseSync): string {
  const parts: unknown[] = [];
  for (const table of MONEY_DIGEST_TABLES) {
    if (!tableExists(db, table)) {
      parts.push({ table, present: false });
      continue;
    }
    const rows = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
    parts.push({ table, present: true, rows });
  }
  const versions = tableExists(db, "managed_money_schema")
    ? db
        .prepare("SELECT version,applied_at FROM managed_money_schema WHERE version<>5 ORDER BY version")
        .all()
    : [];
  parts.push({ table: "managed_money_schema", present: versions.length > 0, rows: versions });
  return createHash("sha256").update(canonical(parts)).digest("hex");
}
