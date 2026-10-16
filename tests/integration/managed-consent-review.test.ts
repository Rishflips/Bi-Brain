import { expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createApp } from "../../apps/server/app.ts";
import { managedCapability } from "../../apps/server/startup-gates.ts";
import { ManagedRuntime } from "../../packages/runtime/managed.ts";
import { ManagedSpendingStore } from "../../packages/storage/managed-spending.ts";
import { ManagedReconciliationStore } from "../../packages/storage/managed-reconciliation.ts";
import { ManagedActivationStore } from "../../packages/storage/managed-activation.ts";
import { auditManagedHistory } from "../../packages/runtime/managed-audit.ts";
import { writeWorkerReadiness } from "../../packages/runtime/worker-readiness.ts";

const ORIGIN = "https://brain.example.test", HOST = "brain.example.test";
const now = new Date("2026-10-16T09:00:00.000Z"), clock = () => now;
async function fixture(ready = false) {
  const root = mkdtempSync(join(tmpdir(), "brain-consent-parent-"));
  vi.stubEnv("BRAIN_MANAGED_ALLOW_PAID", "1");
  const capability = () => managedCapability({ control: runtime.control, root, now, optIn: true });
  const runtime: ManagedRuntime = new ManagedRuntime(root, { clock, capability: () => { const c = capability(); return { ready: c.available, reason: c.reason }; } });
  const a = runtime.provision("https://synthetic.example.test", "synthetic-consent-a");
  const b = runtime.provision("https://synthetic.example.test", "synthetic-consent-b");
  const money = new ManagedSpendingStore(runtime.control, clock);
  money.setServicePolicy({ daily_micro_usd: 100_000 });
  for (const account of [a, b]) {
    money.setAccountPolicy({ account_id: account.id, per_job_micro_usd: 10_000, user_daily_micro_usd: 100_000 });
    money.configureAccountPeriod({ account_id: account.id, starts_at: "2026-10-16T00:00:00Z", ends_at: "2026-10-17T00:00:00Z", allowance_micro_usd: 100_000 });
  }
  const handle = runtime.acquire(a.id), brain = handle.brain, owner = brain.ownerPrincipal();
  brain.prefs(owner, { ...brain.prefs(owner), time_zone: "UTC", provider_enabled: true, per_job_cap_micro_usd: 10_000, daily_cap_micro_usd: 100_000 });
  const ack = { offline: true as const, workers_terminated: true as const };
  new ManagedReconciliationStore(runtime.control, root, clock).initEpoch(ack);
  const audit = auditManagedHistory({ runtime, root, clock, ...ack });
  expect(audit.ok).toBe(true);
  const activation = new ManagedActivationStore(runtime.control, root, clock);
  const profile = activation.enable({ provider: "openai", model: "synthetic-model-v1", price_version: "synthetic-price-v1", input_micro_usd_per_million: 10_000, output_micro_usd_per_million: 10_000, accepted_response_models: ["synthetic-model-v1"], max_output_tokens: 100, endpoint_class: "openai_responses", audit_id: audit.audit_id!, expected_version: 0 }, ack);
  if (ready) writeWorkerReadiness(root, {
    schema: 1, worker_id: randomUUID(), epoch: profile.epoch, root_nonce: profile.root_nonce,
    activation_fingerprint: profile.fingerprint, config_digest: profile.config_digest,
    provider: profile.provider, model: profile.model, price_version: profile.price_version, endpoint_class: profile.endpoint_class,
    booted_at: now.toISOString(), heartbeat_at: now.toISOString(), expires_at: "2026-10-16T09:00:15.000Z",
  });
  // This is an explicit synthetic liveness fixture, not an actual worker proof.
  const app = await createApp(undefined, { managed: runtime, static: false, publicOrigin: ORIGIN, capability });
  const session = runtime.control.issueSession(a.id);
  const headers = { host: HOST, cookie: `brain_session=${session.token}`, "x-brain-csrf": session.csrf };
  const get = (url: string) => app.inject({ url, headers });
  const patch = async (payload: Record<string, unknown>) => {
    const current = (await get("/api/v1/preferences/background")).json();
    const { provider_enabled: _derived, ...fields } = current;
    void _derived;
    return app.inject({ method: "PATCH", url: "/api/v1/preferences/background", headers, payload: { ...fields, ...payload } });
  };
  async function unrelated() {
    const prefs = (await get("/api/v1/preferences/background")).json();
    const { provider_enabled: _derived, ...fields } = prefs;
    void _derived;
    return patch({ ...fields, digest_hour: 7, per_job_cap_micro_usd: 1234 });
  }
  function dispatch(accountId: string, actual?: number) {
    const limits = { per_job_micro_usd: 10_000, user_daily_micro_usd: 100_000, time_zone: "UTC" };
    const row = money.reserve({ account_id: accountId, job_id: "synthetic-held-job", dispatch_key: "reasoning", stage: "reasoning", provider: "synthetic", model: "synthetic", price_version: "synthetic-v1", reserved_micro_usd: 10, request_hash: "a".repeat(64), config_hash: "b".repeat(64), limits });
    money.mark(row.call_id, limits);
    if (actual !== undefined) money.settleKnown(row.call_id, actual);
    return row;
  }
  return { root, runtime, a, b, money, brain, owner, activation, profile, app, get, patch, unrelated, dispatch,
    async close() { await app.close(); handle.release(); runtime.close(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } };
}

it("stored consent remains visible and revocable without a ready worker; unrelated settings preserve it", async () => {
  const f = await fixture();
  try {
    expect((await f.get("/api/v1/runtime")).json().connected_processing_available).toBe(false);
    const spend = (await f.get("/api/v1/today")).json().status.spend;
    expect(spend).toMatchObject({ stored_consent_active: true, consent_effective: false, capability_ready: false });
    expect((await f.unrelated()).statusCode).toBe(200);
    expect(f.brain.backgroundConsent(f.owner)).toBe(true);
    expect((await f.patch({ provider_enabled: false })).statusCode).toBe(200);
    expect(f.brain.backgroundConsent(f.owner)).toBe(false);
    expect((await f.patch({ provider_enabled: true })).statusCode).toBe(503);
    expect(f.brain.backgroundConsent(f.owner)).toBe(false);
  } finally { await f.close(); }
});

it("an unknown call pauses admission, not capability or an otherwise valid consent grant", async () => {
  const f = await fixture(true);
  try {
    const other = f.dispatch(f.b.id);
    const meta = (await f.get("/api/v1/runtime")).json();
    expect(meta.connected_processing_available).toBe(true);
    expect((await f.patch({ provider_enabled: false })).statusCode).toBe(200);
    expect((await f.patch({ provider_enabled: true })).statusCode).toBe(200);
    const today = await f.get("/api/v1/today");
    expect(today.json().status.spend).toMatchObject({ stored_consent_active: true, consent_effective: true, capability_ready: true, blocked: true, available: false });
    for (const value of [f.b.id, other.call_id, "synthetic-held-job", f.profile.audit_id, f.profile.fingerprint, "service_daily_cap_micro_usd"]) expect(today.body).not.toContain(value);
  } finally { await f.close(); }
});

it("ready processing with consent and monetary headroom is reported available rather than hard-coded off", async () => {
  const f = await fixture(true);
  try {
    const today = await f.get("/api/v1/today");
    expect(today.statusCode).toBe(200);
    expect(today.json().status.spend).toMatchObject({
      stored_consent_active: true, consent_effective: true, capability_ready: true,
      configured: true, blocked: false, available: true,
    });
  } finally { await f.close(); }
});

it("durable blocks preserve raw consent on unrelated saves, allow withdrawal and still deny re-enable", async () => {
  const f = await fixture(true);
  try {
    f.dispatch(f.a.id, 11);
    expect((await f.get("/api/v1/today")).json().status.spend).toMatchObject({ stored_consent_active: true, consent_effective: false, capability_ready: true });
    expect((await f.unrelated()).statusCode).toBe(200);
    expect(f.brain.backgroundConsent(f.owner)).toBe(true);
    expect((await f.patch({ provider_enabled: false })).statusCode).toBe(200);
    expect(f.brain.backgroundConsent(f.owner)).toBe(false);
    expect((await f.patch({ provider_enabled: true })).statusCode).toBe(409);
    expect(f.money.accountStatus(f.a.id).blocked).toBe(true);
  } finally { await f.close(); }
});

it("disable takes effect immediately despite a fresh old lease and does not trap true consent", async () => {
  const f = await fixture(true);
  try {
    expect((await f.get("/api/v1/runtime")).json().connected_processing_available).toBe(true);
    f.activation.disable(f.profile.version);
    expect((await f.get("/api/v1/runtime")).json().connected_processing_available).toBe(false);
    expect((await f.patch({ provider_enabled: false })).statusCode).toBe(200);
    expect(f.brain.backgroundConsent(f.owner)).toBe(false);
  } finally { await f.close(); }
});

it("a public capability response is content-free and cannot be promoted through preference input", async () => {
  const f = await fixture(true);
  try {
    const meta = await f.get("/api/v1/runtime");
    expect(meta.json().connected_processing_available).toBe(true);
    for (const value of [f.a.id, f.b.id, f.profile.model, f.profile.price_version, f.profile.audit_id, f.profile.fingerprint, f.profile.config_digest, "service_daily_cap_micro_usd"]) expect(meta.body).not.toContain(value);
    expect((await f.patch({ provider_enabled: true, capability_ready: true })).statusCode).toBe(400);
    expect((await f.get("/api/v1/preferences/background")).json()).not.toHaveProperty("stored_consent_active");
  } finally { await f.close(); }
});

it("suspension still denies withdrawal and raw-consent reads on an already pinned brain", async () => {
  const f = await fixture(true);
  try {
    f.runtime.control.setAccountState(f.a.id, "suspended");
    expect((await f.patch({ provider_enabled: false })).statusCode).toBe(401);
    expect(() => f.brain.backgroundConsent(f.owner)).toThrow();
  } finally { await f.close(); }
});
