import { describe, expect, it } from "vitest";
import { questionWords } from "../../packages/domain/ask.ts";

describe("question words", () => {
  it("drops stop words and punctuation", () => {
    expect(questionWords("When does the BETA open??")).toEqual(["beta", "open"]);
    expect(questionWords("?!")).toEqual([]);
  });

  it("keeps short tokens that contain a digit", () => {
    expect(questionWords("Q3?")).toEqual(["q3"]);
    expect(questionWords("What happens on 14?")).toEqual(["happen", "14"]);
    expect(questionWords("is v2 ok")).toEqual(["v2"]);
  });

  it("keeps words with combining marks whole", () => {
    expect(questionWords("தமிழ்")).toEqual(["தமிழ்"]);
  });
});
