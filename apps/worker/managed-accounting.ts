import type { Brain } from "../../packages/domain/service.ts";
import { BrainError } from "../../packages/domain/logic.ts";
import {
  DispatchLedger,
  paidProcessingBlockedSetting,
} from "../../packages/storage/spend.ts";
import { ManagedSpendingStore } from "../../packages/storage/managed-spending.ts";
import type {
  ManagedLimits,
  ManagedReservation,
} from "../../packages/domain/managed-spend.ts";
import type {
  DispatchRecord,
  DispatchSpec,
  JobLease,
  SpendLimits,
} from "../../packages/domain/spend.ts";
import type { DispatchAccounting } from "./accounting.ts";

const reconcile = (message: string) =>
  new BrainError("BUDGET_BLOCKED", message, 409);

/**
 * Account-bound managed accounting coordinator.
 *
 * It is constructed from the trusted pinned runtime brain, so its account id is
 * `brain.tenantId` — never a provider, browser, header or caller-supplied value.
 * It refuses to bind when the control store does not know that account, so an A
 * coordinator can never be attached to a B brain.
 *
 * The ordered sequence is central reserve → tenant reserve → strict projection
 * link, then central mark → tenant mark. Only a fresh central mark CAS permits
 * the caller to execute; an already-marked centre denies on retry or restart and
 * leaves a safe stranded hold. Settlement is central-first and the tenant
 * projection is attempted independently afterwards.
 */
export class ManagedDispatchAccounting implements DispatchAccounting {
  readonly accountId: string;
  private readonly tenant: DispatchLedger;
  constructor(
    private readonly central: ManagedSpendingStore,
    private readonly brain: Brain,
    private readonly clock: () => Date = brain.clock,
  ) {
    const accountId = brain.tenantId;
    if (!accountId)
      throw new BrainError(
        "INVALID_INPUT",
        "Managed accounting requires a tenant-bound brain.",
        400,
      );
    if (!central.control.account(accountId))
      throw new BrainError(
        "UNAUTHORIZED",
        "Managed accounting is not bound to this account.",
        401,
      );
    this.accountId = accountId;
    this.tenant = new DispatchLedger(brain.store, clock);
  }

  private binding(accountId: string): void {
    if (accountId !== this.accountId)
      throw new BrainError(
        "UNAUTHORIZED",
        "Managed accounting cannot read another account's money.",
        401,
      );
  }

  private requireActive(): void {
    if (this.brain.tenantId !== this.accountId)
      throw new BrainError(
        "UNAUTHORIZED",
        "Managed accounting is bound to a different brain.",
        401,
      );
    const account = this.central.control.account(this.accountId);
    if (!account || account.state !== "active")
      throw new BrainError("UNAUTHORIZED", "Managed account unavailable.", 401);
  }

  private currentLimits(): ManagedLimits {
    const prefs = this.brain.prefs(this.brain.ownerPrincipal());
    return {
      per_job_micro_usd: prefs.per_job_cap_micro_usd,
      user_daily_micro_usd: prefs.daily_cap_micro_usd,
      time_zone: prefs.time_zone,
    };
  }

  private toRecord(central: ManagedReservation): DispatchRecord {
    return {
      call_id: central.projection_call_id ?? central.call_id,
      job_id: central.job_id,
      dispatch_key: central.dispatch_key,
      stage: central.stage,
      state: central.state,
      reserved_micro_usd: central.reserved_micro_usd,
      actual_micro_usd: central.actual_micro_usd,
      provider: central.provider,
      model: central.model,
      price_version: central.price_version,
      request_hash: central.request_hash,
      config_hash: central.config_hash,
      budget_day: central.user_day,
      time_zone: central.accounting_tz,
      created_at: central.created_at,
      dispatched_at: central.marked_at,
      settled_at: central.settled_at,
    };
  }

  private centralFor(callId: string): ManagedReservation {
    const central = this.central.receiptByProjection(callId);
    if (!central)
      throw new BrainError("NOT_FOUND", "Unknown managed dispatch.", 404);
    this.binding(central.account_id);
    return central;
  }

  private matches(central: ManagedReservation, row: any): boolean {
    return (
      central.account_id === this.accountId &&
      central.job_id === row.job_id &&
      central.dispatch_key === row.dispatch_key &&
      central.stage === row.stage &&
      central.reserved_micro_usd === Number(row.reserved_micro_usd) &&
      central.provider === row.provider &&
      central.model === row.model &&
      central.price_version === row.price_version &&
      central.request_hash === row.request_hash &&
      central.config_hash === row.config_hash
    );
  }

  /**
   * No managed paid admission until every existing tenant paid record is proven
   * to map to a matching central row. The audit spans all of this tenant's
   * records, not only the current job, so an unknown older charge on another job
   * can never let a fresh job reset the account allowance. An unknown legacy
   * hold, an unmapped tenant dispatch or a restored tenant block requires an
   * operator, never an automatic free import. A legitimate crash orphan is linked
   * only when every immutable field matches, and a mapped record is never
   * re-executed.
   */
  private assertHistoryEligible(): void {
    const store = this.brain.store;
    if (store.setting(paidProcessingBlockedSetting, null) !== null)
      throw reconcile(
        "Paid processing is blocked for this account until an operator reconciles it.",
      );
    if (store.get("SELECT 1 FROM reservations LIMIT 1"))
      throw reconcile(
        "This account has legacy paid history that must be reconciled before managed dispatch.",
      );
    const rows = store.all<any>(
      "SELECT call_id,job_id,dispatch_key,stage,reserved_micro_usd,provider,model,price_version,request_hash,config_hash FROM provider_dispatches",
    );
    for (const row of rows) {
      const linked = this.central.receiptByProjection(row.call_id);
      if (linked) {
        this.binding(linked.account_id);
        if (!this.matches(linked, row))
          throw reconcile(
            "An existing paid record does not match its central mapping.",
          );
        continue;
      }
      const slot = this.central.reservationForSlot(
        this.accountId,
        row.job_id,
        row.dispatch_key,
      );
      if (!slot || !this.matches(slot, row))
        throw reconcile(
          "This account has an unmapped paid record that must be reconciled by an operator.",
        );
      this.binding(slot.account_id);
      this.central.linkProjection(slot.call_id, row.call_id);
    }
  }

  reserve(spec: DispatchSpec, lease: JobLease, limits: SpendLimits): DispatchRecord {
    this.requireActive();
    this.assertHistoryEligible();
    const central = this.central.reserve({
      account_id: this.accountId,
      job_id: spec.job_id,
      dispatch_key: spec.dispatch_key,
      stage: spec.stage,
      reserved_micro_usd: spec.reserved_micro_usd,
      provider: spec.provider,
      model: spec.model,
      price_version: spec.price_version,
      request_hash: spec.request_hash,
      config_hash: spec.config_hash,
      limits: {
        per_job_micro_usd: limits.per_job_micro_usd,
        user_daily_micro_usd: limits.daily_micro_usd,
        time_zone: limits.time_zone,
      },
    });
    this.binding(central.account_id);
    if (central.projection_call_id) {
      // A re-reserve returns the central authority mapped to the tenant call id,
      // even when the tenant projection has drifted.
      return this.toRecord(central);
    }
    const record = this.tenant.reserve(spec, lease, limits);
    this.central.linkProjection(central.call_id, record.call_id);
    return record;
  }

  markDispatched(callId: string, lease: JobLease): DispatchRecord {
    this.requireActive();
    const central = this.centralFor(callId);
    // A fresh central reserved -> dispatched CAS is the only permission to run.
    // An already-dispatched or settled centre throws here and must not be caught.
    this.central.mark(central.call_id, this.currentLimits());
    const record = this.tenant.markDispatched(callId, lease);
    // A revocation between the two marks cancels this invocation before any I/O.
    this.requireActive();
    return record;
  }

  settle(callId: string, actualMicroUsd: number): DispatchRecord {
    const central = this.centralFor(callId);
    let centralError: unknown;
    let markerError: unknown;
    let settled: ManagedReservation | undefined;
    try {
      settled = this.central.settleKnown(central.call_id, actualMicroUsd);
    } catch (error) {
      centralError = error;
      // A central settlement that cannot commit means a known charge is not
      // recorded centrally. Durably deny further managed admission service-wide;
      // a per-account block alone could let another account under-count it.
      try {
        this.central.flagSettlementFailure(central.call_id);
      } catch (persistError) {
        markerError = persistError;
      }
    }
    // The tenant projection is attempted independently even when the central
    // step failed, so a known actual charge is preserved.
    try {
      this.tenant.settle(callId, actualMicroUsd);
    } catch {
      try {
        this.central.flagReconciliationRequired(central.call_id);
      } catch {
        /* Money is unchanged; the account flag is best-effort. */
      }
    }
    // A failure to persist the global deny must not be swallowed: fail closed.
    if (markerError) throw markerError;
    if (centralError) throw centralError;
    return this.toRecord(settled!);
  }

  releaseUndispatched(callId: string): DispatchRecord {
    const central = this.centralFor(callId);
    const tenant = this.tenant.readReceipt(callId);
    if (!tenant || tenant.state !== "reserved" || central.state !== "reserved")
      throw new BrainError(
        "INVALID_STATE",
        "Only a reserved, undispatched managed call can be released.",
        409,
      );
    this.central.releaseUndispatched(central.call_id);
    return this.tenant.releaseUndispatched(callId);
  }

  readReceipt(callId: string): DispatchRecord | undefined {
    const central = this.central.receiptByProjection(callId);
    if (central) {
      this.binding(central.account_id);
      return this.toRecord(central);
    }
    // Legacy/local mapping preserved when there is no central row.
    return this.tenant.readReceipt(callId);
  }

  receiptForJob(jobId: string): DispatchRecord | undefined {
    const central = this.central.latestForJob(this.accountId, jobId);
    if (central) return this.toRecord(central);
    return this.tenantReceiptForJob(jobId);
  }

  hasUnresolved(jobId: string): boolean {
    if (this.central.hasUnresolvedForJob(this.accountId, jobId)) return true;
    const tenant = this.tenantReceiptForJob(jobId);
    return !!tenant && tenant.state !== "released";
  }

  private tenantReceiptForJob(jobId: string): DispatchRecord | undefined {
    const row = this.brain.store.get<{ call_id: string }>(
      "SELECT call_id FROM provider_dispatches WHERE job_id=? ORDER BY created_at DESC LIMIT 1",
      jobId,
    );
    return row ? this.tenant.readReceipt(row.call_id) : undefined;
  }
}
