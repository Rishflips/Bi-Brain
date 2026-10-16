import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedRuntime } from "../../packages/runtime/managed.ts";
import { ManagedSpendingStore } from "../../packages/storage/managed-spending.ts";
import { ManagedReconciliationStore } from "../../packages/storage/managed-reconciliation.ts";
import { assertTrustedManagedRoot } from "../../packages/runtime/managed-operator.ts";

const clock = () => new Date("2026-10-16T09:00:00Z");
const offline = { offline: true as const, workers_terminated: true as const };
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "brain-reconciliation-parent-"));
  const root = join(base, "managed");
  const runtime = new ManagedRuntime(root, { clock });
  const account = runtime.provision("https://synthetic.example.test", "synthetic-attestation");
  const money = new ManagedSpendingStore(runtime.control, clock);
  money.setServicePolicy({ daily_micro_usd: 1000 });
  money.setAccountPolicy({ account_id: account.id, per_job_micro_usd: 1000, user_daily_micro_usd: 1000 });
  money.configureAccountPeriod({ account_id: account.id, starts_at: "2026-10-16T00:00:00Z", ends_at: "2026-10-17T00:00:00Z", allowance_micro_usd: 1000 });
  const limits = { per_job_micro_usd: 1000, user_daily_micro_usd: 1000, time_zone: "UTC" };
  const held = money.reserve({ account_id: account.id, job_id: "synthetic-job", dispatch_key: "reasoning", stage: "reasoning", provider: "synthetic", model: "synthetic", price_version: "synthetic-v1", reserved_micro_usd: 10, request_hash: "a".repeat(64), config_hash: "b".repeat(64), limits });
  money.mark(held.call_id, limits);
  const reconciler = new ManagedReconciliationStore(runtime.control, root, clock);
  const epoch = reconciler.initEpoch(offline);
  const input = { resolution_id: randomUUID(), kind: "settled" as const, account_id: account.id, call_id: held.call_id, identity_hash: held.identity_hash, provider: held.provider, model: held.model, price_version: held.price_version, request_hash: held.request_hash, config_hash: held.config_hash, expected_state: "dispatched" as const, expected_actual_micro_usd: null, cost_micro_usd: 7, currency: "USD" as const, provider_request_id: "req_synthetic_1", evidence_digest: "c".repeat(64), method: "usage_response" as const, actor: "synthetic-operator", checked_at: clock().toISOString(), epoch: epoch.epoch };
  return { base, root, runtime, money, reconciler, input, held, close() { runtime.close(); rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } };
}

it.each([
  { actor: "SYNTHETIC_PRIVATE_SOURCE_BODY\nnot-opaque" },
  { provider_request_id: " \t " },
])("attestation metadata is an opaque identifier, not blank correlation or proof text: %j", (bad) => {
  const f = fixture();
  try {
    expect(() => f.reconciler.attestSettled({ ...f.input, ...bad }, offline)).toThrow();
    expect(f.money.readReceipt(f.held.call_id)).toMatchObject({ state: "dispatched", actual_micro_usd: null });
    expect(f.reconciler.readResolution(f.input.resolution_id)).toBeUndefined();
  } finally { f.close(); }
});

it("an ignored money update cannot produce a successful resolution proof", () => {
  const f = fixture();
  try {
    f.runtime.control.db.exec("CREATE TRIGGER synthetic_ignored_settlement BEFORE UPDATE OF state ON managed_reservations WHEN NEW.state='settled' BEGIN SELECT RAISE(IGNORE); END");
    expect(() => f.reconciler.attestSettled(f.input, offline)).toThrow();
    expect(f.money.readReceipt(f.held.call_id)).toMatchObject({ state: "dispatched", actual_micro_usd: null });
    expect(f.reconciler.readResolution(f.input.resolution_id)).toBeUndefined();
  } finally { f.close(); }
});

it("an overrun and its resolution both roll back when proof persistence fails", () => {
  const f = fixture();
  try {
    f.runtime.control.db.exec("CREATE TRIGGER synthetic_proof_failure BEFORE INSERT ON managed_resolutions BEGIN SELECT RAISE(ABORT,'synthetic proof failure'); END");
    expect(() => f.reconciler.attestSettled({ ...f.input, cost_micro_usd: 20 }, offline)).toThrow();
    expect(f.money.readReceipt(f.held.call_id)).toMatchObject({ state: "dispatched", actual_micro_usd: null });
    expect(f.reconciler.readResolution(f.input.resolution_id)).toBeUndefined();
    expect(f.runtime.control.db.prepare("SELECT count(*) AS n FROM managed_service_blocks").get()?.n).toBe(0);
  } finally { f.close(); }
});

it("a cached reconciler refuses a root marker replaced by a junction before another mutation", () => {
  const f = fixture();
  try {
    const outside = join(f.base, "outside-marker");
    mkdirSync(outside);
    const marker = join(f.root, "control-epoch.json");
    renameSync(marker, join(f.base, "saved-epoch.json"));
    symlinkSync(outside, marker, "junction");
    expect(() => f.reconciler.attestSettled(f.input, offline)).toThrow();
    expect(f.money.readReceipt(f.held.call_id)).toMatchObject({ state: "dispatched", actual_micro_usd: null });
    expect(f.reconciler.readResolution(f.input.resolution_id)).toBeUndefined();
  } finally { f.close(); }
});

it("operator preflight refuses an existing unrelated directory with no control database", () => {
  const root = mkdtempSync(join(tmpdir(), "brain-operator-uninitialized-parent-"));
  try {
    expect(() => assertTrustedManagedRoot(root)).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
