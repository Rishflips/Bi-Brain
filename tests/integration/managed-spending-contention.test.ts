import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStore } from "../../packages/storage/control.ts";
import { ManagedSpendingStore } from "../../packages/storage/managed-spending.ts";
import type {
  ManagedDispatchSpec,
  ManagedLimits,
} from "../../packages/domain/managed-spend.ts";

/**
 * Actual two-process contention for the central managed money ledger.
 *
 * Each worker is a real Node process that imports the real ControlStore and
 * ManagedSpendingStore modules through tsx, opens the same control SQLite file,
 * waits at an IPC barrier, and only then runs one ledger call. The outcomes come
 * from genuine SQLite write-lock contention, not sequential in-process calls.
 */

const CONTROL_URL = new URL("../../packages/storage/control.ts", import.meta.url).href;
const STORE_URL = new URL("../../packages/storage/managed-spending.ts", import.meta.url).href;

const CHILD_SCRIPT = `
import { ControlStore } from ${JSON.stringify(CONTROL_URL)};
import { ManagedSpendingStore } from ${JSON.stringify(STORE_URL)};
const args = JSON.parse(process.env.MANAGED_SPEND_CHILD);
const clock = args.now ? () => new Date(args.now) : () => new Date();
const control = new ControlStore(args.db, clock);
const spending = new ManagedSpendingStore(control, clock);
process.send({ type: "ready" });
process.on("message", (msg) => {
  if (msg !== "go") return;
  let payload;
  try {
    let record;
    if (args.action === "reserve") record = spending.reserve(args.spec);
    else if (args.action === "mark") record = spending.mark(args.call_id, args.limits);
    else throw new Error("unknown action " + args.action);
    payload = { type: "done", ok: true, state: record.state, call_id: record.call_id, service_day: record.service_day };
  } catch (error) {
    payload = {
      type: "done",
      ok: false,
      code: error && error.code ? error.code : null,
      message: error && error.message ? error.message : String(error),
    };
  }
  process.send(payload, () => {
    try { control.close(); } catch {}
    process.exit(0);
  });
});
`;

const ISSUER = "https://issuer.synthetic.test";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

type ChildTask = {
  action: "reserve" | "mark";
  db: string;
  now?: string;
  spec?: ManagedDispatchSpec;
  call_id?: string;
  limits?: ManagedLimits;
};

type ChildResult = {
  ok: boolean;
  code: string | null;
  state?: string;
  call_id?: string;
  service_day?: string;
  message?: string;
};

type Spawned = { child: ChildProcess; stderr: () => string };

const dirs: string[] = [];
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "bibrain-managed-contention-"));
  dirs.push(dir);
  return dir;
}

function spawnChild(task: ChildTask): Spawned {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", CHILD_SCRIPT],
    {
      cwd: process.cwd(),
      env: { ...process.env, MANAGED_SPEND_CHILD: JSON.stringify(task) },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
    },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
  child.stdout?.resume();
  return { child, stderr: () => stderr };
}

function waitReady(worker: Spawned): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    worker.child.on("message", (msg: any) => {
      if (msg?.type === "ready" && !settled) {
        settled = true;
        resolve();
      }
    });
    worker.child.once("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    worker.child.once("exit", (code, signal) => {
      if (!settled) {
        settled = true;
        reject(new Error(`child exited before ready (code=${code}, signal=${signal}): ${worker.stderr()}`));
      }
    });
  });
}

function collect(worker: Spawned): Promise<ChildResult> {
  return new Promise<ChildResult>((resolve, reject) => {
    let result: ChildResult | undefined;
    worker.child.on("message", (msg: any) => {
      if (msg?.type === "done") result = msg as ChildResult;
    });
    worker.child.once("error", reject);
    worker.child.once("exit", (code, signal) => {
      if (result) resolve(result);
      else reject(new Error(`child exited (code=${code}, signal=${signal}) without a result: ${worker.stderr()}`));
    });
  });
}

async function runTogether(tasks: ChildTask[]): Promise<ChildResult[]> {
  const workers = tasks.map(spawnChild);
  try {
    const settled = Promise.all(workers.map(collect));
    await Promise.all(workers.map(waitReady));
    for (const worker of workers) worker.child.send("go");
    return await settled;
  } finally {
    for (const worker of workers)
      if (worker.child.exitCode === null && worker.child.signalCode === null)
        worker.child.kill();
  }
}

/** Holds the SQLite write lock for `ms` in a separate process. */
async function holdWriteLock(path: string, ms: number): Promise<ChildProcess> {
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

const limits: ManagedLimits = {
  per_job_micro_usd: 100,
  user_daily_micro_usd: 100,
  time_zone: "UTC",
};

function spec(accountId: string, jobId: string): ManagedDispatchSpec {
  return {
    account_id: accountId,
    job_id: jobId,
    dispatch_key: "decision",
    stage: "decision",
    reserved_micro_usd: 7,
    provider: "synthetic",
    model: "synthetic",
    price_version: "synthetic-v1",
    request_hash: sha(`request:${accountId}:${jobId}`),
    config_hash: sha(`config:${accountId}:${jobId}`),
    limits,
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("central managed spending multi-process contention", () => {
  it("admits exactly one of two processes on two accounts under one shared service cap", async () => {
    const dir = tempDir();
    const db = join(dir, "control.sqlite");
    const now = "2026-10-16T09:00:00Z";
    const clock = () => new Date(now);

    let accountA = "";
    let accountB = "";
    {
      const control = new ControlStore(db, clock);
      const spending = new ManagedSpendingStore(control, clock);
      try {
        accountA = control.provision(ISSUER, "subject-a").id;
        accountB = control.provision(ISSUER, "subject-b").id;
        for (const account_id of [accountA, accountB]) {
          spending.configureAccountPeriod({
            account_id,
            starts_at: "2026-10-16T00:00:00Z",
            ends_at: "2026-10-17T00:00:00Z",
            allowance_micro_usd: 20,
          });
          spending.setAccountPolicy({
            account_id,
            per_job_micro_usd: 100,
            user_daily_micro_usd: 100,
          });
        }
        spending.setServicePolicy({ daily_micro_usd: 10 });
      } finally {
        control.close();
      }
    }

    const results = await runTogether([
      { action: "reserve", db, now, spec: spec(accountA, "job-a") },
      { action: "reserve", db, now, spec: spec(accountB, "job-b") },
    ]);

    const winners = results.filter((result) => result.ok);
    const losers = results.filter((result) => !result.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0].code).toBe("BUDGET_EXHAUSTED");

    const verify = new ControlStore(db, clock);
    const spending = new ManagedSpendingStore(verify, clock);
    try {
      expect(
        verify.db.prepare("SELECT count(*) AS n FROM managed_reservations").get()!.n,
      ).toBe(1);
      const a = spending.accountStatus(accountA);
      const b = spending.accountStatus(accountB);
      // The service dimension is one global total, so both accounts see the
      // same 7-micro-USD commitment for the shared service and day.
      expect(a.committed.service_day_micro_usd).toBe(7);
      expect(b.committed.service_day_micro_usd).toBe(7);
    } finally {
      verify.close();
    }
  });

  it("rejects a mark whose admission period expires while SQLite waits for the write lock", async () => {
    const dir = tempDir();
    const db = join(dir, "control.sqlite");
    const base = Date.now();
    const starts = new Date(base - 60_000).toISOString();
    const ends = new Date(base + 1500).toISOString();
    const clock = () => new Date(base);

    let callId = "";
    {
      const control = new ControlStore(db, clock);
      const spending = new ManagedSpendingStore(control, clock);
      try {
        const account = control.provision(ISSUER, "subject-expiry");
        spending.configureAccountPeriod({
          account_id: account.id,
          starts_at: starts,
          ends_at: ends,
          allowance_micro_usd: 100,
        });
        spending.setAccountPolicy({
          account_id: account.id,
          per_job_micro_usd: 100,
          user_daily_micro_usd: 100,
        });
        spending.setServicePolicy({ daily_micro_usd: 100 });
        callId = spending.reserve(spec(account.id, "lock-job")).call_id;
      } finally {
        control.close();
      }
    }

    // The admission period is still live here; it expires while the lock is held.
    const holder = await holdWriteLock(db, 3000);
    try {
      const [result] = await runTogether([
        { action: "mark", db, call_id: callId, limits },
      ]);
      expect(result.ok).toBe(false);
      expect(result.code).toBe("PERIOD_EXPIRED");
    } finally {
      if (holder.exitCode === null && holder.signalCode === null) {
        const ended = new Promise<void>((resolve) => holder.once("exit", () => resolve()));
        holder.kill();
        await ended;
      }
    }
  }, 30_000);

  it("lets exactly one of two processes commit the first mark on two reserved accounts", async () => {
    const dir = tempDir();
    const db = join(dir, "control.sqlite");
    const now = "2026-10-16T09:00:00Z";
    const clock = () => new Date(now);

    let accountA = "";
    let accountB = "";
    let callA = "";
    let callB = "";
    {
      const control = new ControlStore(db, clock);
      const spending = new ManagedSpendingStore(control, clock);
      try {
        accountA = control.provision(ISSUER, "mark-race-a").id;
        accountB = control.provision(ISSUER, "mark-race-b").id;
        for (const account_id of [accountA, accountB]) {
          spending.configureAccountPeriod({
            account_id,
            starts_at: "2026-10-16T00:00:00Z",
            ends_at: "2026-10-17T00:00:00Z",
            allowance_micro_usd: 1000,
          });
          spending.setAccountPolicy({
            account_id,
            per_job_micro_usd: 100,
            user_daily_micro_usd: 100,
          });
        }
        spending.setServicePolicy({ daily_micro_usd: 100 });
        // Both holds are reserved first, so this is a valid reserve-before-mark
        // race and the barrier is not yet active.
        callA = spending.reserve(spec(accountA, "mark-race-a-job")).call_id;
        callB = spending.reserve(spec(accountB, "mark-race-b-job")).call_id;
      } finally {
        control.close();
      }
    }

    const results = await runTogether([
      { action: "mark", db, now, call_id: callA, limits },
      { action: "mark", db, now, call_id: callB, limits },
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const loser = results.find((result) => !result.ok)!;
    expect(loser.code).toBe("BUDGET_BLOCKED");

    const verify = new ControlStore(db, clock);
    const spending = new ManagedSpendingStore(verify, clock);
    try {
      expect(
        verify.db
          .prepare(
            "SELECT count(*) AS n FROM managed_reservations WHERE state='dispatched'",
          )
          .get()!.n,
      ).toBe(1);
      const loserCall = results[0]!.ok ? callB : callA;
      expect(spending.readReceipt(loserCall)).toMatchObject({ state: "reserved" });
    } finally {
      verify.close();
    }
  }, 30_000);
});
