import { createHash } from "node:crypto";
import { BrainError, canonical } from "./logic.ts";

/**
 * Pure B0 billing-authority domain primitives.
 *
 * This module holds closed data contracts, the deterministic UTC calendar, window
 * identity and the pure lookup-view validator. It performs no IO, opens no storage,
 * holds no key, reads no clock, and confers NO authority: a window id, a stored
 * reference or a MAC-shaped digest is structural data, never a permission. Only the
 * later authority-owned control store may verify real ownership and provenance.
 *
 * The strict date/token/hex helpers are exported so the seal module reuses the exact
 * same canonical rules instead of duplicating an incompatible parser.
 */

export const BILLING_FRESHNESS_MAX_MS = 15 * 60 * 1000;
export const BILLING_MAX_FRAME_BYTES = 16 * 1024;
export const BILLING_MAX_SOURCE_IDS = 16;
const BILLING_MAX_TERM_MS = 31 * 86400000;

export type Cadence = "monthly" | "annual";
export type UnavailableReason =
  | "no_admission"
  | "no_grant"
  | "stale"
  | "past_due"
  | "canceled"
  | "refunded"
  | "conflict"
  | "suspended"
  | "policy_mismatch";

export type BillingEligibility =
  | {
      state: "granted";
      window_id: string;
      window_start: string;
      window_end: string;
      grant_proof: string;
    }
  | { state: "unavailable"; reason: UnavailableReason };

export interface BillingWindowInput {
  account_id: string;
  subscription_ref: string;
  cadence: Cadence;
  paid_term_start: string;
  paid_term_end: string;
  now: Date;
}

export interface BillingWindow {
  window_id: string;
  window_start: string;
  window_end: string;
  index: number;
}

export type BillingWindowResult =
  | { state: "window"; window: BillingWindow }
  | { state: "unavailable"; reason: UnavailableReason };

/**
 * Pure lookup view carried from the approved B0 spec. Its `window_id`/MAC fields are
 * structural digests, never cryptographic proof or permission.
 */
export interface StoredPaidTermReference {
  term_id: string;
  receipt_id: string;
  account_binding: string;
  subscription_ref: string;
  transaction_ref: string;
  term_start: string;
  term_end: string;
  cadence: Cadence;
  window_id: string;
  window_start: string;
  window_end: string;
  policy_id: string;
  root_epoch: number;
  provenance_mac: string;
}

// ---------------------------------------------------------------- strict helpers

/** Static, content-free refusal. Never echoes caller input. */
export function invalid(message = "Invalid billing data."): never {
  throw new BrainError("INVALID_INPUT", message, 400);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

export function assertExactKeys(
  object: Record<string, unknown>,
  keys: readonly string[],
): void {
  const allowed = new Set(keys);
  // Reflect.ownKeys covers non-enumerable and symbol keys, so an object can never
  // hide a surplus field. Every field must be a plain data property: an accessor
  // could return one value during validation and another during serialization.
  const own = Reflect.ownKeys(object);
  if (own.length !== keys.length) invalid();
  for (const key of own) {
    if (typeof key !== "string" || !allowed.has(key)) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    if (!descriptor || !("value" in descriptor)) invalid();
  }
}

export function isToken(value: unknown): boolean {
  return typeof value === "string" && /^[A-Za-z0-9:_-]{1,200}$/.test(value);
}

export function isUuid(value: unknown): boolean {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  );
}

export function isHex64(value: unknown): boolean {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

export function isSafeInt(
  value: unknown,
  min: number,
  max: number = Number.MAX_SAFE_INTEGER,
): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;
}

const CANONICAL_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Strict `YYYY-MM-DDTHH:mm:ss.sssZ` with a 4-digit year 0001..9999. Rejects
 * Date-normalized instants (e.g. `Feb 30`), year `0000`, offsets, a missing `Z`
 * and short/spaced forms.
 */
export function parseCanonicalUtc(value: unknown): Date {
  if (typeof value !== "string" || !CANONICAL_UTC.test(value)) invalid();
  const year = Number(value.slice(0, 4));
  if (!Number.isSafeInteger(year) || year < 1 || year > 9999) invalid();
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) invalid();
  return date;
}

export function canonicalUtc(value: unknown): string {
  return parseCanonicalUtc(value).toISOString();
}

function assertDate(value: unknown): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) invalid();
  return value;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInUtcMonth(year: number, monthIndex: number): number {
  const table = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return table[monthIndex]!;
}

// ------------------------------------------------------------------- calendar

/**
 * Add whole calendar months from the ORIGINAL anchor, preserving the original UTC
 * millisecond time and clamping the day to the target month's last day. Month
 * arithmetic uses the full year (never the JS 0..99 year gotcha).
 */
export function clampAddMonths(anchorIso: string, months: number): string {
  const instant = parseCanonicalUtc(anchorIso);
  if (!Number.isSafeInteger(months) || months < 0 || months > 12) invalid();
  const year = instant.getUTCFullYear();
  const monthIndex = instant.getUTCMonth() + months;
  const targetYear = year + Math.floor(monthIndex / 12);
  const targetMonth = ((monthIndex % 12) + 12) % 12;
  if (targetYear < 1 || targetYear > 9999) invalid();
  const targetDay = Math.min(instant.getUTCDate(), daysInUtcMonth(targetYear, targetMonth));
  const result = new Date(0);
  result.setUTCFullYear(targetYear, targetMonth, targetDay);
  result.setUTCHours(
    instant.getUTCHours(),
    instant.getUTCMinutes(),
    instant.getUTCSeconds(),
    instant.getUTCMilliseconds(),
  );
  return result.toISOString();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// -------------------------------------------------------------- window identity

const WINDOW_ID_KEYS = [
  "account_id",
  "subscription_ref",
  "paid_term_start",
  "window_start",
  "window_end",
] as const;

/**
 * Policy-independent, transaction-independent logical window identity. Validates
 * `paid_term_start <= window_start < window_end`. It has NO paid-term end input and
 * cannot prove provider-term bounds; callers with the full term (`billingWindow`, the
 * stored-reference validator) enforce those from their own inputs.
 */
export function windowId(input: unknown): string {
  if (!isPlainObject(input)) invalid();
  assertExactKeys(input, WINDOW_ID_KEYS);
  if (!isUuid(input.account_id)) invalid();
  if (!isToken(input.subscription_ref)) invalid();
  const termStart = parseCanonicalUtc(input.paid_term_start);
  const start = parseCanonicalUtc(input.window_start);
  const end = parseCanonicalUtc(input.window_end);
  if (start.getTime() < termStart.getTime()) invalid();
  if (start.getTime() >= end.getTime()) invalid();
  return sha256(
    canonical({
      account_id: input.account_id,
      subscription_ref: input.subscription_ref,
      paid_term_start: input.paid_term_start,
      window_start: input.window_start,
      window_end: input.window_end,
    }),
  );
}

// -------------------------------------------------------------------- windows

const BILLING_WINDOW_KEYS = [
  "account_id",
  "subscription_ref",
  "cadence",
  "paid_term_start",
  "paid_term_end",
  "now",
] as const;

function assertTerm(cadence: Cadence, startIso: string, endIso: string): { start: Date; end: Date } {
  const start = parseCanonicalUtc(startIso);
  const end = parseCanonicalUtc(endIso);
  const span = end.getTime() - start.getTime();
  if (span <= 0) invalid();
  if (cadence === "monthly") {
    if (span > BILLING_MAX_TERM_MS) invalid();
  } else {
    const twelveMonthsAhead = parseCanonicalUtc(clampAddMonths(startIso, 12));
    if (end.getTime() > twelveMonthsAhead.getTime()) invalid();
  }
  return { start, end };
}

/**
 * The ORIGINAL-anchor annual calendar: up to 12 half-open monthly windows, computed
 * from the anchor (never the previous window, so no drift), each clipped at the term
 * end. Shared by `billingWindow` and the stored-reference validator so bounds agree.
 */
function annualCalendarWindows(
  startIso: string,
  endIso: string,
): Array<{ index: number; start: string; end: string }> {
  const end = parseCanonicalUtc(endIso);
  const windows: Array<{ index: number; start: string; end: string }> = [];
  for (let index = 0; index <= 11; index += 1) {
    const wStart = parseCanonicalUtc(clampAddMonths(startIso, index));
    const rawEnd = parseCanonicalUtc(clampAddMonths(startIso, index + 1));
    const wEnd = rawEnd.getTime() < end.getTime() ? rawEnd : end;
    if (wStart.getTime() >= wEnd.getTime()) continue;
    windows.push({ index, start: wStart.toISOString(), end: wEnd.toISOString() });
  }
  return windows;
}

/**
 * Resolve the ONE current billing window.
 *
 * Monthly uses the exact provider-paid period verbatim (no synthesized lifetime
 * anchor). Annual derives up to 12 half-open calendar windows from the ORIGINAL UTC
 * anchor, only returning the window containing `now`, and clips the final window at
 * the term end. The whole input is validated first, so an invalid term never becomes
 * `no_grant` merely because the clock is outside.
 */
export function billingWindow(input: unknown): BillingWindowResult {
  if (!isPlainObject(input)) invalid();
  assertExactKeys(input, BILLING_WINDOW_KEYS);
  if (!isUuid(input.account_id)) invalid();
  if (!isToken(input.subscription_ref)) invalid();
  const cadence = input.cadence;
  if (cadence !== "monthly" && cadence !== "annual") invalid();
  const { start, end } = assertTerm(cadence, input.paid_term_start as string, input.paid_term_end as string);
  const now = assertDate(input.now);

  if (now.getTime() < start.getTime() || now.getTime() >= end.getTime())
    return { state: "unavailable", reason: "no_grant" };

  if (cadence === "monthly") {
    return {
      state: "window",
      window: {
        window_id: windowId({
          account_id: input.account_id,
          subscription_ref: input.subscription_ref,
          paid_term_start: input.paid_term_start,
          window_start: input.paid_term_start,
          window_end: input.paid_term_end,
        }),
        window_start: start.toISOString(),
        window_end: end.toISOString(),
        index: 0,
      },
    };
  }

  for (const candidate of annualCalendarWindows(start.toISOString(), end.toISOString())) {
    const wStart = Date.parse(candidate.start);
    const wEnd = Date.parse(candidate.end);
    if (now.getTime() >= wStart && now.getTime() < wEnd) {
      return {
        state: "window",
        window: {
          window_id: windowId({
            account_id: input.account_id,
            subscription_ref: input.subscription_ref,
            paid_term_start: input.paid_term_start,
            window_start: candidate.start,
            window_end: candidate.end,
          }),
          window_start: candidate.start,
          window_end: candidate.end,
          index: candidate.index,
        },
      };
    }
  }
  return { state: "unavailable", reason: "no_grant" };
}

// ------------------------------------------------------------------ freshness

export function paidTermFreshUntil(verifiedAt: Date, paid_term_end: string): Date {
  const verified = assertDate(verifiedAt);
  const end = parseCanonicalUtc(paid_term_end);
  return new Date(Math.min(verified.getTime() + BILLING_FRESHNESS_MAX_MS, end.getTime()));
}

export function admissionExpiresAt(termFreshnessEnd: Date, current_window_end: string): Date {
  const term = assertDate(termFreshnessEnd);
  const windowEnd = parseCanonicalUtc(current_window_end);
  return new Date(Math.min(term.getTime(), windowEnd.getTime()));
}

// ------------------------------------------------------- stored reference view

const STORED_REF_KEYS = [
  "term_id",
  "receipt_id",
  "account_binding",
  "subscription_ref",
  "transaction_ref",
  "term_start",
  "term_end",
  "cadence",
  "window_id",
  "window_start",
  "window_end",
  "policy_id",
  "root_epoch",
  "provenance_mac",
] as const;

/**
 * Structural, closed validation of the approved lookup view. It checks the closed
 * shape, token/hex/uuid fields, cadence/term duration and exact calendar window
 * bounds. It is explicitly NOT authority: it cannot verify the `window_id` hash (no
 * account id) or the provenance MAC (no key). Only the later authority-owned store
 * may do that.
 */
export function validateStoredPaidTermReference(input: unknown): StoredPaidTermReference {
  if (!isPlainObject(input)) invalid();
  assertExactKeys(input, STORED_REF_KEYS);
  if (!isToken(input.term_id)) invalid();
  if (!isToken(input.receipt_id)) invalid();
  if (!isHex64(input.account_binding)) invalid();
  if (!isToken(input.subscription_ref)) invalid();
  if (!isToken(input.transaction_ref)) invalid();
  const cadence = input.cadence;
  if (cadence !== "monthly" && cadence !== "annual") invalid();
  const { start, end } = assertTerm(cadence, input.term_start as string, input.term_end as string);
  if (!isHex64(input.window_id)) invalid();
  const windowStart = parseCanonicalUtc(input.window_start).toISOString();
  const windowEnd = parseCanonicalUtc(input.window_end).toISOString();
  // The window must be an EXACT trusted calendar window: the whole provider period for
  // monthly, or one of the original-anchor clamped (and term-clipped) intervals for
  // annual. Broad containment is not enough — a shrunk or two-month window is refused.
  if (cadence === "monthly") {
    if (windowStart !== start.toISOString() || windowEnd !== end.toISOString()) invalid();
  } else if (
    !annualCalendarWindows(start.toISOString(), end.toISOString()).some(
      (candidate) => candidate.start === windowStart && candidate.end === windowEnd,
    )
  ) {
    invalid();
  }
  if (!isToken(input.policy_id)) invalid();
  if (!isSafeInt(input.root_epoch, 1)) invalid();
  if (!isHex64(input.provenance_mac)) invalid();
  // Owned, validated snapshot: never alias the caller-mutable input (no TOCTOU between
  // validation and use), and never claim authority from the structural digests.
  return {
    term_id: input.term_id as string,
    receipt_id: input.receipt_id as string,
    account_binding: input.account_binding as string,
    subscription_ref: input.subscription_ref as string,
    transaction_ref: input.transaction_ref as string,
    term_start: start.toISOString(),
    term_end: end.toISOString(),
    cadence,
    window_id: input.window_id as string,
    window_start: windowStart,
    window_end: windowEnd,
    policy_id: input.policy_id as string,
    root_epoch: input.root_epoch as number,
    provenance_mac: input.provenance_mac as string,
  };
}
