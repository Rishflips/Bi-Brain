import { describe, expect, it } from "vitest";
import { evidenceRanges, findQuote, highlightSegments } from "../../apps/web/brain/highlight.ts";

describe("highlightSegments", () => {
  it("marks code-point ranges, merging overlaps, and keeps the whole text", () => {
    const body = "🧠 alpha beta gamma";
    const segs = highlightSegments(body, [
      { start: 2, end: 7 },
      { start: 5, end: 12 },
    ]);
    expect(segs).toEqual([
      { text: "🧠 ", mark: false },
      { text: "alpha beta", mark: true },
      { text: " gamma", mark: false },
    ]);
    expect(segs.map((s) => s.text).join("")).toBe(body);
  });

  it("ignores ranges outside the body and returns the plain body when nothing is marked", () => {
    expect(highlightSegments("short", [{ start: 3, end: 99 }, { start: 4, end: 2 }])).toEqual([
      { text: "short", mark: false },
    ]);
  });
});

describe("findQuote and evidenceRanges", () => {
  it("finds an exact quote in code points, and says null when it is gone", () => {
    expect(findQuote("🧠🧠 We decided that X.", "We decided")).toEqual({ start: 3, end: 13 });
    expect(findQuote("corrected text", "We decided")).toBeNull();
    expect(findQuote("anything", "")).toBeNull();
  });

  it("keeps only evidence whose text still matches its quote", () => {
    const body = "Alpha beta.";
    expect(
      evidenceRanges(body, [
        { start: 0, end: 5, quote: "Alpha" },
        { start: 0, end: 5, quote: "Other" },
      ]),
    ).toEqual([{ start: 0, end: 5 }]);
  });
});
