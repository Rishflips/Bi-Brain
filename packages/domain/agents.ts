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

export type LaunchSpec = { node: string; cli: string; connectionId: string; dataDir: string };

const TARGETS: Record<AgentClient, { dir: string | null; file: string[] }> = {
  codex: { dir: ".codex", file: [".codex", "config.toml"] },
  "claude-code": { dir: null, file: [".mcp.json"] },
  cursor: { dir: ".cursor", file: [".cursor", "mcp.json"] },
};

/** Where each client reads a project-level agent server. */
export function configTarget(client: AgentClient) {
  return TARGETS[client];
}

function launchArgs(l: LaunchSpec): string[] {
  return [l.cli, "connect", "--connection", l.connectionId, "--data", l.dataDir];
}

/** The exact project file BiBrain writes. It never contains the access key. */
export function configContents(client: AgentClient, launch: LaunchSpec): string {
  const args = launchArgs(launch);
  if (client === "codex") {
    // For normal path text a JSON string is also a valid TOML basic string.
    const q = (s: string) => JSON.stringify(s);
    return [
      "# Added by BiBrain. The access key stays in BiBrain on this computer, not in this file.",
      "[mcp_servers.bibrain]",
      `command = ${q(launch.node)}`,
      `args = [${args.map(q).join(", ")}]`,
      "startup_timeout_sec = 15",
      "tool_timeout_sec = 60",
      "required = false",
      'default_tools_approval_mode = "writes"',
      "",
    ].join("\n");
  }
  return JSON.stringify({ mcpServers: { bibrain: { command: launch.node, args } } }, null, 2) + "\n";
}

/** What to do after the file is written, in the agent's own words. */
export const AGENT_HINTS: Record<AgentClient, string> = {
  codex: "Open Codex in this folder. If Codex asks, trust the folder and allow BiBrain. Keep the new file out of shared version control.",
  "claude-code": "Open Claude Code in this folder and approve BiBrain when it asks. Keep the new file out of shared version control.",
  cursor: "Open this folder in Cursor. If BiBrain is listed as off in Cursor's settings, turn it on. Keep the new file out of shared version control.",
};

export type DetectEnv = {
  home: string;
  pathDirs: string[];
  platform: string;
  exists: (path: string) => boolean;
  join: (...parts: string[]) => string;
};
const BINARIES: Record<AgentClient, string> = { codex: "codex", "claude-code": "claude", cursor: "cursor" };
const HOME_DIRS: Record<AgentClient, string> = { codex: ".codex", "claude-code": ".claude", cursor: ".cursor" };

/** Whether each agent looks installed: its command is on PATH or its settings folder exists. */
export function detectAgents(env: DetectEnv): Record<AgentClient, boolean> {
  const exts = env.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  const dirs = env.pathDirs.map((d) => (d.length >= 2 && d.startsWith('"') && d.endsWith('"') ? d.slice(1, -1) : d));
  const found = {} as Record<AgentClient, boolean>;
  for (const client of AGENT_CLIENTS)
    found[client] =
      env.exists(env.join(env.home, HOME_DIRS[client])) ||
      dirs.some((dir) => dir.length > 0 && exts.some((ext) => env.exists(env.join(dir, BINARIES[client] + ext))));
  return found;
}

/** A plain reason the folder text cannot be used, or null when its shape is fine. */
export function checkFolderShape(folder: string, isAbsolute: (p: string) => boolean): string | null {
  const f = folder.trim();
  if (!f) return "Enter the project folder.";
  if (f.length > 1000) return "That folder path is too long.";
  if (f.includes("\u0000")) return "That folder path has a character BiBrain cannot use.";
  if (!isAbsolute(f)) return "Use the full path of the project folder, for example C:\\Users\\you\\code\\northstar.";
  if (f.split(/[\\/]+/u).includes("..")) return "Use the folder's own path without .. in it.";
  return null;
}
