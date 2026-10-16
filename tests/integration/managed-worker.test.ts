import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedRuntime } from "../../packages/runtime/managed.ts";
import {
  ManagedSpendingStore,
  isManagedControlPaused,
} from "../../packages/storage/managed-spending.ts";
import { ManagedWorker } from "../../apps/worker/managed.ts";
import { Worker } from "../../apps/worker/engine.ts";
import {
  enablePaidAccount,
  enrolSyntheticActivation,
  syntheticActivationProvider,
} from "../helpers/managed-activation.ts";

const ISSUER = "https://issuer.example.test";
let current = "2026-10-16T09:00:00Z";
const clock = () => new Date(current);

type Tracked = { runtime: ManagedRuntime; root: string };
const tracked: Tracked[] = [];
function managed(options: { maxOpen?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "bibrain-managed-worker-"));
  const runtime = new ManagedRuntime(root, { clock, ...options });
  tracked.push({ runtime, root });
  return { root, runtime };
}
afterEach(() => {
  current = "2026-10-16T09:00:00Z";
  const entries = tracked.splice(0);
  for (const { runtime } of entries) {
    try {
      runtime.close();
    } catch {}
  }
  for (const root of new Set(entries.map((entry) => entry.root)))
    rmSync(root, { recursive: true, force: true });
});

/** Capture one owner note (which queues a derive_brief job) and release. */
function seed(runtime: ManagedRuntime, id: string, body: string) {
  const h = runtime.acquire(id);
  try {
    h.brain.capture(h.brain.ownerPrincipal(), {
      project_id: "inbox",
      title: "note",
      body,
    });
  } finally {
    h.release();
  }
}
const activeIds = (runtime: ManagedRuntime) =>  (
    runtime.control.db
      .prepare(
        "SELECT id FROM managed_accounts WHERE state='active' ORDER BY id",
      )
      .all() as { id: string }[]
  ).map((r) => r.id);

it("processes two managed accounts into isolated, source-linked, persistent briefs", async () => {
  const { root, runtime } = managed();
  const a = await runtime.provision(ISSUER, "subject-a");
  const b = await runtime.provision(ISSUER, "subject-b");
  seed(runtime, a.id, "SYNTHETIC_ACCOUNT_A_MARKER");
  seed(runtime, b.id, "SYNTHETIC_ACCOUNT_B_MARKER");

  const worker = new ManagedWorker(runtime);
  expect(await worker.tick()).toBe(true);
  expect(await worker.tick()).toBe(true);
  expect(await worker.tick()).toBe(false);

  const read = (id: string) => {
    const h = runtime.acquire(id);
    try {
      const owner = h.brain.ownerPrincipal();
      const brief = h.brain.entities(owner, "brief")[0];
      const source = h.brain.source(
        owner,
        brief.data.items[0].evidence[0].source_id,
      );
      return { brief, source };
    } finally {
      h.release();
    }
  };
  const one = read(a.id);
  const two = read(b.id);
  expect(JSON.stringify(one.brief.data)).toContain(
    "SYNTHETIC_ACCOUNT_A_MARKER",
  );
  expect(JSON.stringify(one.brief.data)).not.toContain(
    "SYNTHETIC_ACCOUNT_B_MARKER",
  );
  expect(JSON.stringify(two.brief.data)).toContain(
    "SYNTHETIC_ACCOUNT_B_MARKER",
  );
  expect(JSON.stringify(two.brief.data)).not.toContain(
    "SYNTHETIC_ACCOUNT_A_MARKER",
  );
  // The brief is source-linked to its own original, not a synthesized claim.
  expect(one.source.body).toContain("SYNTHETIC_ACCOUNT_A_MARKER");
  expect(two.source.body).toContain("SYNTHETIC_ACCOUNT_B_MARKER");

  // Persistence: a fresh runtime over the same root observes the same briefs.
  runtime.close();
  const reopened = new ManagedRuntime(root, { clock });
  tracked.push({ runtime: reopened, root });
  const h = reopened.acquire(a.id);
  try {
    const brief = h.brain.entities(h.brain.ownerPrincipal(), "brief")[0];
    expect(JSON.stringify(brief.data)).toContain("SYNTHETIC_ACCOUNT_A_MARKER");
    expect(JSON.stringify(brief.data)).not.toContain(
      "SYNTHETIC_ACCOUNT_B_MARKER",
    );
  } finally {
    h.release();
  }
});

it("a direct Worker derives the bound owner from a managed brain", async () => {
  const { runtime } = managed();
  const a = await runtime.provision(ISSUER, "direct-owner");
  seed(runtime, a.id, "SYNTHETIC_DIRECT_BOUND");
  const h = runtime.acquire(a.id);
  try {
    const w = new Worker(h.brain);
    expect(await w.tick()).toBe(true);
    const brief = h.brain.entities(h.brain.ownerPrincipal(), "brief")[0];
    expect(JSON.stringify(brief.data)).toContain("SYNTHETIC_DIRECT_BOUND");
  } finally {
    h.release();
  }
});

it("rotates active accounts by trusted keyset with wrap-around fairness", async () => {
  const { runtime } = managed();
  const accounts = [];
  for (const subject of ["fair-a", "fair-b", "fair-c"])
    accounts.push(await runtime.provision(ISSUER, subject));
  for (const account of accounts)
    seed(runtime, account.id, `SYNTHETIC_${account.subject}`);

  const order = activeIds(runtime);
  expect(order).toHaveLength(3);

  const worker = new ManagedWorker(runtime);
  const briefed = new Set<string>();
  for (let i = 0; i < order.length; i++) {
    expect(await worker.tick()).toBe(true);
    const now = new Set<string>();
    for (const id of order) {
      const h = runtime.acquire(id);
      try {
        if (h.brain.entities(h.brain.ownerPrincipal(), "brief").length)
          now.add(id);
      } finally {
        h.release();
      }
    }
    const added = [...now].find((id) => !briefed.has(id));
    expect(added).toBe(order[i]);
    briefed.add(added!);
  }

  // A job queued after the rotation is picked up by wrapping to the lowest id.
  seed(runtime, order[0], "SYNTHETIC_WRAP");
  expect(await worker.tick()).toBe(true);
  const h = runtime.acquire(order[0]);
  try {
    const owner = h.brain.ownerPrincipal();
    expect(
      h.brain.status(owner).jobs.filter((j: any) => j.status === "succeeded"),
    ).toHaveLength(2);
  } finally {
    h.release();
  }
  expect(await worker.tick()).toBe(false);
});

it("denies revoked or out-of-scope agent-originated jobs without publishing", async () => {
  const { runtime } = managed();
  const a = await runtime.provision(ISSUER, "agent-scope");
  const h = runtime.acquire(a.id);
  try {
    const owner = h.brain.ownerPrincipal();
    const other = h.brain.createProject(owner, "other");
    const live = h.brain.createGrant(owner, {
      projects: ["inbox"],
      operations: ["propose_memory"],
      expires_at: "2026-10-17T09:00:00Z",
    });
    const revoked = h.brain.authenticateAgent(live.token);
    const scoped = h.brain.createGrant(owner, {
      projects: ["inbox"],
      operations: ["propose_memory"],
      expires_at: "2026-10-17T09:00:00Z",
    });
    const outOfScope = h.brain.authenticateAgent(scoped.token);
    expect(revoked.tenantId).toBe(a.id);
    expect(outOfScope.tenantId).toBe(a.id);
    // A job whose grant is later revoked, and a job whose principal is scoped
    // to a different project, must both be denied rather than upgraded.
    h.brain.enqueue("inbox", "derive_brief", { principal: revoked });
    h.brain.enqueue(other.id, "derive_brief", { principal: outOfScope });
    h.brain.revoke(owner, live.id);
  } finally {
    h.release();
  }

  const worker = new ManagedWorker(runtime);
  expect(await worker.tick()).toBe(true);
  expect(await worker.tick()).toBe(true);
  expect(await worker.tick()).toBe(false);

  const read = runtime.acquire(a.id);
  try {
    const owner = read.brain.ownerPrincipal();
    expect(read.brain.entities(owner, "brief")).toEqual([]);
    const jobs = read.brain.status(owner).jobs;
    expect(jobs).toHaveLength(2);
    expect(jobs.every((j: any) => j.status !== "succeeded")).toBe(true);
  } finally {
    read.release();
  }
});

it("publishes nothing when the account is suspended during a provider call", async () => {
  const { runtime } = managed();
  const a = await runtime.provision(ISSUER, "suspend-during-call");
  const profile = enrolSyntheticActivation(runtime, a.id, clock);
  seed(runtime, a.id, "SYNTHETIC_SUSPEND");
  const h = runtime.acquire(a.id);
  try {
    let called = false;
    const fake = syntheticActivationProvider(profile, {
      onExecute: () => {
        called = true;
        runtime.control.setAccountState(a.id, "suspended");
      },
    });
    const worker = new ManagedWorker(runtime, { providerFactory: () => fake });
    expect(await worker.tick()).toBe(true);
    expect(called).toBe(true);
    // No brief is published after the post-provider authorization re-check.
    expect(
      h.brain.store.all("SELECT * FROM entities WHERE kind='brief'"),
    ).toEqual([]);
    expect(h.brain.store.all("SELECT status FROM jobs")).toEqual([
      { status: "failed" },
    ]);
  } finally {
    h.release();
  }
});

it("holds the runtime pin across an awaited tick and refuses overlapping work", async () => {
  const { runtime } = managed({ maxOpen: 1 });
  const a = await runtime.provision(ISSUER, "pin-a");
  const b = await runtime.provision(ISSUER, "pin-b");
  enablePaidAccount(runtime, a.id, clock);
  enablePaidAccount(runtime, b.id, clock);
  const profile = enrolSyntheticActivation(runtime, a.id, clock);
  seed(runtime, a.id, "SYNTHETIC_PIN_A");
  seed(runtime, b.id, "SYNTHETIC_PIN_B");
  const order = activeIds(runtime);
  const second = order[1];

  let enteredResolve!: () => void;
  const entered = new Promise<void>((r) => (enteredResolve = r));
  let releaseResolve!: () => void;
  const released = new Promise<void>((r) => (releaseResolve = r));
  const fake = syntheticActivationProvider(profile, {
    onExecute: async () => {
      enteredResolve();
      await released;
    },
  });

  const worker = new ManagedWorker(runtime, { providerFactory: () => fake });
  const pending = worker.tick();
  await entered;
  // The chosen tenant handle stays pinned for the whole awaited tick, so at
  // maxOpen=1 the runtime cannot open the other tenant underneath it.
  expect(() => runtime.acquire(second)).toThrow();
  // A concurrent tick must not dispatch a second overlapping job.
  expect(await worker.tick()).toBe(false);
  releaseResolve();
  expect(await pending).toBe(true);
  // The pin is released in finally, so the other account can now be acquired.
  const h = runtime.acquire(second);
  try {
    expect(h.brain.ownerPrincipal().tenantId).toBe(second);
  } finally {
    h.release();
  }
});

it("stop prevents new work and awaits the in-flight job", async () => {
  const { runtime } = managed();
  const a = await runtime.provision(ISSUER, "stop-waits");
  const profile = enrolSyntheticActivation(runtime, a.id, clock);
  seed(runtime, a.id, "SYNTHETIC_STOP");

  let enteredResolve!: () => void;
  const entered = new Promise<void>((r) => (enteredResolve = r));
  let releaseResolve!: () => void;
  const released = new Promise<void>((r) => (releaseResolve = r));
  const fake = syntheticActivationProvider(profile, {
    onExecute: async () => {
      enteredResolve();
      await released;
    },
  });

  const worker = new ManagedWorker(runtime, { providerFactory: () => fake });
  const pending = worker.tick();
  await entered;
  const stopped = worker.stop();
  // No new work starts once stopped.
  expect(await worker.tick()).toBe(false);
  releaseResolve();
  // stop resolves only after the in-flight job completed.
  await stopped;
  expect(await pending).toBe(true);
  const h = runtime.acquire(a.id);
  try {
    expect(h.brain.entities(h.brain.ownerPrincipal(), "brief")).toHaveLength(1);
  } finally {
    h.release();
  }
});

it("a failed central settlement with a persisted marker blocks globally without fail-stopping the worker", async () => {
  const { runtime } = managed();
  const a = await runtime.provision(ISSUER, "marker-ok");
  const profile = enrolSyntheticActivation(runtime, a.id, clock);
  seed(runtime, a.id, "SYNTHETIC_MARKER_OK");
  runtime.control.db.exec(
    "CREATE TRIGGER settle_fail BEFORE UPDATE OF state ON managed_reservations WHEN NEW.state='settled' BEGIN SELECT RAISE(ABORT,'forced settlement fault'); END",
  );

  const worker = new ManagedWorker(runtime, {
    providerFactory: () => syntheticActivationProvider(profile),
  });
  // The job fails on the central settlement, but the marker write succeeded, so
  // the worker keeps running rather than fail-stopping.
  expect(await worker.tick()).toBe(true);
  expect(isManagedControlPaused(runtime.control)).toBe(false);
  expect(await worker.tick()).toBe(false);

  // The durable service-wide marker denies another account's admission.
  const other = await runtime.provision(ISSUER, "marker-ok-other");
  const central = new ManagedSpendingStore(runtime.control, clock);
  central.configureAccountPeriod({
    account_id: other.id,
    starts_at: "2026-10-16T00:00:00Z",
    ends_at: "2026-10-17T00:00:00Z",
    allowance_micro_usd: 100000,
  });
  central.setAccountPolicy({
    account_id: other.id,
    per_job_micro_usd: 10000,
    user_daily_micro_usd: 100000,
  });
  expect(() =>
    central.reserve({
      account_id: other.id,
      job_id: "other-job",
      dispatch_key: "reasoning",
      stage: "reasoning",
      reserved_micro_usd: 10,
      provider: "synthetic",
      model: "synthetic",
      price_version: "synthetic-v1",
      request_hash: "a".repeat(64),
      config_hash: "b".repeat(64),
      limits: { per_job_micro_usd: 1000, user_daily_micro_usd: 1000, time_zone: "UTC" },
    }),
  ).toThrow();
});

it("a failed safety-marker write fail-stops managed scheduling but keeps capture available", async () => {
  const { runtime } = managed();
  const a = await runtime.provision(ISSUER, "marker-fail");
  const profile = enrolSyntheticActivation(runtime, a.id, clock);
  seed(runtime, a.id, "SYNTHETIC_MARKER_FAIL");
  runtime.control.db.exec(
    "CREATE TRIGGER settle_fail BEFORE UPDATE OF state ON managed_reservations WHEN NEW.state='settled' BEGIN SELECT RAISE(ABORT,'forced settlement fault'); END",
  );
  runtime.control.db.exec(
    "CREATE TRIGGER marker_fail BEFORE INSERT ON managed_money_blocks BEGIN SELECT RAISE(ABORT,'forced marker fault'); END",
  );

  const worker = new ManagedWorker(runtime, {
    providerFactory: () => syntheticActivationProvider(profile),
  });
  // The fatal condition propagates once and stops managed scheduling.
  await expect(worker.tick()).rejects.toThrow();
  expect(await worker.tick()).toBe(false);
  expect(isManagedControlPaused(runtime.control)).toBe(true);

  // Capture through the trusted brain still works while paid work is paused.
  const h = runtime.acquire(a.id);
  try {
    const saved = h.brain.capture(h.brain.ownerPrincipal(), {
      project_id: "inbox",
      title: "note",
      body: "SYNTHETIC_CAPTURE_AFTER_FATAL",
    });
    expect(saved.source_id).toBeTruthy();
  } finally {
    h.release();
  }
});
