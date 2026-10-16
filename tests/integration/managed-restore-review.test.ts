import { expect, it } from "vitest";
import { ControlStore } from "../../packages/storage/control.ts";
import { ManagedSpendingStore } from "../../packages/storage/managed-spending.ts";
import { applyControlRestoreBarrier } from "../../packages/storage/managed-restore-policy.ts";

const clock = () => new Date("2026-10-16T09:00:00Z");

it("restored credentials stay invalid after money blocks are removed; obligations and identities survive", () => {
  const control = new ControlStore(":memory:", clock);
  try {
    const central = new ManagedSpendingStore(control, clock);
    const account = control.provision("https://synthetic.example.test", "synthetic-restore");
    const session = control.issueSession(account.id);
    const tokenHash = "c".repeat(64);
    control.registerAgentToken(tokenHash, account.id, "synthetic-grant");
    central.setServicePolicy({ daily_micro_usd: 100 });
    central.setAccountPolicy({ account_id: account.id, per_job_micro_usd: 100, user_daily_micro_usd: 100 });
    central.configureAccountPeriod({ account_id: account.id, starts_at: "2026-10-16T00:00:00Z", ends_at: "2026-10-17T00:00:00Z", allowance_micro_usd: 100 });
    const limits = { per_job_micro_usd: 100, user_daily_micro_usd: 100, time_zone: "UTC" };
    const spec = { account_id: account.id, job_id: "synthetic-restore-job", dispatch_key: "reasoning", stage: "reasoning" as const, provider: "synthetic", model: "synthetic", price_version: "synthetic-v1", reserved_micro_usd: 10, request_hash: "a".repeat(64), config_hash: "b".repeat(64), limits };
    const held = central.reserve(spec);
    central.mark(held.call_id, limits);
    const before = control.db.prepare("SELECT * FROM managed_reservations WHERE call_id=?").get(held.call_id);
    applyControlRestoreBarrier(control, clock);
    applyControlRestoreBarrier(control, clock);
    expect(central.accountStatus(account.id)).toMatchObject({ blocked: true, blocked_reason: "restored_backup", committed: { unresolved_micro_usd: 10 } });
    expect(control.db.prepare("SELECT * FROM managed_reservations WHERE call_id=?").get(held.call_id)).toEqual(before);
    expect(control.account(account.id)).toEqual(account);
    expect(control.resolveSession(session.token)).toBeUndefined();
    expect(control.agentTokenTenant(tokenHash)).toBeUndefined();
    expect(() => central.reserve({ ...spec, job_id: "synthetic-restored-next" })).toThrow();
    central.settleKnown(held.call_id, 7);
    expect(central.readReceipt(held.call_id)).toMatchObject({ state: "settled", actual_micro_usd: 7 });
    // Deliberate test-only financial-block removal must never revive opaque access.
    control.db.exec("DELETE FROM managed_money_blocks");
    expect(control.resolveSession(session.token)).toBeUndefined();
    expect(control.agentTokenTenant(tokenHash)).toBeUndefined();
  } finally { control.close(); }
});

it("an empty restored control plane is still blocked, even after positive operator policies are configured", () => {
  const control = new ControlStore(":memory:", clock);
  try {
    const central = new ManagedSpendingStore(control, clock);
    applyControlRestoreBarrier(control, clock);
    const account = control.provision("https://synthetic.example.test", "synthetic-empty-restored");
    central.setServicePolicy({ daily_micro_usd: 100 });
    central.setAccountPolicy({ account_id: account.id, per_job_micro_usd: 100, user_daily_micro_usd: 100 });
    central.configureAccountPeriod({ account_id: account.id, starts_at: "2026-10-16T00:00:00Z", ends_at: "2026-10-17T00:00:00Z", allowance_micro_usd: 100 });
    expect(central.accountStatus(account.id)).toMatchObject({ blocked: true, blocked_reason: "restored_backup", committed: { unresolved_micro_usd: 0 } });
  } finally { control.close(); }
});
