import { expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStore } from "../../packages/storage/control.ts";
import { ManagedSpendingStore } from "../../packages/storage/managed-spending.ts";
import { MANAGED_V3_MONEY_DDL } from "../helpers/managed-v3-fixture.ts";
import { canonical } from "../../packages/domain/logic.ts";
import { activationFingerprint, profileConfigDigest, type ActivationProfile } from "../../packages/domain/managed-activation.ts";
import { ManagedActivationStore, readActivationRow, writeActivationMirror } from "../../packages/storage/managed-activation.ts";

const clock = () => new Date("2026-10-17T12:00:00.000Z");
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "brain-v3-upgrade-parent-"));
  const control = new ControlStore(join(root, "control.sqlite"), clock);
  // Start with the actual frozen v3 DDL, not a v4 database with its new tables removed.
  control.db.exec(MANAGED_V3_MONEY_DDL);
  control.db.exec("CREATE TABLE managed_money_schema(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  control.db.prepare("INSERT INTO managed_money_schema VALUES(3,?)").run(clock().toISOString());
  const account = control.provision("https://issuer.synthetic.test", "synthetic-v3-financial-history");
  control.db.prepare("INSERT INTO managed_account_periods VALUES(?,?,?,?,?,?,?,?)").run(
    "synthetic-period", account.id, "2026-10-17T00:00:00Z", "2026-10-18T00:00:00Z", 1000, "active", clock().toISOString(), null,
  );
  control.db.prepare("INSERT INTO managed_service_policy VALUES('managed-processing',1000,1,?)").run(clock().toISOString());
  control.db.prepare("INSERT INTO managed_account_policy VALUES(?,1000,1000,'UTC',1,?)").run(account.id, clock().toISOString());
  const insert = control.db.prepare(`INSERT INTO managed_reservations(
    call_id,account_id,job_id,dispatch_key,service,stage,state,reserved_micro_usd,actual_micro_usd,
    content_hash,identity_hash,account_period_id,service_day,user_day,accounting_tz,stored_per_job_micro_usd,
    stored_user_daily_micro_usd,provider,model,price_version,request_hash,config_hash,projection_call_id,
    reconciliation_required,created_at,marked_at,settled_at)
    VALUES(?,?,?,?,'managed-processing','reasoning',?,100,?,? ,?,'synthetic-period','2026-10-17','2026-10-17','UTC',1000,1000,
      'openai','synthetic-model','synthetic-price',?,?,NULL,0,?,?,?)`);
  for (const state of ["reserved", "dispatched", "settled"] as const) {
    insert.run(`synthetic-${state}`, account.id, `synthetic-job-${state}`, "reasoning", state,
      state === "settled" ? 7 : null, "a".repeat(64), "b".repeat(64), "c".repeat(64), "d".repeat(64),
      clock().toISOString(), state === "reserved" ? null : clock().toISOString(), state === "settled" ? clock().toISOString() : null);
  }
  control.db.prepare("INSERT INTO managed_money_blocks VALUES('synthetic-block','unresolved_usage',?)").run(clock().toISOString());
  const tables = ["managed_reservations", "managed_account_periods", "managed_account_policy", "managed_service_policy", "managed_money_blocks"];
  const snapshot = () => Object.fromEntries(tables.map((table) => [table, canonical(control.db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all())]));
  return { root, control, snapshot, close() { control.close(); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } };
}

it("upgrading frozen v3 DDL preserves reserved, ambiguous dispatched and known-settled money exactly", () => {
  const f = fixture();
  try {
    const before = f.snapshot();
    expect(f.control.db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'managed_decision_activation%'").all()).toEqual([]);
    new ManagedSpendingStore(f.control, clock);
    expect(f.snapshot()).toEqual(before);
    expect(f.control.db.prepare("SELECT MAX(version) AS version FROM managed_money_schema").get()).toMatchObject({ version: 4 });
    expect(f.control.db.prepare("SELECT COUNT(*) AS n FROM managed_decision_activation").get()).toMatchObject({ n: 0 });
    new ManagedSpendingStore(f.control, clock);
    expect(f.snapshot()).toEqual(before);
    expect(f.control.db.prepare("SELECT state,actual_micro_usd FROM managed_reservations WHERE call_id='synthetic-dispatched'").get()).toMatchObject({ state: "dispatched", actual_micro_usd: null });
  } finally { f.close(); }
});

it("a failed v4 marker write rolls back its new DDL without losing v3 holds", () => {
  const f = fixture();
  try {
    const before = f.snapshot();
    f.control.db.exec("CREATE TRIGGER synthetic_migration_failure BEFORE INSERT ON managed_money_schema WHEN NEW.version=4 BEGIN SELECT RAISE(ABORT,'SYNTHETIC_MIGRATION_FAILURE'); END");
    expect(() => new ManagedSpendingStore(f.control, clock)).toThrow();
    expect(f.snapshot()).toEqual(before);
    expect(f.control.db.prepare("SELECT MAX(version) AS version FROM managed_money_schema").get()).toMatchObject({ version: 3 });
    expect(f.control.db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'managed_decision_activation%'").all()).toEqual([]);
  } finally { f.close(); }
});

it("the global stop still works on an existing v3 root before any schema-4 startup migration", () => {
  const f = fixture();
  try {
    const p: ActivationProfile = {
      schema: 1, version: 1, enabled: true, provider: "openai", model: "synthetic-reasoning-v1",
      accepted_response_models: ["synthetic-reasoning-v1"], price_version: "synthetic-price-v1",
      input_micro_usd_per_million: 1000, output_micro_usd_per_million: 1000,
      max_output_tokens: 100, endpoint_class: "openai_responses", config_digest: "", fingerprint: "",
      audit_digest: "a".repeat(64), audit_id: "11111111-1111-4111-8111-111111111111",
      epoch: 1, root_nonce: "b".repeat(64), updated_at: clock().toISOString(),
    };
    p.config_digest = profileConfigDigest(p);
    p.fingerprint = activationFingerprint(p);
    f.control.db.prepare(`INSERT INTO managed_activation VALUES(1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      p.schema, p.version, 1, p.provider, p.model, p.price_version, p.input_micro_usd_per_million,
      p.output_micro_usd_per_million, JSON.stringify(p.accepted_response_models), p.max_output_tokens,
      p.endpoint_class, p.config_digest, p.audit_digest, p.audit_id, p.epoch, p.root_nonce, p.fingerprint, p.updated_at,
    );
    writeActivationMirror(f.root, p);
    expect(new ManagedActivationStore(f.control, f.root, clock).disable(1)).toMatchObject({ disabled: true });
    expect(readActivationRow(f.control.db)).toMatchObject({ enabled: false });
  } finally { f.close(); }
});
