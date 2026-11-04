import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createApp } from "../../apps/server/app.ts";
import { AGENT_CONTRACT, agentDisplayName } from "../../packages/domain/agents.ts";
import { buildFixture, owner, type Fixture } from "../eval/recall-fixture.ts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
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
async function setup() {
  dir = mkdtempSync(join(tmpdir(), "agent-contract-"));
  fx = buildFixture(join(dir, "brain.sqlite"));
  const app = await createApp(fx.brain, { pairSecret: "test-code", static: false });
  close = () => app.close();
  const call = (method: "GET" | "POST", url: string, token: string, payload?: Record<string, unknown>) =>
    method === "GET"
      ? app.inject({ method, url, headers: { host: "127.0.0.1:4317", authorization: `Bearer ${token}` } })
      : app.inject({ method, url, headers: { host: "127.0.0.1:4317", authorization: `Bearer ${token}`, "content-type": "application/json" }, payload: payload ?? {} });
  return { f: fx, app, call };
}

describe("bibrain-agent/1 over HTTP", () => {
  it("names the contract in capabilities and accepts hermes as a client on both endpoints, logging it content-free", async () => {
    const { f, call } = await setup();
    expect(AGENT_CONTRACT).toBe("bibrain-agent/1");
    expect((await call("GET", "/api/v1/agent/capabilities", f.agentToken)).json().contract).toBe("bibrain-agent/1");
    const g = f.brain.createGrant(owner, { projects: [f.ids["project:northstar"]], operations: ["read", "propose_memory"], expires_at: "2027-01-01T00:00:00.000Z", client: "hermes" });
    const push = await call("POST", "/api/v1/agent/recall-push", g.token, { prompt: "what colour did we pick for the launch", session_id: sha("h1"), client: "hermes" });
    expect(push.statusCode).toBe(200);
    expect(["full", "pointer", "none"]).toContain(push.json().level);
    const note = await call("POST", "/api/v1/agent/session-note", g.token, { session_id: sha("h1"), client: "hermes", text: "Decided: adapter: hermes first\nOpen question: gateway hooks?" });
    expect(note.statusCode).toBe(200);
    expect(note.json().saved).toBe(true);
    const log = f.brain.recallLog(owner).rows.at(-1)!;
    expect(log.client).toBe("hermes");
    expect(JSON.stringify(log)).not.toContain("launch");
    const notes = f.brain.sessionNoteLog(owner).rows.at(-1)!;
    expect(notes.client).toBe("hermes");
    expect(JSON.stringify(notes)).not.toContain("adapter");
    const shown = f.brain.connections(owner).find((c) => c.id === g.id)!;
    expect(shown.client).toBe("hermes");
    expect(shown.client_name).toBe("Hermes");
    expect(agentDisplayName("hermes")).toBe("Hermes");
    expect(agentDisplayName("something-else")).toBe("A connected agent");
  });
  it("refuses an unknown client name on both endpoints and in createGrant with a plain 400, storing nothing", async () => {
    const { f, call } = await setup();
    const push = await call("POST", "/api/v1/agent/recall-push", f.agentToken, { prompt: "what colour did we pick for the launch", session_id: sha("x"), client: "my-agent" });
    expect(push.statusCode).toBe(400);
    expect(push.json().error.message).toBe("Check the fields and input limits.");
    const before = f.brain.sessionNoteLog(owner).rows.length;
    const g = f.brain.createGrant(owner, { projects: [f.ids["project:northstar"]], operations: ["read", "propose_memory"], expires_at: "2027-01-01T00:00:00.000Z" });
    const note = await call("POST", "/api/v1/agent/session-note", g.token, { session_id: sha("x"), client: "my-agent", text: "Decided: a: b" });
    expect(note.statusCode).toBe(400);
    expect(f.brain.sessionNoteLog(owner).rows.length).toBe(before);
    expect(() => f.brain.createGrant(owner, { projects: ["inbox"], operations: ["read"], expires_at: "2027-01-01T00:00:00.000Z", client: "my-agent" })).toThrow();
  });
});
