import { expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { ManagedRuntime, managedCapability, managedDecisionCapability } from "../../packages/runtime/managed.ts";
import { ManagedSpendingStore } from "../../packages/storage/managed-spending.ts";
import { ManagedReconciliationStore } from "../../packages/storage/managed-reconciliation.ts";
import { ManagedActivationStore } from "../../packages/storage/managed-activation.ts";
import { ManagedDecisionActivationStore } from "../../packages/storage/managed-decision-activation.ts";
import { auditManagedHistory } from "../../packages/runtime/managed-audit.ts";
import { writeWorkerReadiness, readWorkerReadiness } from "../../packages/runtime/worker-readiness.ts";
import { writeDecisionReadiness, readDecisionReadiness } from "../../packages/runtime/decision-worker-readiness.ts";
import { Worker } from "../../apps/worker/engine.ts";

/**
 * Real `apps/worker/main.ts` subprocess over a disposable managed root.
 *
 * The worker child is the ONLY process that loads the fake-fetch preload
 * (`tests/helpers/decision-provider-preload.mjs`), which allows exactly the two
 * official enrolled endpoints (TypeSafe decision + OpenAI Responses) and throws
 * for every other call. Storage, accounting, readiness, consent and monetary
 * guards are real and never intercepted. All accounts are provisioned and audited
 * BEFORE the child boots. No real key, owner account, network or paid call.
 */

const WORKER_ENTRY = "apps/worker/main.ts";
const PRELOAD_URL = pathToFileURL(
  resolve("tests/helpers/decision-provider-preload.mjs"),
).href;
const ISSUER = "https://issuer.synthetic.test";
const ORIGIN = "https://brain.synthetic.test";
const DUMMY_OPENAI = "SYNTHETIC_DUMMY_OPENAI_KEY_NOT_REAL";
const DUMMY_DECISION = "SYNTHETIC_DUMMY_DECISION_KEY_NOT_REAL";
const ACK = { offline: true as const, workers_terminated: true as const };
/**
 * An EXPLICIT OS/runtime allowlist for the child process, never the full operator
 * environment. No operator `.env` is read and no real key/secret is copied. Only
 * the synthetic extras and the fixture `NODE_OPTIONS` are added.
 */
const OS_ENV_ALLOWLIST = [
  "PATH", "Path", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP",
  "USERPROFILE", "HOME", "PATHEXT", "ComSpec",
] as const;
function sanitizedEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of OS_ENV_ALLOWLIST)
    if (process.env[key] !== undefined) env[key] = process.env[key];
  return { ...env, ...extra, NODE_OPTIONS: `--import ${PRELOAD_URL}` };
}
type Child = { child: ChildProcess; output: () => string; closed: Promise<void> };
function startWorker(env: NodeJS.ProcessEnv): Child {
  const child = spawn(process.execPath, ["--import", "tsx", WORKER_ENTRY], {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  const collect = (chunk: Buffer) => {
    if (output.length < 20_000) output += chunk.toString("utf8");
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  // Capture the REAL close promise at spawn time. `close` (all stdio closed) is the
  // only sound signal that the OS has released this child's handles; `exit` and an
  // `exitCode !== null` check fire BEFORE the stdio pipes/DB handles are released.
  const closed = new Promise<void>((resolveClosed, rejectClosed) => {
    child.once("close", () => resolveClosed());
    child.once("error", (error) => rejectClosed(error));
  });
  return { child, output: () => output, closed };
}
async function stopWorker(handle: Child | undefined): Promise<void> {
  if (!handle) return;
  const { child, closed } = handle;
  if (child.exitCode === null && child.signalCode === null) child.kill();
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 8000);
  try {
    await closed;
  } finally {
    clearTimeout(timer);
  }
}
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const counterLines = (file: string): string[] =>
  existsSync(file)
    ? readFileSync(file, "utf8").slice(0, 8192).split("\n").filter((l) => l.trim() !== "")
    : [];
/** Read-only snapshot of the disposable tenant database while the child runs. */
function tenant(root: string, accountId: string) {
  const db = new DatabaseSync(join(root, accountId, "brain.sqlite"), {
    readOnly: true,
  });
  return {
    dispatches: (jobId: string) =>
      db
        .prepare(
          "SELECT stage,dispatch_key,state,actual_micro_usd FROM provider_dispatches WHERE job_id=? ORDER BY stage",
        )
        .all(jobId) as any[],
    job: (jobId: string) =>
      db
        .prepare(
          "SELECT status,attempts,fence,lease_owner,lease_until,deadline_at FROM jobs WHERE id=?",
        )
        .get(jobId) as any,
    jobByKind: (kind: string) =>
      db
        .prepare(
          "SELECT id,status,result_id FROM jobs WHERE kind=? ORDER BY created_at DESC LIMIT 1",
        )
        .get(kind) as any,
    entities: (kind: string) =>
      (db.prepare("SELECT data FROM entities WHERE kind=?").all(kind) as any[]).map(
        (r) => JSON.parse(r.data),
      ),
    close: () => db.close(),
  };
}
async function waitFor<T>(
  timeoutMs: number,
  handle: Child,
  probe: () => T | undefined,
  label: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (handle.child.exitCode !== null || handle.child.signalCode !== null)
      throw new Error(`${label}: worker exited early:\n${handle.output()}`);
    let value: T | undefined;
    try {
      value = probe();
    } catch {
      value = undefined;
    }
    if (value !== undefined) return value;
    await delay(150);
  }
  throw new Error(`timed out waiting for ${label}:\n${handle.output()}`);
}
/** A child-independent bounded poll (for read-only DB/lease waits between boots). */
async function pollUntil<T>(
  timeoutMs: number,
  probe: () => T | undefined,
  label: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let value: T | undefined;
    try {
      value = probe();
    } catch {
      value = undefined;
    }
    if (value !== undefined) return value;
    await delay(200);
  }
  throw new Error(`timed out waiting for ${label}`);
}
async function cleanup(base: string): Promise<void> {
  let last: any;
  // Bounded escalation (about 10 s) over a Windows-only transient handle: a killed
  // worker can briefly outlive a synchronous vault `git` grandchild whose CWD sits
  // inside this root, so the tree is not removable for a short window. The event
  // loop is yielded between attempts so pending child `close`/stdio callbacks run.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      rmSync(base, { recursive: true, force: true, maxRetries: 0 });
      return;
    } catch (error: any) {
      last = error;
      await delay(250);
    }
  }
  // Data-free diagnosis; a retained root is a real failure, never a passing warn.
  const rawPath = typeof last?.path === "string" ? last.path : "";
  const rel = rawPath
    ? relative(base, rawPath).split(sep).slice(0, 2).join("/")
    : "unreported";
  throw new Error(
    `decision fixture cleanup failed code=${String(last?.code ?? "?")} entry=${rel}`,
  );
}

type Setup = { root: string; accountA: string; accountB: string; jobId: string; goalId: string; sourceId: string; seedBootId: string };
async function provision(root: string, decisionTimeoutMs: number): Promise<Setup> {
  const runtime = new ManagedRuntime(root, {
    capability: () => {
      const c = managedCapability({ control: runtime.control, root: runtime.root, now: new Date(), optIn: true });
      return { ready: c.available, reason: c.reason };
    },
    decisionCapability: () => {
      const c = managedDecisionCapability({ control: runtime.control, root: runtime.root, now: new Date(), optIn: true });
      return { ready: c.available, reason: c.reason };
    },
  });
  try {
  const a = runtime.provision(ISSUER, "advisory-process-a");
  const b = runtime.provision(ISSUER, "advisory-process-b");
  const money = new ManagedSpendingStore(runtime.control);
  money.setServicePolicy({ daily_micro_usd: 1_000_000 });
  for (const account of [a, b]) {
    money.setAccountPolicy({ account_id: account.id, per_job_micro_usd: 100_000, user_daily_micro_usd: 1_000_000 });
    money.configureAccountPeriod({ account_id: account.id, starts_at: "2026-01-01T00:00:00Z", ends_at: "2030-01-01T00:00:00Z", allowance_micro_usd: 1_000_000 });
  }
  new ManagedReconciliationStore(runtime.control, root).initEpoch(ACK);
  const audit = auditManagedHistory({ runtime, root, ...ACK });
  if (!audit.ok) throw new Error(`synthetic audit failed: ${audit.reason}`);
  const d = new ManagedDecisionActivationStore(runtime.control, root).enable({
    provider: "typesafe", model: "jev-synthetic-v1", endpoint: "https://api.typesafe.ai/v1/systemone",
    accepted_response_models: ["jev-synthetic-v1"], price_version: "synthetic-decision-price-v1",
    input_micro_usd_per_million: 10_000, output_micro_usd_per_million: 0, timeout_ms: decisionTimeoutMs,
    max_request_bytes: 1_048_576, max_response_bytes: 262_144, audit_id: audit.audit_id!, expected_version: 0,
  }, ACK);
  const r = new ManagedActivationStore(runtime.control, root).enable({
    provider: "openai", model: "synthetic-reasoning-v1", accepted_response_models: ["synthetic-reasoning-v1"],
    price_version: "synthetic-reasoning-price-v1", input_micro_usd_per_million: 10_000, output_micro_usd_per_million: 10_000,
    max_output_tokens: 100, endpoint_class: "openai_responses", audit_id: audit.audit_id!, expected_version: 0,
  }, ACK);
  // A throwaway in-process readiness lease lets the fixture enable D consent through
  // the REAL decision capability; the child replaces it with its own boot id.
  const bootId = randomUUID();
  const now = new Date();
  const dates = { booted_at: now.toISOString(), heartbeat_at: now.toISOString(), expires_at: new Date(now.getTime() + 15_000).toISOString() };
  writeDecisionReadiness(root, { schema: 1, worker_id: bootId, stage_scope: "decision", provider_family: d.provider,
    endpoint_digest: d.endpoint_digest, epoch: d.epoch, root_nonce: d.root_nonce, activation_fingerprint: d.fingerprint,
    config_digest: d.config_digest, model: d.model, price_version: d.price_version, ...dates });
  writeWorkerReadiness(root, { schema: 1, worker_id: bootId, epoch: r.epoch, root_nonce: r.root_nonce,
    activation_fingerprint: r.fingerprint, config_digest: r.config_digest, provider: r.provider, model: r.model,
    price_version: r.price_version, endpoint_class: r.endpoint_class, ...dates });
  const handle = runtime.acquire(a.id);
  let jobId = "";
  let goalId = "";
  let sourceId = "";
  try {
    const brain = handle.brain;
    const owner = brain.ownerPrincipal();
    sourceId = brain.capture(owner, { title: "SYNTHETIC process evidence", body: "SYNTHETIC_PROCESS_EVIDENCE: ship the beta.", visibility: "project" }).source_id;
    // Drain the extractive derive_brief job BEFORE enabling paid consent.
    const seed = new Worker(brain);
    while (await seed.tick()) {
      /* bounded extractive only */
    }
    const created = brain.goal(owner, { project_id: "inbox", title: "SYNTHETIC ship beta", success_criteria: "Review the beta evidence" });
    const goal = brain.editGoal(owner, created.id, { expected_version: created.version, preparation_enabled: true });
    goalId = goal.id;
    brain.prefs(owner, { ...brain.prefs(owner), enabled: true, provider_enabled: true, decision_provider_enabled: true,
      time_zone: "UTC", per_job_cap_micro_usd: 100_000, daily_cap_micro_usd: 1_000_000 });
    jobId = brain.prepare(owner, goal.id).id;
  } finally {
    handle.release();
  }
  return { root, accountA: a.id, accountB: b.id, jobId, goalId, sourceId, seedBootId: bootId };
  } finally {
    runtime.close();
  }
}
function workerEnv(root: string, counter: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return sanitizedEnv({
    BRAIN_MODE: "managed",
    BRAIN_MANAGED_ROOT: root,
    BRAIN_PUBLIC_ORIGIN: ORIGIN,
    BRAIN_OIDC_ISSUER: ISSUER,
    BRAIN_OIDC_CLIENT_ID: "synthetic-managed-client",
    BRAIN_OIDC_CLIENT_SECRET: "synthetic-managed-client-secret",
    BRAIN_MANAGED_ALLOW_PAID: "1",
    OPENAI_API_KEY: DUMMY_OPENAI,
    BRAIN_DECISION_API_KEY: DUMMY_DECISION,
    FAKE_PROVIDER_COUNTER: counter,
    ...extra,
  });
}

it(
  "recovers a settled decision without resending it after a reasoning pre-send failure and restart",
  async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "bibrain-decision-recovery-")));
    const root = join(base, "managed");
    const counter = join(base, "calls.counter");
    const f = await provision(root, 5_000);
    let worker: Child | undefined;
    try {
      // Run 1: the reasoning lease is negatively invalidated after the decision
      // response, so the reasoning prepare fails BEFORE any reserve (no reasoning
      // row). The decision stage settles and persists its advisory.
      worker = startWorker(workerEnv(root, counter, {
        FAKE_DECISION_TAMPER_REASONING_READINESS: join(root, "worker-ready.json"),
      }));
      const db = tenant(root, f.accountA);
      let observed: any;
      try {
        observed = await waitFor(25_000, worker, () => {
          const rows = db.dispatches(f.jobId);
          const decision = rows.find((r) => r.stage === "decision");
          const reasoning = rows.find((r) => r.stage === "reasoning");
          return decision?.state === "settled" &&
            !reasoning &&
            db.job(f.jobId)?.status === "retry_wait"
            ? { decision }
            : undefined;
        }, "decision settled and reasoning retry queued");
      } finally {
        db.close();
      }
      expect(observed.decision).toMatchObject({ stage: "decision", state: "settled", actual_micro_usd: 7 });
      await stopWorker(worker);
      worker = undefined;

      // Run 2 (fresh boot id, clean readiness): the existing published decision
      // attempt is never reclaimed or resent; the reasoning stage runs on its own
      // fresh permission and slot.
      worker = startWorker(workerEnv(root, counter));
      const db2 = tenant(root, f.accountA);
      try {
        const rows = await waitFor(30_000, worker, () => {
          const r = db2.dispatches(f.jobId);
          return r.length === 2 && r.every((x) => x.state === "settled") ? r : undefined;
        }, "both stages settled after restart");
        expect(rows).toMatchObject([
          { stage: "decision", state: "settled", actual_micro_usd: 7 },
          { stage: "reasoning", state: "settled", actual_micro_usd: 1 },
        ]);
        await waitFor(15_000, worker, () => (db2.job(f.jobId)?.status === "succeeded" ? true : undefined), "job succeeded after restart");
        expect(db2.entities("proposal")).toHaveLength(1);
      } finally {
        db2.close();
      }
      const events = counterLines(counter).map((l) => JSON.parse(l).event);
      // The decision call happened exactly ONCE across both boots.
      expect(events.filter((e) => e === "decision")).toHaveLength(1);
      expect(events.filter((e) => e === "reasoning")).toHaveLength(1);
    } finally {
      await stopWorker(worker);
      await cleanup(base);
    }
  },
  150_000,
);
it(
  "keeps both readiness heartbeats fresh during a >15s decision call, then proves a real re-lease after kill with no resend",
  async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "bibrain-decision-hold-")));
    const root = join(base, "managed");
    const counter = join(base, "calls.counter");
    const release = join(base, "release");
    const f = await provision(root, 60_000);
    let worker: Child | undefined;
    let firstBootId = "";
    let attemptsBefore = 0;
    const db = tenant(root, f.accountA);
    try {
      worker = startWorker(workerEnv(root, counter, { FAKE_DECISION_RELEASE: release }));
      let before = { decision: "", reasoning: "" };
      // The decision provider call must be REALLY marked and held, and a FRESH
      // (non-seed) real decision lease present, before any progress is claimed.
      await waitFor(30_000, worker, () => {
        const marked = db.dispatches(f.jobId).some((r) => r.stage === "decision" && r.state === "dispatched");
        if (!marked) return undefined;
        const d = readDecisionReadiness(root, new Date());
        if (d.state !== "ready" || !d.readiness) return undefined;
        if (d.readiness.worker_id === f.seedBootId) return undefined;
        firstBootId = d.readiness.worker_id;
        return true;
      }, "decision marked and held with a fresh real lease");
      const dr = readDecisionReadiness(root, new Date());
      const rr = readWorkerReadiness(root, new Date());
      expect(dr.state).toBe("ready");
      expect(rr.state).toBe("ready");
      expect(dr.readiness!.worker_id).toBe(firstBootId);
      expect(rr.readiness!.worker_id).toBe(firstBootId);
      expect(Date.parse(dr.readiness!.expires_at)).toBeGreaterThan(Date.now());
      before = { decision: dr.readiness!.heartbeat_at, reasoning: rr.readiness!.heartbeat_at };

      // Held beyond the 15 s TTL: BOTH leases are refreshed by the existing 5 s
      // beat (same worker id), with no second scheduler.
      await delay(16_000);
      const dr2 = readDecisionReadiness(root, new Date());
      const rr2 = readWorkerReadiness(root, new Date());
      expect(dr2.state).toBe("ready");
      expect(rr2.state).toBe("ready");
      expect(dr2.readiness!.worker_id).toBe(firstBootId);
      expect(rr2.readiness!.worker_id).toBe(firstBootId);
      expect(Date.parse(dr2.readiness!.heartbeat_at)).toBeGreaterThan(Date.parse(before.decision));
      expect(Date.parse(rr2.readiness!.heartbeat_at)).toBeGreaterThan(Date.parse(before.reasoning));
      let pending = counterLines(counter).map((l) => JSON.parse(l));
      expect(pending.filter((e) => e.event === "decision")).toHaveLength(1);
      expect(pending.filter((e) => e.event === "reasoning")).toHaveLength(0);

      // Kill during the pending fetch: the dispatched hold survives the crash and the
      // original job lease must genuinely expire before a fresh boot may re-lease it.
      attemptsBefore = db.job(f.jobId).attempts;
      await stopWorker(worker);
      worker = undefined;
      expect(db.dispatches(f.jobId)).toMatchObject([
        { stage: "decision", state: "dispatched", actual_micro_usd: null },
      ]);
      await pollUntil(95_000, () => {
        const j = db.job(f.jobId);
        return j?.lease_until && Date.parse(j.lease_until) <= Date.now() ? true : undefined;
      }, "the original decision job lease expiry");

      // Restart with a FRESH boot id; the job must really be re-leased (attempts and
      // fence advanced), never resending the decision call.
      worker = startWorker(workerEnv(root, counter));
      let secondBootId = "";
      await pollUntil(30_000, () => {
        const d = readDecisionReadiness(root, new Date());
        if (d.state !== "ready" || !d.readiness) return undefined;
        if (d.readiness.worker_id === firstBootId || d.readiness.worker_id === f.seedBootId)
          return undefined;
        secondBootId = d.readiness.worker_id;
        const j = db.job(f.jobId);
        return j && j.attempts >= attemptsBefore + 1 && j.fence >= attemptsBefore + 1 ? true : undefined;
      }, "a fresh boot id and a really re-leased job");
      expect(secondBootId).not.toBe(firstBootId);
      expect(db.dispatches(f.jobId)).toMatchObject([
        { stage: "decision", state: "dispatched", actual_micro_usd: null },
      ]);
      expect(db.entities("advisory")).toEqual([]);
      pending = counterLines(counter).map((l) => JSON.parse(l));
      expect(pending.filter((e) => e.event === "decision")).toHaveLength(1);
      expect(pending.filter((e) => e.event === "reasoning")).toHaveLength(0);
      expect(worker.child.exitCode).toBe(null);

      // Account B (raw master consent FALSE) gets a REAL unpaid extractive brief from
      // the ACTUAL main worker, while the original global decision hold stays unknown.
      const bRuntime = new ManagedRuntime(root);
      try {
        const bHandle = bRuntime.acquire(f.accountB);
        try {
          const bBrain = bHandle.brain;
          const bOwner = bBrain.ownerPrincipal();
          expect(bBrain.backgroundConsent(bOwner)).toBe(false);
          bBrain.capture(bOwner, { title: "SYNTHETIC unpaid B", body: "SYNTHETIC_UNPAID_B_EVIDENCE: keep going.", visibility: "project" });
        } finally {
          bHandle.release();
        }
      } finally {
        bRuntime.close();
      }
      const dbB = tenant(root, f.accountB);
      try {
        const brief = await pollUntil(35_000, () => {
          const job = dbB.jobByKind("derive_brief");
          if (!job || job.status !== "succeeded") return undefined;
          const briefs = dbB.entities("brief");
          return briefs.length ? briefs[0] : undefined;
        }, "account B extractive brief via the actual main worker");
        expect(JSON.stringify(brief)).toContain("SYNTHETIC_UNPAID_B_EVIDENCE");
      } finally {
        dbB.close();
      }
      expect(db.dispatches(f.jobId)).toMatchObject([
        { stage: "decision", state: "dispatched", actual_micro_usd: null },
      ]);
    } finally {
      db.close();
      await stopWorker(worker);
      await cleanup(base);
    }
  },
  300_000,
);

it(
  "boots the actual worker process: both readiness leases, one decision then one reasoning stage on one job, settled costs",
  async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "bibrain-decision-process-")));
    const root = join(base, "managed");
    const counter = join(base, "calls.counter");
    const f = await provision(root, 5_000);
    let worker: Child | undefined;
    try {
      worker = startWorker(workerEnv(root, counter));
      await waitFor(15_000, worker, () => existsSync(join(root, "decision-worker-ready.json")), "decision readiness");
      await waitFor(15_000, worker, () => existsSync(join(root, "worker-ready.json")), "reasoning readiness");
      const db = tenant(root, f.accountA);
      try {
        const rows = await waitFor(30_000, worker, () => {
          const r = db.dispatches(f.jobId);
          return r.length === 2 && r.every((x) => x.state === "settled") ? r : undefined;
        }, "both stages settled");
        expect(rows).toMatchObject([
          { stage: "decision", dispatch_key: "decision", state: "settled", actual_micro_usd: 7 },
          { stage: "reasoning", dispatch_key: "reasoning", state: "settled", actual_micro_usd: 1 },
        ]);
        await waitFor(15_000, worker, () => (db.job(f.jobId)?.status === "succeeded" ? true : undefined), "job succeeded");
        const proposals = db.entities("proposal");
        expect(proposals).toHaveLength(1);
        expect(proposals[0].evidence[0]).toMatchObject({ source_id: f.sourceId, source_version: 1 });
      } finally {
        db.close();
      }
      const events = counterLines(counter).map((l) => JSON.parse(l).event);
      expect(events.filter((e) => e === "decision")).toHaveLength(1);
      expect(events.filter((e) => e === "reasoning")).toHaveLength(1);
      // Both own leases are published while the worker runs (proving independent
      // boot + heartbeat). Graceful SIGTERM marker removal is not observable on
      // Windows (child.kill terminates without running the handler); it is covered
      // by remove{Worker,Decision}Readiness unit tests, not claimed here.
      expect(existsSync(join(root, "decision-worker-ready.json"))).toBe(true);
      expect(existsSync(join(root, "worker-ready.json"))).toBe(true);
      await stopWorker(worker);
      worker = undefined;
    } finally {
      await stopWorker(worker);
      await cleanup(base);
    }
  },
  120_000,
);

it(
  "boots a decision-ONLY worker when the reasoning key is absent and the seed leases are gone",
  async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "bibrain-decision-only-")));
    const root = join(base, "managed");
    const counter = join(base, "calls.counter");
    const f = await provision(root, 5_000);
    // Remove BOTH fixture seed leases offline so only the child's real lease can
    // satisfy the waits (no false-positive existence).
    rmSync(join(root, "decision-worker-ready.json"), { force: true });
    rmSync(join(root, "worker-ready.json"), { force: true });
    let worker: Child | undefined;
    try {
      worker = startWorker(workerEnv(root, counter, { OPENAI_API_KEY: "" }));
      let bootId = "";
      const db = tenant(root, f.accountA);
      try {
        await pollUntil(20_000, () => {
          const d = readDecisionReadiness(root, new Date());
          if (d.state !== "ready" || !d.readiness) return undefined;
          bootId = d.readiness.worker_id;
          return bootId && bootId !== f.seedBootId ? true : undefined;
        }, "the child's own fresh decision lease");
        expect(bootId).not.toBe(f.seedBootId);
        // The decision stage settles known-7; no reasoning provider is installed.
        await pollUntil(30_000, () => {
          const rows = db.dispatches(f.jobId);
          return rows.some((r) => r.stage === "decision" && r.state === "settled" && r.actual_micro_usd === 7)
            ? true
            : undefined;
        }, "decision settled");
        // No reasoning lease was ever published by this process.
        expect(existsSync(join(root, "worker-ready.json"))).toBe(false);
        const before = readDecisionReadiness(root, new Date()).readiness!.heartbeat_at;
        await delay(6_000);
        const after = readDecisionReadiness(root, new Date());
        expect(after.state).toBe("ready");
        expect(after.readiness!.worker_id).toBe(bootId);
        expect(Date.parse(after.readiness!.heartbeat_at)).toBeGreaterThan(Date.parse(before));
      } finally {
        db.close();
      }
      const events = counterLines(counter).map((l) => JSON.parse(l).event);
      expect(events.filter((e) => e === "decision")).toHaveLength(1);
      expect(events.filter((e) => e === "reasoning")).toHaveLength(0);
      expect(existsSync(join(root, "worker-ready.json"))).toBe(false);
    } finally {
      await stopWorker(worker);
      await cleanup(base);
    }
  },
  150_000,
);

it(
  "boots a reasoning-ONLY worker when the decision key is absent and the seed leases are gone",
  async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "bibrain-reasoning-only-")));
    const root = join(base, "managed");
    const counter = join(base, "calls.counter");
    const f = await provision(root, 5_000);
    rmSync(join(root, "decision-worker-ready.json"), { force: true });
    rmSync(join(root, "worker-ready.json"), { force: true });
    let worker: Child | undefined;
    try {
      worker = startWorker(workerEnv(root, counter, { BRAIN_DECISION_API_KEY: "" }));
      let bootId = "";
      const db = tenant(root, f.accountA);
      try {
        await pollUntil(20_000, () => {
          const w = readWorkerReadiness(root, new Date());
          if (w.state !== "ready" || !w.readiness) return undefined;
          bootId = w.readiness.worker_id;
          return bootId && bootId !== f.seedBootId ? true : undefined;
        }, "the child's own fresh reasoning lease");
        await pollUntil(30_000, () => {
          const r = db.dispatches(f.jobId).find((x) => x.stage === "reasoning");
          return r && r.state === "settled" && r.actual_micro_usd === 1 ? true : undefined;
        }, "reasoning settled");
        // The decision stage was never installed: no decision lease, no decision row.
        expect(existsSync(join(root, "decision-worker-ready.json"))).toBe(false);
        expect(db.dispatches(f.jobId).some((x) => x.stage === "decision")).toBe(false);
        await pollUntil(20_000, () => (db.job(f.jobId)?.status === "succeeded" ? true : undefined), "job succeeded");
        expect(db.entities("proposal")).toHaveLength(1);
      } finally {
        db.close();
      }
      const events = counterLines(counter).map((l) => JSON.parse(l).event);
      expect(events.filter((e) => e === "reasoning")).toHaveLength(1);
      expect(events.filter((e) => e === "decision")).toHaveLength(0);
      expect(existsSync(join(root, "decision-worker-ready.json"))).toBe(false);
    } finally {
      await stopWorker(worker);
      await cleanup(base);
    }
  },
  150_000,
);
