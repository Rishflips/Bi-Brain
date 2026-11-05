import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../../packages/storage/index.ts";
import { Brain } from "../../packages/domain/service.ts";
import { createApp } from "../../apps/server/app.ts";
import { publishBetterSearchStatus } from "../../apps/worker/embed.ts";
import { BETTER_SEARCH, EMBED_VISIBILITIES, modelKey } from "../../packages/domain/better-search.ts";
import { pendingEmbedRows, writeEmbeddings } from "../../packages/storage/recall-vectors.ts";
import { FAKE_EMBED_DIM, FAKE_EMBED_MODEL, fakeEmbed } from "../helpers/fake-embed.mjs";
import type { Principal } from "../../packages/contracts/index.ts";

const owner: Principal = { kind: "owner" };
const KEY = modelKey("ollama", FAKE_EMBED_MODEL);
let cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});
function brainWith(status: { detected: boolean; provider?: "ollama" | "cloudflare"; heartbeat?: boolean } | null) {
  const dir = mkdtempSync(join(tmpdir(), "better-search-auto-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Storage(join(dir, "brain.sqlite"));
  cleanup.push(() => store.close());
  const brain = new Brain(store);
  if (status) {
    const provider = status.provider ?? "ollama";
    publishBetterSearchStatus(brain, { configured: true, provider, model: FAKE_EMBED_MODEL, key: modelKey(provider, FAKE_EMBED_MODEL), label: provider, detected: status.detected, probe: status.detected ? "found" : "no_ollama" });
    if (status.heartbeat !== false) store.set("worker_heartbeat", brain.now());
  }
  return { store, brain };
}

describe("automatic Better search", () => {
  it("reads an absent choice as on when the worker found Ollama with the model, without writing a row, and queues the backfill", () => {
    const { store, brain } = brainWith({ detected: true });
    expect(brain.betterSearchSetting()).toEqual({ mode: "ollama", key: KEY, consented_at: null, automatic: true });
    expect(brain.betterSearchAllowed()).toMatchObject({ on: true, reason: "ready" });
    expect(store.setting(BETTER_SEARCH, null)).toBeNull();
    const card = brain.betterSearch(owner);
    expect(card).toMatchObject({ mode: "ollama", automatic: true, detected: true, probe: "found", effective: true, consented_at: null });
    brain.capture(owner, { title: "Morning rhythm", body: "The crew sync is at 9 every morning.", visibility: "project", separate: true });
    expect(store.get("SELECT 1 FROM jobs WHERE kind='embed_batch' AND status IN ('queued','retry_wait','running')")).toBeTruthy();
    expect(pendingEmbedRows(store, KEY, EMBED_VISIBILITIES.ollama, 10).length).toBeGreaterThan(0);
  });
  it("stays off when the model was not detected, when the provider is Cloudflare, or when no status exists; a stale heartbeat makes it words only", () => {
    expect(brainWith({ detected: false }).brain.betterSearchSetting().mode).toBe("off");
    expect(brainWith({ detected: true, provider: "cloudflare" }).brain.betterSearchSetting().mode).toBe("off");
    expect(brainWith(null).brain.betterSearchSetting().mode).toBe("off");
    const stale = brainWith({ detected: true, heartbeat: false });
    expect(stale.brain.betterSearchSetting().automatic).toBe(true);
    expect(stale.brain.betterSearchAllowed()).toMatchObject({ on: false, reason: expect.stringMatching(/background worker is not running/u) });
  });
  it("keeps an explicit Off whatever the probe found, and an explicit On keeps the vectors already prepared", () => {
    const { store, brain } = brainWith({ detected: true });
    brain.setBetterSearch(owner, { mode: "off" });
    expect(store.setting(BETTER_SEARCH, null)).toEqual({ mode: "off", key: null, consented_at: null });
    expect(brain.betterSearchSetting()).toEqual({ mode: "off", key: null, consented_at: null });
    expect(brain.betterSearch(owner)).toMatchObject({ mode: "off", automatic: false, detected: true, effective: false });
    // The owner chooses it explicitly: the row is stored with consent, and vectors under the same key are kept.
    store.run("DELETE FROM settings WHERE key=?", BETTER_SEARCH);
    brain.capture(owner, { title: "Morning rhythm", body: "The crew sync is at 9 every morning.", visibility: "project", separate: true });
    const rows = pendingEmbedRows(store, KEY, EMBED_VISIBILITIES.ollama, 32);
    store.transaction(() => writeEmbeddings(store, KEY, FAKE_EMBED_DIM, rows.map((r) => ({ ...r, vector: Float32Array.from(fakeEmbed(r.text)) }))));
    const embedded = () => Number(store.get<{ n: number }>("SELECT count(*) AS n FROM recall_chunks WHERE embedding IS NOT NULL")!.n);
    expect(embedded()).toBeGreaterThan(0);
    const chosen = brain.setBetterSearch(owner, { mode: "ollama" });
    expect(chosen).toMatchObject({ mode: "ollama", key: KEY });
    expect(typeof chosen.consented_at).toBe("string");
    expect(brain.betterSearchSetting().automatic).toBeUndefined();
    expect(embedded()).toBeGreaterThan(0);
  });
  it("serves the automatic state to the paired owner and turns it off on request", async () => {
    const { store, brain } = brainWith({ detected: true });
    const app = await createApp(brain, { pairSecret: "synthetic-auto", static: false });
    cleanup.push(() => app.close());
    const req = (method: any, url: string, payload?: any, headers: Record<string, string> = {}) => app.inject({ method, url, headers: { host: "127.0.0.1:4317", ...headers }, payload });
    const pairing = await req("POST", "/api/v1/session/pair", { secret: "synthetic-auto" });
    const cookie = pairing.cookies[0];
    const headers = { cookie: `${cookie.name}=${cookie.value}`, "x-brain-csrf": pairing.json().csrf };
    expect((await req("GET", "/api/v1/preferences/better-search", undefined, headers)).json()).toMatchObject({ mode: "ollama", automatic: true, detected: true, effective: true });
    expect((await req("PATCH", "/api/v1/preferences/better-search", { mode: "off" }, headers)).statusCode).toBe(200);
    expect(store.setting(BETTER_SEARCH, null)).toEqual({ mode: "off", key: null, consented_at: null });
    expect((await req("GET", "/api/v1/preferences/better-search", undefined, headers)).json()).toMatchObject({ mode: "off", automatic: false, detected: true });
    const token = brain.createGrant(owner, { projects: ["inbox"], operations: ["read"], expires_at: "2027-01-01T00:00:00.000Z" }).token;
    expect((await req("GET", "/api/v1/preferences/better-search", undefined, { authorization: `Bearer ${token}` })).statusCode).toBe(403);
  });
});
