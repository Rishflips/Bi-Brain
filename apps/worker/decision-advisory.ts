import type { Brain } from "../../packages/domain/service.ts";
import type { Principal } from "../../packages/contracts/index.ts";
import { BrainError, canonical } from "../../packages/domain/logic.ts";
import { detectSecrets } from "../../packages/storage/secrets.ts";
import {
  advisoryRecord,
  expectedDecisionInput,
  type AdvisoryQuestion,
} from "../../packages/domain/decision-advisory.ts";
import {
  markDecisionAttemptUnavailable,
  type AdvisoryAttemptRow,
} from "../../packages/storage/decision-advisory.ts";
import { AccountingPersistenceError } from "../../packages/storage/managed-spending.ts";
import type {
  PreparedDecisionEnvelope,
  PreparedDecisionProvider,
} from "../../packages/providers/prepared-decision.ts";
import type {
  DispatchSpec,
  JobLease,
  SpendLimits,
} from "../../packages/domain/spend.ts";
import type { DispatchAccounting } from "./accounting.ts";

/**
 * The explicit decision advisory stage of ONE existing owner review job.
 *
 * It is NOT a scheduler, a stage router or a permission source. It runs one
 * bounded, default-off advisory judgment on the same `review_changed_assumption`
 * job as the reasoning pass, using its OWN account-bound coordinator
 * (`dispatch_key:"decision"`, `stage:"decision"`). The reasoning pass keeps
 * `dispatch_key:"reasoning"` and its own independent authorization; an advisory
 * choice never changes whether reasoning runs.
 *
 * Ordered boundary: derive the CURRENT authorized question (service-owned), run a
 * full-goal secret scan, prepare the immutable adapter call OUTSIDE any
 * transaction, claim the durable attempt, guarded reserve, mark, a FRESH pre-I/O
 * source/goal/consent recheck, exactly ONE provider execute outside every
 * transaction, settle a known charge in BOTH ledgers, a post-settlement recheck,
 * then persist the advisory in one tenant transaction.
 *
 * Money rules: a known charge is settled before any publication; an unknown
 * after-mark attempt leaves its dispatched hold in place, is never refunded or
 * resent, and never calls reasoning. A pre-mark failure may release its reserved
 * hold by CAS. A fatal `AccountingPersistenceError` is NEVER swallowed: it
 * propagates so the managed worker fail-stops (S1 behavior).
 */

const JOB_KIND = "review_changed_assumption";
const DISPATCH_KEY = "decision";

export interface DecisionAdvisoryDeps {
  brain: Brain;
  /** The account-bound DECISION coordinator (built with its installed policy). */
  accounting: DispatchAccounting;
  /** Structural one-method adapter; the readiness-fenced wrapper is injected. */
  provider: Pick<PreparedDecisionProvider, "prepareDecision">;
  owner: Principal;
}

export type DecisionAdvisoryResult =
  | { status: "skipped"; reason: string }
  | { status: "advisory"; advisory_id: string }
  | { status: "unavailable" }
  | { status: "unknown" };

export async function runDecisionAdvisory(
  deps: DecisionAdvisoryDeps,
  job: { id: string; fence: number },
  leaseOwner: string,
  signal: AbortSignal,
): Promise<DecisionAdvisoryResult> {
  try {
    return await run(deps, job, leaseOwner, signal);
  } catch (error) {
    // A failed safety-marker write is a fatal managed condition: it must stop
    // managed scheduling and is never downgraded to a D-specific skip.
    if (error instanceof AccountingPersistenceError) throw error;
    return { status: "skipped", reason: "decision_unavailable" };
  }
}

function goalIdOf(brain: Brain, jobId: string): string | undefined {
  const row = brain.store.get<{
    project_id: string;
    kind: string;
    payload: string;
  }>("SELECT project_id,kind,payload FROM jobs WHERE id=?", jobId);
  if (!row || row.kind !== JOB_KIND) return undefined;
  try {
    const payload = JSON.parse(row.payload);
    return payload && typeof payload.goal_id === "string"
      ? payload.goal_id
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Deterministic secret scan over the FULL goal text the design bound: title,
 * success criteria, the private plan and its evidence refs. The question the
 * adapter receives omits the plan exactly like the reasoning path; the scan is
 * deliberately NOT loosened to match that omission.
 */
function goalHasSecret(brain: Brain, owner: Principal, goalId: string): boolean {
  let goal;
  try {
    goal = brain.entity(owner, goalId);
  } catch {
    return true;
  }
  if (goal.kind !== "goal") return true;
  const evidence = goal.data.plan_evidence;
  const planEvidence =
    evidence === undefined || evidence === null ? "" : JSON.stringify(evidence);
  return (
    detectSecrets(
      `${goal.data.title ?? ""}\n${goal.data.success_criteria ?? ""}\n${goal.data.plan ?? ""}\n${planEvidence}`,
    ).length > 0
  );
}

function stillCurrent(
  brain: Brain,
  owner: Principal,
  goalId: string,
  questionHash: string,
): boolean {
  try {
    const current = brain.decisionAdvisoryContext(owner, goalId);
    return current.ok && current.question.question_hash === questionHash;
  } catch {
    return false;
  }
}

/** Best-effort truthful `claimed -> unavailable`; a published attempt owns itself. */
function markUnavailable(brain: Brain, key: string): void {
  try {
    brain.store.transaction(() =>
      markDecisionAttemptUnavailable(brain.store, key, brain.clock),
    );
  } catch {
    /* published/absent or a concurrent state change owns the record */
  }
}

/**
 * Read-only proof that the EXACT tenant projection of a decision call is known
 * settled. The S1 coordinator's `receiptForSlot` returns the central financial
 * record, never the tenant proof: a central settlement can commit while its tenant
 * projection fails (the coordinator then flags reconciliation and still returns the
 * central record). Publication requires BOTH journals. No cross-database
 * transaction is opened; this is a narrow single-row read of the same database the
 * worker already owns.
 */
function tenantDecisionSettled(
  brain: Brain,
  input: {
    job_id: string;
    call_id: string;
    request_hash: string;
    config_hash: string;
    amount: number;
  },
): boolean {
  const row = brain.store.get<{
    call_id: string;
    job_id: string;
    dispatch_key: string;
    stage: string;
    state: string;
    actual_micro_usd: number | null;
    request_hash: string;
    config_hash: string;
  }>(
    "SELECT call_id,job_id,dispatch_key,stage,state,actual_micro_usd,request_hash,config_hash FROM provider_dispatches WHERE job_id=? AND dispatch_key=?",
    input.job_id,
    DISPATCH_KEY,
  );
  return (
    !!row &&
    row.call_id === input.call_id &&
    row.job_id === input.job_id &&
    row.dispatch_key === DISPATCH_KEY &&
    row.stage === "decision" &&
    row.state === "settled" &&
    typeof row.actual_micro_usd === "number" &&
    Number.isSafeInteger(row.actual_micro_usd) &&
    row.actual_micro_usd === input.amount &&
    row.request_hash === input.request_hash &&
    row.config_hash === input.config_hash
  );
}

/**
 * Recovery for an attempt that already exists for this question. It NEVER
 * reclaims, resends, adopts a private attempt map or creates a new financial hold.
 *
 * A `claimed` attempt (no entity yet) with an absent/released/settled ORIGINAL
 * slot becomes truthfully `unavailable`; any unknown/live original hold is left
 * held. A `published` attempt is adopted ONLY after the ORIGINAL job's exact
 * decision slot is known-settled with a non-null safe actual value AND its stored
 * whole-question identity (job/key/stage/request/config + goal/plan/project +
 * ordered source refs) still equals the CURRENT question; only then is the
 * owner-internal record loaded (which re-checks current authorization) and its
 * refs re-derived. Any mismatch is `unavailable` with no fabricated output.
 */
function recoverExisting(
  deps: DecisionAdvisoryDeps,
  row: AdvisoryAttemptRow,
  question: AdvisoryQuestion,
): DecisionAdvisoryResult {
  const { brain, accounting, owner } = deps;
  if (row.state === "claimed") {
    const slot = accounting.receiptForSlot(row.job_id, DISPATCH_KEY);
    if (!slot || slot.state === "released" || slot.state === "settled")
      markUnavailable(brain, row.idempotency_key);
    return { status: "unavailable" };
  }
  if (row.state !== "published" || !row.advisory_id)
    return { status: "unavailable" };
  // Validate the ORIGINAL job's exact decision slot BEFORE any entity read.
  const slot = accounting.receiptForSlot(row.job_id, DISPATCH_KEY);
  if (!slot || slot.state !== "settled") return { status: "unavailable" };
  if (slot.actual_micro_usd === null || !Number.isSafeInteger(slot.actual_micro_usd))
    return { status: "unavailable" };
  if (
    slot.job_id !== row.job_id ||
    slot.dispatch_key !== DISPATCH_KEY ||
    slot.stage !== "decision" ||
    slot.request_hash !== row.request_hash ||
    slot.config_hash !== row.config_hash
  )
    return { status: "unavailable" };
  // The central record is not tenant proof: require the EXACT settled tenant
  // projection for the original job before adopting any entity (both journals).
  if (
    !tenantDecisionSettled(brain, {
      job_id: row.job_id,
      call_id: slot.call_id,
      request_hash: row.request_hash,
      config_hash: row.config_hash,
      amount: slot.actual_micro_usd,
    })
  )
    return { status: "unavailable" };
  const currentRefs = canonical(
    question.sources.map((source) => ({
      source_id: source.source_id,
      source_version: source.source_version,
      body_hash: source.body_hash,
    })),
  );
  // The immutable stored identity must still equal the CURRENT question.
  if (
    row.question_hash !== question.question_hash ||
    row.goal_id !== question.goal.goal_id ||
    row.goal_entity_version !== question.goal.goal_entity_version ||
    row.plan_version !== question.goal.plan_version ||
    row.project_id !== question.goal.project_id ||
    row.source_refs_json !== currentRefs
  )
    return { status: "unavailable" };
  const advisory = brain.decisionAdvisory(owner, row.advisory_id);
  if (!advisory || advisory.question_hash !== question.question_hash)
    return { status: "unavailable" };
  const advisoryRefs = canonical(
    advisory.sources.map((source) => ({
      source_id: source.source_id,
      source_version: source.source_version,
      body_hash: source.body_hash,
    })),
  );
  if (advisoryRefs !== currentRefs) return { status: "unavailable" };
  return { status: "advisory", advisory_id: row.advisory_id };
}

async function run(
  deps: DecisionAdvisoryDeps,
  job: { id: string; fence: number },
  leaseOwner: string,
  signal: AbortSignal,
): Promise<DecisionAdvisoryResult> {
  const { brain, accounting, provider, owner } = deps;
  const goalId = goalIdOf(brain, job.id);
  if (!goalId) return { status: "skipped", reason: "not_a_review_job" };

  const context = brain.decisionAdvisoryContext(owner, goalId);
  if (!context.ok) return { status: "skipped", reason: context.skip };
  const question = context.question;
  if (goalHasSecret(brain, owner, goalId))
    return { status: "skipped", reason: "goal_secret" };

  // Prepare the immutable adapter call OUTSIDE any transaction. It is
  // synchronous and no-I/O; a thrown config error is a no-call skip.
  const input = expectedDecisionInput(question);
  let call;
  try {
    call = provider.prepareDecision(input);
  } catch {
    return { status: "skipped", reason: "provider_unavailable" };
  }

  const lease = { job_id: job.id, owner: leaseOwner, fence: job.fence };
  const claim = brain.claimDecisionAdvisory(owner, {
    goal_id: goalId,
    question_hash: question.question_hash,
    lease,
    request_hash: call.identity.request_hash,
    config_hash: call.identity.config_hash,
  });
  if (!claim.claimed) {
    // An existing attempt is never reclaimed or resent, even with no financial
    // slot. Recovery reads the ORIGINAL attempt's job slot (never the current job)
    // and validates a known settlement + identity before adopting any record.
    if (claim.reason === "tombstoned") return { status: "unavailable" };
    return recoverExisting(deps, claim.row, question);
  }
  const key = claim.row.idempotency_key;

  // Full-context eligibility immediately BEFORE reserve: the exact question hash,
  // goal entity/plan version, both consents, the project-visible active source set
  // and the full-goal secret scan must still hold. A change observable here means
  // no I/O has occurred, so no financial row is created at all.
  if (
    !stillCurrent(brain, owner, goalId, question.question_hash) ||
    goalHasSecret(brain, owner, goalId)
  ) {
    markUnavailable(brain, key);
    return { status: "unavailable" };
  }

  const prefs = brain.prefs(owner);
  const limits: SpendLimits = {
    per_job_micro_usd: prefs.per_job_cap_micro_usd,
    daily_micro_usd: prefs.daily_cap_micro_usd,
    time_zone: prefs.time_zone,
  };
  const spec: DispatchSpec = {
    job_id: job.id,
    dispatch_key: DISPATCH_KEY,
    stage: "decision",
    reserved_micro_usd: call.identity.reserved_micro_usd,
    provider: call.identity.provider,
    model: call.identity.model,
    price_version: call.identity.price_version,
    request_hash: call.identity.request_hash,
    config_hash: call.identity.config_hash,
  };
  const currentLease = (): JobLease => {
    const row = brain.store.get<{
      status: string;
      lease_owner: string;
      lease_until: string | null;
      fence: number;
    }>("SELECT status,lease_owner,lease_until,fence FROM jobs WHERE id=?", job.id);
    if (
      !row ||
      row.status !== "running" ||
      row.lease_owner !== leaseOwner ||
      row.fence !== job.fence ||
      !row.lease_until
    )
      throw new BrainError(
        "JOB_CANCELLED",
        "This attempt is no longer current.",
        409,
      );
    return {
      job_id: job.id,
      owner: leaseOwner,
      fence: job.fence,
      expires_at: row.lease_until,
    };
  };

  // Guarded reserve through the account-bound decision coordinator. No money
  // moved on a refusal, so the claim is truthfully unavailable (never resent).
  let record;
  try {
    record = accounting.reserve(spec, currentLease(), limits);
  } catch (error) {
    if (error instanceof AccountingPersistenceError) throw error;
    markUnavailable(brain, key);
    return { status: "skipped", reason: "not_admitted" };
  }
  const callId = record.call_id;
  if (record.state !== "reserved") {
    // An already-dispatched/settled slot is never resent.
    markUnavailable(brain, key);
    return { status: "unavailable" };
  }

  // A pre-mark failure may release its reserved hold by CAS (no fake charge). The
  // full-context eligibility is re-checked immediately BEFORE the mark: a change
  // observable here (no I/O yet) releases the reserved hold instead of marking it.
  try {
    if (signal.aborted)
      throw new BrainError("JOB_CANCELLED", "Cancelled before dispatch.", 409);
    if (!stillCurrent(brain, owner, goalId, question.question_hash))
      throw new BrainError(
        "SOURCE_STALE",
        "The advisory context changed before the paid decision call.",
        409,
      );
    accounting.markDispatched(callId, currentLease());
  } catch (error) {
    if (error instanceof AccountingPersistenceError) throw error;
    try {
      accounting.releaseUndispatched(callId);
    } catch {
      /* A concurrent state change owns the record. */
    }
    markUnavailable(brain, key);
    return { status: "unavailable" };
  }

  // FRESH pre-I/O authorization: the exact source set, goal entity/plan version
  // and both consents must still resolve to the SAME canonical question. A change
  // here leaves the marked hold in place and never sends.
  if (!stillCurrent(brain, owner, goalId, question.question_hash)) {
    markUnavailable(brain, key);
    return { status: "unavailable" };
  }

  // Exactly ONE provider call, outside every transaction.
  let envelope: PreparedDecisionEnvelope;
  try {
    if (signal.aborted)
      throw new BrainError("JOB_CANCELLED", "Cancelled before dispatch.", 409);
    accounting.assertCanExecute?.(callId, currentLease());
    envelope = await call.execute(signal);
  } catch (error) {
    if (error instanceof AccountingPersistenceError) throw error;
    // After mark: any abort/throw/not_dispatched leaves the dispatched hold and
    // is never refunded, retried or turned into a fallback.
    markUnavailable(brain, key);
    return { status: "unknown" };
  }

  if (envelope.accounting.state !== "known") {
    // Unknown usage: retain the hold; the shared barrier blocks other paid stages.
    markUnavailable(brain, key);
    return { status: "unknown" };
  }

  // Settle the known charge. The coordinator settles centrally first and the
  // tenant projection independently: a central success with a failed tenant
  // projection still RETURNS the central record (and flags reconciliation). Verify
  // BOTH journals, matching exact identity, before any publication.
  let settled;
  try {
    settled = accounting.settle(callId, envelope.accounting.cost_micro_usd);
  } catch (error) {
    if (error instanceof AccountingPersistenceError) throw error;
    // The coordinator refused post-settlement (policy/consent/goal/lease changed);
    // the known charge is retained in both ledgers.
    markUnavailable(brain, key);
    return { status: "unavailable" };
  }
  const knownAmount = envelope.accounting.cost_micro_usd;
  if (
    settled.state !== "settled" ||
    settled.actual_micro_usd !== knownAmount ||
    !tenantDecisionSettled(brain, {
      job_id: job.id,
      call_id: callId,
      request_hash: call.identity.request_hash,
      config_hash: call.identity.config_hash,
      amount: knownAmount,
    })
  ) {
    // Partial-known: the central charge committed but the tenant projection did
    // not. NO advisory; the known charge and the central reconciliation block
    // remain and the attempt is truthfully unavailable (never resent).
    markUnavailable(brain, key);
    return { status: "unavailable" };
  }

  // Post-settlement full source/goal/consent recheck before persisting.
  if (!stillCurrent(brain, owner, goalId, question.question_hash)) {
    markUnavailable(brain, key);
    return { status: "unavailable" };
  }

  // Map the settled, structurally-typed envelope. A known malformed output is
  // stored as `unavailable`/null (never a fabricated judgment); an invalid
  // positive throws and becomes unavailable without inventing an answer.
  let mapped;
  try {
    mapped = advisoryRecord({ question, envelope });
  } catch {
    markUnavailable(brain, key);
    return { status: "unavailable" };
  }
  if (!("record" in mapped)) {
    markUnavailable(brain, key);
    return { status: "unavailable" };
  }

  try {
    const entity = brain.saveDecisionAdvisory(owner, {
      idempotency_key: key,
      record: mapped.record,
      lease,
    });
    return { status: "advisory", advisory_id: entity.id };
  } catch (error) {
    if (error instanceof AccountingPersistenceError) throw error;
    markUnavailable(brain, key);
    return { status: "unavailable" };
  }
}
