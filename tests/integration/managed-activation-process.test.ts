import { expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { ManagedRuntime } from "../../packages/runtime/managed.ts";
import { ManagedSpendingStore } from "../../packages/storage/managed-spending.ts";
import { ManagedReconciliationStore } from "../../packages/storage/managed-reconciliation.ts";
import { ManagedActivationStore } from "../../packages/storage/managed-activation.ts";
import { auditManagedHistory } from "../../packages/runtime/managed-audit.ts";
import {
  readWorkerReadiness,
  workerReadinessPath,
} from "../../packages/runtime/worker-readiness.ts";

/**
 * Real `apps/server` + `apps/worker` subprocesses over a disposable managed root.
 *
 * The worker is the ONLY process that loads the fake-fetch preload
 * (`tests/helpers/provider-preload.mjs`), which allows exactly the official OpenAI
 * Responses endpoint and throws for every other call. The server uses an opaque
 * control-store session (no live OIDC request); the OIDC env is strict-but-dummy.
 * No real key, owner account, network or paid call is involved.
 */

const SERVER_ENTRY = "apps/server/main.ts";
const WORKER_ENTRY = "apps/worker/main.ts";
const PRELOAD = "tests/helpers/provider-preload.mjs";
// `--import` must use a resolvable file URL, never a bare relative specifier.
const PRELOAD_URL = pathToFileURL(resolve(PRELOAD)).href;
const ISSUER = "https://issuer.synthetic.test";
const ORIGIN = "https://brain.synthetic.test";
const AUTHORITY = "brain.synthetic.test";
const CLIENT_ID = "synthetic-managed-client";
const CLIENT_SECRET = "synthetic-managed-client-secret";
const MARKER = "SYNTHETIC_ACTIVATION_PROCESS_MARKER";
const SESSION_COOKIE = "brain_session";
const DUMMY_KEY = "SYNTHETIC_DUMMY_KEY_NOT_REAL";
const READY_DEADLINE_MS = 30_000;

const STRIPPED_ENV = [
  "BRAIN_DB",
  "BRAIN_OWNER_SECRET",
  "BRAIN_AGENT_TOKEN",
  "BRAIN_API_URL",
  "BRAIN_MODE",
  "BRAIN_MANAGED_ROOT",
  "BRAIN_PUBLIC_ORIGIN",
  "BRAIN_PORT",
  "BRAIN_CONTAINER",
  "BRAIN_OIDC_ISSUER",
  "BRAIN_OIDC_CLIENT_ID",
  "BRAIN_OIDC_CLIENT_SECRET",
  "BRAIN_OIDC_CALLBACK_PATH",
  "BRAIN_MODEL",
  "BRAIN_INPUT_MICRO_USD_PER_MILLION",
  "BRAIN_OUTPUT_MICRO_USD_PER_MILLION",
  "BRAIN_PRICE_VERSION",
  "BRAIN_MAX_OUTPUT_TOKENS",
  "BRAIN_MANAGED_ALLOW_PAID",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_ORG_ID",
  "NODE_OPTIONS",
];
function sanitizedEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of STRIPPED_ENV) delete env[key];
  for (const key of Object.keys(env))
    if (/(_API_KEY|_API_TOKEN|_ACCESS_TOKEN)$/i.test(key)) delete env[key];
  return { ...env, ...extra };
}

type Child = { child: ChildProcess; output: () => string };
function startMain(entry: string, env: NodeJS.ProcessEnv): Child {
  const child = spawn(process.execPath, ["--import", "tsx", entry], {
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
  return { child, output: () => output };
}
async function stop(handle: Child | undefined): Promise<void> {
  if (!handle) return;
  const { child } = handle;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill();
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  await exited;
  clearTimeout(timer);
}

function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("no port"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}
type HttpResult = { status: number; headers: IncomingHttpHeaders; body: string };
function requestOnce(
  port: number,
  options: {
    method?: string;
    path: string;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Host: AUTHORITY, ...options.headers };
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(Buffer.byteLength(options.body));
    }
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: options.method ?? "GET",
        path: options.path,
        headers,
        timeout: 10_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}
const parseJson = (r: HttpResult): any => {
  try {
    return JSON.parse(r.body);
  } catch {
    return undefined;
  }
};
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
function cleanup(base: string): void {
  // Best-effort: a lingering WAL/file lock on Windows must not fail a test whose
  // assertions already passed. The directory is under the OS temp dir.
  try {
    rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch {
    /* best-effort */
  }
}
const exited = (h: Child) => h.child.exitCode !== null || h.child.signalCode !== null;
async function waitReady(port: number, handle: Child, label: string): Promise<void> {
  const deadline = Date.now() + READY_DEADLINE_MS;
  while (Date.now() < deadline) {
    if (exited(handle)) throw new Error(`${label} exited before ready`);
    try {
      const health = await requestOnce(port, { path: "/api/v1/health/live" });
      if (health.status === 200) return;
    } catch {
      /* not listening yet */
    }
    await delay(100);
  }
  throw new Error(`${label} not ready`);
}
async function waitFor(
  port: number,
  path: string,
  cookie: string,
  predicate: (body: any) => boolean,
  label: string,
): Promise<any> {
  const deadline = Date.now() + READY_DEADLINE_MS;
  while (Date.now() < deadline) {
    const result = await requestOnce(port, { path, headers: { Cookie: cookie } });
    if (result.status === 200) {
      const body = parseJson(result);
      if (predicate(body)) return body;
    }
    await delay(150);
  }
  throw new Error(`timed out waiting for ${label}`);
}
function counterLines(file: string): string[] {
  if (!existsSync(file)) return [];
  // Bounded read: never load an unbounded counter file.
  return readFileSync(file, "utf8").slice(0, 8192).split("\n").filter((l) => l.trim() !== "");
}
async function waitForTerminal(
  port: number,
  cookie: string,
  jobId: string,
  server: Child,
  worker: Child,
): Promise<any> {
  const deadline = Date.now() + READY_DEADLINE_MS;
  while (Date.now() < deadline) {
    if (exited(server) || exited(worker))
      throw new Error("a child exited while awaiting job terminal state");
    const res = await requestOnce(port, {
      path: `/api/v1/jobs/${jobId}`,
      headers: { Cookie: cookie },
    });
    if (res.status === 200) {
      const j = parseJson(res);
      if (j?.status && !["queued", "running", "retry_wait"].includes(j.status)) return j;
    }
    await delay(150);
  }
  throw new Error("job did not reach a terminal state");
}
function settledActual(root: string, jobId: string): number | null {
  const db = new DatabaseSync(join(root, "control.sqlite"), { readOnly: true });
  try {
    const row = db
      .prepare(
        "SELECT state,actual_micro_usd FROM managed_reservations WHERE job_id=? ORDER BY created_at DESC LIMIT 1",
      )
      .get(jobId) as { state: string; actual_micro_usd: number | null } | undefined;
    return row && row.state === "settled" ? Number(row.actual_micro_usd) : null;
  } finally {
    db.close();
  }
}

function enrol(
  root: string,
  providerEnabled: boolean,
  second = false,
): {
  accountId: string;
  token: string;
  csrf: string;
  secondAccountId?: string;
  secondToken?: string;
  secondCsrf?: string;
} {
  const runtime = new ManagedRuntime(root);
  const account = runtime.provision(ISSUER, "synthetic-activation-process");
  const session = runtime.control.issueSession(account.id);
  const money = new ManagedSpendingStore(runtime.control);
  money.setServicePolicy({ daily_micro_usd: 100_000 });
  const grant = (id: string) => {
    money.setAccountPolicy({
      account_id: id,
      per_job_micro_usd: 10_000,
      user_daily_micro_usd: 100_000,
    });
    money.configureAccountPeriod({
      account_id: id,
      starts_at: "2026-01-01T00:00:00Z",
      ends_at: "2030-01-01T00:00:00Z",
      allowance_micro_usd: 1_000_000,
    });
  };
  grant(account.id);
  // A second account MUST exist BEFORE the enrollment audit so the profile binds it.
  const secondAccount = second
    ? runtime.provision(ISSUER, "synthetic-activation-process-b")
    : undefined;
  const secondSession = secondAccount
    ? runtime.control.issueSession(secondAccount.id)
    : undefined;
  if (secondAccount) grant(secondAccount.id);

  const ack = { offline: true as const, workers_terminated: true as const };
  new ManagedReconciliationStore(runtime.control, root).initEpoch(ack);
  const audit = auditManagedHistory({ runtime, root, ...ack });
  if (!audit.ok) throw new Error(`synthetic audit failed: ${audit.reason}`);
  new ManagedActivationStore(runtime.control, root).enable(
    {
      provider: "openai",
      model: "synthetic-model-v1",
      price_version: "synthetic-price-v1",
      input_micro_usd_per_million: 10_000,
      output_micro_usd_per_million: 10_000,
      accepted_response_models: ["synthetic-model-v1"],
      max_output_tokens: 100,
      endpoint_class: "openai_responses",
      audit_id: audit.audit_id!,
      expected_version: 0,
    },
    ack,
  );
  const enableConsent = (id: string) => {
    const h = runtime.acquire(id);
    try {
      const owner = h.brain.ownerPrincipal();
      h.brain.prefs(owner, {
        ...h.brain.prefs(owner),
        time_zone: "UTC",
        provider_enabled: true,
        per_job_cap_micro_usd: 10_000,
        daily_cap_micro_usd: 100_000,
      });
    } finally {
      h.release();
    }
  };
  if (providerEnabled) {
    enableConsent(account.id);
    if (secondAccount) enableConsent(secondAccount.id);
  }
  runtime.close();
  return {
    accountId: account.id,
    token: session.token,
    csrf: session.csrf,
    secondAccountId: secondAccount?.id,
    secondToken: secondSession?.token,
    secondCsrf: secondSession?.csrf,
  };
}

it(
  "boots real server+worker: default-OFF sends zero fake calls; a configured profile sends exactly one known-7 call",
  async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "bibrain-activation-process-")));
    const offRoot = join(base, "off");
    const onRoot = join(base, "on");
    const counterOff = join(base, "off.counter");
    const counterOn = join(base, "on.counter");

    // Default-OFF: account + session only, no activation profile.
    const off = new ManagedRuntime(offRoot);
    const offAccount = off.provision(ISSUER, "synthetic-off");
    const offSession = off.control.issueSession(offAccount.id);
    off.close();

    const on = enrol(onRoot, true);

    let server: Child | undefined;
    let worker: Child | undefined;
    try {
      const managedEnv = (root: string, extra: Record<string, string>) =>
        sanitizedEnv({
          BRAIN_MODE: "managed",
          BRAIN_MANAGED_ROOT: root,
          BRAIN_PUBLIC_ORIGIN: ORIGIN,
          BRAIN_OIDC_ISSUER: ISSUER,
          BRAIN_OIDC_CLIENT_ID: CLIENT_ID,
          BRAIN_OIDC_CLIENT_SECRET: CLIENT_SECRET,
          BRAIN_MANAGED_ALLOW_PAID: "1",
          ...extra,
        });

      // --- default-OFF root ---
      {
        const port = await freePort();
        worker = startMain(
          WORKER_ENTRY,
          managedEnv(offRoot, {
            BRAIN_MANAGED_ALLOW_PAID: "1",
            NODE_OPTIONS: `--import ${PRELOAD_URL}`,
            FAKE_PROVIDER_COUNTER: counterOff,
          }),
        );
        server = startMain(SERVER_ENTRY, managedEnv(offRoot, { BRAIN_PORT: String(port) }));
        await waitReady(port, server, "off server");
        const meta = parseJson(await requestOnce(port, { path: "/api/v1/runtime" }));
        expect(meta.connected_processing_available).toBe(false);

        const cookie = `${SESSION_COOKIE}=${offSession.token}`;
        const capture = await requestOnce(port, {
          method: "POST",
          path: "/api/v1/sources",
          headers: { Cookie: cookie, "x-brain-csrf": offSession.csrf, Origin: ORIGIN },
          body: JSON.stringify({ project_id: "inbox", title: "off note", body: `${MARKER} off` }),
        });
        expect(capture.status).toBe(201);
        const sourceId = parseJson(capture).source_id as string;
        const brief = await waitFor(
          port,
          "/api/v1/today",
          cookie,
          (b) => Array.isArray(b?.briefs) && b.briefs.length > 0,
          "off brief",
        );
        expect(brief.briefs[0].data.mode).toBe("Extractive preview");
        expect(JSON.stringify(brief.briefs[0].data)).toContain(sourceId);
        expect(exited(server!)).toBe(false);
        expect(exited(worker!)).toBe(false);
        await stop(worker);
        worker = undefined;
        await stop(server);
        server = undefined;
        expect(counterLines(counterOff)).toHaveLength(0);
      }

      // --- configured root: worker started BEFORE the server ---
      {
        const port = await freePort();
        worker = startMain(
          WORKER_ENTRY,
          managedEnv(onRoot, {
            BRAIN_MANAGED_ALLOW_PAID: "1",
            OPENAI_API_KEY: DUMMY_KEY,
            NODE_OPTIONS: `--import ${PRELOAD_URL}`,
            FAKE_PROVIDER_COUNTER: counterOn,
          }),
        );
        server = startMain(SERVER_ENTRY, managedEnv(onRoot, { BRAIN_PORT: String(port) }));
        await waitReady(port, server, "on server");
        await waitFor(
          port,
          "/api/v1/runtime",
          "",
          (b) => b?.connected_processing_available === true,
          "capability true",
        );

        const cookie = `${SESSION_COOKIE}=${on.token}`;
        const capture = await requestOnce(port, {
          method: "POST",
          path: "/api/v1/sources",
          headers: { Cookie: cookie, "x-brain-csrf": on.csrf, Origin: ORIGIN },
          body: JSON.stringify({ project_id: "inbox", title: "on note", body: `${MARKER} on` }),
        });
        expect(capture.status).toBe(201);
        const sourceId = parseJson(capture).source_id as string;
        const jobId = parseJson(capture).job?.id;
        expect(typeof jobId).toBe("string");
        const brief = await waitFor(
          port,
          "/api/v1/today",
          cookie,
          (b) => Array.isArray(b?.briefs) && b.briefs.some((x: any) => x.data.mode !== "Extractive preview"),
          "connected brief",
        );
        const connected = brief.briefs.find((x: any) => x.data.mode !== "Extractive preview");
        expect(connected.data.provider).toBe("openai");
        expect(connected.data.items[0].evidence[0].source_id).toBe(sourceId);

        const lines = counterLines(counterOn);
        expect(lines).toHaveLength(1);
        const parsed = JSON.parse(lines[0]!);
        expect(parsed.model).toBe("synthetic-model-v1");
        // The preload never records a key, header or source body.
        expect(lines[0]!).not.toContain(DUMMY_KEY);
        expect(lines[0]!).not.toContain(MARKER);
        expect(exited(server)).toBe(false);
        expect(exited(worker)).toBe(false);
        expect(settledActual(onRoot, jobId)).toBe(7);
      }
    } finally {
      await stop(worker);
      await stop(server);
      cleanup(base);
    }
  },
  180_000,
);

it(
  "a locally invalid dummy key (control characters) never claims readiness or creates a hold",
  async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "bibrain-activation-badkey-")));
    const root = join(base, "managed");
    const counter = join(base, "badkey.counter");
    const on = enrol(root, true);
    let server: Child | undefined;
    let worker: Child | undefined;
    try {
      const env = (extra: Record<string, string>) =>
        sanitizedEnv({
          BRAIN_MODE: "managed",
          BRAIN_MANAGED_ROOT: root,
          BRAIN_PUBLIC_ORIGIN: ORIGIN,
          BRAIN_OIDC_ISSUER: ISSUER,
          BRAIN_OIDC_CLIENT_ID: CLIENT_ID,
          BRAIN_OIDC_CLIENT_SECRET: CLIENT_SECRET,
          BRAIN_MANAGED_ALLOW_PAID: "1",
          ...extra,
        });
      const port = await freePort();
      worker = startMain(
        WORKER_ENTRY,
        env({
          BRAIN_MANAGED_ALLOW_PAID: "1",
          // Non-empty after trim, but the adapter refuses control characters, so
          // the worker must NOT install a paid path or publish readiness.
          OPENAI_API_KEY: `\n${DUMMY_KEY}`,
          NODE_OPTIONS: `--import ${PRELOAD_URL}`,
          FAKE_PROVIDER_COUNTER: counter,
        }),
      );
      server = startMain(SERVER_ENTRY, env({ BRAIN_PORT: String(port) }));
      await waitReady(port, server, "badkey server");
      await delay(1500);
      const meta = parseJson(await requestOnce(port, { path: "/api/v1/runtime" }));
      expect(meta.connected_processing_available).toBe(false);

      const cookie = `${SESSION_COOKIE}=${on.token}`;
      const capture = await requestOnce(port, {
        method: "POST",
        path: "/api/v1/sources",
        headers: { Cookie: cookie, "x-brain-csrf": on.csrf, Origin: ORIGIN },
        body: JSON.stringify({ project_id: "inbox", title: "badkey note", body: `${MARKER} badkey` }),
      });
      expect(capture.status).toBe(201);
      const sourceId = parseJson(capture).source_id as string;
      const jobId = parseJson(capture).job?.id;
      expect(typeof jobId).toBe("string");
      const job = await waitForTerminal(port, cookie, jobId, server!, worker!);
      expect(job.status).toBe("failed");
      expect(exited(server!)).toBe(false);
      expect(exited(worker!)).toBe(false);
      expect(counterLines(counter)).toHaveLength(0);
      const persisted = await requestOnce(port, {
        path: `/api/v1/sources/${sourceId}`,
        headers: { Cookie: cookie },
      });
      expect(persisted.status).toBe(200);
      const db = new DatabaseSync(join(root, "control.sqlite"), { readOnly: true });
      try {
        const rows = db.prepare("SELECT count(*) AS n FROM managed_reservations").get() as { n: number };
        expect(Number(rows.n)).toBe(0);
      } finally {
        db.close();
      }
    } finally {
      await stop(worker);
      await stop(server);
      cleanup(base);
    }
  },
  120_000,
);

it(
  "a malformed provider output with known usage charges before failing to publish",
  async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "bibrain-activation-malformed-")));
    const root = join(base, "managed");
    const counter = join(base, "malformed.counter");
    const on = enrol(root, true);
    let server: Child | undefined;
    let worker: Child | undefined;
    try {
      const env = (extra: Record<string, string>) =>
        sanitizedEnv({
          BRAIN_MODE: "managed",
          BRAIN_MANAGED_ROOT: root,
          BRAIN_PUBLIC_ORIGIN: ORIGIN,
          BRAIN_OIDC_ISSUER: ISSUER,
          BRAIN_OIDC_CLIENT_ID: CLIENT_ID,
          BRAIN_OIDC_CLIENT_SECRET: CLIENT_SECRET,
          BRAIN_MANAGED_ALLOW_PAID: "1",
          ...extra,
        });
      const port = await freePort();
      worker = startMain(
        WORKER_ENTRY,
        env({
          OPENAI_API_KEY: DUMMY_KEY,
          NODE_OPTIONS: `--import ${PRELOAD_URL}`,
          FAKE_PROVIDER_COUNTER: counter,
          FAKE_PROVIDER_MODE: "malformed",
        }),
      );
      server = startMain(SERVER_ENTRY, env({ BRAIN_PORT: String(port) }));
      await waitReady(port, server, "malformed server");
      await waitFor(
        port,
        "/api/v1/runtime",
        "",
        (b) => b?.connected_processing_available === true,
        "malformed capability",
      );
      const cookie = `${SESSION_COOKIE}=${on.token}`;
      const capture = await requestOnce(port, {
        method: "POST",
        path: "/api/v1/sources",
        headers: { Cookie: cookie, "x-brain-csrf": on.csrf, Origin: ORIGIN },
        body: JSON.stringify({ project_id: "inbox", title: "malformed", body: `${MARKER} malformed` }),
      });
      expect(capture.status).toBe(201);
      const sourceId = parseJson(capture).source_id as string;
      const jobId = parseJson(capture).job?.id;
      expect(typeof jobId).toBe("string");
      const job = await waitForTerminal(port, cookie, jobId, server!, worker!);
      expect(job.status).toBe("failed");
      expect(exited(server!)).toBe(false);
      expect(exited(worker!)).toBe(false);
      expect(counterLines(counter)).toHaveLength(1);
      // Known usage is charged even though the output was unusable.
      expect(settledActual(root, jobId)).toBe(7);
      const today = parseJson(
        await requestOnce(port, { path: "/api/v1/today", headers: { Cookie: cookie } }),
      );
      expect((today.briefs ?? []).length).toBe(0);
      const persisted = await requestOnce(port, {
        path: `/api/v1/sources/${sourceId}`,
        headers: { Cookie: cookie },
      });
      expect(persisted.status).toBe(200);
    } finally {
      await stop(worker);
      await stop(server);
      cleanup(base);
    }
  },
  120_000,
);

it(
  "a long provider call keeps an independent heartbeat past the TTL, then a real CLI disable settles the known charge without an abort",
  async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "bibrain-activation-longio-")));
    const root = join(base, "managed");
    const counter = join(base, "longio.counter");
    const release = join(base, "longio.release");
    const on = enrol(root, true);
    let server: Child | undefined;
    let worker: Child | undefined;
    try {
      const env = (extra: Record<string, string>) =>
        sanitizedEnv({
          BRAIN_MODE: "managed",
          BRAIN_MANAGED_ROOT: root,
          BRAIN_PUBLIC_ORIGIN: ORIGIN,
          BRAIN_OIDC_ISSUER: ISSUER,
          BRAIN_OIDC_CLIENT_ID: CLIENT_ID,
          BRAIN_OIDC_CLIENT_SECRET: CLIENT_SECRET,
          BRAIN_MANAGED_ALLOW_PAID: "1",
          ...extra,
        });
      const port = await freePort();
      worker = startMain(
        WORKER_ENTRY,
        env({
          OPENAI_API_KEY: DUMMY_KEY,
          NODE_OPTIONS: `--import ${PRELOAD_URL}`,
          FAKE_PROVIDER_COUNTER: counter,
          FAKE_PROVIDER_RELEASE: release,
        }),
      );
      server = startMain(SERVER_ENTRY, env({ BRAIN_PORT: String(port) }));
      await waitReady(port, server, "longio server");
      await waitFor(
        port,
        "/api/v1/runtime",
        "",
        (b) => b?.connected_processing_available === true,
        "longio capability",
      );

      const cookie = `${SESSION_COOKIE}=${on.token}`;
      const capture = await requestOnce(port, {
        method: "POST",
        path: "/api/v1/sources",
        headers: { Cookie: cookie, "x-brain-csrf": on.csrf, Origin: ORIGIN },
        body: JSON.stringify({ project_id: "inbox", title: "longio", body: `${MARKER} longio` }),
      });
      expect(capture.status, capture.body).toBe(201);
      const sourceId = parseJson(capture).source_id as string;
      const jobId = parseJson(capture).job?.id;
      expect(typeof jobId).toBe("string");

      // The single fake call starts and is HELD by the preload release gate.
      const started = Date.now() + READY_DEADLINE_MS;
      while (counterLines(counter).length < 1 && Date.now() < started) await delay(100);
      expect(counterLines(counter)).toHaveLength(1);
      const ioStartedAt = Date.now();
      const bootBeat = readWorkerReadiness(root, new Date()).readiness?.heartbeat_at ?? null;
      expect(typeof bootBeat).toBe("string");
      const beats = new Set<string>();
      if (bootBeat) beats.add(bootBeat);

      // Hold PAST the initial 15s TTL, asserting the real states each poll.
      while (Date.now() - ioStartedAt < 16_000) {
        await delay(500);
        expect(exited(server!)).toBe(false);
        expect(exited(worker!)).toBe(false);
        const job = parseJson(
          await requestOnce(port, { path: `/api/v1/jobs/${jobId}`, headers: { Cookie: cookie } }),
        );
        expect(job.status).toBe("running");
        const db = new DatabaseSync(join(root, "control.sqlite"), { readOnly: true });
        try {
          const row = db
            .prepare("SELECT state,actual_micro_usd FROM managed_reservations WHERE job_id=?")
            .get(jobId) as any;
          expect(row?.state).toBe("dispatched");
          expect(row?.actual_micro_usd ?? null).toBe(null);
        } finally {
          db.close();
        }
        const beat = readWorkerReadiness(root, new Date()).readiness?.heartbeat_at;
        if (beat) beats.add(beat);
        const meta = parseJson(await requestOnce(port, { path: "/api/v1/runtime" }));
        expect(
          meta.connected_processing_available,
          `runtime meta: ${JSON.stringify(meta)}`,
        ).toBe(true);
        const spend = parseJson(
          await requestOnce(port, { path: "/api/v1/today", headers: { Cookie: cookie } }),
        ).status.spend;
        expect(spend, `spend status: ${JSON.stringify(spend)}`).toMatchObject({
          stored_consent_active: true,
          consent_effective: true,
          capability_ready: true,
          blocked: true,
          paused_reason: "usage_pending",
          available: false,
        });
      }
      expect(beats.size).toBeGreaterThanOrEqual(3); // boot + at least two intervals
      expect(counterLines(counter)).toHaveLength(1); // no second call

      // Real offline CLI disable: policy off is immediate, not TTL-based.
      const cli = spawnSync(
        process.execPath,
        ["--import", "tsx", "scripts/managed-activation.ts", "disable", "--expected-version", "1"],
        { cwd: process.cwd(), env: { ...sanitizedEnv({}), BRAIN_MANAGED_ROOT: root }, encoding: "utf8" },
      );
      expect(cli.status, `${cli.stdout}\n${cli.stderr}`).toBe(0);
      expect(cli.stdout).not.toContain(root);
      expect(JSON.parse(cli.stdout)).toMatchObject({ command: "disable", disabled: true, version: 2 });
      await waitFor(
        port,
        "/api/v1/runtime",
        "",
        (b) => b?.connected_processing_available === false,
        "longio capability off",
      );
      // Own lease is withdrawn within a beat while the call remains held.
      const withdraw = Date.now() + 6000;
      while (existsSync(workerReadinessPath(root)) && Date.now() < withdraw) await delay(200);
      expect(existsSync(workerReadinessPath(root))).toBe(false);
      expect(counterLines(counter)).toHaveLength(1);

      // Release the held response: the known charge settles; no output is published.
      writeFileSync(release, "SYNTHETIC_RELEASE");
      const job = await waitForTerminal(port, cookie, jobId, server!, worker!);
      expect(job.status).toBe("failed");
      expect(counterLines(counter)).toHaveLength(1);
      expect(settledActual(root, jobId)).toBe(7);
      const tenant = new DatabaseSync(join(root, on.accountId, "brain.sqlite"), { readOnly: true });
      try {
        const row = tenant
          .prepare("SELECT state,actual_micro_usd FROM provider_dispatches WHERE job_id=?")
          .get(jobId) as any;
        expect(row?.state).toBe("settled");
        expect(Number(row?.actual_micro_usd)).toBe(7);
      } finally {
        tenant.close();
      }
      const today = parseJson(
        await requestOnce(port, { path: "/api/v1/today", headers: { Cookie: cookie } }),
      );
      expect((today.briefs ?? []).length).toBe(0);
      const persisted = await requestOnce(port, {
        path: `/api/v1/sources/${sourceId}`,
        headers: { Cookie: cookie },
      });
      expect(persisted.status).toBe(200);
      expect(exited(server!)).toBe(false);
      expect(exited(worker!)).toBe(false);
    } finally {
      await stop(worker);
      await stop(server);
      cleanup(base);
    }
  },
  180_000,
);

it(
  "an unaccepted returned model keeps an UNKNOWN hold, survives a real worker restart without resend, and still allows the other account's extractive work",
  async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "bibrain-activation-unknown-")));
    const root = join(base, "managed");
    const counter = join(base, "unknown.counter");
    const on = enrol(root, true, true);
    expect(typeof on.secondAccountId).toBe("string");
    let server: Child | undefined;
    let worker: Child | undefined;
    try {
      const env = (extra: Record<string, string>) =>
        sanitizedEnv({
          BRAIN_MODE: "managed",
          BRAIN_MANAGED_ROOT: root,
          BRAIN_PUBLIC_ORIGIN: ORIGIN,
          BRAIN_OIDC_ISSUER: ISSUER,
          BRAIN_OIDC_CLIENT_ID: CLIENT_ID,
          BRAIN_OIDC_CLIENT_SECRET: CLIENT_SECRET,
          BRAIN_MANAGED_ALLOW_PAID: "1",
          ...extra,
        });
      const startWorker = () =>
        startMain(
          WORKER_ENTRY,
          env({
            OPENAI_API_KEY: DUMMY_KEY,
            NODE_OPTIONS: `--import ${PRELOAD_URL}`,
            FAKE_PROVIDER_COUNTER: counter,
            FAKE_PROVIDER_MODE: "wrongmodel",
          }),
        );
      const port = await freePort();
      worker = startWorker();
      server = startMain(SERVER_ENTRY, env({ BRAIN_PORT: String(port) }));
      await waitReady(port, server, "unknown server");
      await waitFor(
        port,
        "/api/v1/runtime",
        "",
        (b) => b?.connected_processing_available === true,
        "unknown capability",
      );

      const cookieA = `${SESSION_COOKIE}=${on.token}`;
      const capA = await requestOnce(port, {
        method: "POST",
        path: "/api/v1/sources",
        headers: { Cookie: cookieA, "x-brain-csrf": on.csrf, Origin: ORIGIN },
        body: JSON.stringify({ project_id: "inbox", title: "A", body: `${MARKER} unknownA` }),
      });
      expect(capA.status).toBe(201);
      const jobA = parseJson(capA).job?.id;
      expect(typeof jobA).toBe("string");
      const terminalA = await waitForTerminal(port, cookieA, jobA, server!, worker!);
      expect(terminalA.status).toBe("failed");
      expect(counterLines(counter)).toHaveLength(1);
      expect(settledActual(root, jobA)).toBe(null);
      const readA = () => {
        const db = new DatabaseSync(join(root, "control.sqlite"), { readOnly: true });
        try {
          return db
            .prepare("SELECT call_id,state,actual_micro_usd FROM managed_reservations WHERE job_id=?")
            .get(jobA) as any;
        } finally {
          db.close();
        }
      };
      expect(readA()?.state).toBe("dispatched");
      expect(readA()?.actual_micro_usd ?? null).toBe(null);
      const todayA = parseJson(
        await requestOnce(port, { path: "/api/v1/today", headers: { Cookie: cookieA } }),
      );
      expect((todayA.briefs ?? []).length).toBe(0);
      expect(todayA.status.spend).toMatchObject({
        stored_consent_active: true,
        consent_effective: true,
        capability_ready: true,
        blocked: true,
        paused_reason: "usage_pending",
        available: false,
      });

      // Account B cannot start a NEW paid admission while the unknown hold stands.
      const cookieB = `${SESSION_COOKIE}=${on.secondToken!}`;
      const capB = await requestOnce(port, {
        method: "POST",
        path: "/api/v1/sources",
        headers: { Cookie: cookieB, "x-brain-csrf": on.secondCsrf!, Origin: ORIGIN },
        body: JSON.stringify({ project_id: "inbox", title: "B", body: `${MARKER} unknownB` }),
      });
      expect(capB.status).toBe(201);
      const jobB1 = parseJson(capB).job?.id;
      expect(typeof jobB1).toBe("string");
      const terminalB1 = await waitForTerminal(port, cookieB, jobB1, server!, worker!);
      expect(terminalB1.status).toBe("failed");
      expect(counterLines(counter)).toHaveLength(1);
      const bRows = (() => {
        const db = new DatabaseSync(join(root, "control.sqlite"), { readOnly: true });
        try {
          return Number(
            (db.prepare("SELECT count(*) AS n FROM managed_reservations WHERE job_id=?").get(jobB1) as any).n,
          );
        } finally {
          db.close();
        }
      })();
      expect(bRows).toBe(0);
      const sourceB1 = parseJson(capB).source_id as string;
      expect(
        (await requestOnce(port, { path: `/api/v1/sources/${sourceB1}`, headers: { Cookie: cookieB } }))
          .status,
      ).toBe(200);

      // Capture the ORIGINAL readiness identity and A's held row BEFORE restart.
      const originalReady = readWorkerReadiness(root, new Date());
      expect(originalReady.state).toBe("ready");
      const originalWorkerId = originalReady.readiness!.worker_id;
      const originalFingerprint = originalReady.readiness!.activation_fingerprint;
      const originalConfig = originalReady.readiness!.config_digest;
      const originalRow = readA();
      expect(typeof originalRow.call_id).toBe("string");
      expect(originalRow.state).toBe("dispatched");
      expect(originalRow.actual_micro_usd ?? null).toBe(null);
      const originalCallId = originalRow.call_id as string;
      const tenantARow = (() => {
        const db = new DatabaseSync(join(root, on.accountId, "brain.sqlite"), { readOnly: true });
        try {
          return db
            .prepare("SELECT call_id,state,actual_micro_usd FROM provider_dispatches WHERE job_id=?")
            .get(jobA) as any;
        } finally {
          db.close();
        }
      })();
      expect(typeof tenantARow?.call_id).toBe("string");
      expect(tenantARow?.state).toBe("dispatched");
      expect(tenantARow?.actual_micro_usd ?? null).toBe(null);

      // Real worker restart over the SAME root/profile: no re-enroll, no re-audit.
      await stop(worker);
      worker = undefined;
      worker = startWorker();
      // Wait for a genuinely NEW worker id with a FRESH lease matching the frozen
      // profile — never merely the old lease still inside its 15s TTL.
      const newWorkerDeadline = Date.now() + READY_DEADLINE_MS;
      let newReady: { worker_id: string } | null = null;
      while (Date.now() < newWorkerDeadline) {
        if (exited(worker!)) throw new Error("restarted worker exited before publishing readiness");
        const r = readWorkerReadiness(root, new Date());
        if (
          r.state === "ready" &&
          r.readiness &&
          r.readiness.worker_id !== originalWorkerId &&
          r.readiness.activation_fingerprint === originalFingerprint &&
          r.readiness.config_digest === originalConfig
        ) {
          newReady = r.readiness;
          break;
        }
        await delay(200);
      }
      expect(newReady).not.toBeNull();
      expect(newReady!.worker_id).not.toBe(originalWorkerId);
      await waitFor(
        port,
        "/api/v1/runtime",
        "",
        (b) => b?.connected_processing_available === true,
        "capability after worker restart",
      );

      // Retry A's job through the REAL endpoint: no resend, same held call id.
      const beforeRetry = (() => {
        const db = new DatabaseSync(join(root, on.accountId, "brain.sqlite"), { readOnly: true });
        try {
          return db.prepare("SELECT attempts,fence,status FROM jobs WHERE id=?").get(jobA) as any;
        } finally {
          db.close();
        }
      })();
      const retry = await requestOnce(port, {
        method: "POST",
        path: `/api/v1/jobs/${jobA}/retry`,
        headers: { Cookie: cookieA, "x-brain-csrf": on.csrf, Origin: ORIGIN },
      });
      if (retry.status === 409) {
        // The API refused the retry: a static error code, job stays terminal.
        expect(typeof parseJson(retry)?.error?.code).toBe("string");
        expect(beforeRetry?.status).toBe("failed");
      } else {
        expect([200, 201]).toContain(retry.status);
        const terminalRetry = await waitForTerminal(port, cookieA, jobA, server!, worker!);
        expect(terminalRetry.status).toBe("failed");
        const afterRetry = (() => {
          const db = new DatabaseSync(join(root, on.accountId, "brain.sqlite"), { readOnly: true });
          try {
            return db.prepare("SELECT attempts,fence FROM jobs WHERE id=?").get(jobA) as any;
          } finally {
            db.close();
          }
        })();
        expect(
          Number(afterRetry.attempts) > Number(beforeRetry.attempts) ||
            Number(afterRetry.fence) !== Number(beforeRetry.fence),
        ).toBe(true);
      }
      expect(counterLines(counter)).toHaveLength(1);
      expect(readA()?.call_id).toBe(originalCallId);
      expect(readA()?.state).toBe("dispatched");
      expect(readA()?.actual_micro_usd ?? null).toBe(null);

      // A new B capture creates no new hold and no IO; its source persists.
      const capB2 = await requestOnce(port, {
        method: "POST",
        path: "/api/v1/sources",
        headers: { Cookie: cookieB, "x-brain-csrf": on.secondCsrf!, Origin: ORIGIN },
        body: JSON.stringify({ project_id: "inbox", title: "B2", body: `${MARKER} unknownB2` }),
      });
      expect(capB2.status).toBe(201);
      const jobB2 = parseJson(capB2).job?.id;
      expect(typeof jobB2).toBe("string");
      const terminalB2 = await waitForTerminal(port, cookieB, jobB2, server!, worker!);
      expect(terminalB2.status).toBe("failed");
      expect(counterLines(counter)).toHaveLength(1);
      const b2Rows = (() => {
        const db = new DatabaseSync(join(root, "control.sqlite"), { readOnly: true });
        try {
          return Number(
            (db.prepare("SELECT count(*) AS n FROM managed_reservations WHERE job_id=?").get(jobB2) as any).n,
          );
        } finally {
          db.close();
        }
      })();
      expect(b2Rows).toBe(0);
      const sourceB2 = parseJson(capB2).source_id as string;
      expect(
        (await requestOnce(port, { path: `/api/v1/sources/${sourceB2}`, headers: { Cookie: cookieB } }))
          .status,
      ).toBe(200);

      // B withdraws consent (full prefs body from GET) despite the global unknown.
      const full = parseJson(
        await requestOnce(port, { path: "/api/v1/preferences/background", headers: { Cookie: cookieB } }),
      );
      const off = await requestOnce(port, {
        method: "PATCH",
        path: "/api/v1/preferences/background",
        headers: { Cookie: cookieB, "x-brain-csrf": on.secondCsrf!, Origin: ORIGIN },
        body: JSON.stringify({ ...full, provider_enabled: false }),
      });
      expect(off.status).toBe(200);

      // A new B capture now runs EXTRACTIVE (useful) while A's hold persists.
      const capB3 = await requestOnce(port, {
        method: "POST",
        path: "/api/v1/sources",
        headers: { Cookie: cookieB, "x-brain-csrf": on.secondCsrf!, Origin: ORIGIN },
        body: JSON.stringify({ project_id: "inbox", title: "B3", body: `${MARKER} unknownB3 extractive` }),
      });
      expect(capB3.status).toBe(201);
      const sourceB3 = parseJson(capB3).source_id as string;
      const todayB = await waitFor(
        port,
        "/api/v1/today",
        cookieB,
        (b) =>
          Array.isArray(b?.briefs) &&
          b.briefs.some((x: any) =>
            (x.data.source_versions ?? []).some((v: any) => v.id === sourceB3),
          ),
        "B extractive brief citing the new source",
      );
      const briefB = todayB.briefs.find((x: any) =>
        (x.data.source_versions ?? []).some((v: any) => v.id === sourceB3),
      );
      expect(briefB).toBeDefined();
      expect(briefB.data.mode).toBe("Extractive preview");
      expect(counterLines(counter)).toHaveLength(1);
      expect(readA()?.state).toBe("dispatched");
      expect(readA()?.actual_micro_usd ?? null).toBe(null);
      expect(exited(server!)).toBe(false);
      expect(exited(worker!)).toBe(false);
    } finally {
      await stop(worker);
      await stop(server);
      cleanup(base);
    }
  },
  120_000,
);

it(
  "a configured profile without a provider key keeps capability false and creates no hold",
  async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "bibrain-activation-nokey-")));
    const root = join(base, "managed");
    const counter = join(base, "nokey.counter");
    const on = enrol(root, true);
    let server: Child | undefined;
    let worker: Child | undefined;
    try {
      const env = (extra: Record<string, string>) =>
        sanitizedEnv({
          BRAIN_MODE: "managed",
          BRAIN_MANAGED_ROOT: root,
          BRAIN_PUBLIC_ORIGIN: ORIGIN,
          BRAIN_OIDC_ISSUER: ISSUER,
          BRAIN_OIDC_CLIENT_ID: CLIENT_ID,
          BRAIN_OIDC_CLIENT_SECRET: CLIENT_SECRET,
          BRAIN_MANAGED_ALLOW_PAID: "1",
          ...extra,
        });
      const port = await freePort();
      worker = startMain(
        WORKER_ENTRY,
        env({ BRAIN_MANAGED_ALLOW_PAID: "1", NODE_OPTIONS: `--import ${PRELOAD_URL}`, FAKE_PROVIDER_COUNTER: counter }),
      );
      server = startMain(SERVER_ENTRY, env({ BRAIN_PORT: String(port) }));
      await waitReady(port, server, "nokey server");
      await delay(1500);
      const meta = parseJson(await requestOnce(port, { path: "/api/v1/runtime" }));
      expect(meta.connected_processing_available).toBe(false);

      const cookie = `${SESSION_COOKIE}=${on.token}`;
      const capture = await requestOnce(port, {
        method: "POST",
        path: "/api/v1/sources",
        headers: { Cookie: cookie, "x-brain-csrf": on.csrf, Origin: ORIGIN },
        body: JSON.stringify({ project_id: "inbox", title: "nokey note", body: `${MARKER} nokey` }),
      });
      expect(capture.status).toBe(201);
      const sourceId = parseJson(capture).source_id as string;
      const jobId = parseJson(capture).job?.id;
      expect(typeof jobId).toBe("string");
      const job = await waitForTerminal(port, cookie, jobId, server!, worker!);
      expect(job.status).toBe("failed");
      expect(exited(server!)).toBe(false);
      expect(exited(worker!)).toBe(false);
      expect(counterLines(counter)).toHaveLength(0);
      const persisted = await requestOnce(port, {
        path: `/api/v1/sources/${sourceId}`,
        headers: { Cookie: cookie },
      });
      expect(persisted.status).toBe(200);
      const db = new DatabaseSync(join(root, "control.sqlite"), { readOnly: true });
      try {
        const rows = db.prepare("SELECT count(*) AS n FROM managed_reservations").get() as { n: number };
        expect(Number(rows.n)).toBe(0);
      } finally {
        db.close();
      }
    } finally {
      await stop(worker);
      await stop(server);
      cleanup(base);
    }
  },
  120_000,
);
