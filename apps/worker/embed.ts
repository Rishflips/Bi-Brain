import type { Brain } from "../../packages/domain/service.ts";
import { detectSecrets } from "../../packages/storage/secrets.ts";
import { BrainError } from "../../packages/domain/logic.ts";
import { AccountingPersistenceError } from "../../packages/storage/managed-spending.ts";
import type { Principal } from "../../packages/contracts/index.ts";
import { accountingDay, type DispatchRecord, type DispatchSpec, type JobLease, type SpendLimits } from "../../packages/domain/spend.ts";
import {
  BETTER_SEARCH_STATUS,
  EMBED_BACKOFF_MAX_MS,
  EMBED_BATCH_SIZE,
  EMBED_BREAKER_FAILURES,
  EMBED_CALL_MS,
  EMBED_PAUSE_MS,
  EMBED_RETRY_AFTER_MS,
  EMBED_VISIBILITIES,
  embedText,
  modelKey,
  normalize,
  type BetterSearchStatus,
  type EmbedProvider,
} from "../../packages/domain/better-search.ts";
import { pendingEmbedRows, writeEmbeddings, type VectorWrite } from "../../packages/storage/recall-vectors.ts";
import { EmbedError, INPUT_REFUSED_STATUSES, prepareEmbed, type EmbedConfig, type EmbedResult, type PreparedEmbed } from "../../packages/providers/embed.ts";
import type { DispatchAccounting } from "./accounting.ts";

export type EmbedClient = { config: EmbedConfig; fetcher?: typeof fetch };

/**
 * Writes the startup status. Carries the model key and a label, never the credential or the account id.
 * A restart with the same model keeps the back-off and the pause, so a worker that keeps restarting cannot get past the breaker;
 * a different model (or no setup) starts clean.
 */
export function publishBetterSearchStatus(
  brain: Brain,
  from: { configured: true; provider: EmbedProvider; model: string; key: string; label: string } | { configured: false; reason: string },
) {
  const previous = brain.store.setting<BetterSearchStatus | null>(BETTER_SEARCH_STATUS, null);
  const same = from.configured && previous?.configured === true && previous.key === from.key;
  const carried: Partial<BetterSearchStatus> = same
    ? { failures: previous.failures, retry_at: previous.retry_at, paused_until: previous.paused_until, last_error: previous.failures ? previous.last_error : undefined }
    : {};
  brain.store.set(BETTER_SEARCH_STATUS, { ...from, ...carried, updated_at: brain.now() } satisfies BetterSearchStatus);
}

/** Records the latest outcome (and the back-off state) on the published status; does nothing before startup published one. */
export function noteEmbedStatus(brain: Brain, patch: Partial<Pick<BetterSearchStatus, "last_ok_at" | "last_error" | "failures" | "retry_at" | "paused_until">>) {
  try {
    const current = brain.store.setting<BetterSearchStatus | null>(BETTER_SEARCH_STATUS, null);
    if (current) brain.store.set(BETTER_SEARCH_STATUS, { ...current, ...patch });
  } catch {
    /* Status is informational; it must never fail the job. */
  }
}

/** How often the engine's self-heal check looks for rows without a current vector. */
export const EMBED_CHECK_MS = 5_000;
/** How long a spending refusal other than a spent daily limit (a per-preparation limit, a frozen time zone, a reconciliation block) waits before the next try. */
export const EMBED_REFUSAL_WAIT_MS = 900_000;
export type EmbedDeps = { brain: Brain; ledger: DispatchAccounting; client: EmbedClient | null; owner: Principal; leaseOwner: string };
export type EmbedJob = { id: string; fence: number };
export type EmbedOutcome = { outcome: "embedded" | "nothing" | "cancelled" | "failed"; rows: number; more: boolean; error?: string };
/**
 * One provider call and its money. `refused`: nothing was sent and nothing counts toward the breaker (a ledger refusal, a lost
 * lease, a changed choice or a cancelled attempt). `rejected`: the input itself was refused (a 400, 413 or 422, or a text the local
 * checks refuse), so the batch is retried row by row. Anything else (a refused credential, a rate limit, an outage, an unknown outcome)
 * is a failure.
 */
type CallOutcome = { ok: true; result: EmbedResult } | { ok: false; error: Error; rejected: boolean; refused: boolean; retryAt?: string };

/** The persisted lease, never the in-memory row; null once this attempt is no longer current. */
function currentLease(brain: Brain, job: EmbedJob, owner: string): JobLease | null {
  const row = brain.store.get<{ status: string; lease_owner: string; lease_until: string | null; fence: number }>("SELECT status,lease_owner,lease_until,fence FROM jobs WHERE id=?", job.id);
  if (!row || row.status !== "running" || row.lease_owner !== owner || row.fence !== job.fence || !row.lease_until) return null;
  return { job_id: job.id, owner, fence: job.fence, expires_at: row.lease_until };
}

/** The first minute of the accounting day after the one holding `now`, in `timeZone` (DST-safe: it searches, never adds 24 h). */
export function nextAccountingDayStart(now: Date, timeZone: string): Date {
  const today = accountingDay(now, timeZone);
  let t = Math.floor(now.getTime() / 60_000) * 60_000;
  for (let i = 0; i < 48 && accountingDay(new Date(t), timeZone) === today; i++) t += 3_600_000;
  for (let i = 0; i < 60 && accountingDay(new Date(t - 60_000), timeZone) !== today; i++) t -= 60_000;
  return new Date(Math.max(t, now.getTime() + 60_000));
}

/**
 * When a ledger refusal may be tried again, or undefined for a refusal that is not about money (it simply ends the attempt).
 * A spent daily limit waits for the next accounting day; any other spending refusal waits 15 minutes. Neither counts as a failure.
 */
function refusalRetryAt(brain: Brain, error: unknown, timeZone: string): string | undefined {
  if (!(error instanceof BrainError)) return undefined;
  const now = brain.clock();
  if (error.code === "BUDGET_EXHAUSTED" && /today/i.test(error.message)) return nextAccountingDayStart(now, timeZone).toISOString();
  if (error.code.startsWith("BUDGET_") || error.code === "ACCOUNTING_TIMEZONE_FROZEN") return new Date(now.getTime() + EMBED_REFUSAL_WAIT_MS).toISOString();
  return undefined;
}

const allFinite = (v: Float32Array) => {
  for (let i = 0; i < v.length; i++) if (!Number.isFinite(v[i])) return false;
  return true;
};
/** A provider vector the store would refuse (wrong length, or not finite once normalised) is withheld for its row instead of discarding the batch. */
function usable(v: Float32Array | undefined, dim: number): v is Float32Array {
  return !!v && v.length === dim && allFinite(v) && allFinite(normalize(Float32Array.from(v)));
}

/**
 * ONE provider call outside any transaction. Ollama is free and writes no ledger row; Cloudflare goes reserve, mark, call,
 * settle under `dispatchKey`. An error response with no usage settles at 0 (nothing was billed); a timeout after send keeps
 * its hold, so a request that may have gone out is never refunded.
 */
async function callProvider(deps: EmbedDeps, job: EmbedJob, client: EmbedClient, texts: string[], dispatchKey: string, signal: AbortSignal): Promise<CallOutcome> {
  const { brain, ledger, owner } = deps;
  const { config } = client;
  const failed = (error: Error, rejected = false, refused = false): CallOutcome => ({ ok: false, error, rejected, refused });
  let prepared: PreparedEmbed;
  try {
    prepared = prepareEmbed(config, texts, client.fetcher);
  } catch (error) {
    // Nothing was reserved or sent. An input the local checks refuse is the input's fault, so it is isolated row by row like a refused input status.
    if (error instanceof EmbedError && error.code === "INVALID_INPUT") return failed(error, true);
    return failed(error instanceof Error ? error : new Error("Better search could not prepare a batch."));
  }
  let record: DispatchRecord | undefined;
  if (config.provider === "cloudflare") {
    const prefs = brain.prefs(owner);
    const limits: SpendLimits = { per_job_micro_usd: prefs.per_job_cap_micro_usd, daily_micro_usd: prefs.daily_cap_micro_usd, time_zone: prefs.time_zone };
    const lease = currentLease(brain, job, deps.leaseOwner);
    if (!lease) return failed(new Error("This attempt is no longer current."), false, true);
    const spec: DispatchSpec = {
      job_id: job.id,
      dispatch_key: dispatchKey,
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
      reserved = ledger.reserve(spec, lease, limits);
    } catch (error) {
      if (error instanceof AccountingPersistenceError) throw error;
      return {
        ok: false,
        error: new Error(error instanceof BrainError ? `Better search with Cloudflare is paused: ${error.message}` : "Better search could not reserve its spending."),
        rejected: false,
        refused: true,
        retryAt: refusalRetryAt(brain, error, limits.time_zone),
      };
    }
    // An existing slot is never permission to send twice: a re-leased attempt after a crash stops here.
    if (reserved.state !== "reserved") return failed(new Error("This batch was already sent."), false, true);
    // Consent or limits may have changed while the reserve waited on the lock: refuse before the mark, so the hold is released.
    if (signal.aborted || !brain.betterSearchAllowed().on) {
      ledger.releaseUndispatched(reserved.call_id);
      return failed(new Error("Better search was changed while this batch was being prepared."), false, true);
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
    ledger.assertCanExecute?.(record.call_id, lease);
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), EMBED_CALL_MS);
  try {
    const result = await prepared.execute(controller.signal);
    if (record) ledger.settle(record.call_id, result.cost_micro_usd);
    return { ok: true, result };
  } catch (error) {
    // A known cost (0 for an error response) is settled; an unknown one keeps its hold.
    if (record && error instanceof EmbedError && error.actual_cost_micro_usd !== undefined) ledger.settle(record.call_id, error.actual_cost_micro_usd);
    // The engine cancelled this attempt (its fence moved or its deadline passed): not the service's fault, so it does not count.
    if (signal.aborted) return failed(new Error("This attempt was cancelled."), false, true);
    // Only a refused input (400, 413, 422) is isolated row by row. A refused credential (401, 403), a rate limit or timeout (429, 408)
    // and any other status is a failure: it backs off and counts toward the breaker, and no row is ever withheld for it.
    const rejected = error instanceof EmbedError && error.upstream_status !== undefined && INPUT_REFUSED_STATUSES.has(error.upstream_status);
    return failed(error instanceof Error ? error : new Error("The search model request failed."), rejected);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

/** A failed or unknown batch: exponential back-off (60 s doubling to 15 min); the third in a row opens the breaker for 15 min. */
function recordFailure(brain: Brain, message: string) {
  const current = brain.store.setting<BetterSearchStatus | null>(BETTER_SEARCH_STATUS, null);
  const failures = (current?.failures ?? 0) + 1;
  const now = brain.clock().getTime();
  const wait = Math.min(EMBED_RETRY_AFTER_MS * 2 ** (failures - 1), EMBED_BACKOFF_MAX_MS);
  noteEmbedStatus(brain, {
    last_error: message,
    failures,
    retry_at: new Date(now + wait).toISOString(),
    paused_until: failures >= EMBED_BREAKER_FAILURES ? new Date(now + EMBED_PAUSE_MS).toISOString() : current?.paused_until,
  });
}

/**
 * One batch end to end: up to 32 pending rows the provider may see, secret-shaped rows withheld before anything is prepared,
 * one call (a batch whose input the service refuses is retried row by row, and a row refused alone is withheld as rejected),
 * then a fenced, guarded write. A provider vector the store would refuse is withheld for its row, never discarding the rest.
 * A failed or unknown call records a failure (back-off, breaker); vectors already paid for in this attempt are still written.
 * The job itself is never retried, because a Cloudflare job cannot be re-sent under the same dispatch key.
 */
export async function runEmbedBatch(deps: EmbedDeps, job: EmbedJob, signal: AbortSignal): Promise<EmbedOutcome> {
  const { brain, client } = deps;
  const done = (outcome: EmbedOutcome["outcome"], rows = 0, more = false, error?: string): EmbedOutcome => ({ outcome, rows, more, ...(error ? { error } : {}) });
  if (!client) return done("cancelled", 0, false, "Better search is not set up on this computer.");
  const allowed = brain.betterSearchAllowed();
  if (!allowed.on) {
    noteEmbedStatus(brain, { last_error: allowed.reason });
    return done("cancelled", 0, false, allowed.reason);
  }
  // A batch queued before a failure still waits for the back-off: no call until retry_at has passed.
  if (!brain.embedQueueOpen()) return done("cancelled", 0, false, "Better search is waiting before it tries again.");
  const { config } = client;
  const key = modelKey(config.provider, config.model);
  if (key !== allowed.setting.key) return done("cancelled", 0, false, "The search model changed. Choose Better search again.");
  const visibilities = EMBED_VISIBILITIES[config.provider];
  const rows = pendingEmbedRows(brain.store, key, visibilities, EMBED_BATCH_SIZE);
  if (!rows.length) return done("nothing");
  const texts = rows.map((r) => embedText(r.prefix, r.text));
  const vectors: (Float32Array | null)[] = rows.map(() => null);
  const reasons: VectorWrite["reason"][] = rows.map(() => undefined);
  // A secret-shaped text is never sent and never blocks the rest; a blank one could never be embedded.
  texts.forEach((t, i) => {
    if (!t.trim()) reasons[i] = "rejected";
    else if (detectSecrets(t).length > 0) reasons[i] = "secret";
  });
  const more = () => pendingEmbedRows(brain.store, key, visibilities, 1).length > 0;
  /**
   * Re-read right before every call: a row that was replaced, made private (Cloudflare) or rewritten in place since the batch was read
   * is not sent and stays pending, so no text is ever sent under a visibility it no longer has.
   */
  const eligible = (i: number) =>
    !!brain.store.get(
      `SELECT 1 FROM recall_chunks WHERE id=? AND ref_version=? AND status='current' AND text=? AND prefix=? AND visibility IN (${visibilities.map(() => "?").join(",")})`,
      rows[i].id,
      rows[i].ref_version,
      rows[i].text,
      rows[i].prefix,
      ...visibilities,
    );
  let dim = 0;
  let rejectedCount = 0;
  const reject = (i: number) => {
    reasons[i] = "rejected";
    rejectedCount += 1;
  };
  /** Takes one provider vector for row `i`, or withholds the row when the vector is unusable. */
  const take = (i: number, v: Float32Array | undefined, d: number) => {
    if (!dim) dim = d;
    if (d === dim && usable(v, dim)) vectors[i] = v;
    else reject(i);
  };
  // Written only while this attempt still holds its lease and the owner still wants it; otherwise the vectors are dropped and recomputed later.
  // Rows that were neither embedded nor withheld (an interrupted row-by-row pass) are left out, so they stay pending.
  const write = () =>
    brain.store.transaction(() => {
      if (!currentLease(brain, job, deps.leaseOwner) || !brain.betterSearchAllowed().on) return 0;
      const ready = rows.map((r, i) => ({ ...r, vector: vectors[i], reason: reasons[i] })).filter((r) => r.vector !== null || r.reason !== undefined);
      return ready.length ? writeEmbeddings(brain.store, key, dim || 1, ready) : 0;
    });
  /** The write on an early exit: a storage fault here must not turn one outcome into two. */
  const keep = () => {
    try {
      write();
    } catch {
      /* The rows stay pending and the self-heal check picks them up. */
    }
  };
  /** Ends this attempt without counting a failure; anything already paid for is kept. A spending refusal also sets when to try again. */
  const stop = (message: string, retryAt?: string) => {
    keep();
    noteEmbedStatus(brain, { last_error: message, ...(retryAt ? { retry_at: retryAt } : {}) });
    return done("cancelled", 0, false, message);
  };
  /** Ends this attempt as a failure (back-off, breaker); anything already paid for is kept. */
  const fail = (message: string) => {
    keep();
    recordFailure(brain, message);
    return done("failed", 0, false, message);
  };
  try {
    const send = rows.map((_, i) => i).filter((i) => reasons[i] === undefined && eligible(i));
    if (send.length) {
      const batch = await callProvider(deps, job, client, send.map((i) => texts[i]), "embed_batch", signal);
      if (batch.ok) send.forEach((i, k) => take(i, batch.result.vectors[k], batch.result.dim));
      else if (batch.refused) return stop(batch.error.message, batch.retryAt);
      else if (batch.rejected && send.length > 1) {
        // The service refused the batch: one text may be the cause. Each row goes alone under its own dispatch key; a row refused alone is withheld.
        for (const i of send) {
          if (!eligible(i)) continue;
          const one = await callProvider(deps, job, client, [texts[i]], `embed_batch:${rows[i].id}`, signal);
          if (one.ok) take(i, one.result.vectors[0], one.result.dim);
          else if (one.refused) return stop(one.error.message, one.retryAt);
          else if (one.rejected) reject(i);
          else return fail(one.error.message);
        }
      } else if (batch.rejected) reject(send[0]);
      else return fail(batch.error.message);
    }
    const written = write();
    if (!written) return done("cancelled", 0, false);
    noteEmbedStatus(brain, {
      last_ok_at: brain.now(),
      last_error: rejectedCount ? `${rejectedCount} ${rejectedCount === 1 ? "passage was" : "passages were"} refused by the search service and will be skipped until it changes.` : undefined,
      failures: 0,
      retry_at: undefined,
      paused_until: undefined,
    });
    return done("embedded", written, more());
  } catch (error) {
    // A persistence fault of the money journal is fatal and surfaces to the engine; any other ledger or storage fault is a failure like any other.
    if (error instanceof AccountingPersistenceError) throw error;
    recordFailure(brain, error instanceof Error ? error.message : "Better search failed.");
    return done("failed", 0, false, error instanceof Error ? error.message : "Better search failed.");
  }
}

/** The engine's 5-second self-heal: rows without a current vector (after a rebuild, an import or a crash) get a batch, unless one is active, the back-off is running or the breaker is open. */
export function maybeQueueEmbedBatch(brain: Brain): boolean {
  if (!brain.embedQueueOpen()) return false;
  const { setting } = brain.betterSearchAllowed();
  if (!setting.key || setting.mode === "off") return false;
  if (!pendingEmbedRows(brain.store, setting.key, EMBED_VISIBILITIES[setting.mode], 1).length) return false;
  return queueEmbedBatch(brain) !== null;
}

/** The worker's enqueue: the one-at-a-time check and the insert under one write lock, so a capture on the server cannot slip a second batch in between. */
export function queueEmbedBatch(brain: Brain): string | null {
  return brain.store.transaction(() => brain.enqueueEmbedBatch());
}
