import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { BrainError } from "../../packages/domain/logic.ts";
import {
  BILLING_AUTHORITY_DDL,
  BILLING_JOURNAL_DDL,
  billingAuthoritySchemaDigest,
  billingJournalSchemaDigest,
  billingSchemaVariant,
} from "../../packages/storage/billing-schema.ts";
import { readBillingJournal } from "../../packages/storage/billing-journal.ts";

/** T2W closed schema variants — SYNTHETIC. */

const BINDING = { epoch: 1, root_nonce: "a".repeat(64), policy_id: "SYNTHETIC-policy" };
const KEY = new Uint8Array(32).fill(7);

it("detects the journal variant and keeps journal strictness", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(BILLING_JOURNAL_DDL);
    expect(billingSchemaVariant(db)).toBe("journal");
    expect(billingJournalSchemaDigest(db)).toMatch(/^[a-f0-9]{64}$/);
    expect(() => billingAuthoritySchemaDigest(db)).toThrow(BrainError);
  } finally {
    db.close();
  }
});

it("detects the authority variant and refuses the journal-only digest", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys=ON");
    db.exec(BILLING_AUTHORITY_DDL);
    expect(billingSchemaVariant(db)).toBe("authority");
    expect(billingAuthoritySchemaDigest(db)).toMatch(/^[a-f0-9]{64}$/);
    expect(() => billingJournalSchemaDigest(db)).toThrow(BrainError);
  } finally {
    db.close();
  }
});

it("denies extra namespace objects and attached unexpected triggers in both variants", () => {
  const authority = new DatabaseSync(":memory:");
  try {
    authority.exec(BILLING_AUTHORITY_DDL);
    const baseline = billingAuthoritySchemaDigest(authority);
    authority.exec("CREATE TABLE control_billing_extra(authority INTEGER)");
    expect(() => billingAuthoritySchemaDigest(authority)).toThrow(BrainError);
    authority.exec("DROP TABLE control_billing_extra");
    expect(billingAuthoritySchemaDigest(authority)).toBe(baseline);
    authority.exec("CREATE TRIGGER surprise AFTER INSERT ON control_billing_log BEGIN SELECT 1; END");
    expect(() => billingAuthoritySchemaDigest(authority)).toThrow(BrainError);
  } finally {
    authority.close();
  }
});

it("returns unknown and refuses both digests for an unrelated database", () => {
  const db = new DatabaseSync(":memory:");
  try {
    expect(billingSchemaVariant(db)).toBe("unknown");
    expect(() => billingAuthoritySchemaDigest(db)).toThrow(BrainError);
    expect(() => billingJournalSchemaDigest(db)).toThrow(BrainError);
  } finally {
    db.close();
  }
});

it("reads an empty journal under the journal variant but refuses the authority variant by default", () => {
  const authority = new DatabaseSync(":memory:");
  try {
    authority.exec("PRAGMA foreign_keys=ON");
    authority.exec(BILLING_AUTHORITY_DDL);
    expect(() => readBillingJournal(authority, BINDING, KEY, { max_entries: 100 })).toThrow(BrainError);
    expect(readBillingJournal(authority, BINDING, KEY, { max_entries: 100, variant: "authority" })).toEqual({
      state: "empty",
    });
  } finally {
    authority.close();
  }
});
