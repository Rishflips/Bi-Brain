import type { Brain } from "../../packages/domain/service.ts";
import type { Principal } from "../../packages/contracts/index.ts";
import { hash } from "../../packages/domain/logic.ts";
import type { DispatchRecord, DispatchSpec, JobLease, SpendLimits } from "../../packages/domain/spend.ts";
import { EMBED_LOOP_MS, EMBED_RESULT_KEY, EMBED_STATE_KEY, EMBED_SWEEP_AFTER_MS, QUERY_CACHE_MS, modelKey, vectorToBase64 } from "../../packages/domain/better-search.ts";
import { EmbedError, prepareEmbed, type PreparedEmbed } from "../../packages/providers/embed.ts";
import type { DispatchAccounting } from "./accounting.ts";
import { noteEmbedStatus, type EmbedClient } from "./embed.ts";

/**
 * The query fast lane: a dedicated loop over `jobs` rows of kind `recall_embed`, the judge's shape.
 * Ollama answers free; Cloudflare goes through reserve, mark, one call outside any transaction, settle.
 * The result (model key, dim, base64 vector) goes to a settings key the server polls; the server
 * re-authorizes every dense hit itself. The cache holds vectors by sha256(model key + query) only, never text.
 */
export type QueryEmbedDeps = { brain: Brain; ledger: DispatchAccounting; client: EmbedClient; owner: Principal; workerId: string };
type EmbedJob = { id: string; fence: number; deadline_at: string; payload: { request_id: string; request_hash: string } };
type Entry = { key: string; dim: number; vector: Float32Array; at: number };
type Cache = Map<string, Entry>;
const QUERY_LEASE_MS = 10_000;
/** A Cloudflare job with less time than this before its deadline is never reserved; an Ollama job has no floor, because its answer feeds the cache for free. */
export const QUERY_MIN_LEFT_MS = 150;
/** The abort bound for one query call: well inside the 10 s lease, so a slow call can neither outlive its lease nor hold up later questions for long. */
export const QUERY_CALL_MS = 2_000;
/** Consecutive failed query calls (error response, timeout, invalid answer; never a ledger refusal or a cancellation) that start the lane's back-off, and its length. */
export const QUERY_BACKOFF_FAILURES = 3;
export const QUERY_BACKOFF_MS = 60_000;
/** The cheap sweep (expired query rows cancelled, their keys deleted) runs this often; the hourly row deletion runs with the full sweep. */
export const QUERY_KEY_SWEEP_MS = 60_000;
const SWEEP_EVERY_MS = Math.floor(EMBED_SWEEP_AFTER_MS / 4);
/** The lane's in-process back-off, one per cache (that is, per loop). Not persisted: a restarted worker simply tries again. */
type Health = { failures: number; until: number };
const HEALTH = new WeakMap<Cache, Health>();
function healthOf(cache: Cache): Health {
  let h = HEALTH.get(cache);
  if (!h) HEALTH.set(cache, (h = { failures: 0, until: 0 }));
  return h;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.floor(ms)));

/** Leases the oldest queued query job whose deadline is still ahead. */
function leaseQuery(brain: Brain, owner: string): EmbedJob | undefined {
  return brain.store.transaction(() => {
    const now = brain.now();
    const row = brain.store.get<{ id: string; fence: number; deadline_at: string; payload: string }>(
      "SELECT id,fence,deadline_at,payload FROM jobs WHERE kind='recall_embed' AND status='queued' AND deadline_at>? ORDER BY created_at LIMIT 1",
      now,
    );
    if (!row) return undefined;
    const fence = row.fence + 1;
    brain.store.run(
      "UPDATE jobs SET status='running',lease_owner=?,lease_until=?,attempts=attempts+1,fence=? WHERE id=? AND status='queued'",
      owner,
      new Date(brain.clock().getTime() + QUERY_LEASE_MS).toISOString(),
      fence,
      row.id,
    );
    let payload: EmbedJob["payload"];
    try {
      const parsed = JSON.parse(row.payload) as Partial<EmbedJob["payload"]>;
      payload = { request_id: typeof parsed.request_id === "string" ? parsed.request_id : row.id, request_hash: typeof parsed.request_hash === "string" ? parsed.request_hash : "" };
    } catch {
      payload = { request_id: row.id, request_hash: "" };
    }
    return { id: row.id, fence, deadline_at: row.deadline_at, payload };
  });
}

/** Ends the attempt (only while this lease's fence still holds) and always deletes the state, which holds the query text. */
function finishJob(brain: Brain, job: EmbedJob, status: "succeeded" | "cancelled" | "failed") {
  brain.store.run("UPDATE jobs SET status=?,lease_until=NULL WHERE id=? AND fence=?", status, job.id, job.fence);
  brain.store.run("DELETE FROM settings WHERE key=?", EMBED_STATE_KEY(job.payload.request_id));
}

/** Cancels every waiting question at once (fence bumped, question text deleted), so each server wait ends now with words only. */
function cancelQueued(brain: Brain) {
  brain.store.transaction(() => {
    const ids = brain.store.all<{ id: string }>("SELECT id FROM jobs WHERE kind='recall_embed' AND status='queued'");
    brain.store.run("UPDATE jobs SET status='cancelled',fence=fence+1,lease_until=NULL WHERE kind='recall_embed' AND status='queued'");
    for (const { id } of ids) brain.store.run("DELETE FROM settings WHERE key=? OR key=?", EMBED_STATE_KEY(id), EMBED_RESULT_KEY(id));
  });
}

/** One query job end to end. Returns false when there was nothing to do. */
export async function runQueryEmbedOnce(deps: QueryEmbedDeps, cache: Cache): Promise<boolean> {
  const { brain, ledger, client, owner } = deps;
  const leaseOwner = `${deps.workerId}:embed`;
  const job = leaseQuery(brain, leaseOwner);
  if (!job) return false;
  // Set once a request may have gone out; from then on the hold is never released.
  let record: DispatchRecord | undefined;
  try {
    // Consent, the published setup, the worker heartbeat, the circuit breaker and (Cloudflare) both limits: one rule, re-read at every step.
    const allowed = brain.betterSearchAllowed();
    if (!allowed.on) return finishJob(brain, job, "cancelled"), true;
    const key = modelKey(client.config.provider, client.config.model);
    if (key !== allowed.setting.key) return finishJob(brain, job, "cancelled"), true;
    const stored = brain.store.setting<{ query: string; request_hash: string } | null>(EMBED_STATE_KEY(job.payload.request_id), null);
    if (!stored || typeof stored.query !== "string" || !stored.query.trim()) return finishJob(brain, job, "cancelled"), true;
    // The cache key is computed here from this worker's own model key, never trusted from the row.
    const cacheKey = hash(`${key}\n${stored.query}`);
    // The result is written only while this attempt is still current and the server is still waiting; otherwise nothing is left behind.
    const publish = (entry: Entry) =>
      brain.store.transaction(() => {
        const done = brain.store.run("UPDATE jobs SET status='succeeded',lease_until=NULL WHERE id=? AND fence=? AND status='running'", job.id, job.fence).changes;
        if (done && Date.parse(job.deadline_at) > brain.clock().getTime())
          brain.store.set(EMBED_RESULT_KEY(job.payload.request_id), { key: entry.key, dim: entry.dim, vector: vectorToBase64(entry.vector), at: brain.now() });
        else brain.store.run("DELETE FROM settings WHERE key=?", EMBED_RESULT_KEY(job.payload.request_id));
        brain.store.run("DELETE FROM settings WHERE key=?", EMBED_STATE_KEY(job.payload.request_id));
      });
    const timeLeft = () => Date.parse(job.deadline_at) - brain.clock().getTime() >= QUERY_MIN_LEFT_MS;
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.at < QUERY_CACHE_MS && cached.key === key) return publish(cached), true;
    if (cached) cache.delete(cacheKey);
    // Backing off after repeated failures: no call, the question is cancelled and the server answers with words only at once.
    const health = healthOf(cache);
    if (health.until > brain.clock().getTime()) {
      finishJob(brain, job, "cancelled");
      cancelQueued(brain);
      return true;
    }
    let prepared: PreparedEmbed;
    try {
      // prepareEmbed runs detectSecrets over the query again: a secret-shaped question is never sent.
      prepared = prepareEmbed(client.config, [stored.query], client.fetcher);
    } catch (error) {
      if (error instanceof EmbedError && !error.dispatched) return finishJob(brain, job, "cancelled"), true;
      throw error;
    }
    if (client.config.provider === "cloudflare") {
      if (!timeLeft()) return finishJob(brain, job, "cancelled"), true;
      const prefs = brain.prefs(owner);
      const limits: SpendLimits = { per_job_micro_usd: prefs.per_job_cap_micro_usd, daily_micro_usd: prefs.daily_cap_micro_usd, time_zone: prefs.time_zone };
      // Still ours, and still worth paying for: a deadline about to pass means the server has (or will have) answered with words only.
      const row = brain.store.get<{ lease_until: string | null }>(
        "SELECT lease_until FROM jobs WHERE id=? AND status='running' AND lease_owner=? AND fence=? AND deadline_at>=?",
        job.id,
        leaseOwner,
        job.fence,
        new Date(brain.clock().getTime() + QUERY_MIN_LEFT_MS).toISOString(),
      );
      if (!row?.lease_until) return finishJob(brain, job, "cancelled"), true;
      const lease: JobLease = { job_id: job.id, owner: leaseOwner, fence: job.fence, expires_at: row.lease_until };
      const spec: DispatchSpec = {
        job_id: job.id,
        dispatch_key: "recall_embed",
        stage: "decision",
        reserved_micro_usd: prepared.reserved_micro_usd,
        provider: "cloudflare",
        model: prepared.model,
        price_version: prepared.price_version,
        request_hash: prepared.request_hash,
        config_hash: prepared.config_hash,
      };
      let reserved: DispatchRecord;
      try {
        // The shared daily cap and the per-call cap: a refusal is a quiet words-only answer, never an error to the caller.
        reserved = ledger.reserve(spec, lease, limits);
      } catch {
        return finishJob(brain, job, "cancelled"), true;
      }
      if (reserved.state !== "reserved") return finishJob(brain, job, "cancelled"), true;
      // Consent, the breaker, caps or the deadline may have changed while the reserve waited on the lock: refuse before the mark, so the hold is released, not kept.
      const lowered = () => {
        const now = brain.prefs(owner);
        return now.per_job_cap_micro_usd < limits.per_job_micro_usd || now.daily_cap_micro_usd < limits.daily_micro_usd;
      };
      if (!brain.betterSearchAllowed().on || lowered() || !timeLeft()) {
        ledger.releaseUndispatched(reserved.call_id);
        return finishJob(brain, job, "cancelled"), true;
      }
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
      if (!brain.betterSearchAllowed().on || lowered()) return finishJob(brain, job, "cancelled"), true;
      ledger.assertCanExecute?.(record.call_id, lease);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), QUERY_CALL_MS);
    try {
      // The one provider call, outside any transaction.
      const result = await prepared.execute(controller.signal);
      if (record) ledger.settle(record.call_id, result.cost_micro_usd);
      const entry: Entry = { key, dim: result.dim, vector: result.vectors[0], at: Date.now() };
      cache.set(cacheKey, entry);
      health.failures = 0;
      health.until = 0;
      publish(entry);
      // Only the time of the last answer: a batch's own error line (a back-off, refused passages) is not the query lane's to clear.
      noteEmbedStatus(brain, { last_ok_at: brain.now() });
    } catch (error) {
      // A known cost (0 for an error response) is settled; an unknown one keeps its hold, so a request that may have gone out is never refunded.
      if (record && error instanceof EmbedError && error.actual_cost_micro_usd !== undefined) ledger.settle(record.call_id, error.actual_cost_micro_usd);
      noteEmbedStatus(brain, { last_error: error instanceof Error ? error.message : "The search model request failed." });
      finishJob(brain, job, "failed");
      health.failures += 1;
      if (health.failures >= QUERY_BACKOFF_FAILURES) {
        health.until = brain.clock().getTime() + QUERY_BACKOFF_MS;
        health.failures = 0;
        cancelQueued(brain);
      }
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

/** The cheap sweep, about once a minute: past-deadline rows nobody holds a live lease on become cancelled, and their keys (and orphan keys) are deleted. */
export function sweepEmbedKeys(brain: Brain) {
  const now = brain.now();
  const cutoff = new Date(brain.clock().getTime() - EMBED_SWEEP_AFTER_MS).toISOString();
  brain.store.run(
    "UPDATE jobs SET status='cancelled',fence=fence+1,lease_until=NULL WHERE kind='recall_embed' AND status IN ('queued','running') AND deadline_at<=? AND (status='queued' OR lease_until IS NULL OR lease_until<=?)",
    now,
    now,
  );
  // Only the keys still present are visited (normally none), so the sweep stays small however many rows the table keeps.
  const prefixes = [EMBED_STATE_KEY(""), EMBED_RESULT_KEY("")];
  const keys = brain.store.all<{ key: string }>(
    "SELECT key FROM settings WHERE substr(key,1,?)=? OR substr(key,1,?)=?",
    prefixes[0].length,
    prefixes[0],
    prefixes[1].length,
    prefixes[1],
  );
  for (const { key } of keys) {
    const id = key.slice(key.startsWith(prefixes[1]) ? prefixes[1].length : prefixes[0].length);
    const job = brain.store.get<{ status: string; created_at: string }>("SELECT status,created_at FROM jobs WHERE id=? AND kind='recall_embed'", id);
    if (!job || job.created_at <= cutoff || job.status === "cancelled" || job.status === "failed") brain.store.run("DELETE FROM settings WHERE key=?", key);
  }
}

/** The full sweep: the cheap sweep, then finished rows older than an hour that no ledger row references are deleted, and keys that pointed at them. */
export function sweepEmbedRows(brain: Brain) {
  const cutoff = new Date(brain.clock().getTime() - EMBED_SWEEP_AFTER_MS).toISOString();
  sweepEmbedKeys(brain);
  // Ollama rows (no ledger row) are deleted after an hour; Cloudflare rows stay, because the ledger references them.
  brain.store.run(
    "DELETE FROM jobs WHERE kind='recall_embed' AND created_at<=? AND status NOT IN ('queued','running') AND NOT EXISTS (SELECT 1 FROM provider_dispatches d WHERE d.job_id=jobs.id)",
    cutoff,
  );
}

/** Polls every 25 ms only while better search is effective; otherwise re-reads once a second. Cheap sweep every minute, full sweep every 15 minutes. */
export function startEmbedLoop(deps: QueryEmbedDeps, timing: { keySweepMs?: number } = {}): { stop(): Promise<void> } {
  let running = true;
  const cache: Cache = new Map();
  const keySweepMs = timing.keySweepMs ?? QUERY_KEY_SWEEP_MS;
  let lastSweep = 0;
  let lastKeySweep = 0;
  const loop = (async () => {
    while (running) {
      try {
        if (Date.now() - lastSweep > SWEEP_EVERY_MS) {
          sweepEmbedRows(deps.brain);
          lastSweep = lastKeySweep = Date.now();
          for (const [key, entry] of cache) if (Date.now() - entry.at >= QUERY_CACHE_MS) cache.delete(key);
        } else if (Date.now() - lastKeySweep > keySweepMs) {
          sweepEmbedKeys(deps.brain);
          lastKeySweep = Date.now();
        }
        if (!deps.brain.betterSearchAllowed().on) {
          // Off, paused or not effective: no vector is kept for a choice that may change.
          cache.clear();
          await sleep(Math.min(1000, keySweepMs));
          continue;
        }
        const worked = await runQueryEmbedOnce(deps, cache);
        if (!worked) await sleep(EMBED_LOOP_MS);
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
