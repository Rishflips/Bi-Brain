import { describe, expect, it } from "vitest";
import { questionWords, rankAnswers } from "../../packages/domain/ask.ts";
import type { Entity, Source } from "../../packages/contracts/index.ts";

const claim: Entity = {
  id: "c1", project_id: "p1", kind: "claim", version: 1, created_at: "2026-10-01T00:00:00Z",
  data: { status: "current", entity: "Northstar beta", aspect: "statement", value: "opens November 14",
    evidence: [{ source_id: "s1", source_version: 1, start: 0, end: 10, quote: "opens November 14" }] },
};
const src = (id: string, title: string, body: string): Source => ({
  id, project_id: "p1", version: 1, title, body, visibility: "project", state: "active",
  captured_at: "2026-10-01T00:00:00Z", origin: "owner",
});

describe("ask ranking", () => {
  it("drops stop words and punctuation", () => {
    expect(questionWords("When does the BETA open??")).toEqual(["beta", "open"]);
    expect(questionWords("?!")).toEqual([]);
  });

  it("puts reviewed facts before unreviewed originals and dedupes the fact's own original", () => {
    const hits = rankAnswers("when does the beta open", [claim], [
      src("s1", "Beta timeline", "The beta opens November 14."),
      src("s2", "Interview", "Marco asked when the beta opens."),
    ]);
    expect(hits.map((h) => `${h.type}:${h.id}`)).toEqual(["fact:c1", "original:s2"]);
  });

  it("returns nothing when no word matches", () => {
    expect(rankAnswers("pricing", [claim], [src("s1", "Beta", "opens")])).toEqual([]);
  });
});
