import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { constants } from "node:sqlite";
import { expect, it } from "vitest";
import { BrainError, canonical } from "../../packages/domain/logic.ts";
import { ControlStore } from "../../packages/storage/control.ts";
import { ManagedSpendingStore } from "../../packages/storage/managed-spending.ts";
import { installBillingMoney5 } from "../../packages/storage/billing-install.ts";
import { createMoneyV4Control, moneyBytesDigest } from "../helpers/managed-v4-fixture.ts";

// Parent-owned migration evidence: genuine literal v4 first, no live root/provider/key.
const AT = "2027-01-31T12:00:00.000Z";
const clock = () => new Date(AT);
function fixture() {
  const base = process.platform === "win32"
    ? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Temp", "opencode") : tmpdir();
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, "brain-money5-parent-"));
  const path = join(root, "control.sqlite");
  const frozen = createMoneyV4Control(path);
  frozen.close();
  const control = new ControlStore(path, clock);
  const account = control.provision("https://synthetic.invalid", "SYNTHETIC-original-money4-owner");
  const period = randomUUID();
  control.db.prepare("INSERT INTO managed_account_periods VALUES(?,?,?,?,?,?,?,NULL)")
    .run(period, account.id, "2027-01-01T00:00:00.000Z", "2027-02-01T00:00:00.000Z", 1000, "active", AT);
  control.db.prepare("INSERT INTO managed_service_policy VALUES('managed-processing',1000,1,?)").run(AT);
  control.db.prepare("INSERT INTO managed_account_policy VALUES(?,1000,1000,'UTC',1,?)").run(account.id, AT);
  const calls = { reserved: randomUUID(), dispatched: randomUUID(), settled: randomUUID() };
  const insert = control.db.prepare(`INSERT INTO managed_reservations(
    call_id,account_id,job_id,dispatch_key,service,stage,state,reserved_micro_usd,actual_micro_usd,
    content_hash,identity_hash,account_period_id,service_day,user_day,accounting_tz,stored_per_job_micro_usd,
    stored_user_daily_micro_usd,provider,model,price_version,request_hash,config_hash,projection_call_id,
    reconciliation_required,created_at,marked_at,settled_at)
    VALUES(?,?,?,'reasoning','managed-processing','reasoning',?,10,?,?,?,?,'2027-01-31','2027-01-31',
    'UTC',1000,1000,'synthetic','SYNTHETIC-model','SYNTHETIC-price',?,?,NULL,0,?,?,?)`);
  for (const state of ["reserved", "dispatched", "settled"] as const) {
    insert.run(calls[state], account.id, randomUUID(), state, state === "settled" ? 7 : null,
      "a".repeat(64), "b".repeat(64), period, "c".repeat(64), "d".repeat(64), AT,
      state === "reserved" ? null : AT, state === "settled" ? AT : null);
  }
  const version = () => (control.db.prepare("SELECT MAX(version) AS version FROM managed_money_schema").get() as { version: number }).version;
  const schema = () => canonical(control.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all());
  return { root, control, account, calls, version, schema,
    install: () => installBillingMoney5({ root, control, offline: true, workers_terminated: true }),
    close() { control.db.setAuthorizer(null); control.close(); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } };
}

it("ordinary legacy construction does not silently opt a genuine v4 root into billing", () => {
  const f = fixture();
  try {
    const before = moneyBytesDigest(f.control.db), shape = f.schema();
    new ManagedSpendingStore(f.control, clock);
    expect(f.version()).toBe(4);
    expect(moneyBytesDigest(f.control.db)).toBe(before);
    expect(f.schema()).toBe(shape);
    expect(f.control.db.prepare("SELECT name FROM sqlite_master WHERE name='control_billing_log'").get()).toBeUndefined();
  } finally { f.close(); }
});

it("explicit v5 installation preserves every original money row and unresolved foreign-key binding", () => {
  const f = fixture();
  try {
    const before = moneyBytesDigest(f.control.db);
    expect(f.version()).toBe(4);
    expect(f.control.db.prepare("SELECT name FROM sqlite_master WHERE name='control_billing_log'").get()).toBeUndefined();
    f.install();
    expect(f.version()).toBe(5);
    expect(moneyBytesDigest(f.control.db)).toBe(before);
    expect(f.control.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(f.control.db.prepare("SELECT state,actual_micro_usd FROM managed_reservations WHERE call_id=?").get(f.calls.dispatched))
      .toMatchObject({ state: "dispatched", actual_micro_usd: null });
    const shape = f.schema();
    f.install();
    expect(f.schema()).toBe(shape);
    expect(moneyBytesDigest(f.control.db)).toBe(before);
  } finally { f.close(); }
});

it.each([{ offline: false, workers_terminated: true }, { offline: true, workers_terminated: false }])(
  "installation refuses missing offline acknowledgements without writes: %j", (acks) => {
    const f = fixture();
    try {
      const shape = f.schema(), before = moneyBytesDigest(f.control.db);
      expect(() => installBillingMoney5({ root: f.root, control: f.control, ...acks })).toThrow(BrainError);
      expect(f.version()).toBe(4); expect(f.schema()).toBe(shape);
      expect(moneyBytesDigest(f.control.db)).toBe(before);
    } finally { f.close(); }
  },
);

it("an actual failed final COMMIT leaves genuine v4 DDL and money untouched", () => {
  const f = fixture();
  try {
    const before = moneyBytesDigest(f.control.db), shape = f.schema();
    f.control.db.setAuthorizer((action, operation) => action === constants.SQLITE_TRANSACTION && operation === "COMMIT"
      ? constants.SQLITE_DENY : constants.SQLITE_OK);
    expect(() => f.install()).toThrow();
    f.control.db.setAuthorizer(null);
    expect(f.version()).toBe(4); expect(f.schema()).toBe(shape);
    expect(moneyBytesDigest(f.control.db)).toBe(before);
    expect(f.control.db.isTransaction).toBe(false);
  } finally { f.close(); }
});

it("a silently ignored v5 marker insert cannot leave a partially installed authority schema", () => {
  const f = fixture();
  try {
    const before = moneyBytesDigest(f.control.db), shape = f.schema();
    f.control.db.setAuthorizer((action, table) => action === constants.SQLITE_INSERT && table === "managed_money_schema"
      ? constants.SQLITE_IGNORE : constants.SQLITE_OK);
    expect(() => f.install()).toThrow();
    f.control.db.setAuthorizer(null);
    expect(f.version()).toBe(4); expect(f.schema()).toBe(shape);
    expect(moneyBytesDigest(f.control.db)).toBe(before);
  } finally { f.close(); }
});

it("installation cannot report success when SQLite silently ignores its COMMIT", () => {
  const f = fixture();
  try {
    const shape = f.schema(), before = moneyBytesDigest(f.control.db);
    let ignored = false;
    f.control.db.setAuthorizer((action, operation) => {
      if (action === constants.SQLITE_TRANSACTION && operation === "COMMIT") {
        ignored = true; return constants.SQLITE_IGNORE;
      }
      return constants.SQLITE_OK;
    });
    expect(() => f.install()).toThrow();
    f.control.db.setAuthorizer(null);
    expect(ignored).toBe(true);
    expect(f.control.db.isTransaction).toBe(false);
    expect(f.version()).toBe(4); expect(f.schema()).toBe(shape);
    expect(moneyBytesDigest(f.control.db)).toBe(before);
  } finally {
    f.control.db.setAuthorizer(null);
    if (f.control.db.isTransaction) f.control.db.exec("ROLLBACK");
    f.close();
  }
});

it("a future-version root is refused before any new schema object or row is installed", () => {
  const f = fixture();
  try {
    f.control.db.prepare("INSERT INTO managed_money_schema VALUES(6,?)").run(AT);
    const before = moneyBytesDigest(f.control.db), shape = f.schema();
    expect(() => f.install()).toThrow(BrainError);
    expect(f.version()).toBe(6); expect(f.schema()).toBe(shape);
    expect(moneyBytesDigest(f.control.db)).toBe(before);
  } finally { f.close(); }
});

it("a changed v4 schema is not normalized into an implicitly trusted billing installation", () => {
  const f = fixture();
  try {
    f.control.db.exec("ALTER TABLE managed_reservations ADD COLUMN synthetic_unreviewed TEXT");
    const shape = f.schema(), before = moneyBytesDigest(f.control.db);
    expect(() => f.install()).toThrow(BrainError);
    expect(f.version()).toBe(4); expect(f.schema()).toBe(shape);
    expect(moneyBytesDigest(f.control.db)).toBe(before);
  } finally { f.close(); }
});

it("missing immutable-money triggers are rejected, not healed during installation", () => {
  const f = fixture();
  try {
    f.control.db.exec("DROP TRIGGER managed_resolutions_no_update");
    const shape = f.schema(), before = moneyBytesDigest(f.control.db);
    expect(() => f.install()).toThrow(BrainError);
    expect(f.version()).toBe(4); expect(f.schema()).toBe(shape);
    expect(moneyBytesDigest(f.control.db)).toBe(before);
  } finally { f.close(); }
});

it("an existing caller transaction is refused without committing or rolling it back", () => {
  const f = fixture();
  try {
    f.control.db.exec("BEGIN IMMEDIATE");
    const shape = f.schema(), before = moneyBytesDigest(f.control.db);
    expect(() => f.install()).toThrow(BrainError);
    expect(f.control.db.isTransaction).toBe(true);
    expect(f.version()).toBe(4); expect(f.schema()).toBe(shape);
    expect(moneyBytesDigest(f.control.db)).toBe(before);
    f.control.db.exec("ROLLBACK");
  } finally { if (f.control.db.isTransaction) f.control.db.exec("ROLLBACK"); f.close(); }
});

it("v5 reopen rejects a missing authority table instead of silently recreating lost history", () => {
  const f = fixture();
  try {
    f.install();
    f.control.db.exec("PRAGMA foreign_keys=OFF");
    f.control.db.exec("DROP TABLE control_billing_terms");
    f.control.db.exec("PRAGMA foreign_keys=ON");
    const shape = f.schema(), before = moneyBytesDigest(f.control.db);
    expect(() => new ManagedSpendingStore(f.control, clock)).toThrow(BrainError);
    expect(f.schema()).toBe(shape);
    expect(moneyBytesDigest(f.control.db)).toBe(before);
    expect(f.control.db.prepare("SELECT name FROM sqlite_master WHERE name='control_billing_terms'").get()).toBeUndefined();
  } finally { f.close(); }
});

it("v5 reopen validates retained money tables too, not only the added billing namespace", () => {
  const f = fixture();
  try {
    f.install();
    f.control.db.exec("PRAGMA foreign_keys=OFF");
    f.control.db.exec("DROP TABLE managed_resolutions");
    f.control.db.exec("PRAGMA foreign_keys=ON");
    const shape = f.schema(), before = moneyBytesDigest(f.control.db);
    expect(() => new ManagedSpendingStore(f.control, clock)).toThrow(BrainError);
    expect(f.schema()).toBe(shape);
    expect(moneyBytesDigest(f.control.db)).toBe(before);
  } finally { f.close(); }
});

it("unenrolled v5 denies a reserved call's mark without an optional caller guard but still settles known usage", () => {
  const f = fixture();
  try {
    f.install();
    const store = new ManagedSpendingStore(f.control, clock);
    expect(store.settleKnown(f.calls.dispatched, 7)).toMatchObject({ state: "settled", actual_micro_usd: 7 });
    expect(store.serviceBarrier()).toEqual({ paused: false, reason: null });
    expect(() => store.mark(f.calls.reserved, { per_job_micro_usd: 1000, user_daily_micro_usd: 1000, time_zone: "UTC" }))
      .toThrow(BrainError);
    expect(store.readReceipt(f.calls.reserved)).toMatchObject({ state: "reserved" });
    expect(() => store.reserve({ account_id: f.account.id, job_id: randomUUID(), dispatch_key: "reasoning",
      stage: "reasoning", reserved_micro_usd: 1, provider: "synthetic", model: "SYNTHETIC-model",
      price_version: "SYNTHETIC-price", request_hash: "a".repeat(64), config_hash: "b".repeat(64),
      limits: { per_job_micro_usd: 1000, user_daily_micro_usd: 1000, time_zone: "UTC" } })).toThrow(BrainError);
  } finally { f.close(); }
});
