import { createHash } from "node:crypto";
import { z } from "zod";
import { BrainError, canonical } from "./logic.ts";

/**
 * Pure vocabulary for the shared managed provider activation policy.
 *
 * This module has no persistence, transport or authorization concerns. It bounds
 * operator configuration, derives a provider-only configuration digest and a
 * non-circular enrollment fingerprint, and validates one strict operator input.
 * Nothing here reads a provider key, a filesystem path or the control database,
 * and no helper trusts a caller-supplied digest to grant authority.
 */

export const ACTIVATION_SCHEMA_VERSION = 1;
export const ACTIVATION_ENDPOINT_CLASS = "openai_responses";
export const ACTIVATION_MAX_OUTPUT_TOKENS = 8000;
export const ACTIVATION_MAX_ACCEPTED_MODELS = 16;

/** Content-free reasons an activation policy is not usable. */
export type ActivationReason =
  | "ready"
  | "off"
  | "epoch_uninitialized"
  | "epoch_mismatch"
  | "profile_invalid"
  | "audit_stale"
  | "worker_absent"
  | "worker_stale"
  | "worker_config_mismatch"
  | "policy_unconfigured"
  | "key_missing"
  | "durable_block";

/**
 * One persisted operator activation profile. The provider is fixed and the
 * price/model set is concrete; there is no arbitrary endpoint, wildcard model or
 * inferred price here. `config_digest` hashes only provider parameters; the
 * fingerprint binds everything except itself.
 */
export interface ActivationProfile {
  schema: 1;
  version: number;
  enabled: boolean;
  provider: "openai";
  model: string;
  price_version: string;
  input_micro_usd_per_million: number;
  output_micro_usd_per_million: number;
  accepted_response_models: string[];
  max_output_tokens: number;
  endpoint_class: "openai_responses";
  config_digest: string;
  audit_digest: string;
  audit_id: string;
  epoch: number;
  root_nonce: string;
  fingerprint: string;
  updated_at: string;
}

/**
 * The lifecycle point a guard is evaluated at. It is deliberately DISTINCT from
 * `stage` (which is the dispatch stage such as `reasoning`).
 */
export type SendGuardPhase =
  | "before_reserve"
  | "after_reserve"
  | "before_mark"
  | "after_mark";

/**
 * A precomputed, non-secret frozen-policy binding for one paid attempt. It is
 * derived only from a trusted installed policy plus the current lease/spec; the
 * storage seam rechecks it inside its own transaction and it never grants
 * authority on its own.
 *
 * `before_reserve` carries null attempt ids and permits NO nonterminal tolerance.
 * `after_reserve`/`before_mark`/`after_mark` carry the exact central AND tenant
 * call ids of THIS attempt.
 */
/**
 * The closed purpose a decision guard is bound to. It is a single fixed
 * goal-relevance question on a running changed-assumption review; it is not a
 * general provider registry and carries no model output.
 */
export const DECISION_GUARD_PURPOSE = "goal_relevance";
export const DECISION_GUARD_JOB_KIND = "review_changed_assumption";

/**
 * Fields shared by every stage guard. They are the immutable frozen-policy
 * binding plus the exact current attempt slot; none of them is authority on its
 * own.
 */
export interface SendGuardCommon {
  phase: SendGuardPhase;
  account_id: string;
  job_id: string;
  dispatch_key: string;
  lease_owner: string;
  lease_fence: number;
  lease_expires_at: string;
  model: string;
  price_version: string;
  request_hash: string;
  config_hash: string;
  reserved_micro_usd: number;
  profile_version: number;
  fingerprint: string;
  config_digest: string;
  epoch: number;
  root_nonce: string;
  schema_version: number;
  schema_digest: string;
  audit_id: string;
  audit_digest: string;
  expected_prepared_config_hash: string;
  central_inventory_digest: string;
  central_call_id: string | null;
  tenant_call_id: string | null;
}

/** The unchanged reasoning-stage binding over the OpenAI Responses profile. */
export interface ReasoningActivationGuard extends SendGuardCommon {
  stage: "reasoning";
  provider: "openai";
}

/** The separate decision-stage binding over the closed official transport. */
export interface DecisionActivationGuard extends SendGuardCommon {
  stage: "decision";
  provider: "typesafe" | "cloudflare";
  purpose: typeof DECISION_GUARD_PURPOSE;
  job_kind: typeof DECISION_GUARD_JOB_KIND;
}

/**
 * A precomputed, non-secret frozen-policy binding for one paid attempt. It is
 * derived only from a trusted installed policy plus the current lease/spec; the
 * storage seam rechecks it inside its own transaction and it never grants
 * authority on its own. The stage is a closed discriminant: an OpenAI reasoning
 * profile can never present itself as a decision guard, and a coincident hash
 * cannot cross stages.
 *
 * `before_reserve` carries null attempt ids and permits NO nonterminal tolerance.
 * `after_reserve`/`before_mark`/`after_mark` carry the exact central AND tenant
 * call ids of THIS attempt.
 */
export type ActivationGuard = ReasoningActivationGuard | DecisionActivationGuard;

const HEX = /^[0-9a-f]{64}$/;
const MAX_INT = Number.MAX_SAFE_INTEGER;
const guardCommonSchema = {
  phase: z.enum(["before_reserve", "after_reserve", "before_mark", "after_mark"]),
  account_id: z.string().uuid(),
  job_id: z.string().min(1).max(200),
  dispatch_key: z.string().min(1).max(200),
  lease_owner: z.string().min(1).max(200),
  lease_fence: z.number().int().min(0).max(MAX_INT),
  lease_expires_at: z.string().datetime({ offset: true }),
  model: z.string().min(1).max(100),
  price_version: z.string().min(1).max(64),
  request_hash: z.string().regex(HEX),
  config_hash: z.string().regex(HEX),
  reserved_micro_usd: z.number().int().min(0).max(MAX_INT),
  profile_version: z.number().int().min(1).max(MAX_INT),
  fingerprint: z.string().regex(HEX),
  config_digest: z.string().regex(HEX),
  epoch: z.number().int().min(1).max(MAX_INT),
  root_nonce: z.string().regex(HEX),
  schema_version: z.number().int().min(1).max(MAX_INT),
  schema_digest: z.string().regex(HEX),
  audit_id: z.string().uuid(),
  audit_digest: z.string().regex(HEX),
  expected_prepared_config_hash: z.string().regex(HEX),
  central_inventory_digest: z.string().regex(HEX),
  central_call_id: z.string().uuid().nullable(),
  tenant_call_id: z.string().min(1).max(200).nullable(),
};
const reasoningGuardSchema = z
  .object({ ...guardCommonSchema, stage: z.literal("reasoning"), provider: z.literal("openai") })
  .strict();
const decisionGuardSchema = z
  .object({
    ...guardCommonSchema,
    stage: z.literal("decision"),
    // The provider stays a closed literal union; a malformed/unknown value denies
    // rather than being widened to an arbitrary string.
    provider: z.enum(["typesafe", "cloudflare"]),
    purpose: z.literal(DECISION_GUARD_PURPOSE),
    job_kind: z.literal(DECISION_GUARD_JOB_KIND),
  })
  .strict();
const guardSchema = z.discriminatedUnion("stage", [
  reasoningGuardSchema,
  decisionGuardSchema,
]);

/** Strict, closed validation of one derived guard. It never authorizes; it only
 * rejects a malformed/caller-shaped object. A repair stage, a loosened provider
 * or a cross-stage relabel denies. */
export function validateActivationGuard(input: unknown): ActivationGuard {
  const parsed = guardSchema.safeParse(input);
  if (!parsed.success) throw invalid("Invalid activation guard.");
  return parsed.data;
}

/** Closed validation narrowed to the reasoning stage discriminant. */
export function validateReasoningActivationGuard(input: unknown): ReasoningActivationGuard {
  const parsed = guardSchema.safeParse(input);
  if (!parsed.success || parsed.data.stage !== "reasoning")
    throw invalid("Invalid activation guard.");
  return parsed.data;
}

/** Closed validation narrowed to the decision stage discriminant. */
export function validateDecisionActivationGuard(input: unknown): DecisionActivationGuard {
  const parsed = guardSchema.safeParse(input);
  if (!parsed.success || parsed.data.stage !== "decision")
    throw invalid("Invalid activation guard.");
  return parsed.data;
}

export interface GuardLive {
  fingerprint: string;
  version: number;
  config_digest: string;
  epoch: number;
  root_nonce: string;
  schema_version: number;
  schema_digest: string;
  audit_digest: string;
  central_inventory_digest: string;
  call_config_hash?: string;
}

/**
 * Pure compare of one derived guard to live security fields. It is the only
 * authority decision the guard makes, and it is a closed field comparison — never
 * a caller-supplied callback.
 */
export function guardMatchesLive(guard: ActivationGuard, live: GuardLive): void {
  const ok =
    live.fingerprint === guard.fingerprint &&
    live.version === guard.profile_version &&
    live.config_digest === guard.config_digest &&
    live.epoch === guard.epoch &&
    live.root_nonce === guard.root_nonce &&
    live.schema_version === guard.schema_version &&
    live.schema_digest === guard.schema_digest &&
    live.audit_digest === guard.audit_digest &&
    live.central_inventory_digest === guard.central_inventory_digest &&
    (live.call_config_hash === undefined ||
      live.call_config_hash === guard.expected_prepared_config_hash);
  if (!ok)
    throw new BrainError(
      "BUDGET_BLOCKED",
      "Managed paid processing is not enabled for this call.",
      409,
    );
}

/** Strict, closed operator configuration for one activation enrollment. */
export interface ActivationOperatorInput {
  provider: "openai";
  model: string;
  price_version: string;
  input_micro_usd_per_million: number;
  output_micro_usd_per_million: number;
  accepted_response_models: string[];
  max_output_tokens: number;
  endpoint_class: "openai_responses";
  audit_id: string;
  expected_version: number;
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const sha = (value: unknown): string =>
    createHash("sha256").update(canonical(value)).digest("hex");

const invalid = (message: string) => new BrainError("INVALID_INPUT", message, 400);

const tokenSchema = (field: string, max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => !CONTROL_CHARS.test(value), `Invalid ${field}.`);

const acceptedModelsSchema = z
  .array(tokenSchema("accepted_response_model", 200))
  .min(1)
  .max(ACTIVATION_MAX_ACCEPTED_MODELS)
  .refine(
    (models) => new Set(models).size === models.length,
    "Accepted returned model identifiers must be distinct.",
  );

/**
 * Provider-only configuration digest. It deliberately excludes the audit,
 * epoch, version, timestamps, `enabled` and the fingerprint, so enabling or
 * re-auditing a profile never changes how the provider is configured.
 */
export function profileConfigDigest(p: ActivationProfile): string {
  return sha({
    provider: p.provider,
    model: p.model,
    price_version: p.price_version,
    input_micro_usd_per_million: p.input_micro_usd_per_million,
    output_micro_usd_per_million: p.output_micro_usd_per_million,
    accepted_response_models: [...p.accepted_response_models].sort(),
    max_output_tokens: p.max_output_tokens,
    endpoint_class: p.endpoint_class,
  });
}

/**
 * Non-circular enrollment fingerprint: the canonical projection of every field
 * except `fingerprint` and any secret. Changing the audit, epoch, version or
 * timestamp changes it; recomputing over the same value is stable.
 */
export function activationFingerprint(p: ActivationProfile): string {
  return sha({
    schema: p.schema,
    version: p.version,
    enabled: p.enabled,
    provider: p.provider,
    model: p.model,
    price_version: p.price_version,
    input_micro_usd_per_million: p.input_micro_usd_per_million,
    output_micro_usd_per_million: p.output_micro_usd_per_million,
    accepted_response_models: [...p.accepted_response_models].sort(),
    max_output_tokens: p.max_output_tokens,
    endpoint_class: p.endpoint_class,
    config_digest: p.config_digest,
    audit_digest: p.audit_digest,
    audit_id: p.audit_id,
    epoch: p.epoch,
    root_nonce: p.root_nonce,
    updated_at: p.updated_at,
  });
}

const profileSchema = z
  .object({
    schema: z.literal(ACTIVATION_SCHEMA_VERSION),
    version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    enabled: z.boolean(),
    provider: z.literal("openai"),
    model: tokenSchema("model", 100),
    price_version: tokenSchema("price_version", 64),
    input_micro_usd_per_million: z
      .number()
      .int()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER),
    output_micro_usd_per_million: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER),
    accepted_response_models: acceptedModelsSchema,
    max_output_tokens: z
      .number()
      .int()
      .min(1)
      .max(ACTIVATION_MAX_OUTPUT_TOKENS),
    endpoint_class: z.literal(ACTIVATION_ENDPOINT_CLASS),
    config_digest: z.string().regex(HEX),
    audit_digest: z.string().regex(HEX),
    audit_id: z.string().uuid(),
    epoch: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    root_nonce: z.string().regex(HEX),
    fingerprint: z.string().regex(HEX),
    updated_at: z.string().datetime({ offset: true }),
  })
  .strict();

/**
 * Strict validation that RECOMPUTES both digests instead of trusting the input.
 * A profile whose supplied `config_digest` or `fingerprint` does not match its
 * own parameters, or that carries unknown/unsafe fields, is rejected.
 */
export function validateActivationProfile(input: unknown): ActivationProfile {
  const parsed = profileSchema.safeParse(input);
  if (!parsed.success) throw invalid("Invalid activation profile.");
  const value = parsed.data;
  const profile: ActivationProfile = {
    ...value,
    updated_at: new Date(value.updated_at).toISOString(),
  };
  if (profileConfigDigest(profile) !== profile.config_digest)
    throw invalid("Invalid activation profile configuration digest.");
  if (activationFingerprint(profile) !== profile.fingerprint)
    throw invalid("Invalid activation profile fingerprint.");
  return profile;
}

const operatorSchema = z
  .object({
    provider: z.literal("openai"),
    model: tokenSchema("model", 100),
    price_version: tokenSchema("price_version", 64),
    input_micro_usd_per_million: z
      .number()
      .int()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER),
    output_micro_usd_per_million: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER),
    accepted_response_models: acceptedModelsSchema,
    max_output_tokens: z
      .number()
      .int()
      .min(1)
      .max(ACTIVATION_MAX_OUTPUT_TOKENS),
    endpoint_class: z.literal(ACTIVATION_ENDPOINT_CLASS),
    audit_id: z.string().uuid(),
    expected_version: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

/**
 * Strict, closed operator input. It carries provider parameters and the chosen
 * audit id only; it can never name `enabled`, an epoch, a digest or a
 * fingerprint, so a browser or a corrupted file cannot grant activation
 * authority. The accepted returned-model set must include the requested model.
 */
export function validateActivationOperatorInput(
  input: unknown,
): ActivationOperatorInput {
  const parsed = operatorSchema.safeParse(input);
  if (!parsed.success) throw invalid("Invalid activation operator input.");
  const value = parsed.data;
  if (!value.accepted_response_models.includes(value.model))
    throw invalid(
      "Accepted returned model identifiers must include the requested model.",
    );
  return value;
}
