import { expect, it } from "vitest";
import { auditManagedHistory } from "../../packages/runtime/managed-audit.ts";
import { evaluateConfiguredPolicy } from "../../packages/runtime/managed-activation.ts";
import { ManagedActivationStore } from "../../packages/storage/managed-activation.ts";
import { readGuardSnapshot } from "../../packages/storage/managed-activation-state.ts";
import { createBillingAdmissionFixture } from "../helpers/billing-admission-fixture.ts";

// Only synthetic profile metadata is enrolled. No provider factory, credentials,
// readiness or transport is installed; sandbox bootstrap remains separately OFF.
it("a fresh v5 audit can bind the existing reasoning activation contract without pretending it is v4", () => {
  const f = createBillingAdmissionFixture({ enrolled: true });
  try {
    const audit = auditManagedHistory({ runtime: f.runtime, root: f.root,
      offline: true, workers_terminated: true, clock: f.control.clock });
    expect(audit.ok).toBe(true);
    const profile = new ManagedActivationStore(f.control, f.root, f.control.clock).enable({
      provider: "openai", model: "SYNTHETIC-profile-model", price_version: "SYNTHETIC-price-version",
      input_micro_usd_per_million: 10000, output_micro_usd_per_million: 10000,
      accepted_response_models: ["SYNTHETIC-profile-model"], max_output_tokens: 100,
      endpoint_class: "openai_responses", audit_id: audit.audit_id!, expected_version: 0,
    }, { offline: true, workers_terminated: true });
    expect(profile.enabled).toBe(true);
    expect(readGuardSnapshot(f.control, f.root).state).toBe("active");
    expect(evaluateConfiguredPolicy({ control: f.control, root: f.root,
      now: f.control.clock(), optIn: true })).toEqual({ ready: true, reason: "ready" });
  } finally { f.close(); }
});
