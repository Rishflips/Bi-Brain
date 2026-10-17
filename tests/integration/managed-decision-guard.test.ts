import { afterEach, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ManagedRuntime } from "../../packages/runtime/managed.ts";
import { ManagedSpendingStore } from "../../packages/storage/managed-spending.ts";
import {
  ManagedDecisionActivationStore,
  decisionActivationMirrorPath,
} from "../../packages/storage/managed-decision-activation.ts";
import { ManagedReconciliationStore } from "../../packages/storage/managed-reconciliation.ts";
import { auditManagedHistory } from "../../packages/runtime/managed-audit.ts";
import {
  decisionPreparedConfigHash,
} from "../../packages/providers/prepared-decision.ts";
import {
  SYSTEM_ONE_POLICY_VERSION,
} from "../../packages/providers/system-one.ts";
import {
  DECISION_POLICY_VERSION,
} from "../../packages/domain/managed-decision-activation.ts";
import {
  decisionServerCapability,
  evaluateConfiguredDecisionPolicy,
  expectedDecisionConfigHash,
  readDecisionActivation,
} from "../../packages/runtime/managed-activation.ts";
import {
  decisionWorkerReadinessPath,
  readDecisionReadiness,
  removeDecisionReadiness,
  writeDecisionReadiness,
} from "../../packages/runtime/decision-worker-readiness.ts";
import { workerReadinessPath } from "../../packages/runtime/worker-readiness.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function newRoot() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bibrain-decision-guard-")));
  roots.push(root);
  return root;
}

const CLOCK = () => new Date("2026-10-17T12:00:00.000Z");

function readinessRecord(over: Record<string, unknown> = {}) {
  return {
    schema: 1,
    worker_id: randomUUID(),
    stage_scope: "decision",
    provider_family: "typesafe",
    endpoint_digest: "a".repeat(64),
    epoch: 1,
    root_nonce: "b".repeat(64),
    activation_fingerprint: "c".repeat(64),
    config_digest: "d".repeat(64),
    model: "jev-synthetic-v1",
    price_version: "synthetic-decision-price-v1",
    booted_at: "2026-10-17T11:59:55.000Z",
    heartbeat_at: "2026-10-17T11:59:59.000Z",
    expires_at: "2026-10-17T12:00:10.000Z",
    ...over,
  };
}

it("the pure decision config hash binds provider, endpoint, model, ordered accepted array, rates and policy", () => {
  const base = {
    provider: "typesafe" as const,
    model: "jev-synthetic-v1",
    accepted: ["jev-synthetic-return-v2", "jev-synthetic-v1"],
    price: { version: "synthetic-decision-price-v1", input_micro_usd_per_million: 1000, output_micro_usd_per_million: 0 },
    endpoint: "https://api.typesafe.ai/v1/systemone",
    timeout_ms: 1000,
    max_request_bytes: 1_048_576,
    max_response_bytes: 262_144,
    request_overhead_bytes: 1024,
  };
  const h = decisionPreparedConfigHash(base);
  expect(h).toMatch(/^[0-9a-f]{64}$/);
  // Accepted order is part of the identity; a permutation changes the hash.
  expect(
    decisionPreparedConfigHash({ ...base, accepted: [...base.accepted].reverse() }),
  ).not.toBe(h);
  expect(decisionPreparedConfigHash({ ...base, model: "other" })).not.toBe(h);
  expect(decisionPreparedConfigHash({ ...base, endpoint: "https://api.typesafe.ai/v1/other" })).not.toBe(h);
});

it("expectedDecisionConfigHash reuses the shared helper and the decision policy version matches the transport", () => {
  expect(DECISION_POLICY_VERSION).toBe(SYSTEM_ONE_POLICY_VERSION);
  const profile = {
    provider: "typesafe" as const,
    model: "jev-synthetic-v1",
    accepted_response_models: ["jev-synthetic-return-v2", "jev-synthetic-v1"],
    endpoint: "https://api.typesafe.ai/v1/systemone",
    price_version: "synthetic-decision-price-v1",
    input_micro_usd_per_million: 1000,
    output_micro_usd_per_million: 0,
    timeout_ms: 1000,
    max_request_bytes: 1_048_576,
    max_response_bytes: 262_144,
    request_overhead_bytes: 1024,
  } as never as Parameters<typeof expectedDecisionConfigHash>[0];
  expect(expectedDecisionConfigHash(profile as never)).toBe(
    decisionPreparedConfigHash({
      provider: profile.provider,
      model: profile.model,
      accepted: [...profile.accepted_response_models],
      price: {
        version: profile.price_version,
        input_micro_usd_per_million: profile.input_micro_usd_per_million,
        output_micro_usd_per_million: profile.output_micro_usd_per_million,
      },
      endpoint: profile.endpoint,
      timeout_ms: profile.timeout_ms,
      max_request_bytes: profile.max_request_bytes,
      max_response_bytes: profile.max_response_bytes,
      request_overhead_bytes: profile.request_overhead_bytes,
    }),
  );
});

it("decision readiness is absent in S1, uses only decision-worker-ready.json and never the reasoning lease", () => {
  const root = newRoot();
  const runtime = new ManagedRuntime(root);
  try {
    expect(readDecisionReadiness(root, CLOCK()).state).toBe("absent");
    // A reasoning lease must never be read as a decision lease.
    const reasoning = {
      schema: 1,
      worker_id: randomUUID(),
      epoch: 1,
      root_nonce: "b".repeat(64),
      activation_fingerprint: "c".repeat(64),
      config_digest: "d".repeat(64),
      provider: "openai",
      model: "m",
      price_version: "p",
      endpoint_class: "openai_responses",
      booted_at: "2026-10-17T11:59:55.000Z",
      heartbeat_at: "2026-10-17T11:59:59.000Z",
      expires_at: "2026-10-17T12:00:10.000Z",
    };
    writeFileSync(workerReadinessPath(root), JSON.stringify(reasoning));
    expect(readDecisionReadiness(root, CLOCK()).state).toBe("absent");
    expect(decisionWorkerReadinessPath(root)).not.toBe(workerReadinessPath(root));
  } finally {
    runtime.close();
  }
});

it("a self-written decision lease is ready, stale when expired, and only its own worker can remove it", () => {
  const root = newRoot();
  const runtime = new ManagedRuntime(root);
  try {
    const record = readinessRecord();
    writeDecisionReadiness(root, record, CLOCK);
    expect(readDecisionReadiness(root, CLOCK())).toMatchObject({
      state: "ready",
      readiness: { worker_id: record.worker_id, stage_scope: "decision" },
    });
    // Another worker id cannot delete it.
    removeDecisionReadiness(root, randomUUID());
    expect(readDecisionReadiness(root, CLOCK()).state).toBe("ready");
    removeDecisionReadiness(root, record.worker_id);
    expect(readDecisionReadiness(root, CLOCK()).state).toBe("absent");
    // A far-past lease is stale, never ready.
    writeDecisionReadiness(
      root,
      readinessRecord({ booted_at: "2026-10-17T11:00:00.000Z", heartbeat_at: "2026-10-17T11:00:05.000Z", expires_at: "2026-10-17T11:00:20.000Z" }),
      CLOCK,
    );
    expect(readDecisionReadiness(root, CLOCK()).state).toBe("stale");
  } finally {
    runtime.close();
  }
});

it("a malformed or linked decision lease is stale/absent, never ready", () => {
  const root = newRoot();
  const runtime = new ManagedRuntime(root);
  try {
    writeFileSync(decisionWorkerReadinessPath(root), "{not json");
    expect(readDecisionReadiness(root, CLOCK()).state).toBe("stale");
    writeFileSync(decisionWorkerReadinessPath(root), JSON.stringify({ schema: 2 }));
    expect(readDecisionReadiness(root, CLOCK()).state).toBe("stale");
  } finally {
    runtime.close();
  }
});

it("decisionServerCapability denies absent/stale/mismatched workers and only a matching lease is ready", () => {
  const configured = { ready: true, reason: "ready" as const };
  expect(
    decisionServerCapability({ configured, readiness: { state: "absent" } }),
  ).toEqual({ ready: false, reason: "worker_absent" });
  expect(
    decisionServerCapability({ configured, readiness: { state: "stale" } }),
  ).toEqual({ ready: false, reason: "worker_stale" });
  // A ready lease whose fields do not match the installed profile is refused.
  expect(
    decisionServerCapability({
      configured,
      readiness: { state: "ready", readiness: readinessRecord() as never },
      profile: undefined,
    }),
  ).toMatchObject({ ready: false });
});

it("the decision decision profile is absent by default and configured policy is off", () => {
  const root = newRoot();
  const runtime = new ManagedRuntime(root);
  try {
    const control = { db: runtime.control.db, path: runtime.control.path };
    expect(readDecisionActivation(control, root)).toBeUndefined();
    expect(
      evaluateConfiguredDecisionPolicy({ control, root, now: CLOCK(), optIn: true }),
    ).toEqual({ ready: false, reason: "off" });
  } finally {
    runtime.close();
  }
});

const ACK = { offline: true as const, workers_terminated: true as const };
function decisionFixture() {
  const root = newRoot();
  const runtime = new ManagedRuntime(root);
  const account = runtime.provision("https://issuer.synthetic.test", "decision-guard");
  const money = new ManagedSpendingStore(runtime.control);
  money.setServicePolicy({ daily_micro_usd: 100_000 });
  money.setAccountPolicy({ account_id: account.id, per_job_micro_usd: 10_000, user_daily_micro_usd: 100_000 });
  money.configureAccountPeriod({
    account_id: account.id,
    starts_at: "2026-01-01T00:00:00Z",
    ends_at: "2030-01-01T00:00:00Z",
    allowance_micro_usd: 1_000_000,
  });
  new ManagedReconciliationStore(runtime.control, root).initEpoch(ACK);
  const audit = auditManagedHistory({ runtime, root, ...ACK });
  const control = { db: runtime.control.db, path: runtime.control.path };
  const store = new ManagedDecisionActivationStore(runtime.control, root);
  const operator = {
    provider: "typesafe" as const,
    model: "jev-synthetic-v1",
    accepted_response_models: ["jev-synthetic-return-v2", "jev-synthetic-v1"],
    endpoint: "https://api.typesafe.ai/v1/systemone",
    price_version: "synthetic-decision-price-v1",
    input_micro_usd_per_million: 1000,
    output_micro_usd_per_million: 0 as const,
    timeout_ms: 1000,
    max_request_bytes: 1_048_576,
    max_response_bytes: 262_144,
    audit_id: audit.audit_id!,
    expected_version: 0,
  };
  return { root, runtime, control, store, operator, audit };
}

it("readDecisionActivation returns the profile ONLY when SQL and mirror match exactly", () => {
  const f = decisionFixture();
  try {
    expect(f.audit.ok).toBe(true);
    const profile = f.store.enable(f.operator, ACK);
    expect(readDecisionActivation(f.control, f.root)).toMatchObject({ enabled: true, version: 1 });
    // A disabled-but-valid matching profile is still returned (only mismatch denies).
    f.store.disable(profile.version);
    expect(readDecisionActivation(f.control, f.root)).toMatchObject({ enabled: false, version: 2 });
    // Remove the mirror: the (still-valid) SQL row alone must NOT be returned.
    rmSync(decisionActivationMirrorPath(f.root), { force: true });
    expect(readDecisionActivation(f.control, f.root)).toBeUndefined();
  } finally {
    f.runtime.close();
  }
});

it("evaluateConfiguredDecisionPolicy denies profile_invalid when the mirror is missing or mismatched", () => {
  const f = decisionFixture();
  try {
    f.store.enable(f.operator, ACK);
    expect(
      evaluateConfiguredDecisionPolicy({ control: f.control, root: f.root, now: CLOCK(), optIn: true }),
    ).toMatchObject({ ready: true, reason: "ready" });
    rmSync(decisionActivationMirrorPath(f.root), { force: true });
    expect(
      evaluateConfiguredDecisionPolicy({ control: f.control, root: f.root, now: CLOCK(), optIn: true }),
    ).toEqual({ ready: false, reason: "profile_invalid" });
  } finally {
    f.runtime.close();
  }
});

it("readDecisionActivation denies a control handle paired with an unrelated root", () => {
  const f = decisionFixture();
  const other = newRoot();
  try {
    f.store.enable(f.operator, ACK);
    expect(readDecisionActivation({ db: f.control.db, path: other }, other)).toBeUndefined();
  } finally {
    f.runtime.close();
  }
});
