import type { DatabaseSync } from "node:sqlite";
import { BrainError, canonical } from "../domain/logic.ts";
import {
  guardMatchesLive,
  validateActivationGuard,
  type ActivationGuard,
  type ActivationProfile,
  type ActivationReason,
  type SendGuardPhase,
} from "../domain/managed-activation.ts";
import type { DispatchStage, JobLease } from "../domain/spend.ts";
import {
  REASONING_DEFAULT_ENDPOINT,
  REASONING_PROMPT_VERSION_BRIEF,
  REASONING_PROMPT_VERSION_GOAL,
  preparedConfigHash,
} from "../providers/prepared.ts";
import { managedMoneySchemaVersion } from "../storage/managed-spending.ts";
import {
  activationAuditDigest,
  managedControlSchemaVersion,
  readActivationMirror,
  readActivationRow,
  readGuardSnapshot,
  type ActivationReadState,
} from "../storage/managed-activation-state.ts";
import {
  assertTrustedManagedRoot,
  readRootMarker,
  rootEpochMatches,
} from "./managed-operator.ts";
import { readEnrollmentBaseline, readSendGuardBaseline } from "./managed-audit.ts";
import type { WorkerReadiness } from "./worker-readiness.ts";

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
  if (managedControlSchemaVersion(input.control.db) !== managedMoneySchemaVersion)
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
}): ActivationGuard {
  const blocked = (message: string) =>
    new BrainError("BUDGET_BLOCKED", message, 409);
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
  return validateActivationGuard({
    phase: input.phase,
    account_id: input.accountId,
    job_id: input.jobId,
    dispatch_key: input.dispatchKey,
    stage: input.stage,
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
