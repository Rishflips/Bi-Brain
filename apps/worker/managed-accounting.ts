import type { Brain } from "../../packages/domain/service.ts";
import { BrainError } from "../../packages/domain/logic.ts";
import {
  DispatchLedger,
  paidProcessingBlockedSetting,
} from "../../packages/storage/spend.ts";
import { ManagedSpendingStore } from "../../packages/storage/managed-spending.ts";
import { readGuardSnapshot } from "../../packages/storage/managed-activation-state.ts";
import type { ActivationGuard } from "../../packages/domain/managed-activation.ts";
import type {
  ManagedDispatchSpec,
  ManagedLimits,
  ManagedReservation,
} from "../../packages/domain/managed-spend.ts";
import type {
  DispatchRecord,
  DispatchSpec,
  JobLease,
  SpendLimits,
} from "../../packages/domain/spend.ts";
import {
  assertSendGuardContext,
  readActivationGuardContext,
  type InstalledActivationPolicy,
} from "../../packages/runtime/managed-activation.ts";
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
    private readonly installed?: InstalledActivationPolicy,
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

  /**
   * Private in-memory map of the exact central AND tenant call ids produced by a
   * fresh reserve in THIS coordinator process. It lets after_reserve/before_mark/
   * after_mark tolerate only the current attempt slot; a new coordinator/tick has an
   * empty map, so a stranded nonterminal hold fails closed to an operator.
   */
  private readonly attempts = new Map<
    string,
    {
      central_call_id: string;
      tenant_call_id: string;
      owner: string;
      fence: number;
      spec: {
        job_id: string;
        dispatch_key: string;
        stage: DispatchSpec["stage"];
        reserved_micro_usd: number;
        provider: string;
        model: string;
        price_version: string;
        request_hash: string;
        config_hash: string;
      };
    }
  >();

  /**
   * Re-reads the trusted tenant job row and returns a FRESH lease limited to the
   * ORIGINAL owner/fence. The deadline may legitimately be extended by the worker
   * heartbeat, so it is refreshed (bounded to the same owner/fence) rather than
   * pinned to the first snapshot; an expired or foreign lease denies.
   */
  private refreshLease(jobId: string, owner: string, fence: number): JobLease {
    const row = this.brain.store.get<{
      status: string;
      lease_owner: string;
      lease_until: string | null;
      fence: number;
    }>("SELECT status,lease_owner,lease_until,fence FROM jobs WHERE id=?", jobId);
    if (
      !row ||
      row.status !== "running" ||
      row.lease_owner !== owner ||
      row.fence !== fence ||
      !row.lease_until
    )
      throw new BrainError(
        "BUDGET_BLOCKED",
        "The managed paid attempt lease is no longer current.",
        409,
      );
    if (Date.parse(row.lease_until) <= this.clock().getTime())
      throw new BrainError(
        "BUDGET_BLOCKED",
        "The managed paid attempt lease has expired.",
        409,
      );
    return { job_id: jobId, owner, fence, expires_at: row.lease_until };
  }

  private attemptKey(jobId: string, dispatchKey: string, stage: string): string {
    return `${jobId}|${dispatchKey}|${stage}`;
  }

  private kindOf(jobId: string): "brief" | "goal" {
    const row = this.brain.store.get<{ kind: string }>(
      "SELECT kind FROM jobs WHERE id=?",
      jobId,
    );
    if (!row)
      throw new BrainError(
        "INVALID_STATE",
        "Managed paid dispatch has no current job row.",
        409,
      );
    if (row.kind === "derive_brief") return "brief";
    if (row.kind === "review_changed_assumption") return "goal";
    throw new BrainError("INVALID_STATE", "Unknown managed paid job kind.", 409);
  }

  private guardFor(
    spec: {
      job_id: string;
      dispatch_key: string;
      stage: DispatchSpec["stage"];
      reserved_micro_usd: number;
      provider: string;
      model: string;
      price_version: string;
      request_hash: string;
      config_hash: string;
    },
    lease: JobLease,
    phase: ActivationGuard["phase"],
    centralCallId: string | null,
    tenantCallId: string | null,
  ): ActivationGuard | undefined {
    if (!this.installed) return undefined;
    return readActivationGuardContext({
      control: { db: this.central.control.db, path: this.central.control.path },
      installed: this.installed,
      accountId: this.accountId,
      kind: this.kindOf(spec.job_id),
      jobId: spec.job_id,
      dispatchKey: spec.dispatch_key,
      stage: spec.stage,
      lease,
      phase,
      centralCallId,
      tenantCallId,
      spec: {
        provider: spec.provider,
        model: spec.model,
        price_version: spec.price_version,
        request_hash: spec.request_hash,
        config_hash: spec.config_hash,
        reserved_micro_usd: spec.reserved_micro_usd,
      },
    });
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
    const key = this.attemptKey(spec.job_id, spec.dispatch_key, spec.stage);
    if (this.installed && this.attempts.has(key))
      throw new BrainError(
        "BUDGET_BLOCKED",
        "A managed paid attempt for this slot is already in progress.",
        409,
      );
    // Fresh trusted lease preflight BEFORE any central hold is inserted.
    if (this.installed && lease.job_id !== spec.job_id)
      throw new BrainError(
        "BUDGET_BLOCKED",
        "The managed paid lease does not belong to this job.",
        409,
      );
    const current = this.installed
      ? this.refreshLease(lease.job_id, lease.owner, lease.fence)
      : lease;
    const guard = this.guardFor(spec, current, "before_reserve", null, null);
    const central = this.central.reserve(
      {
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
      } satisfies ManagedDispatchSpec,
      guard,
    );
    this.binding(central.account_id);
    if (central.projection_call_id) {
      if (this.installed)
        throw new BrainError(
          "BUDGET_BLOCKED",
          "A managed paid attempt already exists for this slot.",
          409,
        );
      return this.toRecord(central);
    }
    const record = this.tenant.reserve(spec, lease, limits);
    this.central.linkProjection(central.call_id, record.call_id);
    this.attempts.set(key, {
      central_call_id: central.call_id,
      tenant_call_id: record.call_id,
      owner: current.owner,
      fence: current.fence,
      spec: {
        job_id: spec.job_id,
        dispatch_key: spec.dispatch_key,
        stage: spec.stage,
        reserved_micro_usd: spec.reserved_micro_usd,
        provider: spec.provider,
        model: spec.model,
        price_version: spec.price_version,
        request_hash: spec.request_hash,
        config_hash: spec.config_hash,
      },
    });
    return record;
  }

  markDispatched(callId: string, lease: JobLease): DispatchRecord {
    this.requireActive();
    const central = this.centralFor(callId);
    if (!this.installed) {
      // Low-level compatibility (bounded tests, local coordinator): no guard.
      this.central.mark(central.call_id, this.currentLimits());
      const record = this.tenant.markDispatched(callId, lease);
      this.requireActive();
      return record;
    }
    const key = this.attemptKey(central.job_id, central.dispatch_key, central.stage);
    const attempt = this.attempts.get(key);
    if (
      !attempt ||
      attempt.central_call_id !== central.call_id ||
      attempt.tenant_call_id !== callId ||
      attempt.owner !== lease.owner ||
      attempt.fence !== lease.fence
    )
      throw new BrainError(
        "BUDGET_BLOCKED",
        "No current coordinator attempt authorizes this dispatch.",
        409,
      );
    const current = this.refreshLease(central.job_id, attempt.owner, attempt.fence);
    const guard = this.guardFor(
      attempt.spec,
      current,
      "before_mark",
      attempt.central_call_id,
      attempt.tenant_call_id,
    );
    // A fresh central reserved -> dispatched CAS is the only permission to run.
    // An already-dispatched or settled centre throws here and must not be caught.
    this.central.mark(central.call_id, this.currentLimits(), guard);
    const record = this.tenant.markDispatched(callId, lease);
    // A revocation between the two marks cancels this invocation before any I/O.
    this.requireActive();
    return record;
  }

  /**
   * Final pre-I/O permission check. It requires the SAME coordinator attempt map
   * entry (exact central + tenant ids + original owner/fence), re-reads the ACTUAL
   * tenant job row (running, matching owner/fence, future deadline), and re-reads
   * the live frozen policy. Read-only, no central writes; a failure leaves the
   * marked hold in place.
   */
  assertCanExecute(callId: string, lease: JobLease): void {
    if (!this.installed) return; // local/self-hosted no-op
    this.requireActive();
    const central = this.centralFor(callId);
    if (central.state !== "dispatched")
      throw new BrainError(
        "BUDGET_BLOCKED",
        "The managed paid call is not dispatched.",
        409,
      );
    const key = this.attemptKey(central.job_id, central.dispatch_key, central.stage);
    const attempt = this.attempts.get(key);
    if (
      !attempt ||
      attempt.central_call_id !== central.call_id ||
      attempt.tenant_call_id !== callId ||
      attempt.owner !== lease.owner ||
      attempt.fence !== lease.fence
    )
      throw new BrainError(
        "BUDGET_BLOCKED",
        "No current coordinator attempt authorizes this call.",
        409,
      );
    // The ACTUAL current tenant job lease must still be live (a heartbeat may have
    // extended it; a stale/foreign/expired one denies).
    const current = this.refreshLease(central.job_id, attempt.owner, attempt.fence);
    const guard = this.guardFor(
      attempt.spec,
      current,
      "after_mark",
      central.call_id,
      callId,
    );
    assertSendGuardContext(guard!, this.installed.root, {
      db: this.central.control.db,
      path: this.central.control.path,
    });
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
    // Narrow post-settlement frozen-policy check: the known charge is already
    // recorded (central first, tenant independently); if the policy changed while
    // the call was in flight, discard the output rather than publish a proposal.
    // It never runs before settlement, never releases a permit, never caches unknown.
    if (this.installed) {
      const snapshot = readGuardSnapshot(
        { db: this.central.control.db, path: this.central.control.path },
        this.installed.root,
      );
      const frozen = this.installed.profile;
      const changed =
        snapshot.state !== "active" ||
        !snapshot.profile.enabled ||
        snapshot.profile.fingerprint !== frozen.fingerprint ||
        snapshot.profile.version !== frozen.version ||
        snapshot.profile.config_digest !== frozen.config_digest ||
        snapshot.profile.epoch !== frozen.epoch ||
        snapshot.profile.root_nonce !== frozen.root_nonce;
      if (changed)
        throw new BrainError(
          "PROVIDER_UNAVAILABLE",
          "The provider output was discarded because managed processing changed. Any known charge was retained.",
          503,
        );
    }
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
