import { expect, it } from "vitest";
import { BillingAuthority } from "../../packages/storage/billing-authority.ts";
import { auditManagedHistory, validateManagedAudit } from "../../packages/runtime/managed-audit.ts";
import { createBillingAdmissionFixture } from "../helpers/billing-admission-fixture.ts";

// Real audit APIs, synthetic protected enrollment and facts. No model or payment.
function fixture(cadence: "monthly" | "annual" = "monthly") {
  const options = { cadence, enrolled: true };
  const f = createBillingAdmissionFixture(options);
  const audit = () => auditManagedHistory({ runtime: f.runtime, root: f.root,
    offline: true, workers_terminated: true, clock: f.control.clock });
  const validate = (auditId: string) => validateManagedAudit({ control: f.control,
    root: f.root, auditId, clock: f.control.clock });
  return { f, audit, validate };
}

it("a legitimately authorized annual monthly renewal does not invalidate its existing v5 audit", async () => {
  const { f, audit, validate } = fixture("annual");
  try {
    const prepared = await f.prepare();
    if (prepared.state !== "prepared") throw new Error("Synthetic admission did not prepare.");
    expect(f.admit(prepared.preflight_id).state).toBe("admitted");
    const authority = new BillingAuthority({ control: f.control, root: f.root,
      clock: f.control.clock, source: { read: async () => f.facts } });
    expect((await authority.reconcile(f.account_id)).state).toBe("granted");
    const original = audit();
    expect(original.ok).toBe(true);
    expect(original.audit_id).toBeTruthy();
    f.setNow("2027-02-28T12:00:00.000Z");
    f.setFacts({ ...f.facts, verified_at: "2027-02-28T12:00:00.000Z" });
    expect((await authority.reconcile(f.account_id)).state).toBe("granted");
    expect(validate(original.audit_id!).valid).toBe(true);
  } finally { f.close(); }
});

it("a new provisioned capture-only account does not invalidate the frozen v5 audit", () => {
  const { f, audit, validate } = fixture();
  try {
    const original = audit();
    expect(original.ok).toBe(true);
    const next = f.runtime.provision("https://synthetic.invalid", "SYNTHETIC-new-unpaid-after-audit");
    const handle = f.runtime.acquire(next.id);
    try {
      handle.brain.capture(handle.brain.ownerPrincipal(), { title: "SYNTHETIC capture only",
        body: "SYNTHETIC no billing or financial history." });
    } finally { handle.release(); }
    expect(validate(original.audit_id!).valid).toBe(true);
  } finally { f.close(); }
});

it("an unadmitted account's raw financial period cannot hide behind the capture-only audit exemption", () => {
  const { f, audit, validate } = fixture();
  try {
    const original = audit();
    expect(original.ok).toBe(true);
    const next = f.runtime.provision("https://synthetic.invalid", "SYNTHETIC-unadmitted-raw-history");
    f.control.db.prepare("INSERT INTO managed_account_periods VALUES(?,?,?,?,?,?,?,NULL)")
      .run("SYNTHETIC-unsealed-period", next.id, "2027-01-31T00:00:00.000Z", "2027-02-28T00:00:00.000Z",
        1000, "active", f.control.clock().toISOString());
    expect(validate(original.audit_id!).valid).toBe(false);
  } finally { f.close(); }
});
