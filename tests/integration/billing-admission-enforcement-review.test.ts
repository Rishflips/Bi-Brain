import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { BrainError } from "../../packages/domain/logic.ts";
import { createBillingAdmissionFixture } from "../helpers/billing-admission-fixture.ts";

// Raw SQL is not enrollment. No provider, external key or owner data is used.
it("forged enrollment and manual-membership rows cannot bypass the absent protected enrollment anchor", () => {
  const f = createBillingAdmissionFixture();
  try {
    expect(existsSync(join(f.root, ".protected", "billing-enrollment.json"))).toBe(false);
    const at = f.facts.verified_at;
    f.spending.configureAccountPeriod({ account_id: f.account_id,
      starts_at: "2027-01-31T00:00:00.000Z", ends_at: "2027-02-28T00:00:00.000Z", allowance_micro_usd: 1000 });
    f.control.db.prepare("INSERT INTO control_billing_enrollment VALUES(1,1,1,?,?,?,?,?,?,?,?,?)")
      .run(f.policy.epoch, f.policy.root_nonce, "a".repeat(64), "b".repeat(64), f.policy.mode,
        "c".repeat(64), "d".repeat(64), "e".repeat(64), at);
    f.control.db.prepare("INSERT INTO control_billing_manual_baseline VALUES(?,?,?,?)")
      .run(f.account_id, "a".repeat(64), "b".repeat(64), at);
    expect(() => f.spending.reserve({ account_id: f.account_id, job_id: randomUUID(), dispatch_key: "reasoning",
      stage: "reasoning", reserved_micro_usd: 1, provider: "synthetic", model: "SYNTHETIC-model",
      price_version: "SYNTHETIC-price", request_hash: "a".repeat(64), config_hash: "b".repeat(64),
      limits: { per_job_micro_usd: 100, user_daily_micro_usd: 500, time_zone: "UTC" } })).toThrow(BrainError);
    expect(f.control.db.prepare("SELECT COUNT(*) AS n FROM managed_reservations").get()).toMatchObject({ n: 0 });
  } finally { f.close(); }
});
