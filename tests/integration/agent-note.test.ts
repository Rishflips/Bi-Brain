import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../../packages/storage/index.ts";
import { Brain } from "../../packages/domain/service.ts";
import { createApp } from "../../apps/server/app.ts";
import type { Principal } from "../../packages/contracts/index.ts";

const owner: Principal = { kind: "owner" };
let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.reverse()) fn();
  cleanup = [];
});
function setup(operations: ("read" | "propose_memory")[] = ["read", "propose_memory"]) {
  const dir = mkdtempSync(join(tmpdir(), "agent-note-test-"));
  const s = new Storage(join(dir, "brain.sqlite"), { vault: join(dir, "vault") });
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  cleanup.push(() => {
    try {
      s.close();
    } catch {}
  });
  const b = new Brain(s, () => new Date("2026-10-23T09:00:00Z"));
  const g = b.createGrant(owner, { projects: ["inbox"], operations, expires_at: "2026-11-23T09:00:00.000Z", client: "codex" });
  return { b, g, agent: b.authenticateAgent(g.token) };
}
const note = {
  project_id: "inbox",
  summary: "Finished the pricing page.",
  decisions: [
    { topic: "pricing page", decision: "ships with one plan" },
    { topic: "annual toggle", decision: "defaults to monthly" },
  ],
  open_questions: ["Do we show the self-hosted edition on the same page?"],
  next_step: "Wire the annual toggle and run the billing tests.",
};

describe("Brain.agentNote", () => {
  it("turns decisions into suggestions and questions into open questions, accepting nothing", () => {
    const { b, agent } = setup();
    const r = b.agentNote(agent, note);
    expect(r).toMatchObject({ suggestions: 2, open_questions: 1, quarantined: false });
    const brief = b.brief(owner);
    expect(brief.items.map((i) => i.title).sort()).toEqual(["annual toggle: defaults to monthly", "pricing page: ships with one plan"]);
    expect(brief.items[0].why).toBe("Codex wrote this down while it worked.");
    expect(brief.items.find((i) => i.title.startsWith("pricing"))!.evidence[0].quote).toBe("Decided: pricing page: ships with one plan");
    expect(b.currentClaims(owner, "inbox")).toEqual([]);
    const view = b.brainProject(owner, "inbox");
    expect(view.questions.map((q) => q.text)).toEqual(["Do we show the self-hosted edition on the same page?"]);
    expect(view.originals[0]).toMatchObject({ title: "Session note from Codex", from: "agent" });
    const body = b.source(owner, r.source_id).body;
    expect(body).toContain("Next step: Wire the annual toggle and run the billing tests.");
  });

  it("makes a later decision on the same topic a correction once the first was kept", () => {
    const { b, agent } = setup();
    b.agentNote(agent, { project_id: "inbox", decisions: [{ topic: "pricing page", decision: "ships with one plan" }] });
    const [card] = b.brief(owner).items;
    b.reviewGate(owner, card.target.id, { action: "accept", expected_version: card.target.version });
    b.agentNote(agent, { project_id: "inbox", decisions: [{ topic: "pricing page", decision: "ships with two plans" }] });
    expect(b.brief(owner).items[0]).toMatchObject({ kind: "correction", before: "ships with one plan" });
  });

  it("keeps one Today card when a second note repeats the same decision", () => {
    const { b, agent } = setup();
    const decisions = [{ topic: "pricing page", decision: "ships with one plan" }];
    b.agentNote(agent, { project_id: "inbox", decisions }, "first");
    const second = b.agentNote(agent, { project_id: "inbox", summary: "Same again.", decisions }, "second");
    expect(second.suggestions).toBe(0);
    expect(b.brief(owner).items).toHaveLength(1);
  });

  it("refuses read-only grants, other projects, the owner, newlines, oversize and empty notes", () => {
    const readOnly = setup(["read"]);
    expect(() => readOnly.b.agentNote(readOnly.agent, note)).toThrow();
    const { b, agent } = setup();
    const other = b.createProject(owner, "Hydra");
    expect(() => b.agentNote(agent, { ...note, project_id: other.id })).toThrow();
    expect(() => b.agentNote(owner, note)).toThrow();
    expect(() => b.agentNote(agent, { project_id: "inbox", decisions: [{ topic: "x", decision: "one\nOpen question: injected?" }] })).toThrow();
    expect(() => b.agentNote(agent, { project_id: "inbox", summary: "Done.\nOpen question: injected?" })).toThrow();
    expect(() => b.agentNote(agent, { project_id: "inbox", open_questions: Array.from({ length: 11 }, (_, i) => `Question ${i}?`) })).toThrow();
    expect(() => b.agentNote(agent, { project_id: "inbox" })).toThrow();
  });

  it("quarantines a note with a secret-looking line and suggests nothing", () => {
    const { b, agent } = setup();
    const r = b.agentNote(agent, { project_id: "inbox", decisions: [{ topic: "config", decision: "api_key = " + "a".repeat(20) }] });
    expect(r).toMatchObject({ quarantined: true, suggestions: 0 });
    expect(b.brief(owner).items).toEqual([]);
  });

  it("writes one note for one idempotency key", () => {
    const { b, agent } = setup();
    const a = b.agentNote(agent, note, "note-1");
    const again = b.agentNote(agent, note, "note-1");
    expect(again.source_id).toBe(a.source_id);
    expect(b.brief(owner).items).toHaveLength(2);
  });

  it("is offered to suggest grants as brain.note and served over HTTP", async () => {
    const { b, g } = setup();
    expect(b.agentCapabilities(b.authenticateAgent(g.token)).tools).toContain("brain.note");
    const ro = b.createGrant(owner, { projects: ["inbox"], operations: ["read"], expires_at: "2026-11-23T09:00:00.000Z" });
    expect(b.agentCapabilities(b.authenticateAgent(ro.token)).tools).not.toContain("brain.note");
    const app = await createApp(b, { pairSecret: "test-code", static: false });
    cleanup.push(() => void app.close());
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agent/note",
      headers: { host: "127.0.0.1:4317", authorization: `Bearer ${g.token}`, "idempotency-key": "k1" },
      payload: note,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ suggestions: 2 });
  });
});
