import { spawn } from "node:child_process";
const dev = process.argv[2] === "dev";
const children = [
  ["--import", "tsx", "apps/server/main.ts"],
  ["--import", "tsx", "apps/worker/main.ts"],
  ...(dev
    ? [["node_modules/vite/bin/vite.js", "--config", "apps/web/vite.config.ts"]]
    : []),
].map((args) =>
  spawn(process.execPath, args, {
    stdio: "inherit",
    env: { ...process.env, NODE_ENV: dev ? "development" : "production" },
  }),
);
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  setTimeout(() => process.exit(code), 300);
}
for (const child of children) child.on("exit", (code) => stop(code ?? 1));
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
process.on("message", (message) => {
  if (message === "stop") stop();
});
