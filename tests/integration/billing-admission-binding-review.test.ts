import { randomUUID } from "node:crypto";
import { constants } from "node:sqlite";
import { expect, it } from "vitest";
import { BrainError } from "../../packages/domain/logic.ts";
import { BillingAuthority } from "../../packages/storage/billing-authority.ts";
import { createBillingAdmissionFixture } from "../helpers/billing-admission-fixture.ts";

async function fixture() {
  const f = createBillingAdmissionFixture({ enrolled: true });
  try {
    const prepared = await f.prepare();
    if (prepared.state !== "prepared") throw new Error("Synthetic admission did not prepare.");
    expect(f.admit(prepared.preflight_id).state).toBe("admitted");
    const authority = new BillingAuthority({ control: f.control, root: f.root,
      clock: f.control.clock, source: { read: async () => f.facts } });
    expect((await authority.reconcile(f.account_id)).state).toBe("granted");
    const limits = { per_job_micro_usd: 100, user_daily_micro_usd: 500, time_zone: "UTC" };
    const spec = () => ({ account_id: f.account_id, job_id: randomUUID(), dispatch_key: "reasoning",
      stage: "reasoning" as const, reserved_micro_usd: 3, provider: "synthetic", model: "SYNTHETIC-model",
      price_version: "SYNTHETIC-price", request_hash: "a".repeat(64), config_hash: "b".repeat(64), limits });
    return { f, limits, spec };
  } catch (error) { f.close(); throw error; }
}

it("reserve atomically retains the exact admission, generation, grant and original central period", async () => {
  const { f, limits, spec } = await fixture();
  try {
    const reserved = f.spending.reserve(spec());
    const proof = f.control.db.prepare("SELECT * FROM control_billing_reservation WHERE call_id=?").get(reserved.call_id);
    const admission = f.control.db.prepare("SELECT admission_ordinal FROM control_billing_account WHERE account_id=?")
      .get(f.account_id) as { admission_ordinal: number };
    const grant = f.control.db.prepare("SELECT journal_ordinal,term_id,window_id FROM control_billing_period WHERE period_id=?")
      .get(reserved.account_period_id) as { journal_ordinal: number; term_id: string; window_id: string };
    expect(proof).toMatchObject({ call_id: reserved.call_id, account_id: f.account_id,
      epoch: f.policy.epoch, admission_ordinal: admission.admission_ordinal,
      tenant_incarnation: f.binding.tenant_incarnation, provisioning_generation: f.binding.provisioning_generation,
      term_id: grant.term_id, window_id: grant.window_id, period_id: reserved.account_period_id,
      grant_ordinal: grant.journal_ordinal });
    expect((proof as { proof_mac: string }).proof_mac).toMatch(/^[a-f0-9]{64}$/);
    expect(() => f.control.db.prepare("UPDATE control_billing_reservation SET provisioning_generation=99 WHERE call_id=?")
      .run(reserved.call_id)).toThrow();
    expect(f.spending.mark(reserved.call_id, limits).state).toBe("dispatched");
    expect(f.control.db.prepare("SELECT * FROM control_billing_reservation WHERE call_id=?").get(reserved.call_id)).toEqual(proof);
    expect(f.spending.settleKnown(reserved.call_id, 2).state).toBe("settled");
    expect(f.control.db.prepare("SELECT * FROM control_billing_reservation WHERE call_id=?").get(reserved.call_id)).toEqual(proof);
  } finally { f.close(); }
});

it("a denied reservation-proof insert rolls back both the hold and accounting-time-zone freeze", async () => {
  const { f, spec } = await fixture();
  try {
    const before = f.control.db.prepare("SELECT * FROM managed_account_policy WHERE account_id=?").get(f.account_id);
    let deniedProofInsert = false;
    f.control.db.setAuthorizer((action, table) => {
      if (action === constants.SQLITE_INSERT && table === "control_billing_reservation") {
        deniedProofInsert = true; return constants.SQLITE_DENY;
      }
      return constants.SQLITE_OK;
    });
    expect(() => f.spending.reserve(spec())).toThrow();
    f.control.db.setAuthorizer(null);
    expect(deniedProofInsert).toBe(true);
    expect(f.control.db.prepare("SELECT COUNT(*) AS n FROM managed_reservations").get()).toMatchObject({ n: 0 });
    expect(f.control.db.prepare("SELECT * FROM managed_account_policy WHERE account_id=?").get(f.account_id)).toEqual(before);
    expect(f.control.db.isTransaction).toBe(false);
  } finally { f.control.db.setAuthorizer(null); f.close(); }
});

it("a silently ignored reservation-proof insert cannot leave an unfenced hold", async () => {
  const { f, spec } = await fixture();
  try {
    let ignored = false;
    f.control.db.setAuthorizer((action, table) => {
      if (action === constants.SQLITE_INSERT && table === "control_billing_reservation") {
        ignored = true; return constants.SQLITE_IGNORE;
      }
      return constants.SQLITE_OK;
    });
    expect(() => f.spending.reserve(spec())).toThrow();
    f.control.db.setAuthorizer(null);
    expect(ignored).toBe(true);
    expect(f.control.db.prepare("SELECT COUNT(*) AS n FROM managed_reservations").get()).toMatchObject({ n: 0 });
    expect(f.control.db.prepare("SELECT COUNT(*) AS n FROM control_billing_reservation").get()).toMatchObject({ n: 0 });
  } finally { f.control.db.setAuthorizer(null); f.close(); }
});

it("a silently ignored final COMMIT cannot return an undurable funding reservation", async () => {
  const { f, spec } = await fixture();
  try {
    f.spending.billing.prepareForSend(f.control.db);
    let ignoredCommit = false;
    f.control.db.setAuthorizer((action, operation) => {
      if (action === constants.SQLITE_TRANSACTION && operation === "COMMIT") {
        ignoredCommit = true; return constants.SQLITE_IGNORE;
      }
      return constants.SQLITE_OK;
    });
    expect(() => f.spending.reserve(spec())).toThrow();
    f.control.db.setAuthorizer(null);
    expect(ignoredCommit).toBe(true);
    expect(f.control.db.isTransaction).toBe(false);
    expect(f.control.db.prepare("SELECT COUNT(*) AS n FROM managed_reservations").get()).toMatchObject({ n: 0 });
  } finally {
    f.control.db.setAuthorizer(null);
    if (f.control.db.isTransaction) f.control.db.exec("ROLLBACK");
    f.close();
  }
});

it("a raw immutable-call substitution cannot acquire the old reservation's permission to mark", async () => {
  const { f, limits, spec } = await fixture();
  try {
    const reserved = f.spending.reserve(spec());
    f.control.db.prepare("UPDATE managed_reservations SET model=? WHERE call_id=?")
      .run("SYNTHETIC-substituted-model", reserved.call_id);
    expect(() => f.spending.mark(reserved.call_id, limits)).toThrow(BrainError);
    expect(f.spending.readReceipt(reserved.call_id)).toMatchObject({ state: "reserved" });
  } finally { f.close(); }
});

it("a raw immutable-call substitution after mark cannot pass the pre-I/O check or refund the hold", async () => {
  const { f, limits, spec } = await fixture();
  try {
    const reserved = f.spending.reserve(spec());
    f.spending.mark(reserved.call_id, limits);
    f.control.db.prepare("UPDATE managed_reservations SET request_hash=? WHERE call_id=?")
      .run("e".repeat(64), reserved.call_id);
    expect(() => f.spending.assertFundingForExecution(reserved.call_id)).toThrow(BrainError);
    expect(f.spending.readReceipt(reserved.call_id)).toMatchObject({ state: "dispatched", actual_micro_usd: null });
    expect(f.spending.settleKnown(reserved.call_id, 2)).toMatchObject({ state: "settled", actual_micro_usd: 2 });
  } finally { f.close(); }
});

it("losing the immutable proof cannot downgrade a billing reservation into an adoptable legacy call", async () => {
  const { f, limits, spec } = await fixture();
  try {
    const reserved = f.spending.reserve(spec());
    const triggers = f.control.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name='control_billing_reservation'")
      .all() as { name: string; sql: string }[];
    for (const row of triggers) f.control.db.exec(`DROP TRIGGER "${row.name.replaceAll('"', '""')}"`);
    f.control.db.prepare("DELETE FROM control_billing_reservation WHERE call_id=?").run(reserved.call_id);
    for (const row of triggers) f.control.db.exec(row.sql);
    expect(() => f.spending.mark(reserved.call_id, limits)).toThrow(BrainError);
    expect(f.spending.readReceipt(reserved.call_id)).toMatchObject({ state: "reserved", actual_micro_usd: null });
  } finally { f.close(); }
});
