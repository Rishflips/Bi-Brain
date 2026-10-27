import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../../packages/storage/index.ts";
import { Brain } from "../../packages/domain/service.ts";
import { createApp } from "../../apps/server/app.ts";
import type { Principal } from "../../packages/contracts/index.ts";

const owner: Principal = { kind: "owner" };
let cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});
describe("better-search routes", () => {
  it("serve the paired owner, refuse everyone else, and carry the domain's refusals as plain 409s", async () => {
    const dir = mkdtempSync(join(tmpdir(), "better-search-http-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const store = new Storage(join(dir, "brain.sqlite"));
    cleanup.push(() => store.close());
    const brain = new Brain(store);
    const app = await createApp(brain, { pairSecret: "synthetic-better-search", static: false });
    cleanup.push(() => app.close());
    const req = (method: any, url: string, payload?: any, headers: Record<string, string> = {}) =>
      app.inject({ method, url, headers: { host: "127.0.0.1:4317", ...headers }, payload });
    expect((await req("GET", "/api/v1/preferences/better-search")).statusCode).toBe(401);
    const pairing = await req("POST", "/api/v1/session/pair", { secret: "synthetic-better-search" });
    const cookie = pairing.cookies[0];
    const headers = { cookie: `${cookie.name}=${cookie.value}`, "x-brain-csrf": pairing.json().csrf };
    const got = await req("GET", "/api/v1/preferences/better-search", undefined, headers);
    expect(got.statusCode).toBe(200);
    expect(got.json()).toMatchObject({ mode: "off", effective: false, status: null, paused_until: null, counts: { total: 0 } });
    const refused = await req("PATCH", "/api/v1/preferences/better-search", { mode: "ollama" }, headers);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.message).toMatch(/background worker starts/);
    expect(store.setting("better_search", null)).toBeNull();
    const off = await req("PATCH", "/api/v1/preferences/better-search", { mode: "off" }, headers);
    expect(off.statusCode).toBe(200);
    expect(off.json()).toEqual({ mode: "off", key: null, consented_at: null });
    expect((await req("PATCH", "/api/v1/preferences/better-search", { mode: "sideways" }, headers)).statusCode).toBe(400);
    const token = brain.createGrant(owner, { projects: ["inbox"], operations: ["read"], expires_at: "2027-01-01T00:00:00.000Z" }).token;
    const agent = await req("GET", "/api/v1/preferences/better-search", undefined, { authorization: `Bearer ${token}` });
    expect([401, 403]).toContain(agent.statusCode);
  });
});
