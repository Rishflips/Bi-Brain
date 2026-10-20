import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

type Report = {
  role: string;
  key_present: boolean;
  key_matches_synthetic: boolean;
  dodo_key_present: boolean;
  dodo_webhook_present: boolean;
};
const marker = "SYNTHETIC_LAUNCHER_REPORT:";
const syntheticKey = "SYNTHETIC_DECISION_KEY_FOR_LAUNCHER_TEST";

/** Exercise the real launcher/child environments, not source-text matching.
 * Disposable preloads stop BEFORE any actual app entrypoint or provider runs.
 * This is deliberately only an environment-flow proof, not a worker proof. */
async function inspectLauncher(mode: "production" | "dev") {
  const root = mkdtempSync(join(tmpdir(), "brain-decision-launcher-parent-"));
  const preload = join(root, "observe-child.mjs");
  writeFileSync(
    preload,
    `
const entry = (process.argv[1] ?? "").replaceAll("\\\\", "/");
const role = entry.endsWith("apps/server/main.ts") ? "server"
  : entry.endsWith("apps/worker/main.ts") ? "worker"
  : entry.endsWith("node_modules/vite/bin/vite.js") ? "vite" : null;
if (role) {
  process.stdout.write(${JSON.stringify(marker)} + JSON.stringify({ role,
    key_present: Object.hasOwn(process.env, "BRAIN_DECISION_API_KEY"),
    key_matches_synthetic: process.env.BRAIN_DECISION_API_KEY === ${JSON.stringify(syntheticKey)},
    dodo_key_present: process.env.BRAIN_DODO_API_KEY === "SYNTHETIC_DODO_API_KEY",
    dodo_webhook_present: process.env.BRAIN_DODO_WEBHOOK_SECRET === "SYNTHETIC_DODO_SIGNING_SECRET",
  }) + "\\n");
  // Keep only these disposable children alive until the launcher's normal stop
  // protocol runs. The app modules never execute and no storage is opened.
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
`,
  );
  const env: NodeJS.ProcessEnv = {
    NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
    BRAIN_DECISION_API_KEY: syntheticKey,
    BRAIN_DODO_API_KEY: "SYNTHETIC_DODO_API_KEY",
    BRAIN_DODO_WEBHOOK_SECRET: "SYNTHETIC_DODO_SIGNING_SECRET",
  };
  // An explicit non-secret allowlist prevents real service credentials from
  // being copied into this test process. Nothing loads an operator .env file.
  for (const key of [
    "PATH",
    "Path",
    "SystemRoot",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "HOME",
    "PATHEXT",
    "ComSpec",
  ])
    if (process.env[key] !== undefined) env[key] = process.env[key];
  const child = spawn(process.execPath, ["scripts/run.mjs", mode], {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const closed = new Promise<number | null>((resolve) =>
    child.once("close", (code) => resolve(code)),
  );
  const reports = new Map<string, Report>();
  const expected =
    mode === "dev" ? ["server", "worker", "vite"] : ["server", "worker"];
  let collected = "";
  let wake!: () => void;
  let fail!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    wake = resolve;
    fail = reject;
  });
  const timeout = setTimeout(
    () =>
      fail(
        new Error(
          "Disposable launcher children did not report their environments.",
        ),
      ),
    15_000,
  );
  child.once("error", fail);
  child.once("exit", () => {
    if (!expected.every((role) => reports.has(role)))
      fail(
        new Error(
          "Launcher exited before the disposable environment probes completed.",
        ),
      );
  });
  child.stderr!.on("data", () => {
    /* Explicitly piped above; drain without exposing environment values. */
  });
  child.stdout!.on("data", (data: Buffer) => {
    collected += data.toString("utf8");
    const lines = collected.split(/\r?\n/);
    collected = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith(marker)) continue;
      const report = JSON.parse(line.slice(marker.length)) as Report;
      reports.set(report.role, report);
      if (expected.every((role) => reports.has(role))) wake();
    }
  });
  try {
    await ready;
    return reports;
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) {
      if (child.connected) child.send("stop");
      else child.kill("SIGTERM");
    }
    const emergency = setTimeout(() => child.kill("SIGKILL"), 20_000);
    try {
      await closed;
    } finally {
      clearTimeout(emergency);
      rmSync(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
    }
  }
}

it.each(["production", "dev"] as const)(
  "keeps the decision key only in the worker child in %s mode",
  async (mode) => {
    const reports = await inspectLauncher(mode);
    expect(reports.get("worker")).toMatchObject({
      key_present: true,
      key_matches_synthetic: true,
    });
    expect(reports.get("server")).toMatchObject({
      key_present: false,
      key_matches_synthetic: false,
    });
    expect(reports.get("server")).toMatchObject({
      dodo_key_present: true,
      dodo_webhook_present: true,
    });
    expect(reports.get("worker")).toMatchObject({
      dodo_key_present: true,
      dodo_webhook_present: true,
    });
    if (mode === "dev")
      expect(reports.get("vite")).toMatchObject({
        key_present: false,
        key_matches_synthetic: false,
        dodo_key_present: false,
        dodo_webhook_present: false,
      });
  },
  45_000,
);
