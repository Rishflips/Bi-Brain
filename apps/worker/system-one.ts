import type { Brain } from "../../packages/domain/service.ts";
import type { Principal } from "../../packages/contracts/index.ts";
import { BrainError } from "../../packages/domain/logic.ts";
import { buildQuestions } from "../../packages/domain/system-one.ts";
import type {
  DispatchSpec,
  JobLease,
  SpendLimits,
} from "../../packages/domain/spend.ts";
import { prepareAsk, type AskConfig, type AskResult, type PreparedAsk } from "../../packages/providers/system-one-ask.ts";
import { SystemOneError } from "../../packages/providers/system-one.ts";
import type { DispatchAccounting } from "./accounting.ts";

/**
 * One sorting-help request for one note version.
 *
 * It mirrors `dispatchPrepared`: re-check, reserve, mark, re-check, ONE call
 * outside any transaction, then settle a known cost before publishing. Before the
 * mark a failure releases the hold. After the mark a failure keeps it unless the
 * cost is known, so money is never refunded for a request that may have gone out.
 * The answers are advice only; `recordSystemOneResult` decides what, if anything,
 * becomes visible.
 */

export type SystemOneClient = { config: AskConfig; fetcher?: typeof fetch };
export type SystemOneDeps = {
  brain: Brain;
  ledger: DispatchAccounting;
  client: SystemOneClient | null;
  owner: Principal;
  leaseOwner: string;
};
export type SystemOneJob = {
  id: string;
  project_id: string;
  fence: number;
  payload: { source_id: string; source_version: number };
};
export type SystemOneOutcome = { outcome: "recorded" | "skipped" | "cancelled" };

/** What the Settings card and the consent check read. It never holds the key. */
export type SystemOneStatus = {
  configured: boolean;
  label?: string;
  reason?: string;
  updated_at: string;
  last_ok_at?: string;
  last_error?: string;
};
export const SYSTEM_ONE_STATUS = "system_one_status";

/** Writes the startup status. `label` and `reason` are plain sentences, never secrets. */
export function publishSystemOneStatus(
  brain: Brain,
  from: { configured: true; label: string } | { configured: false; reason: string },
) {
  brain.store.set(SYSTEM_ONE_STATUS, { ...from, updated_at: brain.now() } satisfies SystemOneStatus);
}

/** Records the latest outcome on the published status; does nothing before startup published one. */
function noteStatus(brain: Brain, patch: Partial<Pick<SystemOneStatus, "last_ok_at" | "last_error">>) {
  try {
    const current = brain.store.setting<SystemOneStatus | null>(SYSTEM_ONE_STATUS, null);
    if (current) brain.store.set(SYSTEM_ONE_STATUS, { ...current, ...patch });
  } catch {
    /* Status is informational; it must never fail the job. */
  }
}

const cancelled = (message: string) => new BrainError("JOB_CANCELLED", message, 409);

/** Sorting help needs background help, its own consent and both caps above 0. */
function allowed(brain: Brain, owner: Principal): boolean {
  const p = brain.prefs(owner);
  return p.enabled && p.decision_provider_enabled && p.daily_cap_micro_usd > 0 && p.per_job_cap_micro_usd > 0;
}

/** Reads the persisted lease, never the in-memory job row. */
function currentLease(brain: Brain, job: { id: string; fence: number }, owner: string): JobLease {
  const row = brain.store.get<{ status: string; lease_owner: string; lease_until: string | null; fence: number }>(
    "SELECT status,lease_owner,lease_until,fence FROM jobs WHERE id=?",
    job.id,
  );
  if (!row || row.status !== "running" || row.lease_owner !== owner || row.fence !== job.fence || !row.lease_until)
    throw cancelled("This attempt is no longer current.");
  return { job_id: job.id, owner, fence: job.fence, expires_at: row.lease_until };
}

/** The ledger entry for this call. `request_hash` makes a changed note a different request. */
function specFor(job: SystemOneJob, ask: PreparedAsk): DispatchSpec {
  return {
    job_id: job.id,
    dispatch_key: "system_one",
    stage: "decision",
    reserved_micro_usd: ask.reserved_micro_usd,
    provider: ask.provider,
    model: ask.model,
    price_version: ask.price_version,
    request_hash: ask.request_hash,
    config_hash: ask.config_hash,
  };
}

/** After a request went out: settle a known cost, then report the failure in the worker's terms. */
function failAfterSend(deps: SystemOneDeps, callId: string, error: unknown): never {
  if (!(error instanceof SystemOneError)) throw error;
  if (error.actual_cost_micro_usd !== undefined) deps.ledger.settle(callId, error.actual_cost_micro_usd);
  if (error.code === "PROVIDER_ABORTED") throw cancelled(error.message);
  if (error.code === "PROVIDER_INVALID") throw new BrainError("PROVIDER_INVALID", error.message, 502);
  throw new BrainError("PROVIDER_UNAVAILABLE", error.message, 503);
}

async function sortOneNote(
  deps: SystemOneDeps,
  job: SystemOneJob,
  signal: AbortSignal,
): Promise<SystemOneOutcome> {
  const { brain, ledger, client, owner } = deps;
  const { source_id, source_version } = job.payload;
  // 1-2. Local only, and only when a client is configured: no spend otherwise.
  if (brain.tenantId !== undefined) return { outcome: "cancelled" };
  if (!client) return { outcome: "skipped" };
  // 3-4. Consent, caps, watch and visibility are re-read now, not trusted from queue time.
  if (!allowed(brain, owner)) return { outcome: "cancelled" };
  const ctx = brain.systemOneContext(source_id, source_version);
  if (!ctx) return { outcome: "cancelled" };
  // 5. A secret or a bound is refused before anything is reserved.
  let ask: PreparedAsk;
  try {
    const { state, questions } = buildQuestions(ctx);
    ask = prepareAsk(client.config, state, questions, client.fetcher);
  } catch (error) {
    if (error instanceof SystemOneError && !error.dispatched) {
      // Nothing was reserved or sent. Say why in Settings instead of skipping silently.
      noteStatus(brain, {
        last_error: /secret/i.test(error.message)
          ? "A note looked like it held a secret, so it was not sent for sorting."
          : "A note was too large to send for sorting.",
      });
      return { outcome: "cancelled" };
    }
    throw error;
  }
  // 6. Reserve, then mark. Before the mark a failure releases the hold.
  const prefs = brain.prefs(owner);
  const limits: SpendLimits = {
    per_job_micro_usd: prefs.per_job_cap_micro_usd,
    daily_micro_usd: prefs.daily_cap_micro_usd,
    time_zone: prefs.time_zone,
  };
  const lease = currentLease(brain, job, deps.leaseOwner);
  const record = ledger.reserve(specFor(job, ask), lease, limits);
  if (record.state !== "reserved") throw cancelled("A sorting request for this note already exists; it will not be sent again.");
  try {
    if (signal.aborted) throw cancelled("This attempt was cancelled before it was sent.");
    ledger.markDispatched(record.call_id, lease);
  } catch (error) {
    try {
      ledger.releaseUndispatched(record.call_id);
    } catch {
      /* A concurrent state change owns the record. */
    }
    throw error;
  }
  // After the mark the hold stays: nothing here may refund a request that might go out.
  // The mark may have waited on a lock while consent, caps, watch or the note changed.
  const now = brain.prefs(owner);
  if (
    signal.aborted ||
    !allowed(brain, owner) ||
    now.per_job_cap_micro_usd < limits.per_job_micro_usd ||
    now.daily_cap_micro_usd < limits.daily_micro_usd ||
    !brain.systemOneContext(source_id, source_version)
  )
    throw cancelled("Sorting help was changed while this note was being prepared; nothing was sent.");
  ledger.assertCanExecute?.(record.call_id, lease);
  // 7. One call outside any transaction; settle the known cost before publishing.
  let result: AskResult;
  try {
    result = await ask.execute(signal);
  } catch (error) {
    failAfterSend(deps, record.call_id, error);
  }
  const settled = ledger.settle(record.call_id, result.cost_micro_usd);
  if (settled.actual_micro_usd !== null && settled.actual_micro_usd > settled.reserved_micro_usd)
    throw new BrainError("BUDGET_EXHAUSTED", "Sorting help used more than its estimate; it is paused until reconciled.", 409);
  const published = brain.recordSystemOneResult(job, source_id, source_version, result);
  if (!published.recorded) return { outcome: "cancelled" };
  noteStatus(brain, { last_ok_at: brain.now(), last_error: undefined });
  return { outcome: "recorded" };
}

export async function runSystemOneJob(
  deps: SystemOneDeps,
  job: SystemOneJob,
  signal: AbortSignal,
): Promise<SystemOneOutcome> {
  try {
    return await sortOneNote(deps, job, signal);
  } catch (error) {
    // Settings shows the plain message; the engine decides retry or failure.
    if (error instanceof BrainError) noteStatus(deps.brain, { last_error: error.message });
    throw error;
  }
}
