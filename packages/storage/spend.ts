import { randomUUID } from "node:crypto";
import type { Storage } from "./index.ts";
import { BrainError } from "../domain/logic.ts";
import {
  accountingDay,
  checkedSum,
  dispatchIdentityHash,
  safeAdd,
  validateActualMicroUsd,
  validateDispatchSpec,
  validateJobLease,
  validateJobLeaseShape,
  validateSpendLimits,
  type DispatchRecord,
  type DispatchSpec,
  type JobLease,
  type SpendLimits,
  type SpendSummary,
} from "../domain/spend.ts";

/** Durable setting names owned by the ledger. */
export const accountingTimeZoneSetting = "dispatch_accounting_time_zone";
export const paidProcessingBlockedSetting = "paid_processing_blocked";

/**
 * Internal persistence boundary for per-dispatch paid accounting.
 *
 * It is not a transport or an authorization endpoint: the caller must already
 * hold a managed identity/job authorization before invoking it. All state
 * transitions run in short immediate SQLite transactions and every model call
 * stays outside those transactions.
 */
export class DispatchLedger {
  constructor(
    private readonly store: Storage,
    private readonly clock: () => Date,
  ) {}

  /**
   * Admits a logical dispatch slot against cumulative job spend and daily
   * settled spend plus every unresolved hold. Returns the existing record for a
   * duplicate slot with identical immutable content; it is never permission to
   * send twice. A changed slot, an existing legacy reservation, an expired
   * lease, a cap overrun, a frozen time zone change or an active reconciliation
   * block all fail.
   */
  reserve(spec: DispatchSpec, lease: JobLease, limits: SpendLimits): DispatchRecord {
    const validSpec = validateDispatchSpec(spec);
    const validLimits = validateSpendLimits(limits);
    // Shape-only and cross-field checks may run before the lock, but the
    // authoritative lease expiry and every timestamp are sampled inside the
    // transaction after BEGIN IMMEDIATE acquires the write lock.
    const leaseShape = validateJobLeaseShape(lease);
    if (leaseShape.job_id !== validSpec.job_id)
      throw new BrainError("INVALID_INPUT", "Lease does not match the job.", 400);
    return this.store.transaction(() => {
      const now = this.clock();
      const validLease = validateJobLease(leaseShape, now);
      this.requireCurrentLease(validSpec.job_id, validLease, now);

      const legacy = this.store.get(
        "SELECT 1 AS present FROM reservations WHERE job_id=?",
        validSpec.job_id,
      );
      if (legacy)
        throw new BrainError(
          "BUDGET_EXHAUSTED",
          "This job already has a legacy accounting record; inspect it before dispatching.",
          409,
        );

      const identity = dispatchIdentityHash(validSpec);
      const existing = this.store.get(
        "SELECT * FROM provider_dispatches WHERE job_id=? AND dispatch_key=?",
        validSpec.job_id,
        validSpec.dispatch_key,
      );
      if (existing) {
        if (existing.identity_hash !== identity)
          throw new BrainError(
            "DISPATCH_CONFLICT",
            "This dispatch slot already exists with different content.",
            409,
          );
        return toRecord(existing);
      }

      this.assertNotBlocked();

      const frozen =
        this.store.setting<string | null>(accountingTimeZoneSetting, null) ??
        validLimits.time_zone;
      if (frozen !== validLimits.time_zone)
        throw new BrainError(
          "ACCOUNTING_TIMEZONE_FROZEN",
          "The accounting time zone is frozen and cannot change without an explicit migration.",
          409,
        );

      const day = accountingDay(now, frozen);
      const { settled, unresolved } = this.dailyCommitted(day);
      const perJob = this.jobCommitted(validSpec.job_id);

      if (
        safeAdd(perJob, validSpec.reserved_micro_usd) >
        validLimits.per_job_micro_usd
      )
        throw new BrainError(
          "BUDGET_EXHAUSTED",
          "This job has reached its spending cap.",
          409,
        );
      if (
        safeAdd(safeAdd(settled, unresolved), validSpec.reserved_micro_usd) >
        validLimits.daily_micro_usd
      )
        throw new BrainError(
          "BUDGET_EXHAUSTED",
          "Today's spending cap is reached. Your original is saved.",
          409,
        );

      const callId = randomUUID();
      this.store.run(
        `INSERT INTO provider_dispatches(
          call_id,job_id,dispatch_key,stage,state,reserved_micro_usd,actual_micro_usd,
          provider,model,price_version,request_hash,config_hash,identity_hash,
          budget_day,time_zone,created_at,dispatched_at,settled_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        callId,
        validSpec.job_id,
        validSpec.dispatch_key,
        validSpec.stage,
        "reserved",
        validSpec.reserved_micro_usd,
        null,
        validSpec.provider,
        validSpec.model,
        validSpec.price_version,
        validSpec.request_hash,
        validSpec.config_hash,
        identity,
        day,
        frozen,
        now.toISOString(),
        null,
        null,
      );
      if (this.store.setting<string | null>(accountingTimeZoneSetting, null) === null)
        this.store.set(accountingTimeZoneSetting, frozen);
      return this.get(callId)!;
    });
  }

  /**
   * Compare-and-set from `reserved` to `dispatched` under a current lease.
   * Commit happens before any network I/O; a second call fails.
   */
  markDispatched(callId: string, lease: JobLease): DispatchRecord {
    const leaseShape = validateJobLeaseShape(lease);
    return this.store.transaction(() => {
      const now = this.clock();
      const validLease = validateJobLease(leaseShape, now);
      const row = this.get(callId);
      if (!row)
        throw new BrainError("NOT_FOUND", "Unknown dispatch.", 404);
      if (row.job_id !== validLease.job_id)
        throw new BrainError("INVALID_INPUT", "Lease does not match the job.", 400);
      this.requireCurrentLease(row.job_id, validLease, now);
      if (row.state === "dispatched")
        throw new BrainError(
          "ALREADY_DISPATCHED",
          "This dispatch was already marked as sent.",
          409,
        );
      if (row.state !== "reserved")
        throw new BrainError(
          "INVALID_STATE",
          "Only a reserved dispatch can be marked as sent.",
          409,
        );
      // A durable reconciliation block also forbids already-reserved calls from
      // leaking a paid dispatch; they can still be released, but never sent.
      this.assertNotBlocked();
      const result = this.store.run(
        "UPDATE provider_dispatches SET state='dispatched',dispatched_at=? WHERE call_id=? AND state='reserved'",
        now.toISOString(),
        callId,
      );
      if (Number(result.changes) !== 1)
        throw new BrainError(
          "DISPATCH_CONFLICT",
          "The dispatch changed concurrently.",
          409,
        );
      return this.get(callId)!;
    });
  }

  /**
   * Records validated actual cost. Works even after job cancellation or lease
   * loss. A repeated identical settlement is idempotent; a conflicting one
   * fails. Unknown or over-reservation cost is retained, never discarded.
   */
  settle(callId: string, actualMicroUsd: number): DispatchRecord {
    const actual = validateActualMicroUsd(actualMicroUsd);
    const now = this.clock();
    return this.store.transaction(() => {
      const row = this.get(callId);
      if (!row) throw new BrainError("NOT_FOUND", "Unknown dispatch.", 404);
      if (row.state === "settled") {
        if (row.actual_micro_usd === actual) return row;
        throw new BrainError(
          "SETTLEMENT_CONFLICT",
          "This dispatch was already settled with a different amount.",
          409,
        );
      }
      if (row.state === "released")
        throw new BrainError(
          "INVALID_STATE",
          "A released dispatch cannot be settled.",
          409,
        );
      if (row.state === "reserved")
        throw new BrainError(
          "INVALID_STATE",
          "Mark the dispatch as sent before settling it.",
          409,
        );
      const result = this.store.run(
        "UPDATE provider_dispatches SET state='settled',actual_micro_usd=?,settled_at=? WHERE call_id=? AND state='dispatched'",
        actual,
        now.toISOString(),
        callId,
      );
      if (Number(result.changes) !== 1)
        throw new BrainError(
          "DISPATCH_CONFLICT",
          "The dispatch changed concurrently.",
          409,
        );
      if (actual > row.reserved_micro_usd)
        this.store.set(paidProcessingBlockedSetting, {
          call_id: callId,
          job_id: row.job_id,
          at: now.toISOString(),
          over_micro_usd: actual - row.reserved_micro_usd,
        });
      return this.get(callId)!;
    });
  }

  /**
   * Compare-and-set release of a `reserved` dispatch. It can never release a
   * `dispatched` (or settled) record and cannot race a successful dispatch.
   * Releasing an already released record is idempotent.
   */
  releaseUndispatched(callId: string): DispatchRecord {
    return this.store.transaction(() => {
      const row = this.get(callId);
      if (!row) throw new BrainError("NOT_FOUND", "Unknown dispatch.", 404);
      if (row.state === "released") return row;
      if (row.state !== "reserved")
        throw new BrainError(
          "INVALID_STATE",
          "Only a reserved, undispatched call can be released.",
          409,
        );
      const result = this.store.run(
        "UPDATE provider_dispatches SET state='released' WHERE call_id=? AND state='reserved'",
        callId,
      );
      if (Number(result.changes) !== 1)
        throw new BrainError(
          "DISPATCH_CONFLICT",
          "The dispatch changed concurrently.",
          409,
        );
      return this.get(callId)!;
    });
  }

  /**
   * Conservative cumulative spend for one job: settled actual plus unresolved
   * holds plus legacy rows. Unknown usage is counted, not shown as zero.
   */
  jobSpend(jobId: string): number {
    return this.jobCommitted(jobId);
  }

  /** Read-only view of the current accounting window. */
  summary(limits: SpendLimits): SpendSummary {
    const validLimits = validateSpendLimits(limits);
    const frozen = this.store.setting<string | null>(accountingTimeZoneSetting, null);
    const timeZone = frozen ?? validLimits.time_zone;
    const day = accountingDay(this.clock(), timeZone);
    const { settled, unresolved } = this.dailyCommitted(day);
    const committed = safeAdd(settled, unresolved);
    return {
      time_zone: frozen,
      budget_day: day,
      per_job_limit_micro_usd: validLimits.per_job_micro_usd,
      daily_limit_micro_usd: validLimits.daily_micro_usd,
      settled_micro_usd: settled,
      unresolved_micro_usd: unresolved,
      committed_micro_usd: committed,
      remaining_micro_usd: Math.max(0, validLimits.daily_micro_usd - committed),
      blocked: this.store.setting<unknown>(paidProcessingBlockedSetting, null) !== null,
      provider_dispatches: Number(
        this.store.get("SELECT count(*) AS n FROM provider_dispatches")?.n ?? 0,
      ),
      legacy_reservations: Number(
        this.store.get("SELECT count(*) AS n FROM reservations")?.n ?? 0,
      ),
    };
  }

  get(callId: string): DispatchRecord | undefined {
    const row = this.store.get(
      "SELECT * FROM provider_dispatches WHERE call_id=?",
      callId,
    );
    return row ? toRecord(row) : undefined;
  }

  /** Narrow receipt read used by the injected accounting seam. */
  readReceipt(callId: string): DispatchRecord | undefined {
    return this.get(callId);
  }

  private requireCurrentLease(
    jobId: string,
    lease: JobLease,
    now: Date,
  ): void {
    const job = this.store.get(
      "SELECT status,fence,lease_owner,lease_until FROM jobs WHERE id=?",
      jobId,
    );
    if (!job) throw new BrainError("NOT_FOUND", "Unknown job.", 404);
    if (
      job.status !== "running" ||
      job.lease_owner !== lease.owner ||
      job.fence !== lease.fence
    )
      throw new BrainError(
        "LEASE_LOST",
        "This worker no longer holds the job.",
        409,
      );
    if (!job.lease_until || Date.parse(job.lease_until) <= now.getTime())
      throw new BrainError(
        "LEASE_EXPIRED",
        "The worker lease has expired.",
        409,
      );
  }

  private assertNotBlocked(): void {
    if (this.store.setting<unknown>(paidProcessingBlockedSetting, null) !== null)
      throw new BrainError(
        "BUDGET_BLOCKED",
        "Paid processing is blocked until a settlement is reconciled.",
        409,
      );
  }

  private jobCommitted(jobId: string): number {
    const parts: number[] = [];
    for (const row of this.store.all(
      "SELECT state,actual_micro_usd,reserved_micro_usd FROM provider_dispatches WHERE job_id=?",
      jobId,
    )) {
      if (row.state === "settled") parts.push(Number(row.actual_micro_usd ?? 0));
      else if (row.state === "reserved" || row.state === "dispatched")
        parts.push(Number(row.reserved_micro_usd));
    }
    for (const row of this.store.all(
      "SELECT status,reserved,actual FROM reservations WHERE job_id=?",
      jobId,
    )) {
      if (row.status === "held") parts.push(Number(row.reserved));
      else parts.push(Number(row.actual));
    }
    return checkedSum(parts);
  }

  private dailyCommitted(day: string): { settled: number; unresolved: number } {
    const settled: number[] = [];
    const unresolved: number[] = [];
    for (const row of this.store.all(
      "SELECT state,actual_micro_usd,reserved_micro_usd,budget_day FROM provider_dispatches",
    )) {
      if (row.state === "settled") {
        if (row.budget_day === day)
          settled.push(Number(row.actual_micro_usd ?? 0));
      } else if (row.state === "reserved" || row.state === "dispatched")
        unresolved.push(Number(row.reserved_micro_usd));
    }
    for (const row of this.store.all(
      "SELECT day,status,reserved,actual FROM reservations",
    )) {
      if (row.status === "held") unresolved.push(Number(row.reserved));
      else if (row.day === day) settled.push(Number(row.actual));
    }
    return { settled: checkedSum(settled), unresolved: checkedSum(unresolved) };
  }
}

function toRecord(row: any): DispatchRecord {
  return {
    call_id: row.call_id,
    job_id: row.job_id,
    dispatch_key: row.dispatch_key,
    stage: row.stage,
    state: row.state,
    reserved_micro_usd: Number(row.reserved_micro_usd),
    actual_micro_usd:
      row.actual_micro_usd === null || row.actual_micro_usd === undefined
        ? null
        : Number(row.actual_micro_usd),
    provider: row.provider,
    model: row.model,
    price_version: row.price_version,
    request_hash: row.request_hash,
    config_hash: row.config_hash,
    budget_day: row.budget_day,
    time_zone: row.time_zone,
    created_at: row.created_at,
    dispatched_at: row.dispatched_at ?? null,
    settled_at: row.settled_at ?? null,
  };
}
