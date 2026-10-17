import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ManagedRuntime } from "../../packages/runtime/managed.ts";
import { managedDecisionCapability } from "../../packages/runtime/managed.ts";
import { ManagedSpendingStore } from "../../packages/storage/managed-spending.ts";
import { DispatchLedger } from "../../packages/storage/spend.ts";
import { ManagedDecisionActivationStore } from "../../packages/storage/managed-decision-activation.ts";
import { ManagedActivationStore } from "../../packages/storage/managed-activation.ts";
import { ManagedReconciliationStore } from "../../packages/storage/managed-reconciliation.ts";
import { auditManagedHistory } from "../../packages/runtime/managed-audit.ts";
import {
  expectedPreparedConfigHash,
  expectedDecisionConfigHash,
  installDecisionPolicy,
  type InstalledActivationPolicy,
} from "../../packages/runtime/managed-activation.ts";
import {
  decisionWorkerReadinessPath,
  writeDecisionReadiness,
} from "../../packages/runtime/decision-worker-readiness.ts";
import { writeWorkerReadiness } from "../../packages/runtime/worker-readiness.ts";
import { PreparedDecisionProvider } from "../../packages/providers/prepared-decision.ts";
import { PreparedReasoningProvider } from "../../packages/providers/prepared.ts";
import { BrainError } from "../../packages/domain/logic.ts";
import { ManagedDispatchAccounting } from "../../apps/worker/managed-accounting.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const CLOCK = () => new Date("2026-10-17T12:00:00.000Z");
const ACK = { offline: true as const, workers_terminated: true as const };
const WORKER_ID = randomUUID();
const REASONING_WORKER_ID = randomUUID();
const DECISION_OWNER = "synthetic-decision-worker";
const REASONING_OWNER = "synthetic-reasoning-worker";
const LIMITS = {
  per_job_micro_usd: 10_000,
  daily_micro_usd: 100_000,
  time_zone: "UTC",
};

function newRoot() {
  const base = mkdtempSync(join(tmpdir(), "bibrain-decision-accounting-"));
  roots.push(base);
  return join(base, "managed");
}

const decisionInput = {
  state: "SYNTHETIC scoped goal and source version snapshot",
  instruction: "Choose one permitted option.",
  options: [
    { id: "related", description: "Potentially related" },
    { id: "abstain", description: "Insufficient evidence" },
  ],
};

function decisionPayload(over: Record<string, unknown> = {}) {
  return {
    model: "jev-synthetic-v1",
    usage: { input_tokens: 700, output_tokens: 0 },
    answers: {
      decision: {
        type: "choice",
        choice: "related",
        confidence: 0.7,
        probabilities: { related: 0.7, abstain: 0.3 },
      },
    },
    ...over,
  };
}

function readinessRecord(profile: {
  provider: string;
  endpoint_digest: string;
  epoch: number;
  root_nonce: string;
  fingerprint: string;
  config_digest: string;
  model: string;
  price_version: string;
}, workerId: string) {
  return {
    schema: 1 as const,
    worker_id: workerId,
    stage_scope: "decision" as const,
    provider_family: profile.provider,
    endpoint_digest: profile.endpoint_digest,
    epoch: profile.epoch,
    root_nonce: profile.root_nonce,
    activation_fingerprint: profile.fingerprint,
    config_digest: profile.config_digest,
    model: profile.model,
    price_version: profile.price_version,
    booted_at: "2026-10-17T11:59:50.000Z",
    heartbeat_at: CLOCK().toISOString(),
    expires_at: "2026-10-17T12:00:15.000Z",
  };
}

function fixture(fetchImpl?: () => Promise<Response>) {
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
  const account = runtime.provision("https://issuer.synthetic.test", "decision-accounting");
  const money = new ManagedSpendingStore(runtime.control, CLOCK);
  money.setServicePolicy({ daily_micro_usd: 1_000_000 });
  money.setAccountPolicy({
    account_id: account.id,
    per_job_micro_usd: 1_000_000,
    user_daily_micro_usd: 1_000_000,
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
  const profile = new ManagedDecisionActivationStore(runtime.control, root, CLOCK).enable(
    {
      provider: "typesafe",
      model: "jev-synthetic-v1",
      accepted_response_models: ["jev-synthetic-v1", "jev-synthetic-returned-alias"],
      endpoint: "https://api.typesafe.ai/v1/systemone",
      price_version: "synthetic-decision-price-v1",
      input_micro_usd_per_million: 10_000,
      output_micro_usd_per_million: 0,
      timeout_ms: 1000,
      max_request_bytes: 1_048_576,
      max_response_bytes: 262_144,
      audit_id: audit.audit_id!,
      expected_version: 0,
    },
    ACK,
  );
  const reasoningProfile = new ManagedActivationStore(runtime.control, root, CLOCK).enable(
    {
      provider: "openai",
      model: "synthetic-reasoning-model",
      price_version: "synthetic-reasoning-price-v1",
      input_micro_usd_per_million: 10_000,
      output_micro_usd_per_million: 10_000,
      accepted_response_models: ["synthetic-reasoning-model"],
      max_output_tokens: 2000,
      endpoint_class: "openai_responses",
      audit_id: audit.audit_id!,
      expected_version: 0,
    },
    ACK,
  );
  writeDecisionReadiness(root, readinessRecord(profile, WORKER_ID), CLOCK);
  writeWorkerReadiness(root, {
    schema: 1,
    worker_id: REASONING_WORKER_ID,
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
  const installed = installDecisionPolicy({
    root,
    profile,
    worker_id: WORKER_ID,
    optIn: true,
  });
  const reasoningInstalled: InstalledActivationPolicy = {
    root,
    profile: reasoningProfile,
  };
  const handle = runtime.acquire(account.id);
  const brain = handle.brain;
  const owner = brain.ownerPrincipal();
  const project = brain.createProject(owner, "Decision project");
  const goal = brain.goal(owner, {
    project_id: project.id,
    title: "Ship the release",
    success_criteria: "All checks pass",
  });
  brain.editGoal(owner, goal.id, { expected_version: 1, preparation_enabled: true });
  const prepared = brain.prepare(owner, goal.id);
  const jobId = prepared.id;
  brain.store.run(
    "UPDATE jobs SET status='running',lease_owner=?,fence=?,lease_until=? WHERE id=?",
    DECISION_OWNER,
    1,
    "2026-10-17T12:00:20.000Z",
    jobId,
  );
  const prefs = brain.prefs(owner);
  brain.prefs(owner, {
    ...prefs,
    enabled: true,
    provider_enabled: true,
    decision_provider_enabled: true,
    time_zone: "UTC",
    per_job_cap_micro_usd: 100_000,
    daily_cap_micro_usd: 100_000,
  });

  const stats = { calls: 0 };
  const fakeFetch = (async () => {
    stats.calls += 1;
    if (fetchImpl) return fetchImpl();
    return new Response(JSON.stringify(decisionPayload()), { status: 200 });
  }) as unknown as typeof fetch;
  const provider = new PreparedDecisionProvider(
    {
      provider: "typesafe",
      endpoint: profile.endpoint,
      model: profile.model,
      accepted_response_models: [...profile.accepted_response_models],
      price: {
        version: profile.price_version,
        input_micro_usd_per_million: profile.input_micro_usd_per_million,
        output_micro_usd_per_million: 0,
      },
      timeout_ms: profile.timeout_ms,
      max_request_bytes: profile.max_request_bytes,
      max_response_bytes: profile.max_response_bytes,
      key: "SYNTHETIC_CREDENTIAL_NOT_PROFILE_DATA",
    },
    fakeFetch,
  );
  const call = provider.prepareDecision(decisionInput);
  const spec = {
    account_id: account.id,
    job_id: jobId,
    dispatch_key: "decision",
    stage: "decision" as const,
    reserved_micro_usd: call.identity.reserved_micro_usd,
    provider: profile.provider,
    model: profile.model,
    price_version: profile.price_version,
    request_hash: call.identity.request_hash,
    config_hash: call.identity.config_hash,
    limits: LIMITS,
  };
  const lease = {
    job_id: jobId,
    owner: DECISION_OWNER,
    fence: 1,
    expires_at: "2026-10-17T12:00:20.000Z",
  };
  const coordinator = new ManagedDispatchAccounting(money, brain, CLOCK, installed);
  return {
    root,
    runtime,
    account,
    money,
    brain,
    owner,
    project,
    goalId: goal.id,
    jobId,
    profile,
    reasoningProfile,
    reasoningInstalled,
    installed,
    call,
    spec,
    lease,
    coordinator,
    stats,
    fetchImplNote: fetchImpl,
    close() {
      handle.release();
      runtime.close();
    },
  };
}

it("runs the full decision reserve/mark/assert/execute/settle lifecycle with real central and tenant money", async () => {
  const f = fixture();
  try {
    expect(f.spec.config_hash).toBe(expectedDecisionConfigHash(f.profile));
    expect(f.spec.reserved_micro_usd).toBeGreaterThanOrEqual(7);

    const rec = f.coordinator.reserve(f.spec, f.lease, LIMITS);
    expect(rec).toMatchObject({ state: "reserved", stage: "decision" });
    f.coordinator.markDispatched(rec.call_id, f.lease);
    expect(() => f.coordinator.assertCanExecute(rec.call_id, f.lease)).not.toThrow();

    const env = await f.call.execute(new AbortController().signal);
    expect(env.disposition).toBe("attempted");
    expect(env.accounting).toMatchObject({ state: "known", cost_micro_usd: 7 });
    expect(env.output).toMatchObject({ ok: true, choice: "related" });
    expect(f.stats.calls).toBe(1);

    const settled = f.coordinator.settle(rec.call_id, 7);
    expect(settled).toMatchObject({ state: "settled", actual_micro_usd: 7 });
    expect(f.coordinator.receiptForSlot(f.jobId, "decision")).toMatchObject({
      state: "settled",
      actual_micro_usd: 7,
    });
    const tenant = new DispatchLedger(f.brain.store, CLOCK).readReceipt(rec.call_id);
    expect(tenant).toMatchObject({ state: "settled", actual_micro_usd: 7 });
  } finally {
    f.close();
  }
});

it("retains the known cost and the accepted returned-model alias when the answer is malformed", async () => {
  const f = fixture(async () =>
    new Response(
      JSON.stringify(
        decisionPayload({
          model: "jev-synthetic-returned-alias",
          answers: {
            decision: {
              type: "choice",
              choice: "related",
              confidence: 0.7,
              probabilities: { related: 0.9, abstain: 0.9 },
            },
          },
        }),
      ),
      { status: 200 },
    ),
  );
  try {
    const rec = f.coordinator.reserve(f.spec, f.lease, LIMITS);
    f.coordinator.markDispatched(rec.call_id, f.lease);
    f.coordinator.assertCanExecute(rec.call_id, f.lease);
    const env = await f.call.execute(new AbortController().signal);
    expect(env.accounting).toMatchObject({
      state: "known",
      cost_micro_usd: 7,
      model: "jev-synthetic-returned-alias",
    });
    expect(env.output).toMatchObject({ ok: false, code: "INVALID_OUTPUT" });
    // The known charge is still settled; only the output is refused.
    const settled = f.coordinator.settle(rec.call_id, 7);
    expect(settled).toMatchObject({ state: "settled", actual_micro_usd: 7 });
  } finally {
    f.close();
  }
});

it("denies absent, stale and foreign decision readiness before any hold", () => {
  for (const kind of ["absent", "stale", "foreign"] as const) {
    const f = fixture();
    try {
      if (kind === "absent") rmSync(decisionWorkerReadinessPath(f.root), { force: true });
      if (kind === "stale")
        writeDecisionReadiness(
          f.root,
          {
            ...readinessRecord(f.profile, WORKER_ID),
            booted_at: "2026-10-17T11:00:00.000Z",
            heartbeat_at: "2026-10-17T11:00:05.000Z",
            expires_at: "2026-10-17T11:00:20.000Z",
          },
          CLOCK,
        );
      if (kind === "foreign")
        writeDecisionReadiness(f.root, readinessRecord(f.profile, randomUUID()), CLOCK);
      expect(() => f.coordinator.reserve(f.spec, f.lease, LIMITS)).toThrow();
      expect(f.money.latestForJob(f.account.id, f.jobId)).toBeUndefined();
    } finally {
      f.close();
    }
  }
});

const denials: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
  [
    "master consent withdrawn",
    (f) => f.brain.prefs(f.owner, { ...f.brain.prefs(f.owner), provider_enabled: false }),
  ],
  [
    "decision consent withdrawn",
    (f) => f.brain.prefs(f.owner, { ...f.brain.prefs(f.owner), decision_provider_enabled: false }),
  ],
  [
    "background help disabled",
    (f) => f.brain.prefs(f.owner, { ...f.brain.prefs(f.owner), enabled: false }),
  ],
  [
    "goal preparation disabled",
    (f) =>
      f.brain.editGoal(f.owner, f.goalId, {
        expected_version: 2,
        preparation_enabled: false,
      }),
  ],
  [
    "goal plan version advanced",
    (f) =>
      f.brain.editGoal(f.owner, f.goalId, { expected_version: 2, plan: "changed plan" }),
  ],
  [
    "job kind changed",
    (f) => f.brain.store.run("UPDATE jobs SET kind='derive_brief' WHERE id=?", f.jobId),
  ],
  [
    "lease expired",
    (f) =>
      f.brain.store.run(
        "UPDATE jobs SET lease_until='2026-10-17T11:00:00.000Z' WHERE id=?",
        f.jobId,
      ),
  ],
  [
    "account suspended",
    (f) => f.runtime.control.db.exec(`UPDATE managed_accounts SET state='suspended'`),
  ],
];

it.each(denials)("denies before I/O when %s", (_label, mutate) => {
  const f = fixture();
  try {
    const rec = f.coordinator.reserve(f.spec, f.lease, LIMITS);
    mutate(f);
    expect(() => f.coordinator.markDispatched(rec.call_id, f.lease)).toThrow();
    expect(f.stats.calls).toBe(0);
    // The marked attempt was never sent and remains a stranded reserved hold.
    expect(f.coordinator.receiptForSlot(f.jobId, "decision")).toMatchObject({
      state: "reserved",
    });
  } finally {
    f.close();
  }
});

it("releases a reserved, undispatched decision hold by CAS before any I/O", () => {
  const f = fixture();
  try {
    const rec = f.coordinator.reserve(f.spec, f.lease, LIMITS);
    expect(rec.state).toBe("reserved");
    const released = f.coordinator.releaseUndispatched(rec.call_id);
    expect(released).toMatchObject({ state: "released" });
    expect(f.coordinator.receiptForSlot(f.jobId, "decision")).toMatchObject({
      state: "released",
    });
    expect(f.stats.calls).toBe(0);
  } finally {
    f.close();
  }
});

it("keeps the dispatched hold and pauses paid processing after a post-mark abort (no refund)", async () => {
  const f = fixture();
  try {
    const rec = f.coordinator.reserve(f.spec, f.lease, LIMITS);
    f.coordinator.markDispatched(rec.call_id, f.lease);
    const aborted = new AbortController();
    aborted.abort();
    const env = await f.call.execute(aborted.signal);
    expect(env).toMatchObject({ disposition: "not_dispatched", accounting: { state: "unknown" } });
    // No settlement: the marked hold stays dispatched and the global barrier pauses.
    expect(f.coordinator.receiptForSlot(f.jobId, "decision")).toMatchObject({
      state: "dispatched",
    });
    expect(f.coordinator.hasUnresolved(f.jobId)).toBe(true);
    expect(() =>
      new ManagedSpendingStore(f.runtime.control, CLOCK).reserve({
        account_id: f.account.id,
        job_id: "other-job",
        dispatch_key: "reasoning",
        stage: "reasoning",
        reserved_micro_usd: 1,
        provider: "synthetic",
        model: "synthetic",
        price_version: "synthetic-v1",
        request_hash: "a".repeat(64),
        config_hash: "b".repeat(64),
        limits: { per_job_micro_usd: 10_000, user_daily_micro_usd: 100_000, time_zone: "UTC" },
      }),
    ).toThrow();
  } finally {
    f.close();
  }
});

it("treats an unknown provider outcome as a durable global pause and refuses to resend from a new coordinator", async () => {
  const f = fixture(async () => {
    throw new Error("SYNTHETIC_NETWORK_FAILURE");
  });
  try {
    const rec = f.coordinator.reserve(f.spec, f.lease, LIMITS);
    f.coordinator.markDispatched(rec.call_id, f.lease);
    const env = await f.call.execute(new AbortController().signal);
    expect(env).toMatchObject({ disposition: "attempted", accounting: { state: "unknown" } });
    // A fresh coordinator (empty private map) cannot adopt the held slot.
    const successor = new ManagedDispatchAccounting(
      new ManagedSpendingStore(f.runtime.control, CLOCK),
      f.brain,
      CLOCK,
      f.installed,
    );
    expect(() => successor.markDispatched(rec.call_id, f.lease)).toThrow();
    expect(f.coordinator.receiptForSlot(f.jobId, "decision")).toMatchObject({
      state: "dispatched",
    });
  } finally {
    f.close();
  }
});

it("persists the known decision charge but refuses the output when consent is withdrawn during the call", async () => {
  const f = fixture();
  try {
    const rec = f.coordinator.reserve(f.spec, f.lease, LIMITS);
    f.coordinator.markDispatched(rec.call_id, f.lease);
    f.coordinator.assertCanExecute(rec.call_id, f.lease);
    // Consent is withdrawn while the provider call is in flight.
    f.brain.prefs(f.owner, {
      ...f.brain.prefs(f.owner),
      decision_provider_enabled: false,
    });
    const env = await f.call.execute(new AbortController().signal);
    expect(env.accounting).toMatchObject({ state: "known", cost_micro_usd: 7 });
    expect(() => f.coordinator.settle(rec.call_id, 7)).toThrow();
    // The charge was persisted centrally before the output was discarded.
    expect(f.coordinator.receiptForSlot(f.jobId, "decision")).toMatchObject({
      state: "settled",
      actual_micro_usd: 7,
    });
  } finally {
    f.close();
  }
});

it("keeps the decision and reasoning slots of the same job distinct and account-scoped", async () => {
  const f = fixture();
  try {
    const rec = f.coordinator.reserve(f.spec, f.lease, LIMITS);
    f.coordinator.markDispatched(rec.call_id, f.lease);
    f.coordinator.assertCanExecute(rec.call_id, f.lease);
    await f.call.execute(new AbortController().signal);
    f.coordinator.settle(rec.call_id, 7);
    expect(f.coordinator.receiptForSlot(f.jobId, "decision")).toMatchObject({
      state: "settled",
    });
    expect(f.coordinator.receiptForSlot(f.jobId, "reasoning")).toBeUndefined();
    // Another account cannot read this account's slot.
    const other = f.runtime.provision("https://issuer.synthetic.test", "other-account");
    const handle = f.runtime.acquire(other.id);
    try {
      const otherCoordinator = new ManagedDispatchAccounting(
        new ManagedSpendingStore(f.runtime.control, CLOCK),
        handle.brain,
        CLOCK,
        f.installed,
      );
      expect(otherCoordinator.accountId).toBe(other.id);
      expect(otherCoordinator.receiptForSlot(f.jobId, "decision")).toBeUndefined();
    } finally {
      handle.release();
    }
  } finally {
    f.close();
  }
});

it("refuses a decision dispatch through a coordinator without a decision policy and vice versa", () => {
  const f = fixture();
  try {
    const lowLevel = new ManagedDispatchAccounting(
      new ManagedSpendingStore(f.runtime.control, CLOCK),
      f.brain,
      CLOCK,
    );
    expect(() => lowLevel.reserve(f.spec, f.lease, LIMITS)).toThrow();
    expect(f.money.latestForJob(f.account.id, f.jobId)).toBeUndefined();
    // The decision coordinator serves only the decision stage.
    const reasoningSpec = {
      job_id: f.jobId,
      dispatch_key: "reasoning",
      stage: "reasoning" as const,
      reserved_micro_usd: 1,
      provider: "synthetic",
      model: "synthetic",
      price_version: "synthetic-v1",
      request_hash: "a".repeat(64),
      config_hash: "b".repeat(64),
    };
    expect(() => f.coordinator.reserve(reasoningSpec, f.lease, LIMITS)).toThrow();
  } finally {
    f.close();
  }
});

it("does not admit a fresh stage while a decision mark is outstanding, then admits a reasoning slot after settlement", async () => {
  const f = fixture();
  try {
    const rec = f.coordinator.reserve(f.spec, f.lease, LIMITS);
    f.coordinator.markDispatched(rec.call_id, f.lease);

    // A separate reasoning job with its own running lease and installed profile.
    const briefJob = f.brain.enqueue(f.project.id, "derive_brief", { principal: f.owner });
    f.brain.store.run(
      "UPDATE jobs SET status='running',lease_owner=?,fence=?,lease_until=? WHERE id=?",
      REASONING_OWNER,
      1,
      "2026-10-17T12:00:20.000Z",
      briefJob.id,
    );
    const reasoningCoordinator = new ManagedDispatchAccounting(
      new ManagedSpendingStore(f.runtime.control, CLOCK),
      f.brain,
      CLOCK,
      f.reasoningInstalled,
    );
    const reasoningSpec = {
      job_id: briefJob.id,
      dispatch_key: "reasoning",
      stage: "reasoning" as const,
      reserved_micro_usd: 5,
      provider: f.reasoningProfile.provider,
      model: f.reasoningProfile.model,
      price_version: f.reasoningProfile.price_version,
      request_hash: "a".repeat(64),
      config_hash: expectedPreparedConfigHash(f.reasoningProfile, "brief"),
    };
    const reasoningLease = {
      job_id: briefJob.id,
      owner: REASONING_OWNER,
      fence: 1,
      expires_at: "2026-10-17T12:00:20.000Z",
    };
    // While the decision call is dispatched, the one-inflight barrier denies.
    expect(() =>
      reasoningCoordinator.reserve(reasoningSpec, reasoningLease, LIMITS),
    ).toThrow();

    // Settle the decision call, then the reasoning slot is admitted.
    f.coordinator.assertCanExecute(rec.call_id, f.lease);
    await f.call.execute(new AbortController().signal);
    f.coordinator.settle(rec.call_id, 7);
    const reasoningRecord = reasoningCoordinator.reserve(
      reasoningSpec,
      reasoningLease,
      LIMITS,
    );
    expect(reasoningRecord).toMatchObject({ state: "reserved", stage: "reasoning" });
    expect(reasoningCoordinator.receiptForSlot(briefJob.id, "reasoning")).toMatchObject({
      state: "reserved",
    });
    // The two stages on the SAME account remain distinct slots.
    expect(f.coordinator.receiptForSlot(f.jobId, "decision")).toMatchObject({
      state: "settled",
    });
  } finally {
    f.close();
  }
});

it("aggregates the per-job cap across stages for one job", async () => {
  const f = fixture();
  try {
    const rec = f.coordinator.reserve(f.spec, f.lease, LIMITS);
    f.coordinator.markDispatched(rec.call_id, f.lease);
    f.coordinator.assertCanExecute(rec.call_id, f.lease);
    await f.call.execute(new AbortController().signal);
    f.coordinator.settle(rec.call_id, 7);
    // A second slot on the SAME job aggregates the settled decision actual against
    // the (lowered) per-job cap and is denied.
    expect(() =>
      new ManagedSpendingStore(f.runtime.control, CLOCK).reserve({
        account_id: f.account.id,
        job_id: f.jobId,
        dispatch_key: "reasoning",
        stage: "reasoning",
        reserved_micro_usd: 1,
        provider: "synthetic",
        model: "synthetic",
        price_version: "synthetic-v1",
        request_hash: "a".repeat(64),
        config_hash: "b".repeat(64),
        limits: { per_job_micro_usd: 7, user_daily_micro_usd: 100_000, time_zone: "UTC" },
      }),
    ).toThrow();
  } finally {
    f.close();
  }
});

it("keeps extractive capture working on an unpaid account while another stage is paused", async () => {
  const f = fixture();
  try {
    const rec = f.coordinator.reserve(f.spec, f.lease, LIMITS);
    f.coordinator.markDispatched(rec.call_id, f.lease);
    // The unpaid tenant can still capture and search real sources.
    const captured = f.brain.capture(f.owner, {
      project_id: f.project.id,
      title: "Unpaid note",
      body: "SYNTHETIC_UNPAID_EXTRACTIVE",
    });
    expect(captured).toBeTruthy();
    expect(f.brain.sources(f.owner, f.project.id).length).toBeGreaterThan(0);
  } finally {
    f.close();
  }
});

/* ------------------------------------------------------------------ *
 * Repair regressions (parent 2B review REDs)
 * ------------------------------------------------------------------ */

it("discards the decision output but keeps BOTH known charges when the lease expires during I/O", async () => {
  let during: () => void = () => {};
  const f = fixture(async () => {
    during();
    return new Response(JSON.stringify(decisionPayload()), { status: 200 });
  });
  try {
    during = () =>
      f.brain.store.run(
        "UPDATE jobs SET lease_until=? WHERE id=?",
        CLOCK().toISOString(),
        f.jobId,
      );
    const rec = f.coordinator.reserve(f.spec, f.lease, LIMITS);
    f.coordinator.markDispatched(rec.call_id, f.lease);
    f.coordinator.assertCanExecute(rec.call_id, f.lease);
    const env = await f.call.execute(new AbortController().signal);
    expect(env.accounting).toMatchObject({ state: "known", cost_micro_usd: 7 });
    expect(() => f.coordinator.settle(rec.call_id, 7)).toThrow();
    // The known charge stays settled in BOTH ledgers; no refund.
    expect(f.coordinator.receiptForSlot(f.jobId, "decision")).toMatchObject({
      state: "settled",
      actual_micro_usd: 7,
    });
    expect(new DispatchLedger(f.brain.store, CLOCK).readReceipt(rec.call_id)).toMatchObject({
      state: "settled",
      actual_micro_usd: 7,
    });
  } finally {
    f.close();
  }
});

const postMarkMutations: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
  [
    "the job principal becomes a foreign tenant",
    (f) =>
      f.brain.store.run(
        "UPDATE jobs SET payload=? WHERE id=?",
        JSON.stringify({
          goal_id: f.goalId,
          principal: { kind: "owner", tenantId: randomUUID() },
          manual: true,
        }),
        f.jobId,
      ),
  ],
  [
    "the job goal reference changes",
    (f) => {
      const other = f.brain.goal(f.owner, {
        project_id: f.project.id,
        title: "Another goal",
        success_criteria: "x",
      });
      f.brain.editGoal(f.owner, other.id, { expected_version: 1, preparation_enabled: true });
      f.brain.store.run(
        "UPDATE jobs SET payload=? WHERE id=?",
        JSON.stringify({ goal_id: other.id, principal: f.owner, manual: true }),
        f.jobId,
      );
    },
  ],
  [
    "the job kind changes",
    (f) => f.brain.store.run("UPDATE jobs SET kind='derive_brief' WHERE id=?", f.jobId),
  ],
];

it.each(postMarkMutations)(
  "denies I/O and keeps the marked hold when %s after mark",
  (_label, mutate) => {
    const f = fixture();
    try {
      const rec = f.coordinator.reserve(f.spec, f.lease, LIMITS);
      f.coordinator.markDispatched(rec.call_id, f.lease);
      mutate(f);
      expect(() => f.coordinator.assertCanExecute(rec.call_id, f.lease)).toThrow();
      expect(f.stats.calls).toBe(0);
      expect(f.coordinator.receiptForSlot(f.jobId, "decision")).toMatchObject({
        state: "dispatched",
        actual_micro_usd: null,
      });
    } finally {
      f.close();
    }
  },
);

/* ------------------------------------------------------------------ *
 * Same-job two-PAID-stage proof and cumulative cap
 * ------------------------------------------------------------------ */

function reasoningReply(model: string, src: { id: string; version: number; body: string }) {
  const stats = { calls: 0 };
  const fetcher = (async () => {
    stats.calls += 1;
    return new Response(
      JSON.stringify({
        model,
        usage: { input_tokens: 5, output_tokens: 2 },
        output: [
          {
            content: [
              {
                type: "output_text",
                text: JSON.stringify({
                  outcome: "proposal",
                  artifact: "A synthetic proposal",
                  evidence: [
                    {
                      source_id: src.id,
                      source_version: src.version,
                      start: 0,
                      end: 9,
                      quote: src.body.slice(0, 9),
                    },
                  ],
                }),
              },
            ],
          },
        ],
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  return { fetcher, stats };
}

it("runs a real decision call and then an already-authorized reasoning call on the SAME review job, each settling its own row", async () => {
  const f = fixture();
  try {
    const dRec = f.coordinator.reserve(f.spec, f.lease, LIMITS);
    f.coordinator.markDispatched(dRec.call_id, f.lease);
    f.coordinator.assertCanExecute(dRec.call_id, f.lease);
    const dEnv = await f.call.execute(new AbortController().signal);
    expect(dEnv.accounting).toMatchObject({ state: "known", cost_micro_usd: 7 });
    expect(dEnv.output).toMatchObject({ ok: true, choice: "related" });
    f.coordinator.settle(dRec.call_id, 7);
    expect(f.coordinator.receiptForSlot(f.jobId, "decision")).toMatchObject({
      state: "settled",
      actual_micro_usd: 7,
    });

    f.brain.capture(f.owner, {
      project_id: f.project.id,
      title: "Evidence",
      body: "SYNTHETIC evidence body",
    });
    const src = f.brain.sources(f.owner, f.project.id)[0];
    const goalEntity = f.brain.entity(f.owner, f.goalId);
    const { fetcher, stats } = reasoningReply(f.reasoningProfile.model, {
      id: src.id,
      version: src.version,
      body: src.body,
    });
    const reasoningProvider = new PreparedReasoningProvider(
      {
        model: f.reasoningProfile.model,
        accepted_response_models: [...f.reasoningProfile.accepted_response_models],
        price: {
          version: f.reasoningProfile.price_version,
          input_micro_usd_per_million: f.reasoningProfile.input_micro_usd_per_million,
          output_micro_usd_per_million: f.reasoningProfile.output_micro_usd_per_million,
        },
        max_output_tokens: f.reasoningProfile.max_output_tokens,
        key: "SYNTHETIC_REASONING_CREDENTIAL",
      },
      fetcher,
    );
    const rCall = reasoningProvider.prepareCall({
      kind: "goal",
      goal: {
        title: goalEntity.data.title,
        success_criteria: goalEntity.data.success_criteria,
        plan: "",
      },
      sources: [src],
    });
    expect(rCall.identity.config_hash).toBe(
      expectedPreparedConfigHash(f.reasoningProfile, "goal"),
    );
    const rSpec = {
      job_id: f.jobId,
      dispatch_key: "reasoning",
      stage: "reasoning" as const,
      reserved_micro_usd: rCall.identity.reserved_micro_usd,
      provider: "openai",
      model: rCall.identity.model,
      price_version: rCall.identity.price_version,
      request_hash: rCall.identity.request_hash,
      config_hash: rCall.identity.config_hash,
    };
    const rCoordinator = new ManagedDispatchAccounting(
      new ManagedSpendingStore(f.runtime.control, CLOCK),
      f.brain,
      CLOCK,
      f.reasoningInstalled,
    );
    const rRec = rCoordinator.reserve(rSpec, f.lease, LIMITS);
    rCoordinator.markDispatched(rRec.call_id, f.lease);
    rCoordinator.assertCanExecute(rRec.call_id, f.lease);
    const rEnv = await rCall.execute(new AbortController().signal);
    expect(rEnv.accounting.state).toBe("known");
    expect(rEnv.output).toMatchObject({ ok: true, kind: "goal", outcome: "proposal" });
    if (rEnv.output.ok !== true || rEnv.output.kind !== "goal")
      throw new Error("expected a valid goal output");
    expect(rEnv.output.evidence[0]).toMatchObject({
      source_id: src.id,
      quote: src.body.slice(0, 9),
    });
    if (rEnv.accounting.state !== "known") throw new Error("expected known usage");
    const rSettled = rCoordinator.settle(rRec.call_id, rEnv.accounting.cost_micro_usd);
    expect(rSettled).toMatchObject({
      state: "settled",
      actual_micro_usd: rEnv.accounting.cost_micro_usd,
    });
    expect(rCoordinator.receiptForSlot(f.jobId, "reasoning")).toMatchObject({
      state: "settled",
    });
    // Distinct rows on the SAME job; the decision settlement is unchanged.
    expect(f.coordinator.receiptForSlot(f.jobId, "decision")).toMatchObject({
      state: "settled",
      actual_micro_usd: 7,
    });
    expect(f.stats.calls).toBe(1);
    expect(stats.calls).toBe(1);
  } finally {
    f.close();
  }
});

it("denies a second paid stage before I/O when the frozen per-job cap is exceeded, keeping the settled decision", async () => {
  const f = fixture();
  try {
    // Build BOTH provider calls first so their exact reserved bounds are known.
    const { fetcher, stats } = reasoningReply(f.reasoningProfile.model, {
      id: "src-1",
      version: 1,
      body: "SYNTHETIC",
    });
    const reasoningProvider = new PreparedReasoningProvider(
      {
        model: f.reasoningProfile.model,
        accepted_response_models: [...f.reasoningProfile.accepted_response_models],
        price: {
          version: f.reasoningProfile.price_version,
          input_micro_usd_per_million: f.reasoningProfile.input_micro_usd_per_million,
          output_micro_usd_per_million: f.reasoningProfile.output_micro_usd_per_million,
        },
        max_output_tokens: f.reasoningProfile.max_output_tokens,
        key: "SYNTHETIC_REASONING_CREDENTIAL",
      },
      fetcher,
    );
    const rCall = reasoningProvider.prepareCall({
      kind: "goal",
      goal: { title: "Synthetic", success_criteria: "x", plan: "" },
      sources: [
        {
          id: "src-1",
          project_id: f.project.id,
          version: 1,
          title: "t",
          body: "SYNTHETIC",
          visibility: "project",
          state: "active",
          captured_at: "2026-10-17T11:00:00Z",
          origin: "owner",
        },
      ],
    });
    const dBound = f.spec.reserved_micro_usd;
    const rBound = rCall.identity.reserved_micro_usd;
    const cap = Math.max(dBound, rBound);
    // Each individual bound fits the frozen cap, but the settled decision actual
    // PLUS the reasoning bound does not: only the aggregation denies.
    expect(dBound).toBeLessThanOrEqual(cap);
    expect(rBound).toBeLessThanOrEqual(cap);
    expect(7 + rBound).toBeGreaterThan(cap);
    const low = {
      per_job_micro_usd: cap,
      daily_micro_usd: 100_000,
      time_zone: "UTC",
    };

    const dRec = f.coordinator.reserve(f.spec, f.lease, low);
    f.coordinator.markDispatched(dRec.call_id, f.lease);
    f.coordinator.assertCanExecute(dRec.call_id, f.lease);
    await f.call.execute(new AbortController().signal);
    f.coordinator.settle(dRec.call_id, 7);
    expect(f.coordinator.receiptForSlot(f.jobId, "decision")).toMatchObject({
      state: "settled",
      actual_micro_usd: 7,
    });
    expect(new DispatchLedger(f.brain.store, CLOCK).readReceipt(dRec.call_id)).toMatchObject({
      state: "settled",
      actual_micro_usd: 7,
    });

    const rCoordinator = new ManagedDispatchAccounting(
      new ManagedSpendingStore(f.runtime.control, CLOCK),
      f.brain,
      CLOCK,
      f.reasoningInstalled,
    );
    expect(() =>
      rCoordinator.reserve(
        {
          job_id: f.jobId,
          dispatch_key: "reasoning",
          stage: "reasoning",
          reserved_micro_usd: rBound,
          provider: "openai",
          model: rCall.identity.model,
          price_version: rCall.identity.price_version,
          request_hash: rCall.identity.request_hash,
          config_hash: rCall.identity.config_hash,
        },
        f.lease,
        low,
      ),
    ).toThrow();
    expect(stats.calls).toBe(0);
    // The reasoning stage left no hold; the decision settlement is unchanged in both ledgers.
    expect(rCoordinator.receiptForSlot(f.jobId, "reasoning")).toBeUndefined();
    expect(f.coordinator.receiptForSlot(f.jobId, "decision")).toMatchObject({
      state: "settled",
      actual_micro_usd: 7,
    });
  } finally {
    f.close();
  }
});

/* ------------------------------------------------------------------ *
 * Two-account barrier / restart / extractive proof
 * ------------------------------------------------------------------ */

function twoAccountFixture() {
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
  const a = runtime.provision("https://issuer.synthetic.test", "acct-a");
  const b = runtime.provision("https://issuer.synthetic.test", "acct-b");
  const money = new ManagedSpendingStore(runtime.control, CLOCK);
  money.setServicePolicy({ daily_micro_usd: 1_000_000 });
  for (const acct of [a, b]) {
    money.setAccountPolicy({
      account_id: acct.id,
      per_job_micro_usd: 1_000_000,
      user_daily_micro_usd: 1_000_000,
    });
    money.configureAccountPeriod({
      account_id: acct.id,
      starts_at: "2026-10-17T00:00:00Z",
      ends_at: "2026-10-18T00:00:00Z",
      allowance_micro_usd: 1_000_000,
    });
  }
  new ManagedReconciliationStore(runtime.control, root, CLOCK).initEpoch(ACK);
  const audit = auditManagedHistory({ runtime, root, ...ACK, clock: CLOCK });
  if (!audit.ok) throw new Error(`audit failed: ${audit.reason}`);
  const profile = new ManagedDecisionActivationStore(runtime.control, root, CLOCK).enable(
    {
      provider: "typesafe",
      model: "jev-synthetic-v1",
      accepted_response_models: ["jev-synthetic-v1"],
      endpoint: "https://api.typesafe.ai/v1/systemone",
      price_version: "synthetic-decision-price-v1",
      input_micro_usd_per_million: 10_000,
      output_micro_usd_per_million: 0,
      timeout_ms: 1000,
      max_request_bytes: 1_048_576,
      max_response_bytes: 262_144,
      audit_id: audit.audit_id!,
      expected_version: 0,
    },
    ACK,
  );
  const reasoningProfile = new ManagedActivationStore(runtime.control, root, CLOCK).enable(
    {
      provider: "openai",
      model: "synthetic-reasoning-model",
      price_version: "synthetic-reasoning-price-v1",
      input_micro_usd_per_million: 10_000,
      output_micro_usd_per_million: 10_000,
      accepted_response_models: ["synthetic-reasoning-model"],
      max_output_tokens: 2000,
      endpoint_class: "openai_responses",
      audit_id: audit.audit_id!,
      expected_version: 0,
    },
    ACK,
  );
  writeDecisionReadiness(root, readinessRecord(profile, WORKER_ID), CLOCK);
  writeWorkerReadiness(root, {
    schema: 1,
    worker_id: REASONING_WORKER_ID,
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
  const installed = installDecisionPolicy({ root, profile, worker_id: WORKER_ID, optIn: true });
  const reasoningInstalled: InstalledActivationPolicy = { root, profile: reasoningProfile };

  const ha = runtime.acquire(a.id);
  const brainA = ha.brain;
  const ownerA = brainA.ownerPrincipal();
  const projectA = brainA.createProject(ownerA, "A project");
  const goalA = brainA.goal(ownerA, {
    project_id: projectA.id,
    title: "A goal",
    success_criteria: "x",
  });
  brainA.editGoal(ownerA, goalA.id, { expected_version: 1, preparation_enabled: true });
  const preparedA = brainA.prepare(ownerA, goalA.id);
  brainA.store.run(
    "UPDATE jobs SET status='running',lease_owner=?,fence=?,lease_until=? WHERE id=?",
    DECISION_OWNER,
    1,
    "2026-10-17T12:00:20.000Z",
    preparedA.id,
  );
  brainA.prefs(ownerA, {
    ...brainA.prefs(ownerA),
    enabled: true,
    provider_enabled: true,
    decision_provider_enabled: true,
    time_zone: "UTC",
    per_job_cap_micro_usd: 100_000,
    daily_cap_micro_usd: 100_000,
  });

  const hb = runtime.acquire(b.id);
  const brainB = hb.brain;
  const ownerB = brainB.ownerPrincipal();
  brainB.prefs(ownerB, {
    ...brainB.prefs(ownerB),
    enabled: true,
    provider_enabled: false,
    decision_provider_enabled: false,
    time_zone: "UTC",
    per_job_cap_micro_usd: 100_000,
    daily_cap_micro_usd: 100_000,
  });
  const jobB = brainB.enqueue("inbox", "derive_brief", { principal: ownerB });
  brainB.store.run(
    "UPDATE jobs SET status='running',lease_owner=?,fence=?,lease_until=? WHERE id=?",
    REASONING_OWNER,
    1,
    "2026-10-17T12:00:20.000Z",
    jobB.id,
  );

  const dProvider = new PreparedDecisionProvider(
    {
      provider: profile.provider,
      endpoint: profile.endpoint,
      model: profile.model,
      accepted_response_models: [...profile.accepted_response_models],
      price: { version: profile.price_version, input_micro_usd_per_million: 10_000, output_micro_usd_per_million: 0 },
      timeout_ms: profile.timeout_ms,
      max_request_bytes: profile.max_request_bytes,
      max_response_bytes: profile.max_response_bytes,
      key: "SYNTHETIC_CREDENTIAL_NOT_PROFILE_DATA",
    },
    (async () =>
      new Response(JSON.stringify({ model: profile.model, output: [] }), { status: 200 })) as unknown as typeof fetch,
  );
  const dCall = dProvider.prepareDecision(decisionInput);
  const dSpec = {
    account_id: a.id,
    job_id: preparedA.id,
    dispatch_key: "decision",
    stage: "decision" as const,
    reserved_micro_usd: dCall.identity.reserved_micro_usd,
    provider: profile.provider,
    model: profile.model,
    price_version: profile.price_version,
    request_hash: dCall.identity.request_hash,
    config_hash: dCall.identity.config_hash,
    limits: LIMITS,
  };
  const dLease = {
    job_id: preparedA.id,
    owner: DECISION_OWNER,
    fence: 1,
    expires_at: "2026-10-17T12:00:20.000Z",
  };
  const dCoordinator = new ManagedDispatchAccounting(money, brainA, CLOCK, installed);
  const bSpec = {
    job_id: jobB.id,
    dispatch_key: "reasoning",
    stage: "reasoning" as const,
    reserved_micro_usd: 5,
    provider: reasoningProfile.provider,
    model: reasoningProfile.model,
    price_version: reasoningProfile.price_version,
    request_hash: "a".repeat(64),
    config_hash: expectedPreparedConfigHash(reasoningProfile, "brief"),
  };
  const bLease = {
    job_id: jobB.id,
    owner: REASONING_OWNER,
    fence: 1,
    expires_at: "2026-10-17T12:00:20.000Z",
  };
  const bCoordinator = new ManagedDispatchAccounting(money, brainB, CLOCK, reasoningInstalled);
  return {
    root,
    runtime,
    a,
    b,
    money,
    brainA,
    brainB,
    ownerB,
    preparedA,
    jobB,
    profile,
    reasoningProfile,
    installed,
    reasoningInstalled,
    dCall,
    dSpec,
    dLease,
    dCoordinator,
    bSpec,
    bLease,
    bCoordinator,
    release() {
      ha.release();
      hb.release();
    },
  };
}

it("keeps an unknown decision call as a durable service-wide pause and blocks account B's reasoning with usage_pending while B extractive work continues", async () => {
  const f = twoAccountFixture();
  try {
    const dRec = f.dCoordinator.reserve(f.dSpec, f.dLease, LIMITS);
    f.dCoordinator.markDispatched(dRec.call_id, f.dLease);
    const env = await f.dCall.execute(new AbortController().signal);
    expect(env).toMatchObject({ disposition: "attempted", accounting: { state: "unknown" } });
    expect(f.money.reservationForSlot(f.a.id, f.preparedA.id, "decision")).toMatchObject({
      state: "dispatched",
    });

    let bError: unknown;
    try {
      f.bCoordinator.reserve(f.bSpec, f.bLease, LIMITS);
    } catch (error) {
      bError = error;
    }
    expect(bError).toBeInstanceOf(BrainError);
    const message = bError instanceof Error ? bError.message : "";
    expect(message).toMatch(/awaits settlement accounting/);
    expect(message).not.toMatch(/audit|schema|configuration|not enabled/i);

    // B's unpaid extractive path still works.
    f.brainB.capture(f.ownerB, {
      project_id: "inbox",
      title: "B note",
      body: "SYNTHETIC B extractive body",
    });
    expect(f.brainB.sources(f.ownerB, "inbox").length).toBeGreaterThan(0);
  } finally {
    f.release();
    f.runtime.close();
  }
});

it("a reopened control handle with an empty coordinator map cannot adopt or re-authorize the held decision call", async () => {
  const f = twoAccountFixture();
  let callId = "";
  let installed = f.installed;
  const root = f.root;
  try {
    const rec = f.dCoordinator.reserve(f.dSpec, f.dLease, LIMITS);
    callId = rec.call_id;
    f.dCoordinator.markDispatched(callId, f.dLease);
  } finally {
    f.release();
    f.runtime.close();
  }
  const runtime2 = new ManagedRuntime(root, { clock: CLOCK });
  try {
    const handle = runtime2.acquire(f.a.id);
    try {
      installed = installDecisionPolicy({
        root,
        profile: f.profile,
        worker_id: WORKER_ID,
        optIn: true,
      });
      const coordinator2 = new ManagedDispatchAccounting(
        new ManagedSpendingStore(runtime2.control, CLOCK),
        handle.brain,
        CLOCK,
        installed,
      );
      expect(() => coordinator2.markDispatched(callId, f.dLease)).toThrow();
      expect(() => coordinator2.assertCanExecute(callId, f.dLease)).toThrow();
      expect(
        new ManagedSpendingStore(runtime2.control, CLOCK).reservationForSlot(
          f.a.id,
          f.preparedA.id,
          "decision",
        ),
      ).toMatchObject({ state: "dispatched" });
    } finally {
      handle.release();
    }
  } finally {
    runtime2.close();
  }
});
