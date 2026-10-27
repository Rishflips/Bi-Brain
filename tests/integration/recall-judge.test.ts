import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../../packages/storage/index.ts";
import { Brain } from "../../packages/domain/service.ts";
import { LocalDispatchAccounting } from "../../apps/worker/accounting.ts";
// `Storage` is used by the consent case at the end of this file.
import { publishSystemOneStatus } from "../../apps/worker/system-one.ts";
import { runJudgeOnce, sweepJudgeRows, type JudgeDeps } from "../../apps/worker/recall-judge.ts";
import { systemOneFromEnv } from "../../packages/providers/system-one-env.ts";
import { JUDGE_THRESHOLDS, applyJudge, buildJudgeQuestions, buildJudgeState, judgeSignals, judgedStatus } from "../../packages/domain/recall-judge.ts";
import type { AskAnswer } from "../../packages/providers/system-one-ask.ts";
import type { Principal } from "../../packages/contracts/index.ts";
import { buildFixture, owner, type Fixture } from "../eval/recall-fixture.ts";

describe("judge questions and application", () => {
  it("builds a bounded state and at most 15 questions", () => {
    const candidates = Array.from({ length: 20 }, (_, i) => ({ kind: i % 2 ? ("fact" as const) : ("original" as const), date: "2026-10-20", project: "Northstar", title: i % 2 ? null : "Launch notes", text: "x".repeat(2000) }));
    const state = buildJudgeState({ today: "2026-10-25", request: "y".repeat(900), names: Array.from({ length: 80 }, (_, i) => `Name${i}`), candidates });
    expect(state.length).toBeLessThanOrEqual(8000);
    expect(state).toContain("today: 2026-10-25");
    expect(state).toContain("request: " + "y".repeat(500));
    expect(state).not.toContain("y".repeat(501));
    expect(state).toContain("known names: Name0");
    expect(state).not.toContain("Name40");
    expect(state).toContain("[12] fact, checked 2026-10-20, Northstar: ");
    expect(state).not.toContain("[13]");
    const questions = buildJudgeQuestions(20);
    expect(questions.map((q) => q.id)).toEqual(["about_owner", ...Array.from({ length: 12 }, (_, i) => `rel_${i + 1}`), "answered"]);
    expect(questions.length).toBeLessThanOrEqual(15);
    expect(buildJudgeQuestions(2).map((q) => q.id)).toEqual(["about_owner", "rel_1", "rel_2", "answered"]);
  });
  it("reads signals, rejects wrong shapes, demotes weak candidates, pins exact matches and never adds", () => {
    const answers: AskAnswer[] = [
      { id: "about_owner", type: "choice", choice: "owner_world", confidence: 0.8, probabilities: { owner_world: 0.8, general: 0.1, unclear: 0.1 } },
      { id: "rel_1", type: "noul", probability: 0.9 },
      { id: "rel_2", type: "noul", probability: 0.1 },
      { id: "answered", type: "choice", choice: "answered", confidence: 0.7, probabilities: { answered: 0.7, partial: 0.2, none: 0.1 } },
    ];
    const s = judgeSignals(answers, 2)!;
    expect(s).toMatchObject({ ownerWorld: 0.8, general: 0.1, answered: "answered", rel: [0.9, 0.1] });
    expect(s.margin).toBeCloseTo(0.5); // 0.7 - 0.2 is 0.49999999999999994 in doubles
    expect(judgeSignals(answers.slice(1), 2)).toBeNull();
    expect(judgeSignals([...answers, { id: "rel_3", type: "noul", probability: 1 }], 2)).toBeNull();
    const ranked = [{ key: "a", fused: 0.03 }, { key: "b", fused: 0.02 }];
    expect(applyJudge(ranked, s, new Set())).toEqual({ kept: [{ key: "a", fused: 0.03 }], demoted: [{ key: "b", fused: 0.02 }] });
    expect(applyJudge(ranked, s, new Set(["b"])).kept.map((c) => c.key)).toEqual(["a", "b"]);
    const allZero = { ...s, rel: [0, 0] };
    expect(applyJudge(ranked, allZero, new Set(["a"])).kept.map((c) => c.key)).toEqual(["a"]);
    const reorder = { ...s, rel: [0.2, 1] };
    expect(applyJudge(ranked, reorder, new Set()).kept.map((c) => c.key)).toEqual(["b", "a"]);
    expect(judgedStatus(s)).toBe("found");
    expect(judgedStatus({ ...s, margin: 0.1 })).toBe("partial");
    expect(judgedStatus({ ...s, answered: "partial" })).toBe("partial");
    expect(JUDGE_THRESHOLDS.rel_keep).toBe(0.2);
  });
});

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.reverse()) fn();
  cleanup = [];
});
// Built at runtime so no secret-shaped literal sits in fixture data; it still matches detectSecrets' key pattern for the leak checks.
const KEY = ["sk", "test", "never", "a", "real", "key", "0123456789abcdef"].join("-");
/** A fake Clef reply. The adapter rejects a choice that is not its most likely option, so `choice` is always the argmax of `probabilities`. */
function clefAnswer(body: any, over: { ownerWorld?: number; rel?: number | ((i: number) => number); answered?: string; extra?: boolean; wrongType?: boolean } = {}) {
  const answers: Record<string, any> = {};
  for (const [id, q] of Object.entries<any>(body.questions)) {
    if (q.type === "noul") {
      const i = Number(id.split("_")[1]);
      answers[id] = over.wrongType ? { type: "choice", choice: "x", confidence: 1, probabilities: { x: 1 } } : { type: "noul", noul: typeof over.rel === "function" ? over.rel(i) : (over.rel ?? 0.9) };
      continue;
    }
    const ids: string[] = Object.keys(q.criteria);
    let probabilities: Record<string, number>;
    if (id === "about_owner") {
      const ow = over.ownerWorld ?? 0.9;
      probabilities = { owner_world: ow, general: Math.max(0, 1 - ow - 0.05), unclear: 0.05 };
    } else {
      const want = over.answered ?? "answered";
      probabilities = Object.fromEntries(ids.map((x) => [x, x === want ? 0.8 : 0.2 / (ids.length - 1)]));
    }
    const choice = ids.reduce((best, x) => (probabilities[x] > probabilities[best] ? x : best), ids[0]);
    answers[id] = { type: "choice", choice, confidence: probabilities[choice], probabilities };
  }
  if (over.extra) answers.rel_99 = { type: "noul", noul: 1 };
  return new Response(JSON.stringify({ model: "clef-flash", answers, usage: { input_tokens: 2000, output_tokens: 0 } }), { status: 200 });
}
function judged(opts: { consent?: boolean; heartbeat?: boolean; dailyCap?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "recall-judge-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const time = { now: new Date("2026-10-25T09:00:00.000Z") };
  const fx: Fixture = (() => {
    const built = buildFixture(join(dir, "fixture.sqlite"));
    cleanup.push(() => built.store.close());
    return built;
  })();
  // The judge brain needs the capability hook; rebuild the fixture brain on it.
  const brain = new Brain(fx.store, () => time.now, undefined, undefined, undefined, undefined, () => ({ ready: true, reason: "test" }));
  brain.prefs(owner, { ...brain.prefs(owner), enabled: true, decision_provider_enabled: true, daily_cap_micro_usd: opts.dailyCap ?? 50_000, per_job_cap_micro_usd: 5_000 });
  if (opts.consent !== false) brain.setRecallHelp(owner, { enabled: true });
  publishSystemOneStatus(brain, { configured: true, label: "test" });
  if (opts.heartbeat !== false) brain.store.set("worker_heartbeat", brain.now());
  const calls = { n: 0, bodies: [] as any[] };
  let behave: (body: any) => Response = (body) => clefAnswer(body);
  const fetcher = (async (_url: any, init: any) => {
    calls.n++;
    const body = JSON.parse(init.body);
    calls.bodies.push(body);
    return behave(body);
  }) as unknown as typeof fetch;
  const env = systemOneFromEnv({ BRAIN_SYSTEM1_PROVIDER: "ollama", BRAIN_SYSTEM1_ENDPOINT: "http://127.0.0.1:9/v1/systemone", BRAIN_DECISION_API_KEY: KEY });
  if (!env.config) throw new Error(env.reason);
  const deps: JudgeDeps = { brain, ledger: new LocalDispatchAccounting(fx.store, () => time.now), client: { config: env.config, fetcher }, owner, workerId: "worker-test", fetcher };
  const cache = new Map();
  const agent: Principal = brain.authenticateAgent(fx.agentToken);
  /** Runs the recall and, in parallel, one judge pass after a short delay (the worker loop stand-in). */
  const withWorker = async <T>(work: () => Promise<T>) => {
    const [out] = await Promise.all([work(), (async () => { await new Promise((r) => setTimeout(r, 60)); await runJudgeOnce(deps, cache); })()]);
    return out;
  };
  return { fx, brain, agent, deps, cache, calls, time, store: fx.store, withWorker, setBehave: (fn: typeof behave) => (behave = fn) };
}

describe("the judge fast lane", () => {
  it("judges an agent recall through reserve, mark, one call and settle, and the state names no private source", async () => {
    const t = judged();
    const out = await t.withWorker(() => t.brain.recall(t.agent, { query: "launch color right call journal" }));
    expect(out.status).toBe("found");
    expect(out.hits[0].id).toBe(t.fx.ids["fact:launch-color"]);
    expect(t.calls.n).toBe(1);
    const state: string = t.calls.bodies[0].state;
    expect(state).toContain("request: launch color right call journal");
    expect(state).not.toContain("PRIVATE_CANARY_TEXT");
    expect(state).not.toContain("HYDRA_CANARY");
    expect(t.calls.bodies[0].questions.about_owner).toBeDefined();
    const [row] = t.store.all<any>("SELECT * FROM provider_dispatches");
    expect(row).toMatchObject({ state: "settled", dispatch_key: "recall_judge", stage: "decision", provider: "ollama" });
    expect(row.actual_micro_usd).toBeGreaterThan(0);
    const job = t.store.get<any>("SELECT * FROM jobs WHERE kind='recall_judge'")!;
    expect(job.status).toBe("succeeded");
    expect(t.store.all("SELECT key FROM settings WHERE key LIKE 'recall_judge%'")).toEqual([]);
    expect(JSON.stringify(t.calls.bodies)).not.toContain(KEY);
  });
  it("is advisory: all-1.0 adds nothing, all-0.0 demotes to near misses but keeps an exact entity match, extra ids and wrong types fall back", async () => {
    const t = judged();
    const plain = t.brain.recallCore(t.agent, { query: "Northstar status" });
    // The same query four times would be served from the worker's 10-minute cache after the first call, so the cache is cleared between behaviours.
    t.setBehave((b) => clefAnswer(b, { rel: 1 }));
    const high = await t.withWorker(() => t.brain.recall(t.agent, { query: "Northstar status" }));
    expect(high.hits.map((h) => h.id).sort()).toEqual(plain.hits.map((h) => h.id).sort());
    expect(high.searched.projects).toEqual(plain.searched.projects);
    t.cache.clear();
    t.setBehave((b) => clefAnswer(b, { rel: 0, answered: "none", ownerWorld: 0.1 }));
    const low = await t.withWorker(() => t.brain.recall(t.agent, { query: "Northstar status" }));
    expect(low.hits.map((h) => h.id)).toContain(t.fx.ids["fact:status-new"]);
    expect(low.status).toBe("partial");
    expect(low.near_misses.length).toBeLessThanOrEqual(3);
    // A demotion really happened: a hit the core returned moved to near misses as judged not relevant, while the exact-entity fact stayed.
    const moved = plain.hits.filter((h) => !low.hits.some((k) => k.kind === h.kind && k.id === h.id));
    expect(moved.length).toBeGreaterThan(0);
    expect(moved.map((h) => h.id)).not.toContain(t.fx.ids["fact:status-new"]);
    expect(low.near_misses.some((n) => n.reason === "judged not relevant" && moved.some((h) => h.kind === n.kind && h.id === n.id))).toBe(true);
    t.cache.clear();
    t.setBehave((b) => clefAnswer(b, { extra: true }));
    const extra = await t.withWorker(() => t.brain.recall(t.agent, { query: "Northstar status" }));
    expect(extra.hits.map((h) => h.id)).toEqual(plain.hits.map((h) => h.id));
    t.cache.clear();
    t.setBehave((b) => clefAnswer(b, { wrongType: true }));
    const wrong = await t.withWorker(() => t.brain.recall(t.agent, { query: "Northstar status" }));
    expect(wrong.hits.map((h) => h.id)).toEqual(plain.hits.map((h) => h.id));
    expect(t.calls.n).toBe(4);
    expect(t.store.all("SELECT 1 FROM provider_dispatches WHERE state='settled'").length).toBeGreaterThanOrEqual(2);
  });
  it("lowers a push to pointer but never below it for an exact entity match, and never changes the owner's own paths", async () => {
    const t = judged();
    t.setBehave((b) => clefAnswer(b, { ownerWorld: 0.1, rel: 0, answered: "none" }));
    const session = "a".repeat(64);
    const out = await t.withWorker(() => t.brain.recallPush(t.agent, { prompt: "what is the Northstar status today", session_id: session, first_prompt: false, seen: [] }));
    expect(out.level).toBe("pointer");
    expect(t.brain.recallLog(owner).rows.at(-1)).toMatchObject({ judged: true, level: "pointer" });
    const before = t.calls.n;
    await t.brain.ask(owner, { q: "what is the Northstar status today" });
    await t.brain.searchBrain(owner, { q: "Northstar status" });
    t.brain.recallCore(owner, { query: "Northstar status" });
    expect(t.calls.n).toBe(before);
    expect(t.store.all("SELECT id FROM jobs WHERE kind='recall_judge'")).toHaveLength(1);
  });
  it("answers deterministically with no job row when consent is off, the worker is stale, the caps are (nearly) gone, the count cap is hit, zero candidates, or the prompt looks like a secret", async () => {
    // dailyCap 1: one micro-dollar left is under JUDGE_MIN_REMAINING_MICRO_USD, so no job is queued and nobody waits 900 ms.
    for (const opts of [{ consent: false }, { heartbeat: false }, { dailyCap: 1 }] as const) {
      const t = judged(opts);
      const started = Date.now();
      const out = await t.brain.recall(t.agent, { query: "launch color" });
      expect(Date.now() - started).toBeLessThan(100);
      expect(out.hits[0].id).toBe(t.fx.ids["fact:launch-color"]);
      expect(t.store.all("SELECT id FROM jobs WHERE kind='recall_judge'")).toEqual([]);
      expect(t.calls.n).toBe(0);
      cleanup.reverse().forEach((fn) => fn());
      cleanup = [];
    }
    const t = judged();
    for (let i = 0; i < 2000; i++) t.store.run("INSERT INTO jobs(id,project_id,kind,payload,status,next_at,created_at) VALUES(?,?,?,?,?,?,?)", `j${i}`, "inbox", "recall_judge", "{}", "succeeded", t.brain.now(), t.brain.now());
    await t.brain.recall(t.agent, { query: "launch color" });
    expect(t.store.all("SELECT id FROM jobs WHERE kind='recall_judge'")).toHaveLength(2000);
    expect(t.brain.recallJudgeAllowed().reason).toContain("2,000");
    t.store.run("DELETE FROM jobs WHERE kind='recall_judge'");
    const zero = Date.now();
    expect((await t.brain.recall(t.agent, { query: "Zephyr budget for Q3" })).status).toBe("no_match");
    expect(Date.now() - zero).toBeLessThan(100);
    expect(t.store.all("SELECT id FROM jobs WHERE kind='recall_judge'")).toEqual([]);
    await t.brain.recall(t.agent, { query: "api_key = abcdefghijklmnopqrstu launch color" });
    expect(t.store.all("SELECT id FROM jobs WHERE kind='recall_judge'")).toEqual([]);
    expect(t.calls.n).toBe(0);
  });
  it("falls back at the 900 ms deadline when no worker answers, and the sweeper cancels the stale row", async () => {
    const t = judged();
    const started = Date.now();
    const out = await t.brain.recall(t.agent, { query: "launch color" });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(850);
    expect(elapsed).toBeLessThan(1400);
    expect(out.hits[0].id).toBe(t.fx.ids["fact:launch-color"]);
    // The server fences the job it gave up on and deletes the question and passages at once.
    expect(t.store.get<any>("SELECT status FROM jobs WHERE kind='recall_judge'")!.status).toBe("cancelled");
    expect(t.store.all("SELECT key FROM settings WHERE key LIKE 'recall_judge%'")).toEqual([]);
    t.time.now = new Date("2026-10-25T10:30:00.000Z");
    sweepJudgeRows(t.brain);
    expect(t.store.get<any>("SELECT status FROM jobs WHERE kind='recall_judge'")!.status).toBe("cancelled");
    expect(t.store.all("SELECT key FROM settings WHERE key LIKE 'recall_judge%'")).toEqual([]);
    expect(await runJudgeOnce(t.deps, t.cache)).toBe(false);
  });
  /** One queued judge job straight into the table, as the server would queue it. */
  const enqueueOne = (t: ReturnType<typeof judged>, tag: string) =>
    t.brain.enqueueRecallJudge(
      buildJudgeState({ today: "2026-10-25", request: `launch color ${tag}`, names: ["Northstar"], candidates: [{ kind: "fact", date: "2026-10-20", project: "Northstar", title: null, text: "the launch color is cobalt" }] }),
      buildJudgeQuestions(1),
      `hash-${tag}`,
    )!;
  it("never reserves for a job whose deadline is about to pass, and deletes its state", async () => {
    const t = judged();
    const id = enqueueOne(t, "late");
    // Leasable (still ahead of the clock) but with less time left than any call could use.
    t.store.run("UPDATE jobs SET deadline_at=? WHERE id=?", new Date(t.time.now.getTime() + 100).toISOString(), id);
    expect(await runJudgeOnce(t.deps, t.cache)).toBe(true);
    expect(t.calls.n).toBe(0);
    expect(t.store.all("SELECT 1 FROM provider_dispatches")).toEqual([]);
    expect(t.store.get<any>("SELECT status FROM jobs WHERE id=?", id)!.status).toBe("cancelled");
    expect(t.store.all("SELECT key FROM settings WHERE key LIKE 'recall_judge%'")).toEqual([]);
  });
  it("releases the hold and sends nothing when consent is withdrawn between reserve and mark", async () => {
    const t = judged();
    const id = enqueueOne(t, "flip");
    class FlipAfterReserve extends LocalDispatchAccounting {
      reserve(...args: Parameters<LocalDispatchAccounting["reserve"]>) {
        const record = super.reserve(...args);
        t.brain.setRecallHelp(owner, { enabled: false });
        return record;
      }
    }
    expect(await runJudgeOnce({ ...t.deps, ledger: new FlipAfterReserve(t.store, () => t.time.now) }, t.cache)).toBe(true);
    expect(t.calls.n).toBe(0);
    expect(t.store.all<any>("SELECT state FROM provider_dispatches")).toEqual([{ state: "released" }]);
    expect(t.store.get<any>("SELECT status FROM jobs WHERE id=?", id)!.status).toBe("cancelled");
    expect(t.store.all("SELECT key FROM settings WHERE key LIKE 'recall_judge%'")).toEqual([]);
  });
  it("leaves no result or state behind when the job was cancelled while its call was out", async () => {
    const t = judged();
    const id = enqueueOne(t, "gone");
    t.setBehave((b) => {
      // The server gave up while the request was in flight.
      t.store.run("UPDATE jobs SET status='cancelled',fence=fence+1 WHERE id=?", id);
      return clefAnswer(b);
    });
    expect(await runJudgeOnce(t.deps, t.cache)).toBe(true);
    expect(t.calls.n).toBe(1);
    expect(t.store.all<any>("SELECT state FROM provider_dispatches")).toEqual([{ state: "settled" }]);
    expect(t.store.get<any>("SELECT status FROM jobs WHERE id=?", id)!.status).toBe("cancelled");
    expect(t.store.all("SELECT key FROM settings WHERE key LIKE 'recall_judge%'")).toEqual([]);
  });
  it("serves a repeated request from the in-worker cache without a second call or ledger row", async () => {
    const t = judged();
    await t.withWorker(() => t.brain.recall(t.agent, { query: "launch color" }));
    await t.withWorker(() => t.brain.recall(t.agent, { query: "launch color" }));
    expect(t.calls.n).toBe(1);
    expect(t.store.all("SELECT 1 FROM provider_dispatches")).toHaveLength(1);
    expect(t.store.all("SELECT id FROM jobs WHERE kind='recall_judge' AND status='succeeded'")).toHaveLength(2);
  });
  it("refuses recall help consent until sorting help is ready, keeps it out of the preferences object, and hides judge rows from the Settings job list", async () => {
    const dir = mkdtempSync(join(tmpdir(), "recall-consent-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const s = new Storage(join(dir, "brain.sqlite"));
    cleanup.push(() => s.close());
    const off = new Brain(s, () => new Date("2026-10-25T09:00:00.000Z"));
    expect(off.recallHelp(owner)).toEqual({ enabled: false });
    expect(() => off.setRecallHelp(owner, { enabled: true })).toThrow(/Recall help needs sorting help to be on first\./);
    expect(off.recallHelp(owner).enabled).toBe(false);
    expect(() => off.setRecallHelp(owner, { enabled: "yes" })).toThrow();
    const ready = new Brain(s, () => new Date("2026-10-25T09:00:00.000Z"), undefined, undefined, undefined, undefined, () => ({ ready: true, reason: "test" }));
    expect(() => ready.setRecallHelp(owner, { enabled: true })).toThrow(/sorting help/);
    ready.prefs(owner, { ...ready.prefs(owner), enabled: true, decision_provider_enabled: true, daily_cap_micro_usd: 1000, per_job_cap_micro_usd: 100 });
    expect(ready.setRecallHelp(owner, { enabled: true })).toEqual({ enabled: true });
    // The consent is its own setting: the preferences object managed code spreads back into its strict schema never carries it.
    expect("recall_help_enabled" in ready.prefs(owner)).toBe(false);
    expect(() => ready.prefs(owner, { ...ready.prefs(owner) })).not.toThrow();
    expect(ready.setRecallHelp(owner, { enabled: false })).toEqual({ enabled: false });
    expect(() => ready.recallHelp(ready.authenticateAgent(ready.createGrant(owner, { projects: ["inbox"], operations: ["read"], expires_at: "2027-01-01T00:00:00.000Z" }).token))).toThrow(/Owner access required/);
    s.run("INSERT INTO jobs(id,project_id,kind,payload,status,next_at,created_at) VALUES('jj','inbox','recall_judge','{}','succeeded',?,?)", ready.now(), ready.now());
    expect(ready.status(owner).jobs.some((j: any) => j.kind === "recall_judge")).toBe(false);
  });
});
