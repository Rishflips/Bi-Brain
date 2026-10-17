import { expect, it } from "vitest";
import { validateActivationGuard } from "../../packages/domain/managed-activation.ts";

// Schema fixtures alone authorize nothing: live profiles, accounting state,
// leases and consent must still be checked by runtime/storage boundaries.
function reasoningGuard() {
  return {
    phase: "before_reserve", account_id: "11111111-1111-4111-8111-111111111111",
    job_id: "synthetic-job", dispatch_key: "reasoning", stage: "reasoning",
    lease_owner: "synthetic-worker", lease_fence: 1, lease_expires_at: "2026-10-17T12:01:00.000Z",
    provider: "openai", model: "synthetic-reasoning-v1", price_version: "synthetic-price-v1",
    request_hash: "a".repeat(64), config_hash: "b".repeat(64), reserved_micro_usd: 7,
    profile_version: 1, fingerprint: "c".repeat(64), config_digest: "d".repeat(64),
    epoch: 1, root_nonce: "e".repeat(64), schema_version: 4, schema_digest: "f".repeat(64),
    audit_id: "22222222-2222-4222-8222-222222222222", audit_digest: "a".repeat(64),
    expected_prepared_config_hash: "b".repeat(64), central_inventory_digest: "c".repeat(64),
    central_call_id: null, tenant_call_id: null,
  };
}

it("keeps the existing closed reasoning guard shape compatible", () => {
  expect(validateActivationGuard(reasoningGuard())).toEqual(reasoningGuard());
});

it.each(["decision", "repair"])("a legacy OpenAI guard cannot be relabelled as the %s stage", (stage) => {
  expect(() => validateActivationGuard({ ...reasoningGuard(), stage })).toThrow();
});

it.each(["typesafe", "cloudflare"])("a %s provider cannot be smuggled into a reasoning-stage guard", (provider) => {
  expect(() => validateActivationGuard({ ...reasoningGuard(), provider })).toThrow();
});

it("decision-only purpose fields do not widen the reasoning branch", () => {
  expect(() => validateActivationGuard({ ...reasoningGuard(), purpose: "goal_relevance", job_kind: "review_changed_assumption" })).toThrow();
});
