import { constants, DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { BrainError } from "../../packages/domain/logic.ts";
import { canonicalSealFrame, sealMac } from "../../packages/domain/billing-seal.ts";
import {
  BILLING_JOURNAL_DDL,
  billingJournalSchemaDigest,
  readBillingJournal,
} from "../../packages/storage/billing-journal.ts";

// SYNTHETIC signed records inserted by tests, never payment evidence or a grant endpoint.
const account = "11111111-1111-4111-8111-111111111111";
const key = new Uint8Array(32).fill(7);
const binding = { epoch: 1, root_nonce: "a".repeat(64), policy_id: "SYNTHETIC-policy" };
function admission(ordinal = 0, prev_mac = "") {
  return {
    schema: 1, purpose: "admission", ...binding, ordinal, prev_mac,
    source_ids: ["SYNTHETIC-clean-baseline"], body: {
      account_id: account, identity_digest: "b".repeat(64),
      tenant_incarnation: "c".repeat(64), clean_baseline_proof: "d".repeat(64),
    },
  };
}
function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(BILLING_JOURNAL_DDL);
  const first = admission(), mac0 = sealMac(first, key);
  const second = {
    ...admission(1, mac0), purpose: "grant", source_ids: ["SYNTHETIC-receipt"],
    body: { account_id: account, window_id: "e".repeat(64), term_id: "SYNTHETIC-term",
      period_id: "22222222-2222-4222-8222-222222222222", window_start: "2027-01-31T00:00:00.000Z",
      window_end: "2027-02-28T00:00:00.000Z", allowance_micro_usd: 100 },
  };
  const mac1 = sealMac(second, key);
  const insert = db.prepare("INSERT INTO control_billing_log(epoch,ordinal,frame_json,mac) VALUES(?,?,?,?)");
  insert.run(1, 0, canonicalSealFrame(first), mac0);
  insert.run(1, 1, canonicalSealFrame(second), mac1);
  db.prepare("INSERT INTO control_billing_head(singleton,epoch,ordinal,mac) VALUES(1,1,1,?)").run(mac1);
  return { db, first, second, mac0, mac1 };
}

function withLogTriggersRemoved(db: DatabaseSync, mutate: () => void) {
  const triggers = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name='control_billing_log'")
    .all() as { name: string; sql: string }[];
  for (const trigger of triggers) db.exec(`DROP TRIGGER "${trigger.name.replaceAll('"', '""')}"`);
  try { mutate(); } finally { for (const trigger of triggers) db.exec(trigger.sql); }
}

it("verifies a full signed chain against the frozen root and exact final head", () => {
  const f = fixture();
  try {
    expect(readBillingJournal(f.db, binding, key)).toEqual({
      state: "verified", epoch: 1, ordinal: 1, mac: f.mac1, entries: 2,
    });
    expect(f.db.isTransaction).toBe(false);
  } finally { f.db.close(); }
});

it("an empty valid schema is explicitly empty, never a verified spending permit", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(BILLING_JOURNAL_DDL);
    expect(readBillingJournal(db, binding, key)).toEqual({ state: "empty" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM control_billing_head").get()).toMatchObject({ n: 0 });
  } finally { db.close(); }
});

it.each([
  { ...binding, epoch: 2 }, { ...binding, root_nonce: "f".repeat(64) },
  { ...binding, policy_id: "SYNTHETIC-other-policy" }, { ...binding, approved: true },
])("cannot rebind a valid journal to other authority context: %j", (wrong) => {
  const f = fixture();
  try { expect(() => readBillingJournal(f.db, wrong, key)).toThrow(BrainError); }
  finally { f.db.close(); }
});

it("a different key cannot verify syntactically valid records", () => {
  const f = fixture();
  try { expect(() => readBillingJournal(f.db, binding, new Uint8Array(32).fill(8))).toThrow(BrainError); }
  finally { f.db.close(); }
});

it("cannot return partial verified success when the row limit is exhausted", () => {
  const f = fixture();
  try {
    expect(() => readBillingJournal(f.db, binding, key, { max_entries: 1 })).toThrow(BrainError);
    expect(f.db.isTransaction).toBe(false);
    expect(readBillingJournal(f.db, binding, key, { max_entries: 2 })).toMatchObject({ entries: 2 });
  } finally { f.db.close(); }
});

it.each([0, -1, 1.5, Number.NaN, 100_001])("rejects invalid or widened scan bound %s", (max_entries) => {
  const f = fixture();
  try { expect(() => readBillingJournal(f.db, binding, key, { max_entries })).toThrow(BrainError); }
  finally { f.db.close(); }
});

it("head alteration is not compensated by accepting the last available valid prefix", () => {
  const f = fixture();
  try {
    f.db.prepare("UPDATE control_billing_head SET mac=?").run(f.mac0);
    expect(() => readBillingJournal(f.db, binding, key)).toThrow(BrainError);
  } finally { f.db.close(); }
});

it("a tampered singleton value is denied even if a raw SQLite writer bypassed CHECK constraints", () => {
  const f = fixture();
  try {
    f.db.exec("PRAGMA ignore_check_constraints=ON");
    f.db.exec("UPDATE control_billing_head SET singleton=2");
    f.db.exec("PRAGMA ignore_check_constraints=OFF");
    expect(() => readBillingJournal(f.db, binding, key)).toThrow(BrainError);
  } finally { f.db.close(); }
});

it("log rows without a head do not become a new empty journal", () => {
  const f = fixture();
  try {
    f.db.exec("DELETE FROM control_billing_head");
    expect(() => readBillingJournal(f.db, binding, key)).toThrow(BrainError);
  } finally { f.db.close(); }
});

it("a head with no records is corruption, not a new journal", () => {
  const f = fixture();
  try {
    f.db.exec("PRAGMA foreign_keys=OFF");
    withLogTriggersRemoved(f.db, () => f.db.exec("DELETE FROM control_billing_log"));
    expect(() => readBillingJournal(f.db, binding, key)).toThrow(BrainError);
  } finally { f.db.close(); }
});

it("a deleted prefix is detected even when the final record and head still match", () => {
  const f = fixture();
  try {
    withLogTriggersRemoved(f.db, () => f.db.exec("DELETE FROM control_billing_log WHERE ordinal=0"));
    expect(() => readBillingJournal(f.db, binding, key)).toThrow(BrainError);
  } finally { f.db.close(); }
});

it("body substitution is detected even after immutable triggers are restored exactly", () => {
  const f = fixture();
  try {
    const substituted = { ...f.second, body: { ...f.second.body, allowance_micro_usd: 101 } };
    withLogTriggersRemoved(f.db, () => {
      f.db.prepare("UPDATE control_billing_log SET frame_json=? WHERE ordinal=1")
        .run(canonicalSealFrame(substituted));
    });
    expect(() => readBillingJournal(f.db, binding, key)).toThrow(BrainError);
  } finally { f.db.close(); }
});

it("noncanonical JSON cannot bypass exact signed-frame serialization", () => {
  const f = fixture();
  try {
    withLogTriggersRemoved(f.db, () => {
      f.db.prepare("UPDATE control_billing_log SET frame_json=? WHERE ordinal=1")
        .run(JSON.stringify(f.second, null, 2));
    });
    expect(() => readBillingJournal(f.db, binding, key)).toThrow(BrainError);
  } finally { f.db.close(); }
});

it("an oversized serialized frame is refused rather than parsed or truncated", () => {
  const f = fixture();
  try {
    withLogTriggersRemoved(f.db, () => {
      f.db.prepare("UPDATE control_billing_log SET frame_json=? WHERE ordinal=1")
        .run(" ".repeat(16 * 1024 + 1));
    });
    expect(() => readBillingJournal(f.db, binding, key)).toThrow(BrainError);
    expect(f.db.isTransaction).toBe(false);
  } finally { f.db.close(); }
});

it("SQL row coordinates cannot differ from the correctly signed frame's coordinates", () => {
  const f = fixture();
  try {
    const wrongOrdinal = admission(3, f.mac0);
    withLogTriggersRemoved(f.db, () => {
      f.db.prepare("UPDATE control_billing_log SET frame_json=?,mac=? WHERE ordinal=1")
        .run(canonicalSealFrame(wrongOrdinal), sealMac(wrongOrdinal, key));
    });
    f.db.prepare("UPDATE control_billing_head SET mac=?").run(sealMac(wrongOrdinal, key));
    expect(() => readBillingJournal(f.db, binding, key)).toThrow(BrainError);
  } finally { f.db.close(); }
});

it("a correctly MACed record with a broken chain link still fails", () => {
  const f = fixture();
  try {
    const broken = { ...f.second, prev_mac: "f".repeat(64) }, mac = sealMac(broken, key);
    withLogTriggersRemoved(f.db, () => {
      f.db.prepare("UPDATE control_billing_log SET frame_json=?,mac=? WHERE ordinal=1")
        .run(canonicalSealFrame(broken), mac);
    });
    f.db.prepare("UPDATE control_billing_head SET mac=?").run(mac);
    expect(() => readBillingJournal(f.db, binding, key)).toThrow(BrainError);
  } finally { f.db.close(); }
});

it("an unrelated epoch cannot hide outside the selected current-epoch query", () => {
  const f = fixture();
  try {
    const foreign = { ...admission(), epoch: 2 };
    f.db.prepare("INSERT INTO control_billing_log VALUES(?,?,?,?)")
      .run(2, 0, canonicalSealFrame(foreign), sealMac(foreign, key));
    expect(() => readBillingJournal(f.db, binding, key)).toThrow(BrainError);
  } finally { f.db.close(); }
});

it("schema mutation including an unexpected nonnamespace trigger on a known table denies", () => {
  const f = fixture();
  try {
    const baseline = billingJournalSchemaDigest(f.db);
    expect(baseline).toMatch(/^[a-f0-9]{64}$/);
    f.db.exec("CREATE TRIGGER surprise_mutator AFTER INSERT ON control_billing_log BEGIN SELECT 1; END");
    expect(() => billingJournalSchemaDigest(f.db)).toThrow(BrainError);
    expect(() => readBillingJournal(f.db, binding, key)).toThrow(BrainError);
  } finally { f.db.close(); }
});

it("a future namespace object is not silently excluded from the frozen shape", () => {
  const f = fixture();
  try {
    f.db.exec("CREATE TABLE control_billing_extra(authority INTEGER)");
    expect(() => billingJournalSchemaDigest(f.db)).toThrow(BrainError);
  } finally { f.db.close(); }
});

it("read-only verification preserves a caller-owned transaction on success and failure", () => {
  const f = fixture();
  try {
    f.db.exec("BEGIN IMMEDIATE");
    expect(readBillingJournal(f.db, binding, key)).toMatchObject({ entries: 2 });
    expect(f.db.isTransaction).toBe(true);
    expect(() => readBillingJournal(f.db, binding, new Uint8Array(32).fill(8))).toThrow(BrainError);
    expect(f.db.isTransaction).toBe(true);
    f.db.exec("ROLLBACK");
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM control_billing_log").get()).toMatchObject({ n: 2 });
  } finally { f.db.close(); }
});

it("failure to close an owned read snapshot cannot return verified success or leak its transaction", () => {
  const f = fixture();
  try {
    f.db.setAuthorizer((action, operation) => {
      if (action === constants.SQLITE_TRANSACTION && operation === "COMMIT") return constants.SQLITE_DENY;
      return constants.SQLITE_OK;
    });
    expect(() => readBillingJournal(f.db, binding, key)).toThrow(BrainError);
    expect(f.db.isTransaction).toBe(false);
  } finally { f.db.setAuthorizer(null); f.db.close(); }
});

it("malformed JSON refusal leaks neither body data nor SQLite exception text", () => {
  const f = fixture();
  try {
    withLogTriggersRemoved(f.db, () => {
      f.db.prepare("UPDATE control_billing_log SET frame_json=? WHERE ordinal=1").run("SYNTHETIC-PRIVATE-NOTE");
    });
    try {
      readBillingJournal(f.db, binding, key);
      throw new Error("Malformed body accepted");
    } catch (error) {
      expect(error).toBeInstanceOf(BrainError);
      expect((error as Error).message).not.toContain("SYNTHETIC-PRIVATE-NOTE");
    }
    expect(f.db.isTransaction).toBe(false);
  } finally { f.db.close(); }
});
