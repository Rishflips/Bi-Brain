import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
  decisionActivationFingerprint,
  decisionProfileConfigDigest,
  validateDecisionActivationProfile,
  validateDecisionOperatorInput,
  type DecisionActivationProfile,
} from "../../packages/domain/managed-decision-activation.ts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
function operator() {
  return {
    provider: "typesafe" as const, endpoint: "https://api.typesafe.ai/v1/systemone",
    model: "jev-synthetic-v1", accepted_response_models: ["jev-synthetic-v1", "jev-synthetic-alias"],
    price_version: "synthetic-price-v1", input_micro_usd_per_million: 1000,
    output_micro_usd_per_million: 0, timeout_ms: 1000,
    max_request_bytes: 1_048_576, max_response_bytes: 262_144,
    audit_id: "11111111-1111-4111-8111-111111111111", expected_version: 0,
  };
}
function profile(): DecisionActivationProfile {
  const { expected_version: _expected, ...configured } = operator();
  const p: DecisionActivationProfile = {
    ...configured, schema: 1, version: 1, enabled: true,
    endpoint_digest: sha(configured.endpoint), request_overhead_bytes: 1024,
    audit_digest: sha("SYNTHETIC_AUDIT"), epoch: 1, root_nonce: sha("SYNTHETIC_ROOT"),
    updated_at: "2026-10-17T12:00:00.000Z", config_digest: "", fingerprint: "",
  };
  p.config_digest = decisionProfileConfigDigest(p);
  p.fingerprint = decisionActivationFingerprint(p);
  return p;
}

it("accepts a fully bound decision profile without mutating operator-owned arrays", () => {
  const p = profile(), accepted = [...p.accepted_response_models];
  const validated = validateDecisionActivationProfile(p);
  expect(validated).toEqual(p);
  validated.accepted_response_models.reverse();
  expect(p.accepted_response_models).toEqual(accepted);
  expect(validateDecisionOperatorInput(operator())).toEqual(operator());
});

it.each([
  ["endpoint_digest", sha("SYNTHETIC_DIFFERENT_ENDPOINT")],
  ["config_digest", sha("SYNTHETIC_DIFFERENT_CONFIG")],
  ["fingerprint", sha("SYNTHETIC_DIFFERENT_FINGERPRINT")],
] as const)("refuses a stored profile with a substituted %s", (field, value) => {
  expect(() => validateDecisionActivationProfile({ ...profile(), [field]: value })).toThrow();
});

it.each([
  ["enabled", false], ["version", 2], ["audit_digest", sha("SYNTHETIC_OTHER_AUDIT")],
  ["audit_id", "22222222-2222-4222-8222-222222222222"], ["epoch", 2],
  ["root_nonce", sha("SYNTHETIC_OTHER_ROOT")], ["updated_at", "2026-10-17T12:01:00.000Z"],
] as const)("fingerprint binds %s while provider-only config identity remains stable", (field, value) => {
  const p = profile(), changed = { ...p, [field]: value };
  expect(decisionProfileConfigDigest(changed)).toBe(p.config_digest);
  expect(decisionActivationFingerprint(changed)).not.toBe(p.fingerprint);
  expect(() => validateDecisionActivationProfile(changed)).toThrow();
});

it.each([
  "http://api.typesafe.ai/v1/systemone", "http://127.0.0.1:4317/v1/systemone",
  "https://127.0.0.1/v1/systemone", "https://api.typesafe.ai.evil.test/v1/systemone",
  "https://api.typesafe.ai:8443/v1/systemone", "https://user:password@api.typesafe.ai/v1/systemone",
  "https://api.typesafe.ai/v1/systemone?key=SYNTHETIC", "https://api.typesafe.ai/v1/systemone#secret",
  "https://api.typesafe.ai/v1/systemone/extra",
])("refuses a decision endpoint outside the closed enrollment boundary: %s", (endpoint) => {
  expect(() => validateDecisionOperatorInput({ ...operator(), endpoint })).toThrow();
});

it.each([
  { input_micro_usd_per_million: 0 }, { input_micro_usd_per_million: -1 },
  { input_micro_usd_per_million: 0.5 }, { input_micro_usd_per_million: Number.MAX_SAFE_INTEGER + 1 },
  { output_micro_usd_per_million: 1 }, { output_micro_usd_per_million: -1 },
  { timeout_ms: 0 }, { timeout_ms: 120_001 },
  { max_request_bytes: 63 }, { max_response_bytes: 33_554_433 },
  { accepted_response_models: [] }, { accepted_response_models: ["same", "same"] },
  { accepted_response_models: ["bad\nmodel"] }, { expected_version: -1 },
])("refuses invalid pricing, bounds, model sets or CAS input: %j", (change) => {
  expect(() => validateDecisionOperatorInput({ ...operator(), ...change })).toThrow();
});

it.each(["key", "enabled", "config_digest", "fingerprint", "unknown"])("operator input cannot smuggle %s", (field) => {
  expect(() => validateDecisionOperatorInput({ ...operator(), [field]: "SYNTHETIC_UNTRUSTED_VALUE" })).toThrow();
});

it("Cloudflare enrollment binds the official account endpoint selector to the chosen model", () => {
  const cf = {
    ...operator(), provider: "cloudflare", model: "clef", accepted_response_models: ["clef-synthetic-alias"],
    endpoint: "https://api.cloudflare.com/client/v4/accounts/synthetic/ai/run/@cf/cloudflare/clef",
  };
  expect(validateDecisionOperatorInput(cf)).toMatchObject({ provider: "cloudflare", model: "clef" });
  expect(() => validateDecisionOperatorInput({ ...cf, model: "clef-flash" })).toThrow();
  expect(() => validateDecisionOperatorInput({ ...cf, endpoint: cf.endpoint.replace("api.cloudflare.com", "synthetic.example.test") })).toThrow();
});

it("the full profile rejects changed framing, unsafe boolean encodings and unknown fields even with recomputed hashes", () => {
  for (const change of [{ request_overhead_bytes: 0 }, { enabled: 2 }, { unexpected: "SYNTHETIC" }]) {
    const changed = { ...profile(), ...change } as DecisionActivationProfile;
    changed.config_digest = decisionProfileConfigDigest(changed);
    changed.fingerprint = decisionActivationFingerprint(changed);
    expect(() => validateDecisionActivationProfile(changed)).toThrow();
  }
});

it("the enrollment fingerprint binds accepted-model ordering because the prepared hash does", () => {
  const p = profile(), changed = { ...p, accepted_response_models: [...p.accepted_response_models].reverse() };
  expect(decisionActivationFingerprint(changed)).not.toBe(p.fingerprint);
  expect(() => validateDecisionActivationProfile(changed)).toThrow();
});

it.each(["model", "price_version", "accepted_response_models"])("refuses blank %s just as the actual transport does", (field) => {
  const value = field === "accepted_response_models" ? ["   "] : "   ";
  expect(() => validateDecisionOperatorInput({ ...operator(), [field]: value })).toThrow();
});
