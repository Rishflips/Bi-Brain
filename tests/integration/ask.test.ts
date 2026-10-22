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

  it("keeps short tokens that contain a digit", () => {
    expect(questionWords("Q3?")).toEqual(["q3"]);
    expect(questionWords("What happens on 14?")).toEqual(["happen", "14"]);
    expect(questionWords("is v2 ok")).toEqual(["v2"]);
  });

  it("keeps words with combining marks whole and matches them", () => {
    expect(questionWords("தமிழ்")).toEqual(["தமிழ்"]);
    const hits = rankAnswers("தமிழ்", [], [src("s9", "Note", "இது தமிழ் குறிப்பு")]);
    expect(hits.map((h) => h.id)).toEqual(["s9"]);
  });

  it("never returns a fact without evidence", () => {
    const bare = { ...claim, id: "c2", data: { ...claim.data, evidence: [] } };
    const missing = { ...claim, id: "c3", data: { ...claim.data, evidence: undefined } };
    expect(rankAnswers("beta", [bare, missing], [])).toEqual([]);
  });

  it("falls back to the title when the body is empty", () => {
    const [hit] = rankAnswers("timeline", [], [src("s5", "Beta timeline", "")]);
    expect(hit).toMatchObject({ type: "original", snippet: "Beta timeline" });
  });
});
