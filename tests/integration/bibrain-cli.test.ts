import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Storage } from "../../packages/storage/index.ts";
import { Brain } from "../../packages/domain/service.ts";
import { createApp } from "../../apps/server/app.ts";
import type { Principal } from "../../packages/contracts/index.ts";
import { browserCommand, dataDirFor, keyFilePath, parseArgs } from "../../apps/cli/lib.mjs";

const owner: Principal = { kind: "owner" };
const cli = resolve("apps/cli/bibrain.mjs");
let cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

describe("bibrain helpers", () => {
  it("parses commands and flags", () => {
    expect(parseArgs([])).toEqual({ command: "start", flags: {}, positional: [] });
    expect(parseArgs(["connect", "--connection", "abc", "--data", "/d"])).toEqual({ command: "connect", flags: { connection: "abc", data: "/d" }, positional: [] });
    expect(parseArgs(["start", "--no-open"])).toEqual({ command: "start", flags: { "no-open": true }, positional: [] });
  });

  it("opens the browser without a shell on every platform", () => {
    expect(browserCommand("win32", "http://127.0.0.1:4317/#pair=ab")).toEqual({ command: "rundll32", args: ["url.dll,FileProtocolHandler", "http://127.0.0.1:4317/#pair=ab"] });
    expect(browserCommand("darwin", "http://x/")).toEqual({ command: "open", args: ["http://x/"] });
    expect(browserCommand("linux", "http://x/")).toEqual({ command: "xdg-open", args: ["http://x/"] });
  });

  it("only reads key files by connection id from an absolute data folder", () => {
    expect(keyFilePath("/d", "1b4e28ba-2fa1-41d2-883f-0016d3cca427")).toBe(join("/d", "agent-keys", "1b4e28ba-2fa1-41d2-883f-0016d3cca427.json"));
    expect(() => keyFilePath("/d", "../../secret")).toThrow();
    expect(() => keyFilePath("relative", "1b4e28ba-2fa1-41d2-883f-0016d3cca427")).toThrow();
    expect(dataDirFor("/repo", {})).toBe(resolve("/repo", "data"));
    expect(dataDirFor("/repo", { BRAIN_DB: "/x/brain.sqlite" })).toBe(resolve("/x"));
  });
});

describe("bibrain connect", () => {
  it("runs the real adapter for an added agent, counts its first call, and stops after revoke", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bibrain-cli-test-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const s = new Storage(join(dir, "brain.sqlite"));
    cleanup.push(() => {
      try {
        s.close();
      } catch {}
    });
    const b = new Brain(s);
    const app = await createApp(b, { pairSecret: "test-code", static: false });
    await app.listen({ host: "127.0.0.1", port: 0 });
    cleanup.push(() => app.close());
    const port = (app.server.address() as { port: number }).port;
    const g = b.createGrant(owner, { projects: ["inbox"], operations: ["read", "propose_memory"], expires_at: new Date(Date.now() + 86_400_000).toISOString(), client: "codex" });
    mkdirSync(join(dir, "agent-keys"));
    writeFileSync(join(dir, "agent-keys", `${g.id}.json`), JSON.stringify({ api: `http://127.0.0.1:${port}`, key: g.token }));

    const transport = new StdioClientTransport({ command: process.execPath, args: [cli, "connect", "--connection", g.id, "--data", dir] });
    const client = new Client({ name: "cli-test", version: "1.0.0" });
    cleanup.push(() => client.close());
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["brain_recall", "brain_propose"]));
    const res = await client.callTool({ name: "brain_recall", arguments: { query: "anything" } });
    expect(res.isError).toBeFalsy();
    expect(b.connections(owner)[0].status).toBe("Connected");

    b.revoke(owner, g.id);
    const denied = await client.callTool({ name: "brain_recall", arguments: { query: "anything" } });
    expect(denied.isError).toBe(true);
  }, 30_000);

  it("explains a removed connection and exits", () => {
    const dir = mkdtempSync(join(tmpdir(), "bibrain-cli-gone-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const r = spawnSync(process.execPath, [cli, "connect", "--connection", "1b4e28ba-2fa1-41d2-883f-0016d3cca427", "--data", dir], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("This BiBrain connection was removed. Add the agent again from Connections in BiBrain.");
  });

  it("explains a damaged connection file without printing its contents", () => {
    const dir = mkdtempSync(join(tmpdir(), "bibrain-cli-bad-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const id = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";
    mkdirSync(join(dir, "agent-keys"));
    writeFileSync(join(dir, "agent-keys", `${id}.json`), '{"api": "http://127.0.0.1:1", "key": "SECRETVALUE');
    const r = spawnSync(process.execPath, [cli, "connect", "--connection", id, "--data", dir], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("This BiBrain connection file is damaged. Add the agent again from Connections in BiBrain.");
    expect(r.stderr).not.toContain("SECRETVALUE");
    expect(r.stderr).not.toMatch(/\n\s+at |\.mjs:\d+/);
  });
});

/** Runs the CLI without blocking this process, so an in-process server can answer it. */
function runCli(args: string[], env: Record<string, string>) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((done) => {
    const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => done({ status, stdout, stderr }));
  });
}

describe("bibrain open", () => {
  async function liveApp() {
    const dir = mkdtempSync(join(tmpdir(), "bibrain-cli-open-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const s = new Storage(join(dir, "brain.sqlite"));
    cleanup.push(() => {
      try {
        s.close();
      } catch {}
    });
    const app = await createApp(new Brain(s), { pairSecret: "test-code", static: false });
    await app.listen({ host: "127.0.0.1", port: 0 });
    cleanup.push(() => app.close());
    return { dir, port: (app.server.address() as { port: number }).port };
  }

  it("hands the browser a one-time sign-in link that works once", async () => {
    const { dir, port } = await liveApp();
    const log = join(dir, "browser.log");
    const r = await runCli(["open"], { BRAIN_PORT: String(port), BRAIN_OWNER_SECRET: "test-code", BRAIN_DB: join(dir, "brain.sqlite"), BRAIN_CLI_BROWSER_LOG: log });
    expect(r.status).toBe(0);
    const urls = readFileSync(log, "utf8").trim().split("\n");
    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${port}/#pair=[0-9a-f]{64}$`));
    const token = urls[0].split("#pair=")[1];
    const redeem = () => fetch(`http://127.0.0.1:${port}/api/v1/session/pair-link/redeem`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
    expect((await redeem()).status).toBe(200);
    expect((await redeem()).status).toBe(401);
  }, 30_000);

  it("says plainly when the installation code cannot be found", async () => {
    const { dir, port } = await liveApp();
    const log = join(dir, "browser.log");
    const r = await runCli(["open"], { BRAIN_PORT: String(port), BRAIN_OWNER_SECRET: "", BRAIN_DB: join(dir, "brain.sqlite"), BRAIN_CLI_BROWSER_LOG: log });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`BiBrain's installation code was not found in ${dir}. If another BiBrain is using port ${port}, stop it or set BRAIN_PORT.`);
    expect(r.stderr).not.toMatch(/\n\s+at |\.mjs:\d+/);
    expect(existsSync(log)).toBe(false);
  }, 30_000);

  it("refuses to sign in to something that is not BiBrain", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bibrain-cli-other-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const other = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>((ready) => other.listen(0, "127.0.0.1", ready));
    cleanup.push(() => new Promise<void>((closed) => other.close(() => closed())));
    const port = (other.address() as { port: number }).port;
    const log = join(dir, "browser.log");
    const r = await runCli(["open"], { BRAIN_PORT: String(port), BRAIN_OWNER_SECRET: "test-code", BRAIN_DB: join(dir, "brain.sqlite"), BRAIN_CLI_BROWSER_LOG: log });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`Something else is using port ${port}. Stop it or set BRAIN_PORT to another port.`);
    expect(r.stderr).not.toMatch(/\n\s+at |\.mjs:\d+/);
    expect(existsSync(log)).toBe(false);
  }, 30_000);
});
