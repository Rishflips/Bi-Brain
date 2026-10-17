// FROZEN verbatim schema-3 money DDL captured from commit 658565b:packages/storage/managed-spending.ts.
// Used to prove a genuine v3 -> v4 migration. Do NOT edit to track the current schema.
export const MANAGED_V3_MONEY_DDL = `
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
`;
export const MANAGED_V3_SCHEMA_VERSION = 3;
