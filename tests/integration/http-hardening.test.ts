import { afterEach, describe, expect, it } from "vitest";
import { Storage } from "../../packages/storage/index.ts";
import { Brain } from "../../packages/domain/service.ts";
import { createApp } from "../../apps/server/app.ts";
import { ManagedRuntime } from "../../packages/runtime/managed.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

  it("bounds the retry key on the owner's proposal route so the stored key fits, refusing longer keys before anything is stored", async () => {
    const { app, brain, headers } = await paired();
    const payload = { project_id: "inbox", title: "Status", text: "northstar status active", type: "fact", entity: "northstar", field: { aspect: "status", value: "active" } };
    const stored = () => [brain.store.get("SELECT COUNT(*) AS n FROM sources")!.n, brain.store.get("SELECT COUNT(*) AS n FROM idempotency")!.n];
    const before = stored();
    // Over the route bound (200 less the stored "propose:" prefix): a plain 400, and nothing is stored.
    for (const length of [201, 193]) {
      const refused = await app.inject({ method: "POST", url: "/api/v1/proposals/gate", headers: { ...headers, "idempotency-key": "k".repeat(length) }, payload });
      expect(refused.statusCode).toBe(400);
      expect(refused.json().error.code).toBe("INVALID_INPUT");
    }
    expect(stored()).toEqual(before);
    // At the bound: accepted, and a replay returns the same result.
    const ok = await app.inject({ method: "POST", url: "/api/v1/proposals/gate", headers: { ...headers, "idempotency-key": "k".repeat(192) }, payload });
    expect(ok.statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/v1/proposals/gate", headers: { ...headers, "idempotency-key": "k".repeat(192) }, payload })).json()).toEqual(ok.json());
  });

  it("sends the security headers on Host and Origin refusals too", async () => {
    const { app } = await paired();
    for (const res of [
      await app.inject({ url: "/api/v1/today", headers: { host: "evil.test" } }),
      await app.inject({ url: "/api/v1/today", headers: { host: "127.0.0.1:4317", origin: "https://evil.test" } }),
    ]) {
      expect(res.statusCode).toBe(403);
      expect(res.headers["x-frame-options"]).toBe("DENY");
      expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
    }
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

  // Each protected path, with spellings the router resolves to the same route.
  const encodedVariants = (path: string) => [
    path.replace("/api/", "/%61pi/"),
    path.replace("/api/", "/%61%70%69/"),
    path.replace("/v1/", "/%76%31/"),
    path.replace(/\/([a-z])([a-z-]*)$/, (_m, c: string, rest: string) => `/%${c.charCodeAt(0).toString(16)}${rest}`),
    path.replace(/\/([a-z])([a-z-]*)$/, (_m, c: string, rest: string) => `/%${c.charCodeAt(0).toString(16).toUpperCase()}${rest}`),
  ];
  const expectEncodedRefused = async (app: Awaited<ReturnType<typeof createApp>>, path: string, headers: Record<string, string>) => {
    for (const variant of encodedVariants(path)) {
      expect(variant).not.toBe(path);
      for (const extra of [{}, { "sec-fetch-mode": "navigate" }]) {
        const res = await app.inject({ url: variant, headers: { ...headers, ...extra } });
        expect(res.statusCode, variant).toBe(400);
        expect(res.json().error.message).toBe("Request path not allowed.");
        expect(res.headers["x-frame-options"]).toBe("DENY");
      }
    }
  };

  it("refuses encoded spellings of API paths before any gate, in local mode", async () => {
    const { app, host, headers } = await paired();
    for (const path of ["/api/v1/today", "/api/v1/agent/recall", "/api/v1/health/ready", "/api/v1/health/live"]) {
      await expectEncodedRefused(app, path, host);
      await expectEncodedRefused(app, path, headers);
    }
    // The plain paths keep their gate results.
    expect((await app.inject({ url: "/api/v1/today", headers: host })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/v1/today", headers })).statusCode).toBe(200);
    // An encoded reserved character stays encoded for the router too, so it only ever reaches a parameter.
    const reserved = await app.inject({ url: "/api/v1/sources/a%2Fb", headers: host });
    expect(reserved.statusCode).toBe(401);
    expect((await app.inject({ url: "/api/v1/sources/a%2Fb", headers })).statusCode).toBe(404);
  });

  it("refuses encoded spellings of API paths before any gate, when self-hosted over HTTPS", async () => {
    const store = new Storage(":memory:");
    const app = await createApp(new Brain(store), { pairSecret: "s".repeat(40), publicOrigin: "https://brain.example.test", static: false });
    closers.push(async () => {
      await app.close();
      store.close();
    });
    const host = { host: "brain.example.test" };
    for (const path of ["/api/v1/today", "/api/v1/agent/recall", "/api/v1/health/ready"]) await expectEncodedRefused(app, path, host);
    expect((await app.inject({ url: "/api/v1/today", headers: host })).statusCode).toBe(401);
  });

  it("refuses encoded spellings of API paths before any gate, in managed mode", async () => {
    const root = mkdtempSync(join(tmpdir(), "bibrain-http-hardening-"));
    const runtime = new ManagedRuntime(root, { clock: () => new Date() });
    const app = await createApp(undefined, { managed: runtime, publicOrigin: "https://brain.example.test", static: false });
    closers.push(async () => {
      await app.close();
      runtime.close();
      rmSync(root, { recursive: true, force: true });
    });
    const host = { host: "brain.example.test" };
    for (const path of ["/api/v1/today", "/api/v1/agent/recall", "/api/v1/billing/status", "/api/v1/health/ready"]) await expectEncodedRefused(app, path, host);
    expect((await app.inject({ url: "/api/v1/today", headers: host })).statusCode).toBe(401);
    expect((await app.inject({ url: "/api/v1/billing/status", headers: host })).statusCode).toBe(401);
  });
});
