#!/usr/bin/env node
// apps/cli/bibrain.mjs
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { browserCommand, dataDirFor, keyFilePath, parseArgs } from "./lib.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { command, flags } = parseArgs(process.argv.slice(2));
const port = Number(process.env.BRAIN_PORT ?? 4317);
const origin = `http://127.0.0.1:${port}`;

const fail = (message) => {
  process.stderr.write(message + "\n");
  process.exit(1);
};

async function healthy() {
  try {
    const res = await fetch(`${origin}/api/v1/health/live`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function openSignedIn() {
  const secret = process.env.BRAIN_OWNER_SECRET ?? readFileSync(join(dataDirFor(root, process.env), "owner-secret"), "utf8").trim();
  const res = await fetch(`${origin}/api/v1/session/pair-link`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret }),
    redirect: "error",
  });
  if (!res.ok) fail("BiBrain is running but did not accept this computer's installation code.");
  const { token } = await res.json();
  const { command: cmd, args } = browserCommand(process.platform, `${origin}/#pair=${token}`);
  spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
}

async function start() {
  let child = null;
  if (!(await healthy())) {
    if (!existsSync(join(root, "dist", "web", "index.html"))) {
      process.stdout.write("Building BiBrain for the first time…\n");
      const built = spawnSync(process.execPath, [join(root, "node_modules", "vite", "bin", "vite.js"), "build", "--config", "apps/web/vite.config.ts"], { cwd: root, stdio: "inherit" });
      if (built.status !== 0) fail("BiBrain could not be built. Run npm ci in the BiBrain folder, then try again.");
    }
    child = spawn(process.execPath, ["--env-file-if-exists=.env", join(root, "scripts", "run.mjs"), "production"], { cwd: root, stdio: "inherit", env: { ...process.env, BRAIN_PORT: String(port) } });
    const until = Date.now() + 60_000;
    while (!(await healthy())) {
      if (Date.now() > until || child.exitCode !== null) fail("BiBrain did not start. See the messages above.");
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
  const adapter = spawn(process.execPath, [join(root, "node_modules", "tsx", "dist", "cli.mjs"), join(root, "apps", "mcp", "main.ts")], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, BRAIN_AGENT_TOKEN: key, BRAIN_API_URL: api },
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => adapter.kill(signal));
  adapter.on("exit", (code) => process.exit(code ?? 0));
}

const help = `bibrain: start BiBrain and connect agents.

  npx bibrain            Start BiBrain and open it signed in
  npx bibrain open       Open the running BiBrain signed in
  npx bibrain help       Show this help

Agents use "bibrain connect" from the file BiBrain writes into a project folder.`;

if (command === "start") await start();
else if (command === "open") {
  if (!(await healthy())) fail(`BiBrain is not running at ${origin}. Run npx bibrain first.`);
  await openSignedIn();
} else if (command === "connect") connect();
else process.stdout.write(help + "\n");
