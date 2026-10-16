import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ManagedRuntime } from "../../packages/runtime/managed.ts";
import { ManagedSpendingStore } from "../../packages/storage/managed-spending.ts";

function run(root: string, args: string[]) {
  return spawnSync(process.execPath, ["--import", pathToFileURL(resolve("node_modules/tsx/dist/loader.mjs")).href, resolve("scripts/managed-policy.ts"), ...args], {
    env: { ...process.env, BRAIN_MANAGED_ROOT: root }, encoding: "utf8", timeout: 15000,
  });
}

it("policy tooling refuses an existing unrelated directory without initializing a control plane", () => {
  const root = mkdtempSync(join(tmpdir(), "brain-unrelated-policy-"));
  try {
    const result = run(root, ["set-service", "10"]);
    expect(result.status).not.toBe(0);
    expect(existsSync(join(root, "control.sqlite"))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("extra policy arguments are rejected without changing the configured budget", () => {
  const root = mkdtempSync(join(tmpdir(), "brain-policy-arity-"));
  let runtime: ManagedRuntime | undefined;
  try {
    runtime = new ManagedRuntime(root);
    new ManagedSpendingStore(runtime.control).setServicePolicy({ daily_micro_usd: 5 });
    runtime.close(); runtime = undefined;
    const result = run(root, ["set-service", "10", "unexpected-argument"]);
    expect(result.status).not.toBe(0);
    runtime = new ManagedRuntime(root);
    expect(runtime.control.db.prepare("SELECT daily_micro_usd FROM managed_service_policy").get()?.daily_micro_usd).toBe(5);
  } finally { runtime?.close(); rmSync(root, { recursive: true, force: true }); }
});
