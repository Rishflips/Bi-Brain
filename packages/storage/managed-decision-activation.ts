import type { DatabaseSync } from "node:sqlite";
import { randomBytes, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ControlStore } from "./control.ts";
import { ManagedSpendingStore } from "./managed-spending.ts";
import { BrainError, canonical } from "../domain/logic.ts";
import { validateAttestOptions } from "../domain/managed-reconciliation.ts";
import {
  DECISION_ACTIVATION_SCHEMA_VERSION,
  canonicalDecisionEndpoint,
  decisionActivationFingerprint,
  decisionProfileConfigDigest,
  validateDecisionActivationProfile,
  validateDecisionOperatorInput,
  type DecisionActivationProfile,
  type DecisionOperatorInput,
} from "../domain/managed-decision-activation.ts";
import {
  assertTrustedManagedRoot,
  readRootMarker,
  rootEpochMatches,
  type RootEpochMarker,
} from "../runtime/managed-operator.ts";
import { activationAuditDigest, supportedActivationSchema } from "./managed-activation-state.ts";
import { managedControlInventoryDigest, managedControlSchemaVersion, validateManagedAudit } from "../runtime/managed-audit.ts";
import type { ControlEpoch } from "../domain/managed-reconciliation.ts";

/**
 * Persistence for the separate, default-off decision activation profile. It mirrors
 * the reasoning store's discipline (read-only loader, CAS, SQL-then-mirror, exact
 * readback, fail-closed mismatch) but never touches the reasoning row/mirror.
 */

export const DECISION_ACTIVATION_MIRROR_FILE = "decision-activation.json";
const MAX_MIRROR_BYTES = 256 * 1024;
const invalid = (message: string) => new BrainError("INVALID_INPUT", message, 400);

function tableExists(db: DatabaseSync, name: string): boolean {
  return !!db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?").get(name);
}
function lstatOptional(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

export function decisionActivationMirrorPath(root: string): string {
  return resolve(root, DECISION_ACTIVATION_MIRROR_FILE);
}

export function readDecisionActivationMirror(root: string): DecisionActivationProfile | undefined {
  const path = decisionActivationMirrorPath(root);
  const stat = lstatOptional(path);
  if (!stat) return undefined;
  if (stat.isSymbolicLink() || !stat.isFile())
    throw new BrainError("UNAUTHORIZED", "The decision activation mirror is not a real file.", 401);
  if (stat.size > MAX_MIRROR_BYTES)
    throw invalid("The decision activation mirror is too large.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw invalid("The decision activation mirror is unreadable.");
  }
  return validateDecisionActivationProfile(parsed);
}

export function writeDecisionActivationMirror(root: string, profile: DecisionActivationProfile): void {
  const validated = validateDecisionActivationProfile(profile);
  const path = decisionActivationMirrorPath(root);
  if (lstatOptional(path)?.isSymbolicLink())
    throw new BrainError("UNAUTHORIZED", "The decision activation mirror is a link.", 401);
  const tmp = resolve(root, `${DECISION_ACTIVATION_MIRROR_FILE}.${randomBytes(6).toString("hex")}.tmp`);
  rmSync(tmp, { force: true });
  writeFileSync(tmp, JSON.stringify(validated), { mode: 0o600 });
  try {
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

export function readDecisionActivationRow(db: DatabaseSync): DecisionActivationProfile | undefined {
  if (!tableExists(db, "managed_decision_activation")) return undefined;
  const row = db.prepare("SELECT * FROM managed_decision_activation WHERE singleton=1").get() as any;
  if (!row) return undefined;
  let accepted: unknown;
  try {
    accepted = JSON.parse(String(row.accepted_response_models));
  } catch {
    throw invalid("The stored decision activation profile is not readable.");
  }
  return validateDecisionActivationProfile({
    schema: Number(row.schema),
    version: Number(row.version),
    enabled: Number(row.enabled) === 1,
    provider: row.provider,
    model: row.model,
    accepted_response_models: accepted,
    endpoint: row.endpoint,
    endpoint_digest: row.endpoint_digest,
    price_version: row.price_version,
    input_micro_usd_per_million: Number(row.input_micro_usd_per_million),
    output_micro_usd_per_million: Number(row.output_micro_usd_per_million),
    timeout_ms: Number(row.timeout_ms),
    max_request_bytes: Number(row.max_request_bytes),
    max_response_bytes: Number(row.max_response_bytes),
    request_overhead_bytes: Number(row.request_overhead_bytes),
    config_digest: row.config_digest,
    audit_digest: row.audit_digest,
    audit_id: row.audit_id,
    epoch: Number(row.epoch),
    root_nonce: row.root_nonce,
    fingerprint: row.fingerprint,
    updated_at: row.updated_at,
  });
}

function upsertDecisionActivationRow(db: DatabaseSync, p: DecisionActivationProfile): void {
  db.prepare(
    `INSERT INTO managed_decision_activation(
       singleton,schema,version,enabled,provider,model,accepted_response_models,endpoint,endpoint_digest,
       price_version,input_micro_usd_per_million,output_micro_usd_per_million,timeout_ms,max_request_bytes,
       max_response_bytes,request_overhead_bytes,config_digest,audit_digest,audit_id,epoch,root_nonce,
       fingerprint,updated_at)
     VALUES(1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(singleton) DO UPDATE SET
       schema=excluded.schema,version=excluded.version,enabled=excluded.enabled,provider=excluded.provider,
       model=excluded.model,accepted_response_models=excluded.accepted_response_models,endpoint=excluded.endpoint,
       endpoint_digest=excluded.endpoint_digest,price_version=excluded.price_version,
       input_micro_usd_per_million=excluded.input_micro_usd_per_million,
       output_micro_usd_per_million=excluded.output_micro_usd_per_million,timeout_ms=excluded.timeout_ms,
       max_request_bytes=excluded.max_request_bytes,max_response_bytes=excluded.max_response_bytes,
       request_overhead_bytes=excluded.request_overhead_bytes,config_digest=excluded.config_digest,
       audit_digest=excluded.audit_digest,audit_id=excluded.audit_id,epoch=excluded.epoch,
       root_nonce=excluded.root_nonce,fingerprint=excluded.fingerprint,updated_at=excluded.updated_at`,
  ).run(
    p.schema, p.version, p.enabled ? 1 : 0, p.provider, p.model, JSON.stringify(p.accepted_response_models),
    p.endpoint, p.endpoint_digest, p.price_version, p.input_micro_usd_per_million, p.output_micro_usd_per_million,
    p.timeout_ms, p.max_request_bytes, p.max_response_bytes, p.request_overhead_bytes, p.config_digest,
    p.audit_digest, p.audit_id, p.epoch, p.root_nonce, p.fingerprint, p.updated_at,
  );
  // Readback guard: a trigger that ignores the write must never let the API report a
  // profile that was not actually persisted.
  const stored = readDecisionActivationRow(db);
  if (!stored || canonical(stored) !== canonical(p))
    throw new BrainError("AUDIT_STALE", "The decision activation profile was not persisted.", 409);
}

export function appendActivationEvent(db: DatabaseSync, stage: "reasoning" | "decision", action: "enabled" | "disabled" | "restored_disabled", version: number, fingerprint: string, epoch: number, at: string): void {
  const result = db
    .prepare(
      "INSERT INTO managed_decision_activation_events(event_id,stage,action,version,fingerprint,epoch,at) VALUES(?,?,?,?,?,?,?)",
    )
    .run(randomUUID(), stage, action, version, fingerprint, epoch, at);
  if (Number(result.changes) !== 1)
    throw new BrainError("AUDIT_STALE", "The activation event was not recorded.", 409);
}

/** Reuses the whole-audit digest over the same immutable `managed_audits` tables. */
export function decisionActivationAuditDigest(db: DatabaseSync, auditId: string): string | undefined {
  return activationAuditDigest(db, auditId);
}

export type DecisionDisableOutcome =
  | { kind: "absent" }
  | { kind: "unchanged"; profile: DecisionActivationProfile }
  | { kind: "disabled"; profile: DecisionActivationProfile }
  | { kind: "invalid_disabled" };

/**
 * Stops the decision stage inside the CALLER's transaction (no BEGIN/COMMIT) so the
 * global paid stop stays atomic across BOTH stages. A row that fails ONLY profile
 * validation is still stopped truthfully by flipping `enabled` to 0 on the EXISTING raw
 * row (its bytes are preserved, no valid fingerprint is synthesized) and a durable
 * repair hold is recorded. Any generic SQLite failure propagates and rolls the stop back.
 */
export function disableDecisionActivationInTx(
  db: DatabaseSync,
  clock: () => Date,
): DecisionDisableOutcome {
  if (!tableExists(db, "managed_decision_activation")) return { kind: "absent" };
  const raw = db.prepare("SELECT * FROM managed_decision_activation WHERE singleton=1").get() as
    | Record<string, unknown>
    | undefined;
  if (!raw) return { kind: "absent" };
  let current: DecisionActivationProfile | undefined;
  try {
    current = readDecisionActivationRow(db);
  } catch (error) {
    // Only a profile-validation failure on an EXISTING raw row is tolerated; a genuine
    // SQLite error must roll the whole stop back.
    if (!(error instanceof BrainError)) throw error;
    if (Number(raw.enabled) === 1) {
      const updated = db
        .prepare("UPDATE managed_decision_activation SET enabled=0 WHERE singleton=1 AND enabled=1")
        .run();
      if (Number(updated.changes) !== 1)
        throw new BrainError("AUDIT_STALE", "The decision activation profile could not be stopped.", 409);
      const readback = db
        .prepare("SELECT enabled FROM managed_decision_activation WHERE singleton=1")
        .get() as { enabled: number } | undefined;
      if (!readback || Number(readback.enabled) !== 0)
        throw new BrainError("AUDIT_STALE", "The decision activation profile did not stop.", 409);
      // Durable, deterministic repair hold in the SAME transaction: no false profile
      // event and no synthesized fingerprint. It clears only when an operator repairs.
      db.prepare("INSERT OR IGNORE INTO managed_money_blocks(key,reason,at) VALUES(?,?,?)").run(
        "decision_activation_invalid",
        "The stored decision activation profile is invalid and was stopped; operator repair required.",
        clock().toISOString(),
      );
    }
    return { kind: "invalid_disabled" };
  }
  if (!current) return { kind: "absent" };
  if (!current.enabled) return { kind: "unchanged", profile: current };
  const nextVersion = current.version + 1;
  if (!Number.isSafeInteger(nextVersion))
    throw new BrainError("DISPATCH_CONFLICT", "The decision activation version cannot advance safely.", 409);
  const next: DecisionActivationProfile = {
    ...current,
    enabled: false,
    version: nextVersion,
    updated_at: clock().toISOString(),
  };
  next.config_digest = decisionProfileConfigDigest(next);
  next.fingerprint = decisionActivationFingerprint(next);
  const validated = validateDecisionActivationProfile(next);
  upsertDecisionActivationRow(db, validated);
  appendActivationEvent(db, "decision", "disabled", validated.version, validated.fingerprint, validated.epoch, validated.updated_at);
  return { kind: "disabled", profile: validated };
}

export type DecisionReadState =
  | { state: "absent" }
  | { state: "mismatch" }
  | { state: "active"; profile: DecisionActivationProfile };

function sameProfile(a: DecisionActivationProfile | undefined, b: DecisionActivationProfile | undefined): boolean {
  if (!a || !b) return a === b;
  return canonical(a) === canonical(b);
}

export class ManagedDecisionActivationStore {
  private inOwnedTx = false;
  constructor(readonly control: ControlStore, readonly root: string, readonly clock: () => Date = control.clock) {
    assertTrustedManagedRoot(root, control.path);
  }

  read(): DecisionActivationProfile | undefined {
    return readDecisionActivationRow(this.control.db);
  }

  readState(): DecisionReadState {
    try {
      assertTrustedManagedRoot(this.root, this.control.path);
    } catch {
      return { state: "mismatch" };
    }
    let row: DecisionActivationProfile | undefined;
    let mirror: DecisionActivationProfile | undefined;
    let malformed = false;
    try {
      row = readDecisionActivationRow(this.control.db);
    } catch {
      malformed = true;
    }
    try {
      mirror = readDecisionActivationMirror(this.root);
    } catch {
      malformed = true;
    }
    if (malformed) return { state: "mismatch" };
    if (!row && !mirror) return { state: "absent" };
    if (!row || !mirror || !sameProfile(row, mirror)) return { state: "mismatch" };
    return { state: "active", profile: row };
  }

  private readEpoch(): ControlEpoch | undefined {
    if (!tableExists(this.control.db, "managed_control_epoch")) return undefined;
    const row = this.control.db.prepare("SELECT epoch,nonce,rotated_at FROM managed_control_epoch WHERE singleton=1").get() as any;
    return row ? { epoch: Number(row.epoch), nonce: String(row.nonce), rotated_at: String(row.rotated_at) } : undefined;
  }

  private requireMarker(): RootEpochMarker {
    let marker: RootEpochMarker | undefined;
    try {
      marker = readRootMarker(this.root);
    } catch {
      throw new BrainError("EPOCH_MISMATCH", "The managed root marker is unreadable.", 409);
    }
    if (!marker) throw new BrainError("EPOCH_MISMATCH", "The managed root marker is missing.", 409);
    return marker;
  }

  private transaction<T>(fn: () => T): T {
    if (this.inOwnedTx || this.control.db.isTransaction)
      throw new BrainError("INVALID_INPUT", "A managed transaction is already open.", 409);
    if (typeof fn !== "function" || fn.constructor.name === "AsyncFunction")
      throw invalid("Managed transaction callbacks must be synchronous.");
    this.control.db.exec("BEGIN IMMEDIATE");
    this.inOwnedTx = true;
    try {
      const result = fn();
      this.control.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.control.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.inOwnedTx = false;
    }
  }

  enable(input: unknown, ack: unknown): DecisionActivationProfile {
    const operator: DecisionOperatorInput = validateDecisionOperatorInput(input);
    validateAttestOptions(ack);
    assertTrustedManagedRoot(this.root, this.control.path);
    void new ManagedSpendingStore(this.control, this.clock);
    const liveSchema = managedControlSchemaVersion(this.control.db);
    if (!supportedActivationSchema({ db: this.control.db, path: this.control.path }, this.root))
      throw new BrainError("AUDIT_STALE", "Enroll with a current supported control schema; initialize or reconcile first.", 409);
    const epoch = this.readEpoch();
    if (!epoch) throw new BrainError("EPOCH_MISMATCH", "The managed control generation is not initialized.", 409);
    if (!rootEpochMatches(this.requireMarker(), epoch))
      throw new BrainError("EPOCH_MISMATCH", "The managed root marker does not match its control generation.", 409);
    const audit = this.control.db
      .prepare("SELECT control_schema_version FROM managed_audits WHERE audit_id=?")
      .get(operator.audit_id) as { control_schema_version: number } | undefined;
    if (!audit) throw invalid("The decision activation audit id is unknown.");
    if (Number(audit.control_schema_version) !== liveSchema)
      throw new BrainError("AUDIT_STALE", "Enroll with a current schema audit; run managed:reconcile audit-history first.", 409);
    const validation = validateManagedAudit({ control: { db: this.control.db, path: this.control.path }, root: this.root, auditId: operator.audit_id });
    if (!validation.valid)
      throw new BrainError("AUDIT_STALE", "Enrollment requires one current, fully terminal, exactly mapped audit across all accounts.", 409);
    const auditDigest = decisionActivationAuditDigest(this.control.db, operator.audit_id);
    if (!auditDigest) throw invalid("The decision activation audit id is unknown.");
    const endpoint = canonicalDecisionEndpoint(operator.provider, operator.model, operator.endpoint);
    // Bounded preflight OUTSIDE the TX; the same central state is re-read under the
    // acquired lock before any write (mirroring the reasoning enrollment).
    const preflight = {
      epoch: epoch.epoch,
      nonce: epoch.nonce,
      schema: liveSchema,
      auditDigest,
      inventoryDigest: managedControlInventoryDigest(this.control.db),
    };

    const committed = this.transaction(() => {
      const liveEpoch = this.readEpoch();
      const liveMarker = this.requireMarker();
      if (
        !liveEpoch ||
        !rootEpochMatches(liveMarker, liveEpoch) ||
        liveEpoch.epoch !== preflight.epoch ||
        liveEpoch.nonce !== preflight.nonce
      )
        throw new BrainError("EPOCH_MISMATCH", "The managed control generation changed while enrolling.", 409);
      if (managedControlSchemaVersion(this.control.db) !== preflight.schema)
        throw new BrainError("AUDIT_STALE", "The managed schema changed while enrolling.", 409);
      if (decisionActivationAuditDigest(this.control.db, operator.audit_id) !== preflight.auditDigest)
        throw new BrainError("AUDIT_STALE", "The chosen audit changed while enrolling.", 409);
      if (managedControlInventoryDigest(this.control.db) !== preflight.inventoryDigest)
        throw new BrainError("AUDIT_STALE", "Managed configuration or financial baseline changed while enrolling.", 409);
      const current = readDecisionActivationRow(this.control.db);
      const version = current?.version ?? 0;
      if (version !== operator.expected_version)
        throw new BrainError("DISPATCH_CONFLICT", "The decision activation profile changed concurrently.", 409);
      const nextVersion = version + 1;
      if (!Number.isSafeInteger(nextVersion))
        throw new BrainError("DISPATCH_CONFLICT", "The decision activation version cannot advance safely.", 409);
      const draft = {
        schema: DECISION_ACTIVATION_SCHEMA_VERSION,
        version: nextVersion,
        enabled: true,
        provider: operator.provider,
        model: operator.model,
        accepted_response_models: [...operator.accepted_response_models],
        endpoint: endpoint.endpoint,
        endpoint_digest: endpoint.endpoint_digest,
        price_version: operator.price_version,
        input_micro_usd_per_million: operator.input_micro_usd_per_million,
        output_micro_usd_per_million: 0 as const,
        timeout_ms: operator.timeout_ms,
        max_request_bytes: operator.max_request_bytes,
        max_response_bytes: operator.max_response_bytes,
        request_overhead_bytes: 1024,
        config_digest: "",
        audit_digest: auditDigest,
        audit_id: operator.audit_id,
        epoch: epoch.epoch,
        root_nonce: epoch.nonce,
        fingerprint: "",
        updated_at: this.clock().toISOString(),
      } as DecisionActivationProfile;
      draft.config_digest = decisionProfileConfigDigest(draft);
      draft.fingerprint = decisionActivationFingerprint(draft);
      const validated = validateDecisionActivationProfile(draft);
      upsertDecisionActivationRow(this.control.db, validated);
      appendActivationEvent(this.control.db, "decision", "enabled", validated.version, validated.fingerprint, validated.epoch, validated.updated_at);
      return validated;
    });

    assertTrustedManagedRoot(this.root, this.control.path);
    writeDecisionActivationMirror(this.root, committed);
    const readback = this.readState();
    if (readback.state !== "active" || !sameProfile(readback.profile, committed))
      throw new BrainError("DISPATCH_CONFLICT", "The decision activation marker did not commit; decision processing stays off.", 409);
    return committed;
  }

  disable(expectedVersion: number): { disabled: true; version: number; profile?: DecisionActivationProfile } {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw invalid("Invalid expected version.");
    assertTrustedManagedRoot(this.root, this.control.path);
    // Reversible schema-forward before the stop transaction (same as enroll): the
    // global/decision stop must never be blocked by an un-migrated v3 control, and the
    // event table must exist for a truthful, atomic stop. The migrator still refuses
    // any genuinely unknown future schema.
    void new ManagedSpendingStore(this.control, this.clock);
    const result = this.transaction<{ disabled: true; version: number; profile?: DecisionActivationProfile }>(() => {
      const current = readDecisionActivationRow(this.control.db);
      // Strict CAS even for an absent profile: only expected version 0 is a valid
      // no-op; a positive expectation denies without creating a row or mirror.
      const actual = current?.version ?? 0;
      if (actual !== expectedVersion)
        throw new BrainError("DISPATCH_CONFLICT", "The decision activation profile changed concurrently.", 409);
      if (!current) return { disabled: true, version: 0 };
      if (current.version !== expectedVersion)
        throw new BrainError("DISPATCH_CONFLICT", "The decision activation profile changed concurrently.", 409);
      if (!current.enabled) return { disabled: true, version: current.version, profile: current };
      const nextVersion = current.version + 1;
      if (!Number.isSafeInteger(nextVersion))
        throw new BrainError("DISPATCH_CONFLICT", "The decision activation version cannot advance safely.", 409);
      const next: DecisionActivationProfile = { ...current, enabled: false, version: nextVersion, updated_at: this.clock().toISOString() };
      next.config_digest = decisionProfileConfigDigest(next);
      next.fingerprint = decisionActivationFingerprint(next);
      upsertDecisionActivationRow(this.control.db, validateDecisionActivationProfile(next));
      appendActivationEvent(this.control.db, "decision", "disabled", nextVersion, next.fingerprint, next.epoch, next.updated_at);
      return { disabled: true, version: nextVersion, profile: next };
    });
    if (result.profile) {
      // Same failure contract as the global stop: the SQL row is already off, but an
      // incomplete mirror is reported truthfully (never silently swallowed). The
      // unrecognized directory is never deleted, repaired or followed.
      assertTrustedManagedRoot(this.root, this.control.path);
      writeDecisionActivationMirror(this.root, result.profile);
    }
    return result;
  }

  disableForRestore(epoch: { epoch: number; nonce: string }): DecisionActivationProfile | undefined {
    assertTrustedManagedRoot(this.root, this.control.path);
    const current = this.read();
    if (!current) return undefined;
    const nextVersion = current.version + 1;
    if (!Number.isSafeInteger(nextVersion))
      throw new BrainError("DISPATCH_CONFLICT", "The decision activation version cannot advance safely.", 409);
    const next: DecisionActivationProfile = {
      ...current,
      enabled: false,
      version: nextVersion,
      epoch: epoch.epoch,
      root_nonce: epoch.nonce,
      updated_at: this.clock().toISOString(),
    };
    next.config_digest = decisionProfileConfigDigest(next);
    next.fingerprint = decisionActivationFingerprint(next);
    const validated = validateDecisionActivationProfile(next);
    this.transaction(() => {
      upsertDecisionActivationRow(this.control.db, validated);
      appendActivationEvent(this.control.db, "decision", "restored_disabled", validated.version, validated.fingerprint, validated.epoch, validated.updated_at);
    });
    writeDecisionActivationMirror(this.root, validated);
    return validated;
  }
}
