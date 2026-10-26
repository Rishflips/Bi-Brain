import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../apps/server/app.ts";
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
async function setup() {
  dir = mkdtempSync(join(tmpdir(), "agent-recall-http-"));
  fx = buildFixture(join(dir, "brain.sqlite"));
  const app = await createApp(fx.brain, { pairSecret: "test-code", static: false });
  close = () => app.close();
  const get = (url: string, token = fx!.agentToken) => app.inject({ method: "GET", url, headers: { host: "127.0.0.1:4317", authorization: `Bearer ${token}` } });
  return { f: fx, app, get };
}

describe("agent HTTP v2", () => {
  it("lists the v2 tools with the readable projects, and only two tools for a read-only grant", async () => {
    const { f, get } = await setup();
    const caps = (await get("/api/v1/agent/capabilities")).json();
    expect(caps).toEqual({ operations: ["read"], tools: ["brain_recall", "brain_open"], projects: [{ id: f.ids["project:northstar"], title: "Northstar" }], surface: "v2" });
    const full = f.brain.createGrant(owner, { projects: ["inbox"], operations: ["read", "propose_memory", "forget"], expires_at: "2027-01-01T00:00:00.000Z" });
    expect((await get("/api/v1/agent/capabilities", full.token)).json().tools).toEqual(["brain_recall", "brain_open", "brain_note", "brain_propose", "brain_intent", "brain_link", "brain_forget"]);
    expect(JSON.stringify(caps)).not.toMatch(/brain\./);
  });
  it("recalls without a project_id across every readable project, with history and limit, and refuses bad input", async () => {
    const { f, get } = await setup();
    const res = await get("/api/v1/agent/recall?query=launch%20color");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("found");
    expect(body.hits[0]).toMatchObject({ kind: "fact", id: f.ids["fact:launch-color"], freshness: "current", project: { title: "Northstar" } });
    expect(body.searched).toMatchObject({ query: "launch color", history: false, index_complete: true, projects: [{ id: f.ids["project:northstar"], title: "Northstar" }] });
    const history = (await get("/api/v1/agent/recall?query=Northstar%20status&history=true&limit=20")).json();
    expect(history.hits.some((h: any) => h.id === f.ids["fact:status-old"] && h.freshness === "replaced")).toBe(true);
    expect((await get("/api/v1/agent/recall?query=" + encodeURIComponent("x".repeat(501)))).statusCode).toBe(400);
    expect((await get("/api/v1/agent/recall?query=x&limit=21")).statusCode).toBe(400);
    expect((await get("/api/v1/agent/recall?query=x&mode=raw")).statusCode).toBe(400);
    expect((await get(`/api/v1/agent/recall?query=hydra&project_id=${f.ids["project:hydra"]}`)).statusCode).toBe(404);
    expect((await get("/api/v1/agent/recall?query=cobalt", "0".repeat(64))).statusCode).toBe(401);
  });
  it("opens an original and a fact by id, compares versions, and hides private, foreign and identity items", async () => {
    const { f, get } = await setup();
    const original = (await get(`/api/v1/agent/open?id=${f.ids["src:launch-notes"]}`)).json();
    expect(original).toMatchObject({ kind: "source", item: { id: f.ids["src:launch-notes"], version: 1, title: "Launch notes" } });
    const fact = (await get(`/api/v1/agent/open?id=${f.ids["fact:status-new"]}`)).json();
    expect(fact.kind).toBe("claim");
    expect(fact.item.replaces).toEqual([f.ids["fact:status-old"]]);
    expect(fact.item.replaced_by).toBeNull();
    f.brain.editSource(owner, f.ids["src:launch-notes"], { title: "Launch notes", body: "The launch color is cobalt, confirmed.", expected_version: 1 });
    const compared = (await get(`/api/v1/agent/open?id=${f.ids["src:launch-notes"]}&version=2&compare_version=1`)).json();
    expect(compared.compare).toMatchObject({ from_version: 1, to_version: 2, changed: true });
    for (const key of ["src:private-journal", "src:hydra-deploy", "src:prefs", "fact:owner-name", "fact:owner-pref", "fact:hydra-deploy"]) {
      const denied = await get(`/api/v1/agent/open?id=${f.ids[key]}`);
      expect(denied.statusCode, key).toBe(404);
      expect(denied.body).not.toContain("CANARY");
    }
    // An owner_private fact is hidden at its current AND its historical versions (agentGet's historical branch checked only name/preference before).
    const northstar = f.ids["project:northstar"];
    const priv = f.brain.createEntity(northstar, "claim", { entity: "Launch mood", aspect: "statement", value: "OWNER_PRIVATE_CANARY_V1", status: "current", authority: "owner_private", valid_from: "2026-10-24T00:00:00.000Z", recorded_at: "2026-10-24T00:00:00.000Z", evidence: [{ source_id: f.ids["src:palette-review"], source_version: 1, start: 0, end: 5, quote: "Marco" }], supersedes: [], conflicts_with: [] });
    f.brain.revise(priv, { ...priv.data, value: "OWNER_PRIVATE_CANARY_V2" });
    for (const url of [`/api/v1/agent/open?id=${priv.id}`, `/api/v1/agent/open?id=${priv.id}&version=1`, `/api/v1/agent/open?id=${priv.id}&version=2&compare_version=1`]) {
      const denied = await get(url);
      expect(denied.statusCode, url).toBe(404);
      expect(denied.body).not.toContain("OWNER_PRIVATE_CANARY");
    }
    expect((await get(`/api/v1/agent/open?id=${f.ids["fact:status-new"]}&version=1`)).statusCode).toBe(200);
  });
  it("no longer serves the v1 read routes, even for a readable project and a real item", async () => {
    const { f, get } = await setup();
    const project = f.ids["project:northstar"];
    const id = f.ids["src:launch-notes"];
    for (const path of [`/api/v1/agent/search?project_id=${project}&query=launch`, `/api/v1/agent/get?project_id=${project}&object_id=${id}`, `/api/v1/agent/ask?project_id=${project}&question=launch`, `/api/v1/agent/diff?project_id=${project}&object_id=${id}&from_version=1&to_version=2`]) {
      const res = await get(path);
      expect(res.statusCode, path).toBe(404);
      expect(res.json().message, path).toMatch(/^Route GET:.* not found$/);
    }
  });
});
