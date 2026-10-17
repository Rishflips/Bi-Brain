import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createBillingAdmissionFixture } from "../helpers/billing-admission-fixture.ts";
import { ManagedRuntime } from "../../packages/runtime/managed.ts";
import { ManagedSpendingStore } from "../../packages/storage/managed-spending.ts";
import {
  activeFence,
  readAccountIncarnation,
} from "../../packages/storage/managed-incarnation.ts";
import { readRootMarker } from "../../packages/runtime/managed-operator.ts";
import {
  restoreManagedBackup,
  writeManagedBackup,
} from "../../packages/runtime/managed-recovery.ts";

/**
 * Bounded lifecycle: every supported path that can rebuild a tenant's operational
 * database must fence and advance the account's provisioning generation BEFORE the
 * storage constructor runs, so no pre-rebuild admission can ever fund. All fixtures
 * are synthetic: no owner data, real key, provider or network.
 */

const LIMITS = {
  per_job_micro_usd: 100,
  user_daily_micro_usd: 500,
  time_zone: "UTC",
};

/**
 * Windows can hold a transient handle on a just-closed vault for a moment (a known
 * limitation), so the disposable fixture root is removed with a bounded retry.
 */
function cleanup(f: { close(): void; dir: string }) {
  try {
    f.close();
  } catch {
    /* the runtime may already be closed */
  }
  const deadline = Date.now() + 8000;
  for (;;) {
    try {
      rmSync(f.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  }
}

function spec(f: { account_id: string }) {
  return {
    account_id: f.account_id,
    job_id: randomUUID(),
    dispatch_key: "reasoning" as const,
    stage: "reasoning" as const,
    reserved_micro_usd: 1,
    provider: "synthetic",
    model: "SYNTHETIC-model",
    price_version: "SYNTHETIC-price",
    request_hash: "a".repeat(64),
    config_hash: "b".repeat(64),
    limits: LIMITS,
  };
}

async function admitAndReserve(f: ReturnType<typeof createBillingAdmissionFixture>) {
  const prepared = await f.prepare();
  if (prepared.state !== "prepared")
    throw new Error(`Synthetic admission did not prepare: ${JSON.stringify(prepared)}`);
  expect(f.admit(prepared.preflight_id)).toEqual({ state: "admitted" });
  expect((await f.authority.reconcile(f.account_id)).state).toBe("granted");
  const reserved = f.spending.reserve(spec(f));
  expect(reserved.state).toBe("reserved");
  return reserved;
}

function tenantDb(f: { root: string; account_id: string }) {
  return join(f.root, f.account_id, "brain.sqlite");
}

function marker(f: { root: string; account_id: string }) {
  return JSON.parse(
    readFileSync(join(f.root, f.account_id, "provisioned.json"), "utf8"),
  );
}

it("reprovision of a missing operational database fences and advances before the rebuild", async () => {
  const f = createBillingAdmissionFixture({ enrolled: true });
  try {
    const reserved = await admitAndReserve(f);
    const before = readAccountIncarnation(f.control.db, f.account_id)!;
    expect(before.provisioning_generation).toBe(1);

    // The operational database is gone, but the vault (knowledge) remains.
    rmSync(tenantDb(f), { force: true });
    rmSync(`${tenantDb(f)}-wal`, { force: true });
    rmSync(`${tenantDb(f)}-shm`, { force: true });

    f.runtime.reprovision(f.account_id);

    const after = readAccountIncarnation(f.control.db, f.account_id)!;
    expect(after.provisioning_generation).toBe(before.provisioning_generation + 1);
    expect(after.incarnation).not.toBe(before.incarnation);
    expect(activeFence(f.control.db, f.account_id)).toBeUndefined();
    expect(marker(f)).toMatchObject({
      schema: 2,
      account_id: f.account_id,
      incarnation: after.incarnation,
      provisioning_generation: after.provisioning_generation,
    });
    // The stale admission can no longer fund, but the known reservation is retained.
    expect(() => f.spending.reserve(spec(f))).toThrow();
    expect(
      f.control.db
        .prepare("SELECT state FROM managed_reservations WHERE call_id=?")
        .get(reserved.call_id),
    ).toMatchObject({ state: "reserved" });
    // The rebuilt tenant is readable again under the new generation.
    const handle = f.runtime.acquire(f.account_id);
    try {
      expect(handle.brain).toBeTruthy();
    } finally {
      handle.release();
    }
  } finally {
    cleanup(f);
  }
});

it("acquire of an empty operational database fences and advances before the rebuild", async () => {
  const f = createBillingAdmissionFixture({ enrolled: true });
  try {
    const reserved = await admitAndReserve(f);
    const before = readAccountIncarnation(f.control.db, f.account_id)!;

    // A present-but-empty operational database plus a valid vault is exactly the
    // constructor's recovering-from-vault rebuild branch.
    writeFileSync(tenantDb(f), "");

    const handle = f.runtime.acquire(f.account_id);
    handle.release();

    const after = readAccountIncarnation(f.control.db, f.account_id)!;
    expect(after.provisioning_generation).toBe(before.provisioning_generation + 1);
    expect(activeFence(f.control.db, f.account_id)).toBeUndefined();
    expect(marker(f)).toMatchObject({
      schema: 2,
      incarnation: after.incarnation,
      provisioning_generation: after.provisioning_generation,
    });
    expect(() => f.spending.assertFundingForExecution(reserved.call_id)).toThrow();
  } finally {
    cleanup(f);
  }
});

it("a storage failure after fencing leaves the fence active and never clears it", async () => {
  const f = createBillingAdmissionFixture({ enrolled: true });
  try {
    await admitAndReserve(f);
    const before = readAccountIncarnation(f.control.db, f.account_id)!;
    // An unusable operational path (here a directory) still looks like "needs a
    // rebuild", and the storage constructor fails before any history changes.
    rmSync(tenantDb(f), { force: true });
    rmSync(`${tenantDb(f)}-wal`, { force: true });
    rmSync(`${tenantDb(f)}-shm`, { force: true });
    mkdirSync(tenantDb(f));

    expect(() => f.runtime.reprovision(f.account_id)).toThrow();

    const fence = activeFence(f.control.db, f.account_id);
    expect(fence).toBeDefined();
    expect(fence!.reason).toBe("rebuild");
    const after = readAccountIncarnation(f.control.db, f.account_id)!;
    expect(after.provisioning_generation).toBe(before.provisioning_generation + 1);
    // The marker was never rewritten and remains bound to the old incarnation.
    expect(marker(f).incarnation).toBe(before.incarnation);
    expect(() => f.runtime.acquire(f.account_id)).toThrow();
  } finally {
    cleanup(f);
  }
});

it("healthy repeated acquire and provision keep the same generation with no fence", async () => {
  const f = createBillingAdmissionFixture({ enrolled: true });
  try {
    const before = readAccountIncarnation(f.control.db, f.account_id)!;
    const handle = f.runtime.acquire(f.account_id);
    handle.release();
    f.runtime.provision("https://synthetic.invalid", `SYNTHETIC-owner-${f.account_id}`);
    const after = readAccountIncarnation(f.control.db, f.account_id)!;
    expect(after).toEqual(before);
    expect(activeFence(f.control.db, f.account_id)).toBeUndefined();
  } finally {
    cleanup(f);
  }
});

it("a cold restore gives the v5 tenant a new incarnation under a rotated epoch and denies the old admission", async () => {
  const f = createBillingAdmissionFixture({ enrolled: true });
  const bundle = join(f.dir, "bundle");
  const restored = join(f.dir, "restored");
  let reopened: ManagedRuntime | undefined;
  try {
    const reserved = await admitAndReserve(f);
    const before = readAccountIncarnation(f.control.db, f.account_id)!;
    const epochBefore = f.control.db
      .prepare("SELECT epoch FROM managed_control_epoch WHERE singleton=1")
      .get() as { epoch: number };

    await writeManagedBackup({ root: f.root, destination: bundle, offline: true });
    await restoreManagedBackup({
      bundle,
      destination: restored,
      currentRoot: f.root,
      offline: true,
    });

    reopened = new ManagedRuntime(restored, { clock: f.control.clock });
    const after = readAccountIncarnation(reopened.control.db, f.account_id)!;
    expect(after.provisioning_generation).toBe(before.provisioning_generation + 1);
    expect(after.incarnation).not.toBe(before.incarnation);
    expect(activeFence(reopened.control.db, f.account_id)).toBeUndefined();
    const markerAfter = JSON.parse(
      readFileSync(join(restored, f.account_id, "provisioned.json"), "utf8"),
    );
    expect(markerAfter).toMatchObject({
      schema: 2,
      account_id: f.account_id,
      incarnation: after.incarnation,
      provisioning_generation: after.provisioning_generation,
    });
    const epochAfter = reopened.control.db
      .prepare("SELECT epoch FROM managed_control_epoch WHERE singleton=1")
      .get() as { epoch: number };
    expect(epochAfter.epoch).toBe(epochBefore.epoch + 1);
    expect(readRootMarker(restored)?.epoch).toBe(epochAfter.epoch);
    // Financial history is retained byte-for-byte and the restored tenant is usable.
    expect(
      reopened.control.db
        .prepare("SELECT state FROM managed_reservations WHERE call_id=?")
        .get(reserved.call_id),
    ).toMatchObject({ state: "reserved" });
    const handle = reopened.acquire(f.account_id);
    handle.release();
    // The restored root is non-funding (no protected key/enrollment) and denies new paid work.
    expect(() =>
      new ManagedSpendingStore(reopened!.control, f.control.clock).reserve(spec(f)),
    ).toThrow();
    expect(existsSync(join(restored, f.account_id, "brain.sqlite"))).toBe(true);
  } finally {
    reopened?.close();
    cleanup(f);
  }
});

it("a legacy money-4 root keeps its schema-1 marker and is never fenced", () => {
  const base =
    process.platform === "win32"
      ? join(
          process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
          "Temp",
          "opencode",
        )
      : tmpdir();
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, "billing-lifecycle-v4-"));
  const clock = () => new Date("2027-01-31T12:00:00.000Z");
  const runtime = new ManagedRuntime(root, { clock });
  try {
    const account = runtime.provision("https://synthetic.invalid", "SYNTHETIC-v4-owner");
    const readMarker = () =>
      JSON.parse(readFileSync(join(root, account.id, "provisioned.json"), "utf8"));
    expect(readMarker().schema).toBe(1);
    expect(
      runtime.control.db
        .prepare(
          "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='managed_account_incarnation'",
        )
        .get(),
    ).toBeUndefined();
    const handle = runtime.acquire(account.id);
    handle.release();
    // A healthy legacy tenant is not fenced and its marker is never promoted.
    runtime.reprovision(account.id);
    expect(readMarker().schema).toBe(1);
    expect(
      runtime.control.db
        .prepare(
          "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='managed_account_fence'",
        )
        .get(),
    ).toBeUndefined();
  } finally {
    try {
      runtime.close();
    } catch {
      /* the runtime may already be closed */
    }
    const deadline = Date.now() + 8000;
    for (;;) {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
        break;
      } catch (error) {
        if (Date.now() > deadline) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
      }
    }
  }
});
