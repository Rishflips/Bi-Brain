import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { markerLines } from "../../apps/cli/lib.mjs";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const harness = resolve("tests/helpers/hermes-fake-ctx.py");
const plugin = resolve("integrations/hermes/bibrain");
/** The first Python 3.10+ on the PATH, or null. The Windows Store alias prints nothing useful and is passed over. (spawnSync is fine here: no server is up yet.) */
function python(): string | null {
  for (const cmd of process.platform === "win32" ? ["python", "py"] : ["python3", "python"]) {
    const args = cmd === "py" ? ["-3", "--version"] : ["--version"];
    const r = spawnSync(cmd, args, { encoding: "utf8" });
    const m = /^Python 3\.(\d+)\./.exec((r.stdout || r.stderr || "").trim());
    if (r.status === 0 && m && Number(m[1]) >= 10) return cmd;
  }
  return null;
}
const py = python();
// On a developer machine without Python the suite skips and says so; in CI it must run, so a missing Python is a failure there (spec R9).
if (!py && process.env.CI === "true") {
  it("needs Python 3.10+ in CI to test the Hermes plugin", () => {
    throw new Error("No Python 3.10+ on the PATH in CI; the Hermes plugin tests cannot run. Pin it with actions/setup-python.");
  });
} else if (!py) console.log("hermes-plugin.test.ts: no Python 3.10+ on the PATH; the Hermes plugin tests are skipped on this machine.");
let cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});
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
/**
 * Runs the harness: it imports the plugin, registers hooks on a fake ctx, runs the scenario and prints one JSON line. The key is passed through the
 * environment only. Asynchronous on purpose: the fake server lives in this process, and a blocking spawn would stop it answering (every call would time out).
 */
function harnessRun(scenario: unknown, env: Record<string, string>) {
  const args = py === "py" ? ["-3", "-I", harness, plugin] : ["-I", harness, plugin];
  return new Promise<{ status: number | null; out: any; err: string }>((done) => {
    const child = spawn(py!, args, { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill(), 20000);
    child.on("close", (status) => {
      clearTimeout(timer);
      let out: any = null;
      try {
        out = stdout ? JSON.parse(stdout) : null;
      } catch {}
      done({ status, out, err: stderr });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(Buffer.from(JSON.stringify(scenario), "utf8"));
  });
}
const ok = (body: unknown) => (_req: any, res: any) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};
const KEY = "f".repeat(64);

describe.skipIf(!py)("Hermes plugin", () => {
  it("registers pre_llm_call and post_llm_call only, declares the two required variables, and never imports beyond the standard library", async () => {
    const f = await fake(ok({ level: "none", text: "", hit_ids: [], digest: false }));
    const r = await harnessRun({ steps: [] }, { BRAIN_API_URL: `http://127.0.0.1:${f.port}`, BRAIN_AGENT_TOKEN: KEY });
    expect(r.status, r.err).toBe(0);
    expect(r.out.hooks).toEqual(["pre_llm_call", "post_llm_call"]);
    // Every import statement in the plugin names a standard-library module (sys.stdlib_module_names, Python 3.10+).
    expect(r.out.stdlib_only).toBe(true);
    expect(r.out.imports).toContain("urllib.request");
    // Only the manifest keys the Hermes plugins guide documents: name, version, description, requires_env (name, description, url, secret), provides_hooks.
    // Normalise line endings so the check holds on any checkout.
    const manifest = readFileSync(resolve(plugin, "plugin.yaml"), "utf8").replace(/\r\n/g, "\n");
    expect(manifest).toContain("name: bibrain");
    expect(manifest).toMatch(/requires_env:\s*\n\s*- name: BRAIN_AGENT_TOKEN\s*\n(?:\s+\w+: .*\n)*?\s+secret: true/);
    expect(manifest).toMatch(/- name: BRAIN_API_URL/);
    expect(manifest).toContain("provides_hooks:");
    expect(manifest).not.toMatch(/^\s*(label|password):/m);
  });
  it("pre_llm_call pushes the turn with client hermes, returns {context} for a push and None for quiet, and remembers seen ids and the digest per session", async () => {
    const f = await fake((req, res) => {
      const first = f.calls.length === 1;
      ok(first ? { level: "full", text: "BiBrain recall: cobalt (fact id1, 2026-10-20, current)", hit_ids: ["id1"], digest: true } : { level: "none", text: "", hit_ids: [], digest: false })(req, res);
    });
    const r = await harnessRun(
      { steps: [
        { hook: "pre_llm_call", kwargs: { session_id: "sess-1", user_message: "what colour did we pick for the launch", conversation_history: [], is_first_turn: true, model: "any", platform: "cli", telemetry_schema_version: "hermes.observer.v1" } },
        { hook: "pre_llm_call", kwargs: { session_id: "sess-1", user_message: "and what about the launch date for Northstar", conversation_history: [], is_first_turn: false, model: "any", platform: "cli" } },
      ] },
      { BRAIN_API_URL: `http://127.0.0.1:${f.port}`, BRAIN_AGENT_TOKEN: KEY },
    );
    expect(r.status, r.err).toBe(0);
    expect(r.out.results[0]).toEqual({ context: "BiBrain recall: cobalt (fact id1, 2026-10-20, current)" });
    expect(r.out.results[1]).toBeNull();
    expect(f.calls[0].url).toBe("/api/v1/agent/recall-push");
    expect(f.calls[0].headers.authorization).toBe(`Bearer ${KEY}`);
    expect(f.calls[0].body).toEqual({ prompt: "what colour did we pick for the launch", session_id: sha("sess-1"), first_prompt: true, seen: [], client: "hermes" });
    expect(f.calls[1].body).toEqual({ prompt: "and what about the launch date for Northstar", session_id: sha("sess-1"), first_prompt: false, seen: [sha("id1")], client: "hermes" });
    expect(r.err).not.toContain(KEY);
    expect(r.err).not.toContain("cobalt");
  });
  it("pre_llm_call skips short, command and secret prompts, cuts long prompts to 500 code points (astral characters included), and returns None without raising when BiBrain is down, silent, 500, garbage, or trickling bytes", async () => {
    const quiet = await fake(ok({ level: "full", text: "x", hit_ids: [], digest: false }));
    const skips = await harnessRun(
      { steps: ["hi", "/compact now please", "api_key = abcdefghijklmnopqrstu", "what colour did we pick " + "é🙂".repeat(1000)].map((user_message) => ({ hook: "pre_llm_call", kwargs: { session_id: "s", user_message, is_first_turn: false, model: "m", platform: "cli" } })) },
      { BRAIN_API_URL: `http://127.0.0.1:${quiet.port}`, BRAIN_AGENT_TOKEN: KEY },
    );
    expect(skips.status, skips.err).toBe(0);
    expect(skips.out.results.slice(0, 3)).toEqual([null, null, null]);
    expect(quiet.calls).toHaveLength(1);
    // Code points, not UTF-16 units or bytes: the harness reads stdin as UTF-8 bytes, so the emoji survive on Windows too.
    expect(Array.from(quiet.calls[0].body.prompt as string).length).toBe(500);
    expect(quiet.calls[0].body.prompt).toContain("🙂");
    const silent = await fake(() => {});
    const bad = await fake((_req, res) => { res.writeHead(500); res.end("boom"); });
    const garbage = await fake((_req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end("{not json"); });
    // Headers at once, then one byte every 300 ms for ever: a per-read socket timeout alone would never fire.
    const trickle = await fake((_req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); const t = setInterval(() => res.write("x"), 300); res.on("close", () => clearInterval(t)); });
    for (const port of [1, silent.port, bad.port, garbage.port, trickle.port]) {
      const started = Date.now();
      const r = await harnessRun({ steps: [{ hook: "pre_llm_call", kwargs: { session_id: "s", user_message: "what colour did we pick for the launch", is_first_turn: true, model: "m", platform: "cli" } }] }, { BRAIN_API_URL: `http://127.0.0.1:${port}`, BRAIN_AGENT_TOKEN: KEY });
      expect(r.status, r.err).toBe(0);
      expect(r.out.results).toEqual([null]);
      expect(r.out.raised).toEqual([]);
      expect(Date.now() - started).toBeLessThan(6000);
      // The wall-clock deadline: 1.5 s plus process start, never the 30 s Hermes would allow.
      expect(r.out.elapsed_ms[0]).toBeLessThan(2500);
    }
  });
  it("caps what it reads from BiBrain at 64 KiB and treats a longer reply as nothing", async () => {
    const huge = await fake((_req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ level: "full", text: "y".repeat(200 * 1024), hit_ids: [], digest: false })); });
    const r = await harnessRun({ steps: [{ hook: "pre_llm_call", kwargs: { session_id: "s", user_message: "what colour did we pick for the launch", is_first_turn: true, model: "m", platform: "cli" } }] }, { BRAIN_API_URL: `http://127.0.0.1:${huge.port}`, BRAIN_AGENT_TOKEN: KEY });
    expect(r.status, r.err).toBe(0);
    expect(r.out.results).toEqual([null]);
    expect(r.out.raised).toEqual([]);
  });
  it("post_llm_call sends only the marker lines (identical to the CLI's rule), once per session and text, at most 12 a session, and nothing secret", async () => {
    const f = await fake(ok({ saved: true, source_id: "src", suggestions: 1, open_questions: 1, duplicate: false }));
    const reply = "prose ".repeat(300) + "\n- **Decided: lease length: 90 seconds**\n```\nDecided: quoted: in a fence\n```\nOpen question: retry twice?\nNext step: an earlier one.\nNext step: run it.";
    const many = Array.from({ length: 12 }, (_, i) => `Decided: topic ${i + 1}: choice ${i + 1}`).concat(Array.from({ length: 12 }, (_, i) => `Open question: q${i + 1}?`)).join("\n");
    const step = (assistant_response: string, session_id = "A") => ({ hook: "post_llm_call", kwargs: { session_id, user_message: "u", assistant_response, conversation_history: [], model: "m", platform: "cli" } });
    const r = await harnessRun(
      { steps: [step(reply), step(reply), step("All done."), step("Next step: alone"), step("Decided: key: api_key = abcdefghijklmnopqrstu"), step(many), ...Array.from({ length: 14 }, (_, i) => step(`Decided: n${i}: v${i}`, "B"))], pure: { marker_lines: [reply, many, "Next step: alone", "All done.", `Decided: long: ${"x".repeat(301)}\nOpen question: kept?`] } },
      { BRAIN_API_URL: `http://127.0.0.1:${f.port}`, BRAIN_AGENT_TOKEN: KEY },
    );
    expect(r.status, r.err).toBe(0);
    expect(r.out.raised).toEqual([]);
    expect(f.calls[0].url).toBe("/api/v1/agent/session-note");
    expect(f.calls[0].body).toEqual({ session_id: sha("A"), client: "hermes", text: "Decided: lease length: 90 seconds\nOpen question: retry twice?\nNext step: run it." });
    expect(JSON.stringify(f.calls.map((c) => c.body))).not.toContain("prose");
    expect(JSON.stringify(f.calls.map((c) => c.body))).not.toContain("api_key");
    // reply once, many once, then 12 of the 14 in session B
    expect(f.calls).toHaveLength(2 + 12);
    for (const [i, text] of r.out.pure.marker_lines.entries()) expect(text).toBe(markerLines([reply, many, "Next step: alone", "All done.", `Decided: long: ${"x".repeat(301)}\nOpen question: kept?`][i]));
  });
  it("sends the key to no address but a clean HTTPS origin or loopback HTTP: a reachable server behind credentials, a path, a query or a plaintext host name gets no request at all", async () => {
    // A reachable fake makes this mutation-proof: if the guard were removed, the request would arrive and `calls` would not be empty.
    const f = await fake(ok({ level: "full", text: "leak", hit_ids: [], digest: false }));
    const turn = { steps: [{ hook: "pre_llm_call", kwargs: { session_id: "s", user_message: "what colour did we pick for the launch", is_first_turn: true, model: "m", platform: "cli" } }], pure: { api_origin: [] as string[] } };
    for (const url of [`http://u:p@127.0.0.1:${f.port}`, `http://127.0.0.1:${f.port}/path`, `http://127.0.0.1:${f.port}/?q=1`, `http://127.0.0.1:${f.port}/#x`, "http://brain.example.test", "https://u:p@brain.example", "https://brain.example/path", "ftp://x", ""]) {
      const r = await harnessRun(turn, { BRAIN_API_URL: url, BRAIN_AGENT_TOKEN: KEY });
      expect(r.status, r.err).toBe(0);
      expect(r.out.results).toEqual([null]);
      expect(r.out.raised).toEqual([]);
    }
    expect(f.calls).toHaveLength(0);
    // The guard itself: it raises for every bad shape and returns the origin for the good ones.
    const probe = await harnessRun({ steps: [], pure: { api_origin: ["https://brain.example.com", "https://brain.example.com/", `http://127.0.0.1:${f.port}`, "http://localhost:4317", "http://brain.example.test", "https://u:p@brain.example", "https://brain.example/path", "http://127.0.0.1", "ftp://x"] } }, { BRAIN_API_URL: `http://127.0.0.1:${f.port}`, BRAIN_AGENT_TOKEN: KEY });
    expect(probe.out.pure.api_origin).toEqual(["https://brain.example.com", "https://brain.example.com", `http://127.0.0.1:${f.port}`, "http://localhost:4317", "ValueError", "ValueError", "ValueError", "ValueError", "ValueError"]);
    // Without a key the plugin does nothing (Hermes also disables it through requires_env).
    const noKey = await harnessRun(turn, { BRAIN_API_URL: `http://127.0.0.1:${f.port}`, BRAIN_AGENT_TOKEN: "" });
    expect(noKey.out.results).toEqual([null]);
    expect(f.calls).toHaveLength(0);
  });
});
