import { expect, it } from "vitest";
import { ControlStore } from "../../packages/storage/control.ts";
import { ManagedSpendingStore } from "../../packages/storage/managed-spending.ts";
import type { ManagedDispatchSpec } from "../../packages/domain/managed-spend.ts";

const clock = () => new Date("2026-10-16T09:00:00Z");
function fixture() {
  const control = new ControlStore(":memory:", clock);
  const store = new ManagedSpendingStore(control, clock);
  const account = control.provision("https://synthetic.example.test", "synthetic-a");
  store.configureAccountPeriod({ account_id: account.id, starts_at: "2026-10-16T00:00:00Z", ends_at: "2026-10-18T00:00:00Z", allowance_micro_usd: 100 });
  store.setServicePolicy({ daily_micro_usd: 100 });
  store.setAccountPolicy({ account_id: account.id, per_job_micro_usd: 100, user_daily_micro_usd: 100 });
  const limits = { per_job_micro_usd: 100, user_daily_micro_usd: 100, time_zone: "UTC" };
  const spec = (job: string, amount = 7): ManagedDispatchSpec => ({
    account_id: account.id, job_id: job, dispatch_key: "reasoning", stage: "reasoning", reserved_micro_usd: amount,
    provider: "synthetic", model: "synthetic", price_version: "synthetic-v1", request_hash: "a".repeat(64), config_hash: "b".repeat(64), limits,
  });
  return { control, store, account, limits, spec };
}

it("a zero service policy denies admission even when a provider estimates zero cost", () => {
  const f = fixture();
  try {
    f.store.setServicePolicy({ daily_micro_usd: 0 });
    expect(() => f.store.reserve(f.spec("synthetic-zero", 0))).toThrow();
  } finally { f.control.close(); }
});

it("lowering the service policy to zero also prevents an already reserved zero-cost dispatch", () => {
  const f = fixture();
  try {
    const record = f.store.reserve(f.spec("synthetic-zero", 0));
    f.store.setServicePolicy({ daily_micro_usd: 0 });
    expect(() => f.store.mark(record.call_id, f.limits)).toThrow();
  } finally { f.control.close(); }
});

it.each(["2026-10-19", "2026-10-19T00:00:00", "October 19, 2026"])("allowance instants must have explicit ISO time zones: %s", (starts_at) => {
  const f = fixture();
  try {
    expect(() => f.store.configureAccountPeriod({ account_id: f.account.id, starts_at, ends_at: "2026-10-20T00:00:00Z", allowance_micro_usd: 100 })).toThrow();
  } finally { f.control.close(); }
});

it("an overrun blocks a previously reserved call for a different account too", () => {
  const f = fixture();
  try {
    const other = f.control.provision("https://synthetic.example.test", "synthetic-b");
    f.store.configureAccountPeriod({ account_id: other.id, starts_at: "2026-10-16T00:00:00Z", ends_at: "2026-10-18T00:00:00Z", allowance_micro_usd: 100 });
    f.store.setAccountPolicy({ account_id: other.id, per_job_micro_usd: 100, user_daily_micro_usd: 100 });
    const a = f.store.reserve(f.spec("synthetic-a"));
    const b = f.store.reserve({ ...f.spec("synthetic-b"), account_id: other.id });
    f.store.mark(a.call_id, f.limits);
    f.store.settleKnown(a.call_id, 9);
    expect(() => f.store.mark(b.call_id, f.limits)).toThrow();
    expect(f.store.readReceipt(a.call_id)).toMatchObject({ state: "settled", actual_micro_usd: 9 });
    expect(f.store.readReceipt(b.call_id)).toMatchObject({ state: "reserved" });
  } finally { f.control.close(); }
});
