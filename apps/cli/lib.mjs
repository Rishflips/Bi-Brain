import { isAbsolute, join, dirname, resolve } from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** `bibrain <command> --flag value --switch`. No command means start. */
export function parseArgs(argv) {
  const [first, ...rest] = argv;
  const command = first && !first.startsWith("--") ? first : "start";
  const items = first && !first.startsWith("--") ? rest : argv;
  const flags = {};
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item.startsWith("--")) continue;
    const name = item.slice(2);
    const next = items[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[name] = next;
      i++;
    } else flags[name] = true;
  }
  return { command, flags };
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
