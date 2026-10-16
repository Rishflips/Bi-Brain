import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ControlStore } from "./control.ts";
import { ManagedSpendingStore } from "./managed-spending.ts";
import { BrainError } from "../domain/logic.ts";
import {
  attestationBindingDigest,
  validateAttestation,
  validateAttestOptions,
  type AttestationInput,
  type ControlEpoch,
  type ManagedAttestMethod,
  type ManagedResolution,
  type ManagedResolutionKind,
} from "../domain/managed-reconciliation.ts";
import {
  assertTrustedManagedRoot,
  readRootMarker,
  rootEpochMatches,
  writeRootMarker,
  type ManagedRootBinding,
} from "../runtime/managed-operator.ts";

/**
 * Operator-attested reconciliation over the control database.
 *
 * An attestation is an external-actor claim bound to one exact dispatch
 * identity; it is audit provenance, not cryptographic provider verification and
 * not a programmatic quiescence proof. The store performs no network call, reads
 * no prompt or user text and is only reachable from a trusted local operator
 * with the exact managed root and control database.
 *
 * A resolution proof and its money mutation (or a dispute proof and its global
 * block) commit in ONE owned `BEGIN IMMEDIATE` transaction, so no inconsistent
 * proof can survive. The constructor is read-only: it neither creates tables nor
 * initializes the control epoch.
 */
export class ManagedReconciliationStore {
  private readonly binding: ManagedRootBinding;
  private spendingStore?: ManagedSpendingStore;

  constructor(
    readonly control: ControlStore,
    root: string,
    readonly clock: () => Date = control.clock,
  ) {
    this.binding = assertTrustedManagedRoot(root, control.path);
  }

  private spending(): ManagedSpendingStore {
    if (!this.spendingStore)
      this.spendingStore = new ManagedSpendingStore(this.control, this.clock);
    return this.spendingStore;
  }

  private db(): DatabaseSync {
    return this.control.db;
  }

  private tableExists(name: string): boolean {
    return !!this.db()
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?")
      .get(name);
  }

  // ------------------------------------------------------------------- reads

  readEpoch(): ControlEpoch | undefined {
    if (!this.tableExists("managed_control_epoch")) return undefined;
    const row = this.db()
      .prepare(
        "SELECT epoch,nonce,rotated_at FROM managed_control_epoch WHERE singleton=1",
      )
      .get() as { epoch: number; nonce: string; rotated_at: string } | undefined;
    if (!row) return undefined;
    return {
      epoch: Number(row.epoch),
      nonce: row.nonce,
      rotated_at: row.rotated_at,
    };
  }

  readResolution(resolutionId: string): ManagedResolution | undefined {
    if (
      typeof resolutionId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        resolutionId,
      )
    )
      return undefined;
    if (!this.tableExists("managed_resolutions")) return undefined;
    const row = this.db()
      .prepare("SELECT * FROM managed_resolutions WHERE resolution_id=?")
      .get(resolutionId);
    return row ? toResolution(row) : undefined;
  }

  /**
   * Requires a control epoch that matches the root marker at the exact control
   * database path. A missing/mismatched generation denies; it never auto-heals,
   * so a crash between the row commit and the marker write stays denied.
   */
  assertRootEpoch(): ControlEpoch {
    this.assertFreshRoot();
    const epoch = this.readEpoch();
    if (!epoch)
      throw new BrainError(
        "EPOCH_UNINITIALIZED",
        "This managed root has no control generation; initialize it with the trusted operator command.",
        409,
      );
    const marker = readRootMarker(this.binding.root);
    if (!rootEpochMatches(marker, epoch))
      throw new BrainError(
        "EPOCH_MISMATCH",
        "The managed root marker does not match the control generation.",
        409,
      );
    return epoch;
  }

  // --------------------------------------------------------------- mutation

  /**
   * Explicit, offline epoch initialization. It never rotates an existing
   * generation and never re-mints a missing marker when the control row already
   * exists.
   */
  initEpoch(options: unknown): ControlEpoch {
    validateAttestOptions(options);
    this.assertFreshRoot();
    const spending = this.spending();
    const epoch = spending.transaction(() => {
      const existing = this.readEpoch();
      if (existing) {
        if (rootEpochMatches(readRootMarker(this.binding.root), existing))
          return existing;
        throw new BrainError(
          "EPOCH_MISMATCH",
          "A control generation exists without a matching root marker; refusing to re-mint it.",
          409,
        );
      }
      const marker = readRootMarker(this.binding.root);
      if (marker)
        throw new BrainError(
          "EPOCH_MISMATCH",
          "A root marker exists without a control generation; refusing to adopt it.",
          409,
        );
      const created: ControlEpoch = {
        epoch: 1,
        nonce: randomBytes(32).toString("hex"),
        rotated_at: this.clock().toISOString(),
      };
      this.db()
        .prepare(
          "INSERT INTO managed_control_epoch(singleton,epoch,nonce,rotated_at) VALUES(1,?,?,?)",
        )
        .run(created.epoch, created.nonce, created.rotated_at);
      return created;
    });
    // The marker is written only after the row commits: a crash between the two
    // leaves a mismatch that denies, and is never auto-healed.
    writeRootMarker(this.binding.root, {
      schema: 1,
      epoch: epoch.epoch,
      nonce: epoch.nonce,
    });
    return epoch;
  }

  attestSettled(input: unknown, options: unknown): ManagedResolution {
    return this.attest(validateAttestation(input), options, "settled");
  }

  attestZero(input: unknown, options: unknown): ManagedResolution {
    return this.attest(validateAttestation(input), options, "zero");
  }

  private attest(
    input: AttestationInput,
    options: unknown,
    expectedKind: "settled" | "zero",
  ): ManagedResolution {
    // Missing/false acknowledgement denies before any money or proof write.
    validateAttestOptions(options);
    if (input.kind !== expectedKind)
      throw new BrainError(
        "INVALID_INPUT",
        "The attestation kind does not match the operator command.",
        400,
      );
    const bindingDigest = attestationBindingDigest(input);
    const spending = this.spending();
    return spending.transaction(() => {
      // Generation is checked BEFORE any idempotent return, so an attestation
      // made under an old backup can never be reported under a new generation.
      const epoch = this.assertRootEpoch();
      if (input.epoch !== epoch.epoch)
        throw new BrainError(
          "EPOCH_MISMATCH",
          "The attestation was made under a different control generation.",
          409,
        );
      const existing = this.readResolution(input.resolution_id);
      if (existing) {
        if (existing.binding_digest === bindingDigest) return existing;
        throw new BrainError(
          "RESOLUTION_CONFLICT",
          "This resolution id already exists with a different binding.",
          409,
        );
      }
      const row = this.reservation(input.call_id);
      if (!row)
        throw new BrainError("NOT_FOUND", "Unknown managed dispatch.", 404);
      this.assertIdentity(row, input);
      if (
        input.expected_state !== row.state ||
        input.expected_actual_micro_usd !== actualOf(row)
      )
        throw new BrainError(
          "STATE_CONFLICT",
          "The managed dispatch no longer matches the attested state or amount.",
          409,
        );
      const now = this.clock().toISOString();
      const kind: ManagedResolutionKind =
        input.kind === "zero" ? "zero" : "settled";
      if (row.state === "dispatched") {
        // A possibly-sent row is settled by the exact attested amount in the
        // same transaction as its proof. A reserved row is never attested.
        spending.settleKnownWithinTx(input.call_id, input.cost_micro_usd);
        this.insertResolution(kind, input, bindingDigest, now);
      } else if (row.state === "settled") {
        if (Number(row.actual_micro_usd) === input.cost_micro_usd) {
          this.insertResolution(kind, input, bindingDigest, now);
        } else {
          // A conflicting amount appends a dispute and a global block, keeping
          // the original immutable actual untouched.
          this.insertResolution("dispute", input, bindingDigest, now);
          this.upsertDisputeBlock(now);
        }
      } else {
        throw new BrainError(
          "INVALID_STATE",
          "Only a sent or settled managed call can be attested.",
          409,
        );
      }
      return this.readResolution(input.resolution_id)!;
    });
  }

  // ---------------------------------------------------------------- private

  /**
   * Re-runs strict root/control containment on every generation check and
   * mutation, so a cached store never follows a root or marker replaced by a
   * link/junction after construction. No watcher or framework is added.
   */
  private assertFreshRoot(): void {
    assertTrustedManagedRoot(this.binding.root, this.control.path);
  }

  private reservation(callId: string): any {
    return this.db()
      .prepare("SELECT * FROM managed_reservations WHERE call_id=?")
      .get(callId);
  }

  private assertIdentity(row: any, input: AttestationInput): void {
    if (
      row.account_id !== input.account_id ||
      row.call_id !== input.call_id ||
      row.identity_hash !== input.identity_hash ||
      row.provider !== input.provider ||
      row.model !== input.model ||
      row.price_version !== input.price_version ||
      row.request_hash !== input.request_hash ||
      row.config_hash !== input.config_hash
    )
      throw new BrainError(
        "STATE_CONFLICT",
        "The managed dispatch does not match the attested identity.",
        409,
      );
  }

  private insertResolution(
    kind: ManagedResolutionKind,
    input: AttestationInput,
    bindingDigest: string,
    now: string,
  ): void {
    this.db()
      .prepare(
        `INSERT INTO managed_resolutions(
           resolution_id,kind,account_id,call_id,method,evidence_digest,binding_digest,
           cost_micro_usd,currency,provider_request_id,actor,checked_at,epoch,decided_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        input.resolution_id,
        kind,
        input.account_id,
        input.call_id,
        input.method,
        input.evidence_digest,
        bindingDigest,
        input.cost_micro_usd,
        input.currency,
        input.provider_request_id,
        input.actor,
        input.checked_at,
        input.epoch,
        now,
      );
  }

  private upsertDisputeBlock(now: string): void {
    this.db()
      .prepare(
        "INSERT INTO managed_money_blocks(key,reason,at) VALUES('dispute','amount_conflict',?) ON CONFLICT(key) DO UPDATE SET reason=excluded.reason,at=excluded.at",
      )
      .run(now);
  }
}

function actualOf(row: any): number | null {
  return row.actual_micro_usd === null || row.actual_micro_usd === undefined
    ? null
    : Number(row.actual_micro_usd);
}

function toResolution(row: any): ManagedResolution {
  return {
    resolution_id: row.resolution_id,
    kind: row.kind as ManagedResolutionKind,
    account_id: row.account_id,
    call_id: row.call_id,
    method: row.method as ManagedAttestMethod,
    evidence_digest: row.evidence_digest,
    binding_digest: row.binding_digest,
    cost_micro_usd: Number(row.cost_micro_usd),
    currency: "USD",
    provider_request_id: row.provider_request_id,
    actor: row.actor,
    checked_at: row.checked_at,
    epoch: Number(row.epoch),
    decided_at: row.decided_at,
  };
}
