export type { Api } from "../today/types.ts";
export type AgentClient = "codex" | "claude-code" | "cursor";
export type Grant = {
  id: string;
  projects: string[];
  operations: string[];
  expires_at: string;
  revoked_at: string | null;
  last_verified_at: string | null;
  status: "Connected" | "Not connected" | "Needs attention" | "Revoked";
  client: AgentClient | "other";
  client_name: string;
  folder: string | null;
  recall: { pushes: number; last_push_at: string | null; last_level: "full" | "pointer" | "none" | null };
};
export type AgentInfo = { client: AgentClient; name: string; found: boolean; file: string; hint: string };
export type AgentsStatus = { available: boolean; reason: string | null; clients: AgentInfo[] };
export type Preview = { connection_id: string; file: string; contents: string; exists: boolean };
