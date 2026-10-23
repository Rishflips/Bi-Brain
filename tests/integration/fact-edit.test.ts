import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../../packages/storage/index.ts";
import { Brain } from "../../packages/domain/service.ts";
import { createApp } from "../../apps/server/app.ts";
import type { Principal } from "../../packages/contracts/index.ts";

const owner: Principal = { kind: "owner" };
const DECISION = "We decided that Northstar beta is invite only.";
let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.reverse()) fn();
  cleanup = [];
});
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "fact-edit-test-"));
  const s = new Storage(join(dir, "brain.sqlite"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  cleanup.push(() => {
    try {
      s.close();
    } catch {}
  });
  const b = new Brain(s, () => new Date("2026-10-23T09:00:00Z"));
  const saved = b.capture(owner, { title: "Decision", body: DECISION }) as any;
  const [item] = b.brief(owner).items;
  const kept = b.reviewGate(owner, item.target.id, {
    action: "accept",
    expected_version: item.target.version,
  }) as any;
  const [claim] = b.currentClaims(owner, "inbox");
  return { b, saved, claim, gateId: item.target.id, gateVersion: kept.gate_version as number };
}

describe("Brain.reviseClaim", () => {
  it("saves the owner's wording as a new version and keeps the history", () => {
    const { b, claim } = setup();
    expect(b.reviseClaim(owner, claim.id, { expected_version: 1, value: "invite only until launch" })).toEqual({
      id: claim.id,
      version: 2,
      unchanged: false,
    });
    expect(b.currentClaims(owner, "inbox")[0].data).toMatchObject({
      value: "invite only until launch",
      edited_by_owner: true,
    });
    expect(b.brainProject(owner, "inbox").facts[0]).toMatchObject({ version: 2, edited_by_owner: true });
    const history = b.claimHistory(owner, claim.id);
    expect(history.map((h) => h.version)).toEqual([1, 2]);
    expect(history[0].text).toContain("invite only");
    expect(history[1]).toMatchObject({ edited_by_owner: true, status: "current" });
    expect(history[1].text).toContain("until launch");
  });

  it("refuses a stale version, so a second tab or a late undo cannot overwrite a later edit", () => {
    const { b, claim } = setup();
    b.reviseClaim(owner, claim.id, { expected_version: 1, value: "invite only until launch" });
    expect(() => b.reviseClaim(owner, claim.id, { expected_version: 1, value: "open to everyone" })).toThrow(
      /changed since you opened it/i,
    );
    expect(b.currentClaims(owner, "inbox")[0].data.value).toBe("invite only until launch");
  });

  it("makes Today's Undo for the kept memory refuse once the fact was edited", () => {
    const { b, claim, gateId, gateVersion } = setup();
    b.reviseClaim(owner, claim.id, { expected_version: 1, value: "invite only until launch" });
    expect(() => b.reviewGate(owner, gateId, { action: "undo", expected_version: gateVersion })).toThrow(
      /will not overwrite/i,
    );
    expect(b.currentClaims(owner, "inbox")[0].data.value).toBe("invite only until launch");
  });

  it("edits only current statements, within 1,000 characters, for the owner", () => {
    const { b, claim } = setup();
    expect(() => b.reviseClaim(owner, claim.id, { expected_version: 1, value: "x".repeat(1001) })).toThrow();
    expect(() => b.reviseClaim(owner, claim.id, { expected_version: 1, value: "   " })).toThrow();
    expect(() =>
      b.reviseClaim({ kind: "agent", grant_id: "nope" } as Principal, claim.id, { expected_version: 1, value: "x" }),
    ).toThrow();
    expect(b.reviseClaim(owner, claim.id, { expected_version: 1, value: String(claim.data.value) })).toEqual({
      id: claim.id,
      version: 1,
      unchanged: true,
    });
    b.retireClaim(owner, claim.id, 1);
    expect(() => b.reviseClaim(owner, claim.id, { expected_version: 2, value: "x" })).toThrow(/replaced or retired/i);
    expect(b.claimHistory(owner, claim.id).at(-1)).toMatchObject({ status: "retired" });
  });

  it("refuses an edit once the original was withdrawn", () => {
    const { b, saved, claim } = setup();
    b.removeSource(owner, saved.source_id, 1, false);
    expect(() => b.reviseClaim(owner, claim.id, { expected_version: 1, value: "x" })).toThrow();
  });
});

describe("fact routes", () => {
  it("serve edits and history to the paired owner only", async () => {
    const { b, claim } = setup();
    const app = await createApp(b, { pairSecret: "test-code", static: false });
    cleanup.push(() => void app.close());
    const req = (method: any, url: string, payload?: any, headers: Record<string, string> = {}) =>
      app.inject({ method, url, headers: { host: "127.0.0.1:4317", ...headers }, payload });
    expect((await req("GET", `/api/v1/claims/${claim.id}/history`)).statusCode).toBe(401);
    const pairing = await req("POST", "/api/v1/session/pair", { secret: "test-code" });
    const cookie = pairing.cookies[0];
    const headers = { cookie: `${cookie.name}=${cookie.value}`, "x-brain-csrf": pairing.json().csrf };
    const ok = await req("POST", `/api/v1/claims/${claim.id}/revise`, { expected_version: 1, value: "invite only until launch" }, headers);
    expect(ok.statusCode).toBe(200);
    const stale = await req("POST", `/api/v1/claims/${claim.id}/revise`, { expected_version: 1, value: "again" }, headers);
    expect(stale.statusCode).toBe(409);
    const extra = await req("POST", `/api/v1/claims/${claim.id}/revise`, { expected_version: 2, value: "x", y: 1 }, headers);
    expect(extra.statusCode).toBe(400);
    const history = await req("GET", `/api/v1/claims/${claim.id}/history`, undefined, headers);
    expect(history.json().map((h: any) => h.version)).toEqual([1, 2]);
  });
});
