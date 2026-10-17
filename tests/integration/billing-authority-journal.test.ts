import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrainError } from "../../packages/domain/logic.ts";
import { canonicalSealFrame, sealMac } from "../../packages/domain/billing-seal.ts";
import {
  BILLING_JOURNAL_DDL,
  BILLING_JOURNAL_MAX_ENTRIES,
  billingJournalSchemaDigest,
  readBillingJournal,
} from "../../packages/storage/billing-journal.ts";
import { createMoneyV4Control, moneyBytesDigest } from "../helpers/managed-v4-fixture.ts";

/**
 * T2L signed-journal read-only verifier — SYNTHETIC fixtures only. The module does not
 * exist yet, so the first run is RED. Rows are seeded with the T1 `sealMac` helper in
 * test utilities; there is no production grant writer or payment evidence.
 */

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const KEY = new Uint8Array(32).fill(7);
const BINDING = { epoch: 1, root_nonce: "a".repeat(64), policy_id: "SYNTHETIC-policy" };

const WINDOWS_BASE = "C:/Users/Gowrishankar/AppData/Local/Temp/opencode";
const cleanupDirs: string[] = [];

function fixtureBase(): string {
  if (process.platform !== "win32") return tmpdir();
  if (!existsSync(WINDOWS_BASE)) throw new Error("The approved Windows fixture base is missing.");
  return WINDOWS_BASE;
}

afterEach(() => {
  for (const dir of cleanupDirs.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
});

function admission(ordinal = 0, prevMac = "") {
  return {
    schema: 1,
    purpose: "admission",
    ...BINDING,
    ordinal,
    prev_mac: prevMac,
    source_ids: ["SYNTHETIC-clean-baseline"],
    body: {
      account_id: ACCOUNT,
      identity_digest: "b".repeat(64),
      tenant_incarnation: "c".repeat(64),
      clean_baseline_proof: "d".repeat(64),
    },
  };
}

function grant(ordinal: number, prevMac: string) {
  return {
    schema: 1,
    purpose: "grant",
    ...BINDING,
    ordinal,
    prev_mac: prevMac,
    source_ids: ["SYNTHETIC-receipt"],
    body: {
      account_id: ACCOUNT,
      window_id: "e".repeat(64),
      term_id: "SYNTHETIC-term",
      period_id: "22222222-2222-4222-8222-222222222222",
      window_start: "2027-01-31T00:00:00.000Z",
      window_end: "2027-02-28T00:00:00.000Z",
      allowance_micro_usd: 100,
    },
  };
}

function journalFixture() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(BILLING_JOURNAL_DDL);
  const first = admission();
  const mac0 = sealMac(first, KEY);
  const second = grant(1, mac0);
  const mac1 = sealMac(second, KEY);
  const insert = db.prepare("INSERT INTO control_billing_log(epoch,ordinal,frame_json,mac) VALUES(?,?,?,?)");
  insert.run(1, 0, canonicalSealFrame(first), mac0);
  insert.run(1, 1, canonicalSealFrame(second), mac1);
  db.prepare("INSERT INTO control_billing_head(singleton,epoch,ordinal,mac) VALUES(1,1,1,?)").run(mac1);
  return { db, mac1 };
}

describe("readBillingJournal", () => {
  it("verifies a full signed chain against the frozen root and exact final head", () => {
    const f = journalFixture();
    try {
      expect(readBillingJournal(f.db, BINDING, KEY)).toEqual({
        state: "verified",
        epoch: 1,
        ordinal: 1,
        mac: f.mac1,
        entries: 2,
      });
      expect(f.db.isTransaction).toBe(false);
    } finally {
      f.db.close();
    }
  });

  it("treats an empty valid schema as empty, never a spending permit", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(BILLING_JOURNAL_DDL);
      expect(readBillingJournal(db, BINDING, KEY)).toEqual({ state: "empty" });
    } finally {
      db.close();
    }
  });

  it("refuses a wrong key, a rebinding, and a foreign epoch", () => {
    const wrongKey = journalFixture();
    try {
      expect(() => readBillingJournal(wrongKey.db, BINDING, new Uint8Array(32).fill(8))).toThrow(BrainError);
    } finally {
      wrongKey.db.close();
    }

    const rebound = journalFixture();
    try {
      expect(() => readBillingJournal(rebound.db, { ...BINDING, policy_id: "SYNTHETIC-other" }, KEY)).toThrow(BrainError);
    } finally {
      rebound.db.close();
    }

    const foreign = journalFixture();
    try {
      const other = { ...admission(), epoch: 2 };
      foreign.db
        .prepare("INSERT INTO control_billing_log VALUES(?,?,?,?)")
        .run(2, 0, canonicalSealFrame(other), sealMac(other, KEY));
      expect(() => readBillingJournal(foreign.db, BINDING, KEY)).toThrow(BrainError);
    } finally {
      foreign.db.close();
    }
  });

  it("never returns a partial verified result when the bound is exhausted", () => {
    const f = journalFixture();
    try {
      expect(() => readBillingJournal(f.db, BINDING, KEY, { max_entries: 1 })).toThrow(BrainError);
      expect(f.db.isTransaction).toBe(false);
      expect(readBillingJournal(f.db, BINDING, KEY, { max_entries: 2 })).toMatchObject({ entries: 2 });
    } finally {
      f.db.close();
    }
  });

  it.each([0, -1, 1.5, Number.NaN, BILLING_JOURNAL_MAX_ENTRIES + 1])(
    "rejects an invalid or widened scan bound %s",
    (max_entries) => {
      const f = journalFixture();
      try {
        expect(() => readBillingJournal(f.db, BINDING, KEY, { max_entries })).toThrow(BrainError);
      } finally {
        f.db.close();
      }
    },
  );

  it("leaves a caller-owned transaction untouched on success and failure", () => {
    const f = journalFixture();
    try {
      f.db.exec("BEGIN IMMEDIATE");
      expect(readBillingJournal(f.db, BINDING, KEY)).toMatchObject({ entries: 2 });
      expect(f.db.isTransaction).toBe(true);
      expect(() => readBillingJournal(f.db, BINDING, KEY, { max_entries: 1 })).toThrow(BrainError);
      expect(f.db.isTransaction).toBe(true);
      f.db.exec("ROLLBACK");
    } finally {
      f.db.close();
    }
  });
});

describe("billingJournalSchemaDigest", () => {
  it("matches the closed shape and rejects an unexpected namespace object", () => {
    const f = journalFixture();
    try {
      expect(billingJournalSchemaDigest(f.db)).toMatch(/^[a-f0-9]{64}$/);
      f.db.exec("CREATE TABLE control_billing_extra(authority INTEGER)");
      expect(() => billingJournalSchemaDigest(f.db)).toThrow(BrainError);
    } finally {
      f.db.close();
    }
  });

  it("rejects an unexpected trigger attached to a known journal table", () => {
    const f = journalFixture();
    try {
      f.db.exec("CREATE TRIGGER surprise_mutator AFTER INSERT ON control_billing_log BEGIN SELECT 1; END");
      expect(() => billingJournalSchemaDigest(f.db)).toThrow(BrainError);
    } finally {
      f.db.close();
    }
  });
});

describe("frozen money-4 fixture", () => {
  it("keeps every retained money-4 row byte-identical after installing only the journal DDL", () => {
    const dir = mkdtempSync(join(fixtureBase(), "billing-journal-"));
    cleanupDirs.push(dir);
    const db = createMoneyV4Control(join(dir, "control.sqlite"));
    try {
      db.prepare("INSERT INTO managed_accounts(id,issuer,subject,state,created_at) VALUES(?,?,?,?,?)")
        .run(ACCOUNT, "SYNTHETIC-issuer", "SYNTHETIC-subject", "active", "2026-10-17T00:00:00.000Z");
      db.prepare(
        "INSERT INTO managed_account_periods(period_id,account_id,starts_at,ends_at,allowance_micro_usd,state,granted_at,revoked_at) VALUES(?,?,?,?,?,?,?,NULL)",
      ).run("33333333-3333-4333-8333-333333333333", ACCOUNT, "2027-01-01T00:00:00.000Z", "2027-02-01T00:00:00.000Z", 500, "active", "2026-10-17T00:00:00.000Z");
      db.prepare("INSERT INTO managed_money_blocks(key,reason,at) VALUES(?,?,?)").run(
        "reconciliation_required",
        "reconciliation_required",
        "2026-10-17T00:00:00.000Z",
      );
      const before = moneyBytesDigest(db);
      db.exec(BILLING_JOURNAL_DDL);
      expect(moneyBytesDigest(db)).toBe(before);
      expect(
        db.prepare("SELECT COUNT(*) AS n FROM managed_money_schema WHERE version<=4").get(),
      ).toMatchObject({ n: 2 });
    } finally {
      db.close();
    }
  });
});
