import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../../packages/storage/index.ts";
import { Brain } from "../../packages/domain/service.ts";
import { Worker } from "../../apps/worker/engine.ts";
import { LocalDispatchAccounting } from "../../apps/worker/accounting.ts";
import { maybeQueueEmbedBatch, publishBetterSearchStatus, type EmbedClient } from "../../apps/worker/embed.ts";
import { embedFromEnv } from "../../packages/providers/embed-env.ts";
import { DispatchLedger } from "../../packages/storage/spend.ts";
import { EMBED_VISIBILITIES, modelKey, type EmbedProvider } from "../../packages/domain/better-search.ts";
import { countEmbedRows, vectorGeneration } from "../../packages/storage/recall-vectors.ts";
import { FAKE_EMBED_MODEL, fakeEmbedFetcher } from "../helpers/fake-embed.mjs";
import { buildFixture, owner, type Fixture } from "../eval/recall-fixture.ts";
import type { Principal } from "../../packages/contracts/index.ts";

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.reverse()) fn();
  cleanup = [];
});
const KEY = ["sk", "test", "never", "a", "real", "key", "0123456789abcdef"].join("-");
type Opts = { provider?: EmbedProvider; caps?: boolean; before?: (texts: string[]) => void | Promise<void> };
type Fake = { shape: EmbedProvider; status: number; delayMs?: number; reject?: (texts: string[]) => boolean; before?: Opts["before"] };
/** A fixture brain on a movable clock, the published setup for `provider`, a recording fake fetcher (its options are read at call time) and a worker that owns the batch job. */
function batched(opts: Opts = {}) {
  const provider = opts.provider ?? "ollama";
  const dir = mkdtempSync(join(tmpdir(), "embed-batch-"));
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
  if (opts.caps !== false) brain.prefs(owner, { ...brain.prefs(owner), daily_cap_micro_usd: 50_000, per_job_cap_micro_usd: 5_000 });
  const fake: Fake = { shape: provider, status: 200, before: opts.before };
  const { fetcher, calls } = fakeEmbedFetcher(fake);
  const client: EmbedClient = { config: env.config, fetcher };
  const worker = new Worker(brain, undefined, new LocalDispatchAccounting(fx.store, () => time.now), undefined, null, client);
  const drain = async () => {
    for (let i = 0; i < 200; i++) if (!(await worker.tick())) return;
    throw new Error("the worker never drained");
  };
  /** Moves the brain's clock and keeps the worker "running" (its heartbeat is fresh for 30 s only). */
  const advance = (ms: number) => {
    time.now = new Date(time.now.getTime() + ms);
    fx.store.set("worker_heartbeat", brain.now());
  };
  const counts = () => countEmbedRows(fx.store, key, EMBED_VISIBILITIES[provider]);
  const jobs = (status?: string) => fx.store.all<{ id: string; status: string }>(`SELECT id,status FROM jobs WHERE kind='embed_batch'${status ? " AND status=?" : ""} ORDER BY created_at`, ...(status ? [status] : []));
  return { fx, brain, store: fx.store, key, calls, fake, client, worker, drain, advance, counts, jobs, time, provider };
}
const note = (b: Brain, project: string, i: number) => b.capture(owner, { project_id: project, title: `Filler ${i}`, body: `Filler note number ${i} about routine matters.`, visibility: "project", separate: true });

describe("embed_batch", () => {
  it("turning Better search on backfills every eligible current row in batches of at most 32 and then stays idle", async () => {
    const t = batched();
    for (let i = 0; i < 40; i++) note(t.brain, t.fx.ids["project:northstar"], i);
    expect(t.jobs()).toEqual([]);
    expect(t.brain.setBetterSearch(owner, { mode: "ollama" })).toMatchObject({ mode: "ollama", key: t.key });
    expect(t.jobs("queued")).toHaveLength(1);
    const before = t.counts();
    expect(before.pending).toBeGreaterThan(32);
    await t.drain();
    expect(t.calls.n).toBeGreaterThanOrEqual(2);
    for (const texts of t.calls.texts) expect(texts.length).toBeLessThanOrEqual(32);
    expect(t.calls.texts.flat().some((x) => x.startsWith("Launch notes · Northstar · 2026-10-25\nWe met on Tuesday"))).toBe(true);
    const after = t.counts();
    expect(after).toMatchObject({ pending: 0, withheld: 0 });
    expect(after.embedded).toBe(before.total);
    expect(t.store.get<any>("SELECT embedding_dim AS d, length(embedding) AS n FROM recall_chunks WHERE embedding IS NOT NULL LIMIT 1")).toEqual({ d: 256, n: 1024 });
    expect(t.jobs().every((j) => j.status === "succeeded")).toBe(true);
    expect(t.store.all("SELECT 1 FROM provider_dispatches")).toEqual([]);
    const n = t.calls.n;
    await t.drain();
    expect(t.calls.n).toBe(n);
    expect(t.brain.betterSearch(owner)).toMatchObject({ mode: "ollama", effective: true, reason: "ready", counts: { pending: 0 } });
    // A new note queues one more batch and is embedded without touching the rest.
    const g = vectorGeneration();
    note(t.brain, t.fx.ids["project:northstar"], 99);
    expect(t.jobs("queued")).toHaveLength(1);
    await t.drain();
    expect(t.calls.texts.at(-1)!.length).toBe(1);
    expect(t.counts().pending).toBe(0);
    expect(vectorGeneration()).toBeGreaterThan(g);
    expect(t.store.all("SELECT key FROM settings WHERE key LIKE '%vector%' OR key LIKE '%generation%'")).toEqual([]);
  });
  it("Cloudflare never receives private, owner-only or quarantined text, pays through the ledger, and stops when the daily limit is gone", async () => {
    const t = batched({ provider: "cloudflare" });
    t.brain.setBetterSearch(owner, { mode: "cloudflare" });
    await t.drain();
    const sent = JSON.stringify(t.calls.bodies);
    for (const canary of ["PRIVATE_CANARY_TEXT", "Ana Costa", "short answers", "Owner preferences"]) expect(sent).not.toContain(canary);
    expect(t.calls.headers.every((h) => h.Authorization === undefined)).toBe(true);
    const privateRows = t.store.all<any>("SELECT embedding, embedding_model FROM recall_chunks WHERE visibility IN ('private','owner')");
    expect(privateRows.length).toBeGreaterThan(0);
    expect(privateRows.every((r) => r.embedding === null && r.embedding_model === null)).toBe(true);
    expect(t.counts()).toMatchObject({ pending: 0 });
    const dispatches = t.store.all<any>("SELECT dispatch_key,state,provider,actual_micro_usd FROM provider_dispatches");
    expect(dispatches.length).toBe(t.calls.n);
    for (const d of dispatches) expect(d).toMatchObject({ dispatch_key: "embed_batch", state: "settled", provider: "cloudflare" });
    expect(dispatches.every((d) => d.actual_micro_usd > 0)).toBe(true);
    // Quarantine sets visibility private, so the same filter covers it; the words stay searchable for the owner (task 5).
    t.brain.prefs(owner, { ...t.brain.prefs(owner), daily_cap_micro_usd: 0 });
    expect(() => t.brain.setBetterSearch(owner, { mode: "cloudflare" })).toThrow(/limit/);
    expect(t.brain.betterSearch(owner)).toMatchObject({ mode: "cloudflare", effective: false, caps_ok: false });
    // Nothing is queued while the limits are gone, neither by a capture nor by the self-heal check; the stored choice stays.
    note(t.brain, t.fx.ids["project:northstar"], 1);
    expect(t.jobs("queued")).toEqual([]);
    expect(maybeQueueEmbedBatch(t.brain)).toBe(false);
    const n = t.calls.n;
    await t.drain();
    expect(t.calls.n).toBe(n);
    expect(t.brain.betterSearch(owner).reason).toMatch(/limit/);
  });
  it("Cloudflare: an error response settles its hold at 0, a timeout after send keeps it, and an outage never eats the daily limit", async () => {
    const t = batched({ provider: "cloudflare" });
    t.brain.setBetterSearch(owner, { mode: "cloudflare" });
    t.fake.status = 503;
    await t.drain();
    expect(t.calls.n).toBe(1);
    expect(t.store.all<any>("SELECT state,actual_micro_usd FROM provider_dispatches")).toEqual([{ state: "settled", actual_micro_usd: 0 }]);
    expect(t.jobs().at(-1)!.status).toBe("failed");
    expect(t.brain.betterSearch(owner)).toMatchObject({ failures: 1, effective: true });
    // Nothing more is sent while the back-off runs, however often the check runs or notes are captured.
    for (let i = 0; i < 5; i++) {
      note(t.brain, t.fx.ids["project:northstar"], i);
      expect(maybeQueueEmbedBatch(t.brain)).toBe(false);
      await t.drain();
    }
    expect(t.calls.n).toBe(1);
    // A timeout after the request went out: the cost is unknown, the hold stays, and it counts toward the breaker.
    t.advance(61_000);
    t.fake.status = 200;
    t.fake.delayMs = 300;
    t.client.config.timeout_ms = 50;
    expect(maybeQueueEmbedBatch(t.brain)).toBe(true);
    await t.drain();
    expect(t.calls.n).toBe(2);
    expect(t.store.all<any>("SELECT state FROM provider_dispatches ORDER BY created_at").map((r) => r.state)).toEqual(["settled", "dispatched"]);
    expect(t.brain.betterSearch(owner)).toMatchObject({ failures: 2 });
    expect(t.brain.betterSearch(owner).status!.last_error).toMatch(/did not answer in time/);
    const prefs = t.brain.prefs(owner);
    const summary = new DispatchLedger(t.store, () => t.time.now).summary({ per_job_micro_usd: prefs.per_job_cap_micro_usd, daily_micro_usd: prefs.daily_cap_micro_usd, time_zone: prefs.time_zone });
    expect(summary.unresolved_micro_usd).toBeGreaterThan(0);
    expect(summary.unresolved_micro_usd).toBeLessThan(prefs.per_job_cap_micro_usd);
  });
  it("a passage the service refuses is retried alone, withheld as rejected, and never blocks the rest", async () => {
    const t = batched({ provider: "cloudflare" });
    const id = t.fx.ids["src:palette-review"];
    t.store.run("UPDATE recall_chunks SET text=? WHERE kind='original' AND ref_id=? AND ordinal=0", "POISON_ROW the palettes were reviewed", id);
    t.fake.reject = (texts) => texts.some((x) => x.includes("POISON_ROW"));
    t.brain.setBetterSearch(owner, { mode: "cloudflare" });
    await t.drain();
    const first = t.calls.texts[0].length;
    expect(first).toBeGreaterThan(1);
    // One refused batch, then that batch's rows one by one, then the remaining batches.
    expect(t.calls.n).toBeGreaterThanOrEqual(1 + first);
    expect(t.calls.texts.slice(1, 1 + first).every((x) => x.length === 1)).toBe(true);
    expect(t.store.get<any>("SELECT embedding, embedding_model, embedding_dim FROM recall_chunks WHERE kind='original' AND ref_id=? AND ordinal=0", id)).toEqual({ embedding: null, embedding_model: t.key, embedding_dim: -1 });
    expect(t.counts()).toMatchObject({ pending: 0, withheld: 1 });
    expect(t.jobs().every((j) => j.status === "succeeded")).toBe(true);
    expect(t.brain.betterSearch(owner)).toMatchObject({ failures: 0, effective: true });
    expect(t.brain.betterSearch(owner).status!.last_error).toMatch(/refused/);
    const rows = t.store.all<any>("SELECT dispatch_key,state,actual_micro_usd FROM provider_dispatches");
    expect(rows.filter((r) => r.dispatch_key === "embed_batch" && r.actual_micro_usd === 0).length).toBeGreaterThanOrEqual(1);
    expect(rows.filter((r) => r.dispatch_key.startsWith("embed_batch:")).length).toBe(first);
    expect(rows.every((r) => r.state === "settled")).toBe(true);
    // Its text changes with the next edit, so it is embedded then.
    t.brain.editSource(owner, id, { title: "Palette review", body: "Marco reviewed three palettes again.", expected_version: 1 });
    t.fake.reject = undefined;
    await t.drain();
    expect(t.counts()).toMatchObject({ pending: 0, withheld: 0 });
  });
  it("a vector never lands on a row that changed while the provider call was out, and a lost fence writes nothing", async () => {
    const t = batched({
      before: () => {
        const id = t.fx.ids["src:launch-notes"];
        const version = t.store.get<any>("SELECT version FROM sources WHERE id=?", id)!.version;
        if (version === 1) t.brain.editSource(owner, id, { title: "Launch notes", body: "Rewritten while the batch was out: the launch colour is amber now.", expected_version: 1 });
      },
    });
    t.brain.setBetterSearch(owner, { mode: "ollama" });
    // The fixture leaves derive_brief jobs ahead of the batch in the queue: tick until the provider has been called once.
    while (t.calls.n < 1) expect(await t.worker.tick()).toBe(true);
    const id = t.fx.ids["src:launch-notes"];
    expect(Number(t.store.get("SELECT count(*) AS n FROM recall_chunks WHERE ref_id=? AND embedding IS NOT NULL", id)!.n)).toBe(0);
    expect(t.store.all<any>("SELECT ref_version FROM recall_chunks WHERE ref_id=?", id).every((r) => r.ref_version === 2)).toBe(true);
    await t.drain();
    const rows = t.store.all<any>("SELECT ref_version, embedding FROM recall_chunks WHERE ref_id=?", id);
    expect(rows.every((r) => r.ref_version === 2 && r.embedding !== null)).toBe(true);
    expect(t.calls.texts.flat().some((x) => x.includes("amber now"))).toBe(true);
    // Fence: the attempt is superseded during the call; its vectors are discarded, nothing is written.
    const u = batched({ before: () => { u.store.run("UPDATE jobs SET fence=fence+1 WHERE kind='embed_batch' AND status='running'"); } });
    u.brain.setBetterSearch(owner, { mode: "ollama" });
    while (u.calls.n < 1) expect(await u.worker.tick()).toBe(true);
    expect(u.calls.n).toBe(1);
    expect(u.counts().embedded).toBe(0);
  });
  it("turning it off clears every vector and queued batch; choosing again queues a fresh backfill; a changed model is a fresh choice", async () => {
    const t = batched();
    t.brain.setBetterSearch(owner, { mode: "ollama" });
    await t.drain();
    expect(t.counts().embedded).toBeGreaterThan(0);
    note(t.brain, t.fx.ids["project:northstar"], 1);
    expect(t.jobs("queued")).toHaveLength(1);
    const g = vectorGeneration();
    expect(t.brain.setBetterSearch(owner, { mode: "off" })).toEqual({ mode: "off", key: null, consented_at: null });
    expect(t.counts().embedded).toBe(0);
    expect(t.jobs("queued")).toEqual([]);
    expect(vectorGeneration()).toBeGreaterThan(g);
    expect(t.brain.betterSearch(owner)).toMatchObject({ mode: "off", effective: false, reason: "Better search is off." });
    const n = t.calls.n;
    await t.drain();
    expect(t.calls.n).toBe(n);
    t.brain.setBetterSearch(owner, { mode: "ollama" });
    expect(t.jobs("queued")).toHaveLength(1);
    expect(t.brain.betterSearch(owner).counts.pending).toBeGreaterThan(0);
    await t.drain();
    // The worker now publishes another model: the stored choice no longer applies, and nothing is queued or run until the owner chooses again.
    publishBetterSearchStatus(t.brain, { configured: true, provider: "ollama", model: "other", key: modelKey("ollama", "other"), label: "Ollama on this computer" });
    expect(t.brain.betterSearch(owner)).toMatchObject({ effective: false, reason: "The search model changed. Choose Better search again." });
    note(t.brain, t.fx.ids["project:northstar"], 2);
    expect(t.jobs("queued")).toEqual([]);
    const m = t.calls.n;
    await t.drain();
    expect(t.calls.n).toBe(m);
    expect(maybeQueueEmbedBatch(t.brain)).toBe(false);
  });
  it("a secret-shaped passage is withheld, never sent, and never blocks the rest of the batch", async () => {
    const t = batched();
    const id = t.fx.ids["src:launch-notes"];
    t.store.run("UPDATE recall_chunks SET text=? WHERE kind='original' AND ref_id=? AND ordinal=0", `api_key = ${KEY} and the launch colour is cobalt`, id);
    t.brain.setBetterSearch(owner, { mode: "ollama" });
    await t.drain();
    expect(JSON.stringify(t.calls.bodies)).not.toContain(KEY);
    expect(t.store.get<any>("SELECT embedding, embedding_model FROM recall_chunks WHERE kind='original' AND ref_id=? AND ordinal=0", id)).toEqual({ embedding: null, embedding_model: t.key });
    expect(t.counts()).toMatchObject({ pending: 0, withheld: 1 });
    expect(t.counts().embedded).toBeGreaterThan(0);
  });
  it("the self-heal check queues a batch after a rebuild; failures back off 60 s then 120 s, the third pauses everything for 15 minutes, a success resets", async () => {
    const t = batched();
    t.brain.setBetterSearch(owner, { mode: "ollama" });
    await t.drain();
    t.store.rebuildRecallIndex();
    expect(t.counts().embedded).toBe(0);
    expect(t.jobs("queued")).toEqual([]);
    expect(maybeQueueEmbedBatch(t.brain)).toBe(true);
    expect(maybeQueueEmbedBatch(t.brain)).toBe(false);
    await t.drain();
    expect(t.counts().pending).toBe(0);
    // An outage: each failed batch ends at once (no attempt loop), the next waits for the back-off, the third opens the breaker.
    t.fake.status = 503;
    t.store.rebuildRecallIndex();
    expect(maybeQueueEmbedBatch(t.brain)).toBe(true);
    await t.drain();
    expect(t.jobs().at(-1)!.status).toBe("failed");
    expect(t.calls.n).toBeGreaterThan(0);
    const afterFirst = t.calls.n;
    expect(t.brain.betterSearch(owner)).toMatchObject({ failures: 1, effective: true, paused_until: null });
    expect(t.brain.betterSearch(owner).status!.last_error).toMatch(/503/);
    expect(maybeQueueEmbedBatch(t.brain)).toBe(false);
    t.advance(59_000);
    expect(maybeQueueEmbedBatch(t.brain)).toBe(false);
    t.advance(2_000);
    expect(maybeQueueEmbedBatch(t.brain)).toBe(true);
    await t.drain();
    expect(t.calls.n).toBe(afterFirst + 1);
    expect(t.brain.betterSearch(owner).failures).toBe(2);
    t.advance(61_000);
    expect(maybeQueueEmbedBatch(t.brain)).toBe(false);
    t.advance(60_000);
    expect(maybeQueueEmbedBatch(t.brain)).toBe(true);
    await t.drain();
    const paused = t.brain.betterSearch(owner);
    expect(paused).toMatchObject({ failures: 3, effective: false, reason: "Better search paused: the service is not answering." });
    expect(paused.paused_until).not.toBeNull();
    // The query lane reads the same rule: while paused a question gets words only, at once, with nothing queued and nothing sent.
    expect(t.brain.betterSearchAllowed()).toMatchObject({ on: false, reason: "Better search paused: the service is not answering." });
    const sentBefore = t.calls.n;
    const startedAt = Date.now();
    expect(await t.brain.queryVector(owner, "launch colour")).toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(100);
    expect(t.store.all("SELECT 1 FROM jobs WHERE kind='recall_embed'")).toEqual([]);
    expect(t.calls.n).toBe(sentBefore);
    t.advance(5 * 60_000);
    expect(maybeQueueEmbedBatch(t.brain)).toBe(false);
    t.advance(11 * 60_000);
    t.fake.status = 200;
    expect(maybeQueueEmbedBatch(t.brain)).toBe(true);
    await t.drain();
    expect(t.counts().pending).toBe(0);
    expect(t.brain.betterSearch(owner)).toMatchObject({ failures: 0, effective: true, retry_at: null, paused_until: null });
  });
  it("a vector that is not finite after normalising is withheld as rejected and never discards the rest of the batch", async () => {
    const t = batched();
    const id = t.fx.ids["src:launch-notes"];
    t.store.run("UPDATE recall_chunks SET text=? WHERE kind='original' AND ref_id=? AND ordinal=0", "HUGE_ROW the launch colour is cobalt", id);
    const plain = t.client.fetcher!;
    // A finite double above the Float32 range becomes Infinity once stored as Float32, so normalising yields NaN.
    t.client.fetcher = (async (url: string, init: RequestInit) => {
      const texts: string[] = JSON.parse(String(init.body)).input;
      if (!texts.some((x) => x.includes("HUGE_ROW"))) return plain(url, init);
      const res = await plain(url, init);
      const body = await res.json();
      body.embeddings = body.embeddings.map((v: number[], i: number) => (texts[i].includes("HUGE_ROW") ? v.map((_, d) => (d === 0 ? 1e39 : 0)) : v));
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    t.brain.setBetterSearch(owner, { mode: "ollama" });
    await t.drain();
    expect(t.store.get<any>("SELECT embedding, embedding_model, embedding_dim FROM recall_chunks WHERE kind='original' AND ref_id=? AND ordinal=0", id)).toEqual({ embedding: null, embedding_model: t.key, embedding_dim: -1 });
    expect(t.counts()).toMatchObject({ pending: 0, withheld: 1 });
    expect(t.counts().embedded).toBeGreaterThan(0);
    expect(t.jobs().every((j) => j.status === "succeeded")).toBe(true);
    expect(t.brain.betterSearch(owner)).toMatchObject({ failures: 0, effective: true });
  });
  it("the choice is owner-only, outside the preferences, refused without the worker's matching setup, and its jobs stay out of the Settings job list", () => {
    const dir = mkdtempSync(join(tmpdir(), "better-search-consent-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const s = new Storage(join(dir, "brain.sqlite"));
    cleanup.push(() => s.close());
    const b = new Brain(s, () => new Date("2026-10-25T09:00:00.000Z"));
    expect(b.betterSearch(owner)).toMatchObject({ mode: "off", status: null, effective: false, counts: { total: 0, embedded: 0, pending: 0, withheld: 0 } });
    expect(() => b.setBetterSearch(owner, { mode: "ollama" })).toThrow(/background worker starts/);
    publishBetterSearchStatus(b, { configured: true, provider: "cloudflare", model: "@cf/baai/bge-m3", key: modelKey("cloudflare", "@cf/baai/bge-m3"), label: "Cloudflare" });
    expect(() => b.setBetterSearch(owner, { mode: "ollama" })).toThrow(/Ollama on this computer is not set up/);
    expect(() => b.setBetterSearch(owner, { mode: "cloudflare" })).toThrow(/background worker is not running/);
    s.set("worker_heartbeat", b.now());
    expect(() => b.setBetterSearch(owner, { mode: "cloudflare" })).toThrow(/limit/);
    b.prefs(owner, { ...b.prefs(owner), daily_cap_micro_usd: 1000, per_job_cap_micro_usd: 100 });
    expect(b.setBetterSearch(owner, { mode: "cloudflare" })).toMatchObject({ mode: "cloudflare", key: "cloudflare:@cf/baai/bge-m3:none" });
    expect(s.all("SELECT id FROM jobs WHERE kind='embed_batch' AND status='queued'")).toHaveLength(1);
    expect("better_search" in b.prefs(owner)).toBe(false);
    expect(() => b.prefs(owner, { ...b.prefs(owner) })).not.toThrow();
    expect(() => b.setBetterSearch(owner, { mode: "sideways" })).toThrow();
    const agent: Principal = b.authenticateAgent(b.createGrant(owner, { projects: ["inbox"], operations: ["read"], expires_at: "2027-01-01T00:00:00.000Z" }).token);
    expect(() => b.betterSearch(agent)).toThrow(/Owner access required/);
    expect(() => b.setBetterSearch(agent, { mode: "off" })).toThrow(/Owner access required/);
    s.run("INSERT INTO jobs(id,project_id,kind,payload,status,next_at,created_at) VALUES('e1','inbox','recall_embed','{}','succeeded',?,?)", b.now(), b.now());
    expect(b.status(owner).jobs.some((j: any) => j.kind === "embed_batch" || j.kind === "recall_embed")).toBe(false);
    expect(() => b.job(owner, "e1")).toThrow(/unavailable/);
    expect(b.setBetterSearch(owner, { mode: "off" })).toEqual({ mode: "off", key: null, consented_at: null });
  });

  /** Ticks until the worker has nothing left, returning how many ticks that took (a hot loop fails at 200). */
  const ticksToDrain = async (worker: Worker) => {
    for (let i = 1; i <= 200; i++) if (!(await worker.tick())) return i;
    throw new Error("the worker never drained");
  };
  const embedRows = (t: ReturnType<typeof batched>, status: string) => t.jobs(status).length;

  it("a spent daily limit refuses once, waits for the next accounting day without counting a failure, and never spins", async () => {
    const t = batched({ provider: "cloudflare" });
    t.brain.setBetterSearch(owner, { mode: "cloudflare" });
    await t.drain();
    // Today's limit is now exactly what was spent; a rebuild leaves every row pending again.
    const spent = Number(t.store.get<any>("SELECT sum(actual_micro_usd) AS n FROM provider_dispatches WHERE state='settled'")!.n);
    expect(spent).toBeGreaterThan(0);
    t.brain.prefs(owner, { ...t.brain.prefs(owner), daily_cap_micro_usd: spent });
    t.store.rebuildRecallIndex();
    expect(maybeQueueEmbedBatch(t.brain)).toBe(true);
    const calls = t.calls.n;
    const ticks = await ticksToDrain(t.worker);
    expect(ticks).toBeLessThanOrEqual(3);
    expect(embedRows(t, "cancelled")).toBe(1);
    expect(t.jobs("queued")).toEqual([]);
    expect(t.calls.n).toBe(calls);
    const view = t.brain.betterSearch(owner);
    expect(view).toMatchObject({ failures: 0, effective: true, paused_until: null });
    expect(view.status!.last_error).toMatch(/spending cap/);
    // The wait ends exactly when the owner's accounting day (Asia/Calcutta, 18:30Z) rolls over.
    expect(view.retry_at).toBe("2026-10-25T18:30:00.000Z");
    // The self-heal check stays quiet until then, however often it runs.
    for (let i = 0; i < 3; i++) expect(maybeQueueEmbedBatch(t.brain)).toBe(false);
    t.advance(Date.parse("2026-10-25T18:29:00.000Z") - t.time.now.getTime());
    expect(maybeQueueEmbedBatch(t.brain)).toBe(false);
    t.advance(2 * 60_000);
    expect(maybeQueueEmbedBatch(t.brain)).toBe(true);
    await t.drain();
    expect(t.counts().pending).toBe(0);
    expect(t.brain.betterSearch(owner)).toMatchObject({ failures: 0, retry_at: null });
  });
  it("a per-preparation limit no batch fits under refuses once, sends nothing and waits 15 minutes without counting a failure", async () => {
    const t = batched({ provider: "cloudflare" });
    t.brain.prefs(owner, { ...t.brain.prefs(owner), per_job_cap_micro_usd: 1 });
    t.brain.setBetterSearch(owner, { mode: "cloudflare" });
    const ticks = await ticksToDrain(t.worker);
    // The fixture's own queued jobs run too; the batch itself runs once.
    expect(ticks).toBeLessThan(40);
    expect(embedRows(t, "cancelled")).toBe(1);
    expect(t.jobs()).toHaveLength(1);
    expect(t.calls.n).toBe(0);
    expect(t.store.all("SELECT 1 FROM provider_dispatches")).toEqual([]);
    expect(t.brain.betterSearch(owner)).toMatchObject({ failures: 0, retry_at: new Date(t.time.now.getTime() + 15 * 60_000).toISOString() });
    expect(maybeQueueEmbedBatch(t.brain)).toBe(false);
    t.advance(14 * 60_000);
    expect(maybeQueueEmbedBatch(t.brain)).toBe(false);
    t.advance(2 * 60_000);
    expect(maybeQueueEmbedBatch(t.brain)).toBe(true);
  });
  it("a row made private while its batch was being refused is never sent on its own", async () => {
    const t = batched({ provider: "cloudflare" });
    const flip = t.store.get<any>("SELECT id FROM recall_chunks WHERE status='current' AND visibility='project' ORDER BY id LIMIT 1")!.id;
    t.store.run("UPDATE recall_chunks SET text=? WHERE id=?", "FLIP_ROW the launch colour is cobalt", flip);
    t.fake.reject = (texts) => texts.length > 1;
    t.fake.before = () => {
      if (t.calls.n === 1) t.store.run("UPDATE recall_chunks SET visibility='private' WHERE id=?", flip);
    };
    t.brain.setBetterSearch(owner, { mode: "cloudflare" });
    await t.drain();
    expect(t.calls.texts[0].some((x) => x.includes("FLIP_ROW"))).toBe(true);
    expect(t.calls.texts.slice(1).flat().some((x) => x.includes("FLIP_ROW"))).toBe(false);
    expect(t.store.get<any>("SELECT embedding, embedding_model FROM recall_chunks WHERE id=?", flip)).toEqual({ embedding: null, embedding_model: null });
    expect(t.counts()).toMatchObject({ pending: 0 });
  });
  it("a restart keeps the back-off and the pause for the same model, and a new model starts clean", async () => {
    const t = batched();
    t.brain.setBetterSearch(owner, { mode: "ollama" });
    await t.drain();
    const status = t.store.setting<any>("better_search_status", null);
    const at = (ms: number) => new Date(t.time.now.getTime() + ms).toISOString();
    t.store.set("better_search_status", { ...status, failures: 3, retry_at: at(240_000), paused_until: at(900_000), last_error: "The search model answered 503." });
    // The worker starts again with the same model: the breaker stays open and the first schedule queues nothing.
    publishBetterSearchStatus(t.brain, { configured: true, provider: "ollama", model: FAKE_EMBED_MODEL, key: t.key, label: "Ollama on this computer" });
    expect(t.brain.betterSearch(owner)).toMatchObject({ failures: 3, effective: false, reason: "Better search paused: the service is not answering.", retry_at: at(240_000), paused_until: at(900_000) });
    t.store.rebuildRecallIndex();
    const restarted = new Worker(t.brain, undefined, new LocalDispatchAccounting(t.store, () => t.time.now), undefined, null, t.client);
    const calls = t.calls.n;
    for (let i = 0; i < 200 && (await restarted.tick()); i++);
    expect(t.jobs("queued")).toEqual([]);
    expect(t.calls.n).toBe(calls);
    // A different model is a fresh start.
    publishBetterSearchStatus(t.brain, { configured: true, provider: "ollama", model: "other", key: modelKey("ollama", "other"), label: "Ollama on this computer" });
    expect(t.brain.betterSearch(owner)).toMatchObject({ failures: 0, retry_at: null, paused_until: null });
  });
  it("turning it off while a batch is out writes nothing and queues no further batch", async () => {
    const t = batched();
    t.fake.before = () => {
      if (t.calls.n === 1) t.brain.setBetterSearch(owner, { mode: "off" });
    };
    t.brain.setBetterSearch(owner, { mode: "ollama" });
    await t.drain();
    expect(t.calls.n).toBe(1);
    expect(t.jobs()).toHaveLength(1);
    expect(t.jobs("cancelled")).toHaveLength(1);
    expect(Number(t.store.get<any>("SELECT count(*) AS n FROM recall_chunks WHERE embedding IS NOT NULL OR embedding_model IS NOT NULL")!.n)).toBe(0);
  });
  it("a row whose text or prefix changed in place while the call was out never receives the vector of the old text", async () => {
    const t = batched();
    const row = t.store.get<any>("SELECT id FROM recall_chunks WHERE status='current' ORDER BY id LIMIT 1")!.id;
    const other = t.store.get<any>("SELECT id FROM recall_chunks WHERE status='current' AND id>? ORDER BY id LIMIT 1", row)!.id;
    t.fake.before = () => {
      if (t.calls.n !== 1) return;
      t.store.run("UPDATE recall_chunks SET prefix=prefix||' (renamed)' WHERE id=?", row);
      t.store.run("UPDATE recall_chunks SET text=text||' (edited)' WHERE id=?", other);
    };
    t.brain.setBetterSearch(owner, { mode: "ollama" });
    while (t.calls.n < 1) expect(await t.worker.tick()).toBe(true);
    expect(t.store.all<any>("SELECT embedding FROM recall_chunks WHERE id IN (?,?)", row, other).every((r) => r.embedding === null)).toBe(true);
    await t.drain();
    expect(t.store.all<any>("SELECT embedding FROM recall_chunks WHERE id IN (?,?)", row, other).every((r) => r.embedding !== null)).toBe(true);
    const later = t.calls.texts.slice(1).flat();
    expect(later.some((x) => x.includes("(renamed)"))).toBe(true);
    expect(later.some((x) => x.includes("(edited)"))).toBe(true);
    expect(t.counts().pending).toBe(0);
  });
});
