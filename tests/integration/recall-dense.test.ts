import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIXTURE_CLOCK, buildFixture, owner, type Fixture } from "../eval/recall-fixture.ts";
import { embedFixture, fakeVector } from "../eval/dense-fixture.ts";
import { FAKE_EMBED_DIM, FAKE_EMBED_MODEL, fakeEmbed, fakeEmbedFetcher } from "../helpers/fake-embed.mjs";
import { Brain } from "../../packages/domain/service.ts";
import { LocalDispatchAccounting } from "../../apps/worker/accounting.ts";
import { runQueryEmbedOnce, type QueryEmbedDeps } from "../../apps/worker/recall-embed.ts";
import { embedFromEnv } from "../../packages/providers/embed-env.ts";
import { BETTER_SEARCH, BETTER_SEARCH_OFF, encodeVector, normalize, type QueryVector } from "../../packages/domain/better-search.ts";
import { VectorCache, bumpVectorGeneration, pendingEmbedRows } from "../../packages/storage/recall-vectors.ts";
import { deterministicLevel, fromBm25, type RecallResult } from "../../packages/domain/recall.ts";
import { JUDGE_CANDIDATES_MAX } from "../../packages/domain/recall-judge.ts";
import { publishSystemOneStatus } from "../../apps/worker/system-one.ts";
import { runJudgeOnce, type JudgeDeps } from "../../apps/worker/recall-judge.ts";
import { systemOneFromEnv } from "../../packages/providers/system-one-env.ts";

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

const SNAPSHOT = "tests/eval/recall-dense-off-snapshot.json";
/** Every fixture id by its name, and any other id by order of first appearance, so the snapshot does not depend on ids capture chose. */
function named(fx: Fixture, value: unknown): unknown {
  let text = JSON.stringify(value);
  for (const [name, id] of Object.entries(fx.ids)) text = text.split(id).join(`<${name}>`);
  const seen = new Map<string, string>();
  text = text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gu, (m) => seen.get(m) ?? (seen.set(m, `<id${seen.size}>`), seen.get(m)!));
  return JSON.parse(text);
}
/** recallCore and recallPush for every golden query, then the recall log without its wall-clock fields, on a brain that never chose Better search. */
async function denseOffOutputs() {
  const dir = mkdtempSync(join(tmpdir(), "recall-off-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const fx = buildFixture(join(dir, "off.sqlite"));
  cleanup.push(() => fx.store.close());
  const golden = JSON.parse(readFileSync("tests/eval/recall-golden-v1.json", "utf8")) as { cases: { id: string; principal: "owner" | "agent"; query: string; history?: boolean }[] };
  const out: Record<string, unknown> = {};
  for (const c of golden.cases) {
    const core = fx.brain.recallCore(c.principal === "owner" ? owner : fx.agent, { query: c.query, history: c.history ?? false, limit: 8 });
    const push = await fx.brain.recallPush(fx.agent, { prompt: c.query, session_id: "a".repeat(64), first_prompt: true, seen: [] });
    out[c.id] = { core, push };
  }
  out.recall_log = fx.brain.recallLog(owner).rows.map(({ at: _at, latency_ms: _ms, ...row }) => row);
  return named(fx, out);
}

/** A fake Clef reply (as in recall-judge.test.ts): the choice is always the argmax of its probabilities. */
function clefAnswer(body: any, over: { ownerWorld?: number; rel?: (i: number) => number } = {}) {
  const answers: Record<string, unknown> = {};
  for (const [id, q] of Object.entries<any>(body.questions)) {
    if (q.type === "noul") {
      answers[id] = { type: "noul", noul: over.rel ? over.rel(Number(id.split("_")[1])) : 0.9 };
      continue;
    }
    const ids: string[] = Object.keys(q.criteria);
    const ow = over.ownerWorld ?? 0.9;
    const probabilities: Record<string, number> = id === "about_owner" ? { owner_world: ow, general: Math.max(0, 1 - ow - 0.05), unclear: 0.05 } : Object.fromEntries(ids.map((x) => [x, x === "answered" ? 0.8 : 0.2 / (ids.length - 1)]));
    const choice = ids.reduce((best, x) => (probabilities[x] > probabilities[best] ? x : best), ids[0]);
    answers[id] = { type: "choice", choice, confidence: probabilities[choice], probabilities };
  }
  return new Response(JSON.stringify({ model: "clef-flash", answers, usage: { input_tokens: 2000, output_tokens: 0 } }), { status: 200 });
}
// Built at runtime so no secret-shaped literal sits in the file.
const JUDGE_KEY = ["sk", "test", "never", "a", "real", "key", "0123456789abcdef"].join("-");
/** The embedded fixture with recall help on: a judge brain, the fake Clef behind the real judge lane, and the query vector answered in-process. */
function withJudge(t: { fx: Fixture; dense: (q: string) => QueryVector }, rel?: (i: number) => number) {
  const brain = new Brain(t.fx.store, () => new Date(FIXTURE_CLOCK), undefined, undefined, undefined, undefined, () => ({ ready: true, reason: "test" }));
  brain.prefs(owner, { ...brain.prefs(owner), enabled: true, decision_provider_enabled: true, daily_cap_micro_usd: 50_000, per_job_cap_micro_usd: 5_000 });
  brain.setRecallHelp(owner, { enabled: true });
  publishSystemOneStatus(brain, { configured: true, label: "test" });
  const calls = { n: 0 };
  const fetcher = (async (_url: unknown, init: any) => {
    calls.n++;
    return clefAnswer(JSON.parse(init.body), { ownerWorld: 0.9, rel });
  }) as unknown as typeof fetch;
  const env = systemOneFromEnv({ BRAIN_SYSTEM1_PROVIDER: "ollama", BRAIN_SYSTEM1_ENDPOINT: "http://127.0.0.1:9/v1/systemone", BRAIN_DECISION_API_KEY: JUDGE_KEY });
  if (!env.config) throw new Error(env.reason);
  const deps: JudgeDeps = { brain, ledger: new LocalDispatchAccounting(t.fx.store, () => new Date(FIXTURE_CLOCK)), client: { config: env.config, fetcher }, owner, workerId: "judge-test", fetcher };
  vi.spyOn(brain, "queryVector").mockImplementation(async (_p, q) => t.dense(q));
  const agent = brain.authenticateAgent(t.fx.agentToken);
  const push = (prompt: string) =>
    Promise.all([
      brain.recallPush(agent, { prompt, session_id: "b".repeat(64), first_prompt: false, seen: [] }),
      (async () => {
        await new Promise((r) => setTimeout(r, 60));
        await runJudgeOnce(deps, new Map());
      })(),
    ]).then(([out]) => out);
  return { brain, agent, calls, push };
}

describe("dense recall", () => {
  it("with Better search off, recall and the hook push equal the committed plan 5 snapshot byte for byte", async () => {
    const outputs = await denseOffOutputs();
    // Regenerate only deliberately, from plan 5 code: UPDATE_DENSE_OFF_SNAPSHOT=1 npx vitest run tests/integration/recall-dense.test.ts -t "plan 5 snapshot".
    if (process.env.UPDATE_DENSE_OFF_SNAPSHOT === "1") writeFileSync(SNAPSHOT, JSON.stringify(outputs, null, 1) + "\n");
    expect(existsSync(SNAPSHOT)).toBe(true);
    // Line endings are normalised: a checkout with core.autocrlf may write the file with CRLF.
    expect(JSON.stringify(outputs, null, 1) + "\n").toBe(readFileSync(SNAPSHOT, "utf8").replace(/\r\n/gu, "\n"));
  });
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
  it("the judge never raises a push found by meaning alone: with no word candidate it is not even asked", async () => {
    const t = dense();
    const j = withJudge(t);
    const q = "which hue was chosen";
    const internal = j.brain.recallInternal(j.agent, { query: q, history: false, limit: 8 }, t.dense(q));
    expect(internal.ranked.length).toBeGreaterThan(0);
    expect(internal.ranked.some(fromBm25)).toBe(false);
    const out = await j.push(q);
    expect(out.level).toBe("none");
    expect(out.text).toBe("");
    expect(j.calls.n).toBe(0);
    expect(t.fx.store.all("SELECT 1 FROM jobs WHERE kind='recall_judge'")).toEqual([]);
    expect(j.brain.recallLog(owner).rows.at(-1)).toMatchObject({ level: "none", judged: false, dense: true });
  });
  it("when the judge puts a hit found by meaning alone on top, the push level is capped at the words level", async () => {
    const dir = mkdtempSync(join(tmpdir(), "recall-cap-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const fx = buildFixture(join(dir, "cap.sqlite"));
    cleanup.push(() => fx.store.close());
    // Phrased only in synonyms: no word of the query below, so only meaning finds it.
    fx.brain.capture(owner, { project_id: fx.ids["project:northstar"], title: "Banner", body: "The shade we settled on for the banner is teal.", separate: true });
    const t = { fx, ...embedFixture(fx) };
    const q = "which hue was chosen for the launch";
    const probe = withJudge(t).brain.recallInternal(t.fx.agent, { query: q, history: false, limit: 8 }, t.dense(q));
    const top = probe.ranked.slice(0, JUDGE_CANDIDATES_MAX);
    const meaning = top.findIndex((c) => !fromBm25(c) && probe.result.hits.some((h) => h.id === c.row.ref_id));
    expect(meaning).toBeGreaterThanOrEqual(0);
    expect(top.some(fromBm25)).toBe(true);
    const words = deterministicLevel(probe.signals);
    expect(words).not.toBe("full");
    vi.restoreAllMocks();
    // The judge rates the word candidates not relevant and the one found by meaning alone fully relevant, so it leads the surviving hits
    // and the judge alone would push it in full.
    const j = withJudge(t, (i) => (i === meaning + 1 ? 1 : 0));
    const out = await j.push(q);
    expect(j.calls.n).toBe(1);
    expect(j.brain.recallLog(owner).rows.at(-1)).toMatchObject({ judged: true });
    expect(out.level).toBe(words);
    expect(out.text).toBe("");
  });
  it("Better search on never pushes louder than off: an exact-entity fact second by words stays at the words level when the pin moves it first", () => {
    const dir = mkdtempSync(join(tmpdir(), "recall-pin-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const fx = buildFixture(join(dir, "pin.sqlite"));
    cleanup.push(() => fx.store.close());
    // A short note holding the exact phrase outranks the Marco fact by words.
    fx.brain.capture(owner, { project_id: fx.ids["project:northstar"], title: "Trip", body: "Marco Lisbon trip planning for the offsite.", separate: true });
    const e = embedFixture(fx);
    const q = "Marco Lisbon";
    for (const p of [owner, fx.agent]) {
      const off = fx.brain.recallInternal(p, { query: q, history: false, limit: 8 });
      expect(off.ranked[1].row.ref_id).toBe(fx.ids["fact:marco-role"]);
      expect(deterministicLevel(off.signals)).toBe("pointer");
      const on = fx.brain.recallInternal(p, { query: q, history: false, limit: 8 }, e.dense(q));
      // The pin still orders the hits...
      expect(on.result.hits[0].id).toBe(fx.ids["fact:marco-role"]);
      // ...but the level and the status are the words reading, exactly as without Better search.
      expect(deterministicLevel(on.signals)).toBe("pointer");
      expect(on.result.status).toBe(off.result.status);
      expect({ ...on.signals, candidates: 0 }).toEqual({ ...off.signals, candidates: 0 });
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
