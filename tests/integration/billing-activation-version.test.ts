import { expect, it } from "vitest";
import { auditManagedHistory } from "../../packages/runtime/managed-audit.ts";
import {
  evaluateConfiguredDecisionPolicy,
  evaluateConfiguredPolicy,
} from "../../packages/runtime/managed-activation.ts";
import { ManagedActivationStore } from "../../packages/storage/managed-activation.ts";
import { ManagedDecisionActivationStore } from "../../packages/storage/managed-decision-activation.ts";
import { readGuardSnapshot } from "../../packages/storage/managed-activation-state.ts";
import { readDecisionGuardSnapshot } from "../../packages/storage/managed-decision-activation-state.ts";
import { createBillingAdmissionFixture } from "../helpers/billing-admission-fixture.ts";

/**
 * The stored activation contract binds the ACTUAL closed control-money version (4 or
 * 5), never a fixed 4. A genuine money-5 root with the strict integrated schema and a
 * verified protected enrollment anchor can bind an existing reasoning OR decision
 * profile; a future/unknown version or a v5 without the anchor is refused. Only
 * synthetic profile metadata is enrolled: no provider, key, readiness or transport.
 */

const ACK = { offline: true, workers_terminated: true };
const REASONING = {
  provider: "openai",
  model: "SYNTHETIC-profile-model",
  price_version: "SYNTHETIC-price-version",
  input_micro_usd_per_million: 10000,
  output_micro_usd_per_million: 10000,
  accepted_response_models: ["SYNTHETIC-profile-model"],
  max_output_tokens: 100,
  endpoint_class: "openai_responses",
};
const DECISION = {
  provider: "typesafe",
  model: "SYNTHETIC-decision-model",
  accepted_response_models: ["SYNTHETIC-decision-model"],
  endpoint: "https://api.typesafe.ai/v1/systemone",
  price_version: "SYNTHETIC-decision-price",
  input_micro_usd_per_million: 10000,
  output_micro_usd_per_million: 0,
  timeout_ms: 1000,
  max_request_bytes: 4096,
  max_response_bytes: 4096,
};

it("a fresh v5 audit binds the REASONING activation contract at its actual version", () => {
  const f = createBillingAdmissionFixture({ enrolled: true });
  try {
    const audit = auditManagedHistory({
      runtime: f.runtime,
      root: f.root,
      offline: true,
      workers_terminated: true,
      clock: f.control.clock,
    });
    expect(audit.ok).toBe(true);
    const profile = new ManagedActivationStore(
      f.control,
      f.root,
      f.control.clock,
    ).enable({ ...REASONING, audit_id: audit.audit_id!, expected_version: 0 }, ACK);
    expect(profile.enabled).toBe(true);
    expect(profile.schema).toBe(1);
    expect(readGuardSnapshot(f.control, f.root).state).toBe("active");
    expect(
      evaluateConfiguredPolicy({
        control: f.control,
        root: f.root,
        now: f.control.clock(),
        optIn: true,
      }),
    ).toEqual({ ready: true, reason: "ready" });
  } finally {
    f.close();
  }
});

it("a fresh v5 audit binds the DECISION activation contract at its actual version", () => {
  const f = createBillingAdmissionFixture({ enrolled: true });
  try {
    const audit = auditManagedHistory({
      runtime: f.runtime,
      root: f.root,
      offline: true,
      workers_terminated: true,
      clock: f.control.clock,
    });
    expect(audit.ok).toBe(true);
    const store = new ManagedDecisionActivationStore(
      f.control,
      f.root,
      f.control.clock,
    );
    const profile = store.enable(
      { ...DECISION, audit_id: audit.audit_id!, expected_version: 0 },
      ACK,
    );
    expect(profile.enabled).toBe(true);
    expect(profile.schema).toBe(1);
    expect(readDecisionGuardSnapshot(f.control, f.root).state).toBe("active");
    expect(
      evaluateConfiguredDecisionPolicy({
        control: f.control,
        root: f.root,
        now: f.control.clock(),
        optIn: true,
      }),
    ).toEqual({ ready: true, reason: "ready" });
  } finally {
    f.close();
  }
});

it("a v5 root without the protected enrollment anchor cannot bind activation", () => {
  const f = createBillingAdmissionFixture();
  try {
    const audit = auditManagedHistory({
      runtime: f.runtime,
      root: f.root,
      offline: true,
      workers_terminated: true,
      clock: f.control.clock,
    });
    // The non-funding install is genuine v5 but unenrolled: any audit it can produce
    // must never authorize a paid activation profile.
    if (!audit.ok) return;
    expect(() =>
      new ManagedActivationStore(f.control, f.root, f.control.clock).enable(
        { ...REASONING, audit_id: audit.audit_id!, expected_version: 0 },
        ACK,
      ),
    ).toThrow();
  } finally {
    f.close();
  }
});
