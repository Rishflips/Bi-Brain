import { expect, it } from "vitest";
import { createBillingAdmissionFixture } from "../helpers/billing-admission-fixture.ts";

// A retained digest must resolve to the complete, authenticated baseline evidence.
function baselines(value: unknown): Record<string, unknown>[] {
  if (!value || typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  const own = "provider_dispatches" in object && "legacy_reservations" in object ? [object] : [];
  return own.concat(Object.values(object).flatMap(baselines));
}

it("a prepared admission retains its actual clean-baseline evidence rather than only an unresolved hash", async () => {
  const input = { cadence: "monthly" as const, enrolled: true };
  const f = createBillingAdmissionFixture(input);
  try {
    const prepared = await f.prepare();
    expect(prepared.state).toBe("prepared");
    if (prepared.state !== "prepared") throw new Error("Synthetic admission did not prepare.");
    const row = f.control.db.prepare("SELECT * FROM control_billing_preflight WHERE preflight_id=?")
      .get(prepared.preflight_id) as Record<string, unknown>;
    const retained = Object.values(row).flatMap((value) => {
      if (typeof value !== "string") return [];
      try { return baselines(JSON.parse(value)); } catch { return []; }
    });
    expect(retained.length).toBeGreaterThan(0);
    expect(retained[0]).toMatchObject({ schema: 1, account_id: f.account_id,
      incarnation: f.binding.tenant_incarnation, provisioning_generation: f.binding.provisioning_generation,
      tenant_schema_version: 6, provider_dispatches: 0, legacy_reservations: 0, paid_processing_blocked: false });
    expect(f.admit(prepared.preflight_id).state).toBe("admitted");
  } finally { f.close(); }
});

it("a preflight expires at its original fifteen-minute boundary without appending admission", async () => {
  const input = { cadence: "monthly" as const, enrolled: true };
  const f = createBillingAdmissionFixture(input);
  try {
    const prepared = await f.prepare();
    if (prepared.state !== "prepared") throw new Error("Synthetic admission did not prepare.");
    f.setNow("2027-01-31T12:15:00.000Z");
    expect(f.admit(prepared.preflight_id)).toMatchObject({ state: "denied" });
    expect(f.control.db.prepare("SELECT COUNT(*) AS n FROM control_billing_account").get()).toMatchObject({ n: 0 });
    expect(f.control.db.prepare("SELECT COUNT(*) AS n FROM control_billing_log").get()).toMatchObject({ n: 0 });
  } finally { f.close(); }
});
