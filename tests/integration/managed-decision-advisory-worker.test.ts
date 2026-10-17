import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Worker } from "../../apps/worker/engine.ts";
import { ManagedDispatchAccounting } from "../../apps/worker/managed-accounting.ts";
import { ManagedRuntime, managedCapability, managedDecisionCapability } from "../../packages/runtime/managed.ts";
import { ManagedSpendingStore } from "../../packages/storage/managed-spending.ts";
import { ManagedReconciliationStore } from "../../packages/storage/managed-reconciliation.ts";
import { ManagedActivationStore } from "../../packages/storage/managed-activation.ts";
import { ManagedDecisionActivationStore } from "../../packages/storage/managed-decision-activation.ts";
import { auditManagedHistory } from "../../packages/runtime/managed-audit.ts";
import { installDecisionPolicy } from "../../packages/runtime/managed-activation.ts";
import { writeWorkerReadiness } from "../../packages/runtime/worker-readiness.ts";
import { writeDecisionReadiness } from "../../packages/runtime/decision-worker-readiness.ts";
import { PreparedReasoningProvider } from "../../packages/providers/prepared.ts";
import { PreparedDecisionProvider } from "../../packages/providers/prepared-decision.ts";
import { runDecisionAdvisory } from "../../apps/worker/decision-advisory.ts";

const clock = () => new Date("2026-10-17T12:00:00.000Z");
const ack = { offline: true as const, workers_terminated: true as const };
type Mode = "normal" | "unknown-decision" | "malformed-decision" | "unknown-reasoning";
type Choice = "related" | "unrelated" | "abstain";
afterEach(() => vi.unstubAllEnvs());

/**
 * Executor fixture (independent of the parent *-review suite): actual profiles,
 * own decision/reasoning readiness, account-bound central money and the real
 * `Worker`. Only the two HTTP responses and the prices are synthetic; no API is
 * stubbed to grant permission and neither fetch may run inside a transaction.
 */
async function fixture(choice: Choice = "related", mode: Mode = "normal") {
  vi.stubEnv("BRAIN_MANAGED_ALLOW_PAID", "1");
  const root = mkdtempSync(join(tmpdir(), "brain-advisory-worker-own-"));
  const runtime: ManagedRuntime = new ManagedRuntime(root, { clock,
    capability: () => { const c = managedCapability({ control: runtime.control, root, now: clock(), optIn: true }); return { ready: c.available, reason: c.reason }; },
    decisionCapability: () => { const c = managedDecisionCapability({ control: runtime.control, root, now: clock(), optIn: true }); return { ready: c.available, reason: c.reason }; },
  });
  const a = runtime.provision("https://issuer.synthetic.test", "advisory-own-a");
  const b = runtime.provision("https://issuer.synthetic.test", "advisory-own-b");
  const money = new ManagedSpendingStore(runtime.control, clock);
  money.setServicePolicy({ daily_micro_usd: 1_000_000 });
  for (const account of [a, b]) {
    money.setAccountPolicy({ account_id: account.id, per_job_micro_usd: 100_000, user_daily_micro_usd: 1_000_000 });
    money.configureAccountPeriod({ account_id: account.id, starts_at: "2026-10-17T00:00:00Z", ends_at: "2026-10-18T00:00:00Z", allowance_micro_usd: 1_000_000 });
  }
  new ManagedReconciliationStore(runtime.control, root, clock).initEpoch(ack);
  const audit = auditManagedHistory({ runtime, root, ...ack, clock });
  expect(audit.ok).toBe(true);
  const d = new ManagedDecisionActivationStore(runtime.control, root, clock).enable({ provider: "typesafe",
    model: "jev-synthetic-v1", endpoint: "https://api.typesafe.ai/v1/systemone", accepted_response_models: ["jev-synthetic-v1"],
    price_version: "synthetic-decision-price-v1", input_micro_usd_per_million: 10_000, output_micro_usd_per_million: 0,
    timeout_ms: 1000, max_request_bytes: 1_048_576, max_response_bytes: 262_144, audit_id: audit.audit_id!, expected_version: 0 }, ack);
  const r = new ManagedActivationStore(runtime.control, root, clock).enable({ provider: "openai", model: "synthetic-reasoning-v1",
    accepted_response_models: ["synthetic-reasoning-v1"], price_version: "synthetic-reasoning-price-v1", input_micro_usd_per_million: 10_000,
    output_micro_usd_per_million: 10_000, max_output_tokens: 100, endpoint_class: "openai_responses", audit_id: audit.audit_id!, expected_version: 0 }, ack);
  const bootId = randomUUID();
  const dates = { booted_at: clock().toISOString(), heartbeat_at: clock().toISOString(), expires_at: "2026-10-17T12:00:15.000Z" };
  writeDecisionReadiness(root, { schema: 1, worker_id: bootId, stage_scope: "decision", provider_family: d.provider,
    endpoint_digest: d.endpoint_digest, epoch: d.epoch, root_nonce: d.root_nonce, activation_fingerprint: d.fingerprint,
    config_digest: d.config_digest, model: d.model, price_version: d.price_version, ...dates }, clock);
  writeWorkerReadiness(root, { schema: 1, worker_id: bootId, epoch: r.epoch, root_nonce: r.root_nonce,
    activation_fingerprint: r.fingerprint, config_digest: r.config_digest, provider: r.provider, model: r.model,
    price_version: r.price_version, endpoint_class: r.endpoint_class, ...dates });
  const handle = runtime.acquire(a.id), brain = handle.brain, owner = brain.ownerPrincipal();
  const capture = brain.capture(owner, { title: "SYNTHETIC release evidence", body: "SYNTHETIC_BETA_EVIDENCE: users need a simple beta.", visibility: "project" });
  brain.capture(owner, { title: "SYNTHETIC personal detail", body: "SYNTHETIC_PRIVATE_NOT_FOR_ANY_PROVIDER", visibility: "private" });
  const seed = new Worker(brain);
  while (await seed.tick()) { /* extractive derivations only */ }
  const source = brain.source(owner, capture.source_id);
  const created = brain.goal(owner, { project_id: "inbox", title: "SYNTHETIC ship beta", success_criteria: "Review the beta evidence" });
  const goal = brain.editGoal(owner, created.id, { expected_version: created.version, preparation_enabled: true });
  brain.prefs(owner, { ...brain.prefs(owner), enabled: true, provider_enabled: true, decision_provider_enabled: true,
    time_zone: "UTC", per_job_cap_micro_usd: 100_000, daily_cap_micro_usd: 1_000_000 });
  const job = brain.prepare(owner, goal.id);
  const stats = { decision: 0, reasoning: 0 };
  const dp = new PreparedDecisionProvider({ provider: d.provider, endpoint: d.endpoint, model: d.model,
    accepted_response_models: [...d.accepted_response_models], price: { version: d.price_version, input_micro_usd_per_million: 10_000, output_micro_usd_per_million: 0 },
    key: "SYNTHETIC_TEST_ONLY_DECISION_KEY", timeout_ms: d.timeout_ms, max_request_bytes: d.max_request_bytes, max_response_bytes: d.max_response_bytes,
  }, async () => {
    expect(brain.store.db.isTransaction).toBe(false);
    expect(runtime.control.db.isTransaction).toBe(false);
    stats.decision++;
    const probabilities = { related: 0.1, unrelated: 0.1, abstain: 0.1 }; probabilities[choice] = 0.8;
    return Response.json({ model: d.model, ...(mode === "unknown-decision" ? {} : { usage: { input_tokens: 700, output_tokens: 0 } }),
      answers: { decision: { type: "choice", choice: mode === "malformed-decision" ? "grant_permission" : choice, confidence: 0.8, probabilities } } });
  });
  const rp = new PreparedReasoningProvider({ model: r.model, accepted_response_models: [...r.accepted_response_models],
    key: "SYNTHETIC_TEST_ONLY_REASONING_KEY", max_output_tokens: r.max_output_tokens,
    price: { version: r.price_version, input_micro_usd_per_million: 10_000, output_micro_usd_per_million: 10_000 },
  }, async () => {
    expect(brain.store.db.isTransaction).toBe(false);
    stats.reasoning++;
    return Response.json({ model: r.model, ...(mode === "unknown-reasoning" ? {} : { usage: { input_tokens: 100, output_tokens: 0 } }),
      output: [{ content: [{ type: "output_text", text: JSON.stringify({ outcome: "proposal", artifact: "SYNTHETIC next beta experiment",
        evidence: [{ source_id: source.id, source_version: source.version, start: 0, end: 23, quote: source.body.slice(0, 23) }] }) }] }] });
  });
  const decisionAccounting = new ManagedDispatchAccounting(money, brain, clock, installDecisionPolicy({ root, profile: d, worker_id: bootId, optIn: true }));
  const makeWorker = () => new Worker(brain, rp, new ManagedDispatchAccounting(money, brain, clock, { root, profile: r }), { decisionAccounting, decisionProvider: dp });
  const stages = () => brain.store.all("SELECT * FROM provider_dispatches WHERE job_id=? ORDER BY stage", job.id) as any[];
  const advisories = () => brain.store.all("SELECT * FROM entities WHERE kind='advisory'").map((e: any) => ({ ...e, data: JSON.parse(e.data) })) as any[];
  const receipt = () => brain.entities(owner, "receipt").find((e) => e.data.job_id === job.id);
  const dream = () => readFileSync(join(brain.store.vault!.root, "generations", brain.store.setting<string>("vault_generation", ""), "dreams", "2026-10-17.md"), "utf8");
  return { root, runtime, a, b, brain, owner, sourceId: capture.source_id, goal, job, stats, makeWorker, decisionAccounting, dp, stages, advisories, receipt, dream,
    close() { handle.release(); runtime.close(); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } };
}

it("runs one real decision then one reasoning stage on one job with a combined known cost", async () => {
  const f = await fixture("related");
  try {
    expect(await f.makeWorker().tick()).toBe(true);
    expect(f.stats).toMatchObject({ decision: 1, reasoning: 1 });
    expect(f.stages()).toMatchObject([
      { stage: "decision", dispatch_key: "decision", state: "settled", actual_micro_usd: 7 },
      { stage: "reasoning", dispatch_key: "reasoning", state: "settled", actual_micro_usd: 1 },
    ]);
    // The reasoning pass revises the goal, so the decision advisory is withdrawn.
    expect(f.advisories()).toHaveLength(1);
    expect(f.advisories()[0].data).toMatchObject({ epistemic_status: "hypothesis", status: "withdrawn", judgment: { choice: "related" } });
    expect(f.brain.decisionAdvisoriesForGoal(f.owner, f.goal.id)).toEqual([]);
    expect(f.receipt()?.data.cost_micro_usd).toBe(8);
    expect(f.brain.entities(f.owner, "proposal")).toHaveLength(1);
    expect(f.dream()).toMatch(/Cost \(micro USD\): 8(?:\D|$)/);
  } finally { f.close(); }
}, 30_000);

it("retains an unknown decision hold, never runs reasoning, and never resends the question", async () => {
  const f = await fixture("related", "unknown-decision");
  try {
    await f.makeWorker().tick();
    expect(f.stats).toMatchObject({ decision: 1, reasoning: 0 });
    expect(f.stages()).toMatchObject([{ stage: "decision", state: "dispatched", actual_micro_usd: null }]);
    expect(f.advisories()).toEqual([]);
    // A second tick cannot resend the same question (existing claimed attempt).
    await f.makeWorker().tick();
    expect(f.stats).toMatchObject({ decision: 1, reasoning: 0 });
    // Another account's unpaid extractive work is unaffected by the shared barrier.
    const second = f.runtime.acquire(f.b.id);
    try {
      const brain = second.brain, owner = brain.ownerPrincipal();
      brain.capture(owner, { title: "SYNTHETIC unpaid", body: "SYNTHETIC_UNPAID_CONTINUES" });
      expect(await new Worker(brain).tick()).toBe(true);
      expect(brain.sources(owner, "inbox").some((s) => s.body.includes("SYNTHETIC_UNPAID_CONTINUES"))).toBe(true);
    } finally { second.release(); }
  } finally { f.close(); }
}, 30_000);

it("stores a known malformed decision as unavailable with the charge retained and reasoning still runs", async () => {
  const f = await fixture("related", "malformed-decision");
  try {
    await f.makeWorker().tick();
    expect(f.stats).toMatchObject({ decision: 1, reasoning: 1 });
    expect(f.stages()).toMatchObject([{ stage: "decision", state: "settled", actual_micro_usd: 7 }, { stage: "reasoning", state: "settled", actual_micro_usd: 1 }]);
    expect(f.advisories()).toHaveLength(1);
    expect(f.advisories()[0].data.judgment).toBeNull();
    expect(["unavailable", "withdrawn"]).toContain(f.advisories()[0].data.status);
  } finally { f.close(); }
}, 30_000);

it("reports the WHOLE job cost as unknown (never zero or the decision subtotal) when reasoning usage is unknown", async () => {
  const f = await fixture("related", "unknown-reasoning");
  try {
    await f.makeWorker().tick();
    expect(f.stats).toMatchObject({ decision: 1, reasoning: 1 });
    expect(f.stages()).toMatchObject([{ stage: "decision", state: "settled", actual_micro_usd: 7 }, { stage: "reasoning", state: "dispatched", actual_micro_usd: null }]);
    expect(f.receipt()?.data.cost_micro_usd).toBeNull();
    expect(f.receipt()?.data.usage_status).toBe("unknown");
    // Only THIS job's rendered run must never print a zero/false subtotal.
    const run = f.dream().split(`## Run ${f.job.id}`)[1]?.split("## Run ")[0];
    expect(run).toBeTruthy();
    expect(run).toMatch(/Cost \(micro USD\): unknown/i);
    expect(run).not.toMatch(/Cost \(micro USD\): 0(?:\D|$)/);
  } finally { f.close(); }
}, 30_000);

it("keeps a legitimate known zero cost as zero and performs no decision call when master consent is off", async () => {
  const f = await fixture();
  try {
    // Master paid consent off: neither the decision nor the reasoning stage runs.
    f.brain.prefs(f.owner, { ...f.brain.prefs(f.owner), provider_enabled: false });
    await f.makeWorker().tick();
    expect(f.stats).toMatchObject({ decision: 0, reasoning: 0 });
    expect(f.stages()).toEqual([]);
    // The earlier extractive (unpaid) receipts still render a legitimate known 0.
    expect(f.dream()).toMatch(/Cost \(micro USD\): 0(?:\D|$)/);
  } finally { f.close(); }
}, 30_000);

it("skips the decision stage with a static reason and makes no provider call when consent is absent", async () => {
  const f = await fixture();
  try {
    f.brain.prefs(f.owner, { ...f.brain.prefs(f.owner), decision_provider_enabled: false });
    const result = await runDecisionAdvisory(
      { brain: f.brain, accounting: f.decisionAccounting, provider: f.dp, owner: f.owner },
      f.job as any,
      new Worker(f.brain).id,
      new AbortController().signal,
    );
    expect(result).toEqual({ status: "skipped", reason: "not_opted_in" });
    expect(f.stats.decision).toBe(0);
  } finally { f.close(); }
}, 30_000);

it("creates no financial row when the source turns private after the claim but before reserve", async () => {
  const f = await fixture();
  try {
    const original = f.brain.claimDecisionAdvisory.bind(f.brain);
    (f.brain as any).claimDecisionAdvisory = (...args: any[]) => {
      const result = (original as any)(...args);
      const source = f.brain.source(f.owner, f.sourceId);
      f.brain.editSource(f.owner, source.id, { expected_version: source.version, title: source.title, body: source.body, visibility: "private" });
      return result;
    };
    await f.makeWorker().tick();
    expect(f.stats.decision).toBe(0);
    expect(f.stages()).toEqual([]);
    expect(f.advisories()).toEqual([]);
  } finally { f.close(); }
}, 30_000);

it("releases the reserved decision hold when the source turns private after reserve but before the mark", async () => {
  const f = await fixture();
  try {
    const original = f.decisionAccounting.reserve.bind(f.decisionAccounting);
    (f.decisionAccounting as any).reserve = (...args: any[]) => {
      const record = (original as any)(...args);
      const source = f.brain.source(f.owner, f.sourceId);
      f.brain.editSource(f.owner, source.id, { expected_version: source.version, title: source.title, body: source.body, visibility: "private" });
      return record;
    };
    await f.makeWorker().tick();
    expect(f.stats.decision).toBe(0);
    expect(f.stages()).toMatchObject([{ stage: "decision", state: "released", actual_micro_usd: null }]);
    expect(f.advisories()).toEqual([]);
  } finally { f.close(); }
}, 30_000);

it("adopts a settled published decision on a new job without any new decision call or financial row", async () => {
  const f = await fixture();
  try {
    // First attempt: the reasoning prepare fails before reserve, leaving a settled
    // and published decision attempt on the original job.
    const worker = f.makeWorker();
    const reasoningProvider = (worker as any).provider;
    const originalPrepare = reasoningProvider.prepareCall.bind(reasoningProvider);
    let first = true;
    reasoningProvider.prepareCall = (input: any) => {
      if (first) {
        first = false;
        throw new Error("SYNTHETIC reasoning prepare failure");
      }
      return originalPrepare(input);
    };
    await worker.tick();
    expect(f.stats).toMatchObject({ decision: 1, reasoning: 0 });
    expect(f.advisories()).toHaveLength(1);
    const originalDecisionJob = f.job.id;

    // A NEW review job for the same goal/question, leased by a future worker.
    const next = f.brain.prepare(f.owner, f.goal.id);
    expect(next.id).not.toBe(originalDecisionJob);
    await f.makeWorker().tick();
    // No new decision call or row; the original settled decision slot is untouched.
    expect(f.stats.decision).toBe(1);
    const decisionRows = f.stages().filter((r: any) => r.stage === "decision");
    expect(decisionRows).toHaveLength(1);
    expect(decisionRows[0]).toMatchObject({ job_id: originalDecisionJob, state: "settled", actual_micro_usd: 7 });
  } finally { f.close(); }
}, 30_000);

it("publishes no advisory when the known central decision settlement commits but its tenant projection fails", async () => {
  const f = await fixture();
  try {
    // A genuine tenant SQL trigger: the decision settle projection aborts while the
    // central settlement still commits. No accounting is mocked.
    f.brain.store.db.exec(
      `CREATE TRIGGER block_decision_settle BEFORE UPDATE ON provider_dispatches
       WHEN OLD.stage='decision' AND OLD.state='dispatched' AND NEW.state='settled'
       BEGIN SELECT RAISE(ABORT, 'SYNTHETIC tenant decision projection failure'); END;`,
    );
    await f.makeWorker().tick();
    expect(f.stats).toMatchObject({ decision: 1, reasoning: 0 });
    // Tenant projection is still dispatched/null; no advisory is published.
    expect(f.stages()).toMatchObject([{ stage: "decision", state: "dispatched", actual_micro_usd: null }]);
    expect(f.advisories()).toEqual([]);
    // The known central charge remains settled, with a reconciliation block.
    const central = f.decisionAccounting.receiptForSlot(f.job.id, "decision");
    expect(central).toMatchObject({ state: "settled", actual_micro_usd: 7 });
  } finally { f.close(); }
}, 30_000);
