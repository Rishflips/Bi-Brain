import { createHash } from "node:crypto";
import { ManagedRuntime } from "../../packages/runtime/managed.ts";
import { ManagedSpendingStore } from "../../packages/storage/managed-spending.ts";
import { ManagedReconciliationStore } from "../../packages/storage/managed-reconciliation.ts";
import { ManagedActivationStore } from "../../packages/storage/managed-activation.ts";
import { auditManagedHistory } from "../../packages/runtime/managed-audit.ts";
import { expectedPreparedConfigHash } from "../../packages/runtime/managed-activation.ts";
import type { ActivationProfile } from "../../packages/domain/managed-activation.ts";
import {
  fakePreparedProvider,
  type FakePreparedSpec,
} from "./prepared-provider.ts";
import type {
  PrepareRequest,
  PreparedCall,
  PreparedProvider,
} from "../../packages/providers/prepared.ts";

/**
 * Trusted TEST-ONLY helper for Task 2. It enrols one synthetic activation profile
 * and builds a fake transport whose declared `config_hash` equals the profile's
 * expected prepared hash, so managed paid tests exercise the real gate instead of
 * bypassing it. No real key, provider or network; never imported by production.
 * The parent review fixtures are deliberately independent of this helper.
 */

const ACK = { offline: true as const, workers_terminated: true as const };
export const SYNTHETIC_ACTIVATION_MODEL = "synthetic-model-v1";
export const SYNTHETIC_ACTIVATION_PRICE = "synthetic-price-v1";

export function enablePaidAccount(
  runtime: ManagedRuntime,
  accountId: string,
  clock: () => Date = runtime.control.clock,
): void {
  // Explicit deployment opt-in: a persistent operator flag, not a per-boot challenge.
  process.env.BRAIN_MANAGED_ALLOW_PAID = "1";
  const control = runtime.control;
  const money = new ManagedSpendingStore(control, clock);
  const ensure = (fn: () => void) => {
    try {
      fn();
    } catch {
      /* already configured by the caller */
    }
  };
  ensure(() => money.setServicePolicy({ daily_micro_usd: 100000 }));
  ensure(() =>
    money.setAccountPolicy({
      account_id: accountId,
      per_job_micro_usd: 10000,
      user_daily_micro_usd: 100000,
    }),
  );
  ensure(() =>
    money.configureAccountPeriod({
      account_id: accountId,
      starts_at: "2026-10-16T00:00:00Z",
      ends_at: "2030-01-01T00:00:00Z",
      allowance_micro_usd: 1000000,
    }),
  );
  const handle = runtime.acquire(accountId);
  try {
    const owner = handle.brain.ownerPrincipal();
    handle.brain.prefs(owner, {
      ...handle.brain.prefs(owner),
      time_zone: "UTC",
      provider_enabled: true,
      daily_cap_micro_usd: 100000,
      per_job_cap_micro_usd: 10000,
    });
  } finally {
    handle.release();
  }
}

export function enrolSyntheticActivation(
  runtime: ManagedRuntime,
  accountId: string,
  clock: () => Date = runtime.control.clock,
): ActivationProfile {
  const control = runtime.control;
  enablePaidAccount(runtime, accountId, clock);
  const recon = new ManagedReconciliationStore(control, runtime.root, clock);
  if (!recon.readEpoch()) recon.initEpoch(ACK);
  const store = new ManagedActivationStore(control, runtime.root, clock);
  const existing = store.read();
  if (existing) return existing;
  const audit = auditManagedHistory({ runtime, root: runtime.root, ...ACK, clock });
  if (!audit.ok) throw new Error(`synthetic activation audit failed: ${audit.reason}`);
  return store.enable(
    {
      provider: "openai",
      model: SYNTHETIC_ACTIVATION_MODEL,
      price_version: SYNTHETIC_ACTIVATION_PRICE,
      input_micro_usd_per_million: 10000,
      output_micro_usd_per_million: 10000,
      accepted_response_models: [SYNTHETIC_ACTIVATION_MODEL],
      max_output_tokens: 100,
      endpoint_class: "openai_responses",
      audit_id: audit.audit_id!,
      expected_version: 0,
    },
    ACK,
  );
}

/**
 * A fake prepared transport that declares the profile-derived `config_hash` for
 * the call kind while delegating execution/accounting to the standard fake.
 */
export function syntheticActivationProvider(
  profile: ActivationProfile,
  spec: FakePreparedSpec = {},
): PreparedProvider & { calls: number } {
  const base = fakePreparedProvider(spec);
  const provider = { calls: 0 } as PreparedProvider & { calls: number };
  provider.prepareCall = (input: PrepareRequest): PreparedCall => {
    const json = JSON.stringify(input);
    const inner = base.prepareCall(input);
    const identity = Object.freeze({
      ...inner.identity,
      provider: profile.provider,
      model: profile.model,
      price_version: profile.price_version,
      config_hash: expectedPreparedConfigHash(profile, input.kind),
      request_hash: createHash("sha256").update(json).digest("hex"),
    });
    return Object.freeze({
      identity,
      request_bytes: inner.request_bytes,
      execute: async (signal: AbortSignal) => {
        provider.calls += 1;
        return inner.execute(signal);
      },
    });
  };
  return provider;
}
