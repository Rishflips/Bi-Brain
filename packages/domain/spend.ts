import { createHash } from "node:crypto";
import { BrainError, canonical } from "./logic.ts";

/**
 * Pure accounting vocabulary and validation for per-dispatch paid spend.
 *
 * This module has no persistence, transport or authorization concerns. It only
 * bounds values, derives the immutable dispatch identity and computes the
 * accounting day. Storage applies these results inside short transactions.
 */

export const dispatchStages = ["decision", "reasoning", "repair"] as const;
export type DispatchStage = (typeof dispatchStages)[number];

export const dispatchStates = [
  "reserved",
  "dispatched",
  "settled",
  "released",
] as const;
export type DispatchState = (typeof dispatchStates)[number];

export const maxMicroUsd = Number.MAX_SAFE_INTEGER;

/** Immutable inputs for one logical dispatch slot on a job. */
export interface DispatchSpec {
  job_id: string;
  /** Stable logical slot, e.g. `decision` or `repair:2`. Not a network id. */
  dispatch_key: string;
  stage: DispatchStage;
  reserved_micro_usd: number;
  provider: string;
  model: string;
  price_version: string;
  /** SHA-256 (lowercase hex) of the request the provider would receive. */
  request_hash: string;
  /** SHA-256 (lowercase hex) of the config/context the call would send. */
  config_hash: string;
}

/** A currently held worker lease. The job row is the source of truth. */
export interface JobLease {
  job_id: string;
  owner: string;
  fence: number;
  expires_at: string;
}

/** Caller-supplied bounds for admission. Amounts are integer micro-USD. */
export interface SpendLimits {
  per_job_micro_usd: number;
  daily_micro_usd: number;
  time_zone: string;
}

/** Persisted dispatch record. No prompt or evidence bodies are ever stored. */
export interface DispatchRecord {
  call_id: string;
  job_id: string;
  dispatch_key: string;
  stage: DispatchStage;
  state: DispatchState;
  reserved_micro_usd: number;
  actual_micro_usd: number | null;
  provider: string;
  model: string;
  price_version: string;
  request_hash: string;
  config_hash: string;
  budget_day: string;
  time_zone: string;
  created_at: string;
  dispatched_at: string | null;
  settled_at: string | null;
}

/** Conservative, plain-language view of the current accounting window. */
export interface SpendSummary {
  time_zone: string | null;
  budget_day: string;
  per_job_limit_micro_usd: number;
  daily_limit_micro_usd: number;
  /** Settled actual for the budget day, including legacy rows. */
  settled_micro_usd: number;
  /** Unresolved holds from every day, including legacy rows. */
  unresolved_micro_usd: number;
  /** settled + unresolved. Unknown usage is counted, never shown as zero. */
  committed_micro_usd: number;
  remaining_micro_usd: number;
  /** True while a durable over-bound reconciliation block is set. */
  blocked: boolean;
  provider_dispatches: number;
  legacy_reservations: number;
}

const invalid = (message: string) => new BrainError("INVALID_INPUT", message, 400);

function boundedText(value: unknown, field: string, max = 200): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max)
    throw invalid(`Invalid ${field}.`);
  return value;
}

function sha256Hex(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value))
    throw invalid(`Invalid ${field}: expected a lowercase SHA-256 digest.`);
  return value;
}

function microUsd(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  )
    throw invalid(`Invalid ${field}: expected a nonnegative safe integer.`);
  return value;
}

/** Bounds and normalizes a dispatch spec. Throws BrainError INVALID_INPUT. */
export function validateDispatchSpec(input: unknown): DispatchSpec {
  const spec = input as DispatchSpec;
  if (!spec || typeof spec !== "object") throw invalid("Dispatch spec is required.");
  if (!dispatchStages.includes(spec.stage))
    throw invalid("Unknown dispatch stage.");
  return {
    job_id: boundedText(spec.job_id, "job_id"),
    dispatch_key: boundedText(spec.dispatch_key, "dispatch_key"),
    stage: spec.stage,
    reserved_micro_usd: microUsd(spec.reserved_micro_usd, "reserved_micro_usd"),
    provider: boundedText(spec.provider, "provider"),
    model: boundedText(spec.model, "model"),
    price_version: boundedText(spec.price_version, "price_version"),
    request_hash: sha256Hex(spec.request_hash, "request_hash"),
    config_hash: sha256Hex(spec.config_hash, "config_hash"),
  };
}

/** Bounds and normalizes limits, including IANA time zone. */
export function validateSpendLimits(input: unknown): SpendLimits {
  const limits = input as SpendLimits;
  if (!limits || typeof limits !== "object") throw invalid("Spend limits are required.");
  const time_zone = boundedText(limits.time_zone, "time_zone");
  try {
    new Intl.DateTimeFormat("en", { timeZone: time_zone });
  } catch {
    throw invalid("Unknown accounting time zone.");
  }
  return {
    per_job_micro_usd: microUsd(limits.per_job_micro_usd, "per_job_micro_usd"),
    daily_micro_usd: microUsd(limits.daily_micro_usd, "daily_micro_usd"),
    time_zone,
  };
}

export function validateActualMicroUsd(value: unknown): number {
  return microUsd(value, "actual_micro_usd");
}

/** Bounds a lease's shape without consulting a clock. */
export function validateJobLeaseShape(input: unknown): JobLease {
  const lease = input as JobLease;
  if (!lease || typeof lease !== "object") throw invalid("A worker lease is required.");
  const job_id = boundedText(lease.job_id, "lease.job_id");
  const owner = boundedText(lease.owner, "lease.owner");
  if (
    typeof lease.fence !== "number" ||
    !Number.isSafeInteger(lease.fence) ||
    lease.fence < 0
  )
    throw invalid("Invalid lease fence.");
  const expires_at = boundedText(lease.expires_at, "lease.expires_at", 64);
  if (!Number.isFinite(Date.parse(expires_at))) throw invalid("Invalid lease deadline.");
  return { job_id, owner, fence: lease.fence, expires_at };
}

/**
 * Bounds a lease and rejects an already expired deadline at `now`.
 *
 * The caller must pass a clock sampled *after* any write lock is acquired;
 * otherwise a lease that expires while waiting for the lock could be admitted.
 */
export function validateJobLease(input: unknown, now: Date): JobLease {
  const lease = validateJobLeaseShape(input);
  if (Date.parse(lease.expires_at) <= now.getTime())
    throw new BrainError(
      "LEASE_EXPIRED",
      "This worker lease is no longer current.",
      409,
    );
  return lease;
}

/** Stable SHA-256 of the immutable slot content used for duplicate detection. */
export function dispatchIdentityHash(spec: DispatchSpec): string {
  const material = {
    job_id: spec.job_id,
    dispatch_key: spec.dispatch_key,
    stage: spec.stage,
    provider: spec.provider,
    model: spec.model,
    price_version: spec.price_version,
    request_hash: spec.request_hash,
    config_hash: spec.config_hash,
    reserved_micro_usd: spec.reserved_micro_usd,
  };
  return createHash("sha256").update(canonical(material)).digest("hex");
}

/** Calendar day (YYYY-MM-DD) of `now` in `timeZone`. */
export function accountingDay(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (key: string) => parts.find((p) => p.type === key)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * Adds nonnegative safe integers, rejecting any non-safe intermediate total.
 * This is the overflow guard used when aggregating rows, not merely for one row.
 */
export function safeAdd(...values: number[]): number {
  let total = 0;
  for (const value of values) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
      throw new BrainError(
        "SPEND_OVERFLOW",
        "Accounted spend is out of range; refusing to treat it as zero.",
        409,
      );
    total += value;
    if (!Number.isSafeInteger(total))
      throw new BrainError(
        "SPEND_OVERFLOW",
        "Accounted spend exceeds the safe integer range.",
        409,
      );
  }
  return total;
}

export function checkedSum(values: readonly number[]): number {
  return safeAdd(...values);
}

/** Remaining daily allowance given committed spend, clamped at zero. */
export function remainingAllowance(limit: number, committed: number): number {
  return Math.max(0, limit - Math.min(limit, committed));
}