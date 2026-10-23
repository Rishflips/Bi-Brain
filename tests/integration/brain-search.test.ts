import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../../packages/storage/index.ts";
import { Brain } from "../../packages/domain/service.ts";
import { createApp } from "../../apps/server/app.ts";
import type { Entity, Principal, Source } from "../../packages/contracts/index.ts";
import { findInBrain, snippetFor } from "../../packages/domain/brain-search.ts";

const owner: Principal = { kind: "owner" };
const src = (id: string, title: string, body: string, state = "active"): Source => ({
  id,
  project_id: "inbox",
  version: 1,
  title,
  body,
  visibility: "project",
  state,
  captured_at: "2026-10-20T09:00:00Z",
  origin: "manual",
});
const claim = (id: string, entity: string, value: string, evidence: unknown[] = [{ source_id: "a", source_version: 1, start: 0, end: 4, quote: "Beta" }]): Entity => ({
  id,
  project_id: "inbox",
  kind: "claim",
  version: 1,
  created_at: "2026-10-20T09:00:00Z",
  data: { entity, aspect: "statement", value, evidence },
});

describe("findInBrain", () => {
  it("finds facts by their wording and originals by title or body, ignoring case", () => {
    const out = findInBrain(
      "MÜLLER",
      [claim("c1", "Interview with Müller", "keep the free plan")],
      [src("a", "Notes", "We met Herr Müller on Monday."), src("b", "Müller call", "Short.")],
    );
    expect(out.facts.map((f) => f.id)).toEqual(["c1"]);
    expect(out.originals.map((o) => o.id)).toEqual(["a", "b"]);
    expect(out.originals[0].snippet).toBe("We met Herr Müller on Monday.");
  });

  it("skips facts without evidence and originals that are no longer active", () => {
    const out = findInBrain(
      "beta",
      [claim("c1", "Beta", "invite only", [])],
      [src("a", "Beta", "withdrawn note", "withdrawn")],
    );
    expect(out).toEqual({ facts: [], originals: [] });
  });

  it("returns nothing for a blank query and cuts long snippets on code points", () => {
    expect(findInBrain("   ", [], [src("a", "x", "y")])).toEqual({ facts: [], originals: [] });
    const long = "🧠".repeat(300) + " needle";
    const snippet = snippetFor(long, "t", "needle");
    expect(Array.from(snippet).length).toBeLessThanOrEqual(240);
    expect(snippet).toContain("needle");
    expect(snippet.startsWith("…")).toBe(true);
  });

  it("shows a query that spans a sentence break", () => {
    expect(snippetFor("Intro.\nWe met Dr. Smith today.", "t", "Dr. Smith")).toContain("Dr. Smith");
  });

  it("windows around a match in the middle of a long line", () => {
    const line = "a".repeat(500) + " Needle " + "b".repeat(500);
    const snippet = snippetFor(line, "t", "needle");
    expect(Array.from(snippet).length).toBeLessThanOrEqual(240);
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet).toContain("Needle");
  });
});

describe("Brain.searchBrain", () => {
  let cleanup: (() => void)[] = [];
  afterEach(() => {
    for (const fn of cleanup.reverse()) fn();
    cleanup = [];
  });
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), "brain-search-test-"));
    const s = new Storage(join(dir, "brain.sqlite"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    cleanup.push(() => {
      try {
        s.close();
      } catch {}
    });
    return new Brain(s, () => new Date("2026-10-23T09:00:00Z"));
  }

  it("searches every project, validates the query and is owner-only", () => {
    const b = setup();
    const hydra = b.createProject(owner, "Hydra");
    b.capture(owner, { title: "Hydra", body: "The ZEBRA_SENTINEL lives here.", project_id: hydra.id });
    const gone = b.capture(owner, { title: "Gone", body: "ZEBRA_SENTINEL withdrawn." }) as any;
    b.removeSource(owner, gone.source_id, 1, false);
    const out = b.searchBrain(owner, { q: "zebra_sentinel" });
    expect(out.originals.map((o) => o.project_id)).toEqual([hydra.id]);
    expect(() => b.searchBrain(owner, { q: "z" })).toThrow();
    expect(() => b.searchBrain(owner, { q: "z".repeat(201) })).toThrow();
    expect(() => b.searchBrain(owner, { q: "zebra", extra: 1 })).toThrow();
    expect(() => b.searchBrain({ kind: "agent", grant_id: "nope" } as Principal, { q: "zebra" })).toThrow();
  });

  it("is served over HTTP to the paired owner only", async () => {
    const b = setup();
    const app = await createApp(b, { pairSecret: "test-code", static: false });
    cleanup.push(() => void app.close());
    const req = (method: any, url: string, payload?: any, headers: Record<string, string> = {}) =>
      app.inject({ method, url, headers: { host: "127.0.0.1:4317", ...headers }, payload });
    expect((await req("GET", "/api/v1/brain/search?q=zebra")).statusCode).toBe(401);
    const pairing = await req("POST", "/api/v1/session/pair", { secret: "test-code" });
    const cookie = pairing.cookies[0];
    const headers = { cookie: `${cookie.name}=${cookie.value}`, "x-brain-csrf": pairing.json().csrf };
    await req("POST", "/api/v1/sources", { title: "Zebra", body: "A zebra note." }, headers);
    const ok = await req("GET", "/api/v1/brain/search?q=zebra", undefined, headers);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().originals).toHaveLength(1);
    expect((await req("GET", "/api/v1/brain/search?q=z", undefined, headers)).statusCode).toBe(400);
  });
});
