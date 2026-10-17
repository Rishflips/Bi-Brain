import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  DECISION_GUARD_JOB_KIND,
  DECISION_GUARD_PURPOSE,
  validateActivationGuard,
  type ActivationGuard,
  type DecisionActivationGuard,
  type ReasoningActivationGuard,
} from "../../packages/domain/managed-activation.ts";
import {
  assertDecisionSendGuardContext,
  expectedDecisionConfigHash,
  installDecisionPolicy,
  readDecisionActivationGuardContext,
} from "../../packages/runtime/managed-activation.ts";
import { ManagedRuntime, managedDecisionCapability } from "../../packages/runtime/managed.ts";
import { ManagedSpendingStore } from "../../packages/storage/managed-spending.ts";
import { ManagedDecisionActivationStore } from "../../packages/storage/managed-decision-activation.ts";
import { ManagedReconciliationStore } from "../../packages/storage/managed-reconciliation.ts";
import { auditManagedHistory } from "../../packages/runtime/managed-audit.ts";
import { paidProcessingBlockedSetting } from "../../packages/storage/spend.ts";
import {
  decisionWorkerReadinessPath,
  writeDecisionReadiness,
} from "../../packages/runtime/decision-worker-readiness.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const CLOCK = () => new Date("2026-10-17T12:00:00.000Z");
const ACK = { offline: true as const, workers_terminated: true as const };
const WORKER_ID = randomUUID();

function newRoot() {
  const base = mkdtempSync(join(tmpdir(), "bibrain-decision-stage-"));
  roots.push(base);
  return join(base, "managed");
}

function reasoningGuard(): ReasoningActivationGuard {
  return {
    phase: "before_reserve",
    account_id: randomUUID(),
    job_id: "reasoning-job",
    dispatch_key: "reasoning",
    stage: "reasoning",
    lease_owner: "synthetic-worker",
    lease_fence: 1,
    lease_expires_at: "2030-01-01T00:00:00.000Z",
    provider: "openai",
    model: "synthetic-openai-model",
    price_version: "synthetic-reasoning-price-v1",
    request_hash: "a".repeat(64),
    config_hash: "b".repeat(64),
    reserved_micro_usd: 1,
    profile_version: 1,
    fingerprint: "c".repeat(64),
    config_digest: "d".repeat(64),
    epoch: 1,
    root_nonce: "e".repeat(64),
    schema_version: 1,
    schema_digest: "f".repeat(64),
    audit_id: randomUUID(),
    audit_digest: "1".repeat(64),
    expected_prepared_config_hash: "b".repeat(64),
    central_inventory_digest: "2".repeat(64),
    central_call_id: null,
    tenant_call_id: null,
  };
}

function decisionGuardShape(): DecisionActivationGuard {
  return {
    ...reasoningGuard(),
    stage: "decision",
    provider: "typesafe",
    purpose: DECISION_GUARD_PURPOSE,
    job_kind: DECISION_GUARD_JOB_KIND,
  };
}

const LIMITS = {
  per_job_micro_usd: 10_000,
  user_daily_micro_usd: 100_000,
  time_zone: "UTC",
};

function decisionFixture() {
  const root = newRoot();
  const runtime = new ManagedRuntime(root, { clock: CLOCK });
  const account = runtime.provision("https://issuer.synthetic.test", "decision-stage");
  const money = new ManagedSpendingStore(runtime.control, CLOCK);
  money.setServicePolicy({ daily_micro_usd: 100_000 });
  money.setAccountPolicy({
    account_id: account.id,
    per_job_micro_usd: 10_000,
    user_daily_micro_usd: 100_000,
  });
  money.configureAccountPeriod({
    account_id: account.id,
    starts_at: "2026-10-17T00:00:00Z",
    ends_at: "2026-10-18T00:00:00Z",
    allowance_micro_usd: 1_000_000,
  });
  new ManagedReconciliationStore(runtime.control, root, CLOCK).initEpoch(ACK);
  const audit = auditManagedHistory({ runtime, root, ...ACK, clock: CLOCK });
  if (!audit.ok) throw new Error(`audit failed: ${audit.reason}`);
  const store = new ManagedDecisionActivationStore(runtime.control, root, CLOCK);
  const profile = store.enable(
    {
      provider: "typesafe",
      model: "jev-synthetic-v1",
      accepted_response_models: ["jev-synthetic-return-v2", "jev-synthetic-v1"],
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
  writeDecisionReadiness(
    root,
    {
      schema: 1,
      worker_id: WORKER_ID,
      stage_scope: "decision",
      provider_family: profile.provider,
      endpoint_digest: profile.endpoint_digest,
      epoch: profile.epoch,
      root_nonce: profile.root_nonce,
      activation_fingerprint: profile.fingerprint,
      config_digest: profile.config_digest,
      model: profile.model,
      price_version: profile.price_version,
      booted_at: "2026-10-17T11:59:55.000Z",
      heartbeat_at: "2026-10-17T11:59:59.000Z",
      expires_at: "2026-10-17T12:00:10.000Z",
    },
    CLOCK,
  );
  const installed = installDecisionPolicy({
    root,
    profile,
    worker_id: WORKER_ID,
    optIn: true,
  });
  const control = { db: runtime.control.db, path: runtime.control.path };
  const jobId = "synthetic-decision-job";
  const spec = {
    account_id: account.id,
    job_id: jobId,
    dispatch_key: "decision",
    stage: "decision" as const,
    reserved_micro_usd: 7,
    provider: profile.provider,
    model: profile.model,
    price_version: profile.price_version,
    request_hash: "a".repeat(64),
    config_hash: expectedDecisionConfigHash(profile),
    limits: LIMITS,
  };
  const lease = {
    job_id: jobId,
    owner: "synthetic-worker",
    fence: 1,
    expires_at: "2030-01-01T00:00:00.000Z",
  };
  const base = {
    control,
    installed,
    accountId: account.id,
    jobId,
    dispatchKey: "decision",
    stage: "decision" as const,
    lease,
    now: CLOCK(),
    spec: {
      provider: spec.provider,
      model: spec.model,
      price_version: spec.price_version,
      request_hash: spec.request_hash,
      config_hash: spec.config_hash,
      reserved_micro_usd: spec.reserved_micro_usd,
    },
  };
  return { root, runtime, account, money, store, profile, installed, control, spec, lease, base, jobId };
}

/* ---------------------------------------------------------------- domain */

it("a valid reasoning guard keeps the closed openai reasoning literal", () => {
  const guard = reasoningGuard();
  expect(validateActivationGuard(guard)).toMatchObject({ stage: "reasoning", provider: "openai" });
});

it("a valid decision guard keeps the closed stage, provider, purpose and job kind", () => {
  const guard = decisionGuardShape();
  expect(validateActivationGuard(guard)).toEqual(guard);
  expect(validateActivationGuard(guard)).toMatchObject({
    stage: "decision",
    provider: "typesafe",
    purpose: "goal_relevance",
    job_kind: "review_changed_assumption",
  });
});

it("the guard union is strictly discriminated: repair, an unknown provider and a reasoning-shaped decision guard deny", () => {
  const decision = decisionGuardShape();
  for (const change of [
    { ...decision, stage: "repair" },
    { ...decision, provider: "openai" },
    { ...decision, provider: "synthetic-other" },
    { ...decision, purpose: "other_purpose" },
    { ...decision, job_kind: "other_job" },
    { ...decision, unexpected: true },
  ])
    expect(() => validateActivationGuard(change)).toThrow();
  // A reasoning guard cannot be relabelled into a decision guard.
  expect(() => validateActivationGuard({ ...reasoningGuard(), stage: "decision" })).toThrow();
});

/* ------------------------------------------------- runtime guard context */

it("derives a concrete decision guard through the runtime helper with the shared expected hash, never the config_digest", () => {
  const f = decisionFixture();
  try {
    const guard = readDecisionActivationGuardContext({
      ...f.base,
      phase: "before_reserve",
      centralCallId: null,
      tenantCallId: null,
    });
    const expected = expectedDecisionConfigHash(f.profile);
    expect(guard.stage).toBe("decision");
    expect(guard.purpose).toBe("goal_relevance");
    expect(guard.job_kind).toBe("review_changed_assumption");
    expect(guard.expected_prepared_config_hash).toBe(expected);
    expect(guard.config_hash).toBe(expected);
    expect(guard.config_digest).toBe(f.profile.config_digest);
    expect(guard.config_digest).not.toBe(expected);
    expect(guard.fingerprint).toBe(f.profile.fingerprint);
    expect(guard.epoch).toBe(f.profile.epoch);
    expect(guard.lease_owner).toBe(f.lease.owner);
  } finally {
    f.runtime.close();
  }
});

it("denies absent, stale and foreign decision readiness", () => {
  const f = decisionFixture();
  try {
    const phase = { phase: "before_reserve" as const, centralCallId: null, tenantCallId: null };
    rmSync(decisionWorkerReadinessPath(f.root), { force: true });
    expect(() => readDecisionActivationGuardContext({ ...f.base, ...phase })).toThrow();
    // A stale (far-past) lease is not ready.
    writeDecisionReadiness(
      f.root,
      {
        schema: 1,
        worker_id: WORKER_ID,
        stage_scope: "decision",
        provider_family: f.profile.provider,
        endpoint_digest: f.profile.endpoint_digest,
        epoch: f.profile.epoch,
        root_nonce: f.profile.root_nonce,
        activation_fingerprint: f.profile.fingerprint,
        config_digest: f.profile.config_digest,
        model: f.profile.model,
        price_version: f.profile.price_version,
        booted_at: "2026-10-17T11:00:00.000Z",
        heartbeat_at: "2026-10-17T11:00:05.000Z",
        expires_at: "2026-10-17T11:00:20.000Z",
      },
      CLOCK,
    );
    expect(() => readDecisionActivationGuardContext({ ...f.base, ...phase })).toThrow();
    // A ready lease for a DIFFERENT worker cannot authorize this installed worker.
    writeDecisionReadiness(
      f.root,
      {
        schema: 1,
        worker_id: randomUUID(),
        stage_scope: "decision",
        provider_family: f.profile.provider,
        endpoint_digest: f.profile.endpoint_digest,
        epoch: f.profile.epoch,
        root_nonce: f.profile.root_nonce,
        activation_fingerprint: f.profile.fingerprint,
        config_digest: f.profile.config_digest,
        model: f.profile.model,
        price_version: f.profile.price_version,
        booted_at: "2026-10-17T11:59:55.000Z",
        heartbeat_at: "2026-10-17T11:59:59.000Z",
        expires_at: "2026-10-17T12:00:10.000Z",
      },
      CLOCK,
    );
    expect(() => readDecisionActivationGuardContext({ ...f.base, ...phase })).toThrow();
  } finally {
    f.runtime.close();
  }
});

it("samples the trusted decision-readiness clock after the snapshot, never as a false future heartbeat", () => {
  const f = decisionFixture();
  try {
    const phase = { phase: "before_reserve" as const, centralCallId: null, tenantCallId: null };
    const base = Date.parse("2026-10-17T12:00:00.000Z");
    // The independent decision worker refreshes its lease AFTER the caller sampled
    // its eager wall clock but BEFORE the guard reads readiness.
    writeDecisionReadiness(
      f.root,
      {
        schema: 1, worker_id: WORKER_ID, stage_scope: "decision",
        provider_family: f.profile.provider, endpoint_digest: f.profile.endpoint_digest,
        epoch: f.profile.epoch, root_nonce: f.profile.root_nonce,
        activation_fingerprint: f.profile.fingerprint, config_digest: f.profile.config_digest,
        model: f.profile.model, price_version: f.profile.price_version,
        booted_at: new Date(base).toISOString(), heartbeat_at: new Date(base + 50).toISOString(), expires_at: new Date(base + 15_050).toISOString(),
      },
      CLOCK,
    );
    // Production supplies the trusted clock: sampled at the readiness read, so the
    // fresh lease derives a guard. The fixed instant keeps the strict rule and denies.
    const guard = readDecisionActivationGuardContext({ ...f.base, clock: () => new Date(base + 50), ...phase });
    expect(guard.stage).toBe("decision");
    expect(() => readDecisionActivationGuardContext({ ...f.base, ...phase })).toThrow();
  } finally {
    f.runtime.close();
  }
});

it("denies opt-out, wrong-phase call ids and an expired lease", () => {
  const f = decisionFixture();
  try {
    const optedOut = installDecisionPolicy({
      root: f.root,
      profile: f.profile,
      worker_id: WORKER_ID,
      optIn: false,
    });
    expect(() =>
      readDecisionActivationGuardContext({
        ...f.base,
        installed: optedOut,
        phase: "before_reserve",
        centralCallId: null,
        tenantCallId: null,
      }),
    ).toThrow();
    // A reservation guard must carry null call ids.
    expect(() =>
      readDecisionActivationGuardContext({
        ...f.base,
        phase: "before_reserve",
        centralCallId: randomUUID(),
        tenantCallId: randomUUID(),
      }),
    ).toThrow();
    // A mark guard requires both exact ids.
    expect(() =>
      readDecisionActivationGuardContext({
        ...f.base,
        phase: "before_mark",
        centralCallId: null,
        tenantCallId: randomUUID(),
      }),
    ).toThrow();
    // An expired lease cannot authorize.
    expect(() =>
      readDecisionActivationGuardContext({
        ...f.base,
        lease: { ...f.lease, expires_at: "2026-10-17T11:00:00.000Z" },
        phase: "before_reserve",
        centralCallId: null,
        tenantCallId: null,
      }),
    ).toThrow();
  } finally {
    f.runtime.close();
  }
});

it("denies a substituted provider/model/price or a config hash that is not the decision expected hash", () => {
  const f = decisionFixture();
  try {
    const phase = { phase: "before_reserve" as const, centralCallId: null, tenantCallId: null };
    for (const change of [
      { provider: "cloudflare" },
      { model: "synthetic-other-model" },
      { price_version: "synthetic-other-price" },
      { config_hash: f.profile.config_digest },
      { config_hash: "0".repeat(64) },
    ])
      expect(() =>
        readDecisionActivationGuardContext({ ...f.base, spec: { ...f.base.spec, ...change }, ...phase }),
      ).toThrow();
  } finally {
    f.runtime.close();
  }
});

it("requires the live decision profile to still match the frozen installed policy", () => {
  const f = decisionFixture();
  try {
    const phase = { phase: "before_reserve" as const, centralCallId: null, tenantCallId: null };
    readDecisionActivationGuardContext({ ...f.base, ...phase });
    f.store.disable(f.profile.version);
    expect(() => readDecisionActivationGuardContext({ ...f.base, ...phase })).toThrow();
  } finally {
    f.runtime.close();
  }
});

it("installDecisionPolicy freezes a deep defensive copy of the profile and accepted array", () => {
  const f = decisionFixture();
  try {
    const installed = installDecisionPolicy({
      root: f.root,
      profile: f.profile,
      worker_id: WORKER_ID,
      optIn: true,
    });
    expect(Object.isFrozen(installed)).toBe(true);
    expect(Object.isFrozen(installed.profile)).toBe(true);
    expect(Object.isFrozen(installed.profile.accepted_response_models)).toBe(true);
    const snapshot = JSON.stringify(f.profile);
    (f.profile.accepted_response_models as string[]).push("synthetic-injected-model");
    expect(JSON.stringify(installed.profile)).toBe(snapshot);
  } finally {
    f.runtime.close();
  }
});

/* ------------------------------------------------------- storage seam */

function insertTenantDecisionRow(
  f: ReturnType<typeof decisionFixture>,
  callId: string,
  state: "reserved" | "dispatched",
): void {
  const handle = f.runtime.acquire(f.account.id);
  try {
    handle.brain.store.run(
      `INSERT OR IGNORE INTO jobs(
         id,project_id,kind,payload,status,attempts,max_attempts,next_at,created_at)
       VALUES(?,?,?,?,?,?,?,?,?)`,
      f.jobId,
      "inbox",
      "review_changed_assumption",
      "{}",
      "running",
      1,
      3,
      CLOCK().toISOString(),
      CLOCK().toISOString(),
    );
    handle.brain.store.run(
      `INSERT INTO provider_dispatches(
         call_id,job_id,dispatch_key,stage,state,reserved_micro_usd,actual_micro_usd,
         provider,model,price_version,request_hash,config_hash,identity_hash,
         budget_day,time_zone,created_at,dispatched_at,settled_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      callId,
      f.jobId,
      "decision",
      "decision",
      state,
      f.spec.reserved_micro_usd,
      null,
      f.profile.provider,
      f.profile.model,
      f.profile.price_version,
      f.spec.request_hash,
      f.spec.config_hash,
      "9".repeat(64),
      "2026-10-17",
      "UTC",
      CLOCK().toISOString(),
      state === "dispatched" ? CLOCK().toISOString() : null,
      null,
    );
  } finally {
    handle.release();
  }
}

it("reserves and marks the decision stage through the closed guard with a real central slot", () => {
  const f = decisionFixture();
  try {
    const reserveGuard = readDecisionActivationGuardContext({
      ...f.base,
      phase: "before_reserve",
      centralCallId: null,
      tenantCallId: null,
    });
    const rec = f.money.reserve(f.spec, reserveGuard);
    expect(rec).toMatchObject({ state: "reserved", stage: "decision" });
    expect(f.money.latestForJob(f.account.id, f.jobId)!.call_id).toBe(rec.call_id);
    // The exact tenant projection is linked, then the decision slot is marked.
    const tenantCallId = randomUUID();
    insertTenantDecisionRow(f, tenantCallId, "reserved");
    f.money.linkProjection(rec.call_id, tenantCallId);
    const markGuard = readDecisionActivationGuardContext({
      ...f.base,
      phase: "before_mark",
      centralCallId: rec.call_id,
      tenantCallId,
    });
    const marked = f.money.mark(rec.call_id, LIMITS, markGuard);
    expect(marked).toMatchObject({ state: "dispatched", stage: "decision" });
  } finally {
    f.runtime.close();
  }
});

it("the decision seam independently rejects a substituted configuration even when both guard hash fields agree", () => {
  const f = decisionFixture();
  try {
    const guard = readDecisionActivationGuardContext({
      ...f.base,
      phase: "before_reserve",
      centralCallId: null,
      tenantCallId: null,
    });
    const substituted = "f".repeat(64);
    expect(substituted).not.toBe(guard.expected_prepared_config_hash);
    expect(() =>
      f.money.reserve(
        { ...f.spec, config_hash: substituted },
        { ...guard, config_hash: substituted, expected_prepared_config_hash: substituted },
      ),
    ).toThrow();
    expect(f.money.latestForJob(f.account.id, f.jobId)).toBeUndefined();
  } finally {
    f.runtime.close();
  }
});

it("a reasoning guard cannot reserve a decision spec and a decision guard cannot reserve a reasoning spec", () => {
  const f = decisionFixture();
  try {
    const decisionGuard = readDecisionActivationGuardContext({
      ...f.base,
      phase: "before_reserve",
      centralCallId: null,
      tenantCallId: null,
    });
    expect(() => f.money.reserve(f.spec, reasoningGuard() as ActivationGuard)).toThrow();
    const reasoningSpec = {
      ...f.spec,
      dispatch_key: "reasoning",
      stage: "reasoning" as const,
      config_hash: "b".repeat(64),
    };
    expect(() => f.money.reserve(reasoningSpec, decisionGuard)).toThrow();
    expect(f.money.latestForJob(f.account.id, f.jobId)).toBeUndefined();
  } finally {
    f.runtime.close();
  }
});

it("a coincident config_digest or a forged wrong-phase attempt id is denied by the seam", () => {
  const f = decisionFixture();
  try {
    const guard = readDecisionActivationGuardContext({
      ...f.base,
      phase: "before_reserve",
      centralCallId: null,
      tenantCallId: null,
    });
    // The domain config_digest is never the prepared config_hash.
    expect(() =>
      f.money.reserve({ ...f.spec, config_hash: f.profile.config_digest }, guard),
    ).toThrow();
    // A before_mark guard carrying a forged reserved-id pair cannot reserve.
    const forged: ActivationGuard = {
      ...guard,
      phase: "before_mark",
      central_call_id: randomUUID(),
      tenant_call_id: randomUUID(),
    };
    expect(() => f.money.reserve(f.spec, forged)).toThrow();
    expect(f.money.latestForJob(f.account.id, f.jobId)).toBeUndefined();
  } finally {
    f.runtime.close();
  }
});

it("the in-transaction decision seam denies once the live profile changes after the preflight", () => {
  const f = decisionFixture();
  try {
    const guard = readDecisionActivationGuardContext({
      ...f.base,
      phase: "before_reserve",
      centralCallId: null,
      tenantCallId: null,
    });
    f.money.setAccountPolicy({
      account_id: f.account.id,
      per_job_micro_usd: 999,
      user_daily_micro_usd: 999,
    });
    expect(() => f.money.reserve(f.spec, guard)).toThrow();
    expect(f.money.latestForJob(f.account.id, f.jobId)).toBeUndefined();
  } finally {
    f.runtime.close();
  }
});

it("assertDecisionSendGuardContext rechecks the live central state and rejects a reasoning guard", () => {
  const f = decisionFixture();
  try {
    const guard = readDecisionActivationGuardContext({
      ...f.base,
      phase: "before_reserve",
      centralCallId: null,
      tenantCallId: null,
    });
    expect(() => assertDecisionSendGuardContext(guard, f.root, f.control)).not.toThrow();
    expect(() =>
      assertDecisionSendGuardContext(reasoningGuard() as ActivationGuard, f.root, f.control),
    ).toThrow();
    f.store.disable(f.profile.version);
    expect(() => assertDecisionSendGuardContext(guard, f.root, f.control)).toThrow();
  } finally {
    f.runtime.close();
  }
});

/* ------------------------------------------------------------ consent */

function consentFixture(decisionReady = false) {
  const root = newRoot();
  const runtime = new ManagedRuntime(root, {
    clock: CLOCK,
    decisionCapability: () => {
      const c = managedDecisionCapability({
        control: runtime.control,
        root,
        now: CLOCK(),
        optIn: true,
      });
      return { ready: c.available, reason: c.reason };
    },
  });
  const account = runtime.provision("https://issuer.synthetic.test", "decision-consent");
  const money = new ManagedSpendingStore(runtime.control, CLOCK);
  money.setServicePolicy({ daily_micro_usd: 100_000 });
  money.setAccountPolicy({
    account_id: account.id,
    per_job_micro_usd: 10_000,
    user_daily_micro_usd: 100_000,
  });
  money.configureAccountPeriod({
    account_id: account.id,
    starts_at: "2026-10-17T00:00:00Z",
    ends_at: "2026-10-18T00:00:00Z",
    allowance_micro_usd: 1_000_000,
  });
  new ManagedReconciliationStore(runtime.control, root, CLOCK).initEpoch(ACK);
  const audit = auditManagedHistory({ runtime, root, ...ACK, clock: CLOCK });
  if (!audit.ok) throw new Error(`audit failed: ${audit.reason}`);
  if (decisionReady) {
    const profile = new ManagedDecisionActivationStore(runtime.control, root, CLOCK).enable(
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
    writeDecisionReadiness(
      root,
      {
        schema: 1,
        worker_id: WORKER_ID,
        stage_scope: "decision",
        provider_family: profile.provider,
        endpoint_digest: profile.endpoint_digest,
        epoch: profile.epoch,
        root_nonce: profile.root_nonce,
        activation_fingerprint: profile.fingerprint,
        config_digest: profile.config_digest,
        model: profile.model,
        price_version: profile.price_version,
        booted_at: "2026-10-17T11:59:55.000Z",
        heartbeat_at: "2026-10-17T11:59:59.000Z",
        expires_at: "2026-10-17T12:00:10.000Z",
      },
      CLOCK,
    );
  }
  const handle = runtime.acquire(account.id);
  const brain = handle.brain;
  const owner = brain.ownerPrincipal();
  return {
    root,
    runtime,
    handle,
    brain,
    owner,
    close() {
      handle.release();
      runtime.close();
    },
  };
}

it("decision consent defaults false and an explicit true without a real capability is refused", () => {
  const f = consentFixture(false);
  try {
    const p = f.brain.prefs(f.owner);
    expect(p).toMatchObject({ decision_provider_enabled: false });
    expect(() => f.brain.prefs(f.owner, { ...p, decision_provider_enabled: true })).toThrow();
    expect(f.brain.prefs(f.owner)).toMatchObject({ decision_provider_enabled: false });
    expect(f.brain.decisionBackgroundConsent(f.owner)).toBe(false);
  } finally {
    f.close();
  }
});

it("an unrelated save preserves both raw consent choices, and a raw decision true stays withdrawable", () => {
  const f = consentFixture(false);
  try {
    const p = f.brain.prefs(f.owner);
    f.brain.store.set("preferences", {
      ...p,
      provider_enabled: true,
      decision_provider_enabled: true,
    });
    const {
      provider_enabled: _master,
      decision_provider_enabled: _decision,
      ...rest
    } = f.brain.store.setting<Record<string, unknown>>("preferences", {});
    f.brain.prefs(f.owner, { ...rest, daily_cap_micro_usd: 17 });
    expect(f.brain.store.setting("preferences", {})).toMatchObject({
      provider_enabled: true,
      decision_provider_enabled: true,
      daily_cap_micro_usd: 17,
    });
    // Withdrawing the raw decision flag is always possible while unavailable.
    f.brain.prefs(f.owner, { ...rest, decision_provider_enabled: false });
    expect(f.brain.store.setting("preferences", {})).toMatchObject({
      provider_enabled: true,
      decision_provider_enabled: false,
    });
  } finally {
    f.close();
  }
});

it("withdrawing master never silently clears the separate raw decision choice", () => {
  const f = consentFixture(false);
  try {
    const p = f.brain.prefs(f.owner);
    f.brain.store.set("preferences", {
      ...p,
      provider_enabled: true,
      decision_provider_enabled: true,
    });
    const { decision_provider_enabled: _decision, ...rest } = f.brain.store.setting<
      Record<string, unknown>
    >("preferences", {});
    f.brain.prefs(f.owner, { ...rest, provider_enabled: false });
    expect(f.brain.store.setting("preferences", {})).toMatchObject({
      provider_enabled: false,
      decision_provider_enabled: true,
    });
    expect(f.brain.decisionBackgroundConsent(f.owner)).toBe(true);
    expect(f.brain.backgroundConsent(f.owner)).toBe(false);
  } finally {
    f.close();
  }
});

it("an explicit decision true is admitted only with an actual trusted capability (real profile + fresh readiness)", () => {
  const f = consentFixture(true);
  try {
    const p = f.brain.prefs(f.owner);
    const saved = f.brain.prefs(f.owner, { ...p, decision_provider_enabled: true });
    expect(saved).toMatchObject({ decision_provider_enabled: true });
    expect(f.brain.decisionBackgroundConsent(f.owner)).toBe(true);
    // A stale readiness lease withdraws the capability and refuses a NEW true.
    f.brain.prefs(f.owner, { ...f.brain.store.setting<Record<string, unknown>>("preferences", {}), decision_provider_enabled: false });
    rmSync(decisionWorkerReadinessPath(f.root), { force: true });
    expect(() =>
      f.brain.prefs(f.owner, {
        ...f.brain.store.setting<Record<string, unknown>>("preferences", {}),
        decision_provider_enabled: true,
      }),
    ).toThrow();
  } finally {
    f.close();
  }
});

it("an explicit decision true is refused under a durable monetary block even with a ready capability", () => {
  const f = consentFixture(true);
  try {
    const p = f.brain.prefs(f.owner);
    f.brain.store.set(paidProcessingBlockedSetting, { reason: "restored_backup" });
    expect(() => f.brain.prefs(f.owner, { ...p, decision_provider_enabled: true })).toThrow();
    expect(f.brain.decisionBackgroundConsent(f.owner)).toBe(false);
  } finally {
    f.close();
  }
});

it("an optional undefined decision-consent field is omission, not an implicit withdrawal", () => {
  const f = consentFixture(false);
  try {
    const p = f.brain.prefs(f.owner);
    f.brain.store.set("preferences", {
      ...p,
      provider_enabled: true,
      decision_provider_enabled: true,
    });
    const {
      provider_enabled: _master,
      decision_provider_enabled: _decision,
      ...rest
    } = f.brain.store.setting<Record<string, unknown>>("preferences", {});
    f.brain.prefs(f.owner, { ...rest, decision_provider_enabled: undefined });
    expect(f.brain.store.setting("preferences", {})).toMatchObject({
      provider_enabled: true,
      decision_provider_enabled: true,
    });
  } finally {
    f.close();
  }
});
