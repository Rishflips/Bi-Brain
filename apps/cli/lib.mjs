import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, dirname, resolve } from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** `bibrain <command> --flag value --switch`. No command means start. */
export function parseArgs(argv) {
  const [first, ...rest] = argv;
  const command = first && !first.startsWith("--") ? first : "start";
  const items = first && !first.startsWith("--") ? rest : argv;
  const flags = {};
  const positional = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item.startsWith("--")) {
      positional.push(item);
      continue;
    }
    const name = item.slice(2);
    const next = items[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[name] = next;
      i++;
    } else flags[name] = true;
  }
  return { command, flags, positional };
}

/** Opens a URL in the default browser without passing it through a shell. */
export function browserCommand(platform, url) {
  if (platform === "win32") return { command: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
  if (platform === "darwin") return { command: "open", args: [url] };
  return { command: "xdg-open", args: [url] };
}

/** The key file for one connection. Never a path built from untrusted text. */
export function keyFilePath(dataDir, connectionId) {
  if (typeof dataDir !== "string" || !isAbsolute(dataDir)) throw new Error("The data folder must be a full path.");
  if (typeof connectionId !== "string" || !UUID.test(connectionId)) throw new Error("That connection id is not valid.");
  return join(dataDir, "agent-keys", `${connectionId}.json`);
}

/** Where the local server keeps its data, the same rule apps/server uses. */
export function dataDirFor(root, env) {
  return dirname(resolve(root, env.BRAIN_DB ?? "data/brain.sqlite"));
}

export const HOOK_BUDGET_MS = 1500;
export const HOOK_STDIN_MS = 200;
export const HOOK_MIN_PROMPT = 12;
export const HOOK_PROMPT_MAX = 500;
export const HOOK_SESSIONS = 20;
export const HOOK_HASHES = 300;
export const HOOK_CLIENTS = ["claude-code", "codex"];

export const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/** The same three patterns as packages/storage/secrets.ts; a test keeps them equal. */
export function looksLikeSecret(text) {
  return [
    /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
    /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/,
    /(?:api[_ -]?key|access[_ -]?token|client[_ -]?secret|password)\s*[=:]\s*["']?[A-Za-z0-9_./+\-=]{16,}/i,
  ].some((p) => p.test(text));
}

export function firstCodePoints(text, n) {
  return Array.from(text).slice(0, n).join("");
}

/** One UserPromptSubmit event. A BOM, CRLF or a missing trailing newline are fine; anything that is not an object with a string prompt is null. */
export function parseHookStdin(raw) {
  let value;
  try {
    value = JSON.parse(raw.replace(/^\uFEFF/u, "").trim());
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || typeof value.prompt !== "string") return null;
  return { prompt: value.prompt, session_id: typeof value.session_id === "string" ? value.session_id : "" };
}

export function hookSkipReason(prompt) {
  const trimmed = prompt.trim();
  if (Array.from(trimmed).length < HOOK_MIN_PROMPT) return "short";
  if (/^[/!#]/u.test(trimmed)) return "command";
  if (looksLikeSecret(trimmed)) return "secret";
  return null;
}

/** A hook only ever talks to the BiBrain on this computer. */
export function loopbackApi(api) {
  if (typeof api !== "string") throw new Error("The connection file has no API address.");
  const url = new URL(api);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) || !url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
    throw new Error("The hook only calls BiBrain on this computer.");
  return url.origin;
}

export function hookStatePath(dataDir, connectionId) {
  keyFilePath(dataDir, connectionId);
  return join(dataDir, "hook-state", `${connectionId}.json`);
}

export function readHookState(path) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (value && typeof value === "object" && value.sessions && typeof value.sessions === "object") return { sessions: value.sessions };
  } catch {}
  return { sessions: {} };
}

/** Remembers the ids pushed into one session: the 20 most recently active sessions, 300 hashes each, and whether the session already received the first-prompt digest. Never the prompt, never the key. */
export function noteHookState(state, sessionHash, ids, now, digested = false) {
  const current = state.sessions[sessionHash] ?? { first_seen: now, last_seen: now, hashes: [] };
  const hashes = [...current.hashes, ...ids.map((id) => sha256(String(id)))].slice(-HOOK_HASHES);
  const sessions = { ...state.sessions, [sessionHash]: { first_seen: current.first_seen, last_seen: now, hashes, digested: current.digested === true || digested === true } };
  const kept = Object.entries(sessions)
    .sort((a, b) => (b[1].last_seen ?? b[1].first_seen) - (a[1].last_seen ?? a[1].first_seen))
    .slice(0, HOOK_SESSIONS);
  return { sessions: Object.fromEntries(kept) };
}

export function writeHookState(path, state) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(state), { mode: 0o600 });
}

export function hookOutput(text) {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: text } });
}
