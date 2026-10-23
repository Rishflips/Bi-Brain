import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../../packages/storage/index.ts";
import { Brain } from "../../packages/domain/service.ts";
import { createApp } from "../../apps/server/app.ts";
import { takePairToken } from "../../apps/web/pair-link.ts";

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.reverse()) fn();
  cleanup = [];
});
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "pair-link-test-"));
  const s = new Storage(join(dir, "brain.sqlite"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  cleanup.push(() => {
    try {
      s.close();
    } catch {}
  });
  let now = new Date("2026-10-23T09:00:00Z");
  const b = new Brain(s, () => now);
  const app = await createApp(b, { pairSecret: "test-code", static: false });
  cleanup.push(() => void app.close());
  const req = (url: string, payload?: any, headers: Record<string, string> = {}) =>
    app.inject({ method: "POST", url, headers: { host: "127.0.0.1:4317", ...headers }, payload });
  return { b, req, advance: (ms: number) => { now = new Date(now.getTime() + ms); } };
}

describe("one-time pairing link", () => {
  it("needs the installation code, signs in once, then refuses the same link", async () => {
    const { req } = await setup();
    expect((await req("/api/v1/session/pair-link", { secret: "wrong" })).statusCode).toBe(401);
    const minted = await req("/api/v1/session/pair-link", { secret: "test-code" });
    expect(minted.statusCode).toBe(200);
    const { token } = minted.json();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const first = await req("/api/v1/session/pair-link/redeem", { token });
    expect(first.statusCode).toBe(200);
    expect(first.json().csrf).toBeTruthy();
    expect(first.cookies.find((c) => c.name === "brain_session")).toBeTruthy();
    const again = await req("/api/v1/session/pair-link/redeem", { token });
    expect(again.statusCode).toBe(401);
    expect(again.json().error.message).toBe("This link was already used or has expired. Use the installation code instead.");
  });

  it("expires after two minutes and rejects malformed tokens", async () => {
    const { req, advance } = await setup();
    const { token } = (await req("/api/v1/session/pair-link", { secret: "test-code" })).json();
    advance(121_000);
    expect((await req("/api/v1/session/pair-link/redeem", { token })).statusCode).toBe(401);
    expect((await req("/api/v1/session/pair-link/redeem", { token: "not-hex" })).statusCode).toBe(400);
  });
});

describe("takePairToken", () => {
  it("takes the token and removes it from the address bar", () => {
    const calls: string[] = [];
    const hist = { replaceState: (_d: unknown, _u: string, url: string) => calls.push(url) };
    const token = "a".repeat(64);
    expect(takePairToken({ hash: `#pair=${token}`, pathname: "/", search: "" }, hist)).toBe(token);
    expect(calls).toEqual(["/"]);
  });

  it("still returns the token when the browser empties the live hash on replaceState", () => {
    const token = "b".repeat(64);
    const loc = { hash: `#pair=${token}`, pathname: "/", search: "" };
    const hist = { replaceState: () => { loc.hash = ""; } };
    expect(takePairToken(loc, hist)).toBe(token);
  });

  it("leaves other fragments alone and strips a malformed pair fragment", () => {
    const calls: string[] = [];
    const hist = { replaceState: (_d: unknown, _u: string, url: string) => calls.push(url) };
    expect(takePairToken({ hash: "#brain", pathname: "/", search: "" }, hist)).toBeNull();
    expect(calls).toEqual([]);
    expect(takePairToken({ hash: "#pair=xyz", pathname: "/", search: "?a=1" }, hist)).toBeNull();
    expect(calls).toEqual(["/?a=1"]);
  });
});
