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
import { writeDecisionReadiness } from "../../packages/runtime/decision-worker-readiness.ts";
import { advisoryRecord, expectedDecisionInput, type AdvisoryQuestion } from "../../packages/domain/decision-advisory.ts";
import { canonical, hash } from "../../packages/domain/logic.ts";
import { PreparedDecisionProvider } from "../../packages/providers/prepared-decision.ts";
import { claimDecisionAttempt, decisionAdvisoryKey, markDecisionAttemptUnavailable, publishDecisionAttempt, purgeDecisionAttempts, readDecisionAttempt } from "../../packages/storage/decision-advisory.ts";
import { applyRestoreSafetyBarrier, purgeRetainedDeletedSource } from "../../packages/storage/restore-policy.ts";
import { Brain } from "../../packages/domain/service.ts";
import { Storage } from "../../packages/storage/index.ts";

const clock = () => new Date("2026-10-17T12:00:00.000Z");
const ack = { offline: true as const, workers_terminated: true as const };

// Genuine account/configuration/SQLite/vault, explicitly synthetic readiness.
// No provider executes here. These tests prove persistence, not known settlement;
// the approved T3 worker must settle both money ledgers before it calls save.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "brain-advisory-persistence-parent-"));
  const runtime: ManagedRuntime = new ManagedRuntime(root, { clock, decisionCapability: () => {
    const cap = managedDecisionCapability({ control: runtime.control, root, now: clock(), optIn: true });
    return { ready: cap.available, reason: cap.reason };
  } });
  const a = runtime.provision("https://issuer.synthetic.test", "synthetic-advisory-a");
  const b = runtime.provision("https://issuer.synthetic.test", "synthetic-advisory-b");
  const money = new ManagedSpendingStore(runtime.control, clock);
  money.setServicePolicy({ daily_micro_usd: 100_000 });
  for (const account of [a, b]) {
    money.setAccountPolicy({ account_id: account.id, per_job_micro_usd: 10_000, user_daily_micro_usd: 100_000 });
    money.configureAccountPeriod({ account_id: account.id, starts_at: "2026-10-17T00:00:00Z", ends_at: "2026-10-18T00:00:00Z", allowance_micro_usd: 100_000 });
  }
  new ManagedReconciliationStore(runtime.control, root, clock).initEpoch(ack);
  const audit = auditManagedHistory({ runtime, root, ...ack, clock });
  expect(audit.ok).toBe(true);
  const profile = new ManagedDecisionActivationStore(runtime.control, root, clock).enable({ provider: "typesafe",
    endpoint: "https://api.typesafe.ai/v1/systemone", model: "jev-synthetic-v1", accepted_response_models: ["jev-synthetic-v1"],
    price_version: "synthetic-price-v1", input_micro_usd_per_million: 1000, output_micro_usd_per_million: 0,
    timeout_ms: 1000, max_request_bytes: 1_048_576, max_response_bytes: 262_144, audit_id: audit.audit_id!, expected_version: 0 }, ack);
  const worker = randomUUID();
  writeDecisionReadiness(root, { schema: 1, worker_id: worker, stage_scope: "decision", provider_family: profile.provider,
    endpoint_digest: profile.endpoint_digest, epoch: profile.epoch, root_nonce: profile.root_nonce,
    activation_fingerprint: profile.fingerprint, config_digest: profile.config_digest, model: profile.model,
    price_version: profile.price_version, booted_at: clock().toISOString(), heartbeat_at: clock().toISOString(), expires_at: "2026-10-17T12:00:15.000Z" }, clock);
  const handle = runtime.acquire(a.id), brain = handle.brain, owner = brain.ownerPrincipal();
  brain.prefs(owner, { ...brain.prefs(owner), enabled: true, provider_enabled: true, decision_provider_enabled: true,
    time_zone: "UTC", per_job_cap_micro_usd: 10_000, daily_cap_micro_usd: 100_000 });
  const created = brain.goal(owner, { project_id: "inbox", title: "SYNTHETIC beta goal", success_criteria: "Understand the supplied beta evidence" });
  const goal = brain.editGoal(owner, created.id, { expected_version: created.version, preparation_enabled: true });
  const publicId = brain.capture(owner, { title: "SYNTHETIC public evidence", body: "SYNTHETIC_PUBLIC_BETA_INPUT", visibility: "project" }).source_id;
  const privateId = brain.capture(owner, { title: "SYNTHETIC private note", body: "SYNTHETIC_PRIVATE_DO_NOT_SEND", visibility: "private" }).source_id;
  const otherProject = brain.createProject(owner, "SYNTHETIC other project");
  const foreignId = brain.capture(owner, { project_id: otherProject.id, title: "SYNTHETIC other scope", body: "SYNTHETIC_OTHER_PROJECT_DO_NOT_SEND", visibility: "project" }).source_id;
  const provider = new PreparedDecisionProvider({ provider: profile.provider, endpoint: profile.endpoint, model: profile.model,
    accepted_response_models: [...profile.accepted_response_models], key: "SYNTHETIC_TEST_ONLY_NOT_A_CREDENTIAL",
    price: { version: profile.price_version, input_micro_usd_per_million: 1000, output_micro_usd_per_million: 0 },
  }, async () => { throw new Error("This persistence fixture must never call a provider"); });
  function createJob() {
    const job = brain.prepare(owner, goal.id);
    const lease = { job_id: job.id, owner: worker, fence: 1 };
    brain.store.run("UPDATE jobs SET status='running',lease_owner=?,lease_until=?,fence=1 WHERE id=?", worker, "2026-10-17T12:01:00.000Z", job.id);
    return { job, lease };
  }
  const { job, lease } = createJob();
  function context() {
    const result = brain.decisionAdvisoryContext(owner, goal.id);
    if (!result.ok) throw new Error(`Expected current context, got ${result.skip}`);
    return result.question;
  }
  function mapped(q: AdvisoryQuestion) {
    const result = advisoryRecord({ question: q, envelope: { accounting: { state: "known" }, disposition: "attempted",
      output: { ok: true, choice: "related", confidence: 0.8, probabilities: { related: 0.8, unrelated: 0.1, abstain: 0.1 } } } });
    if (!("record" in result)) throw new Error(`Unexpected mapping skip: ${result.skip}`);
    return result.record;
  }
  function claim(q: AdvisoryQuestion, target = { job, lease }) {
    const identity = provider.prepareDecision(expectedDecisionInput(q)).identity;
    const input = { question: q, job_id: target.job.id, principal: owner,
      owner: target.lease.owner, fence: target.lease.fence, request_hash: identity.request_hash, config_hash: identity.config_hash };
    return brain.store.transaction(() => claimDecisionAttempt(brain.store, input, clock));
  }
  function save(q: AdvisoryQuestion, targetLease = lease) {
    return brain.saveDecisionAdvisory(owner, { idempotency_key: decisionAdvisoryKey(q), record: mapped(q), lease: targetLease });
  }
  return { root, runtime, brain, owner, a, b, worker, goal, publicId, privateId, foreignId,
    job, lease, provider, createJob, context, mapped, claim, save,
    close() { handle.release(); runtime.close(); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } };
}

it("derives current context from one bound account and excludes private and foreign-project source text", () => {
  const f = fixture();
  try {
    const q = f.context();
    expect(q.goal.plan_version).toBe(0);
    expect(q.sources.map((s) => s.source_id)).toEqual([f.publicId]);
    expect(JSON.stringify(q)).toContain("SYNTHETIC_PUBLIC_BETA_INPUT");
    expect(JSON.stringify(q)).not.toContain("SYNTHETIC_PRIVATE_DO_NOT_SEND");
    expect(JSON.stringify(q)).not.toContain("SYNTHETIC_OTHER_PROJECT_DO_NOT_SEND");
    const other = f.runtime.acquire(f.b.id);
    try { expect(() => f.brain.decisionAdvisoryContext(other.brain.ownerPrincipal(), f.goal.id)).toThrow(); }
    finally { other.release(); }
  } finally { f.close(); }
});

it("cannot save an unclaimed prediction or create a visible public entity from an internal advisory", () => {
  const f = fixture();
  try {
    const q = f.context();
    expect(() => f.save(q)).toThrow();
    expect(f.brain.store.all("SELECT id FROM entities WHERE kind='advisory'")).toEqual([]);
    expect(f.claim(q).claimed).toBe(true);
    const saved = f.save(q);
    expect(saved.kind).toBe("advisory");
    expect(f.brain.decisionAdvisory(f.owner, saved.id)).toEqual(f.mapped(q));
    expect(() => f.brain.entity(f.owner, saved.id)).toThrow();
    expect(f.brain.entities(f.owner, "advisory")).toEqual([]);
    const grant = f.brain.createGrant(f.owner, { projects: ["inbox"], operations: ["read"], expires_at: "2026-10-17T13:00:00.000Z" });
    const agent = f.brain.authenticateAgent(grant.token);
    expect(() => f.brain.decisionAdvisory(agent, saved.id)).toThrow();
    expect(() => f.brain.entity(agent, saved.id)).toThrow();
    expect(f.brain.store.get("SELECT state,advisory_id FROM advisory_attempts WHERE idempotency_key=?", decisionAdvisoryKey(q))).toMatchObject({ state: "published", advisory_id: saved.id });
    expect(f.brain.store.all("SELECT * FROM provider_dispatches")).toEqual([]);
  } finally { f.close(); }
});

it("never includes a real quarantined capture in the decision question", () => {
  const f = fixture();
  try {
    const captured = f.brain.capture(f.owner, { title: "SYNTHETIC scanner fixture",
      body: "api_key=SYNTHETIC_NON_SECRET_MATCH_12345678", visibility: "project" });
    expect(captured).toMatchObject({ quarantined: true });
    const q = f.context();
    expect(q.sources.map((s) => s.source_id)).not.toContain(captured.source_id);
    expect(JSON.stringify(q)).not.toContain("SYNTHETIC_NON_SECRET_MATCH_12345678");
  } finally { f.close(); }
});

it("rolls back the entity and history if the claimed-to-published CAS is silently ignored", () => {
  const f = fixture();
  try {
    const q = f.context(); f.claim(q);
    f.brain.store.db.exec("CREATE TRIGGER synthetic_ignore_publish BEFORE UPDATE ON advisory_attempts WHEN NEW.state='published' BEGIN SELECT RAISE(IGNORE); END;");
    expect(() => f.save(q)).toThrow();
    expect(f.brain.store.all("SELECT id FROM entities WHERE kind='advisory'")).toEqual([]);
    expect(readDecisionAttempt(f.brain.store, decisionAdvisoryKey(q))).toMatchObject({ state: "claimed", advisory_id: null });
    f.brain.store.db.exec("DROP TRIGGER synthetic_ignore_publish");
    const saved = f.save(q);
    expect(f.brain.store.get("SELECT COUNT(*) AS n FROM entity_versions WHERE entity_id=?", saved.id)?.n).toBe(1);
  } finally { f.close(); }
});

it("requires an owned tenant transaction even when the job and question otherwise match", () => {
  const f = fixture();
  try {
    const q = f.context(), identity = f.provider.prepareDecision(expectedDecisionInput(q)).identity;
    const input = { question: q, job_id: f.job.id, principal: f.owner, owner: f.lease.owner,
      fence: f.lease.fence, request_hash: identity.request_hash, config_hash: identity.config_hash };
    expect(() => claimDecisionAttempt(f.brain.store, input, clock)).toThrow();
    expect(readDecisionAttempt(f.brain.store, decisionAdvisoryKey(q))).toBeUndefined();
  } finally { f.close(); }
});

it.each(["publish", "unavailable", "purge"])("also refuses a transactionless %s mutation", (operation) => {
  const f = fixture();
  try {
    const q = f.context(); f.claim(q); const key = decisionAdvisoryKey(q);
    expect(() => {
      if (operation === "publish") publishDecisionAttempt(f.brain.store, key, randomUUID(), clock);
      else if (operation === "unavailable") markDecisionAttemptUnavailable(f.brain.store, key, clock);
      else purgeDecisionAttempts(f.brain.store, () => true, clock);
    }).toThrow();
    expect(readDecisionAttempt(f.brain.store, key)).toMatchObject({ state: "claimed", advisory_id: null });
  } finally { f.close(); }
});

it("does not infer a local owner's tenant from a UUID-shaped directory name", () => {
  const f = fixture();
  let local: Storage | undefined;
  try {
    const q = f.context();
    local = new Storage(join(f.root, "separate-local", randomUUID(), "brain.sqlite"));
    const brain = new Brain(local, clock), principal = brain.ownerPrincipal();
    expect(principal).toEqual({ kind: "owner" });
    const job = randomUUID();
    local.run("INSERT INTO jobs(id,project_id,kind,payload,status,next_at,lease_owner,lease_until,fence,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      job, "inbox", "review_changed_assumption", JSON.stringify({ goal_id: q.goal.goal_id, principal }), "running",
      clock().toISOString(), "synthetic-local-worker", "2026-10-17T12:01:00.000Z", 1, clock().toISOString());
    const identity = f.provider.prepareDecision(expectedDecisionInput(q)).identity;
    const input = { question: q, job_id: job, principal, owner: "synthetic-local-worker", fence: 1,
      request_hash: identity.request_hash, config_hash: identity.config_hash };
    const store = local;
    expect(store.transaction(() => claimDecisionAttempt(store, input, clock))).toMatchObject({ claimed: true });
  } finally { local?.close(); f.close(); }
});

it.each([
  ["question_hash", "UPDATE advisory_attempts SET question_hash=? WHERE idempotency_key=?", "f".repeat(64)],
  ["goal_entity_version", "UPDATE advisory_attempts SET goal_entity_version=? WHERE idempotency_key=?", 999],
  ["plan_version", "UPDATE advisory_attempts SET plan_version=? WHERE idempotency_key=?", 999],
  ["project_id", "UPDATE advisory_attempts SET project_id=? WHERE idempotency_key=?", "synthetic-foreign-project"],
  ["source_refs_json", "UPDATE advisory_attempts SET source_refs_json=? WHERE idempotency_key=?", "[]"],
  ["request_hash", "UPDATE advisory_attempts SET request_hash=? WHERE idempotency_key=?", "e".repeat(64)],
  ["config_hash", "UPDATE advisory_attempts SET config_hash=? WHERE idempotency_key=?", "d".repeat(64)],
])("cannot publish after the immutable claim's %s is replaced", (_field, sql, replacement) => {
  const f = fixture();
  try {
    const q = f.context(); f.claim(q); const key = decisionAdvisoryKey(q);
    const before = readDecisionAttempt(f.brain.store, key);
    let rejected = false;
    try { f.brain.store.run(sql, replacement, key); } catch { rejected = true; }
    if (rejected) expect(readDecisionAttempt(f.brain.store, key)).toEqual(before);
    else {
      expect(() => f.save(q)).toThrow();
      expect(f.brain.store.all("SELECT id FROM entities WHERE kind='advisory'")).toEqual([]);
    }
  } finally { f.close(); }
});

it.each([
  ["expired deadline", "UPDATE jobs SET lease_until='2026-10-17T12:00:00.000Z' WHERE id=?"],
  ["malformed deadline", "UPDATE jobs SET lease_until='invalid-date' WHERE id=?"],
  ["foreign lease owner", "UPDATE jobs SET lease_owner='synthetic-foreign-worker' WHERE id=?"],
  ["changed fence", "UPDATE jobs SET fence=2 WHERE id=?"],
  ["wrong job kind", "UPDATE jobs SET kind='derive_brief' WHERE id=?"],
  ["stopped job", "UPDATE jobs SET status='cancelled' WHERE id=?"],
])("refuses a new attempt under an actual %s", (_label, sql) => {
  const f = fixture();
  try {
    const q = f.context();
    // Negative integrity fixture: change the real leased job, not a permission callback.
    f.brain.store.run(sql, f.job.id);
    expect(() => f.claim(q)).toThrow();
    expect(readDecisionAttempt(f.brain.store, decisionAdvisoryKey(q))).toBeUndefined();
  } finally { f.close(); }
});

it("binds publication to the original job, not just an owner/fence shared by another running job", () => {
  const f = fixture();
  try {
    const q = f.context(); f.claim(q);
    const other = f.createJob();
    expect(other.lease.owner).toBe(f.lease.owner);
    expect(other.lease.fence).toBe(f.lease.fence);
    expect(() => f.save(q, other.lease)).toThrow();
    expect(f.brain.store.all("SELECT id FROM entities WHERE kind='advisory'")).toEqual([]);
    expect(f.save(q).kind).toBe("advisory");
  } finally { f.close(); }
});

it("revalidates the actual payload principal before claim and again before publication", () => {
  const f = fixture();
  try {
    const q = f.context(), other = f.runtime.acquire(f.b.id);
    const original = f.brain.store.get("SELECT payload FROM jobs WHERE id=?", f.job.id)!.payload;
    try {
      const foreignPayload = JSON.stringify({ goal_id: f.goal.id, principal: other.brain.ownerPrincipal(), manual: true });
      f.brain.store.run("UPDATE jobs SET payload=? WHERE id=?", foreignPayload, f.job.id);
      expect(() => f.claim(q)).toThrow();
      expect(readDecisionAttempt(f.brain.store, decisionAdvisoryKey(q))).toBeUndefined();
      f.brain.store.run("UPDATE jobs SET payload=? WHERE id=?", original, f.job.id);
      f.claim(q);
      f.brain.store.run("UPDATE jobs SET payload=? WHERE id=?", foreignPayload, f.job.id);
      expect(() => f.save(q)).toThrow();
      expect(f.brain.store.all("SELECT id FROM entities WHERE kind='advisory'")).toEqual([]);
    } finally { other.release(); }
  } finally { f.close(); }
});

it("does not publish after an actual lease expires following a valid claim", () => {
  const f = fixture();
  try {
    const q = f.context(); f.claim(q);
    f.brain.store.run("UPDATE jobs SET lease_until=? WHERE id=?", clock().toISOString(), f.job.id);
    expect(() => f.save(q)).toThrow();
    expect(f.brain.store.all("SELECT id FROM entities WHERE kind='advisory'")).toEqual([]);
    expect(readDecisionAttempt(f.brain.store, decisionAdvisoryKey(q))).toMatchObject({ state: "claimed" });
  } finally { f.close(); }
});

it("rechecks goal and source scope before publication and withdraws an already stored result on privacy change", () => {
  const f = fixture();
  try {
    const q = f.context(); f.claim(q);
    const saved = f.save(q), original = f.brain.source(f.owner, f.publicId);
    f.brain.editSource(f.owner, f.publicId, { expected_version: original.version, title: original.title, body: original.body, visibility: "private" });
    expect(JSON.parse(f.brain.store.get("SELECT data FROM entities WHERE id=?", saved.id)!.data).status).toBe("withdrawn");
    expect(f.brain.decisionAdvisory(f.owner, saved.id)).toBeUndefined();
    expect(f.brain.decisionAdvisoriesForGoal(f.owner, f.goal.id)).toEqual([]);
    expect(() => f.save(q)).toThrow();
  } finally { f.close(); }
});

it("withdraws a stored judgment when the bound goal plan changes through the real edit operation", () => {
  const f = fixture();
  try {
    const q = f.context(); f.claim(q); const saved = f.save(q);
    f.brain.editGoal(f.owner, f.goal.id, { expected_version: f.goal.version, plan: "SYNTHETIC later human plan" });
    expect(JSON.parse(f.brain.store.get("SELECT data FROM entities WHERE id=?", saved.id)!.data).status).toBe("withdrawn");
    expect(f.brain.decisionAdvisory(f.owner, saved.id)).toBeUndefined();
  } finally { f.close(); }
});

it("checks current visibility on read even when a stale projection retained the source version", () => {
  const f = fixture();
  try {
    const q = f.context(); f.claim(q); const saved = f.save(q);
    // Negative stale-projection fixture: no normal edit/invalidation helper runs.
    f.brain.store.run("UPDATE sources SET visibility='private' WHERE id=?", f.publicId);
    expect(f.brain.source(f.owner, f.publicId).version).toBe(q.sources[0].source_version);
    expect(f.brain.decisionAdvisory(f.owner, saved.id)).toBeUndefined();
    expect(f.brain.decisionAdvisoriesForGoal(f.owner, f.goal.id)).toEqual([]);
  } finally { f.close(); }
});

it.each([{ provider_enabled: false }, { decision_provider_enabled: false }, { enabled: false }])("withdraws stored judgments when background permission is removed: %j", (change) => {
  const f = fixture();
  try {
    const q = f.context(); f.claim(q); const saved = f.save(q);
    f.brain.prefs(f.owner, { ...f.brain.prefs(f.owner), ...change });
    expect(JSON.parse(f.brain.store.get("SELECT data FROM entities WHERE id=?", saved.id)!.data).status).toBe("withdrawn");
    expect(f.brain.decisionAdvisoriesForGoal(f.owner, f.goal.id)).toEqual([]);
    expect(f.brain.decisionAdvisoryContext(f.owner, f.goal.id).ok).toBe(false);
  } finally { f.close(); }
});

it("does not revive a withdrawn judgment when background help is resumed with unchanged context", () => {
  const f = fixture();
  try {
    const q = f.context(); f.claim(q); const saved = f.save(q);
    f.brain.prefs(f.owner, { ...f.brain.prefs(f.owner), enabled: false });
    f.brain.prefs(f.owner, { ...f.brain.prefs(f.owner), enabled: true });
    expect(f.context().question_hash).toBe(q.question_hash);
    expect(f.brain.decisionAdvisory(f.owner, saved.id)).toBeUndefined();
    expect(f.brain.decisionAdvisoriesForGoal(f.owner, f.goal.id)).toEqual([]);
  } finally { f.close(); }
});

it("round-trips owner export while making imported judgments unavailable and importing no execution claims", () => {
  const f = fixture();
  try {
    const q = f.context(); f.claim(q); const saved = f.save(q);
    const exported = f.brain.export(f.owner);
    expect(exported.payload.entities.find((e) => e.id === saved.id)).toMatchObject({ kind: "advisory" });
    const target = f.runtime.acquire(f.b.id);
    try {
      const owner = target.brain.ownerPrincipal();
      target.brain.applyImport(owner, target.brain.preview(owner, exported).id);
      const imported = target.brain.store.get("SELECT data FROM entities WHERE id=?", saved.id);
      expect(JSON.parse(imported!.data)).toMatchObject({ status: "unavailable", judgment: null });
      expect(target.brain.store.all("SELECT * FROM advisory_attempts")).toEqual([]);
      target.brain.applyImport(owner, target.brain.preview(owner, exported).id);
      expect(target.brain.store.get("SELECT COUNT(*) AS n FROM entities WHERE id=?", saved.id)?.n).toBe(1);
    } finally { target.release(); }
  } finally { f.close(); }
});

it("round-trips an exported historical advisory and its legitimately retained source version", () => {
  const f = fixture();
  try {
    const q = f.context(); f.claim(q); const saved = f.save(q), original = f.brain.source(f.owner, f.publicId);
    f.brain.editSource(f.owner, f.publicId, { expected_version: original.version,
      title: original.title, body: "SYNTHETIC_EDITED_PUBLIC_BETA_INPUT" });
    const exported = f.brain.export(f.owner), target = f.runtime.acquire(f.b.id);
    expect(exported.payload.sources.some((s) => s.id === f.publicId && s.version === original.version && s.body === original.body)).toBe(true);
    try {
      const owner = target.brain.ownerPrincipal();
      target.brain.applyImport(owner, target.brain.preview(owner, exported).id);
      expect(JSON.parse(target.brain.store.get("SELECT data FROM entities WHERE id=?", saved.id)!.data)).toMatchObject({ status: "unavailable", judgment: null });
      expect(target.brain.store.get("SELECT body FROM source_versions WHERE source_id=? AND version=?", f.publicId, original.version)).toMatchObject({ body: original.body });
      expect(target.brain.store.all("SELECT * FROM advisory_attempts")).toEqual([]);
    } finally { target.release(); }
  } finally { f.close(); }
});

it("can import a scoped historical advisory after its source moved away without inventing missing source history", () => {
  const f = fixture();
  try {
    const q = f.context(); f.claim(q); const saved = f.save(q), original = f.brain.source(f.owner, f.publicId);
    const destination = f.brain.createProject(f.owner, "SYNTHETIC moved-source destination");
    f.brain.editSource(f.owner, f.publicId, { expected_version: original.version, title: original.title,
      body: original.body, project_id: destination.id });
    const exported = f.brain.export(f.owner, "inbox");
    expect(exported.payload.sources.some((s) => s.id === f.publicId)).toBe(false);
    expect(exported.payload.entities.some((e) => e.id === saved.id)).toBe(true);
    const target = f.runtime.acquire(f.b.id);
    try {
      const owner = target.brain.ownerPrincipal();
      target.brain.applyImport(owner, target.brain.preview(owner, exported).id);
      expect(JSON.parse(target.brain.store.get("SELECT data FROM entities WHERE id=?", saved.id)!.data)).toMatchObject({ status: "unavailable", judgment: null });
      expect(target.brain.store.all("SELECT * FROM source_versions WHERE source_id=?", f.publicId)).toEqual([]);
      expect(target.brain.store.all("SELECT * FROM advisory_attempts")).toEqual([]);
      expect(target.brain.decisionAdvisory(owner, saved.id)).toBeUndefined();
    } finally { target.release(); }
  } finally { f.close(); }
});

it.each(["body_hash", "project_id"])("does not import available provenance that contradicts its declared %s", (field) => {
  const f = fixture();
  try {
    const q = f.context(); f.claim(q); const saved = f.save(q);
    const exported = structuredClone(f.brain.export(f.owner));
    const e = exported.payload.entities.find((entity) => entity.id === saved.id)!;
    if (field === "project_id") e.data.project_id = "synthetic-inconsistent-project";
    else e.data.sources[0].body_hash = "0".repeat(64);
    exported.checksum = hash(canonical(exported.payload));
    const target = f.runtime.acquire(f.b.id);
    try {
      const owner = target.brain.ownerPrincipal(), preview = target.brain.preview(owner, exported);
      expect(() => target.brain.applyImport(owner, preview.id)).toThrow();
      expect(target.brain.store.get("SELECT id FROM entities WHERE id=?", saved.id)).toBeUndefined();
    } finally { target.release(); }
  } finally { f.close(); }
});

it("purges all advisory versions and operational references while retaining only hash tombstones", () => {
  const f = fixture();
  try {
    const q = f.context(); f.claim(q); const saved = f.save(q), key = decisionAdvisoryKey(q);
    f.brain.prefs(f.owner, { ...f.brain.prefs(f.owner), enabled: false });
    expect(f.brain.store.get("SELECT COUNT(*) AS n FROM entity_versions WHERE entity_id=?", saved.id)?.n).toBeGreaterThan(1);
    f.brain.removeSource(f.owner, f.publicId, f.brain.source(f.owner, f.publicId).version, true);
    expect(f.brain.store.get("SELECT id FROM entities WHERE id=?", saved.id)).toBeUndefined();
    expect(f.brain.store.all("SELECT * FROM entity_versions WHERE entity_id=?", saved.id)).toEqual([]);
    expect(readDecisionAttempt(f.brain.store, key)).toBeUndefined();
    const tombstones = f.brain.store.all("SELECT * FROM advisory_tombstones WHERE idempotency_key=?", key);
    expect(tombstones).toHaveLength(1);
    expect(JSON.stringify(tombstones)).not.toContain(f.publicId);
    expect(JSON.stringify(tombstones)).not.toContain(f.goal.id);
    expect(JSON.stringify(tombstones)).not.toContain(saved.id);
    expect(f.brain.store.vault!.verifyForget(f.publicId)).toMatchObject({ file_gone: true });
    // The vault verifies file/Git erasure; the real SQLite FTS check is separate.
    expect(f.brain.store.all("SELECT * FROM source_fts WHERE source_id=?", f.publicId)).toEqual([]);
  } finally { f.close(); }
}, 30_000);

it("the shared local/managed restore barrier withdraws advisories without silently changing raw decision consent", () => {
  const f = fixture();
  try {
    const q = f.context(); f.claim(q); const saved = f.save(q);
    applyRestoreSafetyBarrier(f.brain.store, clock);
    expect(f.brain.backgroundConsent(f.owner)).toBe(false);
    expect(f.brain.decisionBackgroundConsent(f.owner)).toBe(true);
    expect(JSON.parse(f.brain.store.get("SELECT data FROM entities WHERE id=?", saved.id)!.data).status).toBe("withdrawn");
    expect(f.brain.decisionAdvisory(f.owner, saved.id)).toBeUndefined();
  } finally { f.close(); }
});

it("the shared retained-source purge removes attempt references from a stale backup, not just entity data", () => {
  const f = fixture();
  try {
    const q = f.context(); f.claim(q); const saved = f.save(q), key = decisionAdvisoryKey(q);
    // Negative restore fixture: a tombstone exists but old source/entity versions
    // and the operational attempt still survive in the backup being replayed.
    f.brain.store.run("UPDATE sources SET state='deleted' WHERE id=?", f.publicId);
    purgeRetainedDeletedSource(f.brain.store, f.publicId);
    expect(f.brain.store.all("SELECT * FROM source_versions WHERE source_id=?", f.publicId)).toEqual([]);
    expect(f.brain.store.get("SELECT id FROM entities WHERE id=?", saved.id)).toBeUndefined();
    expect(f.brain.store.all("SELECT * FROM entity_versions WHERE entity_id=?", saved.id)).toEqual([]);
    expect(readDecisionAttempt(f.brain.store, key)).toBeUndefined();
    expect(f.brain.store.get("SELECT idempotency_key FROM advisory_tombstones WHERE idempotency_key=?", key)?.idempotency_key).toBe(key);
  } finally { f.close(); }
});

it.each([
  ["tombstone insert", "CREATE TRIGGER synthetic_ignore_purge BEFORE INSERT ON advisory_tombstones BEGIN SELECT RAISE(IGNORE); END;"],
  ["attempt delete", "CREATE TRIGGER synthetic_ignore_purge BEFORE DELETE ON advisory_attempts BEGIN SELECT RAISE(IGNORE); END;"],
])("does not report a successful forget when its %s was silently ignored", (_label, trigger) => {
  const f = fixture();
  try {
    const q = f.context(); f.claim(q); const saved = f.save(q), key = decisionAdvisoryKey(q);
    f.brain.store.db.exec(trigger);
    expect(() => f.brain.removeSource(f.owner, f.privateId, f.brain.source(f.owner, f.privateId).version, true)).toThrow();
    expect(f.brain.store.get("SELECT state FROM sources WHERE id=?", f.privateId)).toMatchObject({ state: "active" });
    expect(readDecisionAttempt(f.brain.store, key)).toMatchObject({ state: "published", advisory_id: saved.id });
  } finally { f.close(); }
}, 30_000);

it("cannot pay for an identical question again after a conservative purge of an excluded source", () => {
  const f = fixture();
  try {
    const ids = [f.publicId];
    for (let i = 0; i < 11; i++) ids.push(f.brain.capture(f.owner, { title: `SYNTHETIC additional note ${i}`, body: `SYNTHETIC further beta evidence number ${i}.`, visibility: "project" }).source_id);
    const q = f.context(), selected = new Set(q.sources.map((s) => s.source_id));
    const excluded = ids.find((id) => !selected.has(id))!;
    expect(excluded).toBeTruthy();
    f.claim(q); const saved = f.save(q);
    f.brain.removeSource(f.owner, excluded, f.brain.source(f.owner, excluded).version, true);
    expect(f.brain.store.get("SELECT id FROM entities WHERE id=?", saved.id)).toBeUndefined();
    const current = f.context();
    expect(current.question_hash).toBe(q.question_hash);
    expect(f.claim(current, f.createJob())).toEqual({ claimed: false, reason: "tombstoned" });
  } finally { f.close(); }
}, 30_000);
