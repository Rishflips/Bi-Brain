import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createApp } from "../../apps/server/app.ts";
import {
  ManagedRuntime,
  managedCapability,
  managedDecisionCapability,
} from "../../packages/runtime/managed.ts";
import { ManagedSpendingStore } from "../../packages/storage/managed-spending.ts";
import { ManagedDecisionActivationStore } from "../../packages/storage/managed-decision-activation.ts";
import { ManagedActivationStore } from "../../packages/storage/managed-activation.ts";
import { ManagedReconciliationStore } from "../../packages/storage/managed-reconciliation.ts";
import { auditManagedHistory } from "../../packages/runtime/managed-audit.ts";
import {
  decisionWorkerReadinessPath,
  writeDecisionReadiness,
} from "../../packages/runtime/decision-worker-readiness.ts";
import {
  writeWorkerReadiness,
} from "../../packages/runtime/worker-readiness.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const ORIGIN = "https://brain.example.test";
const HOST = "brain.example.test";
const CLOCK = () => new Date("2026-10-17T12:00:00.000Z");
const ACK = { offline: true as const, workers_terminated: true as const };
const DECISION_WORKER = randomUUID();
const REASONING_WORKER = randomUUID();

function newRoot() {
  const base = mkdtempSync(join(tmpdir(), "brain-decision-consent-"));
  roots.push(base);
  return join(base, "managed");
}

async function fixture(
  opts: { decisionReady?: boolean; reasoningReady?: boolean } = {
    decisionReady: true,
    reasoningReady: true,
  },
) {
  const root = newRoot();
  const capability = () =>
    managedCapability({
      control: runtime.control,
      root,
      now: CLOCK(),
      optIn: true,
    });
  const decisionCapability = () =>
    managedDecisionCapability({
      control: runtime.control,
      root,
      now: CLOCK(),
      optIn: true,
    });
  const runtime: ManagedRuntime = new ManagedRuntime(root, {
    clock: CLOCK,
    capability: () => {
      const c = capability();
      return { ready: c.available, reason: c.reason };
    },
    decisionCapability: () => {
      const c = decisionCapability();
      return { ready: c.available, reason: c.reason };
    },
  });
  const a = runtime.provision("https://issuer.synthetic.test", "consent-a");
  const b = runtime.provision("https://issuer.synthetic.test", "consent-b");
  const money = new ManagedSpendingStore(runtime.control, CLOCK);
  money.setServicePolicy({ daily_micro_usd: 100_000 });
  for (const acct of [a, b]) {
    money.setAccountPolicy({
      account_id: acct.id,
      per_job_micro_usd: 10_000,
      user_daily_micro_usd: 100_000,
    });
    money.configureAccountPeriod({
      account_id: acct.id,
      starts_at: "2026-10-17T00:00:00Z",
      ends_at: "2026-10-18T00:00:00Z",
      allowance_micro_usd: 100_000,
    });
  }
  new ManagedReconciliationStore(runtime.control, root, CLOCK).initEpoch(ACK);
  const audit = auditManagedHistory({ runtime, root, clock: CLOCK, ...ACK });
  if (!audit.ok) throw new Error(`audit failed: ${audit.reason}`);
  const decisionProfile = new ManagedDecisionActivationStore(
    runtime.control,
    root,
    CLOCK,
  ).enable(
    {
      provider: "typesafe",
      model: "jev-synthetic-v1",
      accepted_response_models: ["jev-synthetic-v1"],
      endpoint: "https://api.typesafe.ai/v1/systemone",
      price_version: "synthetic-decision-price-v1",
      input_micro_usd_per_million: 1000,
      output_micro_usd_per_million: 0,
      timeout_ms: 1000,
      max_request_bytes: 1_048_576,
      max_response_bytes: 262_144,
      audit_id: audit.audit_id!,
      expected_version: 0,
    },
    ACK,
  );
  const reasoningProfile = new ManagedActivationStore(
    runtime.control,
    root,
    CLOCK,
  ).enable(
    {
      provider: "openai",
      model: "synthetic-reasoning-model",
      price_version: "synthetic-reasoning-price-v1",
      input_micro_usd_per_million: 10_000,
      output_micro_usd_per_million: 10_000,
      accepted_response_models: ["synthetic-reasoning-model"],
      max_output_tokens: 100,
      endpoint_class: "openai_responses",
      audit_id: audit.audit_id!,
      expected_version: 0,
    },
    ACK,
  );
  if (opts.decisionReady)
    writeDecisionReadiness(
      root,
      {
        schema: 1,
        worker_id: DECISION_WORKER,
        stage_scope: "decision",
        provider_family: decisionProfile.provider,
        endpoint_digest: decisionProfile.endpoint_digest,
        epoch: decisionProfile.epoch,
        root_nonce: decisionProfile.root_nonce,
        activation_fingerprint: decisionProfile.fingerprint,
        config_digest: decisionProfile.config_digest,
        model: decisionProfile.model,
        price_version: decisionProfile.price_version,
        booted_at: "2026-10-17T11:59:50.000Z",
        heartbeat_at: CLOCK().toISOString(),
        expires_at: "2026-10-17T12:00:15.000Z",
      },
      CLOCK,
    );
  if (opts.reasoningReady)
    writeWorkerReadiness(root, {
      schema: 1,
      worker_id: REASONING_WORKER,
      epoch: reasoningProfile.epoch,
      root_nonce: reasoningProfile.root_nonce,
      activation_fingerprint: reasoningProfile.fingerprint,
      config_digest: reasoningProfile.config_digest,
      provider: reasoningProfile.provider,
      model: reasoningProfile.model,
      price_version: reasoningProfile.price_version,
      endpoint_class: reasoningProfile.endpoint_class,
      booted_at: "2026-10-17T11:59:50.000Z",
      heartbeat_at: CLOCK().toISOString(),
      expires_at: "2026-10-17T12:00:15.000Z",
    });

  const app = await createApp(undefined, {
    managed: runtime,
    static: false,
    publicOrigin: ORIGIN,
    capability,
    decisionCapability: () => {
      const c = decisionCapability();
      return { available: c.available, reason: c.reason };
    },
  });
  const sessionA = runtime.control.issueSession(a.id);
  const sessionB = runtime.control.issueSession(b.id);
  const headersA = {
    host: HOST,
    cookie: `brain_session=${sessionA.token}`,
    "x-brain-csrf": sessionA.csrf,
  };
  const headersB = {
    host: HOST,
    cookie: `brain_session=${sessionB.token}`,
    "x-brain-csrf": sessionB.csrf,
  };
  const getA = (url: string) => app.inject({ url, headers: headersA });
  const getB = (url: string) => app.inject({ url, headers: headersB });
  const patchA = (payload: Record<string, unknown>) =>
    app.inject({
      method: "PATCH",
      url: "/api/v1/preferences/background",
      headers: headersA,
      payload,
    });
  const prefsA = async () =>
    (await getA("/api/v1/preferences/background")).json() as Record<
      string,
      unknown
    >;
  const spendA = async () =>
    ((await getA("/api/v1/today")).json() as any).status.spend;
  return {
    root,
    runtime,
    a,
    b,
    money,
    app,
    headersA,
    sessionA,
    getA,
    getB,
    patchA,
    prefsA,
    spendA,
    close() {
      return app.close().then(() => runtime.close());
    },
  };
}

it("defaults to no decision consent and exposes the separate status fields", async () => {
  const f = await fixture();
  try {
    expect(await f.prefsA()).toMatchObject({ decision_provider_enabled: false });
    const spend = await f.spendA();
    expect(spend).toMatchObject({
      decision_capability_ready: true,
      decision_stored_consent_active: false,
      decision_consent_effective: false,
    });
    // The reasoning capability fields are unchanged.
    expect(spend.capability_ready).toBe(true);
    expect(spend.stored_consent_active).toBe(false);
  } finally {
    await f.close();
  }
});

it("enables the separate decision consent with a real capability and withdraws it", async () => {
  const f = await fixture();
  try {
    const p = await f.prefsA();
    // Enabling the master reasoning consent is legitimate here (its worker is ready).
    expect(
      (await f.patchA({ ...p, provider_enabled: true })).statusCode,
    ).toBe(200);
    const enabled = await f.patchA({
      ...(await f.prefsA()),
      decision_provider_enabled: true,
    });
    expect(enabled.statusCode).toBe(200);
    expect(await f.prefsA()).toMatchObject({ decision_provider_enabled: true });
    expect(await f.spendA()).toMatchObject({
      decision_stored_consent_active: true,
      decision_consent_effective: true,
    });
    const withdrawn = await f.patchA({
      ...(await f.prefsA()),
      decision_provider_enabled: false,
    });
    expect(withdrawn.statusCode).toBe(200);
    expect(await f.prefsA()).toMatchObject({ decision_provider_enabled: false });
  } finally {
    await f.close();
  }
});

it("an unrelated cap update that omits the decision field preserves the raw choice", async () => {
  const f = await fixture();
  try {
    await f.patchA({ ...(await f.prefsA()), provider_enabled: true });
    await f.patchA({
      ...(await f.prefsA()),
      decision_provider_enabled: true,
    });
    const {
      provider_enabled: _master,
      decision_provider_enabled: _decision,
      ...rest
    } = await f.prefsA();
    const saved = await f.patchA({ ...rest, daily_cap_micro_usd: 17 });
    expect(saved.statusCode).toBe(200);
    expect(await f.prefsA()).toMatchObject({
      provider_enabled: true,
      decision_provider_enabled: true,
      daily_cap_micro_usd: 17,
    });
  } finally {
    await f.close();
  }
});

it("denies a malicious re-enable while unavailable and always allows a withdrawal", async () => {
  const f = await fixture();
  try {
    await f.patchA({ ...(await f.prefsA()), provider_enabled: true });
    await f.patchA({
      ...(await f.prefsA()),
      decision_provider_enabled: true,
    });
    // Lose the fresh decision worker lease.
    rmSync(decisionWorkerReadinessPath(f.root), { force: true });
    expect(await f.spendA()).toMatchObject({
      decision_capability_ready: false,
      decision_stored_consent_active: true,
    });
    const denied = await f.patchA({
      ...(await f.prefsA()),
      decision_provider_enabled: true,
    });
    expect(denied.statusCode).not.toBe(200);
    expect(await f.prefsA()).toMatchObject({ decision_provider_enabled: true });
    const withdrawn = await f.patchA({
      ...(await f.prefsA()),
      decision_provider_enabled: false,
    });
    expect(withdrawn.statusCode).toBe(200);
    expect(await f.prefsA()).toMatchObject({ decision_provider_enabled: false });
  } finally {
    await f.close();
  }
});

it("withdrawing the master keeps the raw decision choice and clears effective decision consent", async () => {
  const f = await fixture();
  try {
    await f.patchA({ ...(await f.prefsA()), provider_enabled: true });
    await f.patchA({
      ...(await f.prefsA()),
      decision_provider_enabled: true,
    });
    expect(await f.spendA()).toMatchObject({ decision_consent_effective: true });
    expect(
      (await f.patchA({ ...(await f.prefsA()), provider_enabled: false }))
        .statusCode,
    ).toBe(200);
    expect(await f.prefsA()).toMatchObject({
      provider_enabled: false,
      decision_provider_enabled: true,
    });
    expect(await f.spendA()).toMatchObject({
      decision_stored_consent_active: true,
      decision_consent_effective: false,
    });
  } finally {
    await f.close();
  }
});

it("keeps the raw decision choice with a lost decision worker and never leaks account data", async () => {
  const f = await fixture({ decisionReady: true, reasoningReady: true });
  try {
    await f.patchA({ ...(await f.prefsA()), provider_enabled: true });
    await f.patchA({
      ...(await f.prefsA()),
      decision_provider_enabled: true,
    });
    rmSync(decisionWorkerReadinessPath(f.root), { force: true });
    const spend = await f.spendA();
    expect(spend).toMatchObject({
      decision_stored_consent_active: true,
      decision_capability_ready: false,
    });
    const text = JSON.stringify(spend);
    expect(text).not.toContain(f.b.id);
    expect(text).not.toContain(DECISION_WORKER);
    expect(text).not.toContain("typesafe");
    expect(text).not.toContain("systemone");
    expect(text).not.toContain("api.");
  } finally {
    await f.close();
  }
});

it("keeps account A and account B decision consent isolated", async () => {
  const f = await fixture();
  try {
    await f.patchA({ ...(await f.prefsA()), provider_enabled: true });
    await f.patchA({
      ...(await f.prefsA()),
      decision_provider_enabled: true,
    });
    expect(await f.prefsA()).toMatchObject({ decision_provider_enabled: true });
    expect(
      (await f.getB("/api/v1/preferences/background")).json(),
    ).toMatchObject({ decision_provider_enabled: false });
    expect(
      ((await f.getB("/api/v1/today")).json() as any).status.spend,
    ).toMatchObject({
      decision_stored_consent_active: false,
      decision_consent_effective: false,
    });
  } finally {
    await f.close();
  }
});

it("requires the CSRF header for the decision preference write", async () => {
  const f = await fixture();
  try {
    const noCsrf = await f.app.inject({
      method: "PATCH",
      url: "/api/v1/preferences/background",
      headers: {
        host: HOST,
        cookie: `brain_session=${f.sessionA.token}`,
      },
      payload: { ...(await f.prefsA()), decision_provider_enabled: true },
    });
    expect(noCsrf.statusCode).toBe(403);
    expect(await f.prefsA()).toMatchObject({ decision_provider_enabled: false });
  } finally {
    await f.close();
  }
});

it("publishes decision deployment availability as config-only metadata", async () => {
  const f = await fixture();
  try {
    const runtime = await f.getA("/api/v1/runtime");
    const body = runtime.json() as any;
    expect(body).toMatchObject({
      decision_processing_available: true,
      decision_paid_reason: null,
    });
    const text = JSON.stringify(body);
    expect(text).not.toContain("typesafe");
    expect(text).not.toContain("systemone");
    expect(text).not.toContain("api.");
    expect(text).not.toContain(DECISION_WORKER);
    rmSync(decisionWorkerReadinessPath(f.root), { force: true });
    const unavailable = (await f.getA("/api/v1/runtime")).json() as any;
    expect(unavailable).toMatchObject({ decision_processing_available: false });
    expect(unavailable.decision_paid_reason).toMatch(
      /not available on this installation/,
    );
  } finally {
    await f.close();
  }
});

it("separates decision consent from monetary admission while a call awaits settlement", async () => {
  const f = await fixture();
  try {
    await f.patchA({ ...(await f.prefsA()), provider_enabled: true });
    await f.patchA({
      ...(await f.prefsA()),
      decision_provider_enabled: true,
    });
    // A committed dispatched central row makes paid admission `usage_pending`;
    // it must never clear the decision capability or the effective consent.
    const limits = {
      per_job_micro_usd: 10_000,
      user_daily_micro_usd: 100_000,
      time_zone: "UTC",
    };
    const rec = f.money.reserve({
      account_id: f.a.id,
      job_id: "synthetic-held",
      dispatch_key: "decision",
      stage: "decision",
      reserved_micro_usd: 1,
      provider: "synthetic",
      model: "synthetic",
      price_version: "synthetic-v1",
      request_hash: "a".repeat(64),
      config_hash: "b".repeat(64),
      limits,
    });
    f.money.mark(rec.call_id, limits);
    const spend = await f.spendA();
    expect(spend).toMatchObject({
      paused: true,
      paused_reason: "usage_pending",
      decision_capability_ready: true,
      decision_stored_consent_active: true,
      decision_consent_effective: true,
    });
    expect(
      ((await f.getA("/api/v1/runtime")).json() as any)
        .decision_processing_available,
    ).toBe(true);
  } finally {
    await f.close();
  }
});
