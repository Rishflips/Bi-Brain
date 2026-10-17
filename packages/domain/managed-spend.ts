import { createHash } from "node:crypto";
import { z } from "zod";
import { BrainError, canonical } from "./logic.ts";
import {
  dispatchStages,
  maxMicroUsd,
  type DispatchStage,
} from "./spend.ts";

/**
 * Pure managed-money vocabulary and validation for the central spending ledger.
 *
 * This module has no persistence, transport or authorization concerns. It bounds
 * values, derives the immutable dispatch identity for one global managed service
 * bucket, and computes the canonical UTC / frozen accounting day. Storage applies
 * these results inside short immediate transactions over the control database.
 *
 * There is exactly one managed paid service. A caller never supplies a service
 * string, so separate `reasoning`/`decision`/`repair` calls can never be placed in
 * independent service buckets to defeat the single shared service cap.
 */
export const MANAGED_SERVICE_ID = "managed-processing" as const;
export type ManagedServiceId = typeof MANAGED_SERVICE_ID;

/**
 * Current managed money schema version. It lives in the pure domain layer so
 * storage, runtime and the activation state helper can share it without an import
 * cycle through `storage/managed-spending.ts`.
 *
 * The normal constructor installs/accepts the LEGACY version (4) only; a genuine
 * legacy v4 database is never auto-promoted. The billing version (5) is reached
 * solely through the explicit `installBillingMoney5` operation.
 */
export const managedMoneySchemaVersion = 4;
/** The billing money schema version, installed only by `installBillingMoney5`. */
export const managedMoneyBillingVersion = 5;
/** Versions the runtime understands (activation/audit branch on the actual stored value). */
export const managedMoneySupportedVersions = [4, 5] as const;

export { maxMicroUsd };

/** Current trusted user constraints. A caller may only ever lower them. */
export interface ManagedLimits {
  per_job_micro_usd: number;
  user_daily_micro_usd: number;
  time_zone: string;
}

/** Immutable inputs for one logical dispatch slot on an account. */
export interface ManagedDispatchSpec {
  account_id: string;
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
  limits: ManagedLimits;
}

export const managedReservationStates = [
  "reserved",
  "dispatched",
  "settled",
  "released",
] as const;
export type ManagedReservationState = (typeof managedReservationStates)[number];

/**
 * Content-free public pause reasons for the shared managed service.
 *
 * `usage_pending` is an ADMISSION barrier: a committed `dispatched` row may have
 * reached a provider and awaits a known settlement. It is deliberately distinct
 * from consent: it never revokes the owner's stored paid preference. The other
 * reason, `awaiting_accounting`, covers a durable money/service block or the
 * process fuse, where paid work must stay unavailable until an operator
 * reconciles. Neither reason carries an id, account or amount.
 */
export const managedPauseReasons = ["usage_pending", "awaiting_accounting"] as const;
export type ManagedPauseReason = (typeof managedPauseReasons)[number];

export interface ManagedServiceBarrier {
  paused: boolean;
  reason: ManagedPauseReason | null;
}

export interface AccountAllowancePeriod {
  period_id: string;
  account_id: string;
  starts_at: string;
  ends_at: string;
  allowance_micro_usd: number;
  state: "active" | "revoked";
  granted_at: string;
  revoked_at: string | null;
}

export interface ServicePolicy {
  service: ManagedServiceId;
  daily_micro_usd: number;
  version: number;
  updated_at: string;
}

export interface AccountSpendingPolicy {
  account_id: string;
  per_job_micro_usd: number;
  user_daily_micro_usd: number;
  /** Frozen at the first successful admission; null until then. */
  accounting_tz: string | null;
  version: number;
  updated_at: string;
}

/** Persisted central reservation. No prompt, evidence or key is ever stored. */
export interface ManagedReservation {
  call_id: string;
  account_id: string;
  job_id: string;
  dispatch_key: string;
  service: ManagedServiceId;
  stage: DispatchStage;
  state: ManagedReservationState;
  reserved_micro_usd: number;
  actual_micro_usd: number | null;
  content_hash: string;
  identity_hash: string;
  account_period_id: string;
  service_day: string;
  user_day: string;
  accounting_tz: string;
  stored_per_job_micro_usd: number;
  stored_user_daily_micro_usd: number;
  provider: string;
  model: string;
  price_version: string;
  request_hash: string;
  config_hash: string;
  projection_call_id: string | null;
  reconciliation_required: boolean;
  created_at: string;
  marked_at: string | null;
  settled_at: string | null;
}

/** Narrow, central-authoritative read view for the worker seam. */
export interface ManagedMoneyReceipt {
  call_id: string;
  state: ManagedReservationState;
  reserved_micro_usd: number;
  actual_micro_usd: number | null;
  reconciliation_required: boolean;
  account_period_id: string;
  service_day: string;
  user_day: string;
}

export interface ManagedAccountStatus {
  account_id: string;
  active: boolean;
  period: AccountAllowancePeriod | null;
  service: ServicePolicy | null;
  policy: AccountSpendingPolicy | null;
  committed: {
    account_period_micro_usd: number;
    service_day_micro_usd: number;
    user_day_micro_usd: number;
    unresolved_micro_usd: number;
  };
  blocked: boolean;
  blocked_reason:
    | "overrun"
    | "restored_backup"
    | "reconciliation_required"
    | "disputed_usage"
    | "usage_pending"
    | null;
  reconciliation_required: boolean;
}

/**
 * Public, own-account money view for the authenticated owner.
 *
 * It deliberately omits every global/service aggregate and any other account's
 * data: the internal `ManagedAccountStatus` exposes a service-wide committed
 * total and the singleton service cap, and this view strips both to a bare
 * `service_available` boolean. It also never reads the tenant projection, so a
 * stale/failed projection can never make the owner's money look fresher or
 * cheaper than the central authority.
 */
export interface ManagedSpendView {
  /** Paid processing is not enabled in this batch: always false. */
  available: false;
  /** Operator policy exists and is usable for this account. */
  configured: boolean;
  /** Managed paid admission is paused for this owner's service (barrier or block). */
  paused: boolean;
  /** Content-free public pause reason; never an id, account or amount. */
  paused_reason: ManagedPauseReason | null;
  blocked: boolean;
  blocked_reason:
    | "overrun"
    | "restored_backup"
    | "reconciliation_required"
    | "disputed_usage"
    | "usage_pending"
    | null;
  account_id: string;
  time_zone: string | null;
  budget_day: string;
  /** Known actual settled for the owner's current accounting day only. */
  settled_micro_usd: number;
  /** Every unresolved hold for the owner across all days. */
  unresolved_micro_usd: number;
  committed_micro_usd: number;
  per_job_limit_micro_usd: number;
  daily_limit_micro_usd: number;
  /** Own user-day remaining; never a global service figure. */
  remaining_micro_usd: number;
  /** The shared managed service has a positive operator cap. */
  service_available: boolean;
  allowance: {
    window_start: string | null;
    window_end: string | null;
    limit_micro_usd: number;
    committed_micro_usd: number;
    remaining_micro_usd: number;
  };
}

const invalid = (message: string) => new BrainError("INVALID_INPUT", message, 400);
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw invalid(`Invalid ${field}: expected a nonnegative safe integer.`);
  return value;
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID.test(value))
    throw invalid(`Invalid ${field}.`);
  return value;
}

/**
 * Parses one strict ISO 8601 date-time with an explicit `Z` or numeric offset,
 * then returns the single canonical UTC ISO form used for every compare. A
 * date-only, offset-less, locale-text or impossible-calendar value is rejected
 * before it can reach `Date.parse`.
 */
const isoInstantSchema = z.string().datetime({ offset: true });

function isoInstant(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 64)
    throw invalid(`Invalid ${field}.`);
  const parsed = isoInstantSchema.safeParse(value);
  if (!parsed.success)
    throw invalid(
      `Invalid ${field}: expected an ISO 8601 date-time with an explicit UTC offset.`,
    );
  return new Date(parsed.data).toISOString();
}

export function validateManagedLimits(input: unknown): ManagedLimits {
  const limits = input as ManagedLimits;
  if (!limits || typeof limits !== "object")
    throw invalid("Managed spending limits are required.");
  const time_zone = boundedText(limits.time_zone, "time_zone");
  try {
    new Intl.DateTimeFormat("en", { timeZone: time_zone });
  } catch {
    throw invalid("Unknown accounting time zone.");
  }
  return {
    per_job_micro_usd: microUsd(limits.per_job_micro_usd, "per_job_micro_usd"),
    user_daily_micro_usd: microUsd(
      limits.user_daily_micro_usd,
      "user_daily_micro_usd",
    ),
    time_zone,
  };
}

export function validateManagedDispatchSpec(input: unknown): ManagedDispatchSpec {
  const spec = input as ManagedDispatchSpec;
  if (!spec || typeof spec !== "object")
    throw invalid("Managed dispatch spec is required.");
  if (!dispatchStages.includes(spec.stage))
    throw invalid("Unknown dispatch stage.");
  return {
    account_id: uuid(spec.account_id, "account_id"),
    job_id: boundedText(spec.job_id, "job_id"),
    dispatch_key: boundedText(spec.dispatch_key, "dispatch_key"),
    stage: spec.stage,
    reserved_micro_usd: microUsd(spec.reserved_micro_usd, "reserved_micro_usd"),
    provider: boundedText(spec.provider, "provider"),
    model: boundedText(spec.model, "model"),
    price_version: boundedText(spec.price_version, "price_version"),
    request_hash: sha256Hex(spec.request_hash, "request_hash"),
    config_hash: sha256Hex(spec.config_hash, "config_hash"),
    limits: validateManagedLimits(spec.limits),
  };
}

export function validateAllowancePeriodInput(input: unknown): {
  account_id: string;
  starts_at: string;
  ends_at: string;
  allowance_micro_usd: number;
} {
  const value = input as {
    account_id?: unknown;
    starts_at?: unknown;
    ends_at?: unknown;
    allowance_micro_usd?: unknown;
  };
  if (!value || typeof value !== "object")
    throw invalid("Allowance period is required.");
  const starts_at = isoInstant(value.starts_at, "starts_at");
  const ends_at = isoInstant(value.ends_at, "ends_at");
  if (ends_at <= starts_at)
    throw invalid("Allowance period must end after it starts.");
  return {
    account_id: uuid(value.account_id, "account_id"),
    starts_at,
    ends_at,
    allowance_micro_usd: microUsd(value.allowance_micro_usd, "allowance_micro_usd"),
  };
}

export function validateServicePolicyInput(input: unknown): {
  daily_micro_usd: number;
} {
  const value = input as { daily_micro_usd?: unknown };
  if (!value || typeof value !== "object")
    throw invalid("Service policy is required.");
  return { daily_micro_usd: microUsd(value.daily_micro_usd, "daily_micro_usd") };
}

export function validateAccountPolicyInput(input: unknown): {
  account_id: string;
  per_job_micro_usd: number;
  user_daily_micro_usd: number;
} {
  const value = input as {
    account_id?: unknown;
    per_job_micro_usd?: unknown;
    user_daily_micro_usd?: unknown;
  };
  if (!value || typeof value !== "object")
    throw invalid("Account policy is required.");
  return {
    account_id: uuid(value.account_id, "account_id"),
    per_job_micro_usd: microUsd(value.per_job_micro_usd, "per_job_micro_usd"),
    user_daily_micro_usd: microUsd(
      value.user_daily_micro_usd,
      "user_daily_micro_usd",
    ),
  };
}

/** Calendar day (YYYY-MM-DD) of `now` in UTC. */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Stable SHA-256 of the immutable request content of one dispatch slot. It
 * excludes the derived day/period binding, which is hashed separately so a
 * duplicate lookup never has to recompute a day that may have rolled over.
 */
export function managedContentHash(spec: ManagedDispatchSpec): string {
  const material = {
    account_id: spec.account_id,
    job_id: spec.job_id,
    dispatch_key: spec.dispatch_key,
    stage: spec.stage,
    reserved_micro_usd: spec.reserved_micro_usd,
    provider: spec.provider,
    model: spec.model,
    price_version: spec.price_version,
    request_hash: spec.request_hash,
    config_hash: spec.config_hash,
  };
  return createHash("sha256").update(canonical(material)).digest("hex");
}

/**
 * Immutable binding of a reservation to its period ids, the single service, the
 * frozen accounting zone and the stored user caps. A mismatch on any binding
 * field, amount, request/config hash or stage is a dispatch conflict.
 */
export function managedIdentityHash(
  spec: ManagedDispatchSpec,
  binding: {
    content_hash: string;
    account_period_id: string;
    service: ManagedServiceId;
    service_day: string;
    user_day: string;
    accounting_tz: string;
    stored_per_job_micro_usd: number;
    stored_user_daily_micro_usd: number;
  },
): string {
  const material = {
    account_id: spec.account_id,
    job_id: spec.job_id,
    dispatch_key: spec.dispatch_key,
    content_hash: binding.content_hash,
    account_period_id: binding.account_period_id,
    service: binding.service,
    service_day: binding.service_day,
    user_day: binding.user_day,
    accounting_tz: binding.accounting_tz,
    stored_per_job_micro_usd: binding.stored_per_job_micro_usd,
    stored_user_daily_micro_usd: binding.stored_user_daily_micro_usd,
  };
  return createHash("sha256").update(canonical(material)).digest("hex");
}
