import { createHash, randomUUID } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { constants } from "node:sqlite";
import { expect, it } from "vitest";
import { BrainError, canonical } from "../../packages/domain/logic.ts";
import { canonicalSealFrame, sealMac } from "../../packages/domain/billing-seal.ts";
import type { ProviderFacts, ServerOwnedBinding } from "../../packages/domain/billing-evidence.ts";
import { BillingAuthority } from "../../packages/storage/billing-authority.ts";
import { ManagedSpendingStore } from "../../packages/storage/managed-spending.ts";
import { createBillingAuthorityFixture } from "../helpers/billing-authority-fixture.ts";

// Parent-owned SYNTHETIC observations/admissions only. No provider or payment is contacted.
const NOW = "2027-01-31T12:00:00.000Z";
type Fixture = ReturnType<typeof createBillingAuthorityFixture>;
function facts(binding: ServerOwnedBinding, change: Partial<ProviderFacts> = {}): ProviderFacts {
  return {
    transaction_ref: binding.initial_transaction_ref,
    subscription_ref: binding.subscription_ref, customer_ref: binding.customer_ref,
    product_ref: binding.product_ref, price_ref: binding.price_ref, cadence: binding.cadence,
    completed_payment: true, current_state: "active", verified_at: NOW,
    paid_period_start: "2027-01-31T00:00:00.000Z",
    paid_period_end: binding.cadence === "annual" ? "2028-01-31T00:00:00.000Z" : "2027-02-28T00:00:00.000Z",
    ...change,
  };
}
function count(f: Fixture, table: string): number {
  return Number((f.control.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
}
function snapshot(f: Fixture): string {
  return createHash("sha256").update(canonical([
    "managed_account_periods", "managed_reservations", "managed_money_blocks", "managed_service_blocks",
    "control_billing_log", "control_billing_head", "control_billing_terms", "control_billing_period",
    "control_billing_freshness", "control_billing_account",
  ].map((table) => [table, f.control.db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()]))).digest("hex");
}
async function refuses(action: () => unknown | Promise<unknown>) {
  let result: unknown;
  try {
    result = await action();
  } catch (error) { expect(error).toBeInstanceOf(BrainError); return; }
  expect((result as { state: string }).state).not.toBe("granted");
}
function withoutImmutableTriggers(f: Fixture, table: string, mutation: () => void) {
  const rows = f.control.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name=?")
    .all(table) as { name: string; sql: string }[];
  for (const row of rows) f.control.db.exec(`DROP TRIGGER "${row.name.replaceAll('"', '""')}"`);
  try { mutation(); } finally { for (const row of rows) f.control.db.exec(row.sql); }
}
function reservedCall(f: Fixture, at = NOW) {
  const plan = f.policy.catalog.find((entry) => entry.cadence === f.binding.cadence)!;
  const ledger = new ManagedSpendingStore(f.control, () => new Date(at));
  const limits = { per_job_micro_usd: plan.per_job_micro_usd,
    user_daily_micro_usd: plan.user_daily_micro_usd, time_zone: "UTC" };
  const reservation = ledger.reserve({
    account_id: f.account_id, job_id: randomUUID(), dispatch_key: "reasoning", stage: "reasoning",
    reserved_micro_usd: 3, provider: "openai", model: "SYNTHETIC-model", price_version: "SYNTHETIC-price",
    request_hash: "a".repeat(64), config_hash: "b".repeat(64), limits,
  });
  ledger.mark(reservation.call_id, limits);
  return { ledger, reservation };
}

function secondSignedAccount(f: Fixture): ServerOwnedBinding {
  const account = f.control.provision("https://synthetic.invalid", "SYNTHETIC-second-owner");
  const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
  const binding = { ...f.binding, account_id: account.id,
    identity_digest: digest({ account_id: account.id, issuer: account.issuer, subject: account.subject }),
    customer_ref: "SYNTHETIC-second-customer", subscription_ref: "SYNTHETIC-second-subscription",
    initial_transaction_ref: "SYNTHETIC-second-initial", correlation_ref: "SYNTHETIC-second-correlation" };
  const plan = f.policy.catalog.find((entry) => entry.cadence === binding.cadence)!;
  f.control.db.prepare("INSERT INTO managed_account_policy VALUES(?,?,?,NULL,1,?)")
    .run(account.id, plan.per_job_micro_usd, plan.user_daily_micro_usd, NOW);
  const head = f.control.db.prepare("SELECT ordinal,mac FROM control_billing_head WHERE singleton=1").get() as { ordinal: number; mac: string };
  const proof = "d".repeat(64), bindingHash = digest(binding);
  const frame = { schema: 1, purpose: "admission", epoch: f.policy.epoch,
    root_nonce: f.policy.root_nonce, policy_id: f.policy.policy_id, ordinal: head.ordinal + 1,
    prev_mac: head.mac, source_ids: [`binding:${bindingHash}`, `baseline:${proof}`],
    body: { account_id: account.id, identity_digest: binding.identity_digest,
      tenant_incarnation: binding.tenant_incarnation, clean_baseline_proof: proof } };
  const mac = sealMac(frame, f.key);
  f.control.db.prepare("INSERT INTO control_billing_log VALUES(?,?,?,?)")
    .run(f.policy.epoch, frame.ordinal, canonicalSealFrame(frame), mac);
  f.control.db.prepare("UPDATE control_billing_head SET ordinal=?,mac=? WHERE singleton=1").run(frame.ordinal, mac);
  f.control.db.prepare("INSERT INTO control_billing_account VALUES(?,?,?,?,0)")
    .run(account.id, canonical(binding), bindingHash, frame.ordinal);
  return binding;
}

it("a null source cannot create authority, even from an already configured synthetic root", async () => {
  const f = createBillingAuthorityFixture({ source: null });
  try {
    const before = snapshot(f);
    expect(await f.authority.reconcile(f.account_id)).toEqual({ state: "denied", reason: "no_source" });
    expect(f.authority.billingEligibility(f.account_id).state).toBe("unavailable");
    expect(f.authority.ensureCurrentGrant(f.account_id).state).toBe("unavailable");
    expect(snapshot(f)).toBe(before);
  } finally { f.close(); }
});

it("a new null-source composition cannot adopt a grant cached by synthetic evidence", async () => {
  const f = createBillingAuthorityFixture();
  try {
    await f.authority.reconcile(f.account_id);
    const before = snapshot(f);
    const disabled = new BillingAuthority({ control: f.control, root: f.root, source: null, clock: () => new Date(NOW) });
    expect(disabled.billingEligibility(f.account_id).state).toBe("unavailable");
    expect(disabled.ensureCurrentGrant(f.account_id).state).toBe("unavailable");
    expect(await disabled.reconcile(f.account_id)).toEqual({ state: "denied", reason: "no_source" });
    expect(snapshot(f)).toBe(before);
  } finally { f.close(); }
});

it("reconciliation creates one original central period and replays never recharge it", async () => {
  const f = createBillingAuthorityFixture();
  try {
    expect((await f.authority.reconcile(f.account_id)).state).toBe("granted");
    const original = f.control.db.prepare("SELECT * FROM managed_account_periods").get();
    const head = f.control.db.prepare("SELECT * FROM control_billing_head").get();
    expect(count(f, "managed_account_periods")).toBe(1);
    expect((await f.authority.reconcile(f.account_id)).state).toBe("granted");
    expect(f.authority.ensureCurrentGrant(f.account_id).state).toBe("granted");
    expect(count(f, "managed_account_periods")).toBe(1);
    expect(count(f, "control_billing_period")).toBe(1);
    expect(f.control.db.prepare("SELECT * FROM managed_account_periods").get()).toEqual(original);
    expect(f.control.db.prepare("SELECT * FROM control_billing_head").get()).toEqual(head);
  } finally { f.close(); }
});

it.each(["customer_ref", "subscription_ref", "product_ref", "price_ref", "transaction_ref"] as const)(
  "a completed initial observation for another %s cannot be assigned to this account", async (field) => {
    const f = createBillingAuthorityFixture();
    try {
      f.setFacts(facts(f.binding, { [field]: "SYNTHETIC-someone-else" }));
      await refuses(() => f.authority.reconcile(f.account_id));
      expect(count(f, "managed_account_periods")).toBe(0);
    } finally { f.close(); }
  },
);

it("provider output cannot grant a budget or choose an account/generation", async () => {
  for (const extra of [{ allowance_micro_usd: 999999 }, { account_id: randomUUID() },
    { verified: true }, { adverse_generation: 0 }]) {
    const f = createBillingAuthorityFixture();
    try {
      f.setFacts({ ...facts(f.binding), ...extra } as ProviderFacts);
      await refuses(() => f.authority.reconcile(f.account_id));
      expect(count(f, "managed_account_periods")).toBe(0);
    } finally { f.close(); }
  }
});

it("another account's existing term cannot bypass this account's initial transaction correlation", async () => {
  const f = createBillingAuthorityFixture();
  try {
    await f.authority.reconcile(f.account_id);
    const other = secondSignedAccount(f);
    f.setFacts(facts(other, { transaction_ref: "SYNTHETIC-not-the-initial-checkout" }));
    await refuses(() => f.authority.reconcile(other.account_id));
    expect(f.control.db.prepare("SELECT COUNT(*) AS n FROM managed_account_periods WHERE account_id=?").get(other.account_id))
      .toMatchObject({ n: 0 });
    expect(count(f, "managed_account_periods")).toBe(1);
  } finally { f.close(); }
});

it.each(["2027-01-31T12:00:00.001Z", "2027-01-31T11:44:59.999Z", "2027-01-31T11:45:00.000Z"])(
  "future or stale provider observation %s cannot mint a period", async (verified_at) => {
    const f = createBillingAuthorityFixture();
    try {
      f.setFacts(facts(f.binding, { verified_at }));
      await refuses(() => f.authority.reconcile(f.account_id));
      expect(count(f, "managed_account_periods")).toBe(0);
    } finally { f.close(); }
  },
);

it("unpaid evidence cannot create a processing allowance", async () => {
  const f = createBillingAuthorityFixture();
  try {
    f.setFacts(facts(f.binding, { completed_payment: false }));
    await refuses(() => f.authority.reconcile(f.account_id));
    expect(count(f, "managed_account_periods")).toBe(0);
  } finally { f.close(); }
});

it("a new paid monthly transaction advances the period without a new checkout binding", async () => {
  const f = createBillingAuthorityFixture();
  try {
    await f.authority.reconcile(f.account_id);
    f.setNow("2027-02-28T12:00:00.000Z");
    f.setFacts(facts(f.binding, { transaction_ref: "SYNTHETIC-renewal-2",
      paid_period_start: "2027-02-28T00:00:00.000Z", paid_period_end: "2027-03-31T00:00:00.000Z",
      verified_at: "2027-02-28T12:00:00.000Z" }));
    expect((await f.authority.reconcile(f.account_id)).state).toBe("granted");
    expect(count(f, "managed_account_periods")).toBe(2);
    const view = f.authority.billingEligibility(f.account_id);
    expect(view).toMatchObject({ state: "granted", window_start: "2027-02-28T00:00:00.000Z",
      window_end: "2027-03-31T00:00:00.000Z" });
  } finally { f.close(); }
});

it("a second completed transaction for the same paid interval cannot reset its allowance", async () => {
  const f = createBillingAuthorityFixture();
  try {
    await f.authority.reconcile(f.account_id);
    const original = f.control.db.prepare("SELECT * FROM managed_account_periods").get();
    f.setFacts(facts(f.binding, { transaction_ref: "SYNTHETIC-duplicate-payment" }));
    await refuses(() => f.authority.reconcile(f.account_id));
    expect(count(f, "managed_account_periods")).toBe(1);
    expect(f.control.db.prepare("SELECT * FROM managed_account_periods").get()).toEqual(original);
  } finally { f.close(); }
});

it("a fresh annual term rolls to its next month without another source read or payment", async () => {
  const f = createBillingAuthorityFixture({ cadence: "annual", now: "2027-02-27T23:55:00.000Z" });
  try {
    f.setFacts(facts(f.binding, { verified_at: "2027-02-27T23:55:00.000Z" }));
    await f.authority.reconcile(f.account_id);
    f.setNow("2027-02-28T00:01:00.000Z");
    expect(f.authority.ensureCurrentGrant(f.account_id)).toMatchObject({ state: "granted",
      window_start: "2027-02-28T00:00:00.000Z", window_end: "2027-03-31T00:00:00.000Z" });
    expect(count(f, "managed_account_periods")).toBe(2);
    expect(count(f, "control_billing_terms")).toBe(1);
  } finally { f.close(); }
});

it("missed annual months are not banked or materialized as future allowance", async () => {
  const f = createBillingAuthorityFixture({ cadence: "annual" });
  try {
    await f.authority.reconcile(f.account_id);
    f.setNow("2027-09-15T12:00:00.000Z");
    f.setFacts(facts(f.binding, { verified_at: "2027-09-15T12:00:00.000Z" }));
    expect((await f.authority.reconcile(f.account_id)).state).toBe("granted");
    expect(count(f, "managed_account_periods")).toBe(2);
    expect(f.authority.billingEligibility(f.account_id)).toMatchObject({ state: "granted",
      window_start: "2027-08-31T00:00:00.000Z", window_end: "2027-09-30T00:00:00.000Z" });
  } finally { f.close(); }
});

it("poll refreshes update signed freshness without appending payment facts on every poll", async () => {
  const f = createBillingAuthorityFixture();
  try {
    await f.authority.reconcile(f.account_id);
    const logCount = count(f, "control_billing_log");
    for (const minute of [1, 2, 3, 4, 5]) {
      const now = `2027-01-31T12:0${minute}:00.000Z`;
      f.setNow(now); f.setFacts(facts(f.binding, { verified_at: now }));
      expect((await f.authority.reconcile(f.account_id)).state).toBe("granted");
    }
    expect(count(f, "control_billing_log")).toBe(logCount);
    expect(count(f, "control_billing_terms")).toBe(1);
    expect(count(f, "managed_account_periods")).toBe(1);
    expect((f.control.db.prepare("SELECT revision FROM control_billing_freshness").get() as { revision: number }).revision)
      .toBeGreaterThan(1);
  } finally { f.close(); }
});

it("freshness expiry denies cached access without deleting retained periods", async () => {
  const f = createBillingAuthorityFixture();
  try {
    await f.authority.reconcile(f.account_id);
    f.setNow("2027-01-31T12:15:00.000Z");
    expect(f.authority.billingEligibility(f.account_id).state).toBe("unavailable");
    expect(f.authority.ensureCurrentGrant(f.account_id).state).toBe("unavailable");
    expect(count(f, "managed_account_periods")).toBe(1);
  } finally { f.close(); }
});

it("expired annual evidence cannot create a new monthly period even when the returned view is unavailable", async () => {
  const f = createBillingAuthorityFixture({ cadence: "annual" });
  try {
    await f.authority.reconcile(f.account_id);
    f.setNow("2027-02-28T12:00:00.000Z");
    const before = snapshot(f);
    await refuses(() => f.authority.ensureCurrentGrant(f.account_id));
    expect(snapshot(f)).toBe(before);
  } finally { f.close(); }
});

it("unknown dispatched usage is retained and charged against a new annual monthly window", async () => {
  const f = createBillingAuthorityFixture({ cadence: "annual" });
  try {
    await f.authority.reconcile(f.account_id);
    const { reservation } = reservedCall(f);
    const before = f.control.db.prepare("SELECT * FROM managed_reservations WHERE call_id=?").get(reservation.call_id);
    f.setNow("2027-02-28T12:00:00.000Z");
    f.setFacts(facts(f.binding, { verified_at: "2027-02-28T12:00:00.000Z" }));
    await f.authority.reconcile(f.account_id);
    expect(f.control.db.prepare("SELECT * FROM managed_reservations WHERE call_id=?").get(reservation.call_id)).toEqual(before);
    const ledger = new ManagedSpendingStore(f.control, () => new Date("2027-02-28T12:00:00.000Z"));
    const status = ledger.accountStatus(f.account_id);
    expect(status.committed.unresolved_micro_usd).toBe(3);
    expect(status.committed.account_period_micro_usd).toBe(3);
    expect(ledger.serviceBarrier()).toEqual({ paused: true, reason: "usage_pending" });
  } finally { f.close(); }
});

it("known settlement still preserves its original period after a billing revocation", async () => {
  const f = createBillingAuthorityFixture();
  try {
    await f.authority.reconcile(f.account_id);
    const { ledger, reservation } = reservedCall(f);
    f.setFacts(facts(f.binding, { current_state: "refunded" }));
    await refuses(() => f.authority.reconcile(f.account_id));
    expect(f.authority.billingEligibility(f.account_id).state).toBe("unavailable");
    expect(ledger.settleKnown(reservation.call_id, 2)).toMatchObject({ state: "settled",
      actual_micro_usd: 2, account_period_id: reservation.account_period_id });
  } finally { f.close(); }
});

it("an unpaid adverse observation still revokes cached authority instead of failing before the deny write", async () => {
  const f = createBillingAuthorityFixture();
  try {
    await f.authority.reconcile(f.account_id);
    const before = count(f, "control_billing_log");
    f.setFacts(facts(f.binding, { current_state: "past_due", completed_payment: false }));
    await refuses(() => f.authority.reconcile(f.account_id));
    expect(f.authority.billingEligibility(f.account_id).state).toBe("unavailable");
    expect(count(f, "control_billing_log")).toBeGreaterThan(before);
    expect(count(f, "managed_account_periods")).toBe(1);
    expect(f.control.account(f.account_id)?.state).toBe("active");
  } finally { f.close(); }
});

it("a mutable adverse-generation projection cannot erase a signed revocation", async () => {
  const f = createBillingAuthorityFixture();
  try {
    await f.authority.reconcile(f.account_id);
    f.setFacts(facts(f.binding, { current_state: "refunded" }));
    await refuses(() => f.authority.reconcile(f.account_id));
    f.control.db.prepare("UPDATE control_billing_account SET adverse_generation=0 WHERE account_id=?").run(f.account_id);
    await refuses(() => f.authority.billingEligibility(f.account_id));
    f.setFacts(facts(f.binding));
    await refuses(() => f.authority.reconcile(f.account_id));
    expect(count(f, "managed_account_periods")).toBe(1);
  } finally { f.close(); }
});

it("an active reply cannot revive a revoked term or falsely report that it granted access", async () => {
  const f = createBillingAuthorityFixture();
  try {
    await f.authority.reconcile(f.account_id);
    f.setFacts(facts(f.binding, { current_state: "refunded" }));
    await refuses(() => f.authority.reconcile(f.account_id));
    f.setFacts(facts(f.binding));
    const before = snapshot(f);
    await refuses(() => f.authority.reconcile(f.account_id));
    expect(snapshot(f)).toBe(before);
  } finally { f.close(); }
});

it("a later genuinely paid term can qualify at the current local adverse generation", async () => {
  const f = createBillingAuthorityFixture();
  try {
    await f.authority.reconcile(f.account_id);
    f.setFacts(facts(f.binding, { current_state: "refunded" }));
    await f.authority.reconcile(f.account_id);
    f.setNow("2027-02-28T12:00:00.000Z");
    f.setFacts(facts(f.binding, { transaction_ref: "SYNTHETIC-new-paid-term",
      paid_period_start: "2027-02-28T00:00:00.000Z", paid_period_end: "2027-03-31T00:00:00.000Z",
      verified_at: "2027-02-28T12:00:00.000Z" }));
    expect((await f.authority.reconcile(f.account_id)).state).toBe("granted");
    expect(f.authority.billingEligibility(f.account_id).state).toBe("granted");
    expect(count(f, "managed_account_periods")).toBe(2);
  } finally { f.close(); }
});

it("repeated adverse observations do not grow the rare authority log on every poll", async () => {
  const f = createBillingAuthorityFixture();
  try {
    await f.authority.reconcile(f.account_id);
    f.setFacts(facts(f.binding, { current_state: "past_due", completed_payment: false }));
    await f.authority.reconcile(f.account_id);
    const entries = count(f, "control_billing_log");
    const generation = f.control.db.prepare("SELECT adverse_generation FROM control_billing_account").get();
    f.setNow("2027-01-31T12:01:00.000Z");
    f.setFacts(facts(f.binding, { current_state: "past_due", completed_payment: false, verified_at: "2027-01-31T12:01:00.000Z" }));
    await f.authority.reconcile(f.account_id);
    expect(count(f, "control_billing_log")).toBe(entries);
    expect(f.control.db.prepare("SELECT adverse_generation FROM control_billing_account").get()).toEqual(generation);
  } finally { f.close(); }
});

it("changing the central allowance cannot widen the authenticated grant", async () => {
  const f = createBillingAuthorityFixture();
  try {
    await f.authority.reconcile(f.account_id);
    f.control.db.exec("UPDATE managed_account_periods SET allowance_micro_usd=allowance_micro_usd+1");
    await refuses(() => f.authority.billingEligibility(f.account_id));
    await refuses(() => f.authority.ensureCurrentGrant(f.account_id));
    expect(count(f, "managed_account_periods")).toBe(1);
  } finally { f.close(); }
});

it("a corrupted signed freshness projection is not silently repaired by another provider read", async () => {
  const f = createBillingAuthorityFixture();
  try {
    await f.authority.reconcile(f.account_id);
    f.control.db.exec("UPDATE control_billing_freshness SET revision=revision+1");
    const before = snapshot(f);
    await refuses(() => f.authority.reconcile(f.account_id));
    expect(snapshot(f)).toBe(before);
  } finally { f.close(); }
});

it("a raw account-binding row and its recomputed unkeyed digest cannot forge a signed admission", async () => {
  const f = createBillingAuthorityFixture();
  try {
    const binding = { ...f.binding, customer_ref: "SYNTHETIC-attacker" };
    f.control.db.prepare("UPDATE control_billing_account SET binding_json=?,binding_digest=? WHERE account_id=?")
      .run(canonical(binding), createHash("sha256").update(canonical(binding)).digest("hex"), f.account_id);
    await refuses(() => f.authority.reconcile(f.account_id));
    expect(count(f, "managed_account_periods")).toBe(0);
  } finally { f.close(); }
});

it("recomputing a tampered immutable receipt digest cannot replace its journal-authenticated provenance", async () => {
  const f = createBillingAuthorityFixture();
  try {
    await f.authority.reconcile(f.account_id);
    const term = f.control.db.prepare("SELECT term_id,receipt_json FROM control_billing_terms").get() as {
      term_id: string; receipt_json: string;
    };
    const receipt = { ...JSON.parse(term.receipt_json), customer_ref: "SYNTHETIC-attacker" };
    const text = canonical(receipt);
    withoutImmutableTriggers(f, "control_billing_terms", () => {
      f.control.db.prepare("UPDATE control_billing_terms SET receipt_json=?,receipt_digest=? WHERE term_id=?")
        .run(text, createHash("sha256").update(text).digest("hex"), term.term_id);
    });
    await refuses(() => f.authority.billingEligibility(f.account_id));
    expect(count(f, "managed_account_periods")).toBe(1);
  } finally { f.close(); }
});

it("receipt JSON cannot be changed while leaving its old authenticated digest in place", async () => {
  const f = createBillingAuthorityFixture();
  try {
    await f.authority.reconcile(f.account_id);
    const term = f.control.db.prepare("SELECT receipt_json FROM control_billing_terms").get() as { receipt_json: string };
    withoutImmutableTriggers(f, "control_billing_terms", () => {
      f.control.db.prepare("UPDATE control_billing_terms SET receipt_json=?")
        .run(canonical({ ...JSON.parse(term.receipt_json), customer_ref: "SYNTHETIC-substituted" }));
    });
    await refuses(() => f.authority.billingEligibility(f.account_id));
  } finally { f.close(); }
});

it("observation JSON is actually authenticated, not merely accompanied by a signed expiry", async () => {
  const f = createBillingAuthorityFixture();
  try {
    await f.authority.reconcile(f.account_id);
    const row = f.control.db.prepare("SELECT observation_json FROM control_billing_freshness").get() as { observation_json: string };
    f.control.db.prepare("UPDATE control_billing_freshness SET observation_json=?")
      .run(canonical({ ...JSON.parse(row.observation_json), completed_payment: false }));
    await refuses(() => f.authority.billingEligibility(f.account_id));
  } finally { f.close(); }
});

it("the actual central period ID must match the signed grant, not merely its dates and amount", async () => {
  const f = createBillingAuthorityFixture();
  try {
    await f.authority.reconcile(f.account_id);
    f.control.db.exec("PRAGMA foreign_keys=OFF");
    f.control.db.prepare("UPDATE managed_account_periods SET period_id=?").run(randomUUID());
    f.control.db.exec("PRAGMA foreign_keys=ON");
    await refuses(() => f.authority.billingEligibility(f.account_id));
  } finally { f.close(); }
});

it("a raw cap increase is not inherited as higher operator authority", async () => {
  const f = createBillingAuthorityFixture();
  try {
    f.control.db.prepare("UPDATE managed_account_policy SET per_job_micro_usd=per_job_micro_usd+1 WHERE account_id=?")
      .run(f.account_id);
    await refuses(() => f.authority.reconcile(f.account_id));
    expect(count(f, "managed_account_periods")).toBe(0);
  } finally { f.close(); }
});

it("changing a cap after a valid grant is not hidden behind the existing-window refresh path", async () => {
  const f = createBillingAuthorityFixture();
  try {
    await f.authority.reconcile(f.account_id);
    f.control.db.exec("UPDATE managed_account_policy SET per_job_micro_usd=per_job_micro_usd+1");
    await refuses(() => f.authority.billingEligibility(f.account_id));
    await refuses(() => f.authority.reconcile(f.account_id));
  } finally { f.close(); }
});

it("a changed actual issuer/subject cannot inherit the old signed admission", async () => {
  const f = createBillingAuthorityFixture();
  try {
    f.control.db.prepare("UPDATE managed_accounts SET subject=? WHERE id=?")
      .run("SYNTHETIC-different-owner", f.account_id);
    await refuses(() => f.authority.reconcile(f.account_id));
    expect(count(f, "managed_account_periods")).toBe(0);
  } finally { f.close(); }
});

it("a root epoch changed while awaiting evidence is rechecked inside publication", async () => {
  const f: Fixture = createBillingAuthorityFixture({ source: { read: async (binding) => {
    f.control.db.exec("UPDATE managed_control_epoch SET epoch=epoch+1");
    return facts(binding);
  } } });
  try {
    await refuses(() => f.authority.reconcile(f.account_id));
    expect(count(f, "managed_account_periods")).toBe(0);
  } finally { f.close(); }
});

it("the policy's key commitment must actually match the protected key bytes", () => {
  const f = createBillingAuthorityFixture();
  try {
    const path = join(f.root, ".protected", "billing-policy.json");
    const changed = { ...f.policy, key_commitment: "f".repeat(64) };
    const text = canonical(changed);
    writeFileSync(path, text);
    f.control.db.prepare("UPDATE control_billing_policy SET policy_json=?,policy_digest=?")
      .run(text, createHash("sha256").update(text).digest("hex"));
    expect(() => new BillingAuthority({ root: f.root, control: f.control,
      source: { read: async (binding) => facts(binding) }, clock: () => new Date(NOW) })).toThrow(BrainError);
  } finally { f.close(); }
});

it("an existing revoked central interval still prevents a second overlapping allowance", async () => {
  const f = createBillingAuthorityFixture();
  try {
    f.control.db.prepare("INSERT INTO managed_account_periods VALUES(?,?,?,?,?,?,?,?)")
      .run(randomUUID(), f.account_id, "2027-01-31T00:00:00.000Z", "2027-02-28T00:00:00.000Z",
        100, "revoked", NOW, NOW);
    await refuses(() => f.authority.reconcile(f.account_id));
    expect(count(f, "managed_account_periods")).toBe(1);
    expect(count(f, "control_billing_period")).toBe(0);
  } finally { f.close(); }
});

it("an actual SQLite projection-write denial rolls back the already appended journal/head", async () => {
  const f = createBillingAuthorityFixture();
  try {
    const before = snapshot(f);
    f.control.db.setAuthorizer((action, table) => action === constants.SQLITE_INSERT && table === "managed_account_periods"
      ? constants.SQLITE_DENY : constants.SQLITE_OK);
    await refuses(() => f.authority.reconcile(f.account_id));
    f.control.db.setAuthorizer(null);
    expect(snapshot(f)).toBe(before);
    expect(f.control.db.isTransaction).toBe(false);
  } finally { f.control.db.setAuthorizer(null); f.close(); }
});

it("source reads run outside the transaction, and a failed final COMMIT cannot publish a grant", async () => {
  let denyCommit = false, readOutsideTransaction = false;
  const f: Fixture = createBillingAuthorityFixture({ source: { read: async (binding) => {
    readOutsideTransaction = !f.control.db.isTransaction;
    denyCommit = true;
    return facts(binding);
  } } });
  try {
    const before = snapshot(f);
    f.control.db.setAuthorizer((action, operation) => action === constants.SQLITE_TRANSACTION && operation === "COMMIT" && denyCommit
      ? constants.SQLITE_DENY : constants.SQLITE_OK);
    await refuses(() => f.authority.reconcile(f.account_id));
    f.control.db.setAuthorizer(null);
    expect(readOutsideTransaction).toBe(true);
    expect(denyCommit).toBe(true);
    expect(snapshot(f)).toBe(before);
    expect(f.control.db.isTransaction).toBe(false);
  } finally { f.control.db.setAuthorizer(null); f.close(); }
});

it("an existing caller transaction is not held across provider I/O or rolled back by reconciliation", async () => {
  let reads = 0;
  const f = createBillingAuthorityFixture({ source: { read: async (binding) => {
    reads += 1; return facts(binding);
  } } });
  try {
    f.control.db.exec("BEGIN IMMEDIATE");
    await refuses(() => f.authority.reconcile(f.account_id));
    expect(reads).toBe(0);
    expect(f.control.db.isTransaction).toBe(true);
    f.control.db.exec("ROLLBACK");
    expect(count(f, "managed_account_periods")).toBe(0);
  } finally { if (f.control.db.isTransaction) f.control.db.exec("ROLLBACK"); f.close(); }
});

it("a delayed active observation cannot overwrite a newer authenticated adverse result", async () => {
  let finishOld: ((value: ProviderFacts) => void) | undefined;
  let readStarted: () => void = () => {};
  const started = new Promise<void>((resolve) => { readStarted = resolve; });
  let mode: "initial" | "old" | "adverse" = "initial";
  const f = createBillingAuthorityFixture({ source: { read: async (binding) => {
    if (mode === "old") return new Promise<ProviderFacts>((resolve) => { finishOld = resolve; readStarted(); });
    return facts(binding, mode === "adverse" ? { current_state: "past_due" } : {});
  } } });
  try {
    await f.authority.reconcile(f.account_id);
    mode = "old";
    const pending = f.authority.reconcile(f.account_id);
    await started;
    expect(finishOld).toBeDefined();
    mode = "adverse";
    await refuses(() => f.authority.reconcile(f.account_id));
    finishOld!(facts(f.binding));
    await refuses(() => pending);
    expect(f.authority.billingEligibility(f.account_id).state).toBe("unavailable");
    expect(count(f, "managed_account_periods")).toBe(1);
  } finally { f.close(); }
});

it("loss of the actual protected key never reinitializes it or permits cached processing", async () => {
  const f = createBillingAuthorityFixture();
  try {
    await f.authority.reconcile(f.account_id);
    unlinkSync(join(f.root, ".protected", "billing-authority.key"));
    await refuses(() => f.authority.billingEligibility(f.account_id));
    await refuses(() => f.authority.ensureCurrentGrant(f.account_id));
    expect(count(f, "managed_account_periods")).toBe(1);
  } finally { f.close(); }
});

it("a policy-file hot edit cannot be accepted even if its database cache is edited too", async () => {
  const f = createBillingAuthorityFixture();
  try {
    const path = join(f.root, ".protected", "billing-policy.json");
    const changed = { ...JSON.parse(readFileSync(path, "utf8")), service_daily_micro_usd: f.policy.service_daily_micro_usd + 1 };
    const text = canonical(changed);
    writeFileSync(path, text);
    f.control.db.prepare("UPDATE control_billing_policy SET policy_json=?,policy_digest=? WHERE singleton=1")
      .run(text, createHash("sha256").update(text).digest("hex"));
    f.control.db.prepare("UPDATE managed_service_policy SET daily_micro_usd=? WHERE service='managed-processing'")
      .run(changed.service_daily_micro_usd);
    await refuses(() => f.authority.reconcile(f.account_id));
    expect(count(f, "managed_account_periods")).toBe(0);
  } finally { f.close(); }
});

it("suspension in the actual control identity is rechecked rather than trusting the signed old binding", async () => {
  const f = createBillingAuthorityFixture();
  try {
    f.control.setAccountState(f.account_id, "suspended");
    await refuses(() => f.authority.reconcile(f.account_id));
    expect(count(f, "managed_account_periods")).toBe(0);
  } finally { f.close(); }
});
