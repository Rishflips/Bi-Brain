import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../apps/server/app.ts";
import {
  ManagedRuntime,
  type ManagedHandle,
} from "../../packages/runtime/managed.ts";
import { ManagedSpendingStore } from "../../packages/storage/managed-spending.ts";
import { DispatchLedger } from "../../packages/storage/spend.ts";
import type { Preferences } from "../../packages/contracts/index.ts";
import type {
  DispatchSpec,
  JobLease,
  SpendLimits,
} from "../../packages/domain/spend.ts";
import type {
  ManagedDispatchSpec,
  ManagedLimits,
} from "../../packages/domain/managed-spend.ts";

/**
 * Independent review of the managed central money view.
 *
 * Every case drives the real `ManagedRuntime` (real per-tenant SQLite, real
 * control store), the real `ManagedSpendingStore`, real `Brain` handles and the
 * real Fastify handlers through `app.inject`. Browser identity comes only from
 * an opaque control-store session (`control.issueSession`) presented as a
 * cookie: no tenant identity header or payload claim is ever trusted. No model
 * or network provider is constructed and all fixtures are synthetic.
 *
 * The central ledger is the single authority. The tenant `DispatchLedger` is a
 * conservative projection, so a settled central charge must win over a stale
 * held tenant row, and the public view must never expose the singleton service
 * cap, the service-wide committed total or another account's identifiers.
 */

const ORIGIN = "https://brain.example.test";
const HOST = "brain.example.test";
const ISSUER = "https://issuer.synthetic.test";
const NOW = "2026-10-16T09:00:00Z";
const CLOCK = () => new Date(NOW);

const TENANT_LIMITS: SpendLimits = {
  per_job_micro_usd: 1000,
  daily_micro_usd: 1000,
  time_zone: "UTC",
};
const CENTRAL_LIMITS: ManagedLimits = {
  per_job_micro_usd: 1000,
  user_daily_micro_usd: 1000,
  time_zone: "UTC",
};
const FORBIDDEN_MONEY_KEYS = [
  "service",
  "service_policy",
  "service_day_micro_usd",
  "service_daily_cap_micro_usd",
];

type Tracked = {
  app?: Awaited<ReturnType<typeof createApp>>;
  runtime: ManagedRuntime;
  root: string;
  releases: Array<() => void>;
};
const tracked: Tracked[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  const entries = tracked.splice(0);
  let failure: unknown;
  for (const entry of entries) {
    for (const release of entry.releases.splice(0)) {
      try {
        release();
      } catch (error) {
        failure ??= error;
      }
    }
    if (entry.app) {
      try {
        await entry.app.close();
      } catch (error) {
        failure ??= error;
      }
    }
    // A pinned handle would make this throw; that must surface, never be hidden.
    try {
      entry.runtime.close();
    } catch (error) {
      failure ??= error;
    }
    try {
      rmSync(entry.root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) throw failure;
});

function harness(): Tracked {
  const root = mkdtempSync(join(tmpdir(), "bibrain-managed-money-view-"));
  const runtime = new ManagedRuntime(root, { clock: CLOCK });
  const entry: Tracked = { runtime, root, releases: [] };
  tracked.push(entry);
  return entry;
}

function pin(entry: Tracked, tenantId: string): ManagedHandle {
  const handle = entry.runtime.acquire(tenantId);
  entry.releases.push(handle.release);
  return handle;
}

async function buildApp(entry: Tracked) {
  const app = await createApp(undefined, {
    managed: entry.runtime,
    publicOrigin: ORIGIN,
    static: false,
  });
  entry.app = app;
  return app;
}

function grantAccount(
  central: ManagedSpendingStore,
  accountId: string,
  allowance = 1000,
) {
  central.configureAccountPeriod({
    account_id: accountId,
    starts_at: "2026-10-16T00:00:00Z",
    ends_at: "2026-10-17T00:00:00Z",
    allowance_micro_usd: allowance,
  });
  central.setAccountPolicy({
    account_id: accountId,
    per_job_micro_usd: allowance,
    user_daily_micro_usd: allowance,
  });
}

function setPrefs(handle: ManagedHandle, over: Partial<Preferences> = {}) {
  const owner = handle.brain.ownerPrincipal();
  const current = handle.brain.prefs(owner);
  return handle.brain.prefs(owner, {
    ...current,
    time_zone: "UTC",
    daily_cap_micro_usd: 1000,
    per_job_cap_micro_usd: 1000,
    provider_enabled: false,
    ...over,
  });
}

function tenantSpec(jobId: string, amount = 10): DispatchSpec {
  return {
    job_id: jobId,
    dispatch_key: "reasoning",
    stage: "reasoning",
    reserved_micro_usd: amount,
    provider: "synthetic",
    model: "synthetic",
    price_version: "synthetic-v1",
    request_hash: "a".repeat(64),
    config_hash: "b".repeat(64),
  };
}

function centralSpec(
  accountId: string,
  spec: DispatchSpec,
  limits: ManagedLimits = CENTRAL_LIMITS,
): ManagedDispatchSpec {
  return { account_id: accountId, ...spec, limits };
}

/** Promotes a queued tenant job to a real running lease, as the worker does. */
function runningLease(
  handle: ManagedHandle,
  jobId: string,
  owner = "synthetic-worker",
  until = "2026-10-16T09:30:00Z",
): JobLease {
  handle.brain.store.run(
    "UPDATE jobs SET status='running',lease_owner=?,lease_until=?,fence=?,attempts=attempts+1 WHERE id=?",
    owner,
    until,
    1,
    jobId,
  );
  return { job_id: jobId, owner, fence: 1, expires_at: until };
}

function deepValues(value: unknown, out: unknown[] = []): unknown[] {
  if (Array.isArray(value)) {
    for (const item of value) deepValues(item, out);
  } else if (value && typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>))
      deepValues(nested, out);
  } else {
    out.push(value);
  }
  return out;
}

function expectCode(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (error) {
    expect((error as { code?: string }).code).toBe(code);
    return;
  }
  throw new Error(`Expected BrainError ${code}`);
}

it("public remaining and cap values respect the user's lower limits, not only operator ceilings", async () => {
  const entry = harness();
  const account = await entry.runtime.provision(ISSUER, "synthetic-lower-limits");
  const central = new ManagedSpendingStore(entry.runtime.control, CLOCK);
  central.setServicePolicy({ daily_micro_usd: 1000 });
  grantAccount(central, account.id);
  const handle = pin(entry, account.id);
  setPrefs(handle);
  const paid = central.reserve(centralSpec(account.id, tenantSpec("synthetic-prior-call")));
  central.mark(paid.call_id, CENTRAL_LIMITS);
  central.settleKnown(paid.call_id, 5);
  setPrefs(handle, { daily_cap_micro_usd: 10, per_job_cap_micro_usd: 3 });
  expect(handle.brain.status(handle.brain.ownerPrincipal()).spend).toMatchObject({
    actual: 5, reserved: 0, daily_limit_micro_usd: 10, per_job_limit_micro_usd: 3, remaining_micro_usd: 5,
  });
});

it("service capacity is unavailable when its shared cap is exhausted without exposing the total", async () => {
  const entry = harness();
  const a = await entry.runtime.provision(ISSUER, "synthetic-capacity-a");
  const b = await entry.runtime.provision(ISSUER, "synthetic-capacity-b");
  const central = new ManagedSpendingStore(entry.runtime.control, CLOCK);
  central.setServicePolicy({ daily_micro_usd: 10 });
  grantAccount(central, a.id);
  grantAccount(central, b.id);
  const bh = pin(entry, b.id);
  setPrefs(bh);
  const held = central.reserve(centralSpec(a.id, tenantSpec("synthetic-service-full")));
  central.mark(held.call_id, CENTRAL_LIMITS);
  const view = bh.brain.status(bh.brain.ownerPrincipal()).spend;
  expect(view.configured).toBe(true);
  expect(view.service_available).toBe(false);
  expect(JSON.stringify(view)).not.toContain("service_day_micro_usd");
});

describe("managed money view (independent review)", () => {
  it("reports only the own-account central settlement while hiding the stale tenant hold, the other account and the global service figures", async () => {
    const entry = harness();
    const a = entry.runtime.provision(ISSUER, "synthetic-a");
    const b = entry.runtime.provision(ISSUER, "synthetic-b");
    const central = new ManagedSpendingStore(entry.runtime.control, CLOCK);
    central.setServicePolicy({ daily_micro_usd: 1000 });
    grantAccount(central, a.id);
    grantAccount(central, b.id);

    const handleA = pin(entry, a.id);
    const ownerA = handleA.brain.ownerPrincipal();
    setPrefs(handleA);
    const handleB = pin(entry, b.id);
    const ownerB = handleB.brain.ownerPrincipal();
    setPrefs(handleB);

    // A: a real tenant dispatch journal is held at 10 (stale projection).
    const jobA = handleA.brain.enqueue("inbox", "derive_brief", {
      principal: ownerA,
    });
    const leaseA = runningLease(handleA, jobA.id);
    const tenantLedger = new DispatchLedger(handleA.brain.store, CLOCK);
    const tenantA = tenantLedger.reserve(tenantSpec(jobA.id, 10), leaseA, TENANT_LIMITS);
    tenantLedger.markDispatched(tenantA.call_id, leaseA);
    expect(tenantA.state).toBe("reserved");

    // The central authority is the truth: the matching slot is settled at 5
    // centrally only, so the tenant projection stays held at 10.
    const specA = centralSpec(a.id, tenantSpec(jobA.id, 10));
    const centralA = central.reserve(specA);
    central.linkProjection(centralA.call_id, tenantA.call_id);
    central.mark(centralA.call_id, CENTRAL_LIMITS);
    central.settleKnown(centralA.call_id, 5);
    expect(central.receiptByProjection(tenantA.call_id)).toMatchObject({
      state: "settled",
      actual_micro_usd: 5,
    });
    expect(tenantLedger.get(tenantA.call_id)!.state).toBe("dispatched");

    // B: an unrelated dispatched central hold of 20, never settled.
    const centralB = central.reserve(
      centralSpec(b.id, tenantSpec("job-b", 20)),
    );
    central.mark(centralB.call_id, CENTRAL_LIMITS);

    // A's own view follows the centre, not its tenant projection.
    const statusA = handleA.brain.status(ownerA);
    expect({
      actual: statusA.spend.actual,
      reserved: statusA.spend.reserved,
    }).toEqual({ actual: 5, reserved: 0 });
    expect({
      settled: statusA.spend.settled_micro_usd,
      unresolved: statusA.spend.unresolved_micro_usd,
      committed: statusA.spend.committed_micro_usd,
    }).toEqual({ settled: 5, unresolved: 0, committed: 5 });
    expect(statusA.spend.time_zone).toBe("UTC");
    expect(statusA.spend.budget_day).toBe("2026-10-16");
    expect(statusA.spend.configured).toBe(true);
    expect(statusA.spend.available).toBe(false);
    expect(statusA.spend.service_available).toBe(true);

    // Private, own-period metadata is allowed; the shared service dimension is
    // reduced to a bare boolean and is never a cap or a committed total.
    for (const key of FORBIDDEN_MONEY_KEYS)
      expect(key in statusA.spend).toBe(false);
    expect(statusA.spend.allowance!.limit_micro_usd).toBe(1000);
    expect(statusA.spend.allowance!.committed_micro_usd).toBe(5);
    expect(statusA.spend.allowance!.remaining_micro_usd).toBe(995);
    expect(JSON.stringify(statusA.spend)).not.toContain(b.id);
    expect(deepValues(statusA.spend)).not.toContain(25);

    // The internal status still carries the global figures the public view strips.
    const rawA = central.accountStatus(a.id);
    expect(rawA.service?.daily_micro_usd).toBe(1000);
    expect(rawA.committed.service_day_micro_usd).toBe(25);
    expect("service" in rawA).toBe(true);

    // B sees only its own 20 hold, never A's settled 5.
    const statusB = handleB.brain.status(ownerB);
    expect({
      actual: statusB.spend.actual,
      reserved: statusB.spend.reserved,
    }).toEqual({ actual: 0, reserved: 20 });
    expect(statusB.spend.allowance!.committed_micro_usd).toBe(20);
    expect(JSON.stringify(statusB.spend)).not.toContain(a.id);

    // The same own-account figures come through the real HTTP handler.
    const app = await buildApp(entry);
    const session = entry.runtime.control.issueSession(a.id);
    const today = await app.inject({
      url: "/api/v1/today",
      headers: { host: HOST, cookie: `brain_session=${session.token}` },
    });
    expect(today.statusCode).toBe(200);
    const spend = today.json().status.spend;
    expect({ actual: spend.actual, reserved: spend.reserved }).toEqual({
      actual: 5,
      reserved: 0,
    });
    for (const key of FORBIDDEN_MONEY_KEYS) expect(key in spend).toBe(false);
    expect(deepValues(spend)).not.toContain(25);
    expect(today.body).not.toContain(b.id);
  });

  it("denies a suspended account's status and HTTP reads but still settles an already-dispatched central call", async () => {
    const entry = harness();
    const a = entry.runtime.provision(ISSUER, "synthetic-suspended");
    const central = new ManagedSpendingStore(entry.runtime.control, CLOCK);
    central.setServicePolicy({ daily_micro_usd: 1000 });
    grantAccount(central, a.id);

    // The handle is pinned while the account is still usable.
    const handle = pin(entry, a.id);
    const owner = handle.brain.ownerPrincipal();
    setPrefs(handle);

    // A separate call that already reached `dispatched` before revocation.
    const dispatched = central.reserve(
      centralSpec(a.id, tenantSpec("job-already-sent", 6)),
    );
    central.mark(dispatched.call_id, CENTRAL_LIMITS);

    const app = await buildApp(entry);
    const session = entry.runtime.control.issueSession(a.id);

    // Real trusted revocation through the control store, not a mocked liveness.
    entry.runtime.control.setAccountState(a.id, "suspended");
    expect(entry.runtime.control.account(a.id)!.state).toBe("suspended");

    // The already-acquired handle can no longer read status or money.
    expectCode(() => handle.brain.status(owner), "UNAUTHORIZED");

    const today = await app.inject({
      url: "/api/v1/today",
      headers: { host: HOST, cookie: `brain_session=${session.token}` },
    });
    expect([401, 403]).toContain(today.statusCode);
    expect(today.body).not.toContain("actual");

    // Known actual for an already-dispatched call is retained after revocation;
    // no financial history is lost because the account is no longer active.
    const settled = central.settleKnown(dispatched.call_id, 4);
    expect(settled).toMatchObject({ state: "settled", actual_micro_usd: 4 });
    expect(central.readReceipt(dispatched.call_id).actual_micro_usd).toBe(4);
  });

  it("keeps connected processing unavailable and refuses a paid preference even with a configured policy and the allow flag", async () => {
    const entry = harness();
    const a = entry.runtime.provision(ISSUER, "synthetic-activation");
    const central = new ManagedSpendingStore(entry.runtime.control, CLOCK);
    central.setServicePolicy({ daily_micro_usd: 1000 });
    grantAccount(central, a.id);

    const app = await buildApp(entry);
    vi.stubEnv("BRAIN_MANAGED_ALLOW_PAID", "1");

    const meta = await app.inject({
      url: "/api/v1/runtime",
      headers: { host: HOST },
    });
    expect(meta.statusCode).toBe(200);
    expect(meta.json().connected_processing_available).toBe(false);

    const session = entry.runtime.control.issueSession(a.id);
    const headers = {
      host: HOST,
      cookie: `brain_session=${session.token}`,
      "x-brain-csrf": session.csrf,
    };
    const current = (
      await app.inject({
        url: "/api/v1/preferences/background",
        headers: { host: HOST, cookie: headers.cookie },
      })
    ).json();

    // A real cookie + CSRF request is still refused while the worker denies.
    const denied = await app.inject({
      method: "PATCH",
      url: "/api/v1/preferences/background",
      headers,
      payload: { ...current, provider_enabled: true },
    });
    expect(denied.statusCode).toBe(503);
    expect(denied.json().error.code).toBe("PROVIDER_UNAVAILABLE");

    // Unrelated preferences and explicit capture keep working with no provider.
    const unrelated = await app.inject({
      method: "PATCH",
      url: "/api/v1/preferences/background",
      headers,
      payload: { ...current, provider_enabled: false, digest_hour: 7 },
    });
    expect(unrelated.statusCode).toBe(200);
    expect(unrelated.json().digest_hour).toBe(7);

    const saved = await app.inject({
      method: "POST",
      url: "/api/v1/sources",
      headers,
      payload: {
        project_id: "inbox",
        title: "activation review",
        body: "SYNTHETIC_ACTIVATION_CAPTURE",
      },
    });
    expect(saved.statusCode).toBe(201);

    vi.unstubAllEnvs();
  });

  it("returns safe zeros for a fresh managed account with no operator policy and still accepts capture", async () => {
    const entry = harness();
    const fresh = entry.runtime.provision(ISSUER, "synthetic-fresh");
    const handle = pin(entry, fresh.id);
    const owner = handle.brain.ownerPrincipal();

    const status = handle.brain.status(owner);
    expect({
      actual: status.spend.actual,
      reserved: status.spend.reserved,
    }).toEqual({ actual: 0, reserved: 0 });
    expect(status.spend.configured).toBe(false);
    expect(status.spend.available).toBe(false);
    expect(status.spend.service_available).toBe(false);
    expect(status.spend.blocked).toBe(false);
    expect(status.spend.allowance!.limit_micro_usd).toBe(0);
    // Unconfigured money is never advertised as ready.
    expect(status.mode).toBe("Extractive preview");

    const app = await buildApp(entry);
    const session = entry.runtime.control.issueSession(fresh.id);
    const saved = await app.inject({
      method: "POST",
      url: "/api/v1/sources",
      headers: {
        host: HOST,
        cookie: `brain_session=${session.token}`,
        "x-brain-csrf": session.csrf,
      },
      payload: {
        project_id: "inbox",
        title: "fresh capture",
        body: "SYNTHETIC_FRESH_CAPTURE",
      },
    });
    expect([200, 201]).toContain(saved.statusCode);

    const meta = await app.inject({
      url: "/api/v1/runtime",
      headers: { host: HOST },
    });
    expect(meta.json().connected_processing_available).toBe(false);
  });
});
