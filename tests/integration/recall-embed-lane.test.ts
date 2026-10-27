import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Brain } from "../../packages/domain/service.ts";
import { LocalDispatchAccounting } from "../../apps/worker/accounting.ts";
import { Worker } from "../../apps/worker/engine.ts";
import { publishBetterSearchStatus } from "../../apps/worker/embed.ts";
import { runQueryEmbedOnce, sweepEmbedRows, type QueryEmbedDeps } from "../../apps/worker/recall-embed.ts";
import { embedFromEnv } from "../../packages/providers/embed-env.ts";
import { modelKey, type EmbedProvider } from "../../packages/domain/better-search.ts";
import { FAKE_EMBED_DIM, FAKE_EMBED_MODEL, cosine, fakeEmbed, fakeEmbedFetcher } from "../helpers/fake-embed.mjs";
import { buildFixture, owner, type Fixture } from "../eval/recall-fixture.ts";
import type { Principal } from "../../packages/contracts/index.ts";

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.reverse()) fn();
  cleanup = [];
});
const KEY = ["sk", "test", "never", "a", "real", "key", "0123456789abcdef"].join("-");
function lane(opts: { provider?: EmbedProvider; delayMs?: number; on?: boolean } = {}) {
  const provider = opts.provider ?? "ollama";
  const dir = mkdtempSync(join(tmpdir(), "recall-embed-lane-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const fx: Fixture = buildFixture(join(dir, "fixture.sqlite"));
  cleanup.push(() => fx.store.close());
  const time = { now: new Date("2026-10-25T09:00:00.000Z") };
  const brain = new Brain(fx.store, () => time.now);
  const model = provider === "ollama" ? FAKE_EMBED_MODEL : "@cf/baai/bge-m3";
  const env = embedFromEnv({ BRAIN_EMBED_PROVIDER: provider, BRAIN_EMBED_MODEL: model, BRAIN_EMBED_ENDPOINT: provider === "ollama" ? "http://127.0.0.1:9/api/embed" : "http://127.0.0.1:9/client/v4/accounts/test/ai/run/@cf/baai/bge-m3" });
  if (!env.config) throw new Error(env.reason);
  const key = modelKey(provider, model);
  publishBetterSearchStatus(brain, { configured: true, provider, model, key, label: env.label });
  brain.store.set("worker_heartbeat", brain.now());
  brain.prefs(owner, { ...brain.prefs(owner), daily_cap_micro_usd: 50_000, per_job_cap_micro_usd: 5_000 });
  if (opts.on !== false) brain.setBetterSearch(owner, { mode: provider });
  const fake = { shape: provider, delayMs: opts.delayMs, status: 200 as number };
  const { fetcher, calls } = fakeEmbedFetcher(fake);
  const deps: QueryEmbedDeps = { brain, ledger: new LocalDispatchAccounting(fx.store, () => time.now), client: { config: env.config, fetcher }, owner, workerId: "worker-test" };
  const cache = new Map();
  const agent: Principal = brain.authenticateAgent(fx.agentToken);
  /** The recall and, in parallel, worker passes every 20 ms until the work settles (the loop stand-in). */
  const withWorker = async <T>(work: () => Promise<T>) => {
    let running = true;
    const pump = (async () => {
      while (running) {
        await runQueryEmbedOnce(deps, cache);
        await new Promise((r) => setTimeout(r, 20));
      }
    })();
    try {
      return await work();
    } finally {
      running = false;
      await pump;
    }
  };
  const embedJobs = () => fx.store.all<{ id: string; status: string }>("SELECT id,status FROM jobs WHERE kind='recall_embed' ORDER BY created_at");
  const keys = () => fx.store.all<{ key: string; value: string }>("SELECT key,value FROM settings WHERE key LIKE 'recall_embed%'");
  return { fx, brain, store: fx.store, agent, deps, cache, calls, fake, key, time, withWorker, embedJobs, keys };
}

describe("the query embedding fast lane", () => {
  it("answers an agent's query vector through lease, one call and a published result, leaving no query text behind", async () => {
    const t = lane();
    const out = await t.withWorker(() => t.brain.queryVector(t.agent, "which hue was chosen for the release"));
    expect(out).not.toBeNull();
    expect(out!.key).toBe(t.key);
    expect(out!.dim).toBe(FAKE_EMBED_DIM);
    expect(cosine([...out!.vector], fakeEmbed("which hue was chosen for the release"))).toBeGreaterThan(0.999);
    expect(t.calls.n).toBe(1);
    expect(t.calls.texts[0]).toEqual(["which hue was chosen for the release"]);
    expect(t.embedJobs()).toEqual([{ id: expect.any(String), status: "succeeded" }]);
    expect(t.keys()).toEqual([]);
    expect(t.store.all("SELECT 1 FROM provider_dispatches")).toEqual([]);
  });
  it("falls back to words only at the 400 ms deadline when no worker answers, cancelling the job and deleting its query text", async () => {
    const t = lane();
    const started = Date.now();
    const out = await t.brain.queryVector(owner, "when does the stand-up happen");
    const elapsed = Date.now() - started;
    expect(out).toBeNull();
    expect(elapsed).toBeGreaterThanOrEqual(380);
    expect(elapsed).toBeLessThan(800);
    expect(t.embedJobs()).toEqual([{ id: expect.any(String), status: "cancelled" }]);
    expect(t.keys()).toEqual([]);
    expect(await runQueryEmbedOnce(t.deps, t.cache)).toBe(false);
    expect(t.calls.n).toBe(0);
  });
  it("serves a repeated question from the worker cache, and a late answer is cached for the next identical question", async () => {
    const t = lane();
    await t.withWorker(() => t.brain.queryVector(owner, "monthly fee"));
    await t.withWorker(() => t.brain.queryVector(owner, "monthly fee"));
    expect(t.calls.n).toBe(1);
    expect(t.embedJobs().map((j) => j.status)).toEqual(["succeeded", "succeeded"]);
    const slow = lane({ delayMs: 600 });
    const first = await slow.withWorker(() => slow.brain.queryVector(owner, "food supplier for the celebration"));
    expect(first).toBeNull();
    // The worker's call was still out when the server gave up; its answer feeds the cache. (On the test's fixed clock the worker still
    // sees the deadline ahead and publishes a result nobody reads; the real clock has passed it, and the sweeper deletes it either way.)
    expect(slow.store.all("SELECT key FROM settings WHERE key LIKE 'recall_embed:%'")).toEqual([]);
    expect(slow.cache.size).toBe(1);
    slow.fake.delayMs = 0;
    const second = await slow.withWorker(() => slow.brain.queryVector(owner, "food supplier for the celebration"));
    expect(second).not.toBeNull();
    expect(slow.calls.n).toBe(1);
  });
  it("queues nothing when Better search is off, not effective, the worker is stale, the query is empty or looks like a secret", async () => {
    for (const setup of [
      () => lane({ on: false }),
      () => {
        const t = lane();
        publishBetterSearchStatus(t.brain, { configured: true, provider: "ollama", model: "other", key: modelKey("ollama", "other"), label: "Ollama on this computer" });
        return t;
      },
      () => {
        const t = lane();
        t.store.set("worker_heartbeat", "2026-10-25T08:00:00.000Z");
        return t;
      },
    ]) {
      const t = setup();
      const started = Date.now();
      expect(await t.brain.queryVector(owner, "launch colour")).toBeNull();
      expect(Date.now() - started).toBeLessThan(100);
      expect(t.embedJobs()).toEqual([]);
      cleanup.reverse().forEach((fn) => fn());
      cleanup = [];
    }
    const t = lane();
    expect(await t.brain.queryVector(owner, "   ")).toBeNull();
    expect(await t.brain.queryVector(owner, `api_key = ${KEY} launch colour`)).toBeNull();
    expect(t.embedJobs()).toEqual([]);
    expect(t.calls.n).toBe(0);
  });
  it("Cloudflare query embedding goes through reserve, mark, call and settle under dispatch_key recall_embed, and never pays for a job about to expire", async () => {
    const t = lane({ provider: "cloudflare" });
    const out = await t.withWorker(() => t.brain.queryVector(t.agent, "மாத விலை எவ்வளவு"));
    expect(out).not.toBeNull();
    const [row] = t.store.all<any>("SELECT dispatch_key,state,provider,actual_micro_usd FROM provider_dispatches");
    expect(row).toMatchObject({ dispatch_key: "recall_embed", state: "settled", provider: "cloudflare" });
    expect(row.actual_micro_usd).toBeGreaterThan(0);
    expect(JSON.stringify(t.calls.bodies)).not.toContain(KEY);
    // A job with less than 50 ms left is cancelled without a call or a hold.
    const id = "late-job";
    t.store.run("INSERT INTO jobs(id,project_id,kind,payload,status,max_attempts,next_at,created_at,deadline_at) VALUES(?,?,?,?,?,?,?,?,?)", id, "inbox", "recall_embed", JSON.stringify({ request_id: id, request_hash: "h" }), "queued", 1, t.brain.now(), t.brain.now(), new Date(t.time.now.getTime() + 20).toISOString());
    t.store.set(`recall_embed:${id}`, { query: "late question", request_hash: "h", created_at: t.brain.now() });
    expect(await runQueryEmbedOnce(t.deps, t.cache)).toBe(true);
    expect(t.calls.n).toBe(1);
    expect(t.store.all("SELECT 1 FROM provider_dispatches")).toHaveLength(1);
    expect(t.store.get<any>("SELECT status FROM jobs WHERE id=?", id)!.status).toBe("cancelled");
    expect(t.keys()).toEqual([]);
  });
  it("the sweeper cancels stale rows, deletes orphan keys, and removes old unreferenced rows", () => {
    const t = lane();
    const mk = (id: string, status: string, createdAt: string, deadline: string) =>
      t.store.run("INSERT INTO jobs(id,project_id,kind,payload,status,max_attempts,next_at,created_at,deadline_at) VALUES(?,?,?,?,?,?,?,?,?)", id, "inbox", "recall_embed", "{}", status, 1, createdAt, createdAt, deadline);
    mk("stale", "queued", "2026-10-25T08:59:00.000Z", "2026-10-25T08:59:01.000Z");
    mk("old", "succeeded", "2026-10-25T07:00:00.000Z", "2026-10-25T07:00:01.000Z");
    mk("fresh", "queued", t.brain.now(), new Date(t.time.now.getTime() + 400).toISOString());
    t.store.set("recall_embed:stale", { query: "gone", request_hash: "x", created_at: "2026-10-25T08:59:00.000Z" });
    t.store.set("recall_embed_result:old", { key: t.key, dim: 1, vector: "AACAPw==", at: "2026-10-25T07:00:00.000Z" });
    t.store.set("recall_embed:fresh", { query: "kept", request_hash: "y", created_at: t.brain.now() });
    sweepEmbedRows(t.brain);
    expect(t.store.get<any>("SELECT status FROM jobs WHERE id='stale'")!.status).toBe("cancelled");
    expect(t.store.get("SELECT 1 FROM jobs WHERE id='old'")).toBeUndefined();
    expect(t.store.get<any>("SELECT status FROM jobs WHERE id='fresh'")!.status).toBe("queued");
    expect(t.keys().map((k) => k.key)).toEqual(["recall_embed:fresh"]);
  });
  it("the main worker loop never leases, fails or schedules a query row: only the fast lane owns it", () => {
    const t = lane();
    // The fixture's own preparation jobs are set aside, so the only leasable rows are the query rows.
    t.store.run("UPDATE jobs SET status='succeeded' WHERE kind<>'recall_embed'");
    const mk = (id: string, status: string, deadline: string) =>
      t.store.run("INSERT INTO jobs(id,project_id,kind,payload,status,max_attempts,next_at,created_at,deadline_at,lease_until) VALUES(?,?,?,?,?,?,?,?,?,?)", id, "inbox", "recall_embed", "{}", status, 1, t.brain.now(), t.brain.now(), deadline, status === "running" ? "2026-10-25T08:00:00.000Z" : null);
    mk("q-queued", "queued", new Date(t.time.now.getTime() + 400).toISOString());
    mk("q-running", "running", "2026-10-25T08:59:00.000Z");
    const worker = new Worker(t.brain);
    expect(worker.lease()).toBeUndefined();
    worker.schedule();
    expect(t.store.all<any>("SELECT id,status FROM jobs WHERE kind='recall_embed' ORDER BY id")).toEqual([
      { id: "q-queued", status: "queued" },
      { id: "q-running", status: "running" },
    ]);
  });
});
