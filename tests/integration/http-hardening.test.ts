import { afterEach, describe, expect, it } from "vitest";
import { Storage } from "../../packages/storage/index.ts";
import { Brain } from "../../packages/domain/service.ts";
import { createApp } from "../../apps/server/app.ts";

let closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.reverse()) await c();
  closers = [];
});
async function paired() {
  const store = new Storage(":memory:");
  const brain = new Brain(store);
  const app = await createApp(brain, { pairSecret: "test-code", static: false });
  closers.push(async () => {
    await app.close();
    store.close();
  });
  const host = { host: "127.0.0.1:4317" };
  const session = await app.inject({ method: "POST", url: "/api/v1/session/pair", headers: host, payload: { secret: "test-code" } });
  const headers = { ...host, cookie: session.headers["set-cookie"]!.toString().split(";")[0], "x-brain-csrf": session.json().csrf };
  return { app, brain, host, headers };
}

describe("HTTP hardening", () => {
  it("refuses a browser navigation to the API except the liveness check", async () => {
    const { app, host, headers } = await paired();
    const nav = { ...headers, "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };
    const refused = await app.inject({ url: "/api/v1/agent/recall?query=anything", headers: nav });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.message).toBe("Open BiBrain from its own page.");
    expect((await app.inject({ url: "/api/v1/today", headers: nav })).statusCode).toBe(403);
    expect((await app.inject({ url: "/api/v1/health/live", headers: { ...host, "sec-fetch-mode": "navigate" } })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/v1/today", headers: { ...headers, "sec-fetch-mode": "cors" } })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/v1/today", headers })).statusCode).toBe(200);
  });

  it("sends frame and content-security headers in every mode", async () => {
    const { app, host, headers } = await paired();
    for (const res of [await app.inject({ url: "/api/v1/health/live", headers: host }), await app.inject({ url: "/api/v1/today", headers })]) {
      expect(res.headers["x-frame-options"]).toBe("DENY");
      expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
    }
  });

  it("bounds the retry key on the owner's proposal route through the same helper as every other route", async () => {
    const { app, headers } = await paired();
    const payload = { project_id: "inbox", title: "Status", text: "northstar status active", type: "fact", entity: "northstar", field: { aspect: "status", value: "active" } };
    // Over the route bound: a plain 400 from the shared helper, before anything is stored.
    expect((await app.inject({ method: "POST", url: "/api/v1/proposals/gate", headers: { ...headers, "idempotency-key": "k".repeat(201) }, payload })).statusCode).toBe(400);
    // Within it (the stored key carries a short prefix, so 150 is comfortably inside): accepted, and a replay returns the same result.
    const ok = await app.inject({ method: "POST", url: "/api/v1/proposals/gate", headers: { ...headers, "idempotency-key": "k".repeat(150) }, payload });
    expect(ok.statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/v1/proposals/gate", headers: { ...headers, "idempotency-key": "k".repeat(150) }, payload })).json()).toEqual(ok.json());
  });

  it("keeps the health checks and the owner's page openable as navigations", async () => {
    const { app, host, headers } = await paired();
    const nav = { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };
    expect((await app.inject({ url: "/api/v1/health/live", headers: { ...host, ...nav } })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/v1/health/ready", headers: { ...headers, ...nav } })).statusCode).toBe(200);
    // Pages outside the API, such as the app root that carries a one-time pairing link, are never refused as navigations.
    expect((await app.inject({ url: "/", headers: { ...host, ...nav } })).statusCode).not.toBe(403);
    // Pairing and its one-time link are page fetches, so they keep working from the app.
    const fetchMode = { ...host, "sec-fetch-mode": "cors" };
    expect((await app.inject({ method: "POST", url: "/api/v1/session/pair", headers: fetchMode, payload: { secret: "test-code" } })).statusCode).toBe(200);
  });
});
