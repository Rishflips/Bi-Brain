import { describe, expect, it } from "vitest";
import { secondFileHelper, secondFileLabel } from "../../apps/web/connections/second-file.ts";

const none = { pushes: 0, last_push_at: null, last_level: null } as const;
const pushed = { pushes: 1, last_push_at: "2026-10-26T09:00:00.000Z", last_level: "full" } as const;
const hook = { role: "hook", state: "written" } as const;

describe("second file copy", () => {
  it("does not say Codex recall is on until Codex has run the hook once", () => {
    expect(secondFileLabel({ client: "codex", recall: none }, hook)).toBe("Recall on every prompt: on after Codex trusts the hook");
    expect(secondFileLabel({ client: "codex", recall: pushed }, hook)).toBe("Recall on every prompt: on");
  });
  it("does not say Claude Code recall is on until a prompt has been pushed, and says add-it-yourself when the file already existed", () => {
    expect(secondFileLabel({ client: "claude-code", recall: none }, hook)).toBe("Recall on every prompt: on after your next prompt");
    expect(secondFileLabel({ client: "claude-code", recall: pushed }, hook)).toBe("Recall on every prompt: on");
    expect(secondFileLabel({ client: "codex", recall: pushed }, { role: "hook", state: "exists" })).toBe("Recall on every prompt: add it yourself");
    expect(secondFileLabel({ client: "cursor", recall: none }, { role: "rule", state: "written" })).toBe("Rule file added");
    expect(secondFileLabel({ client: "cursor", recall: none }, { role: "rule", state: "exists" })).toBe("Rule file: add it yourself");
  });
  it("describes each second file truthfully and only claims pre-approved tools for Claude Code", () => {
    expect(secondFileHelper("claude-code")).toContain("Only two read-only tools are pre-approved");
    expect(secondFileHelper("cursor")).toBe("This rule asks the agent to check your brain first. It cannot run anything.");
    expect(secondFileHelper("codex")).toBe("This runs BiBrain's recall on every prompt. It pre-approves nothing; Codex asks you to trust it once.");
    for (const c of ["claude-code", "cursor", "codex"] as const) expect(secondFileHelper(c)).not.toMatch(/\b(model|MCP|token)\b/i);
  });
});
