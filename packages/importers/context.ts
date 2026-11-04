/** The instruction files a developer already keeps for agents. Shared by the page (which reads nothing else) and the server (which refuses anything else). */
export const CONTEXT_FILE_NAMES = ["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", "GEMINI.md", "MEMORY.md", ".cursorrules", ".windsurfrules", "copilot-instructions.md"] as const;
/** Checked against the folders *below* the picked folder; the picked folder's own name is dropped by the page before the path reaches this rule. */
export const SKIPPED_FOLDERS = ["node_modules", ".git", "dist", "build", "vendor", "target", "out"] as const;
/** One file over either limit is skipped with a warning; the rest of the batch still imports. The character limit is capture's. */
export const CONTEXT_FILE_MAX_BYTES = 1048576;
export const CONTEXT_FILE_MAX_CHARS = 100000;
const MAX_DEPTH = 5;

export function isContextFile(relPath: string): boolean {
  const parts = relPath.replaceAll("\\", "/").split("/").filter(Boolean);
  if (!parts.length || parts.length > MAX_DEPTH + 1) return false;
  if (parts.slice(0, -1).some((p) => (SKIPPED_FOLDERS as readonly string[]).includes(p))) return false;
  const name = parts[parts.length - 1];
  if ((CONTEXT_FILE_NAMES as readonly string[]).includes(name)) return name !== "copilot-instructions.md" || parts[parts.length - 2] === ".github";
  return /\.mdc$/u.test(name) && parts.length >= 3 && parts[parts.length - 3] === ".cursor" && parts[parts.length - 2] === "rules";
}
