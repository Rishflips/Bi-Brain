import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFixture, owner, type Fixture } from "../eval/recall-fixture.ts";

let fx: Fixture | null = null;
let dir = "";
afterEach(() => {
  fx?.store.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  fx = null;
});
function setup() {
  dir = mkdtempSync(join(tmpdir(), "ask-recall-"));
  fx = buildFixture(join(dir, "brain.sqlite"));
  return fx;
}

describe("the owner's Ask bar on recall", () => {
  it("answers a paraphrase with the fact first, keeps the response shape, and caps at three hits", () => {
    const f = setup();
    const out = f.brain.ask(owner, { q: "what color did we pick for the launch" });
    expect(out.answered).toBe(true);
    expect(out.hits.length).toBeLessThanOrEqual(3);
    expect(out.hits[0]).toMatchObject({ type: "fact", id: f.ids["fact:launch-color"], project_id: f.ids["project:northstar"], text: "Launch color: cobalt" });
    expect((out.hits[0] as any).evidence[0]).toEqual({ source_id: f.ids["src:launch-notes"], source_version: 1, quote: "the launch color is cobalt" });
    const original = out.hits.find((h) => h.type === "original") as any;
    if (original) expect(Object.keys(original).sort()).toEqual(["id", "project_id", "snippet", "source_version", "title", "type"]);
  });
  it("sees private originals for the owner, says not answered when nothing matches, and still refuses stopword-only questions", () => {
    const f = setup();
    expect(f.brain.ask(owner, { q: "journal right call" }).hits.some((h) => h.id === f.ids["src:private-journal"])).toBe(true);
    expect(f.brain.ask(owner, { q: "office wifi password" })).toEqual({ question: "office wifi password", hits: [], answered: false });
    expect(() => f.brain.ask(owner, { q: "the and of" })).toThrow(/Ask with a few words/);
  });
});

describe("Your brain search on recall", () => {
  it("returns facts and originals in the unchanged shape with snippets of at most 240 code points", () => {
    const f = setup();
    const out = f.brain.searchBrain(owner, { q: "Lumen Catering" });
    expect(out.facts.map((x) => x.id)).toContain(f.ids["fact:caterer"]);
    expect(out.facts[0].evidence[0]).toMatchObject({ source_id: f.ids["src:buried"], start: expect.any(Number), end: expect.any(Number) });
    expect(out.originals.map((o) => o.id)).toContain(f.ids["src:buried"]);
    for (const o of out.originals) {
      expect(Array.from(o.snippet).length).toBeLessThanOrEqual(240);
      expect(Object.keys(o).sort()).toEqual(["id", "project_id", "snippet", "title", "version"]);
    }
    expect(out.originals.filter((o) => o.id === f.ids["src:buried"])).toHaveLength(1);
  });
  it("matches words that are not adjacent in the note, which the literal list could not", () => {
    const f = setup();
    const out = f.brain.searchBrain(owner, { q: "catering vendor launch" });
    expect(out.facts.map((x) => x.id)).toContain(f.ids["fact:caterer"]);
    expect(out.originals.map((o) => o.id)).toContain(f.ids["src:buried"]);
  });
  it("finds a word by its prefix and never lists withdrawn originals", () => {
    const f = setup();
    expect(f.brain.searchBrain(owner, { q: "north" }).facts.length).toBeGreaterThan(0);
    f.brain.removeSource(owner, f.ids["src:palette-review"], 1, false);
    expect(f.brain.searchBrain(owner, { q: "palettes" }).originals.map((o) => o.id)).not.toContain(f.ids["src:palette-review"]);
  });
  it("falls back to a literal match for short words and fragments inside a word, as the Your brain list did before", () => {
    const f = setup();
    expect(f.brain.searchBrain(owner, { q: "star" }).originals.map((o) => o.id)).toContain(f.ids["src:beta-timeline"]);
    expect(f.brain.searchBrain(owner, { q: "we" }).originals.map((o) => o.id)).toContain(f.ids["src:launch-notes"]);
    expect(f.brain.searchBrain(owner, { q: "UI" })).toEqual({ facts: [], originals: [] });
  });
});
