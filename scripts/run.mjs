import { spawn } from "node:child_process";
const dev = process.argv[2] === "dev";
const entries = [
  ["--import", "tsx", "apps/server/main.ts"],
  ["--import", "tsx", "apps/worker/main.ts"],
  ...(dev
    ? [["node_modules/vite/bin/vite.js", "--config", "apps/web/vite.config.ts"]]
    : []),
];
// Secret-bearing service variables never reach the dev frontend child. The
// decision key remains worker-only; billing backend credentials are available to
// the API server and worker because both validate the same all-or-none managed
// config. Dodo hosted checkout requires no browser payment token.
const isWorker = (args) => args[args.length - 1] === "apps/worker/main.ts";
const isServer = (args) => args[args.length - 1] === "apps/server/main.ts";
const children = entries.map((args) => {
  const env = {
    ...process.env,
    NODE_ENV: dev ? "development" : "production",
  };
  if (!isWorker(args)) delete env.BRAIN_DECISION_API_KEY;
  if (!isServer(args) && !isWorker(args)) delete env.BRAIN_PADDLE_API_KEY;
  if (!isServer(args) && !isWorker(args)) delete env.BRAIN_PADDLE_WEBHOOK_SECRET;
  if (!isServer(args) && !isWorker(args)) delete env.BRAIN_DODO_API_KEY;
  if (!isServer(args) && !isWorker(args)) delete env.BRAIN_DODO_WEBHOOK_SECRET;
  if (!isServer(args) && !isWorker(args)) delete env.BRAIN_OIDC_CLIENT_SECRET;
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
