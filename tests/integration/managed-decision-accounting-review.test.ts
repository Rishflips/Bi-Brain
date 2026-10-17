import { expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ManagedRuntime, managedDecisionCapability } from "../../packages/runtime/managed.ts";
import { ManagedSpendingStore } from "../../packages/storage/managed-spending.ts";
import { ManagedReconciliationStore } from "../../packages/storage/managed-reconciliation.ts";
import { ManagedDecisionActivationStore } from "../../packages/storage/managed-decision-activation.ts";
import { auditManagedHistory } from "../../packages/runtime/managed-audit.ts";
import { installDecisionPolicy } from "../../packages/runtime/managed-activation.ts";
import { writeDecisionReadiness } from "../../packages/runtime/decision-worker-readiness.ts";
import { PreparedDecisionProvider } from "../../packages/providers/prepared-decision.ts";
import { ManagedDispatchAccounting } from "../../apps/worker/managed-accounting.ts";

const clock = () => new Date("2026-10-17T12:00:00.000Z");
const ack = { offline: true as const, workers_terminated: true as const };
const limits = { per_job_micro_usd: 1000, daily_micro_usd: 1000, time_zone: "UTC" };
function fixture(onFetch?: () => void) {
  const root = mkdtempSync(join(tmpdir(), "brain-decision-coordinator-parent-"));
  const runtime = new ManagedRuntime(root, { clock, decisionCapability: () => {
    const cap = managedDecisionCapability({ control: runtime.control, root, now: clock(), optIn: true });
    return { ready: cap.available, reason: cap.reason };
  } });
  const account = runtime.provision("https://issuer.synthetic.test", "synthetic-decision-accounting");
  const money = new ManagedSpendingStore(runtime.control, clock);
  money.setServicePolicy({ daily_micro_usd: 1000 });
  money.setAccountPolicy({ account_id: account.id, per_job_micro_usd: 1000, user_daily_micro_usd: 1000 });
  money.configureAccountPeriod({ account_id: account.id, starts_at: "2026-10-17T00:00:00Z", ends_at: "2026-10-18T00:00:00Z", allowance_micro_usd: 1000 });
  new ManagedReconciliationStore(runtime.control, root, clock).initEpoch(ack);
  const audit = auditManagedHistory({ runtime, root, ...ack, clock });
  expect(audit.ok).toBe(true);
  const profile = new ManagedDecisionActivationStore(runtime.control, root, clock).enable({ provider: "typesafe",
    endpoint: "https://api.typesafe.ai/v1/systemone", model: "jev-synthetic-v1", accepted_response_models: ["jev-synthetic-v1"],
    price_version: "synthetic-price-v1", input_micro_usd_per_million: 1000, output_micro_usd_per_million: 0,
    timeout_ms: 1000, max_request_bytes: 1_048_576, max_response_bytes: 262_144, audit_id: audit.audit_id!, expected_version: 0 }, ack);
  const worker_id = randomUUID();
  writeDecisionReadiness(root, { schema: 1, worker_id, stage_scope: "decision", provider_family: profile.provider,
    endpoint_digest: profile.endpoint_digest, epoch: profile.epoch, root_nonce: profile.root_nonce,
    activation_fingerprint: profile.fingerprint, config_digest: profile.config_digest, model: profile.model,
    price_version: profile.price_version, booted_at: "2026-10-17T11:59:50.000Z", heartbeat_at: clock().toISOString(), expires_at: "2026-10-17T12:00:15.000Z" }, clock);
  const installed = installDecisionPolicy({ root, profile, worker_id, optIn: true });
  const handle = runtime.acquire(account.id), brain = handle.brain, owner = brain.ownerPrincipal();
  brain.prefs(owner, { ...brain.prefs(owner), enabled: true, provider_enabled: true, decision_provider_enabled: true,
    time_zone: "UTC", daily_cap_micro_usd: 1000, per_job_cap_micro_usd: 1000 });
  const created = brain.goal(owner, { project_id: "inbox", title: "SYNTHETIC explicit review goal", success_criteria: "Review the saved evidence" });
  const goal = brain.editGoal(owner, created.id, { expected_version: created.version, preparation_enabled: true });
  const job = brain.prepare(owner, goal.id);
  const lease = { job_id: job.id, owner: worker_id, fence: 1, expires_at: "2026-10-17T12:01:00.000Z" };
  brain.store.run("UPDATE jobs SET status='running',lease_owner=?,lease_until=?,fence=?,attempts=1 WHERE id=?", lease.owner, lease.expires_at, lease.fence, job.id);
  let attempts = 0;
  const call = new PreparedDecisionProvider({ provider: profile.provider, endpoint: profile.endpoint, model: profile.model,
    accepted_response_models: [...profile.accepted_response_models], key: "SYNTHETIC_CREDENTIAL_NOT_REAL",
    price: { version: profile.price_version, input_micro_usd_per_million: 1000, output_micro_usd_per_million: 0 },
    timeout_ms: profile.timeout_ms, max_request_bytes: profile.max_request_bytes, max_response_bytes: profile.max_response_bytes,
  }, async () => {
    attempts++;
    onFetch?.();
    return Response.json({ model: profile.model, usage: { input_tokens: 500, output_tokens: 0 }, answers: {
      decision: { type: "choice", choice: "related", confidence: 0.9, probabilities: { related: 0.9, abstain: 0.1 } },
    } });
  }).prepareDecision({ state: `SYNTHETIC goal ${goal.id}, entity version ${goal.version}`, instruction: "Choose one permitted option.",
    options: [{ id: "related", description: "Potentially related" }, { id: "abstain", description: "Insufficient evidence" }] });
  const spec = { job_id: job.id, dispatch_key: "decision", stage: "decision" as const,
    reserved_micro_usd: call.identity.reserved_micro_usd, provider: profile.provider, model: profile.model,
    price_version: profile.price_version, request_hash: call.identity.request_hash, config_hash: call.identity.config_hash };
  const coordinator = new ManagedDispatchAccounting(money, brain, clock, installed);
  return { root, runtime, brain, owner, account, money, goal, job, lease, call, spec, coordinator,
    fresh() { return new ManagedDispatchAccounting(money, brain, clock, installed); }, attempts() { return attempts; },
    close() { handle.release(); runtime.close(); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } };
}

it("the real decision coordinator reserves, marks, checks and settles exactly one known synthetic call", async () => {
  const f = fixture();
  try {
    const row = f.coordinator.reserve(f.spec, f.lease, limits);
    f.coordinator.markDispatched(row.call_id, f.lease);
    f.coordinator.assertCanExecute(row.call_id, f.lease);
    const result = await f.call.execute(new AbortController().signal);
    expect(result).toMatchObject({ disposition: "attempted", accounting: { state: "known", cost_micro_usd: 1 }, output: { ok: true } });
    if (result.accounting.state !== "known") throw new Error("Expected synthetic known usage");
    f.coordinator.settle(row.call_id, result.accounting.cost_micro_usd);
    expect(f.money.reservationForSlot(f.account.id, f.job.id, "decision")).toMatchObject({ state: "settled", actual_micro_usd: 1 });
    expect(f.brain.store.get("SELECT state,actual_micro_usd FROM provider_dispatches WHERE call_id=?", row.call_id)).toMatchObject({ state: "settled", actual_micro_usd: 1 });
    expect(f.attempts()).toBe(1);
    expect(() => f.fresh().markDispatched(row.call_id, f.lease)).toThrow();
    expect(() => f.fresh().assertCanExecute(row.call_id, f.lease)).toThrow();
  } finally { f.close(); }
});

it("a goal version change after mark fences I/O without refunding the marked hold", () => {
  const f = fixture();
  try {
    const row = f.coordinator.reserve(f.spec, f.lease, limits);
    f.coordinator.markDispatched(row.call_id, f.lease);
    f.brain.editGoal(f.owner, f.goal.id, { expected_version: f.goal.version, plan: "SYNTHETIC later plan" });
    expect(() => f.coordinator.assertCanExecute(row.call_id, f.lease)).toThrow();
    expect(() => f.coordinator.releaseUndispatched(row.call_id)).toThrow();
    expect(f.money.reservationForSlot(f.account.id, f.job.id, "decision")).toMatchObject({ state: "dispatched", actual_micro_usd: null });
    expect(f.attempts()).toBe(0);
  } finally { f.close(); }
});

it("known usage settles before a mid-I/O goal edit causes output refusal", async () => {
  let edit = () => {};
  const f = fixture(() => edit());
  try {
    edit = () => { f.brain.editGoal(f.owner, f.goal.id, { expected_version: f.goal.version, plan: "SYNTHETIC changed during I/O" }); };
    const row = f.coordinator.reserve(f.spec, f.lease, limits);
    f.coordinator.markDispatched(row.call_id, f.lease);
    f.coordinator.assertCanExecute(row.call_id, f.lease);
    const result = await f.call.execute(new AbortController().signal);
    expect(result.accounting).toMatchObject({ state: "known", cost_micro_usd: 1 });
    if (result.accounting.state !== "known") throw new Error("Expected synthetic known usage");
    const knownCost = result.accounting.cost_micro_usd;
    expect(() => f.coordinator.settle(row.call_id, knownCost)).toThrow();
    expect(f.money.reservationForSlot(f.account.id, f.job.id, "decision")).toMatchObject({ state: "settled", actual_micro_usd: 1 });
    expect(f.brain.store.get("SELECT state,actual_micro_usd FROM provider_dispatches WHERE call_id=?", row.call_id)).toMatchObject({ state: "settled", actual_micro_usd: 1 });
    expect(f.attempts()).toBe(1);
  } finally { f.close(); }
});

it("a managed coordinator without an installed decision policy cannot reserve a decision slot", () => {
  const f = fixture();
  try {
    const coordinator = new ManagedDispatchAccounting(f.money, f.brain, clock);
    expect(() => coordinator.reserve(f.spec, f.lease, limits)).toThrow();
    expect(f.money.reservationForSlot(f.account.id, f.job.id, "decision")).toBeUndefined();
    expect(f.attempts()).toBe(0);
  } finally { f.close(); }
});

it("an adapter pre-abort after durable mark cannot release the call or authorize a restarted coordinator", async () => {
  const f = fixture();
  try {
    const row = f.coordinator.reserve(f.spec, f.lease, limits);
    f.coordinator.markDispatched(row.call_id, f.lease);
    f.coordinator.assertCanExecute(row.call_id, f.lease);
    const controller = new AbortController();
    controller.abort();
    expect(await f.call.execute(controller.signal)).toMatchObject({ disposition: "not_dispatched", accounting: { state: "unknown" } });
    expect(() => f.coordinator.releaseUndispatched(row.call_id)).toThrow();
    expect(() => f.fresh().assertCanExecute(row.call_id, f.lease)).toThrow();
    expect(() => f.fresh().reserve(f.spec, f.lease, limits)).toThrow();
    expect(f.money.reservationForSlot(f.account.id, f.job.id, "decision")).toMatchObject({ state: "dispatched", actual_micro_usd: null });
    expect(f.attempts()).toBe(0);
  } finally { f.close(); }
});

it("withdrawing decision consent after mark prevents I/O while retaining the marked hold", () => {
  const f = fixture();
  try {
    const row = f.coordinator.reserve(f.spec, f.lease, limits);
    f.coordinator.markDispatched(row.call_id, f.lease);
    f.brain.prefs(f.owner, { ...f.brain.prefs(f.owner), decision_provider_enabled: false });
    expect(() => f.coordinator.assertCanExecute(row.call_id, f.lease)).toThrow();
    expect(f.money.reservationForSlot(f.account.id, f.job.id, "decision")).toMatchObject({ state: "dispatched", actual_micro_usd: null });
    expect(f.attempts()).toBe(0);
  } finally { f.close(); }
});

it("the actual tenant lease deadline is re-read rather than trusting a caller's older future deadline", () => {
  const f = fixture();
  try {
    const row = f.coordinator.reserve(f.spec, f.lease, limits);
    f.coordinator.markDispatched(row.call_id, f.lease);
    f.brain.store.run("UPDATE jobs SET lease_until=? WHERE id=?", clock().toISOString(), f.job.id);
    expect(() => f.coordinator.assertCanExecute(row.call_id, f.lease)).toThrow();
    expect(f.money.reservationForSlot(f.account.id, f.job.id, "decision")).toMatchObject({ state: "dispatched", actual_micro_usd: null });
    expect(f.attempts()).toBe(0);
  } finally { f.close(); }
});

it("a lease expiring during I/O refuses the output only after preserving the known charge", async () => {
  let expire = () => {};
  const f = fixture(() => expire());
  try {
    expire = () => { f.brain.store.run("UPDATE jobs SET lease_until=? WHERE id=?", clock().toISOString(), f.job.id); };
    const row = f.coordinator.reserve(f.spec, f.lease, limits);
    f.coordinator.markDispatched(row.call_id, f.lease);
    f.coordinator.assertCanExecute(row.call_id, f.lease);
    const result = await f.call.execute(new AbortController().signal);
    expect(result.accounting).toMatchObject({ state: "known", cost_micro_usd: 1 });
    if (result.accounting.state !== "known") throw new Error("Expected synthetic known usage");
    const knownCost = result.accounting.cost_micro_usd;
    expect(() => f.coordinator.settle(row.call_id, knownCost)).toThrow();
    expect(f.money.reservationForSlot(f.account.id, f.job.id, "decision")).toMatchObject({ state: "settled", actual_micro_usd: 1 });
    expect(f.brain.store.get("SELECT state,actual_micro_usd FROM provider_dispatches WHERE call_id=?", row.call_id)).toMatchObject({ state: "settled", actual_micro_usd: 1 });
    expect(f.attempts()).toBe(1);
  } finally { f.close(); }
});

it("changing the actual job principal after mark invalidates the prepared decision context", () => {
  const f = fixture();
  try {
    const row = f.coordinator.reserve(f.spec, f.lease, limits);
    f.coordinator.markDispatched(row.call_id, f.lease);
    f.brain.store.run("UPDATE jobs SET payload=? WHERE id=?", JSON.stringify({
      goal_id: f.goal.id, principal: { kind: "owner", tenantId: randomUUID() }, manual: true,
    }), f.job.id);
    expect(() => f.coordinator.assertCanExecute(row.call_id, f.lease)).toThrow();
    expect(f.money.reservationForSlot(f.account.id, f.job.id, "decision")).toMatchObject({ state: "dispatched", actual_micro_usd: null });
    expect(f.attempts()).toBe(0);
  } finally { f.close(); }
});
