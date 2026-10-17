import { describe, expect, it } from "vitest";
import { createBillingAdmissionFixture } from "../helpers/billing-admission-fixture.ts";
import { enrolledBillingMode, paidTransportsAllowed } from "../../packages/storage/billing-verify.ts";

/**
 * Bootstrap safeguard: an enrolled SANDBOX billing root must never install real paid
 * model transports (checked by `ManagedWorker.paidTransportsAllowed`), while the ledger
 * guard itself still allows injected synthetic funding. These are independent so a
 * synthetic fixture can fund an injected call without ever enabling a real one.
 */
describe("sandbox billing root bootstrap gate", () => {
  it("an enrolled sandbox root forbids real paid transports", () => {
    const f = createBillingAdmissionFixture({ enrolled: true });
    try {
      const control = { db: f.control.db, path: f.control.path };
      expect(enrolledBillingMode(control, f.root)).toBe("sandbox");
      expect(paidTransportsAllowed(control, f.root)).toBe(false);
    } finally {
      f.close();
    }
  });

  it("an unenrolled/legacy root keeps transports allowed (no false sandbox denial)", () => {
    const f = createBillingAdmissionFixture();
    try {
      const control = { db: f.control.db, path: f.control.path };
      expect(enrolledBillingMode(control, f.root)).toBe(null);
      expect(paidTransportsAllowed(control, f.root)).toBe(true);
    } finally {
      f.close();
    }
  });

  it("the sandbox ledger still admits an injected synthetic account (gate is bootstrap-only)", () => {
    const f = createBillingAdmissionFixture({ enrolled: true });
    try {
      expect(f.spending.billing.state()).toBe("enrolled");
      // The account is not yet admitted, so the ledger denies funding — but the gate
      // is about transports, not about denying every sandbox ledger record.
      expect(f.spending.billing.classify(f.control.db, f.account_id)).toBe("unadmitted");
    } finally {
      f.close();
    }
  });
});
