import type { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { ControlStore } from "./control.ts";
import { managedMoneySchemaVersion, ManagedSpendingStore } from "./managed-spending.ts";
import { BrainError, canonical } from "../domain/logic.ts";
import { validateAttestOptions } from "../domain/managed-reconciliation.ts";
import {
  ACTIVATION_SCHEMA_VERSION,
  activationFingerprint,
  profileConfigDigest,
  validateActivationOperatorInput,
  validateActivationProfile,
  type ActivationOperatorInput,
  type ActivationProfile,
} from "../domain/managed-activation.ts";
import {
  assertTrustedManagedRoot,
  readRootMarker,
  rootEpochMatches,
  type RootEpochMarker,
} from "../runtime/managed-operator.ts";
import {
  managedControlInventoryDigest,
  managedControlSchemaVersion,
  validateManagedAudit,
} from "../runtime/managed-audit.ts";
import type { ControlEpoch } from "../domain/managed-reconciliation.ts";

/**
 * Persistence for the one shared, default-off activation policy.
 *
 * The SQL row is authoritative and commits first; the mirrored
 * `<root>/activation.json` is written second (tmp + rename). This is deliberately
 * NOT one atomic write: an interrupted marker write leaves a mismatch and every
 * reader then fails closed, while capture and extractive work continue. Every
 * mutation takes an explicit `expected_version` CAS so a stale operator can never
 * overwrite a concurrent disable, and the loader is genuinely read-only.
 */

export const ACTIVATION_MIRROR_FILE = "activation.json";
const MAX_MIRROR_BYTES = 256 * 1024;

const sha = (value: unknown): string =>
  createHash("sha256").update(canonical(value)).digest("hex");

const invalid = (message: string) => new BrainError("INVALID_INPUT", message, 400);

function tableExists(db: DatabaseSync, name: string): boolean {
  return !!db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?")
    .get(name);
}

function lstatOptional(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------ mirror

export function activationMirrorPath(root: string): string {
  return resolve(root, ACTIVATION_MIRROR_FILE);
}

/**
 * Reads the mirror strictly. A link, non-file (for example a directory created by
 * a failed write), oversized, unreadable or invalid profile throws; callers that
 * must not crash (the read-only loader) catch this and treat it as a mismatch.
 */
export function readActivationMirror(root: string): ActivationProfile | undefined {
  const path = activationMirrorPath(root);
  const stat = lstatOptional(path);
  if (!stat) return undefined;
  if (stat.isSymbolicLink() || !stat.isFile())
    throw new BrainError(
      "UNAUTHORIZED",
      "The activation mirror is not a real file.",
      401,
    );
  if (stat.size > MAX_MIRROR_BYTES)
    throw new BrainError("INVALID_INPUT", "The activation mirror is too large.", 400);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new BrainError("INVALID_INPUT", "The activation mirror is unreadable.", 400);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BrainError("INVALID_INPUT", "The activation mirror is not valid JSON.", 400);
  }
  return validateActivationProfile(parsed);
}

/** Atomically writes the mirror (tmp + rename, mode 0600). Never follows a link. */
export function writeActivationMirror(
  root: string,
  profile: ActivationProfile,
): void {
  const validated = validateActivationProfile(profile);
  const path = activationMirrorPath(root);
  const stat = lstatOptional(path);
  if (stat?.isSymbolicLink())
    throw new BrainError("UNAUTHORIZED", "The activation mirror is a link.", 401);
  const tmp = resolve(root, `${ACTIVATION_MIRROR_FILE}.${randomBytes(6).toString("hex")}.tmp`);
  rmSync(tmp, { force: true });
  writeFileSync(tmp, JSON.stringify(validated), { mode: 0o600 });
  try {
    renameSync(tmp, path);
  } catch (error) {
    // Never leave our own temporary file behind; never touch an unrecognized
    // marker path (the caller is not authorized to empty it).
    rmSync(tmp, { force: true });
    throw error;
  }
}

// --------------------------------------------------------------------- row

export function readActivationRow(db: DatabaseSync): ActivationProfile | undefined {
  if (!tableExists(db, "managed_activation")) return undefined;
  const row = db
    .prepare("SELECT * FROM managed_activation WHERE singleton=1")
    .get() as any;
  if (!row) return undefined;
  let accepted: unknown;
  try {
    accepted = JSON.parse(String(row.accepted_response_models));
  } catch {
    throw invalid("The stored activation profile is not readable.");
  }
  return validateActivationProfile({
    schema: Number(row.schema),
    version: Number(row.version),
    enabled: Number(row.enabled) === 1,
    provider: row.provider,
    model: row.model,
    price_version: row.price_version,
    input_micro_usd_per_million: Number(row.input_micro_usd_per_million),
    output_micro_usd_per_million: Number(row.output_micro_usd_per_million),
    accepted_response_models: accepted,
    max_output_tokens: Number(row.max_output_tokens),
    endpoint_class: row.endpoint_class,
    config_digest: row.config_digest,
    audit_digest: row.audit_digest,
    audit_id: row.audit_id,
    epoch: Number(row.epoch),
    root_nonce: row.root_nonce,
    fingerprint: row.fingerprint,
    updated_at: row.updated_at,
  });
}

function upsertActivationRow(db: DatabaseSync, profile: ActivationProfile): void {
  db.prepare(
    `INSERT INTO managed_activation(
       singleton,schema,version,enabled,provider,model,price_version,
       input_micro_usd_per_million,output_micro_usd_per_million,accepted_response_models,
       max_output_tokens,endpoint_class,config_digest,audit_digest,audit_id,epoch,root_nonce,
       fingerprint,updated_at)
     VALUES(1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(singleton) DO UPDATE SET
       schema=excluded.schema,version=excluded.version,enabled=excluded.enabled,
       provider=excluded.provider,model=excluded.model,price_version=excluded.price_version,
       input_micro_usd_per_million=excluded.input_micro_usd_per_million,
       output_micro_usd_per_million=excluded.output_micro_usd_per_million,
       accepted_response_models=excluded.accepted_response_models,
       max_output_tokens=excluded.max_output_tokens,endpoint_class=excluded.endpoint_class,
       config_digest=excluded.config_digest,audit_digest=excluded.audit_digest,
       audit_id=excluded.audit_id,epoch=excluded.epoch,root_nonce=excluded.root_nonce,
       fingerprint=excluded.fingerprint,updated_at=excluded.updated_at`,
  ).run(
    profile.schema,
    profile.version,
    profile.enabled ? 1 : 0,
    profile.provider,
    profile.model,
    profile.price_version,
    profile.input_micro_usd_per_million,
    profile.output_micro_usd_per_million,
    JSON.stringify(profile.accepted_response_models),
    profile.max_output_tokens,
    profile.endpoint_class,
    profile.config_digest,
    profile.audit_digest,
    profile.audit_id,
    profile.epoch,
    profile.root_nonce,
    profile.fingerprint,
    profile.updated_at,
  );
}

// ----------------------------------------------------------- read-only audit

/**
 * Digest of the WHOLE chosen stored audit: its immutable row plus every ordered
 * account and baseline row. Binding this — not just the baseline digest — means
 * a service-policy or per-account change that leaves the profile fields identical
 * is still detectable at capability time.
 */
export function activationAuditDigest(
  db: DatabaseSync,
  auditId: string,
): string | undefined {
  if (!tableExists(db, "managed_audits")) return undefined;
  const audit = db
    .prepare("SELECT * FROM managed_audits WHERE audit_id=?")
    .get(auditId) as any;
  if (!audit) return undefined;
  const accounts = (
    db
      .prepare(
        "SELECT account_id,config_digest,baseline_digest,financial_digest FROM managed_audit_accounts WHERE audit_id=? ORDER BY account_id",
      )
      .all(auditId) as any[]
  ).map((row) => ({
    account_id: String(row.account_id),
    config_digest: String(row.config_digest),
    baseline_digest: String(row.baseline_digest),
    financial_digest: String(row.financial_digest),
  }));
  const rows = (
    db
      .prepare(
        "SELECT account_id,call_id,central_digest,tenant_digest FROM managed_audit_rows WHERE audit_id=? ORDER BY account_id,call_id",
      )
      .all(auditId) as any[]
  ).map((row) => ({
    account_id: String(row.account_id),
    call_id: String(row.call_id),
    central_digest: String(row.central_digest),
    tenant_digest: String(row.tenant_digest),
  }));
  return sha({
    audit: {
      audit_id: String(audit.audit_id),
      epoch: Number(audit.epoch),
      control_schema_version: Number(audit.control_schema_version),
      config_digest: String(audit.config_digest),
      schema_digest: String(audit.schema_digest),
      inventory_digest: String(audit.inventory_digest),
      baseline_digest: String(audit.baseline_digest),
      root_nonce: String(audit.root_nonce),
      created_at: String(audit.created_at),
    },
    accounts,
    rows,
  });
}

/**
 * Reproduces the control-database configuration digest the audit writes (service
 * policy + per-account config fingerprints). It is read-only and is used to
 * require that the current configuration still matches the chosen audit before an
 * enrollment is accepted.
 */
export function activationControlConfigDigest(db: DatabaseSync): string {
  const accounts = db
    .prepare("SELECT id,state,issuer,subject FROM managed_accounts ORDER BY id")
    .all() as { id: string; state: string; issuer: string; subject: string }[];
  const globalHashes = accounts
    .map((account) => ({
      account_id: account.id,
      config_hash: accountConfigHash(db, account),
    }))
    .sort((a, b) => a.account_id.localeCompare(b.account_id));
  return sha({ service: servicePolicy(db), accounts: globalHashes });
}

function servicePolicy(
  db: DatabaseSync,
): { daily_micro_usd: number; version: number } | null {
  if (!tableExists(db, "managed_service_policy")) return null;
  const row = db
    .prepare(
      "SELECT daily_micro_usd,version FROM managed_service_policy WHERE service='managed-processing'",
    )
    .get() as { daily_micro_usd: number; version: number } | undefined;
  return row
    ? { daily_micro_usd: Number(row.daily_micro_usd), version: Number(row.version) }
    : null;
}

function accountConfigHash(
  db: DatabaseSync,
  account: { id: string; state: string; issuer: string; subject: string },
): string {
  const policy = db
    .prepare(
      "SELECT per_job_micro_usd,user_daily_micro_usd FROM managed_account_policy WHERE account_id=?",
    )
    .get(account.id) as any;
  const periods = db
    .prepare(
      "SELECT period_id,starts_at,ends_at,allowance_micro_usd,state FROM managed_account_periods WHERE account_id=? ORDER BY starts_at,period_id",
    )
    .all(account.id) as any[];
  return sha({
    account_id: account.id,
    issuer: account.issuer,
    subject: account.subject,
    state: account.state,
    policy: policy
      ? {
          per_job_micro_usd: Number(policy.per_job_micro_usd),
          user_daily_micro_usd: Number(policy.user_daily_micro_usd),
        }
      : null,
    periods: periods.map((period) => ({
      period_id: period.period_id,
      starts_at: period.starts_at,
      ends_at: period.ends_at,
      allowance_micro_usd: Number(period.allowance_micro_usd),
      state: period.state,
    })),
  });
}

// ------------------------------------------------------------------- store

export type ActivationReadState =
  | { state: "absent" }
  | { state: "mismatch" }
  | { state: "active"; profile: ActivationProfile };

export type ActivationDisableResult = {
  disabled: true;
  version: number;
  profile?: ActivationProfile;
};

function sameProfile(
  a: ActivationProfile | undefined,
  b: ActivationProfile | undefined,
): boolean {
  if (!a || !b) return a === b;
  return canonical(a) === canonical(b);
}

export class ManagedActivationStore {
  private inOwnedTx = false;

  constructor(
    readonly control: ControlStore,
    readonly root: string,
    readonly clock: () => Date = control.clock,
  ) {
    // A genuinely fresh, trusted root/control binding. Never creates a database
    // or table; a bad root or a control database outside the root fails here.
    assertTrustedManagedRoot(root, control.path);
  }

  // ------------------------------------------------------------- read-only

  /** Read-only: never opens a transaction, never creates a table. */
  read(): ActivationProfile | undefined {
    return readActivationRow(this.control.db);
  }

  readState(): ActivationReadState {
    // Fresh root/control containment on every read; no DDL and no auto re-mint.
    try {
      assertTrustedManagedRoot(this.root, this.control.path);
    } catch {
      return { state: "mismatch" };
    }
    let row: ActivationProfile | undefined;
    let mirror: ActivationProfile | undefined;
    let malformed = false;
    try {
      row = readActivationRow(this.control.db);
    } catch {
      malformed = true;
    }
    try {
      mirror = readActivationMirror(this.root);
    } catch {
      malformed = true;
    }
    if (malformed) return { state: "mismatch" };
    if (!row && !mirror) return { state: "absent" };
    if (!row || !mirror) return { state: "mismatch" };
    if (!sameProfile(row, mirror)) return { state: "mismatch" };
    return { state: "active", profile: row };
  }

  private readEpoch(): ControlEpoch | undefined {
    if (!tableExists(this.control.db, "managed_control_epoch")) return undefined;
    const row = this.control.db
      .prepare("SELECT epoch,nonce,rotated_at FROM managed_control_epoch WHERE singleton=1")
      .get() as { epoch: number; nonce: string; rotated_at: string } | undefined;
    if (!row) return undefined;
    return {
      epoch: Number(row.epoch),
      nonce: String(row.nonce),
      rotated_at: String(row.rotated_at),
    };
  }

  private readAudit(
    auditId: string,
  ): { config_digest: string; control_schema_version: number } | undefined {
    if (!tableExists(this.control.db, "managed_audits")) return undefined;
    const row = this.control.db
      .prepare("SELECT config_digest,control_schema_version FROM managed_audits WHERE audit_id=?")
      .get(auditId) as any;
    return row
      ? {
          config_digest: String(row.config_digest),
          control_schema_version: Number(row.control_schema_version),
        }
      : undefined;
  }

  private requireLiveEpoch(): ControlEpoch {
    const epoch = this.readEpoch();
    if (!epoch)
      throw new BrainError(
        "EPOCH_MISMATCH",
        "The managed control generation is not initialized.",
        409,
      );
    return epoch;
  }

  private requireMarker(): RootEpochMarker {
    let marker: RootEpochMarker | undefined;
    try {
      marker = readRootMarker(this.root);
    } catch {
      throw new BrainError("EPOCH_MISMATCH", "The managed root marker is unreadable.", 409);
    }
    if (!marker)
      throw new BrainError("EPOCH_MISMATCH", "The managed root marker is missing.", 409);
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
      if (result && typeof (result as { then?: unknown }).then === "function")
        throw invalid("Managed transaction callbacks must be synchronous.");
      this.control.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.control.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.inOwnedTx = false;
    }
  }

  // ------------------------------------------------------------- mutations

  /**
   * Derives and persists one enabled profile from closed operator input plus a
   * validated offline acknowledgement. The chosen audit must exist at the current
   * schema and be ONE full, current, fully terminal, exactly mapped enrollment
   * snapshot across all accounts at the live epoch — not merely a valid-looking
   * central baseline. Version and timestamp are final BEFORE the digests are
   * computed, and the trusted state is re-read under the write lock before the
   * INSERT. The SQL row commits, then the mirror; a failed mirror write throws and
   * leaves a fail-closed mismatch.
   */
  enable(input: unknown, ack: unknown): ActivationProfile {
    const operator: ActivationOperatorInput = validateActivationOperatorInput(input);
    validateAttestOptions(ack);
    assertTrustedManagedRoot(this.root, this.control.path);
    // Explicit schema migration before any audit/enrollment.
    void new ManagedSpendingStore(this.control, this.clock);
    const auditControl = { db: this.control.db, path: this.control.path };

    // Bounded preflight OUTSIDE the write transaction.
    const epoch = this.requireLiveEpoch();
    const marker = this.requireMarker();
    if (!rootEpochMatches(marker, epoch))
      throw new BrainError(
        "EPOCH_MISMATCH",
        "The managed root marker does not match its control generation.",
        409,
      );
    const audit = this.readAudit(operator.audit_id);
    if (!audit) throw invalid("The activation audit id is unknown.");
    if (audit.control_schema_version !== managedMoneySchemaVersion)
      throw new BrainError(
        "AUDIT_STALE",
        "Enroll with a current schema audit; run managed:reconcile audit-history first.",
        409,
      );
    // Full bounded enrollment audit: every account must be terminal, mapped and
    // matching at the live epoch/schema/config. This is the only place a full
    // tenant scan runs; it never re-runs per send.
    const validation = validateManagedAudit({
      control: auditControl,
      root: this.root,
      auditId: operator.audit_id,
    });
    if (!validation.valid)
      throw new BrainError(
        "AUDIT_STALE",
        "Enrollment requires one current, fully terminal, exactly mapped audit across all accounts.",
        409,
      );
    const auditDigest = activationAuditDigest(this.control.db, operator.audit_id);
    if (!auditDigest) throw invalid("The activation audit id is unknown.");
    const preflight = {
      epoch: epoch.epoch,
      nonce: epoch.nonce,
      schema: managedMoneySchemaVersion,
      auditDigest,
      inventoryDigest: managedControlInventoryDigest(this.control.db),
    };

    const committed = this.transaction(() => {
      // Fresh re-read of trusted central state under the acquired lock BEFORE the
      // INSERT, compared to the bounded preflight snapshot. No tenant database is
      // opened inside this transaction.
      const liveEpoch = this.requireLiveEpoch();
      const liveMarker = this.requireMarker();
      if (
        !rootEpochMatches(liveMarker, liveEpoch) ||
        liveEpoch.epoch !== preflight.epoch ||
        liveEpoch.nonce !== preflight.nonce
      )
        throw new BrainError(
          "EPOCH_MISMATCH",
          "The managed control generation changed while enrolling.",
          409,
        );
      if (managedControlSchemaVersion(this.control.db) !== preflight.schema)
        throw new BrainError(
          "AUDIT_STALE",
          "The managed schema changed while enrolling.",
          409,
        );
      if (activationAuditDigest(this.control.db, operator.audit_id) !== preflight.auditDigest)
        throw new BrainError(
          "AUDIT_STALE",
          "The chosen audit changed while enrolling.",
          409,
        );
      if (managedControlInventoryDigest(this.control.db) !== preflight.inventoryDigest)
        throw new BrainError(
          "AUDIT_STALE",
          "Managed configuration or financial baseline changed while enrolling.",
          409,
        );
      const current = readActivationRow(this.control.db);
      const version = current?.version ?? 0;
      if (version !== operator.expected_version)
        throw new BrainError(
          "DISPATCH_CONFLICT",
          "The activation profile changed concurrently.",
          409,
        );
      const nextVersion = version + 1;
      if (!Number.isSafeInteger(nextVersion))
        throw new BrainError(
          "DISPATCH_CONFLICT",
          "The activation profile version cannot advance safely.",
          409,
        );
      const draft = {
        schema: ACTIVATION_SCHEMA_VERSION,
        version: nextVersion,
        enabled: true,
        provider: operator.provider,
        model: operator.model,
        price_version: operator.price_version,
        input_micro_usd_per_million: operator.input_micro_usd_per_million,
        output_micro_usd_per_million: operator.output_micro_usd_per_million,
        accepted_response_models: [...operator.accepted_response_models],
        max_output_tokens: operator.max_output_tokens,
        endpoint_class: operator.endpoint_class,
        config_digest: "",
        audit_digest: preflight.auditDigest,
        audit_id: operator.audit_id,
        epoch: preflight.epoch,
        root_nonce: preflight.nonce,
        fingerprint: "",
        updated_at: this.clock().toISOString(),
      } as ActivationProfile;
      draft.config_digest = profileConfigDigest(draft);
      draft.fingerprint = activationFingerprint(draft);
      const validated = validateActivationProfile(draft);
      upsertActivationRow(this.control.db, validated);
      return validated;
    });

    // Fresh root/control containment immediately before publishing the mirror.
    assertTrustedManagedRoot(this.root, this.control.path);
    writeActivationMirror(this.root, committed);
    const readback = this.readState();
    if (readback.state !== "active" || !sameProfile(readback.profile, committed))
      throw new BrainError(
        "DISPATCH_CONFLICT",
        "The activation marker did not commit; paid processing stays off.",
        409,
      );
    return committed;
  }

  /**
   * Immediate, no-offline disable. Missing row is a true OFF with no fake profile.
   * Strict CAS even when already disabled; never re-enables and never overwrites a
   * later user/operator change.
   */
  disable(expectedVersion: number): ActivationDisableResult {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0)
      throw invalid("Invalid expected activation version.");
    assertTrustedManagedRoot(this.root, this.control.path);
    const result = this.transaction<ActivationDisableResult>(() => {
      const current = readActivationRow(this.control.db);
      if (!current) return { disabled: true, version: 0 };
      if (current.version !== expectedVersion)
        throw new BrainError(
          "DISPATCH_CONFLICT",
          "The activation profile changed concurrently.",
          409,
        );
      if (!current.enabled)
        return { disabled: true, version: current.version, profile: current };
      const nextVersion = current.version + 1;
      if (!Number.isSafeInteger(nextVersion))
        throw new BrainError(
          "DISPATCH_CONFLICT",
          "The activation profile version cannot advance safely.",
          409,
        );
      const next: ActivationProfile = {
        ...current,
        enabled: false,
        version: nextVersion,
        updated_at: this.clock().toISOString(),
      };
      next.config_digest = profileConfigDigest(next);
      next.fingerprint = activationFingerprint(next);
      upsertActivationRow(this.control.db, validateActivationProfile(next));
      return { disabled: true, version: nextVersion, profile: next };
    });
    // The SQL row is already authoritative-off. Only a profile we own may be
    // rewritten to the disabled state; an unrecognized marker path is NEVER
    // recursively deleted and no link is followed.
    if (result.profile) {
      try {
        assertTrustedManagedRoot(this.root, this.control.path);
        writeActivationMirror(this.root, result.profile);
      } catch {
        /* SQL is off; a stale or unrecognized mirror fails closed. */
      }
    }
    const readback = this.readState();
    if (readback.state === "active" && readback.profile?.enabled)
      throw new BrainError(
        "DISPATCH_CONFLICT",
        "The activation profile did not disable.",
        409,
      );
    return result;
  }

  /**
   * Operator/restore-only disable used after a supported restore rotates the
   * control generation: keeps the provider params and audit digests, sets the new
   * epoch/nonce, disables, and rewrites the mirror BEFORE publish. Never re-enables.
   */
  disableForRestore(epoch: { epoch: number; nonce: string }): ActivationProfile | undefined {
    assertTrustedManagedRoot(this.root, this.control.path);
    const current = this.read();
    // An absent profile leaves any unrecognized marker path untouched: SQL is off,
    // and never recursively emptying an operator filesystem path is fail-closed.
    if (!current) return undefined;
    const nextVersion = current.version + 1;
    if (!Number.isSafeInteger(nextVersion))
      throw new BrainError(
        "DISPATCH_CONFLICT",
        "The activation profile version cannot advance safely.",
        409,
      );
    const next: ActivationProfile = {
      ...current,
      enabled: false,
      version: nextVersion,
      epoch: epoch.epoch,
      root_nonce: epoch.nonce,
      updated_at: this.clock().toISOString(),
    };
    next.config_digest = profileConfigDigest(next);
    next.fingerprint = activationFingerprint(next);
    const validated = validateActivationProfile(next);
    this.transaction(() => upsertActivationRow(this.control.db, validated));
    writeActivationMirror(this.root, validated);
    return validated;
  }
}
