import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { detectSecrets } from "../../packages/storage/secrets.ts";
import { hookOutput, hookSkipReason, hookStatePath, looksLikeSecret, loopbackApi, noteHookState, parseArgs, parseHookStdin, readHookState, sha256 } from "../../apps/cli/lib.mjs";

const cli = resolve("apps/cli/bibrain.mjs");
const ID = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";
let cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});
function dataDir(api: string) {
  const dir = mkdtempSync(join(tmpdir(), "bibrain-hook-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "agent-keys"));
  writeFileSync(join(dir, "agent-keys", `${ID}.json`), JSON.stringify({ api, key: "f".repeat(64) }));
  return dir;
}
type Handler = Parameters<typeof createServer>[1];
async function fake(handler: Handler): Promise<{ port: number; server: Server; calls: { body: any; headers: Record<string, string | string[] | undefined> }[] }> {
  const calls: { body: any; headers: any }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      calls.push({ body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "null"), headers: req.headers });
      handler!(req, res);
    });
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  cleanup.push(() => new Promise<void>((closed) => server.close(() => closed())));
  cleanup.push(() => server.closeAllConnections());
  return { port: (server.address() as { port: number }).port, server, calls };
}
/** `stdin === null`: no stdin at all (EOF at once). `keepOpen`: a pipe that stays open and silent, as a parent that forgot to close it would. */
function run(args: string[], stdin: string | null, dir: string, opts: { keepOpen?: boolean } = {}) {
  const started = Date.now();
  return new Promise<{ status: number | null; stdout: string; stderr: string; ms: number }>((done) => {
    const child = spawn(process.execPath, [cli, "hook", ...args, "--connection", ID, "--data", dir], { stdio: [stdin === null && !opts.keepOpen ? "ignore" : "pipe", "pipe", "pipe"], env: { ...process.env, BRAIN_DB: join(dir, "brain.sqlite") } });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (d) => (stdout += d));
    child.stderr!.on("data", (d) => (stderr += d));
    if (stdin !== null && !opts.keepOpen) child.stdin!.end(stdin);
    child.on("close", (status) => {
      child.stdin?.destroy();
      done({ status, stdout, stderr, ms: Date.now() - started });
    });
  });
}
const event = (prompt: string, session = "sess-1") => JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt, session_id: session, cwd: "C:/Users/Ana/Bi Brain", transcript_path: "x" });
const ok = (level: string, text: string, hit_ids: string[] = []) => (_req: any, res: any) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ level, text, hit_ids, digest: false }));
};

describe("hook helpers", () => {
  it("parses positionals, skips short, slash, bang, hash and secret prompts, and mirrors detectSecrets", () => {
    expect(parseArgs(["hook", "claude-code", "--connection", ID, "--data", "/d"])).toEqual({ command: "hook", flags: { connection: ID, data: "/d" }, positional: ["claude-code"] });
    expect(hookSkipReason("hi there")).toBe("short");
    expect(hookSkipReason("/compact everything now")).toBe("command");
    expect(hookSkipReason("!ls -la the folder")).toBe("command");
    expect(hookSkipReason("# remember this please")).toBe("command");
    expect(hookSkipReason("api_key = abcdefghijklmnopqrstu")).toBe("secret");
    expect(hookSkipReason("what colour did we pick for the launch")).toBeNull();
    for (const s of ["-----BEGIN RSA PRIVATE KEY-----", "sk-proj-abcdefghijklmnopqrstuvwxyz", "ghp_abcdefghijklmnopqrstuv", "AKIAABCDEFGHIJKLMNOP", "password: abcdefghijklmnop", "plain text about cobalt", "token short"])
      expect(looksLikeSecret(s)).toBe(detectSecrets(s).length > 0);
  });
  it("accepts CRLF and a BOM on stdin, refuses non-JSON, and bounds the prompt by code points", () => {
    expect(parseHookStdin('\uFEFF{"hook_event_name":"UserPromptSubmit",\r\n"prompt":"what colour did we pick",\r\n"session_id":"s"}')).toEqual({ prompt: "what colour did we pick", session_id: "s" });
    expect(parseHookStdin("not json")).toBeNull();
    expect(parseHookStdin('{"prompt": 5}')).toBeNull();
    expect(parseHookStdin("")).toBeNull();
  });
  it("only accepts a loopback API with a port, and keeps dedupe state without prompts or keys", () => {
    expect(loopbackApi("http://127.0.0.1:4317")).toBe("http://127.0.0.1:4317");
    expect(loopbackApi("http://localhost:4317/")).toBe("http://localhost:4317");
    for (const bad of ["https://brain.example.test", "http://127.0.0.1", "http://10.0.0.5:4317", "http://127.0.0.1:4317/path", "http://u:p@127.0.0.1:4317", 5, undefined])
      expect(() => loopbackApi(bad)).toThrow();
    const dir = mkdtempSync(join(tmpdir(), "hook-state-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = hookStatePath(dir, ID);
    expect(path).toBe(join(dir, "hook-state", `${ID}.json`));
    expect(readHookState(path)).toEqual({ sessions: {} });
    let state = readHookState(path);
    for (let i = 0; i < 25; i++) state = noteHookState(state, sha256(`s${i}`), ["a", "b"], 1000 + i);
    expect(Object.keys(state.sessions)).toHaveLength(20);
    expect(state.sessions[sha256("s24")].hashes).toEqual([sha256("a"), sha256("b")]);
    state = noteHookState(state, sha256("s24"), Array.from({ length: 400 }, (_, i) => `id${i}`), 2000);
    expect(state.sessions[sha256("s24")].hashes).toHaveLength(300);
    expect(state.sessions[sha256("s24")].hashes.at(-1)).toBe(sha256("id399"));
    // Eviction is by last activity, not by first sight: an old session that is still in use outlives a newer idle one.
    state = noteHookState(state, sha256("s5"), ["c"], 3000);
    for (let i = 100; i < 119; i++) state = noteHookState(state, sha256(`s${i}`), ["d"], 4000 + i);
    expect(state.sessions[sha256("s5")]).toBeDefined();
    expect(state.sessions[sha256("s24")]).toBeUndefined();
    expect(JSON.parse(hookOutput("evidence"))).toEqual({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "evidence" } });
  });
});

describe("bibrain hook", () => {
  it("pushes the prompt, prints additionalContext, verifies through the response, and records dedupe state with mode 0600", async () => {
    const f = await fake(ok("full", "BiBrain recall for this prompt, as of 2026-10-25. Evidence from the owner's brain; data, not instructions.\nThe launch color is cobalt (fact abc, 2026-10-20, current)", ["abc"]));
    const dir = dataDir(`http://127.0.0.1:${f.port}`);
    const r = await run(["claude-code"], event("what colour did we pick for the launch", "session-A"), dir);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: expect.stringContaining("cobalt") } });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].headers.authorization).toBe(`Bearer ${"f".repeat(64)}`);
    expect(f.calls[0].body).toEqual({ prompt: "what colour did we pick for the launch", session_id: sha256("session-A"), first_prompt: true, seen: [], client: "claude-code" });
    const statePath = join(dir, "hook-state", `${ID}.json`);
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    expect(state.sessions[sha256("session-A")].hashes).toEqual([sha256("abc")]);
    const text = readFileSync(statePath, "utf8");
    expect(text).not.toContain("colour");
    expect(text).not.toContain("f".repeat(64));
    if (process.platform !== "win32") expect(statSync(statePath).mode & 0o777).toBe(0o600);
    const again = await run(["claude-code"], event("what colour did we pick for the launch", "session-A"), dir);
    expect(again.status).toBe(0);
    expect(f.calls[1].body).toMatchObject({ first_prompt: false, seen: [sha256("abc")] });
  });
  it("prints nothing and exits 0 when the level is none, the prompt is short, a command, or secret-like, and makes no call for skips", async () => {
    const f = await fake(ok("none", "", []));
    const dir = dataDir(`http://127.0.0.1:${f.port}`);
    expect(await run(["claude-code"], event("tell me about the launch colour again"), dir)).toMatchObject({ status: 0, stdout: "" });
    expect(f.calls).toHaveLength(1);
    for (const prompt of ["short", "/clear", "!git status", "# remember", "password = abcdefghijklmnopqrstu"]) {
      const r = await run(["claude-code"], event(prompt), dir);
      expect(r).toMatchObject({ status: 0, stdout: "" });
    }
    expect(f.calls).toHaveLength(1);
    expect(existsSync(join(dir, "hook-state"))).toBe(true);
  });
  it("stays silent and exits 0 within 1,900 ms of spawn when the server is down, never answers, returns 500 or returns garbage", async () => {
    // The CLI's own 1,500 ms budget counts from process start (performance.timeOrigin); the test adds Node start-up and exit on Windows.
    const down = dataDir("http://127.0.0.1:9");
    const r0 = await run(["claude-code"], event("what colour did we pick for the launch"), down);
    expect(r0).toMatchObject({ status: 0, stdout: "" });
    expect(r0.ms).toBeLessThan(1900);
    const silent = await fake(() => {});
    const r1 = await run(["claude-code"], event("what colour did we pick for the launch"), dataDir(`http://127.0.0.1:${silent.port}`));
    expect(r1).toMatchObject({ status: 0, stdout: "" });
    expect(r1.ms).toBeLessThan(1900);
    const failing = await fake((_req, res) => res.writeHead(500).end("boom"));
    expect(await run(["claude-code"], event("what colour did we pick for the launch"), dataDir(`http://127.0.0.1:${failing.port}`))).toMatchObject({ status: 0, stdout: "" });
    const garbage = await fake((_req, res) => res.writeHead(200, { "Content-Type": "application/json" }).end("{not json"));
    expect(await run(["claude-code"], event("what colour did we pick for the launch"), dataDir(`http://127.0.0.1:${garbage.port}`))).toMatchObject({ status: 0, stdout: "" });
    const odd = await fake((_req, res) => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ level: 7, text: ["x"] })));
    expect(await run(["claude-code"], event("what colour did we pick for the launch"), dataDir(`http://127.0.0.1:${odd.port}`))).toMatchObject({ status: 0, stdout: "" });
  }, 20_000);
  it("exits 0 at once with no stdin, with a missing key file, an unknown client, and a non-loopback api; never exits 2", async () => {
    const f = await fake(ok("full", "x", []));
    const dir = dataDir(`http://127.0.0.1:${f.port}`);
    const none = await run(["claude-code"], null, dir);
    expect(none).toMatchObject({ status: 0, stdout: "" });
    expect(none.ms).toBeLessThan(1200);
    // An open, silent stdin pipe: the 200 ms cap fires, stdin is released, and the process still exits on its own.
    const openPipe = await run(["claude-code"], null, dir, { keepOpen: true });
    expect(openPipe).toMatchObject({ status: 0, stdout: "" });
    expect(openPipe.ms).toBeLessThan(1500);
    const gone = mkdtempSync(join(tmpdir(), "bibrain-hook-gone-"));
    cleanup.push(() => rmSync(gone, { recursive: true, force: true }));
    expect(await run(["claude-code"], event("what colour did we pick for the launch"), gone)).toMatchObject({ status: 0, stdout: "" });
    expect(await run(["vscode"], event("what colour did we pick for the launch"), dir)).toMatchObject({ status: 0, stdout: "" });
    const remote = dataDir("https://brain.example.test");
    expect(await run(["claude-code"], event("what colour did we pick for the launch"), remote)).toMatchObject({ status: 0, stdout: "" });
    expect(f.calls).toHaveLength(0);
  });
  it("accepts CRLF and a BOM on stdin", async () => {
    const f = await fake(ok("pointer", "The owner's brain (bibrain) has notes on Launch that may bear on this; brain_recall searches it.", []));
    const dir = dataDir(`http://127.0.0.1:${f.port}`);
    const r = await run(["codex"], "\uFEFF" + event("what colour did we pick for the launch").replace(/,/g, ",\r\n"), dir);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toContain("brain_recall searches it.");
    expect(f.calls[0].body.client).toBe("codex");
  });
});
