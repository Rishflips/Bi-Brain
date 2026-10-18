import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { BrainError, canonical } from "../domain/logic.ts";
import type { PaddleEventProjection } from "../domain/paddle-event.ts";
import type { PaddleMode } from "../providers/paddle.ts";
import type {
  BillingCorrelationSource,
  ServerBillingCorrelation,
} from "../domain/billing-admission.ts";

/**
 * Durable, non-authoritative Paddle coordination store.
 *
 * This separate SQLite file contains only opaque ids and normalized event fields.
 * It cannot mint B0 grants: payment authority still requires current provider reads
 * through BillingAuthority. Keeping this store separate avoids silently widening the
 * frozen money-5 schema; it is a single-host file and must join operational backups.
 */

const DDL = `
PRAGMA busy_timeout=5000;
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS paddle_checkout_intents(
  intent_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('sandbox','live')),
  cadence TEXT NOT NULL CHECK(cadence IN ('monthly','annual')),
  product_ref TEXT NOT NULL,
  price_ref TEXT NOT NULL,
  transaction_ref TEXT,
  uncertain INTEGER NOT NULL DEFAULT 0 CHECK(uncertain IN (0,1)),
  state TEXT NOT NULL CHECK(state IN ('pending','created','bound','expired','failed')),
  version INTEGER NOT NULL CHECK(version>=1),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS paddle_one_pending_intent
  ON paddle_checkout_intents(account_id) WHERE state IN ('pending','created');
CREATE TABLE IF NOT EXISTS paddle_events(
  mode TEXT NOT NULL CHECK(mode IN ('sandbox','live')),
  endpoint_ref TEXT NOT NULL,
  event_id TEXT NOT NULL,
  body_digest TEXT NOT NULL CHECK(length(body_digest)=64),
  projection_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','processing','done','denied')),
  lease_owner TEXT,
  lease_fence INTEGER NOT NULL DEFAULT 0,
  lease_expires_at TEXT,
  received_at TEXT NOT NULL,
  completed_at TEXT,
  PRIMARY KEY(mode,endpoint_ref,event_id));
CREATE TABLE IF NOT EXISTS paddle_bindings(
  account_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK(mode IN ('sandbox','live')),
  customer_ref TEXT NOT NULL UNIQUE,
  subscription_ref TEXT NOT NULL UNIQUE,
  initial_transaction_ref TEXT NOT NULL UNIQUE,
  intent_id TEXT NOT NULL UNIQUE REFERENCES paddle_checkout_intents(intent_id),
  cadence TEXT NOT NULL CHECK(cadence IN ('monthly','annual')),
  product_ref TEXT NOT NULL,
  price_ref TEXT NOT NULL,
  status TEXT NOT NULL,
  adverse_generation INTEGER NOT NULL DEFAULT 0 CHECK(adverse_generation>=0),
  version INTEGER NOT NULL CHECK(version>=1),
  verified_at TEXT,
  next_check_at TEXT,
  updated_at TEXT NOT NULL);
`;

const token = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._:-]+$/);
const uuid = z.string().uuid();
const modeSchema = z.enum(["sandbox", "live"]);
const cadenceSchema = z.enum(["monthly", "annual"]);
const conflict = (message: string) => new BrainError("CONFLICT", message, 409);
const invalid = (message: string) =>
  new BrainError("INVALID_INPUT", message, 400);

function iso(date: Date): string {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime()))
    throw invalid("The Paddle store clock is invalid.");
  return date.toISOString();
}

export class PaddleStore {
  readonly db: DatabaseSync;
  private readonly clock: () => Date;

  constructor(path: string, clock: () => Date = () => new Date()) {
    this.db = new DatabaseSync(path);
    this.db.exec(DDL);
    const columns = (table: string) =>
      new Set(
        (
          this.db.prepare(`PRAGMA table_info(${table})`).all() as {
            name: string;
          }[]
        ).map((column) => column.name),
      );
    const ensureColumn = (table: string, name: string, sql: string) => {
      if (columns(table).has(name)) return;
      try {
        this.db.exec(sql);
      } catch (error) {
        // The API and worker can start together against an older database.
        // If the other process completed this exact migration after our read,
        // accept it; every other migration failure remains fatal.
        if (!columns(table).has(name)) throw error;
      }
    };
    ensureColumn(
      "paddle_checkout_intents",
      "uncertain",
      "ALTER TABLE paddle_checkout_intents ADD COLUMN uncertain INTEGER NOT NULL DEFAULT 0 CHECK(uncertain IN (0,1))",
    );
    ensureColumn(
      "paddle_bindings",
      "verified_at",
      "ALTER TABLE paddle_bindings ADD COLUMN verified_at TEXT",
    );
    ensureColumn(
      "paddle_bindings",
      "next_check_at",
      "ALTER TABLE paddle_bindings ADD COLUMN next_check_at TEXT",
    );
    this.clock = clock;
  }

  close(): void {
    this.db.close();
  }

  createIntent(input: {
    account_id: string;
    mode: PaddleMode;
    cadence: "monthly" | "annual";
    product_ref: string;
    price_ref: string;
  }) {
    const accountId = uuid.parse(input.account_id);
    const mode = modeSchema.parse(input.mode);
    const cadence = cadenceSchema.parse(input.cadence);
    const product = token.parse(input.product_ref);
    const price = token.parse(input.price_ref);
    const now = this.clock();
    const created = iso(now);
    const expires = new Date(now.getTime() + 30 * 60 * 1000).toISOString();
    const intentId = randomUUID();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "UPDATE paddle_checkout_intents SET state='expired',version=version+1,updated_at=? WHERE account_id=? AND state='pending' AND uncertain=0 AND expires_at<=?",
        )
        .run(created, accountId, created);
      this.db
        .prepare(
          `INSERT INTO paddle_checkout_intents(
             intent_id,account_id,mode,cadence,product_ref,price_ref,transaction_ref,uncertain,state,
             version,created_at,expires_at,updated_at)
           VALUES(?,?,?,?,?,?,NULL,0,'pending',1,?,?,?)`,
        )
        .run(
          intentId,
          accountId,
          mode,
          cadence,
          product,
          price,
          created,
          expires,
          created,
        );
      this.db.exec("COMMIT");
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      if (
        error instanceof Error &&
        error.message.includes(
          "UNIQUE constraint failed: paddle_checkout_intents.account_id",
        )
      )
        throw conflict(
          "This account already has a checkout awaiting confirmation.",
        );
      throw error;
    }
    return {
      intent_id: intentId,
      cadence,
      state: "pending" as const,
      version: 1,
      expires_at: expires,
    };
  }

  /** Persist uncertainty before the create request can reach Paddle. */
  beginProviderCreate(input: { intent_id: string; expected_version: number }) {
    uuid.parse(input.intent_id);
    if (
      !Number.isSafeInteger(input.expected_version) ||
      input.expected_version < 1
    )
      throw invalid("The checkout intent version is invalid.");
    const now = iso(this.clock());
    const changed = this.db
      .prepare(
        `UPDATE paddle_checkout_intents
         SET uncertain=1,version=version+1,updated_at=?
         WHERE intent_id=? AND version=? AND state='pending' AND expires_at>?`,
      )
      .run(now, input.intent_id, input.expected_version, now);
    if (Number(changed.changes) !== 1)
      throw conflict("The checkout intent changed or expired.");
    return this.intent(input.intent_id)!;
  }

  attachTransaction(input: {
    intent_id: string;
    expected_version: number;
    transaction_ref: string;
  }) {
    uuid.parse(input.intent_id);
    token.parse(input.transaction_ref);
    if (
      !Number.isSafeInteger(input.expected_version) ||
      input.expected_version < 1
    )
      throw invalid("The checkout intent version is invalid.");
    const now = iso(this.clock());
    const changed = this.db
      .prepare(
        `UPDATE paddle_checkout_intents
         SET transaction_ref=?,uncertain=0,state='created',version=version+1,updated_at=?
         WHERE intent_id=? AND version=? AND state='pending' AND expires_at>?`,
      )
      .run(
        input.transaction_ref,
        now,
        input.intent_id,
        input.expected_version,
        now,
      );
    if (Number(changed.changes) !== 1) {
      const current = this.intent(input.intent_id);
      if (
        current?.transaction_ref === input.transaction_ref &&
        ["created", "bound"].includes(String(current.state))
      )
        return current;
      throw conflict(
        "The checkout intent changed, expired, or was already used.",
      );
    }
    return this.intent(input.intent_id)!;
  }

  intent(intentId: string) {
    if (!uuid.safeParse(intentId).success) return undefined;
    return this.db
      .prepare("SELECT * FROM paddle_checkout_intents WHERE intent_id=?")
      .get(intentId) as Record<string, unknown> | undefined;
  }

  accountIntent(accountId: string) {
    if (!uuid.safeParse(accountId).success) return undefined;
    return this.db
      .prepare(
        `SELECT intent_id,cadence,transaction_ref,uncertain,state,version,created_at,expires_at,updated_at
         FROM paddle_checkout_intents WHERE account_id=? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(accountId) as Record<string, unknown> | undefined;
  }

  failIntent(intentId: string, expectedVersion: number): void {
    if (!uuid.safeParse(intentId).success) return;
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) return;
    this.db
      .prepare(
        `UPDATE paddle_checkout_intents SET uncertain=0,state='failed',version=version+1,updated_at=?
         WHERE intent_id=? AND version=? AND state='pending'`,
      )
      .run(iso(this.clock()), intentId, expectedVersion);
  }

  binding(accountId: string) {
    if (!uuid.safeParse(accountId).success) return undefined;
    return this.db
      .prepare(
        `SELECT account_id,mode,customer_ref,subscription_ref,initial_transaction_ref,
                intent_id,cadence,product_ref,price_ref,status,adverse_generation,version,
                verified_at,next_check_at,updated_at
         FROM paddle_bindings WHERE account_id=?`,
      )
      .get(accountId) as Record<string, unknown> | undefined;
  }

  correlation(accountId: string): ServerBillingCorrelation | undefined {
    const row = this.binding(accountId);
    if (!row) return undefined;
    return {
      schema: 1,
      mode: row.mode as PaddleMode,
      product_ref: String(row.product_ref),
      price_ref: String(row.price_ref),
      cadence: row.cadence as "monthly" | "annual",
      customer_ref: String(row.customer_ref),
      subscription_ref: String(row.subscription_ref),
      initial_transaction_ref: String(row.initial_transaction_ref),
      correlation_ref: String(row.intent_id),
      version: Number(row.version),
    };
  }

  correlationSource(): BillingCorrelationSource {
    return {
      resolve: async ({ account_id }) => {
        const value = this.correlation(account_id);
        if (!value)
          throw conflict("No Paddle correlation exists for this account.");
        return value;
      },
    };
  }

  setBindingStatus(input: {
    account_id: string;
    expected_version: number;
    status: string;
    verified?: boolean;
    retry_ms?: number;
  }): void {
    uuid.parse(input.account_id);
    token.parse(input.status);
    if (
      !Number.isSafeInteger(input.expected_version) ||
      input.expected_version < 1
    )
      throw invalid("The Paddle binding version is invalid.");
    const now = this.clock();
    const next = new Date(
      now.getTime() +
        (input.retry_ms ?? (input.verified ? 5 * 60_000 : 60_000)),
    ).toISOString();
    const changed = this.db
      .prepare(
        `UPDATE paddle_bindings SET status=?,version=version+1,verified_at=?,next_check_at=?,updated_at=?
         WHERE account_id=? AND version=?`,
      )
      .run(
        input.status,
        input.verified ? iso(now) : null,
        next,
        iso(now),
        input.account_id,
        input.expected_version,
      );
    if (Number(changed.changes) !== 1)
      throw conflict("The Paddle binding changed during verification.");
  }

  dueBindings(limit = 4): string[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 4)
      throw invalid("The Paddle reconciliation limit is invalid.");
    const now = iso(this.clock());
    return (
      this.db
        .prepare(
          `SELECT account_id FROM paddle_bindings
           WHERE next_check_at IS NULL OR next_check_at<=?
           ORDER BY COALESCE(next_check_at,''),updated_at,account_id LIMIT ?`,
        )
        .all(now, limit) as { account_id: string }[]
    ).map((row) => row.account_id);
  }

  ingestEvent(input: {
    mode: PaddleMode;
    endpoint_ref: string;
    body_digest: string;
    projection: PaddleEventProjection;
  }): { state: "accepted" | "duplicate" | "conflict" } {
    const mode = modeSchema.parse(input.mode);
    const endpoint = token.parse(input.endpoint_ref);
    if (!/^[0-9a-f]{64}$/.test(input.body_digest))
      throw invalid("The Paddle event body digest is invalid.");
    const projectionJson = canonical(input.projection);
    const now = iso(this.clock());
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.db
        .prepare(
          "SELECT body_digest,projection_json FROM paddle_events WHERE mode=? AND endpoint_ref=? AND event_id=?",
        )
        .get(mode, endpoint, input.projection.event_id) as
        { body_digest: string; projection_json: string } | undefined;
      if (current) {
        const exact =
          current.body_digest === input.body_digest &&
          current.projection_json === projectionJson;
        if (!exact) {
          const retained = JSON.parse(
            current.projection_json,
          ) as PaddleEventProjection;
          const subscriptions = new Set(
            [
              retained.subscription_ref,
              input.projection.subscription_ref,
            ].filter((value): value is string => value !== null),
          );
          for (const subscription of subscriptions)
            this.db
              .prepare(
                `UPDATE paddle_bindings SET status='attention',adverse_generation=adverse_generation+1,
                   version=version+1,next_check_at=?,updated_at=?
                 WHERE mode=? AND subscription_ref=?`,
              )
              .run(now, now, mode, subscription);
        }
        this.db.exec("COMMIT");
        return { state: exact ? "duplicate" : "conflict" };
      }
      this.db
        .prepare(
          `INSERT INTO paddle_events(
             mode,endpoint_ref,event_id,body_digest,projection_json,state,received_at)
           VALUES(?,?,?,?,?,'pending',?)`,
        )
        .run(
          mode,
          endpoint,
          input.projection.event_id,
          input.body_digest,
          projectionJson,
          now,
        );
      this.db.exec("COMMIT");
      return { state: "accepted" };
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  leaseEvents(
    owner: string,
    limit = 10,
  ): Array<{
    mode: PaddleMode;
    endpoint_ref: string;
    event_id: string;
    projection: PaddleEventProjection;
    lease_fence: number;
  }> {
    token.parse(owner);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10)
      throw invalid("The Paddle event lease limit is invalid.");
    const now = this.clock();
    const nowIso = iso(now);
    const expires = new Date(now.getTime() + 60_000).toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const candidates = this.db
        .prepare(
          `SELECT mode,endpoint_ref,event_id FROM paddle_events
           WHERE (state='pending' AND received_at<=?)
              OR (state='processing' AND lease_expires_at<=?)
           ORDER BY received_at,event_id LIMIT ?`,
        )
        .all(nowIso, nowIso, limit) as {
        mode: PaddleMode;
        endpoint_ref: string;
        event_id: string;
      }[];
      for (const row of candidates)
        this.db
          .prepare(
            `UPDATE paddle_events SET state='processing',lease_owner=?,lease_fence=lease_fence+1,lease_expires_at=?
             WHERE mode=? AND endpoint_ref=? AND event_id=?`,
          )
          .run(owner, expires, row.mode, row.endpoint_ref, row.event_id);
      const leased = candidates.map((row) => {
        const record = this.db
          .prepare(
            "SELECT projection_json,lease_fence FROM paddle_events WHERE mode=? AND endpoint_ref=? AND event_id=?",
          )
          .get(row.mode, row.endpoint_ref, row.event_id) as {
          projection_json: string;
          lease_fence: number;
        };
        return {
          ...row,
          projection: JSON.parse(
            record.projection_json,
          ) as PaddleEventProjection,
          lease_fence: Number(record.lease_fence),
        };
      });
      this.db.exec("COMMIT");
      return leased;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  completeEvent(input: {
    mode: PaddleMode;
    endpoint_ref: string;
    event_id: string;
    owner: string;
    lease_fence: number;
    outcome: "done" | "denied";
  }): void {
    const changed = this.db
      .prepare(
        `UPDATE paddle_events SET state=?,completed_at=?,lease_owner=NULL,lease_expires_at=NULL
         WHERE mode=? AND endpoint_ref=? AND event_id=? AND state='processing'
           AND lease_owner=? AND lease_fence=?`,
      )
      .run(
        input.outcome,
        iso(this.clock()),
        input.mode,
        input.endpoint_ref,
        input.event_id,
        input.owner,
        input.lease_fence,
      );
    if (Number(changed.changes) !== 1)
      throw conflict("The Paddle event lease is stale.");
  }

  /**
   * Applies only correlation/restriction metadata under the event lease. A
   * completed event can bind the exact server-created transaction, but never
   * creates an allowance; B0 still requires fresh Paddle reads.
   */
  applyLeasedEvent(input: {
    mode: PaddleMode;
    endpoint_ref: string;
    event_id: string;
    owner: string;
    lease_fence: number;
    projection: PaddleEventProjection;
  }): { state: "done" | "orphan" | "denied"; account_id?: string } {
    modeSchema.parse(input.mode);
    token.parse(input.endpoint_ref);
    token.parse(input.owner);
    const now = iso(this.clock());
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const lease = this.db
        .prepare(
          `SELECT state,lease_owner,lease_fence,projection_json FROM paddle_events
           WHERE mode=? AND endpoint_ref=? AND event_id=?`,
        )
        .get(input.mode, input.endpoint_ref, input.event_id) as
        | {
            state: string;
            lease_owner: string;
            lease_fence: number;
            projection_json: string;
          }
        | undefined;
      if (
        !lease ||
        lease.state !== "processing" ||
        lease.lease_owner !== input.owner ||
        Number(lease.lease_fence) !== input.lease_fence ||
        lease.projection_json !== canonical(input.projection)
      )
        throw conflict("The Paddle event lease is stale.");

      let accountId: string | undefined;
      let outcome: "done" | "orphan" | "denied" = "done";
      const projection = input.projection;
      if (
        projection.event_type.startsWith("transaction.") &&
        projection.intent_ref &&
        projection.transaction_ref
      ) {
        const intent = this.db
          .prepare(
            "SELECT * FROM paddle_checkout_intents WHERE intent_id=? AND mode=?",
          )
          .get(projection.intent_ref, input.mode) as
          Record<string, unknown> | undefined;
        if (!intent) {
          outcome = "denied";
        } else {
          if (intent.state === "pending" && Number(intent.uncertain) === 1) {
            this.db
              .prepare(
                `UPDATE paddle_checkout_intents
                 SET transaction_ref=?,uncertain=0,state='created',version=version+1,updated_at=?
                 WHERE intent_id=? AND state='pending' AND uncertain=1`,
              )
              .run(projection.transaction_ref, now, String(intent.intent_id));
            intent.transaction_ref = projection.transaction_ref;
            intent.uncertain = 0;
            intent.state = "created";
          } else if (intent.state === "pending") {
            outcome = "orphan";
          }
          if (outcome === "done" && intent.state === "created") {
            if (intent.transaction_ref !== projection.transaction_ref) {
              outcome = "denied";
            } else if (projection.status === "canceled") {
              accountId = String(intent.account_id);
              this.db
                .prepare(
                  `UPDATE paddle_checkout_intents
                   SET uncertain=0,state='failed',version=version+1,updated_at=?
                   WHERE intent_id=? AND state='created' AND transaction_ref=?`,
                )
                .run(now, String(intent.intent_id), projection.transaction_ref);
            } else if (
              projection.event_type === "transaction.completed" &&
              projection.status === "completed"
            ) {
              if (!projection.subscription_ref || !projection.customer_ref) {
                this.db
                  .prepare(
                    `UPDATE paddle_checkout_intents
                     SET uncertain=1,version=version+1,updated_at=?
                     WHERE intent_id=? AND state='created' AND transaction_ref=?`,
                  )
                  .run(
                    now,
                    String(intent.intent_id),
                    projection.transaction_ref,
                  );
                accountId = String(intent.account_id);
                outcome = "denied";
              } else {
                accountId = String(intent.account_id);
                const existing = this.binding(accountId);
                if (existing) {
                  const same =
                    existing.intent_id === intent.intent_id &&
                    existing.initial_transaction_ref ===
                      projection.transaction_ref &&
                    existing.subscription_ref === projection.subscription_ref &&
                    existing.customer_ref === projection.customer_ref;
                  outcome = same ? "done" : "denied";
                } else {
                  this.db
                    .prepare(
                      `INSERT INTO paddle_bindings(
                         account_id,mode,customer_ref,subscription_ref,initial_transaction_ref,
                         intent_id,cadence,product_ref,price_ref,status,adverse_generation,version,
                         verified_at,next_check_at,updated_at)
                       VALUES(?,?,?,?,?,?,?,?,?,'pending_verification',0,1,NULL,?,?)`,
                    )
                    .run(
                      accountId,
                      input.mode,
                      projection.customer_ref,
                      projection.subscription_ref,
                      projection.transaction_ref,
                      String(intent.intent_id),
                      String(intent.cadence),
                      String(intent.product_ref),
                      String(intent.price_ref),
                      now,
                      now,
                    );
                  this.db
                    .prepare(
                      `UPDATE paddle_checkout_intents SET state='bound',version=version+1,updated_at=?
                       WHERE intent_id=? AND state='created'`,
                    )
                    .run(now, String(intent.intent_id));
                }
              }
            } else if (projection.event_type === "transaction.completed") {
              this.db
                .prepare(
                  `UPDATE paddle_checkout_intents
                   SET uncertain=1,version=version+1,updated_at=?
                   WHERE intent_id=? AND state='created' AND transaction_ref=?`,
                )
                .run(now, String(intent.intent_id), projection.transaction_ref);
              accountId = String(intent.account_id);
              outcome = "denied";
            }
          } else if (outcome === "done" && intent.state === "bound") {
            accountId = String(intent.account_id);
            const existing = this.binding(accountId);
            const same =
              !!existing &&
              existing.intent_id === intent.intent_id &&
              existing.initial_transaction_ref === projection.transaction_ref;
            if (!same) {
              outcome = "denied";
            } else if (
              projection.status !== null &&
              !["draft", "ready", "paid", "completed"].includes(
                projection.status,
              )
            ) {
              this.db
                .prepare(
                  `UPDATE paddle_bindings SET status='attention',adverse_generation=adverse_generation+1,
                     version=version+1,next_check_at=?,updated_at=? WHERE account_id=?`,
                )
                .run(now, now, accountId);
            }
          } else if (outcome === "done") {
            outcome = "denied";
          }
        }
      } else if (projection.subscription_ref) {
        const existing = this.db
          .prepare(
            "SELECT account_id,status FROM paddle_bindings WHERE subscription_ref=? AND mode=?",
          )
          .get(projection.subscription_ref, input.mode) as
          { account_id: string; status: string } | undefined;
        if (existing) {
          accountId = existing.account_id;
          const adverse =
            projection.event_type.startsWith("adjustment.") ||
            (projection.status !== null &&
              !["active", "trialing", "completed"].includes(projection.status));
          if (adverse)
            this.db
              .prepare(
                `UPDATE paddle_bindings SET status='attention',adverse_generation=adverse_generation+1,
                   version=version+1,next_check_at=?,updated_at=? WHERE account_id=?`,
              )
              .run(now, now, accountId);
        }
      }

      if (outcome === "orphan") {
        const retryAt = new Date(this.clock().getTime() + 2_000).toISOString();
        this.db
          .prepare(
            `UPDATE paddle_events SET state='pending',received_at=?,lease_owner=NULL,lease_expires_at=NULL
             WHERE mode=? AND endpoint_ref=? AND event_id=? AND lease_owner=? AND lease_fence=?`,
          )
          .run(
            retryAt,
            input.mode,
            input.endpoint_ref,
            input.event_id,
            input.owner,
            input.lease_fence,
          );
      } else {
        this.db
          .prepare(
            `UPDATE paddle_events SET state=?,completed_at=?,lease_owner=NULL,lease_expires_at=NULL
             WHERE mode=? AND endpoint_ref=? AND event_id=? AND lease_owner=? AND lease_fence=?`,
          )
          .run(
            outcome === "denied" ? "denied" : "done",
            now,
            input.mode,
            input.endpoint_ref,
            input.event_id,
            input.owner,
            input.lease_fence,
          );
      }
      this.db.exec("COMMIT");
      return {
        state: outcome,
        ...(accountId ? { account_id: accountId } : {}),
      };
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
