import { createHash } from "node:crypto";
import { canonical } from "./logic.ts";
import { maxMicroUsd } from "./spend.ts";
import {
  assertExactKeys,
  invalid,
  isHex64,
  isPlainObject,
  isSafeInt,
  isToken,
} from "./billing-authority.ts";

/**
 * T2P frozen operator billing policy contract.
 *
 * Pure, data-only configuration for the later private financial writer. It performs no
 * IO, reads no clock, touches no environment or key file, and confers NO entitlement:
 * these functions validate and resolve structural configuration only. Every monetary
 * value is a **model-cost micro-USD** cap, never a customer price, payment amount or
 * Paddle charge; no value is derived from a payment and no economic default is invented.
 *
 * The later writer must load this exact audited policy (checked again under its own
 * transaction) and must never accept a provider- or caller-supplied allowance. There is
 * no public append/seal method here.
 */

export type BillingMode = "sandbox" | "live";

export interface BillingCatalogPlan {
  cadence: "monthly" | "annual";
  product_ref: string;
  price_ref: string;
  allowance_micro_usd: number;
  per_job_micro_usd: number;
  user_daily_micro_usd: number;
}

export interface BillingOperatorPolicy {
  schema: 1;
  policy_id: string;
  version: number;
  mode: BillingMode;
  epoch: number;
  root_nonce: string;
  key_commitment: string;
  service_daily_micro_usd: number;
  catalog: BillingCatalogPlan[];
}

const POLICY_KEYS = [
  "schema",
  "policy_id",
  "version",
  "mode",
  "epoch",
  "root_nonce",
  "key_commitment",
  "service_daily_micro_usd",
  "catalog",
] as const;
const CATALOG_KEYS = [
  "cadence",
  "product_ref",
  "price_ref",
  "allowance_micro_usd",
  "per_job_micro_usd",
  "user_daily_micro_usd",
] as const;
const SELECTION_KEYS = ["mode", "cadence", "product_ref", "price_ref"] as const;

function assertMoney(value: unknown): asserts value is number {
  if (!isSafeInt(value, 0, maxMicroUsd)) invalid("A billing policy monetary value is invalid.");
}

function validateCatalogEntry(value: unknown): BillingCatalogPlan {
  if (!isPlainObject(value)) invalid("A billing catalog entry is required.");
  assertExactKeys(value, CATALOG_KEYS);
  const cadence = value.cadence;
  if (cadence !== "monthly" && cadence !== "annual") invalid("A billing catalog cadence is invalid.");
  if (!isToken(value.product_ref)) invalid("A billing catalog product reference is invalid.");
  if (!isToken(value.price_ref)) invalid("A billing catalog price reference is invalid.");
  assertMoney(value.allowance_micro_usd);
  assertMoney(value.per_job_micro_usd);
  assertMoney(value.user_daily_micro_usd);
  return {
    cadence,
    product_ref: value.product_ref as string,
    price_ref: value.price_ref as string,
    allowance_micro_usd: value.allowance_micro_usd,
    per_job_micro_usd: value.per_job_micro_usd,
    user_daily_micro_usd: value.user_daily_micro_usd,
  };
}

/**
 * Exactly two dense data entries. The array is never iterated with an untrusted
 * iterator: length is bounded to 2 first, surplus index/symbol/extra keys are rejected,
 * and each index is read through its own data descriptor.
 */
function catalogSnapshot(value: unknown): [BillingCatalogPlan, BillingCatalogPlan] {
  if (!Array.isArray(value)) invalid("The billing catalog must be an array.");
  const length = value.length;
  if (!Number.isSafeInteger(length) || length !== 2) invalid("The billing catalog must have exactly two entries.");
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1) invalid("The billing catalog must be a dense two-entry array.");
  const allowed = new Set<string>(["length", "0", "1"]);
  for (const key of keys) if (typeof key !== "string" || !allowed.has(key)) invalid("The billing catalog has an unexpected property.");
  const entries: BillingCatalogPlan[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) invalid("A billing catalog entry must be plain data.");
    entries.push(validateCatalogEntry(descriptor.value));
  }
  return [entries[0]!, entries[1]!];
}

/** Closed validation. Returns an owned policy canonicalized to monthly then annual. */
export function validateBillingOperatorPolicy(input: unknown): BillingOperatorPolicy {
  if (!isPlainObject(input)) invalid("A billing operator policy is required.");
  assertExactKeys(input, POLICY_KEYS);
  if (input.schema !== 1) invalid("The billing operator policy schema is unsupported.");
  if (!isToken(input.policy_id)) invalid("The billing operator policy id is invalid.");
  if (!isSafeInt(input.version, 1)) invalid("The billing operator policy version is invalid.");
  const mode = input.mode;
  if (mode !== "sandbox" && mode !== "live") invalid("The billing operator policy mode is invalid.");
  if (!isSafeInt(input.epoch, 1)) invalid("The billing operator policy epoch is invalid.");
  if (!isHex64(input.root_nonce)) invalid("The billing operator policy nonce is invalid.");
  if (!isHex64(input.key_commitment)) invalid("The billing operator policy key commitment is invalid.");
  assertMoney(input.service_daily_micro_usd);

  const [first, second] = catalogSnapshot(input.catalog);
  const monthly = first.cadence === "monthly" ? first : second;
  const annual = first.cadence === "monthly" ? second : first;
  if (monthly.cadence === annual.cadence) invalid("The billing catalog must have one entry per cadence.");
  if (monthly.product_ref !== annual.product_ref) invalid("Both billing cadences must share one product.");
  if (monthly.price_ref === annual.price_ref) invalid("Billing cadences must use distinct price references.");
  if (
    monthly.allowance_micro_usd !== annual.allowance_micro_usd ||
    monthly.per_job_micro_usd !== annual.per_job_micro_usd ||
    monthly.user_daily_micro_usd !== annual.user_daily_micro_usd
  )
    invalid("Both billing cadences must share the same monthly allowance and caps.");

  return {
    schema: 1,
    policy_id: input.policy_id as string,
    version: input.version as number,
    mode,
    epoch: input.epoch as number,
    root_nonce: input.root_nonce as string,
    key_commitment: input.key_commitment as string,
    service_daily_micro_usd: input.service_daily_micro_usd,
    catalog: [monthly, annual],
  };
}

/** SHA-256 over the canonical policy, including every field, reference and cap. */
export function billingOperatorPolicyDigest(input: unknown): string {
  return createHash("sha256").update(canonical(validateBillingOperatorPolicy(input))).digest("hex");
}

/**
 * Resolve one catalog plan for an exact, mode-bound selection. The policy is validated
 * first, so a malformed selection can never hide an invalid policy. A well-formed
 * selection that simply does not match returns `null`; a zero service or selected-plan
 * ceiling returns `null` (default-off, never an automatic free allowance).
 */
export function resolveBillingCatalogPlan(
  policy: unknown,
  selection: unknown,
): BillingCatalogPlan | null {
  const validated = validateBillingOperatorPolicy(policy);
  if (!isPlainObject(selection)) invalid("A billing plan selection is required.");
  assertExactKeys(selection, SELECTION_KEYS);
  const mode = selection.mode;
  if (mode !== "sandbox" && mode !== "live") invalid("The billing plan selection mode is invalid.");
  const cadence = selection.cadence;
  if (cadence !== "monthly" && cadence !== "annual") invalid("The billing plan selection cadence is invalid.");
  if (!isToken(selection.product_ref)) invalid("The billing plan selection product reference is invalid.");
  if (!isToken(selection.price_ref)) invalid("The billing plan selection price reference is invalid.");

  if (mode !== validated.mode) return null;
  const plan = validated.catalog.find(
    (entry) =>
      entry.cadence === cadence &&
      entry.product_ref === selection.product_ref &&
      entry.price_ref === selection.price_ref,
  );
  if (!plan) return null;
  if (
    validated.service_daily_micro_usd === 0 ||
    plan.allowance_micro_usd === 0 ||
    plan.per_job_micro_usd === 0 ||
    plan.user_daily_micro_usd === 0
  )
    return null;
  return {
    cadence: plan.cadence,
    product_ref: plan.product_ref,
    price_ref: plan.price_ref,
    allowance_micro_usd: plan.allowance_micro_usd,
    per_job_micro_usd: plan.per_job_micro_usd,
    user_daily_micro_usd: plan.user_daily_micro_usd,
  };
}
