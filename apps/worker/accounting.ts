import type {
  DispatchRecord,
  DispatchSpec,
  JobLease,
  SpendLimits,
} from "../../packages/domain/spend.ts";
import { BrainError } from "../../packages/domain/logic.ts";
import { DispatchLedger } from "../../packages/storage/spend.ts";
import type { Storage } from "../../packages/storage/index.ts";

/**
 * Narrow internal accounting seam for one paid dispatch.
 *
 * It is not a transport or an authorization endpoint. It only records and reads
 * money for a job the caller is already authorized to run: the account id is
 * never a caller-supplied argument, and it never grants provider authority.
 *
 * `accountId` is present only for a tenant-bound central coordinator; a local
 * single-owner brain leaves it undefined.
 */
export interface DispatchAccounting {
  readonly accountId?: string;
  reserve(spec: DispatchSpec, lease: JobLease, limits: SpendLimits): DispatchRecord;
  markDispatched(callId: string, lease: JobLease): DispatchRecord;
  /**
   * Optional final pre-I/O permission check, run directly before the single
   * provider call. A managed paid coordinator implements it (frozen-policy live
   * recheck); a local/self-hosted ledger leaves it undefined (no-op).
   */
  assertCanExecute?(callId: string, lease: JobLease): void;
  settle(callId: string, actualMicroUsd: number): DispatchRecord;
  releaseUndispatched(callId: string): DispatchRecord;
  readReceipt(callId: string): DispatchRecord | undefined;
  /**
   * Authoritative latest receipt for a job, available even before a call id was
   * returned (for example when the central reserve committed but the tenant
   * projection failed). For a local brain this preserves the legacy held/settled
   * tenant row mapping.
   */
  receiptForJob(jobId: string): DispatchRecord | undefined;
  /** True while the job has an unresolved (non-released) paid record. */
  hasUnresolved(jobId: string): boolean;
}

/**
 * Local single-owner accounting over the tenant `DispatchLedger`. Unchanged in
 * behavior from the pre-seam worker: it is the self-hosted money journal.
 */
export class LocalDispatchAccounting implements DispatchAccounting {
  private readonly ledger: DispatchLedger;
  constructor(
    private readonly store: Storage,
    private readonly clock: () => Date,
  ) {
    this.ledger = new DispatchLedger(store, clock);
  }
  reserve(spec: DispatchSpec, lease: JobLease, limits: SpendLimits) {
    return this.ledger.reserve(spec, lease, limits);
  }
  markDispatched(callId: string, lease: JobLease) {
    return this.ledger.markDispatched(callId, lease);
  }
  settle(callId: string, actualMicroUsd: number) {
    return this.ledger.settle(callId, actualMicroUsd);
  }
  releaseUndispatched(callId: string) {
    return this.ledger.releaseUndispatched(callId);
  }
  readReceipt(callId: string) {
    return this.ledger.readReceipt(callId);
  }
  receiptForJob(jobId: string) {
    const row = this.store.get<{ call_id: string }>(
      "SELECT call_id FROM provider_dispatches WHERE job_id=? ORDER BY created_at DESC LIMIT 1",
      jobId,
    );
    return row ? this.ledger.readReceipt(row.call_id) : undefined;
  }
  hasUnresolved(jobId: string) {
    return !!this.store.get(
      "SELECT 1 FROM provider_dispatches WHERE job_id=? AND state<>'released'",
      jobId,
    );
  }
}

const paidUnavailable = () =>
  new BrainError(
    "UNAUTHORIZED",
    "Managed paid work requires its account-bound central accounting.",
    401,
  );

/**
 * Fail-closed accounting for a tenant-bound brain that was constructed without
 * a central coordinator (for example a direct `new Worker(managedBrain)`). It
 * still serves extractive, unpaid work and can read the tenant journal for
 * receipts, but it can never fall back to local money for a paid dispatch.
 */
export class TenantOnlyAccounting implements DispatchAccounting {
  readonly accountId: string;
  private readonly reads: LocalDispatchAccounting;
  constructor(store: Storage, clock: () => Date, accountId: string) {
    this.accountId = accountId;
    this.reads = new LocalDispatchAccounting(store, clock);
  }
  reserve(): never {
    throw paidUnavailable();
  }
  markDispatched(): never {
    throw paidUnavailable();
  }
  settle(): never {
    throw paidUnavailable();
  }
  releaseUndispatched(): never {
    throw paidUnavailable();
  }
  readReceipt(callId: string) {
    return this.reads.readReceipt(callId);
  }
  receiptForJob(jobId: string) {
    return this.reads.receiptForJob(jobId);
  }
  hasUnresolved(jobId: string) {
    return this.reads.hasUnresolved(jobId);
  }
}
