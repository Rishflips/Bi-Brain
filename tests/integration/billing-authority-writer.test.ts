import { constants } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { BrainError } from "../../packages/domain/logic.ts";
import { createBillingAuthorityFixture } from "../helpers/billing-authority-fixture.ts";

/** T2W writer behavior and adversarial fencing — SYNTHETIC. */

function count(fixture: ReturnType<typeof createBillingAuthorityFixture>, sql: string) {
  return fixture.control.db.prepare(sql).get();
}

describe("reconcile", () => {
  it("grants an immutable period projection for a validated monthly payment", async () => {
    const fixture = createBillingAuthorityFixture();
    try {
      const decision = await fixture.authority.reconcile(fixture.account_id);
      expect(decision).toMatchObject({ state: "granted", window_start: "2027-01-31T00:00:00.000Z", window_end: "2027-02-28T00:00:00.000Z" });
      const period = fixture.control.db
        .prepare("SELECT starts_at,ends_at,allowance_micro_usd,state FROM managed_account_periods WHERE account_id=?")
        .get(fixture.account_id);
      expect(period).toMatchObject({
        starts_at: "2027-01-31T00:00:00.000Z",
        ends_at: "2027-02-28T00:00:00.000Z",
        allowance_micro_usd: 1000,
        state: "active",
      });
      expect(count(fixture, "SELECT COUNT(*) AS n FROM control_billing_terms")).toEqual({ n: 1 });
      expect(count(fixture, "SELECT COUNT(*) AS n FROM control_billing_period")).toEqual({ n: 1 });
      expect(count(fixture, "SELECT COUNT(*) AS n FROM control_billing_log")).toEqual({ n: 2 });
      expect(fixture.authority.billingEligibility(fixture.account_id)).toMatchObject({
        state: "granted",
        window_start: "2027-01-31T00:00:00.000Z",
        window_end: "2027-02-28T00:00:00.000Z",
      });
    } finally {
      fixture.close();
    }
  });

  it("replays the same payment without resetting money or minting a second period", async () => {
    const fixture = createBillingAuthorityFixture();
    try {
      const first = await fixture.authority.reconcile(fixture.account_id);
      const second = await fixture.authority.reconcile(fixture.account_id);
      expect(second).toEqual(first);
      expect(count(fixture, "SELECT COUNT(*) AS n FROM managed_account_periods")).toEqual({ n: 1 });
      expect(count(fixture, "SELECT COUNT(*) AS n FROM control_billing_period")).toEqual({ n: 1 });
      expect(count(fixture, "SELECT COUNT(*) AS n FROM control_billing_terms")).toEqual({ n: 1 });
    } finally {
      fixture.close();
    }
  });

  it("grants the next monthly window from a new paid period without banking the gap", async () => {
    const fixture = createBillingAuthorityFixture();
    try {
      await fixture.authority.reconcile(fixture.account_id);
      fixture.setNow("2027-03-05T00:00:00.000Z");
      fixture.setFacts({
        ...fixture.facts,
        transaction_ref: "SYNTHETIC-transaction-2",
        paid_period_start: "2027-02-28T00:00:00.000Z",
        paid_period_end: "2027-03-31T00:00:00.000Z",
        verified_at: "2027-03-05T00:00:00.000Z",
      });
      const decision = await fixture.authority.reconcile(fixture.account_id);
      expect(decision).toMatchObject({ state: "granted", window_start: "2027-02-28T00:00:00.000Z", window_end: "2027-03-31T00:00:00.000Z" });
      expect(count(fixture, "SELECT COUNT(*) AS n FROM managed_account_periods")).toEqual({ n: 2 });
      expect(count(fixture, "SELECT COUNT(*) AS n FROM control_billing_terms")).toEqual({ n: 2 });
    } finally {
      fixture.close();
    }
  });

  it.each([
    ["stale", { verified_at: "2027-01-31T11:00:00.000Z" }],
    ["future", { verified_at: "2027-01-31T13:00:00.000Z" }],
    ["incomplete", { completed_payment: false }],
    ["wrong-customer", { customer_ref: "SYNTHETIC-other-customer" }],
    ["inverted-period", { paid_period_end: "2027-01-31T00:00:00.000Z" }],
  ])("denies an invalid or unowned payment (%s) without any write", async (_label, change) => {
    const fixture = createBillingAuthorityFixture();
    try {
      fixture.setFacts({ ...fixture.facts, ...change });
      const decision = await fixture.authority.reconcile(fixture.account_id);
      expect(decision.state).toBe("denied");
      expect(count(fixture, "SELECT COUNT(*) AS n FROM managed_account_periods")).toEqual({ n: 0 });
      expect(count(fixture, "SELECT COUNT(*) AS n FROM control_billing_terms")).toEqual({ n: 0 });
      expect(count(fixture, "SELECT COUNT(*) AS n FROM control_billing_log")).toEqual({ n: 1 });
    } finally {
      fixture.close();
    }
  });

  it("persists a signed revocation for a non-active subscription and grants nothing", async () => {
    const fixture = createBillingAuthorityFixture();
    try {
      fixture.setFacts({ ...fixture.facts, current_state: "past_due" });
      const decision = await fixture.authority.reconcile(fixture.account_id);
      expect(decision).toEqual({ state: "denied", reason: "past_due" });
      expect(count(fixture, "SELECT COUNT(*) AS n FROM managed_account_periods")).toEqual({ n: 0 });
      const rows = fixture.control.db.prepare("SELECT ordinal,frame_json FROM control_billing_log ORDER BY ordinal").all();
      expect(rows.length).toBe(2);
      expect(String((rows[1] as { frame_json: string }).frame_json)).toContain('"purpose":"revocation"');
      expect(fixture.authority.billingEligibility(fixture.account_id)).toMatchObject({ state: "unavailable" });
    } finally {
      fixture.close();
    }
  });

  it("denies and writes nothing when the source fails", async () => {
    const fixture = createBillingAuthorityFixture();
    try {
      fixture.setSourceError(new Error("SYNTHETIC-PRIVATE-FAILURE"));
      await expect(fixture.authority.reconcile(fixture.account_id)).rejects.toBeInstanceOf(BrainError);
      expect(count(fixture, "SELECT COUNT(*) AS n FROM control_billing_log")).toEqual({ n: 1 });
      expect(count(fixture, "SELECT COUNT(*) AS n FROM managed_account_periods")).toEqual({ n: 0 });
    } finally {
      fixture.close();
    }
  });

  it("preserves unknown holds and existing money bytes", async () => {
    const fixture = createBillingAuthorityFixture();
    try {
      fixture.control.db
        .prepare("INSERT INTO managed_money_blocks(key,reason,at) VALUES(?,?,?)")
        .run("SYNTHETIC-pause", "unresolved_usage", "2027-01-31T00:00:00.000Z");
      await fixture.authority.reconcile(fixture.account_id);
      expect(
        fixture.control.db.prepare("SELECT reason FROM managed_money_blocks WHERE key='SYNTHETIC-pause'").get(),
      ).toEqual({ reason: "unresolved_usage" });
    } finally {
      fixture.close();
    }
  });
});

describe("adversarial fencing", () => {
  it("rolls back every new row when the commit is denied", async () => {
    const fixture = createBillingAuthorityFixture();
    try {
      fixture.control.db.setAuthorizer((action: number, operation: string | null) =>
        action === constants.SQLITE_TRANSACTION && operation === "COMMIT"
          ? constants.SQLITE_DENY
          : constants.SQLITE_OK,
      );
      await expect(fixture.authority.reconcile(fixture.account_id)).rejects.toBeInstanceOf(BrainError);
      fixture.control.db.setAuthorizer(null);
      expect(count(fixture, "SELECT COUNT(*) AS n FROM managed_account_periods")).toEqual({ n: 0 });
      expect(count(fixture, "SELECT COUNT(*) AS n FROM control_billing_terms")).toEqual({ n: 0 });
      expect(count(fixture, "SELECT COUNT(*) AS n FROM control_billing_log")).toEqual({ n: 1 });
      expect(fixture.control.db.isTransaction).toBe(false);
    } finally {
      fixture.close();
    }
  });

  it("denies an account with no signed admission row", async () => {
    const fixture = createBillingAuthorityFixture();
    try {
      const other = fixture.control.provision("https://synthetic.invalid", "SYNTHETIC-other-owner");
      await expect(fixture.authority.reconcile(other.id)).rejects.toBeInstanceOf(BrainError);
      expect(count(fixture, "SELECT COUNT(*) AS n FROM managed_account_periods")).toEqual({ n: 0 });
    } finally {
      fixture.close();
    }
  });
});
