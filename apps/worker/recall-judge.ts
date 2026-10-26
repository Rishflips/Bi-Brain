import type { Brain } from "../../packages/domain/service.ts";
import type { Principal } from "../../packages/contracts/index.ts";
import { JUDGE_CACHE_MS, JUDGE_LOOP_MS, JUDGE_RESULT_KEY, JUDGE_STATE_KEY, JUDGE_SWEEP_AFTER_MS } from "../../packages/domain/recall-judge.ts";
import type { DispatchRecord, DispatchSpec, JobLease, SpendLimits } from "../../packages/domain/spend.ts";
import { prepareAsk, type AskAnswer, type AskQuestion, type PreparedAsk } from "../../packages/providers/system-one-ask.ts";
import { SystemOneError } from "../../packages/providers/system-one.ts";
import type { DispatchAccounting } from "./accounting.ts";
import type { SystemOneClient } from "./system-one.ts";

/**
 * The judge fast lane: a dedicated loop over `jobs` rows of kind `recall_judge`.
 * Same money path as sorting (reserve, mark, one call outside any transaction,
 * settle); the key is read from this process's environment only. Results go to
 * a settings key the server polls; the server re-authorizes every hit itself.
 * The cache holds answers only (probabilities by candidate ordinal), never text.
 */
export type JudgeDeps = { brain: Brain; ledger: DispatchAccounting; client: SystemOneClient; owner: Principal; workerId: string; fetcher?: typeof fetch };
type JudgeJob = { id: string; fence: number; payload: { request_id: string; state_hash: string } };
type Cache = Map<string, { answers: AskAnswer[]; at: number }>;
/** The lease and the abort bound for one judge call. Integer milliseconds. */
const JUDGE_LEASE_MS = 10_000;
const SWEEP_EVERY_MS = Math.floor(JUDGE_SWEEP_AFTER_MS / 4);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.floor(ms)));

/** Leases the oldest queued judge job whose deadline is still ahead. */
function leaseJudge(brain: Brain, owner: string): JudgeJob | undefined {
  return brain.store.transaction(() => {
    const now = brain.now();
    const row = brain.store.get<{ id: string; fence: number; payload: string }>(
      "SELECT id,fence,payload FROM jobs WHERE kind='recall_judge' AND status='queued' AND deadline_at>? ORDER BY created_at LIMIT 1",
      now,
    );
    if (!row) return undefined;
    const fence = row.fence + 1;
    brain.store.run(
      "UPDATE jobs SET status='running',lease_owner=?,lease_until=?,attempts=attempts+1,fence=? WHERE id=? AND status='queued'",
      owner,
      new Date(brain.clock().getTime() + JUDGE_LEASE_MS).toISOString(),
      fence,
      row.id,
    );
    return { id: row.id, fence, payload: JSON.parse(row.payload) };
  });
}

/** Ends the attempt (only while this lease's fence still holds) and always deletes the state, which holds the agent's question and passages. */
function finishJob(brain: Brain, job: JudgeJob, status: "succeeded" | "cancelled" | "failed") {
  brain.store.run("UPDATE jobs SET status=?,lease_until=NULL WHERE id=? AND fence=?", status, job.id, job.fence);
  brain.store.run("DELETE FROM settings WHERE key=?", JUDGE_STATE_KEY(job.payload.request_id));
}

/** Recall help needs its own consent and everything sorting help needs, re-read at every step. */
function allowed(brain: Brain, owner: Principal) {
  if (brain.tenantId !== undefined || !brain.recallHelp(owner).enabled) return false;
  const p = brain.prefs(owner);
  return p.enabled && p.decision_provider_enabled && p.daily_cap_micro_usd > 0 && p.per_job_cap_micro_usd > 0;
}

/** One judge job end to end. Returns false when there was nothing to do. */
export async function runJudgeOnce(deps: JudgeDeps, cache: Cache): Promise<boolean> {
  const { brain, ledger, client, owner } = deps;
  const leaseOwner = `${deps.workerId}:judge`;
  const job = leaseJudge(brain, leaseOwner);
  if (!job) return false;
  // Set once a request may have gone out; from then on the hold is never released.
  let record: DispatchRecord | undefined;
  try {
    if (!allowed(brain, owner)) return finishJob(brain, job, "cancelled"), true;
    const stored = brain.store.setting<{ state: string; questions: AskQuestion[]; request_hash: string } | null>(JUDGE_STATE_KEY(job.payload.request_id), null);
    if (!stored || typeof stored.state !== "string" || !Array.isArray(stored.questions)) return finishJob(brain, job, "cancelled"), true;
    const publish = (answers: AskAnswer[]) => {
      brain.store.set(JUDGE_RESULT_KEY(job.payload.request_id), { answers, at: brain.now() });
      finishJob(brain, job, "succeeded");
    };
    const cached = cache.get(stored.request_hash);
    if (cached && Date.now() - cached.at < JUDGE_CACHE_MS) return publish(cached.answers), true;
    if (cached) cache.delete(stored.request_hash);
    let ask: PreparedAsk;
    try {
      // prepareAsk runs detectSecrets over the whole state again: a secret-shaped passage is never sent.
      ask = prepareAsk(client.config, stored.state, stored.questions, deps.fetcher ?? client.fetcher);
    } catch (error) {
      if (error instanceof SystemOneError && !error.dispatched) return finishJob(brain, job, "cancelled"), true;
      throw error;
    }
    const prefs = brain.prefs(owner);
    const limits: SpendLimits = { per_job_micro_usd: prefs.per_job_cap_micro_usd, daily_micro_usd: prefs.daily_cap_micro_usd, time_zone: prefs.time_zone };
    const row = brain.store.get<{ lease_until: string | null }>(
      "SELECT lease_until FROM jobs WHERE id=? AND status='running' AND lease_owner=? AND fence=?",
      job.id,
      leaseOwner,
      job.fence,
    );
    if (!row?.lease_until) return finishJob(brain, job, "cancelled"), true;
    const lease: JobLease = { job_id: job.id, owner: leaseOwner, fence: job.fence, expires_at: row.lease_until };
    const spec: DispatchSpec = {
      job_id: job.id,
      dispatch_key: "recall_judge",
      stage: "decision",
      reserved_micro_usd: ask.reserved_micro_usd,
      provider: ask.provider,
      model: ask.model,
      price_version: ask.price_version,
      request_hash: ask.request_hash,
      config_hash: ask.config_hash,
    };
    let reserved: DispatchRecord;
    try {
      // The shared daily cap and the per-call cap: a refusal is a quiet deterministic answer, never an error to the agent.
      reserved = ledger.reserve(spec, lease, limits);
    } catch {
      return finishJob(brain, job, "cancelled"), true;
    }
    if (reserved.state !== "reserved") return finishJob(brain, job, "cancelled"), true;
    try {
      ledger.markDispatched(reserved.call_id, lease);
    } catch (error) {
      try {
        ledger.releaseUndispatched(reserved.call_id);
      } catch {
        /* A concurrent state change owns the record. */
      }
      throw error;
    }
    record = reserved;
    // After the mark the hold stays. The mark may have waited on a lock while consent or caps changed.
    const now = brain.prefs(owner);
    if (!allowed(brain, owner) || now.per_job_cap_micro_usd < limits.per_job_micro_usd || now.daily_cap_micro_usd < limits.daily_micro_usd)
      return finishJob(brain, job, "cancelled"), true;
    ledger.assertCanExecute?.(record.call_id, lease);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), JUDGE_LEASE_MS);
    try {
      // The one provider call, outside any transaction.
      const result = await ask.execute(controller.signal);
      ledger.settle(record.call_id, result.cost_micro_usd);
      cache.set(stored.request_hash, { answers: result.answers, at: Date.now() });
      publish(result.answers);
    } catch (error) {
      // A known cost is settled; an unknown one keeps its hold, so a request that may have gone out is never refunded.
      if (error instanceof SystemOneError && error.actual_cost_micro_usd !== undefined) ledger.settle(record.call_id, error.actual_cost_micro_usd);
      finishJob(brain, job, "failed");
    } finally {
      clearTimeout(timer);
    }
    return true;
  } catch {
    try {
      finishJob(brain, job, "failed");
    } catch {
      /* Storage is unavailable; the sweeper cancels the row later. */
    }
    return true;
  }
}

/** Queued or running rows past their deadline become cancelled (never deleted: the ledger references them); state and result keys older than an hour are deleted. */
export function sweepJudgeRows(brain: Brain) {
  const now = brain.now();
  const cutoff = new Date(brain.clock().getTime() - JUDGE_SWEEP_AFTER_MS).toISOString();
  brain.store.run(
    "UPDATE jobs SET status='cancelled',fence=fence+1,lease_until=NULL WHERE kind='recall_judge' AND status IN ('queued','running') AND deadline_at<=? AND (status='queued' OR lease_until IS NULL OR lease_until<=?)",
    now,
    now,
  );
  // Only the keys still present are visited (normally none), so the sweep stays small however many judge rows the table keeps.
  const prefixes = [JUDGE_STATE_KEY(""), JUDGE_RESULT_KEY("")];
  const keys = brain.store.all<{ key: string }>(
    "SELECT key FROM settings WHERE substr(key,1,?)=? OR substr(key,1,?)=?",
    prefixes[0].length,
    prefixes[0],
    prefixes[1].length,
    prefixes[1],
  );
  for (const { key } of keys) {
    const id = key.slice(key.startsWith(prefixes[1]) ? prefixes[1].length : prefixes[0].length);
    const job = brain.store.get<{ status: string; created_at: string }>("SELECT status,created_at FROM jobs WHERE id=? AND kind='recall_judge'", id);
    if (!job || job.created_at <= cutoff || job.status === "cancelled" || job.status === "failed") brain.store.run("DELETE FROM settings WHERE key=?", key);
  }
}

/** Polls every 100 ms only while the consent is on; otherwise re-reads the consent once a second. Sweeps every 15 minutes. */
export function startJudgeLoop(deps: JudgeDeps): { stop(): Promise<void> } {
  let running = true;
  const cache: Cache = new Map();
  let lastSweep = 0;
  const loop = (async () => {
    while (running) {
      try {
        if (Date.now() - lastSweep > SWEEP_EVERY_MS) {
          sweepJudgeRows(deps.brain);
          lastSweep = Date.now();
          for (const [key, entry] of cache) if (Date.now() - entry.at >= JUDGE_CACHE_MS) cache.delete(key);
        }
        if (!allowed(deps.brain, deps.owner)) {
          await sleep(1000);
          continue;
        }
        const worked = await runJudgeOnce(deps, cache);
        if (!worked) await sleep(JUDGE_LOOP_MS);
      } catch {
        await sleep(1000);
      }
    }
  })();
  return {
    async stop() {
      running = false;
      await loop;
    },
  };
}
