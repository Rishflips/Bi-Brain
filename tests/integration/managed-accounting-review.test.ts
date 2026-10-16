import { expect, it } from "vitest";
import { ControlStore } from "../../packages/storage/control.ts";
import { Storage } from "../../packages/storage/index.ts";
import { DispatchLedger } from "../../packages/storage/spend.ts";
import { ManagedSpendingStore } from "../../packages/storage/managed-spending.ts";
import { ManagedDispatchAccounting } from "../../apps/worker/managed-accounting.ts";
import { Brain } from "../../packages/domain/service.ts";
import type { DispatchSpec } from "../../packages/domain/spend.ts";

const clock = () => new Date("2026-10-16T09:00:00Z");
function setup() {
  const control = new ControlStore(":memory:", clock);
  const central = new ManagedSpendingStore(control, clock);
  const account = control.provision("https://synthetic.example.test", "synthetic-a");
  central.setServicePolicy({ daily_micro_usd: 1000 });
  const grant = (id: string) => {
    central.configureAccountPeriod({ account_id: id, starts_at: "2026-10-16T00:00:00Z", ends_at: "2026-10-18T00:00:00Z", allowance_micro_usd: 1000 });
    central.setAccountPolicy({ account_id: id, per_job_micro_usd: 1000, user_daily_micro_usd: 1000 });
  };
  grant(account.id);
  const store = new Storage(":memory:");
  const brain = new Brain(store, clock, account.id, () => control.account(account.id)?.state === "active");
  brain.prefs(brain.ownerPrincipal(), { ...brain.prefs(brain.ownerPrincipal()), provider_enabled: true, time_zone: "UTC", per_job_cap_micro_usd: 1000, daily_cap_micro_usd: 1000 });
  const accounting = new ManagedDispatchAccounting(central, brain, clock);
  const limits = { per_job_micro_usd: 1000, daily_micro_usd: 1000, time_zone: "UTC" };
  const job = () => {
    const row = brain.enqueue("inbox", "derive_brief", { principal: brain.ownerPrincipal() });
    store.run("UPDATE jobs SET status='running',lease_owner='synthetic-worker',fence=1,lease_until=? WHERE id=?", "2026-10-16T10:00:00Z", row.id);
    return { id: row.id, lease: { job_id: row.id, owner: "synthetic-worker", fence: 1, expires_at: "2026-10-16T10:00:00Z" } };
  };
  const spec = (id: string): DispatchSpec => ({ job_id: id, dispatch_key: "reasoning", stage: "reasoning", reserved_micro_usd: 10, provider: "synthetic", model: "synthetic", price_version: "synthetic-v1", request_hash: "a".repeat(64), config_hash: "b".repeat(64) });
  return { control, central, store, brain, accounting, limits, account, grant, job, spec, close() { store.close(); control.close(); } };
}

it.each(["legacy", "dispatch"])("unknown %s history on a different job denies a new managed admission", (kind) => {
  const f = setup();
  try {
    const older = f.job(), next = f.job();
    if (kind === "legacy") f.store.run("INSERT INTO reservations VALUES(?,?,?,?,?)", older.id, "2026-10-15", 7, 0, "held");
    else {
      const local = new DispatchLedger(f.store, clock);
      const held = local.reserve(f.spec(older.id), older.lease, f.limits);
      local.markDispatched(held.call_id, older.lease);
    }
    expect(() => f.accounting.reserve(f.spec(next.id), next.lease, f.limits)).toThrow();
    expect(f.control.db.prepare("SELECT count(*) AS n FROM managed_reservations").get()?.n).toBe(0);
  } finally { f.close(); }
});

it("a failed central settlement still preserves the tenant actual and blocks further service admission", () => {
  const f = setup();
  try {
    f.central.setServicePolicy({ daily_micro_usd: 30 });
    const job = f.job();
    const held = f.accounting.reserve(f.spec(job.id), job.lease, f.limits);
    f.accounting.markDispatched(held.call_id, job.lease);
    f.control.db.exec("CREATE TRIGGER synthetic_settlement_fault BEFORE UPDATE OF state ON managed_reservations WHEN NEW.state='settled' BEGIN SELECT RAISE(ABORT,'synthetic settlement fault'); END");
    expect(() => f.accounting.settle(held.call_id, 20)).toThrow();
    expect(f.store.get("SELECT state,actual_micro_usd FROM provider_dispatches WHERE call_id=?", held.call_id)).toMatchObject({ state: "settled", actual_micro_usd: 20 });
    const other = f.control.provision("https://synthetic.example.test", "synthetic-b");
    f.grant(other.id);
    expect(() => f.central.reserve({ ...f.spec("synthetic-other-job"), account_id: other.id, reserved_micro_usd: 20, limits: { per_job_micro_usd: 1000, user_daily_micro_usd: 1000, time_zone: "UTC" } })).toThrow();
    expect(f.central.accountStatus(other.id).blocked).toBe(true);
  } finally { f.close(); }
});

it("failed safety-marker persistence keeps the shared control handle paused even after writes recover", () => {
  const f = setup();
  try {
    f.central.setServicePolicy({ daily_micro_usd: 30 });
    const job = f.job();
    const held = f.accounting.reserve(f.spec(job.id), job.lease, f.limits);
    f.accounting.markDispatched(held.call_id, job.lease);
    f.control.db.exec("CREATE TRIGGER synthetic_settlement_fault BEFORE UPDATE OF state ON managed_reservations WHEN NEW.state='settled' BEGIN SELECT RAISE(ABORT,'synthetic settlement fault'); END");
    f.control.db.exec("CREATE TRIGGER synthetic_marker_fault BEFORE INSERT ON managed_money_blocks BEGIN SELECT RAISE(ABORT,'synthetic marker fault'); END");
    expect(() => f.accounting.settle(held.call_id, 20)).toThrow();
    expect(f.store.get("SELECT state,actual_micro_usd FROM provider_dispatches WHERE call_id=?", held.call_id)).toMatchObject({ state: "settled", actual_micro_usd: 20 });
    f.control.db.exec("DROP TRIGGER synthetic_settlement_fault; DROP TRIGGER synthetic_marker_fault;");
    const other = f.control.provision("https://synthetic.example.test", "synthetic-b");
    f.grant(other.id);
    const freshStore = new ManagedSpendingStore(f.control, clock);
    expect(() => freshStore.reserve({ ...f.spec("synthetic-after-recovery"), account_id: other.id, reserved_micro_usd: 20, limits: { per_job_micro_usd: 1000, user_daily_micro_usd: 1000, time_zone: "UTC" } })).toThrow();
    const saved = f.brain.capture(f.brain.ownerPrincipal(), { title: "Still captured", body: "SYNTHETIC_CAPTURE_DURING_FINANCIAL_PAUSE" });
    expect(saved.source_id).toBeTruthy();
  } finally { f.close(); }
});
