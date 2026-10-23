import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
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
    expect(parseArgs([])).toEqual({ command: "start", flags: {} });
    expect(parseArgs(["connect", "--connection", "abc", "--data", "/d"])).toEqual({ command: "connect", flags: { connection: "abc", data: "/d" } });
    expect(parseArgs(["start", "--no-open"])).toEqual({ command: "start", flags: { "no-open": true } });
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
    await client.connect(transport);
    cleanup.push(() => client.close());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["brain.search", "brain.propose"]));
    const res = await client.callTool({ name: "brain.search", arguments: { project_id: "inbox", query: "anything" } });
    expect(res.isError).toBeFalsy();
    expect(b.connections(owner)[0].status).toBe("Connected");

    b.revoke(owner, g.id);
    const denied = await client.callTool({ name: "brain.search", arguments: { project_id: "inbox", query: "anything" } });
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
    expect(r.stderr).not.toContain("at ");
  });
});
