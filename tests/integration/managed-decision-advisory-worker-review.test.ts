import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Worker } from "../../apps/worker/engine.ts";
import { ManagedWorker } from "../../apps/worker/managed.ts";
import { runDecisionAdvisory } from "../../apps/worker/decision-advisory.ts";
import { ManagedDispatchAccounting } from "../../apps/worker/managed-accounting.ts";
import { ManagedRuntime, managedCapability, managedDecisionCapability } from "../../packages/runtime/managed.ts";
import { ManagedSpendingStore, AccountingPersistenceError } from "../../packages/storage/managed-spending.ts";
import { ManagedReconciliationStore } from "../../packages/storage/managed-reconciliation.ts";
import { ManagedActivationStore } from "../../packages/storage/managed-activation.ts";
import { ManagedDecisionActivationStore } from "../../packages/storage/managed-decision-activation.ts";
import { auditManagedHistory } from "../../packages/runtime/managed-audit.ts";
import { installDecisionPolicy } from "../../packages/runtime/managed-activation.ts";
import { writeWorkerReadiness } from "../../packages/runtime/worker-readiness.ts";
import { writeDecisionReadiness } from "../../packages/runtime/decision-worker-readiness.ts";
import { PreparedReasoningProvider } from "../../packages/providers/prepared.ts";
import { PreparedDecisionProvider } from "../../packages/providers/prepared-decision.ts";
import { expectedDecisionInput } from "../../packages/domain/decision-advisory.ts";
import { BrainError } from "../../packages/domain/logic.ts";

const clock = () => new Date("2026-10-17T12:00:00.000Z");
const ack = { offline: true as const, workers_terminated: true as const };
type Mode = "normal" | "unknown-decision" | "malformed-decision" | "unknown-reasoning";
type Choice = "related" | "unrelated" | "abstain";
afterEach(() => vi.unstubAllEnvs());

// Independent fixture: actual profiles, own readiness, account-bound money,
// production adapters and Worker. Only HTTP responses and prices are synthetic.
// No API is stubbed to grant permission; neither fetch may enter a transaction.
async function fixture(choice: Choice = "related", mode: Mode = "normal") {
  vi.stubEnv("BRAIN_MANAGED_ALLOW_PAID", "1");
  const root = mkdtempSync(join(tmpdir(), "brain-advisory-worker-parent-"));
  const runtime: ManagedRuntime = new ManagedRuntime(root, { clock,
    capability: () => { const c = managedCapability({ control: runtime.control, root, now: clock(), optIn: true }); return { ready: c.available, reason: c.reason }; },
    decisionCapability: () => { const c = managedDecisionCapability({ control: runtime.control, root, now: clock(), optIn: true }); return { ready: c.available, reason: c.reason }; },
  });
  const a = runtime.provision("https://issuer.synthetic.test", "advisory-worker-a");
  const b = runtime.provision("https://issuer.synthetic.test", "advisory-worker-b");
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
  const privateId = brain.capture(owner, { title: "SYNTHETIC personal detail", body: "SYNTHETIC_PRIVATE_NOT_FOR_ANY_PROVIDER", visibility: "private" }).source_id;
  // Seed through the real unpaid worker, so paid brief work cannot mask the
  // later goal-review assertions or compete with the one review job.
  const seed = new Worker(brain);
  while (await seed.tick()) { /* Two bounded extractive derivations. */ }
  const source = brain.source(owner, capture.source_id);
  const created = brain.goal(owner, { project_id: "inbox", title: "SYNTHETIC ship beta", success_criteria: "Review the beta evidence" });
  const goal = brain.editGoal(owner, created.id, { expected_version: created.version, preparation_enabled: true });
  brain.prefs(owner, { ...brain.prefs(owner), enabled: true, provider_enabled: true, decision_provider_enabled: true,
    time_zone: "UTC", per_job_cap_micro_usd: 100_000, daily_cap_micro_usd: 1_000_000 });
  const job = brain.prepare(owner, goal.id);
  const stats = { decision: 0, reasoning: 0, decisionInputTokens: 700, decisionState: "", reasoningRequest: "", duringDecision: () => {}, duringReasoning: () => {}, afterDecisionClaim: () => {}, afterDecisionReserve: () => {}, afterDecisionMark: () => {} };
  const originalClaim = brain.claimDecisionAdvisory.bind(brain);
  brain.claimDecisionAdvisory = (...args) => {
    const claimed = originalClaim(...args);
    stats.afterDecisionClaim();
    return claimed;
  };
  function checkSend(stage: string) {
    expect(brain.store.db.isTransaction).toBe(false);
    expect(runtime.control.db.isTransaction).toBe(false);
    expect(brain.store.get("SELECT state FROM provider_dispatches WHERE job_id=? AND dispatch_key=?", job.id, stage)?.state).toBe("dispatched");
  }
  const dp = new PreparedDecisionProvider({ provider: d.provider, endpoint: d.endpoint, model: d.model,
    accepted_response_models: [...d.accepted_response_models], price: { version: d.price_version, input_micro_usd_per_million: 10_000, output_micro_usd_per_million: 0 },
    key: "SYNTHETIC_TEST_ONLY_DECISION_KEY", timeout_ms: d.timeout_ms, max_request_bytes: d.max_request_bytes, max_response_bytes: d.max_response_bytes,
  }, async (url, init) => {
    expect(String(url)).toBe("https://api.typesafe.ai/v1/systemone"); checkSend("decision");
    stats.decision++; stats.decisionState = String(init?.body); stats.duringDecision();
    const probabilities = { related: 0.1, unrelated: 0.1, abstain: 0.1 }; probabilities[choice] = 0.8;
    return Response.json({ model: d.model, ...(mode === "unknown-decision" ? {} : { usage: { input_tokens: stats.decisionInputTokens, output_tokens: 0 } }),
      answers: { decision: { type: "choice", choice: mode === "malformed-decision" ? "grant_permission" : choice, confidence: 0.8, probabilities } } });
  });
  const rp = new PreparedReasoningProvider({ model: r.model, accepted_response_models: [...r.accepted_response_models],
    key: "SYNTHETIC_TEST_ONLY_REASONING_KEY", max_output_tokens: r.max_output_tokens,
    price: { version: r.price_version, input_micro_usd_per_million: 10_000, output_micro_usd_per_million: 10_000 },
  }, async (url, init) => {
    expect(String(url)).toBe("https://api.openai.com/v1/responses"); checkSend("reasoning");
    stats.reasoning++; stats.reasoningRequest = String(init?.body); stats.duringReasoning();
    return Response.json({ model: r.model, ...(mode === "unknown-reasoning" ? {} : { usage: { input_tokens: 100, output_tokens: 0 } }),
      output: [{ content: [{ type: "output_text", text: JSON.stringify({ outcome: "proposal", artifact: "SYNTHETIC next beta experiment",
        evidence: [{ source_id: source.id, source_version: source.version, start: 0, end: 23, quote: source.body.slice(0, 23) }] }) }] }] });
  });
  const newDecisionAccounting = () => {
    const decisionAccounting = new ManagedDispatchAccounting(money, brain, clock, installDecisionPolicy({ root, profile: d, worker_id: bootId, optIn: true }));
    const reserve = decisionAccounting.reserve.bind(decisionAccounting);
    decisionAccounting.reserve = (...args) => {
      const record = reserve(...args);
      stats.afterDecisionReserve();
      return record;
    };
    const mark = decisionAccounting.markDispatched.bind(decisionAccounting);
    decisionAccounting.markDispatched = (...args) => {
      const record = mark(...args); // Real central AND tenant marks first.
      stats.afterDecisionMark();
      return record;
    };
    return decisionAccounting;
  };
  const makeWorker = () => {
    return new Worker(brain, rp, new ManagedDispatchAccounting(money, brain, clock, { root, profile: r }), {
      decisionAccounting: newDecisionAccounting(), decisionProvider: dp,
    });
  };
  function stages() { return brain.store.all("SELECT * FROM provider_dispatches WHERE job_id=? ORDER BY stage", job.id); }
  function advisories() { return brain.store.all<{ id: string; data: string }>("SELECT * FROM entities WHERE kind='advisory'").map((e) => ({ ...e, data: JSON.parse(e.data) })); }
  function receipt() { return brain.entities(owner, "receipt").find((e) => e.data.job_id === job.id); }
  return { root, runtime, a, b, brain, owner, source, privateId, goal, job, stats, makeWorker, stages, advisories, receipt,
    decisionProvider: dp, reasoningProvider: rp, newDecisionAccounting,
    reasoningBootstrap: { root, profile: r },
    decisionBootstrap: installDecisionPolicy({ root, profile: d, worker_id: bootId, optIn: true }),
    close() { handle.release(); runtime.close(); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } };
}

it.each(["related", "unrelated", "abstain"] as const)("runs one actual D then R on one job without letting %s suppress reasoning", async (choice) => {
  const f = await fixture(choice);
  try {
    expect(await f.makeWorker().tick()).toBe(true);
    expect(f.stats).toMatchObject({ decision: 1, reasoning: 1 });
    expect(f.stats.decisionState).toContain("SYNTHETIC_BETA_EVIDENCE");
    expect(f.stats.decisionState).not.toContain("SYNTHETIC_PRIVATE_NOT_FOR_ANY_PROVIDER");
    expect(f.stats.reasoningRequest).not.toContain("SYNTHETIC_PRIVATE_NOT_FOR_ANY_PROVIDER");
    expect(f.stages()).toMatchObject([{ stage: "decision", state: "settled", actual_micro_usd: 7 }, { stage: "reasoning", state: "settled", actual_micro_usd: 1 }]);
    expect(f.advisories()).toHaveLength(1);
    expect(f.advisories()[0].data).toMatchObject({ epistemic_status: "hypothesis", judgment: { choice }, status: "withdrawn" });
    expect(f.receipt()?.data.cost_micro_usd).toBe(8);
    expect(f.brain.entities(f.owner, "proposal")).toHaveLength(1);
    expect(f.brain.decisionAdvisoriesForGoal(f.owner, f.goal.id)).toEqual([]);
  } finally { f.close(); }
}, 30_000);

it("keeps both known charges but publishes no advisory after decision consent is withdrawn during I/O", async () => {
  const f = await fixture();
  try {
    f.stats.duringDecision = () => f.brain.prefs(f.owner, { ...f.brain.prefs(f.owner), decision_provider_enabled: false });
    await f.makeWorker().tick();
    expect(f.stats).toMatchObject({ decision: 1, reasoning: 1 });
    expect(f.stages()).toMatchObject([{ stage: "decision", state: "settled", actual_micro_usd: 7 }, { stage: "reasoning", state: "settled", actual_micro_usd: 1 }]);
    expect(f.advisories()).toEqual([]);
    expect(f.brain.entities(f.owner, "proposal")).toHaveLength(1);
    expect(f.receipt()?.data.cost_micro_usd).toBe(8);
  } finally { f.close(); }
}, 30_000);

it("known malformed decision output cannot become a fact or suppress independently authorized reasoning", async () => {
  const f = await fixture("related", "malformed-decision");
  try {
    await f.makeWorker().tick();
    expect(f.stats).toMatchObject({ decision: 1, reasoning: 1 });
    expect(f.stages()).toMatchObject([{ stage: "decision", actual_micro_usd: 7 }, { stage: "reasoning", actual_micro_usd: 1 }]);
    expect(f.advisories()).toHaveLength(1);
    expect(f.advisories()[0].data.judgment).toBeNull();
    expect(["unavailable", "withdrawn"]).toContain(f.advisories()[0].data.status);
    expect(f.brain.entities(f.owner, "proposal")).toHaveLength(1);
  } finally { f.close(); }
}, 30_000);

it("retains an overrun charge but does not publish its advisory or start another paid stage", async () => {
  const f = await fixture();
  try {
    f.stats.decisionInputTokens = 100_000; // Exactly 1000 synthetic micro-USD; exceeds the frozen bound.
    await f.makeWorker().tick();
    expect(f.stats).toMatchObject({ decision: 1, reasoning: 0 });
    expect(f.stages()).toMatchObject([{ stage: "decision", state: "settled", actual_micro_usd: 1000 }]);
    // The adapter may retain an explicitly unavailable/null observation for
    // rejected bounded output; it must not expose an accepted judgment.
    expect(f.brain.decisionAdvisoriesForGoal(f.owner, f.goal.id)).toEqual([]);
    expect(f.advisories().every((e) => e.data.judgment === null)).toBe(true);
    expect(f.brain.entities(f.owner, "proposal")).toEqual([]);
  } finally { f.close(); }
}, 30_000);

it("does not publish when known decision settlement committed centrally but its tenant projection failed", async () => {
  const f = await fixture();
  try {
    // Real tenant SQL failure; the central coordinator must still retain known
    // cost and its reconciliation block. No accounting method is mocked out.
    f.brain.store.db.exec("CREATE TRIGGER synthetic_block_decision_settle BEFORE UPDATE ON provider_dispatches WHEN OLD.stage='decision' AND NEW.state='settled' BEGIN SELECT RAISE(ABORT,'SYNTHETIC tenant settlement failure'); END;");
    await f.makeWorker().tick();
    expect(f.stats).toMatchObject({ decision: 1, reasoning: 0 });
    expect(f.stages()).toMatchObject([{ stage: "decision", state: "dispatched", actual_micro_usd: null }]);
    expect(f.newDecisionAccounting().receiptForSlot(f.job.id, "decision")).toMatchObject({ state: "settled", actual_micro_usd: 7 });
    expect(f.advisories()).toEqual([]);
    expect(f.brain.entities(f.owner, "proposal")).toEqual([]);
  } finally { f.close(); }
}, 30_000);

it("a real decision settlement and safety-marker failure fail-stops the managed scheduler instead of continuing to R", async () => {
  const f = await fixture();
  const worker = new ManagedWorker(f.runtime, { bootstrap: f.reasoningBootstrap,
    providerFactory: () => f.reasoningProvider, decisionBootstrap: f.decisionBootstrap,
    decisionProviderFactory: () => f.decisionProvider });
  try {
    f.runtime.control.db.exec("CREATE TRIGGER synthetic_settlement_fault BEFORE UPDATE OF state ON managed_reservations WHEN NEW.state='settled' BEGIN SELECT RAISE(ABORT,'SYNTHETIC decision settlement fault'); END;");
    f.runtime.control.db.exec("CREATE TRIGGER synthetic_marker_fault BEFORE INSERT ON managed_money_blocks BEGIN SELECT RAISE(ABORT,'SYNTHETIC safety marker fault'); END;");
    await expect(worker.tick()).rejects.toBeInstanceOf(AccountingPersistenceError);
    expect(f.stats).toMatchObject({ decision: 1, reasoning: 0 });
    expect(f.advisories()).toEqual([]);
    // Even after writes recover, this scheduler instance must remain stopped.
    f.runtime.control.db.exec("DROP TRIGGER synthetic_settlement_fault; DROP TRIGGER synthetic_marker_fault;");
    expect(await worker.tick()).toBe(false);
    expect(f.stats).toMatchObject({ decision: 1, reasoning: 0 });
    expect(f.brain.sources(f.owner, "inbox").some((s) => s.id === f.source.id)).toBe(true);
  } finally { await worker.stop(); f.close(); }
}, 30_000);

it("a source made private after the durable mark but before I/O is never sent and its marked hold is not released", async () => {
  const f = await fixture();
  try {
    f.stats.afterDecisionMark = () => {
      const source = f.brain.source(f.owner, f.source.id);
      f.brain.editSource(f.owner, source.id, { expected_version: source.version, title: source.title, body: source.body, visibility: "private" });
    };
    await f.makeWorker().tick();
    expect(f.stats).toMatchObject({ decision: 0, reasoning: 0 });
    expect(f.stages()).toMatchObject([{ stage: "decision", state: "dispatched", actual_micro_usd: null }]);
    expect(f.advisories()).toEqual([]);
    expect(f.brain.entities(f.owner, "proposal")).toEqual([]);
  } finally { f.close(); }
}, 30_000);

it("rejects a changed authorized source set before reserving any decision money", async () => {
  const f = await fixture();
  try {
    f.stats.afterDecisionClaim = () => {
      const source = f.brain.source(f.owner, f.source.id);
      f.brain.editSource(f.owner, source.id, { expected_version: source.version, title: source.title, body: source.body, visibility: "private" });
    };
    await f.makeWorker().tick();
    expect(f.stats).toMatchObject({ decision: 0, reasoning: 0 });
    expect(f.stages()).toEqual([]);
    expect(f.advisories()).toEqual([]);
  } finally { f.close(); }
}, 30_000);

it("releases an undispatched decision reservation when source privacy changed before the mark", async () => {
  const f = await fixture();
  try {
    f.stats.afterDecisionReserve = () => {
      const source = f.brain.source(f.owner, f.source.id);
      f.brain.editSource(f.owner, source.id, { expected_version: source.version, title: source.title, body: source.body, visibility: "private" });
    };
    await f.makeWorker().tick();
    expect(f.stats).toMatchObject({ decision: 0, reasoning: 0 });
    expect(f.stages()).toMatchObject([{ stage: "decision", state: "released", actual_micro_usd: null }]);
    expect(f.advisories()).toEqual([]);
  } finally { f.close(); }
}, 30_000);

it("recovers a published current advisory using its original job's known financial slot, never by sending D again", async () => {
  const f = await fixture();
  try {
    f.reasoningProvider.prepareCall = () => { throw new BrainError("PROVIDER_UNAVAILABLE", "SYNTHETIC before-reserve outage", 503); };
    await f.makeWorker().tick();
    expect(f.stats).toMatchObject({ decision: 1, reasoning: 0 });
    expect(f.stages()).toMatchObject([{ stage: "decision", state: "settled", actual_micro_usd: 7 }]);
    const published = f.advisories()[0];
    expect(published.data.status).toBe("advisory");
    const successor = f.brain.prepare(f.owner, f.goal.id), next = f.makeWorker();
    const leased = next.lease();
    expect(leased?.id).toBe(successor.id);
    const accounting = f.newDecisionAccounting(), readSlot = accounting.receiptForSlot.bind(accounting), queried: string[] = [];
    accounting.receiptForSlot = (jobId, key) => { queried.push(jobId); return readSlot(jobId, key); };
    const recovered = await runDecisionAdvisory({ brain: f.brain, owner: f.owner, accounting, provider: f.decisionProvider },
      { id: successor.id, fence: leased!.fence }, next.id, new AbortController().signal);
    expect(recovered).toEqual({ status: "advisory", advisory_id: published.id });
    expect(queried).toContain(f.job.id);
    expect(f.stats).toMatchObject({ decision: 1, reasoning: 0 });
    expect(f.brain.store.get("SELECT * FROM provider_dispatches WHERE job_id=? AND dispatch_key='decision'", successor.id)).toBeUndefined();
  } finally { f.close(); }
}, 30_000);

it("settles known cost before discarding a source made private during decision I/O", async () => {
  const f = await fixture();
  try {
    f.stats.duringDecision = () => {
      const source = f.brain.source(f.owner, f.source.id);
      f.brain.editSource(f.owner, source.id, { expected_version: source.version, title: source.title, body: source.body, visibility: "private" });
    };
    await f.makeWorker().tick();
    expect(f.stats).toMatchObject({ decision: 1, reasoning: 0 });
    expect(f.stages()).toMatchObject([{ stage: "decision", state: "settled", actual_micro_usd: 7 }]);
    expect(f.advisories()).toEqual([]);
    expect(f.brain.entities(f.owner, "proposal")).toEqual([]);
    expect(f.receipt()?.data.cost_micro_usd).toBe(7);
  } finally { f.close(); }
}, 30_000);

it("does not treat decision consent as reasoning consent or perform an automatic fallback", async () => {
  const f = await fixture();
  try {
    f.brain.prefs(f.owner, { ...f.brain.prefs(f.owner), provider_enabled: false });
    await f.makeWorker().tick();
    expect(f.stats).toMatchObject({ decision: 0, reasoning: 0 });
    expect(f.stages()).toEqual([]);
  } finally { f.close(); }
}, 30_000);

it("missing decision readiness makes no decision call or hold and leaves the reasoning path usable", async () => {
  const f = await fixture();
  try {
    rmSync(join(f.root, "decision-worker-ready.json"));
    await f.makeWorker().tick();
    expect(f.stats).toMatchObject({ decision: 0, reasoning: 1 });
    expect(f.stages()).toMatchObject([{ stage: "reasoning", state: "settled", actual_micro_usd: 1 }]);
    expect(f.advisories()).toEqual([]);
    expect(f.receipt()?.data.cost_micro_usd).toBe(1);
  } finally { f.close(); }
}, 30_000);

it("decision eligibility does not derive from the API's separate reasoning-readiness flag", async () => {
  const f = await fixture();
  try {
    rmSync(join(f.root, "worker-ready.json"));
    expect(f.brain.backgroundConsent(f.owner)).toBe(true);
    expect(managedCapability({ control: f.runtime.control, root: f.root, now: clock(), optIn: true }).available).toBe(false);
    await f.makeWorker().tick();
    expect(f.stats.decision).toBe(1);
    expect(f.stages().find((row) => row.stage === "decision")).toMatchObject({ state: "settled", actual_micro_usd: 7 });
    expect(f.advisories()).toHaveLength(1);
    // This direct fixture explicitly supplies R's adapter. Its production
    // readiness wrapper belongs to the separate actual-main process gate; do
    // not demand a new readiness policy from S1's unchanged legacy coordinator.
  } finally { f.close(); }
}, 30_000);

it("denies R by the cumulative job cap even though either prepared stage individually fits", async () => {
  const f = await fixture();
  try {
    const context = f.brain.decisionAdvisoryContext(f.owner, f.goal.id);
    if (!context.ok) throw new Error("Synthetic goal unexpectedly has no authorized context");
    // These are real no-I/O bounds used to configure an adversarial budget,
    // not a reimplementation of the admission rule or a fake permission result.
    const dBound = f.decisionProvider.prepareDecision(expectedDecisionInput(context.question)).identity.reserved_micro_usd;
    const rBound = f.reasoningProvider.prepareCall({ kind: "goal", sources: [f.source],
      goal: { title: f.goal.data.title, success_criteria: f.goal.data.success_criteria, plan: "" } }).identity.reserved_micro_usd;
    const cap = dBound + rBound - 1;
    expect(dBound).toBeGreaterThan(0); expect(rBound).toBeGreaterThan(0);
    expect(dBound).toBeLessThanOrEqual(cap); expect(rBound).toBeLessThanOrEqual(cap);
    // Synthetic price = 0.01 micro-USD/input token, so 100*dBound tokens
    // charge exactly dBound. No real provider price or invoice is asserted.
    f.stats.decisionInputTokens = dBound * 100;
    f.brain.prefs(f.owner, { ...f.brain.prefs(f.owner), per_job_cap_micro_usd: cap });
    await f.makeWorker().tick();
    expect(f.stats).toMatchObject({ decision: 1, reasoning: 0 });
    expect(f.stages()).toMatchObject([{ stage: "decision", state: "settled", actual_micro_usd: dBound }]);
    expect(f.brain.entities(f.owner, "proposal")).toEqual([]);
    expect(f.receipt()?.data.cost_micro_usd).toBe(dBound);
  } finally { f.close(); }
}, 30_000);

it("unknown decision usage holds the shared barrier, never calls R, and leaves another account's extractive work usable", async () => {
  const f = await fixture("related", "unknown-decision");
  try {
    await f.makeWorker().tick();
    expect(f.stats).toMatchObject({ decision: 1, reasoning: 0 });
    expect(f.stages()).toMatchObject([{ stage: "decision", state: "dispatched", actual_micro_usd: null }]);
    expect(f.advisories()).toEqual([]);
    const second = f.runtime.acquire(f.b.id);
    try {
      const brain = second.brain, owner = brain.ownerPrincipal();
      brain.capture(owner, { title: "SYNTHETIC unpaid account", body: "SYNTHETIC_UNPAID_CONTINUES" });
      expect(await new Worker(brain).tick()).toBe(true);
      expect(brain.entities(owner, "brief")[0].data.items.length).toBeGreaterThan(0);
      expect(brain.sources(owner, "inbox").some((s) => s.body.includes("SYNTHETIC_UNPAID_CONTINUES"))).toBe(true);
      expect(brain.store.all("SELECT * FROM provider_dispatches")).toEqual([]);
    } finally { second.release(); }
    await f.makeWorker().tick();
    expect(f.stats).toMatchObject({ decision: 1, reasoning: 0 });
  } finally { f.close(); }
}, 30_000);

it("unknown reasoning usage does not present the known decision subtotal as total job cost or print zero in the vault", async () => {
  const f = await fixture("related", "unknown-reasoning");
  try {
    await f.makeWorker().tick();
    expect(f.stats).toMatchObject({ decision: 1, reasoning: 1 });
    expect(f.stages()).toMatchObject([{ stage: "decision", state: "settled", actual_micro_usd: 7 }, { stage: "reasoning", state: "dispatched", actual_micro_usd: null }]);
    expect(f.receipt()?.data.cost_micro_usd).toBeNull();
    const vault = f.brain.store.vault!;
    const day = readFileSync(join(vault.root, "generations", vault.generation(), "dreams", "2026-10-17.md"), "utf8");
    const run = day.split(`## Run ${f.job.id}`)[1]?.split("## Run ")[0];
    expect(run).toBeTruthy();
    expect(run).toMatch(/Cost[^\n]*unknown/i);
    expect(run).not.toMatch(/Cost[^\n]*: 0(?:\D|$)/i);
  } finally { f.close(); }
}, 30_000);
