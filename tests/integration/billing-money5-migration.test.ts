import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStore } from "../../packages/storage/control.ts";
import { ManagedSpendingStore } from "../../packages/storage/managed-spending.ts";
import { installBillingMoney5 } from "../../packages/storage/billing-install.ts";
import { billingSchemaVariant } from "../../packages/storage/billing-schema.ts";
import { MANAGED_V4_MONEY_DDL, moneyBytesDigest } from "../helpers/managed-v4-fixture.ts";

const NOW = "2027-01-31T12:00:00.000Z";

function v4Control(dir: string) {
  const clock = () => new Date(NOW);
  const control = new ControlStore(join(dir, "control.sqlite"), clock);
  control.db.exec("CREATE TABLE IF NOT EXISTS managed_money_schema(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);");
  control.db.exec(MANAGED_V4_MONEY_DDL);
  control.db.prepare("INSERT INTO managed_money_schema VALUES(4,?)").run(NOW);
  return { control, clock };
}

describe("explicit money-5 install", () => {
  it("leaves a genuine v4 database at v4 in the normal constructor", () => {
    const dir = mkdtempSync(join(tmpdir(), "money5-"));
    try {
      const { control, clock } = v4Control(dir);
      new ManagedSpendingStore(control, clock);
      expect(control.db.prepare("SELECT max(version) AS v FROM managed_money_schema").get()).toMatchObject({ v: 4 });
      expect(billingSchemaVariant(control.db)).toBe("unknown");
      control.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("installs v5 atomically, preserving every money-4 row and digest, and is idempotent", () => {
    const dir = mkdtempSync(join(tmpdir(), "money5-"));
    try {
      const { control, clock } = v4Control(dir);
      const account = "11111111-1111-4111-8111-111111111111";
      control.db.prepare("INSERT INTO managed_accounts(id,issuer,subject,state,created_at) VALUES(?,?,?,'active',?)").run(account, "https://synthetic.invalid", "SYNTHETIC-owner", NOW);
      control.db.prepare("INSERT INTO managed_account_periods VALUES(?,?,?,?,?,?,?,NULL)").run("SYNTHETIC-v4-period", account, "2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z", 1000, "active", NOW);
      control.db.prepare("INSERT INTO managed_money_blocks VALUES(?,?,?)").run("SYNTHETIC-pause", "unresolved_usage", NOW);
      const before = moneyBytesDigest(control.db);

      const result = installBillingMoney5({ control, root: dir, offline: true, workers_terminated: true });
      expect(result).toMatchObject({ version: 5, nonfunding: true });
      expect(control.db.prepare("SELECT max(version) AS v FROM managed_money_schema").get()).toMatchObject({ v: 5 });
      expect(billingSchemaVariant(control.db)).toBe("integrated");
      expect(moneyBytesDigest(control.db)).toBe(before);
      expect(control.db.prepare("SELECT state FROM managed_account_periods WHERE period_id='SYNTHETIC-v4-period'").get()).toMatchObject({ state: "active" });
      expect(control.db.prepare("SELECT reason FROM managed_money_blocks WHERE key='SYNTHETIC-pause'").get()).toMatchObject({ reason: "unresolved_usage" });

      // Idempotent: a repeat install returns the same recorded install.
      const again = installBillingMoney5({ control, root: dir, offline: true, workers_terminated: true });
      expect(again.version).toBe(5);
      expect(again.installed_at).toBe(result.installed_at);

      // The normal constructor now verifies the strict integrated variant.
      new ManagedSpendingStore(control, clock);
      control.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("requires both offline acknowledgements as attestations", () => {
    const dir = mkdtempSync(join(tmpdir(), "money5-"));
    try {
      const { control } = v4Control(dir);
      expect(() =>
        installBillingMoney5({ control, root: dir, offline: false, workers_terminated: true }),
      ).toThrow();
      expect(() =>
        installBillingMoney5({ control, root: dir, offline: true, workers_terminated: false }),
      ).toThrow();
      expect(control.db.prepare("SELECT max(version) AS v FROM managed_money_schema").get()).toMatchObject({ v: 4 });
      control.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a v5 reopen with a dropped authority table and never heals it", () => {
    const dir = mkdtempSync(join(tmpdir(), "money5-"));
    try {
      const { control, clock } = v4Control(dir);
      installBillingMoney5({ control, root: dir, offline: true, workers_terminated: true });
      control.db.exec("DROP TABLE control_billing_terms");
      expect(() => new ManagedSpendingStore(control, clock)).toThrow();
      control.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a future version before any DDL", () => {
    const dir = mkdtempSync(join(tmpdir(), "money5-"));
    try {
      const { control, clock } = v4Control(dir);
      control.db.prepare("INSERT INTO managed_money_schema VALUES(6,?)").run(NOW);
      expect(() => new ManagedSpendingStore(control, clock)).toThrow(/newer version/i);
      expect(billingSchemaVariant(control.db)).toBe("unknown");
      control.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
