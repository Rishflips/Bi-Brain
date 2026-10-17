import { createHash } from "node:crypto";
import { canonical } from "./logic.ts";
import {
  assertExactKeys,
  invalid,
  isHex64,
  isPlainObject,
  isSafeInt,
  isToken,
  isUuid,
  parseCanonicalUtc,
} from "./billing-authority.ts";
import type { BillingMode } from "./billing-policy.ts";

/**
 * T3 billing-admission pure contracts.
 *
 * Closed shapes for the provisioning incarnation, the durable admission
 * preflight record, the enrollment anchor and the trusted server correlation
 * source. No IO, no clock, no key: a MAC-shaped digest here is structural data,
 * never permission. Only the authority store may seal or consume a proof.
 */

const sha = (value: unknown): string =>
  createHash("sha256").update(canonical(value)).digest("hex");

// ------------------------------------------------------------- incarnation

export type IncarnationSource = "provision" | "restore" | "rebuild" | "enroll";

export interface Incarnation {
  incarnation: string;
  provisioning_generation: number;
  source: IncarnationSource;
  minted_at: string;
}

const INCARNATION_KEYS = [
  "account_id",
  "issuer",
  "subject",
  "provisioning_generation",
  "minted_at",
  "nonce",
] as const;

/**
 * Deterministic, pure incarnation mint. The caller supplies a random 32-byte
 * `nonce`; identical inputs yield the identical incarnation so a re-provision can
 * never rotate a generation.
 */
export function mintIncarnation(input: unknown): Incarnation {
  if (!isPlainObject(input)) invalid("An incarnation request is required.");
  assertExactKeys(input, INCARNATION_KEYS);
  if (!isUuid(input.account_id)) invalid("The incarnation account is invalid.");
  if (
    typeof input.issuer !== "string" ||
    input.issuer.length === 0 ||
    input.issuer.length > 300 ||
    typeof input.subject !== "string" ||
    input.subject.length === 0 ||
    input.subject.length > 300
  )
    invalid("The incarnation identity is invalid.");
  if (!isSafeInt(input.provisioning_generation, 1))
    invalid("The incarnation generation is invalid.");
  const minted = parseCanonicalUtc(input.minted_at);
  if (!isHex64(input.nonce)) invalid("The incarnation nonce is invalid.");
  const incarnation = sha({
    schema: 1,
    account_id: input.account_id,
    issuer: input.issuer,
    subject: input.subject,
    provisioning_generation: input.provisioning_generation,
    minted_at: minted.toISOString(),
    nonce: input.nonce,
  });
  return {
    incarnation,
    provisioning_generation: input.provisioning_generation as number,
    source: "provision",
    minted_at: minted.toISOString(),
  };
}

// --------------------------------------------------------- clean baseline

export interface CleanBaselineProof {
  schema: 1;
  account_id: string;
  incarnation: string;
  provisioning_generation: number;
  tenant_schema_version: number;
  provider_dispatches: 0;
  legacy_reservations: 0;
  paid_processing_blocked: false;
}

export function cleanBaselineDigest(input: CleanBaselineProof): string {
  return sha(input);
}

// ---------------------------------------------------------- correlation

export interface ServerBillingCorrelation {
  schema: 1;
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

export interface BillingCorrelationSource {
  resolve(input: {
    account_id: string;
    identity_digest: string;
  }): Promise<ServerBillingCorrelation>;
}

const CORRELATION_KEYS = [
  "schema",
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

export function validateServerBillingCorrelation(
  input: unknown,
): ServerBillingCorrelation {
  if (!isPlainObject(input)) invalid("A server billing correlation is required.");
  assertExactKeys(input, CORRELATION_KEYS);
  if (input.schema !== 1) invalid("The server billing correlation schema is unsupported.");
  if (input.mode !== "sandbox" && input.mode !== "live")
    invalid("The server billing correlation mode is invalid.");
  if (!isToken(input.product_ref)) invalid("The correlation product is invalid.");
  if (!isToken(input.price_ref)) invalid("The correlation price is invalid.");
  if (input.cadence !== "monthly" && input.cadence !== "annual")
    invalid("The correlation cadence is invalid.");
  if (!isToken(input.customer_ref)) invalid("The correlation customer is invalid.");
  if (!isToken(input.subscription_ref)) invalid("The correlation subscription is invalid.");
  if (!isToken(input.initial_transaction_ref))
    invalid("The correlation initial transaction is invalid.");
  if (!isToken(input.correlation_ref)) invalid("The correlation reference is invalid.");
  if (!isSafeInt(input.version, 1)) invalid("The correlation version is invalid.");
  return {
    schema: 1,
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

// -------------------------------------------------- complete preflight record

/** The closed column set stored in `control_billing_preflight` and hashed. */
export interface AdmissionPreflightColumns {
  preflight_id: string;
  account_id: string;
  incarnation: string;
  provisioning_generation: number;
  identity_digest: string;
  binding_digest: string;
  binding_json: string;
  baseline_json: string;
  policy_id: string;
  policy_digest: string;
  root_epoch: number;
  root_nonce: string;
  mode: BillingMode;
  created_at: string;
  expires_at: string;
}

const CLEAN_BASELINE_KEYS = [
  "schema",
  "account_id",
  "incarnation",
  "provisioning_generation",
  "tenant_schema_version",
  "provider_dispatches",
  "legacy_reservations",
  "paid_processing_blocked",
] as const;

/** Closed validation of the retained clean-baseline payload. */
export function validateCleanBaselineProof(input: unknown): CleanBaselineProof {
  if (!isPlainObject(input)) invalid("A clean baseline proof is required.");
  assertExactKeys(input, CLEAN_BASELINE_KEYS);
  if (input.schema !== 1) invalid("The clean baseline schema is unsupported.");
  if (!isUuid(input.account_id)) invalid("The clean baseline account is invalid.");
  if (!isHex64(input.incarnation)) invalid("The clean baseline incarnation is invalid.");
  if (!isSafeInt(input.provisioning_generation, 1)) invalid("The clean baseline generation is invalid.");
  if (!isSafeInt(input.tenant_schema_version, 0)) invalid("The clean baseline tenant schema is invalid.");
  if (input.provider_dispatches !== 0 || input.legacy_reservations !== 0)
    invalid("The clean baseline must have zero financial history.");
  if (input.paid_processing_blocked !== false) invalid("The clean baseline must not be blocked.");
  return {
    schema: 1,
    account_id: input.account_id as string,
    incarnation: input.incarnation as string,
    provisioning_generation: input.provisioning_generation as number,
    tenant_schema_version: input.tenant_schema_version as number,
    provider_dispatches: 0,
    legacy_reservations: 0,
    paid_processing_blocked: false,
  };
}

/**
 * The authenticated request digest bound into the proof frame as
 * `request:<digest>`. It covers every stored preflight column plus the clean
 * baseline proof carried in the frame body, so a mutated expiry/mode/generation or
 * a swapped body can never re-satisfy the proof.
 */
export function preflightRequestDigest(
  columns: AdmissionPreflightColumns,
  cleanBaselineProof: string,
): string {
  return sha({
    schema: 1,
    purpose: "billing-admission-preflight",
    preflight_id: columns.preflight_id,
    account_id: columns.account_id,
    incarnation: columns.incarnation,
    provisioning_generation: columns.provisioning_generation,
    identity_digest: columns.identity_digest,
    binding_digest: columns.binding_digest,
    binding_json: columns.binding_json,
    baseline_json: columns.baseline_json,
    policy_id: columns.policy_id,
    policy_digest: columns.policy_digest,
    root_epoch: columns.root_epoch,
    root_nonce: columns.root_nonce,
    mode: columns.mode,
    clean_baseline_proof: cleanBaselineProof,
    created_at: columns.created_at,
    expires_at: columns.expires_at,
  });
}

// ------------------------------------------------------------- decisions

export type AdmissionReason =
  | "no_source"
  | "dirty_baseline"
  | "generation_mismatch"
  | "fenced"
  | "policy_mismatch"
  | "root_mismatch"
  | "already"
  | "expired"
  | "conflict";

export type AdmissionDecision =
  | { state: "prepared"; preflight_id: string }
  | { state: "admitted" }
  | { state: "denied"; reason: AdmissionReason };

// --------------------------------------------------------- enrollment anchor

export interface EnrollmentAnchor {
  schema: 1;
  policy_digest: string;
  key_commitment: string;
  mode: BillingMode;
  epoch: number;
  root_nonce: string;
  baseline_digest: string;
  roster_digest: string;
  accounts: Array<{
    account_id: string;
    config_digest: string;
    baseline_digest: string;
  }>;
}

const ANCHOR_ACCOUNT_KEYS = ["account_id", "config_digest", "baseline_digest"] as const;
const ANCHOR_KEYS = [
  "schema",
  "policy_digest",
  "key_commitment",
  "mode",
  "epoch",
  "root_nonce",
  "baseline_digest",
  "roster_digest",
  "accounts",
] as const;

export function validateEnrollmentAnchor(input: unknown): EnrollmentAnchor {
  if (!isPlainObject(input)) invalid("A billing enrollment anchor is required.");
  assertExactKeys(input, ANCHOR_KEYS);
  if (input.schema !== 1) invalid("The billing enrollment anchor schema is unsupported.");
  if (!isHex64(input.policy_digest)) invalid("The enrollment policy digest is invalid.");
  if (!isHex64(input.key_commitment)) invalid("The enrollment key commitment is invalid.");
  if (input.mode !== "sandbox" && input.mode !== "live")
    invalid("The enrollment mode is invalid.");
  if (!isSafeInt(input.epoch, 1)) invalid("The enrollment epoch is invalid.");
  if (!isHex64(input.root_nonce)) invalid("The enrollment nonce is invalid.");
  if (!isHex64(input.baseline_digest)) invalid("The enrollment baseline digest is invalid.");
  if (!isHex64(input.roster_digest)) invalid("The enrollment roster digest is invalid.");
  if (!Array.isArray(input.accounts)) invalid("The enrollment roster must be an array.");
  const accounts = input.accounts.map((entry) => {
    if (!isPlainObject(entry)) invalid("An enrollment roster entry is required.");
    assertExactKeys(entry, ANCHOR_ACCOUNT_KEYS);
    if (!isUuid(entry.account_id)) invalid("An enrollment roster account is invalid.");
    if (!isHex64(entry.config_digest)) invalid("An enrollment roster config digest is invalid.");
    if (!isHex64(entry.baseline_digest)) invalid("An enrollment roster baseline digest is invalid.");
    return {
      account_id: entry.account_id as string,
      config_digest: entry.config_digest as string,
      baseline_digest: entry.baseline_digest as string,
    };
  });
  return {
    schema: 1,
    policy_digest: input.policy_digest as string,
    key_commitment: input.key_commitment as string,
    mode: input.mode as BillingMode,
    epoch: input.epoch as number,
    root_nonce: input.root_nonce as string,
    baseline_digest: input.baseline_digest as string,
    roster_digest: input.roster_digest as string,
    accounts,
  };
}

export function enrollmentAnchorDigest(anchor: EnrollmentAnchor): string {
  return sha(validateEnrollmentAnchor(anchor));
}
