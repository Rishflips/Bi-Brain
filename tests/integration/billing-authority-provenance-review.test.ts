import { createHash } from "node:crypto";
import { constants } from "node:sqlite";
import { expect, it } from "vitest";
import { BrainError, canonical } from "../../packages/domain/logic.ts";
import { createBillingAuthorityFixture } from "../helpers/billing-authority-fixture.ts";

// Parent review: raw projection edits must not defeat the retained signed journal.
// Disposable SYNTHETIC history only. No payment/provider access or live keys.
type Fixture = ReturnType<typeof createBillingAuthorityFixture>;
async function denied(action: () => unknown | Promise<unknown>) {
  let value: unknown;
  try { value = await action(); }
  catch (error) { expect(error).toBeInstanceOf(BrainError); return; }
  expect((value as { state: string }).state).not.toBe("granted");
}
function rawEdit(f: Fixture, table: string, edit: () => void) {
  const triggers = f.control.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name=?")
    .all(table) as { name: string; sql: string }[];
  for (const row of triggers) f.control.db.exec(`DROP TRIGGER "${row.name.replaceAll('"', '""')}"`);
  try { edit(); } finally { for (const row of triggers) f.control.db.exec(row.sql); }
}

it("deleting denial projections and resetting their counter cannot erase a retained signed revocation", async () => {
  const f = createBillingAuthorityFixture();
  try {
    await f.authority.reconcile(f.account_id);
    f.setFacts({ ...f.facts, current_state: "refunded" });
    await f.authority.reconcile(f.account_id);
    rawEdit(f, "control_billing_denials", () => f.control.db.exec("DELETE FROM control_billing_denials"));
    f.control.db.exec("UPDATE control_billing_account SET adverse_generation=0");
    await denied(() => f.authority.billingEligibility(f.account_id));
    f.setFacts({ ...f.facts, current_state: "active" });
    await denied(() => f.authority.reconcile(f.account_id));
  } finally { f.close(); }
});

it("a rehashed receipt plus a missing freshness cache cannot replace the original journal payment reference", async () => {
  const f = createBillingAuthorityFixture();
  try {
    await f.authority.reconcile(f.account_id);
    const row = f.control.db.prepare("SELECT receipt_json FROM control_billing_terms").get() as { receipt_json: string };
    const text = canonical({ ...JSON.parse(row.receipt_json), transaction_ref: "SYNTHETIC-forged-receipt" });
    rawEdit(f, "control_billing_terms", () => f.control.db.prepare("UPDATE control_billing_terms SET receipt_json=?,receipt_digest=?")
      .run(text, createHash("sha256").update(text).digest("hex")));
    f.control.db.exec("DELETE FROM control_billing_freshness");
    f.setFacts({ ...f.facts, transaction_ref: "SYNTHETIC-forged-receipt" });
    await denied(() => f.authority.reconcile(f.account_id));
  } finally { f.close(); }
});

it("a retained receipt must reference its actual grant ordinal, not merely any valid journal row", async () => {
  const f = createBillingAuthorityFixture();
  try {
    await f.authority.reconcile(f.account_id);
    rawEdit(f, "control_billing_terms", () => f.control.db.exec("UPDATE control_billing_terms SET journal_ordinal=0"));
    await denied(() => f.authority.billingEligibility(f.account_id));
  } finally { f.close(); }
});

it("a retained grant cannot be reminted after its projection and central period are deleted", async () => {
  const f = createBillingAuthorityFixture();
  try {
    await f.authority.reconcile(f.account_id);
    f.control.db.exec("PRAGMA foreign_keys=OFF");
    rawEdit(f, "control_billing_period", () => f.control.db.exec("DELETE FROM control_billing_period"));
    f.control.db.exec("DELETE FROM managed_account_periods");
    f.control.db.exec("PRAGMA foreign_keys=ON");
    await denied(() => f.authority.reconcile(f.account_id));
    expect(f.control.db.prepare("SELECT COUNT(*) AS n FROM managed_account_periods").get()).toMatchObject({ n: 0 });
  } finally { f.close(); }
});

it("a term's stored epoch must match the originating grant, even after a raw foreign-key bypass", async () => {
  const f = createBillingAuthorityFixture();
  try {
    await f.authority.reconcile(f.account_id);
    f.control.db.exec("PRAGMA foreign_keys=OFF");
    rawEdit(f, "control_billing_terms", () => f.control.db.exec("UPDATE control_billing_terms SET epoch=epoch+1"));
    f.control.db.exec("PRAGMA foreign_keys=ON");
    await denied(() => f.authority.billingEligibility(f.account_id));
  } finally { f.close(); }
});

it("a foreign-epoch record cannot be hidden by filtering the journal to the current epoch", async () => {
  const f = createBillingAuthorityFixture();
  try {
    await f.authority.reconcile(f.account_id);
    f.control.db.prepare("INSERT INTO control_billing_log VALUES(?,?,?,?)")
      .run(f.policy.epoch + 1, 0, "{}", "a".repeat(64));
    await denied(() => f.authority.billingEligibility(f.account_id));
  } finally { f.close(); }
});

it("an existing-window refresh cannot report granted when its exact central period was revoked", async () => {
  const f = createBillingAuthorityFixture();
  try {
    await f.authority.reconcile(f.account_id);
    f.control.db.exec("UPDATE managed_account_periods SET state='revoked'");
    await denied(() => f.authority.reconcile(f.account_id));
  } finally { f.close(); }
});

it("another transaction for the same annual term cannot be introduced via a new monthly window", async () => {
  const f = createBillingAuthorityFixture({ cadence: "annual" });
  try {
    await f.authority.reconcile(f.account_id);
    f.setNow("2027-02-28T12:00:00.000Z");
    f.setFacts({ ...f.facts, transaction_ref: "SYNTHETIC-another-payment-same-term", verified_at: "2027-02-28T12:00:00.000Z" });
    await denied(() => f.authority.reconcile(f.account_id));
    expect(f.control.db.prepare("SELECT COUNT(*) AS n FROM managed_account_periods").get()).toMatchObject({ n: 1 });
  } finally { f.close(); }
});

it("a second paid annual year gets only its current monthly allowance and a distinct grant", async () => {
  const f = createBillingAuthorityFixture({ cadence: "annual" });
  try {
    expect((await f.authority.reconcile(f.account_id)).state).toBe("granted");
    const original = f.control.db.prepare("SELECT * FROM managed_account_periods").get();
    f.setNow("2028-02-29T12:00:00.000Z");
    f.setFacts({ ...f.facts, transaction_ref: "SYNTHETIC-next-annual-year",
      paid_period_start: "2028-01-31T00:00:00.000Z", paid_period_end: "2029-01-31T00:00:00.000Z",
      verified_at: "2028-02-29T12:00:00.000Z" });
    expect((await f.authority.reconcile(f.account_id)).state).toBe("granted");
    expect(f.authority.billingEligibility(f.account_id)).toMatchObject({ state: "granted",
      window_start: "2028-02-29T00:00:00.000Z", window_end: "2028-03-31T00:00:00.000Z" });
    expect(f.control.db.prepare("SELECT COUNT(*) AS n FROM managed_account_periods").get()).toMatchObject({ n: 2 });
    expect(f.control.db.prepare("SELECT COUNT(*) AS n FROM control_billing_terms").get()).toMatchObject({ n: 2 });
    expect(f.control.db.prepare("SELECT * FROM managed_account_periods ORDER BY starts_at LIMIT 1").get()).toEqual(original);
    expect((await f.authority.reconcile(f.account_id)).state).toBe("granted");
    expect(f.control.db.prepare("SELECT COUNT(*) AS n FROM managed_account_periods").get()).toMatchObject({ n: 2 });
  } finally { f.close(); }
});

it("clock rollback cannot make an observation from the future eligible", async () => {
  const f = createBillingAuthorityFixture();
  try {
    await f.authority.reconcile(f.account_id);
    f.setNow("2027-01-31T11:59:00.000Z");
    await denied(() => f.authority.billingEligibility(f.account_id));
    await denied(() => f.authority.ensureCurrentGrant(f.account_id));
  } finally { f.close(); }
});

it("a silently ignored freshness-frame update cannot commit a success with mismatched signed data", async () => {
  const f = createBillingAuthorityFixture();
  try {
    await f.authority.reconcile(f.account_id);
    const before = f.control.db.prepare("SELECT * FROM control_billing_freshness").get();
    f.setNow("2027-01-31T12:01:00.000Z");
    f.setFacts({ ...f.facts, verified_at: "2027-01-31T12:01:00.000Z" });
    f.control.db.setAuthorizer((action, table, column) =>
      action === constants.SQLITE_UPDATE && table === "control_billing_freshness" && column === "frame_json"
        ? constants.SQLITE_IGNORE : constants.SQLITE_OK);
    await denied(() => f.authority.reconcile(f.account_id));
    f.control.db.setAuthorizer(null);
    expect(f.control.db.prepare("SELECT * FROM control_billing_freshness").get()).toEqual(before);
    expect(f.control.db.isTransaction).toBe(false);
  } finally { f.control.db.setAuthorizer(null); f.close(); }
});
