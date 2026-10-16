import { expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStore } from "../../packages/storage/control.ts";
import { ManagedSpendingStore } from "../../packages/storage/managed-spending.ts";
import type { ManagedDispatchSpec } from "../../packages/domain/managed-spend.ts";
import { ManagedRuntime } from "../../packages/runtime/managed.ts";
import { ManagedWorker } from "../../apps/worker/managed.ts";
import { PreparedReasoningProvider, type PreparedProvider } from "../../packages/providers/prepared.ts";
import { ManagedReconciliationStore } from "../../packages/storage/managed-reconciliation.ts";
import { ManagedActivationStore } from "../../packages/storage/managed-activation.ts";
import { auditManagedHistory } from "../../packages/runtime/managed-audit.ts";

function fixture(path = ":memory:") {
  let now = "2026-10-16T09:00:00Z";
  const clock = () => new Date(now);
  const control = new ControlStore(path, clock);
  const money = new ManagedSpendingStore(control, clock);
  const a = control.provision("https://synthetic.example.test", "synthetic-ambiguity-a");
  const b = control.provision("https://synthetic.example.test", "synthetic-ambiguity-b");
  money.setServicePolicy({ daily_micro_usd: 1000 });
  for (const account of [a, b]) {
    money.configureAccountPeriod({ account_id: account.id, starts_at: "2026-10-16T00:00:00Z", ends_at: "2026-10-18T00:00:00Z", allowance_micro_usd: 1000 });
    money.setAccountPolicy({ account_id: account.id, per_job_micro_usd: 1000, user_daily_micro_usd: 1000 });
  }
  const limits = { per_job_micro_usd: 1000, user_daily_micro_usd: 1000, time_zone: "UTC" };
  const spec = (accountId: string, job: string, stage: "reasoning" | "decision" = "reasoning"): ManagedDispatchSpec => ({ account_id: accountId, job_id: job, dispatch_key: stage, stage, provider: "synthetic", model: "synthetic", price_version: "synthetic-v1", reserved_micro_usd: 10, request_hash: "a".repeat(64), config_hash: "b".repeat(64), limits });
  return { control, money, a, b, spec, limits, clock, advance(value: string) { now = value; } };
}

it("one committed mark denies another account's new reserve and an already reserved different stage", () => {
  const f = fixture();
  try {
    const a = f.money.reserve(f.spec(f.a.id, "synthetic-a"));
    const b = f.money.reserve(f.spec(f.b.id, "synthetic-b", "decision"));
    f.money.mark(a.call_id, f.limits);
    expect(() => f.money.reserve(f.spec(f.b.id, "synthetic-next"))).toThrow();
    expect(() => f.money.mark(b.call_id, f.limits)).toThrow();
    expect(f.money.readReceipt(b.call_id)).toMatchObject({ state: "reserved", actual_micro_usd: null });
    expect(f.money.accountStatus(f.b.id).blocked).toBe(true);
  } finally { f.control.close(); }
});

it("an unknown previous-day dispatch pauses all paid work without inserting a new safety marker", () => {
  const f = fixture();
  try {
    const a = f.money.reserve(f.spec(f.a.id, "synthetic-a"));
    f.money.mark(a.call_id, f.limits);
    f.advance("2026-10-17T09:00:00Z");
    expect(() => f.money.reserve(f.spec(f.b.id, "synthetic-next-day"))).toThrow();
    expect(f.money.accountStatus(f.b.id).blocked).toBe(true);
    expect(f.control.db.prepare("SELECT count(*) AS n FROM managed_money_blocks").get()?.n).toBe(0);
    expect(f.money.readReceipt(a.call_id)).toMatchObject({ state: "dispatched", actual_micro_usd: null });
  } finally { f.control.close(); }
});

it("reserved-only holds do not halt the service and ordinary known settlement lets the next mark proceed", () => {
  const f = fixture();
  try {
    const a = f.money.reserve(f.spec(f.a.id, "synthetic-a"));
    const b = f.money.reserve(f.spec(f.b.id, "synthetic-b"));
    expect(f.money.accountStatus(f.b.id).blocked).toBe(false);
    f.money.mark(a.call_id, f.limits);
    expect(() => f.money.mark(b.call_id, f.limits)).toThrow();
    f.money.settleKnown(a.call_id, 7);
    expect(f.money.accountStatus(f.b.id).blocked).toBe(false);
    expect(f.money.mark(b.call_id, f.limits)).toMatchObject({ state: "dispatched" });
    expect(() => f.money.releaseUndispatched(b.call_id)).toThrow();
  } finally { f.control.close(); }
});

it("a fresh control connection after restart still sees the durable pause without the old process fuse", () => {
  const base = mkdtempSync(join(tmpdir(), "brain-ambiguity-restart-review-"));
  const path = join(base, "control.sqlite");
  const f = fixture(path);
  let fresh: ControlStore | undefined;
  let closed = false;
  try {
    const a = f.money.reserve(f.spec(f.a.id, "synthetic-a"));
    const b = f.money.reserve(f.spec(f.b.id, "synthetic-before-restart"));
    f.money.mark(a.call_id, f.limits);
    f.control.close();
    closed = true;
    fresh = new ControlStore(path, f.clock);
    const money = new ManagedSpendingStore(fresh, f.clock);
    expect(() => money.reserve(f.spec(f.b.id, "synthetic-after-restart"))).toThrow();
    expect(() => money.mark(b.call_id, f.limits)).toThrow();
    expect(money.accountStatus(f.b.id).blocked).toBe(true);
  } finally { fresh?.close(); if (!closed) f.control.close(); rmSync(base, { recursive: true, force: true }); }
});

it("a valid managed call keeps consent through its own marker and settles once without stopping workers", async () => {
  const root = mkdtempSync(join(tmpdir(), "brain-ambiguity-worker-review-"));
  const clock = () => new Date("2026-10-16T09:00:00Z");
  const runtime = new ManagedRuntime(root, { clock });
  const account = runtime.provision("https://synthetic.example.test", "synthetic-normal-settle");
  const handle = runtime.acquire(account.id);
  try {
    const central = new ManagedSpendingStore(runtime.control, clock);
    central.setServicePolicy({ daily_micro_usd: 1000 });
    central.setAccountPolicy({ account_id: account.id, per_job_micro_usd: 1000, user_daily_micro_usd: 1000 });
    central.configureAccountPeriod({ account_id: account.id, starts_at: "2026-10-16T00:00:00Z", ends_at: "2026-10-17T00:00:00Z", allowance_micro_usd: 1000 });
    const owner = handle.brain.ownerPrincipal();
    handle.brain.prefs(owner, { ...handle.brain.prefs(owner), time_zone: "UTC", provider_enabled: true, daily_cap_micro_usd: 1000, per_job_cap_micro_usd: 1000 });
    const saved = handle.brain.capture(owner, { title: "Synthetic", body: "SYNTHETIC consent remains granted" }) as { source_id: string; job: { id: string } };
    const ack = { offline: true as const, workers_terminated: true as const };
    new ManagedReconciliationStore(runtime.control, root, clock).initEpoch(ack);
    const audit = auditManagedHistory({ runtime, root, clock, ...ack });
    expect(audit.ok).toBe(true);
    const profile = new ManagedActivationStore(runtime.control, root, clock).enable({
      provider: "openai", model: "synthetic-model-v1", price_version: "synthetic-price-v1",
      input_micro_usd_per_million: 10_000, output_micro_usd_per_million: 10_000,
      accepted_response_models: ["synthetic-model-v1"], max_output_tokens: 100,
      endpoint_class: "openai_responses", audit_id: audit.audit_id!, expected_version: 0,
    }, ack);
    const prepared = new PreparedReasoningProvider({
      model: profile.model, key: "SYNTHETIC_UNUSED_KEY",
      accepted_response_models: profile.accepted_response_models, max_output_tokens: profile.max_output_tokens,
      price: { version: profile.price_version, input_micro_usd_per_million: profile.input_micro_usd_per_million, output_micro_usd_per_million: profile.output_micro_usd_per_million },
    }, async () => { throw new Error("SYNTHETIC_NETWORK_DENIED"); });
    vi.stubEnv("BRAIN_MANAGED_ALLOW_PAID", "1");
    let sends = 0, consentAtSend = false, pausedAtSend = false;
    const provider: PreparedProvider = { prepareCall(input) { const call = prepared.prepareCall(input); return {
      identity: call.identity,
      request_bytes: call.request_bytes,
      async execute() {
        sends++;
        consentAtSend = handle.brain.prefs(owner).provider_enabled;
        pausedAtSend = handle.brain.status(owner).spend.blocked;
        return { accounting: { state: "known", cost_micro_usd: 7, usage: { input_tokens: 1, output_tokens: 1 }, model: profile.model }, output: { ok: true, kind: "brief", items: [{ text: "A supported synthetic statement", epistemic_status: "supported", evidence: [{ source_id: saved.source_id, source_version: 1, start: 0, end: 9, quote: "SYNTHETIC" }] }], unknowns: [] } };
      },
    }; } };
    const worker = new ManagedWorker(runtime, { providerFactory: () => provider });
    try {
      await worker.tick();
      expect(sends).toBe(1);
      expect(consentAtSend).toBe(true);
      expect(pausedAtSend).toBe(true);
      expect(handle.brain.store.get("SELECT status FROM jobs WHERE id=?", saved.job.id)?.status).toBe("succeeded");
      expect(central.latestForJob(account.id, saved.job.id)).toMatchObject({ state: "settled", actual_micro_usd: 7 });
      expect(central.accountStatus(account.id).blocked).toBe(false);
    } finally { await worker.stop(); }
  } finally { vi.unstubAllEnvs(); handle.release(); runtime.close(); rmSync(root, { recursive: true, force: true }); }
});

it("another account's ambiguity produces a content-free pause while own money and capture remain available", () => {
  const root = mkdtempSync(join(tmpdir(), "brain-ambiguity-view-review-"));
  const clock = () => new Date("2026-10-16T09:00:00Z");
  const runtime = new ManagedRuntime(root, { clock });
  const a = runtime.provision("https://synthetic.example.test", "synthetic-a");
  const b = runtime.provision("https://synthetic.example.test", "synthetic-b");
  const handle = runtime.acquire(b.id);
  try {
    const money = new ManagedSpendingStore(runtime.control, clock);
    money.setServicePolicy({ daily_micro_usd: 1000 });
    for (const account of [a, b]) {
      money.setAccountPolicy({ account_id: account.id, per_job_micro_usd: 1000, user_daily_micro_usd: 1000 });
      money.configureAccountPeriod({ account_id: account.id, starts_at: "2026-10-16T00:00:00Z", ends_at: "2026-10-17T00:00:00Z", allowance_micro_usd: 1000 });
    }
    const limits = { per_job_micro_usd: 1000, user_daily_micro_usd: 1000, time_zone: "UTC" };
    const pending = money.reserve({ account_id: a.id, job_id: "synthetic-private-job", dispatch_key: "reasoning", stage: "reasoning", provider: "synthetic", model: "synthetic", price_version: "synthetic-v1", reserved_micro_usd: 10, request_hash: "a".repeat(64), config_hash: "b".repeat(64), limits });
    money.mark(pending.call_id, limits);
    const owner = handle.brain.ownerPrincipal();
    const spend = handle.brain.status(owner).spend;
    expect(spend).toMatchObject({ actual: 0, reserved: 0, blocked: true, available: false });
    const text = JSON.stringify(spend);
    for (const privateValue of [a.id, pending.call_id, "synthetic-private-job", "service_day_micro_usd"]) expect(text).not.toContain(privateValue);
    const saved = handle.brain.capture(owner, { title: "Saved during pause", body: "SYNTHETIC_CAPTURE_WITH_GLOBAL_PAUSE" }) as { source_id: string };
    expect(handle.brain.source(owner, saved.source_id).body).toBe("SYNTHETIC_CAPTURE_WITH_GLOBAL_PAUSE");
  } finally { handle.release(); runtime.close(); rmSync(root, { recursive: true, force: true }); }
});
