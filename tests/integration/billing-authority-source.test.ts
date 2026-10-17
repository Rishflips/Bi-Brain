import { describe, expect, it } from "vitest";
import { BrainError } from "../../packages/domain/logic.ts";
import {
  bindingDigest,
  identityDigest,
  receiptFromFacts,
  receiptDigest,
  termId,
  validateProviderFacts,
  validateServerOwnedBinding,
} from "../../packages/domain/billing-evidence.ts";
import { createBillingAuthorityFixture, syntheticProviderFacts } from "../helpers/billing-authority-fixture.ts";

/** T2W trusted evidence contract and the null-source default — SYNTHETIC. */

const binding = () => ({
  schema: 1 as const,
  account_id: "11111111-1111-4111-8111-111111111111",
  identity_digest: "b".repeat(64),
  tenant_incarnation: "c".repeat(64),
  provisioning_generation: 1,
  mode: "sandbox" as const,
  product_ref: "SYNTHETIC-product",
  price_ref: "SYNTHETIC-price-monthly",
  cadence: "monthly" as const,
  customer_ref: "SYNTHETIC-customer",
  subscription_ref: "SYNTHETIC-subscription",
  initial_transaction_ref: "SYNTHETIC-transaction",
  correlation_ref: "SYNTHETIC-correlation",
  version: 1,
});

const facts = () => ({
  transaction_ref: "SYNTHETIC-transaction",
  subscription_ref: "SYNTHETIC-subscription",
  customer_ref: "SYNTHETIC-customer",
  product_ref: "SYNTHETIC-product",
  price_ref: "SYNTHETIC-price-monthly",
  cadence: "monthly" as const,
  completed_payment: true,
  current_state: "active" as const,
  paid_period_start: "2027-01-31T00:00:00.000Z",
  paid_period_end: "2027-02-28T00:00:00.000Z",
  verified_at: "2027-01-31T12:00:00.000Z",
});

describe("evidence validation", () => {
  it("accepts the exact binding and facts and returns owned copies", () => {
    const input = binding();
    const validated = validateServerOwnedBinding(input);
    expect(validated).toEqual(input);
    expect(validated).not.toBe(input);
    expect(validateProviderFacts(facts())).toEqual(facts());
  });

  it.each([
    { extra: 1 },
    { account_id: "not-a-uuid" },
    { identity_digest: "abc" },
    { provisioning_generation: 0 },
    { provisioning_generation: 1.5 },
    { mode: "prod" },
    { version: 0 },
    { initial_transaction_ref: "" },
  ])("rejects a malformed binding: %j", (change) => {
    expect(() => validateServerOwnedBinding({ ...binding(), ...change })).toThrow(BrainError);
  });

  it.each([
    { account_id: "11111111-1111-4111-8111-111111111111" },
    { allowance_micro_usd: 1 },
    { verified: true },
    { current_state: "trial" },
    { completed_payment: "yes" },
    { paid_period_end: "2027-02-30T00:00:00.000Z" },
    { extra: 1 },
  ])("rejects malformed provider facts: %j", (change) => {
    expect(() => validateProviderFacts({ ...facts(), ...change })).toThrow(BrainError);
  });

  it("derives stable identity, binding, term and receipt digests", () => {
    const value = validateServerOwnedBinding(binding());
    expect(identityDigest({ account_id: value.account_id, issuer: "i", subject: "s" })).toMatch(/^[a-f0-9]{64}$/);
    expect(bindingDigest(value)).toMatch(/^[a-f0-9]{64}$/);
    expect(bindingDigest(value)).toBe(bindingDigest({ ...value }));
    expect(bindingDigest({ ...value, customer_ref: "other" })).not.toBe(bindingDigest(value));
    const fact = validateProviderFacts(facts());
    expect(termId(value.account_id, fact)).toMatch(/^[a-f0-9]{64}$/);
    const receipt = receiptFromFacts(fact, value);
    expect(receiptDigest(receipt)).toMatch(/^[a-f0-9]{64}$/);
    expect(receiptDigest(receiptFromFacts({ ...fact, paid_period_end: "2027-03-31T00:00:00.000Z" }, value))).not.toBe(
      receiptDigest(receipt),
    );
  });
});

describe("null source default", () => {
  it("denies reconciliation and eligibility with no writes", async () => {
    const fixture = createBillingAuthorityFixture({ source: null });
    try {
      const before = fixture.control.db.prepare("SELECT COUNT(*) AS n FROM control_billing_log").get();
      const decision = await fixture.authority.reconcile(fixture.account_id);
      expect(decision).toEqual({ state: "denied", reason: "no_source" });
      expect(fixture.authority.billingEligibility(fixture.account_id)).toMatchObject({ state: "unavailable" });
      expect(fixture.control.db.prepare("SELECT COUNT(*) AS n FROM control_billing_log").get()).toEqual(before);
      expect(fixture.control.db.prepare("SELECT COUNT(*) AS n FROM managed_account_periods").get()).toEqual({ n: 0 });
    } finally {
      fixture.close();
    }
  });
});

it("the default synthetic source exposes the same closed facts contract", () => {
  const fixture = createBillingAuthorityFixture();
  try {
    const produced = syntheticProviderFacts(fixture.binding, "2027-01-31T12:00:00.000Z");
    expect(validateProviderFacts(produced)).toEqual(produced);
    expect(Object.keys(produced).sort()).toEqual(Object.keys(facts()).sort());
  } finally {
    fixture.close();
  }
});
