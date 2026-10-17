import { expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ManagedRuntime } from "../../packages/runtime/managed.ts";
import { ManagedSpendingStore } from "../../packages/storage/managed-spending.ts";
import { ManagedReconciliationStore } from "../../packages/storage/managed-reconciliation.ts";
import { ManagedDecisionActivationStore } from "../../packages/storage/managed-decision-activation.ts";
import { auditManagedHistory } from "../../packages/runtime/managed-audit.ts";
import { expectedDecisionConfigHash, installDecisionPolicy, readDecisionActivationGuardContext } from "../../packages/runtime/managed-activation.ts";
import { writeDecisionReadiness } from "../../packages/runtime/decision-worker-readiness.ts";

const clock = () => new Date("2026-10-17T12:00:00.000Z");
const ack = { offline: true as const, workers_terminated: true as const };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "brain-decision-central-binding-parent-"));
  const runtime = new ManagedRuntime(root, { clock });
  const account = runtime.provision("https://issuer.synthetic.test", "synthetic-guard-review");
  const money = new ManagedSpendingStore(runtime.control, clock);
  money.setServicePolicy({ daily_micro_usd: 1000 });
  money.setAccountPolicy({ account_id: account.id, per_job_micro_usd: 1000, user_daily_micro_usd: 1000 });
  money.configureAccountPeriod({ account_id: account.id, starts_at: "2026-10-17T00:00:00Z", ends_at: "2026-10-18T00:00:00Z", allowance_micro_usd: 1000 });
  new ManagedReconciliationStore(runtime.control, root, clock).initEpoch(ack);
  const audit = auditManagedHistory({ runtime, root, ...ack, clock });
  expect(audit.ok).toBe(true);
  const profile = new ManagedDecisionActivationStore(runtime.control, root, clock).enable({ provider: "typesafe",
    endpoint: "https://api.typesafe.ai/v1/systemone", model: "jev-synthetic-v1", accepted_response_models: ["jev-synthetic-v1"],
    price_version: "synthetic-price-v1", input_micro_usd_per_million: 1000, output_micro_usd_per_million: 0,
    timeout_ms: 1000, max_request_bytes: 1_048_576, max_response_bytes: 262_144, audit_id: audit.audit_id!, expected_version: 0 }, ack);
  const worker_id = randomUUID();
  writeDecisionReadiness(root, { schema: 1, worker_id, stage_scope: "decision", provider_family: profile.provider,
    endpoint_digest: profile.endpoint_digest, epoch: profile.epoch, root_nonce: profile.root_nonce,
    activation_fingerprint: profile.fingerprint, config_digest: profile.config_digest, model: profile.model,
    price_version: profile.price_version, booted_at: "2026-10-17T11:59:50.000Z", heartbeat_at: clock().toISOString(), expires_at: "2026-10-17T12:00:15.000Z" }, clock);
  const installed = installDecisionPolicy({ root, profile, worker_id, optIn: true });
  const spec = { account_id: account.id, job_id: "synthetic-job", dispatch_key: "decision", stage: "decision" as const,
    reserved_micro_usd: 7, provider: profile.provider, model: profile.model, price_version: profile.price_version,
    request_hash: "a".repeat(64), config_hash: expectedDecisionConfigHash(profile),
    limits: { per_job_micro_usd: 1000, user_daily_micro_usd: 1000, time_zone: "UTC" } };
  const guard = readDecisionActivationGuardContext({ control: runtime.control, installed, accountId: account.id,
    jobId: spec.job_id, dispatchKey: spec.dispatch_key, stage: "decision", phase: "before_reserve",
    lease: { job_id: spec.job_id, owner: "synthetic-lease-owner", fence: 1, expires_at: "2026-10-17T12:01:00.000Z" },
    centralCallId: null, tenantCallId: null, now: clock(), spec });
  return { runtime, money, account, spec, guard,
    close() { runtime.close(); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } };
}

it("the central decision writer independently rejects a substituted configuration even when both guard hash fields agree", () => {
  const f = fixture();
  try {
    const substituted = "f".repeat(64);
    expect(substituted).not.toBe(f.guard.expected_prepared_config_hash);
    expect(() => f.money.reserve({ ...f.spec, config_hash: substituted }, {
      ...f.guard, config_hash: substituted, expected_prepared_config_hash: substituted,
    })).toThrow();
    expect(f.money.latestForJob(f.account.id, f.spec.job_id)).toBeUndefined();
  } finally { f.close(); }
});
