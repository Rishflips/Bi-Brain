import type { AdvisoryQuestion } from "../domain/decision-advisory.ts";
import { validateAdvisoryQuestion } from "../domain/decision-advisory.ts";
import { BrainError, canonical, hash } from "../domain/logic.ts";
import type { Principal } from "../contracts/index.ts";
import type { Storage } from "./index.ts";

/**
 * Narrow, typed operational store for the advisory decision pass.
 *
 * The new tables are never written by broad ad-hoc SQL: every claim, publish and
 * tombstone goes through this module. None of these helpers open a transaction of
 * their own — the caller must own a real `Storage.transaction` (BEGIN IMMEDIATE),
 * which is asserted at entry. A claim commits before any central reserve; no
 * transaction ever spans the tenant and control databases and no provider or
 * central money I/O runs under this lock. A claim that cannot proceed is the
 * conservative `claimed:false` outcome; an orphaned claim is marked `unavailable`
 * with no fabricated charge and is never re-sent.
 *
 * The idempotency key binds the goal entity/plan versions, the ordered selected
 * source refs, the pinned policy version and the whole canonical question hash.
 * The account is implicit in the tenant database, and the trusted owner principal
 * is passed in by the application service. A tombstone carries only opaque
 * hashes/time, never a source id, goal id, body or advisory ref.
 */

export type AdvisoryAttemptState = "claimed" | "published" | "unavailable";

export interface AdvisoryAttemptRow {
  idempotency_key: string;
  job_id: string;
  dispatch_key: "decision";
  project_id: string;
  goal_id: string;
  goal_entity_version: number;
  plan_version: number;
  source_refs_json: string;
  request_hash: string;
  config_hash: string;
  question_hash: string;
  owner: string;
  fence: number;
  state: AdvisoryAttemptState;
  advisory_id: string | null;
  claimed_at: string;
  updated_at: string;
}

export type AdvisoryClaimResult =
  | { claimed: true; row: AdvisoryAttemptRow }
  | { claimed: false; reason: "exists"; row: AdvisoryAttemptRow }
  | { claimed: false; reason: "tombstoned" };

export interface AdvisoryClaimInput {
  question: AdvisoryQuestion;
  /**
   * Trusted owner principal supplied by the application service from the actual
   * `Brain.ownerPrincipal`, never a browser/agent field. The repository only
   * checks the structural claim; the service binds it to the real account.
   */
  principal: Principal;
  job_id: string;
  owner: string;
  fence: number;
  request_hash: string;
  config_hash: string;
}

const HEX = /^[0-9a-f]{64}$/;
const MAX_INT = Number.MAX_SAFE_INTEGER;
const invalid = (message: string) => new BrainError("INVALID_INPUT", message, 400);
const corrupt = () =>
  new BrainError("UNAVAILABLE", "The advisory attempt record is corrupt.", 503);

/** Every mutator requires a real caller-owned BEGIN IMMEDIATE transaction. */
function requireOwnedTransaction(store: Storage): void {
  if (store.db.isTransaction !== true)
    throw new BrainError(
      "UNAVAILABLE",
      "Advisory mutations require an owned transaction.",
      503,
    );
}

function boundedText(value: unknown, field: string, max = 200): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max)
    throw invalid(`Invalid ${field}.`);
  return value;
}

function sha256Hex(value: unknown, field: string): string {
  if (typeof value !== "string" || !HEX.test(value))
    throw invalid(`Invalid ${field}: expected a lowercase SHA-256 digest.`);
  return value;
}

function safeFence(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_INT)
    throw invalid("Invalid advisory fence.");
  return value;
}

/**
 * Stable idempotency key for one advisory question. Account is implicit in the
 * tenant database, so it is deliberately not part of the material.
 */
export function decisionAdvisoryKey(question: AdvisoryQuestion): string {
  const valid = validateAdvisoryQuestion(question);
  return hash(
    canonical({
      goal_id: valid.goal.goal_id,
      goal_entity_version: valid.goal.goal_entity_version,
      plan_version: valid.goal.plan_version,
      sources: valid.sources.map((source) => ({
        source_id: source.source_id,
        source_version: source.source_version,
        body_hash: source.body_hash,
      })),
      policy_version: valid.policy_version,
      question_hash: valid.question_hash,
    }),
  );
}

function refsIncludeSource(refsJson: string, sourceId: string): boolean {
  try {
    const refs = JSON.parse(refsJson);
    return (
      Array.isArray(refs) &&
      refs.some(
        (ref) => !!ref && typeof ref === "object" && (ref as { source_id?: unknown }).source_id === sourceId,
      )
    );
  } catch {
    return false;
  }
}

const ATTEMPT_STATES: readonly AdvisoryAttemptState[] = ["claimed", "published", "unavailable"];

function mapRow(row: any): AdvisoryAttemptRow {
  // Fail closed on a corrupt/hand-edited row rather than silently coercing a
  // foreign stage or a non-integer identity into a "decision" attempt.
  if (row.dispatch_key !== "decision" || !ATTEMPT_STATES.includes(row.state)) throw corrupt();
  for (const field of ["idempotency_key", "request_hash", "config_hash", "question_hash"]) {
    if (typeof row[field] !== "string" || !HEX.test(row[field])) throw corrupt();
  }
  const goalEntityVersion = Number(row.goal_entity_version);
  const planVersion = Number(row.plan_version);
  const fence = Number(row.fence);
  if (!Number.isSafeInteger(goalEntityVersion) || goalEntityVersion < 1) throw corrupt();
  if (!Number.isSafeInteger(planVersion) || planVersion < 0) throw corrupt();
  if (!Number.isSafeInteger(fence) || fence < 0) throw corrupt();
  return {
    idempotency_key: row.idempotency_key,
    job_id: String(row.job_id),
    dispatch_key: "decision",
    project_id: String(row.project_id),
    goal_id: String(row.goal_id),
    goal_entity_version: goalEntityVersion,
    plan_version: planVersion,
    source_refs_json: String(row.source_refs_json),
    request_hash: row.request_hash,
    config_hash: row.config_hash,
    question_hash: row.question_hash,
    owner: String(row.owner),
    fence,
    state: row.state,
    advisory_id: row.advisory_id === null || row.advisory_id === undefined ? null : String(row.advisory_id),
    claimed_at: String(row.claimed_at),
    updated_at: String(row.updated_at),
  };
}

export function readDecisionAttempt(store: Storage, key: string): AdvisoryAttemptRow | undefined {
  const row = store.get("SELECT * FROM advisory_attempts WHERE idempotency_key=?", key);
  return row ? mapRow(row) : undefined;
}

/**
 * Re-reads the ACTUAL tenant job and its live lease. Ownership is never a caller
 * boolean: the job row's kind/project/payload/goal and the captured
 * owner/fence plus a strict future expiry are all re-derived here. The job
 * payload's owner principal must be bound to the SAME account as the trusted
 * principal the application service passed in. A NaN or missing deadline fails
 * closed.
 */
function requireBoundJob(
  store: Storage,
  input: {
    principal: Principal;
    job_id: string;
    owner: string;
    fence: number;
    project_id: string;
    goal_id: string;
  },
  clock: () => Date,
): void {
  if (input.principal?.kind !== "owner")
    throw new BrainError("FORBIDDEN", "The bound principal is not an owner.", 403);
  const job = store.get<{
    project_id: string;
    kind: string;
    payload: string;
    status: string;
    lease_owner: string | null;
    lease_until: string | null;
    fence: number;
  }>("SELECT project_id,kind,payload,status,lease_owner,lease_until,fence FROM jobs WHERE id=?", input.job_id);
  if (!job) throw new BrainError("NOT_FOUND", "Unknown job.", 404);
  if (job.kind !== "review_changed_assumption")
    throw new BrainError("FORBIDDEN", "This job is not an advisory review job.", 403);
  if (job.project_id !== input.project_id)
    throw new BrainError("FORBIDDEN", "This job belongs to another project.", 403);
  if (job.status !== "running" || job.lease_owner !== input.owner || job.fence !== input.fence)
    throw new BrainError("LEASE_LOST", "This worker no longer holds the job.", 409);
  const expiry = job.lease_until ? Date.parse(job.lease_until) : Number.NaN;
  if (!Number.isFinite(expiry) || expiry <= clock().getTime())
    throw new BrainError("LEASE_EXPIRED", "The worker lease has expired.", 409);
  let payload: { goal_id?: unknown; principal?: { kind?: unknown; tenantId?: unknown } } | undefined;
  try {
    payload = JSON.parse(job.payload);
  } catch {
    payload = undefined;
  }
  if (!payload || typeof payload !== "object")
    throw new BrainError("FORBIDDEN", "The job payload is not bound.", 403);
  if (payload.goal_id !== input.goal_id)
    throw new BrainError("FORBIDDEN", "The job does not target this goal.", 403);
  if (payload.principal?.kind !== "owner")
    throw new BrainError("FORBIDDEN", "The job is not an owner-bound review.", 403);
  // The job's owner principal must be bound to the SAME account as the trusted
  // principal the application service passed from the real owner.
  if (
    (payload.principal.tenantId ?? undefined) !==
    (input.principal.tenantId ?? undefined)
  )
    throw new BrainError(
      "FORBIDDEN",
      "The job principal is not bound to this account.",
      403,
    );
}

/**
 * Claims a single advisory attempt for the passed question, bound to the actual
 * running job. Must run inside a caller-owned tenant transaction. Returns the
 * exact immutable row on a fresh claim, the existing row when already claimed, or
 * a tombstone outcome that carries NO fabricated row.
 */
export function claimDecisionAttempt(
  store: Storage,
  input: AdvisoryClaimInput,
  clock: () => Date,
): AdvisoryClaimResult {
  requireOwnedTransaction(store);
  if (!input || typeof input !== "object") throw invalid("An advisory claim is required.");
  const question = validateAdvisoryQuestion(input.question);
  const job_id = boundedText(input.job_id, "job_id");
  const owner = boundedText(input.owner, "owner");
  const fence = safeFence(input.fence);
  const request_hash = sha256Hex(input.request_hash, "request_hash");
  const config_hash = sha256Hex(input.config_hash, "config_hash");
  requireBoundJob(
    store,
    {
      principal: input.principal,
      job_id,
      owner,
      fence,
      project_id: question.goal.project_id,
      goal_id: question.goal.goal_id,
    },
    clock,
  );
  const key = decisionAdvisoryKey(question);
  if (store.get("SELECT 1 AS present FROM advisory_tombstones WHERE idempotency_key=?", key))
    return { claimed: false, reason: "tombstoned" };
  const now = clock().toISOString();
  const refs = canonical(
    question.sources.map((source) => ({
      source_id: source.source_id,
      source_version: source.source_version,
      body_hash: source.body_hash,
    })),
  );
  const inserted = store.run(
    `INSERT INTO advisory_attempts(
      idempotency_key,job_id,dispatch_key,project_id,goal_id,goal_entity_version,plan_version,
      source_refs_json,request_hash,config_hash,question_hash,owner,fence,state,advisory_id,claimed_at,updated_at)
     VALUES(?,?,'decision',?,?,?,?,?,?,?,?,?,?,'claimed',NULL,?,?)
     ON CONFLICT(idempotency_key) DO NOTHING`,
    key,
    job_id,
    question.goal.project_id,
    question.goal.goal_id,
    question.goal.goal_entity_version,
    question.goal.plan_version,
    refs,
    request_hash,
    config_hash,
    question.question_hash,
    owner,
    fence,
    now,
    now,
  );
  const row = readDecisionAttempt(store, key);
  if (!row) throw new BrainError("UNAVAILABLE", "Advisory claim could not be recorded.", 503);
  if (inserted.changes === 1) return { claimed: true, row };
  return { claimed: false, reason: "exists", row };
}

/** CAS `claimed -> published` for the advisory entity created in the same TX. */
export function publishDecisionAttempt(
  store: Storage,
  key: string,
  advisoryId: string,
  clock: () => Date,
): void {
  requireOwnedTransaction(store);
  const idempotency_key = sha256Hex(key, "idempotency_key");
  const advisory_id = boundedText(advisoryId, "advisory_id");
  const row = readDecisionAttempt(store, idempotency_key);
  if (!row) throw new BrainError("NOT_FOUND", "No advisory claim to publish.", 404);
  if (row.state === "published") {
    if (row.advisory_id === advisory_id) return;
    throw new BrainError("VERSION_CONFLICT", "The advisory claim was already published.", 409);
  }
  const changed = store.run(
    "UPDATE advisory_attempts SET state='published',advisory_id=?,updated_at=? WHERE idempotency_key=? AND state='claimed'",
    advisory_id,
    clock().toISOString(),
    idempotency_key,
  );
  if (changed.changes !== 1)
    throw new BrainError("VERSION_CONFLICT", "The advisory claim changed.", 409);
}

/** CAS `claimed -> unavailable`; a published claim is never overwritten. */
export function markDecisionAttemptUnavailable(
  store: Storage,
  key: string,
  clock: () => Date,
): void {
  requireOwnedTransaction(store);
  const idempotency_key = sha256Hex(key, "idempotency_key");
  const row = readDecisionAttempt(store, idempotency_key);
  if (!row) throw new BrainError("NOT_FOUND", "No advisory claim to update.", 404);
  if (row.state === "unavailable") return;
  if (row.state !== "claimed")
    throw new BrainError("VERSION_CONFLICT", "The advisory claim was published.", 409);
  const changed = store.run(
    "UPDATE advisory_attempts SET state='unavailable',updated_at=? WHERE idempotency_key=? AND state='claimed'",
    clock().toISOString(),
    idempotency_key,
  );
  if (changed.changes !== 1)
    throw new BrainError("VERSION_CONFLICT", "The advisory claim changed.", 409);
}

/**
 * Hash-only tombstone + delete for every attempt the caller is about to purge.
 * Must run inside a caller-owned tenant transaction. The predicate is exact (an
 * id equality on a parsed ref or the project column), never a data substring.
 */
export function purgeDecisionAttempts(
  store: Storage,
  match: (row: AdvisoryAttemptRow) => boolean,
  clock: () => Date,
): number {
  requireOwnedTransaction(store);
  const now = clock().toISOString();
  let purged = 0;
  for (const raw of store.all("SELECT * FROM advisory_attempts")) {
    const row = mapRow(raw);
    if (!match(row)) continue;
    // A tombstone must exist exactly before the attempt can be deleted. INSERT OR
    // IGNORE legitimately changes zero rows when an identical tombstone already
    // exists, so read the persisted row back and require it to match.
    store.run(
      "INSERT OR IGNORE INTO advisory_tombstones(idempotency_key,question_hash,created_at) VALUES(?,?,?)",
      row.idempotency_key,
      row.question_hash,
      now,
    );
    const tombstone = store.get<{ question_hash: string }>(
      "SELECT question_hash FROM advisory_tombstones WHERE idempotency_key=?",
      row.idempotency_key,
    );
    if (!tombstone || tombstone.question_hash !== row.question_hash)
      throw new BrainError(
        "FORGET_INCOMPLETE",
        "The advisory tombstone could not be recorded; nothing was forgotten.",
        503,
      );
    const deleted = store.run(
      "DELETE FROM advisory_attempts WHERE idempotency_key=?",
      row.idempotency_key,
    );
    if (
      deleted.changes !== 1 ||
      store.get("SELECT 1 AS present FROM advisory_attempts WHERE idempotency_key=?", row.idempotency_key)
    )
      throw new BrainError(
        "FORGET_INCOMPLETE",
        "The advisory attempt could not be removed; nothing was forgotten.",
        503,
      );
    purged += 1;
  }
  return purged;
}

/** True when the attempt's parsed source refs reference this exact source id. */
export function attemptReferencesSource(row: AdvisoryAttemptRow, sourceId: string): boolean {
  return refsIncludeSource(row.source_refs_json, sourceId);
}
