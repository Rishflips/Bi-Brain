import { describe, expect, it } from "vitest";
import { shortDate } from "../../apps/web/brain/format.ts";
import { secondFileHelper, secondFileLabel, stopEntryFor, writebackLabel } from "../../apps/web/connections/second-file.ts";

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

  it("says plainly whether session notes are on, waiting, missing from an older file, or by hand, and offers the exact Stop entry to add", () => {
    const none = { notes: 0, last_at: null };
    const some = { notes: 3, last_at: "2026-11-03T09:00:00.000Z" };
    const command = 'node "/opt/bibrain/apps/cli/bibrain.mjs" hook claude-code --connection 1b4e28ba-2fa1-41d2-883f-0016d3cca427 --data "/opt/bibrain/data"';
    const withStop = { role: "hook", state: "written", contents: JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command, timeout: 5 }] }], Stop: [] } }) } as const;
    const without = { role: "hook", state: "written", contents: JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command, timeout: 5 }] }] } }) } as const;
    expect(writebackLabel({ client: "claude-code", writeback: none }, withStop)).toBe("Session notes: on after your next session");
    expect(writebackLabel({ client: "codex", writeback: none }, withStop)).toBe("Session notes: on after Codex trusts the hook");
    expect(writebackLabel({ client: "codex", writeback: some }, withStop)).toBe(`Session notes: 3 saved · last ${shortDate(some.last_at)}`);
    expect(writebackLabel({ client: "claude-code", writeback: none }, { ...withStop, state: "exists" })).toBe("Session notes: add the hook yourself");
    expect(writebackLabel({ client: "claude-code", writeback: none }, without)).toBe("Session notes: add the Stop entry yourself");
    expect(writebackLabel({ client: "cursor", writeback: none }, { role: "rule", state: "written", contents: "" })).toBe("Session notes: by hand (Cursor has no end-of-turn hook)");
    // The entry to paste is the connection's own prompt-hook command with hook-end in place of hook; nothing in the file is touched.
    expect(JSON.parse(stopEntryFor("claude-code", without.contents)!)).toEqual({ Stop: [{ hooks: [{ type: "command", command: command.replace(" hook claude-code ", " hook-end claude-code "), timeout: 5 }] }] });
    expect(stopEntryFor("claude-code", withStop.contents)).toBeNull();
    expect(stopEntryFor("claude-code", "not json")).toBeNull();
    for (const c of ["claude-code", "cursor", "codex"] as const) expect(writebackLabel({ client: c, writeback: none }, withStop)).not.toMatch(/\b(model|MCP|token)\b/i);
  });
});
