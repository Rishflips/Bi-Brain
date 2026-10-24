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
afterEach(() => { for (const fn of cleanup.reverse()) fn(); cleanup = []; });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "s1-service-test-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const s = new Storage(join(dir, "brain.sqlite"), { vault: join(dir, "vault") });
  cleanup.push(() => { try { s.close(); } catch {} });
  const b = new Brain(s, () => new Date("2026-10-24T09:00:00Z"), undefined, undefined, undefined, undefined, () => ({ ready: true, reason: "test" }));
  b.prefs(owner, { ...b.prefs(owner), enabled: true, decision_provider_enabled: true, daily_cap_micro_usd: 50_000, per_job_cap_micro_usd: 5_000 });
  return b;
}
const result = (over: Partial<Record<string, any>> = {}): AskResult => ({
  model: "clef-flash", usage: { input_tokens: 300, output_tokens: 0 }, cost_micro_usd: 27, price_version: "cf-clef-flash-2026-10-01", policy_version: "system-one-ask-v1",
  answers: [
    { id: "kind", type: "choice", choice: "decision", confidence: 0.9, probabilities: { decision: 0.9, fact: 0.025, question: 0.025, task: 0.025, note: 0.025 } },
    { id: "project", type: "choice", choice: over.project ?? "PROJECT", confidence: over.confidence ?? 0.85, probabilities: {} },
    { id: "review", type: "noul", probability: over.review ?? 0.1 },
    { id: "show", type: "noul", probability: over.show ?? 0.9 },
  ],
});
const jobs = (b: Brain) => b.store.all<{ kind: string; payload: string }>("SELECT kind,payload FROM jobs WHERE kind='system_one_route'");

describe("System 1 in the service", () => {
  it("queues one job per project-visible capture only while sorting help is allowed", () => {
    const b = setup();
    b.capture(owner, { project_id: "inbox", title: "A", body: "We decided to ship one plan.", visibility: "project" });
    b.capture(owner, { project_id: "inbox", title: "B", body: "Private thought.", visibility: "private" });
    expect(jobs(b)).toHaveLength(1);
    b.prefs(owner, { ...b.prefs(owner), decision_provider_enabled: false });
    b.capture(owner, { project_id: "inbox", title: "C", body: "Another one.", visibility: "project" });
    expect(jobs(b)).toHaveLength(1);
  });

  it("files a confident Inbox note through the owner's Keep, as a new version", () => {
    const b = setup();
    const p = b.createProject(owner, "Northstar");
    const { source_id } = b.capture(owner, { project_id: "inbox", title: "Pricing", body: "Northstar ships with one plan.", visibility: "project" }) as any;
    const r = b.recordSystemOneResult({ id: "j1", project_id: "inbox" }, source_id, 1, result({ project: p.id }));
    expect(r).toMatchObject({ recorded: true, advice: { file_to: p.id } });
    const [card] = b.brief(owner).items.filter((i) => i.kind === "file");
    expect(card.title).toBe("File in Northstar?");
    b.fileSuggestion(owner, card.target.id, { action: "keep", expected_version: card.target.version });
    expect(b.source(owner, source_id)).toMatchObject({ project_id: p.id, version: 2 });
    expect(b.systemOneLog(owner).rows.some((row) => row.action === "keep_file" && row.question === "project")).toBe(true);
    expect(JSON.stringify(b.systemOneLog(owner))).not.toContain("one plan");
  });

  it("publishes nothing for an old version, an unwatched project or a replay", () => {
    const b = setup();
    const p = b.createProject(owner, "Northstar");
    const { source_id } = b.capture(owner, { project_id: "inbox", title: "Pricing", body: "Northstar ships.", visibility: "project" }) as any;
    b.editSource(owner, source_id, { title: "Pricing", body: "Northstar ships soon.", expected_version: 1 });
    expect(b.recordSystemOneResult({ id: "j1", project_id: "inbox" }, source_id, 1, result({ project: p.id })).recorded).toBe(false);
    expect(b.recordSystemOneResult({ id: "j2", project_id: "inbox" }, source_id, 2, result({ project: p.id })).recorded).toBe(true);
    expect(b.recordSystemOneResult({ id: "j3", project_id: "inbox" }, source_id, 2, result({ project: p.id })).recorded).toBe(false);
    expect(b.entities(owner, "file_suggestion")).toHaveLength(1);
  });

  it("publishes nothing once the project is no longer watched", () => {
    const b = setup();
    const p = b.createProject(owner, "Northstar");
    const { source_id } = b.capture(owner, { project_id: p.id, title: "S", body: "Northstar notes.", visibility: "project" }) as any;
    b.watchProject(owner, p.id, { watched: false });
    expect(b.recordSystemOneResult({ id: "j1", project_id: p.id }, source_id, 1, result({ project: "stay" })).recorded).toBe(false);
    expect(b.entities(owner, "s1_answer")).toHaveLength(0);
  });

  it("keeps a moved note from being moved again by a stale suggestion", () => {
    const b = setup();
    const p = b.createProject(owner, "Northstar");
    const { source_id } = b.capture(owner, { project_id: "inbox", title: "Pricing", body: "Northstar ships.", visibility: "project" }) as any;
    b.recordSystemOneResult({ id: "j1", project_id: "inbox" }, source_id, 1, result({ project: p.id }));
    const [card] = b.brief(owner).items.filter((i) => i.kind === "file");
    b.editSource(owner, source_id, { title: "Pricing", body: "Changed.", expected_version: 1 });
    expect(() => b.fileSuggestion(owner, card.target.id, { action: "keep", expected_version: card.target.version })).toThrow(/changed/i);
  });

  it("quiets a note's cards without hiding them, and logs Dismiss against the answer", () => {
    const b = setup();
    const p = b.createProject(owner, "Northstar");
    const { source_id } = b.capture(owner, { project_id: p.id, title: "S", body: "northstar status active", visibility: "project" }) as any;
    b.recordSystemOneResult({ id: "j1", project_id: p.id }, source_id, 1, result({ show: 0.1, project: "stay" }));
    const [card] = b.brief(owner).items;
    expect(card).toBeTruthy();
    b.dismissBriefItem(owner, { signature: card.signature });
    expect(b.systemOneLog(owner).rows.some((row) => row.action === "dismiss")).toBe(true);
  });

  it("wakes at most one review per goal, only for an active goal that allows preparation", () => {
    const b = setup();
    const p = b.createProject(owner, "Northstar");
    const goal = b.goal(owner, { project_id: p.id, title: "Launch", success_criteria: "Ship in November" });
    b.editGoal(owner, goal.id, { expected_version: goal.version, preparation_enabled: true });
    const { source_id } = b.capture(owner, { project_id: p.id, title: "S", body: "Interviews moved the date.", visibility: "project" }) as any;
    const pending = () => b.store.all("SELECT id FROM jobs WHERE kind='review_changed_assumption' AND status='queued'").length;
    const before = pending();
    b.recordSystemOneResult({ id: "j1", project_id: p.id }, source_id, 1, result({ review: 0.9, project: "stay" }));
    expect(pending()).toBe(before + 1);
    b.editSource(owner, source_id, { title: "S", body: "Interviews moved the date again.", expected_version: 1 });
    b.recordSystemOneResult({ id: "j2", project_id: p.id }, source_id, 2, result({ review: 0.9, project: "stay" }));
    expect(pending()).toBe(before + 1);
  });
});
