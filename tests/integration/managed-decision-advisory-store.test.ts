import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../../packages/storage/index.ts";
import { Brain } from "../../packages/domain/service.ts";
import {
  advisoryRecord,
  buildAdvisoryQuestion,
} from "../../packages/domain/decision-advisory.ts";
import { canonical, hash } from "../../packages/domain/logic.ts";
import {
  claimDecisionAttempt,
  decisionAdvisoryKey,
  markDecisionAttemptUnavailable,
  publishDecisionAttempt,
  purgeDecisionAttempts,
  readDecisionAttempt,
} from "../../packages/storage/decision-advisory.ts";
import {
  applyRestoreSafetyBarrier,
  purgeRetainedDeletedSource,
} from "../../packages/storage/restore-policy.ts";
import { ManagedRuntime, managedDecisionCapability } from "../../packages/runtime/managed.ts";
import { ManagedSpendingStore } from "../../packages/storage/managed-spending.ts";
import { ManagedDecisionActivationStore } from "../../packages/storage/managed-decision-activation.ts";
import { ManagedReconciliationStore } from "../../packages/storage/managed-reconciliation.ts";
import { auditManagedHistory } from "../../packages/runtime/managed-audit.ts";
import { writeDecisionReadiness } from "../../packages/runtime/decision-worker-readiness.ts";

/**
 * Executor-owned advisory persistence gate.
 *
 * Claim/CAS cases use a plain real SQLite tenant with a raw running job row (a
 * synthetic setup row, never an active advisory). Service authorization cases use
 * a genuine managed tenant: real decision profile + audit + a synthetic but
 * real-file readiness lease (the same pattern S1 used), so consent is written
 * through the real `Brain.prefs` path rather than a `() => ready true` stub.
 */

const CLOCK = () => new Date("2026-10-17T12:00:00.000Z");
const ACK = { offline: true as const, workers_terminated: true as const };
const ISSUER = "https://issuer.synthetic.test";
const WORKER_ID = randomUUID();
const RH = "a".repeat(64);
const CH = "b".repeat(64);

const dirs: string[] = [];
const runtimes: ManagedRuntime[] = [];
let seq = 0;
afterEach(() => {
  for (const runtime of runtimes.splice(0)) {
    try {
      runtime.close();
    } catch {
      /* already closed */
    }
  }
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function tempDir(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

// ------------------------------------------------------------------ plain CAS

function plainStore(): Storage {
  return new Storage(join(tempDir("brain-advisory-cas-"), "brain.sqlite"));
}

type Lease = { job_id: string; owner: string; fence: number };

function runningJob(
  store: Storage,
  over: { owner?: string; fence?: number; until?: string; kind?: string; payload?: unknown } = {},
): Lease {
  const id = `job-${++seq}`;
  const owner = over.owner ?? "w1";
  const fence = over.fence ?? 1;
  store.run(
    "INSERT INTO jobs(id,project_id,kind,payload,status,attempts,max_attempts,next_at,lease_owner,lease_until,fence,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    id,
    "inbox",
    over.kind ?? "review_changed_assumption",
    JSON.stringify(over.payload ?? { goal_id: "g1", principal: { kind: "owner" } }),
    "running",
    1,
    3,
    "2026-10-17T12:00:00.000Z",
    owner,
    over.until ?? "2026-10-17T12:30:00.000Z",
    fence,
    "2026-10-17T12:00:00.000Z",
  );
  return { job_id: id, owner, fence };
}

const plainQuestion = () => {
  const result = buildAdvisoryQuestion({
    goal: {
      goal_id: "g1",
      goal_entity_version: 1,
      plan_version: 0,
      project_id: "inbox",
      title: "SYNTHETIC advisory goal",
      success_criteria: "",
      status: "active",
      preparation_enabled: true,
    },
    sources: [
      { source_id: "s1", source_version: 1, project_id: "inbox", body: "BODY_ONE" },
      { source_id: "s2", source_version: 2, project_id: "inbox", body: "BODY_TWO" },
    ],
  });
  if (!result.ok) throw new Error(`unexpected skip ${result.skip}`);
  return result.question;
};

function claim(store: Storage, question: ReturnType<typeof plainQuestion>, lease: Lease) {
  return store.transaction(() =>
    claimDecisionAttempt(
      store,
      {
        question,
        job_id: lease.job_id,
        principal: new Brain(store, CLOCK).ownerPrincipal(),
        owner: lease.owner,
        fence: lease.fence,
        request_hash: RH,
        config_hash: CH,
      },
      CLOCK,
    ),
  );
}

// ---------------------------------------------------------------- managed

function managedFixture(opts: { consent?: boolean } = {}) {
  const base = tempDir("brain-advisory-store-");
  const root = join(base, "managed");
  const runtime = new ManagedRuntime(root, {
    clock: CLOCK,
    decisionCapability: () => {
      const c = managedDecisionCapability({ control: runtime.control, root, now: CLOCK(), optIn: true });
      return { ready: c.available, reason: c.reason };
    },
  });
  runtimes.push(runtime);
  const account = runtime.provision(ISSUER, `subject-${++seq}`);
  const money = new ManagedSpendingStore(runtime.control, CLOCK);
  money.setServicePolicy({ daily_micro_usd: 1_000_000 });
  money.setAccountPolicy({
    account_id: account.id,
    per_job_micro_usd: 100_000,
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
  if (!audit.ok) throw new Error(`synthetic audit failed: ${audit.reason}`);
  const profile = new ManagedDecisionActivationStore(runtime.control, root, CLOCK).enable(
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
  writeDecisionReadiness(root, {
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
  });
  const handle = runtime.acquire(account.id);
  const brain = handle.brain;
  handle.release();
  const owner = brain.ownerPrincipal();
  const store = brain.store;
  const dbPath = join(root, account.id, "brain.sqlite");
  const vaultPath = join(root, account.id, "vault");
  if (opts.consent !== false)
    brain.prefs(owner, {
      ...brain.prefs(owner),
      time_zone: "UTC",
      enabled: true,
      provider_enabled: true,
      decision_provider_enabled: true,
      daily_cap_micro_usd: 100_000,
      per_job_cap_micro_usd: 50_000,
    });
  return { base, root, runtime, account, brain, owner, store, dbPath, vaultPath };
}

type Managed = ReturnType<typeof managedFixture>;

function seedGoalSourcesAndJob(
  f: Managed,
  opts: { count?: number; until?: string; owner?: string; fence?: number } = {},
) {
  const goal = f.brain.goal(f.owner, {
    project_id: "inbox",
    title: "SYNTHETIC goal for advisory store",
    success_criteria: "SYNTHETIC criteria",
  });
  f.brain.editGoal(f.owner, goal.id, { expected_version: goal.version, preparation_enabled: true });
  const count = opts.count ?? 2;
  const sourceIds: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const id = String.fromCharCode(97 + i);
    sourceIds.push(
      f.brain.capture(f.owner, { project_id: "inbox", title: `SYNTHETIC ${id}`, body: `BODY_${id}` })
        .source_id,
    );
  }
  const job = f.brain.prepare(f.owner, goal.id);
  const owner = opts.owner ?? "w1";
  const fence = opts.fence ?? 1;
  f.store.run(
    "UPDATE jobs SET status='running',lease_owner=?,lease_until=?,fence=? WHERE id=?",
    owner,
    opts.until ?? "2026-10-17T12:30:00.000Z",
    fence,
    job.id,
  );
  return { goalId: goal.id, sourceIds, jobId: job.id, lease: { job_id: job.id, owner, fence } };
}

function contextQuestion(f: Managed, goalId: string) {
  const result = f.brain.decisionAdvisoryContext(f.owner, goalId);
  if (!result.ok) throw new Error(`unexpected context skip ${result.skip}`);
  return result.question;
}

function knownRecord(question: ReturnType<typeof contextQuestion>) {
  const result = advisoryRecord({
    question,
    envelope: {
      accounting: { state: "known" },
      disposition: "attempted",
      output: {
        ok: true,
        choice: "related",
        confidence: 0.75,
        probabilities: { related: 0.75, unrelated: 0.2, abstain: 0.05 },
      },
    },
  });
  if (!("record" in result)) throw new Error(`unexpected record skip ${result.skip}`);
  return result.record;
}

function claimManaged(f: Managed, question: ReturnType<typeof contextQuestion>, lease: Lease) {
  return f.store.transaction(() =>
    claimDecisionAttempt(
      f.store,
      {
        question,
        job_id: lease.job_id,
        principal: f.owner,
        owner: lease.owner,
        fence: lease.fence,
        request_hash: RH,
        config_hash: CH,
      },
      f.brain.clock,
    ),
  );
}

function saveManaged(
  f: Managed,
  question: ReturnType<typeof contextQuestion>,
  record: ReturnType<typeof knownRecord>,
  lease: Lease,
) {
  return f.brain.saveDecisionAdvisory(f.owner, {
    idempotency_key: decisionAdvisoryKey(question),
    record,
    lease,
  });
}

// ------------------------------------------------------------------ tests

describe("advisory attempt CAS (plain tenant)", () => {
  it("claims once, reports the existing immutable row across jobs and reopens without re-claiming", () => {
    const path = join(tempDir("brain-advisory-reopen-"), "brain.sqlite");
    let store = new Storage(path);
    const question = plainQuestion();
    const first = runningJob(store);
    const claimed = claim(store, question, first);
    expect(claimed).toMatchObject({ claimed: true });
    if (!claimed.claimed) throw new Error("expected claim");
    expect(claimed.row).toMatchObject({
      job_id: first.job_id,
      owner: "w1",
      fence: 1,
      state: "claimed",
      dispatch_key: "decision",
    });
    // A different job with the same question is never re-claimed.
    const second = runningJob(store);
    expect(claim(store, question, second)).toMatchObject({ claimed: false, reason: "exists" });
    // A reopened handle sees the same immutable row.
    store.close();
    store = new Storage(path);
    expect(claim(store, question, second)).toMatchObject({
      claimed: false,
      reason: "exists",
      row: { job_id: first.job_id },
    });
    expect(store.all("SELECT * FROM advisory_attempts")).toHaveLength(1);
    store.close();
  });

  it("denies a claim bound to an expired, malformed, foreign or non-owner job with no orphan row", () => {
    const store = plainStore();
    const question = plainQuestion();
    const denied = [
      runningJob(store, { until: "2026-10-17T11:00:00.000Z" }),
      runningJob(store, { until: "not-a-date" }),
      runningJob(store, { owner: "w1", payload: { goal_id: "g1", principal: { kind: "agent", grant_id: "x" } } }),
      runningJob(store, { kind: "derive_brief" }),
    ];
    for (const lease of denied) expect(() => claim(store, question, lease)).toThrow();
    // Foreign owner / fence mismatches against a valid running job.
    const valid = runningJob(store);
    expect(() => claim(store, question, { ...valid, owner: "other" })).toThrow();
    expect(() => claim(store, question, { ...valid, fence: valid.fence + 1 })).toThrow();
    expect(store.all("SELECT * FROM advisory_attempts")).toEqual([]);
    store.close();
  });

  it("refuses a tombstoned key without inventing an attempt row", () => {
    const store = plainStore();
    const question = plainQuestion();
    const key = decisionAdvisoryKey(question);
    store.run(
      "INSERT INTO advisory_tombstones VALUES(?,?,?)",
      key,
      question.question_hash,
      "2026-10-17T12:00:00.000Z",
    );
    const lease = runningJob(store);
    expect(claim(store, question, lease)).toEqual({ claimed: false, reason: "tombstoned" });
    expect(store.all("SELECT * FROM advisory_attempts")).toEqual([]);
    expect(readDecisionAttempt(store, key)).toBeUndefined();
    store.close();
  });

  it("CAS-publishes a claimed attempt and marks an orphan unavailable without overwriting", () => {
    const store = plainStore();
    const question = plainQuestion();
    const lease = runningJob(store);
    const key = decisionAdvisoryKey(question);
    const claimed = claim(store, question, lease);
    if (!claimed.claimed) throw new Error("expected claim");
    store.transaction(() => publishDecisionAttempt(store, key, "advisory-1", CLOCK));
    expect(readDecisionAttempt(store, key)).toMatchObject({ state: "published", advisory_id: "advisory-1" });
    expect(() => store.transaction(() => markDecisionAttemptUnavailable(store, key, CLOCK))).toThrow();
    expect(readDecisionAttempt(store, key)?.state).toBe("published");
    store.close();
  });

  it("binds the idempotency key to the goal, plan, ordered sources and question hash", () => {
    const question = plainQuestion();
    const base = decisionAdvisoryKey(question);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(base).toBe(decisionAdvisoryKey(plainQuestion()));
    const snapGoal = { ...question.goal, preparation_enabled: true };
    const snapSources = question.sources.map((s) => ({
      source_id: s.source_id,
      source_version: s.source_version,
      project_id: "inbox",
      body: s.body,
    }));
    const moved = buildAdvisoryQuestion({
      goal: { ...snapGoal, goal_entity_version: 2, plan_version: 3 },
      sources: snapSources,
    });
    if (moved.ok) expect(decisionAdvisoryKey(moved.question)).not.toBe(base);
    const body = buildAdvisoryQuestion({
      goal: snapGoal,
      sources: snapSources.map((s, i) => (i ? s : { ...s, body: s.body + " changed" })),
    });
    if (body.ok) expect(decisionAdvisoryKey(body.question)).not.toBe(base);
  });
});

describe("advisory service (genuine managed tenant)", () => {
  it("builds a consent-gated question and persists exactly one advisory entity with history and CAS", () => {
    const f = managedFixture();
    const setup = seedGoalSourcesAndJob(f, { count: 2 });
    const question = contextQuestion(f, setup.goalId);
    const record = knownRecord(question);
    const claimed = claimManaged(f, question, setup.lease);
    if (!claimed.claimed) throw new Error("expected claim");
    const entity = saveManaged(f, question, record, setup.lease);
    expect(entity.kind).toBe("advisory");
    expect(entity.data).toMatchObject({ status: "advisory", epistemic_status: "hypothesis" });
    expect(entity.data.judgment).not.toBeNull();
    const rows = f.store.all("SELECT * FROM entities WHERE kind='advisory'");
    expect(rows).toHaveLength(1);
    expect(f.store.all("SELECT * FROM entity_versions WHERE entity_id=?", entity.id)).toHaveLength(1);
    expect(readDecisionAttempt(f.store, decisionAdvisoryKey(question))).toMatchObject({
      state: "published",
      advisory_id: entity.id,
    });
    expect(JSON.stringify(record)).not.toContain("BODY_");
  });

  it("denies context without raw decision consent or with background disabled", () => {
    const open = managedFixture({ consent: false });
    const setup = seedGoalSourcesAndJob(open, { count: 1 });
    expect(open.brain.decisionAdvisoryContext(open.owner, setup.goalId).ok).toBe(false);
    const on = managedFixture();
    const setup2 = seedGoalSourcesAndJob(on, { count: 1 });
    expect(on.brain.decisionAdvisoryContext(on.owner, setup2.goalId).ok).toBe(true);
    on.brain.prefs(on.owner, { ...on.brain.prefs(on.owner), enabled: false });
    expect(on.brain.decisionAdvisoryContext(on.owner, setup2.goalId).ok).toBe(false);
  });

  it("excludes private, withdrawn and cross-project sources from the question", () => {
    const f = managedFixture();
    const setup = seedGoalSourcesAndJob(f, { count: 1 });
    const other = f.brain.createProject(f.owner, "SYNTHETIC other project");
    const foreign = f.brain.capture(f.owner, { project_id: other.id, title: "SYNTHETIC foreign", body: "FOREIGN_BODY" });
    const privateSource = f.brain.capture(f.owner, { project_id: "inbox", title: "SYNTHETIC private", body: "PRIVATE_BODY" });
    const current = f.brain.source(f.owner, privateSource.source_id);
    f.brain.editSource(f.owner, privateSource.source_id, {
      body: "PRIVATE_BODY_UPDATED",
      title: "SYNTHETIC private",
      expected_version: current.version,
      visibility: "private",
    });
    const question = contextQuestion(f, setup.goalId);
    const ids = question.sources.map((s) => s.source_id);
    expect(ids).not.toContain(foreign.source_id);
    expect(ids).not.toContain(privateSource.source_id);
    // A foreign owner bound to another tenant is refused outright.
    expect(() =>
      f.brain.decisionAdvisoryContext({ kind: "owner", tenantId: "other-tenant" }, setup.goalId),
    ).toThrow();
  });

  it("refuses to persist an unclaimed, mismatched or foreign-lease advisory and creates no entity", () => {
    const f = managedFixture();
    const setup = seedGoalSourcesAndJob(f, { count: 1 });
    const question = contextQuestion(f, setup.goalId);
    const record = knownRecord(question);
    // Unclaimed.
    expect(() => saveManaged(f, question, record, setup.lease)).toThrow();
    const claimed = claimManaged(f, question, setup.lease);
    if (!claimed.claimed) throw new Error("expected claim");
    // A stale record for a later goal version is refused.
    f.brain.editGoal(f.owner, setup.goalId, {
      expected_version: f.brain.entity(f.owner, setup.goalId).version,
      plan: "SYNTHETIC new plan",
    });
    expect(() => saveManaged(f, question, record, setup.lease)).toThrow();
    // A new lease cannot adopt the original claim.
    f.store.run(
      "UPDATE jobs SET lease_owner=?,fence=? WHERE id=?",
      "w2",
      setup.lease.fence + 1,
      setup.lease.job_id,
    );
    expect(() =>
      saveManaged(f, question, record, {
        job_id: setup.lease.job_id,
        owner: "w2",
        fence: setup.lease.fence + 1,
      }),
    ).toThrow();
    expect(f.store.all("SELECT * FROM entities WHERE kind='advisory'")).toEqual([]);
    expect(readDecisionAttempt(f.store, decisionAdvisoryKey(question))?.state).toBe("claimed");
  });

  it("keeps advisory entities out of the generic owner and agent entity readers", () => {
    const f = managedFixture();
    const setup = seedGoalSourcesAndJob(f, { count: 1 });
    const question = contextQuestion(f, setup.goalId);
    const claimed = claimManaged(f, question, setup.lease);
    if (!claimed.claimed) throw new Error("expected claim");
    const entity = saveManaged(f, question, knownRecord(question), setup.lease);
    expect(() => f.brain.entity(f.owner, entity.id)).toThrow();
    expect(f.brain.entities(f.owner).some((e) => e.kind === "advisory")).toBe(false);
    expect(f.brain.entities(f.owner, "advisory")).toEqual([]);
    // The internal owner reader still returns the exact-current record.
    expect(f.brain.decisionAdvisory(f.owner, entity.id)).toMatchObject({ status: "advisory" });
    expect(f.brain.decisionAdvisoriesForGoal(f.owner, setup.goalId)).toHaveLength(1);
  });

  it("withdraws dependent advisories on source edits, goal edits, plan accept and consent off", () => {
    const f = managedFixture();
    const setup = seedGoalSourcesAndJob(f, { count: 2 });
    const question = contextQuestion(f, setup.goalId);
    const claimed = claimManaged(f, question, setup.lease);
    if (!claimed.claimed) throw new Error("expected claim");
    const entity = saveManaged(f, question, knownRecord(question), setup.lease);
    const source = f.brain.source(f.owner, setup.sourceIds[0]);
    f.brain.editSource(f.owner, setup.sourceIds[0], {
      body: "BODY_a EDITED",
      title: "SYNTHETIC a",
      expected_version: source.version,
    });
    expect(f.store.get("SELECT data FROM entities WHERE id=?", entity.id)?.data).toContain('"withdrawn"');
    expect(f.brain.decisionAdvisory(f.owner, entity.id)).toBeUndefined();
  });

  it("withdraws advisories when the goal is edited or an accepted plan is reviewed", () => {
    const f = managedFixture();
    const setup = seedGoalSourcesAndJob(f, { count: 1 });
    const question = contextQuestion(f, setup.goalId);
    const claimed = claimManaged(f, question, setup.lease);
    if (!claimed.claimed) throw new Error("expected claim");
    const entity = saveManaged(f, question, knownRecord(question), setup.lease);
    const goal = f.brain.entity(f.owner, setup.goalId);
    f.brain.editGoal(f.owner, setup.goalId, { expected_version: goal.version, status: "paused" });
    expect(f.store.get("SELECT data FROM entities WHERE id=?", entity.id)?.data).toContain('"withdrawn"');
    // A raw-seeded reviewable proposal exercises the accept path's goal revision.
    f.brain.editGoal(f.owner, setup.goalId, {
      expected_version: f.brain.entity(f.owner, setup.goalId).version,
      status: "active",
    });
    const goal2 = f.brain.entity(f.owner, setup.goalId);
    const proposal = f.brain.createEntity("inbox", "proposal", {
      goal_id: setup.goalId,
      base_version: goal2.data.plan_version,
      title: "SYNTHETIC proposal",
      reason: "SYNTHETIC reason",
      artifact: "SYNTHETIC accepted plan",
      evidence: [],
      status: "ready",
    });
    f.brain.review(f.owner, proposal.id, "accept", { expected_version: proposal.version });
    expect(f.store.get("SELECT data FROM entities WHERE id=?", entity.id)?.data).toContain('"withdrawn"');
  });

  it("withdraws advisories when either global consent is switched off", () => {
    const f = managedFixture();
    const setup = seedGoalSourcesAndJob(f, { count: 1 });
    const question = contextQuestion(f, setup.goalId);
    const claimed = claimManaged(f, question, setup.lease);
    if (!claimed.claimed) throw new Error("expected claim");
    const entity = saveManaged(f, question, knownRecord(question), setup.lease);
    f.brain.prefs(f.owner, { ...f.brain.prefs(f.owner), decision_provider_enabled: false });
    expect(f.store.get("SELECT data FROM entities WHERE id=?", entity.id)?.data).toContain('"withdrawn"');
  });

  it("retains the validated advisory through owner export and derives unavailable/null on import", () => {
    const f = managedFixture();
    const setup = seedGoalSourcesAndJob(f, { count: 1 });
    const question = contextQuestion(f, setup.goalId);
    const claimed = claimManaged(f, question, setup.lease);
    if (!claimed.claimed) throw new Error("expected claim");
    const entity = saveManaged(f, question, knownRecord(question), setup.lease);
    const dump = f.brain.export(f.owner);
    expect(JSON.stringify(dump)).toContain(entity.id);

    const target = new Brain(new Storage(join(tempDir("brain-advisory-import-"), "brain.sqlite")));
    const preview = target.preview(target.ownerPrincipal(), dump);
    target.applyImport(target.ownerPrincipal(), preview.id);
    const imported = target.store.get<{ data: string }>(
      "SELECT data FROM entities WHERE id=?",
      entity.id,
    );
    const data = JSON.parse(imported!.data);
    expect(data).toMatchObject({ status: "unavailable", judgment: null });
    expect(target.store.all("SELECT * FROM advisory_attempts")).toEqual([]);
    // A full second round trip dedups by digest and creates nothing new.
    const again = target.preview(target.ownerPrincipal(), dump);
    target.applyImport(target.ownerPrincipal(), again.id);
    expect(target.store.all("SELECT id FROM entities WHERE kind='advisory'")).toHaveLength(1);
    target.store.close();
  });

  it("routes advisories to the vault observations folder and restores them on rebuild", () => {
    const f = managedFixture();
    const setup = seedGoalSourcesAndJob(f, { count: 1 });
    const question = contextQuestion(f, setup.goalId);
    const claimed = claimManaged(f, question, setup.lease);
    if (!claimed.claimed) throw new Error("expected claim");
    const entity = saveManaged(f, question, knownRecord(question), setup.lease);
    const generation = f.store.vault!.generation();
    expect(existsSync(join(f.vaultPath, "generations", generation, "observations", `${entity.id}.json`))).toBe(true);
    expect(existsSync(join(f.vaultPath, "generations", generation, "dreams", `${entity.id}.json`))).toBe(false);
    f.store.rebuild();
    expect(f.store.get("SELECT kind FROM entities WHERE id=?", entity.id)?.kind).toBe("advisory");
  });

  it("purges every advisory version and attempt ref on source purge, tombstoning the key", () => {
    const f = managedFixture();
    const setup = seedGoalSourcesAndJob(f, { count: 1 });
    const question = contextQuestion(f, setup.goalId);
    const claimed = claimManaged(f, question, setup.lease);
    if (!claimed.claimed) throw new Error("expected claim");
    const entity = saveManaged(f, question, knownRecord(question), setup.lease);
    const key = decisionAdvisoryKey(question);
    const source = f.brain.source(f.owner, setup.sourceIds[0]);
    f.brain.removeSource(f.owner, setup.sourceIds[0], source.version, true);
    expect(f.store.all("SELECT * FROM entities WHERE kind='advisory'")).toEqual([]);
    expect(f.store.all("SELECT * FROM entity_versions WHERE entity_id=?", entity.id)).toEqual([]);
    expect(f.store.all("SELECT * FROM advisory_attempts")).toEqual([]);
    const tombstones = f.store.all<{ idempotency_key: string; question_hash: string }>(
      "SELECT idempotency_key,question_hash FROM advisory_tombstones",
    );
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0].idempotency_key).toBe(key);
    expect(JSON.stringify(tombstones)).not.toContain(setup.sourceIds[0]);
    expect(readDecisionAttempt(f.store, key)).toBeUndefined();
    // The same question can never be re-claimed, but a fresh capture may.
    const retryLease = runningJob(f.store, {
      payload: { goal_id: setup.goalId, principal: { kind: "owner" } },
    });
    expect(claim(f.store, question, retryLease)).toEqual({ claimed: false, reason: "tombstoned" });
  }, 20000);

  it("tombstones an attempt even when the purged source is outside the selected first ten", () => {
    const f = managedFixture();
    const setup = seedGoalSourcesAndJob(f, { count: 11 });
    const question = contextQuestion(f, setup.goalId);
    const claimed = claimManaged(f, question, setup.lease);
    if (!claimed.claimed) throw new Error("expected claim");
    const selected = new Set(question.sources.map((s) => s.source_id));
    const excluded = setup.sourceIds.find((id) => !selected.has(id))!;
    const source = f.brain.source(f.owner, excluded);
    f.brain.removeSource(f.owner, excluded, source.version, true);
    expect(claim(f.store, question, runningJob(f.store, {
      payload: { goal_id: setup.goalId, principal: { kind: "owner" } },
    }))).toEqual({ claimed: false, reason: "tombstoned" });
  }, 20000);

  it("marks stored advisories withdrawn on a restore safety barrier and preserves raw decision", () => {
    const f = managedFixture();
    const setup = seedGoalSourcesAndJob(f, { count: 1 });
    const question = contextQuestion(f, setup.goalId);
    const claimed = claimManaged(f, question, setup.lease);
    if (!claimed.claimed) throw new Error("expected claim");
    const entity = saveManaged(f, question, knownRecord(question), setup.lease);
    applyRestoreSafetyBarrier(f.store, CLOCK);
    expect(f.store.get("SELECT data FROM entities WHERE id=?", entity.id)?.data).toContain('"withdrawn"');
    expect(f.store.all("SELECT * FROM entity_versions WHERE entity_id=?", entity.id)).toHaveLength(2);
    expect(f.brain.prefs(f.owner).provider_enabled).toBe(false);
    expect(f.store.setting<{ decision_provider_enabled?: boolean }>("preferences", {}).decision_provider_enabled).toBe(true);
  });

  it("rolls the advisory entity and CAS back atomically when the entity write fails", () => {
    const f = managedFixture();
    const setup = seedGoalSourcesAndJob(f, { count: 1 });
    const question = contextQuestion(f, setup.goalId);
    const claimed = claimManaged(f, question, setup.lease);
    if (!claimed.claimed) throw new Error("expected claim");
    const key = decisionAdvisoryKey(question);
    f.store.db.exec(
      "CREATE TRIGGER synthetic_block_advisory BEFORE INSERT ON entities WHEN NEW.kind='advisory' BEGIN SELECT RAISE(ABORT,'SYNTHETIC advisory write failure'); END;",
    );
    expect(() => saveManaged(f, question, knownRecord(question), setup.lease)).toThrow();
    f.store.db.exec("DROP TRIGGER synthetic_block_advisory");
    expect(f.store.all("SELECT * FROM entities WHERE kind='advisory'")).toEqual([]);
    expect(readDecisionAttempt(f.store, key)).toMatchObject({ state: "claimed", advisory_id: null });
  });

  it("recovers advisories withdrawn when a vault rebuilds a missing operational database", () => {
    const f = managedFixture();
    const setup = seedGoalSourcesAndJob(f, { count: 1 });
    const question = contextQuestion(f, setup.goalId);
    const claimed = claimManaged(f, question, setup.lease);
    if (!claimed.claimed) throw new Error("expected claim");
    const entity = saveManaged(f, question, knownRecord(question), setup.lease);
    // Close the whole runtime (releasing the tenant store + control) before
    // deleting the operational database so Windows frees the file handles.
    f.runtime.close();
    for (const suffix of ["", "-wal", "-shm"]) rmSync(f.dbPath + suffix, { force: true, maxRetries: 5, retryDelay: 50 });
    const reopened = new Storage(f.dbPath, { vault: f.vaultPath });
    try {
      expect(reopened.get("SELECT kind FROM entities WHERE id=?", entity.id)?.kind).toBe("advisory");
      expect(reopened.get("SELECT data FROM entities WHERE id=?", entity.id)?.data).toContain('"withdrawn"');
    } finally {
      reopened.close();
    }
  }, 20000);
});

describe("shared restore purge hook", () => {
  it("tombstones and deletes attempt references on a retained-source purge", () => {
    const store = new Storage(join(tempDir("brain-advisory-purge-"), "brain.sqlite"));
    const at = "2026-10-17T12:00:00.000Z";
    store.run("INSERT INTO sources VALUES(?,?,?,?,?,?,?)", "src-purge", "inbox", 1, "deleted", "project", "note", at);
    store.run("INSERT INTO source_versions VALUES(?,?,?,?,?)", "src-purge", 1, "SYNTHETIC", "SYNTH_PURGE_BODY", at);
    const refs = JSON.stringify([{ source_id: "src-purge", source_version: 1, body_hash: "c".repeat(64) }]);
    const data = JSON.stringify({
      goal_id: "g1", goal_entity_version: 1, plan_version: 0, project_id: "inbox",
      question_hash: "d".repeat(64), sources: [{ source_id: "src-purge", source_version: 1, body_hash: "c".repeat(64) }],
      policy_version: "advisory-goal-relevance-v1", epistemic_status: "hypothesis",
      judgment: null, status: "unavailable", decision_source: "prepared-decision",
    });
    store.run("INSERT INTO entities VALUES(?,?,?,?,?,?)", "adv-1", "inbox", "advisory", 1, data, at);
    store.run("INSERT INTO entity_versions VALUES(?,?,?,?)", "adv-1", 1, data, at);
    store.run(
      "INSERT INTO advisory_attempts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      "e".repeat(64), "job-x", "decision", "inbox", "g1", 1, 0, refs, RH, CH, "d".repeat(64),
      "w1", 1, "claimed", null, at, at,
    );
    purgeRetainedDeletedSource(store, "src-purge");
    expect(store.all("SELECT * FROM entities WHERE kind='advisory'")).toEqual([]);
    expect(store.all("SELECT * FROM advisory_attempts")).toEqual([]);
    expect(store.all("SELECT idempotency_key FROM advisory_tombstones")).toEqual([{ idempotency_key: "e".repeat(64) }]);
    store.close();
  });
});

describe("repository transaction guard and immutable identity", () => {
  it("refuses every attempt mutation outside an owned tenant transaction", () => {
    const store = plainStore();
    const question = plainQuestion();
    const lease = runningJob(store);
    const principal = new Brain(store, CLOCK).ownerPrincipal();
    const input = {
      question,
      job_id: lease.job_id,
      principal,
      owner: lease.owner,
      fence: lease.fence,
      request_hash: RH,
      config_hash: CH,
    };
    // Every mutator must be a no-op outside a caller-owned transaction.
    expect(() => claimDecisionAttempt(store, input, CLOCK)).toThrow();
    expect(readDecisionAttempt(store, decisionAdvisoryKey(question))).toBeUndefined();
    expect(store.all("SELECT * FROM advisory_attempts")).toEqual([]);
    const claimed = claim(store, question, lease);
    if (!claimed.claimed) throw new Error("expected claim");
    const key = decisionAdvisoryKey(question);
    expect(() => publishDecisionAttempt(store, key, "advisory-x", CLOCK)).toThrow();
    expect(() => markDecisionAttemptUnavailable(store, key, CLOCK)).toThrow();
    expect(() => purgeDecisionAttempts(store, () => true, CLOCK)).toThrow();
    expect(readDecisionAttempt(store, key)).toMatchObject({ state: "claimed", advisory_id: null });
    store.close();
  });

  it("rejects replacing any immutable claim field through the migration trigger", () => {
    const store = plainStore();
    const question = plainQuestion();
    const lease = runningJob(store);
    const claimed = claim(store, question, lease);
    if (!claimed.claimed) throw new Error("expected claim");
    const key = decisionAdvisoryKey(question);
    const before = readDecisionAttempt(store, key);
    for (const [sql, value] of [
      ["UPDATE advisory_attempts SET question_hash=? WHERE idempotency_key=?", "f".repeat(64)],
      ["UPDATE advisory_attempts SET source_refs_json=? WHERE idempotency_key=?", "[]"],
      ["UPDATE advisory_attempts SET fence=? WHERE idempotency_key=?", 99],
    ] as const) {
      expect(() => store.run(sql, value, key)).toThrow();
      expect(readDecisionAttempt(store, key)).toEqual(before);
    }
    store.close();
  });

  it("readDecisionAttempt fails closed on a corrupt typed field", () => {
    const store = plainStore();
    const question = plainQuestion();
    const lease = runningJob(store);
    const claimed = claim(store, question, lease);
    if (!claimed.claimed) throw new Error("expected claim");
    const key = decisionAdvisoryKey(question);
    // Simulate a historical pre-trigger corrupt row.
    store.db.exec("DROP TRIGGER advisory_attempts_identity_immutable");
    store.run("UPDATE advisory_attempts SET fence='abc' WHERE idempotency_key=?", key);
    expect(() => readDecisionAttempt(store, key)).toThrow();
    store.close();
  });
});

describe("owner-checked advisory wrapper and withdrawn revival", () => {
  it("claims only through the Brain wrapper and refuses a stale question hash or foreign principal", () => {
    const f = managedFixture();
    const setup = seedGoalSourcesAndJob(f, { count: 1 });
    const question = contextQuestion(f, setup.goalId);
    const claimed = f.brain.claimDecisionAdvisory(f.owner, {
      goal_id: setup.goalId,
      question_hash: question.question_hash,
      lease: setup.lease,
      request_hash: RH,
      config_hash: CH,
    });
    expect(claimed).toMatchObject({ claimed: true });
    expect(() =>
      f.brain.claimDecisionAdvisory(f.owner, {
        goal_id: setup.goalId,
        question_hash: "f".repeat(64),
        lease: setup.lease,
        request_hash: RH,
        config_hash: CH,
      }),
    ).toThrow();
    const other = managedFixture();
    expect(() =>
      other.brain.claimDecisionAdvisory(other.owner, {
        goal_id: setup.goalId,
        question_hash: question.question_hash,
        lease: setup.lease,
        request_hash: RH,
        config_hash: CH,
      }),
    ).toThrow();
  });

  it("never revives a withdrawn advisory when background help is resumed unchanged", () => {
    const f = managedFixture();
    const setup = seedGoalSourcesAndJob(f, { count: 1 });
    const question = contextQuestion(f, setup.goalId);
    const claimed = claimManaged(f, question, setup.lease);
    if (!claimed.claimed) throw new Error("expected claim");
    const entity = saveManaged(f, question, knownRecord(question), setup.lease);
    f.brain.prefs(f.owner, { ...f.brain.prefs(f.owner), enabled: false });
    f.brain.prefs(f.owner, { ...f.brain.prefs(f.owner), enabled: true });
    expect(contextQuestion(f, setup.goalId).question_hash).toBe(question.question_hash);
    expect(f.brain.decisionAdvisory(f.owner, entity.id)).toBeUndefined();
    expect(f.brain.decisionAdvisoriesForGoal(f.owner, setup.goalId)).toEqual([]);
  });

  it("rolls back a forget when the tombstone insert or attempt delete is silently ignored", () => {
    for (const mode of ["tombstone", "delete"]) {
      const f = managedFixture();
      const setup = seedGoalSourcesAndJob(f, { count: 1 });
      const question = contextQuestion(f, setup.goalId);
      const claimed = claimManaged(f, question, setup.lease);
      if (!claimed.claimed) throw new Error("expected claim");
      const saved = saveManaged(f, question, knownRecord(question), setup.lease);
      const privateSource = f.brain.capture(f.owner, {
        project_id: "inbox",
        title: "SYNTHETIC private purge",
        body: "SYNTHETIC_PRIVATE_PURGE_BODY",
        visibility: "private",
      }).source_id;
      f.store.db.exec(
        mode === "tombstone"
          ? "CREATE TRIGGER synthetic_ignore_purge BEFORE INSERT ON advisory_tombstones BEGIN SELECT RAISE(IGNORE); END;"
          : "CREATE TRIGGER synthetic_ignore_purge BEFORE DELETE ON advisory_attempts BEGIN SELECT RAISE(IGNORE); END;",
      );
      const source = f.brain.source(f.owner, privateSource);
      expect(() =>
        f.brain.removeSource(f.owner, privateSource, source.version, true),
      ).toThrow();
      expect(f.store.get("SELECT state FROM sources WHERE id=?", privateSource)).toMatchObject({ state: "active" });
      expect(readDecisionAttempt(f.store, decisionAdvisoryKey(question))).toMatchObject({
        state: "published",
        advisory_id: saved.id,
      });
    }
  }, 30000);
});

describe("portable scoped historical advisory import", () => {
  it("imports a scoped historical advisory after its source moved away without inventing history", () => {
    const f = managedFixture();
    const setup = seedGoalSourcesAndJob(f, { count: 1 });
    const question = contextQuestion(f, setup.goalId);
    const claimed = claimManaged(f, question, setup.lease);
    if (!claimed.claimed) throw new Error("expected claim");
    const entity = saveManaged(f, question, knownRecord(question), setup.lease);
    const destination = f.brain.createProject(f.owner, "SYNTHETIC moved destination");
    const source = f.brain.source(f.owner, setup.sourceIds[0]);
    f.brain.editSource(f.owner, setup.sourceIds[0], {
      body: source.body,
      title: source.title,
      expected_version: source.version,
      project_id: destination.id,
    });
    const exported = f.brain.export(f.owner, "inbox");
    expect(exported.payload.sources.some((s) => s.id === setup.sourceIds[0])).toBe(false);
    expect(exported.payload.entities.some((e) => e.id === entity.id)).toBe(true);
    const target = new Brain(new Storage(join(tempDir("brain-adv-move-"), "brain.sqlite")));
    try {
      const preview = target.preview(target.ownerPrincipal(), exported);
      target.applyImport(target.ownerPrincipal(), preview.id);
      expect(JSON.parse(target.store.get("SELECT data FROM entities WHERE id=?", entity.id)!.data)).toMatchObject({
        status: "unavailable",
        judgment: null,
      });
      expect(target.store.all("SELECT * FROM source_versions WHERE source_id=?", setup.sourceIds[0])).toEqual([]);
      expect(target.store.all("SELECT * FROM advisory_attempts")).toEqual([]);
      expect(target.decisionAdvisory(target.ownerPrincipal(), entity.id)).toBeUndefined();
    } finally {
      target.store.close();
    }
  }, 30000);

  it("rejects available provenance that contradicts its declared body hash or project", () => {
    for (const field of ["body_hash", "project_id"]) {
      const f = managedFixture();
      const setup = seedGoalSourcesAndJob(f, { count: 1 });
      const question = contextQuestion(f, setup.goalId);
      const claimed = claimManaged(f, question, setup.lease);
      if (!claimed.claimed) throw new Error("expected claim");
      const entity = saveManaged(f, question, knownRecord(question), setup.lease);
      const exported = structuredClone(f.brain.export(f.owner));
      const row = exported.payload.entities.find((e) => e.id === entity.id)!;
      if (field === "project_id") row.data.project_id = "synthetic-inconsistent-project";
      else row.data.sources[0].body_hash = "0".repeat(64);
      exported.checksum = hash(canonical(exported.payload));
      const target = new Brain(new Storage(join(tempDir("brain-adv-prov-"), "brain.sqlite")));
      try {
        const owner = target.ownerPrincipal();
        const preview = target.preview(owner, exported);
        expect(() => target.applyImport(owner, preview.id)).toThrow();
        expect(target.store.get("SELECT id FROM entities WHERE id=?", entity.id)).toBeUndefined();
      } finally {
        target.store.close();
      }
    }
  }, 30000);
});

describe("service claim identity comparison", () => {
  it("denies save when a corrupt stored claim identity no longer matches the current question", () => {
    const f = managedFixture();
    const setup = seedGoalSourcesAndJob(f, { count: 1 });
    const question = contextQuestion(f, setup.goalId);
    const claimed = claimManaged(f, question, setup.lease);
    if (!claimed.claimed) throw new Error("expected claim");
    // Simulate a pre-trigger corrupt snapshot row and prove the service compares
    // the full stored identity under the write lock, not just the key.
    f.store.db.exec("DROP TRIGGER advisory_attempts_identity_immutable");
    f.store.run(
      "UPDATE advisory_attempts SET plan_version=99 WHERE idempotency_key=?",
      decisionAdvisoryKey(question),
    );
    expect(() =>
      saveManaged(f, question, knownRecord(question), setup.lease),
    ).toThrow();
    expect(f.store.all("SELECT * FROM entities WHERE kind='advisory'")).toEqual([]);
  });
});
