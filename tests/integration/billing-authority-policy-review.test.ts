import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { BrainError } from "../../packages/domain/logic.ts";
import {
  billingOperatorPolicyDigest, resolveBillingCatalogPlan, validateBillingOperatorPolicy,
} from "../../packages/domain/billing-policy.ts";

// SYNTHETIC ceilings and provider references, not selected customer pricing or payment evidence.
function policy() {
  const caps = { product_ref: "SYNTHETIC-product", allowance_micro_usd: 1000,
    per_job_micro_usd: 10, user_daily_micro_usd: 100 };
  return {
    schema: 1, policy_id: "SYNTHETIC-policy", version: 1, mode: "sandbox",
    epoch: 1, root_nonce: "a".repeat(64), key_commitment: "b".repeat(64), service_daily_micro_usd: 2000,
    catalog: [
      { ...caps, cadence: "monthly", price_ref: "SYNTHETIC-month" },
      { ...caps, cadence: "annual", price_ref: "SYNTHETIC-year" },
    ],
  };
}
const selection = () => ({ mode: "sandbox", cadence: "monthly",
  product_ref: "SYNTHETIC-product", price_ref: "SYNTHETIC-month" });

it("the frozen digest binds all fields using independently ordered canonical bytes", () => {
  const input = policy();
  const catalog = ["monthly", "annual"].map((cadence) => ({
    allowance_micro_usd: 1000, cadence, per_job_micro_usd: 10,
    price_ref: cadence === "monthly" ? "SYNTHETIC-month" : "SYNTHETIC-year",
    product_ref: "SYNTHETIC-product", user_daily_micro_usd: 100,
  }));
  const bytes = JSON.stringify({ catalog, epoch: 1, key_commitment: "b".repeat(64), mode: "sandbox",
    policy_id: "SYNTHETIC-policy", root_nonce: "a".repeat(64), schema: 1,
    service_daily_micro_usd: 2000, version: 1 });
  expect(billingOperatorPolicyDigest(input)).toBe(createHash("sha256").update(bytes, "utf8").digest("hex"));
  expect(billingOperatorPolicyDigest({ ...input, catalog: [...input.catalog].reverse() }))
    .toBe(billingOperatorPolicyDigest(input));
});

it.each([
  { policy_id: "SYNTHETIC-policy-2" }, { version: 2 }, { mode: "live" }, { epoch: 2 },
  { root_nonce: "c".repeat(64) }, { key_commitment: "d".repeat(64) }, { service_daily_micro_usd: 2001 },
])("an authority-header substitution changes the policy digest: %j", (change) => {
  expect(billingOperatorPolicyDigest({ ...policy(), ...change })).not.toBe(billingOperatorPolicyDigest(policy()));
});

it.each(["allowance_micro_usd", "per_job_micro_usd", "user_daily_micro_usd"] as const)(
  "changing the static %s cap changes the digest for both cadences", (field) => {
    const input = policy(), before = billingOperatorPolicyDigest(input);
    for (const plan of input.catalog) plan[field] += 1;
    expect(billingOperatorPolicyDigest(input)).not.toBe(before);
  },
);

it("product and per-cadence price mappings are included in the digest", () => {
  const input = policy(), before = billingOperatorPolicyDigest(input);
  input.catalog[0]!.price_ref = "SYNTHETIC-new-month";
  expect(billingOperatorPolicyDigest(input)).not.toBe(before);
  for (const plan of input.catalog) plan.product_ref = "SYNTHETIC-new-product";
  expect(billingOperatorPolicyDigest(input)).not.toBe(before);
});

it("selection requires the whole configured mode/product/price/cadence tuple", () => {
  expect(resolveBillingCatalogPlan(policy(), selection())).toEqual(policy().catalog[0]);
  for (const change of [
    { mode: "live" }, { cadence: "annual" }, { product_ref: "SYNTHETIC-other-product" },
    { price_ref: "SYNTHETIC-other-price" },
  ]) expect(resolveBillingCatalogPlan(policy(), { ...selection(), ...change })).toBeNull();
  expect(resolveBillingCatalogPlan(policy(), {
    ...selection(), cadence: "annual", price_ref: "SYNTHETIC-year",
  })).toEqual(policy().catalog[1]);
});

it.each(["allowance_micro_usd", "per_job_micro_usd", "user_daily_micro_usd"] as const)(
  "an explicit zero %s policy is representable but cannot select a spending plan", (field) => {
    const input = policy();
    for (const plan of input.catalog) plan[field] = 0;
    expect(validateBillingOperatorPolicy(input).catalog[0]![field]).toBe(0);
    expect(resolveBillingCatalogPlan(input, selection())).toBeNull();
  },
);

it("zero service cap cannot be overridden by a positive account plan", () => {
  const input = { ...policy(), service_daily_micro_usd: 0 };
  expect(validateBillingOperatorPolicy(input).service_daily_micro_usd).toBe(0);
  expect(resolveBillingCatalogPlan(input, selection())).toBeNull();
});

it.each([
  { schema: 2 }, { version: 0 }, { version: 1.5 }, { epoch: 0 }, { mode: "trial" },
  { key_commitment: "not-a-digest" }, { root_nonce: "" }, { service_daily_micro_usd: -1 },
  { service_daily_micro_usd: Infinity }, { service_daily_micro_usd: Number.MAX_SAFE_INTEGER + 1 },
  { token_price: 1 }, { verified: true }, { provider_api_key: "SYNTHETIC-forbidden" },
])("invalid or widened policy configuration is rejected: %j", (change) => {
  expect(() => validateBillingOperatorPolicy({ ...policy(), ...change })).toThrow(BrainError);
});

it.each(["allowance_micro_usd", "per_job_micro_usd", "user_daily_micro_usd"] as const)(
  "rejects fractional, negative and unsafe %s even when both plans match", (field) => {
    for (const amount of [-1, 0.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      const input = policy();
      for (const plan of input.catalog) plan[field] = amount;
      expect(() => validateBillingOperatorPolicy(input)).toThrow(BrainError);
    }
  },
);

it("same-cadence, same-price and unequal allowance alternatives cannot masquerade as the two approved plans", () => {
  const sameCadence = policy(); sameCadence.catalog[1]!.cadence = "monthly";
  const samePrice = policy(); samePrice.catalog[1]!.price_ref = "SYNTHETIC-month";
  const unequal = policy(); unequal.catalog[1]!.allowance_micro_usd = 12000;
  const differentProduct = policy(); differentProduct.catalog[1]!.product_ref = "SYNTHETIC-other-product";
  for (const input of [sameCadence, samePrice, unequal, differentProduct]) {
    expect(() => validateBillingOperatorPolicy(input)).toThrow(BrainError);
  }
});

it("malformed catalogs reject rather than being sorted or default-filled into permission", () => {
  const input = policy();
  for (const catalog of [[], [input.catalog[0]], [...input.catalog, input.catalog[0]], [null, input.catalog[1]]]) {
    expect(() => validateBillingOperatorPolicy({ ...input, catalog })).toThrow(BrainError);
  }
  const sparse = Array(2); sparse[1] = input.catalog[1];
  expect(() => validateBillingOperatorPolicy({ ...input, catalog: sparse })).toThrow(BrainError);
  expect(() => validateBillingOperatorPolicy({ ...input,
    catalog: input.catalog.map((plan) => ({ ...plan, customer_payment_amount: 1 })),
  })).toThrow(BrainError);
});

it("a caller cannot replace catalog entries through a custom iterator during validation", () => {
  const input = policy();
  Object.defineProperty(input.catalog, Symbol.iterator, { value: function* () { yield* policy().catalog; } });
  expect(() => validateBillingOperatorPolicy(input)).toThrow(BrainError);
});

it("policy validation and selection return independent owned configuration, never caller aliases", () => {
  const input = policy(), validated = validateBillingOperatorPolicy(input);
  validated.catalog[0]!.allowance_micro_usd = 9999;
  const selected = resolveBillingCatalogPlan(input, selection());
  expect(selected).not.toBeNull();
  selected!.allowance_micro_usd = 9999;
  expect(input.catalog[0]!.allowance_micro_usd).toBe(1000);
  expect(resolveBillingCatalogPlan(input, selection())!.allowance_micro_usd).toBe(1000);
});

it.each([
  { ...selection(), allowance_micro_usd: 9999 }, { ...selection(), mode: "trial" },
  { ...selection(), price_ref: "" }, { ...selection(), cadence: "weekly" },
  { ...selection(), product_ref: "SYNTHETIC\nprivate" },
])("selection cannot provide authority flags or malformed provider selectors: %j", (input) => {
  expect(() => resolveBillingCatalogPlan(policy(), input)).toThrow(BrainError);
});

it("an unmatched selector cannot hide an invalid installed policy", () => {
  expect(() => resolveBillingCatalogPlan({ ...policy(), version: 0 }, {
    ...selection(), price_ref: "SYNTHETIC-unmatched",
  })).toThrow(BrainError);
});
