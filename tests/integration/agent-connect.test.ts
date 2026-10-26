import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Storage } from "../../packages/storage/index.ts";
import { Brain } from "../../packages/domain/service.ts";
import { agentConnect } from "../../apps/server/agent-connect.ts";
import { createApp } from "../../apps/server/app.ts";
import type { Principal } from "../../packages/contracts/index.ts";

const owner: Principal = { kind: "owner" };
let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.reverse()) fn();
  cleanup = [];
});
function setup() {
  const root = mkdtempSync(join(tmpdir(), "agent-connect-test-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const s = new Storage(join(dataDir, "brain.sqlite"));
  cleanup.push(() => {
    try {
      s.close();
    } catch {}
  });
  const b = new Brain(s, () => new Date("2026-10-23T09:00:00Z"));
  const home = join(root, "home");
  mkdirSync(join(home, ".codex"), { recursive: true });
  const folder = join(root, "northstar");
  mkdirSync(folder);
  const config = {
    available: true,
    reason: "",
    dataDir,
    apiOrigin: "http://127.0.0.1:4317",
    node: "/usr/bin/node",
    cli: "/opt/bibrain/apps/cli/bibrain.mjs",
    home,
    pathDirs: [],
  };
  return { b, s, dataDir, folder, config, svc: agentConnect(b, config) };
}

describe("agentConnect", () => {
  it("reports which agents look installed, and where each file goes", () => {
    const { svc } = setup();
    const st = svc.status(owner);
    expect(st.available).toBe(true);
    expect(st.clients.map((c) => [c.client, c.found, c.file])).toEqual([
      ["codex", true, ".codex/config.toml"],
      ["claude-code", false, ".mcp.json"],
      ["cursor", false, ".cursor/mcp.json"],
    ]);
  });

  it("writes exactly the previewed file, keeps the key out of it, and stores the key for BiBrain", () => {
    const { b, svc, folder, dataDir } = setup();
    const pv = svc.preview(owner, { client: "codex", project_id: "inbox", folder });
    expect(pv.exists).toBe(false);
    expect(pv.file).toBe(join(folder, ".codex", "config.toml"));
    const done = svc.connect(owner, { connection_id: pv.connection_id, client: "codex", project_id: "inbox", folder, access: "suggest" });
    expect(readFileSync(done.file, "utf8")).toBe(pv.contents);
    const key = JSON.parse(readFileSync(join(dataDir, "agent-keys", `${pv.connection_id}.json`), "utf8"));
    expect(key).toEqual({ api: "http://127.0.0.1:4317", key: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(pv.contents).not.toContain(key.key);
    const [row] = b.connections(owner);
    expect(row).toMatchObject({ id: pv.connection_id, client: "codex", operations: ["read", "propose_memory"], status: "Not connected" });
    expect(Date.parse(row.expires_at)).toBe(Date.parse("2026-10-23T09:00:00Z") + 90 * 86_400_000);
    expect(b.authenticateAgent(key.key)).toMatchObject({ kind: "agent", grant_id: pv.connection_id });
  });

  it("never touches an existing project file and leaves no connection behind", () => {
    const { b, svc, folder, dataDir } = setup();
    writeFileSync(join(folder, ".mcp.json"), '{"mcpServers":{}}\n');
    const pv = svc.preview(owner, { client: "claude-code", project_id: "inbox", folder });
    expect(pv.exists).toBe(true);
    expect(() => svc.connect(owner, { connection_id: pv.connection_id, client: "claude-code", project_id: "inbox", folder, access: "suggest" })).toThrow(/will not change your existing/i);
    expect(readFileSync(join(folder, ".mcp.json"), "utf8")).toBe('{"mcpServers":{}}\n');
    expect(b.connections(owner)).toEqual([]);
    expect(existsSync(join(dataDir, "agent-keys", `${pv.connection_id}.json`))).toBe(false);
  });

  it("refuses folders that are relative, missing, files or inside BiBrain's data folder", () => {
    const { b, svc, folder, dataDir } = setup();
    const file = join(folder, "notes.txt");
    writeFileSync(file, "x");
    mkdirSync(join(dataDir, "inner"));
    const cases: [string, RegExp][] = [
      ["northstar", /full path/i],
      [join(folder, "missing"), /cannot find that folder/i],
      [file, /is a file/i],
      [dataDir, /data folder/i],
      [join(dataDir, "inner"), /data folder/i],
    ];
    for (const [bad, message] of cases)
      expect(() => svc.preview(owner, { client: "codex", project_id: "inbox", folder: bad })).toThrow(message);
    expect(b.connections(owner)).toEqual([]);
  });

  it("accepts a folder whose name merely starts with two dots", () => {
    const { svc, folder } = setup();
    const odd = join(folder, "..x");
    mkdirSync(odd);
    expect(svc.preview(owner, { client: "codex", project_id: "inbox", folder: odd }).file).toBe(join(odd, ".codex", "config.toml"));
  });

  it("will not write through a linked or non-folder config directory", () => {
    const { b, svc, folder, dataDir } = setup();
    const elsewhere = join(dirname(folder), "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(folder, ".cursor"), "junction");
    expect(() => svc.preview(owner, { client: "cursor", project_id: "inbox", folder })).toThrow(/linked \.cursor folder/);
    const id = "11111111-1111-4111-8111-111111111111";
    expect(() => svc.connect(owner, { connection_id: id, client: "cursor", project_id: "inbox", folder, access: "suggest" })).toThrow(/linked \.cursor folder/);
    expect(readdirSync(elsewhere)).toEqual([]);
    writeFileSync(join(folder, ".codex"), "x");
    expect(() => svc.connect(owner, { connection_id: id, client: "codex", project_id: "inbox", folder, access: "suggest" })).toThrow(/file named \.codex/);
    expect(b.connections(owner)).toEqual([]);
    expect(existsSync(join(dataDir, "agent-keys", `${id}.json`))).toBe(false);
  });

  it("rolls back exactly when the key cannot be stored", () => {
    const { b, svc, folder, dataDir } = setup();
    writeFileSync(join(dataDir, "agent-keys"), "in the way");
    const pv = svc.preview(owner, { client: "codex", project_id: "inbox", folder });
    expect(() => svc.connect(owner, { connection_id: pv.connection_id, client: "codex", project_id: "inbox", folder, access: "suggest" })).toThrow(/could not write/i);
    expect(b.connections(owner).map((c) => c.status)).toEqual(["Revoked"]);
    expect(existsSync(join(folder, ".codex"))).toBe(false);
    expect(readFileSync(join(dataDir, "agent-keys"), "utf8")).toBe("in the way");
  });

  it("grants read only when asked, and forgets the key on revoke", () => {
    const { b, svc, folder, dataDir } = setup();
    const pv = svc.preview(owner, { client: "cursor", project_id: "inbox", folder });
    svc.connect(owner, { connection_id: pv.connection_id, client: "cursor", project_id: "inbox", folder, access: "read" });
    expect(b.connections(owner)[0].operations).toEqual(["read"]);
    svc.forget(pv.connection_id);
    expect(existsSync(join(dataDir, "agent-keys", `${pv.connection_id}.json`))).toBe(false);
  });

  it("does not reuse a setup that was already used, even after it was revoked", () => {
    const { b, svc, folder, dataDir } = setup();
    const pv = svc.preview(owner, { client: "codex", project_id: "inbox", folder });
    const input = { connection_id: pv.connection_id, client: "codex" as const, project_id: "inbox", folder, access: "suggest" as const };
    const done = svc.connect(owner, input);
    b.revoke(owner, pv.connection_id);
    svc.forget(pv.connection_id);
    rmSync(done.file);
    expect(() => svc.connect(owner, input)).toThrow(/already used/i);
    expect(existsSync(join(dataDir, "agent-keys", `${pv.connection_id}.json`))).toBe(false);
    expect(existsSync(done.file)).toBe(false);
  });

  it("previews and writes both files for Claude Code, records their state, and keeps the key out of every file", () => {
    const { b, svc, folder, dataDir } = setup();
    const pv = svc.preview(owner, { client: "claude-code", project_id: "inbox", folder });
    expect(pv.files.map((f) => [f.role, f.path, f.exists])).toEqual([
      ["server", join(folder, ".mcp.json"), false],
      ["hook", join(folder, ".claude", "settings.local.json"), false],
    ]);
    const done = svc.connect(owner, { connection_id: pv.connection_id, client: "claude-code", project_id: "inbox", folder, access: "read" });
    expect(done.files.map((f) => [f.role, f.state])).toEqual([["server", "written"], ["hook", "written"]]);
    expect(readFileSync(join(folder, ".claude", "settings.local.json"), "utf8")).toBe(pv.files[1].contents);
    const key = JSON.parse(readFileSync(join(dataDir, "agent-keys", `${pv.connection_id}.json`), "utf8")).key;
    for (const f of done.files) expect(f.contents).not.toContain(key);
    expect(JSON.stringify(pv)).not.toContain(key);
    expect(b.connections(owner)[0].files.map((f) => [f.role, f.state])).toEqual([["server", "written"], ["hook", "written"]]);
  });
  it("never changes an existing hook file: the server file is still written, the state says exists, and the snippet is returned", () => {
    const { b, svc, folder } = setup();
    mkdirSync(join(folder, ".claude"));
    writeFileSync(join(folder, ".claude", "settings.local.json"), '{"permissions":{"allow":[]}}\n');
    const pv = svc.preview(owner, { client: "claude-code", project_id: "inbox", folder });
    expect(pv.files[1].exists).toBe(true);
    const done = svc.connect(owner, { connection_id: pv.connection_id, client: "claude-code", project_id: "inbox", folder, access: "suggest" });
    expect(done.files.map((f) => [f.role, f.state])).toEqual([["server", "written"], ["hook", "exists"]]);
    expect(done.files[1].contents).toContain("mcp__bibrain__brain_recall");
    expect(readFileSync(join(folder, ".claude", "settings.local.json"), "utf8")).toBe('{"permissions":{"allow":[]}}\n');
    expect(existsSync(join(folder, ".mcp.json"))).toBe(true);
    expect(b.connections(owner)[0]).toMatchObject({ status: "Not connected", files: [{ role: "server", state: "written" }, { role: "hook", state: "exists" }] });
  });
  it("refuses a linked .claude folder or a linked .cursor/rules folder, and a file named .claude, before anything is written", () => {
    const { b, svc, folder, dataDir } = setup();
    const elsewhere = join(dirname(folder), "elsewhere-claude");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(folder, ".claude"), "junction");
    expect(() => svc.preview(owner, { client: "claude-code", project_id: "inbox", folder })).toThrow(/linked \.claude folder/);
    rmSync(join(folder, ".claude"), { recursive: true, force: true });
    mkdirSync(join(folder, ".cursor"));
    symlinkSync(elsewhere, join(folder, ".cursor", "rules"), "junction");
    expect(() => svc.preview(owner, { client: "cursor", project_id: "inbox", folder })).toThrow(/linked \.cursor\/rules folder/);
    rmSync(join(folder, ".cursor"), { recursive: true, force: true });
    writeFileSync(join(folder, ".claude"), "a file where a folder must be");
    const id = "22222222-2222-4222-8222-222222222222";
    expect(() => svc.connect(owner, { connection_id: id, client: "claude-code", project_id: "inbox", folder, access: "read" })).toThrow(/file named \.claude/);
    expect(b.connections(owner)).toEqual([]);
    expect(existsSync(join(dataDir, "agent-keys", `${id}.json`))).toBe(false);
    expect(existsSync(join(folder, ".mcp.json"))).toBe(false);
  });
  it("rolls back the grant, the key and the already written server file when the second write fails", () => {
    // `.cursor` is a real folder (so the pre-checks pass) but `.cursor/rules` is a FILE: the server file is written first,
    // then `mkdirSync(.cursor/rules, { recursive: true })` throws EEXIST on every platform, which is not the "exists" path
    // (that one is EEXIST from the `wx` write of the second file itself) and must roll everything back.
    const { b, svc, folder, dataDir } = setup();
    mkdirSync(join(folder, ".cursor"));
    writeFileSync(join(folder, ".cursor", "rules"), "a file where a folder must be");
    const pv = svc.preview(owner, { client: "cursor", project_id: "inbox", folder });
    expect(() => svc.connect(owner, { connection_id: pv.connection_id, client: "cursor", project_id: "inbox", folder, access: "read" })).toThrow(/could not write \.cursor\/rules\/bibrain\.mdc/);
    // Rolled back exactly as a failed key write is: the grant is revoked (a Revoked row stays), the key file and the server file are gone.
    expect(b.connections(owner).map((c) => [c.status, c.files])).toEqual([["Revoked", []]]);
    expect(existsSync(join(dataDir, "agent-keys", `${pv.connection_id}.json`))).toBe(false);
    expect(existsSync(join(folder, ".cursor", "mcp.json"))).toBe(false);
    expect(readFileSync(join(folder, ".cursor", "rules"), "utf8")).toBe("a file where a folder must be");
  });
  it("writes the Codex hook file next to its config, keeps spaces in paths intact, and forgets the recorded files with the key", () => {
    const { b, s, svc, folder, config } = setup();
    const spaced = { ...config, node: "C:\\Program Files\\nodejs\\node.exe", cli: "C:\\Users\\Ana\\Bi Brain\\apps\\cli\\bibrain.mjs" };
    const spacedSvc = agentConnect(b, spaced);
    const pv = spacedSvc.preview(owner, { client: "codex", project_id: "inbox", folder });
    const done = spacedSvc.connect(owner, { connection_id: pv.connection_id, client: "codex", project_id: "inbox", folder, access: "read" });
    expect(done.files.map((f) => [f.role, f.state])).toEqual([["server", "written"], ["hook", "written"]]);
    const written = JSON.parse(readFileSync(join(folder, ".codex", "hooks.json"), "utf8"));
    const command: string = written.hooks.UserPromptSubmit[0].hooks[0].command;
    expect(command.startsWith('"C:/Program Files/nodejs/node.exe" "C:/Users/Ana/Bi Brain/apps/cli/bibrain.mjs" hook codex --connection ')).toBe(true);
    expect(command).not.toContain("\\");
    expect(s.setting(`agent_files:${pv.connection_id}`, [])).toHaveLength(2);
    svc.forget(pv.connection_id);
    expect(s.setting(`agent_files:${pv.connection_id}`, "gone")).toEqual("gone");
  });
  it("creates .cursor/rules and writes the rule file once", () => {
    const { svc, folder } = setup();
    const pv = svc.preview(owner, { client: "cursor", project_id: "inbox", folder });
    const done = svc.connect(owner, { connection_id: pv.connection_id, client: "cursor", project_id: "inbox", folder, access: "read" });
    expect(done.files.map((f) => [f.role, f.state])).toEqual([["server", "written"], ["rule", "written"]]);
    expect(readFileSync(join(folder, ".cursor", "rules", "bibrain.mdc"), "utf8")).toContain("alwaysApply: true");
  });

  it("is unavailable away from the local app", () => {
    const { b, config, folder } = setup();
    const remote = agentConnect(b, { ...config, available: false, reason: "Adding agents in one step works in the BiBrain app on your computer." });
    expect(remote.status(owner)).toMatchObject({ available: false, reason: expect.stringMatching(/on your computer/) });
    expect(() => remote.preview(owner, { client: "codex", project_id: "inbox", folder })).toThrow(/on your computer/);
  });
});

describe("agent routes", () => {
  it("are owner-only, refuse bad input, and revoke deletes the key", async () => {
    const { b, folder, dataDir, config } = setup();
    const app = await createApp(b, { pairSecret: "test-code", static: false, agents: config });
    cleanup.push(() => void app.close());
    const req = (method: any, url: string, payload?: any, headers: Record<string, string> = {}) =>
      app.inject({ method, url, headers: { host: "127.0.0.1:4317", ...headers }, payload });
    expect((await req("GET", "/api/v1/agents")).statusCode).toBe(401);
    const pairing = await req("POST", "/api/v1/session/pair", { secret: "test-code" });
    const cookie = pairing.cookies[0];
    const headers = { cookie: `${cookie.name}=${cookie.value}`, "x-brain-csrf": pairing.json().csrf };
    expect((await req("GET", "/api/v1/agents", undefined, headers)).json().available).toBe(true);
    expect((await req("POST", "/api/v1/agents/preview", { client: "codex", project_id: "inbox", folder: "relative" }, headers)).statusCode).toBe(400);
    const pv = (await req("POST", "/api/v1/agents/preview", { client: "codex", project_id: "inbox", folder }, headers)).json();
    expect(JSON.stringify(pv)).not.toMatch(/[0-9a-f]{64}/);
    const noCsrf = { cookie: headers.cookie };
    expect((await req("POST", "/api/v1/agents/preview", { client: "codex", project_id: "inbox", folder }, noCsrf)).statusCode).toBe(403);
    const done = await req("POST", "/api/v1/agents/connect", { connection_id: pv.connection_id, client: "codex", project_id: "inbox", folder, access: "suggest" }, headers);
    expect(done.statusCode).toBe(200);
    expect(JSON.stringify(done.json())).not.toMatch(/[0-9a-f]{64}/);
    const keyFile = join(dataDir, "agent-keys", `${pv.connection_id}.json`);
    const { key } = JSON.parse(readFileSync(keyFile, "utf8"));
    expect((await req("POST", "/api/v1/agent/verify", {}, { authorization: `Bearer ${key}` })).statusCode).toBe(200);
    expect(b.connections(owner)[0].status).toBe("Connected");
    expect((await req("POST", "/api/v1/agents/preview", { client: "codex", project_id: "inbox", folder }, { authorization: `Bearer ${key}` })).statusCode).toBe(403);
    expect((await req("DELETE", `/api/v1/agent-grants/${pv.connection_id}`, {}, headers)).statusCode).toBe(200);
    expect(existsSync(keyFile)).toBe(false);
    expect((await req("POST", "/api/v1/agent/verify", {}, { authorization: `Bearer ${key}` })).statusCode).toBe(401);
  });
});
