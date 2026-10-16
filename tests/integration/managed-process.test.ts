import { expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { ManagedRuntime } from "../../packages/runtime/managed.ts";

/**
 * Process-level verification of the 2026-10-16 managed foundation plan. This
 * file is tests-only: it must not modify production code.
 *
 * It spawns the real `apps/server/main.ts` and `apps/worker/main.ts` entry
 * points as separate Node processes under the existing `--import tsx` loader,
 * over a disposable managed root and a random loopback port (never the parent
 * browser's 4317).
 *
 * The HTTP requests are real loopback sockets with `Host` set to a synthetic
 * HTTPS authority to emulate the backend behind a TLS proxy. This is an
 * authority-header contract check, not a TLS or browser-redirect proof.
 *
 * The synthetic OIDC issuer and client secret are configuration only. The
 * adapter resolves the issuer lazily and this test never reaches `/auth/login`,
 * so no live identity, model or provider call is made.
 *
 * On Windows `child.kill()` is a forced termination. This file verifies a real
 * kill/restart persistence path and deliberately does not claim that graceful
 * SIGTERM shutdown handlers were exercised.
 */

const SERVER_ENTRY = "apps/server/main.ts";
const WORKER_ENTRY = "apps/worker/main.ts";

const ISSUER = "https://issuer.synthetic.test";
const ORIGIN = "https://brain.synthetic.test";
const AUTHORITY = "brain.synthetic.test";
const CLIENT_ID = "synthetic-managed-client";
const CLIENT_SECRET = "synthetic-managed-client-secret";
const MARKER = "SYNTHETIC_MANAGED_PROCESS_MARKER";
const SESSION_COOKIE = "brain_session";

const READY_DEADLINE_MS = 15_000;
const MAX_CAPTURED_OUTPUT = 20_000;
const MAX_BODY_BYTES = 4 * 1_048_576;

/**
 * Provider and local-mode variables a managed subprocess must never inherit.
 * The base environment is otherwise preserved so the Node/tsx loader keeps
 * working; only credentials, provider keys and routing variables are removed.
 */
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
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_ORG_ID",
  "ANTHROPIC_API_KEY",
  "TYPESAFE_API_KEY",
  "CLEF_API_TOKEN",
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
    if (output.length < MAX_CAPTURED_OUTPUT) output += chunk.toString("utf8");
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  return { child, output: () => output };
}

async function stop(handle: Child | undefined): Promise<void> {
  if (!handle) return;
  const { child } = handle;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  // Forced termination on Windows; see the file header for the stated limit.
  child.kill();
  await exited;
}

function runToExit(
  handle: Child,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const { child } = handle;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("A fail-closed startup did not exit in time."));
    }, READY_DEADLINE_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("No loopback port was assigned."));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

type HttpResult = {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
};

function requestOnce(
  port: number,
  options: {
    method?: string;
    path: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
  },
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      Host: AUTHORITY,
      ...options.headers,
    };
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
        timeout: options.timeoutMs ?? 5000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total <= MAX_BODY_BYTES) chunks.push(chunk);
        });
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
    req.on("timeout", () => req.destroy(new Error("request timed out")));
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

function parseJson(result: HttpResult): any {
  try {
    return JSON.parse(result.body);
  } catch {
    return undefined;
  }
}

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function exited(handle: Child): boolean {
  return handle.child.exitCode !== null || handle.child.signalCode !== null;
}

async function waitReady(
  port: number,
  handle: Child,
  label: string,
): Promise<void> {
  const deadline = Date.now() + READY_DEADLINE_MS;
  while (Date.now() < deadline) {
    if (exited(handle))
      throw new Error(`${label} exited before becoming ready.`);
    try {
      const health = await requestOnce(port, { path: "/api/v1/health/live" });
      if (health.status === 200) return;
    } catch {
      /* Not listening yet; a fatal child exit is still caught above. */
    }
    await delay(100);
  }
  throw new Error(`${label} was not ready within ${READY_DEADLINE_MS} ms.`);
}

async function waitForBrief(
  port: number,
  cookie: string,
  worker: Child,
): Promise<any> {
  const deadline = Date.now() + READY_DEADLINE_MS;
  let lastStatus = 0;
  while (Date.now() < deadline) {
    if (exited(worker))
      throw new Error("Managed worker exited before producing a brief.");
    const today = await requestOnce(port, {
      path: "/api/v1/today",
      headers: { Cookie: cookie },
    });
    lastStatus = today.status;
    if (today.status === 200) {
      const body = parseJson(today);
      if (Array.isArray(body?.briefs) && body.briefs.length > 0)
        return body.briefs[0];
    }
    await delay(150);
  }
  throw new Error(
    `Managed worker produced no brief within ${READY_DEADLINE_MS} ms (last HTTP ${lastStatus}).`,
  );
}

it(
  "boots the actual managed server and worker over loopback, captures and derives a source-linked extractive brief, and persists source + brief across a real restart",
  async () => {
    // Canonicalize so the runtime's own-real-path check is stable on Windows.
    const base = realpathSync(
      mkdtempSync(join(tmpdir(), "bibrain-managed-process-")),
    );
    const root = join(base, "managed");
    const unusedLocal = join(base, "unused-local");
    const sentinelDb = join(unusedLocal, "brain.sqlite");
    const sentinelSecret = join(unusedLocal, "owner-secret");

    // Trusted fixture: a real managed account and an opaque session are
    // provisioned by a temporary parent runtime, then the parent is closed so
    // the children own the root. There is no identity-header bypass.
    const parent = new ManagedRuntime(root);
    const account = parent.provision(ISSUER, "subject-managed-process");
    const session = parent.control.issueSession(account.id);
    parent.close();

    const managedEnv = (extra: Record<string, string>) =>
      sanitizedEnv({
        BRAIN_MODE: "managed",
        BRAIN_MANAGED_ROOT: root,
        BRAIN_PUBLIC_ORIGIN: ORIGIN,
        BRAIN_OIDC_ISSUER: ISSUER,
        BRAIN_OIDC_CLIENT_ID: CLIENT_ID,
        BRAIN_OIDC_CLIENT_SECRET: CLIENT_SECRET,
        BRAIN_DB: sentinelDb,
        ...extra,
      });

    let server: Child | undefined;
    let worker: Child | undefined;
    try {
      const port = await freePort();
      server = startMain(SERVER_ENTRY, managedEnv({ BRAIN_PORT: String(port) }));
      await waitReady(port, server, "managed server");

      const metadata = parseJson(
        await requestOnce(port, { path: "/api/v1/runtime" }),
      );
      expect(metadata.mode).toBe("managed");
      expect(metadata.sign_in_available).toBe(true);
      expect(metadata.pairing_available).toBe(false);
      expect(metadata.connected_processing_available).toBe(false);

      // Managed accounts never pair locally.
      const pairing = await requestOnce(port, {
        method: "POST",
        path: "/api/v1/session/pair",
        headers: { Origin: ORIGIN },
        body: JSON.stringify({ secret: "irrelevant" }),
      });
      expect(pairing.status).toBe(403);

      // A tenant header is never routing authority: with no session cookie the
      // request is refused even when a plausible tenant id is supplied.
      const spoofedOnly = await requestOnce(port, {
        path: "/api/v1/session",
        headers: { "x-brain-tenant": account.id },
      });
      expect(spoofedOnly.status).toBe(401);

      const cookie = `${SESSION_COOKIE}=${session.token}`;
      const sessionInfo = parseJson(
        await requestOnce(port, {
          path: "/api/v1/session",
          // The same foreign tenant header is present and must be ignored.
          headers: { Cookie: cookie, "x-brain-tenant": account.id },
        }),
      );
      expect(sessionInfo.account_id).toBe(account.id);
      expect(sessionInfo.csrf).toBe(session.csrf);

      const captureBody = `${MARKER} retained through a real worker and restart`;
      const capture = await requestOnce(port, {
        method: "POST",
        path: "/api/v1/sources",
        headers: {
          Cookie: cookie,
          "x-brain-csrf": session.csrf,
          Origin: ORIGIN,
          "Idempotency-Key": "managed-process-1",
        },
        body: JSON.stringify({
          project_id: "inbox",
          title: "Managed process note",
          body: captureBody,
        }),
      });
      expect(capture.status).toBe(201);
      const sourceId = parseJson(capture).source_id as string;
      expect(typeof sourceId).toBe("string");

      // Only the separate worker derives briefs; none exists before it starts.
      const beforeWorker = parseJson(
        await requestOnce(port, {
          path: "/api/v1/today",
          headers: { Cookie: cookie },
        }),
      );
      expect(Array.isArray(beforeWorker.briefs)).toBe(true);
      expect(beforeWorker.briefs.length).toBe(0);

      worker = startMain(WORKER_ENTRY, managedEnv({}));
      const brief = await waitForBrief(port, cookie, worker);
      expect(brief.data.status).toBe("current");
      expect(brief.data.mode).toBe("Extractive preview");
      expect(brief.data.provider).toBe("extractive");
      expect(
        brief.data.source_versions.some((v: any) => v.id === sourceId),
      ).toBe(true);
      expect(brief.data.items[0].evidence[0].source_id).toBe(sourceId);
      expect(JSON.stringify(brief.data)).toContain(MARKER);

      // Real forced termination, then a genuine restart over the same root.
      await stop(worker);
      const workerOutput = worker.output();
      worker = undefined;
      await stop(server);
      const serverOutput = server.output();
      server = undefined;

      const restartedPort = await freePort();
      server = startMain(
        SERVER_ENTRY,
        managedEnv({ BRAIN_PORT: String(restartedPort) }),
      );
      await waitReady(restartedPort, server, "restarted managed server");

      const persistedSource = await requestOnce(restartedPort, {
        path: `/api/v1/sources/${sourceId}`,
        headers: { Cookie: cookie },
      });
      expect(persistedSource.status).toBe(200);
      expect(parseJson(persistedSource).body).toBe(captureBody);

      const persistedToday = parseJson(
        await requestOnce(restartedPort, {
          path: "/api/v1/today",
          headers: { Cookie: cookie },
        }),
      );
      expect(persistedToday.briefs.length).toBeGreaterThan(0);
      const persistedBrief = persistedToday.briefs[0];
      expect(persistedBrief.data.items[0].evidence[0].source_id).toBe(sourceId);
      expect(JSON.stringify(persistedBrief.data)).toContain(MARKER);

      // No secret ever reaches child stdout/stderr. Boolean checks keep the
      // captured output out of assertion failure messages.
      expect(serverOutput.includes(CLIENT_SECRET)).toBe(false);
      expect(serverOutput.includes(session.token)).toBe(false);
      expect(serverOutput.includes(session.csrf)).toBe(false);
      expect(workerOutput.includes(CLIENT_SECRET)).toBe(false);
      expect(workerOutput.includes(session.token)).toBe(false);

      // Managed mode never created the local database or its pairing secret.
      expect(existsSync(sentinelDb)).toBe(false);
      expect(existsSync(sentinelSecret)).toBe(false);
      expect(existsSync(unusedLocal)).toBe(false);
    } finally {
      await stop(worker);
      await stop(server);
      rmSync(base, { recursive: true, force: true });
    }
  },
  90_000,
);

it(
  "fails closed before touching local data when managed startup configuration is invalid on either entry point",
  async () => {
    const base = realpathSync(
      mkdtempSync(join(tmpdir(), "bibrain-managed-invalid-")),
    );
    const root = join(base, "managed");
    const unusedLocal = join(base, "unused-local");
    const sentinelDb = join(unusedLocal, "brain.sqlite");
    const sentinelSecret = join(unusedLocal, "owner-secret");

    const managedFields = {
      BRAIN_MODE: "managed",
      BRAIN_MANAGED_ROOT: root,
      BRAIN_PUBLIC_ORIGIN: ORIGIN,
      BRAIN_OIDC_ISSUER: ISSUER,
      BRAIN_OIDC_CLIENT_ID: CLIENT_ID,
      BRAIN_OIDC_CLIENT_SECRET: CLIENT_SECRET,
    };

    const cases: { label: string; entry: string; env: Record<string, string> }[] =
      [
        {
          label: "server invalid mode",
          entry: SERVER_ENTRY,
          env: { BRAIN_MODE: "unsupported" },
        },
        {
          label: "server non-HTTPS issuer",
          entry: SERVER_ENTRY,
          env: { ...managedFields, BRAIN_OIDC_ISSUER: "http://issuer.synthetic.test" },
        },
        {
          // Root omitted: the worker must fail before provisioning anything.
          label: "worker missing managed root",
          entry: WORKER_ENTRY,
          env: {
            BRAIN_MODE: "managed",
            BRAIN_PUBLIC_ORIGIN: ORIGIN,
            BRAIN_OIDC_ISSUER: ISSUER,
            BRAIN_OIDC_CLIENT_ID: CLIENT_ID,
            BRAIN_OIDC_CLIENT_SECRET: CLIENT_SECRET,
          },
        },
        {
          // A required managed field is missing.
          label: "worker missing client secret",
          entry: WORKER_ENTRY,
          env: {
            BRAIN_MODE: "managed",
            BRAIN_MANAGED_ROOT: root,
            BRAIN_PUBLIC_ORIGIN: ORIGIN,
            BRAIN_OIDC_ISSUER: ISSUER,
            BRAIN_OIDC_CLIENT_ID: CLIENT_ID,
          },
        },
      ];

    try {
      for (const item of cases) {
        const handle = startMain(
          item.entry,
          sanitizedEnv({ BRAIN_DB: sentinelDb, ...item.env }),
        );
        const result = await runToExit(handle);
        // Boolean checks keep captured output, including the synthetic secret,
        // out of any assertion failure message.
        expect(result.code === 0).toBe(false);
        expect(handle.output().includes(CLIENT_SECRET)).toBe(false);
      }

      // Nothing started, so no local database, pairing secret or managed root.
      expect(existsSync(sentinelDb)).toBe(false);
      expect(existsSync(sentinelSecret)).toBe(false);
      expect(existsSync(unusedLocal)).toBe(false);
      expect(existsSync(root)).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  },
  60_000,
);
