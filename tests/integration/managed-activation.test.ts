import { afterEach, expect, it } from "vitest";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { ManagedRuntime } from "../../packages/runtime/managed.ts";
import { ManagedSpendingStore } from "../../packages/storage/managed-spending.ts";
import { managedActivationGate } from "../../apps/server/startup-gates.ts";

/**
 * Managed paid activation stays off in this batch. The pure gate may report a
 * ready policy, but availability is hard-false and the operator CLI is the only
 * policy writer. No provider or model call is made.
 */

const ISSUER = "https://issuer.synthetic.test";
const ORIGIN = "https://brain.synthetic.test";
const AUTHORITY = "brain.synthetic.test";
const roots: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null) child.kill();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function tempRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bibrain-managed-activation-")));
  roots.push(root);
  return root;
}

it("the pure gate can be policy-ready while availability is hard-false", () => {
  const ready = managedActivationGate({
    allowPaid: true,
    hasPeriod: true,
    hasServicePolicy: true,
    hasAccountPolicy: true,
    blocked: false,
  });
  expect(ready).toEqual({ policy_ready: true, reason: "policy_ready" });
  expect(
    managedActivationGate({
      allowPaid: false,
      hasPeriod: true,
      hasServicePolicy: true,
      hasAccountPolicy: true,
      blocked: false,
    }).policy_ready,
  ).toBe(false);
  expect(
    managedActivationGate({
      allowPaid: true,
      hasPeriod: true,
      hasServicePolicy: true,
      hasAccountPolicy: true,
      blocked: true,
    }).reason,
  ).toBe("blocked");
});

function runCli(
  env: Record<string, string>,
  args: string[],
): { status: number | null; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(
      process.execPath,
      ["--import", "tsx", "scripts/managed-policy.ts", ...args],
      { cwd: process.cwd(), env: { ...process.env, ...env }, encoding: "utf8" },
    );
    return { status: 0, stdout, stderr: "" };
  } catch (error: any) {
    return {
      status: error.status ?? 1,
      stdout: String(error.stdout ?? ""),
      stderr: String(error.stderr ?? ""),
    };
  }
}

it("the operator CLI writes only validated policy for a known account", () => {
  const root = tempRoot();
  let accountId = "";
  {
    const runtime = new ManagedRuntime(root);
    accountId = runtime.provision(ISSUER, "cli-account").id;
    runtime.close();
  }

  expect(runCli({ BRAIN_MANAGED_ROOT: root }, ["set-service", "30"]).status).toBe(0);
  const period = runCli({ BRAIN_MANAGED_ROOT: root }, [
    "configure-period",
    accountId,
    "2026-10-16T00:00:00Z",
    "2026-10-18T00:00:00Z",
    "100",
  ]);
  expect(period.status).toBe(0);
  expect(JSON.parse(period.stdout).period_id).toMatch(/[0-9a-f-]{36}/);
  expect(
    runCli({ BRAIN_MANAGED_ROOT: root }, ["set-account", accountId, "10", "10"]).status,
  ).toBe(0);

  const runtime = new ManagedRuntime(root);
  try {
    const store = new ManagedSpendingStore(runtime.control);
    const status = store.accountStatus(accountId);
    expect(status.service?.daily_micro_usd).toBe(30);
    expect(status.policy?.per_job_micro_usd).toBe(10);
    expect(status.period?.allowance_micro_usd).toBe(100);
  } finally {
    runtime.close();
  }
});

it("the operator CLI fails closed on a missing or absent root without creating one", () => {
  const missing = runCli({}, ["set-service", "30"]);
  expect(missing.status).not.toBe(0);
  expect(missing.stderr.toLowerCase()).toContain("brain_managed_root");

  const absent = join(tempRoot(), "does-not-exist");
  const result = runCli({ BRAIN_MANAGED_ROOT: absent }, ["set-service", "30"]);
  expect(result.status).not.toBe(0);
  expect(existsSync(absent)).toBe(false);

  const root = tempRoot();
  const unknown = runCli({ BRAIN_MANAGED_ROOT: root }, [
    "set-account",
    "00000000-0000-4000-8000-000000000000",
    "10",
    "10",
  ]);
  expect(unknown.status).not.toBe(0);
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("No loopback port."));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

function requestOnce(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, method: "GET", path, headers: { Host: AUTHORITY }, timeout: 5000 },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end();
  });
}

async function waitReady(port: number, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("server exited before ready");
    try {
      const health = await requestOnce(port, "/api/v1/health/live");
      if (health.status === 200) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server not ready");
}

async function startServer(port: number, root: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["--import", "tsx", "apps/server/main.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      BRAIN_MODE: "managed",
      BRAIN_MANAGED_ROOT: root,
      BRAIN_PUBLIC_ORIGIN: ORIGIN,
      BRAIN_OIDC_ISSUER: ISSUER,
      BRAIN_OIDC_CLIENT_ID: "synthetic-client",
      BRAIN_OIDC_CLIENT_SECRET: "synthetic-client-secret",
      BRAIN_MANAGED_ALLOW_PAID: "1",
      BRAIN_PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  children.push(child);
  return child;
}

it(
  "reports paid processing unavailable with a positive policy and ALLOW flag, across restart",
  async () => {
    const root = tempRoot();
    let accountId = "";
    {
      const runtime = new ManagedRuntime(root);
      accountId = runtime.provision(ISSUER, "activation-account").id;
      runtime.close();
    }
    expect(runCli({ BRAIN_MANAGED_ROOT: root }, ["set-service", "30"]).status).toBe(0);
    expect(
      runCli({ BRAIN_MANAGED_ROOT: root }, [
        "configure-period",
        accountId,
        "2026-10-16T00:00:00Z",
        "2026-10-18T00:00:00Z",
        "1000",
      ]).status,
    ).toBe(0);
    expect(
      runCli({ BRAIN_MANAGED_ROOT: root }, ["set-account", accountId, "100", "100"]).status,
    ).toBe(0);

    for (let attempt = 0; attempt < 2; attempt++) {
      const port = await freePort();
      const server = await startServer(port, root);
      await waitReady(port, server);
      const metadata = JSON.parse((await requestOnce(port, "/api/v1/runtime")).body);
      expect(metadata.mode).toBe("managed");
      expect(metadata.connected_processing_available).toBe(false);
      expect(metadata.managed_paid_reason).toContain("not enabled");
      server.kill();
      await new Promise<void>((resolve) => server.once("exit", () => resolve()));
    }
  },
  60_000,
);
