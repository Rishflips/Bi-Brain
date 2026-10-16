import { expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedRuntime } from "../../packages/runtime/managed.ts";
import { ManagedSpendingStore } from "../../packages/storage/managed-spending.ts";
import { ManagedReconciliationStore } from "../../packages/storage/managed-reconciliation.ts";
import { ManagedActivationStore } from "../../packages/storage/managed-activation.ts";
import { auditManagedHistory } from "../../packages/runtime/managed-audit.ts";
import { PreparedReasoningProvider, type PreparedEnvelope, type PreparedProvider } from "../../packages/providers/prepared.ts";
import { ManagedWorker } from "../../apps/worker/managed.ts";
import { ManagedDispatchAccounting } from "../../apps/worker/managed-accounting.ts";
import { expectedPreparedConfigHash, readActivationGuardContext } from "../../packages/runtime/managed-activation.ts";

const clock = () => new Date("2026-10-16T09:00:00Z");
const ack = { offline: true as const, workers_terminated: true as const };
function fixture(enrolled = true) {
  const root = mkdtempSync(join(tmpdir(), "brain-activation-guard-parent-"));
  const runtime = new ManagedRuntime(root, { clock });
  const a = runtime.provision("https://synthetic.example.test", "synthetic-guard-a");
  const b = runtime.provision("https://synthetic.example.test", "synthetic-guard-b");
  const money = new ManagedSpendingStore(runtime.control, clock);
  money.setServicePolicy({ daily_micro_usd: 100_000 });
  for (const account of [a, b]) {
    money.setAccountPolicy({ account_id: account.id, per_job_micro_usd: 10_000, user_daily_micro_usd: 100_000 });
    money.configureAccountPeriod({ account_id: account.id, starts_at: "2026-10-16T00:00:00Z", ends_at: "2026-10-17T00:00:00Z", allowance_micro_usd: 100_000 });
  }
  const handle = runtime.acquire(a.id), brain = handle.brain, owner = brain.ownerPrincipal();
  brain.prefs(owner, { ...brain.prefs(owner), time_zone: "UTC", provider_enabled: true, per_job_cap_micro_usd: 10_000, daily_cap_micro_usd: 100_000 });
  const config = {
    model: "synthetic-model-v1", key: "SYNTHETIC_UNUSED_KEY",
    // Intentionally non-alphabetical: the existing prepared hash preserves order.
    accepted_response_models: ["z-synthetic-return-v1", "synthetic-model-v1"],
    max_output_tokens: 100,
    price: { version: "synthetic-price-v1", input_micro_usd_per_million: 10_000, output_micro_usd_per_million: 10_000 },
  };
  const activation = new ManagedActivationStore(runtime.control, root, clock);
  function enroll(expectedVersion: number) {
    const audit = auditManagedHistory({ runtime, root, clock, ...ack });
    expect(audit.ok).toBe(true);
    return activation.enable({
      provider: "openai", model: config.model, price_version: config.price.version,
      input_micro_usd_per_million: config.price.input_micro_usd_per_million,
      output_micro_usd_per_million: config.price.output_micro_usd_per_million,
      accepted_response_models: config.accepted_response_models, max_output_tokens: config.max_output_tokens,
      endpoint_class: "openai_responses", audit_id: audit.audit_id!, expected_version: expectedVersion,
    }, ack);
  }
  new ManagedReconciliationStore(runtime.control, root, clock).initEpoch(ack);
  const profile = enrolled ? enroll(0) : undefined;
  vi.stubEnv("BRAIN_MANAGED_ALLOW_PAID", "1");
  const prepareOnly = new PreparedReasoningProvider(config, async () => { throw new Error("SYNTHETIC_NETWORK_DENIED"); });
  let sends = 0;
  function provider(options: { wrongModel?: boolean; prepare?: () => void; execute?: () => void; unknown?: boolean } = {}): PreparedProvider {
    return { prepareCall(input) {
      const call = prepareOnly.prepareCall(input);
      const source = input.sources[0]!;
      options.prepare?.();
      return {
        identity: options.wrongModel ? Object.freeze({ ...call.identity, model: "synthetic-unenrolled-model" }) : call.identity,
        request_bytes: call.request_bytes,
        async execute(): Promise<PreparedEnvelope> {
          sends++;
          options.execute?.();
          return {
            accounting: options.unknown ? { state: "unknown" } : { state: "known", cost_micro_usd: 7, usage: { input_tokens: 1, output_tokens: 1 }, model: config.model },
            output: { ok: true, kind: "brief", items: [{ text: "Supported synthetic statement", epistemic_status: "supported", evidence: [{ source_id: source.id, source_version: source.version, start: 0, end: 9, quote: "SYNTHETIC" }] }], unknowns: [] },
          };
        },
      };
    } };
  }
  function capture(suffix: string) {
    return brain.capture(owner, { title: `Synthetic ${suffix}`, body: `SYNTHETIC guard evidence ${suffix}` }) as { source_id: string; job: { id: string } };
  }
  async function run(p = provider()) {
    const worker = new ManagedWorker(runtime, { providerFactory: () => p });
    try {
      // Drain both accounts: a different account's harmless queued job must not
      // let a zero-send assertion pass before the target job is attempted.
      for (let tick = 0; tick < 8 && await worker.tick(); tick++) { /* bounded */ }
    } finally { await worker.stop(); }
  }
  return { root, runtime, a, b, money, brain, owner, activation, profile, enroll, capture, provider, run, sends: () => sends,
    close() { vi.unstubAllEnvs(); handle.release(); runtime.close(); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } };
}

it("a transport factory cannot dispatch or create a hold without an enrolled profile", async () => {
  const f = fixture(false);
  try {
    const saved = f.capture("missing profile");
    await f.run();
    expect(f.sends()).toBe(0);
    expect(f.money.latestForJob(f.a.id, saved.job.id)).toBeUndefined();
    expect(f.brain.entities(f.owner, "brief")).toHaveLength(0);
    expect(f.brain.source(f.owner, saved.source_id).body).toContain("SYNTHETIC");
  } finally { f.close(); }
});

it("one enrollment admits two sequential calls and keeps consent through each own marker", async () => {
  const f = fixture();
  try {
    const p = f.provider({ execute() {
      expect(f.brain.prefs(f.owner).provider_enabled).toBe(true);
      expect(f.money.accountStatus(f.a.id).blocked).toBe(true);
    } });
    for (const suffix of ["first", "second"]) {
      const saved = f.capture(suffix);
      await f.run(p);
      expect(f.money.latestForJob(f.a.id, saved.job.id)).toMatchObject({ state: "settled", actual_micro_usd: 7 });
      expect(f.brain.store.get("SELECT status FROM jobs WHERE id=?", saved.job.id)?.status).toBe("succeeded");
    }
    expect(f.sends()).toBe(2);
    expect(f.activation.read()?.version).toBe(f.profile!.version);
  } finally { f.close(); }
});

it("a newly unknown legacy hold on another account denies before creating a new hold", async () => {
  const f = fixture();
  try {
    const other = f.runtime.acquire(f.b.id);
    try {
      const job = other.brain.enqueue("inbox", "derive_brief", { principal: other.brain.ownerPrincipal() });
      other.brain.store.run("INSERT INTO reservations VALUES(?,?,?,?,?)", job.id, "2026-10-16", 10, 0, "held");
    } finally { other.release(); }
    const saved = f.capture("other account history");
    await f.run();
    expect(f.sends()).toBe(0);
    expect(f.money.latestForJob(f.a.id, saved.job.id)).toBeUndefined();
  } finally { f.close(); }
});

it("a correct config hash cannot disguise an unenrolled provider model", async () => {
  const f = fixture();
  try {
    const saved = f.capture("forged model");
    await f.run(f.provider({ wrongModel: true }));
    expect(f.sends()).toBe(0);
    expect(f.money.latestForJob(f.a.id, saved.job.id)).toBeUndefined();
  } finally { f.close(); }
});

it("a mirror removed during the tenant mark prevents IO without refunding either marked hold", async () => {
  const f = fixture();
  try {
    const saved = f.capture("post mark mirror loss");
    f.brain.store.db.function("synthetic_remove_activation_mirror", () => { rmSync(join(f.root, "activation.json")); return 1; });
    f.brain.store.db.exec("CREATE TRIGGER synthetic_remove_mirror AFTER UPDATE OF state ON provider_dispatches WHEN NEW.state='dispatched' BEGIN SELECT synthetic_remove_activation_mirror(); END");
    await f.run();
    expect(f.sends()).toBe(0);
    expect(f.money.latestForJob(f.a.id, saved.job.id)).toMatchObject({ state: "dispatched", actual_micro_usd: null });
    expect(f.brain.store.get("SELECT state,actual_micro_usd FROM provider_dispatches WHERE job_id=?", saved.job.id)).toMatchObject({ state: "dispatched", actual_micro_usd: null });
    expect(f.money.accountStatus(f.b.id).blocked).toBe(true);
  } finally { f.close(); }
});

it("disable after IO starts retains the known charge and discards the generated brief", async () => {
  const f = fixture();
  try {
    const saved = f.capture("disable in flight");
    await f.run(f.provider({ execute() { f.activation.disable(f.profile!.version); } }));
    expect(f.sends()).toBe(1);
    expect(f.money.latestForJob(f.a.id, saved.job.id)).toMatchObject({ state: "settled", actual_micro_usd: 7 });
    expect(f.brain.store.get("SELECT state,actual_micro_usd FROM provider_dispatches WHERE job_id=?", saved.job.id)).toMatchObject({ state: "settled", actual_micro_usd: 7 });
    expect(f.brain.entities(f.owner, "brief")).toHaveLength(0);
    expect(f.brain.store.get("SELECT status FROM jobs WHERE id=?", saved.job.id)?.status).not.toBe("succeeded");
  } finally { f.close(); }
});

it("tenant-only edits to an enrolled baseline deny a later send even when central money matches", async () => {
  const f = fixture();
  try {
    const prior = f.capture("baseline seed");
    await f.run();
    expect(f.sends()).toBe(1);
    expect(f.money.latestForJob(f.a.id, prior.job.id)).toMatchObject({ state: "settled" });
    f.enroll(f.profile!.version);
    f.brain.store.run("UPDATE provider_dispatches SET created_at=? WHERE job_id=?", "2026-10-15T09:00:00.000Z", prior.job.id);
    const next = f.capture("after baseline tamper");
    await f.run();
    expect(f.sends()).toBe(1);
    expect(f.money.latestForJob(f.a.id, next.job.id)).toBeUndefined();
  } finally { f.close(); }
});

it("an expired actual job lease refuses admission before inserting a central hold", async () => {
  const f = fixture();
  try {
    const saved = f.capture("expired before admission");
    await f.run(f.provider({ prepare() {
      f.brain.store.run("UPDATE jobs SET lease_until=? WHERE id=?", "2026-10-16T08:00:00.000Z", saved.job.id);
    } }));
    expect(f.sends()).toBe(0);
    expect(f.money.latestForJob(f.a.id, saved.job.id)).toBeUndefined();
  } finally { f.close(); }
});

it("lease expiry during the tenant mark prevents IO and retains the marked hold", async () => {
  const f = fixture();
  try {
    const saved = f.capture("expired after mark");
    f.brain.store.db.exec("CREATE TRIGGER synthetic_expire_after_mark AFTER UPDATE OF state ON provider_dispatches WHEN NEW.state='dispatched' BEGIN UPDATE jobs SET lease_until='2026-10-16T08:00:00.000Z' WHERE id=NEW.job_id; END");
    await f.run();
    expect(f.sends()).toBe(0);
    expect(f.money.latestForJob(f.a.id, saved.job.id)).toMatchObject({ state: "dispatched", actual_micro_usd: null });
  } finally { f.close(); }
});

it("a fresh coordinator cannot acquire an older coordinator's reserved attempt by knowing its call id", () => {
  const f = fixture();
  try {
    const saved = f.capture("stranded reservation");
    const lease = { job_id: saved.job.id, owner: "synthetic-worker", fence: 1, expires_at: "2026-10-16T09:30:00.000Z" };
    f.brain.store.run("UPDATE jobs SET status='running',lease_owner=?,fence=?,lease_until=? WHERE id=?", lease.owner, lease.fence, lease.expires_at, saved.job.id);
    const installed = { root: f.root, profile: f.profile! };
    const first = new ManagedDispatchAccounting(f.money, f.brain, clock, installed);
    const record = first.reserve({
      job_id: saved.job.id, dispatch_key: "reasoning", stage: "reasoning", provider: f.profile!.provider,
      model: f.profile!.model, price_version: f.profile!.price_version, request_hash: "a".repeat(64),
      config_hash: expectedPreparedConfigHash(f.profile!, "brief"), reserved_micro_usd: 100,
    }, lease, { per_job_micro_usd: 10_000, daily_micro_usd: 100_000, time_zone: "UTC" });
    const successor = new ManagedDispatchAccounting(f.money, f.brain, clock, installed);
    expect(() => successor.markDispatched(record.call_id, lease)).toThrow();
    expect(f.money.latestForJob(f.a.id, saved.job.id)).toMatchObject({ state: "reserved", actual_micro_usd: null });
  } finally { f.close(); }
});

it("a changed control schema shape invalidates enrollment even when its integer version was not changed", async () => {
  const f = fixture();
  try {
    f.runtime.control.db.exec("ALTER TABLE managed_reservations ADD COLUMN synthetic_future_contract TEXT");
    const saved = f.capture("changed schema shape");
    await f.run();
    expect(f.sends()).toBe(0);
    expect(f.money.latestForJob(f.a.id, saved.job.id)).toBeUndefined();
  } finally { f.close(); }
});

it.each([
  { provider: "synthetic-other-provider" },
  { model: "synthetic-unenrolled-model" },
  { price_version: "synthetic-unenrolled-price" },
  { request_hash: "b".repeat(64) },
  { reserved_micro_usd: 0 },
])("a guarded reservation cannot substitute immutable identity fields: %j", (change) => {
  const f = fixture();
  try {
    const saved = f.capture("reserve identity substitution");
    const lease = { job_id: saved.job.id, owner: "synthetic-worker", fence: 1, expires_at: "2026-10-16T09:30:00.000Z" };
    f.brain.store.run("UPDATE jobs SET status='running',lease_owner=?,fence=?,lease_until=? WHERE id=?", lease.owner, lease.fence, lease.expires_at, saved.job.id);
    const spec = {
      account_id: f.a.id, job_id: saved.job.id, dispatch_key: "reasoning", stage: "reasoning" as const,
      provider: f.profile!.provider, model: f.profile!.model, price_version: f.profile!.price_version,
      request_hash: "a".repeat(64), config_hash: expectedPreparedConfigHash(f.profile!, "brief"), reserved_micro_usd: 100,
      limits: { per_job_micro_usd: 10_000, user_daily_micro_usd: 100_000, time_zone: "UTC" },
    };
    const guard = readActivationGuardContext({
      control: f.runtime.control, installed: { root: f.root, profile: f.profile! }, accountId: f.a.id,
      kind: "brief", jobId: saved.job.id, dispatchKey: "reasoning", stage: "reasoning", lease,
      phase: "before_reserve", centralCallId: null, tenantCallId: null, spec,
    });
    expect(() => f.money.reserve({ ...spec, ...change }, guard)).toThrow();
    expect(f.money.latestForJob(f.a.id, saved.job.id)).toBeUndefined();
  } finally { f.close(); }
});

it("a valid lease for another job cannot authorize a new central reservation", () => {
  const f = fixture();
  try {
    const leased = f.capture("leased job"), unleased = f.capture("different unleased job");
    const lease = { job_id: leased.job.id, owner: "synthetic-worker", fence: 1, expires_at: "2026-10-16T09:30:00.000Z" };
    f.brain.store.run("UPDATE jobs SET status='running',lease_owner=?,fence=?,lease_until=? WHERE id=?", lease.owner, lease.fence, lease.expires_at, leased.job.id);
    const coordinator = new ManagedDispatchAccounting(f.money, f.brain, clock, { root: f.root, profile: f.profile! });
    expect(() => coordinator.reserve({
      job_id: unleased.job.id, dispatch_key: "reasoning", stage: "reasoning", provider: f.profile!.provider,
      model: f.profile!.model, price_version: f.profile!.price_version, request_hash: "a".repeat(64),
      config_hash: expectedPreparedConfigHash(f.profile!, "brief"), reserved_micro_usd: 100,
    }, lease, { per_job_micro_usd: 10_000, daily_micro_usd: 100_000, time_zone: "UTC" })).toThrow();
    expect(f.money.latestForJob(f.a.id, unleased.job.id)).toBeUndefined();
  } finally { f.close(); }
});
