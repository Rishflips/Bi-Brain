import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../../packages/storage/index.ts";
import { Brain } from "../../packages/domain/service.ts";
import { Worker } from "../../apps/worker/engine.ts";
import { createApp } from "../../apps/server/app.ts";
import type { Principal } from "../../packages/contracts/index.ts";

const owner: Principal = { kind: "owner" };
let cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.reverse()) fn(); cleanup = []; });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "watch-test-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const s = new Storage(join(dir, "brain.sqlite"), { vault: join(dir, "vault") });
  cleanup.push(() => { try { s.close(); } catch {} });
  return new Brain(s, () => new Date("2026-10-24T09:00:00Z"));
}

describe("watching a project", () => {
  it("is on by default, and an unwatched project's cards leave Today but stay in Your brain", () => {
    const b = setup();
    const p = b.createProject(owner, "Northstar");
    b.capture(owner, { project_id: p.id, title: "Status", body: "northstar status active", visibility: "project" });
    expect(b.projects(owner).find((x) => x.id === p.id)?.watched).toBe(true);
    expect(b.brief(owner).items).toHaveLength(1);
    expect(b.watchProject(owner, p.id, { watched: false })).toEqual({ id: p.id, watched: false });
    expect(b.brief(owner).items).toEqual([]);
    expect(b.brainProject(owner, p.id).waiting_for_review).toBeGreaterThan(0);
    b.watchProject(owner, p.id, { watched: true });
    expect(b.brief(owner).items).toHaveLength(1);
  });

  it("never unwatches the Inbox and refuses agents and unknown projects", () => {
    const b = setup();
    expect(() => b.watchProject(owner, "inbox", { watched: false })).toThrow(/Inbox/);
    expect(() => b.watchProject(owner, "nope", { watched: false })).toThrow();
    const g = b.createGrant(owner, { projects: ["inbox"], operations: ["read"], expires_at: "2026-11-24T09:00:00.000Z" });
    expect(() => b.watchProject(b.authenticateAgent(g.token), "inbox", { watched: true })).toThrow();
  });

  it("does not schedule goal reviews for an unwatched project", async () => {
    const b = setup();
    const p = b.createProject(owner, "Northstar");
    const goal = b.goal(owner, { project_id: p.id, title: "Ship", success_criteria: "Shipped" });
    b.editGoal(owner, goal.id, { expected_version: 1, preparation_enabled: true });
    b.prefs(owner, { ...b.prefs(owner), enabled: true, digest_hour: 0, quiet_start: 0, quiet_end: 0 });
    b.watchProject(owner, p.id, { watched: false });
    new Worker(b).schedule();
    expect(b.store.get("SELECT count(*) AS n FROM jobs WHERE kind='review_changed_assumption'")!.n).toBe(0);
  });

  it("is served over HTTP for the owner only", async () => {
    const b = setup();
    const p = b.createProject(owner, "Northstar");
    const app = await createApp(b, { pairSecret: "test-code", static: false });
    cleanup.push(() => void app.close());
    const pair = await app.inject({ method: "POST", url: "/api/v1/session/pair", headers: { host: "127.0.0.1:4317" }, payload: { secret: "test-code" } });
    const c = pair.cookies[0];
    const res = await app.inject({ method: "PUT", url: `/api/v1/projects/${p.id}/watch`, headers: { host: "127.0.0.1:4317", cookie: `${c.name}=${c.value}`, "x-brain-csrf": pair.json().csrf }, payload: { watched: false } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: p.id, watched: false });
  });
});
