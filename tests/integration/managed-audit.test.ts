import { afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStore } from "../../packages/storage/control.ts";
import { ManagedSpendingStore } from "../../packages/storage/managed-spending.ts";
import { ManagedReconciliationStore } from "../../packages/storage/managed-reconciliation.ts";
import { ManagedRuntime } from "../../packages/runtime/managed.ts";
import {
  auditManagedHistory,
  readManagedAudit,
  validateManagedAudit,
} from "../../packages/runtime/managed-audit.ts";

/**
 * Bounded read-only all-account history audit (Task 3).
 *
 * The audit scans one tenant database at a time, records only ids, hashes and
 * integer money, and refuses the whole audit on any legacy, unmapped, orphan or
 * non-terminal paid row. A supported restore rotates the epoch and invalidates a
 * prior audit; legitimate new terminal rows beyond the baseline stay valid.
 */

const ISSUER = "https://synthetic.example.test";
const clock = () => new Date("2026-10-16T09:00:00Z");
const ACK = { offline: true, workers_terminated: true };
const SENTINEL = "AUDIT_PRIVATE_BODY_SENTINEL";
const limits = {
  per_job_micro_usd: 100000,
  user_daily_micro_usd: 100000,
  time_zone: "UTC",
};
const bases: string[] = [];
const runtimes: ManagedRuntime[] = [];

afterEach(() => {
  for (const runtime of runtimes.splice(0)) {
    try {
      runtime.close();
    } catch {}
  }
  for (const base of bases.splice(0))
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function baseDir() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "bibrain-audit-")));
  bases.push(base);
  return base;
}

interface Fixture {
  base: string;
  root: string;
  runtime: ManagedRuntime;
  control: ControlStore;
  spending: ManagedSpendingStore;
}

function setup(): Fixture {
  const base = baseDir();
  const root = join(base, "managed");
  const runtime = new ManagedRuntime(root, { clock });
  runtimes.push(runtime);
  const control = runtime.control;
  const spending = new ManagedSpendingStore(control, clock);
  spending.setServicePolicy({ daily_micro_usd: 100000 });
  new ManagedReconciliationStore(control, root, clock).initEpoch(ACK);
  return { base, root, runtime, control, spending };
}

function addAccount(f: Fixture, subject: string) {
  const account = f.runtime.provision(ISSUER, subject);
  f.spending.setAccountPolicy({
    account_id: account.id,
    per_job_micro_usd: 100000,
    user_daily_micro_usd: 100000,
  });
  f.spending.configureAccountPeriod({
    account_id: account.id,
    starts_at: "2026-10-16T00:00:00Z",
    ends_at: "2026-10-18T00:00:00Z",
    allowance_micro_usd: 100000,
  });
  return account;
}

function seedTerminal(f: Fixture, accountId: string, reserved = 10, actual = 7) {
  const jobId = randomUUID();
  const rec = f.spending.reserve({
    account_id: accountId,
    job_id: jobId,
    dispatch_key: "reasoning",
    stage: "reasoning",
    reserved_micro_usd: reserved,
    provider: "synthetic",
    model: "synthetic",
    price_version: "synthetic-v1",
    request_hash: "a".repeat(64),
    config_hash: "b".repeat(64),
    limits,
  });
  f.spending.mark(rec.call_id, limits);
  f.spending.settleKnown(rec.call_id, actual);
  const handle = f.runtime.acquire(accountId);
  const tenantCallId = randomUUID();
  try {
    handle.brain.store.run(
      "INSERT INTO jobs(id,project_id,kind,payload,status,attempts,max_attempts,next_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
      jobId,
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
      "INSERT INTO provider_dispatches(call_id,job_id,dispatch_key,stage,state,reserved_micro_usd,actual_micro_usd,provider,model,price_version,request_hash,config_hash,identity_hash,budget_day,time_zone,created_at,dispatched_at,settled_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      tenantCallId,
      jobId,
      "reasoning",
      "reasoning",
      "settled",
      reserved,
      actual,
      "synthetic",
      "synthetic",
      "synthetic-v1",
      "a".repeat(64),
      "b".repeat(64),
      rec.identity_hash,
      "2026-10-16",
      "UTC",
      clock().toISOString(),
      clock().toISOString(),
      clock().toISOString(),
    );
  } finally {
    handle.release();
  }
  f.spending.linkProjection(rec.call_id, tenantCallId);
  return { centralCallId: rec.call_id, tenantCallId };
}

function audit(f: Fixture, over: Record<string, unknown> = {}) {
  return auditManagedHistory({
    runtime: f.runtime,
    root: f.root,
    offline: true,
    workers_terminated: true,
    clock,
    ...over,
  });
}

it("passes a clean all-terminal history with an inventory and stores no content", () => {
  const f = setup();
  const account = addAccount(f, "audit-clean");
  seedTerminal(f, account.id);
  const handle = f.runtime.acquire(account.id);
  try {
    handle.brain.capture(handle.brain.ownerPrincipal(), {
      title: "private note",
      body: SENTINEL,
    });
  } finally {
    handle.release();
  }

  const result = audit(f);
  expect(result.ok).toBe(true);
  expect(result.reason).toBeNull();
  expect(result.audit_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(result.evidence).toBe("matched");
  expect(result.inventory.root_epoch).toBe(1);
  expect(result.inventory.accounts).toHaveLength(1);
  expect(result.inventory.accounts[0]!.account_id).toBe(account.id);
  expect(result.inventory.accounts[0]!.baseline_digest).toMatch(/^[0-9a-f]{64}$/);

  const record = readManagedAudit(f.control, result.audit_id!);
  expect(record).toBeTruthy();
  expect(record!.accounts).toHaveLength(1);
  expect(JSON.stringify(record)).not.toContain(SENTINEL);
  const stored = f.control.db
    .prepare("SELECT count(*) AS n FROM managed_audit_rows WHERE audit_id=?")
    .get(result.audit_id) as { n: number };
  expect(stored.n).toBe(1);
});

it("includes a suspended account read-only and never reactivates it", () => {
  const f = setup();
  const active = addAccount(f, "audit-active");
  seedTerminal(f, active.id);
  const suspended = addAccount(f, "audit-suspended");
  f.control.setAccountState(suspended.id, "suspended");

  const result = audit(f);
  expect(result.ok).toBe(true);
  expect(result.inventory.accounts.map((a) => a.account_id).sort()).toEqual(
    [active.id, suspended.id].sort(),
  );
  expect(f.control.account(suspended.id)?.state).toBe("suspended");
});

it("refuses a central projection orphan and a mismatched paid row", () => {
  const orphan = setup();
  const a = addAccount(orphan, "audit-orphan");
  const rec = orphan.spending.reserve({
    account_id: a.id,
    job_id: randomUUID(),
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
  orphan.spending.mark(rec.call_id, limits);
  orphan.spending.settleKnown(rec.call_id, 7);
  const orphanResult = audit(orphan);
  expect(orphanResult.ok).toBe(false);
  expect(orphanResult.audit_id).toBeNull();
  expect(orphanResult.reason).toBe("orphan_projection");
  expect(
    (orphan.control.db.prepare("SELECT count(*) AS n FROM managed_audits").get() as { n: number }).n,
  ).toBe(0);

  const mismatch = setup();
  const b = addAccount(mismatch, "audit-mismatch");
  const seeded = seedTerminal(mismatch, b.id, 10, 7);
  const db = mismatch.control.db;
  db.prepare("UPDATE managed_reservations SET actual_micro_usd=99 WHERE call_id=?").run(
    seeded.centralCallId,
  );
  const mismatchResult = audit(mismatch);
  expect(mismatchResult.ok).toBe(false);
  expect(mismatchResult.reason).toBe("row_mismatch");
  expect(mismatchResult.audit_id).toBeNull();
});

it("keeps new terminal rows valid but marks an edited baseline stale", () => {
  const f = setup();
  const account = addAccount(f, "audit-baseline");
  const first = seedTerminal(f, account.id);
  const result = audit(f);
  expect(result.ok).toBe(true);

  // A legitimate new typed terminal row beyond the baseline does not invalidate.
  seedTerminal(f, account.id, 20, 15);
  const valid = validateManagedAudit({
    control: f.control,
    root: f.root,
    auditId: result.audit_id!,
    clock,
  });
  expect(valid.valid).toBe(true);

  // Editing an audited baseline row makes the audit stale.
  f.control.db
    .prepare("UPDATE managed_reservations SET actual_micro_usd=99 WHERE call_id=?")
    .run(first.centralCallId);
  const stale = validateManagedAudit({
    control: f.control,
    root: f.root,
    auditId: result.audit_id!,
    clock,
  });
  expect(stale.valid).toBe(false);
  expect(stale.reason).toBeTruthy();
});

it("marks an unsurveyed new account stale", () => {
  const f = setup();
  const account = addAccount(f, "audit-surveyed");
  seedTerminal(f, account.id);
  const result = audit(f);
  expect(result.ok).toBe(true);

  addAccount(f, "audit-unsurveyed");
  const stale = validateManagedAudit({
    control: f.control,
    root: f.root,
    auditId: result.audit_id!,
    clock,
  });
  expect(stale.valid).toBe(false);
  expect(stale.reason).toBe("unsurveyed_account");
});

it("denies deterministically on the global row bound without a partial record", () => {
  const f = setup();
  const account = addAccount(f, "audit-bounds");
  seedTerminal(f, account.id, 10, 7);
  seedTerminal(f, account.id, 20, 15);

  const denied = audit(f, { maxRows: 1 });
  expect(denied.ok).toBe(false);
  expect(denied.reason).toBe("row_limit");
  expect(denied.audit_id).toBeNull();
  expect(
    (f.control.db.prepare("SELECT count(*) AS n FROM managed_audits").get() as { n: number }).n,
  ).toBe(0);

  expect(() => audit(f, { maxRows: 0 })).toThrow();
});

it("refuses a non-integer paid amount in either journal", () => {
  const f = setup();
  const account = addAccount(f, "audit-money");
  const seeded = seedTerminal(f, account.id, 10, 7);
  // SQLite INTEGER affinity + CHECK(>=0) still admits a fractional value.
  f.control.db
    .prepare("UPDATE managed_reservations SET actual_micro_usd=7.5 WHERE call_id=?")
    .run(seeded.centralCallId);
  const handle = f.runtime.acquire(account.id);
  try {
    handle.brain.store.run(
      "UPDATE provider_dispatches SET actual_micro_usd=7.5 WHERE call_id=?",
      seeded.tenantCallId,
    );
  } finally {
    handle.release();
  }
  const result = audit(f);
  expect(result.ok).toBe(false);
  expect(result.audit_id).toBeNull();
  expect(result.reason).toBe("invalid_money");
  expect(
    (f.control.db.prepare("SELECT count(*) AS n FROM managed_audits").get() as { n: number }).n,
  ).toBe(0);
});
