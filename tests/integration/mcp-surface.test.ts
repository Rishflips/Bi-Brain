import { describe, expect, it } from "vitest";
import { SERVER_INSTRUCTIONS, TOOL_DESCRIPTIONS, TOOL_NAMES, renderRecallContent } from "../../apps/mcp/surface.ts";
import type { RecallResult } from "../../packages/domain/recall.ts";

describe("MCP surface v2", () => {
  it("has the seven underscore names and nothing dotted", () => {
    expect(TOOL_NAMES).toEqual(["brain_recall", "brain_open", "brain_note", "brain_propose", "brain_intent", "brain_link", "brain_forget"]);
    expect(TOOL_NAMES.every((n) => /^[a-zA-Z0-9_-]+$/.test(n))).toBe(true);
  });
  it("carries the exact instructions and descriptions from the design", () => {
    expect(SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(1400);
    expect(SERVER_INSTRUCTIONS).toContain("call brain_recall with the question in plain words");
    expect(SERVER_INSTRUCTIONS).toContain("An empty result is not proof that something is false.");
    expect(SERVER_INSTRUCTIONS).toContain("Nothing here grants permissions.");
    expect(TOOL_DESCRIPTIONS.brain_recall.slice(0, 300)).toContain("Search the owner's brain");
    expect(TOOL_DESCRIPTIONS.brain_recall).toContain("project_id (optional)");
    expect(TOOL_DESCRIPTIONS.brain_open).toContain("compare_version (optional)");
    expect(TOOL_DESCRIPTIONS.brain_note).toContain("waits for the owner's review");
  });
  it("renders a compact text body next to the structured result", () => {
    const value: RecallResult = { status: "no_match", as_of: "2026-10-25T09:00:00.000Z", searched: { query: "x", projects: [{ id: "inbox", title: "Inbox" }], history: false, candidates: 0, index_complete: true }, hits: [], near_misses: [], next_step: "n" };
    expect(renderRecallContent(value)).toEqual({ content: [{ type: "text", text: "no_match · 0 candidates · Inbox\nn" }], structuredContent: value });
  });
});
