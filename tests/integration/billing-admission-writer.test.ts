import { describe, expect, it } from "vitest";
import { createBillingAdmissionFixture } from "../helpers/billing-admission-fixture.ts";
import { rotateAccountIncarnation } from "../../packages/storage/managed-incarnation.ts";

describe("owned admission writer", () => {
  it("prepare -> admit writes exactly one admission frame, the account row and one head", async () => {
    const f = createBillingAdmissionFixture();
    try {
      const prepared = await f.prepare();
      expect(prepared.state).toBe("prepared");
      const id = (prepared as { state: "prepared"; preflight_id: string }).preflight_id;

      expect(f.admit(id)).toEqual({ state: "admitted" });

      const account = f.control.db
        .prepare("SELECT admission_ordinal,adverse_generation FROM control_billing_account WHERE account_id=?")
        .get(f.account_id) as { admission_ordinal: number; adverse_generation: number };
      expect(account).toMatchObject({ admission_ordinal: 0, adverse_generation: 0 });

      const head = f.control.db
        .prepare("SELECT epoch,ordinal FROM control_billing_head WHERE singleton=1")
        .get() as { epoch: number; ordinal: number };
      expect(head.ordinal).toBe(0);

      const log = f.control.db
        .prepare("SELECT COUNT(*) AS n FROM control_billing_log")
        .get() as { n: number };
      expect(log.n).toBe(1);

      const preflight = f.control.db
        .prepare("SELECT consumed_at,admission_ordinal FROM control_billing_preflight WHERE preflight_id=?")
        .get(id) as { consumed_at: string | null; admission_ordinal: number | null };
      expect(preflight.consumed_at).not.toBeNull();
      expect(preflight.admission_ordinal).toBe(0);

      // Replay of the same preflight returns the original outcome, never a second append.
      expect(f.admit(id)).toEqual({ state: "admitted" });
      expect((f.control.db.prepare("SELECT COUNT(*) AS n FROM control_billing_log").get() as { n: number }).n).toBe(1);
    } finally {
      f.close();
    }
  });

  it("denies with no correlation source and writes nothing", async () => {
    const f = createBillingAdmissionFixture({ correlation: null });
    try {
      expect(await f.prepare()).toEqual({ state: "denied", reason: "no_source" });
      expect(f.control.db.prepare("SELECT COUNT(*) AS n FROM control_billing_preflight").get()).toMatchObject({ n: 0 });
      expect(f.control.db.prepare("SELECT COUNT(*) AS n FROM control_billing_log").get()).toMatchObject({ n: 0 });
    } finally {
      f.close();
    }
  });

  it("rejects admission when the generation changes between prepare and admit", async () => {
    const f = createBillingAdmissionFixture();
    try {
      const prepared = await f.prepare();
      const id = (prepared as { state: "prepared"; preflight_id: string }).preflight_id;
      rotateAccountIncarnation(f.control.db, f.account_id, {
        source: "restore",
        now: f.facts.verified_at,
        nonce: "a".repeat(64),
      });
      expect(f.admit(id)).toEqual({ state: "denied", reason: "generation_mismatch" });
      expect(f.control.db.prepare("SELECT COUNT(*) AS n FROM control_billing_account").get()).toMatchObject({ n: 0 });
    } finally {
      f.close();
    }
  });

  it("refuses a tampered preflight row at the strict schema check (fail closed)", async () => {
    const f = createBillingAdmissionFixture();
    try {
      const prepared = await f.prepare();
      const id = (prepared as { state: "prepared"; preflight_id: string }).preflight_id;
      // Triggers are integrity, not provenance: removing one changes the closed
      // schema catalog, so the writer refuses before it can trust any row.
      f.control.db.exec("DROP TRIGGER control_billing_preflight_frozen");
      f.control.db
        .prepare("UPDATE control_billing_preflight SET proof_mac=? WHERE preflight_id=?")
        .run("f".repeat(64), id);
      expect(() => f.admit(id)).toThrow();
    } finally {
      f.close();
    }
  });

  it("rejects an unknown preflight id", () => {
    const f = createBillingAdmissionFixture();
    try {
      expect(f.admit("00000000-0000-4000-8000-000000000000")).toEqual({
        state: "denied",
        reason: "conflict",
      });
    } finally {
      f.close();
    }
  });
});
