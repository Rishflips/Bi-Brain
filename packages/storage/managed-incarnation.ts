import type { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { BrainError } from "../domain/logic.ts";
import { mintIncarnation, type Incarnation, type IncarnationSource } from "../domain/billing-admission.ts";

/**
 * Trusted per-account provisioning incarnation + durable fence over the control
 * database. These tables exist only in the money-5 integrated schema; callers must
 * check the schema first. Nothing here opens a tenant database or a nested writer.
 */

const invalid = (message: string) => new BrainError("INVALID_INPUT", message, 400);
const conflict = (message: string) => new BrainError("CONFLICT", message, 409);

function accountIdentity(
  db: DatabaseSync,
  accountId: string,
): { issuer: string; subject: string } {
  const row = db
    .prepare("SELECT issuer,subject FROM managed_accounts WHERE id=?")
    .get(accountId) as { issuer: string; subject: string } | undefined;
  if (!row) throw invalid("The managed account is unavailable.");
  return { issuer: row.issuer, subject: row.subject };
}

export function readAccountIncarnation(
  db: DatabaseSync,
  accountId: string,
): Incarnation | undefined {
  const row = db
    .prepare(
      "SELECT incarnation,provisioning_generation,source,minted_at FROM managed_account_incarnation WHERE account_id=?",
    )
    .get(accountId) as
    | { incarnation: string; provisioning_generation: number; source: IncarnationSource; minted_at: string }
    | undefined;
  if (!row) return undefined;
  return {
    incarnation: row.incarnation,
    provisioning_generation: Number(row.provisioning_generation),
    source: row.source,
    minted_at: row.minted_at,
  };
}

/**
 * INSERT-only mint at generation 1. A repeated provision returns the existing row,
 * so a generation is never reset. The caller supplies a random nonce.
 */
export function mintAccountIncarnation(
  db: DatabaseSync,
  args: { account_id: string; issuer: string; subject: string; now: string; nonce: string },
): Incarnation {
  const existing = readAccountIncarnation(db, args.account_id);
  if (existing) return existing;
  const minted = mintIncarnation({
    account_id: args.account_id,
    issuer: args.issuer,
    subject: args.subject,
    provisioning_generation: 1,
    minted_at: args.now,
    nonce: args.nonce,
  });
  const inserted = db
    .prepare(
      "INSERT INTO managed_account_incarnation(account_id,incarnation,provisioning_generation,source,minted_at) VALUES(?,?,?,?,?) ON CONFLICT(account_id) DO NOTHING",
    )
    .run(args.account_id, minted.incarnation, minted.provisioning_generation, "provision", minted.minted_at);
  void inserted;
  return readAccountIncarnation(db, args.account_id)!;
}

/**
 * Monotonic rotation (restore/rebuild/replace). Requires an existing row; a missing
 * incarnation is never minted here, so a lost history cannot silently regain funding.
 */
export function rotateAccountIncarnation(
  db: DatabaseSync,
  accountId: string,
  args: { source: Exclude<IncarnationSource, "provision" | "enroll">; now: string; nonce: string },
): Incarnation {
  const existing = readAccountIncarnation(db, accountId);
  if (!existing) throw conflict("No provisioning incarnation exists to advance.");
  const next = existing.provisioning_generation + 1;
  const identity = accountIdentity(db, accountId);
  const minted = mintIncarnation({
    account_id: accountId,
    issuer: identity.issuer,
    subject: identity.subject,
    provisioning_generation: next,
    minted_at: args.now,
    nonce: args.nonce,
  });
  const updated = db
    .prepare(
      "UPDATE managed_account_incarnation SET incarnation=?,provisioning_generation=?,source=?,minted_at=? WHERE account_id=? AND provisioning_generation=?",
    )
    .run(minted.incarnation, next, args.source, minted.minted_at, accountId, existing.provisioning_generation);
  if (Number(updated.changes) !== 1)
    throw conflict("The provisioning incarnation changed concurrently.");
  return readAccountIncarnation(db, accountId)!;
}

export function activeFence(
  db: DatabaseSync,
  accountId: string,
): { generation: number; reason: string } | undefined {
  const row = db
    .prepare(
      "SELECT generation,reason FROM managed_account_fence WHERE account_id=? AND cleared_at IS NULL",
    )
    .get(accountId) as { generation: number; reason: string } | undefined;
  return row ? { generation: Number(row.generation), reason: row.reason } : undefined;
}

/**
 * Acquire (or re-acquire) the durable fence and advance the generation. The caller
 * must run this BEFORE mutating tenant history, so a partial operation stays fenced.
 * Uses the current incarnation generation, or 1 when none exists yet.
 */
export function fenceAccount(
  db: DatabaseSync,
  accountId: string,
  reason: "rebuild" | "restore" | "replace",
  now: string,
): { generation: number } {
  // Advance the provisioning generation BEFORE the caller mutates tenant storage, so
  // an in-flight old worker cannot mark against a pre-mutation generation.
  let current = readAccountIncarnation(db, accountId);
  if (current) {
    current = rotateAccountIncarnation(db, accountId, {
      source: reason === "restore" ? "restore" : "rebuild",
      now,
      nonce: randomBytes(32).toString("hex"),
    });
  }
  const generation = current ? current.provisioning_generation : 1;
  db.prepare(
    `INSERT INTO managed_account_fence(account_id,generation,reason,fenced_at,cleared_at)
     VALUES(?,?,?,?,NULL)
     ON CONFLICT(account_id) DO UPDATE SET generation=excluded.generation,reason=excluded.reason,fenced_at=excluded.fenced_at,cleared_at=NULL`,
  ).run(accountId, generation, reason, now);
  return { generation };
}

export function clearFence(db: DatabaseSync, accountId: string, now: string): void {
  db.prepare(
    "UPDATE managed_account_fence SET cleared_at=? WHERE account_id=? AND cleared_at IS NULL",
  ).run(now, accountId);
}
