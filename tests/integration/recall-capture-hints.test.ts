import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../../packages/storage/index.ts";
import { Brain } from "../../packages/domain/service.ts";
import type { Principal } from "../../packages/contracts/index.ts";
import type { AskResult } from "../../packages/providers/system-one-ask.ts";

const owner: Principal = { kind: "owner" };
let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.reverse()) fn();
  cleanup = [];
});
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "recall-hints-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const s = new Storage(join(dir, "brain.sqlite"), { vault: join(dir, "vault") });
  cleanup.push(() => {
    try {
      s.close();
    } catch {}
  });
  const b = new Brain(s, () => new Date("2026-10-25T09:00:00Z"), undefined, undefined, undefined, undefined, () => ({ ready: true, reason: "test" }));
  b.prefs(owner, { ...b.prefs(owner), enabled: true, decision_provider_enabled: true, daily_cap_micro_usd: 50_000, per_job_cap_micro_usd: 5_000 });
  return { s, b };
}
const result = (durable: number, topic: { choice: string; confidence: number } | null): AskResult => ({
  model: "clef-flash", usage: { input_tokens: 300, output_tokens: 0 }, cost_micro_usd: 27, price_version: "cf-clef-flash-2026-10-01", policy_version: "system-one-ask-v1",
  answers: [
    { id: "kind", type: "choice", choice: "note", confidence: 0.9, probabilities: { decision: 0.025, fact: 0.025, question: 0.025, task: 0.025, note: 0.9 } },
    { id: "review", type: "noul", probability: 0.1 },
    { id: "show", type: "noul", probability: 0.9 },
    { id: "durable", type: "noul", probability: durable },
    ...(topic ? [{ id: "topic", type: "choice" as const, choice: topic.choice, confidence: topic.confidence, probabilities: {} }] : []),
  ],
});

describe("capture-time hints reach the recall index", () => {
  it("a durable note gets ×1.15 on its chunks, a throwaway note ×0.9, and an unsure one stays at 1", () => {
    const { s, b } = setup();
    const p = b.createProject(owner, "Northstar");
    const note = (body: string) => b.capture(owner, { project_id: p.id, title: "N", body, visibility: "project", separate: true }) as any;
    for (const [body, durable, boost] of [["Keep: the launch colour is cobalt.", 0.9, 1.15], ["Lunch at noon.", 0.1, 0.9], ["Maybe later.", 0.4, 1]] as const) {
      const saved = note(body);
      b.recordSystemOneResult({ id: "job", project_id: p.id }, saved.source_id, 1, result(durable, null));
      expect(Number(s.get("SELECT boost FROM recall_chunks WHERE ref_id=?", saved.source_id)!.boost)).toBe(boost);
    }
  });
  it("a confident topic adds the entity name to the prefix, stored with provenance, and a low or invalid one is ignored", () => {
    const { s, b } = setup();
    const p = b.createProject(owner, "Northstar");
    const seed = b.capture(owner, { project_id: p.id, title: "Status", body: "Northstar status active", visibility: "project" }) as any;
    const gate = b.entities(owner, "gate").find((g) => g.data.raw_id === seed.source_id)!;
    b.reviewGate(owner, gate.id, { action: "accept", expected_version: gate.version });
    // Owner-only facts (name, preference, owner_private) never become topic options: the sorting consent does not cover them.
    b.createEntity(p.id, "claim", { entity: "Ana Costa", aspect: "name", value: "Ana Costa", status: "current", authority: "owner_reviewed", valid_from: "2026-10-24T00:00:00.000Z", recorded_at: "2026-10-24T00:00:00.000Z", evidence: [{ source_id: seed.source_id, source_version: 1, start: 0, end: 9, quote: "Northstar" }], supersedes: [], conflicts_with: [] });
    b.createEntity(p.id, "claim", { entity: "Launch mood", aspect: "statement", value: "nervous", status: "current", authority: "owner_private", valid_from: "2026-10-24T00:00:00.000Z", recorded_at: "2026-10-24T00:00:00.000Z", evidence: [{ source_id: seed.source_id, source_version: 1, start: 0, end: 9, quote: "Northstar" }], supersedes: [], conflicts_with: [] });
    const ctx = b.systemOneContext(seed.source_id, 1)!;
    expect(ctx.entityNames).toEqual(["northstar"]);
    const saved = b.capture(owner, { project_id: p.id, title: "Plan", body: "The plan for the quarter is to ship.", visibility: "project" }) as any;
    b.recordSystemOneResult({ id: "job2", project_id: p.id }, saved.source_id, 1, result(0.5, { choice: "t1", confidence: 0.9 }));
    const row = s.get<any>("SELECT prefix FROM recall_chunks WHERE ref_id=?", saved.source_id)!;
    expect(row.prefix).toBe("Plan · Northstar · 2026-10-25 · northstar");
    const answer = b.entities(owner, "s1_answer").find((a) => a.data.source_id === saved.source_id)!;
    expect(answer.data.topic_options).toEqual(["northstar"]);
    for (const bad of [{ choice: "t1", confidence: 0.5 }, { choice: "t99", confidence: 0.99 }, { choice: "none", confidence: 0.99 }]) {
      const other = b.capture(owner, { project_id: p.id, title: "Other", body: `Another note ${bad.choice} ${bad.confidence}.`, visibility: "project" }) as any;
      b.recordSystemOneResult({ id: `job-${bad.choice}-${bad.confidence}`, project_id: p.id }, other.source_id, 1, result(0.5, bad));
      expect(s.get<any>("SELECT prefix FROM recall_chunks WHERE ref_id=?", other.source_id)!.prefix).toBe("Other · Northstar · 2026-10-25");
    }
    expect(b.recallCore(owner, { query: "northstar plan" }).hits.some((h) => h.id === saved.source_id)).toBe(true);
  });
  it("is a boost, never an exclusion: a durable of 0 still returns the note", () => {
    const { b } = setup();
    const saved = b.capture(owner, { title: "Throwaway", body: "The ZIRCON_SENTINEL is here.", visibility: "project" }) as any;
    b.recordSystemOneResult({ id: "job3", project_id: "inbox" }, saved.source_id, 1, result(0, null));
    expect(b.recallCore(owner, { query: "zircon_sentinel" }).hits.map((h) => h.id)).toContain(saved.source_id);
  });
});
