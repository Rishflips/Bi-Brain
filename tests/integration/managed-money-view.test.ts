import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedRuntime } from "../../packages/runtime/managed.ts";
import { ManagedSpendingStore } from "../../packages/storage/managed-spending.ts";
import { ManagedDispatchAccounting } from "../../apps/worker/managed-accounting.ts";
import { Storage } from "../../packages/storage/index.ts";
import { Brain } from "../../packages/domain/service.ts";
import type { DispatchSpec, JobLease, SpendLimits } from "../../packages/domain/spend.ts";

/**
 * Own-account managed money view over the real managed runtime.
 *
 * Every case is a direct, deterministic read: no provider, no network and no
 * browser. The central authority is the only source of the figures.
 */

const ISSUER = "https://issuer.synthetic.test";
let current = "2026-10-16T09:00:00Z";
let seq = 0;
const clock = () => new Date(current);
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

const roots: string[] = [];
const runtimes: ManagedRuntime[] = [];
afterEach(() => {
  current = "2026-10-16T09:00:00Z";
  for (const runtime of runtimes.splice(0)) {
    try {
      runtime.close();
    } catch {
      /* handles released per case */
    }
  }
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function managed() {
  const root = mkdtempSync(join(tmpdir(), "bibrain-managed-money-"));
  roots.push(root);
  const runtime = new ManagedRuntime(root, { clock });
  runtimes.push(runtime);
  const central = new ManagedSpendingStore(runtime.control, clock);
  return { runtime, central };
}

const limits: SpendLimits = {
  per_job_micro_usd: 1000,
  daily_micro_usd: 1000,
  time_zone: "UTC",
};

function grant(
  central: ManagedSpendingStore,
  id: string,
  over: Record<string, number> = {},
) {
  central.configureAccountPeriod({
    account_id: id,
    starts_at: "2026-10-16T00:00:00Z",
    ends_at: "2026-10-18T00:00:00Z",
    allowance_micro_usd: over.allowance ?? 1000,
  });
  central.setServicePolicy({ daily_micro_usd: over.service ?? 1000 });
  central.setAccountPolicy({
    account_id: id,
    per_job_micro_usd: over.perJob ?? 1000,
    user_daily_micro_usd: over.userDaily ?? 1000,
  });
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

function specFor(jobId: string, amount: number): DispatchSpec {
  return {
    job_id: jobId,
    dispatch_key: "reasoning",
    stage: "reasoning",
    reserved_micro_usd: amount,
    provider: "synthetic",
    model: "synthetic",
    price_version: "synthetic-v1",
    request_hash: sha(`request:${jobId}`),
    config_hash: sha(`config:${jobId}`),
  };
}

function ownerBrain(runtime: ManagedRuntime, id: string) {
  const h = runtime.acquire(id);
  const owner = h.brain.ownerPrincipal();
  h.brain.prefs(owner, {
    ...h.brain.prefs(owner),
    time_zone: "UTC",
    per_job_cap_micro_usd: 1000,
    daily_cap_micro_usd: 1000,
  });
  return { h, owner, brain: h.brain };
}

describe("own-account managed money view", () => {
  it("shows the known central actual, not a stale tenant projection", async () => {
    const { runtime, central } = managed();
    const a = await runtime.provision(ISSUER, "view-a");
    grant(central, a.id);
    const { h, owner, brain } = ownerBrain(runtime, a.id);
    try {
      const job = runningJob(brain.store);
      const coord = new ManagedDispatchAccounting(central, brain, clock);
      const rec = coord.reserve(specFor(job.id, 10), job.lease, limits);
      coord.markDispatched(rec.call_id, job.lease);
      coord.settle(rec.call_id, 5);
      // Drift the tenant projection to a stale held 10.
      brain.store.run(
        "UPDATE provider_dispatches SET state='dispatched',actual_micro_usd=NULL WHERE call_id=?",
        rec.call_id,
      );
      const status = brain.status(owner);
      expect(status.spend.actual).toBe(5);
      expect(status.spend.settled_micro_usd).toBe(5);
      expect(status.spend.reserved).toBe(0);
      expect(status.spend.unresolved_micro_usd).toBe(0);
      expect(status.spend.available).toBe(false);
    } finally {
      h.release();
    }
  });

  it("keeps each account's own money and strips the global service figures", async () => {
    const { runtime, central } = managed();
    const a = await runtime.provision(ISSUER, "iso-a");
    const b = await runtime.provision(ISSUER, "iso-b");
    grant(central, a.id, { service: 777 });
    grant(central, b.id, { service: 777 });
    const ha = ownerBrain(runtime, a.id);
    const hb = ownerBrain(runtime, b.id);
    try {
      const jobA = runningJob(ha.brain.store);
      const coordA = new ManagedDispatchAccounting(central, ha.brain, clock);
      const recA = coordA.reserve(specFor(jobA.id, 10), jobA.lease, limits);
      coordA.markDispatched(recA.call_id, jobA.lease);
      coordA.settle(recA.call_id, 5);

      const jobB = runningJob(hb.brain.store);
      const coordB = new ManagedDispatchAccounting(central, hb.brain, clock);
      coordB.reserve(specFor(jobB.id, 20), jobB.lease, limits);

      const statusA = ha.brain.status(ha.owner);
      const statusB = hb.brain.status(hb.owner);
      expect(statusA.spend.settled_micro_usd).toBe(5);
      expect(statusA.spend.unresolved_micro_usd).toBe(0);
      expect(statusB.spend.unresolved_micro_usd).toBe(20);
      expect(statusB.spend.settled_micro_usd).toBe(0);

      const publicA = JSON.stringify(statusA.spend);
      expect(publicA).not.toContain(b.id);
      // The global service cap and any service-wide committed total are stripped.
      expect(publicA).not.toContain("777");
      expect(publicA).not.toContain("service_day_micro_usd");
      expect(Object.keys(statusA.spend)).not.toContain("service");
      expect(statusA.spend.service_available).toBe(true);
    } finally {
      ha.h.release();
      hb.h.release();
    }
  });

  it("serves an unconfigured account a truthful unavailable view and keeps capture", async () => {
    const { runtime } = managed();
    const c = await runtime.provision(ISSUER, "view-zero");
    const { h, owner, brain } = ownerBrain(runtime, c.id);
    try {
      const status = brain.status(owner);
      expect(status.spend.configured).toBe(false);
      expect(status.spend.blocked).toBe(false);
      expect(status.spend.remaining_micro_usd).toBe(0);
      expect(status.spend.available).toBe(false);
      const saved = brain.capture(owner, {
        project_id: "inbox",
        title: "note",
        body: "SYNTHETIC_ZERO_POLICY_CAPTURE",
      });
      expect(saved.source_id).toBeTruthy();
      // An unconfigured policy cannot be enabled through preferences.
      expect(brain.prefs(owner).provider_enabled).toBe(false);
      expect(() =>
        brain.prefs(owner, { ...brain.prefs(owner), provider_enabled: true }),
      ).toThrow();
    } finally {
      h.release();
    }
  });

  it("denies a suspended account's money read", async () => {
    const { runtime, central } = managed();
    const a = await runtime.provision(ISSUER, "view-suspend");
    grant(central, a.id);
    const { h, owner, brain } = ownerBrain(runtime, a.id);
    try {
      runtime.control.setAccountState(a.id, "suspended");
      expect(() => brain.status(owner)).toThrow();
    } finally {
      h.release();
    }
  });

  it("maps a durable central block to a content-free paused view while capture works", async () => {
    const { runtime, central } = managed();
    const a = await runtime.provision(ISSUER, "view-block");
    grant(central, a.id);
    const { h, owner, brain } = ownerBrain(runtime, a.id);
    try {
      const job = runningJob(brain.store);
      const coord = new ManagedDispatchAccounting(central, brain, clock);
      const rec = coord.reserve(specFor(job.id, 10), job.lease, limits);
      coord.markDispatched(rec.call_id, job.lease);
      central.flagSettlementFailure(central.receiptByProjection(rec.call_id)!.call_id);

      const status = brain.status(owner);
      expect(status.spend.blocked).toBe(true);
      expect(status.spend.blocked_reason).toBe("reconciliation_required");
      expect(status.spend.blocked_message).toBeTruthy();
      expect(/[0-9]/.test(status.spend.blocked_message!)).toBe(false);
      const saved = brain.capture(owner, {
        project_id: "inbox",
        title: "note",
        body: "SYNTHETIC_CAPTURE_WHILE_BLOCKED",
      });
      expect(saved.source_id).toBeTruthy();
    } finally {
      h.release();
    }
  });

  it("leaves the local single-owner status unchanged", () => {
    const store = new Storage(":memory:");
    try {
      const brain = new Brain(store, clock);
      const spend = brain.status({ kind: "owner" }).spend as any;
      expect(spend.configured).toBe(false);
      expect(spend.allowance).toBeNull();
      expect(typeof spend.settled_micro_usd).toBe("number");
      expect(typeof spend.unresolved_micro_usd).toBe("number");
    } finally {
      store.close();
    }
  });
});
