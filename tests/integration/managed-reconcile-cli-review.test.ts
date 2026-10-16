import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ManagedRuntime } from "../../packages/runtime/managed.ts";
import { ManagedSpendingStore } from "../../packages/storage/managed-spending.ts";
import { ManagedReconciliationStore } from "../../packages/storage/managed-reconciliation.ts";

const clock = () => new Date("2026-10-16T09:00:00Z");
const ack = { offline: true, workers_terminated: true };
function run(root: string, args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", resolve("scripts/managed-reconcile.ts"), ...args], { env: { ...process.env, BRAIN_MANAGED_ROOT: root }, encoding: "utf8", timeout: 15000 });
}
function setup(paid = false) {
  const base = mkdtempSync(join(tmpdir(), "brain-reconcile-cli-parent-")), root = join(base, "managed");
  const runtime = new ManagedRuntime(root, { clock });
  const account = runtime.provision("https://synthetic.example.test", "synthetic-cli-review");
  const session = runtime.control.issueSession(account.id);
  let input: Record<string, unknown> = {};
  if (paid) {
    const money = new ManagedSpendingStore(runtime.control, clock);
    money.setServicePolicy({ daily_micro_usd: 1000 });
    money.setAccountPolicy({ account_id: account.id, per_job_micro_usd: 1000, user_daily_micro_usd: 1000 });
    money.configureAccountPeriod({ account_id: account.id, starts_at: "2026-10-16T00:00:00Z", ends_at: "2026-10-17T00:00:00Z", allowance_micro_usd: 1000 });
    const limits = { per_job_micro_usd: 1000, user_daily_micro_usd: 1000, time_zone: "UTC" };
    const held = money.reserve({ account_id: account.id, job_id: "synthetic-cli-job", dispatch_key: "reasoning", stage: "reasoning", provider: "synthetic", model: "synthetic", price_version: "synthetic-v1", reserved_micro_usd: 10, request_hash: "a".repeat(64), config_hash: "b".repeat(64), limits });
    money.mark(held.call_id, limits);
    const epoch = new ManagedReconciliationStore(runtime.control, root, clock).initEpoch(ack);
    input = { resolution_id: randomUUID(), kind: "settled", account_id: account.id, call_id: held.call_id, identity_hash: held.identity_hash, provider: held.provider, model: held.model, price_version: held.price_version, request_hash: held.request_hash, config_hash: held.config_hash, expected_state: "dispatched", expected_actual_micro_usd: null, cost_micro_usd: 7, currency: "USD", provider_request_id: "req_synthetic_cli_1", evidence_digest: "c".repeat(64), method: "usage_response", actor: "synthetic-operator", checked_at: clock().toISOString(), epoch: epoch.epoch };
  }
  runtime.close();
  const inputPath = join(base, "attestation.json");
  writeFileSync(inputPath, JSON.stringify(input));
  return { base, root, input, inputPath, session, close() { rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } };
}
function snapshot(root: string) {
  const db = new DatabaseSync(join(root, "control.sqlite"), { readOnly: true });
  try {
    return JSON.stringify({ schema: db.prepare("SELECT name,sql FROM sqlite_master ORDER BY type,name").all(), accounts: db.prepare("SELECT * FROM managed_accounts ORDER BY id").all(), sessions: db.prepare("SELECT * FROM managed_sessions ORDER BY token_hash").all() });
  } finally { db.close(); }
}
function receipt(root: string, callId: unknown) {
  const db = new DatabaseSync(join(root, "control.sqlite"), { readOnly: true });
  try { return db.prepare("SELECT state,actual_micro_usd FROM managed_reservations WHERE call_id=?").get(String(callId)); } finally { db.close(); }
}

it("status works on an initialized account without creating money schema, epoch or credentials", () => {
  const f = setup();
  try {
    const before = snapshot(f.root);
    const result = run(f.root, ["status"]);
    expect(result.status).toBe(0);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
    expect(snapshot(f.root)).toBe(before);
    expect(existsSync(join(f.root, "control-epoch.json"))).toBe(false);
    expect(result.stdout + result.stderr).not.toContain(f.session.token);
    expect(result.stdout + result.stderr).not.toContain(f.session.csrf);
  } finally { f.close(); }
});

it("mutating commands require both acknowledgements and then settle the exact call once", () => {
  const f = setup(true);
  try {
    expect(run(f.root, ["attest-settled", f.inputPath, "--offline"]).status).not.toBe(0);
    expect(receipt(f.root, f.input.call_id)).toMatchObject({ state: "dispatched", actual_micro_usd: null });
    const result = run(f.root, ["attest-settled", f.inputPath, "--offline", "--workers-terminated"]);
    expect(result.status).toBe(0);
    expect(receipt(f.root, f.input.call_id)).toMatchObject({ state: "settled", actual_micro_usd: 7 });
    expect(run(f.root, ["attest-settled", f.inputPath, "--offline", "--workers-terminated"]).status).toBe(0);
    expect(receipt(f.root, f.input.call_id)).toMatchObject({ state: "settled", actual_micro_usd: 7 });
  } finally { f.close(); }
});

it("attestation paths cannot follow an ancestor junction", () => {
  const f = setup(true);
  try {
    const actual = join(f.base, "actual-input"), redirected = join(f.base, "input-link");
    mkdirSync(actual);
    writeFileSync(join(actual, "attestation.json"), JSON.stringify(f.input));
    symlinkSync(actual, redirected, "junction");
    expect(run(f.root, ["attest-settled", join(redirected, "attestation.json"), "--offline", "--workers-terminated"]).status).not.toBe(0);
    expect(receipt(f.root, f.input.call_id)).toMatchObject({ state: "dispatched", actual_micro_usd: null });
  } finally { f.close(); }
});

it("unknown fields and extra arguments fail without echoing input or changing money", () => {
  const f = setup(true);
  try {
    const marker = "SYNTHETIC_PRIVATE_METADATA_DO_NOT_LOG";
    writeFileSync(f.inputPath, JSON.stringify({ ...f.input, private_body: marker }));
    const result = run(f.root, ["attest-settled", f.inputPath, "--offline", "--workers-terminated"]);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).not.toContain(marker);
    expect(result.stdout + result.stderr).not.toContain(f.inputPath);
    expect(run(f.root, ["status", "unexpected-argument"]).status).not.toBe(0);
    expect(receipt(f.root, f.input.call_id)).toMatchObject({ state: "dispatched", actual_micro_usd: null });
  } finally { f.close(); }
});
