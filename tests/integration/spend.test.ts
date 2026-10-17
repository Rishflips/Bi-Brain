import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../../packages/storage/index.ts";
import {
  DispatchLedger,
  accountingTimeZoneSetting,
  paidProcessingBlockedSetting,
} from "../../packages/storage/spend.ts";
import { BrainError } from "../../packages/domain/logic.ts";
import {
  checkedSum,
  maxMicroUsd,
  type DispatchSpec,
  type JobLease,
  type SpendLimits,
} from "../../packages/domain/spend.ts";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
let hashSeq = 0;
const nextHash = (label: string) => sha(`${label}:${++hashSeq}`);

function testClock(start: string) {
  let current = start;
  return {
    now: () => new Date(current),
    set: (iso: string) => (current = iso),
  };
}

const limits = (over: Partial<SpendLimits> = {}): SpendLimits => ({
  per_job_micro_usd: 10,
  daily_micro_usd: 20,
  time_zone: "UTC",
  ...over,
});

function spec(jobId: string, over: Partial<DispatchSpec> = {}): DispatchSpec {
  return {
    job_id: jobId,
    dispatch_key: "decision",
    stage: "decision",
    reserved_micro_usd: 10,
    provider: "test-provider",
    model: "test-model",
    price_version: "2026-10-16.1",
    request_hash: nextHash("request"),
    config_hash: nextHash("config"),
    ...over,
  };
}

function runningJob(
  store: Storage,
  over: Partial<{ owner: string; fence: number; leaseUntil: string; status: string }> = {},
): { id: string; lease: JobLease } {
  const id = `job-${nextHash("job").slice(0, 12)}`;
  const owner = over.owner ?? "worker-1";
  const fence = over.fence ?? 1;
  const leaseUntil = over.leaseUntil ?? "2026-10-16T09:10:00Z";
  store.run(
    "INSERT INTO jobs(id,project_id,kind,payload,status,attempts,max_attempts,next_at,lease_owner,lease_until,fence,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    id,
    "inbox",
    "derive_brief",
    "{}",
    over.status ?? "running",
    1,
    3,
    "2026-10-16T09:00:00Z",
    owner,
    leaseUntil,
    fence,
    "2026-10-16T09:00:00Z",
  );
  return { id, lease: { job_id: id, owner, fence, expires_at: leaseUntil } };
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), "bibrain-spend-"));
}

function removeDir(dir: string) {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

function expectCode(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(BrainError);
    expect((error as BrainError).code).toBe(code);
    return;
  }
  throw new Error(`Expected BrainError ${code}`);
}

/**
 * A separate process takes the SQLite write lock for `ms`, then releases it.
 * It resolves only once the lock is actually held, so the caller can be sure
 * the next ledger call waits for the lock.
 */
async function holdWriteLock(path: string, ms: number) {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1]);
      db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
      process.stdout.write('locked\\n');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${ms});
      db.exec('ROLLBACK'); db.close();
    `,
      path,
    ],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  await new Promise<void>((resolve, reject) => {
    child.stdout!.once("data", () => resolve());
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) reject(new Error("Synthetic SQLite lock holder failed."));
    });
  });
  return child;
}

describe("per-dispatch accounting", () => {
  it("shares one cumulative cap across decision and reasoning stages and never reports unknown spend as zero", () => {
    const store = new Storage(":memory:");
    const clock = testClock("2026-10-16T09:00:00Z");
    const ledger = new DispatchLedger(store, clock.now);
    const job = runningJob(store);

    const first = ledger.reserve(spec(job.id, { reserved_micro_usd: 10 }), job.lease, limits());
    expect(first.state).toBe("reserved");
    expect(first.actual_micro_usd).toBeNull();
    expect(first.budget_day).toBe("2026-10-16");
    expect(first.time_zone).toBe("UTC");

    const dispatched = ledger.markDispatched(first.call_id, job.lease);
    expect(dispatched.state).toBe("dispatched");
    expect(dispatched.dispatched_at).toBeTruthy();

    const settled = ledger.settle(first.call_id, 6);
    expect(settled.state).toBe("settled");
    expect(settled.actual_micro_usd).toBe(6);

    expectCode(
      () =>
        ledger.reserve(
          spec(job.id, {
            dispatch_key: "reasoning",
            stage: "reasoning",
            reserved_micro_usd: 5,
          }),
          job.lease,
          limits(),
        ),
      "BUDGET_EXHAUSTED",
    );
    expect(ledger.jobSpend(job.id)).toBe(6);
    store.close();
  });

  it("returns the existing record for a duplicate slot and never grants a second dispatch", () => {
    const store = new Storage(":memory:");
    const clock = testClock("2026-10-16T09:00:00Z");
    const ledger = new DispatchLedger(store, clock.now);
    const job = runningJob(store);
    const slot = spec(job.id);
    const first = ledger.reserve(slot, job.lease, limits());

    const duplicate = ledger.reserve(slot, job.lease, limits());
    expect(duplicate.call_id).toBe(first.call_id);
    expect(duplicate.state).toBe("reserved");
    expect(store.get("SELECT count(*) AS n FROM provider_dispatches")!.n).toBe(1);

    ledger.markDispatched(first.call_id, job.lease);
    // A repeat of the same slot only exposes that it is already dispatched.
    const afterDispatch = ledger.reserve(slot, job.lease, limits());
    expect(afterDispatch.call_id).toBe(first.call_id);
    expect(afterDispatch.state).toBe("dispatched");
    expectCode(() => ledger.markDispatched(first.call_id, job.lease), "ALREADY_DISPATCHED");
    expect(store.get("SELECT count(*) AS n FROM provider_dispatches")!.n).toBe(1);
    store.close();
  });

  it("rejects a changed hash or changed content on the same slot", () => {
    const store = new Storage(":memory:");
    const clock = testClock("2026-10-16T09:00:00Z");
    const ledger = new DispatchLedger(store, clock.now);
    const job = runningJob(store);
    ledger.reserve(spec(job.id), job.lease, limits());

    expectCode(
      () =>
        ledger.reserve(
          spec(job.id, { request_hash: nextHash("request") }),
          job.lease,
          limits(),
        ),
      "DISPATCH_CONFLICT",
    );
    expectCode(
      () => ledger.reserve(spec(job.id, { reserved_micro_usd: 9 }), job.lease, limits()),
      "DISPATCH_CONFLICT",
    );
    store.close();
  });

  it("upgrades a schema-3-equivalent database through migration 4 once and preserves legacy reservations", () => {
    const dir = tempDir();
    const path = join(dir, "brain.sqlite");
    try {
      let store = new Storage(path);
      const legacyJob = runningJob(store);
      store.run(
        "INSERT INTO reservations VALUES(?,?,?,?,?)",
        legacyJob.id,
        "2026-10-16",
        7,
        0,
        "held",
      );
      // This older equivalent-schema test is not the genuine frozen-v4 proof.
      // Remove later advisory tables too, rather than leave a v5 marker behind.
      store.transaction(() => {
        store.run("DROP TABLE IF EXISTS advisory_tombstones");
        store.run("DROP TABLE IF EXISTS advisory_attempts");
        store.run("DROP TABLE provider_dispatches");
        store.run("DELETE FROM migrations WHERE version>=4");
      });
      store.close();

      store = new Storage(path);
      expect(Number(store.get("SELECT max(version) AS v FROM migrations")!.v)).toBe(5);
      expect(Number(store.get("SELECT count(*) AS n FROM migrations WHERE version=4")!.n)).toBe(
        1,
      );
      expect(
        store.get(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='provider_dispatches'",
        ),
      ).toBeTruthy();

      const preserved = store.all("SELECT * FROM reservations");
      expect(preserved).toHaveLength(1);
      expect(preserved[0].reserved).toBe(7);
      expect(preserved[0].actual).toBe(0);
      expect(preserved[0].status).toBe("held");
      expect(preserved[0].day).toBe("2026-10-16");

      const clock = testClock("2026-10-16T09:00:00Z");
      const ledger = new DispatchLedger(store, clock.now);
      const summary = ledger.summary(limits());
      // Legacy held spend counts as an unresolved hold, not zero.
      expect(summary.unresolved_micro_usd).toBe(7);
      expect(summary.committed_micro_usd).toBe(7);
      expect(summary.legacy_reservations).toBe(1);
      expect(summary.provider_dispatches).toBe(0);

      // Any legacy reservation on the job prevents a new dispatch.
      expectCode(
        () => ledger.reserve(spec(legacyJob.id), legacyJob.lease, limits()),
        "BUDGET_EXHAUSTED",
      );
      store.close();
    } finally {
      removeDir(dir);
    }
  });

  it("shares admission state across two SQLite connections so a committed hold cannot be overspent", () => {
    const dir = tempDir();
    const path = join(dir, "brain.sqlite");
    try {
      const a = new Storage(path);
      const b = new Storage(path);
      const clock = testClock("2026-10-16T09:00:00Z");
      const ledgerA = new DispatchLedger(a, clock.now);
      const ledgerB = new DispatchLedger(b, clock.now);
      const jobA = runningJob(a, { owner: "worker-a" });
      const jobB = runningJob(b, { owner: "worker-b" });
      const tight = limits({ per_job_micro_usd: 6, daily_micro_usd: 6 });

      const winner = ledgerA.reserve(
        spec(jobA.id, { reserved_micro_usd: 6 }),
        jobA.lease,
        tight,
      );
      expect(winner.state).toBe("reserved");
      // The second connection observes the first connection's committed hold.
      expectCode(
        () => ledgerB.reserve(spec(jobB.id, { reserved_micro_usd: 6 }), jobB.lease, tight),
        "BUDGET_EXHAUSTED",
      );
      expect(a.get("SELECT count(*) AS n FROM provider_dispatches")!.n).toBe(1);
      expect(b.get("SELECT count(*) AS n FROM provider_dispatches")!.n).toBe(1);
      expect(ledgerA.jobSpend(jobA.id)).toBe(6);
      a.close();
      b.close();
    } finally {
      removeDir(dir);
    }
  });

  it("keeps unresolved holds across restart, midnight and cancellation, then settles after cancellation", () => {
    const dir = tempDir();
    const path = join(dir, "brain.sqlite");
    try {
      let store = new Storage(path);
      const clock = testClock("2026-10-16T23:30:00Z");
      let ledger = new DispatchLedger(store, clock.now);
      const job1 = runningJob(store, { leaseUntil: "2026-10-16T23:40:00Z" });
      const hold = ledger.reserve(
        spec(job1.id, { reserved_micro_usd: 6 }),
        job1.lease,
        limits(),
      );
      ledger.markDispatched(hold.call_id, job1.lease);
      expect(ledger.summary(limits()).unresolved_micro_usd).toBe(6);
      store.close();

      // Restart preserves the hold.
      store = new Storage(path);
      ledger = new DispatchLedger(store, clock.now);
      expect(ledger.summary(limits()).unresolved_micro_usd).toBe(6);

      // Midnight: the older-day hold is still an unresolved hold.
      clock.set("2026-10-17T00:30:00Z");
      const day2 = ledger.summary(limits());
      expect(day2.budget_day).toBe("2026-10-17");
      expect(day2.unresolved_micro_usd).toBe(6);

      // A new job cannot spend past the daily cap while the older hold is open.
      const job2 = runningJob(store, { owner: "worker-2", leaseUntil: "2026-10-17T01:00:00Z" });
      const roomier = limits({ per_job_micro_usd: 20, daily_micro_usd: 20 });
      expectCode(
        () =>
          ledger.reserve(
            spec(job2.id, { reserved_micro_usd: 15 }),
            job2.lease,
            roomier,
          ),
        "BUDGET_EXHAUSTED",
      );

      // Cancel the first job: the hold survives and settlement still lands.
      store.run("UPDATE jobs SET status='cancelled',fence=fence+1 WHERE id=?", job1.id);
      const settled = ledger.settle(hold.call_id, 6);
      expect(settled.state).toBe("settled");
      expect(settled.actual_micro_usd).toBe(6);
      expect(ledger.jobSpend(job1.id)).toBe(6);
      expect(ledger.summary(limits()).unresolved_micro_usd).toBe(0);

      // Day-2 allowance is available once the day-1 hold is settled.
      const admitted = ledger.reserve(
        spec(job2.id, { reserved_micro_usd: 15 }),
        job2.lease,
        roomier,
      );
      expect(admitted.state).toBe("reserved");
      store.close();
    } finally {
      removeDir(dir);
    }
  });

  it("freezes the accounting time zone at first admission and rejects attempts to change it", () => {
    const store = new Storage(":memory:");
    const clock = testClock("2026-10-16T09:00:00Z");
    const ledger = new DispatchLedger(store, clock.now);
    const job1 = runningJob(store);
    ledger.reserve(spec(job1.id), job1.lease, limits());
    expect(store.setting(accountingTimeZoneSetting, "")).toBe("UTC");

    const job2 = runningJob(store, { owner: "worker-2" });
    expectCode(
      () =>
        ledger.reserve(
          spec(job2.id),
          job2.lease,
          limits({ time_zone: "Pacific/Kiritimati" }),
        ),
      "ACCOUNTING_TIMEZONE_FROZEN",
    );
    // Reads and future days keep using the frozen zone, not the new preference.
    const summary = ledger.summary(limits({ time_zone: "Pacific/Kiritimati" }));
    expect(summary.time_zone).toBe("UTC");
    expect(summary.budget_day).toBe("2026-10-16");
    clock.set("2026-10-16T23:30:00Z");
    expect(ledger.summary(limits()).budget_day).toBe("2026-10-16");
    store.close();
  });

  it("settles idempotently, rejects conflicting settlement and refuses to settle an unsent hold", () => {
    const store = new Storage(":memory:");
    const clock = testClock("2026-10-16T09:00:00Z");
    const ledger = new DispatchLedger(store, clock.now);
    const job = runningJob(store);
    const call = ledger.reserve(spec(job.id), job.lease, limits());
    ledger.markDispatched(call.call_id, job.lease);

    const settled = ledger.settle(call.call_id, 6);
    const again = ledger.settle(call.call_id, 6);
    expect(again.settled_at).toBe(settled.settled_at);
    expect(again.actual_micro_usd).toBe(6);
    expectCode(() => ledger.settle(call.call_id, 7), "SETTLEMENT_CONFLICT");

    const job2 = runningJob(store, { owner: "worker-2" });
    const hold = ledger.reserve(spec(job2.id), job2.lease, limits());
    expectCode(() => ledger.settle(hold.call_id, 1), "INVALID_STATE");
    store.close();
  });

  it("retains an over-reservation actual and blocks further paid admission until reconciled", () => {
    const store = new Storage(":memory:");
    const clock = testClock("2026-10-16T09:00:00Z");
    const ledger = new DispatchLedger(store, clock.now);
    const job = runningJob(store);
    const call = ledger.reserve(spec(job.id, { reserved_micro_usd: 5 }), job.lease, limits());
    ledger.markDispatched(call.call_id, job.lease);
    const settled = ledger.settle(call.call_id, 9);

    expect(settled.actual_micro_usd).toBe(9);
    expect(ledger.jobSpend(job.id)).toBe(9);
    expect(store.setting(paidProcessingBlockedSetting, null)).toBeTruthy();
    expect(ledger.summary(limits()).blocked).toBe(true);

    const job2 = runningJob(store, { owner: "worker-2" });
    expectCode(
      () =>
        ledger.reserve(
          spec(job2.id),
          job2.lease,
          limits({ per_job_micro_usd: 100, daily_micro_usd: 100 }),
        ),
      "BUDGET_BLOCKED",
    );
    store.close();
  });

  it("refuses to dispatch an already-reserved call after a durable block but still allows releasing it", () => {
    const store = new Storage(":memory:");
    const clock = testClock("2026-10-16T09:00:00Z");
    const ledger = new DispatchLedger(store, clock.now);
    const job = runningJob(store);

    const first = ledger.reserve(spec(job.id, { reserved_micro_usd: 5 }), job.lease, limits());
    ledger.markDispatched(first.call_id, job.lease);
    // Second slot is reserved before the overrun block exists.
    const second = ledger.reserve(
      spec(job.id, { dispatch_key: "repair:1", stage: "repair", reserved_micro_usd: 1 }),
      job.lease,
      limits(),
    );
    // The over-bound settlement sets the durable block.
    ledger.settle(first.call_id, 9);
    expect(store.setting(paidProcessingBlockedSetting, null)).toBeTruthy();

    // The reserved-but-unsent call can no longer dispatch...
    expectCode(() => ledger.markDispatched(second.call_id, job.lease), "BUDGET_BLOCKED");
    expect(ledger.get(second.call_id)!.state).toBe("reserved");
    // ...but it can still be released, and settling an already-sent call is unaffected.
    expect(ledger.releaseUndispatched(second.call_id).state).toBe("released");
    store.close();
  });

  it("only releases an undispatched hold and never races a successful dispatch", () => {
    const store = new Storage(":memory:");
    const clock = testClock("2026-10-16T09:00:00Z");
    const ledger = new DispatchLedger(store, clock.now);
    const job = runningJob(store);

    const hold = ledger.reserve(spec(job.id), job.lease, limits());
    const released = ledger.releaseUndispatched(hold.call_id);
    expect(released.state).toBe("released");
    expect(ledger.releaseUndispatched(hold.call_id).state).toBe("released");
    expectCode(() => ledger.markDispatched(hold.call_id, job.lease), "INVALID_STATE");

    const sent = ledger.reserve(
      spec(job.id, { dispatch_key: "repair", stage: "repair", reserved_micro_usd: 1 }),
      job.lease,
      limits(),
    );
    ledger.markDispatched(sent.call_id, job.lease);
    expectCode(() => ledger.releaseUndispatched(sent.call_id), "INVALID_STATE");
    store.close();
  });

  it("rejects an overflowing aggregate instead of silently overspending", () => {
    const store = new Storage(":memory:");
    const clock = testClock("2026-10-16T09:00:00Z");
    const ledger = new DispatchLedger(store, clock.now);
    const huge = limits({ per_job_micro_usd: maxMicroUsd, daily_micro_usd: maxMicroUsd });

    const jobA = runningJob(store);
    ledger.reserve(
      spec(jobA.id, { reserved_micro_usd: maxMicroUsd - 10 }),
      jobA.lease,
      huge,
    );
    const jobB = runningJob(store, { owner: "worker-2" });
    expectCode(
      () => ledger.reserve(spec(jobB.id, { reserved_micro_usd: 20 }), jobB.lease, huge),
      "SPEND_OVERFLOW",
    );
    expectCode(() => checkedSum([Number.MAX_SAFE_INTEGER, 1]), "SPEND_OVERFLOW");

    const summary = ledger.summary(huge);
    expect(Number.isSafeInteger(summary.unresolved_micro_usd)).toBe(true);
    expect(Number.isSafeInteger(summary.committed_micro_usd)).toBe(true);
    store.close();
  });

  it("preserves dispatch records through a SQLite backup and reopen", () => {
    const dir = tempDir();
    const path = join(dir, "brain.sqlite");
    const backup = join(dir, "backup.sqlite");
    try {
      const store = new Storage(path);
      const clock = testClock("2026-10-16T09:00:00Z");
      const ledger = new DispatchLedger(store, clock.now);
      const job = runningJob(store);
      const call = ledger.reserve(spec(job.id), job.lease, limits());
      ledger.markDispatched(call.call_id, job.lease);
      ledger.settle(call.call_id, 6);

      store.db.prepare("VACUUM INTO ?").run(backup);
      store.close();

      const reopened = new Storage(backup);
      const reopenedLedger = new DispatchLedger(reopened, clock.now);
      expect(Number(reopened.get("SELECT max(version) AS v FROM migrations")!.v)).toBe(5);
      expect(reopened.get("SELECT count(*) AS n FROM provider_dispatches")!.n).toBe(1);
      expect(reopenedLedger.get(call.call_id)!.state).toBe("settled");
      expect(reopenedLedger.jobSpend(job.id)).toBe(6);
      reopened.close();
    } finally {
      removeDir(dir);
    }
  });

  it("requires a current running lease and bounds spec and limit input", () => {
    const store = new Storage(":memory:");
    const clock = testClock("2026-10-16T09:00:00Z");
    const ledger = new DispatchLedger(store, clock.now);
    const job = runningJob(store);

    const expired = runningJob(store, { leaseUntil: "2026-10-16T08:59:00Z" });
    expectCode(
      () => ledger.reserve(spec(expired.id), expired.lease, limits()),
      "LEASE_EXPIRED",
    );
    expectCode(
      () => ledger.reserve(spec(job.id), { ...job.lease, fence: 99 }, limits()),
      "LEASE_LOST",
    );
    expectCode(
      () =>
        ledger.reserve(spec(job.id), { ...job.lease, owner: "someone-else" }, limits()),
      "LEASE_LOST",
    );
    const cancelled = runningJob(store, { status: "cancelled" });
    expectCode(
      () => ledger.reserve(spec(cancelled.id), cancelled.lease, limits()),
      "LEASE_LOST",
    );

    expectCode(
      () =>
        ledger.reserve(
          spec(job.id, { request_hash: "not-a-hash" }),
          job.lease,
          limits(),
        ),
      "INVALID_INPUT",
    );
    expectCode(
      () => ledger.reserve(spec(job.id), job.lease, limits({ time_zone: "Mars/Olympus" })),
      "INVALID_INPUT",
    );
    expectCode(
      () => ledger.settle("missing-call", 1),
      "NOT_FOUND",
    );
    store.close();
  });

  it("rejects a lease that expires while SQLite waits for the write lock before reserving", async () => {
    const dir = tempDir();
    const path = join(dir, "brain.sqlite");
    const store = new Storage(path);
    const ledger = new DispatchLedger(store, () => new Date());
    let child: ReturnType<typeof spawn> | undefined;
    try {
      const expires_at = new Date(Date.now() + 1500).toISOString();
      const job = runningJob(store, { owner: "lock-worker", leaseUntil: expires_at });
      const lease: JobLease = {
        job_id: job.id,
        owner: "lock-worker",
        fence: 1,
        expires_at,
      };
      // The lease is still valid here; it expires while the lock is held.
      child = await holdWriteLock(path, 1800);
      expectCode(
        () => ledger.reserve(spec(job.id, { reserved_micro_usd: 5 }), lease, limits()),
        "LEASE_EXPIRED",
      );
      expect(store.get("SELECT count(*) AS n FROM provider_dispatches")!.n).toBe(0);
    } finally {
      if (child && child.exitCode === null) {
        const ended = new Promise<void>((resolve) => child!.once("exit", () => resolve()));
        child.kill();
        await ended;
      }
      store.close();
      removeDir(dir);
    }
  });
});
