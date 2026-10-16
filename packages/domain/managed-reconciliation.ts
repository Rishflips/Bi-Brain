import { createHash } from "node:crypto";
import { z } from "zod";
import { BrainError, canonical } from "./logic.ts";

/**
 * Pure vocabulary and validation for operator-attested reconciliation.
 *
 * There is no cryptographic provider verification here: an operator records an
 * externally checked amount bound to one exact dispatch identity. Everything in
 * this module is untrusted input until it is validated, and nothing here grants
 * authority, contacts a network or stores a free-form proof body.
 */

export const managedAttestMethods = [
  "usage_response",
  "call_statement",
] as const;
export type ManagedAttestMethod = (typeof managedAttestMethods)[number];

export const managedResolutionKinds = ["settled", "zero", "dispute"] as const;
export type ManagedResolutionKind = (typeof managedResolutionKinds)[number];

/** Strict, closed operator attestation. Unknown or missing fields are rejected. */
export interface AttestationInput {
  resolution_id: string;
  kind: "settled" | "zero";
  account_id: string;
  call_id: string;
  identity_hash: string;
  provider: string;
  model: string;
  price_version: string;
  request_hash: string;
  config_hash: string;
  expected_state: "dispatched" | "settled";
  expected_actual_micro_usd: number | null;
  cost_micro_usd: number;
  /** Micro-USD integer denomination in USD; any other currency is denied. */
  currency: "USD";
  provider_request_id: string;
  evidence_digest: string;
  method: ManagedAttestMethod;
  /** Opaque, bounded actor metadata; no free-form proof text. */
  actor: string;
  checked_at: string;
  epoch: number;
}

/** Immutable persisted resolution proof. */
export interface ManagedResolution {
  resolution_id: string;
  kind: ManagedResolutionKind;
  account_id: string;
  call_id: string;
  method: ManagedAttestMethod;
  evidence_digest: string;
  binding_digest: string;
  cost_micro_usd: number;
  currency: "USD";
  provider_request_id: string;
  actor: string;
  checked_at: string;
  epoch: number;
  decided_at: string;
}

/**
 * A guarded offline mutation precondition. Both fields must be literally true;
 * there is no default. The operator asserts that writers were stopped, which is
 * a precondition, not a programmatic quiescence proof.
 */
export interface ManagedAttestOptions {
  offline: true;
  workers_terminated: true;
}

export interface ControlEpoch {
  epoch: number;
  nonce: string;
  rotated_at: string;
}

const HEX = /^[0-9a-f]{64}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const invalid = (message: string) => new BrainError("INVALID_INPUT", message, 400);

const attestationSchema = z
  .object({
    resolution_id: z.string().regex(UUID),
    kind: z.enum(["settled", "zero"]),
    account_id: z.string().regex(UUID),
    call_id: z.string().regex(UUID),
    identity_hash: z.string().regex(HEX),
    provider: z.string().min(1).max(200),
    model: z.string().min(1).max(200),
    price_version: z.string().min(1).max(200),
    request_hash: z.string().regex(HEX),
    config_hash: z.string().regex(HEX),
    expected_state: z.enum(["dispatched", "settled"]),
    expected_actual_micro_usd: z.number().nullable(),
    cost_micro_usd: z.number(),
    currency: z.literal("USD"),
    // Exact external correlation: a bounded identifier with no whitespace or
    // control characters, never trimmed (which could alias two different ids).
    provider_request_id: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:/+=-]{0,199}$/),
    evidence_digest: z.string().regex(HEX),
    method: z.enum(managedAttestMethods),
    // Bounded opaque actor id, never free-form or multiline proof text.
    actor: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,119}$/),
    checked_at: z.string().datetime({ offset: true }),
    epoch: z.number().int().min(1),
  })
  .strict();

/**
 * Validates one closed operator attestation. Requires an explicit USD currency,
 * a safe-integer cost, a canonical UTC `checked_at` with an explicit zone, and a
 * strict expected state/actual CAS shape. `kind:"settled"` must carry a positive
 * cost; `kind:"zero"` must carry an exact explicit 0. Missing input is never
 * treated as 0 or as USD.
 */
export function validateAttestation(input: unknown): AttestationInput {
  const parsed = attestationSchema.safeParse(input);
  if (!parsed.success) throw invalid("Invalid operator attestation.");
  const value = parsed.data;
  if (!Number.isSafeInteger(value.cost_micro_usd) || value.cost_micro_usd < 0)
    throw invalid("Invalid operator attestation cost.");
  if (
    value.expected_actual_micro_usd !== null &&
    (!Number.isSafeInteger(value.expected_actual_micro_usd) ||
      value.expected_actual_micro_usd < 0)
  )
    throw invalid("Invalid expected managed actual.");
  if (
    value.expected_state === "dispatched" &&
    value.expected_actual_micro_usd !== null
  )
    throw invalid("A dispatched managed call has no actual amount.");
  if (
    value.expected_state === "settled" &&
    value.expected_actual_micro_usd === null
  )
    throw invalid("A settled managed call must name its expected actual.");
  if (value.kind === "settled" && value.cost_micro_usd <= 0)
    throw invalid("A settled attestation requires a positive cost.");
  if (value.kind === "zero" && value.cost_micro_usd !== 0)
    throw invalid("A zero attestation must carry an explicit zero cost.");
  return {
    ...value,
    checked_at: new Date(value.checked_at).toISOString(),
  };
}

const optionsSchema = z
  .object({
    offline: z.literal(true),
    workers_terminated: z.literal(true),
  })
  .strict();

/**
 * Requires the explicit offline acknowledgement at the store boundary as well as
 * the CLI. A missing or false acknowledgement denies before any money change.
 */
export function validateAttestOptions(input: unknown): ManagedAttestOptions {
  const parsed = optionsSchema.safeParse(input);
  if (!parsed.success)
    throw new BrainError(
      "BUDGET_BLOCKED",
      "Operator reconciliation requires an explicit offline acknowledgement that all managed workers are terminated.",
      409,
    );
  return parsed.data;
}

/**
 * Canonical digest of every immutable field of one attestation. It binds the
 * call identity, pricing/request/config hashes, expected state/actual, cost,
 * currency, method, evidence, correlation, actor, time and epoch.
 */
export function attestationBindingDigest(input: AttestationInput): string {
  return createHash("sha256")
    .update(
      canonical({
        resolution_id: input.resolution_id,
        kind: input.kind,
        account_id: input.account_id,
        call_id: input.call_id,
        identity_hash: input.identity_hash,
        provider: input.provider,
        model: input.model,
        price_version: input.price_version,
        request_hash: input.request_hash,
        config_hash: input.config_hash,
        expected_state: input.expected_state,
        expected_actual_micro_usd: input.expected_actual_micro_usd,
        cost_micro_usd: input.cost_micro_usd,
        currency: input.currency,
        provider_request_id: input.provider_request_id,
        evidence_digest: input.evidence_digest,
        method: input.method,
        actor: input.actor,
        checked_at: input.checked_at,
        epoch: input.epoch,
      }),
    )
    .digest("hex");
}
