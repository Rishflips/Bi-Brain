import { expect, it } from "vitest";
import { Storage } from "../../packages/storage/index.ts";
import { DispatchLedger } from "../../packages/storage/spend.ts";
import type { DispatchSpec } from "../../packages/domain/spend.ts";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

it("an overrun blocks already reserved but not yet dispatched calls too", () => {
  const store = new Storage(":memory:");
  const now = () => new Date("2026-10-16T09:00:00Z");
  const ledger = new DispatchLedger(store, now);
  const limits = { per_job_micro_usd: 100, daily_micro_usd: 1000, time_zone: "UTC" };
  const lease = (id: string) => ({ job_id: id, owner: "synthetic-worker", fence: 1, expires_at: "2026-10-16T10:00:00Z" });
  const spec = (id: string): DispatchSpec => ({
    job_id: id, dispatch_key: "decision:0", stage: "decision", reserved_micro_usd: 10,
    provider: "synthetic", model: "synthetic", price_version: "synthetic-v1",
    request_hash: "a".repeat(64), config_hash: "b".repeat(64),
  });
  try {
    for (const id of ["synthetic-a", "synthetic-b"]) store.run(
      "INSERT INTO jobs(id,project_id,kind,payload,status,next_at,lease_owner,lease_until,fence,created_at) VALUES(?,'inbox','derive_brief','{}','running',?,'synthetic-worker',?,1,?)",
      id, now().toISOString(), lease(id).expires_at, now().toISOString(),
    );
    const a = ledger.reserve(spec("synthetic-a"), lease("synthetic-a"), limits);
    const b = ledger.reserve(spec("synthetic-b"), lease("synthetic-b"), limits);
    ledger.markDispatched(a.call_id, lease("synthetic-a"));
    ledger.settle(a.call_id, 20);
    expect(ledger.summary(limits).blocked).toBe(true);
    expect(() => ledger.markDispatched(b.call_id, lease("synthetic-b"))).toThrow();
    expect(ledger.get(b.call_id)?.state).toBe("reserved");
  } finally {
    store.close();
  }
});

it("a lease expiring while SQLite waits for the write lock cannot dispatch", async () => {
  const root = mkdtempSync(join(tmpdir(), "brain-spend-lock-"));
  const path = join(root, "brain.sqlite");
  const store = new Storage(path);
  const ledger = new DispatchLedger(store, () => new Date());
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const expires_at = new Date(Date.now() + 1500).toISOString();
    const lease = { job_id: "synthetic-lock-job", owner: "synthetic-worker", fence: 1, expires_at };
    store.run(
      "INSERT INTO jobs(id,project_id,kind,payload,status,next_at,lease_owner,lease_until,fence,created_at) VALUES(?,'inbox','derive_brief','{}','running',?,'synthetic-worker',?,1,?)",
      lease.job_id, new Date().toISOString(), expires_at, new Date().toISOString(),
    );
    const reserved = ledger.reserve({
      job_id: lease.job_id, dispatch_key: "decision:0", stage: "decision", reserved_micro_usd: 10,
      provider: "synthetic", model: "synthetic", price_version: "synthetic-v1",
      request_hash: "a".repeat(64), config_hash: "b".repeat(64),
    }, lease, { per_job_micro_usd: 100, daily_micro_usd: 1000, time_zone: "UTC" });
    child = spawn(process.execPath, ["-e", `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1]);
      db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
      process.stdout.write('locked\\n');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1800);
      db.exec('ROLLBACK'); db.close();
    `, path], { stdio: ["ignore", "pipe", "pipe"] });
    await new Promise<void>((resolve, reject) => {
      child!.stdout!.once("data", () => resolve());
      child!.once("error", reject);
      child!.once("exit", (code) => { if (code !== 0) reject(new Error("Synthetic SQLite lock holder failed.")); });
    });
    expect(() => ledger.markDispatched(reserved.call_id, lease)).toThrow();
    expect(ledger.get(reserved.call_id)?.state).toBe("reserved");
  } finally {
    if (child && child.exitCode === null) {
      const ended = new Promise<void>((resolve) => child!.once("exit", () => resolve()));
      child.kill();
      await ended;
    }
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
