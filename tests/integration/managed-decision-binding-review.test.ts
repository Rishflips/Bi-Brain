import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  decisionActivationFingerprint,
  decisionProfileConfigDigest,
  type DecisionActivationProfile,
} from "../../packages/domain/managed-decision-activation.ts";
import { expectedDecisionConfigHash } from "../../packages/runtime/managed-activation.ts";
import { PreparedDecisionProvider } from "../../packages/providers/prepared-decision.ts";

function profile(provider: "typesafe" | "cloudflare" = "typesafe"): DecisionActivationProfile {
  const endpoint = provider === "typesafe" ? "https://api.typesafe.ai/v1/systemone"
    : "https://api.cloudflare.com/client/v4/accounts/synthetic/ai/run/@cf/cloudflare/clef";
  const p: DecisionActivationProfile = {
    schema: 1, version: 1, enabled: true, provider, endpoint,
    endpoint_digest: createHash("sha256").update(endpoint).digest("hex"),
    model: provider === "typesafe" ? "jev-synthetic-v1" : "clef",
    accepted_response_models: ["synthetic-returned-alias", "synthetic-returned-alias-2"],
    price_version: "synthetic-price-v1", input_micro_usd_per_million: 1000, output_micro_usd_per_million: 0,
    timeout_ms: 1000, max_request_bytes: 1_048_576, max_response_bytes: 262_144, request_overhead_bytes: 1024,
    audit_id: "11111111-1111-4111-8111-111111111111", audit_digest: "a".repeat(64), epoch: 1,
    root_nonce: "b".repeat(64), updated_at: "2026-10-17T12:00:00.000Z", config_digest: "", fingerprint: "",
  };
  return rebind(p);
}
function rebind(p: DecisionActivationProfile): DecisionActivationProfile {
  p.config_digest = decisionProfileConfigDigest(p);
  p.fingerprint = decisionActivationFingerprint(p);
  return p;
}
const input = {
  state: "SYNTHETIC scoped goal and source version snapshot", instruction: "Choose one permitted option.",
  options: [{ id: "related", description: "Potentially related" }, { id: "abstain", description: "Insufficient evidence" }],
};

it.each(["typesafe", "cloudflare"] as const)("%s profile expected hash exactly matches the real prepared adapter, with no transport I/O", (provider) => {
  const p = profile(provider);
  let calls = 0;
  const instance = new PreparedDecisionProvider({
    provider: p.provider, endpoint: p.endpoint, model: p.model, accepted_response_models: [...p.accepted_response_models],
    price: { version: p.price_version, input_micro_usd_per_million: p.input_micro_usd_per_million, output_micro_usd_per_million: 0 },
    timeout_ms: p.timeout_ms, max_request_bytes: p.max_request_bytes, max_response_bytes: p.max_response_bytes,
    key: "SYNTHETIC_CREDENTIAL_NOT_PROFILE_DATA",
  }, async () => { calls++; throw new Error("SYNTHETIC_NO_IO_ALLOWED"); });
  const call = instance.prepareDecision(input);
  expect(expectedDecisionConfigHash(p)).toBe(call.identity.config_hash);
  expect(expectedDecisionConfigHash(p)).not.toBe(p.config_digest);
  expect(calls).toBe(0);
  expect(JSON.stringify(call.identity)).not.toContain("SYNTHETIC_CREDENTIAL_NOT_PROFILE_DATA");
});

it("the expected prepared hash binds accepted-model ordering and every execution bound", () => {
  const p = profile(), hash = expectedDecisionConfigHash(p);
  for (const changed of [
    { ...p, accepted_response_models: [...p.accepted_response_models].reverse() },
    { ...p, timeout_ms: p.timeout_ms + 1 },
    { ...p, max_request_bytes: p.max_request_bytes - 1 },
    { ...p, max_response_bytes: p.max_response_bytes - 1 },
    { ...p, price_version: "synthetic-price-v2" },
    { ...p, input_micro_usd_per_million: 2000 },
  ]) expect(expectedDecisionConfigHash(rebind(changed))).not.toBe(hash);
});

it("enrollment metadata changes never masquerade as a different provider request configuration", () => {
  const p = profile(), hash = expectedDecisionConfigHash(p);
  const changed = rebind({ ...p, version: 2, enabled: false, epoch: 2, root_nonce: "c".repeat(64), updated_at: "2026-10-17T12:01:00.000Z" });
  expect(changed.fingerprint).not.toBe(p.fingerprint);
  expect(expectedDecisionConfigHash(changed)).toBe(hash);
});
