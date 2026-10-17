import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { BrainError } from "../../packages/domain/logic.ts";
import { BillingAuthority } from "../../packages/storage/billing-authority.ts";
import { createBillingAdmissionFixture } from "../helpers/billing-admission-fixture.ts";

// Positive and negative financial behavior through the ACTUAL central ledger.
// The test-only fixture creates protected synthetic enrollment, not a live activation.
async function fixture(cadence: "monthly" | "annual" = "monthly") {
  const input = { cadence, enrolled: true };
  const f = createBillingAdmissionFixture(input);
  try {
    const prepared = await f.prepare();
    if (prepared.state !== "prepared") throw new Error("Synthetic admission did not prepare.");
    expect(f.admit(prepared.preflight_id).state).toBe("admitted");
    const authority = new BillingAuthority({ control: f.control, root: f.root,
      clock: f.control.clock, source: { read: async () => f.facts } });
    expect((await authority.reconcile(f.account_id)).state).toBe("granted");
    expect(f.spending.billing.classify(f.control.db, f.account_id)).toBe("billing");
    const plan = f.policy.catalog.find((p) => p.cadence === cadence)!;
    const limits = { per_job_micro_usd: plan.per_job_micro_usd, user_daily_micro_usd: plan.user_daily_micro_usd, time_zone: "UTC" };
    const spec = () => ({ account_id: f.account_id, job_id: randomUUID(), dispatch_key: "reasoning",
      stage: "reasoning" as const, reserved_micro_usd: 3, provider: "synthetic", model: "SYNTHETIC-model",
      price_version: "SYNTHETIC-price", request_hash: "a".repeat(64), config_hash: "b".repeat(64), limits });
    return { f, authority, limits, spec };
  } catch (error) { f.close(); throw error; }
}

it("a correctly enrolled and admitted account can reserve, freshly mark and settle a known charge", async () => {
  const { f, limits, spec } = await fixture();
  try {
    const reserved = f.spending.reserve(spec());
    expect(reserved.state).toBe("reserved");
    expect(f.spending.mark(reserved.call_id, limits).state).toBe("dispatched");
    expect(f.spending.settleKnown(reserved.call_id, 2)).toMatchObject({ state: "settled", actual_micro_usd: 2,
      account_period_id: reserved.account_period_id });
  } finally { f.close(); }
});

it("a signed refund prevents an old reserved call's mark without discarding the reservation", async () => {
  const { f, authority, limits, spec } = await fixture();
  try {
    const reserved = f.spending.reserve(spec());
    f.setFacts({ ...f.facts, current_state: "refunded" });
    expect((await authority.reconcile(f.account_id)).state).toBe("denied");
    expect(() => f.spending.mark(reserved.call_id, limits)).toThrow(BrainError);
    expect(f.spending.readReceipt(reserved.call_id)).toMatchObject({ state: "reserved",
      account_period_id: reserved.account_period_id });
  } finally { f.close(); }
});

it("known in-flight usage still settles after a signed refund", async () => {
  const { f, authority, limits, spec } = await fixture();
  try {
    const reserved = f.spending.reserve(spec());
    f.spending.mark(reserved.call_id, limits);
    f.setFacts({ ...f.facts, current_state: "refunded" });
    expect((await authority.reconcile(f.account_id)).state).toBe("denied");
    expect(f.spending.settleKnown(reserved.call_id, 2)).toMatchObject({ state: "settled", actual_micro_usd: 2,
      account_period_id: reserved.account_period_id });
  } finally { f.close(); }
});

it("a reserved call cannot silently rebind to a new annual month when its original window expires", async () => {
  const { f, authority, limits, spec } = await fixture("annual");
  try {
    f.setNow("2027-02-27T23:55:00.000Z");
    f.setFacts({ ...f.facts, verified_at: "2027-02-27T23:55:00.000Z" });
    expect((await authority.reconcile(f.account_id)).state).toBe("granted");
    const reserved = f.spending.reserve(spec());
    f.setNow("2027-02-28T00:01:00.000Z");
    expect(authority.ensureCurrentGrant(f.account_id).state).toBe("granted");
    expect(() => f.spending.mark(reserved.call_id, limits)).toThrow(BrainError);
    expect(f.spending.readReceipt(reserved.call_id)).toMatchObject({ state: "reserved",
      account_period_id: reserved.account_period_id });
  } finally { f.close(); }
});

it("an unresolved dispatched hold remains bound to its original period across annual monthly renewal", async () => {
  const { f, authority, limits, spec } = await fixture("annual");
  try {
    const reserved = f.spending.reserve(spec());
    f.spending.mark(reserved.call_id, limits);
    const before = f.control.db.prepare("SELECT * FROM managed_reservations WHERE call_id=?").get(reserved.call_id);
    f.setNow("2027-02-28T12:00:00.000Z");
    f.setFacts({ ...f.facts, verified_at: "2027-02-28T12:00:00.000Z" });
    expect((await authority.reconcile(f.account_id)).state).toBe("granted");
    expect(f.control.db.prepare("SELECT * FROM managed_reservations WHERE call_id=?").get(reserved.call_id)).toEqual(before);
    expect(() => f.spending.reserve(spec())).toThrow(BrainError);
    expect(f.spending.serviceBarrier()).toEqual({ paused: true, reason: "usage_pending" });
    expect(f.spending.settleKnown(reserved.call_id, 2)).toMatchObject({ state: "settled",
      account_period_id: reserved.account_period_id });
  } finally { f.close(); }
});

it("the pre-send central check refuses expired freshness without releasing a marked hold", async () => {
  const { f, limits, spec } = await fixture();
  try {
    const reserved = f.spending.reserve(spec());
    f.spending.mark(reserved.call_id, limits);
    expect(() => f.spending.assertFundingForExecution(reserved.call_id)).not.toThrow();
    const before = f.control.db.prepare("SELECT * FROM managed_reservations WHERE call_id=?").get(reserved.call_id);
    f.setNow("2027-01-31T12:15:00.000Z");
    expect(() => f.spending.assertFundingForExecution(reserved.call_id)).toThrow(BrainError);
    expect(f.control.db.prepare("SELECT * FROM managed_reservations WHERE call_id=?").get(reserved.call_id)).toEqual(before);
    expect(f.spending.settleKnown(reserved.call_id, 2)).toMatchObject({ state: "settled", actual_micro_usd: 2 });
  } finally { f.close(); }
});

it("a generation change between durable mark and transport is refused by the central pre-send check", async () => {
  const { f, limits, spec } = await fixture();
  try {
    const reserved = f.spending.reserve(spec());
    f.spending.mark(reserved.call_id, limits);
    expect(() => f.spending.assertFundingForExecution(reserved.call_id)).not.toThrow();
    const before = f.control.db.prepare("SELECT * FROM managed_reservations WHERE call_id=?").get(reserved.call_id);
    f.control.db.prepare("UPDATE managed_account_incarnation SET incarnation=?,provisioning_generation=provisioning_generation+1 WHERE account_id=?")
      .run("f".repeat(64), f.account_id);
    expect(() => f.spending.assertFundingForExecution(reserved.call_id)).toThrow(BrainError);
    expect(f.control.db.prepare("SELECT * FROM managed_reservations WHERE call_id=?").get(reserved.call_id)).toEqual(before);
    expect(f.spending.settleKnown(reserved.call_id, 2)).toMatchObject({ state: "settled", actual_micro_usd: 2 });
  } finally { f.close(); }
});

it("warm reserve and mark do not scan journal history while holding the monetary write transaction", async () => {
  const { f, limits, spec } = await fixture();
  let restore = () => {};
  try {
    const first = f.spending.reserve(spec());
    f.spending.mark(first.call_id, limits);
    f.spending.settleKnown(first.call_id, 2);
    const fullHistoryReads: string[] = [];
    let monetaryReads = 0;
    const prepare = f.control.db.prepare.bind(f.control.db);
    // Observe actual SQL while still executing the original statements. This
    // checks the material lock-duration invariant, not a mocked authorization.
    const observed = vi.spyOn(f.control.db, "prepare").mockImplementation((sql: string) => {
      if (f.control.db.isTransaction) monetaryReads += 1;
      if (f.control.db.isTransaction && /\bFROM\s+control_billing_log\b/i.test(sql) &&
          !/\bordinal\s*=\s*\?/i.test(sql)) fullHistoryReads.push(sql);
      return prepare(sql);
    });
    restore = () => observed.mockRestore();
    const next = f.spending.reserve(spec());
    expect(f.spending.mark(next.call_id, limits).state).toBe("dispatched");
    expect(monetaryReads).toBeGreaterThan(0);
    expect(fullHistoryReads).toEqual([]);
  } finally { restore(); f.close(); }
});

it("a forward annual grant refresh reads only the new journal suffix, not the full verified history", async () => {
  const { f, authority, limits, spec } = await fixture("annual");
  let restore = () => {};
  try {
    const first = f.spending.reserve(spec());
    f.spending.mark(first.call_id, limits);
    f.spending.settleKnown(first.call_id, 2);
    const original = f.control.db.prepare("SELECT ordinal FROM control_billing_head WHERE singleton=1").get() as { ordinal: number };
    f.setNow("2027-02-28T12:00:00.000Z");
    f.setFacts({ ...f.facts, verified_at: "2027-02-28T12:00:00.000Z" });
    expect((await authority.reconcile(f.account_id)).state).toBe("granted");
    expect((f.control.db.prepare("SELECT ordinal FROM control_billing_head WHERE singleton=1").get() as { ordinal: number }).ordinal)
      .toBeGreaterThan(original.ordinal);
    const scans: string[] = [];
    const prepare = f.control.db.prepare.bind(f.control.db);
    const observed = vi.spyOn(f.control.db, "prepare").mockImplementation((sql: string) => {
      if (/\bFROM\s+control_billing_log\b/i.test(sql) && !/\bordinal\s*=\s*\?/i.test(sql)) scans.push(sql);
      return prepare(sql);
    });
    restore = () => observed.mockRestore();
    const next = f.spending.reserve(spec());
    expect(f.spending.mark(next.call_id, limits).state).toBe("dispatched");
    expect(scans.length).toBeGreaterThan(0);
    // Point reads reauthenticate current dependencies. Every non-point log read
    // must be explicitly bounded to a forward suffix, never a COUNT/SUM or genesis scan.
    expect(scans.filter((sql) => !/\bordinal\s*(?:>\s*\?|>=\s*\?|BETWEEN\s+\?)/i.test(sql))).toEqual([]);
  } finally { restore(); f.close(); }
});

it("a cached signed revocation cannot disappear by deleting its log row while leaving its known head intact", async () => {
  const { f, authority, spec } = await fixture();
  try {
    f.setFacts({ ...f.facts, current_state: "refunded" });
    expect((await authority.reconcile(f.account_id)).state).toBe("denied");
    f.spending.billing.prepareForSend(f.control.db);
    const ordinal = (f.control.db.prepare("SELECT ordinal FROM control_billing_head WHERE singleton=1").get() as { ordinal: number }).ordinal;
    const tables = ["control_billing_log", "control_billing_denials"];
    const triggers = tables.flatMap((table) => f.control.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name=?")
      .all(table) as { name: string; sql: string }[]);
    for (const row of triggers) f.control.db.exec(`DROP TRIGGER "${row.name.replaceAll('"', '""')}"`);
    f.control.db.exec("PRAGMA foreign_keys=OFF");
    f.control.db.prepare("DELETE FROM control_billing_denials WHERE journal_ordinal=?").run(ordinal);
    f.control.db.prepare("DELETE FROM control_billing_log WHERE ordinal=?").run(ordinal);
    f.control.db.exec("UPDATE control_billing_account SET adverse_generation=0");
    f.control.db.exec("PRAGMA foreign_keys=ON");
    for (const row of triggers) f.control.db.exec(row.sql);
    expect(() => f.spending.reserve(spec())).toThrow(BrainError);
    expect(f.control.db.prepare("SELECT COUNT(*) AS n FROM managed_reservations").get()).toMatchObject({ n: 0 });
  } finally { f.close(); }
});

it("deleting only the v5 marker cannot downgrade an enrolled root into legacy funding", async () => {
  const { f, spec } = await fixture();
  try {
    f.control.db.exec("DELETE FROM managed_money_schema WHERE version=5");
    expect(() => f.spending.reserve(spec())).toThrow(BrainError);
    expect(f.control.db.prepare("SELECT COUNT(*) AS n FROM managed_reservations").get()).toMatchObject({ n: 0 });
  } finally { f.close(); }
});
