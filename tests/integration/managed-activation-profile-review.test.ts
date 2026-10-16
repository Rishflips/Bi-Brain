import { expect, it } from "vitest";
import {
  activationFingerprint,
  profileConfigDigest,
  validateActivationProfile,
  type ActivationProfile,
} from "../../packages/domain/managed-activation.ts";

function profile(): ActivationProfile {
  const value: ActivationProfile = {
    schema: 1,
    version: 1,
    enabled: true,
    provider: "openai",
    model: "synthetic-model-v1",
    price_version: "synthetic-price-v1",
    input_micro_usd_per_million: 1_000_000,
    output_micro_usd_per_million: 1_000_000,
    accepted_response_models: ["synthetic-model-v1"],
    max_output_tokens: 100,
    endpoint_class: "openai_responses",
    config_digest: "0".repeat(64),
    audit_digest: "a".repeat(64),
    audit_id: "7c811b6f-1897-4e54-9519-26dcaad76789",
    epoch: 1,
    root_nonce: "b".repeat(64),
    fingerprint: "0".repeat(64),
    updated_at: "2026-10-16T09:00:00.000Z",
  };
  value.config_digest = profileConfigDigest(value);
  value.fingerprint = activationFingerprint(value);
  return value;
}

it("validates the exact profile and recomputes both digests rather than trusting supplied hashes", () => {
  const value = profile();
  expect(validateActivationProfile(value)).toEqual(value);
  expect(() => validateActivationProfile({ ...value, input_micro_usd_per_million: 2_000_000 })).toThrow();
  expect(() => validateActivationProfile({ ...value, fingerprint: "c".repeat(64) })).toThrow();
  expect(() => validateActivationProfile({ ...value, config_digest: "d".repeat(64) })).toThrow();
});

it("provider configuration and enrollment identity have separate non-circular digests", () => {
  const value = profile();
  const enrollment = { ...value, version: 2, epoch: 2, audit_digest: "c".repeat(64), updated_at: "2026-10-17T09:00:00.000Z" };
  expect(profileConfigDigest(enrollment)).toBe(value.config_digest);
  expect(activationFingerprint(enrollment)).not.toBe(value.fingerprint);
  expect(activationFingerprint({ ...value, fingerprint: "e".repeat(64) })).toBe(value.fingerprint);
});

it.each([
  { endpoint_class: "arbitrary_https" },
  { endpoint: "https://synthetic-untrusted.example.test/v1/responses" },
  { key: "SYNTHETIC_PRIVATE_KEY_NOT_PROFILE_DATA" },
  { output_micro_usd_per_million: 0.5 },
  { input_micro_usd_per_million: Number.MAX_SAFE_INTEGER + 1 },
  { max_output_tokens: 8001 },
  { version: 0 },
])("rejects an unsafe provider profile without granting authority: %j", (change) => {
  expect(() => validateActivationProfile({ ...profile(), ...change })).toThrow();
});
