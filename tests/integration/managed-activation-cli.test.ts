import { afterEach, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedRuntime } from "../../packages/runtime/managed.ts";
import { ManagedSpendingStore } from "../../packages/storage/managed-spending.ts";
import { ManagedReconciliationStore } from "../../packages/storage/managed-reconciliation.ts";
import { auditManagedHistory } from "../../packages/runtime/managed-audit.ts";

/**
 * Task 1 offline CLI suite: strict arity/flags, no secret persistence, full
 * enable→status→disable behavior over a real managed root. Synthetic only; no
 * provider key or model IO.
 */

const clock = () => new Date("2026-10-16T09:00:00Z");
const ACK = { offline: true as const, workers_terminated: true as const };
const ISSUER = "https://synthetic.example.test";
const bases: string[] = [];

afterEach(() => {
  for (const base of bases.splice(0))
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function run(root: string, args: string[]) {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/managed-activation.ts", ...args],
    { cwd: process.cwd(), env: { ...process.env, BRAIN_MANAGED_ROOT: root, BRAIN_MANAGED_ALLOW_PAID: "1" }, encoding: "utf8" },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function enrolledRoot() {
  const base = mkdtempSync(join(tmpdir(), "brain-activation-cli2-"));
  bases.push(base);
  const root = join(base, "managed");
  const runtime = new ManagedRuntime(root, { clock });
  const account = runtime.provision(ISSUER, "cli2-account");
  const money = new ManagedSpendingStore(runtime.control, clock);
  money.setServicePolicy({ daily_micro_usd: 1000 });
  money.setAccountPolicy({
    account_id: account.id,
    per_job_micro_usd: 1000,
    user_daily_micro_usd: 1000,
  });
  money.configureAccountPeriod({
    account_id: account.id,
    starts_at: "2026-10-16T00:00:00Z",
    ends_at: "2026-10-17T00:00:00Z",
    allowance_micro_usd: 1000,
  });
  new ManagedReconciliationStore(runtime.control, root, clock).initEpoch(ACK);
  const audit = auditManagedHistory({ runtime, root, ...ACK, clock });
  expect(audit.ok).toBe(true);
  runtime.close();
  const file = join(base, "profile.json");
  writeFileSync(
    file,
    JSON.stringify({
      provider: "openai",
      model: "synthetic-model-v1",
      price_version: "synthetic-price-v1",
      input_micro_usd_per_million: 1_000_000,
      output_micro_usd_per_million: 1_000_000,
      accepted_response_models: ["synthetic-model-v1"],
      max_output_tokens: 100,
      endpoint_class: "openai_responses",
      audit_id: audit.audit_id!,
      expected_version: 0,
    }),
  );
  return { base, root, file };
}

it("enables, reports status and disables through the operator CLI", () => {
  const f = enrolledRoot();
  const before = run(f.root, ["status"]);
  expect(before.status).toBe(0);
  expect(JSON.parse(before.stdout)).toMatchObject({ profile: "absent", reason: "off" });

  const enable = run(f.root, ["enable", f.file, "--offline", "--workers-terminated"]);
  expect(enable.status, `${enable.stdout}\n${enable.stderr}`).toBe(0);
  const enabled = JSON.parse(enable.stdout);
  expect(enabled).toMatchObject({ command: "enable", version: 1 });
  expect(enabled.fingerprint).toMatch(/^[0-9a-f]{64}$/);

  const status = run(f.root, ["status"]);
  expect(status.status).toBe(0);
  expect(JSON.parse(status.stdout)).toMatchObject({ profile: "enabled", version: 1, reason: "ready" });

  const disable = run(f.root, ["disable", "--expected-version", "1"]);
  expect(disable.status).toBe(0);
  expect(JSON.parse(disable.stdout)).toMatchObject({ command: "disable", disabled: true, version: 2 });

  const after = run(f.root, ["status"]);
  expect(JSON.parse(after.stdout)).toMatchObject({ profile: "disabled", version: 2, reason: "off" });
});

it("rejects unknown commands, wrong arity and duplicate flags without mutating", () => {
  const f = enrolledRoot();
  expect(run(f.root, ["frobnicate"]).status).not.toBe(0);
  expect(run(f.root, ["enable"]).status).not.toBe(0);
  expect(
    run(f.root, ["enable", f.file, "--offline", "--offline", "--workers-terminated"]).status,
  ).not.toBe(0);
  expect(run(f.root, ["enable", f.file, "--offline"]).status).not.toBe(0);
  expect(run(f.root, ["status", "--offline"]).status).not.toBe(0);
  expect(run(f.root, ["disable"]).status).not.toBe(0);
  const status = run(f.root, ["status"]);
  expect(JSON.parse(status.stdout)).toMatchObject({ profile: "absent" });
});

it("never echoes a raw path or system error when the control database is unreadable", () => {
  const base = mkdtempSync(join(tmpdir(), "brain-activation-cli3-"));
  bases.push(base);
  const root = join(base, "managed");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "control.sqlite"), "SYNTHETIC_NOT_A_DATABASE");
  const result = run(root, ["status"]);
  expect(result.status).not.toBe(0);
  expect(`${result.stdout}${result.stderr}`).not.toContain(root);
});

it("rejects a secret-bearing or invalid profile before persistence", () => {
  const f = enrolledRoot();
  const secret = join(f.base, "secret.json");
  writeFileSync(
    secret,
    JSON.stringify({
      provider: "openai",
      model: "synthetic-model-v1",
      price_version: "synthetic-price-v1",
      input_micro_usd_per_million: 1_000_000,
      output_micro_usd_per_million: 1_000_000,
      accepted_response_models: ["synthetic-model-v1"],
      max_output_tokens: 100,
      endpoint_class: "openai_responses",
      audit_id: "00000000-0000-4000-8000-000000000000",
      expected_version: 0,
      key: "SYNTHETIC_NOT_A_REAL_KEY",
    }),
  );
  const result = run(f.root, ["enable", secret, "--offline", "--workers-terminated"]);
  expect(result.status).not.toBe(0);
  const status = run(f.root, ["status"]);
  expect(JSON.parse(status.stdout)).toMatchObject({ profile: "absent" });
});
