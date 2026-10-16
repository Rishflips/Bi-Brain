import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ControlStore } from "./control.ts";
import { BrainError } from "../domain/logic.ts";
import { accountingDay, checkedSum, safeAdd, validateActualMicroUsd } from "../domain/spend.ts";
import {
  MANAGED_SERVICE_ID,
  managedContentHash,
  managedIdentityHash,
  utcDay,
  validateAccountPolicyInput,
  validateAllowancePeriodInput,
  validateManagedDispatchSpec,
  validateManagedLimits,
  validateServicePolicyInput,
  type AccountAllowancePeriod,
  type AccountSpendingPolicy,
  type ManagedAccountStatus,
  type ManagedDispatchSpec,
  type ManagedLimits,
  type ManagedMoneyReceipt,
  type ManagedReservation,
  type ManagedReservationState,
  type ManagedServiceId,
  type ServicePolicy,
} from "../domain/managed-spend.ts";

/**
 * Single authoritative ledger for all managed paid money, stored in the control
 * database beside the trusted identity tables.
 *
 * It is an internal persistence boundary, not a transport or an authorization
 * endpoint: the caller must already hold a trusted pinned runtime handle and the
 * account id is never taken from a provider, browser, header or spec outside the
 * trusted handle that constructs it. Every state transition runs in a short
 * `BEGIN IMMEDIATE` transaction with the authoritative clock read inside it.
 *
 * The per-tenant `DispatchLedger` is retained unchanged as a conservative
 * journal/projection; it is never an independent authority for managed money.
 */
export const managedMoneySchemaVersion = 1;

const SERVICE: ManagedServiceId = MANAGED_SERVICE_ID;

/**
 * Process-local fuse over the shared control handle. When a critical safety
 * marker cannot be persisted, managed admission must fail closed for the rest
 * of this process even after the underlying write "recovers": the marker write
 * that was supposed to record the obligation may itself have been lost, so
 * trusting the recovered row would under-count a real charge.
 *
 * It is deliberately in-memory and weak over the shared `ControlStore` handle:
 * a new `ManagedSpendingStore` built from the same handle is still paused. It is
 * never cleared on DB recovery and is not a durable or multi-process guarantee —
 * a restart relies on managed paid processing defaulting to off in `main.ts`.
 */
const poisonedControls = new WeakSet<ControlStore>();

export function isManagedControlPaused(control: ControlStore): boolean {
  return poisonedControls.has(control);
}

/**
 * Internal fatal condition: managed spending was paused because a critical
 * safety marker could not be persisted. It is not a model/output code and must
 * not be swallowed by an ordinary job-error handler; managed worker scheduling
 * must fail-stop.
 */
export class AccountingPersistenceError extends Error {
  readonly code = "ACCOUNTING_PERSISTENCE";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.name = "AccountingPersistenceError";
  }
}

const MONEY_DDL = `
CREATE TABLE IF NOT EXISTS managed_account_periods(
  period_id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES managed_accounts(id),
  starts_at TEXT NOT NULL, ends_at TEXT NOT NULL,
  allowance_micro_usd INTEGER NOT NULL CHECK(allowance_micro_usd>=0),
  state TEXT NOT NULL CHECK(state IN ('active','revoked')),
  granted_at TEXT NOT NULL, revoked_at TEXT,
  UNIQUE(account_id, starts_at, ends_at));
CREATE TABLE IF NOT EXISTS managed_service_policy(
  service TEXT PRIMARY KEY CHECK(service='managed-processing'),
  daily_micro_usd INTEGER NOT NULL CHECK(daily_micro_usd>=0), version INTEGER NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS managed_account_policy(
  account_id TEXT PRIMARY KEY REFERENCES managed_accounts(id),
  per_job_micro_usd INTEGER NOT NULL CHECK(per_job_micro_usd>=0),
  user_daily_micro_usd INTEGER NOT NULL CHECK(user_daily_micro_usd>=0),
  accounting_tz TEXT, version INTEGER NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS managed_reservations(
  call_id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES managed_accounts(id),
  job_id TEXT NOT NULL, dispatch_key TEXT NOT NULL,
  service TEXT NOT NULL CHECK(service='managed-processing'),
  stage TEXT NOT NULL CHECK(stage IN ('decision','reasoning','repair')),
  state TEXT NOT NULL CHECK(state IN ('reserved','dispatched','settled','released')),
  reserved_micro_usd INTEGER NOT NULL CHECK(reserved_micro_usd>=0),
  actual_micro_usd INTEGER CHECK(actual_micro_usd IS NULL OR actual_micro_usd>=0),
  content_hash TEXT NOT NULL, identity_hash TEXT NOT NULL,
  account_period_id TEXT NOT NULL REFERENCES managed_account_periods(period_id),
  service_day TEXT NOT NULL, user_day TEXT NOT NULL, accounting_tz TEXT NOT NULL,
  stored_per_job_micro_usd INTEGER NOT NULL CHECK(stored_per_job_micro_usd>=0),
  stored_user_daily_micro_usd INTEGER NOT NULL CHECK(stored_user_daily_micro_usd>=0),
  provider TEXT NOT NULL, model TEXT NOT NULL, price_version TEXT NOT NULL,
  request_hash TEXT NOT NULL, config_hash TEXT NOT NULL,
  projection_call_id TEXT, reconciliation_required INTEGER NOT NULL DEFAULT 0 CHECK(reconciliation_required IN (0,1)),
  created_at TEXT NOT NULL, marked_at TEXT, settled_at TEXT,
  UNIQUE(account_id, job_id, dispatch_key));
CREATE TABLE IF NOT EXISTS managed_service_blocks(
  service TEXT PRIMARY KEY CHECK(service='managed-processing'),
  call_id TEXT NOT NULL, account_id TEXT NOT NULL,
  over_micro_usd INTEGER NOT NULL CHECK(over_micro_usd>=0), at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS managed_money_blocks(key TEXT PRIMARY KEY, reason TEXT NOT NULL, at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS managed_reservations_account ON managed_reservations(account_id,state);
CREATE INDEX IF NOT EXISTS managed_reservations_job ON managed_reservations(account_id,job_id,state);
CREATE INDEX IF NOT EXISTS managed_reservations_service_day ON managed_reservations(service_day,state);
CREATE UNIQUE INDEX IF NOT EXISTS managed_reservations_projection ON managed_reservations(projection_call_id);
`;

const budget = (message: string) =>
  new BrainError("BUDGET_EXHAUSTED", message, 409);

export class ManagedSpendingStore {
  readonly db: DatabaseSync;
  constructor(
    readonly control: ControlStore,
    readonly clock: () => Date = control.clock,
  ) {
    this.db = control.db;
    this.migrate();
  }

  /** Future-version guard runs inside the transaction before any money DDL. */
  private migrate(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const meta = this.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='managed_money_schema'",
        )
        .get();
      if (meta) {
        const version = Number(
          (
            this.db
              .prepare("SELECT max(version) AS version FROM managed_money_schema")
              .get() as { version: number | null } | undefined
          )?.version ?? 0,
        );
        if (version > managedMoneySchemaVersion)
          throw new BrainError(
            "UNAVAILABLE",
            "Managed spending schema is from a newer version.",
            503,
          );
      }
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS managed_money_schema(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);`,
      );
      this.db.exec(MONEY_DDL);
      this.db
        .prepare("INSERT OR IGNORE INTO managed_money_schema VALUES(?,?)")
        .run(managedMoneySchemaVersion, this.clock().toISOString());
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private assertNotPaused(): void {
    if (poisonedControls.has(this.control))
      throw new AccountingPersistenceError(
        "Managed spending is paused until an operator reconciles a failed safety marker.",
      );
  }

  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    let result: T;
    try {
      result = fn();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return result;
  }

  // ---------------------------------------------------------------- operator

  configureAccountPeriod(input: unknown): AccountAllowancePeriod {
    const value = validateAllowancePeriodInput(input);
    return this.tx(() => {
      const now = this.clock().toISOString();
      if (!this.control.account(value.account_id))
        throw new BrainError("NOT_FOUND", "Managed account unavailable.", 404);
      for (const row of this.db
        .prepare("SELECT * FROM managed_account_periods WHERE account_id=?")
        .all(value.account_id) as any[]) {
        const overlaps =
          row.starts_at < value.ends_at && row.ends_at > value.starts_at;
        if (!overlaps) continue;
        if (
          row.state === "active" &&
          row.starts_at === value.starts_at &&
          row.ends_at === value.ends_at &&
          Number(row.allowance_micro_usd) === value.allowance_micro_usd
        )
          return toPeriod(row);
        throw new BrainError(
          "PERIOD_CONFLICT",
          "An overlapping managed allowance period already exists.",
          409,
        );
      }
      const period_id = randomUUID();
      this.db
        .prepare(
          "INSERT INTO managed_account_periods(period_id,account_id,starts_at,ends_at,allowance_micro_usd,state,granted_at,revoked_at) VALUES(?,?,?,?,?,?,?,NULL)",
        )
        .run(
          period_id,
          value.account_id,
          value.starts_at,
          value.ends_at,
          value.allowance_micro_usd,
          "active",
          now,
        );
      return toPeriod(this.periodRow(period_id)!);
    });
  }

  revokeAccountPeriod(periodId: string): AccountAllowancePeriod {
    if (typeof periodId !== "string" || periodId.length === 0)
      throw new BrainError("INVALID_INPUT", "Invalid allowance period.", 400);
    return this.tx(() => {
      const row = this.periodRow(periodId);
      if (!row)
        throw new BrainError("NOT_FOUND", "Unknown allowance period.", 404);
      if (row.state === "revoked") return toPeriod(row);
      this.db
        .prepare(
          "UPDATE managed_account_periods SET state='revoked',revoked_at=? WHERE period_id=? AND state='active'",
        )
        .run(this.clock().toISOString(), periodId);
      return toPeriod(this.periodRow(periodId)!);
    });
  }

  setServicePolicy(input: unknown): ServicePolicy {
    const value = validateServicePolicyInput(input);
    return this.tx(() => {
      const now = this.clock().toISOString();
      const existing = this.servicePolicyRow();
      this.db
        .prepare(
          "INSERT INTO managed_service_policy(service,daily_micro_usd,version,updated_at) VALUES(?,?,?,?) ON CONFLICT(service) DO UPDATE SET daily_micro_usd=excluded.daily_micro_usd,version=excluded.version,updated_at=excluded.updated_at",
        )
        .run(SERVICE, value.daily_micro_usd, (existing?.version ?? 0) + 1, now);
      return toServicePolicy(this.servicePolicyRow()!);
    });
  }

  setAccountPolicy(input: unknown): AccountSpendingPolicy {
    const value = validateAccountPolicyInput(input);
    return this.tx(() => {
      if (!this.control.account(value.account_id))
        throw new BrainError("NOT_FOUND", "Managed account unavailable.", 404);
      const now = this.clock().toISOString();
      const existing = this.accountPolicyRow(value.account_id);
      this.db
        .prepare(
          "INSERT INTO managed_account_policy(account_id,per_job_micro_usd,user_daily_micro_usd,accounting_tz,version,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET per_job_micro_usd=excluded.per_job_micro_usd,user_daily_micro_usd=excluded.user_daily_micro_usd,version=excluded.version,updated_at=excluded.updated_at",
        )
        .run(
          value.account_id,
          value.per_job_micro_usd,
          value.user_daily_micro_usd,
          existing?.accounting_tz ?? null,
          (existing?.version ?? 0) + 1,
          now,
        );
      return toAccountPolicy(this.accountPolicyRow(value.account_id)!);
    });
  }

  // ---------------------------------------------------------------- lifecycle

  reserve(spec: ManagedDispatchSpec): ManagedReservation {
    this.assertNotPaused();
    const valid = validateManagedDispatchSpec(spec);
    return this.tx(() => {
      const now = this.clock();
      const content = managedContentHash(valid);
      // Duplicate lookup happens before any day recomputation, so the same slot
      // after a rollover can never become new money.
      const existing = this.slotRow(
        valid.account_id,
        valid.job_id,
        valid.dispatch_key,
      );
      if (existing) {
        if (
          existing.content_hash !== content ||
          Number(existing.stored_per_job_micro_usd) !==
            valid.limits.per_job_micro_usd ||
          Number(existing.stored_user_daily_micro_usd) !==
            valid.limits.user_daily_micro_usd ||
          existing.accounting_tz !== valid.limits.time_zone
        )
          throw new BrainError(
            "DISPATCH_CONFLICT",
            "This dispatch slot already exists with different content.",
            409,
          );
        return toReservation(existing);
      }
      const account = this.control.account(valid.account_id);
      if (!account || account.state !== "active")
        throw new BrainError("UNAUTHORIZED", "Managed account unavailable.", 401);
      const policy = this.accountPolicyRow(valid.account_id);
      if (!policy) throw budget("Managed spending policy is not configured.");
      if (
        policy.accounting_tz !== null &&
        policy.accounting_tz !== valid.limits.time_zone
      )
        throw new BrainError(
          "ACCOUNTING_TIMEZONE_FROZEN",
          "The accounting time zone is frozen and cannot change without an explicit migration.",
          409,
        );
      if (this.isBlocked())
        throw new BrainError(
          "BUDGET_BLOCKED",
          "Managed paid processing is blocked until the recorded reason is reconciled.",
          409,
        );
      const period = this.activePeriod(valid.account_id, now);
      if (!period) throw budget("No managed allowance period is active.");
      const serviceDaily = this.servicePolicyRow()?.daily_micro_usd ?? 0;
      const effectivePerJob = Math.min(
        valid.limits.per_job_micro_usd,
        policy.per_job_micro_usd,
      );
      const effectiveUserDaily = Math.min(
        valid.limits.user_daily_micro_usd,
        policy.user_daily_micro_usd,
      );
      // A zero cap in any dimension denies, even when the estimate itself is
      // zero. A legitimate zero estimate is still admitted under positive caps.
      if (effectivePerJob <= 0)
        throw budget("No managed per-job allowance is configured.");
      if (effectiveUserDaily <= 0)
        throw budget("No managed daily allowance is configured.");
      if (period.allowance_micro_usd <= 0)
        throw budget("The managed allowance period has no allowance.");
      if (serviceDaily <= 0)
        throw budget("Managed processing has no service allowance.");
      const serviceDay = utcDay(now);
      const userDay = accountingDay(now, valid.limits.time_zone);
      const amount = valid.reserved_micro_usd;
      if (
        safeAdd(this.jobCommitted(valid.account_id, valid.job_id), amount) >
        effectivePerJob
      )
        throw budget("This job has reached its managed spending cap.");
      if (
        safeAdd(this.userDayCommitted(valid.account_id, userDay), amount) >
        effectiveUserDaily
      )
        throw budget("Today's managed spending cap is reached.");
      if (
        safeAdd(
          this.accountPeriodCommitted(valid.account_id, period.period_id),
          amount,
        ) > period.allowance_micro_usd
      )
        throw budget("The managed allowance period is exhausted.");
      if (safeAdd(this.serviceDayCommitted(serviceDay), amount) > serviceDaily)
        throw budget("Managed processing is out of allowance for today.");
      const accountingTz = policy.accounting_tz ?? valid.limits.time_zone;
      const binding = {
        content_hash: content,
        account_period_id: period.period_id,
        service: SERVICE,
        service_day: serviceDay,
        user_day: userDay,
        accounting_tz: accountingTz,
        stored_per_job_micro_usd: valid.limits.per_job_micro_usd,
        stored_user_daily_micro_usd: valid.limits.user_daily_micro_usd,
      };
      const identity = managedIdentityHash(valid, binding);
      const callId = randomUUID();
      this.db
        .prepare(
          `INSERT INTO managed_reservations(
             call_id,account_id,job_id,dispatch_key,service,stage,state,reserved_micro_usd,actual_micro_usd,
             content_hash,identity_hash,account_period_id,service_day,user_day,accounting_tz,
             stored_per_job_micro_usd,stored_user_daily_micro_usd,provider,model,price_version,
             request_hash,config_hash,projection_call_id,reconciliation_required,created_at,marked_at,settled_at)
           VALUES(?,?,?,?,?,?,?,?,NULL,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,0,?,NULL,NULL)`,
        )
        .run(
          callId,
          valid.account_id,
          valid.job_id,
          valid.dispatch_key,
          SERVICE,
          valid.stage,
          "reserved",
          amount,
          content,
          identity,
          period.period_id,
          serviceDay,
          userDay,
          accountingTz,
          valid.limits.per_job_micro_usd,
          valid.limits.user_daily_micro_usd,
          valid.provider,
          valid.model,
          valid.price_version,
          valid.request_hash,
          valid.config_hash,
          now.toISOString(),
        );
      // Freeze the accounting zone only on a successful admission.
      if (policy.accounting_tz === null)
        this.db
          .prepare(
            "UPDATE managed_account_policy SET accounting_tz=? WHERE account_id=? AND accounting_tz IS NULL",
          )
          .run(accountingTz, valid.account_id);
      return toReservation(this.reservationRow(callId)!);
    });
  }

  /**
   * Compare-and-set `reserved -> dispatched` under current trusted constraints.
   * A pre-existing dispatched/settled/released row is never treated as success:
   * only a fresh CAS is permission for the caller to execute.
   */
  mark(callId: string, currentLimits: ManagedLimits): ManagedReservation {
    this.assertNotPaused();
    const limits = validateManagedLimits(currentLimits);
    return this.tx(() => {
      const now = this.clock();
      const row = this.reservationRow(callId);
      if (!row)
        throw new BrainError("NOT_FOUND", "Unknown managed dispatch.", 404);
      if (row.state === "dispatched")
        throw new BrainError(
          "ALREADY_DISPATCHED",
          "This managed dispatch was already marked as sent.",
          409,
        );
      if (row.state !== "reserved")
        throw new BrainError(
          "INVALID_STATE",
          "Only a reserved managed dispatch can be marked as sent.",
          409,
        );
      const account = this.control.account(row.account_id);
      if (!account || account.state !== "active")
        throw new BrainError("UNAUTHORIZED", "Managed account unavailable.", 401);
      if (this.isBlocked())
        throw new BrainError(
          "BUDGET_BLOCKED",
          "Managed paid processing is blocked until the recorded reason is reconciled.",
          409,
        );
      if (limits.time_zone !== row.accounting_tz)
        throw new BrainError(
          "ACCOUNTING_TIMEZONE_FROZEN",
          "The accounting time zone is frozen and cannot change without an explicit migration.",
          409,
        );
      const iso = now.toISOString();
      const period = this.periodRow(row.account_period_id);
      if (
        !period ||
        period.state !== "active" ||
        iso < period.starts_at ||
        iso >= period.ends_at ||
        row.service_day !== utcDay(now) ||
        row.user_day !== accountingDay(now, row.accounting_tz)
      )
        throw new BrainError(
          "PERIOD_EXPIRED",
          "This managed admission period is no longer current; it will not be sent.",
          409,
        );
      const policy = this.accountPolicyRow(row.account_id);
      const serviceDaily = this.servicePolicyRow()?.daily_micro_usd ?? 0;
      const effectivePerJob = Math.min(
        Number(row.stored_per_job_micro_usd),
        limits.per_job_micro_usd,
        policy?.per_job_micro_usd ?? 0,
      );
      const effectiveUserDaily = Math.min(
        Number(row.stored_user_daily_micro_usd),
        limits.user_daily_micro_usd,
        policy?.user_daily_micro_usd ?? 0,
      );
      // A zero cap in any dimension denies a mark too.
      if (effectivePerJob <= 0)
        throw budget("No managed per-job allowance is configured.");
      if (effectiveUserDaily <= 0)
        throw budget("No managed daily allowance is configured.");
      if (period.allowance_micro_usd <= 0)
        throw budget("The managed allowance period has no allowance.");
      if (serviceDaily <= 0)
        throw budget("Managed processing has no service allowance.");
      // This row is already counted in every unresolved sum; no extra debit.
      if (
        this.jobCommitted(row.account_id, row.job_id) > effectivePerJob ||
        this.userDayCommitted(row.account_id, row.user_day) > effectiveUserDaily ||
        this.accountPeriodCommitted(row.account_id, row.account_period_id) >
          period.allowance_micro_usd ||
        this.serviceDayCommitted(row.service_day) > serviceDaily
      )
        throw budget("The current managed spending limits no longer admit this call.");
      const result = this.db
        .prepare(
          "UPDATE managed_reservations SET state='dispatched',marked_at=? WHERE call_id=? AND state='reserved'",
        )
        .run(iso, callId);
      if (Number(result.changes) !== 1)
        throw new BrainError(
          "DISPATCH_CONFLICT",
          "The managed dispatch changed concurrently.",
          409,
        );
      return toReservation(this.reservationRow(callId)!);
    });
  }

  /**
   * Records a validated known actual cost even after the account, period or
   * lease is gone. Never fabricates a charge and never re-checks a period.
   */
  settleKnown(callId: string, actualMicroUsd: number): ManagedReservation {
    const actual = validateActualMicroUsd(actualMicroUsd);
    return this.tx(() => {
      const now = this.clock();
      const row = this.reservationRow(callId);
      if (!row)
        throw new BrainError("NOT_FOUND", "Unknown managed dispatch.", 404);
      if (row.state === "settled") {
        if (Number(row.actual_micro_usd) === actual) return toReservation(row);
        throw new BrainError(
          "SETTLEMENT_CONFLICT",
          "This managed dispatch was already settled with a different amount.",
          409,
        );
      }
      if (row.state !== "dispatched")
        throw new BrainError(
          "INVALID_STATE",
          "Mark the managed dispatch as sent before settling it.",
          409,
        );
      this.db
        .prepare(
          "UPDATE managed_reservations SET state='settled',actual_micro_usd=?,settled_at=? WHERE call_id=? AND state='dispatched'",
        )
        .run(actual, now.toISOString(), callId);
      if (actual > Number(row.reserved_micro_usd)) {
        const over = actual - Number(row.reserved_micro_usd);
        this.db
          .prepare(
            "INSERT INTO managed_service_blocks(service,call_id,account_id,over_micro_usd,at) VALUES(?,?,?,?,?) ON CONFLICT(service) DO UPDATE SET call_id=excluded.call_id,account_id=excluded.account_id,over_micro_usd=excluded.over_micro_usd,at=excluded.at",
          )
          .run(SERVICE, callId, row.account_id, over, now.toISOString());
      }
      return toReservation(this.reservationRow(callId)!);
    });
  }

  releaseUndispatched(callId: string): ManagedReservation {
    return this.tx(() => {
      const row = this.reservationRow(callId);
      if (!row)
        throw new BrainError("NOT_FOUND", "Unknown managed dispatch.", 404);
      if (row.state === "released") return toReservation(row);
      if (row.state !== "reserved")
        throw new BrainError(
          "INVALID_STATE",
          "Only a reserved, undispatched managed call can be released.",
          409,
        );
      this.db
        .prepare(
          "UPDATE managed_reservations SET state='released' WHERE call_id=? AND state='reserved'",
        )
        .run(callId);
      return toReservation(this.reservationRow(callId)!);
    });
  }

  // ------------------------------------------------------------------- reads

  readReceipt(callId: string): ManagedMoneyReceipt {
    const row = this.reservationRow(callId);
    if (!row)
      throw new BrainError("NOT_FOUND", "Unknown managed dispatch.", 404);
    return toReceipt(row);
  }

  linkProjection(callId: string, projectionCallId: string): void {
    if (
      typeof projectionCallId !== "string" ||
      projectionCallId.length === 0 ||
      projectionCallId.length > 200
    )
      throw new BrainError("INVALID_INPUT", "Invalid projection id.", 400);
    this.tx(() => {
      const row = this.reservationRow(callId);
      if (!row)
        throw new BrainError("NOT_FOUND", "Unknown managed dispatch.", 404);
      if (
        row.projection_call_id !== null &&
        row.projection_call_id !== projectionCallId
      )
        throw new BrainError(
          "DISPATCH_CONFLICT",
          "This managed dispatch is already linked to another projection.",
          409,
        );
      this.db
        .prepare(
          "UPDATE managed_reservations SET projection_call_id=? WHERE call_id=? AND (projection_call_id IS NULL OR projection_call_id=?)",
        )
        .run(projectionCallId, callId, projectionCallId);
    });
  }

  receiptByProjection(projectionCallId: string): ManagedReservation | undefined {
    if (typeof projectionCallId !== "string" || !projectionCallId)
      return undefined;
    const row = this.db
      .prepare("SELECT * FROM managed_reservations WHERE projection_call_id=?")
      .get(projectionCallId) as any;
    return row ? toReservation(row) : undefined;
  }

  /**
   * Read-only authoritative lookup by immutable slot. It performs no financial
   * transition and is used by the account-bound coordinator to find a central
   * row whose tenant projection has not been linked yet.
   */
  reservationForSlot(
    accountId: string,
    jobId: string,
    dispatchKey: string,
  ): ManagedReservation | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM managed_reservations WHERE account_id=? AND job_id=? AND dispatch_key=?",
      )
      .get(accountId, jobId, dispatchKey) as any;
    return row ? toReservation(row) : undefined;
  }

  /** Read-only authoritative latest reservation for one account job. */
  latestForJob(accountId: string, jobId: string): ManagedReservation | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM managed_reservations WHERE account_id=? AND job_id=? ORDER BY created_at DESC, call_id DESC LIMIT 1",
      )
      .get(accountId, jobId) as any;
    return row ? toReservation(row) : undefined;
  }

  /** Read-only: does this account's job carry an unresolved (non-released) call? */
  hasUnresolvedForJob(accountId: string, jobId: string): boolean {
    return !!this.db
      .prepare(
        "SELECT 1 AS present FROM managed_reservations WHERE account_id=? AND job_id=? AND state IN ('reserved','dispatched') LIMIT 1",
      )
      .get(accountId, jobId);
  }

  /** Read-only: settled actual for one account's user-day, without holds. */
  ownDaySettledMicroUsd(accountId: string, day: string): number {
    return checkedSum(
      this.rows("account_id=? AND user_day=? AND state='settled'", [
        accountId,
        day,
      ]).map((row) => Number(row.actual_micro_usd ?? 0)),
    );
  }

  /** Read-only: every unresolved (reserved|dispatched) hold for one account. */
  ownUnresolvedMicroUsd(accountId: string): number {
    return this.unresolvedCommitted(accountId);
  }

  flagReconciliationRequired(callId: string): void {
    this.tx(() => {
      const row = this.reservationRow(callId);
      if (!row)
        throw new BrainError("NOT_FOUND", "Unknown managed dispatch.", 404);
      this.db
        .prepare(
          "UPDATE managed_reservations SET reconciliation_required=1 WHERE call_id=?",
        )
        .run(callId);
    });
  }

  /**
   * Records a central settlement failure that could not be committed. It marks
   * the reservation for reconciliation AND sets a durable service-wide deny so
   * no account can admit further managed spend before an operator reconciles; a
   * mere per-account block would let another account reserve against a stale
   * under-count. It writes only the marker and never rewrites financial history.
   */
  flagSettlementFailure(callId: string): void {
    try {
      this.tx(() => {
        const row = this.reservationRow(callId);
        if (!row)
          throw new BrainError("NOT_FOUND", "Unknown managed dispatch.", 404);
        this.db
          .prepare(
            "UPDATE managed_reservations SET reconciliation_required=1 WHERE call_id=?",
          )
          .run(callId);
        this.db
          .prepare(
            "INSERT INTO managed_money_blocks(key,reason,at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET reason=excluded.reason,at=excluded.at",
          )
          .run(
            "reconciliation_required",
            "reconciliation_required",
            this.clock().toISOString(),
          );
      });
    } catch (error) {
      // The marker that would record the obligation may have been lost. Poison
      // the shared control handle so every reserve/mark (including through a new
      // store instance) fails closed for the rest of this process. Never cleared
      // on recovery; not a durable or multi-process guarantee.
      poisonedControls.add(this.control);
      throw new AccountingPersistenceError(
        "Managed spending was paused because a safety marker could not be persisted.",
        { cause: error },
      );
    }
  }

  accountStatus(accountId: string): ManagedAccountStatus {
    return this.tx(() => {
      const account = this.control.account(accountId);
      if (!account)
        throw new BrainError("NOT_FOUND", "Managed account unavailable.", 404);
      const now = this.clock();
      const period = this.activePeriod(accountId, now);
      const policy = this.accountPolicyRow(accountId);
      const serviceDay = utcDay(now);
      const tz = policy?.accounting_tz ?? null;
      const block = this.db
        .prepare("SELECT reason FROM managed_money_blocks LIMIT 1")
        .get() as { reason: string } | undefined;
      const serviceBlock = this.db
        .prepare("SELECT 1 AS present FROM managed_service_blocks LIMIT 1")
        .get() as { present: number } | undefined;
      const reconciliation = this.db
        .prepare(
          "SELECT 1 AS present FROM managed_reservations WHERE account_id=? AND reconciliation_required=1 LIMIT 1",
        )
        .get(accountId) as { present: number } | undefined;
      const status: ManagedAccountStatus = {
        account_id: accountId,
        active: account.state === "active",
        period,
        service: this.servicePolicyRow()
          ? toServicePolicy(this.servicePolicyRow()!)
          : null,
        policy: policy ? toAccountPolicy(policy) : null,
        committed: {
          account_period_micro_usd: period
            ? this.accountPeriodCommitted(accountId, period.period_id)
            : 0,
          service_day_micro_usd: this.serviceDayCommitted(serviceDay),
          user_day_micro_usd: tz
            ? this.userDayCommitted(accountId, accountingDay(now, tz))
            : this.unresolvedCommitted(accountId),
          unresolved_micro_usd: this.unresolvedCommitted(accountId),
        },
        blocked: !!block || !!serviceBlock,
        blocked_reason: block
          ? block.reason === "reconciliation_required"
            ? "reconciliation_required"
            : "restored_backup"
          : serviceBlock
            ? "overrun"
            : null,
        reconciliation_required: !!reconciliation,
      };
      // A poisoned shared handle reports paused even though the failed marker
      // write left no row to read.
      if (poisonedControls.has(this.control)) {
        status.blocked = true;
        status.blocked_reason = "reconciliation_required";
      }
      return status;
    });
  }

  // ------------------------------------------------------------- aggregates

  private rows(where: string, args: any[]): any[] {
    return this.db
      .prepare(
        `SELECT state,actual_micro_usd,reserved_micro_usd FROM managed_reservations WHERE ${where}`,
      )
      .all(...args) as any[];
  }

  private unresolvedCommitted(accountId: string): number {
    return checkedSum(
      this.rows("account_id=? AND state IN ('reserved','dispatched')", [
        accountId,
      ]).map((row) => Number(row.reserved_micro_usd)),
    );
  }

  private jobCommitted(accountId: string, jobId: string): number {
    return checkedSum(
      this.rows("account_id=? AND job_id=?", [accountId, jobId]).map((row) =>
        row.state === "settled"
          ? Number(row.actual_micro_usd ?? 0)
          : row.state === "reserved" || row.state === "dispatched"
            ? Number(row.reserved_micro_usd)
            : 0,
      ),
    );
  }

  private userDayCommitted(accountId: string, day: string): number {
    const settled = this.rows(
      "account_id=? AND user_day=? AND state='settled'",
      [accountId, day],
    ).map((row) => Number(row.actual_micro_usd ?? 0));
    return checkedSum([...settled, this.unresolvedCommitted(accountId)]);
  }

  private accountPeriodCommitted(accountId: string, periodId: string): number {
    const settled = this.rows(
      "account_id=? AND account_period_id=? AND state='settled'",
      [accountId, periodId],
    ).map((row) => Number(row.actual_micro_usd ?? 0));
    return checkedSum([...settled, this.unresolvedCommitted(accountId)]);
  }

  private serviceDayCommitted(day: string): number {
    const settled = this.rows("service_day=? AND state='settled'", [day]).map(
      (row) => Number(row.actual_micro_usd ?? 0),
    );
    const unresolved = this.rows("state IN ('reserved','dispatched')", []).map(
      (row) => Number(row.reserved_micro_usd),
    );
    return checkedSum([...settled, ...unresolved]);
  }

  private isBlocked(): boolean {
    return (
      !!this.db
        .prepare("SELECT 1 AS present FROM managed_money_blocks LIMIT 1")
        .get() ||
      !!this.db
        .prepare("SELECT 1 AS present FROM managed_service_blocks LIMIT 1")
        .get()
    );
  }

  // -------------------------------------------------------------- row loads

  private activePeriod(
    accountId: string,
    now: Date,
  ): AccountAllowancePeriod | null {
    const iso = now.toISOString();
    const row = this.db
      .prepare(
        "SELECT * FROM managed_account_periods WHERE account_id=? AND state='active' AND starts_at<=? AND ends_at>? ORDER BY starts_at DESC LIMIT 1",
      )
      .get(accountId, iso, iso) as any;
    return row ? toPeriod(row) : null;
  }

  private periodRow(periodId: string): any {
    return this.db
      .prepare("SELECT * FROM managed_account_periods WHERE period_id=?")
      .get(periodId);
  }

  private slotRow(accountId: string, jobId: string, dispatchKey: string): any {
    return this.db
      .prepare(
        "SELECT * FROM managed_reservations WHERE account_id=? AND job_id=? AND dispatch_key=?",
      )
      .get(accountId, jobId, dispatchKey);
  }

  private reservationRow(callId: string): any {
    return this.db
      .prepare("SELECT * FROM managed_reservations WHERE call_id=?")
      .get(callId);
  }

  private servicePolicyRow():
    | { service: string; daily_micro_usd: number; version: number; updated_at: string }
    | undefined {
    return this.db
      .prepare("SELECT * FROM managed_service_policy WHERE service=?")
      .get(SERVICE) as any;
  }

  private accountPolicyRow(accountId: string): any {
    return this.db
      .prepare("SELECT * FROM managed_account_policy WHERE account_id=?")
      .get(accountId);
  }
}

function toPeriod(row: any): AccountAllowancePeriod {
  return {
    period_id: row.period_id,
    account_id: row.account_id,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    allowance_micro_usd: Number(row.allowance_micro_usd),
    state: row.state,
    granted_at: row.granted_at,
    revoked_at: row.revoked_at ?? null,
  };
}

function toServicePolicy(row: any): ServicePolicy {
  return {
    service: row.service,
    daily_micro_usd: Number(row.daily_micro_usd),
    version: Number(row.version),
    updated_at: row.updated_at,
  };
}

function toAccountPolicy(row: any): AccountSpendingPolicy {
  return {
    account_id: row.account_id,
    per_job_micro_usd: Number(row.per_job_micro_usd),
    user_daily_micro_usd: Number(row.user_daily_micro_usd),
    accounting_tz: row.accounting_tz ?? null,
    version: Number(row.version),
    updated_at: row.updated_at,
  };
}

function toReservation(row: any): ManagedReservation {
  return {
    call_id: row.call_id,
    account_id: row.account_id,
    job_id: row.job_id,
    dispatch_key: row.dispatch_key,
    service: row.service,
    stage: row.stage,
    state: row.state as ManagedReservationState,
    reserved_micro_usd: Number(row.reserved_micro_usd),
    actual_micro_usd:
      row.actual_micro_usd === null || row.actual_micro_usd === undefined
        ? null
        : Number(row.actual_micro_usd),
    content_hash: row.content_hash,
    identity_hash: row.identity_hash,
    account_period_id: row.account_period_id,
    service_day: row.service_day,
    user_day: row.user_day,
    accounting_tz: row.accounting_tz,
    stored_per_job_micro_usd: Number(row.stored_per_job_micro_usd),
    stored_user_daily_micro_usd: Number(row.stored_user_daily_micro_usd),
    provider: row.provider,
    model: row.model,
    price_version: row.price_version,
    request_hash: row.request_hash,
    config_hash: row.config_hash,
    projection_call_id: row.projection_call_id ?? null,
    reconciliation_required: Number(row.reconciliation_required) === 1,
    created_at: row.created_at,
    marked_at: row.marked_at ?? null,
    settled_at: row.settled_at ?? null,
  };
}

function toReceipt(row: any): ManagedMoneyReceipt {
  return {
    call_id: row.call_id,
    state: row.state as ManagedReservationState,
    reserved_micro_usd: Number(row.reserved_micro_usd),
    actual_micro_usd:
      row.actual_micro_usd === null || row.actual_micro_usd === undefined
        ? null
        : Number(row.actual_micro_usd),
    reconciliation_required: Number(row.reconciliation_required) === 1,
    account_period_id: row.account_period_id,
    service_day: row.service_day,
    user_day: row.user_day,
  };
}
