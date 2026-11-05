// tests/integration/meaning-lead.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../apps/server/app.ts";
import { publishBetterSearchStatus } from "../../apps/worker/embed.ts";
import { MEANING_LEAD, MEANING_LEAD_MIN_SAMPLE, modelKey, type MeaningLead, type QueryVector } from "../../packages/domain/better-search.ts";
import { meaningLead } from "../../packages/domain/recall-push.ts";
import { MIN_SAMPLE } from "../../packages/domain/calibration.ts";
import { buildFixture, owner, type Fixture } from "../eval/recall-fixture.ts";
import { embedFixture } from "../eval/dense-fixture.ts";
import { FAKE_EMBED_MODEL } from "../helpers/fake-embed.mjs";

let cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});
/** The embedded fixture with the query vector answered in-process, so recallPush runs the dense list without a worker. */
function dense() {
  const dir = mkdtempSync(join(tmpdir(), "meaning-lead-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const fx: Fixture = buildFixture(join(dir, "brain.sqlite"));
  cleanup.push(() => fx.store.close());
  const e = embedFixture(fx);
  vi.spyOn(fx.brain, "queryVector").mockImplementation(async (_p, q) => e.dense(q));
  return { fx, ...e };
}
// No word of this prompt is in any fixture passage: only meaning finds the launch-colour fact, so the leader is dense-only.
const PARAPHRASE = "the hue picked for the premiere";
const push = (fx: Fixture, prompt: string, session = "e".repeat(64)) => fx.brain.recallPush(fx.agent, { prompt, session_id: session, first_prompt: false, seen: [] });
const lastLog = (fx: Fixture) => fx.brain.recallLog(owner).rows.at(-1)!;
const keyOf = (h: { kind: string; id: string; start?: number }) => `${h.kind}:${h.id}:${h.kind === "original" ? h.start : ""}`;
/** The cosine of the hit that leads a dense recall of `prompt`, and the cosines of every dense-only hit after it. */
function leaderCosine(fx: Fixture, vec: (q: string) => QueryVector, prompt: string) {
  const internal = fx.brain.recallInternal(fx.agent, { query: prompt, history: false, limit: 6 }, vec(prompt));
  const [lead, ...rest] = internal.result.hits;
  const cos = internal.denseScores.get(keyOf(lead));
  if (cos === undefined || !internal.denseOnly.has(keyOf(lead))) throw new Error(`${prompt}: the leader is not dense-only`);
  return { internal, cos, others: rest.map((h) => ({ id: h.id, denseOnly: internal.denseOnly.has(keyOf(h)), cos: internal.denseScores.get(keyOf(h)) ?? null })) };
}

describe("the meaning-lead rule", () => {
  it("raises only a dense-only, reviewed, leading hit at or above a set threshold, and nothing while unset", () => {
    const top = { denseOnly: true, cosine: 0.7, unreviewed: false };
    expect(meaningLead("none", top, null)).toBe("none");
    expect(meaningLead("pointer", top, null)).toBe("pointer");
    expect(meaningLead("none", top, 0.7)).toBe("full");
    expect(meaningLead("pointer", top, 0.6)).toBe("full");
    expect(meaningLead("none", top, 0.71)).toBe("none");
    expect(meaningLead("full", { ...top, cosine: 0.1 }, 0.6)).toBe("full");
    expect(meaningLead("none", null, 0.6)).toBe("none");
    expect(meaningLead("none", { ...top, denseOnly: false }, 0.6)).toBe("none");
    expect(meaningLead("pointer", { ...top, unreviewed: true }, 0.6)).toBe("pointer");
    expect(meaningLead("none", { ...top, cosine: null }, 0.6)).toBe("none");
    expect(MEANING_LEAD_MIN_SAMPLE).toBe(MIN_SAMPLE);
  });
  it("lets a paraphrase found by meaning alone lead a full push only after the owner applied a threshold it reaches", async () => {
    const { fx, dense: vec } = dense();
    const before = await push(fx, PARAPHRASE);
    expect(before.level).toBe("none");
    // Before any line: the row records the leader's cosine (so calibrate can compare like with like) and nothing else new.
    expect(lastLog(fx)).toMatchObject({ dense: true, level: "none", lead_cos: expect.any(Number) });
    expect(lastLog(fx)).not.toHaveProperty("lead");
    expect(lastLog(fx)).not.toHaveProperty("lead_at");
    const { cos, internal } = leaderCosine(fx, vec, PARAPHRASE);
    expect(internal.result.hits[0].id).toBe(fx.ids["fact:launch-color"]);
    expect(cos).toBeGreaterThanOrEqual(0.45);
    expect(lastLog(fx).lead_cos).toBe(Number(cos.toFixed(3)));
    // The line is set from the leader's own cosine, rounded down to two decimals, so the leader reaches it.
    const reach = Math.max(0.45, Math.floor(cos * 100) / 100);
    const applied = fx.brain.setMeaningLead(owner, { threshold: reach, sample: 54, source: "proof:search", measured_at: "2026-10-25" });
    expect(applied).toMatchObject({ threshold: reach, key: modelKey("ollama", FAKE_EMBED_MODEL), sample: 54, source: "proof:search", measured_at: "2026-10-25" });
    expect(fx.brain.meaningLeadThreshold()).toBe(reach);
    const after = await push(fx, PARAPHRASE, "f".repeat(64));
    expect(after.level).toBe("full");
    expect(after.hit_ids[0]).toBe(fx.ids["fact:launch-color"]);
    expect(after.text).toContain("Launch color: cobalt");
    expect(lastLog(fx)).toMatchObject({ dense: true, level: "full", lead: true, lead_at: reach });
    // Above the leader's score: today's behaviour again; the row still says a line was in force (lead_at) but not that it led.
    const above = Math.min(0.99, Math.ceil(cos * 100) / 100 + 0.01);
    fx.brain.setMeaningLead(owner, { threshold: above, sample: 54, source: "calibrate", measured_at: "2026-10-25" });
    const over = await push(fx, PARAPHRASE, "a".repeat(64));
    expect(over.level).toBe("none");
    expect(lastLog(fx)).toMatchObject({ lead_at: above });
    expect(lastLog(fx)).not.toHaveProperty("lead");
    // A word match is never counted as a meaning lead, and a word-led row carries no lead_cos.
    fx.brain.setMeaningLead(owner, { threshold: reach, sample: 54, source: "proof:search", measured_at: "2026-10-25" });
    const words = await push(fx, "launch color", "b".repeat(64));
    expect(words.level).toBe("full");
    expect(lastLog(fx)).not.toHaveProperty("lead");
    expect(lastLog(fx)).not.toHaveProperty("lead_cos");
  });
  it("renders only the leader, word-found hits and dense-only hits at or above the line; a sub-threshold neighbour never rides along", async () => {
    const { fx, dense: vec } = dense();
    // "the squad huddle" maps onto the stand-up note (leader) and, more weakly, onto the weekly notes; both are dense-only.
    const PROMPT = "the squad huddle";
    const { cos, others } = leaderCosine(fx, vec, PROMPT);
    const weaker = others.filter((o) => o.denseOnly && o.cos !== null && o.cos < cos);
    expect(weaker.length, "the fixture must give the leader at least one weaker dense-only neighbour").toBeGreaterThan(0);
    const line = Math.max(0.45, Math.min(Math.floor(cos * 100) / 100, Math.ceil(Math.max(...weaker.map((w) => w.cos!)) * 100) / 100 + 0.01));
    expect(line).toBeLessThanOrEqual(cos);
    fx.brain.setMeaningLead(owner, { threshold: line, sample: 20, source: "proof:search", measured_at: "2026-10-25" });
    const r = await push(fx, PROMPT, "d".repeat(64));
    expect(r.level).toBe("full");
    expect(r.hit_ids[0]).toBe(fx.ids["src:standup"]);
    for (const w of weaker) if (w.cos! < line) expect(r.hit_ids, `${w.id} is under the line`).not.toContain(w.id);
    expect(r.text.split("\n").length - 2).toBe(r.hit_ids.length);
  });
  it("never lets an unreviewed agent-written note lead, and lets the same note lead once the owner reviewed it", async () => {
    const { fx, dense: vec } = dense();
    fx.brain.setMeaningLead(owner, { threshold: 0.45, sample: 20, source: "proof:search", measured_at: "2026-10-25" });
    const writer = fx.brain.createGrant(owner, { projects: [fx.ids["project:northstar"]], operations: ["read", "propose_memory"], expires_at: "2027-01-01T00:00:00.000Z", client: "codex" });
    const writerP = fx.brain.authenticateAgent(writer.token);
    // Only this note holds the deploy concept (fake lexicon: deploy~deployment); no owner passage shares it. The prompt is "the deploy" alone:
    // "patch" would be found by words in the owner's Support note and lead instead, which is the plan 5 rule, not the one under test.
    const saved = fx.brain.sessionNote(writerP, { session_id: "9".repeat(64), client: "codex", text: "Decided: deployment hotfix: ship the hotfix before the deployment" }) as { saved: boolean; source_id: string };
    expect(saved.saved).toBe(true);
    embedFixture(fx);
    const PROMPT = "the deploy";
    const internal = fx.brain.recallInternal(fx.agent, { query: PROMPT, history: false, limit: 6 }, vec(PROMPT));
    const denseOnly = internal.authorized.filter((h) => internal.denseOnly.has(keyOf(h)));
    expect(denseOnly.map((h) => h.id), "the agent note must be the only dense-only hit").toEqual([saved.source_id]);
    expect(internal.authorized.filter((h) => !internal.denseOnly.has(keyOf(h)))).toHaveLength(0);
    const r = await push(fx, PROMPT, "c".repeat(64));
    expect(r.level).toBe("none");
    expect(r.hit_ids).not.toContain(saved.source_id);
    expect(r.text).not.toContain("hotfix");
    expect(lastLog(fx)).toMatchObject({ lead_at: 0.45 });
    expect(lastLog(fx)).not.toHaveProperty("lead");
    // The positive twin: once reviewed, the same note is the owner's evidence and the rule applies to it.
    fx.brain.markSourceReviewed(owner, saved.source_id);
    const led = await push(fx, PROMPT, "7".repeat(64));
    expect(led.level).toBe("full");
    expect(led.hit_ids).toEqual([saved.source_id]);
    expect(lastLog(fx)).toMatchObject({ lead: true });
  });
  it("is bound to the model key it was measured with, and refuses bad input and the wrong caller", async () => {
    const { fx } = dense();
    const app = await createApp(fx.brain, { pairSecret: "synthetic-lead", static: false });
    cleanup.push(() => app.close());
    const req = (method: any, url: string, payload?: any, headers: Record<string, string> = {}) => app.inject({ method, url, headers: { host: "127.0.0.1:4317", ...headers }, payload });
    const pairing = await req("POST", "/api/v1/session/pair", { secret: "synthetic-lead" });
    const cookie = pairing.cookies[0];
    const headers = { cookie: `${cookie.name}=${cookie.value}`, "x-brain-csrf": pairing.json().csrf };
    expect((await req("GET", "/api/v1/preferences/meaning-lead")).statusCode).toBe(401);
    expect((await req("GET", "/api/v1/preferences/meaning-lead", undefined, headers)).json()).toEqual({ lead: null, effective: null, reason: "Not yet calibrated." });
    const good = { threshold: 0.6, sample: 20, source: "proof:search", measured_at: "2026-10-25" };
    // The fixture clock is 2026-10-25T09:00Z: today and tomorrow (an owner ahead of UTC) are accepted, the day after is not.
    for (const bad of [{ ...good, threshold: 0.44 }, { ...good, threshold: 1 }, { ...good, sample: 19 }, { ...good, source: "guess" }, { ...good, measured_at: "2026-10-27" }, { ...good, measured_at: "yesterday" }, { ...good, measured_at: "2026-02-30" }, { ...good, extra: 1 }])
      expect((await req("PATCH", "/api/v1/preferences/meaning-lead", bad, headers)).statusCode, JSON.stringify(bad)).toBe(400);
    expect((await req("PATCH", "/api/v1/preferences/meaning-lead", { ...good, measured_at: "2026-10-26" }, headers)).statusCode).toBe(200);
    expect((await req("DELETE", "/api/v1/preferences/meaning-lead", {}, { ...headers, "content-type": "application/json" })).statusCode).toBe(200);
    expect(fx.store.setting(MEANING_LEAD, null)).toBeNull();
    expect((await req("PATCH", "/api/v1/preferences/meaning-lead", good, { cookie: headers.cookie })).statusCode).toBe(403);
    expect((await req("PATCH", "/api/v1/preferences/meaning-lead", good, { authorization: `Bearer ${fx.agentToken}` })).statusCode).toBe(403);
    expect((await req("GET", "/api/v1/preferences/meaning-lead", undefined, { authorization: `Bearer ${fx.agentToken}` })).statusCode).toBe(403);
    const set = await req("PATCH", "/api/v1/preferences/meaning-lead", { ...good, threshold: 0.604 }, headers);
    expect(set.statusCode).toBe(200);
    expect(set.json()).toMatchObject({ threshold: 0.6, key: modelKey("ollama", FAKE_EMBED_MODEL), sample: 20, source: "proof:search", measured_at: "2026-10-25", applied_at: "2026-10-25T09:00:00.000Z" });
    expect((await req("GET", "/api/v1/preferences/meaning-lead", undefined, headers)).json()).toMatchObject({ effective: 0.6, reason: "ready" });
    // The worker's model changes: the line is kept but never leads, and Settings says to measure again.
    publishBetterSearchStatus(fx.brain, { configured: true, provider: "ollama", model: "other-model", key: modelKey("ollama", "other-model"), label: "Ollama on this computer", detected: true, probe: "found" });
    fx.store.set("worker_heartbeat", fx.brain.now());
    fx.brain.setBetterSearch(owner, { mode: "ollama" });
    expect(fx.brain.meaningLeadThreshold()).toBeNull();
    expect((await req("GET", "/api/v1/preferences/meaning-lead", undefined, headers)).json()).toMatchObject({ effective: null, reason: "Measured for another search model. Measure again." });
    expect((await req("DELETE", "/api/v1/preferences/meaning-lead", undefined, headers)).json()).toEqual({ lead: null });
    expect(fx.store.setting<MeaningLead | null>(MEANING_LEAD, null)).toBeNull();
    // With Better search off there is nothing to measure against.
    fx.brain.setBetterSearch(owner, { mode: "off" });
    expect((await req("PATCH", "/api/v1/preferences/meaning-lead", good, headers)).statusCode).toBe(409);
    expect((await req("GET", "/api/v1/preferences/meaning-lead", undefined, headers)).json()).toMatchObject({ effective: null, reason: "Turn Better search on first." });
  });
});
