import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { BrainError, canonical } from "../domain/logic.ts";
import { canonicalSealFrame, verifySealMac } from "../domain/billing-seal.ts";
import type { ControlStore } from "./control.ts";
import { billingSchemaVariant } from "./billing-schema.ts";
import { managedControlSchemaVersion } from "./managed-activation-state.ts";
import { BILLING_JOURNAL_MAX_ENTRIES } from "./billing-journal.ts";
import { readAccountIncarnation } from "./managed-incarnation.ts";
import {
  buildReservationBinding,
  loadBillingContext,
  loadEnrollmentAnchor,
  parseReservationBinding,
  reservationProofMac,
  verifyBillingAccountGrant,
  verifyReservationProofMac,
  type BillingContext,
  type EnrollmentView,
} from "./billing-verify.ts";

/**
 * Mandatory, discovered billing enforcement for the central money store.
 *
 * Built from the store's own control handle; no optional guard. Enrollment requires
 * the protected `billing-enrollment.json` anchor matching every SQL cache column
 * (raw rows give no funding); manual membership is the anchor roster only. The billing
 * path uses the SAME complete closed point validator as the accepted writer and NEVER
 * runs the writer's full journal `snapshot()` inside the money transaction: a bounded,
 * process-owned verified prefix is established outside the tx and the exact used rows
 * are re-authenticated inside it.
 */

export type EnforcementState = "legacy" | "unenrolled" | "enrolled";
export type AccountClass = "legacy" | "manual" | "billing" | "unadmitted";

const blocked = (message = "Managed paid funding is not authorized for this account.") =>
  new BrainError("BUDGET_BLOCKED", message, 409);

export class BillingEnforcement {
  private contextCache?: BillingContext;
  private verified?: { epoch: number; ordinal: number; mac: string };
  private index?: {
    epoch: number;
    ordinal: number;
    mac: string;
    adverse: Map<string, number>;
  };

  private constructor(
    private readonly control: ControlStore,
    private readonly clock: () => Date,
  ) {}

  static forControl(control: ControlStore, clock: () => Date): BillingEnforcement {
    return new BillingEnforcement(control, clock);
  }

  private root(): string {
    return dirname(resolve(this.control.path));
  }

  private enrollment(db: DatabaseSync): EnrollmentView | undefined {
    if (managedControlSchemaVersion(db) < 5) return undefined;
    if (billingSchemaVariant(db) !== "integrated") return undefined;
    try {
      return loadEnrollmentAnchor({ db, path: this.control.path }, this.root());
    } catch {
      return undefined;
    }
  }

  /**
   * A root that carries a v5 INTEGRATION footprint must never be classified legacy by a
   * missing version row: the integration tables or the protected external enrollment
   * artifact prove it was installed. The frozen standalone 8-table authority prefix is
   * NOT a v5 footprint (accepted old writer unknown-hold tests use v4 + that DDL).
   */
  private hasV5Footprint(db: DatabaseSync): boolean {
    const probe = (name: string) =>
      !!db
        .prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?")
        .get(name);
    if (
      probe("control_billing_install") ||
      probe("control_billing_enrollment") ||
      probe("control_billing_reservation") ||
      probe("managed_account_incarnation") ||
      probe("managed_account_fence")
    )
      return true;
    try {
      return lstatSync(join(this.root(), ".protected", "billing-enrollment.json")).isFile();
    } catch {
      return false;
    }
  }

  state(db: DatabaseSync = this.control.db): EnforcementState {
    const version = managedControlSchemaVersion(db);
    if (version < 5) return this.hasV5Footprint(db) ? "unenrolled" : "legacy";
    if (billingSchemaVariant(db) !== "integrated") return "unenrolled";
    return this.enrollment(db) ? "enrolled" : "unenrolled";
  }

  classify(db: DatabaseSync, accountId: string): AccountClass {
    const state = this.state(db);
    if (state === "legacy") return "legacy";
    if (state === "unenrolled") return "unadmitted";
    const view = this.enrollment(db)!;
    if (view.anchor.accounts.some((account) => account.account_id === accountId)) return "manual";
    if (db.prepare("SELECT 1 AS present FROM control_billing_account WHERE account_id=?").get(accountId))
      return "billing";
    return "unadmitted";
  }

  private context(db: DatabaseSync): BillingContext {
    if (!this.contextCache)
      this.contextCache = loadBillingContext({ db, path: this.control.path }, this.root());
    return this.contextCache;
  }

  private head(db: DatabaseSync): { epoch: number; ordinal: number; mac: string } | undefined {
    const row = db
      .prepare("SELECT epoch,ordinal,mac FROM control_billing_head WHERE singleton=1")
      .get() as { epoch: number; ordinal: number; mac: string } | undefined;
    if (!row) return undefined;
    return { epoch: Number(row.epoch), ordinal: Number(row.ordinal), mac: row.mac };
  }

  /**
   * ONE bounded cold-boot verification (allowed outside any money transaction) that
   * builds the process-owned prefix index: validated frames by ordinal/MAC plus the
   * per-account authenticated adverse counter (signed revocations). It never runs inside
   * a model-send money transaction.
   */
  private coldBoot(db: DatabaseSync, context: BillingContext): void {
    const rows = db
      .prepare(
        "SELECT epoch,ordinal,frame_json,mac FROM control_billing_log WHERE epoch=? ORDER BY ordinal LIMIT ?",
      )
      .all(context.epoch, BILLING_JOURNAL_MAX_ENTRIES + 1) as unknown as {
      epoch: number;
      ordinal: number;
      frame_json: string;
      mac: string;
    }[];
    if (rows.length > BILLING_JOURNAL_MAX_ENTRIES)
      throw blocked("The billing journal exceeds the entries bound; funding is refused.");
    const adverse = new Map<string, number>();
    let previousMac = "";
    let lastOrdinal = -1;
    let lastMac = "";
    for (const row of rows) {
      if (Number(row.ordinal) !== lastOrdinal + 1)
        throw blocked("The billing journal is not contiguous; funding is refused.");
      let frame: unknown;
      try {
        frame = JSON.parse(row.frame_json);
      } catch {
        throw blocked("A billing journal frame is unreadable.");
      }
      if (canonicalSealFrame(frame) !== row.frame_json)
        throw blocked("A billing journal frame is not canonical.");
      const outer = frame as {
        epoch?: number;
        ordinal?: number;
        root_nonce?: string;
        policy_id?: string;
        prev_mac?: string;
        purpose?: string;
        body?: { account_id?: string; adverse_generation?: number };
      };
      if (
        outer.epoch !== context.epoch ||
        Number(outer.ordinal) !== Number(row.ordinal) ||
        outer.root_nonce !== context.root_nonce ||
        outer.policy_id !== context.policy.policy_id ||
        outer.prev_mac !== previousMac ||
        !verifySealMac(frame, context.key, row.mac)
      )
        throw blocked("A billing journal frame failed verification.");
      if (
        outer.purpose === "revocation" &&
        outer.body &&
        typeof outer.body.account_id === "string" &&
        typeof outer.body.adverse_generation === "number"
      )
        adverse.set(outer.body.account_id, outer.body.adverse_generation);
      previousMac = row.mac;
      lastOrdinal = Number(row.ordinal);
      lastMac = row.mac;
    }
    const head = this.head(db);
    if (rows.length === 0) {
      if (head) throw blocked("A billing journal head exists with no records.");
      this.verified = { epoch: context.epoch, ordinal: -1, mac: "" };
      this.index = { epoch: context.epoch, ordinal: -1, mac: "", adverse };
      return;
    }
    if (!head || head.epoch !== context.epoch || head.ordinal !== lastOrdinal || head.mac !== lastMac)
      throw blocked("The billing journal head does not match its records.");
    this.verified = { epoch: context.epoch, ordinal: lastOrdinal, mac: lastMac };
    this.index = { epoch: context.epoch, ordinal: lastOrdinal, mac: lastMac, adverse };
  }

  /**
   * Contiguous FORWARD suffix verification only: rows with `ordinal > from.ordinal AND
   * ordinal <= to.ordinal` for this exact epoch, chained from the known MAC, updating the
   * process-owned index. No COUNT, SUM or genesis/history read.
   */
  private verifySuffix(
    db: DatabaseSync,
    context: BillingContext,
    from: { ordinal: number; mac: string },
    to: { epoch: number; ordinal: number; mac: string },
  ): void {
    if (to.ordinal === from.ordinal) {
      if (to.mac !== from.mac) throw blocked("The billing journal head MAC changed; funding is refused.");
      return;
    }
    if (to.ordinal < from.ordinal)
      throw blocked("The billing journal head moved backward; funding is refused until refreshed.");
    const rows = db
      .prepare(
        "SELECT epoch,ordinal,frame_json,mac FROM control_billing_log WHERE epoch=? AND ordinal>? AND ordinal<=? ORDER BY ordinal LIMIT ?",
      )
      .all(context.epoch, from.ordinal, to.ordinal, BILLING_JOURNAL_MAX_ENTRIES + 1) as unknown as {
      epoch: number;
      ordinal: number;
      frame_json: string;
      mac: string;
    }[];
    if (rows.length > BILLING_JOURNAL_MAX_ENTRIES)
      throw blocked("The billing journal suffix exceeds the entries bound; funding is refused.");
    let prevMac = from.mac;
    let lastOrdinal = from.ordinal;
    let lastMac = from.mac;
    for (const row of rows) {
      if (Number(row.ordinal) !== lastOrdinal + 1)
        throw blocked("The billing journal suffix is not contiguous; funding is refused.");
      let frame: unknown;
      try {
        frame = JSON.parse(row.frame_json);
      } catch {
        throw blocked("A billing journal frame is unreadable.");
      }
      if (canonicalSealFrame(frame) !== row.frame_json)
        throw blocked("A billing journal frame is not canonical.");
      const outer = frame as {
        epoch?: number;
        ordinal?: number;
        root_nonce?: string;
        policy_id?: string;
        prev_mac?: string;
        purpose?: string;
        body?: { account_id?: string; adverse_generation?: number };
      };
      if (
        outer.epoch !== context.epoch ||
        Number(outer.ordinal) !== Number(row.ordinal) ||
        outer.root_nonce !== context.root_nonce ||
        outer.policy_id !== context.policy.policy_id ||
        outer.prev_mac !== prevMac ||
        !verifySealMac(frame, context.key, row.mac)
      )
        throw blocked("A billing journal suffix frame failed verification.");
      if (
        this.index &&
        outer.purpose === "revocation" &&
        outer.body &&
        typeof outer.body.account_id === "string" &&
        typeof outer.body.adverse_generation === "number"
      )
        this.index.adverse.set(outer.body.account_id, outer.body.adverse_generation);
      prevMac = row.mac;
      lastOrdinal = Number(row.ordinal);
      lastMac = row.mac;
    }
    if (lastOrdinal !== to.ordinal || lastMac !== to.mac)
      throw blocked("The billing journal head does not match the verified suffix.");
  }

  /**
   * Runs OUTSIDE the money transaction. A cold boot performs ONE bounded full-chain
   * verification into the process-owned prefix index; every later call verifies only the
   * forward suffix from the known head. A backward, foreign-epoch, gapped or mixed head
   * refuses.
   */
  prepareForSend(db: DatabaseSync = this.control.db): void {
    if (this.state(db) !== "enrolled") return;
    const context = loadBillingContext({ db, path: this.control.path }, this.root());
    if (this.contextCache) {
      // Frozen at first use: a later live change is refused, never silently adopted.
      if (
        this.contextCache.epoch !== context.epoch ||
        this.contextCache.root_nonce !== context.root_nonce ||
        this.contextCache.policy_digest !== context.policy_digest ||
        Buffer.compare(Buffer.from(this.contextCache.key), Buffer.from(context.key)) !== 0
      )
        throw blocked("The billing root policy/key/epoch changed; funding is refused until reviewed.");
    } else {
      this.contextCache = context;
    }
    const view = this.enrollment(db);
    const keyCommitment = createHash("sha256").update(Buffer.from(context.key)).digest("hex");
    if (
      !view ||
      view.anchor.policy_digest !== context.policy_digest ||
      view.anchor.key_commitment !== keyCommitment ||
      view.anchor.epoch !== context.epoch ||
      view.anchor.root_nonce !== context.root_nonce ||
      view.anchor.mode !== context.policy.mode
    )
      throw blocked("The billing enrollment anchor does not match the protected policy/key/epoch.");
    const head = this.head(db);
    if (!head) {
      if (this.verified) throw blocked("The billing journal head disappeared; funding is refused.");
      this.verified = { epoch: context.epoch, ordinal: -1, mac: "" };
      this.index = { epoch: context.epoch, ordinal: -1, mac: "", adverse: this.index?.adverse ?? new Map() };
      return;
    }
    if (head.epoch !== context.epoch)
      throw blocked("The billing journal head is in a foreign epoch; funding is refused.");
    if (!this.verified || !this.index) {
      this.coldBoot(db, context);
      return;
    }
    if (this.index.epoch !== context.epoch)
      throw blocked("The billing journal epoch changed; funding is refused.");
    if (head.ordinal === this.index.ordinal && head.mac === this.index.mac) return;
    this.verifySuffix(db, context, this.index, head);
    this.index = { epoch: head.epoch, ordinal: head.ordinal, mac: head.mac, adverse: this.index.adverse };
    this.verified = { epoch: head.epoch, ordinal: head.ordinal, mac: head.mac };
  }

  /**
   * The account's adverse counter must equal the process-owned verified index (built
   * from signed revocations at cold boot and the forward suffix), never only the mutable
   * SQL column. A deleted revocation log/denial row with a reset counter is therefore
   * still latched.
   */
  private assertIndexedCounter(
    db: DatabaseSync,
    context: BillingContext,
    accountId: string,
    head: { epoch: number; ordinal: number; mac: string },
  ): void {
    if (
      !this.index ||
      this.index.epoch !== context.epoch ||
      this.index.ordinal !== head.ordinal ||
      this.index.mac !== head.mac
    )
      throw blocked("The billing prefix index is not current; funding is refused.");
    const row = db
      .prepare("SELECT adverse_generation FROM control_billing_account WHERE account_id=?")
      .get(accountId) as { adverse_generation: number } | undefined;
    if (!row || Number(row.adverse_generation) !== (this.index.adverse.get(accountId) ?? 0))
      throw blocked("The billing adverse counter does not match the verified index; funding is refused.");
  }

  /** Runs INSIDE the money `BEGIN IMMEDIATE`, after the trusted activation seam. */
  assertNewFundingWithinTx(
    db: DatabaseSync,
    args: { account_id: string; period_id: string; now: Date; stage: string },
  ): void {
    const state = this.state(db);
    if (state === "legacy") return;
    if (state === "unenrolled")
      throw blocked("Managed billing is installed but not enrolled; new paid funding is refused.");
    const mode = this.classify(db, args.account_id);
    if (mode === "manual") return;
    if (mode === "unadmitted")
      throw blocked("This account has no trusted billing admission; new paid funding is refused.");
    const head = this.head(db);
    if (
      !this.verified ||
      !head ||
      head.epoch !== this.verified.epoch ||
      head.ordinal !== this.verified.ordinal ||
      head.mac !== this.verified.mac
    )
      throw blocked("The billing journal head is not current; funding is refused until refreshed.");
    // Complete closed point validation of the exact used rows (no full journal scan).
    verifyBillingAccountGrant(db, this.context(db), args.account_id, args.period_id, args.now);
    this.assertIndexedCounter(db, this.context(db), args.account_id, head);
  }

  /**
   * Pre-I/O re-check for an already-marked call. It never establishes a new permission
   * and never mutates the hold: it re-authenticates the exact grant bound to this call's
   * period at the current clock/generation. A changed generation or an expired freshness
   * refuses the I/O while the marked hold (and any known settlement) is preserved.
   */
  verifyForExecution(
    db: DatabaseSync,
    accountId: string,
    periodId: string,
    now: Date,
  ): void {
    const state = this.state(db);
    if (state === "legacy") return;
    if (state === "unenrolled")
      throw blocked("Managed billing is not enrolled; funding is refused.");
    const mode = this.classify(db, accountId);
    if (mode === "manual") return;
    if (mode === "unadmitted")
      throw blocked("This account has no trusted billing admission; funding is refused.");
    verifyBillingAccountGrant(db, this.context(db), accountId, periodId, now);
  }

  /**
   * Writes the immutable call -> admission binding inside the reserve transaction. It is
   * billing-only; a legacy/manual account writes nothing. A failed proof insert rolls the
   * whole reserve back, so no base hold or zone freeze survives without its proof.
   */
  bindReservationWithinTx(
    db: DatabaseSync,
    args: {
      call_id: string;
      account_id: string;
      period_id: string;
      created_at: string;
    },
  ): void {
    if (this.state(db) !== "enrolled") return;
    const mode = this.classify(db, args.account_id);
    if (mode === "manual") return;
    if (mode === "unadmitted")
      throw blocked("This account has no trusted billing admission; funding is refused.");
    if (
      !db
        .prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='control_billing_reservation'")
        .get()
    )
      return;
    const context = this.context(db);
    const record = buildReservationBinding(db, context, args);
    const mac = reservationProofMac(record, context.key);
    const inserted = db
      .prepare(
        `INSERT INTO control_billing_reservation(
           call_id,account_id,epoch,admission_ordinal,tenant_incarnation,provisioning_generation,
           term_id,window_id,period_id,grant_ordinal,grant_mac,root_nonce,policy_digest,binding_digest,
           reservation_identity_hash,proof_json,proof_mac,created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        record.call_id, record.account_id, record.epoch, record.admission_ordinal, record.tenant_incarnation,
        record.provisioning_generation, record.term_id, record.window_id, record.period_id, record.grant_ordinal,
        record.grant_mac, record.root_nonce, record.policy_digest, record.binding_digest,
        record.identity_hash, canonical(record), mac, record.created_at,
      );
    if (Number(inserted.changes) !== 1)
      throw blocked("The billing reservation proof was not written.");
    const readback = db
      .prepare("SELECT proof_mac FROM control_billing_reservation WHERE call_id=?")
      .get(args.call_id) as { proof_mac: string } | undefined;
    if (!readback || readback.proof_mac !== mac)
      throw blocked("The billing reservation proof read-back failed.");
  }

  /**
   * Re-verifies the exact retained call -> admission proof. A missing proof on a billed
   * account denies (no legacy fallback); a changed generation/admission/context or a raw
   * reservation-identity tamper denies even if a fresh grant exists, so a stale worker can
   * never be re-authorized. Manual/legacy calls keep today's behavior.
   */
  verifyReservationWithinTx(
    db: DatabaseSync,
    args: { call_id: string; account_id: string; period_id: string; now: Date },
  ): void {
    const state = this.state(db);
    if (state === "legacy") return;
    if (state === "unenrolled") {
      this.verifyForExecution(db, args.account_id, args.period_id, args.now);
      return;
    }
    const mode = this.classify(db, args.account_id);
    if (mode === "manual") return;
    if (mode === "unadmitted")
      throw blocked("This account has no trusted billing admission; funding is refused.");
    const row = db
      .prepare("SELECT proof_json,proof_mac FROM control_billing_reservation WHERE call_id=?")
      .get(args.call_id) as { proof_json: string; proof_mac: string } | undefined;
    if (!row) throw blocked("This billed call has no reservation proof.");
    let record;
    try {
      record = parseReservationBinding(JSON.parse(row.proof_json));
    } catch {
      throw blocked("The billing reservation proof is malformed.");
    }
    if (canonical(record) !== row.proof_json)
      throw blocked("The billing reservation proof is not canonical.");
    const context = this.context(db);
    if (!verifyReservationProofMac(record, context.key, row.proof_mac))
      throw blocked("The billing reservation proof MAC is invalid.");
    if (
      record.call_id !== args.call_id ||
      record.account_id !== args.account_id ||
      record.period_id !== args.period_id
    )
      throw blocked("The billing reservation proof does not bind this call.");
    if (
      record.epoch !== context.epoch ||
      record.root_nonce !== context.root_nonce ||
      record.policy_digest !== context.policy_digest
    )
      throw blocked("The billing reservation proof context changed.");
    const incarnation = readAccountIncarnation(db, args.account_id);
    if (
      !incarnation ||
      incarnation.incarnation !== record.tenant_incarnation ||
      incarnation.provisioning_generation !== record.provisioning_generation
    )
      throw blocked("The billing reservation generation changed; funding is refused.");
    const account = db
      .prepare("SELECT admission_ordinal,binding_digest FROM control_billing_account WHERE account_id=?")
      .get(args.account_id) as { admission_ordinal: number; binding_digest: string } | undefined;
    if (
      !account ||
      Number(account.admission_ordinal) !== record.admission_ordinal ||
      account.binding_digest !== record.binding_digest
    )
      throw blocked("The billing reservation admission changed; funding is refused.");
    const base = db
      .prepare("SELECT identity_hash,job_id,dispatch_key,stage,provider,model,price_version,request_hash,config_hash,reserved_micro_usd FROM managed_reservations WHERE call_id=?")
      .get(args.call_id) as
      | { identity_hash: string; job_id: string; dispatch_key: string; stage: string; provider: string; model: string; price_version: string; request_hash: string; config_hash: string; reserved_micro_usd: number }
      | undefined;
    if (
      !base ||
      base.identity_hash !== record.identity_hash ||
      base.job_id !== record.job_id ||
      base.dispatch_key !== record.dispatch_key ||
      base.stage !== record.stage ||
      base.provider !== record.provider ||
      base.model !== record.model ||
      base.price_version !== record.price_version ||
      base.request_hash !== record.request_hash ||
      base.config_hash !== record.config_hash ||
      Number(base.reserved_micro_usd) !== record.reserved_micro_usd
    )
      throw blocked("The billing reservation identity changed; funding is refused.");
    verifyBillingAccountGrant(db, context, args.account_id, args.period_id, args.now);
    const head = this.head(db);
    if (head) this.assertIndexedCounter(db, context, args.account_id, head);
  }
}
