import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BrainError, canonical } from "../../packages/domain/logic.ts";
import {
  billingOperatorPolicyDigest,
  resolveBillingCatalogPlan,
  validateBillingOperatorPolicy,
} from "../../packages/domain/billing-policy.ts";

/**
 * T2P frozen operator policy contract — pure, SYNTHETIC. The module does not exist yet,
 * so the first run is RED. These are model-cost micro-USD caps, never a customer price
 * or payment amount, and no value here is a real economic default.
 */

const ZERO = 0;
const NONCE = "a".repeat(64);
const COMMITMENT = "b".repeat(64);

function catalogEntry(over: Record<string, unknown> = {}) {
  return {
    cadence: "monthly",
    product_ref: "SYNTHETIC-product",
    price_ref: "SYNTHETIC-price-monthly",
    allowance_micro_usd: 1000,
    per_job_micro_usd: 100,
    user_daily_micro_usd: 500,
    ...over,
  };
}

function basePolicy(over: Record<string, unknown> = {}) {
  return {
    schema: 1,
    policy_id: "SYNTHETIC-policy",
    version: 1,
    mode: "sandbox",
    epoch: 1,
    root_nonce: NONCE,
    key_commitment: COMMITMENT,
    service_daily_micro_usd: 10_000,
    catalog: [
      catalogEntry(),
      catalogEntry({ cadence: "annual", price_ref: "SYNTHETIC-price-annual" }),
    ],
    ...over,
  };
}

function selection(over: Record<string, unknown> = {}) {
  return {
    mode: "sandbox",
    cadence: "monthly",
    product_ref: "SYNTHETIC-product",
    price_ref: "SYNTHETIC-price-monthly",
    ...over,
  };
}

describe("validateBillingOperatorPolicy", () => {
  it("returns an owned policy canonicalized to monthly then annual", () => {
    const input = basePolicy({
      catalog: [
        catalogEntry({ cadence: "annual", price_ref: "SYNTHETIC-price-annual" }),
        catalogEntry(),
      ],
    });
    const policy = validateBillingOperatorPolicy(input);
    expect(policy.catalog.map((entry) => entry.cadence)).toEqual(["monthly", "annual"]);
    expect(policy.catalog).not.toBe(input.catalog);
    input.catalog[0]!.cadence = "monthly";
    expect(policy.catalog[0]!.cadence).toBe("monthly");
  });

  it.each([
    { extra: 1 },
    { schema: 2 },
    { policy_id: "" },
    { policy_id: "has spaces" },
    { version: 0 },
    { version: 1.5 },
    { mode: "production" },
    { epoch: 0 },
    { root_nonce: "abc" },
    { key_commitment: "not-a-mac" },
    { service_daily_micro_usd: -1 },
    { service_daily_micro_usd: Number.NaN },
  ])("rejects a malformed policy header: %j", (change) => {
    expect(() => validateBillingOperatorPolicy(basePolicy(change))).toThrow(BrainError);
  });

  it.each([
    { catalog: [catalogEntry()] },
    { catalog: [catalogEntry(), catalogEntry({ cadence: "annual" }), catalogEntry({ cadence: "monthly" })] },
    { catalog: [catalogEntry(), catalogEntry({ cadence: "monthly", price_ref: "x" })] },
    { catalog: [catalogEntry(), catalogEntry({ cadence: "annual", price_ref: "s".repeat(201) })] },
    { catalog: [catalogEntry(), catalogEntry({ cadence: "annual", product_ref: "other" })] },
    { catalog: [catalogEntry(), catalogEntry({ cadence: "annual", allowance_micro_usd: 1 })] },
    { catalog: [catalogEntry(), catalogEntry({ cadence: "annual", per_job_micro_usd: 1 })] },
    { catalog: [catalogEntry(), catalogEntry({ cadence: "annual", user_daily_micro_usd: 1 })] },
    { catalog: [catalogEntry({ allowance_micro_usd: 1.5 }), catalogEntry({ cadence: "annual", price_ref: "y" })] },
    { catalog: [catalogEntry({ allowance_micro_usd: Number.MAX_SAFE_INTEGER + 1 }), catalogEntry({ cadence: "annual", price_ref: "y" })] },
    { catalog: [catalogEntry({ extra: 1 }), catalogEntry({ cadence: "annual", price_ref: "y" })] },
  ])("rejects an invalid catalog: %j", (change) => {
    expect(() => validateBillingOperatorPolicy(basePolicy(change))).toThrow(BrainError);
  });

  it("rejects a non-dense or non-data catalog array", () => {
    const sparse: unknown[] = [catalogEntry(), catalogEntry({ cadence: "annual", price_ref: "y" })];
    delete sparse[0];
    expect(() => validateBillingOperatorPolicy(basePolicy({ catalog: sparse }))).toThrow(BrainError);

    const withExtra = [catalogEntry(), catalogEntry({ cadence: "annual", price_ref: "y" })];
    (withExtra as unknown as Record<string, unknown>).extra = 1;
    expect(() => validateBillingOperatorPolicy(basePolicy({ catalog: withExtra }))).toThrow(BrainError);

    const withSymbol = [catalogEntry(), catalogEntry({ cadence: "annual", price_ref: "y" })];
    Object.defineProperty(withSymbol, Symbol("extra"), { value: 1 });
    expect(() => validateBillingOperatorPolicy(basePolicy({ catalog: withSymbol }))).toThrow(BrainError);

    const accessor = [catalogEntry(), catalogEntry({ cadence: "annual", price_ref: "y" })];
    Object.defineProperty(accessor, "0", { enumerable: true, configurable: true, get: () => catalogEntry() });
    expect(() => validateBillingOperatorPolicy(basePolicy({ catalog: accessor }))).toThrow(BrainError);
  });
});

describe("billingOperatorPolicyDigest", () => {
  it("matches an independently serialized canonical vector", () => {
    const policy = basePolicy();
    const literal =
      `{"catalog":[{"allowance_micro_usd":1000,"cadence":"monthly","per_job_micro_usd":100,` +
      `"price_ref":"SYNTHETIC-price-monthly","product_ref":"SYNTHETIC-product","user_daily_micro_usd":500},` +
      `{"allowance_micro_usd":1000,"cadence":"annual","per_job_micro_usd":100,` +
      `"price_ref":"SYNTHETIC-price-annual","product_ref":"SYNTHETIC-product","user_daily_micro_usd":500}],` +
      `"epoch":1,"key_commitment":"${COMMITMENT}","mode":"sandbox","policy_id":"SYNTHETIC-policy",` +
      `"root_nonce":"${NONCE}","schema":1,"service_daily_micro_usd":10000,"version":1}`;
    expect(billingOperatorPolicyDigest(policy)).toBe(createHash("sha256").update(literal).digest("hex"));
  });

  it("is unchanged by catalog reordering but changes for every meaningful field", () => {
    const monthlyFirst = billingOperatorPolicyDigest(basePolicy());
    const annualFirst = billingOperatorPolicyDigest(
      basePolicy({
        catalog: [
          catalogEntry({ cadence: "annual", price_ref: "SYNTHETIC-price-annual" }),
          catalogEntry(),
        ],
      }),
    );
    expect(annualFirst).toBe(monthlyFirst);
    expect(billingOperatorPolicyDigest(basePolicy())).toMatch(/^[a-f0-9]{64}$/);

    for (const change of [
      { policy_id: "SYNTHETIC-other" },
      { version: 2 },
      { mode: "live" },
      { epoch: 2 },
      { root_nonce: "c".repeat(64) },
      { key_commitment: "d".repeat(64) },
      { service_daily_micro_usd: 10_001 },
    ]) {
      expect(billingOperatorPolicyDigest(basePolicy(change))).not.toBe(monthlyFirst);
    }
    const bothAnnual = basePolicy({
      catalog: [catalogEntry({ allowance_micro_usd: 1001 }), catalogEntry({ cadence: "annual", price_ref: "SYNTHETIC-price-annual", allowance_micro_usd: 1001 })],
    });
    expect(billingOperatorPolicyDigest(bothAnnual)).not.toBe(monthlyFirst);
  });
});

describe("resolveBillingCatalogPlan", () => {
  it("returns the matching owned plan", () => {
    const policy = basePolicy();
    const plan = resolveBillingCatalogPlan(policy, selection());
    expect(plan).toEqual(catalogEntry());
    expect(plan).not.toBe(policy.catalog[0]);
    plan!.allowance_micro_usd = 999_999;
    expect(policy.catalog[0]!.allowance_micro_usd).toBe(1000);
  });

  it.each([
    { mode: "live" },
    { cadence: "annual", price_ref: "SYNTHETIC-price-monthly" },
    { product_ref: "other" },
    { price_ref: "other" },
  ])("returns null for a well-formed non-match: %j", (change) => {
    expect(resolveBillingCatalogPlan(basePolicy(), selection(change))).toBeNull();
  });

  it.each([
    [{ ...selection(), extra: 1 }],
    [{ ...selection(), cadence: 1.5 }],
    [{ ...selection(), mode: "production" }],
    [{ ...selection(), price_ref: "" }],
    [{ mode: "sandbox" }],
  ])("throws for a malformed selection: %j", (bad) => {
    expect(() => resolveBillingCatalogPlan(basePolicy(), bad)).toThrow(BrainError);
  });

  it("validates the policy before the selection, so an invalid policy never hides", () => {
    expect(() => resolveBillingCatalogPlan(basePolicy({ schema: 2 }), selection({ price_ref: "nope" }))).toThrow(BrainError);
  });

  it("returns null for a zero ceiling anywhere in the selected plan or the service", () => {
    const zeroService = basePolicy({ service_daily_micro_usd: ZERO });
    expect(resolveBillingCatalogPlan(zeroService, selection())).toBeNull();

    for (const change of [{ allowance_micro_usd: ZERO }, { per_job_micro_usd: ZERO }, { user_daily_micro_usd: ZERO }]) {
      const zeroPlan = basePolicy({
        catalog: [
          catalogEntry(change),
          catalogEntry({ cadence: "annual", price_ref: "SYNTHETIC-price-annual", ...change }),
        ],
        ...(change.allowance_micro_usd === ZERO ? { service_daily_micro_usd: 10_000 } : {}),
      });
      expect(resolveBillingCatalogPlan(zeroPlan, selection())).toBeNull();
    }
  });

  it("is deterministic and returns only owned structural data", () => {
    const policy = basePolicy();
    expect(resolveBillingCatalogPlan(policy, selection())).toEqual(resolveBillingCatalogPlan(policy, selection()));
    expect(canonical(resolveBillingCatalogPlan(policy, selection()))).toBe(canonical(catalogEntry()));
  });
});
