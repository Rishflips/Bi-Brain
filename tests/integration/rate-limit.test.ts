import { afterEach, describe, expect, it } from "vitest";
import { Storage } from "../../packages/storage/index.ts";
import { Brain } from "../../packages/domain/service.ts";
import { createApp } from "../../apps/server/app.ts";

let closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.reverse()) await c();
  closers = [];
});
const secret = "synthetic-owner-code-at-least-32-chars";
async function app(publicOrigin?: string) {
  const store = new Storage(":memory:");
  const brain = new Brain(store);
  const a = await createApp(brain, { pairSecret: secret, publicOrigin, static: false, rateLimitMax: 5 });
  closers.push(async () => {
    await a.close();
    store.close();
  });
  return a;
}
const live = "/api/v1/health/live";

describe("rate limiting", () => {
  it("self-host: keys on the client address the proxy forwards, so one client's flood leaves the owner served, and a forwarded Host is still refused", async () => {
    const a = await app("https://brain.example.test");
    const host = { host: "brain.example.test" };
    const from = (ip: string, extra: Record<string, string> = {}) => ({ headers: { ...host, "x-forwarded-for": ip, ...extra }, remoteAddress: "172.18.0.2" });
    for (let i = 0; i < 5; i++) expect((await a.inject({ url: live, ...from("203.0.113.9") })).statusCode).toBe(200);
    expect((await a.inject({ url: live, ...from("203.0.113.9") })).statusCode).toBe(429);
    // Another client behind the same proxy hop has its own bucket.
    expect((await a.inject({ url: live, ...from("198.51.100.4") })).statusCode).toBe(200);
    // The owner, from a third address, pairs and is served while the flood is still refused.
    const paired = await a.inject({ method: "POST", url: "/api/v1/session/pair", ...from("192.0.2.7", { origin: "https://brain.example.test" }), payload: { secret } });
    expect(paired.statusCode).toBe(200);
    const cookie = paired.headers["set-cookie"]!.toString().split(";")[0];
    expect((await a.inject({ url: "/api/v1/today", ...from("192.0.2.7", { cookie }) })).statusCode).toBe(200);
    expect((await a.inject({ url: live, ...from("203.0.113.9") })).statusCode).toBe(429);
    // Only the hop the proxy adds counts: a client-supplied first address is not the key.
    expect((await a.inject({ url: live, ...from("10.9.9.9, 203.0.113.9") })).statusCode).toBe(429);
    // Forwarded headers never change the Host check.
    expect((await a.inject({ url: live, headers: { host: "evil.test", "x-forwarded-host": "brain.example.test", "x-forwarded-for": "192.0.2.8" }, remoteAddress: "172.18.0.2" })).statusCode).toBe(403);
  });

  it("local mode is unchanged: one bucket per loopback address, a forwarded address is ignored, and a cookie or bearer never opens a fresh bucket", async () => {
    const a = await app();
    const host = { host: "127.0.0.1:4317" };
    for (let i = 0; i < 5; i++) expect((await a.inject({ url: live, headers: { ...host, "x-forwarded-for": `203.0.113.${i}` }, remoteAddress: "127.0.0.1" })).statusCode).toBe(200);
    expect((await a.inject({ url: live, headers: { ...host, "x-forwarded-for": "203.0.113.99" }, remoteAddress: "127.0.0.1" })).statusCode).toBe(429);
    expect((await a.inject({ url: live, headers: { ...host, cookie: `brain_session=${"a".repeat(64)}` }, remoteAddress: "127.0.0.1" })).statusCode).toBe(429);
    expect((await a.inject({ url: live, headers: { ...host, authorization: `Bearer ${"b".repeat(64)}` }, remoteAddress: "127.0.0.1" })).statusCode).toBe(429);
  });

  it("the pairing routes keep their own cap per address: twelve attempts with twelve different cookies are refused after ten", async () => {
    const a = await app();
    const host = { host: "127.0.0.1:4317" };
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await a.inject({ method: "POST", url: "/api/v1/session/pair", headers: { ...host, cookie: `brain_session=${String(i).repeat(32).slice(0, 64)}` }, remoteAddress: "127.0.0.1", payload: { secret: "wrong" } })).statusCode);
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes.slice(10)).toEqual([429, 429]);
  });

  it("a refused request carries the same fixed security headers as every other response", async () => {
    const a = await app();
    const host = { host: "127.0.0.1:4317" };
    let last;
    for (let i = 0; i < 11; i++) last = await a.inject({ method: "POST", url: "/api/v1/session/pair", headers: host, remoteAddress: "127.0.0.1", payload: { secret: "wrong" } });
    expect(last!.statusCode).toBe(429);
    expect(last!.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(last!.headers["x-frame-options"]).toBe("DENY");
    expect(last!.headers["x-content-type-options"]).toBe("nosniff");
    expect(last!.headers["cache-control"]).toBe("no-store");
  });
});
