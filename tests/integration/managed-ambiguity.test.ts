import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStore } from "../../packages/storage/control.ts";
import {
  ManagedSpendingStore,
  AccountingPersistenceError,
  isManagedControlPaused,
} from "../../packages/storage/managed-spending.ts";
import type { ManagedDispatchSpec } from "../../packages/domain/managed-spend.ts";
import { ManagedRuntime } from "../../packages/runtime/managed.ts";
import { ManagedWorker } from "../../apps/worker/managed.ts";
import { fakePreparedProvider } from "../helpers/prepared-provider.ts";

/**
 * Own-account durable ambiguity barrier (Task 1).
 *
 * A committed `dispatched` row is a cross-process, restart-durable barrier: a
 * new admission and any other call's mark are denied until a real known
 * settlement (or a state-correct CAS) resolves it. `reserved`-only holds are
 * never a global pause. The barrier is an ADMISSION barrier, never consent
 * revocation: a valid managed call must still be able to send.
 */

const clock = () => new Date("2026-10-16T09:00:00Z");
let current = "2026-10-16T09:00:00Z";
const movedClock = () => new Date(current);
const roots: string[] = [];

afterEach(() => {
  current = "2026-10-16T09:00:00Z";
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function fixture(path = ":memory:") {
  const control = new ControlStore(path, movedClock);
  const money = new ManagedSpendingStore(control, movedClock);
  const a = control.provision("https://synthetic.example.test", "own-a");
  const b = control.provision("https://synthetic.example.test", "own-b");
  money.setServicePolicy({ daily_micro_usd: 1000 });
  for (const account of [a, b]) {
    money.configureAccountPeriod({
      account_id: account.id,
      starts_at: "2026-10-16T00:00:00Z",
      ends_at: "2026-10-18T00:00:00Z",
      allowance_micro_usd: 1000,
    });
    money.setAccountPolicy({
      account_id: account.id,
      per_job_micro_usd: 1000,
      user_daily_micro_usd: 1000,
    });
  }
  const limits = {
    per_job_micro_usd: 1000,
    user_daily_micro_usd: 1000,
    time_zone: "UTC",
  };
  const spec = (accountId: string, job: string): ManagedDispatchSpec => ({
    account_id: accountId,
    job_id: job,
    dispatch_key: "reasoning",
    stage: "reasoning",
    provider: "synthetic",
    model: "synthetic",
    price_version: "synthetic-v1",
    reserved_micro_usd: 10,
    request_hash: "a".repeat(64),
    config_hash: "b".repeat(64),
    limits,
  });
  return { control, money, a, b, limits, spec };
}

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "bibrain-ambiguity-"));
  roots.push(root);
  return root;
}

function enableProvider(runtime: ManagedRuntime, id: string) {
  const money = new ManagedSpendingStore(runtime.control, clock);
  money.setServicePolicy({ daily_micro_usd: 1000 });
  money.setAccountPolicy({
    account_id: id,
    per_job_micro_usd: 1000,
    user_daily_micro_usd: 1000,
  });
  money.configureAccountPeriod({
    account_id: id,
    starts_at: "2026-10-16T00:00:00Z",
    ends_at: "2026-10-17T00:00:00Z",
    allowance_micro_usd: 1000,
  });
  const h = runtime.acquire(id);
  try {
    const owner = h.brain.ownerPrincipal();
    h.brain.prefs(owner, {
      ...h.brain.prefs(owner),
      time_zone: "UTC",
      provider_enabled: true,
      daily_cap_micro_usd: 1000,
      per_job_cap_micro_usd: 1000,
    });
  } finally {
    h.release();
  }
}

it("a committed mark denies a new reserve and another call's mark", () => {
  const f = fixture();
  try {
    const a = f.money.reserve(f.spec(f.a.id, "job-a"));
    const b = f.money.reserve(f.spec(f.b.id, "job-b"));
    f.money.mark(a.call_id, f.limits);
    expect(() => f.money.reserve(f.spec(f.b.id, "job-next"))).toThrow();
    expect(() => f.money.mark(b.call_id, f.limits)).toThrow();
    expect(f.money.readReceipt(b.call_id)).toMatchObject({
      state: "reserved",
      actual_micro_usd: null,
    });
  } finally {
    f.control.close();
  }
});

it("a dispatched row from a previous UTC day still pauses without a money-block row", () => {
  const f = fixture();
  try {
    const a = f.money.reserve(f.spec(f.a.id, "job-a"));
    f.money.mark(a.call_id, f.limits);
    current = "2026-10-17T09:00:00Z";
    expect(() => f.money.reserve(f.spec(f.b.id, "job-next-day"))).toThrow();
    expect(
      f.control.db
        .prepare("SELECT count(*) AS n FROM managed_money_blocks")
        .get()!.n,
    ).toBe(0);
    expect(f.money.readReceipt(a.call_id)).toMatchObject({
      state: "dispatched",
      actual_micro_usd: null,
    });
  } finally {
    f.control.close();
  }
});

it("reserved-only holds never halt the service", () => {
  const f = fixture();
  try {
    f.money.reserve(f.spec(f.a.id, "job-a"));
    f.money.reserve(f.spec(f.b.id, "job-b"));
    expect(f.money.accountStatus(f.b.id).blocked).toBe(false);
    expect(f.money.serviceBarrier()).toEqual({ paused: false, reason: null });
  } finally {
    f.control.close();
  }
});

it("an ordinary known settlement releases the barrier for the next mark", () => {
  const f = fixture();
  try {
    const a = f.money.reserve(f.spec(f.a.id, "job-a"));
    const b = f.money.reserve(f.spec(f.b.id, "job-b"));
    f.money.mark(a.call_id, f.limits);
    expect(() => f.money.mark(b.call_id, f.limits)).toThrow();
    f.money.settleKnown(a.call_id, 7);
    expect(f.money.accountStatus(f.b.id).blocked).toBe(false);
    expect(f.money.mark(b.call_id, f.limits)).toMatchObject({
      state: "dispatched",
    });
    expect(() => f.money.releaseUndispatched(b.call_id)).toThrow();
  } finally {
    f.control.close();
  }
});

it("reports usage_pending and never leaks another account's ids or global money", async () => {
  const root = tempRoot();
  const runtime = new ManagedRuntime(root, { clock });
  try {
    const a = runtime.provision("https://synthetic.example.test", "view-a");
    const b = runtime.provision("https://synthetic.example.test", "view-b");
    const money = new ManagedSpendingStore(runtime.control, clock);
    money.setServicePolicy({ daily_micro_usd: 1000 });
    for (const account of [a, b]) {
      money.setAccountPolicy({
        account_id: account.id,
        per_job_micro_usd: 1000,
        user_daily_micro_usd: 1000,
      });
      money.configureAccountPeriod({
        account_id: account.id,
        starts_at: "2026-10-16T00:00:00Z",
        ends_at: "2026-10-17T00:00:00Z",
        allowance_micro_usd: 1000,
      });
    }
    const limits = {
      per_job_micro_usd: 1000,
      user_daily_micro_usd: 1000,
      time_zone: "UTC",
    };
    const pending = money.reserve({
      account_id: a.id,
      job_id: "private-job-a",
      dispatch_key: "reasoning",
      stage: "reasoning",
      provider: "synthetic",
      model: "synthetic",
      price_version: "synthetic-v1",
      reserved_micro_usd: 10,
      request_hash: "a".repeat(64),
      config_hash: "b".repeat(64),
      limits,
    });
    money.mark(pending.call_id, limits);

    expect(money.accountStatus(b.id).blocked_reason).toBe("usage_pending");
    const barrier = money.serviceBarrier();
    expect(barrier).toEqual({ paused: true, reason: "usage_pending" });
    expect(JSON.stringify(barrier)).not.toContain(a.id);
    expect(JSON.stringify(barrier)).not.toContain(pending.call_id);

    const h = runtime.acquire(b.id);
    try {
      const spend = h.brain.status(h.brain.ownerPrincipal()).spend;
      expect(spend.paused).toBe(true);
      expect(spend.paused_reason).toBe("usage_pending");
      expect(spend).toMatchObject({
        available: false,
        blocked: true,
        service_available: false,
        settled_micro_usd: 0,
        unresolved_micro_usd: 0,
      });
      const text = JSON.stringify(spend);
      for (const privateValue of [
        a.id,
        pending.call_id,
        "private-job-a",
        "service_day_micro_usd",
      ])
        expect(text).not.toContain(privateValue);
    } finally {
      h.release();
    }
  } finally {
    runtime.close();
  }
});

it("keeps capture available while the barrier is active", async () => {
  const root = tempRoot();
  const runtime = new ManagedRuntime(root, { clock });
  try {
    const a = runtime.provision("https://synthetic.example.test", "capture-a");
    const money = new ManagedSpendingStore(runtime.control, clock);
    money.setServicePolicy({ daily_micro_usd: 1000 });
    money.setAccountPolicy({
      account_id: a.id,
      per_job_micro_usd: 1000,
      user_daily_micro_usd: 1000,
    });
    money.configureAccountPeriod({
      account_id: a.id,
      starts_at: "2026-10-16T00:00:00Z",
      ends_at: "2026-10-17T00:00:00Z",
      allowance_micro_usd: 1000,
    });
    const limits = {
      per_job_micro_usd: 1000,
      user_daily_micro_usd: 1000,
      time_zone: "UTC",
    };
    const held = money.reserve({
      account_id: a.id,
      job_id: "capture-job",
      dispatch_key: "reasoning",
      stage: "reasoning",
      provider: "synthetic",
      model: "synthetic",
      price_version: "synthetic-v1",
      reserved_micro_usd: 10,
      request_hash: "a".repeat(64),
      config_hash: "b".repeat(64),
      limits,
    });
    money.mark(held.call_id, limits);

    const h = runtime.acquire(a.id);
    try {
      const saved = h.brain.capture(h.brain.ownerPrincipal(), {
        title: "note",
        body: "SYNTHETIC_CAPTURE_WITH_BARRIER",
      }) as { source_id: string };
      expect(saved.source_id).toBeTruthy();
      expect(h.brain.source(h.brain.ownerPrincipal(), saved.source_id).body).toBe(
        "SYNTHETIC_CAPTURE_WITH_BARRIER",
      );
    } finally {
      h.release();
    }
  } finally {
    runtime.close();
  }
});

it("keeps the durable pause across a restart after a fatal marker failure, without the fuse", () => {
  const root = tempRoot();
  let first = new ManagedRuntime(root, { clock });
  let a: { id: string };
  let b: { id: string };
  let bCall: string;
  try {
    a = first.provision("https://synthetic.example.test", "restart-a");
    b = first.provision("https://synthetic.example.test", "restart-b");
    const money = new ManagedSpendingStore(first.control, clock);
    money.setServicePolicy({ daily_micro_usd: 1000 });
    for (const account of [a, b]) {
      money.setAccountPolicy({
        account_id: account.id,
        per_job_micro_usd: 1000,
        user_daily_micro_usd: 1000,
      });
      money.configureAccountPeriod({
        account_id: account.id,
        starts_at: "2026-10-16T00:00:00Z",
        ends_at: "2026-10-18T00:00:00Z",
        allowance_micro_usd: 1000,
      });
    }
    const limits = {
      per_job_micro_usd: 1000,
      user_daily_micro_usd: 1000,
      time_zone: "UTC",
    };
    const spec = (accountId: string, job: string): ManagedDispatchSpec => ({
      account_id: accountId,
      job_id: job,
      dispatch_key: "reasoning",
      stage: "reasoning",
      provider: "synthetic",
      model: "synthetic",
      price_version: "synthetic-v1",
      reserved_micro_usd: 10,
      request_hash: "a".repeat(64),
      config_hash: "b".repeat(64),
      limits,
    });
    const aCall = money.reserve(spec(a.id, "restart-a"));
    const bReserved = money.reserve(spec(b.id, "restart-b"));
    bCall = bReserved.call_id;
    money.mark(aCall.call_id, limits);
    // Force the safety-marker write to fail so the shared handle is poisoned,
    // exactly as the settlement-marker failure path does.
    first.control.db.exec(
      "CREATE TRIGGER marker_fault BEFORE INSERT ON managed_money_blocks BEGIN SELECT RAISE(ABORT,'synthetic marker fault'); END",
    );
    expect(() => money.flagSettlementFailure(aCall.call_id)).toThrow(
      AccountingPersistenceError,
    );
    expect(isManagedControlPaused(first.control)).toBe(true);
    first.close();
    first = undefined as unknown as ManagedRuntime;
  } finally {
    if (first) first.close();
  }

  const second = new ManagedRuntime(root, { clock });
  try {
    const money = new ManagedSpendingStore(second.control, clock);
    const limits = {
      per_job_micro_usd: 1000,
      user_daily_micro_usd: 1000,
      time_zone: "UTC",
    };
    expect(() =>
      money.reserve({
        account_id: b.id,
        job_id: "restart-after",
        dispatch_key: "reasoning",
        stage: "reasoning",
        provider: "synthetic",
        model: "synthetic",
        price_version: "synthetic-v1",
        reserved_micro_usd: 10,
        request_hash: "a".repeat(64),
        config_hash: "b".repeat(64),
        limits,
      }),
    ).toThrow();
    expect(() => money.mark(bCall, limits)).toThrow();
    expect(money.accountStatus(b.id).blocked).toBe(true);
    const h = second.acquire(b.id);
    try {
      const saved = h.brain.capture(h.brain.ownerPrincipal(), {
        title: "note",
        body: "SYNTHETIC_CAPTURE_AFTER_RESTART",
      }) as { source_id: string };
      expect(saved.source_id).toBeTruthy();
    } finally {
      h.release();
    }
  } finally {
    second.close();
  }
});

it("usage_pending is an admission barrier, not consent revocation", () => {
  const root = tempRoot();
  const runtime = new ManagedRuntime(root, { clock });
  try {
    const a = runtime.provision("https://synthetic.example.test", "consent-a");
    enableProvider(runtime, a.id);
    const money = new ManagedSpendingStore(runtime.control, clock);
    const limits = {
      per_job_micro_usd: 1000,
      user_daily_micro_usd: 1000,
      time_zone: "UTC",
    };
    const held = money.reserve({
      account_id: a.id,
      job_id: "consent-job",
      dispatch_key: "reasoning",
      stage: "reasoning",
      provider: "synthetic",
      model: "synthetic",
      price_version: "synthetic-v1",
      reserved_micro_usd: 10,
      request_hash: "a".repeat(64),
      config_hash: "b".repeat(64),
      limits,
    });
    money.mark(held.call_id, limits);
    const h = runtime.acquire(a.id);
    try {
      const owner = h.brain.ownerPrincipal();
      expect(money.serviceBarrier().reason).toBe("usage_pending");
      // Effective and stored consent are both preserved.
      expect(h.brain.prefs(owner).provider_enabled).toBe(true);
      const stored = h.brain.store.setting("preferences", {} as any) as {
        provider_enabled?: boolean;
      };
      expect(stored.provider_enabled).toBe(true);
    } finally {
      h.release();
    }
  } finally {
    runtime.close();
  }
});

it("lets a real ManagedWorker send once and settle its own marker", async () => {
  const root = tempRoot();
  const runtime = new ManagedRuntime(root, { clock });
  try {
    const a = runtime.provision("https://synthetic.example.test", "worker-a");
    enableProvider(runtime, a.id);
    const handle = runtime.acquire(a.id);
    const owner = handle.brain.ownerPrincipal();
    const saved = handle.brain.capture(owner, {
      title: "Synthetic",
      body: "SYNTHETIC worker consent",
    }) as { source_id: string; job: { id: string } };
    const provider = fakePreparedProvider();
    const worker = new ManagedWorker(runtime, { providerFactory: () => provider });
    try {
      expect(await worker.tick()).toBe(true);
      expect(provider.calls).toBe(1);
      expect(
        handle.brain.store.get("SELECT status FROM jobs WHERE id=?", saved.job.id)
          ?.status,
      ).toBe("succeeded");
      const central = new ManagedSpendingStore(runtime.control, clock);
      expect(central.latestForJob(a.id, saved.job.id)).toMatchObject({
        state: "settled",
        actual_micro_usd: 10,
      });
      expect(central.accountStatus(a.id).blocked).toBe(false);
    } finally {
      await worker.stop();
      handle.release();
    }
  } finally {
    runtime.close();
  }
});
