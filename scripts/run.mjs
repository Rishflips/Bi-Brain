import { spawn } from "node:child_process";
const dev = process.argv[2] === "dev";
const entries = [
  ["--import", "tsx", "apps/server/main.ts"],
  ["--import", "tsx", "apps/worker/main.ts"],
  ...(dev
    ? [["node_modules/vite/bin/vite.js", "--config", "apps/web/vite.config.ts"]]
    : []),
];
// The worker-only decision key must never reach the API server or the dev
// frontend child. Every legacy variable (OPENAI/identity/etc.) is preserved; only
// this one deliberately scoped key is removed from non-worker environments.
const isWorker = (args) => args[args.length - 1] === "apps/worker/main.ts";
const children = entries.map((args) => {
  const env = {
    ...process.env,
    NODE_ENV: dev ? "development" : "production",
  };
  if (!isWorker(args)) delete env.BRAIN_DECISION_API_KEY;
  return spawn(process.execPath, args, { stdio: "inherit", env });
});
let stopping = false;
let exitCode = 0;
let deadline;
function finish() {
  if (
    stopping &&
    children.every(
      (child) => child.exitCode !== null || child.signalCode !== null,
    )
  ) {
    clearTimeout(deadline);
    process.exit(exitCode);
  }
}
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  exitCode = code;
  for (const child of children)
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGTERM");
  deadline = setTimeout(() => {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
    process.exit(exitCode);
  }, 15000);
  finish();
}
for (const child of children) {
  child.on("error", () => stop(1));
  child.on("exit", (code) => {
    if (!stopping) stop(code || 1);
    finish();
  });
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
process.on("message", (message) => {
  if (message === "stop") stop();
});
