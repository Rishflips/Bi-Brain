import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../../packages/storage/index.ts";
import { Brain } from "../../packages/domain/service.ts";
import { REVIEWED_KEY, writtenByLabel } from "../../packages/domain/provenance.ts";
import { createApp } from "../../apps/server/app.ts";
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
    // A Fix (keeping the card again in the owner's own words) is not a review of the note either.
    const again = b.brief(owner).items.find((c) => c.title.startsWith("queue"))!;
    b.reviewGate(owner, again.target.id, { action: "accept", expected_version: again.target.version, value: "SQLite with leases, thirty seconds each." });
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
    // Withdrawing (not purging) also drops the mark, and a withdrawn note cannot be marked.
    b.removeSource(owner, a.source_id, b.source(owner, a.source_id).version, false);
    expect(b.sourceReviewedAt(a.source_id)).toBeNull();
    expect(() => b.markSourceReviewed(owner, a.source_id)).toThrow(/withdrawn/i);
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

  it("a restored export keeps an agent note agent-written and unreviewed, and an owner capture an import", () => {
    const { b, agent } = setup();
    const theirs = b.agentNote(agent, { project_id: "inbox", open_questions: ["Which plover lease length?"] });
    const mine = b.capture(owner, { title: "Mine", body: "The owner's own plover WREN_CANARY note." }) as { source_id: string };
    b.markSourceReviewed(owner, theirs.source_id);
    const exported = b.export(owner);
    const t = setup();
    const preview = t.b.preview(owner, exported);
    expect(preview.conflicts).toEqual([]);
    t.b.applyImport(owner, preview.id);
    // Review state is local: the restored note starts unreviewed and is tied to no grant of this brain.
    expect(t.b.sourceReviewedAt(theirs.source_id)).toBeNull();
    expect(t.b.writtenBy(t.b.source(owner, theirs.source_id))).toEqual({ agent: "A connected agent", reviewed: false });
    const hits = t.b.recallCore(owner, { query: "plover lease length" }).hits;
    expect(hits.find((h) => h.id === theirs.source_id)).toMatchObject({ kind: "original", written_by: { agent: "A connected agent", reviewed: false } });
    expect(t.b.source(owner, mine.source_id).origin).toBe("import");
    expect(t.b.sourceView(owner, mine.source_id)).not.toHaveProperty("written_by");
    // Still withheld from an agent's continuation brief until the owner reviews it.
    const forAgent = JSON.stringify(t.b.context(t.agent, "inbox"));
    expect(forAgent).toContain("WREN_CANARY");
    expect(forAgent).not.toContain("plover lease length");
    t.b.markSourceReviewed(owner, theirs.source_id);
    expect(JSON.stringify(t.b.context(t.agent, "inbox"))).toContain("plover lease length");
  });

  it("a near miss never names an unreviewed agent-written original", () => {
    const { b, agent } = setup();
    const theirs = b.agentNote(agent, { project_id: "inbox", open_questions: ["Is the plover lease right?"] });
    b.capture(owner, { title: "Mine", body: "The plover migration note." });
    const other = b.capture(owner, { title: "Mine two", body: "The plover rollout note." }) as { source_id: string };
    for (const who of [owner, agent]) {
      const r = b.recallCore(who, { query: "plover", limit: 1 });
      expect(r.near_misses.map((n) => n.id)).toContain(other.source_id);
      expect(r.near_misses.map((n) => n.id)).not.toContain(theirs.source_id);
    }
    b.markSourceReviewed(owner, theirs.source_id);
    expect(b.recallCore(agent, { query: "plover", limit: 1 }).near_misses.map((n) => n.id)).toContain(theirs.source_id);
  });

  it("a model-written brief's unknowns are withheld from an agent and labelled for the owner while an input is an unreviewed agent note", () => {
    const { b, agent } = setup();
    const theirs = b.agentNote(agent, { project_id: "inbox", open_questions: ["Is the SWIFT lease right?"] });
    const plant = (id: string, extra: Record<string, unknown>) =>
      b.store.run(
        "INSERT INTO entities VALUES(?,?,?,?,?,?)",
        id, "inbox", "brief", 1,
        JSON.stringify({ status: "current", items: [{ text: "owner line", epistemic_status: "supported", evidence: [] }], unknowns: ["Whether the SANDPIPER_CANARY retry holds."], source_versions: [{ id: theirs.source_id, version: 1 }], ...extra }),
        "2026-11-03T09:00:00.000Z",
      );
    plant("brief-unknowns-test", { provider: "openai" });
    const forAgent = b.context(agent, "inbox") as { unknowns: string[] };
    expect(forAgent.unknowns).toEqual([]);
    // The whole model-written brief is withheld from the agent, its evidence-free items included.
    expect(JSON.stringify(forAgent)).not.toContain("owner line");
    const forOwner = b.context(owner, "inbox") as { unknowns: string[]; unknowns_epistemic_status?: string };
    expect(forOwner.unknowns).toEqual(["Whether the SANDPIPER_CANARY retry holds."]);
    expect(forOwner.unknowns_epistemic_status).toBe("agent_unreviewed");
    b.markSourceReviewed(owner, theirs.source_id);
    expect((b.context(agent, "inbox") as { unknowns: string[] }).unknowns).toEqual(["Whether the SANDPIPER_CANARY retry holds."]);
    expect(b.context(owner, "inbox")).not.toHaveProperty("unknowns_epistemic_status");
  });

  it("a model-written brief built from an unreviewed agent note: an agent gets the excerpts instead, and the owner sees derived items labelled", () => {
    const { b, agent } = setup();
    const theirs = b.agentNote(agent, { project_id: "inbox", open_questions: ["Is the PIPIT_CANARY lease right?"] });
    const mine = b.capture(owner, { title: "Mine", body: "The owner's own LINNET_CANARY note." }) as { source_id: string };
    const body = b.source(owner, theirs.source_id).body;
    const quote = "Open question: Is the PIPIT_CANARY lease right?";
    const start = Array.from(body.slice(0, body.indexOf(quote))).length;
    const ownerQuote = "The owner's own LINNET_CANARY note.";
    b.store.run(
      "INSERT INTO entities VALUES(?,?,?,?,?,?)",
      "brief-derived-test", "inbox", "brief", 1,
      JSON.stringify({
        status: "current",
        provider: "openai",
        items: [
          { text: "Cites the agent note: PIPIT_CANARY", epistemic_status: "user_assertion", evidence: [{ source_id: theirs.source_id, source_version: 1, start, end: start + Array.from(quote).length, quote }] },
          { text: "Paraphrase without evidence: GREBE_CANARY", epistemic_status: "hypothesis", evidence: [] },
          { text: "Cites the owner: LINNET_CANARY", epistemic_status: "supported", evidence: [{ source_id: mine.source_id, source_version: 1, start: 0, end: Array.from(ownerQuote).length, quote: ownerQuote }] },
        ],
        unknowns: [],
        source_versions: [{ id: theirs.source_id, version: 1 }, { id: mine.source_id, version: 1 }],
      }),
      "2026-11-03T09:00:00.000Z",
    );
    const forAgent = JSON.stringify(b.context(agent, "inbox"));
    expect(forAgent).not.toContain("PIPIT_CANARY");
    expect(forAgent).not.toContain("GREBE_CANARY");
    expect(forAgent).not.toContain("Cites the owner");
    expect(forAgent).toContain("The owner's own LINNET_CANARY note.");
    const forOwner = b.context(owner, "inbox") as { items: { text: string; epistemic_status: string }[] };
    const status = (needle: string) => forOwner.items.find((i) => i.text.includes(needle))!.epistemic_status;
    expect(status("PIPIT_CANARY")).toBe("agent_unreviewed");
    expect(status("GREBE_CANARY")).toBe("agent_unreviewed");
    expect(status("Cites the owner")).toBe("supported");
    b.markSourceReviewed(owner, theirs.source_id);
    const reviewed = JSON.stringify(b.context(agent, "inbox"));
    expect(reviewed).toContain("PIPIT_CANARY");
    expect(reviewed).toContain("GREBE_CANARY");
    expect((b.context(owner, "inbox") as { items: { epistemic_status: string }[] }).items.map((i) => i.epistemic_status)).not.toContain("agent_unreviewed");
  });

  it("deletes expired owner sessions when a new one is issued", () => {
    const { b, s } = setup();
    s.run("INSERT INTO sessions VALUES('old','x','2026-11-01T00:00:00.000Z')");
    b.issueSession();
    expect(s.all("SELECT token_hash FROM sessions").map((r: any) => r.token_hash)).not.toContain("old");
  });

  it("the page reads the provenance and can mark an agent note reviewed over HTTP", async () => {
    const { b, agent, grant } = setup();
    const a = b.agentNote(agent, note);
    const app = await createApp(b, { pairSecret: "test-code", static: false });
    cleanup.push(() => void app.close());
    const paired = await app.inject({ method: "POST", url: "/api/v1/session/pair", headers: { host: "127.0.0.1:4317" }, payload: { secret: "test-code" } });
    const headers = { host: "127.0.0.1:4317", cookie: paired.headers["set-cookie"]!.toString().split(";")[0], "x-brain-csrf": paired.json().csrf };
    expect((await app.inject({ url: `/api/v1/sources/${a.source_id}`, headers })).json().written_by).toEqual({ agent: "Codex", reviewed: false });
    const marked = await app.inject({ method: "POST", url: `/api/v1/sources/${a.source_id}/reviewed`, headers, payload: {} });
    expect(marked.statusCode).toBe(200);
    expect(marked.json()).toEqual({ source_id: a.source_id, reviewed_at: "2026-11-03T09:00:00.000Z" });
    expect((await app.inject({ url: `/api/v1/sources/${a.source_id}`, headers })).json().written_by).toEqual({ agent: "Codex", reviewed: true });
    const view = (await app.inject({ url: "/api/v1/brain/projects/inbox", headers })).json();
    expect(view.originals[0]).toMatchObject({ written_by: { agent: "Codex", reviewed: true } });
    // An agent cannot review on the owner's behalf: an unknown key is refused, and a real agent token is forbidden.
    expect((await app.inject({ method: "POST", url: `/api/v1/sources/${a.source_id}/reviewed`, headers: { host: "127.0.0.1:4317", authorization: `Bearer ${"f".repeat(64)}` }, payload: {} })).statusCode).toBe(401);
    // Repeating the review changes nothing; a call without the page's CSRF header is refused.
    const again = await app.inject({ method: "POST", url: `/api/v1/sources/${a.source_id}/reviewed`, headers, payload: {} });
    expect(again.json()).toEqual(marked.json());
    const { "x-brain-csrf": _omit, ...noCsrf } = headers;
    expect((await app.inject({ method: "POST", url: `/api/v1/sources/${a.source_id}/reviewed`, headers: noCsrf, payload: {} })).statusCode).toBe(403);
    const asAgent = await app.inject({ method: "POST", url: `/api/v1/sources/${a.source_id}/reviewed`, headers: { host: "127.0.0.1:4317", authorization: `Bearer ${grant.token}` }, payload: {} });
    expect(asAgent.statusCode).toBe(403);
  });

  it("search, Ask and the Today evidence carry the agent label before and after review", async () => {
    const { b, agent } = setup();
    const a = b.agentNote(agent, note);
    const label = { agent: "Codex", reviewed: false };
    const search = await b.searchBrain(owner, { q: "lease recovery" });
    expect(search.originals.find((o) => o.id === a.source_id)).toMatchObject({ written_by: label });
    const asked = await b.ask(owner, { q: "Wire the lease recovery test" });
    expect(asked.hits.find((h) => h.id === a.source_id && h.type === "original")).toMatchObject({ written_by: label });
    const mine = b.capture(owner, { title: "Plain", body: "A plain owner note about lease recovery." }) as { source_id: string };
    expect((await b.searchBrain(owner, { q: "plain owner note" })).originals.find((o) => o.id === mine.source_id)).not.toHaveProperty("written_by");
    const cited = b.brief(owner).items.flatMap((item) => item.evidence).filter((e) => e.source_id === a.source_id);
    expect(cited.length).toBeGreaterThan(0);
    for (const e of cited) expect(e.written_by).toEqual(label);
    b.markSourceReviewed(owner, a.source_id);
    expect((await b.searchBrain(owner, { q: "lease recovery" })).originals.find((o) => o.id === a.source_id)).toMatchObject({ written_by: { agent: "Codex", reviewed: true } });
  });
});
