import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStore } from "../../packages/storage/control.ts";
import { ManagedSpendingStore } from "../../packages/storage/managed-spending.ts";
import { MANAGED_V4_MONEY_DDL } from "../helpers/managed-v4-fixture.ts";
import { createBillingAdmissionFixture } from "../helpers/billing-admission-fixture.ts";

const NOW = "2027-01-31T12:00:00.000Z";

describe("mandatory low-level billing enforcement", () => {
  it("a genuine v4 store keeps legacy behavior and never promotes", () => {
    const dir = mkdtempSync(join(tmpdir(), "guard-"));
    try {
      const clock = () => new Date(NOW);
      const control = new ControlStore(join(dir, "control.sqlite"), clock);
      control.db.exec("CREATE TABLE IF NOT EXISTS managed_money_schema(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);");
      control.db.exec(MANAGED_V4_MONEY_DDL);
      control.db.prepare("INSERT INTO managed_money_schema VALUES(4,?)").run(NOW);
      const store = new ManagedSpendingStore(control, clock);
      expect(store.billing.state()).toBe("legacy");
      expect(() =>
        store.billing.assertNewFundingWithinTx(control.db, {
          account_id: "11111111-1111-4111-8111-111111111111",
          period_id: "p",
          now: new Date(NOW),
          stage: "reasoning",
        }),
      ).not.toThrow();
      control.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an installed but unenrolled v5 root denies new funding even with positive caps", () => {
    const f = createBillingAdmissionFixture();
    try {
      expect(f.spending.billing.state()).toBe("unenrolled");
      expect(() =>
        f.spending.billing.assertNewFundingWithinTx(f.control.db, {
          account_id: f.account_id,
          period_id: "00000000-0000-4000-8000-000000000000",
          now: new Date(f.facts.verified_at),
          stage: "reasoning",
        }),
      ).toThrow(/refused/i);
    } finally {
      f.close();
    }
  });

  it("classifies an unadmitted account as unadmitted (no manual fallback)", () => {
    const f = createBillingAdmissionFixture();
    try {
      expect(f.spending.billing.classify(f.control.db, f.account_id)).toBe("unadmitted");
    } finally {
      f.close();
    }
  });
});
