export const AGENT_CLIENTS = ["codex", "claude-code", "cursor"] as const;
export type AgentClient = (typeof AGENT_CLIENTS)[number];
export type GrantClient = AgentClient | "other";

const NAMES: Record<GrantClient, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  cursor: "Cursor",
  other: "A connected agent",
};

/** The name a person sees for the agent behind a grant. */
export function agentDisplayName(client: unknown): string {
  return typeof client === "string" && Object.hasOwn(NAMES, client)
    ? NAMES[client as GrantClient]
    : NAMES.other;
}
