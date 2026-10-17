import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { ManagedRuntime } from "../../packages/runtime/managed.ts";
import { restoreManagedBackup, writeManagedBackup } from "../../packages/runtime/managed-recovery.ts";
import { BillingAuthority } from "../../packages/storage/billing-authority.ts";
import { ManagedSpendingStore } from "../../packages/storage/managed-spending.ts";
import { createBillingAdmissionFixture } from "../helpers/billing-admission-fixture.ts";

it("a real cold v5 round trip rotates incarnation, preserves an unknown hold and keeps knowledge usable", async () => {
  const options = { cadence: "monthly" as const, enrolled: true };
  const f = createBillingAdmissionFixture(options);
  let restored: ManagedRuntime | undefined;
  try {
    const prepared = await f.prepare();
    if (prepared.state !== "prepared") throw new Error("Synthetic admission did not prepare.");
    expect(f.admit(prepared.preflight_id).state).toBe("admitted");
    const authority = new BillingAuthority({ control: f.control, root: f.root,
      clock: f.control.clock, source: { read: async () => f.facts } });
    expect((await authority.reconcile(f.account_id)).state).toBe("granted");
    const handle = f.runtime.acquire(f.account_id);
    try {
      handle.brain.capture(handle.brain.ownerPrincipal(), { title: "SYNTHETIC restore evidence",
        body: "SYNTHETIC retained knowledge after billing restore." });
    } finally { handle.release(); }
    const limits = { per_job_micro_usd: 100, user_daily_micro_usd: 500, time_zone: "UTC" };
    const reserved = f.spending.reserve({ account_id: f.account_id, job_id: randomUUID(), dispatch_key: "reasoning",
      stage: "reasoning", reserved_micro_usd: 3, provider: "synthetic", model: "SYNTHETIC-model",
      price_version: "SYNTHETIC-price", request_hash: "a".repeat(64), config_hash: "b".repeat(64), limits });
    f.spending.mark(reserved.call_id, limits);
    const originalMoney = f.control.db.prepare("SELECT * FROM managed_reservations WHERE call_id=?").get(reserved.call_id);
    const originalIncarnation = f.control.db.prepare("SELECT incarnation,provisioning_generation FROM managed_account_incarnation WHERE account_id=?")
      .get(f.account_id) as { incarnation: string; provisioning_generation: number };
    const originalEpoch = (f.control.db.prepare("SELECT epoch FROM managed_control_epoch WHERE singleton=1").get() as { epoch: number }).epoch;
    const bundle = join(f.dir, "cold-bundle"), destination = join(f.dir, "restored");
    const clock = f.control.clock;
    f.runtime.close();
    await writeManagedBackup({ root: f.root, destination: bundle, offline: true });
    await restoreManagedBackup({ bundle, destination, currentRoot: f.root, offline: true });
    restored = new ManagedRuntime(destination, { clock });
    const current = restored.control.db.prepare("SELECT incarnation,provisioning_generation FROM managed_account_incarnation WHERE account_id=?")
      .get(f.account_id) as { incarnation: string; provisioning_generation: number };
    expect(current.provisioning_generation).toBeGreaterThan(originalIncarnation.provisioning_generation);
    expect(current.incarnation).not.toBe(originalIncarnation.incarnation);
    const marker = JSON.parse(readFileSync(join(destination, f.account_id, "provisioned.json"), "utf8"));
    expect(marker).toMatchObject({ schema: 2, incarnation: current.incarnation,
      provisioning_generation: current.provisioning_generation });
    expect((restored.control.db.prepare("SELECT epoch FROM managed_control_epoch WHERE singleton=1").get() as { epoch: number }).epoch)
      .toBeGreaterThan(originalEpoch);
    expect(restored.control.db.prepare("SELECT * FROM managed_reservations WHERE call_id=?").get(reserved.call_id)).toEqual(originalMoney);
    const reopened = restored.acquire(f.account_id);
    try {
      expect(reopened.brain.sources(reopened.brain.ownerPrincipal()).some((source) =>
        source.body === "SYNTHETIC retained knowledge after billing restore.")).toBe(true);
      expect(reopened.brain.capture(reopened.brain.ownerPrincipal(), { title: "SYNTHETIC after restore",
        body: "SYNTHETIC capture works while paid processing is blocked." }).source_id).toBeTruthy();
    } finally { reopened.release(); }
    // The explicit restore/accounting block takes precedence over the retained
    // unknown-usage barrier; neither may be cleared by restoring the knowledge.
    expect(new ManagedSpendingStore(restored.control, clock).serviceBarrier()).toEqual({ paused: true, reason: "awaiting_accounting" });
  } finally { restored?.close(); f.close(); }
}, 60_000);
