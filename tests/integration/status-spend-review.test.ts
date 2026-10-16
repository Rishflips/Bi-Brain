import { expect, it } from "vitest";
import { Storage } from "../../packages/storage/index.ts";
import { Brain } from "../../packages/domain/service.ts";
import { DispatchLedger, paidProcessingBlockedSetting } from "../../packages/storage/spend.ts";
import { Worker } from "../../apps/worker/engine.ts";

const clock = () => new Date("2026-10-16T00:30:00Z");

it("reports legacy holds and new charges in the frozen accounting zone after a schedule-zone change", () => {
  const store = new Storage(":memory:");
  const brain = new Brain(store, clock), owner = brain.ownerPrincipal();
  try {
    brain.prefs(owner, { ...brain.prefs(owner), time_zone: "UTC", per_job_cap_micro_usd: 1000, daily_cap_micro_usd: 1000 });
    const job = brain.enqueue("inbox", "derive_brief", { principal: owner });
    const oldJob = brain.enqueue("inbox", "derive_brief", { principal: owner });
    store.run("UPDATE jobs SET status='running',lease_owner='synthetic-worker',fence=1,lease_until=? WHERE id=?", "2026-10-16T01:00:00Z", job.id);
    store.run("INSERT INTO reservations VALUES(?,?,?,?,?)", oldJob.id, "2026-10-15", 2, 0, "held");
    const ledger = new DispatchLedger(store, clock);
    const lease = { job_id: job.id, owner: "synthetic-worker", fence: 1, expires_at: "2026-10-16T01:00:00Z" };
    const limits = { per_job_micro_usd: 1000, daily_micro_usd: 1000, time_zone: "UTC" };
    const spec = { job_id: job.id, stage: "reasoning" as const, provider: "synthetic", model: "synthetic", price_version: "synthetic-v1", request_hash: "a".repeat(64), config_hash: "b".repeat(64) };
    const paid = ledger.reserve({ ...spec, dispatch_key: "reasoning", reserved_micro_usd: 8 }, lease, limits);
    ledger.markDispatched(paid.call_id, lease);
    ledger.settle(paid.call_id, 7);
    ledger.reserve({ ...spec, dispatch_key: "repair", reserved_micro_usd: 20 }, lease, limits);
    brain.prefs(owner, { ...brain.prefs(owner), time_zone: "America/Los_Angeles" });
    expect(brain.status(owner).spend).toMatchObject({
      actual: 7, reserved: 22, settled_micro_usd: 7, unresolved_micro_usd: 22,
      committed_micro_usd: 29, remaining_micro_usd: 971, budget_day: "2026-10-16", time_zone: "UTC",
    });
  } finally { store.close(); }
});

it("a durable block defeats an old enabled preference without blocking capture or extractive preparation", async () => {
  const store = new Storage(":memory:");
  const brain = new Brain(store, clock), owner = brain.ownerPrincipal();
  try {
    brain.prefs(owner, { ...brain.prefs(owner), provider_enabled: true, per_job_cap_micro_usd: 1000, daily_cap_micro_usd: 1000 });
    store.set(paidProcessingBlockedSetting, { reason: "restored_backup", at: clock().toISOString() });
    expect(brain.prefs(owner).provider_enabled).toBe(false);
    expect(() => brain.prefs(owner, { ...brain.prefs(owner), provider_enabled: true })).toThrow();
    expect(brain.prefs(owner, { ...brain.prefs(owner), digest_hour: 10, provider_enabled: false }).digest_hour).toBe(10);
    brain.capture(owner, { title: "Still useful", body: "SYNTHETIC_CAPTURE_WHILE_BLOCKED" });
    let paidCalls = 0;
    await new Worker(brain, { prepareCall() { paidCalls++; throw new Error("Paid processing must not start."); } }).tick();
    expect(paidCalls).toBe(0);
    expect(brain.entities(owner, "brief")).toHaveLength(1);
    expect(brain.status(owner).spend).toMatchObject({ blocked: true });
    expect(store.setting(paidProcessingBlockedSetting, null)).toMatchObject({ reason: "restored_backup" });
  } finally { store.close(); }
});
