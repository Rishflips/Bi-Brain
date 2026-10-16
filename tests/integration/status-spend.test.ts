import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../../packages/storage/index.ts";
import { Brain } from "../../packages/domain/service.ts";
import { Worker } from "../../apps/worker/engine.ts";
import { DispatchLedger, paidProcessingBlockedSetting } from "../../packages/storage/spend.ts";
import { hash } from "../../packages/domain/logic.ts";
import type { DispatchSpec, JobLease, SpendLimits } from "../../packages/domain/spend.ts";

const owner = { kind: "owner" } as const;
let current = "2026-10-16T09:00:00Z";
const clock = () => new Date(current);
const dirs: string[] = [];
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
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

let jobSeq = 0;
function runningJob(store: Storage): { id: string; lease: JobLease } {
  const id = `job-${++jobSeq}-${hash(String(jobSeq)).slice(0, 8)}`;
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

const limitsUTC: SpendLimits = {
  per_job_micro_usd: 1000,
  daily_micro_usd: 1000,
  time_zone: "UTC",
};

function specFor(jobId: string, reserved: number): DispatchSpec {
  return {
    job_id: jobId,
    dispatch_key: "reasoning",
    stage: "reasoning",
    reserved_micro_usd: reserved,
    provider: "test",
    model: "test",
    price_version: "test",
    request_hash: hash("req:" + jobId),
    config_hash: hash("cfg:" + jobId),
  };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "bibrain-status-spend-"));
  dirs.push(dir);
  const store = new Storage(join(dir, "brain.sqlite"));
  stores.push(store);
  const b = new Brain(store, clock);
  b.prefs(owner, {
    ...b.prefs(owner),
    time_zone: "UTC",
    provider_enabled: true,
    daily_cap_micro_usd: 1000,
    per_job_cap_micro_usd: 1000,
  });
  const ledger = new DispatchLedger(store, clock);
  return { store, b, ledger };
}

describe("authoritative spend status", () => {
  it("counts known legacy and new settled spend for the frozen day plus every unresolved hold", () => {
    const { store, b, ledger } = setup();

    // New settled today (7) and new hold today (5).
    const settledJob = runningJob(store);
    const settled = ledger.reserve(specFor(settledJob.id, 10), settledJob.lease, limitsUTC);
    ledger.markDispatched(settled.call_id, settledJob.lease);
    ledger.settle(settled.call_id, 7);
    const holdJob = runningJob(store);
    const hold = ledger.reserve(specFor(holdJob.id, 5), holdJob.lease, limitsUTC);
    ledger.markDispatched(hold.call_id, holdJob.lease);

    // A new hold from an earlier day must still count as unresolved.
    const oldJob = runningJob(store);
    store.run(
      `INSERT INTO provider_dispatches(call_id,job_id,dispatch_key,stage,state,reserved_micro_usd,actual_micro_usd,provider,model,price_version,request_hash,config_hash,identity_hash,budget_day,time_zone,created_at,dispatched_at,settled_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      "call-old",
      oldJob.id,
      "reasoning",
      "reasoning",
      "dispatched",
      3,
      null,
      "test",
      "test",
      "test",
      hash("req:old"),
      hash("cfg:old"),
      hash("id:old"),
      "2026-10-15",
      "UTC",
      "2026-10-15T08:00:00Z",
      "2026-10-15T08:00:00Z",
      null,
    );

    // Legacy rows: settled today (40), held today (20), held earlier (4), settled earlier (30).
    const legacy = (day: string, reserved: number, actual: number, status: string) => {
      const j = runningJob(store);
      store.run("INSERT INTO reservations VALUES(?,?,?,?,?)", j.id, day, reserved, actual, status);
    };
    legacy("2026-10-16", 40, 40, "settled");
    legacy("2026-10-16", 20, 0, "held");
    legacy("2026-10-15", 4, 0, "held");
    legacy("2026-10-15", 30, 30, "settled");

    const spend = b.status(owner).spend;
    expect(spend.settled_micro_usd).toBe(7 + 40); // new + legacy, today only
    expect(spend.unresolved_micro_usd).toBe(5 + 3 + 20 + 4); // every unresolved hold, any day
    expect(spend.actual).toBe(spend.settled_micro_usd); // alias preserved
    expect(spend.reserved).toBe(spend.unresolved_micro_usd); // alias preserved
    expect(spend.unresolved_micro_usd).toBeGreaterThan(0);
    expect(spend.budget_day).toBe("2026-10-16");
    expect(spend.time_zone).toBe("UTC");
    expect(spend.remaining_micro_usd).toBe(1000 - (47 + 32));
    expect(spend.blocked).toBe(false);
    expect(spend.blocked_reason).toBeNull();
    expect(spend.blocked_message).toBeNull();
  });

  it("keeps the frozen accounting zone when scheduling preferences change", () => {
    const { store, b, ledger } = setup();
    const job = runningJob(store);
    const rec = ledger.reserve(specFor(job.id, 10), job.lease, limitsUTC);
    ledger.markDispatched(rec.call_id, job.lease);
    ledger.settle(rec.call_id, 4);

    // Move the wall clock to where Asia/Calcutta is a different local day.
    current = "2026-10-16T20:30:00Z";
    b.prefs(owner, { ...b.prefs(owner), time_zone: "Asia/Calcutta" });

    const spend = b.status(owner).spend;
    expect(spend.time_zone).toBe("UTC");
    expect(spend.budget_day).toBe("2026-10-16");
    expect(spend.settled_micro_usd).toBe(4);
  });

  it("refuses to re-enable paid processing under an over-bound block and names the reason", () => {
    const { store, b, ledger } = setup();
    const job = runningJob(store);
    const rec = ledger.reserve(specFor(job.id, 1), job.lease, limitsUTC);
    ledger.markDispatched(rec.call_id, job.lease);
    ledger.settle(rec.call_id, 50); // actual exceeds reserved -> durable block

    const spend = b.status(owner).spend;
    expect(spend.blocked).toBe(true);
    expect(spend.blocked_reason).toBe("overrun");
    expect(spend.blocked_message).toContain("exceeded");
    expect(spend.blocked_message?.toLowerCase()).not.toContain("unknown charge");

    // Stored consent was true, but the effective view is unavailable and does
    // not silently re-enable or rewrite history.
    expect(b.prefs(owner).provider_enabled).toBe(false);
    expect(b.status(owner).mode).toBe("Extractive preview");
    expect(() =>
      b.prefs(owner, { ...b.prefs(owner), provider_enabled: true }),
    ).toThrow("blocked");

    // Turning off / updating unrelated preferences is still allowed.
    const updated = b.prefs(owner, {
      ...b.prefs(owner),
      provider_enabled: false,
      daily_cap_micro_usd: 500,
    });
    expect(updated.daily_cap_micro_usd).toBe(500);

    // A block does not disable capture, search, export or extractive processing.
    b.capture(owner, { title: "note", body: "SYNTHETIC after block" });
    expect(b.sources(owner).some((s) => s.body.includes("SYNTHETIC after block"))).toBe(true);
    expect(b.export(owner)).toBeTruthy();
    expect(store.setting(paidProcessingBlockedSetting, null)).not.toBeNull();
  });

  it("maps a restored-backup block to a recovery reason, not an unknown charge", () => {
    const { store, b } = setup();
    store.set(paidProcessingBlockedSetting, {
      reason: "restored_backup",
      at: "2026-10-16T09:00:00Z",
    });
    const spend = b.status(owner).spend;
    expect(spend.blocked).toBe(true);
    expect(spend.blocked_reason).toBe("recovery");
    expect(spend.blocked_message?.toLowerCase()).toContain("restore");
    expect(spend.blocked_message?.toLowerCase()).not.toContain("unknown charge");
  });

  it("publishes extractively while blocked and never fabricates history for a late settlement", async () => {
    const { store, b, ledger } = setup();
    const job = runningJob(store);
    const rec = ledger.reserve(specFor(job.id, 10), job.lease, limitsUTC);
    ledger.markDispatched(rec.call_id, job.lease);

    // A historic receipt that recorded an unknown hold must stay untouched.
    const receipt = b.createEntity("inbox", "receipt", {
      job_id: job.id,
      outcome: "failed",
      usage_status: "unknown",
      cost_micro_usd: null,
    });
    store.set(paidProcessingBlockedSetting, { reason: "restored_backup", at: "2026-10-16T09:00:00Z" });

    // Blocked: ordinary paid is skipped, but extractive still runs.
    b.capture(owner, { title: "note", body: "SYNTHETIC extractive while blocked" });
    await new Worker(b).tick();
    expect(b.entities(owner, "brief").length).toBeGreaterThan(0);

    // A later known settlement is visible through the authoritative ledger,
    // without rewriting the historic receipt.
    ledger.settle(rec.call_id, 6);
    expect(b.status(owner).spend.settled_micro_usd).toBe(6);
    expect(b.entity(owner, receipt.id).data).toMatchObject({
      usage_status: "unknown",
      cost_micro_usd: null,
    });
  });
});
