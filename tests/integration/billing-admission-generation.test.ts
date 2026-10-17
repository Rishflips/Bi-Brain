import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createBillingAdmissionFixture } from "../helpers/billing-admission-fixture.ts";
import { fenceAccount } from "../../packages/storage/managed-incarnation.ts";

describe("provisioning incarnation and fence", () => {
  it("mints generation 1 with a schema-2 marker that matches central", () => {
    const f = createBillingAdmissionFixture();
    try {
      const inc = f.control.db
        .prepare("SELECT incarnation,provisioning_generation FROM managed_account_incarnation WHERE account_id=?")
        .get(f.account_id) as { incarnation: string; provisioning_generation: number };
      expect(inc.provisioning_generation).toBe(1);
      expect(inc.incarnation).toMatch(/^[0-9a-f]{64}$/);
      const marker = JSON.parse(readFileSync(join(f.root, f.account_id, "provisioned.json"), "utf8"));
      expect(marker).toMatchObject({
        schema: 2,
        account_id: f.account_id,
        incarnation: inc.incarnation,
        provisioning_generation: 1,
      });
    } finally {
      f.close();
    }
  });

  it("never resets a generation on a repeated provision", () => {
    const f = createBillingAdmissionFixture();
    try {
      const first = f.runtime.provision("https://synthetic.invalid", "SYNTHETIC-repeat");
      const again = f.runtime.provision("https://synthetic.invalid", "SYNTHETIC-repeat");
      expect(again.id).toBe(first.id);
      const rows = f.control.db
        .prepare("SELECT COUNT(*) AS n FROM managed_account_incarnation WHERE account_id=?")
        .get(first.id) as { n: number };
      expect(rows.n).toBe(1);
    } finally {
      f.close();
    }
  });

  it("refuses acquisition when the marker generation disagrees with central", () => {
    const f = createBillingAdmissionFixture();
    try {
      f.control.db
        .prepare("UPDATE managed_account_incarnation SET provisioning_generation=2 WHERE account_id=?")
        .run(f.account_id);
      expect(() => f.runtime.acquire(f.account_id)).toThrow();
    } finally {
      f.close();
    }
  });

  it("refuses acquisition while an active fence is present", () => {
    const f = createBillingAdmissionFixture();
    try {
      fenceAccount(f.control.db, f.account_id, "rebuild", f.facts.verified_at);
      expect(() => f.runtime.acquire(f.account_id)).toThrow();
    } finally {
      f.close();
    }
  });

  it("aborts a raw SQL generation decrease", () => {
    const f = createBillingAdmissionFixture();
    try {
      expect(() =>
        f.control.db
          .prepare("UPDATE managed_account_incarnation SET provisioning_generation=0 WHERE account_id=?")
          .run(f.account_id),
      ).toThrow();
    } finally {
      f.close();
    }
  });
});
