import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../../packages/storage/index.ts";
import { Brain } from "../../packages/domain/service.ts";
import { createApp } from "../../apps/server/app.ts";
import { MARKER_LINE, SESSION_NOTES_PER_SESSION, parseSessionNote } from "../../packages/domain/session-note.ts";
import type { Principal } from "../../packages/contracts/index.ts";

const owner: Principal = { kind: "owner" };
let cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "session-note-test-"));
  const s = new Storage(join(dir, "brain.sqlite"), { vault: join(dir, "vault") });
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  cleanup.push(() => {
    try {
      s.close();
    } catch {}
  });
  const b = new Brain(s, () => new Date("2026-11-03T09:00:00Z"));
  const g = b.createGrant(owner, { projects: ["inbox"], operations: ["read", "propose_memory"], expires_at: "2026-12-03T09:00:00.000Z", client: "claude-code" });
  return { b, agent: b.authenticateAgent(g.token), grant: g };
}
const session = "a".repeat(64);
const reply = [
  "I finished the queue work. Here is what changed.",
  "- **Decided: lease length: 90 seconds**",
  "* Decided: no topic here so this line is kept out",
  "Open question: should the worker retry twice?",
  "Next step: run the lease recovery test on Windows.",
  "Some trailing prose that is not a marker line.",
].join("\n");

describe("parseSessionNote", () => {
  it("keeps only marker lines, strips bullets and bold, needs a decision or a question, and returns null otherwise", () => {
    expect(parseSessionNote(reply)).toEqual({ decisions: [{ topic: "lease length", decision: "90 seconds" }], open_questions: ["should the worker retry twice?"], next_step: "run the lease recovery test on Windows." });
    expect(parseSessionNote("All done, nothing to record.")).toBeNull();
    // A next step alone is ordinary prose in an agent reply, not a note.
    expect(parseSessionNote("Next step: run the tests.")).toBeNull();
    expect(parseSessionNote("Still unclear: which port.\nQuestion: who owns it?")).toEqual({ decisions: [], open_questions: ["which port.", "who owns it?"] });
    expect(parseSessionNote("Decided: a: b\n".repeat(30))!.decisions).toHaveLength(10);
    // The topic ends at the first colon followed by a space, so a URL in the decision stays whole.
    expect(parseSessionNote("Decided: docs host: switch to https://x.example/docs")).toEqual({ decisions: [{ topic: "docs host", decision: "switch to https://x.example/docs" }], open_questions: [] });
    // One line over the brain_note cap drops only itself.
    expect(parseSessionNote(`Decided: long: ${"x".repeat(301)}\nOpen question: kept?`)).toEqual({ decisions: [], open_questions: ["kept?"] });
    expect(parseSessionNote(`Decided: fits: ${"x".repeat(300)}`)!.decisions).toHaveLength(1);
    expect(MARKER_LINE.test(reply)).toBe(true);
    expect(MARKER_LINE.test("plain prose\nmore prose")).toBe(false);
  });
});

describe("Brain.sessionNote", () => {
  it("saves a note from marker lines as an unreviewed agent original with cards, once per session and text", () => {
    const { b, agent } = setup();
    const r = b.sessionNote(agent, { session_id: session, client: "claude-code", text: reply });
    expect(r).toMatchObject({ saved: true, suggestions: 1, open_questions: 1, duplicate: false });
    const src = b.source(owner, (r as any).source_id);
    expect(src.title).toBe("Session note from Claude Code");
    expect(src.body).toBe("Session note from Claude Code.\nDecided: lease length: 90 seconds\nOpen question: should the worker retry twice?\nNext step: run the lease recovery test on Windows.");
    expect(src.body).not.toContain("trailing prose");
    expect(b.writtenBy(src)).toEqual({ agent: "Claude Code", reviewed: false });
    expect(b.brief(owner).items[0]).toMatchObject({ kind: "agent_memory", title: "lease length: 90 seconds", why: "Claude Code wrote this down while it worked." });
    expect(b.currentClaims(owner, "inbox")).toEqual([]);
    expect(b.sessionNote(agent, { session_id: session, client: "claude-code", text: reply })).toEqual(r);
    expect(b.sources(owner, "inbox")).toHaveLength(1);
    const again = b.sessionNote(agent, { session_id: "b".repeat(64), client: "claude-code", text: reply });
    expect(again).toMatchObject({ saved: true, duplicate: true });
    expect(b.sources(owner, "inbox")).toHaveLength(1);
    expect(b.connections(owner)[0].writeback).toEqual({ notes: 1, last_at: "2026-11-03T09:00:00.000Z" });
  });

  it("stays quiet on prose, on secrets and past the per-session limit, and logs nothing but counts", () => {
    const { b, agent } = setup();
    expect(b.sessionNote(agent, { session_id: session, client: "codex", text: "All done." })).toEqual({ saved: false, reason: "nothing" });
    expect(b.sessionNote(agent, { session_id: session, client: "codex", text: "Decided: api key: sk-proj-abcdefghijklmnopqrstuvwxyz123456" })).toEqual({ saved: false, reason: "secret" });
    expect(b.sources(owner, "inbox")).toEqual([]);
    for (let i = 0; i < SESSION_NOTES_PER_SESSION; i++) expect(b.sessionNote(agent, { session_id: session, client: "codex", text: `Open question: item ${i}?` })).toMatchObject({ saved: true });
    expect(b.sessionNote(agent, { session_id: session, client: "codex", text: "Open question: one too many?" })).toEqual({ saved: false, reason: "limit" });
    const log = JSON.stringify(b.sessionNoteLog(owner));
    for (const word of ["item", "api key", "sk-proj", "All done"]) expect(log).not.toContain(word);
    expect(b.sessionNoteLog(owner).rows.map((r) => r.reason ?? "saved")).toEqual(["nothing", "secret", ...Array(SESSION_NOTES_PER_SESSION).fill("saved"), "limit"]);
    expect(b.connections(owner)[0].writeback).toEqual({ notes: SESSION_NOTES_PER_SESSION, last_at: "2026-11-03T09:00:00.000Z" });
    // The log is bounded; the per-connection count is not lost when old rows fall off.
    for (let i = 0; i < 220; i++) b.sessionNote(agent, { session_id: ("0" + i).padStart(64, "0"), client: "codex", text: "All done." });
    expect(b.sessionNoteLog(owner).rows).toHaveLength(200);
    expect(b.connections(owner)[0].writeback.notes).toBe(SESSION_NOTES_PER_SESSION);
  });

  it("needs an agent that may suggest and reads exactly one project, refuses bad input, and keeps a secret-shaped value out of the Brief", () => {
    const { b, agent } = setup();
    expect(() => b.sessionNote(owner, { session_id: session, client: "codex", text: "Open question: x?" })).toThrow(/agent/i);
    const ro = b.createGrant(owner, { projects: ["inbox"], operations: ["read"], expires_at: "2026-12-03T09:00:00.000Z", client: "codex" });
    expect(() => b.sessionNote(b.authenticateAgent(ro.token), { session_id: session, client: "codex", text: "Open question: x?" })).toThrow();
    b.createProject(owner, "Northstar");
    const wide = b.createGrant(owner, { projects: ["inbox", b.projects(owner).find((p: any) => p.title === "Northstar")!.id], operations: ["read", "propose_memory"], expires_at: "2026-12-03T09:00:00.000Z", client: "codex" });
    expect(() => b.sessionNote(b.authenticateAgent(wide.token), { session_id: session, client: "codex", text: "Open question: where?" })).toThrow("This connection reads more than one project; session notes need exactly one.");
    expect(b.sources(owner)).toEqual([]);
    expect(() => b.sessionNote(agent, { session_id: "short", client: "codex", text: "Open question: x?" })).toThrow();
    expect(() => b.sessionNote(agent, { session_id: session, client: "codex", text: "x".repeat(4001) })).toThrow();
    // A marker line whose decision looks like a credential is refused before capture: no card, no recall hit, nothing stored.
    const r = b.sessionNote(agent, { session_id: session, client: "codex", text: "Decided: deploy: password = hunter2hunter2hunter2\nNext step: rotate" });
    expect(r).toMatchObject({ saved: false, reason: "secret" });
    expect(b.brief(owner).items).toEqual([]);
    expect(b.recallCore(agent, { query: "hunter2hunter2hunter2" }).hits).toEqual([]);
  });

  it("is reachable over HTTP with the agent's bearer only", async () => {
    const { b, grant } = setup();
    const app = await createApp(b, { pairSecret: "test-code", static: false });
    cleanup.push(() => app.close());
    const res = await app.inject({ method: "POST", url: "/api/v1/agent/session-note", headers: { host: "127.0.0.1:4317", authorization: `Bearer ${grant.token}` }, payload: { session_id: session, client: "claude-code", text: reply } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ saved: true });
    expect((await app.inject({ method: "POST", url: "/api/v1/agent/session-note", headers: { host: "127.0.0.1:4317" }, payload: { session_id: session, client: "claude-code", text: reply } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/v1/agent/session-note", headers: { host: "127.0.0.1:4317", authorization: `Bearer ${grant.token}` }, payload: { session_id: session, text: reply, extra: 1 } })).statusCode).toBe(400);
  });

  it("arrives as an unreviewed agent original: a second agent recalls it labelled, and a push names nothing from it above a pointer", async () => {
    const { b, grant } = setup();
    const app = await createApp(b, { pairSecret: "test-code", static: false });
    cleanup.push(() => app.close());
    const post = (url: string, token: string, payload: Record<string, unknown>) => app.inject({ method: "POST", url, headers: { host: "127.0.0.1:4317", authorization: `Bearer ${token}` }, payload });
    const text = "Decided: zephyr cadence: fortnightly KESTREL_CANARY\nOpen question: does the zephyr cadence hold in winter?";
    const saved = (await post("/api/v1/agent/session-note", grant.token, { session_id: session, client: "claude-code", text })).json();
    expect(saved).toMatchObject({ saved: true, suggestions: 1, duplicate: false });
    const reader = b.createGrant(owner, { projects: ["inbox"], operations: ["read"], expires_at: "2026-12-03T09:00:00.000Z", client: "codex" });
    const hit = b.recallCore(b.authenticateAgent(reader.token), { query: "zephyr cadence" }).hits.find((h) => h.id === saved.source_id);
    expect(hit).toMatchObject({ kind: "original", written_by: { agent: "Claude Code", reviewed: false } });
    const push = (await post("/api/v1/agent/recall-push", reader.token, { prompt: "what is the zephyr cadence we settled on", session_id: "c".repeat(64), first_prompt: false, seen: [] })).json();
    // By words alone the note is a strong hit; the cap for unreviewed agent text holds it to a pointer that names no part of it.
    expect(push.level).toBe("pointer");
    expect(push.hit_ids).toEqual([]);
    expect(String(push.text ?? "")).not.toContain("KESTREL_CANARY");
    expect(String(push.text ?? "")).not.toContain("fortnightly");
  });

  it("skips marker-looking lines inside a fenced code block", () => {
    const fence = "`".repeat(3);
    const quoted = ["Here is the file I read:", fence, "Decided: quoted topic: from a file", "Open question: quoted?", fence, "Open question: is this mine?"].join("\n");
    expect(parseSessionNote(quoted)).toEqual({ decisions: [], open_questions: ["is this mine?"] });
    expect(parseSessionNote([`${fence}ts`, "Decided: a: b", fence].join("\n"))).toBeNull();
  });

  it("files the same session's different text as a new note, counted toward the session's limit", () => {
    const { b, agent } = setup();
    const first = b.sessionNote(agent, { session_id: session, client: "codex", text: "Open question: first?" });
    const second = b.sessionNote(agent, { session_id: session, client: "codex", text: "Open question: second?" });
    expect(first).toMatchObject({ saved: true, duplicate: false });
    expect(second).toMatchObject({ saved: true, duplicate: false });
    expect((second as any).source_id).not.toBe((first as any).source_id);
    expect(b.sources(owner, "inbox")).toHaveLength(2);
    expect(b.connections(owner)[0].writeback.notes).toBe(2);
  });

  it("stores a secret split by bold markers only as the private quarantined source capture keeps, and reports it as a secret", () => {
    const { b, agent } = setup();
    // The raw text passes the scan; the cleaned marker line joins the secret, and capture quarantines it.
    const text = "Decided: deploy: sk-proj-abcdef**ghijklmnopqrstuvwxyz123456";
    expect(b.sessionNote(agent, { session_id: session, client: "codex", text })).toEqual({ saved: false, reason: "secret" });
    const kept = b.sources(owner);
    expect(kept).toHaveLength(1);
    expect(JSON.stringify(kept)).not.toContain("ghijklmnop");
    expect(b.brief(owner).items).toEqual([]);
    expect(b.recallCore(agent, { query: "deploy" }).hits).toEqual([]);
    expect(b.connections(owner)[0].writeback.notes).toBe(0);
  });

  it("refuses a revoked or an expired grant in the domain and over HTTP", async () => {
    const { b, agent, grant } = setup();
    const app = await createApp(b, { pairSecret: "test-code", static: false });
    cleanup.push(() => app.close());
    const body = { session_id: session, client: "codex", text: "Open question: x?" };
    const post = (token: string) => app.inject({ method: "POST", url: "/api/v1/agent/session-note", headers: { host: "127.0.0.1:4317", authorization: `Bearer ${token}` }, payload: body });
    b.revoke(owner, grant.id);
    expect(() => b.sessionNote(agent, body)).toThrow("Access expired or was revoked.");
    expect((await post(grant.token)).statusCode).toBe(401);
    const later = b.createGrant(owner, { projects: ["inbox"], operations: ["read", "propose_memory"], expires_at: "2026-12-03T09:00:00.000Z", client: "codex" });
    const laterAgent = b.authenticateAgent(later.token);
    b.store.run("UPDATE grants SET expires_at=? WHERE id=?", "2026-11-01T00:00:00.000Z", later.id);
    expect(() => b.sessionNote(laterAgent, body)).toThrow("Access expired or was revoked.");
    expect((await post(later.token)).statusCode).toBe(401);
    expect(b.sources(owner)).toEqual([]);
  });

  it("limits the route to 60 posts a minute", async () => {
    const { b, grant } = setup();
    const app = await createApp(b, { pairSecret: "test-code", static: false });
    cleanup.push(() => app.close());
    const post = () => app.inject({ method: "POST", url: "/api/v1/agent/session-note", headers: { host: "127.0.0.1:4317", authorization: `Bearer ${grant.token}` }, payload: { session_id: session, client: "codex", text: "All done." } });
    for (let i = 0; i < 60; i++) expect((await post()).statusCode).toBe(200);
    expect((await post()).statusCode).toBe(429);
  });
});
