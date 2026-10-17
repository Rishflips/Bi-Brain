import { expect, it } from "vitest";
import { BILLING_JOURNAL_DDL } from "../../packages/storage/billing-journal.ts";
import { createMoneyV4Control, moneyBytesDigest } from "../helpers/managed-v4-fixture.ts";

it("the genuine frozen-v4 fixture retains unknown holds when only an unused journal namespace is added", () => {
  const db = createMoneyV4Control(":memory:");
  try {
    expect(db.prepare("SELECT MAX(version) AS version FROM managed_money_schema").get()).toMatchObject({ version: 4 });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='managed_decision_activation'").get()).toBeDefined();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='control_billing_log'").get()).toBeUndefined();
    const account = "11111111-1111-4111-8111-111111111111";
    const at = "2026-10-17T12:00:00.000Z";
    db.prepare("INSERT INTO managed_accounts(id,issuer,subject,state,created_at) VALUES(?,?,?,'active',?)")
      .run(account, "https://synthetic.invalid", "SYNTHETIC-v4-owner", at);
    db.prepare("INSERT INTO managed_account_periods VALUES(?,?,?,?,?,?,?,?)")
      .run("SYNTHETIC-v4-period", account, "2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z", 1000, "active", at, null);
    db.prepare(`INSERT INTO managed_reservations(
      call_id,account_id,job_id,dispatch_key,service,stage,state,reserved_micro_usd,actual_micro_usd,
      content_hash,identity_hash,account_period_id,service_day,user_day,accounting_tz,
      stored_per_job_micro_usd,stored_user_daily_micro_usd,provider,model,price_version,
      request_hash,config_hash,projection_call_id,reconciliation_required,created_at,marked_at,settled_at)
      VALUES(?,?,?,'decision','managed-processing','decision','dispatched',100,NULL,
      ?,?,'SYNTHETIC-v4-period','2026-10-17','2026-10-17','UTC',1000,1000,
      'typesafe','SYNTHETIC-model','SYNTHETIC-price',?,?,NULL,0,?,?,NULL)`)
      .run("SYNTHETIC-v4-call", account, "SYNTHETIC-v4-job", "a".repeat(64), "b".repeat(64),
        "c".repeat(64), "d".repeat(64), at, at);
    db.prepare("INSERT INTO managed_money_blocks VALUES(?,?,?)").run("SYNTHETIC-pause", "unresolved_usage", at);
    const before = moneyBytesDigest(db);
    db.exec(BILLING_JOURNAL_DDL);
    expect(moneyBytesDigest(db)).toBe(before);
    expect(db.prepare("SELECT state,actual_micro_usd FROM managed_reservations WHERE call_id=?").get("SYNTHETIC-v4-call"))
      .toMatchObject({ state: "dispatched", actual_micro_usd: null });
    expect(db.prepare("SELECT reason FROM managed_money_blocks WHERE key='SYNTHETIC-pause'").get())
      .toMatchObject({ reason: "unresolved_usage" });
    db.prepare("UPDATE managed_reservations SET reserved_micro_usd=101 WHERE call_id='SYNTHETIC-v4-call'").run();
    expect(moneyBytesDigest(db)).not.toBe(before);
  } finally { db.close(); }
});

it("the frozen history digest excludes only additive v5 bookkeeping, not unknown future markers", () => {
  const db = createMoneyV4Control(":memory:");
  try {
    const before = moneyBytesDigest(db);
    db.prepare("INSERT INTO managed_money_schema VALUES(5,?)").run("2026-10-17T12:00:00.000Z");
    expect(moneyBytesDigest(db)).toBe(before);
    db.prepare("INSERT INTO managed_money_schema VALUES(6,?)").run("2026-10-17T12:00:00.000Z");
    expect(moneyBytesDigest(db)).not.toBe(before);
  } finally { db.close(); }
});
