/** Owner-run native recall acceptance. Spends subscription quota; never runs in CI or
 * from an agent. Disposable workspace and data; the real one-step connect writes the
 * client's project file AND the prompt hook; ten prompts × N repeats, observed at the
 * loopback server, never trusted from the model's own account of itself. */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { Storage } from "../packages/storage/index.ts";
import { Brain } from "../packages/domain/service.ts";
import { createApp } from "../apps/server/app.ts";
import { agentConnect } from "../apps/server/agent-connect.ts";

const client = process.argv[2];
if (process.env.BRAIN_RECALL_PROOF !== "1" || !["codex", "claude"].includes(client))
  throw new Error("Explicitly set BRAIN_RECALL_PROOF=1 and choose codex or claude. This uses native subscription quota.");
const hookOn = process.env.BRAIN_PROOF_NO_HOOK !== "1";
const repeats = Math.max(1, Math.min(5, Number(process.env.BRAIN_PROOF_REPEATS ?? 3)));
const repo = process.cwd();
const base = resolve("test-results");
mkdirSync(base, { recursive: true });
const root = mkdtempSync(join(base, `recall-${client}-`));
const workspace = join(root, "workspace");
const dataDir = join(root, "data");
mkdirSync(workspace);
mkdirSync(dataDir);
const store = new Storage(join(root, "brain.sqlite"));
const brain = new Brain(store);
const owner = { kind: "owner" } as const;
const project = brain.createProject(owner, "Northstar");

/** A reviewed fact with exact evidence: capture, then accept its gate. */
function fact(entity: string, value: "active" | "paused" | "done") {
  const saved = brain.capture(owner, { project_id: project.id, title: `${entity} status`, body: `${entity} status ${value}`, visibility: "project", separate: true }) as any;
  const gate = brain.entities(owner, "gate").find((g) => g.data.raw_id === saved.source_id)!;
  brain.reviewGate(owner, gate.id, { action: "accept", expected_version: gate.version });
  return saved.source_id as string;
}
const FACTS: [string, "active" | "paused" | "done"][] = [["Northstar", "active"], ["Hydra", "paused"], ["Lantern", "done"], ["Beacon", "active"], ["Quill", "paused"], ["Atlas", "done"]];
for (const [entity, value] of FACTS) fact(entity, value);
// Three unreviewed originals; nothing reads their ids back (no-unused-vars), the proof observes them through the agent.
brain.capture(owner, { project_id: project.id, title: "Launch notes", body: "The launch color is cobalt. Ana wants the banner shipped by Friday.", visibility: "project" });
brain.capture(owner, { project_id: project.id, title: "Vendor", body: "The launch party caterer is Lumen Catering, confirmed by Ana.", visibility: "project" });
brain.capture(owner, { project_id: project.id, title: "People", body: "Marco is the design lead and works from Lisbon.", visibility: "project" });
brain.capture(owner, { project_id: project.id, title: "Private", body: "RECALL_PRIVATE_CANARY", visibility: "private" });
const other = brain.createProject(owner, "Other");
brain.capture(owner, { project_id: other.id, title: "Other", body: "RECALL_OTHER_CANARY", visibility: "project" });

type Prompt = { id: string; text: string; shouldRetrieve: boolean; expect: string[] };
const PROMPTS: Prompt[] = [
  { id: "r1", text: "Is Northstar active right now, and how do you know?", shouldRetrieve: true, expect: ["active"] },
  { id: "r2", text: "What color did we settle on for the launch?", shouldRetrieve: true, expect: ["cobalt"] },
  { id: "r3", text: "Who is catering the launch party?", shouldRetrieve: true, expect: ["Lumen"] },
  { id: "r4", text: "Where does Marco work from these days?", shouldRetrieve: true, expect: ["Lisbon"] },
  { id: "r5", text: "Is Hydra still paused or did it restart?", shouldRetrieve: true, expect: ["paused"] },
  { id: "r6", text: "Remind me what state Lantern is in.", shouldRetrieve: true, expect: ["done"] },
  { id: "n1", text: "Write a Python function that reverses a linked list.", shouldRetrieve: false, expect: [] },
  { id: "n2", text: "Explain the difference between TCP and UDP in two sentences.", shouldRetrieve: false, expect: [] },
  { id: "n3", text: "Give me a regex that matches an ISO 8601 date.", shouldRetrieve: false, expect: [] },
  { id: "n4", text: "What does the git rebase --onto flag do?", shouldRetrieve: false, expect: [] },
];

let token = "";
let connectionId = "";
const app = await createApp(brain, { pairSecret: "synthetic-recall-pairing", static: false });
type Observation = { prompt: string; path: string; status: number; payload: string; at: number };
const observations: Observation[] = [];
let currentPrompt = "";
app.addHook("onSend", (req, reply, payload, done) => {
  if (!!token && req.headers.authorization === `Bearer ${token}`)
    observations.push({ prompt: currentPrompt, path: req.url.split("?")[0], status: reply.statusCode, payload: typeof payload === "string" ? payload : "", at: Date.now() });
  done(null, payload);
});
await app.listen({ host: "127.0.0.1", port: 0 });
const address = app.server.address();
if (!address || typeof address === "string") throw new Error("Local proof server did not bind.");
const apiUrl = `http://127.0.0.1:${address.port}`;
let connector: ReturnType<typeof agentConnect> | undefined;
const runs: { prompt: string; repeat: number; code: number | null; output: string; stderr: string; ms: number }[] = [];
try {
  const folder = realpathSync(workspace);
  connector = agentConnect(brain, { available: true, reason: "", dataDir, apiOrigin: apiUrl, node: process.execPath, cli: join(repo, "apps/cli/bibrain.mjs"), home: root, pathDirs: [] });
  const agent = client === "codex" ? "codex" : "claude-code";
  const preview = connector.preview(owner, { client: agent, project_id: project.id, folder });
  const connected = connector.connect(owner, { connection_id: preview.connection_id, client: agent, project_id: project.id, folder, access: "read" });
  connectionId = connected.connection_id;
  token = (JSON.parse(readFileSync(join(dataDir, "agent-keys", `${connectionId}.json`), "utf8")) as { key: string }).key;
  const hookFile = connected.files.find((f) => f.role === "hook");
  if (!hookOn && hookFile?.state === "written") {
    const parsed = JSON.parse(readFileSync(hookFile.path, "utf8"));
    delete parsed.hooks;
    writeFileSync(hookFile.path, JSON.stringify(parsed, null, 2) + "\n");
  }
  const env = { ...process.env };
  for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "BRAIN_DODO_API_KEY", "BRAIN_DODO_WEBHOOK_SECRET", "BRAIN_DECISION_API_KEY", "OLLAMA_API_KEY"]) delete env[name as keyof typeof env];
  const appData = process.env.APPDATA ?? "";
  const executable = client === "codex" ? process.execPath : (process.env.BRAIN_NATIVE_CLAUDE_BINARY ?? join(appData, "npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe"));
  const argsFor = (prompt: string) =>
    client === "codex"
      ? [process.env.BRAIN_NATIVE_CODEX_ENTRY ?? join(appData, "npm/node_modules/@openai/codex/bin/codex.js"), "exec", "--ignore-user-config", "--ephemeral", "--skip-git-repo-check", "--json", "--sandbox", "read-only", "--model", "gpt-6-sol", prompt]
      : ["--print", "--restricted", "--tools", "", "--strict-mcp-config", "--mcp-config", join(folder, ".mcp.json"), "--allowedTools", "mcp__bibrain__*", "--permission-mode", "dontAsk", "--no-session-persistence", "--output-format", "json", prompt];
  for (const prompt of PROMPTS)
    for (let repeat = 0; repeat < repeats; repeat++) {
      currentPrompt = prompt.id;
      const started = Date.now();
      const child = spawn(executable, argsFor(prompt.text), { cwd: workspace, env, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      let stderr = "";
      const timeout = setTimeout(() => child.kill("SIGTERM"), 120_000);
      const code = await new Promise<number | null>((done, reject) => {
        child.on("error", reject);
        child.stdout!.on("data", (d) => (output += d.toString()));
        child.stderr!.on("data", (d) => (stderr += d.toString()));
        child.once("close", done);
      }).finally(() => clearTimeout(timeout));
      runs.push({ prompt: prompt.id, repeat, code, output: output.slice(-20000), stderr: stderr.slice(-4000), ms: Date.now() - started });
    }
  const byPrompt = (id: string) => observations.filter((o) => o.prompt === id);
  const pushes = observations.filter((o) => o.path.endsWith("/recall-push"));
  const levelOf = (o: Observation) => { try { return JSON.parse(o.payload).level as string; } catch { return "unparsed"; } };
  const perPrompt = PROMPTS.map((p) => {
    const mine = runs.filter((r) => r.prompt === p.id);
    const toolCalls = byPrompt(p.id).filter((o) => o.path.endsWith("/agent/recall") || o.path.endsWith("/agent/open")).length;
    const levels = byPrompt(p.id).filter((o) => o.path.endsWith("/recall-push")).map(levelOf);
    const correct = mine.filter((r) => p.expect.every((e) => r.output.toLowerCase().includes(e.toLowerCase())) && /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(r.output)).length;
    return { id: p.id, should_retrieve: p.shouldRetrieve, tool_calls: toolCalls, levels, correct_runs: correct, runs: mine.length, pass_all: p.shouldRetrieve ? correct === mine.length : true };
  });
  const retrieve = perPrompt.filter((p) => p.should_retrieve);
  const quiet = perPrompt.filter((p) => !p.should_retrieve);
  // Hook latency comes from the content-free recall log (the push response carries no timing field).
  const log = brain.recallLog(owner).rows.filter((r) => r.grant_id === connectionId);
  const hookLatencies = log.map((r) => r.latency_ms).sort((a, b) => a - b);
  const median = hookLatencies.length ? hookLatencies[Math.floor(hookLatencies.length / 2)] : null;
  const canary = observations.some((o) => o.payload.includes("RECALL_PRIVATE_CANARY") || o.payload.includes("RECALL_OTHER_CANARY")) || runs.some((r) => r.output.includes("RECALL_PRIVATE_CANARY") || r.output.includes("RECALL_OTHER_CANARY"));
  const checks = {
    should_retrieve_answered_with_citation: retrieve.filter((p) => p.correct_runs >= 1).length >= 5,
    pass_cubed: retrieve.filter((p) => p.pass_all).length,
    tool_call_rate_on_should_retrieve: retrieve.reduce((n, p) => n + (p.tool_calls > 0 ? 1 : 0), 0) / retrieve.length,
    no_full_on_should_not: quiet.every((p) => !p.levels.includes("full")),
    at_most_one_pointer_on_should_not: quiet.reduce((n, p) => n + p.levels.filter((l) => l === "pointer").length, 0) <= 1,
    no_canary: !canary,
    // With the hook on, a run where it never fired proves nothing about push levels (the two should-not checks would be vacuous).
    hook_fired: !hookOn || pushes.length > 0,
  };
  const passed = checks.hook_fired && checks.should_retrieve_answered_with_citation && checks.no_full_on_should_not && checks.at_most_one_pointer_on_should_not && checks.no_canary;
  const report = { client, hook: hookOn ? "on" : "off", repeats, generated_at: new Date().toISOString(), checks, passed, per_prompt: perPrompt, pushes: pushes.length, median_hook_latency_ms: median, hook_latency_sample: hookLatencies, request_statuses: observations.map((o) => ({ prompt: o.prompt, path: o.path, status: o.status })), runs: runs.map((r) => ({ prompt: r.prompt, repeat: r.repeat, code: r.code, ms: r.ms, output: r.output.slice(-6000), stderr: r.stderr.slice(-2000) })), scope: "Synthetic disposable native client, no owner data or paid API credentials; subscription quota used." };
  const serialized = JSON.stringify(report, null, 2);
  if (serialized.includes(token)) throw new Error("Refusing to persist a recall report containing a credential.");
  mkdirSync(resolve("data"), { recursive: true });
  const reportPath = resolve(`data/recall-${client}-${hookOn ? "hook" : "nohook"}-proof.json`);
  writeFileSync(reportPath, serialized, { mode: 0o600 });
  console.log(JSON.stringify({ client, hook: hookOn ? "on" : "off", passed, checks, pushes: pushes.length, median_hook_ms: median, report: reportPath }));
  if (!passed) process.exitCode = 1;
} finally {
  if (connectionId) {
    brain.revoke(owner, connectionId);
    connector?.forget(connectionId);
  }
  await app.close();
  store.close();
  if (!resolve(root).startsWith(base + sep)) throw new Error("Refusing cleanup outside the disposable proof directory.");
  rmSync(root, { recursive: true, force: true });
}
