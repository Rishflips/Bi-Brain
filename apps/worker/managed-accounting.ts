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
  assertDecisionSendGuardContext,
  assertSendGuardContext,
  readActivationGuardContext,
  readDecisionActivationGuardContext,
  type InstalledActivationPolicy,
  type InstalledDecisionPolicy,
} from "../../packages/runtime/managed-activation.ts";
import { readDecisionGuardSnapshot } from "../../packages/storage/managed-decision-activation-state.ts";
import type { DispatchAccounting } from "./accounting.ts";

const reconcile = (message: string) =>
  new BrainError("BUDGET_BLOCKED", message, 409);

/**
 * The closed set of frozen installed policies a coordinator may be bound to. A
 * legacy reasoning policy carries no `stage`; the decision policy carries an
 * explicit `stage:"decision"` discriminant. There is deliberately NO arbitrary
 * `allowedStages`/boolean permit: the stage a coordinator serves is fixed by the
 * single installed policy it was constructed with.
 */
type InstalledPolicy = InstalledActivationPolicy | InstalledDecisionPolicy;

function isDecisionPolicy(
  installed: InstalledPolicy | undefined,
): installed is InstalledDecisionPolicy {
  return !!installed && "stage" in installed && installed.stage === "decision";
}

/** Private immutable goal binding captured at decision reserve and re-checked. */
type DecisionGoalContext = {
  goal_id: string;
  entity_version: number;
  plan_version: number;
  /** The job's project; the bound goal must stay in the same project. */
  project_id: string;
};

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
    private readonly installed?: InstalledPolicy,
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
      /**
       * Decision-stage only: the immutable goal entity+plan version bound at
       * reserve and re-checked before mark and before I/O. Absent for a legacy
       * reasoning attempt.
       */
      goal?: DecisionGoalContext;
    }
  >();

  /** The frozen decision policy when this coordinator was built for that stage. */
  private decisionPolicy(): InstalledDecisionPolicy | undefined {
    return isDecisionPolicy(this.installed) ? this.installed : undefined;
  }

  /** The legacy reasoning policy when this coordinator was built for that stage. */
  private reasoningPolicy(): InstalledActivationPolicy | undefined {
    return this.installed && !isDecisionPolicy(this.installed)
      ? this.installed
      : undefined;
  }

  /**
   * The decision-stage owner must hold the RAW master consent AND the separate RAW
   * decision consent AND background help. These are re-read live at reserve, before
   * mark and before I/O; an explicit false or a raw false throws BEFORE any hold.
   */
  private requireDecisionConsent(): void {
    const owner = this.brain.ownerPrincipal();
    if (
      !this.brain.backgroundConsent(owner) ||
      !this.brain.decisionBackgroundConsent(owner) ||
      !this.brain.prefs(owner).enabled
    )
      throw reconcile("Decision preparation consent is not current.");
  }

  /**
   * Resolves the ACTUAL goal from the closed job payload and validates project
   * scope and purpose through the domain services (never a model/grant JSON). It
   * returns the goal entity version and plan version to bind at reserve.
   */
  private decisionGoalContext(jobId: string): DecisionGoalContext {
    const job = this.brain.store.get<{
      project_id: string;
      kind: string;
      payload: string;
    }>("SELECT project_id,kind,payload FROM jobs WHERE id=?", jobId);
    if (!job || job.kind !== "review_changed_assumption")
      throw reconcile(
        "The decision dispatch has no changed-assumption review job.",
      );
    let payload: any;
    try {
      payload = JSON.parse(job.payload);
    } catch {
      payload = null;
    }
    if (!payload || typeof payload !== "object" || typeof payload.goal_id !== "string")
      throw reconcile("The decision dispatch job payload is not a goal review.");
    const owner = this.brain.ownerPrincipal();
    const principal = payload.principal;
    // This slice serves BOUND OWNER jobs only. A scoped-agent proposal job is out
    // of scope; the principal must be this exact tenant-bound owner.
    if (
      !principal ||
      principal.kind !== "owner" ||
      (principal.tenantId ?? undefined) !== (owner.tenantId ?? undefined)
    )
      throw reconcile("The decision dispatch job principal is not this owner.");
    const goal = this.brain.entity(owner, payload.goal_id);
    if (goal.kind !== "goal" || goal.project_id !== job.project_id)
      throw reconcile("The decision dispatch goal is not the job's goal.");
    if (goal.data.status !== "active" || !goal.data.preparation_enabled)
      throw new BrainError("FORBIDDEN", "Goal preparation is disabled.", 403);
    return {
      goal_id: goal.id,
      entity_version: goal.version,
      plan_version: goal.data.plan_version ?? 0,
      project_id: job.project_id,
    };
  }

  /**
   * Re-reads the ACTUAL job payload/principal/project and the referenced goal, and
   * requires the SAME goal id, entity version, plan version and project as the
   * private snapshot captured at reserve. A later payload, principal or goal
   * reference change fails closed. The owner is the trusted bound
   * `brain.ownerPrincipal`, never re-derived from the payload as permission.
   */
  private requireBoundGoalCurrent(
    jobId: string,
    goal: DecisionGoalContext,
  ): void {
    const current = this.decisionGoalContext(jobId);
    if (
      current.goal_id !== goal.goal_id ||
      current.entity_version !== goal.entity_version ||
      current.plan_version !== goal.plan_version ||
      current.project_id !== goal.project_id
    )
      throw new BrainError(
        "SOURCE_STALE",
        "The bound goal or job context changed before the paid decision call.",
        409,
      );
  }

  /**
   * Re-reads the ACTUAL running tenant job row limited to the ORIGINAL owner/fence.
   * The deadline may be extended by the heartbeat, so it is refreshed (same
   * owner/fence) rather than pinned; an expired, foreign, non-running or
   * wrong-kind lease denies. The job kind must be the review job.
   */
  private requireDecisionJobLease(
    jobId: string,
    owner: string,
    fence: number,
  ): JobLease {
    const row = this.brain.store.get<{
      kind: string;
      status: string;
      lease_owner: string;
      lease_until: string | null;
      fence: number;
    }>("SELECT kind,status,lease_owner,lease_until,fence FROM jobs WHERE id=?", jobId);
    if (
      !row ||
      row.kind !== "review_changed_assumption" ||
      row.status !== "running" ||
      row.lease_owner !== owner ||
      row.fence !== fence ||
      !row.lease_until
    )
      throw new BrainError(
        "BUDGET_BLOCKED",
        "The decision paid attempt lease is no longer current.",
        409,
      );
    // Strict future deadline: a malformed/NaN timestamp must fail closed.
    if (!(Date.parse(row.lease_until) > this.clock().getTime()))
      throw new BrainError(
        "BUDGET_BLOCKED",
        "The decision paid attempt lease has expired.",
        409,
      );
    return { job_id: jobId, owner, fence, expires_at: row.lease_until };
  }

  /**
   * Full decision preflight: re-check the ACTUAL tenant job lease, both RAW
   * consents plus background help, and the bound goal version, then derive a fresh
   * closed decision guard for the requested phase. It never trusts caller input
   * for the goal, project or consent.
   */
  private decisionPreflight(
    policy: InstalledDecisionPolicy,
    goal: DecisionGoalContext,
    spec: {
      job_id: string;
      dispatch_key: string;
      reserved_micro_usd: number;
      provider: string;
      model: string;
      price_version: string;
      request_hash: string;
      config_hash: string;
    },
    owner: string,
    fence: number,
    phase: "before_reserve" | "after_reserve" | "before_mark" | "after_mark",
    centralCallId: string | null,
    tenantCallId: string | null,
  ): { lease: JobLease; guard: ReturnType<typeof readDecisionActivationGuardContext> } {
    const lease = this.requireDecisionJobLease(spec.job_id, owner, fence);
    this.requireDecisionConsent();
    this.requireBoundGoalCurrent(spec.job_id, goal);
    const guard = readDecisionActivationGuardContext({
      control: { db: this.central.control.db, path: this.central.control.path },
      installed: policy,
      accountId: this.accountId,
      jobId: spec.job_id,
      dispatchKey: spec.dispatch_key,
      stage: "decision",
      phase,
      lease,
      centralCallId,
      tenantCallId,
      now: this.clock(),
      clock: this.clock,
      spec: {
        provider: spec.provider,
        model: spec.model,
        price_version: spec.price_version,
        request_hash: spec.request_hash,
        config_hash: spec.config_hash,
        reserved_micro_usd: spec.reserved_micro_usd,
      },
    });
    return { lease, guard };
  }

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
    const policy = this.reasoningPolicy();
    if (!policy) return undefined;
    return readActivationGuardContext({
      control: { db: this.central.control.db, path: this.central.control.path },
      installed: policy,
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
    const decision = this.decisionPolicy();
    if (decision) {
      this.requireNoOutstandingPaidCall();
      return this.reserveDecision(decision, spec, lease, limits);
    }
    // A decision dispatch can NEVER use a coordinator that was not built with its
    // installed DECISION policy (reasoning-only or low-level).
    if (spec.stage === "decision")
      throw reconcile(
        "Decision preparation requires its installed decision policy.",
      );
    this.requireNoOutstandingPaidCall();
    return this.reserveReasoning(spec, lease, limits);
  }

  /**
   * Bounded, read-only check for any outstanding committed `dispatched` central
   * row across the shared service. It is the same service-wide admission barrier
   * the money store enforces, surfaced with its specific `usage_pending` reason
   * BEFORE any guard derivation or hold. It never opens a tenant database, never
   * runs a full audit and never mutates.
   */
  private requireNoOutstandingPaidCall(): void {
    const outstanding = this.central.control.db
      .prepare("SELECT 1 AS present FROM managed_reservations WHERE state='dispatched' LIMIT 1")
      .get();
    if (outstanding)
      throw reconcile(
        "Managed paid processing is paused while a previous call awaits settlement accounting.",
      );
  }

  private reserveReasoning(
    spec: DispatchSpec,
    lease: JobLease,
    limits: SpendLimits,
  ): DispatchRecord {
    const policy = this.reasoningPolicy();
    this.assertHistoryEligible();
    const key = this.attemptKey(spec.job_id, spec.dispatch_key, spec.stage);
    if (policy && this.attempts.has(key))
      throw new BrainError(
        "BUDGET_BLOCKED",
        "A managed paid attempt for this slot is already in progress.",
        409,
      );
    // Fresh trusted lease preflight BEFORE any central hold is inserted.
    if (policy && lease.job_id !== spec.job_id)
      throw new BrainError(
        "BUDGET_BLOCKED",
        "The managed paid lease does not belong to this job.",
        409,
      );
    const current = policy
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
      if (policy)
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

  /**
   * The decision reserve sequence: full tenant job/goal/lease/consent preflight,
   * central reserve with a fresh closed decision guard, tenant reserve, strict
   * projection link, then the private goal-binding attempt is recorded. A decision
   * dispatch can never fall back to the low-level unguarded path.
   */
  private reserveDecision(
    policy: InstalledDecisionPolicy,
    spec: DispatchSpec,
    lease: JobLease,
    limits: SpendLimits,
  ): DispatchRecord {
    if (spec.stage !== "decision")
      throw reconcile(
        "The installed decision policy only covers the decision stage.",
      );
    this.assertHistoryEligible();
    const key = this.attemptKey(spec.job_id, spec.dispatch_key, spec.stage);
    if (this.attempts.has(key))
      throw reconcile("A managed paid attempt for this slot is already in progress.");
    if (lease.job_id !== spec.job_id)
      throw reconcile("The managed paid lease does not belong to this job.");
    const goal = this.decisionGoalContext(spec.job_id);
    const preflight = this.decisionPreflight(
      policy,
      goal,
      spec,
      lease.owner,
      lease.fence,
      "before_reserve",
      null,
      null,
    );
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
      preflight.guard,
    );
    this.binding(central.account_id);
    if (central.projection_call_id)
      throw reconcile("A managed paid attempt already exists for this slot.");
    const record = this.tenant.reserve(spec, lease, limits);
    this.central.linkProjection(central.call_id, record.call_id);
    this.attempts.set(key, {
      central_call_id: central.call_id,
      tenant_call_id: record.call_id,
      owner: preflight.lease.owner,
      fence: preflight.lease.fence,
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
      goal,
    });
    return record;
  }

  markDispatched(callId: string, lease: JobLease): DispatchRecord {
    this.requireActive();
    const decision = this.decisionPolicy();
    if (decision) return this.markDecision(decision, callId, lease);
    const central = this.centralFor(callId);
    if (central.stage === "decision")
      throw reconcile(
        "Decision preparation requires its installed decision policy.",
      );
    return this.markReasoning(central, callId, lease);
  }

  private markReasoning(
    central: ManagedReservation,
    callId: string,
    lease: JobLease,
  ): DispatchRecord {
    const policy = this.reasoningPolicy();
    if (!policy) {
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
   * The decision mark: the private attempt map entry (exact central+tenant ids and
   * original owner/fence), the ACTUAL tenant job lease, both RAW consents plus
   * background help, and the bound goal entity+plan version are all re-checked
   * before a fresh `before_mark` decision guard authorizes the central CAS. A new
   * coordinator with an empty map can never adopt a stranded held slot.
   */
  private markDecision(
    policy: InstalledDecisionPolicy,
    callId: string,
    lease: JobLease,
  ): DispatchRecord {
    const central = this.centralFor(callId);
    if (central.stage !== "decision")
      throw reconcile(
        "The installed decision policy only covers the decision stage.",
      );
    const key = this.attemptKey(central.job_id, central.dispatch_key, central.stage);
    const attempt = this.attempts.get(key);
    if (
      !attempt ||
      !attempt.goal ||
      attempt.central_call_id !== central.call_id ||
      attempt.tenant_call_id !== callId ||
      attempt.owner !== lease.owner ||
      attempt.fence !== lease.fence
    )
      throw reconcile("No current decision coordinator attempt authorizes this dispatch.");
    const { guard } = this.decisionPreflight(
      policy,
      attempt.goal,
      attempt.spec,
      attempt.owner,
      attempt.fence,
      "before_mark",
      attempt.central_call_id,
      attempt.tenant_call_id,
    );
    this.central.mark(central.call_id, this.currentLimits(), guard);
    const record = this.tenant.markDispatched(callId, lease);
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
    // `callId` is the TENANT projection id; resolve the exact CENTRAL call id before the
    // mandatory pre-I/O funding re-check, which operates on the central ledger row.
    this.central.assertFundingForExecution(this.centralFor(callId).call_id);
    const decision = this.decisionPolicy();
    if (decision) {
      this.requireActive();
      return this.assertDecisionExecute(decision, callId, lease);
    }
    if (!this.reasoningPolicy()) {
      // Low-level compatibility: a no-op for non-decision rows, but a decision row
      // still requires the installed decision policy.
      const central = this.centralFor(callId);
      if (central.stage === "decision")
        throw reconcile(
          "Decision preparation requires its installed decision policy.",
        );
      return;
    }
    return this.assertReasoningExecute(callId, lease);
  }

  private assertReasoningExecute(callId: string, lease: JobLease): void {
    const policy = this.reasoningPolicy()!;
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
    assertSendGuardContext(guard!, policy.root, {
      db: this.central.control.db,
      path: this.central.control.path,
    });
  }

  /**
   * Final pre-I/O decision permission check: the private attempt map entry, the
   * ACTUAL tenant job lease, both RAW consents plus background help, and the bound
   * goal version must all still hold, a FRESH `after_mark` decision guard is derived
   * (readiness, opt-in, profile/audit/epoch, bounded self permit), and only then the
   * narrow `assertDecisionSendGuardContext` live snapshot is re-read. A failure
   * leaves the marked hold in place and the call is never sent.
   */
  private assertDecisionExecute(
    policy: InstalledDecisionPolicy,
    callId: string,
    lease: JobLease,
  ): void {
    const central = this.centralFor(callId);
    if (central.stage !== "decision")
      throw reconcile(
        "The installed decision policy only covers the decision stage.",
      );
    if (central.state !== "dispatched")
      throw reconcile("The decision paid call is not dispatched.");
    const key = this.attemptKey(central.job_id, central.dispatch_key, central.stage);
    const attempt = this.attempts.get(key);
    if (
      !attempt ||
      !attempt.goal ||
      attempt.central_call_id !== central.call_id ||
      attempt.tenant_call_id !== callId ||
      attempt.owner !== lease.owner ||
      attempt.fence !== lease.fence
    )
      throw reconcile("No current decision coordinator attempt authorizes this call.");
    const { guard } = this.decisionPreflight(
      policy,
      attempt.goal,
      attempt.spec,
      attempt.owner,
      attempt.fence,
      "after_mark",
      attempt.central_call_id,
      attempt.tenant_call_id,
    );
    assertDecisionSendGuardContext(guard, policy.root, {
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
    // Narrow post-settlement check: the known charge is already recorded (central
    // first, tenant independently). If the policy/consent/goal/lease/account changed
    // while the call was in flight, discard the output rather than publish a result.
    // It never runs before settlement, never releases a permit, never caches unknown,
    // and never re-runs the full `after_mark` financial guard (which needs a
    // dispatched row).
    if (central.stage === "decision") {
      const decision = this.decisionPolicy();
      const key = this.attemptKey(central.job_id, central.dispatch_key, central.stage);
      const attempt = this.attempts.get(key);
      if (
        !decision ||
        !attempt ||
        !attempt.goal ||
        attempt.central_call_id !== central.call_id
      )
        throw new BrainError(
          "PROVIDER_UNAVAILABLE",
          "The decision output was discarded because its authorized attempt is not current. Any known charge was retained.",
          503,
        );
      this.assertDecisionPostSettlement(
        decision,
        attempt.spec.job_id,
        attempt.goal,
        attempt.owner,
        attempt.fence,
      );
    } else if (this.reasoningPolicy()) {
      const policy = this.reasoningPolicy()!;
      const snapshot = readGuardSnapshot(
        { db: this.central.control.db, path: this.central.control.path },
        policy.root,
      );
      const frozen = policy.profile;
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

  /**
   * Decision-stage post-settlement permission (narrow, read-only, no new money
   * admission). It validates the frozen stage profile/version/fingerprint/epoch and
   * the CURRENT owner-active, both RAW consents, background help, the re-resolved
   * ACTUAL job payload/principal/project and bound goal entity+plan version, and the
   * original job lease with a future `lease_until`. Any change (including a lease
   * that expired during I/O) discards the output AFTER the known charge is already
   * persisted centrally and in the tenant; it never refunds, re-sends or re-admits.
   * It deliberately never re-runs the full `after_mark` financial guard, which needs
   * a still-dispatched row.
   */
  private assertDecisionPostSettlement(
    policy: InstalledDecisionPolicy,
    jobId: string,
    goal: DecisionGoalContext,
    owner: string,
    fence: number,
  ): void {
    const frozen = policy.profile;
    const snapshot = readDecisionGuardSnapshot(
      { db: this.central.control.db, path: this.central.control.path },
      policy.root,
    );
    const policyChanged =
      snapshot.state !== "active" ||
      !snapshot.profile.enabled ||
      snapshot.profile.fingerprint !== frozen.fingerprint ||
      snapshot.profile.version !== frozen.version ||
      snapshot.profile.config_digest !== frozen.config_digest ||
      snapshot.profile.epoch !== frozen.epoch ||
      snapshot.profile.root_nonce !== frozen.root_nonce;
    const account = this.central.control.account(this.accountId);
    const ownerActive = !!account && account.state === "active";
    const job = this.brain.store.get<{
      status: string;
      lease_owner: string;
      lease_until: string | null;
      fence: number;
    }>("SELECT status,lease_owner,lease_until,fence FROM jobs WHERE id=?", jobId);
    const until = job ? Date.parse(job.lease_until ?? "") : Number.NaN;
    const leaseCurrent =
      !!job &&
      job.status === "running" &&
      job.lease_owner === owner &&
      job.fence === fence &&
      until > this.clock().getTime();
    let consent = false;
    let contextCurrent = false;
    try {
      const ownerPrincipal = this.brain.ownerPrincipal();
      consent =
        this.brain.backgroundConsent(ownerPrincipal) &&
        this.brain.decisionBackgroundConsent(ownerPrincipal) &&
        this.brain.prefs(ownerPrincipal).enabled;
      // Re-resolve the ACTUAL job payload/principal/project and referenced goal;
      // a post-mark payload/principal/goal change discards the output.
      const current = this.decisionGoalContext(jobId);
      contextCurrent =
        current.goal_id === goal.goal_id &&
        current.entity_version === goal.entity_version &&
        current.plan_version === goal.plan_version &&
        current.project_id === goal.project_id;
    } catch {
      consent = false;
      contextCurrent = false;
    }
    if (
      policyChanged ||
      !ownerActive ||
      !leaseCurrent ||
      !consent ||
      !contextCurrent
    )
      throw new BrainError(
        "PROVIDER_UNAVAILABLE",
        "The decision output was discarded because processing changed. Any known charge was retained.",
        503,
      );
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

  /**
   * Exact account-scoped slot reader: the authoritative central row for this
   * account's (job, dispatch_key), or the tenant projection when no central row is
   * mapped. A decision (`dispatch_key:"decision"`) and a reasoning
   * (`dispatch_key:"reasoning"`) slot on the same job stay distinct, and another
   * account's row is never returned.
   */
  receiptForSlot(jobId: string, dispatchKey: string): DispatchRecord | undefined {
    const central = this.central.reservationForSlot(
      this.accountId,
      jobId,
      dispatchKey,
    );
    if (central) {
      this.binding(central.account_id);
      return this.toRecord(central);
    }
    const row = this.brain.store.get<{ call_id: string }>(
      "SELECT call_id FROM provider_dispatches WHERE job_id=? AND dispatch_key=? ORDER BY created_at DESC LIMIT 1",
      jobId,
      dispatchKey,
    );
    return row ? this.tenant.readReceipt(row.call_id) : undefined;
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
