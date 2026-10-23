import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../../packages/storage/index.ts";
import { Brain } from "../../packages/domain/service.ts";
import { createApp } from "../../apps/server/app.ts";
import type { Principal } from "../../packages/contracts/index.ts";

const owner: Principal = { kind: "owner" };
const agent = { kind: "agent", grant_id: "nope" } as Principal;
const DECISION = "We decided that Northstar beta is invite only.";
const QUESTION_NOTE = "Launch notes\nOpen question: who writes the launch post?";
let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.reverse()) fn();
  cleanup = [];
});
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "brain-project-test-"));
  const s = new Storage(join(dir, "brain.sqlite"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  cleanup.push(() => {
    try {
      s.close();
    } catch {}
  });
  let date = new Date("2026-10-23T09:00:00Z");
  const b = new Brain(s, () => date);
  return { b, advance: (ms: number) => { date = new Date(date.getTime() + ms); } };
}
function keepFirst(b: Brain) {
  const [item] = b.brief(owner).items;
  b.reviewGate(owner, item.target.id, { action: "accept", expected_version: item.target.version });
  return b.currentClaims(owner, "inbox")[0];
}

describe("Brain.brainProject", () => {
  it("shows kept facts with evidence, open questions and originals newest first", () => {
    const { b, advance } = setup();
    b.capture(owner, { title: "Decision", body: DECISION });
    const claim = keepFirst(b);
    advance(60_000);
    b.capture(owner, { title: "Launch notes", body: QUESTION_NOTE });
    const view = b.brainProject(owner, "inbox");
    expect(view.project).toMatchObject({ id: "inbox" });
    expect(view.facts).toHaveLength(1);
    expect(view.facts[0]).toMatchObject({ id: claim.id, version: 1, editable: true, stale: false });
    expect(view.facts[0].text).toContain("invite only");
    expect(view.facts[0].evidence[0]).toMatchObject({ source_title: "Decision" });
    expect(view.facts[0].evidence[0].quote).toContain("invite only");
    expect(view.questions.map((q) => q.text)).toEqual(["who writes the launch post?"]);
    expect(view.originals.map((o) => o.title)).toEqual(["Launch notes", "Decision"]);
    expect(view.originals[0].from).toBe("you");
    expect(view.waiting_for_review).toBe(0);
    expect(view.needs_decision).toEqual([]);
  });

  it("marks a fact not checked after 21 days until the owner confirms it", () => {
    const { b, advance } = setup();
    b.capture(owner, { title: "Decision", body: DECISION });
    const claim = keepFirst(b);
    advance(22 * 86_400_000);
    expect(b.brainProject(owner, "inbox").facts[0].stale).toBe(true);
    b.confirmClaim(owner, claim.id);
    expect(b.brainProject(owner, "inbox").facts[0].stale).toBe(false);
  });

  it("drops the facts and questions of a withdrawn original", () => {
    const { b } = setup();
    const saved = b.capture(owner, { title: "Decision", body: DECISION + "\nOpen question: who signs off?" }) as any;
    keepFirst(b);
    expect(b.brainProject(owner, "inbox").questions).toHaveLength(1);
    b.removeSource(owner, saved.source_id, 1, false);
    const view = b.brainProject(owner, "inbox");
    expect(view.facts).toEqual([]);
    expect(view.questions).toEqual([]);
    expect(view.originals).toEqual([]);
  });

  it("counts suggestions for this project only, and lists what only Your brain can decide", () => {
    const { b } = setup();
    b.capture(owner, { title: "Decision", body: DECISION });
    const other = b.createProject(owner, "Hydra");
    expect(b.brainProject(owner, "inbox").waiting_for_review).toBe(1);
    expect(b.brainProject(owner, other.id).waiting_for_review).toBe(0);
    b.propose(owner, { project_id: other.id, title: "Raw note", text: "Something an agent wrote down." });
    const view = b.brainProject(owner, other.id);
    expect(view.needs_decision).toHaveLength(1);
    expect(view.needs_decision[0].data.field).toBeUndefined();
  });

  it("refuses other principals and unknown projects", () => {
    const { b } = setup();
    expect(() => b.brainProject(agent, "inbox")).toThrow();
    expect(() => b.brainProject(owner, "missing-project")).toThrow(/unavailable/i);
  });
});

describe("Brain.answerQuestion", () => {
  it("hides a question until it is brought back, for the owner only", () => {
    const { b } = setup();
    b.capture(owner, { title: "Launch notes", body: QUESTION_NOTE });
    const [q] = b.brainProject(owner, "inbox").questions;
    expect(b.answerQuestion(owner, { project_id: "inbox", signature: q.signature, answered: true })).toEqual({
      signature: q.signature,
      answered: true,
    });
    expect(b.brainProject(owner, "inbox").questions).toEqual([]);
    b.answerQuestion(owner, { project_id: "inbox", signature: q.signature, answered: false });
    expect(b.brainProject(owner, "inbox").questions).toHaveLength(1);
    expect(() => b.answerQuestion(agent, { project_id: "inbox", signature: q.signature, answered: true })).toThrow();
    expect(() => b.answerQuestion(owner, { project_id: "inbox", signature: "", answered: true })).toThrow();
    expect(() => b.answerQuestion(owner, { project_id: "nope", signature: q.signature, answered: true })).toThrow();
  });
});

describe("Your brain routes", () => {
  it("serve the project view and answers to the paired owner only", async () => {
    const { b } = setup();
    const app = await createApp(b, { pairSecret: "test-code", static: false });
    cleanup.push(() => void app.close());
    const req = (method: any, url: string, payload?: any, headers: Record<string, string> = {}) =>
      app.inject({ method, url, headers: { host: "127.0.0.1:4317", ...headers }, payload });
    expect((await req("GET", "/api/v1/brain/projects/inbox")).statusCode).toBe(401);
    const pairing = await req("POST", "/api/v1/session/pair", { secret: "test-code" });
    const cookie = pairing.cookies[0];
    const headers = { cookie: `${cookie.name}=${cookie.value}`, "x-brain-csrf": pairing.json().csrf };
    await req("POST", "/api/v1/sources", { title: "Launch notes", body: QUESTION_NOTE }, headers);
    const view = await req("GET", "/api/v1/brain/projects/inbox", undefined, headers);
    expect(view.statusCode).toBe(200);
    const [q] = view.json().questions;
    const extra = await req(
      "POST",
      "/api/v1/questions/answer",
      { project_id: "inbox", signature: q.signature, answered: true, extra: 1 },
      headers,
    );
    expect(extra.statusCode).toBe(400);
    const ok = await req("POST", "/api/v1/questions/answer", { project_id: "inbox", signature: q.signature, answered: true }, headers);
    expect(ok.statusCode).toBe(200);
    expect((await req("GET", "/api/v1/brain/projects/inbox", undefined, headers)).json().questions).toEqual([]);
    expect((await req("GET", "/api/v1/brain/projects/nope", undefined, headers)).statusCode).toBe(404);
  });
});
