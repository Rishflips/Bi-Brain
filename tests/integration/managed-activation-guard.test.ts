import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedRuntime } from "../../packages/runtime/managed.ts";
import { ManagedSpendingStore } from "../../packages/storage/managed-spending.ts";
import { ManagedActivationStore } from "../../packages/storage/managed-activation.ts";
import { ManagedWorker } from "../../apps/worker/managed.ts";
import {
  expectedPreparedConfigHash,
  readActivationGuardContext,
} from "../../packages/runtime/managed-activation.ts";
import { validateActivationProfile, profileConfigDigest, activationFingerprint } from "../../packages/domain/managed-activation.ts";
import { PreparedReasoningProvider } from "../../packages/providers/prepared.ts";
import { fakePreparedProvider } from "../helpers/prepared-provider.ts";
import {
  enrolSyntheticActivation,
  syntheticActivationProvider,
} from "../helpers/managed-activation.ts";

process.env.BRAIN_MANAGED_ALLOW_PAID = "1";

/**
 * Task 2 guard suite. Real control/tenant SQLite over a disposable root with a
 * deterministic clock. Synthetic profile + fake transport only; no provider key,
 * model IO or network in any case.
 */

const ISSUER = "https://issuer.synthetic.test";
let current = "2026-10-16T09:00:00Z";
const clock = () => new Date(current);

const tracked: { runtime: ManagedRuntime; root: string }[] = [];
function managed() {
  const root = mkdtempSync(join(tmpdir(), "bibrain-activation-guard-"));
  const runtime = new ManagedRuntime(root, { clock });
  tracked.push({ runtime, root });
  return { root, runtime };
}
afterEach(() => {
  current = "2026-10-16T09:00:00Z";
  const entries = tracked.splice(0);
  for (const { runtime } of entries) {
    try {
      runtime.close();
    } catch {
      /* already closed */
    }
  }
  for (const root of new Set(entries.map((e) => e.root)))
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function seed(runtime: ManagedRuntime, id: string, body: string) {
  const h = runtime.acquire(id);
  try {
    h.brain.capture(h.brain.ownerPrincipal(), { project_id: "inbox", title: "note", body });
  } finally {
    h.release();
  }
}

function centralRows(runtime: ManagedRuntime) {
  return runtime.control.db
    .prepare("SELECT call_id,state,actual_micro_usd FROM managed_reservations ORDER BY created_at")
    .all() as { call_id: string; state: string; actual_micro_usd: number | null }[];
}

describe("frozen-policy activation guard", () => {
  it("dispatches two sequential paid calls with one enrolment and no re-audit self-deny", async () => {
    const { runtime } = managed();
    const a = await runtime.provision(ISSUER, "seq-a");
    const profile = enrolSyntheticActivation(runtime, a.id, clock);
    seed(runtime, a.id, "SYNTHETIC_SEQ_ONE");
    const provider = syntheticActivationProvider(profile);
    const worker = new ManagedWorker(runtime, { providerFactory: () => provider });
    expect(await worker.tick()).toBe(true);
    seed(runtime, a.id, "SYNTHETIC_SEQ_TWO");
    expect(await worker.tick()).toBe(true);
    expect(provider.calls).toBe(2);
    const rows = centralRows(runtime);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.state === "settled")).toBe(true);
  });

  it("performs no IO and adds no hold when no profile is installed", async () => {
    const { runtime } = managed();
    const a = await runtime.provision(ISSUER, "no-profile");
    const money = new ManagedSpendingStore(runtime.control, clock);
    money.setServicePolicy({ daily_micro_usd: 100000 });
    money.configureAccountPeriod({
      account_id: a.id,
      starts_at: "2026-10-16T00:00:00Z",
      ends_at: "2026-10-17T00:00:00Z",
      allowance_micro_usd: 100000,
    });
    money.setAccountPolicy({ account_id: a.id, per_job_micro_usd: 10000, user_daily_micro_usd: 100000 });
    const h = runtime.acquire(a.id);
    try {
      h.brain.prefs(h.brain.ownerPrincipal(), {
        ...h.brain.prefs(h.brain.ownerPrincipal()),
        provider_enabled: true,
        daily_cap_micro_usd: 10000,
        per_job_cap_micro_usd: 1000,
      });
    } finally {
      h.release();
    }
    seed(runtime, a.id, "SYNTHETIC_NO_PROFILE");
    const provider = fakePreparedProvider();
    const worker = new ManagedWorker(runtime, { providerFactory: () => provider });
    expect(await worker.tick()).toBe(true); // job fails closed
    expect(provider.calls).toBe(0);
    expect(centralRows(runtime)).toEqual([]);
  });

  it("denies before any hold when the provider identity does not match the installed profile", async () => {
    const { runtime } = managed();
    const a = await runtime.provision(ISSUER, "identity-mismatch");
    const profile = enrolSyntheticActivation(runtime, a.id, clock);
    seed(runtime, a.id, "SYNTHETIC_IDENTITY");
    // A cost-imposter: a real-looking config hash but a different provider model.
    const imposter = syntheticActivationProvider({ ...profile, model: "other-model" } as never);
    const worker = new ManagedWorker(runtime, { providerFactory: () => imposter });
    await worker.tick();
    expect(centralRows(runtime)).toEqual([]);
  });

  it("the in-transaction seam denies when the stored profile changes after the preflight", async () => {
    const { runtime } = managed();
    const a = await runtime.provision(ISSUER, "seam-race");
    const profile = enrolSyntheticActivation(runtime, a.id, clock);
    const jobId = (
      runtime.control.db
        .prepare("SELECT id FROM managed_accounts WHERE id=?")
        .get(a.id) as { id: string }
    ).id;
    expect(jobId).toBe(a.id);
    // Read the guard from the live loader, then mutate the trusted policy.
    const h = runtime.acquire(a.id);
    try {
      h.brain.capture(h.brain.ownerPrincipal(), { project_id: "inbox", title: "n", body: "SYNTHETIC_SEAM" });
      const job = h.brain.store.get<{ id: string }>(
        "SELECT id FROM jobs WHERE kind='derive_brief' ORDER BY created_at DESC LIMIT 1",
      )!.id;
      const lease = { job_id: job, owner: "w", fence: 1, expires_at: "2026-10-16T09:30:00Z" };
      const guard = readActivationGuardContext({
        control: { db: runtime.control.db, path: runtime.control.path },
        installed: { root: runtime.root, profile },
        accountId: a.id,
        kind: "brief",
        jobId: job,
        dispatchKey: "reasoning",
        stage: "reasoning",
        lease,
        phase: "before_reserve",
        centralCallId: null,
        tenantCallId: null,
        spec: {
          provider: profile.provider,
          model: profile.model,
          price_version: profile.price_version,
          request_hash: "a".repeat(64),
          config_hash: expectedPreparedConfigHash(profile, "brief"),
          reserved_micro_usd: 100,
        },
      });
      // Mutate the trusted policy AFTER the preflight but BEFORE the write.
      new ManagedSpendingStore(runtime.control, clock).setAccountPolicy({
        account_id: a.id,
        per_job_micro_usd: 999,
        user_daily_micro_usd: 999,
      });
      const store = new ManagedSpendingStore(runtime.control, clock);
      expect(() =>
        store.reserve(
          {
            account_id: a.id,
            job_id: guard.job_id,
            dispatch_key: guard.dispatch_key,
            stage: guard.stage,
            reserved_micro_usd: guard.reserved_micro_usd,
            provider: guard.provider,
            model: guard.model,
            price_version: guard.price_version,
            request_hash: guard.request_hash,
            config_hash: guard.config_hash,
            limits: { per_job_micro_usd: 10000, user_daily_micro_usd: 100000, time_zone: "UTC" },
          },
          guard,
        ),
      ).toThrow();
      expect(centralRows(runtime)).toEqual([]);
    } finally {
      h.release();
    }
  });

  it("the seam rejects a spec whose provider identity or money fields differ from the guard", () => {
    const { runtime } = managed();
    const a = runtime.provision(ISSUER, "seam-identity");
    const profile = enrolSyntheticActivation(runtime, a.id, clock);
    const h = runtime.acquire(a.id);
    try {
      const saved = h.brain.capture(h.brain.ownerPrincipal(), {
        project_id: "inbox",
        title: "n",
        body: "SYNTHETIC_SEAM_IDENTITY",
      }) as { job: { id: string } };
      h.brain.store.run(
        "UPDATE jobs SET status='running',lease_owner='w',fence=1,lease_until='2026-10-16T09:30:00.000Z' WHERE id=?",
        saved.job.id,
      );
      const lease = {
        job_id: saved.job.id,
        owner: "w",
        fence: 1,
        expires_at: "2026-10-16T09:30:00.000Z",
      };
      const expected = expectedPreparedConfigHash(profile, "brief");
      const context = {
        control: { db: runtime.control.db, path: runtime.control.path },
        installed: { root: runtime.root, profile },
        accountId: a.id,
        kind: "brief" as const,
        jobId: saved.job.id,
        dispatchKey: "reasoning",
        stage: "reasoning" as const,
        lease,
        phase: "before_reserve" as const,
        centralCallId: null,
        tenantCallId: null,
        spec: {
          provider: profile.provider,
          model: profile.model,
          price_version: profile.price_version,
          request_hash: "a".repeat(64),
          config_hash: expected,
          reserved_micro_usd: 100,
        },
      };
      const guard = readActivationGuardContext(context);
      const store = new ManagedSpendingStore(runtime.control, clock);
      const base = {
        account_id: a.id,
        job_id: saved.job.id,
        dispatch_key: "reasoning",
        stage: "reasoning" as const,
        reserved_micro_usd: 100,
        provider: guard.provider,
        model: guard.model,
        price_version: guard.price_version,
        request_hash: guard.request_hash,
        config_hash: guard.config_hash,
        limits: { per_job_micro_usd: 10000, user_daily_micro_usd: 100000, time_zone: "UTC" },
      };
      for (const change of [
        { provider: "other" },
        { model: "other" },
        { price_version: "other" },
        { request_hash: "b".repeat(64) },
        { reserved_micro_usd: 999 },
        { config_hash: "c".repeat(64) },
      ]) {
        expect(() => store.reserve({ ...base, ...change } as never, guard)).toThrow();
      }
      // A lease that belongs to a different job denies before any central hold.
      expect(() =>
        readActivationGuardContext({ ...context, lease: { ...lease, job_id: "other-job" } }),
      ).toThrow();
      expect(centralRows(runtime)).toEqual([]);
    } finally {
      h.release();
    }
  });

  it("the seam never opens a nested transaction", () => {
    const { runtime } = managed();
    const store = new ManagedSpendingStore(runtime.control, clock);
    expect(() => store.transaction(() => store.reserve({} as never))).toThrow();
  });

  it("preserves the exact accepted-model order in the prepared config hash", () => {
    const accepted = ["z-model", "a-model"];
    const base = {
      schema: 1 as const, version: 1, enabled: true, provider: "openai" as const, model: "z-model",
      price_version: "p1", input_micro_usd_per_million: 5, output_micro_usd_per_million: 0,
      accepted_response_models: accepted, max_output_tokens: 64, endpoint_class: "openai_responses" as const,
      audit_digest: "0".repeat(64), audit_id: "00000000-0000-4000-8000-000000000000", epoch: 1,
      root_nonce: "0".repeat(64), updated_at: "2026-10-16T09:00:00.000Z",
    };
    const draft = (extra: Record<string, unknown>) => ({ ...base, config_digest: "", fingerprint: "", ...extra });
    const config_digest = profileConfigDigest(draft({}) as never);
    const fingerprint = activationFingerprint(draft({ config_digest }) as never);
    const profile = validateActivationProfile(draft({ config_digest, fingerprint }));
    const provider = new PreparedReasoningProvider({
      model: "z-model",
      accepted_response_models: accepted,
      key: "DUMMY_KEY",
      price: { version: "p1", input_micro_usd_per_million: 5, output_micro_usd_per_million: 0 },
      max_output_tokens: 64,
    });
    for (const kind of ["brief", "goal"] as const) {
      const call = provider.prepareCall(
        kind === "brief"
          ? { kind, sources: [] }
          : { kind, goal: { title: "t", success_criteria: "s", plan: "" }, sources: [] },
      );
      expect(call.identity.config_hash).toBe(expectedPreparedConfigHash(profile, kind));
    }
  });

  it("settles a known charge after disable but publishes no proposal", async () => {
    const { runtime } = managed();
    const a = await runtime.provision(ISSUER, "post-settle");
    const profile = enrolSyntheticActivation(runtime, a.id, clock);
    seed(runtime, a.id, "SYNTHETIC_POST_SETTLE");
    const provider = syntheticActivationProvider(profile, {
      result: () => ({
        accounting: { state: "known", cost_micro_usd: 7, usage: { input_tokens: 1, output_tokens: 1 }, model: profile.model },
        output: { ok: true, kind: "brief", items: [], unknowns: [] },
      }),
      onExecute: () => {
        // Disable the PROFILE itself while the provider call is in flight.
        new ManagedActivationStore(runtime.control, runtime.root, clock).disable(
          profile.version,
        );
      },
    });
    const worker = new ManagedWorker(runtime, { providerFactory: () => provider });
    await worker.tick();
    const rows = centralRows(runtime);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("settled");
    expect(rows[0]!.actual_micro_usd).toBe(7);
    const h = runtime.acquire(a.id);
    try {
      expect(h.brain.store.all("SELECT 1 FROM entities WHERE kind='brief'")).toEqual([]);
    } finally {
      h.release();
    }
  });
});
