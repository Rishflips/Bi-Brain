import { createHash } from "node:crypto";
import { canonical } from "./logic.ts";
import { assertExactKeys, invalid, isHex64, isPlainObject, isSafeInt, isToken, isUuid, parseCanonicalUtc } from "./billing-authority.ts";
import type { BillingMode } from "./billing-policy.ts";

/**
 * T2W trusted evidence contract.
 *
 * Pure types and closed validators for the server-owned binding and the provider facts
 * that a trusted `EvidenceSource` returns. A non-null source is dependency injection, not
 * proof that Paddle was contacted; the production source is `null` until separately
 * approved B1 exists. These helpers perform no IO and confer no entitlement.
 */

export interface ServerOwnedBinding {
  schema: 1;
  account_id: string;
  identity_digest: string;
  tenant_incarnation: string;
  provisioning_generation: number;
  mode: BillingMode;
  product_ref: string;
  price_ref: string;
  cadence: "monthly" | "annual";
  customer_ref: string;
  subscription_ref: string;
  initial_transaction_ref: string;
  correlation_ref: string;
  version: number;
}

export type ProviderState = "active" | "past_due" | "canceled" | "refunded" | "paused" | "unknown";

export interface ProviderFacts {
  transaction_ref: string;
  subscription_ref: string;
  customer_ref: string;
  product_ref: string;
  price_ref: string;
  cadence: "monthly" | "annual";
  completed_payment: boolean;
  current_state: ProviderState;
  paid_period_start: string;
  paid_period_end: string;
  verified_at: string;
}

export interface EvidenceSource {
  read(binding: ServerOwnedBinding): Promise<ProviderFacts>;
}

export interface BillingReceipt {
  schema: 1;
  account_id: string;
  binding_digest: string;
  transaction_ref: string;
  subscription_ref: string;
  customer_ref: string;
  product_ref: string;
  price_ref: string;
  cadence: "monthly" | "annual";
  completed_payment: true;
  paid_period_start: string;
  paid_period_end: string;
}

export interface BillingObservation extends ProviderFacts {
  schema: 1;
  account_id: string;
  binding_digest: string;
}

/** A denial observation is a normalized, time-independent adverse record. */
export interface BillingDenialObservation {
  schema: 1;
  account_id: string;
  binding_digest: string;
  transaction_ref: string;
  subscription_ref: string;
  customer_ref: string;
  product_ref: string;
  price_ref: string;
  cadence: "monthly" | "annual";
  completed_payment: boolean;
  current_state: ProviderState;
  paid_period_start: string;
  paid_period_end: string;
}

const BINDING_KEYS = [
  "schema",
  "account_id",
  "identity_digest",
  "tenant_incarnation",
  "provisioning_generation",
  "mode",
  "product_ref",
  "price_ref",
  "cadence",
  "customer_ref",
  "subscription_ref",
  "initial_transaction_ref",
  "correlation_ref",
  "version",
] as const;
const FACTS_KEYS = [
  "transaction_ref",
  "subscription_ref",
  "customer_ref",
  "product_ref",
  "price_ref",
  "cadence",
  "completed_payment",
  "current_state",
  "paid_period_start",
  "paid_period_end",
  "verified_at",
] as const;
const STATES: readonly ProviderState[] = ["active", "past_due", "canceled", "refunded", "paused", "unknown"];

const sha = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");

export function validateServerOwnedBinding(input: unknown): ServerOwnedBinding {
  if (!isPlainObject(input)) invalid("A server-owned binding is required.");
  assertExactKeys(input, BINDING_KEYS);
  if (input.schema !== 1) invalid("The server-owned binding schema is unsupported.");
  if (!isUuid(input.account_id)) invalid("The server-owned binding account is invalid.");
  if (!isHex64(input.identity_digest)) invalid("The server-owned binding identity digest is invalid.");
  if (!isHex64(input.tenant_incarnation)) invalid("The server-owned binding incarnation is invalid.");
  if (!isSafeInt(input.provisioning_generation, 1)) invalid("The server-owned binding generation is invalid.");
  if (input.mode !== "sandbox" && input.mode !== "live") invalid("The server-owned binding mode is invalid.");
  if (!isToken(input.product_ref)) invalid("The server-owned binding product is invalid.");
  if (!isToken(input.price_ref)) invalid("The server-owned binding price is invalid.");
  if (input.cadence !== "monthly" && input.cadence !== "annual") invalid("The server-owned binding cadence is invalid.");
  if (!isToken(input.customer_ref)) invalid("The server-owned binding customer is invalid.");
  if (!isToken(input.subscription_ref)) invalid("The server-owned binding subscription is invalid.");
  if (!isToken(input.initial_transaction_ref)) invalid("The server-owned binding initial transaction is invalid.");
  if (!isToken(input.correlation_ref)) invalid("The server-owned binding correlation is invalid.");
  if (!isSafeInt(input.version, 1)) invalid("The server-owned binding version is invalid.");
  return {
    schema: 1,
    account_id: input.account_id as string,
    identity_digest: input.identity_digest as string,
    tenant_incarnation: input.tenant_incarnation as string,
    provisioning_generation: input.provisioning_generation as number,
    mode: input.mode as BillingMode,
    product_ref: input.product_ref as string,
    price_ref: input.price_ref as string,
    cadence: input.cadence as "monthly" | "annual",
    customer_ref: input.customer_ref as string,
    subscription_ref: input.subscription_ref as string,
    initial_transaction_ref: input.initial_transaction_ref as string,
    correlation_ref: input.correlation_ref as string,
    version: input.version as number,
  };
}

export function validateProviderFacts(input: unknown): ProviderFacts {
  if (!isPlainObject(input)) invalid("Provider facts are required.");
  assertExactKeys(input, FACTS_KEYS);
  if (!isToken(input.transaction_ref)) invalid("The provider transaction is invalid.");
  if (!isToken(input.subscription_ref)) invalid("The provider subscription is invalid.");
  if (!isToken(input.customer_ref)) invalid("The provider customer is invalid.");
  if (!isToken(input.product_ref)) invalid("The provider product is invalid.");
  if (!isToken(input.price_ref)) invalid("The provider price is invalid.");
  if (input.cadence !== "monthly" && input.cadence !== "annual") invalid("The provider cadence is invalid.");
  if (typeof input.completed_payment !== "boolean") invalid("The provider payment flag is invalid.");
  if (typeof input.current_state !== "string" || !STATES.includes(input.current_state as ProviderState))
    invalid("The provider state is invalid.");
  const start = parseCanonicalUtc(input.paid_period_start);
  const end = parseCanonicalUtc(input.paid_period_end);
  if (start.getTime() >= end.getTime()) invalid("The provider paid period is invalid.");
  parseCanonicalUtc(input.verified_at);
  return {
    transaction_ref: input.transaction_ref as string,
    subscription_ref: input.subscription_ref as string,
    customer_ref: input.customer_ref as string,
    product_ref: input.product_ref as string,
    price_ref: input.price_ref as string,
    cadence: input.cadence as "monthly" | "annual",
    completed_payment: input.completed_payment,
    current_state: input.current_state as ProviderState,
    paid_period_start: start.toISOString(),
    paid_period_end: end.toISOString(),
    verified_at: parseCanonicalUtc(input.verified_at).toISOString(),
  };
}

export function identityDigest(input: { account_id: string; issuer: string; subject: string }): string {
  if (!isUuid(input.account_id)) invalid("The identity account is invalid.");
  if (typeof input.issuer !== "string" || typeof input.subject !== "string")
    invalid("The identity pair is invalid.");
  return sha({ account_id: input.account_id, issuer: input.issuer, subject: input.subject });
}

export function bindingDigest(binding: ServerOwnedBinding): string {
  return sha(validateServerOwnedBinding(binding));
}

export function termId(accountId: string, facts: ProviderFacts): string {
  const value = validateProviderFacts(facts);
  return sha({
    account_id: accountId,
    subscription_ref: value.subscription_ref,
    paid_period_start: value.paid_period_start,
    paid_period_end: value.paid_period_end,
  });
}

/** The same term identity, derived from an already validated receipt (no provider fields). */
export function receiptTermId(accountId: string, receipt: BillingReceipt): string {
  const value = validateBillingReceipt(receipt);
  return sha({
    account_id: accountId,
    subscription_ref: value.subscription_ref,
    paid_period_start: value.paid_period_start,
    paid_period_end: value.paid_period_end,
  });
}

export function receiptFromFacts(facts: ProviderFacts, binding: ServerOwnedBinding): BillingReceipt {
  const value = validateProviderFacts(facts);
  const bound = validateServerOwnedBinding(binding);
  if (!value.completed_payment) invalid("A billing receipt requires a completed payment.");
  if (
    value.product_ref !== bound.product_ref ||
    value.price_ref !== bound.price_ref ||
    value.cadence !== bound.cadence ||
    value.customer_ref !== bound.customer_ref ||
    value.subscription_ref !== bound.subscription_ref
  )
    invalid("Provider facts do not match the bound subscription.");
  return {
    schema: 1,
    account_id: bound.account_id,
    binding_digest: sha(bound),
    transaction_ref: value.transaction_ref,
    subscription_ref: value.subscription_ref,
    customer_ref: value.customer_ref,
    product_ref: value.product_ref,
    price_ref: value.price_ref,
    cadence: value.cadence,
    completed_payment: true,
    paid_period_start: value.paid_period_start,
    paid_period_end: value.paid_period_end,
  };
}

export function receiptDigest(receipt: BillingReceipt): string {
  return sha(receipt);
}

export function observationFromFacts(
  facts: ProviderFacts,
  accountId: string,
  bindingDigestValue: string,
): BillingObservation {
  const value = validateProviderFacts(facts);
  return { schema: 1, account_id: accountId, binding_digest: bindingDigestValue, ...value };
}

export function observationDigest(observation: BillingObservation): string {
  return sha(observation);
}

const RECEIPT_KEYS = [
  "schema",
  "account_id",
  "binding_digest",
  "transaction_ref",
  "subscription_ref",
  "customer_ref",
  "product_ref",
  "price_ref",
  "cadence",
  "completed_payment",
  "paid_period_start",
  "paid_period_end",
] as const;
const OBSERVATION_KEYS = [
  "schema",
  "account_id",
  "binding_digest",
  ...FACTS_KEYS,
] as const;

/** Closed receipt validation owned by the evidence layer (never trusts a stored row alone). */
export function validateBillingReceipt(input: unknown): BillingReceipt {
  if (!isPlainObject(input)) invalid("A billing receipt is required.");
  assertExactKeys(input, RECEIPT_KEYS);
  if (input.schema !== 1) invalid("The billing receipt schema is unsupported.");
  if (!isUuid(input.account_id)) invalid("The billing receipt account is invalid.");
  if (!isHex64(input.binding_digest)) invalid("The billing receipt binding digest is invalid.");
  if (!isToken(input.transaction_ref)) invalid("The billing receipt transaction is invalid.");
  if (!isToken(input.subscription_ref)) invalid("The billing receipt subscription is invalid.");
  if (!isToken(input.customer_ref)) invalid("The billing receipt customer is invalid.");
  if (!isToken(input.product_ref)) invalid("The billing receipt product is invalid.");
  if (!isToken(input.price_ref)) invalid("The billing receipt price is invalid.");
  if (input.cadence !== "monthly" && input.cadence !== "annual") invalid("The billing receipt cadence is invalid.");
  if (input.completed_payment !== true) invalid("The billing receipt requires a completed payment.");
  const start = parseCanonicalUtc(input.paid_period_start);
  const end = parseCanonicalUtc(input.paid_period_end);
  if (start.getTime() >= end.getTime()) invalid("The billing receipt period is invalid.");
  return {
    schema: 1,
    account_id: input.account_id as string,
    binding_digest: input.binding_digest as string,
    transaction_ref: input.transaction_ref as string,
    subscription_ref: input.subscription_ref as string,
    customer_ref: input.customer_ref as string,
    product_ref: input.product_ref as string,
    price_ref: input.price_ref as string,
    cadence: input.cadence as "monthly" | "annual",
    completed_payment: true,
    paid_period_start: start.toISOString(),
    paid_period_end: end.toISOString(),
  };
}

/** Closed observation validation; the projection MAC over it is still required separately. */
export function validateBillingObservation(input: unknown): BillingObservation {
  if (!isPlainObject(input)) invalid("A billing observation is required.");
  assertExactKeys(input, OBSERVATION_KEYS);
  if (input.schema !== 1) invalid("The billing observation schema is unsupported.");
  if (!isUuid(input.account_id)) invalid("The billing observation account is invalid.");
  if (!isHex64(input.binding_digest)) invalid("The billing observation binding digest is invalid.");
  const facts = validateProviderFacts({
    transaction_ref: input.transaction_ref,
    subscription_ref: input.subscription_ref,
    customer_ref: input.customer_ref,
    product_ref: input.product_ref,
    price_ref: input.price_ref,
    cadence: input.cadence,
    completed_payment: input.completed_payment,
    current_state: input.current_state,
    paid_period_start: input.paid_period_start,
    paid_period_end: input.paid_period_end,
    verified_at: input.verified_at,
  });
  return { schema: 1, account_id: input.account_id as string, binding_digest: input.binding_digest as string, ...facts };
}

const DENIAL_KEYS = [
  "schema",
  "account_id",
  "binding_digest",
  "transaction_ref",
  "subscription_ref",
  "customer_ref",
  "product_ref",
  "price_ref",
  "cadence",
  "completed_payment",
  "current_state",
  "paid_period_start",
  "paid_period_end",
] as const;

/** A normalized, time-independent denial observation (no `verified_at`, so a repeated
 * adverse poll over the same state is idempotent). */
export function denialFromFacts(
  facts: ProviderFacts,
  accountId: string,
  bindingDigestValue: string,
): BillingDenialObservation {
  const value = validateProviderFacts(facts);
  return {
    schema: 1,
    account_id: accountId,
    binding_digest: bindingDigestValue,
    transaction_ref: value.transaction_ref,
    subscription_ref: value.subscription_ref,
    customer_ref: value.customer_ref,
    product_ref: value.product_ref,
    price_ref: value.price_ref,
    cadence: value.cadence,
    completed_payment: value.completed_payment,
    current_state: value.current_state,
    paid_period_start: value.paid_period_start,
    paid_period_end: value.paid_period_end,
  };
}

export function validateBillingDenialObservation(input: unknown): BillingDenialObservation {
  if (!isPlainObject(input)) invalid("A billing denial observation is required.");
  assertExactKeys(input, DENIAL_KEYS);
  if (input.schema !== 1) invalid("The billing denial schema is unsupported.");
  if (!isUuid(input.account_id)) invalid("The billing denial account is invalid.");
  if (!isHex64(input.binding_digest)) invalid("The billing denial binding digest is invalid.");
  const facts = validateProviderFacts({
    transaction_ref: input.transaction_ref,
    subscription_ref: input.subscription_ref,
    customer_ref: input.customer_ref,
    product_ref: input.product_ref,
    price_ref: input.price_ref,
    cadence: input.cadence,
    completed_payment: input.completed_payment,
    current_state: input.current_state,
    paid_period_start: input.paid_period_start,
    paid_period_end: input.paid_period_end,
    verified_at: "2000-01-01T00:00:00.000Z",
  });
  return {
    schema: 1,
    account_id: input.account_id as string,
    binding_digest: input.binding_digest as string,
    transaction_ref: facts.transaction_ref,
    subscription_ref: facts.subscription_ref,
    customer_ref: facts.customer_ref,
    product_ref: facts.product_ref,
    price_ref: facts.price_ref,
    cadence: facts.cadence,
    completed_payment: facts.completed_payment,
    current_state: facts.current_state,
    paid_period_start: facts.paid_period_start,
    paid_period_end: facts.paid_period_end,
  };
}

export function denialDigest(denial: BillingDenialObservation): string {
  return sha(denial);
}
