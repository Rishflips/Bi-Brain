import { describe, expect, it } from "vitest";
import { betterSearchCanSave, plainSearchProblem, plainSearchReason } from "../../apps/web/better-search-copy.ts";

describe("Better search card copy", () => {
  it("turns the worker's last problem into plain words with no codes, services or model names", () => {
    const cases: [string, string][] = [
      ["The search model answered 503.", "The search service did not answer."],
      ["The search model did not answer in time.", "The search service did not answer."],
      ["The search model request failed.", "The search service did not answer."],
      ["The search model reported an error.", "The search service did not answer."],
      ["1 passage was refused by the search service and will be skipped until it changes.", "The search service refused a passage."],
      ["3 passages were refused by the search service and will be skipped until it changes.", "The search service refused some passages."],
      ["Better search with Cloudflare is paused: Today's background spending limit is reached.", "Today's spending limit was reached."],
      ["Better search could not reserve its spending.", "Today's spending limit was reached."],
      ["Better search is waiting before it tries again.", "Better search is waiting a little before it tries again."],
      ["Cloudflare returned something odd for @cf/baai/bge-m3 (HTTP 418)", "Something went wrong preparing passages."],
      ["", "Something went wrong preparing passages."],
    ];
    for (const [raw, plain] of cases) expect(plainSearchProblem(raw)).toBe(plain);
    expect(plainSearchProblem(null)).toBe("Something went wrong preparing passages.");
    for (const [raw] of cases) expect(plainSearchProblem(raw)).not.toMatch(/\d{3}|model|cloudflare|ollama|bge/i);
  });
  it("rewords the one reason that names the model", () => {
    expect(plainSearchReason("The search model changed. Choose Better search again.")).toBe("The search setup changed. Choose Better search again.");
    expect(plainSearchReason("BiBrain's background worker is not running.")).toBe("BiBrain's background worker is not running.");
  });
  it("lets the saved choice be saved again only when the service's key moved", () => {
    const base = { mode: "ollama", key: "ollama:a:none", status: { key: "ollama:a:none" } };
    expect(betterSearchCanSave(base, "ollama")).toBe(false);
    expect(betterSearchCanSave(base, "off")).toBe(true);
    expect(betterSearchCanSave({ ...base, status: { key: "ollama:b:none" } }, "ollama")).toBe(true);
    expect(betterSearchCanSave({ mode: "off", key: null, status: { key: "ollama:b:none" } }, "off")).toBe(false);
    expect(betterSearchCanSave({ ...base, status: null }, "ollama")).toBe(false);
  });
});
