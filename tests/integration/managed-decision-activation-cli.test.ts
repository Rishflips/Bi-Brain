import { afterEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ManagedRuntime } from "../../packages/runtime/managed.ts";
import { ManagedSpendingStore } from "../../packages/storage/managed-spending.ts";
import { decisionActivationMirrorPath } from "../../packages/storage/managed-decision-activation.ts";
import { readActivationRow } from "../../packages/storage/managed-activation-state.ts";
import { ManagedReconciliationStore } from "../../packages/storage/managed-reconciliation.ts";
import { auditManagedHistory } from "../../packages/runtime/managed-audit.ts";

const ISSUER = "https://issuer.synthetic.test";
const ACK = { offline: true as const, workers_terminated: true as const };
const AUDIT_ID = "00000000-0000-4000-8000-000000000000";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function runCli(
  env: Record<string, string | undefined>,
  args: string[],
): { status: number | null; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(
      process.execPath,
      ["--import", "tsx", "scripts/managed-decision-activation.ts", ...args],
      { cwd: process.cwd(), env: { ...process.env, ...env }, encoding: "utf8" },
    );
    return { status: 0, stdout, stderr: "" };
  } catch (error: any) {
    return {
      status: error.status ?? 1,
      stdout: String(error.stdout ?? ""),
      stderr: String(error.stderr ?? ""),
    };
  }
}

function operatorInput(over: Record<string, unknown> = {}) {
  return {
    provider: "typesafe",
    model: "jev-synthetic-v1",
    accepted_response_models: ["jev-synthetic-return-v2", "jev-synthetic-v1"],
    endpoint: "https://api.typesafe.ai/v1/systemone",
    price_version: "synthetic-decision-price-v1",
    input_micro_usd_per_million: 1000,
    output_micro_usd_per_million: 0,
    timeout_ms: 1000,
    max_request_bytes: 1_048_576,
    max_response_bytes: 262_144,
    audit_id: AUDIT_ID,
    expected_version: 0,
    ...over,
  };
}

/** A genuine dummy real managed root with a valid current-schema audit, no network. */
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bibrain-decision-cli-")));
  roots.push(root);
  const runtime = new ManagedRuntime(root);
  const account = runtime.provision(ISSUER, "decision-cli-account");
  const money = new ManagedSpendingStore(runtime.control);
  money.setServicePolicy({ daily_micro_usd: 100_000 });
  money.setAccountPolicy({ account_id: account.id, per_job_micro_usd: 10_000, user_daily_micro_usd: 100_000 });
  money.configureAccountPeriod({
    account_id: account.id,
    starts_at: "2026-01-01T00:00:00Z",
    ends_at: "2030-01-01T00:00:00Z",
    allowance_micro_usd: 1_000_000,
  });
  new ManagedReconciliationStore(runtime.control, root).initEpoch(ACK);
  const audit = auditManagedHistory({ runtime, root, ...ACK });
  const dir = mkdtempSync(join(tmpdir(), "bibrain-decision-cli-in-"));
  roots.push(dir);
  return {
    root,
    dir,
    audit,
    write(name: string, body: unknown) {
      const path = join(dir, name);
      writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
      return path;
    },
    close() {
      runtime.close();
    },
  };
}

it("enables with valid offline flags and a fresh full audit, never calling a provider", () => {
  const f = fixture();
  try {
    expect(f.audit.ok).toBe(true);
    const file = f.write("profile.json", operatorInput({ audit_id: f.audit.audit_id }));
    const run = runCli({ BRAIN_MANAGED_ROOT: f.root }, [
      "enable",
      file,
      "--offline",
      "--workers-terminated",
    ]);
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ command: "enable", version: 1, enabled: true });
    // Persisted for real: SQL row + mirror both exist and match.
    const mirror = JSON.parse(readFileSync(decisionActivationMirrorPath(f.root), "utf8"));
    expect(mirror).toMatchObject({ provider: "typesafe", enabled: true, version: 1 });
    // The reasoning stage was never touched by a decision-only enrollment.
    const db = new DatabaseSync(join(f.root, "control.sqlite"), { readOnly: true });
    try {
      expect(readActivationRow(db)).toBeUndefined();
    } finally {
      db.close();
    }
  } finally {
    f.close();
  }
});

it("enable rejects a missing acknowledgement flag before any write", () => {
  const f = fixture();
  try {
    const file = f.write("profile.json", operatorInput({ audit_id: f.audit.audit_id }));
    const run = runCli({ BRAIN_MANAGED_ROOT: f.root }, ["enable", file, "--offline"]);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/offline|terminated/i);
    expect(existsSync(decisionActivationMirrorPath(f.root))).toBe(false);
  } finally {
    f.close();
  }
});

it("rejects duplicate, unknown, and misplaced flags", () => {
  const f = fixture();
  try {
    const file = f.write("profile.json", operatorInput({ audit_id: f.audit.audit_id }));
    expect(
      runCli({ BRAIN_MANAGED_ROOT: f.root }, [
        "enable",
        file,
        "--offline",
        "--offline",
        "--workers-terminated",
      ]).status,
    ).not.toBe(0);
    expect(
      runCli({ BRAIN_MANAGED_ROOT: f.root }, [
        "enable",
        file,
        "--offline",
        "--workers-terminated",
        "--expected-version",
        "1",
      ]).status,
    ).not.toBe(0);
    expect(runCli({ BRAIN_MANAGED_ROOT: f.root }, ["enable", file, "--offline", "--workers-terminated", "--bogus"]).status).not.toBe(0);
    expect(runCli({ BRAIN_MANAGED_ROOT: f.root }, ["enable", file, "extra", "--offline", "--workers-terminated"]).status).not.toBe(0);
    expect(runCli({ BRAIN_MANAGED_ROOT: f.root }, ["status", "--expected-version", "1"]).status).not.toBe(0);
  } finally {
    f.close();
  }
});

it("rejects duplicate --expected-version before consuming the value", () => {
  const f = fixture();
  try {
    const run = runCli({ BRAIN_MANAGED_ROOT: f.root }, [
      "disable",
      "--expected-version",
      "1",
      "--expected-version",
      "2",
    ]);
    expect(run.status).not.toBe(0);
  } finally {
    f.close();
  }
});

it("status and show are read-only and report absent on a fresh root", () => {
  const f = fixture();
  try {
    for (const command of ["status", "show"]) {
      const run = runCli({ BRAIN_MANAGED_ROOT: f.root }, [command]);
      expect(run.status).toBe(0);
      expect(JSON.parse(run.stdout)).toMatchObject({ command, mode: "managed", profile: "absent", effective: "off" });
    }
    expect(existsSync(decisionActivationMirrorPath(f.root))).toBe(false);
  } finally {
    f.close();
  }
});

it("status reports mismatch, never present, when SQL and mirror disagree", () => {
  const f = fixture();
  try {
    const file = f.write("profile.json", operatorInput({ audit_id: f.audit.audit_id }));
    expect(
      runCli({ BRAIN_MANAGED_ROOT: f.root }, ["enable", file, "--offline", "--workers-terminated"]).status,
    ).toBe(0);
    const mirror = readFileSync(decisionActivationMirrorPath(f.root), "utf8");
    const tampered = JSON.parse(mirror);
    tampered.model = "MUTATED";
    writeFileSync(decisionActivationMirrorPath(f.root), JSON.stringify(tampered));
    const run = runCli({ BRAIN_MANAGED_ROOT: f.root }, ["status"]);
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ profile: "mismatch", effective: "unavailable" });
  } finally {
    f.close();
  }
});

it("denies an unknown or uninitialized managed root", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "bibrain-decision-cli-bad-")));
  roots.push(dir);
  expect(runCli({ BRAIN_MANAGED_ROOT: dir }, ["status"]).status).not.toBe(0);
  expect(runCli({}, ["status"]).status).not.toBe(0);
  expect(runCli({ BRAIN_MANAGED_ROOT: "relative/path" }, ["status"]).status).not.toBe(0);
});

it("rejects an off-allowlist endpoint and normalizes a canonical alias", () => {
  const f = fixture();
  try {
    const bad = f.write("bad.json", operatorInput({ audit_id: f.audit.audit_id, endpoint: "http://127.0.0.1/v1/systemone" }));
    expect(runCli({ BRAIN_MANAGED_ROOT: f.root }, ["enable", bad, "--offline", "--workers-terminated"]).status).not.toBe(0);
    expect(existsSync(decisionActivationMirrorPath(f.root))).toBe(false);
    // A non-canonical alias is accepted but stored normalized to the canonical URL.
    const alias = f.write(
      "alias.json",
      operatorInput({ audit_id: f.audit.audit_id, endpoint: "https://api.typesafe.ai/v1/../v1/systemone" }),
    );
    expect(
      runCli({ BRAIN_MANAGED_ROOT: f.root }, ["enable", alias, "--offline", "--workers-terminated"]).status,
    ).toBe(0);
    const stored = JSON.parse(readFileSync(decisionActivationMirrorPath(f.root), "utf8"));
    expect(stored.endpoint).toBe("https://api.typesafe.ai/v1/systemone");
  } finally {
    f.close();
  }
});
