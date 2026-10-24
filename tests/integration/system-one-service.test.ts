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

  const gateFor = (b: Brain, project: string, sourceId: string, version: number, extra: Record<string, any> = {}) =>
    b.createEntity(project, "gate", {
      raw_id: sourceId, type: "fact", entity: "northstar", field: { aspect: "status", value: "active" },
      evidence: [{ source_id: sourceId, source_version: version, start: 0, end: 4, quote: "Nort" }],
      status: "queued", reasons: [], actor: "owner", ...extra,
    });

  it("logs a dismissed card as the show question only, once, and never as kind", () => {
    const b = setup();
    const p = b.createProject(owner, "Northstar");
    const { source_id } = b.capture(owner, { project_id: p.id, title: "S", body: "northstar status active", visibility: "project" }) as any;
    b.recordSystemOneResult({ id: "j1", project_id: p.id }, source_id, 1, result({ project: "stay" }));
    const [card] = b.brief(owner).items;
    b.dismissBriefItem(owner, { signature: card.signature });
    b.dismissBriefItem(owner, { signature: card.signature });
    const { rows } = b.systemOneLog(owner);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ question: "show", choice: 0.9, action: "dismiss" });
    expect(rows.some((r) => r.question === "kind")).toBe(false);
  });

  it("logs show and changes_fact when a correction is reviewed", () => {
    const b = setup();
    const p = b.createProject(owner, "Northstar");
    const { source_id } = b.capture(owner, { project_id: p.id, title: "S", body: "Northstar plan notes", visibility: "project" }) as any;
    const r = result({ project: "stay" });
    r.answers.push({ id: "changes_fact", type: "noul", probability: 0.8 });
    b.recordSystemOneResult({ id: "j1", project_id: p.id }, source_id, 1, r);
    const gate = gateFor(b, p.id, source_id, 1, { correction: true, conflicts: [] });
    b.reviewGate(owner, gate.id, { action: "reject", expected_version: gate.version });
    const rows = b.systemOneLog(owner).rows.filter((x) => x.action === "reject");
    expect(rows.map((x) => x.question).sort()).toEqual(["changes_fact", "show"]);
    expect(b.systemOneLog(owner).rows.some((x) => x.question === "kind")).toBe(false);
  });

  it("leaves a newer version's card alone when the answer is for the older version", () => {
    const b = setup();
    const p = b.createProject(owner, "Northstar");
    const { source_id } = b.capture(owner, { project_id: p.id, title: "S", body: "Northstar plan notes", visibility: "project" }) as any;
    const old = gateFor(b, p.id, source_id, 1);
    const newer = gateFor(b, p.id, source_id, 2);
    b.recordSystemOneResult({ id: "j1", project_id: p.id }, source_id, 1, result({ show: 0.1, project: "stay" }));
    const quiet = b.store.setting<Record<string, string>>("brief_quiet", {});
    expect(Object.keys(quiet)).toEqual([old.id]);
    expect(b.entity(owner, old.id).version).toBe(old.version);
    expect(b.brief(owner).items.find((i) => i.target.id === newer.id)?.quiet).toBeUndefined();
  });

  it("quieting a card leaves its version alone, so a card drawn earlier still accepts", () => {
    const b = setup();
    const p = b.createProject(owner, "Northstar");
    const { source_id } = b.capture(owner, { project_id: p.id, title: "S", body: "Northstar plan notes", visibility: "project" }) as any;
    const gate = gateFor(b, p.id, source_id, 1);
    const drawn = b.brief(owner).items.find((i) => i.target.id === gate.id)!;
    expect(b.recordSystemOneResult({ id: "j1", project_id: p.id }, source_id, 1, result({ show: 0.1, project: "stay" })).recorded).toBe(true);
    expect(b.entity(owner, gate.id).version).toBe(drawn.target.version);
    expect(b.brief(owner).items.find((i) => i.target.id === gate.id)?.quiet).toBe(true);
    expect(() => b.reviewGate(owner, gate.id, { action: "accept", expected_version: drawn.target.version })).not.toThrow();
  });

  it("logs a dismissed quiet card against its answer through the quiet map", () => {
    const b = setup();
    const p = b.createProject(owner, "Northstar");
    const { source_id } = b.capture(owner, { project_id: p.id, title: "S", body: "Northstar plan notes", visibility: "project" }) as any;
    const gate = gateFor(b, p.id, source_id, 1);
    b.recordSystemOneResult({ id: "j1", project_id: p.id }, source_id, 1, result({ show: 0.1, project: "stay" }));
    const answerId = b.store.setting<Record<string, string>>("brief_quiet", {})[gate.id];
    expect(answerId).toBeTruthy();
    const card = b.brief(owner).items.find((i) => i.target.id === gate.id)!;
    b.dismissBriefItem(owner, { signature: card.signature });
    expect(b.systemOneLog(owner).rows.filter((r) => r.action === "dismiss" && r.question === "show").map((r) => r.answer_id)).toEqual([answerId]);
  });

  it("wakes a goal's review at most once a day", () => {
    let now = new Date("2026-10-24T09:00:00Z");
    const dir = mkdtempSync(join(tmpdir(), "s1-wake-test-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const s = new Storage(join(dir, "brain.sqlite"), { vault: join(dir, "vault") });
    cleanup.push(() => { try { s.close(); } catch {} });
    const b = new Brain(s, () => now, undefined, undefined, undefined, undefined, () => ({ ready: true, reason: "test" }));
    b.prefs(owner, { ...b.prefs(owner), enabled: true, decision_provider_enabled: true, daily_cap_micro_usd: 50_000, per_job_cap_micro_usd: 5_000 });
    const p = b.createProject(owner, "Northstar");
    const goal = b.goal(owner, { project_id: p.id, title: "Launch", success_criteria: "Ship in November" });
    b.editGoal(owner, goal.id, { expected_version: goal.version, preparation_enabled: true });
    const { source_id } = b.capture(owner, { project_id: p.id, title: "S", body: "Interviews moved the date.", visibility: "project" }) as any;
    const woken = () => b.store.all("SELECT id FROM jobs WHERE kind='review_changed_assumption' AND json_extract(payload,'$.woken_by') IS NOT NULL").length;
    const finish = () => b.store.run("UPDATE jobs SET status='succeeded' WHERE kind='review_changed_assumption'");
    b.recordSystemOneResult({ id: "j1", project_id: p.id }, source_id, 1, result({ review: 0.9, project: "stay" }));
    finish();
    now = new Date("2026-10-24T09:50:00Z");
    b.editSource(owner, source_id, { title: "S", body: "Interviews moved the date again.", expected_version: 1 });
    b.recordSystemOneResult({ id: "j2", project_id: p.id }, source_id, 2, result({ review: 0.9, project: "stay" }));
    expect(woken()).toBe(1);
    now = new Date("2026-10-25T10:00:00Z");
    b.editSource(owner, source_id, { title: "S", body: "Interviews moved the date a third time.", expected_version: 2 });
    b.recordSystemOneResult({ id: "j3", project_id: p.id }, source_id, 3, result({ review: 0.9, project: "stay" }));
    expect(woken()).toBe(2);
  });
});
