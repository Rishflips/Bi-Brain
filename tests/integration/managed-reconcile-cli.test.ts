import { afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ControlStore } from "../../packages/storage/control.ts";
import { ManagedRuntime } from "../../packages/runtime/managed.ts";
import { ManagedSpendingStore } from "../../packages/storage/managed-spending.ts";
import { ManagedReconciliationStore } from "../../packages/storage/managed-reconciliation.ts";

/**
 * Trusted offline reconciliation CLI (Task 3).
 *
 * The CLI runs on the server filesystem against one explicit existing absolute
 * managed root. Read-only commands must not create a control database, money
 * tables, an epoch, or a credential. Mutating commands need both acknowledgement
 * flags and never echo the input file or its body.
 */

const clock = () => new Date("2026-10-16T09:00:00Z");
const ACK = { offline: true, workers_terminated: true };
const ISSUER = "https://synthetic.example.test";
const SCRIPT = resolve("scripts/managed-reconcile.ts");
const limits = {
  per_job_micro_usd: 100000,
  user_daily_micro_usd: 100000,
  time_zone: "UTC",
};
const bases: string[] = [];

afterEach(() => {
  for (const base of bases.splice(0))
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function baseDir() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "bibrain-reconcile-cli-")));
  bases.push(base);
  return base;
}

function run(root: string | undefined, args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (root === undefined) delete env.BRAIN_MANAGED_ROOT;
  else env.BRAIN_MANAGED_ROOT = root;
  return spawnSync(process.execPath, ["--import", "tsx", SCRIPT, ...args], {
    env,
    encoding: "utf8",
    timeout: 20000,
  });
}

interface Fixture {
  base: string;
  root: string;
  runtime: ManagedRuntime;
  spending: ManagedSpendingStore;
  accountId: string;
  input: Record<string, unknown>;
  inputPath: string;
}

function setup(options: { paid: boolean; epoch?: boolean; extraAccount?: boolean } = { paid: false, epoch: false }): Fixture {
  const base = baseDir();
  const root = join(base, "managed");
  const runtime = new ManagedRuntime(root, { clock });
  const account = runtime.provision(ISSUER, "synthetic-cli-own");
  if (options.extraAccount) runtime.provision(ISSUER, "synthetic-cli-extra");
  const spending = new ManagedSpendingStore(runtime.control, clock);
  spending.setServicePolicy({ daily_micro_usd: 100000 });
  spending.setAccountPolicy({
    account_id: account.id,
    per_job_micro_usd: 100000,
    user_daily_micro_usd: 100000,
  });
  spending.configureAccountPeriod({
    account_id: account.id,
    starts_at: "2026-10-16T00:00:00Z",
    ends_at: "2026-10-18T00:00:00Z",
    allowance_micro_usd: 100000,
  });
  let held: ReturnType<ManagedSpendingStore["reserve"]> | undefined;
  if (options.paid) {
    held = spending.reserve({
      account_id: account.id,
      job_id: "synthetic-cli-job",
      dispatch_key: "reasoning",
      stage: "reasoning",
      reserved_micro_usd: 10,
      provider: "synthetic",
      model: "synthetic",
      price_version: "synthetic-v1",
      request_hash: "a".repeat(64),
      config_hash: "b".repeat(64),
      limits,
    });
    spending.mark(held.call_id, limits);
  }
  let epoch = 1;
  if (options.epoch || options.paid) {
    epoch = new ManagedReconciliationStore(runtime.control, root, clock).initEpoch(ACK).epoch;
  }
  runtime.close();
  const input = held
    ? {
        resolution_id: randomUUID(),
        kind: "settled",
        account_id: account.id,
        call_id: held.call_id,
        identity_hash: held.identity_hash,
        provider: held.provider,
        model: held.model,
        price_version: held.price_version,
        request_hash: held.request_hash,
        config_hash: held.config_hash,
        expected_state: "dispatched",
        expected_actual_micro_usd: null,
        cost_micro_usd: 7,
        currency: "USD",
        provider_request_id: "req_synthetic_cli_1",
        evidence_digest: "c".repeat(64),
        method: "usage_response",
        actor: "synthetic-operator",
        checked_at: clock().toISOString(),
        epoch,
      }
    : {};
  const inputPath = join(base, "attestation.json");
  writeFileSync(inputPath, JSON.stringify(input));
  return { base, root, runtime, spending, accountId: account.id, input, inputPath };
}

function receipt(root: string, callId: unknown) {
  const db = new DatabaseSync(join(root, "control.sqlite"), { readOnly: true });
  try {
    return db
      .prepare("SELECT state,actual_micro_usd FROM managed_reservations WHERE call_id=?")
      .get(String(callId));
  } finally {
    db.close();
  }
}

function snapshot(root: string) {
  const db = new DatabaseSync(join(root, "control.sqlite"), { readOnly: true });
  try {
    return JSON.stringify({
      schema: db.prepare("SELECT name,sql FROM sqlite_master ORDER BY type,name").all(),
      accounts: db.prepare("SELECT * FROM managed_accounts ORDER BY id").all(),
      sessions: db.prepare("SELECT * FROM managed_sessions ORDER BY token_hash").all(),
    });
  } finally {
    db.close();
  }
}

it("refuses a missing or unrelated managed root without creating a control database", () => {
  const base = baseDir();
  const missing = run(undefined, ["status"]);
  expect(missing.status).not.toBe(0);

  const emptyRoot = join(base, "empty");
  const unrelated = run(emptyRoot, ["status"]);
  expect(unrelated.status).not.toBe(0);
  expect(existsSync(join(emptyRoot, "control.sqlite"))).toBe(false);
});

it("requires both offline acknowledgements before an operator attestation writes money", () => {
  const f = setup({ paid: true, epoch: true });
  const withoutTerminated = run(f.root, ["attest-settled", f.inputPath, "--offline"]);
  expect(withoutTerminated.status).not.toBe(0);
  expect(receipt(f.root, f.input.call_id)).toMatchObject({
    state: "dispatched",
    actual_micro_usd: null,
  });

  const withoutOffline = run(f.root, ["attest-settled", f.inputPath, "--workers-terminated"]);
  expect(withoutOffline.status).not.toBe(0);
  expect(receipt(f.root, f.input.call_id)).toMatchObject({
    state: "dispatched",
    actual_micro_usd: null,
  });

  const ok = run(f.root, ["attest-settled", f.inputPath, "--offline", "--workers-terminated"]);
  expect(ok.status).toBe(0);
  expect(receipt(f.root, f.input.call_id)).toMatchObject({
    state: "settled",
    actual_micro_usd: 7,
  });
});

it("settles a dispatched call once and refuses a later resend", () => {
  const f = setup({ paid: true, epoch: true });
  const first = run(f.root, ["attest-settled", f.inputPath, "--offline", "--workers-terminated"]);
  expect(first.status).toBe(0);
  const repeat = run(f.root, ["attest-settled", f.inputPath, "--offline", "--workers-terminated"]);
  expect(repeat.status).toBe(0);
  expect(receipt(f.root, f.input.call_id)).toMatchObject({
    state: "settled",
    actual_micro_usd: 7,
  });
  // A resend can never follow: the settled row is not a fresh reservation.
  const control = new ControlStore(join(f.root, "control.sqlite"), clock);
  try {
    const store = new ManagedSpendingStore(control, clock);
    expect(() => store.mark(String(f.input.call_id), limits)).toThrow();
  } finally {
    control.close();
  }
});

it("denies an attestation for an undispatched reserved call", () => {
  const base = baseDir();
  const root = join(base, "managed");
  const runtime = new ManagedRuntime(root, { clock });
  const account = runtime.provision(ISSUER, "synthetic-cli-reserved");
  const spending = new ManagedSpendingStore(runtime.control, clock);
  spending.setServicePolicy({ daily_micro_usd: 100000 });
  spending.setAccountPolicy({
    account_id: account.id,
    per_job_micro_usd: 100000,
    user_daily_micro_usd: 100000,
  });
  spending.configureAccountPeriod({
    account_id: account.id,
    starts_at: "2026-10-16T00:00:00Z",
    ends_at: "2026-10-18T00:00:00Z",
    allowance_micro_usd: 100000,
  });
  const rec = spending.reserve({
    account_id: account.id,
    job_id: "synthetic-cli-reserved-job",
    dispatch_key: "reasoning",
    stage: "reasoning",
    reserved_micro_usd: 10,
    provider: "synthetic",
    model: "synthetic",
    price_version: "synthetic-v1",
    request_hash: "a".repeat(64),
    config_hash: "b".repeat(64),
    limits,
  });
  const epoch = new ManagedReconciliationStore(runtime.control, root, clock).initEpoch(ACK).epoch;
  runtime.close();
  const inputPath = join(base, "reserved.json");
  writeFileSync(
    inputPath,
    JSON.stringify({
      resolution_id: randomUUID(),
      kind: "settled",
      account_id: account.id,
      call_id: rec.call_id,
      identity_hash: rec.identity_hash,
      provider: rec.provider,
      model: rec.model,
      price_version: rec.price_version,
      request_hash: rec.request_hash,
      config_hash: rec.config_hash,
      expected_state: "dispatched",
      expected_actual_micro_usd: null,
      cost_micro_usd: 7,
      currency: "USD",
      provider_request_id: "req_synthetic_reserved_1",
      evidence_digest: "c".repeat(64),
      method: "usage_response",
      actor: "synthetic-operator",
      checked_at: clock().toISOString(),
      epoch,
    }),
  );
  const denied = run(root, ["attest-settled", inputPath, "--offline", "--workers-terminated"]);
  expect(denied.status).not.toBe(0);
  expect(receipt(root, rec.call_id)).toMatchObject({ state: "reserved", actual_micro_usd: null });
});

it("audits two accounts serially and then refuses a legacy paid row", () => {
  const base = baseDir();
  const root = join(base, "managed");
  const runtime = new ManagedRuntime(root, { clock });
  const a = runtime.provision(ISSUER, "synthetic-cli-audit-a");
  const b = runtime.provision(ISSUER, "synthetic-cli-audit-b");
  const spending = new ManagedSpendingStore(runtime.control, clock);
  spending.setServicePolicy({ daily_micro_usd: 100000 });
  for (const account of [a, b]) {
    spending.setAccountPolicy({
      account_id: account.id,
      per_job_micro_usd: 100000,
      user_daily_micro_usd: 100000,
    });
    spending.configureAccountPeriod({
      account_id: account.id,
      starts_at: "2026-10-16T00:00:00Z",
      ends_at: "2026-10-18T00:00:00Z",
      allowance_micro_usd: 100000,
    });
  }
  new ManagedReconciliationStore(runtime.control, root, clock).initEpoch(ACK);
  runtime.close();

  const clean = run(root, ["audit-history", "--offline", "--workers-terminated"]);
  expect(clean.status).toBe(0);
  const parsed = JSON.parse(clean.stdout);
  expect(parsed.audit_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(parsed.evidence).toBe("empty");

  // Insert a legacy tenant paid reservation into account B.
  const reopened = new ManagedRuntime(root, { clock });
  const handle = reopened.acquire(b.id);
  try {
    handle.brain.store.run(
      "INSERT INTO jobs(id,project_id,kind,payload,status,attempts,max_attempts,next_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
      "legacy-job",
      "inbox",
      "derive_brief",
      "{}",
      "done",
      1,
      3,
      clock().toISOString(),
      clock().toISOString(),
    );
    handle.brain.store.run(
      "INSERT INTO reservations(job_id,day,reserved,actual,status) VALUES(?,?,?,?,?)",
      "legacy-job",
      "2026-10-16",
      5,
      0,
      "held",
    );
  } finally {
    handle.release();
  }
  reopened.close();

  const refused = run(root, ["audit-history", "--offline", "--workers-terminated"]);
  expect(refused.status).not.toBe(0);
  const db = new DatabaseSync(join(root, "control.sqlite"), { readOnly: true });
  try {
    expect(
      (db.prepare("SELECT count(*) AS n FROM managed_audits").get() as { n: number }).n,
    ).toBe(1);
  } finally {
    db.close();
  }
});

it("status and inspect are read-only and never create an epoch", () => {
  const f = setup({ paid: false, epoch: false });
  const before = snapshot(f.root);
  const status = run(f.root, ["status"]);
  expect(status.status).toBe(0);
  expect(() => JSON.parse(status.stdout)).not.toThrow();
  expect(snapshot(f.root)).toBe(before);
  expect(existsSync(join(f.root, "control-epoch.json"))).toBe(false);

  const inspect = run(f.root, ["inspect", randomUUID()]);
  expect(inspect.status).not.toBe(0);
  expect(snapshot(f.root)).toBe(before);
  expect(existsSync(join(f.root, "control-epoch.json"))).toBe(false);
});

it("rejects no arguments and unknown, extra or duplicated flags", () => {
  const f = setup({ paid: false, epoch: false });
  expect(run(f.root, []).status).not.toBe(0);
  expect(run(f.root, ["nonsense"]).status).not.toBe(0);
  expect(run(f.root, ["status", "--offline"]).status).not.toBe(0);
  expect(
    run(f.root, ["attest-settled", f.inputPath, "--offline", "--offline", "--workers-terminated"])
      .status,
  ).not.toBe(0);
  expect(
    run(f.root, ["attest-settled", f.inputPath, "--offline", "--workers-terminated", "extra"])
      .status,
  ).not.toBe(0);
});

it("reports an unrelated control namespace without creating tables", () => {
  const base = baseDir();
  const dir = join(base, "control");
  mkdirSync(dir);
  const seed = new DatabaseSync(join(dir, "control.sqlite"));
  seed.exec("CREATE TABLE unrelated(x INTEGER)");
  seed.close();

  const result = run(dir, ["status"]);
  expect(result.status).not.toBe(0);

  const after = new DatabaseSync(join(dir, "control.sqlite"), { readOnly: true });
  try {
    const names = (
      after.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
        name: string;
      }[]
    ).map((row) => row.name);
    expect(names).toEqual(["unrelated"]);
  } finally {
    after.close();
  }
});

it("inspect exposes curated immutable financial identity without leaking private metadata", () => {
  const f = setup({ paid: true, epoch: true });
  const result = run(f.root, ["inspect", String(f.input.call_id)]);
  expect(result.status).toBe(0);
  const parsed = JSON.parse(result.stdout);
  expect(parsed.identity_hash).toBe(f.input.identity_hash);
  expect(parsed.provider).toBe(f.input.provider);
  expect(parsed.model).toBe(f.input.model);
  expect(parsed.price_version).toBe(f.input.price_version);
  expect(parsed.request_hash).toBe(f.input.request_hash);
  expect(parsed.config_hash).toBe(f.input.config_hash);
  expect(parsed.epoch).toBe(f.input.epoch);
  const text = result.stdout + result.stderr;
  expect(text).not.toContain(String(f.input.evidence_digest));
  expect(text).not.toContain(String(f.input.actor));
  expect(text).not.toContain(String(f.input.provider_request_id));
});

it("settles a known zero via the CLI and refuses a non-USD attestation", () => {
  const f = setup({ paid: true, epoch: true });
  const badPath = join(f.base, "bad-currency.json");
  writeFileSync(badPath, JSON.stringify({ ...f.input, currency: "EUR" }));
  const bad = run(f.root, ["attest-settled", badPath, "--offline", "--workers-terminated"]);
  expect(bad.status).not.toBe(0);
  expect(receipt(f.root, f.input.call_id)).toMatchObject({
    state: "dispatched",
    actual_micro_usd: null,
  });

  const zeroPath = join(f.base, "zero.json");
  writeFileSync(
    zeroPath,
    JSON.stringify({
      ...f.input,
      resolution_id: randomUUID(),
      kind: "zero",
      cost_micro_usd: 0,
      provider_request_id: "req_zero_1",
    }),
  );
  const zero = run(f.root, ["attest-zero", zeroPath, "--offline", "--workers-terminated"]);
  expect(zero.status).toBe(0);
  expect(receipt(f.root, f.input.call_id)).toMatchObject({
    state: "settled",
    actual_micro_usd: 0,
  });
});
