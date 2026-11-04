import { shortDate } from "../brain/format.ts";
import type { AgentClient, Grant, WrittenFile } from "./types.ts";

/** The line under a connection about its hook or rule file. "On" waits for a recorded push: Codex only runs a project hook after the person trusts it, and Claude Code may still be asking about the folder or the changed settings. */
export function secondFileLabel(grant: Pick<Grant, "client" | "recall">, file: Pick<WrittenFile, "role" | "state">): string {
  if (file.role === "hook") {
    if (file.state === "exists") return "Recall on every prompt: add it yourself";
    if (grant.recall.pushes === 0) return grant.client === "codex" ? "Recall on every prompt: on after Codex trusts the hook" : "Recall on every prompt: on after your next prompt";
    return "Recall on every prompt: on";
  }
  return file.state === "written" ? "Rule file added" : "Rule file: add it yourself";
}

/** What the second file does, said truthfully for each agent (shown in the Add preview when there is more than one file). */
export function secondFileHelper(client: AgentClient): string {
  if (client === "claude-code") return "The second file turns on recall on every prompt. Only two read-only tools are pre-approved; nothing in it can write.";
  if (client === "cursor") return "This rule asks the agent to check your brain first. It cannot run anything.";
  return "This runs BiBrain's recall on every prompt. It pre-approves nothing; Codex asks you to trust it once.";
}

const hasStop = (contents: string) => {
  try {
    const parsed = JSON.parse(contents);
    return Array.isArray(parsed?.hooks?.Stop);
  } catch {
    return false;
  }
};

/**
 * For a hook file written before session notes existed: the exact Stop entry to add, built from that file's own prompt-hook command
 * (the same command with hook-end in place of hook), so the owner pastes one block and no file BiBrain wrote is ever changed. Null when the file
 * already has a Stop entry or cannot be read.
 */
export function stopEntryFor(client: AgentClient, contents: string): string | null {
  if (client === "cursor" || hasStop(contents)) return null;
  let command: unknown;
  try {
    command = JSON.parse(contents)?.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]?.command;
  } catch {
    return null;
  }
  if (typeof command !== "string" || !command.includes(` hook ${client} `)) return null;
  return JSON.stringify({ Stop: [{ hooks: [{ type: "command", command: command.replace(` hook ${client} `, ` hook-end ${client} `), timeout: 5 }] }] }, null, 2);
}

/** The line under a connection about its session notes. Only a hook file that carries the Stop entry can produce them; "on" waits for the first saved note. */
export function writebackLabel(grant: Pick<Grant, "client" | "writeback">, file: Pick<WrittenFile, "role" | "state" | "contents">): string {
  if (file.role === "rule") return "Session notes: by hand (Cursor has no end-of-turn hook)";
  if (!hasStop(file.contents)) return "Session notes: add the Stop entry yourself";
  if (file.state === "exists") return "Session notes: add the hook yourself";
  if (grant.writeback.notes === 0) return grant.client === "codex" ? "Session notes: on after Codex trusts the hook" : "Session notes: on after your next session";
  return `Session notes: ${grant.writeback.notes} saved · last ${shortDate(grant.writeback.last_at!)}`;
}
