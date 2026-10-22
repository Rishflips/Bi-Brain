import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../../packages/storage/index.ts";
import { Brain } from "../../packages/domain/service.ts";
import { createApp } from "../../apps/server/app.ts";
import type { Principal } from "../../packages/contracts/index.ts";

const owner: Principal = { kind: "owner" };
let cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.reverse()) fn(); cleanup = []; });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "brief-test-"));
  const s = new Storage(join(dir, "brain.sqlite"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  cleanup.push(() => { try { s.close(); } catch {} });
  let date = new Date("2026-10-23T09:00:00Z");
  const b = new Brain(s, () => date);
  return { b, advance: (ms: number) => { date = new Date(date.getTime() + ms); } };
}

describe("Brain.brief", () => {
  it("shows a memory found in an explicit decision, and drops it when its original is withdrawn", () => {
    const { b } = setup();
    const saved = b.capture(owner, { title: "Decision", body: "We decided that Northstar beta is invite only." }) as any;
    const brief = b.brief(owner);
    expect(brief.items).toHaveLength(1);
    expect(brief.items[0]).toMatchObject({ kind: "memory", target: { type: "gate" } });
    expect(brief.items[0].evidence[0].quote).toContain("invite only");
    b.removeSource(owner, saved.source_id, 1, false);
    expect(b.brief(owner).items).toEqual([]);
  });

  it("keeps a dismissed item hidden and rejects other principals", () => {
    const { b } = setup();
    b.capture(owner, { title: "Decision", body: "We decided that Northstar beta is invite only." });
    const [item] = b.brief(owner).items;
    expect(b.dismissBriefItem(owner, { signature: item.signature })).toEqual({ dismissed: true });
    expect(b.brief(owner).items).toEqual([]);
    expect(() => b.brief({ kind: "agent", grant_id: "nope" } as any)).toThrow();
  });

  it("confirms a current claim and refuses unknown ids", () => {
    const { b } = setup();
    b.capture(owner, { title: "Decision", body: "We decided that Northstar beta is invite only." });
    const [item] = b.brief(owner).items;
    const reviewed = b.reviewGate(owner, item.target.id, { action: "accept", expected_version: item.target.version }) as any;
    const claimId = reviewed.claim_ids[0];
    expect(b.confirmClaim(owner, claimId)).toEqual({ id: claimId, confirmed_at: "2026-10-23T09:00:00.000Z" });
    expect(() => b.confirmClaim(owner, "missing")).toThrow(/unavailable/i);
  });
});

describe("brief routes", () => {
  it("serve the brief to the paired owner only", async () => {
    const { b } = setup();
    const app = await createApp(b, { pairSecret: "test-code", static: false });
    cleanup.push(() => void app.close());
    const req = (method: any, url: string, payload?: any, headers: Record<string, string> = {}) =>
      app.inject({ method, url, headers: { host: "127.0.0.1:4317", ...headers }, payload });
    expect((await req("GET", "/api/v1/brief")).statusCode).toBe(401);
    const pairing = await req("POST", "/api/v1/session/pair", { secret: "test-code" });
    const cookie = pairing.cookies[0];
    const headers = { cookie: `${cookie.name}=${cookie.value}`, "x-brain-csrf": pairing.json().csrf };
    await req("POST", "/api/v1/sources", { title: "Decision", body: "We decided that Northstar beta is invite only." }, headers);
    const brief = await req("GET", "/api/v1/brief", undefined, headers);
    expect(brief.statusCode).toBe(200);
    expect(brief.json().items).toHaveLength(1);
    const bad = await req("POST", "/api/v1/brief/dismiss", { signature: "x".repeat(400) }, headers);
    expect(bad.statusCode).toBe(400);
    const ok = await req("POST", "/api/v1/brief/dismiss", { signature: brief.json().items[0].signature }, headers);
    expect(ok.statusCode).toBe(200);
    expect((await req("GET", "/api/v1/brief", undefined, headers)).json().items).toEqual([]);
  });
});
