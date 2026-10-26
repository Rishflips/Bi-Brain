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
