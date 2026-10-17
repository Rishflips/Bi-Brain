import { createHash } from "node:crypto";
import { z } from "zod";
import { BrainError, canonical } from "./logic.ts";

/**
 * Pure vocabulary for the separate, default-off decision activation profile.
 *
 * It mirrors the reasoning activation module's shape but is OpenAI-free: the
 * provider is a closed `typesafe`/`cloudflare` family over the existing official
 * allowlisted transport, the endpoint is stored canonically (and as a non-secret
 * digest), and output pricing must be zero. No key/secret is ever part of this
 * module or the profile.
 */

export const DECISION_ACTIVATION_SCHEMA_VERSION = 1;
export const DECISION_POLICY_VERSION = "system-one-choice-v1";
export const DECISION_REQUEST_OVERHEAD_BYTES = 1024;
export const DECISION_MAX_TIMEOUT_MS = 120_000;
export const DECISION_MAX_BODY_BYTES = 33_554_432;

export type DecisionProviderKind = "typesafe" | "cloudflare";

export interface DecisionActivationProfile {
  schema: 1;
  version: number;
  enabled: boolean;
  provider: DecisionProviderKind;
  model: string;
  accepted_response_models: string[];
  endpoint: string;
  endpoint_digest: string;
  price_version: string;
  input_micro_usd_per_million: number;
  output_micro_usd_per_million: number;
  timeout_ms: number;
  max_request_bytes: number;
  max_response_bytes: number;
  request_overhead_bytes: number;
  config_digest: string;
  audit_digest: string;
  audit_id: string;
  epoch: number;
  root_nonce: string;
  fingerprint: string;
  updated_at: string;
}

export interface DecisionOperatorInput {
  provider: DecisionProviderKind;
  model: string;
  accepted_response_models: string[];
  endpoint: string;
  price_version: string;
  input_micro_usd_per_million: number;
  output_micro_usd_per_million: 0;
  timeout_ms: number;
  max_request_bytes: number;
  max_response_bytes: number;
  audit_id: string;
  expected_version: number;
}

const HEX = /^[0-9a-f]{64}$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const sha = (value: unknown): string =>
  createHash("sha256").update(canonical(value)).digest("hex");
const invalid = (message: string) => new BrainError("INVALID_INPUT", message, 400);

function token(max: number, field: string) {
  return z
    .string()
    .min(1)
    .max(max)
    .refine((value) => !CONTROL_CHARS.test(value), `Invalid ${field}.`)
    .refine((value) => value.trim().length > 0, `Invalid ${field}.`);
}

const acceptedSchema = z
  .array(token(200, "accepted_response_model"))
  .min(1)
  .max(16)
  .refine((models) => new Set(models).size === models.length, "distinct");

/** Canonical official endpoint + its non-secret digest; rejects credentials/query/loopback. */
export function canonicalDecisionEndpoint(
  provider: DecisionProviderKind,
  model: string,
  endpoint: string,
): { endpoint: string; endpoint_digest: string } {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw invalid("The decision endpoint must be an absolute URL.");
  }
  if (url.username || url.password) throw invalid("The decision endpoint must not contain credentials.");
  if (url.search) throw invalid("The decision endpoint must not contain query parameters.");
  if (url.hash) throw invalid("The decision endpoint must not contain a fragment.");
  if (url.protocol !== "https:") throw invalid("The decision endpoint must use HTTPS.");
  if (url.port !== "") throw invalid("The decision endpoint must use the default port.");
  if (provider === "typesafe") {
    if (url.hostname !== "api.typesafe.ai" || url.pathname !== "/v1/systemone")
      throw invalid("The TypeSafe decision endpoint must be https://api.typesafe.ai/v1/systemone.");
  } else {
    const selector =
      /^\/client\/v4\/accounts\/[^/]+\/ai\/run\/@cf\/cloudflare\/(clef|clef-flash)$/.exec(
        url.pathname,
      );
    if (url.hostname !== "api.cloudflare.com" || !selector)
      throw invalid("The Cloudflare decision endpoint must be an official Clef run endpoint.");
    if (selector[1] !== model)
      throw invalid("The Cloudflare endpoint selector must match the configured model.");
  }
  const canonicalUrl = `${url.protocol}//${url.hostname}${url.pathname}`;
  // Standard raw UTF-8 hash of the canonical URL (distinct from the object-canonical
  // digests used for the profile/config, which remain `sha(canonical(...))`).
  const endpoint_digest = createHash("sha256").update(canonicalUrl).digest("hex");
  return { endpoint: canonicalUrl, endpoint_digest };
}

/** Provider-parameter-only digest (distinct from the prepared adapter's config_hash). */
export function decisionProfileConfigDigest(p: DecisionActivationProfile): string {
  return sha({
    provider: p.provider,
    model: p.model,
    accepted_response_models: [...p.accepted_response_models].sort(),
    endpoint: p.endpoint,
    endpoint_digest: p.endpoint_digest,
    price_version: p.price_version,
    input_micro_usd_per_million: p.input_micro_usd_per_million,
    output_micro_usd_per_million: p.output_micro_usd_per_million,
    timeout_ms: p.timeout_ms,
    max_request_bytes: p.max_request_bytes,
    max_response_bytes: p.max_response_bytes,
    request_overhead_bytes: p.request_overhead_bytes,
    policy_version: DECISION_POLICY_VERSION,
  });
}

/** Non-circular fingerprint: every field except `fingerprint`. */
export function decisionActivationFingerprint(p: DecisionActivationProfile): string {
  return sha({
    schema: p.schema,
    version: p.version,
    enabled: p.enabled,
    provider: p.provider,
    model: p.model,
    // The fingerprint binds the FULL ORDERED accepted-model array (the prepared
    // config_hash preserves order), so a permutation changes the fingerprint.
    accepted_response_models: [...p.accepted_response_models],
    endpoint: p.endpoint,
    endpoint_digest: p.endpoint_digest,
    price_version: p.price_version,
    input_micro_usd_per_million: p.input_micro_usd_per_million,
    output_micro_usd_per_million: p.output_micro_usd_per_million,
    timeout_ms: p.timeout_ms,
    max_request_bytes: p.max_request_bytes,
    max_response_bytes: p.max_response_bytes,
    request_overhead_bytes: p.request_overhead_bytes,
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
    schema: z.literal(DECISION_ACTIVATION_SCHEMA_VERSION),
    version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    enabled: z.boolean(),
    provider: z.enum(["typesafe", "cloudflare"]),
    model: token(100, "model"),
    accepted_response_models: acceptedSchema,
    endpoint: z.string().min(8).max(2048),
    endpoint_digest: z.string().regex(HEX),
    price_version: token(64, "price_version"),
    input_micro_usd_per_million: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    output_micro_usd_per_million: z.literal(0),
    timeout_ms: z.number().int().min(1).max(DECISION_MAX_TIMEOUT_MS),
    max_request_bytes: z.number().int().min(64).max(DECISION_MAX_BODY_BYTES),
    max_response_bytes: z.number().int().min(64).max(DECISION_MAX_BODY_BYTES),
    request_overhead_bytes: z.literal(DECISION_REQUEST_OVERHEAD_BYTES),
    config_digest: z.string().regex(HEX),
    audit_digest: z.string().regex(HEX),
    audit_id: z.string().uuid(),
    epoch: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    root_nonce: z.string().regex(HEX),
    fingerprint: z.string().regex(HEX),
    updated_at: z.string().datetime({ offset: true }),
  })
  .strict();

export function validateDecisionActivationProfile(input: unknown): DecisionActivationProfile {
  const parsed = profileSchema.safeParse(input);
  if (!parsed.success) throw invalid("Invalid decision activation profile.");
  const profile: DecisionActivationProfile = {
    ...parsed.data,
    updated_at: new Date(parsed.data.updated_at).toISOString(),
  };
  if (profile.provider === "cloudflare" && !/^(clef|clef-flash)$/.test(profile.model))
    throw invalid("The Cloudflare decision model must be clef or clef-flash.");
  const expectedEndpoint = canonicalDecisionEndpoint(
    profile.provider,
    profile.model,
    profile.endpoint,
  );
  if (expectedEndpoint.endpoint_digest !== profile.endpoint_digest)
    throw invalid("Invalid decision endpoint digest.");
  // Profiles are exact and immutable: a recomputed hash must not launder a
  // non-canonical alias into the stored profile.
  if (expectedEndpoint.endpoint !== profile.endpoint)
    throw invalid("The decision endpoint must be the canonical allowlisted URL.");
  if (decisionProfileConfigDigest(profile) !== profile.config_digest)
    throw invalid("Invalid decision configuration digest.");
  if (decisionActivationFingerprint(profile) !== profile.fingerprint)
    throw invalid("Invalid decision activation fingerprint.");
  return profile;
}

const operatorSchema = z
  .object({
    provider: z.enum(["typesafe", "cloudflare"]),
    model: token(100, "model"),
    accepted_response_models: acceptedSchema,
    endpoint: z.string().min(8).max(2048),
    price_version: token(64, "price_version"),
    input_micro_usd_per_million: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    output_micro_usd_per_million: z.literal(0),
    timeout_ms: z.number().int().min(1).max(DECISION_MAX_TIMEOUT_MS),
    max_request_bytes: z.number().int().min(64).max(DECISION_MAX_BODY_BYTES),
    max_response_bytes: z.number().int().min(64).max(DECISION_MAX_BODY_BYTES),
    audit_id: z.string().uuid(),
    expected_version: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

export function validateDecisionOperatorInput(input: unknown): DecisionOperatorInput {
  const parsed = operatorSchema.safeParse(input);
  if (!parsed.success) throw invalid("Invalid decision operator input.");
  canonicalDecisionEndpoint(parsed.data.provider, parsed.data.model, parsed.data.endpoint);
  // Normalize to the canonical URL so an alias is never stored.
  return {
    ...parsed.data,
    endpoint: canonicalDecisionEndpoint(
      parsed.data.provider,
      parsed.data.model,
      parsed.data.endpoint,
    ).endpoint,
  };
}
