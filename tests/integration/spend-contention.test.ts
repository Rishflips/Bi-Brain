import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../../packages/storage/index.ts";
import { DispatchLedger } from "../../packages/storage/spend.ts";
import type { DispatchSpec, JobLease, SpendLimits } from "../../packages/domain/spend.ts";

/**
 * Actual two-process contention for the per-dispatch ledger.
 *
 * Each worker is a real Node process that imports the real Storage and
 * DispatchLedger modules through tsx, opens the same SQLite file, waits at an
 * IPC barrier, and only then runs one ledger call. The outcomes therefore come
 * from genuine SQLite write-lock contention, not sequential in-process calls.
 */

const STORAGE_URL = new URL("../../packages/storage/index.ts", import.meta.url).href;
const LEDGER_URL = new URL("../../packages/storage/spend.ts", import.meta.url).href;

const CHILD_SCRIPT = `
import { Storage } from ${JSON.stringify(STORAGE_URL)};
import { DispatchLedger } from ${JSON.stringify(LEDGER_URL)};
const args = JSON.parse(process.env.SPEND_CHILD);
const store = new Storage(args.db);
const ledger = new DispatchLedger(store, () => new Date(args.now));
process.send({ type: "ready" });
process.on("message", (msg) => {
  if (msg !== "go") return;
  let payload;
  try {
    let record;
    if (args.action === "reserve") record = ledger.reserve(args.spec, args.lease, args.limits);
    else if (args.action === "mark") record = ledger.markDispatched(args.call_id, args.lease);
    else if (args.action === "release") record = ledger.releaseUndispatched(args.call_id);
    else throw new Error("unknown action " + args.action);
    payload = { type: "done", ok: true, state: record.state, call_id: record.call_id };
  } catch (error) {
    payload = {
      type: "done",
      ok: false,
      code: error && error.code ? error.code : null,
      message: error && error.message ? error.message : String(error),
    };
  }
  process.send(payload, () => {
    try { store.close(); } catch {}
    process.exit(0);
  });
});
`;

type WorkerAction = "reserve" | "mark" | "release";

interface WorkerTask {
  action: WorkerAction;
  db: string;
  now: string;
  spec?: DispatchSpec;
  lease?: JobLease;
  limits?: SpendLimits;
  call_id?: string;
}

interface WorkerResult {
  ok: boolean;
  code: string | null;
  state?: string;
  call_id?: string;
  message?: string;
}

interface SpawnedWorker {
  child: ChildProcess;
  stderr: () => string;
}

function spawnWorker(task: WorkerTask): SpawnedWorker {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", CHILD_SCRIPT],
    {
      cwd: process.cwd(),
      env: { ...process.env, SPEND_CHILD: JSON.stringify(task) },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
    },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
  child.stdout?.resume();
  return { child, stderr: () => stderr };
}

function waitUntilReady(worker: SpawnedWorker): Promise<void> {
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
        reject(
          new Error(
            `child exited before ready (code=${code}, signal=${signal}): ${worker.stderr()}`,
          ),
        );
      }
    });
  });
}

async function runContention(tasks: WorkerTask[]): Promise<WorkerResult[]> {
  const workers = tasks.map(spawnWorker);
  try {
    // Attach result listeners before signalling so no outcome is missed.
    const settled = Promise.allSettled(
      workers.map(
        (worker) =>
          new Promise<WorkerResult>((resolve, reject) => {
            let result: WorkerResult | undefined;
            worker.child.on("message", (msg: any) => {
              if (msg?.type === "done") result = msg as WorkerResult;
            });
            worker.child.once("error", reject);
            worker.child.once("exit", (code, signal) => {
              if (result) resolve(result);
              else
                reject(
                  new Error(
                    `child exited (code=${code}, signal=${signal}) without a result: ${worker.stderr()}`,
                  ),
                );
            });
          }),
      ),
    );
    // IPC barrier: every child is open and idle before any ledger call starts.
    await Promise.all(workers.map(waitUntilReady));
    for (const worker of workers) worker.child.send("go");
    const outcomes = await settled;
    return outcomes.map((outcome) => {
      if (outcome.status === "fulfilled") return outcome.value;
      throw outcome.reason;
    });
  } finally {
    for (const worker of workers)
      if (worker.child.exitCode === null && worker.child.signalCode === null)
        worker.child.kill();
  }
}

const dirs: string[] = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "bibrain-contention-"));
  dirs.push(dir);
  return dir;
}

function removeDir(dir: string) {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

const insertJob = (
  store: Storage,
  id: string,
  owner: string,
  leaseUntil: string,
  now: string,
) =>
  store.run(
    "INSERT INTO jobs(id,project_id,kind,payload,status,attempts,max_attempts,next_at,lease_owner,lease_until,fence,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    id,
    "inbox",
    "derive_brief",
    "{}",
    "running",
    1,
    3,
    now,
    owner,
    leaseUntil,
    1,
    now,
  );

const specFor = (
  id: string,
  reserved: number,
  hashes: [string, string],
): DispatchSpec => ({
  job_id: id,
  dispatch_key: "decision",
  stage: "decision",
  reserved_micro_usd: reserved,
  provider: "synthetic",
  model: "synthetic",
  price_version: "synthetic-v1",
  request_hash: hashes[0].repeat(64),
  config_hash: hashes[1].repeat(64),
});

const leaseFor = (id: string, owner: string, expires: string): JobLease => ({
  job_id: id,
  owner,
  fence: 1,
  expires_at: expires,
});

afterEach(() => {
  while (dirs.length) removeDir(dirs.pop()!);
});

describe("per-dispatch ledger multi-process contention", () => {
  it("admits exactly one of two processes reserving simultaneously under a shared cap", async () => {
    const dir = tempDir();
    const db = join(dir, "brain.sqlite");
    const now = "2026-10-16T09:00:00Z";
    const expires = "2026-10-16T10:00:00Z";
    const owner = "contention-worker";
    const limits: SpendLimits = {
      per_job_micro_usd: 10,
      daily_micro_usd: 10,
      time_zone: "UTC",
    };
    const jobA = `job-a-${randomUUID()}`;
    const jobB = `job-b-${randomUUID()}`;

    {
      const seed = new Storage(db);
      try {
        insertJob(seed, jobA, owner, expires, now);
        insertJob(seed, jobB, owner, expires, now);
      } finally {
        seed.close();
      }
    }

    const results = await runContention([
      {
        action: "reserve",
        db,
        now,
        spec: specFor(jobA, 7, ["a", "b"]),
        lease: leaseFor(jobA, owner, expires),
        limits,
      },
      {
        action: "reserve",
        db,
        now,
        spec: specFor(jobB, 7, ["c", "d"]),
        lease: leaseFor(jobB, owner, expires),
        limits,
      },
    ]);

    const winners = results.filter((result) => result.ok);
    const losers = results.filter((result) => !result.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    // A loser must be the expected budget rejection, never a fatal error.
    expect(losers[0].code).toBe("BUDGET_EXHAUSTED");

    {
      const verify = new Storage(db);
      try {
        const ledger = new DispatchLedger(verify, () => new Date(now));
        const summary = ledger.summary(limits);
        expect(summary.provider_dispatches).toBe(1);
        expect(summary.unresolved_micro_usd).toBe(7);
        expect(summary.committed_micro_usd).toBe(7);
        expect(summary.remaining_micro_usd).toBe(3);
      } finally {
        verify.close();
      }
    }
  });

  it("settles a real release-vs-mark race on one reserved call to exactly one outcome", async () => {
    const dir = tempDir();
    const db = join(dir, "brain.sqlite");
    const now = "2026-10-16T09:00:00Z";
    const expires = "2026-10-16T10:00:00Z";
    const owner = "contention-worker";
    const limits: SpendLimits = {
      per_job_micro_usd: 10,
      daily_micro_usd: 10,
      time_zone: "UTC",
    };
    const jobId = `job-race-${randomUUID()}`;
    const lease = leaseFor(jobId, owner, expires);

    const callId = (() => {
      const seed = new Storage(db);
      try {
        insertJob(seed, jobId, owner, expires, now);
        const ledger = new DispatchLedger(seed, () => new Date(now));
        return ledger.reserve(specFor(jobId, 7, ["e", "f"]), lease, limits).call_id;
      } finally {
        seed.close();
      }
    })();

    const results = await runContention([
      { action: "mark", db, now, call_id: callId, lease },
      { action: "release", db, now, call_id: callId },
    ]);

    const winners = results.filter((result) => result.ok);
    const losers = results.filter((result) => !result.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    // The loser lost a state compare-and-set, never a fatal error.
    expect(["INVALID_STATE", "DISPATCH_CONFLICT"]).toContain(losers[0].code);

    {
      const verify = new Storage(db);
      try {
        const ledger = new DispatchLedger(verify, () => new Date(now));
        const record = ledger.get(callId)!;
        expect(["dispatched", "released"]).toContain(record.state);
        const liability = ledger.jobSpend(jobId);
        if (record.state === "dispatched") {
          expect(winners[0].state).toBe("dispatched");
          expect(liability).toBe(7);
        } else {
          expect(winners[0].state).toBe("released");
          expect(liability).toBe(0);
        }
      } finally {
        verify.close();
      }
    }
  });
});
