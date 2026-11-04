import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../apps/server/app.ts";
import { BrainError } from "../../packages/domain/logic.ts";
import { SERVER_INSTRUCTIONS } from "../../apps/mcp/surface.ts";
import { buildFixture, owner, type Fixture } from "../eval/recall-fixture.ts";

let fx: Fixture | null = null;
let dir = "";
let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  await close?.();
  fx?.store.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  fx = null;
  close = null;
});
const ACCEPT = "application/json, text/event-stream";
async function setup() {
  dir = mkdtempSync(join(tmpdir(), "mcp-http-"));
  fx = buildFixture(join(dir, "brain.sqlite"));
  const app = await createApp(fx.brain, { pairSecret: "test-code", static: false });
  close = () => app.close();
  let n = 0;
  const rpc = (token: string | null, method: string, params: unknown = {}, headers: Record<string, string> = {}) =>
    app.inject({
      method: "POST",
      url: "/api/v1/agent/mcp",
      headers: { host: "127.0.0.1:4317", accept: ACCEPT, "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      payload: { jsonrpc: "2.0", id: ++n, method, params },
    });
  const init = (token: string) => rpc(token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  return { f: fx, app, rpc, init };
}

describe("Streamable HTTP MCP", () => {
  it("initializes statelessly with the same instructions, lists only the grant's tools, and recalls with the same cited result as the stdio adapter", async () => {
    const { f, rpc, init } = await setup();
    const hello = await init(f.agentToken);
    expect(hello.statusCode).toBe(200);
    expect(hello.headers["content-type"]).toContain("application/json");
    expect(hello.headers["mcp-session-id"]).toBeUndefined();
    expect(hello.json().result.instructions).toBe(SERVER_INSTRUCTIONS);
    expect(hello.json().result.serverInfo.name).toBe("bi-brain");
    // No session: the next request stands on its own, exactly as the first did.
    const list = await rpc(f.agentToken, "tools/list");
    expect(list.json().result.tools.map((t: any) => t.name)).toEqual(["brain_recall", "brain_open"]);
    expect(list.json().result.tools[0].annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    const recall = await rpc(f.agentToken, "tools/call", { name: "brain_recall", arguments: { query: "what colour did we pick for the launch" } });
    expect(recall.statusCode).toBe(200);
    const body = recall.json().result;
    expect(body.isError).toBeFalsy();
    expect(body.structuredContent.status).not.toBe("no_match");
    expect(body.content[0].text).toContain(body.structuredContent.hits[0].id);
    expect(JSON.stringify(body)).not.toContain(f.ids["src:private-journal"]);
    expect(JSON.stringify(body)).not.toContain("PRIVATE_CANARY_TEXT");
    const full = f.brain.createGrant(owner, { projects: ["inbox"], operations: ["read", "propose_memory", "forget"], expires_at: "2027-01-01T00:00:00.000Z", client: "hermes" });
    expect((await rpc(full.token, "tools/list")).json().result.tools.map((t: any) => t.name)).toEqual(["brain_recall", "brain_open", "brain_note", "brain_propose", "brain_intent", "brain_link", "brain_forget"]);
    // Listing tools is not a call: the badge flips only when a tool really runs, through the same verify() the stdio adapter makes.
    expect(f.brain.connections(owner).find((c) => c.id === full.id)!.status).toBe("Not connected");
    const call = await rpc(full.token, "tools/call", { name: "brain_recall", arguments: { query: "anything at all" } });
    expect(call.statusCode).toBe(200);
    expect(f.brain.connections(owner).find((c) => c.id === full.id)!.status).toBe("Connected");
  });
  it("keeps plan 8's provenance through this door: a note written over HTTP MCP is agent-written and unreviewed when the owner reads it", async () => {
    const { app, f, rpc } = await setup();
    const g = f.brain.createGrant(owner, { projects: ["inbox"], operations: ["read", "propose_memory"], expires_at: "2027-01-01T00:00:00.000Z", client: "hermes" });
    const note = await rpc(g.token, "tools/call", { name: "brain_note", arguments: { project_id: "inbox", decisions: [{ topic: "transport", decision: "streamable http" }], open_questions: [], idempotency_key: "mcp-http-note-1" } });
    expect(note.statusCode).toBe(200);
    expect(note.json().result.isError).toBeFalsy();
    const sourceId = JSON.parse(note.json().result.content[0].text).source_id as string;
    const pair = await app.inject({ method: "POST", url: "/api/v1/session/pair", headers: { host: "127.0.0.1:4317" }, payload: { secret: "test-code" } });
    const cookie = pair.headers["set-cookie"]!.toString().split(";")[0];
    const owned = await app.inject({ method: "GET", url: `/api/v1/sources/${sourceId}`, headers: { host: "127.0.0.1:4317", cookie } });
    expect(owned.statusCode).toBe(200);
    expect(owned.json().written_by).toEqual({ agent: "Hermes", reviewed: false });
  });
  it("is bearer-only: a signed-in browser session with the app's own Origin and CSRF header is refused, and nothing runs", async () => {
    const { app, f } = await setup();
    const pair = await app.inject({ method: "POST", url: "/api/v1/session/pair", headers: { host: "127.0.0.1:4317" }, payload: { secret: "test-code" } });
    const cookie = pair.headers["set-cookie"]!.toString().split(";")[0];
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agent/mcp",
      headers: { host: "127.0.0.1:4317", origin: "http://127.0.0.1:4317", cookie, "x-brain-csrf": pair.json().csrf, accept: ACCEPT, "content-type": "application/json" },
      payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "brain_recall", arguments: { query: "launch" } } },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toBe("Use an agent token.");
    expect(res.body).not.toContain("Northstar");
    // Nothing ran as any connection: no grant was verified by that request.
    expect(f.brain.connections(owner).every((c) => c.status !== "Connected")).toBe(true);
  });
  it("refuses a JSON-RPC batch before anything runs, with one plain sentence", async () => {
    const { app, f } = await setup();
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/agent/mcp",
      headers: { host: "127.0.0.1:4317", authorization: `Bearer ${f.agentToken}`, accept: ACCEPT, "content-type": "application/json" },
      payload: [{ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "brain_recall", arguments: { query: "launch" } } }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toBe("Send one request at a time.");
    expect(f.brain.connections(owner).every((c) => c.status !== "Connected")).toBe(true);
  });
  it("counts each caller separately: inner calls carry the outer address, the route allows 120 a minute (its own stricter bucket, used in place of the global one on this route), and the 121st answers 429 with the security headers", async () => {
    const { app, f } = await setup();
    const from = (remoteAddress: string, method = "tools/list") =>
      app.inject({ method: "POST", url: "/api/v1/agent/mcp", remoteAddress, headers: { host: "127.0.0.1:4317", authorization: `Bearer ${f.agentToken}`, accept: ACCEPT, "content-type": "application/json" }, payload: { jsonrpc: "2.0", id: 1, method, params: {} } });
    for (let i = 0; i < 120; i += 1) expect((await from("10.0.0.1")).statusCode).toBe(200);
    const blocked = await from("10.0.0.1");
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["x-frame-options"]).toBe("DENY");
    expect(blocked.headers["content-security-policy"]).toBeDefined();
    // Another caller is untouched, and so is the caller's own ordinary route: other routes keep the global 1,000, which still has room; this route's 120 does not.
    expect((await from("10.0.0.2")).statusCode).toBe(200);
    const plain = await app.inject({ method: "GET", url: "/api/v1/agent/capabilities", remoteAddress: "10.0.0.1", headers: { host: "127.0.0.1:4317", authorization: `Bearer ${f.agentToken}` } });
    expect(plain.statusCode).toBe(200);
  });
  it("refuses a missing or revoked bearer at once, a foreign Origin, a navigation, GET and DELETE, and an oversized body", async () => {
    const { app, f, rpc, init } = await setup();
    expect((await rpc(null, "tools/list")).statusCode).toBe(401);
    const g = f.brain.createGrant(owner, { projects: ["inbox"], operations: ["read"], expires_at: "2027-01-01T00:00:00.000Z" });
    expect((await init(g.token)).statusCode).toBe(200);
    f.brain.revoke(owner, g.id);
    expect((await init(g.token)).statusCode).toBe(401);
    expect((await rpc(g.token, "tools/call", { name: "brain_recall", arguments: { query: "launch" } })).statusCode).toBe(401);
    expect((await rpc(f.agentToken, "tools/list", {}, { origin: "https://evil.example" })).statusCode).toBe(403);
    expect((await rpc(f.agentToken, "tools/list", {}, { "sec-fetch-mode": "navigate" })).statusCode).toBe(403);
    for (const method of ["GET", "DELETE"] as const) {
      const r = await app.inject({ method, url: "/api/v1/agent/mcp", headers: { host: "127.0.0.1:4317", authorization: `Bearer ${f.agentToken}`, accept: ACCEPT } });
      expect(r.statusCode).toBe(405);
      expect(r.json().error.message).toBe("This address answers POST only; there is no stream to open and no session to end.");
    }
    const big = await app.inject({ method: "POST", url: "/api/v1/agent/mcp", headers: { host: "127.0.0.1:4317", authorization: `Bearer ${f.agentToken}`, accept: ACCEPT, "content-type": "application/json" }, payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "brain_recall", arguments: { query: "x".repeat(300 * 1024) } } } });
    expect(big.statusCode).toBe(413);
  });
  it("sends the security headers on every reply and names the contract and transport in the shared capabilities resource", async () => {
    const { f, rpc } = await setup();
    const r = await rpc(f.agentToken, "tools/list");
    expect(r.headers["x-frame-options"]).toBe("DENY");
    expect(r.headers["content-security-policy"]).toBeDefined();
    const resource = await rpc(f.agentToken, "resources/read", { uri: "brain://capabilities" });
    expect(JSON.parse(resource.json().result.contents[0].text)).toEqual({ tools: ["brain_recall", "brain_open"], projects: [{ id: f.ids["project:northstar"], title: "Northstar" }], surface: "v2", contract: "bibrain-agent/1", transport: "streamable-http", binding: "manual until a client adapter is verified", private_sources: "owner only" });
  });
  it("never reaches an owner route through the inner calls: tool arguments stay in the query string and the agent bearer is refused there anyway", async () => {
    const { app, f, rpc } = await setup();
    const g = f.brain.createGrant(owner, { projects: ["inbox"], operations: ["read", "propose_memory", "forget"], expires_at: "2027-01-01T00:00:00.000Z", client: "hermes" });
    for (const id of ["../../connections", "../sources/" + f.ids["src:private-journal"], "x?y=1#/../../connections"]) {
      const r = await rpc(g.token, "tools/call", { name: "brain_open", arguments: { id } });
      expect(r.statusCode).toBe(200);
      expect(r.json().result.isError).toBe(true);
      expect(r.body).not.toContain("PRIVATE_CANARY_TEXT");
      expect(r.body).not.toContain('"status":"Connected"');
    }
    const owned = await app.inject({ method: "GET", url: "/api/v1/connections", headers: { host: "127.0.0.1:4317", authorization: `Bearer ${g.token}` } });
    expect(owned.statusCode).toBe(403);
  });
  it("answers a failed capabilities lookup as plain HTTP: 401 unchanged and a neutral 502 without the inner body", async () => {
    const { f, rpc } = await setup();
    const real = f.brain.agentCapabilities.bind(f.brain);
    f.brain.agentCapabilities = () => {
      throw new BrainError("UNAUTHORIZED", "Access unavailable.", 401);
    };
    const denied = await rpc(f.agentToken, "tools/list");
    expect(denied.statusCode).toBe(401);
    expect(denied.json().error.message).toBe("Access unavailable.");
    f.brain.agentCapabilities = () => {
      throw new Error("inner detail SECRET_STACK_MARKER");
    };
    const broken = await rpc(f.agentToken, "tools/list");
    expect(broken.statusCode).toBe(502);
    expect(broken.json().error).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", message: "BiBrain could not answer just now; try again shortly.", retryable: true });
    expect(broken.body).not.toContain("SECRET_STACK_MARKER");
    expect(broken.body).not.toContain("operation failed");
    expect(broken.headers["x-frame-options"]).toBe("DENY");
    f.brain.agentCapabilities = real;
    expect((await rpc(f.agentToken, "tools/list")).statusCode).toBe(200);
  });
  it("passes an inner 429 through with its Retry-After when the caller's global bucket is spent", async () => {
    dir = mkdtempSync(join(tmpdir(), "mcp-http-"));
    fx = buildFixture(join(dir, "brain.sqlite"));
    const app = await createApp(fx.brain, { pairSecret: "test-code", static: false, rateLimitMax: 2 });
    close = () => app.close();
    const send = () => app.inject({ method: "POST", url: "/api/v1/agent/mcp", remoteAddress: "10.0.0.9", headers: { host: "127.0.0.1:4317", authorization: `Bearer ${fx!.agentToken}`, accept: ACCEPT, "content-type": "application/json" }, payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} } });
    expect((await send()).statusCode).toBe(200);
    expect((await send()).statusCode).toBe(200);
    const busy = await send();
    expect(busy.statusCode).toBe(429);
    expect(busy.headers["retry-after"]).toBeDefined();
    expect(busy.json().error).toMatchObject({ code: "RATE_LIMITED", message: "BiBrain is busy; try again in a minute.", retryable: true });
    expect(busy.headers["x-frame-options"]).toBe("DENY");
  });
  it("refuses a body that is not JSON with 415 before any JSON-RPC parsing", async () => {
    const { app, f } = await setup();
    const res = await app.inject({ method: "POST", url: "/api/v1/agent/mcp", headers: { host: "127.0.0.1:4317", authorization: `Bearer ${f.agentToken}`, accept: ACCEPT, "content-type": "text/plain" }, payload: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
    expect(res.statusCode).toBe(415);
    expect(res.json().error.message).toBe("Send the request as application/json.");
    expect(res.body).not.toContain("jsonrpc");
    const ok = await app.inject({ method: "POST", url: "/api/v1/agent/mcp", headers: { host: "127.0.0.1:4317", authorization: `Bearer ${f.agentToken}`, accept: ACCEPT, "content-type": "application/json; charset=utf-8" }, payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} } });
    expect(ok.statusCode).toBe(200);
  });
});
