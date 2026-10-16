import type { Brain } from "../../packages/domain/service.ts";
import type { Principal } from "../../packages/contracts/index.ts";
import { BrainError } from "../../packages/domain/logic.ts";
import type { DispatchAccounting } from "./accounting.ts";
import type {
  DispatchSpec,
  JobLease,
  SpendLimits,
} from "../../packages/domain/spend.ts";
import type {
  PrepareRequest,
  PreparedAccounting,
  PreparedIdentity,
  PreparedOutput,
  PreparedProvider,
} from "../../packages/providers/prepared.ts";

/**
 * One-shot paid dispatch for a single job attempt.
 *
 * The sequence is durable and ordered: re-check the current principal, consent,
 * source/goal state and lease; `reserve` the stable `reasoning` slot; commit
 * `markDispatched`; run exactly one provider call outside any transaction; then
 * `settle` a known charge before the caller publishes. A reserved call that was
 * never sent may be released; a dispatched or settled call is never released.
 * A result whose cost cannot be accounted is never published as zero: it fails
 * closed and leaves the hold. There is no retry, fallback or second call here.
 */

export type DispatchDeps = {
  brain: Brain;
  ledger: DispatchAccounting;
  provider: PreparedProvider;
  owner: Principal;
};

/** A settled/known accounting record; unknown never reaches the caller. */
export type VerifiedAccounting = Extract<PreparedAccounting, { state: "known" }>;

export type PreparedAttempt = {
  call_id: string;
  identity: PreparedIdentity;
  output: PreparedOutput;
  accounting: VerifiedAccounting;
};

/** Reads the persisted lease deadline, never the stale in-memory job row. */
function currentLease(
  deps: DispatchDeps,
  job: { id: string; fence: number },
  owner: string,
): JobLease {
  const row = deps.brain.store.get<{
    status: string;
    lease_owner: string;
    lease_until: string | null;
    fence: number;
  }>("SELECT status,lease_owner,lease_until,fence FROM jobs WHERE id=?", job.id);
  if (
    !row ||
    row.status !== "running" ||
    row.lease_owner !== owner ||
    row.fence !== job.fence ||
    !row.lease_until
  )
    throw new BrainError(
      "JOB_CANCELLED",
      "This attempt is no longer current.",
      409,
    );
  return { job_id: job.id, owner, fence: job.fence, expires_at: row.lease_until };
}

export async function dispatchPrepared(
  deps: DispatchDeps,
  input: PrepareRequest,
  job: { id: string; fence: number },
  leaseOwner: string,
  guard: () => void,
  signal: AbortSignal,
): Promise<PreparedAttempt> {
  const { brain, ledger, provider, owner } = deps;
  if (signal.aborted)
    throw new BrainError(
      "JOB_CANCELLED",
      "This attempt was cancelled before dispatch.",
      409,
    );
  const prefs = brain.prefs(owner);
  const limits: SpendLimits = {
    per_job_micro_usd: prefs.per_job_cap_micro_usd,
    daily_micro_usd: prefs.daily_cap_micro_usd,
    time_zone: prefs.time_zone,
  };
  const call = provider.prepareCall(input); // sync, no I/O; throw => no attempt
  const spec: DispatchSpec = {
    job_id: job.id,
    dispatch_key: "reasoning",
    stage: "reasoning",
    reserved_micro_usd: call.identity.reserved_micro_usd,
    provider: call.identity.provider,
    model: call.identity.model,
    price_version: call.identity.price_version,
    request_hash: call.identity.request_hash,
    config_hash: call.identity.config_hash,
  };
  const lease = currentLease(deps, job, leaseOwner);
  guard();
  const record = ledger.reserve(spec, lease, limits);
  if (record.state !== "reserved")
    throw new BrainError(
      "JOB_CANCELLED",
      "A paid call for this preparation already exists; it will not be sent again.",
      409,
    );
  try {
    if (signal.aborted)
      throw new BrainError(
        "JOB_CANCELLED",
        "This attempt was cancelled before dispatch.",
        409,
      );
    guard();
    ledger.markDispatched(record.call_id, lease);
  } catch (error) {
    // The request was never sent, so releasing the hold cannot lose real spend.
    try {
      ledger.releaseUndispatched(record.call_id);
    } catch {
      /* A concurrent state change owns the record. */
    }
    throw error;
  }
  // The mark may have waited on a database lock while consent, sources, the
  // goal, the principal or the user's caps changed. Re-check the current trusted
  // state before the single network call. This is intentionally OUTSIDE the
  // release catch: a throw here leaves the marked hold in place, so the call is
  // never refunded and never sent twice. Once the call is marked, a guard
  // failure is a failed attempt with a retained hold, not a clean cancellation.
  // There is no way to make this last check and the network call one atomic step,
  // so a change in the tiny remaining window is unavoidable; any marked call's
  // cost stays accounted.
  if (signal.aborted)
    throw new BrainError(
      "JOB_CANCELLED",
      "This attempt was cancelled before dispatch.",
      409,
    );
  try {
    guard();
  } catch (error) {
    throw new BrainError(
      "PROVIDER_UNAVAILABLE",
      error instanceof BrainError
        ? error.message
        : "The attempt changed after it was marked; it was not sent.",
      503,
    );
  }
  const current = brain.prefs(owner);
  if (
    current.per_job_cap_micro_usd < limits.per_job_micro_usd ||
    current.daily_cap_micro_usd < limits.daily_micro_usd
  )
    throw new BrainError(
      "JOB_CANCELLED",
      "Your spending caps were lowered while this attempt was being marked; it was not sent.",
      409,
    );
  // Final frozen-policy permission check, directly before the single network call
  // and OUTSIDE the release catch: a failure here leaves the marked hold in place.
  ledger.assertCanExecute?.(record.call_id, lease);
  const envelope = await call.execute(signal);
  // Fail closed when the cost cannot be accounted: never publish a zero-cost
  // result. The hold left by markDispatched remains for reconciliation.
  if (envelope.accounting.state !== "known")
    throw new BrainError(
      "PROVIDER_UNAVAILABLE",
      "The provider result could not be accounted; any charge remains held.",
      503,
    );
  const accounting = envelope.accounting;
  const settled = ledger.settle(record.call_id, accounting.cost_micro_usd);
  // Settle and block first; then refuse publication even if the output was ok.
  if (
    settled.actual_micro_usd !== null &&
    settled.actual_micro_usd > settled.reserved_micro_usd
  )
    throw new BrainError(
      "BUDGET_EXHAUSTED",
      "Provider usage exceeded its estimate; paid processing is blocked until reconciled.",
      409,
    );
  return {
    call_id: record.call_id,
    identity: call.identity,
    output: envelope.output,
    accounting,
  };
}
