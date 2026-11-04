// tests/integration/bibrain-contract.test.ts
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { CONTRACT, genericClient, noteOutput, parseNoteInput, parseRecallInput, recallOutput } from "../../apps/cli/contract.mjs";
import { sha256 } from "../../apps/cli/lib.mjs";

const cli = resolve("apps/cli/bibrain.mjs");
const ID = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";
let cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});
function dataDir(api: string) {
  const dir = mkdtempSync(join(tmpdir(), "bibrain-contract-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "agent-keys"));
  writeFileSync(join(dir, "agent-keys", `${ID}.json`), JSON.stringify({ api, key: "f".repeat(64) }));
  return dir;
}
async function fake(handler: Parameters<typeof createServer>[1]) {
  const calls: { url: string; body: any; headers: any }[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      calls.push({ url: req.url!, body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "null"), headers: req.headers });
      handler!(req, res);
    });
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  cleanup.push(() => new Promise<void>((closed) => server.close(() => closed())));
  cleanup.push(() => server.closeAllConnections());
  return { port: (server.address() as { port: number }).port, calls };
}
function run(command: string, args: string[], stdin: string | Buffer | null, dir: string) {
  const started = Date.now();
  return new Promise<{ status: number | null; stdout: string; stderr: string; ms: number }>((done) => {
    const child = spawn(process.execPath, [cli, command, ...args, "--connection", ID, "--data", dir], { stdio: [stdin === null ? "ignore" : "pipe", "pipe", "pipe"], env: { ...process.env, BRAIN_DB: join(dir, "brain.sqlite") } });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (d) => (stdout += d));
    child.stderr!.on("data", (d) => (stderr += d));
    // The command closes its stdin after 200 ms; a large write still in flight then fails with EPIPE on this side, which is expected and must not fail the test.
    child.stdin?.on("error", () => {});
    if (stdin !== null) child.stdin!.end(stdin);
    child.on("close", (status) => done({ status, stdout, stderr, ms: Date.now() - started }));
  });
}
const ok = (body: unknown) => (_req: any, res: any) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

describe("contract helpers", () => {
  it("names the contract, parses only v1 objects with string fields, and prints valid JSON", () => {
    expect(CONTRACT).toBe("bibrain-agent/1");
    expect(parseRecallInput('\uFEFF{"v":1,"prompt":"what colour did we pick","session":"s1","cwd":"C:/x"}\r\n')).toEqual({ prompt: "what colour did we pick", session: "s1" });
    expect(parseRecallInput('{"v":2,"prompt":"x","session":"s"}')).toBeNull();
    expect(parseRecallInput('{"prompt":"x","session":"s"}')).toBeNull();
    expect(parseRecallInput('{"v":1,"prompt":5,"session":"s"}')).toBeNull();
    expect(parseRecallInput('{"v":1,"prompt":"x"}')).toEqual({ prompt: "x", session: "" });
    expect(parseRecallInput("nope")).toBeNull();
    expect(parseNoteInput('{"v":1,"reply":"Decided: a: b","session":"s","continued":true}')).toEqual({ reply: "Decided: a: b", session: "s", continued: true });
    expect(parseNoteInput('{"v":1,"reply":"x"}')).toEqual({ reply: "x", session: "", continued: false });
    expect(parseNoteInput('{"v":1,"session":"s"}')).toBeNull();
    expect(JSON.parse(recallOutput("evidence"))).toEqual({ v: 1, context: "evidence" });
    expect(recallOutput("")).toBe('{"v":1,"context":""}');
    expect(noteOutput()).toBe('{"v":1}');
    expect(genericClient("hermes")).toBe("hermes");
    expect(genericClient("other")).toBe("other");
    expect(genericClient("claude-code")).toBe("other");
    expect(genericClient(undefined)).toBe("other");
    expect(genericClient(true)).toBe("other");
  });
});

describe("bibrain recall", () => {
  it("posts the generic prompt as a push with client other, prints the context JSON, and keeps hashes only", async () => {
    const f = await fake(ok({ level: "full", text: "BiBrain recall: cobalt (fact id1, 2026-10-20, current)", hit_ids: ["id1"], digest: true }));
    const dir = dataDir(`http://127.0.0.1:${f.port}`);
    const r = await run("recall", [], JSON.stringify({ v: 1, prompt: "what colour did we pick for the launch", session: "sess-9", cwd: "C:/proj" }), dir);
    expect(r).toMatchObject({ status: 0, stderr: "" });
    expect(JSON.parse(r.stdout)).toEqual({ v: 1, context: expect.stringContaining("cobalt") });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].url).toBe("/api/v1/agent/recall-push");
    expect(f.calls[0].headers.authorization).toBe(`Bearer ${"f".repeat(64)}`);
    expect(f.calls[0].body).toEqual({ prompt: "what colour did we pick for the launch", session_id: sha256("sess-9"), first_prompt: true, seen: [], client: "other" });
    expect(JSON.stringify(f.calls[0].body)).not.toContain("C:/proj");
    const state = JSON.parse(readFileSync(join(dir, "hook-state", `${ID}.json`), "utf8"));
    expect(state.sessions[sha256("sess-9")]).toMatchObject({ hashes: [sha256("id1")], digested: true });
  });
  it("names the client hermes when asked, never prints the hook envelope, and prints an empty context for level none", async () => {
    const f = await fake(ok({ level: "none", text: "", hit_ids: [], digest: false }));
    const dir = dataDir(`http://127.0.0.1:${f.port}`);
    const r = await run("recall", ["--client", "hermes"], JSON.stringify({ v: 1, prompt: "what colour did we pick for the launch", session: "s" }), dir);
    expect(r).toMatchObject({ status: 0, stdout: '{"v":1,"context":""}', stderr: "" });
    expect(f.calls[0].body.client).toBe("hermes");
    expect(r.stdout).not.toContain("hookSpecificOutput");
  });
  it("prints the empty context and exits 0, making no call, for a short prompt, a command, a secret, a v2 input, a 2 MB prompt and bytes that are not UTF-8", async () => {
    const f = await fake(ok({ level: "full", text: "x", hit_ids: [], digest: false }));
    const dir = dataDir(`http://127.0.0.1:${f.port}`);
    for (const input of [
      JSON.stringify({ v: 1, prompt: "hi", session: "s" }),
      JSON.stringify({ v: 1, prompt: "/compact everything now", session: "s" }),
      JSON.stringify({ v: 1, prompt: "api_key = abcdefghijklmnopqrstu", session: "s" }),
      JSON.stringify({ v: 2, prompt: "what colour did we pick for the launch", session: "s" }),
      Buffer.from([0xff, 0xfe, 0x7b, 0x22]),
    ]) {
      const r = await run("recall", [], input, dir);
      expect(r).toMatchObject({ status: 0, stdout: '{"v":1,"context":""}', stderr: "" });
    }
    // A prompt far beyond the cap: either the 200 ms stdin cap ends the read first (nothing sent) or it arrives whole and is cut to 500 code points. Both end in the same output.
    const big = await run("recall", [], JSON.stringify({ v: 1, prompt: "what colour did we pick " + "x".repeat(2 * 1024 * 1024), session: "s" }), dir);
    expect(big.status).toBe(0);
    expect(JSON.parse(big.stdout).v).toBe(1);
    const sent = f.calls.filter((c) => c.url === "/api/v1/agent/recall-push");
    for (const c of sent) expect(Array.from(c.body.prompt as string).length).toBeLessThanOrEqual(500);
    expect(big.ms).toBeLessThan(4000);
  });
  it("stays silent, prints the empty context and exits 0 within 1,900 ms when the server is down or never answers", async () => {
    const down = dataDir("http://127.0.0.1:1");
    const r1 = await run("recall", [], JSON.stringify({ v: 1, prompt: "what colour did we pick for the launch", session: "s" }), down);
    expect(r1).toMatchObject({ status: 0, stdout: '{"v":1,"context":""}' });
    const f = await fake(() => {});
    const r2 = await run("recall", [], JSON.stringify({ v: 1, prompt: "what colour did we pick for the launch", session: "s" }), dataDir(`http://127.0.0.1:${f.port}`));
    expect(r2).toMatchObject({ status: 0, stdout: '{"v":1,"context":""}' });
    expect(r2.ms).toBeLessThan(1900);
  });
});

describe("bibrain note", () => {
  const saved = ok({ saved: true, source_id: "src", suggestions: 1, open_questions: 0, duplicate: false });
  it("posts only the marker lines with client other, prints {\"v\":1}, and skips a continued turn and a repeat", async () => {
    const f = await fake(saved);
    const dir = dataDir(`http://127.0.0.1:${f.port}`);
    const reply = "Here is the summary nobody should store.\nDecided: lease length: 90 seconds\nNext step: run the recovery test.";
    const r = await run("note", [], JSON.stringify({ v: 1, reply, session: "A" }), dir);
    expect(r).toMatchObject({ status: 0, stdout: '{"v":1}', stderr: "" });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].url).toBe("/api/v1/agent/session-note");
    expect(f.calls[0].body).toEqual({ session_id: sha256("A"), client: "other", text: "Decided: lease length: 90 seconds\nNext step: run the recovery test." });
    expect(JSON.stringify(f.calls[0].body)).not.toContain("nobody should store");
    const again = await run("note", [], JSON.stringify({ v: 1, reply, session: "A" }), dir);
    expect(again.stdout).toBe('{"v":1}');
    expect(f.calls).toHaveLength(1);
    const continued = await run("note", [], JSON.stringify({ v: 1, reply: "Decided: x: y", session: "B", continued: true }), dir);
    expect(continued.stdout).toBe('{"v":1}');
    expect(f.calls).toHaveLength(1);
  });
  it("prints {\"v\":1} and exits 0 with no call for prose, a next step alone, a secret, bad JSON and no stdin", async () => {
    const f = await fake(saved);
    const dir = dataDir(`http://127.0.0.1:${f.port}`);
    for (const input of ["All done.", "Next step: alone", "Decided: key: api_key = abcdefghijklmnopqrstu", "nope"].map((reply) => (reply === "nope" ? "nope" : JSON.stringify({ v: 1, reply, session: "s" })))) {
      const r = await run("note", [], input, dir);
      expect(r).toMatchObject({ status: 0, stdout: '{"v":1}', stderr: "" });
    }
    expect((await run("note", [], null, dir)).stdout).toBe('{"v":1}');
    expect(f.calls).toHaveLength(0);
  });
});
