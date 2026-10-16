import { afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStore } from "../../packages/storage/control.ts";
import { ManagedSpendingStore } from "../../packages/storage/managed-spending.ts";
import { ManagedReconciliationStore } from "../../packages/storage/managed-reconciliation.ts";
import { ManagedRuntime } from "../../packages/runtime/managed.ts";
import { markerPath } from "../../packages/runtime/managed-operator.ts";
import {
  restoreManagedBackup,
  writeManagedBackup,
} from "../../packages/runtime/managed-recovery.ts";
import { controlRestoreRequired } from "../../packages/storage/managed-restore-policy.ts";
import {
  auditManagedHistory,
  validateManagedAudit,
} from "../../packages/runtime/managed-audit.ts";

/**
 * Root-epoch rotation on supported restore (Task 3).
 *
 * A supported restore rotates the control epoch and rewrites the root marker at
 * staging before publish, invalidating every prior audit. The financial block
 * and the deleted restored credentials are preserved. A previous-format bundle
 * without the marker is still supported (blocked), not mass-rejected.
 */

const ISSUER = "https://synthetic.example.test";
const clock = () => new Date("2026-10-16T09:00:00Z");
const ACK = { offline: true, workers_terminated: true };
const limits = {
  per_job_micro_usd: 100000,
  user_daily_micro_usd: 100000,
  time_zone: "UTC",
};
const bases: string[] = [];

afterEach(() => {
  for (const base of bases.splice(0))
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function baseDir() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "bibrain-epoch-restore-")));
  bases.push(base);
  return base;
}

function setup(options: { reserve?: boolean } = {}) {
  const base = baseDir();
  const root = join(base, "managed");
  const runtime = new ManagedRuntime(root, { clock });
  const account = runtime.provision(ISSUER, "epoch-restore");
  const spending = new ManagedSpendingStore(runtime.control, clock);
  spending.setServicePolicy({ daily_micro_usd: 100000 });
  spending.setAccountPolicy({
    account_id: account.id,
    per_job_micro_usd: 100000,
    user_daily_micro_usd: 100000,
  });
  spending.configureAccountPeriod({
    account_id: account.id,
    starts_at: "2026-10-16T00:00:00Z",
    ends_at: "2026-10-18T00:00:00Z",
    allowance_micro_usd: 100000,
  });
  if (options.reserve) {
    const rec = spending.reserve({
      account_id: account.id,
      job_id: randomUUID(),
      dispatch_key: "reasoning",
      stage: "reasoning",
      reserved_micro_usd: 10,
      provider: "synthetic",
      model: "synthetic",
      price_version: "synthetic-v1",
      request_hash: "a".repeat(64),
      config_hash: "b".repeat(64),
      limits,
    });
    spending.mark(rec.call_id, limits);
    spending.settleKnown(rec.call_id, 7);
  }
  const epoch = new ManagedReconciliationStore(runtime.control, root, clock).initEpoch(ACK);
  const token = runtime.control.issueSession(account.id).token;
  runtime.close();
  return { base, root, account, epoch, token };
}

it("rotates the epoch on restore and invalidates a pre-restore audit", async () => {
  const f = setup();
  const bundle = join(f.base, "bundle");
  const restored = join(f.base, "restored");

  const control = new ControlStore(join(f.root, "control.sqlite"), clock);
  let auditId = "";
  try {
    const result = auditManagedHistory({
      control,
      root: f.root,
      offline: true,
      workers_terminated: true,
      clock,
    });
    expect(result.ok).toBe(true);
    expect(result.evidence).toBe("empty");
    auditId = result.audit_id!;
  } finally {
    control.close();
  }

  await writeManagedBackup({ root: f.root, destination: bundle, offline: true });
  await restoreManagedBackup({
    bundle,
    destination: restored,
    currentRoot: f.root,
    offline: true,
  });

  const restoredControl = new ControlStore(join(restored, "control.sqlite"), clock);
  try {
    const recon = new ManagedReconciliationStore(restoredControl, restored, clock);
    const newEpoch = recon.readEpoch()!;
    expect(newEpoch.epoch).toBe(f.epoch.epoch + 1);
    expect(newEpoch.nonce).not.toBe(f.epoch.nonce);
    expect(() => recon.assertRootEpoch()).not.toThrow();
    expect(existsSync(markerPath(restored))).toBe(true);

    const old = validateManagedAudit({
      control: restoredControl,
      root: restored,
      auditId,
      clock,
    });
    expect(old.valid).toBe(false);
    expect(old.reason).toBe("epoch_mismatch");
  } finally {
    restoredControl.close();
  }
});

it("preserves the restored financial rows, block and credential deletion", async () => {
  const f = setup({ reserve: true });
  const bundle = join(f.base, "bundle");
  const restored = join(f.base, "restored");
  await writeManagedBackup({ root: f.root, destination: bundle, offline: true });
  await restoreManagedBackup({
    bundle,
    destination: restored,
    currentRoot: f.root,
    offline: true,
  });

  const restoredControl = new ControlStore(join(restored, "control.sqlite"), clock);
  try {
    expect(controlRestoreRequired(restoredControl)).toBe(true);
    expect(restoredControl.resolveSession(f.token)).toBeUndefined();
    const count = restoredControl.db
      .prepare("SELECT count(*) AS n FROM managed_reservations")
      .get() as { n: number };
    expect(count.n).toBeGreaterThanOrEqual(1);
    expect(
      new ManagedReconciliationStore(restoredControl, restored, clock).readEpoch()!.epoch,
    ).toBe(f.epoch.epoch + 1);
  } finally {
    restoredControl.close();
  }
});

it("refuses a mismatched marker but restores a previous-format bundle as blocked", async () => {
  const tampered = setup();
  writeFileSync(
    markerPath(tampered.root),
    JSON.stringify({ schema: 1, epoch: 1, nonce: "d".repeat(64) }),
  );
  await expect(
    writeManagedBackup({
      root: tampered.root,
      destination: join(tampered.base, "tampered-bundle"),
      offline: true,
    }),
  ).rejects.toThrow();
  expect(existsSync(join(tampered.base, "tampered-bundle"))).toBe(false);

  const f = setup();
  const bundle = join(f.base, "bundle");
  const restored = join(f.base, "restored");
  await writeManagedBackup({ root: f.root, destination: bundle, offline: true });
  // Emulate a previous-format bundle that predates the root marker field.
  const manifestPath = join(bundle, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  delete manifest.root_marker;
  manifest.files = manifest.files.filter(
    (file: { path: string }) => file.path !== "control-epoch.json",
  );
  writeFileSync(manifestPath, JSON.stringify(manifest));
  rmSync(join(bundle, "control-epoch.json"), { force: true });

  await expect(
    restoreManagedBackup({
      bundle,
      destination: restored,
      currentRoot: f.root,
      offline: true,
    }),
  ).resolves.toBeTruthy();

  const restoredControl = new ControlStore(join(restored, "control.sqlite"), clock);
  try {
    expect(controlRestoreRequired(restoredControl)).toBe(true);
  } finally {
    restoredControl.close();
  }
});
