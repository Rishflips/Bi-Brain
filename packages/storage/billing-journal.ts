import { DatabaseSync } from "node:sqlite";
import { BrainError } from "../domain/logic.ts";
import { assertExactKeys, invalid, isHex64, isPlainObject, isSafeInt, isToken } from "../domain/billing-authority.ts";
import { canonicalSealFrame, verifySealMac } from "../domain/billing-seal.ts";
import { billingAuthoritySchemaDigest, billingIntegratedSchemaDigest, billingJournalSchemaDigest } from "./billing-schema.ts";

export { BILLING_JOURNAL_DDL, billingJournalSchemaDigest } from "./billing-schema.ts";

/**
 * B0 signed-journal read-only verifier.
 *
 * The closed DDL and catalog checks live in `billing-schema.ts`; this module re-exports
 * the journal constants for existing callers and keeps the journal read strict by
 * default. A caller may explicitly select the full `authority` variant, which is the only
 * way a full-schema database is accepted — the journal default is never silently widened.
 *
 * This is a bounded boot/writer verifier, not a per-model-send optimization: it scans the
 * bounded journal. MAC integrity is not payment evidence.
 */

const BINDING_KEYS = ["epoch", "root_nonce", "policy_id"] as const;
const ALLOWED_OPTION_KEYS = new Set(["max_entries", "variant"]);
const JOURNAL_MAX_FRAME_BYTES = 16 * 1024;
const JOURNAL_MAX_TOTAL_BYTES = 16 * 1024 * 1024;

export const BILLING_JOURNAL_MAX_ENTRIES = 100_000;

export interface BillingJournalBinding {
  epoch: number;
  root_nonce: string;
  policy_id: string;
}

export type BillingJournalSnapshot =
  | { state: "empty" }
  | { state: "verified"; epoch: number; ordinal: number; mac: string; entries: number };

const corrupt = (message = "The billing journal could not be verified.") =>
  new BrainError("UNAVAILABLE", message, 503);

interface LogRow {
  epoch: number;
  ordinal: number;
  frame_json: string;
  mac: string;
}

interface HeadRow {
  singleton: number;
  epoch: number;
  ordinal: number;
  mac: string;
}

function assertKey(key: unknown): asserts key is Uint8Array {
  if (!(key instanceof Uint8Array) || key.length !== 32)
    throw invalid("The billing journal key must be exactly 32 raw bytes.");
}

function validateBinding(binding: unknown): BillingJournalBinding {
  if (!isPlainObject(binding)) throw invalid("The billing journal binding is required.");
  assertExactKeys(binding, BINDING_KEYS);
  if (!isSafeInt(binding.epoch, 1)) throw invalid("The billing journal binding epoch is invalid.");
  if (!isHex64(binding.root_nonce)) throw invalid("The billing journal binding nonce is invalid.");
  if (!isToken(binding.policy_id)) throw invalid("The billing journal binding policy is invalid.");
  return {
    epoch: binding.epoch as number,
    root_nonce: binding.root_nonce as string,
    policy_id: binding.policy_id as string,
  };
}

interface JournalOptions {
  bound: number;
  variant: "journal" | "authority" | "integrated";
}

function validateOptions(options: unknown): JournalOptions {
  if (options === undefined) return { bound: BILLING_JOURNAL_MAX_ENTRIES, variant: "journal" };
  if (options === null || typeof options !== "object" || Array.isArray(options))
    throw invalid("The billing journal read options are required.");
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key !== "string" || !ALLOWED_OPTION_KEYS.has(key))
      throw invalid("The billing journal read options are not closed.");
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (!descriptor || !("value" in descriptor)) throw invalid("The billing journal read options must be plain data.");
  }
  const record = options as { max_entries?: unknown; variant?: unknown };
  if (!isSafeInt(record.max_entries, 1, BILLING_JOURNAL_MAX_ENTRIES))
    throw invalid("The billing journal read bound is invalid.");
  let variant: "journal" | "authority" | "integrated" = "journal";
  if (record.variant !== undefined) {
    if (record.variant !== "journal" && record.variant !== "authority" && record.variant !== "integrated")
      throw invalid("The billing journal read variant is invalid.");
    variant = record.variant;
  }
  return { bound: record.max_entries as number, variant };
}

function schemaDigest(db: DatabaseSync, variant: "journal" | "authority" | "integrated"): string {
  if (variant === "integrated") return billingIntegratedSchemaDigest(db);
  return variant === "authority" ? billingAuthoritySchemaDigest(db) : billingJournalSchemaDigest(db);
}

function verify(
  db: DatabaseSync,
  binding: BillingJournalBinding,
  key: Uint8Array,
  options: JournalOptions,
): BillingJournalSnapshot {
  schemaDigest(db, options.variant);

  const totals = db
    .prepare(
      "SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(CAST(frame_json AS BLOB))),0) AS bytes FROM control_billing_log",
    )
    .get() as unknown as { n: number; bytes: number };
  const total = Number(totals.n);
  const totalBytes = Number(totals.bytes);

  const epochRows = db
    .prepare("SELECT COUNT(*) AS n FROM control_billing_log WHERE epoch=?")
    .get(binding.epoch) as unknown as { n: number };
  if (Number(epochRows.n) !== total)
    throw corrupt("The billing journal contains rows outside the bound epoch.");

  const heads = db
    .prepare("SELECT singleton,epoch,ordinal,mac FROM control_billing_head ORDER BY singleton")
    .all() as unknown as HeadRow[];
  if (heads.length > 1) throw corrupt("The billing journal has more than one head.");
  const head = heads[0];
  if (head && head.singleton !== 1) throw corrupt("The billing journal head is malformed.");

  if (total === 0) {
    if (head) throw corrupt("A billing journal head exists with no records.");
    return { state: "empty" };
  }
  if (!head) throw corrupt("Billing journal records exist without a head.");
  if (total > options.bound) throw corrupt("The billing journal exceeds the entries bound.");
  if (totalBytes > JOURNAL_MAX_TOTAL_BYTES) throw corrupt("The billing journal exceeds the verification byte bound.");

  const rows = db
    .prepare("SELECT epoch,ordinal,frame_json,mac FROM control_billing_log WHERE epoch=? ORDER BY ordinal LIMIT ?")
    .all(binding.epoch, options.bound + 1) as unknown as LogRow[];
  if (rows.length > options.bound) throw corrupt("The billing journal exceeds the entries bound.");

  let previousMac = "";
  let lastOrdinal = -1;
  let lastMac = "";
  let countedBytes = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (row.epoch !== binding.epoch || row.ordinal !== index)
      throw corrupt("The billing journal ordinals are not contiguous from zero.");
    if (typeof row.frame_json !== "string" || typeof row.mac !== "string")
      throw corrupt("A billing journal row is malformed.");
    const frameBytes = Buffer.byteLength(row.frame_json, "utf8");
    if (frameBytes > JOURNAL_MAX_FRAME_BYTES) throw corrupt("A billing journal frame exceeds the maximum size.");
    countedBytes += frameBytes;
    if (countedBytes > JOURNAL_MAX_TOTAL_BYTES) throw corrupt("The billing journal exceeds the verification byte bound.");

    let parsed: unknown;
    try {
      parsed = JSON.parse(row.frame_json);
    } catch {
      throw corrupt("A billing journal frame is not valid JSON.");
    }
    if (canonicalSealFrame(parsed) !== row.frame_json) throw corrupt("A billing journal frame is not canonical.");
    const frame = parsed as { epoch: number; ordinal: number; root_nonce: string; policy_id: string; prev_mac: string };
    if (frame.epoch !== binding.epoch || frame.ordinal !== index)
      throw corrupt("A billing journal frame does not match the bound epoch and order.");
    if (frame.root_nonce !== binding.root_nonce || frame.policy_id !== binding.policy_id)
      throw corrupt("A billing journal frame does not match the bound authority context.");
    if (frame.prev_mac !== previousMac) throw corrupt("The billing journal chain link does not match.");
    if (!verifySealMac(frame, key, row.mac)) throw corrupt("A billing journal frame MAC is invalid.");
    previousMac = row.mac;
    lastOrdinal = index;
    lastMac = row.mac;
  }

  if (head.epoch !== binding.epoch) throw corrupt("The billing journal head is in a foreign epoch.");
  if (head.ordinal !== lastOrdinal || head.mac !== lastMac)
    throw corrupt("The billing journal head does not match the final record.");

  return { state: "verified", epoch: binding.epoch, ordinal: lastOrdinal, mac: lastMac, entries: rows.length };
}

function beginOwnTransaction(db: DatabaseSync): void {
  try {
    db.exec("BEGIN DEFERRED");
  } catch {
    throw corrupt("The billing journal read transaction could not start.");
  }
}

function commitOwnTransaction(db: DatabaseSync): void {
  try {
    db.exec("COMMIT");
  } catch {
    throw corrupt("The billing journal read transaction could not commit.");
  }
  // A silently ignored COMMIT leaves the read transaction open; never report the
  // snapshot as verified and let the caller roll it back.
  if (db.isTransaction)
    throw corrupt("The billing journal read transaction commit was not applied.");
}

function rollbackOwnTransaction(db: DatabaseSync): void {
  if (!db.isTransaction) return;
  try {
    db.exec("ROLLBACK");
  } catch {
    /* static: a denied rollback cannot turn a refusal into verified success */
  }
}

export function readBillingJournal(
  db: DatabaseSync,
  binding: BillingJournalBinding,
  key: Uint8Array,
  options?: { max_entries: number; variant?: "journal" | "authority" | "integrated" },
): BillingJournalSnapshot {
  const parsedOptions = validateOptions(options);
  const context = validateBinding(binding);
  assertKey(key);

  const ownsTransaction = !db.isTransaction;
  if (ownsTransaction) beginOwnTransaction(db);
  try {
    const snapshot = verify(db, context, key, parsedOptions);
    if (ownsTransaction) commitOwnTransaction(db);
    return snapshot;
  } catch (error) {
    if (ownsTransaction) rollbackOwnTransaction(db);
    if (error instanceof BrainError) throw error;
    throw corrupt();
  }
}
