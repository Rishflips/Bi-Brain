import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStore, type Account } from "../../packages/storage/control.ts";
import { ManagedSpendingStore } from "../../packages/storage/managed-spending.ts";
import { Storage } from "../../packages/storage/index.ts";
import {
  DispatchLedger,
  paidProcessingBlockedSetting,
} from "../../packages/storage/spend.ts";
import { Brain } from "../../packages/domain/service.ts";
import { BrainError } from "../../packages/domain/logic.ts";
import { ManagedDispatchAccounting } from "../../apps/worker/managed-accounting.ts";
import type { DispatchSpec, JobLease, SpendLimits } from "../../packages/domain/spend.ts";

/**
 * Account-bound managed dispatch coordinator.
 *
 * Every case uses the real control store and a real tenant SQLite ledger over a
 * disposable directory with a deterministic clock. No provider or network call
 * is made; the coordinator is exercised directly.
 */

const ISSUER = "https://issuer.synthetic.test";
let current = "2026-10-16T09:00:00Z";
let seq = 0;
const clock = () => new Date(current);
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

const dirs: string[] = [];
const controls: ControlStore[] = [];
const stores: Storage[] = [];
afterEach(() => {
  current = "2026-10-16T09:00:00Z";
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      /* already closed */
    }
  }
  for (const control of controls.splice(0)) {
    try {
      control.close();
    } catch {
      /* already closed */
    }
  }
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const limits: SpendLimits = {
  per_job_micro_usd: 1000,
  daily_micro_usd: 1000,
  time_zone: "UTC",
};

type ControlFixture = { dir: string; control: ControlStore; central: ManagedSpendingStore };
function makeControl(): ControlFixture {
  const dir = mkdtempSync(join(tmpdir(), "bibrain-managed-accounting-"));
  dirs.push(dir);
  const control = new ControlStore(join(dir, "control.sqlite"), clock);
  controls.push(control);
  return { dir, control, central: new ManagedSpendingStore(control, clock) };
}

type TenantFixture = {
  account: Account;
  store: Storage;
  brain: Brain;
  owner: ReturnType<Brain["ownerPrincipal"]>;
  tenant: DispatchLedger;
  coordinator: ManagedDispatchAccounting;
};
function makeTenant(c: ControlFixture, grantOver: Record<string, number> = {}): TenantFixture {
  const account = c.control.provision(ISSUER, `subject-${++seq}`);
  const store = new Storage(join(c.dir, `${account.id}.sqlite`));
  stores.push(store);
  const brain = new Brain(
    store,
    clock,
    account.id,
    () => c.control.account(account.id)?.state === "active",
  );
  const owner = brain.ownerPrincipal();
  brain.prefs(owner, {
    ...brain.prefs(owner),
    time_zone: "UTC",
    provider_enabled: true,
    daily_cap_micro_usd: 1000,
    per_job_cap_micro_usd: 1000,
  });
  const grant = {
    allowance: 10_000,
    service: 10_000,
    per_job: 10_000,
    user_daily: 10_000,
    ...grantOver,
  };
  c.central.configureAccountPeriod({
    account_id: account.id,
    starts_at: "2026-10-16T00:00:00Z",
    ends_at: "2026-10-17T00:00:00Z",
    allowance_micro_usd: grant.allowance,
  });
  c.central.setServicePolicy({ daily_micro_usd: grant.service });
  c.central.setAccountPolicy({
    account_id: account.id,
    per_job_micro_usd: grant.per_job,
    user_daily_micro_usd: grant.user_daily,
  });
  return {
    account,
    store,
    brain,
    owner,
    tenant: new DispatchLedger(store, clock),
    coordinator: new ManagedDispatchAccounting(c.central, brain, clock),
  };
}

function build(grantOver: Record<string, number> = {}) {
  const c = makeControl();
  return { ...c, ...makeTenant(c, grantOver) };
}

function runningJob(store: Storage): { id: string; lease: JobLease } {
  const id = `job-${++seq}`;
  const leaseUntil = "2026-10-16T09:30:00Z";
  store.run(
    "INSERT INTO jobs(id,project_id,kind,payload,status,attempts,max_attempts,next_at,lease_owner,lease_until,fence,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    id,
    "inbox",
    "derive_brief",
    "{}",
    "running",
    1,
    3,
    "2026-10-16T09:00:00Z",
    "w1",
    leaseUntil,
    1,
    "2026-10-16T09:00:00Z",
  );
  return { id, lease: { job_id: id, owner: "w1", fence: 1, expires_at: leaseUntil } };
}

function specFor(jobId: string, over: Partial<DispatchSpec> = {}): DispatchSpec {
  return {
    job_id: jobId,
    dispatch_key: "reasoning",
    stage: "reasoning",
    reserved_micro_usd: 100,
    provider: "synthetic",
    model: "synthetic",
    price_version: "synthetic-v1",
    request_hash: sha(`request:${jobId}`),
    config_hash: sha(`config:${jobId}`),
    ...over,
  };
}

function expectCode(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (error) {
    expect((error as BrainError).code).toBe(code);
    return;
  }
  throw new Error(`Expected BrainError ${code}`);
}

describe("managed dispatch coordinator", () => {
  it("reserves centrally and in the tenant, then links the projection", async () => {
    const f = build();
    const job = runningJob(f.store);
    const record = f.coordinator.reserve(specFor(job.id), job.lease, limits);
    expect(record.state).toBe("reserved");
    const central = f.central.receiptByProjection(record.call_id)!;
    expect(central.account_id).toBe(f.account.id);
    expect(central.reserved_micro_usd).toBe(100);
    expect(f.store.all("SELECT * FROM provider_dispatches")).toHaveLength(1);
  });

  it("denies a managed reserve when the central policy is zero", async () => {
    const f = build({ allowance: 0, service: 0, per_job: 0, user_daily: 0 });
    const job = runningJob(f.store);
    expectCode(
      () => f.coordinator.reserve(specFor(job.id), job.lease, limits),
      "BUDGET_EXHAUSTED",
    );
    expect(f.store.all("SELECT * FROM provider_dispatches")).toHaveLength(0);
  });

  it("refuses a job with unknown legacy history and requires reconciliation", async () => {
    const f = build();
    const job = runningJob(f.store);
    f.store.run("INSERT INTO reservations VALUES(?,?,?,?,?)", job.id, "2026-10-16", 5, 0, "held");
    expectCode(
      () => f.coordinator.reserve(specFor(job.id), job.lease, limits),
      "BUDGET_BLOCKED",
    );
    expect(f.store.all("SELECT * FROM provider_dispatches")).toHaveLength(0);
  });

  it("refuses an unmapped tenant dispatch record and a restored tenant block", async () => {
    const f = build();
    const job = runningJob(f.store);
    f.store.run(
      "INSERT INTO provider_dispatches(call_id,job_id,dispatch_key,stage,state,reserved_micro_usd,actual_micro_usd,provider,model,price_version,request_hash,config_hash,identity_hash,budget_day,time_zone,created_at,dispatched_at,settled_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      "tenant-only",
      job.id,
      "reasoning",
      "reasoning",
      "reserved",
      100,
      null,
      "synthetic",
      "synthetic",
      "synthetic-v1",
      sha(`request:${job.id}`),
      sha(`config:${job.id}`),
      sha("identity"),
      "2026-10-16",
      "UTC",
      "2026-10-16T09:00:00Z",
      null,
      null,
    );
    expectCode(
      () => f.coordinator.reserve(specFor(job.id), job.lease, limits),
      "BUDGET_BLOCKED",
    );

    const second = build();
    const job2 = runningJob(second.store);
    second.store.set(paidProcessingBlockedSetting, { reason: "restored_backup" });
    expectCode(
      () => second.coordinator.reserve(specFor(job2.id), job2.lease, limits),
      "BUDGET_BLOCKED",
    );
  });

  it("recovers a crash after central reserve but before tenant reserve", async () => {
    const f = build();
    const job = runningJob(f.store);
    const first = f.central.reserve({
      account_id: f.account.id,
      job_id: job.id,
      dispatch_key: "reasoning",
      stage: "reasoning",
      reserved_micro_usd: 100,
      provider: "synthetic",
      model: "synthetic",
      price_version: "synthetic-v1",
      request_hash: sha(`request:${job.id}`),
      config_hash: sha(`config:${job.id}`),
      limits: { per_job_micro_usd: 1000, user_daily_micro_usd: 1000, time_zone: "UTC" },
    });
    const record = f.coordinator.reserve(specFor(job.id), job.lease, limits);
    expect(f.central.receiptByProjection(record.call_id)!.call_id).toBe(first.call_id);
    expect(f.store.all("SELECT * FROM provider_dispatches")).toHaveLength(1);
  });

  it("recovers and links a tenant row orphaned before the projection link", async () => {
    const f = build();
    const job = runningJob(f.store);
    const tenantRow = f.tenant.reserve(specFor(job.id), job.lease, limits);
    const centralRow = f.central.reserve({
      account_id: f.account.id,
      job_id: job.id,
      dispatch_key: "reasoning",
      stage: "reasoning",
      reserved_micro_usd: 100,
      provider: "synthetic",
      model: "synthetic",
      price_version: "synthetic-v1",
      request_hash: sha(`request:${job.id}`),
      config_hash: sha(`config:${job.id}`),
      limits: { per_job_micro_usd: 1000, user_daily_micro_usd: 1000, time_zone: "UTC" },
    });
    const record = f.coordinator.reserve(specFor(job.id), job.lease, limits);
    expect(record.call_id).toBe(tenantRow.call_id);
    expect(f.central.receiptByProjection(tenantRow.call_id)!.call_id).toBe(centralRow.call_id);
    expect(f.store.all("SELECT * FROM provider_dispatches")).toHaveLength(1);
  });

  it("marks both stores on a fresh central CAS and refuses a second mark", async () => {
    const f = build();
    const job = runningJob(f.store);
    const record = f.coordinator.reserve(specFor(job.id), job.lease, limits);
    const marked = f.coordinator.markDispatched(record.call_id, job.lease);
    expect(marked.state).toBe("dispatched");
    expect(f.central.receiptByProjection(record.call_id)!.state).toBe("dispatched");
    expect(f.tenant.readReceipt(record.call_id)!.state).toBe("dispatched");
    expectCode(
      () => f.coordinator.markDispatched(record.call_id, job.lease),
      "ALREADY_DISPATCHED",
    );
  });

  it("refuses to execute when central is already dispatched but the tenant is not", async () => {
    const f = build();
    const job = runningJob(f.store);
    const record = f.coordinator.reserve(specFor(job.id), job.lease, limits);
    const centralRow = f.central.receiptByProjection(record.call_id)!;
    f.central.mark(centralRow.call_id, {
      per_job_micro_usd: 1000,
      user_daily_micro_usd: 1000,
      time_zone: "UTC",
    });
    expectCode(
      () => f.coordinator.markDispatched(record.call_id, job.lease),
      "ALREADY_DISPATCHED",
    );
    expect(f.tenant.readReceipt(record.call_id)!.state).toBe("reserved");
    expect(f.central.receiptByProjection(record.call_id)!.state).toBe("dispatched");
  });

  it("refuses to send and retains the central hold when the account is revoked before mark", async () => {
    const f = build();
    const job = runningJob(f.store);
    const record = f.coordinator.reserve(specFor(job.id), job.lease, limits);
    f.control.setAccountState(f.account.id, "suspended");
    expectCode(
      () => f.coordinator.markDispatched(record.call_id, job.lease),
      "UNAUTHORIZED",
    );
    expect(f.central.receiptByProjection(record.call_id)!.state).toBe("reserved");
  });

  it("settles centrally first, flags a projection failure, and reports the central charge", async () => {
    const f = build();
    const job = runningJob(f.store);
    const record = f.coordinator.reserve(specFor(job.id), job.lease, limits);
    f.coordinator.markDispatched(record.call_id, job.lease);
    // The tenant projection is already settled at a conflicting amount.
    f.tenant.settle(record.call_id, 9);

    const settled = f.coordinator.settle(record.call_id, 7);
    expect(settled.state).toBe("settled");
    expect(settled.actual_micro_usd).toBe(7);
    expect(
      f.central.readReceipt(f.central.receiptByProjection(record.call_id)!.call_id)
        .actual_micro_usd,
    ).toBe(7);
    expect(f.central.receiptByProjection(record.call_id)!.reconciliation_required).toBe(true);
    expect(f.tenant.readReceipt(record.call_id)!.actual_micro_usd).toBe(9);
    expect(f.coordinator.readReceipt(record.call_id)!.actual_micro_usd).toBe(7);
    expect(f.coordinator.receiptForJob(job.id)!.actual_micro_usd).toBe(7);
  });

  it("still attempts the tenant projection when the central settlement fails", async () => {
    const f = build();
    const job = runningJob(f.store);
    const record = f.coordinator.reserve(specFor(job.id), job.lease, limits);
    f.coordinator.markDispatched(record.call_id, job.lease);
    const centralRow = f.central.receiptByProjection(record.call_id)!;
    f.central.settleKnown(centralRow.call_id, 9);

    expectCode(() => f.coordinator.settle(record.call_id, 7), "SETTLEMENT_CONFLICT");
    expect(f.tenant.readReceipt(record.call_id)!.state).toBe("settled");
    expect(f.tenant.readReceipt(record.call_id)!.actual_micro_usd).toBe(7);
  });

  it("rejects a foreign projection id and reports a released hold as unsent", async () => {
    const c = makeControl();
    const a = makeTenant(c);
    const b = makeTenant(c);
    const jobB = runningJob(b.store);
    const bRecord = b.coordinator.reserve(specFor(jobB.id), jobB.lease, limits);
    expectCode(() => a.coordinator.readReceipt(bRecord.call_id), "UNAUTHORIZED");
    expectCode(
      () => a.coordinator.markDispatched(bRecord.call_id, jobB.lease),
      "UNAUTHORIZED",
    );

    const jobA = runningJob(a.store);
    const aRecord = a.coordinator.reserve(specFor(jobA.id), jobA.lease, limits);
    a.coordinator.releaseUndispatched(aRecord.call_id);
    expect(a.coordinator.receiptForJob(jobA.id)!.state).toBe("released");
    expect(a.coordinator.hasUnresolved(jobA.id)).toBe(false);
  });

  it("refuses to bind a coordinator to a different control's account", async () => {
    const a = build();
    const b = build();
    expect(
      () => new ManagedDispatchAccounting(a.central, b.brain, clock),
    ).toThrow("bound");
  });

  it("releases an unmarked hold in both stores and never refunds a marked call", async () => {
    const f = build();
    const job = runningJob(f.store);
    const record = f.coordinator.reserve(specFor(job.id), job.lease, limits);
    const released = f.coordinator.releaseUndispatched(record.call_id);
    expect(released.state).toBe("released");
    expect(f.central.receiptByProjection(record.call_id)!.state).toBe("released");

    const job2 = runningJob(f.store);
    const marked = f.coordinator.reserve(specFor(job2.id), job2.lease, limits);
    f.coordinator.markDispatched(marked.call_id, job2.lease);
    expectCode(
      () => f.coordinator.releaseUndispatched(marked.call_id),
      "INVALID_STATE",
    );
    expect(f.central.receiptByProjection(marked.call_id)!.state).toBe("dispatched");
    expect(f.tenant.readReceipt(marked.call_id)!.state).toBe("dispatched");
  });

  it("denies a fresh job when an unmapped paid record exists on another job", async () => {
    const f = build();
    const oldJob = runningJob(f.store);
    f.store.run(
      "INSERT INTO provider_dispatches(call_id,job_id,dispatch_key,stage,state,reserved_micro_usd,actual_micro_usd,provider,model,price_version,request_hash,config_hash,identity_hash,budget_day,time_zone,created_at,dispatched_at,settled_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      "orphan-other",
      oldJob.id,
      "reasoning",
      "reasoning",
      "settled",
      10,
      10,
      "synthetic",
      "synthetic",
      "synthetic-v1",
      sha(`request:${oldJob.id}`),
      sha(`config:${oldJob.id}`),
      sha("identity"),
      "2026-10-16",
      "UTC",
      "2026-10-16T09:00:00Z",
      "2026-10-16T09:00:00Z",
      "2026-10-16T09:00:00Z",
    );
    const freshJob = runningJob(f.store);
    expectCode(
      () => f.coordinator.reserve(specFor(freshJob.id), freshJob.lease, limits),
      "BUDGET_BLOCKED",
    );
  });

  it("denies when a mapped tenant row's stage does not match the central row", async () => {
    const f = build();
    const job = runningJob(f.store);
    f.central.reserve({
      account_id: f.account.id,
      job_id: job.id,
      dispatch_key: "reasoning",
      stage: "reasoning",
      reserved_micro_usd: 100,
      provider: "synthetic",
      model: "synthetic",
      price_version: "synthetic-v1",
      request_hash: sha(`request:${job.id}`),
      config_hash: sha(`config:${job.id}`),
      limits: { per_job_micro_usd: 1000, user_daily_micro_usd: 1000, time_zone: "UTC" },
    });
    f.store.run(
      "INSERT INTO provider_dispatches(call_id,job_id,dispatch_key,stage,state,reserved_micro_usd,actual_micro_usd,provider,model,price_version,request_hash,config_hash,identity_hash,budget_day,time_zone,created_at,dispatched_at,settled_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      "stage-mismatch",
      job.id,
      "reasoning",
      "decision",
      "reserved",
      100,
      null,
      "synthetic",
      "synthetic",
      "synthetic-v1",
      sha(`request:${job.id}`),
      sha(`config:${job.id}`),
      sha("identity"),
      "2026-10-16",
      "UTC",
      "2026-10-16T09:00:00Z",
      null,
      null,
    );
    expectCode(
      () => f.coordinator.reserve(specFor(job.id), job.lease, limits),
      "BUDGET_BLOCKED",
    );
  });

  it("returns the central authority state after a tenant projection drift", async () => {
    const f = build();
    const job = runningJob(f.store);
    const record = f.coordinator.reserve(specFor(job.id), job.lease, limits);
    // Drift the tenant projection away from the central authority.
    f.store.run(
      "UPDATE provider_dispatches SET state='dispatched' WHERE call_id=?",
      record.call_id,
    );
    const again = f.coordinator.reserve(specFor(job.id), job.lease, limits);
    expect(again.call_id).toBe(record.call_id);
    expect(again.state).toBe("reserved");
  });

  it("records a failed central settlement as a durable service-wide deny", async () => {
    const f = build({ service: 30 });
    const job = runningJob(f.store);
    const record = f.coordinator.reserve(
      specFor(job.id, { reserved_micro_usd: 10 }),
      job.lease,
      limits,
    );
    f.coordinator.markDispatched(record.call_id, job.lease);
    f.control.db.exec(
      "CREATE TRIGGER settle_fail BEFORE UPDATE OF state ON managed_reservations WHEN NEW.state='settled' BEGIN SELECT RAISE(ABORT,'forced central settle failure'); END;",
    );
    expect(() => f.coordinator.settle(record.call_id, 20)).toThrow();

    // The tenant projection still recorded the known actual charge.
    expect(f.tenant.readReceipt(record.call_id)!.actual_micro_usd).toBe(20);
    // The centre is still unresolved and durably denies future admission.
    expect(f.central.receiptByProjection(record.call_id)!.state).toBe("dispatched");
    const status = f.central.accountStatus(f.account.id);
    expect(status.blocked).toBe(true);
    expect(status.blocked_reason).toBe("reconciliation_required");

    // Another account on the same control store can no longer reserve.
    const b = makeTenant(f);
    const jobB = runningJob(b.store);
    expectCode(
      () => b.coordinator.reserve(specFor(jobB.id), jobB.lease, limits),
      "BUDGET_BLOCKED",
    );
  });
});
