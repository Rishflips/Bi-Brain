import { createHmac, timingSafeEqual } from "node:crypto";
import { canonical } from "./logic.ts";
import { maxMicroUsd } from "./spend.ts";
import {
  BILLING_FRESHNESS_MAX_MS,
  BILLING_MAX_FRAME_BYTES,
  BILLING_MAX_SOURCE_IDS,
  assertExactKeys,
  invalid,
  isHex64,
  isPlainObject,
  isSafeInt,
  isToken,
  isUuid,
  parseCanonicalUtc,
} from "./billing-authority.ts";

/**
 * Pure closed seal-frame contract for the B0 authority log.
 *
 * It defines a discriminated, purpose-specific, closed body and the HMAC helpers over
 * the canonical UTF-8 frame. HMAC integrity is deliberately NOT authority: a valid MAC
 * proves only that the frame was produced with the key. It never grants a power,
 * budgets money, or proves freshness. The caller owns the key and the transaction
 * boundary; this module performs no IO, generates no key and reads no clock.
 */

export type SealPurpose = "grant" | "admission" | "revocation" | "freshness";

export interface SealBase {
  schema: 1;
  purpose: SealPurpose;
  epoch: number;
  root_nonce: string;
  policy_id: string;
  source_ids: string[];
  ordinal: number;
  prev_mac: string;
}

export interface AdmissionSealBody {
  account_id: string;
  identity_digest: string;
  tenant_incarnation: string;
  clean_baseline_proof: string;
}

export interface GrantSealBody {
  account_id: string;
  window_id: string;
  term_id: string;
  period_id: string;
  window_start: string;
  window_end: string;
  allowance_micro_usd: number;
}

export interface RevocationSealBody {
  account_id: string;
  term_id: string;
  adverse_generation: number;
  reason: "past_due" | "canceled" | "refunded" | "conflict" | "suspended" | "policy_mismatch";
}

export interface FreshnessSealBody {
  account_id: string;
  term_id: string;
  verified_at: string;
  expires_at: string;
  revision: number;
  adverse_generation: number;
}

export type SealFrame =
  | (SealBase & { purpose: "grant"; body: GrantSealBody })
  | (SealBase & { purpose: "admission"; body: AdmissionSealBody })
  | (SealBase & { purpose: "revocation"; body: RevocationSealBody })
  | (SealBase & { purpose: "freshness"; body: FreshnessSealBody });

const PURPOSES: readonly SealPurpose[] = ["grant", "admission", "revocation", "freshness"];
const FRAME_KEYS = [
  "schema",
  "purpose",
  "epoch",
  "root_nonce",
  "policy_id",
  "source_ids",
  "ordinal",
  "prev_mac",
  "body",
] as const;
const BODY_KEYS: Record<SealPurpose, readonly string[]> = {
  grant: ["account_id", "window_id", "term_id", "period_id", "window_start", "window_end", "allowance_micro_usd"],
  admission: ["account_id", "identity_digest", "tenant_incarnation", "clean_baseline_proof"],
  revocation: ["account_id", "term_id", "adverse_generation", "reason"],
  freshness: ["account_id", "term_id", "verified_at", "expires_at", "revision", "adverse_generation"],
};
const REVOCATION_REASONS = ["past_due", "canceled", "refunded", "conflict", "suspended", "policy_mismatch"];

/**
 * Dense, data-only source array snapshot. It never iterates a caller-provided
 * iterator: it bounds `.length` first, requires an ordinary dense array with no
 * surplus own key or symbol, reads each index through its own DATA descriptor, and
 * returns the owned validated values used for the whole rest of the operation. This
 * makes a custom `Symbol.iterator` (or a getter index) unable to yield a valid value
 * during validation and a different value during serialization.
 */
function sourcesSnapshot(value: unknown): string[] {
  if (!Array.isArray(value)) invalid();
  const length = value.length;
  if (!Number.isSafeInteger(length) || length < 1 || length > BILLING_MAX_SOURCE_IDS) invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1) invalid();
  const allowed = new Set<string>(["length"]);
  for (let index = 0; index < length; index += 1) allowed.add(String(index));
  for (const key of keys) if (typeof key !== "string" || !allowed.has(key)) invalid();
  const snapshot: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) invalid();
    const entry = descriptor.value;
    if (!isToken(entry)) invalid();
    if (seen.has(entry)) invalid();
    seen.add(entry);
    snapshot.push(entry);
  }
  return snapshot;
}

type SealBody = GrantSealBody | AdmissionSealBody | RevocationSealBody | FreshnessSealBody;

/**
 * Validate one closed body and return an OWNED snapshot. The snapshot is what gets
 * validated further and serialized, so a caller-owned accessor can never return one
 * value during validation and another during serialization (no TOCTOU).
 */
function bodySnapshot(purpose: SealPurpose, body: unknown): SealBody {
  if (!isPlainObject(body)) invalid();
  assertExactKeys(body, BODY_KEYS[purpose]);
  if (!isUuid(body.account_id)) invalid();
  if (purpose === "grant") {
    if (!isHex64(body.window_id)) invalid();
    if (!isToken(body.term_id)) invalid();
    if (!isUuid(body.period_id)) invalid();
    const start = parseCanonicalUtc(body.window_start);
    const end = parseCanonicalUtc(body.window_end);
    if (start.getTime() >= end.getTime()) invalid();
    if (!isSafeInt(body.allowance_micro_usd, 0, maxMicroUsd)) invalid();
    return {
      account_id: body.account_id as string,
      window_id: body.window_id as string,
      term_id: body.term_id as string,
      period_id: body.period_id as string,
      window_start: start.toISOString(),
      window_end: end.toISOString(),
      allowance_micro_usd: body.allowance_micro_usd as number,
    };
  }
  if (purpose === "admission") {
    if (!isHex64(body.identity_digest)) invalid();
    if (!isHex64(body.tenant_incarnation)) invalid();
    if (!isHex64(body.clean_baseline_proof)) invalid();
    return {
      account_id: body.account_id as string,
      identity_digest: body.identity_digest as string,
      tenant_incarnation: body.tenant_incarnation as string,
      clean_baseline_proof: body.clean_baseline_proof as string,
    };
  }
  if (purpose === "revocation") {
    if (!isToken(body.term_id)) invalid();
    if (!isSafeInt(body.adverse_generation, 1)) invalid();
    if (typeof body.reason !== "string" || !REVOCATION_REASONS.includes(body.reason)) invalid();
    return {
      account_id: body.account_id as string,
      term_id: body.term_id as string,
      adverse_generation: body.adverse_generation as number,
      reason: body.reason as RevocationSealBody["reason"],
    };
  }
  if (!isToken(body.term_id)) invalid();
  const verified = parseCanonicalUtc(body.verified_at);
  const expires = parseCanonicalUtc(body.expires_at);
  if (!isSafeInt(body.revision, 1)) invalid();
  if (!isSafeInt(body.adverse_generation, 0)) invalid();
  const span = expires.getTime() - verified.getTime();
  if (span <= 0 || span > BILLING_FRESHNESS_MAX_MS) invalid();
  return {
    account_id: body.account_id as string,
    term_id: body.term_id as string,
    verified_at: verified.toISOString(),
    expires_at: expires.toISOString(),
    revision: body.revision as number,
    adverse_generation: body.adverse_generation as number,
  };
}

/** Closed validation of the whole frame. Unknown keys anywhere are rejected. */
function validateSealFrame(frame: unknown): SealFrame {
  if (!isPlainObject(frame)) invalid();
  assertExactKeys(frame, FRAME_KEYS);
  if (frame.schema !== 1) invalid();
  if (typeof frame.purpose !== "string" || !PURPOSES.includes(frame.purpose as SealPurpose)) invalid();
  const purpose = frame.purpose as SealPurpose;
  if (!isSafeInt(frame.epoch, 1)) invalid();
  if (!isHex64(frame.root_nonce)) invalid();
  if (!isToken(frame.policy_id)) invalid();
  const sourceIds = sourcesSnapshot(frame.source_ids);
  if (!isSafeInt(frame.ordinal, 0)) invalid();
  if (frame.ordinal === 0) {
    if (frame.prev_mac !== "") invalid();
  } else if (!isHex64(frame.prev_mac)) {
    invalid();
  }
  // Build an owned snapshot so canonicalization and MAC never re-read caller state.
  return {
    schema: 1,
    purpose,
    epoch: frame.epoch as number,
    root_nonce: frame.root_nonce as string,
    policy_id: frame.policy_id as string,
    source_ids: sourceIds,
    ordinal: frame.ordinal as number,
    prev_mac: frame.prev_mac as string,
    body: bodySnapshot(purpose, frame.body),
  } as unknown as SealFrame;
}

/**
 * Canonical, closed serialization of a validated frame. Invalid frames throw a
 * static `BrainError` (`INVALID_INPUT`); nothing is coerced or normalized.
 */
export function canonicalSealFrame(frame: unknown): string {
  const validated = validateSealFrame(frame);
  const text = canonical(validated);
  if (Buffer.byteLength(text, "utf8") > BILLING_MAX_FRAME_BYTES) invalid();
  return text;
}

function assertKey(privateBytes: unknown): Uint8Array {
  if (!(privateBytes instanceof Uint8Array) || privateBytes.length !== 32) invalid();
  return privateBytes;
}

/** HMAC-SHA256 over the canonical frame. The key is never mutated. */
export function sealMac(frame: unknown, privateBytes: Uint8Array): string {
  const key = assertKey(privateBytes);
  const text = canonicalSealFrame(frame);
  return createHmac("sha256", Buffer.from(key)).update(text, "utf8").digest("hex");
}

/**
 * Fail-closed verification: any malformed frame, key or MAC returns `false` and never
 * throws. Comparison is length-safe and constant-time over 32 decoded bytes.
 */
export function verifySealMac(
  frame: unknown,
  privateBytes: Uint8Array,
  mac: unknown,
): boolean {
  try {
    if (!(privateBytes instanceof Uint8Array) || privateBytes.length !== 32) return false;
    if (typeof mac !== "string" || !/^[0-9a-f]{64}$/.test(mac)) return false;
    const expected = sealMac(frame, privateBytes);
    const a = Buffer.from(expected, "hex");
    const b = Buffer.from(mac, "hex");
    if (a.length !== 32 || b.length !== 32) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
