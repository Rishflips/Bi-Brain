import { describe, expect, it } from "vitest";
import { SERVER_INSTRUCTIONS, TOOL_DESCRIPTIONS, TOOL_NAMES, renderRecallContent } from "../../apps/mcp/surface.ts";
import type { RecallResult } from "../../packages/domain/recall.ts";

describe("MCP surface v2", () => {
  it("has the seven underscore names and nothing dotted", () => {
    expect(TOOL_NAMES).toEqual(["brain_recall", "brain_open", "brain_note", "brain_propose", "brain_intent", "brain_link", "brain_forget"]);
    expect(TOOL_NAMES.every((n) => /^[a-zA-Z0-9_-]+$/.test(n))).toBe(true);
  });
  it("carries the exact instructions and descriptions from the design", () => {
    expect(SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(1700);
    expect(SERVER_INSTRUCTIONS).toContain("written_by");
    expect(SERVER_INSTRUCTIONS).toContain("Decided: <topic>: <decision>");
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
  it("registers the same tools and the same capabilities resource through one table for stdio and HTTP", async () => {
    const { TOOL_TABLE, capabilitiesResource } = await import("../../apps/mcp/tools.ts");
    expect(Object.keys(TOOL_TABLE).sort()).toEqual([...TOOL_NAMES].sort());
    const body = JSON.parse(capabilitiesResource({ tools: ["brain_recall"], projects: [] }, "stdio").contents[0].text);
    expect(body).toEqual({ tools: ["brain_recall"], projects: [], surface: "v2", contract: "bibrain-agent/1", transport: "stdio", binding: "manual until a client adapter is verified", private_sources: "owner only" });
  });
  it("names no model, vendor or harness anywhere an agent reads", async () => {
    const { PUSH_FOOTER, PUSH_HEADER, renderPointer } = await import("../../packages/domain/recall-push.ts");
    const { CURSOR_RULE } = await import("../../packages/domain/agents.ts");
    const texts = [SERVER_INSTRUCTIONS, ...Object.values(TOOL_DESCRIPTIONS), PUSH_HEADER("2026-11-05"), PUSH_FOOTER, renderPointer(["Northstar"]), CURSOR_RULE];
    for (const t of texts) expect(t).not.toMatch(/(Claude|Codex|Cursor|Hermes|GPT|OpenAI|Anthropic|Gemini|Llama|Nous)/);
  });
});
