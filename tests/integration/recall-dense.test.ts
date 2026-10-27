import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFixture, owner, type Fixture } from "../eval/recall-fixture.ts";
import { embedFixture, fakeVector } from "../eval/dense-fixture.ts";
import { FAKE_EMBED_DIM, FAKE_EMBED_MODEL, fakeEmbed, fakeEmbedFetcher } from "../helpers/fake-embed.mjs";
import { Brain } from "../../packages/domain/service.ts";
import { LocalDispatchAccounting } from "../../apps/worker/accounting.ts";
import { runQueryEmbedOnce, type QueryEmbedDeps } from "../../apps/worker/recall-embed.ts";
import { embedFromEnv } from "../../packages/providers/embed-env.ts";
import { BETTER_SEARCH, BETTER_SEARCH_OFF, encodeVector, normalize } from "../../packages/domain/better-search.ts";
import { VectorCache, bumpVectorGeneration, pendingEmbedRows } from "../../packages/storage/recall-vectors.ts";
import type { RecallResult } from "../../packages/domain/recall.ts";

let cleanup: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const fn of cleanup.reverse()) fn();
  cleanup = [];
});
const everywhere = (r: RecallResult) => JSON.stringify({ ...r, searched: { ...r.searched, query: "" } });
function dense() {
  const dir = mkdtempSync(join(tmpdir(), "recall-dense-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const fx: Fixture = buildFixture(join(dir, "fixture.sqlite"));
  cleanup.push(() => fx.store.close());
  const e = embedFixture(fx);
  return { fx, ...e, ns: fx.ids["project:northstar"] };
}
/** A worker pump for the owner-screen cases: the lane answers from the same fake model the fixture was embedded with. */
function pump(fx: Fixture) {
  const env = embedFromEnv({ BRAIN_EMBED_PROVIDER: "ollama", BRAIN_EMBED_MODEL: FAKE_EMBED_MODEL, BRAIN_EMBED_ENDPOINT: "http://127.0.0.1:9/api/embed" });
  if (!env.config) throw new Error(env.reason);
  const { fetcher, calls } = fakeEmbedFetcher();
  const deps: QueryEmbedDeps = { brain: fx.brain, ledger: new LocalDispatchAccounting(fx.store, fx.brain.clock), client: { config: env.config, fetcher }, owner, workerId: "w" };
  const cache = new Map();
  const withWorker = async <T>(work: () => Promise<T>) => {
    let running = true;
    const loop = (async () => {
      while (running) {
        await runQueryEmbedOnce(deps, cache);
        await new Promise((r) => setTimeout(r, 15));
      }
    })();
    try {
      return await work();
    } finally {
      running = false;
      await loop;
    }
  };
  return { withWorker, calls };
}

describe("dense recall", () => {
  it("a paraphrased question finds the note with Better search on and not without it, for the owner and an agent", () => {
    const t = dense();
    const q = "which hue was chosen for the release";
    for (const p of [owner, t.fx.agent]) {
      const on = t.fx.brain.recallCore(p, { query: q }, t.dense(q));
      const ids = on.hits.slice(0, 5).map((h) => h.id);
      expect(ids).toContain(t.fx.ids["fact:launch-color"]);
      expect(on.hits.find((h) => h.id === t.fx.ids["fact:launch-color"])!.why).toContain("similar meaning");
      expect(on.status).toBe("partial");
      expect(on.near_misses.length).toBeLessThanOrEqual(3);
      const off = t.fx.brain.recallCore(p, { query: q });
      expect(off.hits.map((h) => h.id)).not.toContain(t.fx.ids["fact:launch-color"]);
      expect(JSON.stringify(off)).toBe(JSON.stringify(t.fx.brain.recallCore(p, { query: q }, null)));
    }
    expect(t.fx.brain.recallInternal(owner, { query: q, history: false, limit: 8 }).dense).toBe(false);
    expect(t.fx.brain.recallInternal(owner, { query: q, history: false, limit: 8 }, t.dense(q)).dense).toBe(true);
    expect(t.fx.store.all("SELECT 1 FROM jobs WHERE kind IN ('recall_embed','embed_batch')")).toEqual([]);
  });
  it("dense candidates pass the same authorization: the scope filter first, then the per-hit re-check", () => {
    const t = dense();
    const q = "was the launch colour the right call";
    const mine = t.fx.brain.recallCore(owner, { query: q }, t.dense(q));
    expect(mine.hits.map((h) => h.id)).toContain(t.fx.ids["src:private-journal"]);
    const theirs = t.fx.brain.recallCore(t.fx.agent, { query: q }, t.dense(q));
    expect(everywhere(theirs)).not.toContain("PRIVATE_CANARY");
    expect(everywhere(theirs)).not.toContain(t.fx.ids["src:private-journal"]);
    // A planted project-visible row whose source is private: the scan returns it, the per-hit source() check drops it from every field.
    t.fx.store.run(
      "INSERT INTO recall_chunks(kind,ref_id,ref_version,project_id,visibility,status,ordinal,start,end,text,prefix,recorded_at,boost,embedding,embedding_model,embedding_dim) VALUES('original',?,1,?,'project','current',7,0,10,'PRIVATE_CANARY_TEXT planted','Journal · Northstar · 2026-10-25','2026-10-25T00:00:00.000Z',1,?,?,?)",
      t.fx.ids["src:private-journal"], t.ns, encodeVector(normalize(Float32Array.from(fakeEmbed(q)))), t.key, FAKE_EMBED_DIM,
    );
    // A write on this connection moves neither data_version nor the generation; bump it as the index writers do, so the scan sees the row.
    bumpVectorGeneration();
    const scan = vi.spyOn(VectorCache.prototype, "search");
    const again = t.fx.brain.recallCore(t.fx.agent, { query: q }, t.dense(q));
    expect((scan.mock.results.at(-1)!.value as { text: string }[]).some((r) => r.text === "PRIVATE_CANARY_TEXT planted")).toBe(true);
    expect(everywhere(again)).not.toContain("PRIVATE_CANARY");
    expect(again.searched.candidates).toBeGreaterThanOrEqual(again.hits.length + again.near_misses.length);
    // Another project never enters the matrix for this grant.
    const hydra = t.fx.brain.recallCore(t.fx.agent, { query: "what day does Hydra deploy" }, t.dense("what day does Hydra deploy"));
    for (const canary of ["HYDRA_CANARY", t.fx.ids["src:hydra-deploy"], t.fx.ids["fact:hydra-deploy"]]) expect(everywhere(hydra)).not.toContain(canary);
    // Owner-only facts stay owner-only.
    const name = t.fx.brain.recallCore(t.fx.agent, { query: "what is the owner called" }, t.dense("what is the owner called"));
    for (const canary of ["Ana Costa", t.fx.ids["fact:owner-name"], t.fx.ids["src:prefs"]]) expect(everywhere(name)).not.toContain(canary);
  });
  it("a dense hit gets the same per-hit checks: an owner-only fact row marked project, a retired fact marked current and a fact without evidence are dropped", () => {
    const t = dense();
    const vec = (text: string) => encodeVector(normalize(Float32Array.from(fakeEmbed(text))));
    // Planted index rows the agent's scope filter lets through: only the per-hit visibleClaim, status and evidence checks stand between them and the agent.
    t.fx.store.run("UPDATE recall_chunks SET visibility='project',embedding=?,embedding_model=?,embedding_dim=? WHERE kind='fact' AND ref_id=?", vec("what is the owner called"), t.key, FAKE_EMBED_DIM, t.fx.ids["fact:owner-name"]);
    t.fx.store.run("UPDATE recall_chunks SET status='current',embedding=?,embedding_model=?,embedding_dim=? WHERE kind='fact' AND ref_id=?", vec("was the northstar status paused"), t.key, FAKE_EMBED_DIM, t.fx.ids["fact:status-old"]);
    t.fx.store.run("UPDATE entities SET data=json_set(data,'$.evidence',json('[]')) WHERE id=?", t.fx.ids["fact:price"]);
    bumpVectorGeneration();
    const scan = vi.spyOn(VectorCache.prototype, "search");
    const cases: [string, string, string[]][] = [
      ["what is the owner called", t.fx.ids["fact:owner-name"], ["Ana Costa"]],
      // The notes behind these two facts are project-visible and may be shown; only the facts themselves must not be.
      ["was the northstar status paused", t.fx.ids["fact:status-old"], []],
      ["what is the monthly fee", t.fx.ids["fact:price"], []],
    ];
    for (const [q, id, words] of cases) {
      const out = t.fx.brain.recallCore(t.fx.agent, { query: q }, t.dense(q));
      // The scan did return the planted row, so this is the per-hit check at work, not the scope filter.
      expect((scan.mock.results.at(-1)!.value as { ref_id: string }[]).map((r) => r.ref_id)).toContain(id);
      for (const canary of [id, ...words]) expect(everywhere(out)).not.toContain(canary);
    }
    // The owner's view of the retired fact also needs history; without it the planted current row is dropped for the owner too.
    expect(t.fx.brain.recallCore(owner, { query: "was the northstar status paused" }, t.dense("was the northstar status paused")).hits.map((h) => h.id)).not.toContain(t.fx.ids["fact:status-old"]);
  });
  it("with vectors stored but no query vector, every golden case equals the words-only result of a brain that never chose Better search", () => {
    const t = dense();
    const dir = mkdtempSync(join(tmpdir(), "recall-plain-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const plain = buildFixture(join(dir, "plain.sqlite"));
    cleanup.push(() => plain.store.close());
    expect(t.embedded).toBeGreaterThan(0);
    const golden = JSON.parse(readFileSync("tests/eval/recall-golden-v1.json", "utf8")) as { cases: { principal: "owner" | "agent"; query: string; history?: boolean }[] };
    // Ids differ between the two fixtures only where the fixture lets capture choose them; map each fixture's own ids to their names.
    const named = (fx: Fixture, r: RecallResult) => {
      let out = JSON.stringify(r);
      for (const [name, id] of Object.entries(fx.ids)) out = out.split(id).join(name);
      return out;
    };
    for (const c of golden.cases) {
      const input = { query: c.query, history: c.history ?? false, limit: 8 };
      const a = t.fx.brain.recallCore(c.principal === "owner" ? owner : t.fx.agent, input);
      const b = plain.brain.recallCore(c.principal === "owner" ? owner : plain.agent, input);
      expect(named(t.fx, a)).toBe(named(plain, b));
    }
  });
  it("a stale vector (another model key) is ignored, a mixed-model read is refused, and the row is pending again", () => {
    const t = dense();
    const q = "what is the monthly fee";
    const price = t.fx.ids["fact:price"];
    expect(t.fx.brain.recallCore(owner, { query: q }, t.dense(q)).hits.map((h) => h.id)).toContain(price);
    t.fx.store.run("UPDATE recall_chunks SET embedding_model='ollama:other:none' WHERE kind='fact' AND ref_id=?", price);
    expect(t.fx.brain.recallCore(owner, { query: q }, t.dense(q)).hits.map((h) => h.id)).not.toContain(price);
    expect(pendingEmbedRows(t.fx.store, t.key, ["project", "private", "owner"], 32).map((r) => r.ref_id)).toEqual([price]);
    const other = t.fx.brain.recallCore(owner, { query: q }, fakeVector(q, "ollama:other:none"));
    expect(other.hits.map((h) => h.id)).toEqual([price]);
    expect(t.fx.brain.recallCore(owner, { query: q }, { ...t.dense(q), dim: 8, vector: new Float32Array(8).fill(0.35) }).hits).toEqual([]);
  });
  it("an exact entity match stays first when dense candidates are present", () => {
    const t = dense();
    const q = "Northstar status";
    const out = t.fx.brain.recallCore(owner, { query: q }, t.dense(q));
    expect(out.hits[0].id).toBe(t.fx.ids["fact:status-new"]);
    expect(out.hits.map((h) => h.id)).not.toContain(t.fx.ids["fact:status-old"]);
  });
  it("the Ask bar and Your brain search use dense when it is on, through the worker lane, and words only when it is off", async () => {
    const t = dense();
    const { withWorker, calls } = pump(t.fx);
    const asked = await withWorker(() => t.fx.brain.ask(owner, { q: "which hue was chosen for the release" }));
    expect(asked.answered).toBe(true);
    // Membership, not rank: the BM25 hit on "release" (the Hydra deploy note's "release branch") can outrank the fact in RRF.
    expect(asked.hits.map((h) => h.id)).toContain(t.fx.ids["fact:launch-color"]);
    // "is" has two letters: without a vector this query goes to the literal list; with Better search on, meaning finds the fact.
    const searched = await withWorker(() => t.fx.brain.searchBrain(owner, { q: "what is the monthly fee" }));
    expect(searched.facts.map((f) => f.id)).toContain(t.fx.ids["fact:price"]);
    expect(calls.n).toBe(2);
    // A query with no searchable words at all still falls back to the literal list (which finds nothing for this one).
    const literal = await withWorker(() => t.fx.brain.searchBrain(owner, { q: "zq xk" }));
    expect(literal).toEqual({ facts: [], originals: [] });
    expect(t.fx.store.all("SELECT 1 FROM jobs WHERE kind='recall_judge'")).toEqual([]);
    t.fx.store.set(BETTER_SEARCH, BETTER_SEARCH_OFF);
    const plain = await t.fx.brain.ask(owner, { q: "which hue was chosen for the release" });
    expect(plain.hits.map((h) => h.id)).not.toContain(t.fx.ids["fact:launch-color"]);
    expect(calls.n).toBe(2);
    await expect(t.fx.brain.ask(owner, { q: "the and of" })).rejects.toThrow(/Ask with a few words/);
  });
  it("recall and the hook push take the vector before the judge, log dense, and keep the push level term-based", async () => {
    const t = dense();
    const { withWorker } = pump(t.fx);
    const order: string[] = [];
    vi.spyOn(t.fx.brain, "queryVector").mockImplementation(async function (this: Brain, _p, q) {
      order.push("vector");
      return fakeVector(q);
    });
    vi.spyOn(t.fx.brain as any, "judgeRanked").mockImplementation(async function (this: Brain, _p, internal: any) {
      order.push("judge");
      return { signals: null, ranked: internal.ranked, demoted: [] };
    });
    const out = await withWorker(() => t.fx.brain.recall(t.fx.agent, { query: "which hue was chosen for the release" }));
    expect(order).toEqual(["vector", "judge"]);
    expect(out.hits.map((h) => h.id)).toContain(t.fx.ids["fact:launch-color"]);
    const started = Date.now();
    const push = await withWorker(() => t.fx.brain.recallPush(t.fx.agent, { prompt: "which hue was chosen for the release", session_id: "a".repeat(64), first_prompt: false, seen: [] }));
    expect(Date.now() - started).toBeLessThan(1500);
    expect(push.level).toBe("none");
    expect(t.fx.brain.recallLog(owner).rows.at(-1)).toMatchObject({ dense: true, judged: false, level: "none" });
    expect(t.fx.brain.recallLog(owner).rows.at(-1)!.candidates).toBeGreaterThan(0);
  });
});
