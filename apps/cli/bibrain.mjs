#!/usr/bin/env node
// apps/cli/bibrain.mjs
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { browserCommand, dataDirFor, keyFilePath, parseArgs } from "./lib.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
// Read the same .env the server reads, so the port, data folder and installation
// code match. Values already in the environment win.
try {
  if (existsSync(join(root, ".env"))) process.loadEnvFile(join(root, ".env"));
} catch {}
const { command, flags } = parseArgs(process.argv.slice(2));
const port = Number(process.env.BRAIN_PORT ?? 4317);
const origin = `http://127.0.0.1:${port}`;

// The server this run started, if any. A failure after that point stops it, so
// no orphan is left running. A server that was already running is never touched.
let child = null;
const fail = (message) => {
  process.stderr.write(message + "\n");
  if (child && child.exitCode === null) child.kill("SIGTERM");
  process.exit(1);
};

// For async paths: report, stop our own server, and let Node end on its own.
// Calling process.exit with a request still closing can crash Node on Windows.
class Quit extends Error {}
const stop = (message) => {
  process.stderr.write(message + "\n");
  if (child && child.exitCode === null) child.kill("SIGTERM");
  process.exitCode = 1;
  throw new Quit();
};

async function healthy() {
  try {
    const res = await fetch(`${origin}/api/v1/health/live`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

// True only for a local BiBrain, so a different program on this port is never given the code.
async function isBiBrain() {
  try {
    const res = await fetch(`${origin}/api/v1/runtime`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return false;
    const body = await res.json();
    return body?.mode === "local";
  } catch {
    return false;
  }
}

const notBiBrain = () => stop(`Something else is using port ${port}. Stop it or set BRAIN_PORT to another port.`);

async function openSignedIn() {
  const dataDir = dataDirFor(root, process.env);
  let secret = process.env.BRAIN_OWNER_SECRET || "";
  if (!secret) {
    try {
      secret = readFileSync(join(dataDir, "owner-secret"), "utf8").trim();
    } catch {}
  }
  if (!secret) stop(`BiBrain's installation code was not found in ${dataDir}. If another BiBrain is using port ${port}, stop it or set BRAIN_PORT.`);
  const res = await fetch(`${origin}/api/v1/session/pair-link`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret }),
    redirect: "error",
  });
  if (!res.ok) stop("BiBrain is running but did not accept this computer's installation code.");
  const { token } = await res.json();
  const url = `${origin}/#pair=${token}`;
  // Tests only: when this names a file, the link is appended there and no browser opens.
  if (process.env.BRAIN_CLI_BROWSER_LOG) {
    appendFileSync(process.env.BRAIN_CLI_BROWSER_LOG, url + "\n");
    return;
  }
  const { command: cmd, args } = browserCommand(process.platform, url);
  spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
}

async function start() {
  if (await healthy()) {
    if (!(await isBiBrain())) notBiBrain();
  } else {
    if (!existsSync(join(root, "dist", "web", "index.html"))) {
      process.stdout.write("Building BiBrain for the first time…\n");
      const built = spawnSync(process.execPath, [join(root, "node_modules", "vite", "bin", "vite.js"), "build", "--config", "apps/web/vite.config.ts"], { cwd: root, stdio: "inherit" });
      if (built.status !== 0) stop("BiBrain could not be built. Run npm ci in the BiBrain folder, then try again.");
    }
    child = spawn(process.execPath, ["--env-file-if-exists=.env", join(root, "scripts", "run.mjs"), "production"], { cwd: root, stdio: "inherit", env: { ...process.env, BRAIN_PORT: String(port) } });
    const until = Date.now() + 60_000;
    while (!(await healthy())) {
      if (Date.now() > until || child.exitCode !== null) stop("BiBrain did not start. See the messages above.");
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (flags["no-open"]) process.stdout.write(`BiBrain is running at ${origin}. Run npx bibrain open to open it signed in.\n`);
  else {
    await openSignedIn();
    process.stdout.write(`BiBrain is open at ${origin}.\n`);
  }
  if (child) {
    process.stdout.write("Keep this window open. Press Ctrl+C to stop BiBrain.\n");
    const stop = () => child.kill("SIGTERM");
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    child.on("exit", (code) => process.exit(code ?? 0));
  }
}

function connect() {
  let file;
  try {
    file = keyFilePath(String(flags.data ?? ""), String(flags.connection ?? ""));
  } catch (error) {
    fail(error.message);
  }
  if (!existsSync(file)) fail("This BiBrain connection was removed. Add the agent again from Connections in BiBrain.");
  let api;
  let key;
  try {
    ({ api, key } = JSON.parse(readFileSync(file, "utf8")));
  } catch {
    fail("This BiBrain connection file is damaged. Add the agent again from Connections in BiBrain.");
  }
  if (typeof api !== "string" || typeof key !== "string") fail("This BiBrain connection file is damaged. Add the agent again from Connections in BiBrain.");
  const env = { ...process.env };
  delete env.BRAIN_OWNER_SECRET;
  env.BRAIN_AGENT_TOKEN = key;
  env.BRAIN_API_URL = api;
  const adapter = spawn(process.execPath, [join(root, "node_modules", "tsx", "dist", "cli.mjs"), join(root, "apps", "mcp", "main.ts")], {
    cwd: root,
    stdio: "inherit",
    env,
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => adapter.kill(signal));
  adapter.on("error", () => fail("BiBrain could not start its agent connection. Run npm ci in the BiBrain folder, then try again."));
  adapter.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

const help = `bibrain: start BiBrain and connect agents.

  npx bibrain            Start BiBrain and open it signed in
  npx bibrain open       Open the running BiBrain signed in
  npx bibrain help       Show this help

Agents use "bibrain connect" from the file BiBrain writes into a project folder.`;

try {
  if (command === "start") await start();
  else if (command === "open") {
    if (!(await healthy())) stop(`BiBrain is not running at ${origin}. Run npx bibrain first.`);
    if (!(await isBiBrain())) notBiBrain();
    await openSignedIn();
  } else if (command === "connect") connect();
  else process.stdout.write(help + "\n");
} catch (error) {
  if (!(error instanceof Quit)) throw error;
}
