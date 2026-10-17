import { expect, it } from "vitest";
import { BrainError, canonical } from "../../packages/domain/logic.ts";
import { BillingAuthority } from "../../packages/storage/billing-authority.ts";
import { loadBillingContext, verifyBillingAccountGrant } from "../../packages/storage/billing-verify.ts";
import { createBillingAdmissionFixture } from "../helpers/billing-admission-fixture.ts";

// The low-level spending verifier must be at least as strict as the accepted
// writer. All keys, paid facts and enrollment artifacts here are SYNTHETIC.
async function grantedFixture() {
  const options = { cadence: "monthly" as const, enrolled: true };
  const f = createBillingAdmissionFixture(options);
  try {
    const prepared = await f.prepare();
    if (prepared.state !== "prepared") throw new Error("Synthetic admission did not prepare.");
    expect(f.admit(prepared.preflight_id).state).toBe("admitted");
    const authority = new BillingAuthority({ control: f.control, root: f.root,
      clock: () => f.control.clock(), source: { read: async () => f.facts } });
    expect((await authority.reconcile(f.account_id)).state).toBe("granted");
    const mapping = f.control.db.prepare("SELECT period_id FROM control_billing_period WHERE account_id=?")
      .get(f.account_id) as { period_id: string };
    const verify = (now = f.control.clock()) => verifyBillingAccountGrant(f.control.db,
      loadBillingContext(f.control, f.root), f.account_id, mapping.period_id, now);
    expect(verify().binding.account_id).toBe(f.account_id);
    return { ...f, authority, verify };
  } catch (error) { f.close(); throw error; }
}
function editImmutable(f: Awaited<ReturnType<typeof grantedFixture>>, table: string, action: () => void) {
  const rows = f.control.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name=?")
    .all(table) as { name: string; sql: string }[];
  for (const row of rows) f.control.db.exec(`DROP TRIGGER "${row.name.replaceAll('"', '""')}"`);
  try { action(); } finally { for (const row of rows) f.control.db.exec(row.sql); }
}

it("the spending verifier authenticates the retained paid receipt body, not only its signed grant", async () => {
  const f = await grantedFixture();
  try {
    const row = f.control.db.prepare("SELECT receipt_json FROM control_billing_terms").get() as { receipt_json: string };
    editImmutable(f, "control_billing_terms", () => f.control.db.prepare("UPDATE control_billing_terms SET receipt_json=?")
      .run(canonical({ ...JSON.parse(row.receipt_json), transaction_ref: "SYNTHETIC-substituted-receipt" })));
    expect(() => f.verify()).toThrow(BrainError);
  } finally { f.close(); }
});

it("the spending verifier checks the observation digest referenced by the freshness MAC", async () => {
  const f = await grantedFixture();
  try {
    const row = f.control.db.prepare("SELECT observation_json FROM control_billing_freshness").get() as { observation_json: string };
    f.control.db.prepare("UPDATE control_billing_freshness SET observation_json=?")
      .run(canonical({ ...JSON.parse(row.observation_json), customer_ref: "SYNTHETIC-other-customer" }));
    expect(() => f.verify()).toThrow(BrainError);
  } finally { f.close(); }
});

it("the spending verifier compares the stored freshness revision with its authenticated body", async () => {
  const f = await grantedFixture();
  try {
    f.control.db.exec("UPDATE control_billing_freshness SET revision=revision+1");
    expect(() => f.verify()).toThrow(BrainError);
  } finally { f.close(); }
});

it("the spending verifier refuses a future observation after clock rollback", async () => {
  const f = await grantedFixture();
  try {
    expect(() => f.verify(new Date("2027-01-31T11:59:00.000Z"))).toThrow(BrainError);
  } finally { f.close(); }
});

it("the spending verifier checks the term's originating epoch and exact grant reference", async () => {
  const f = await grantedFixture();
  try {
    f.control.db.exec("PRAGMA foreign_keys=OFF");
    editImmutable(f, "control_billing_terms", () => f.control.db.exec("UPDATE control_billing_terms SET epoch=epoch+1,journal_ordinal=0"));
    f.control.db.exec("PRAGMA foreign_keys=ON");
    expect(() => f.verify()).toThrow(BrainError);
  } finally { f.close(); }
});

it("resetting a mutable counter cannot conceal a retained signed term revocation from spending", async () => {
  const f = await grantedFixture();
  try {
    f.setFacts({ ...f.facts, current_state: "refunded" });
    expect((await f.authority.reconcile(f.account_id)).state).toBe("denied");
    f.control.db.exec("UPDATE control_billing_account SET adverse_generation=0");
    expect(() => f.verify()).toThrow(BrainError);
  } finally { f.close(); }
});
