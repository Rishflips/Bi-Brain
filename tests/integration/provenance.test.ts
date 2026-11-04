import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../../packages/storage/index.ts";
import { Brain } from "../../packages/domain/service.ts";
import { REVIEWED_KEY, writtenByLabel } from "../../packages/domain/provenance.ts";
import type { Principal } from "../../packages/contracts/index.ts";

const owner: Principal = { kind: "owner" };
let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.reverse()) fn();
  cleanup = [];
});
function setup(clock = "2026-11-03T09:00:00Z") {
  const dir = mkdtempSync(join(tmpdir(), "provenance-test-"));
  const s = new Storage(join(dir, "brain.sqlite"), { vault: join(dir, "vault") });
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  cleanup.push(() => {
    try {
      s.close();
    } catch {}
  });
  const b = new Brain(s, () => new Date(clock));
  const g = b.createGrant(owner, { projects: ["inbox"], operations: ["read", "propose_memory"], expires_at: "2026-12-03T09:00:00.000Z", client: "codex" });
  return { b, s, dir, grant: g, agent: b.authenticateAgent(g.token) };
}
const note = { project_id: "inbox", decisions: [{ topic: "queue", decision: "SQLite with leases" }], next_step: "Wire the lease recovery test." };

describe("provenance of agent-written originals", () => {
  it("labels an agent note unreviewed in recall and open, and leaves an owner note unlabelled", () => {
    const { b, agent } = setup();
    const mine = b.capture(owner, { title: "Queue plan", body: "The queue uses SQLite with leases, decided by me." }) as { source_id: string };
    const theirs = b.agentNote(agent, note);
    expect(b.sourceReviewedAt(theirs.source_id)).toBeNull();
    expect(b.writtenBy({ id: mine.source_id, origin: "manual" })).toBeUndefined();
    const hits = b.recallCore(owner, { query: "queue SQLite leases" }).hits;
    const agentHit = hits.find((h) => h.id === theirs.source_id)!;
    const ownerHit = hits.find((h) => h.id === mine.source_id)!;
    expect(agentHit).toMatchObject({ kind: "original", written_by: { agent: "Codex", reviewed: false } });
    expect(ownerHit).not.toHaveProperty("written_by");
    expect(JSON.stringify(ownerHit)).not.toContain("written_by");
    const opened = b.agentOpen(agent, { id: theirs.source_id }) as { item: { written_by?: unknown } };
    expect(opened.item.written_by).toEqual({ agent: "Codex", reviewed: false });
    expect(b.sourceView(owner, mine.source_id)).not.toHaveProperty("written_by");
    expect(writtenByLabel({ agent: "Codex", reviewed: false })).toBe("From Codex · not yet reviewed");
  });

  it("a Keep, Fix, Dismiss or Undo on a derived card never reviews the note; the rest of the note stays unreviewed everywhere", () => {
    const { b, agent } = setup();
    // A note that holds more than the one line a card shows.
    const r = b.agentNote(agent, { project_id: "inbox", decisions: [{ topic: "queue", decision: "SQLite with leases" }, { topic: "deploy", decision: "Thursdays, the kestrel window" }], open_questions: ["Which lease length?"], next_step: "Wire the lease recovery test." });
    const cards = b.brief(owner).items;
    const deploy = cards.find((c) => c.title.startsWith("deploy"))!;
    b.reviewGate(owner, deploy.target.id, { action: "reject", expected_version: deploy.target.version });
    const queue = cards.find((c) => c.title.startsWith("queue"))!;
    const kept = b.reviewGate(owner, queue.target.id, { action: "accept", expected_version: queue.target.version });
    expect(b.sourceReviewedAt(r.source_id)).toBeNull();
    // The kept fact is the owner's; the note is still another agent's unreviewed text.
    const hits = b.recallCore(agent, { query: "kestrel window deploy" }).hits;
    expect(hits.find((h) => h.id === r.source_id)).toMatchObject({ written_by: { agent: "Codex", reviewed: false } });
    expect(b.recallCore(agent, { query: "queue SQLite leases" }).hits[0]).toMatchObject({ kind: "fact" });
    b.reviewGate(owner, queue.target.id, { action: "undo", expected_version: kept.gate_version });
    expect(b.sourceReviewedAt(r.source_id)).toBeNull();
  });

  it("an owner edit of the body, Mark as reviewed, or saving the same text reviews the note; a move, a title-only edit or an owner note do not; a forgotten note loses its mark", () => {
    const { b, s, agent } = setup();
    const a = b.agentNote(agent, note);
    const c = b.agentNote(agent, { project_id: "inbox", open_questions: ["Which lease length?"] });
    const d = b.agentNote(agent, { project_id: "inbox", open_questions: ["Which port?"] });
    const mine = b.capture(owner, { title: "Mine", body: "Owner text." }) as { source_id: string };
    expect(b.markSourceReviewed(owner, a.source_id)).toEqual({ source_id: a.source_id, reviewed_at: "2026-11-03T09:00:00.000Z" });
    expect(() => b.markSourceReviewed(agent, a.source_id)).toThrow(/Owner access required/);
    expect(() => b.markSourceReviewed(owner, mine.source_id)).toThrow(/not written by an agent/i);
    expect(() => b.markSourceReviewed(owner, "missing")).toThrow(/unavailable/i);
    // A title-only edit, and a move between projects, are not a review.
    const srcD = b.source(owner, d.source_id);
    b.editSource(owner, d.source_id, { title: "Renamed", body: srcD.body, expected_version: srcD.version });
    expect(b.sourceReviewedAt(d.source_id)).toBeNull();
    b.createProject(owner, "Northstar");
    const moved = b.source(owner, d.source_id);
    b.editSource(owner, d.source_id, { title: moved.title, body: moved.body, expected_version: moved.version, project_id: b.projects(owner).find((p: any) => p.title === "Northstar")!.id });
    expect(b.sourceReviewedAt(d.source_id)).toBeNull();
    // An edit that changes the body is.
    const srcC = b.source(owner, c.source_id);
    b.editSource(owner, c.source_id, { title: srcC.title, body: srcC.body + "\nOwner addition.", expected_version: srcC.version });
    expect(b.sourceReviewedAt(c.source_id)).toBe("2026-11-03T09:00:00.000Z");
    // The owner saving the identical text returns the note as a duplicate and counts as their review.
    const e = b.agentNote(agent, { project_id: "inbox", next_step: "Rotate the lease owner." });
    const dup = b.capture(owner, { title: "Mine too", body: b.source(owner, e.source_id).body, visibility: "project" }) as { source_id: string; duplicate?: boolean };
    expect(dup).toMatchObject({ source_id: e.source_id, duplicate: true });
    expect(b.sourceReviewedAt(e.source_id)).toBe("2026-11-03T09:00:00.000Z");
    b.removeSource(owner, c.source_id, 2, true);
    expect(s.get("SELECT value FROM settings WHERE key=?", REVIEWED_KEY(c.source_id))).toBeUndefined();
  });

  it("the continuation brief leaves unreviewed agent sources out for an agent and labels them for the owner", () => {
    const { b, agent } = setup();
    const theirs = b.agentNote(agent, { project_id: "inbox", open_questions: ["Is the HERON_CANARY lease right?"] });
    b.capture(owner, { title: "Mine", body: "The owner's own OSPREY_CANARY note." });
    const forAgent = JSON.stringify(b.context(agent, "inbox"));
    expect(forAgent).toContain("OSPREY_CANARY");
    expect(forAgent).not.toContain("HERON_CANARY");
    const forOwner = b.context(owner, "inbox") as { items: { text: string; epistemic_status: string }[] };
    expect(forOwner.items.find((i) => i.text.includes("HERON_CANARY"))!.epistemic_status).toBe("agent_unreviewed");
    b.markSourceReviewed(owner, theirs.source_id);
    expect(JSON.stringify(b.context(agent, "inbox"))).toContain("HERON_CANARY");
    // The same rule once a derived brief exists: an item whose evidence cites an unreviewed agent note is left out for an agent.
    const again = b.agentNote(agent, { project_id: "inbox", open_questions: ["Is the EGRET_CANARY retry right?"] });
    const quote = "Open question: Is the EGRET_CANARY retry right?";
    // The note body opens with its header line, so the quote's offsets are taken from the stored body.
    const body = b.source(owner, again.source_id).body;
    const start = Array.from(body.slice(0, body.indexOf(quote))).length;
    b.store.run(
      "INSERT INTO entities VALUES(?,?,?,?,?,?)",
      "brief-ctx-test", "inbox", "brief", 1,
      JSON.stringify({ status: "current", items: [{ text: quote, epistemic_status: "user_assertion", evidence: [{ source_id: again.source_id, source_version: 1, start, end: start + Array.from(quote).length, quote }] }, { text: "owner line", epistemic_status: "supported", evidence: [] }], unknowns: [] }),
      "2026-11-03T09:00:00.000Z",
    );
    expect(JSON.stringify(b.context(agent, "inbox"))).not.toContain("EGRET_CANARY");
    expect(JSON.stringify(b.context(agent, "inbox"))).toContain("owner line");
    expect(JSON.stringify(b.context(owner, "inbox"))).toContain("EGRET_CANARY");
  });

  it("deletes expired owner sessions when a new one is issued", () => {
    const { b, s } = setup();
    s.run("INSERT INTO sessions VALUES('old','x','2026-11-01T00:00:00.000Z')");
    b.issueSession();
    expect(s.all("SELECT token_hash FROM sessions").map((r: any) => r.token_hash)).not.toContain("old");
  });
});
