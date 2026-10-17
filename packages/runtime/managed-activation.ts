import type { DatabaseSync } from "node:sqlite";
import { BrainError, canonical } from "../domain/logic.ts";
import {
  DECISION_GUARD_JOB_KIND,
  DECISION_GUARD_PURPOSE,
  guardMatchesLive,
  validateActivationGuard,
  validateDecisionActivationGuard,
  validateReasoningActivationGuard,
  type ActivationGuard,
  type ActivationProfile,
  type ActivationReason,
  type DecisionActivationGuard,
  type ReasoningActivationGuard,
  type SendGuardPhase,
} from "../domain/managed-activation.ts";
import type { DispatchStage, JobLease } from "../domain/spend.ts";
import {
  REASONING_DEFAULT_ENDPOINT,
  REASONING_PROMPT_VERSION_BRIEF,
  REASONING_PROMPT_VERSION_GOAL,
  preparedConfigHash,
} from "../providers/prepared.ts";
import {
  activationAuditDigest,
  managedControlSchemaVersion,
  readActivationMirror,
  readActivationRow,
  readGuardSnapshot,
  supportedActivationSchema,
  type ActivationReadState,
} from "../storage/managed-activation-state.ts";
import {
  assertTrustedManagedRoot,
  readRootMarker,
  rootEpochMatches,
} from "./managed-operator.ts";
import { readEnrollmentBaseline, readSendGuardBaseline } from "./managed-audit.ts";
import type { WorkerReadiness } from "./worker-readiness.ts";
import type { DecisionWorkerReadiness } from "./decision-worker-readiness.ts";
import { expectedDecisionConfigHash } from "../providers/prepared-decision.ts";
import {
  validateDecisionActivationProfile,
  type DecisionActivationProfile,
} from "../domain/managed-decision-activation.ts";
import {
  readDecisionActivationState,
  readDecisionGuardSnapshot,
} from "../storage/managed-decision-activation-state.ts";
import { readDecisionReadiness } from "./decision-worker-readiness.ts";

/**
 * Read-only shared activation loader.
 *
 * It accepts a structural `{ db, path }` control handle rather than a writable
 * store, so reading can never create a table, a marker or a root. It derives the
 * live state from the SQL row AND the mirror and never trusts a caller-supplied
 * profile or an environment endpoint to grant capability.
 */

export type AuditControl = { db: DatabaseSync; path: string };

export function readActivationState(
  control: AuditControl,
  root: string,
): ActivationReadState {
  // Fresh root/control containment on every read. A bad root, a missing control
  // database or a linked path reports a fail-closed mismatch; it never creates a
  // table, a marker or a root and never reads an environment endpoint.
  try {
    assertTrustedManagedRoot(root, control.path);
  } catch {
    return { state: "mismatch" };
  }
  let row: ActivationProfile | undefined;
  let mirror: ActivationProfile | undefined;
  let malformed = false;
  try {
    row = readActivationRow(control.db);
  } catch {
    malformed = true;
  }
  try {
    mirror = readActivationMirror(root);
  } catch {
    malformed = true;
  }
  if (malformed) return { state: "mismatch" };
  if (!row && !mirror) return { state: "absent" };
  if (!row || !mirror) return { state: "mismatch" };
  if (canonical(row) !== canonical(mirror)) return { state: "mismatch" };
  return { state: "active", profile: row };
}

/** The profile only when the SQL row and the mirror agree exactly. */
export function readActivation(
  control: AuditControl,
  root: string,
): ActivationProfile | undefined {
  const state = readActivationState(control, root);
  return state.state === "active" ? state.profile : undefined;
}

function readLiveEpoch(
  db: DatabaseSync,
): { epoch: number; nonce: string } | undefined {
  const present = !!db
    .prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='managed_control_epoch'",
    )
    .get();
  if (!present) return undefined;
  const row = db
    .prepare("SELECT epoch,nonce FROM managed_control_epoch WHERE singleton=1")
    .get() as { epoch: number; nonce: string } | undefined;
  if (!row) return undefined;
  return { epoch: Number(row.epoch), nonce: String(row.nonce) };
}

/**
 * Configured-policy capability: does the operator/global configuration permit a
 * real provider for this root? It is independent of worker readiness, the
 * provider key and any per-call admission, and it always reads live state. A
 * caller-supplied `profile` is accepted structurally but never trusted: the stored
 * row always wins, so a historical enabled profile can never re-enable a disabled
 * one.
 */
export function evaluateConfiguredPolicy(input: {
  control: AuditControl;
  root: string;
  now: Date;
  optIn: boolean;
  /** Advisory context only; never used to grant authority. Shape compatibility. */
  schemaOk?: boolean;
  /** Advisory context only; the live stored row always wins. */
  profile?: ActivationProfile;
}): { ready: boolean; reason: ActivationReason } {
  const state = readActivationState(input.control, input.root);
  if (state.state === "mismatch") return { ready: false, reason: "profile_invalid" };
  const profile = state.state === "active" ? state.profile : undefined;
  if (!profile) return { ready: false, reason: "off" };
  if (!profile.enabled) return { ready: false, reason: "off" };
  if (!supportedActivationSchema(input.control, input.root))
    return { ready: false, reason: "profile_invalid" };
  let marker;
  try {
    marker = readRootMarker(input.root);
  } catch {
    return { ready: false, reason: "epoch_mismatch" };
  }
  const epoch = readLiveEpoch(input.control.db);
  if (!epoch) return { ready: false, reason: "epoch_uninitialized" };
  if (!rootEpochMatches(marker, { ...epoch, rotated_at: "" }))
    return { ready: false, reason: "epoch_mismatch" };
  if (profile.epoch !== epoch.epoch || profile.root_nonce !== epoch.nonce)
    return { ready: false, reason: "epoch_mismatch" };
  if (activationAuditDigest(input.control.db, profile.audit_id) !== profile.audit_digest)
    return { ready: false, reason: "audit_stale" };
  if (!readEnrollmentBaseline(input.control, input.root, profile.audit_id).valid)
    return { ready: false, reason: "audit_stale" };
  if (!input.optIn) return { ready: false, reason: "policy_unconfigured" };
  return { ready: true, reason: "ready" };
}

/**
 * The exact prepared-config hash the installed profile implies for one call kind.
 * It reuses the provider's own pure `preparedConfigHash` and passes the accepted
 * model array IN ITS PROFILE ORDER (never sorted), so it equals the real
 * `PreparedReasoningProvider` identity byte-for-byte.
 */
export function expectedPreparedConfigHash(
  profile: ActivationProfile,
  kind: "brief" | "goal",
): string {
  return preparedConfigHash({
    model: profile.model,
    price: {
      version: profile.price_version,
      input_micro_usd_per_million: profile.input_micro_usd_per_million,
      output_micro_usd_per_million: profile.output_micro_usd_per_million,
    },
    accepted: [...profile.accepted_response_models],
    max_output_tokens: profile.max_output_tokens,
    endpoint: REASONING_DEFAULT_ENDPOINT,
    prompt_version:
      kind === "brief" ? REASONING_PROMPT_VERSION_BRIEF : REASONING_PROMPT_VERSION_GOAL,
  });
}

export type InstalledActivationPolicy = {
  readonly root: string;
  readonly profile: ActivationProfile;
};

/**
 * Read-only preflight that derives one frozen-policy guard OUTSIDE the write
 * transaction. It requires the live profile to equal the frozen installed profile,
 * the provider identity and expected prepared config hash to match, and the current
 * attempt slot to be exactly permitted. It never writes, never opens a tenant
 * database and never trusts a caller-supplied profile.
 */
export function readActivationGuardContext(input: {
  control: AuditControl;
  installed: InstalledActivationPolicy;
  accountId: string;
  kind: "brief" | "goal";
  jobId: string;
  dispatchKey: string;
  stage: DispatchStage;
  lease: JobLease;
  phase: SendGuardPhase;
  centralCallId: string | null;
  tenantCallId: string | null;
  spec: {
    provider: string;
    model: string;
    price_version: string;
    request_hash: string;
    config_hash: string;
    reserved_micro_usd: number;
  };
}): ReasoningActivationGuard {
  const blocked = (message: string) =>
    new BrainError("BUDGET_BLOCKED", message, 409);
  // A declared stage can never widen the reasoning loader into another profile.
  if (input.stage !== "reasoning")
    throw blocked("The installed reasoning policy only covers the reasoning stage.");
  const frozen = input.installed.profile;
  if (input.lease.job_id !== input.jobId)
    throw blocked("The managed paid lease does not belong to this job.");
  if (
    input.spec.provider !== frozen.provider ||
    input.spec.model !== frozen.model ||
    input.spec.price_version !== frozen.price_version
  )
    throw blocked("Managed paid provider identity does not match the installed profile.");
  const expected = expectedPreparedConfigHash(frozen, input.kind);
  if (input.spec.config_hash !== expected)
    throw blocked("Managed paid configuration does not match the installed profile.");
  if (input.phase !== "before_reserve") {
    if (input.centralCallId === null || input.tenantCallId === null)
      throw blocked("A guarded paid attempt requires exact central and tenant ids.");
  } else if (input.centralCallId !== null || input.tenantCallId !== null) {
    throw blocked("A reservation guard cannot carry call ids.");
  }
  const snapshot = readGuardSnapshot(input.control, input.installed.root);
  if (snapshot.state !== "active") throw blocked("Managed activation is not active.");
  const live = snapshot.profile;
  if (
    live.version !== frozen.version ||
    live.fingerprint !== frozen.fingerprint ||
    live.config_digest !== frozen.config_digest ||
    live.epoch !== frozen.epoch ||
    live.root_nonce !== frozen.root_nonce
  )
    throw blocked("The installed activation profile is no longer current.");
  if (!live.enabled) throw blocked("Managed paid processing is disabled.");
  if (live.epoch !== snapshot.epoch.epoch || live.root_nonce !== snapshot.epoch.nonce)
    throw blocked("Managed activation epoch is not current.");
  if (snapshot.audit_digest !== frozen.audit_digest)
    throw blocked("The chosen activation audit is not current.");
  const permit =
    input.phase === "before_reserve"
      ? null
      : {
          account_id: input.accountId,
          job_id: input.jobId,
          dispatch_key: input.dispatchKey,
          stage: input.stage,
          state: (input.phase === "after_mark" ? "dispatched" : "reserved") as
            | "reserved"
            | "dispatched",
          central_call_id: input.centralCallId!,
          tenant_call_id: input.tenantCallId!,
        };
  const baseline = readSendGuardBaseline(
    input.control,
    input.installed.root,
    frozen.audit_id,
    permit,
  );
  if (!baseline.valid || !baseline.central_inventory_digest)
    throw blocked("Managed activation baseline is not current.");
  return validateReasoningActivationGuard({
    phase: input.phase,
    account_id: input.accountId,
    job_id: input.jobId,
    dispatch_key: input.dispatchKey,
    stage: "reasoning",
    lease_owner: input.lease.owner,
    lease_fence: input.lease.fence,
    lease_expires_at: input.lease.expires_at,
    provider: frozen.provider,
    model: frozen.model,
    price_version: frozen.price_version,
    request_hash: input.spec.request_hash,
    config_hash: input.spec.config_hash,
    reserved_micro_usd: input.spec.reserved_micro_usd,
    profile_version: frozen.version,
    fingerprint: frozen.fingerprint,
    config_digest: frozen.config_digest,
    epoch: snapshot.epoch.epoch,
    root_nonce: snapshot.epoch.nonce,
    schema_version: managedControlSchemaVersion(input.control.db),
    schema_digest: snapshot.schema_digest,
    audit_id: frozen.audit_id,
    audit_digest: snapshot.audit_digest,
    expected_prepared_config_hash: expected,
    central_inventory_digest: baseline.central_inventory_digest,
    central_call_id: input.centralCallId,
    tenant_call_id: input.tenantCallId,
  });
}

export { guardMatchesLive, validateActivationGuard };

/**
 * Pure capability comparison: a configured policy (already derived from the live
 * loader) AND a fresh readiness lease whose exact fields equal the live profile.
 * No filesystem/db access — the wrapper supplies validated inputs only.
 */
export function serverCapability(input: {
  configured: { ready: boolean; reason: ActivationReason };
  readiness: { state: "ready" | "stale" | "absent"; readiness?: WorkerReadiness };
  profile?: ActivationProfile;
}): { ready: boolean; reason: ActivationReason } {
  if (!input.configured.ready)
    return { ready: false, reason: input.configured.reason };
  const r = input.readiness;
  if (r.state === "absent") return { ready: false, reason: "worker_absent" };
  if (r.state === "stale" || !r.readiness)
    return { ready: false, reason: "worker_stale" };
  const profile = input.profile;
  if (!profile) return { ready: false, reason: "worker_config_mismatch" };
  const rd = r.readiness;
  const matches =
    rd.epoch === profile.epoch &&
    rd.root_nonce === profile.root_nonce &&
    rd.activation_fingerprint === profile.fingerprint &&
    rd.config_digest === profile.config_digest &&
    rd.provider === profile.provider &&
    rd.model === profile.model &&
    rd.price_version === profile.price_version &&
    rd.endpoint_class === profile.endpoint_class;
  return matches
    ? { ready: true, reason: "ready" }
    : { ready: false, reason: "worker_config_mismatch" };
}

/**
 * Live recheck of one derived guard against the current profile, mirror, epoch,
 * schema, whole-audit digest and central inventory digest. Used for the final
 * pre-I/O permission check and the post-settlement publication check. Read-only.
 */
export function assertSendGuardContext(
  guard: ActivationGuard,
  root: string,
  control: AuditControl,
): void {
  const deny = () =>
    new BrainError(
      "BUDGET_BLOCKED",
      "Managed paid processing is not enabled for this call.",
      409,
    );
  // The reasoning recheck must never accept a decision-stage binding.
  if (guard.stage !== "reasoning") throw deny();
  const snapshot = readGuardSnapshot(control, root);
  if (snapshot.state !== "active")
    throw new BrainError(
      "BUDGET_BLOCKED",
      "Managed paid processing is not enabled for this call.",
      409,
    );
  guardMatchesLive(guard, {
    fingerprint: snapshot.profile.fingerprint,
    version: snapshot.profile.version,
    config_digest: snapshot.profile.config_digest,
    epoch: snapshot.epoch.epoch,
    root_nonce: snapshot.epoch.nonce,
    schema_version: managedControlSchemaVersion(control.db),
    schema_digest: snapshot.schema_digest,
    audit_digest: snapshot.audit_digest,
    central_inventory_digest: snapshot.central_inventory_digest,
  });
}

/* ------------------------------------------------------------------ *
 * Decision-stage (separate) runtime surface. Reasoning callers above
 * are unchanged; these functions never widen reasoning authority.
 * ------------------------------------------------------------------ */

/**
 * The exact prepared-config hash a decision profile implies. It is re-exported from
 * the pure provider module (`prepared-decision.ts`) so runtime and storage share ONE
 * derivation over the accepted-model array IN PROFILE ORDER (never sorted). It is
 * deliberately NOT the profile's `config_digest`.
 */
export { expectedDecisionConfigHash };

/** Read-only decision profile loader. Only an exact SQL+mirror match is returned. */
export function readDecisionActivation(
  control: AuditControl,
  root: string,
): DecisionActivationProfile | undefined {
  const state = readDecisionActivationState(control, root);
  return state.state === "active" ? state.profile : undefined;
}

/**
 * Configured-policy capability for the DECISION stage only. It reads live state and
 * never trusts a caller profile. Absent/disabled => `off`.
 */
export function evaluateConfiguredDecisionPolicy(input: {
  control: AuditControl;
  root: string;
  now: Date;
  optIn: boolean;
  profile?: DecisionActivationProfile;
}): { ready: boolean; reason: ActivationReason } {
  const state = readDecisionActivationState(input.control, input.root);
  if (state.state === "mismatch") return { ready: false, reason: "profile_invalid" };
  const profile = state.state === "active" ? state.profile : undefined;
  if (!profile || !profile.enabled) return { ready: false, reason: "off" };
  if (!input.optIn) return { ready: false, reason: "policy_unconfigured" };
  if (!readEnrollmentBaseline(input.control, input.root, profile.audit_id).valid)
    return { ready: false, reason: "audit_stale" };
  return { ready: true, reason: "ready" };
}

/**
 * Pure decision capability comparison: a configured decision policy AND a fresh
 * decision readiness lease whose exact fields equal the live decision profile. It never
 * reads the reasoning `worker-ready.json`.
 */
export function decisionServerCapability(input: {
  configured: { ready: boolean; reason: ActivationReason };
  readiness: { state: "ready" | "stale" | "absent"; readiness?: DecisionWorkerReadiness };
  profile?: DecisionActivationProfile;
}): { ready: boolean; reason: ActivationReason } {
  if (!input.configured.ready)
    return { ready: false, reason: input.configured.reason };
  const r = input.readiness;
  if (r.state === "absent") return { ready: false, reason: "worker_absent" };
  if (r.state === "stale" || !r.readiness) return { ready: false, reason: "worker_stale" };
  const profile = input.profile;
  if (!profile) return { ready: false, reason: "worker_config_mismatch" };
  const rd = r.readiness;
  const matches =
    rd.stage_scope === "decision" &&
    rd.epoch === profile.epoch &&
    rd.root_nonce === profile.root_nonce &&
    rd.activation_fingerprint === profile.fingerprint &&
    rd.config_digest === profile.config_digest &&
    rd.provider_family === profile.provider &&
    rd.model === profile.model &&
    rd.price_version === profile.price_version &&
    rd.endpoint_digest === profile.endpoint_digest;
  return matches
    ? { ready: true, reason: "ready" }
    : { ready: false, reason: "worker_config_mismatch" };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value))
      deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

/**
 * A frozen, closed installed DECISION policy. It is derived only from a current
 * decision profile, its OWN worker id and the operator's deployment opt-in. It
 * is created by `installDecisionPolicy`, which takes a deep defensive copy of the
 * profile (including the accepted-model array) so a later caller mutation can
 * never change the frozen binding. It is a policy binding, never authorization;
 * `readDecisionActivationGuardContext` re-reads live state and may deny it.
 */
export interface InstalledDecisionPolicy {
  readonly stage: "decision";
  readonly purpose: typeof DECISION_GUARD_PURPOSE;
  readonly root: string;
  readonly profile: DecisionActivationProfile;
  readonly worker_id: string;
  /** Operator deployment opt-in from server configuration, never a request claim. */
  readonly optIn: boolean;
}

/** Freeze one installed decision policy at install time over a validated copy. */
export function installDecisionPolicy(input: {
  root: string;
  profile: DecisionActivationProfile;
  worker_id: string;
  optIn: boolean;
}): InstalledDecisionPolicy {
  const profile = validateDecisionActivationProfile(input.profile);
  return Object.freeze({
    stage: "decision" as const,
    purpose: DECISION_GUARD_PURPOSE,
    root: input.root,
    profile: deepFreeze({
      ...profile,
      accepted_response_models: [...profile.accepted_response_models],
    }),
    worker_id: input.worker_id,
    optIn: input.optIn,
  });
}

/**
 * Read-only preflight that derives one frozen DECISION guard OUTSIDE the write
 * transaction. Unlike the reasoning loader it ALSO requires the operator opt-in,
 * a fresh decision readiness lease for THIS installed worker whose fields equal
 * the live profile, and a bounded current-slot baseline for the exact attempt. It
 * never writes, never opens a tenant database inside a transaction and never
 * trusts a caller-supplied profile. A declared stage cannot widen the binding.
 */
export function readDecisionActivationGuardContext(input: {
  control: AuditControl;
  installed: InstalledDecisionPolicy;
  accountId: string;
  jobId: string;
  dispatchKey: string;
  stage: DispatchStage;
  phase: SendGuardPhase;
  lease: JobLease;
  centralCallId: string | null;
  tenantCallId: string | null;
  now: Date;
  spec: {
    provider: string;
    model: string;
    price_version: string;
    request_hash: string;
    config_hash: string;
    reserved_micro_usd: number;
  };
}): DecisionActivationGuard {
  const blocked = (message: string) => new BrainError("BUDGET_BLOCKED", message, 409);
  const installed = input.installed;
  if (installed.stage !== "decision" || installed.purpose !== DECISION_GUARD_PURPOSE)
    throw blocked("The installed decision policy is not usable for this call.");
  if (!installed.optIn)
    throw blocked("The decision stage is not enabled for this deployment.");
  if (input.stage !== "decision")
    throw blocked("The installed decision policy only covers the decision stage.");
  const frozen = validateDecisionActivationProfile(installed.profile);
  if (input.lease.job_id !== input.jobId)
    throw blocked("The managed paid lease does not belong to this job.");
  if (
    input.spec.provider !== frozen.provider ||
    input.spec.model !== frozen.model ||
    input.spec.price_version !== frozen.price_version
  )
    throw blocked("Managed paid provider identity does not match the installed decision profile.");
  const expected = expectedDecisionConfigHash(frozen);
  // The prepared config_hash is the adapter identity; it must NEVER be the domain
  // config_digest, even when the two share a stage.
  if (input.spec.config_hash !== expected || input.spec.config_hash === frozen.config_digest)
    throw blocked("Managed paid configuration does not match the installed decision profile.");
  if (input.phase !== "before_reserve") {
    if (input.centralCallId === null || input.tenantCallId === null)
      throw blocked("A guarded paid attempt requires exact central and tenant ids.");
  } else if (input.centralCallId !== null || input.tenantCallId !== null) {
    throw blocked("A reservation guard cannot carry call ids.");
  }
  if (!(Date.parse(input.lease.expires_at) > input.now.getTime()))
    throw blocked("The managed paid lease has expired.");

  const snapshot = readDecisionGuardSnapshot(input.control, installed.root);
  if (snapshot.state !== "active") throw blocked("Decision activation is not active.");
  const live = snapshot.profile;
  if (
    live.version !== frozen.version ||
    live.fingerprint !== frozen.fingerprint ||
    live.config_digest !== frozen.config_digest ||
    live.epoch !== frozen.epoch ||
    live.root_nonce !== frozen.root_nonce ||
    live.provider !== frozen.provider ||
    live.model !== frozen.model ||
    live.price_version !== frozen.price_version
  )
    throw blocked("The installed decision profile is no longer current.");
  if (!live.enabled) throw blocked("Decision paid processing is disabled.");
  if (live.epoch !== snapshot.epoch.epoch || live.root_nonce !== snapshot.epoch.nonce)
    throw blocked("Decision activation epoch is not current.");
  if (snapshot.audit_digest !== frozen.audit_digest)
    throw blocked("The chosen decision activation audit is not current.");

  const ready = readDecisionReadiness(installed.root, input.now);
  if (ready.state !== "ready" || !ready.readiness)
    throw blocked("No current decision worker is installed for this root.");
  const rd = ready.readiness;
  if (rd.worker_id !== installed.worker_id)
    throw blocked("The decision worker lease belongs to another installation.");
  if (
    rd.stage_scope !== "decision" ||
    rd.epoch !== live.epoch ||
    rd.root_nonce !== live.root_nonce ||
    rd.activation_fingerprint !== live.fingerprint ||
    rd.config_digest !== live.config_digest ||
    rd.provider_family !== live.provider ||
    rd.model !== live.model ||
    rd.price_version !== live.price_version ||
    rd.endpoint_digest !== live.endpoint_digest
  )
    throw blocked("The decision worker lease does not match the installed profile.");

  const permit =
    input.phase === "before_reserve"
      ? null
      : {
          account_id: input.accountId,
          job_id: input.jobId,
          dispatch_key: input.dispatchKey,
          stage: "decision" as const,
          state: (input.phase === "after_mark" ? "dispatched" : "reserved") as
            | "reserved"
            | "dispatched",
          central_call_id: input.centralCallId!,
          tenant_call_id: input.tenantCallId!,
        };
  const baseline = readSendGuardBaseline(
    input.control,
    installed.root,
    frozen.audit_id,
    permit,
  );
  if (!baseline.valid || !baseline.central_inventory_digest)
    throw blocked("Decision activation baseline is not current.");

  return validateDecisionActivationGuard({
    phase: input.phase,
    account_id: input.accountId,
    job_id: input.jobId,
    dispatch_key: input.dispatchKey,
    stage: "decision",
    purpose: DECISION_GUARD_PURPOSE,
    job_kind: DECISION_GUARD_JOB_KIND,
    lease_owner: input.lease.owner,
    lease_fence: input.lease.fence,
    lease_expires_at: input.lease.expires_at,
    provider: frozen.provider,
    model: frozen.model,
    price_version: frozen.price_version,
    request_hash: input.spec.request_hash,
    config_hash: input.spec.config_hash,
    reserved_micro_usd: input.spec.reserved_micro_usd,
    profile_version: frozen.version,
    fingerprint: frozen.fingerprint,
    config_digest: frozen.config_digest,
    epoch: snapshot.epoch.epoch,
    root_nonce: snapshot.epoch.nonce,
    schema_version: managedControlSchemaVersion(input.control.db),
    schema_digest: snapshot.schema_digest,
    audit_id: frozen.audit_id,
    audit_digest: snapshot.audit_digest,
    expected_prepared_config_hash: expected,
    central_inventory_digest: baseline.central_inventory_digest,
    central_call_id: input.centralCallId,
    tenant_call_id: input.tenantCallId,
  });
}

/**
 * NARROW live-snapshot recheck of one derived DECISION guard against the current
 * decision profile, mirror, epoch, schema, whole-audit digest and central inventory
 * digest. It reads no tenant database and opens no transaction.
 *
 * It is NOT a standalone pre-I/O authorization. It does NOT prove a fresh OWN
 * decision readiness lease, a live job lease/fence, the exact attempt phase/call
 * ids, the private attempt map, tenant job state, an active goal, tenant scoping or
 * raw consent. The 2B coordinator must additionally re-derive the guard with
 * `readDecisionActivationGuardContext(..., phase:"after_mark")` (readiness, lease
 * expiry, exact central+tenant ids) AND verify the real tenant job/lease/goal and
 * raw consent before treating a call as permitted. Never call this as the only check
 * before I/O.
 */
export function assertDecisionSendGuardContext(
  guard: ActivationGuard,
  root: string,
  control: AuditControl,
): void {
  const deny = () =>
    new BrainError(
      "BUDGET_BLOCKED",
      "Managed paid processing is not enabled for this call.",
      409,
    );
  if (guard.stage !== "decision") throw deny();
  const snapshot = readDecisionGuardSnapshot(control, root);
  if (snapshot.state !== "active") throw deny();
  guardMatchesLive(guard, {
    fingerprint: snapshot.profile.fingerprint,
    version: snapshot.profile.version,
    config_digest: snapshot.profile.config_digest,
    epoch: snapshot.epoch.epoch,
    root_nonce: snapshot.epoch.nonce,
    schema_version: managedControlSchemaVersion(control.db),
    schema_digest: snapshot.schema_digest,
    audit_digest: snapshot.audit_digest,
    central_inventory_digest: snapshot.central_inventory_digest,
  });
}
