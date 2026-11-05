import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { ACK_PROMPTS, CONTINUATION_PROMPTS, DECISION_WORDS, RECALL_SESSION_TOPICS, SESSION_TOPICS_MAX, SESSION_TOPIC_TTL_MS, normalizePrompt, promptIntent, rememberTopic, topicFor, topicKey, type SessionTopics } from "../../packages/domain/recall-intent.ts";
import { hashId } from "../../packages/domain/recall-push.ts";
import { CONTINUATION_PROMPTS as CLI_CONTINUATION, hookSkipReason, isContinuationPrompt, normalizePrompt as cliNormalize } from "../../apps/cli/lib.mjs";
import { Storage } from "../../packages/storage/index.ts";
import { Brain } from "../../packages/domain/service.ts";
import { buildFixture, owner } from "../eval/recall-fixture.ts";

let cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

describe("prompt intent", () => {
  it("sorts acknowledgements, continuations, decision questions and everything else", () => {
    for (const p of ["thanks", "Thanks!", "ok", "OK.", "yes", "lgtm", "got it", "sounds good", "  thank you  "]) expect(promptIntent(p).kind, p).toBe("ack");
    // Every entry of the closed list, as typed and capitalised with a full stop.
    // A literal copy on purpose: removing a word from ACK_PROMPTS must fail here, not silently shrink the loop.
    const expectedAcks = ["thanks", "thank you", "ok", "okay", "yes", "no", "sure", "great", "nice", "cool", "done", "lgtm", "good", "fine", "yep", "nope", "got it", "k", "ty", "thx", "perfect", "sounds good"];
    expect([...ACK_PROMPTS].sort()).toEqual([...expectedAcks].sort());
    for (const a of expectedAcks) for (const p of [a, `${a[0].toUpperCase()}${a.slice(1)}.`]) expect(promptIntent(p).kind, p).toBe("ack");
    for (const p of ["continue", "Continue.", "go on", "OK, continue", "please continue", "keep going…", "where were we?", "what did we decide", "what did we decide on", "What did we decide?", "what did we pick", "recap", "and then"]) expect(promptIntent(p), p).toEqual({ kind: "continuation", topicTerms: [] });
    expect(promptIntent("what did we pick for the caterer")).toEqual({ kind: "decision", topicTerms: ["caterer"] });
    expect(promptIntent("what color did we pick for the launch")).toEqual({ kind: "decision", topicTerms: ["color", "launch"] });
    expect(promptIntent("What color did we settle on for the launch?")).toEqual({ kind: "decision", topicTerms: ["color", "launch"] });
    expect(promptIntent("did we choose a price")).toEqual({ kind: "decision", topicTerms: ["price"] });
    expect(promptIntent("what did we go with for auth?")).toEqual({ kind: "decision", topicTerms: ["auth"] });
    expect(promptIntent("What color did we settle on for the launch?")).toEqual({ kind: "decision", topicTerms: ["color", "launch"] });
    // Participles: the common past forms are decision questions too.
    expect(promptIntent("have we decided on a caterer")).toEqual({ kind: "decision", topicTerms: ["caterer"] });
    expect(promptIntent("were we agreed on the beta date")).toEqual({ kind: "decision", topicTerms: ["beta", "date"] });
    expect(promptIntent("what have we decided about the launch")).toEqual({ kind: "decision", topicTerms: ["launch"] });
    expect(promptIntent("had we already settled the caterer")).toEqual({ kind: "decision", topicTerms: ["caterer"] });
    expect(promptIntent("what have we decided")).toEqual({ kind: "continuation", topicTerms: [] });
    // "I" and "us" are first-person subjects too; filler such as "yet" is never a topic word.
    expect(promptIntent("what did I decide about the caterer")).toEqual({ kind: "decision", topicTerms: ["caterer"] });
    expect(promptIntent("have I picked a venue")).toEqual({ kind: "decision", topicTerms: ["venue"] });
    expect(promptIntent("what did the two of us agree on the launch")).toEqual({ kind: "decision", topicTerms: ["launch"] });
    expect(promptIntent("did we decide yet")).toEqual({ kind: "continuation", topicTerms: [] });
    // The gap between subject and verb is at most two words, on both sides of the boundary.
    expect(promptIntent("did we finally actually decide on the venue")).toEqual({ kind: "decision", topicTerms: ["venue"] });
    expect(promptIntent("did we ever really pick the venue")).toEqual({ kind: "decision", topicTerms: ["ever", "really", "venue"] });
    expect(promptIntent("did we break it and then decide to revert").kind).toBe("plain");
    expect(promptIntent("did we break the build then pick a fix").kind).toBe("plain");
    // Zero false positives on ordinary prompts: present-tense how-tos, "you"/"I", phrasal "pick up", noun phrases, and everything generic.
    for (const p of [
      "which hue was chosen for the release", "how did Northstar status change", "should we pick React", "write a function that picks the best route",
      "how do I reverse a linked list in Python", "What does the git rebase --onto flag do?", "what is the zephyr cadence we settled on", "Thanks a lot for that!", "launch color",
      "how do I decide between a list and a set", "do you pick the first element when the list is sorted", "Did you choose the right sorting algorithm for this function?",
      "did we pick up the dry cleaning", "did we pick out a venue yet", "the decision on pricing is pending, draft an email", "do we agree on the api shape",
      "can we decide this later", "will we choose a vendor next week", "we decided to use React, now add the router", "I picked the second option, continue the refactor",
      "did the team agree the schema", "was it decided", "what was the weather like when we picked the venue", "what was picked up by the linter",
      // Passives with no first-person subject (ruling I-1: plain, so they fall back to ordinary recall).
      "What was decided?", "what was decided about Marco", "what has been decided on pricing", "what is chosen by default",
      // The reviewer's seven false positives.
      "what was chosen as the default port in the config", "what was decided by the compiler here", "what were chosen as test fixtures", "what was settled in court",
      "did we pick it up again", "did we pick the accent up", "did we settle the invoice with the vendor",
      // Phrasal verbs, split or not: up, out, off, apart, down.
      "did we pick it up in the plan", "did we pick off the low hanging fruit", "did we pick it apart", "did we pick the plan apart", "did we pick them both off",
      "did we settle down", "have we picked out a venue", "had we already picked it up", "did we pick them out yet",
      // Other everyday shapes from the review probe.
      "fix the failing test", "decide later", "did we break the build", "did we go without the cache", "did we settle the vendor", "what was settled with the vendor",
      "what was chosen as the design", "what was decided by the party", "was I picked for the team", "what is decided at runtime", "what has been picked as the default",
    ])
      expect(promptIntent(p).kind, p).toBe("plain");
    expect(normalizePrompt("  OK, Continue!!  ")).toBe("continue");
    for (const w of ["decide", "picked", "chosen", "agreed"]) expect(DECISION_WORDS.has(w)).toBe(true);
    expect(ACK_PROMPTS.some((a) => CONTINUATION_PROMPTS.includes(a))).toBe(false);
  });
  it("keeps the CLI's copy of the continuation list and its normalisation equal to the domain's", () => {
    expect(CLI_CONTINUATION).toEqual(CONTINUATION_PROMPTS);
    for (const p of ["  OK, Continue!!  ", "please go on.", "What did we decide?", "thanks"]) expect(cliNormalize(p)).toBe(normalizePrompt(p));
    for (const p of CONTINUATION_PROMPTS) expect(isContinuationPrompt(p), p).toBe(true);
    for (const p of ["continue", "next", "go on", "recap"]) expect(hookSkipReason(p), p).toBeNull();
    for (const p of ["thanks", "ok", "yes", "short", "hi there", "/continue"]) expect(hookSkipReason(p), p).toBe("short");
    for (const a of ACK_PROMPTS) expect(hookSkipReason(a), a).toBe("short");
    expect(hookSkipReason("/continue with the migration")).toBe("command");
  });
  it("keeps at most 20 live entries, 12 words each, for two hours, keyed by grant and session, and never answers for another key", () => {
    const now = new Date("2026-10-25T09:00:00.000Z");
    const G = "11111111-0000-4000-8000-000000000099";
    const k = (session: string, grant = G) => topicKey(grant, session);
    expect(k("a".repeat(64))).toBe(`${G}:${"a".repeat(64)}`);
    let topics: SessionTopics = {};
    for (let i = 0; i < 25; i++) topics = rememberTopic(topics, k(String(i).padStart(64, "0")), ["beta", "open"], new Date(now.getTime() + i * 1000));
    expect(Object.keys(topics)).toHaveLength(SESSION_TOPICS_MAX);
    expect(topicFor(topics, k("0".repeat(64)), now)).toBeNull();
    expect(topicFor(topics, k("24".padStart(64, "0")), now)).toEqual(["beta", "open"]);
    const many = rememberTopic({}, k("a".repeat(64)), Array.from({ length: 20 }, (_, i) => `w${i}`), now);
    expect(topicFor(many, k("a".repeat(64)), now)).toHaveLength(12);
    expect(topicFor(many, k("b".repeat(64)), now)).toBeNull();
    // The same session hash under another grant is another key.
    expect(topicFor(many, k("a".repeat(64), "22222222-0000-4000-8000-000000000099"), now)).toBeNull();
    expect(topicFor(many, k("a".repeat(64)), new Date(now.getTime() + SESSION_TOPIC_TTL_MS - 1))).toEqual(topicFor(many, k("a".repeat(64)), now));
    expect(topicFor(many, k("a".repeat(64)), new Date(now.getTime() + SESSION_TOPIC_TTL_MS))).toBeNull();
    expect(Object.keys(rememberTopic(many, k("c".repeat(64)), ["x"], new Date(now.getTime() + SESSION_TOPIC_TTL_MS)))).toEqual([k("c".repeat(64))]);
    expect(topicFor({ [k("d".repeat(64))]: { terms: "nope" as unknown as string[], at: now.toISOString() } }, k("d".repeat(64)), now)).toBeNull();
  });
});

describe("the push with intent", () => {
  function fixture(clock: () => Date) {
    const dir = mkdtempSync(join(tmpdir(), "recall-intent-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const fx = buildFixture(join(dir, "brain.sqlite"));
    cleanup.push(() => fx.store.close());
    const brain = new Brain(fx.store, clock);
    return { fx, brain, agent: brain.authenticateAgent(fx.agentToken) };
  }
  const row = (brain: Brain) => brain.recallLog(owner).rows.at(-1)!;
  it("remembers the topic of a push that found something, reads it for a continuation in the same session only, and forgets it after two hours", async () => {
    let at = new Date("2026-10-25T09:00:00.000Z");
    const { fx, brain, agent } = fixture(() => at);
    const s1 = "1".repeat(64);
    const first = await brain.recallPush(agent, { prompt: "when does the beta open", session_id: s1, first_prompt: true, seen: [] });
    expect(first.level).toBe("full");
    expect(row(brain)).not.toHaveProperty("intent");
    expect(fx.store.setting<SessionTopics>(RECALL_SESSION_TOPICS, {})[topicKey((agent as { grant_id: string }).grant_id, s1)]?.terms).toEqual(["beta", "open"]);
    const again = await brain.recallPush(agent, { prompt: "continue", session_id: s1, first_prompt: false, seen: first.hit_ids.map(hashId) });
    expect(again.level).not.toBe("full");
    expect(row(brain)).toMatchObject({ intent: "continuation", topic: "session" });
    const other = await brain.recallPush(agent, { prompt: "continue", session_id: "2".repeat(64), first_prompt: false, seen: [] });
    expect(other).toEqual({ level: "none", text: "", hit_ids: [], digest: false });
    expect(row(brain)).toMatchObject({ intent: "continuation", topic: "none", candidates: 0 });
    // Another connection sending the same session hash never reads this connection's topic.
    const second = brain.createGrant(owner, { projects: [fx.ids["project:northstar"]], operations: ["read"], expires_at: "2027-01-01T00:00:00.000Z", client: "codex" });
    const stranger = await brain.recallPush(brain.authenticateAgent(second.token), { prompt: "continue", session_id: s1, first_prompt: false, seen: [] });
    expect(stranger).toEqual({ level: "none", text: "", hit_ids: [], digest: false });
    at = new Date(at.getTime() + SESSION_TOPIC_TTL_MS);
    const late = await brain.recallPush(agent, { prompt: "continue", session_id: s1, first_prompt: false, seen: [] });
    expect(late.level).toBe("none");
    expect(row(brain)).toMatchObject({ intent: "continuation", topic: "none" });
    // A generic prompt stores no topic, and an acknowledgement never searches.
    await brain.recallPush(agent, { prompt: "how do I reverse a linked list in Python", session_id: "3".repeat(64), first_prompt: true, seen: [] });
    expect(fx.store.setting<SessionTopics>(RECALL_SESSION_TOPICS, {})[topicKey((agent as { grant_id: string }).grant_id, "3".repeat(64))]).toBeUndefined();
    expect(await brain.recallPush(agent, { prompt: "thanks", session_id: s1, first_prompt: false, seen: [] })).toEqual({ level: "none", text: "", hit_ids: [], digest: false });
    expect(row(brain)).toMatchObject({ intent: "ack", candidates: 0 });
  });
  it("never lets a continuation refresh or overwrite its own session topic", async () => {
    let at = new Date("2026-10-25T09:00:00.000Z");
    const { fx, brain, agent } = fixture(() => at);
    const s = "9".repeat(64);
    const key = topicKey((agent as { grant_id: string }).grant_id, s);
    const stored = () => fx.store.setting<SessionTopics>(RECALL_SESSION_TOPICS, {})[key];
    await brain.recallPush(agent, { prompt: "when does the beta open", session_id: s, first_prompt: true, seen: [] });
    const before = stored();
    expect(before?.terms).toEqual(["beta", "open"]);
    for (let i = 0; i < 3; i++) {
      at = new Date(at.getTime() + 30 * 60_000);
      await brain.recallPush(agent, { prompt: "continue", session_id: s, first_prompt: false, seen: [] });
      expect(row(brain)).toMatchObject({ intent: "continuation", topic: "session" });
      expect(stored()).toEqual(before);
    }
    // Repeated "continue" never extends the topic's two hours.
    at = new Date(Date.parse(before!.at) + SESSION_TOPIC_TTL_MS);
    await brain.recallPush(agent, { prompt: "continue", session_id: s, first_prompt: false, seen: [] });
    expect(row(brain)).toMatchObject({ intent: "continuation", topic: "none" });
  });
  it("never pushes for any acknowledgement in the closed list", async () => {
    const { brain, agent } = fixture(() => new Date("2026-10-25T09:00:00.000Z"));
    for (const a of ACK_PROMPTS) {
      expect(await brain.recallPush(agent, { prompt: a, session_id: "a".repeat(64), first_prompt: true, seen: [] }), a).toEqual({ level: "none", text: "", hit_ids: [], digest: false });
      expect(row(brain), a).toMatchObject({ intent: "ack", candidates: 0, hits: 0 });
    }
  });
  it("holds the decision reading to the evidence rule: one incidental shared word is never full", async () => {
    const { brain, agent } = fixture(() => new Date("2026-10-25T09:00:00.000Z"));
    for (const prompt of ["did we pick it up in the plan", "what was chosen as the design", "what was decided by the party", "did we pick the accent up", "did we settle the vendor", "what was settled with the vendor"]) {
      const r = await brain.recallPush(agent, { prompt, session_id: "b".repeat(64), first_prompt: false, seen: [] });
      expect(r.level, prompt).not.toBe("full");
    }
    // A real decision question whose one topic word is incidental (in a fact's text, not its name): the topic reading is a pointer, never full.
    for (const prompt of ["have we decided the design", "did we decide on the vendor"]) {
      const r = await brain.recallPush(agent, { prompt, session_id: "c".repeat(64), first_prompt: false, seen: [] });
      expect(r.level, prompt).toBe("pointer");
      expect(r.hit_ids, prompt).toEqual([]);
    }
    // One topic word that names the fact's entity is evidence, exactly as the one-word prompt "caterer" or "accent" is.
    expect((await brain.recallPush(agent, { prompt: "did we choose the accent", session_id: "d".repeat(64), first_prompt: false, seen: [] })).level).toBe("full");
  });
  it("opens a session that starts with a continuation on the digest, as a pointer, and on nothing for an empty brain", async () => {
    const { brain, agent } = fixture(() => new Date("2026-10-25T09:00:00.000Z"));
    const r = await brain.recallPush(agent, { prompt: "continue", session_id: "4".repeat(64), first_prompt: true, seen: [] });
    expect(r.level).toBe("pointer");
    expect(r.digest).toBe(true);
    expect(r.text).toContain("The owner's brain (bibrain) covers Northstar");
    expect(r.hit_ids).toEqual([]);
    expect(row(brain)).toMatchObject({ intent: "continuation", topic: "digest", hits: 0 });
    const dir = mkdtempSync(join(tmpdir(), "recall-intent-empty-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const store = new Storage(join(dir, "brain.sqlite"));
    cleanup.push(() => store.close());
    const empty = new Brain(store);
    const grant = empty.createGrant(owner, { projects: ["inbox"], operations: ["read"], expires_at: "2027-01-01T00:00:00.000Z" });
    const e = await empty.recallPush(empty.authenticateAgent(grant.token), { prompt: "continue", session_id: "5".repeat(64), first_prompt: true, seen: [] });
    expect(e).toEqual({ level: "none", text: "", hit_ids: [], digest: false });
  });
  it("reads a decision question without its decision words when that is louder, and never quieter", async () => {
    const { fx, brain, agent } = fixture(() => new Date("2026-10-25T09:00:00.000Z"));
    const r = await brain.recallPush(agent, { prompt: "what did we pick for the caterer", session_id: "6".repeat(64), first_prompt: false, seen: [] });
    expect(r.level).toBe("full");
    expect(r.hit_ids[0]).toBe(fx.ids["fact:caterer"]);
    expect(row(brain)).toMatchObject({ intent: "decision" });
    expect(fx.store.setting<SessionTopics>(RECALL_SESSION_TOPICS, {})[topicKey((agent as { grant_id: string }).grant_id, "6".repeat(64))]?.terms).toEqual(["caterer"]);
    const same = await brain.recallPush(agent, { prompt: "what color did we pick for the launch", session_id: "7".repeat(64), first_prompt: false, seen: [] });
    expect(same.level).toBe("full");
    expect(row(brain)).not.toHaveProperty("intent");
    const nothing = await brain.recallPush(agent, { prompt: "what did we decide for auth", session_id: "8".repeat(64), first_prompt: false, seen: [] });
    expect(nothing).toEqual({ level: "none", text: "", hit_ids: [], digest: false });
    expect(row(brain)).not.toHaveProperty("intent");
  });
});

describe("the hook sends a continuation phrase", () => {
  const cli = resolve("apps/cli/bibrain.mjs");
  const ID = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";
  function dataDir(api: string) {
    const dir = mkdtempSync(join(tmpdir(), "bibrain-continue-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, "agent-keys"));
    writeFileSync(join(dir, "agent-keys", `${ID}.json`), JSON.stringify({ api, key: "f".repeat(64) }));
    return dir;
  }
  async function fake() {
    const bodies: any[] = [];
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ level: "pointer", text: "The owner's brain (bibrain) has notes on Northstar that may bear on this; brain_recall searches it.", hit_ids: [], digest: true }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    cleanup.push(() => new Promise<void>((r) => server.close(() => r())));
    return { port: (server.address() as { port: number }).port, bodies };
  }
  function run(prompt: string, dir: string) {
    return new Promise<{ status: number | null; stdout: string }>((resolveRun) => {
      const child = spawn(process.execPath, [cli, "hook", "claude-code", "--connection", ID, "--data", dir], { windowsHide: true });
      let stdout = "";
      child.stdout.on("data", (c) => (stdout += c));
      child.on("close", (status) => resolveRun({ status, stdout }));
      child.stdin.end(JSON.stringify({ prompt, session_id: "S" }));
    });
  }
  it("calls BiBrain for 'continue' and still skips 'thanks'", async () => {
    const f = await fake();
    const dir = dataDir(`http://127.0.0.1:${f.port}`);
    const r = await run("continue", dir);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toContain("brain_recall searches it");
    expect(f.bodies).toHaveLength(1);
    expect(f.bodies[0].prompt).toBe("continue");
    expect(await run("thanks", dir)).toMatchObject({ status: 0, stdout: "" });
    expect(f.bodies).toHaveLength(1);
  }, 20_000);
});
