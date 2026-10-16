import { expect, it } from "vitest";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Brain } from "../../packages/domain/service.ts";
import { Storage } from "../../packages/storage/index.ts";
import { ManagedRuntime } from "../../packages/runtime/managed.ts";
import { createApp } from "../../apps/server/app.ts";

const ORIGIN = "https://brain.example.test";
const HOST = "brain.example.test";
const ISSUER = "https://issuer.example.test";

let current = "2026-10-16T09:00:00Z";
const clock = () => new Date(current);
const managedRoot = () => mkdtempSync(join(tmpdir(), "bibrain-managed-"));
const cookies = (session: { token: string; csrf: string }) => ({
  host: HOST,
  origin: ORIGIN,
  cookie: `brain_session=${session.token}`,
  "x-brain-csrf": session.csrf,
});

it("managed accounts isolate original capture, retrieval, search and export behind opaque cookie sessions", async () => {
  current = "2026-10-16T09:00:00Z";
  const root = managedRoot();
  const runtime = new ManagedRuntime(root, { clock });
  const app = await createApp(undefined, {
    managed: runtime,
    publicOrigin: ORIGIN,
    static: false,
  });
  try {
    const a = await runtime.provision(ISSUER, "subject-a");
    const b = await runtime.provision(ISSUER, "subject-b");
    expect(a.id).not.toBe(b.id);
    const headersA = cookies(runtime.control.issueSession(a.id));
    const headersB = cookies(runtime.control.issueSession(b.id));

    // The same Idempotency-Key is scoped per tenant and must not collide.
    const savedA = await app.inject({
      method: "POST",
      url: "/api/v1/sources",
      headers: { ...headersA, "idempotency-key": "shared-retry-key" },
      payload: {
        project_id: "inbox",
        title: "Account A note",
        body: "SYNTHETIC_ACCOUNT_A",
      },
    });
    expect(savedA.statusCode).toBe(201);
    const sourceA = savedA.json().source_id as string;

    const savedB = await app.inject({
      method: "POST",
      url: "/api/v1/sources",
      headers: { ...headersB, "idempotency-key": "shared-retry-key" },
      payload: {
        project_id: "inbox",
        title: "Account B note",
        body: "SYNTHETIC_ACCOUNT_B",
      },
    });
    expect(savedB.statusCode).toBe(201);

    // A replayed key in the same tenant with different content still conflicts.
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/sources",
          headers: { ...headersA, "idempotency-key": "shared-retry-key" },
          payload: { project_id: "inbox", title: "Other", body: "different" },
        })
      ).statusCode,
    ).toBe(409);

    expect(
      (
        await app.inject({
          url: `/api/v1/sources/${sourceA}`,
          headers: headersB,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({ url: "/api/v1/search?q=SYNTHETIC", headers: headersB })
      ).body,
    ).not.toContain("SYNTHETIC_ACCOUNT_A");

    const exportA = await app.inject({
      method: "POST",
      url: "/api/v1/exports",
      headers: headersA,
      payload: {},
    });
    const exportB = await app.inject({
      method: "POST",
      url: "/api/v1/exports",
      headers: headersB,
      payload: {},
    });
    expect(exportA.body).toContain("SYNTHETIC_ACCOUNT_A");
    expect(exportA.body).not.toContain("SYNTHETIC_ACCOUNT_B");
    expect(exportB.body).toContain("SYNTHETIC_ACCOUNT_B");
    expect(exportB.body).not.toContain("SYNTHETIC_ACCOUNT_A");
  } finally {
    await app.close();
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("managed sessions enforce CSRF, ignore tenant authority, logout, expire and suspend", async () => {
  current = "2026-10-16T09:00:00Z";
  const root = managedRoot();
  const runtime = new ManagedRuntime(root, { clock });
  const app = await createApp(undefined, {
    managed: runtime,
    publicOrigin: ORIGIN,
    static: false,
  });
  try {
    const a = await runtime.provision(ISSUER, "subject-a");
    const b = await runtime.provision(ISSUER, "subject-b");
    const headersA = cookies(runtime.control.issueSession(a.id));
    const payload = {
      project_id: "inbox",
      title: "Spoof attempt",
      body: "SYNTHETIC_SPOOF_SENTINEL",
    };

    // CSRF is required for state-changing requests.
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/sources",
          headers: { ...headersA, "x-brain-csrf": "wrong" },
          payload,
        })
      ).statusCode,
    ).toBe(403);
    // Existing Host/Origin protection is unchanged.
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/sources",
          headers: { ...headersA, origin: "http://evil.test" },
          payload,
        })
      ).statusCode,
    ).toBe(403);

    // A tenant id in the header or query string never selects the brain.
    const spoofed = await app.inject({
      method: "POST",
      url: `/api/v1/sources?tenant_id=${b.id}&account_id=${b.id}`,
      headers: { ...headersA, "x-brain-tenant": b.id },
      payload,
    });
    expect(spoofed.statusCode).toBe(201);
    const bSearch = await app.inject({
      url: "/api/v1/search?q=SYNTHETIC_SPOOF_SENTINEL",
      headers: cookies(runtime.control.issueSession(b.id)),
    });
    expect(bSearch.body).not.toContain("SYNTHETIC_SPOOF_SENTINEL");

    // Logout invalidates the opaque session.
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: "/api/v1/session",
          headers: headersA,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ url: "/api/v1/today", headers: headersA }))
        .statusCode,
    ).toBe(401);

    // Expiry.
    const expiring = runtime.control.issueSession(a.id);
    current = "2026-10-24T09:00:00Z";
    expect(
      (
        await app.inject({ url: "/api/v1/today", headers: cookies(expiring) })
      ).statusCode,
    ).toBe(401);

    // Suspension revokes access until the account is restored.
    current = "2026-10-16T09:00:00Z";
    const suspended = runtime.control.issueSession(a.id);
    runtime.control.setAccountState(a.id, "suspended");
    expect(
      (
        await app.inject({ url: "/api/v1/today", headers: cookies(suspended) })
      ).statusCode,
    ).toBe(401);
    runtime.control.setAccountState(a.id, "active");
    expect(
      (
        await app.inject({ url: "/api/v1/today", headers: cookies(suspended) })
      ).statusCode,
    ).toBe(200);
  } finally {
    await app.close();
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("managed agent tokens route by the control hash index and revocation is rechecked locally", async () => {
  current = "2026-10-16T09:00:00Z";
  const root = managedRoot();
  const runtime = new ManagedRuntime(root, { clock });
  const app = await createApp(undefined, {
    managed: runtime,
    publicOrigin: ORIGIN,
    static: false,
  });
  try {
    const a = await runtime.provision(ISSUER, "subject-a");
    const owner = cookies(runtime.control.issueSession(a.id));
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/agent-grants",
      headers: owner,
      payload: {
        projects: ["inbox"],
        operations: ["read"],
        expires_at: "2026-10-17T09:00:00Z",
      },
    });
    expect(created.statusCode).toBe(200);
    const { id: grantId, token } = created.json();
    const bearer = { host: HOST, authorization: `Bearer ${token}` };
    expect(
      (
        await app.inject({
          url: "/api/v1/agent/capabilities",
          headers: bearer,
        })
      ).statusCode,
    ).toBe(200);

    // A token never registered in the control index cannot route anywhere.
    expect(
      (
        await app.inject({
          url: "/api/v1/agent/capabilities",
          headers: { host: HOST, authorization: `Bearer ${"a".repeat(64)}` },
        })
      ).statusCode,
    ).toBe(401);

    // Local revocation wins even though the control index still has the hash.
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/v1/agent-grants/${grantId}`,
          headers: owner,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          url: "/api/v1/agent/capabilities",
          headers: bearer,
        })
      ).statusCode,
    ).toBe(401);
  } finally {
    await app.close();
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("managed principals are bound to their own brain in the shared service", async () => {
  current = "2026-10-16T09:00:00Z";
  const root = managedRoot();
  const runtime = new ManagedRuntime(root, { clock });
  const local = new Brain(new Storage(":memory:"));
  try {
    const a = await runtime.provision(ISSUER, "same@example.test");
    expect((await runtime.provision(ISSUER, "same@example.test")).id).toBe(a.id);
    const b = await runtime.provision(
      "https://other-issuer.example.test",
      "same@example.test",
    );
    expect(b.id).not.toBe(a.id);

    const ha = runtime.acquire(a.id);
    const hb = runtime.acquire(b.id);
    try {
      const pa = ha.brain.ownerPrincipal();
      expect(pa.tenantId).toBe(a.id);
      const capture = ha.brain.capture(pa, {
        project_id: "inbox",
        title: "A",
        body: "SYNTHETIC_BOUND_A",
      });
      expect(capture.source_id).toBeTruthy();
      // authenticateAgent returns a tenant-bound principal.
      const grant = ha.brain.createGrant(pa, {
        projects: ["inbox"],
        operations: ["read"],
        expires_at: "2026-10-17T09:00:00Z",
      });
      expect(ha.brain.authenticateAgent(grant.token).tenantId).toBe(a.id);

      // A principal against B's brain, a managed principal against a local
      // brain, and an unbound local principal against a managed brain all fail.
      expect(() => hb.brain.source(pa, capture.source_id)).toThrow();
      expect(() =>
        local.capture(pa, { project_id: "inbox", title: "x", body: "x" }),
      ).toThrow();
      expect(() =>
        ha.brain.capture(
          { kind: "owner" },
          { project_id: "inbox", title: "x", body: "x" },
        ),
      ).toThrow();
      // Local compatibility is retained.
      expect(() =>
        local.capture(
          { kind: "owner" },
          { project_id: "inbox", title: "local", body: "SYNTHETIC_LOCAL" },
        ),
      ).not.toThrow();
    } finally {
      ha.release();
      hb.release();
    }
  } finally {
    runtime.close();
    local.store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("unknown, partial, traversing, file and symlinked tenant paths cannot acquire a runtime", async () => {
  current = "2026-10-16T09:00:00Z";
  const root = managedRoot();
  const runtime = new ManagedRuntime(root, { clock });
  try {
    for (const bad of [
      randomUUID(),
      "../escape",
      "..",
      "not-a-uuid",
      resolve(root, "absolute"),
    ])
      expect(() => runtime.acquire(bad)).toThrow();

    const partial = runtime.control.provision(ISSUER, "partial-subject");
    expect(() => runtime.acquire(partial.id)).toThrow();

    const fileSwap = runtime.control.provision(ISSUER, "file-subject");
    writeFileSync(resolve(root, fileSwap.id), "not a directory");
    expect(() => runtime.acquire(fileSwap.id)).toThrow();

    const linkSwap = runtime.control.provision(ISSUER, "link-subject");
    const target = resolve(root, "link-target");
    mkdirSync(target, { recursive: true });
    symlinkSync(target, resolve(root, linkSwap.id), "junction");
    expect(lstatSync(resolve(root, linkSwap.id)).isSymbolicLink()).toBe(true);
    expect(() => runtime.acquire(linkSwap.id)).toThrow();

    // A provisioned directory removed underneath the runtime also fails closed.
    const removed = await runtime.provision(ISSUER, "removed-subject");
    rmSync(resolve(root, removed.id), { recursive: true, force: true });
    expect(() => runtime.acquire(removed.id)).toThrow();
  } finally {
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("managed provisioning is persistent, idempotent, real-vault backed and pairing-free", async () => {
  current = "2026-10-16T09:00:00Z";
  const root = managedRoot();
  let runtime = new ManagedRuntime(root, { clock });
  let app = await createApp(undefined, {
    managed: runtime,
    publicOrigin: ORIGIN,
    static: false,
  });
  try {
    const a = await runtime.provision(ISSUER, "subject-a");
    const dir = resolve(root, a.id);
    expect(existsSync(resolve(dir, "brain.sqlite"))).toBe(true);
    expect(existsSync(resolve(dir, "vault"))).toBe(true);
    expect(existsSync(resolve(dir, "vault-protected"))).toBe(true);
    expect(existsSync(resolve(dir, "provisioned.json"))).toBe(true);
    expect(runtime.control.account(a.id)?.state).toBe("active");
    // Managed mode never writes a local pairing secret inside the tenant.
    expect(existsSync(resolve(dir, "owner-secret"))).toBe(false);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/session/pair",
          headers: { host: HOST, origin: ORIGIN },
          payload: { secret: "anything" },
        })
      ).statusCode,
    ).toBe(403);

    const session = runtime.control.issueSession(a.id);
    const saved = await app.inject({
      method: "POST",
      url: "/api/v1/sources",
      headers: cookies(session),
      payload: {
        project_id: "inbox",
        title: "Restart",
        body: "SYNTHETIC_RESTART_PERSISTED",
      },
    });
    expect(saved.statusCode).toBe(201);
    const sourceId = saved.json().source_id as string;

    await app.close();
    runtime.close();

    // A fresh runtime over the same root preserves account, session and data.
    runtime = new ManagedRuntime(root, { clock });
    app = await createApp(undefined, {
      managed: runtime,
      publicOrigin: ORIGIN,
      static: false,
    });
    expect((await runtime.provision(ISSUER, "subject-a")).id).toBe(a.id);
    expect(runtime.control.resolveSession(session.token)?.account_id).toBe(a.id);
    const fetched = await app.inject({
      url: `/api/v1/sources/${sourceId}`,
      headers: cookies(session),
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().body).toBe("SYNTHETIC_RESTART_PERSISTED");
  } finally {
    await app.close();
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("managed runtime bounds open handles, evicts idle ones and reopens persisted data", async () => {
  current = "2026-10-16T09:00:00Z";
  const root = managedRoot();
  const runtime = new ManagedRuntime(root, { clock, maxOpen: 2 });
  const releases: Array<() => void> = [];
  const acquire = (tenantId: string) => {
    const handle = runtime.acquire(tenantId);
    releases.push(handle.release);
    return handle;
  };
  try {
    const a = await runtime.provision(ISSUER, "subject-a");
    const b = await runtime.provision(ISSUER, "subject-b");
    const c = await runtime.provision(ISSUER, "subject-c");
    const ha = acquire(a.id);
    ha.brain.capture(ha.brain.ownerPrincipal(), {
      project_id: "inbox",
      title: "Evicted then reopened",
      body: "SYNTHETIC_OBSERVABLE_BOUND",
    });
    const hb = acquire(b.id);
    // At the hard cap with both handles pinned: no unpinned handle exists, so
    // the runtime must fail closed rather than open an unbounded connection.
    expect(() => runtime.acquire(c.id)).toThrow();
    // Releasing one handle makes room; the idle handle is evicted and closed.
    ha.release();
    ha.release(); // release is idempotent
    const hc = acquire(c.id);
    expect(hc.brain.ownerPrincipal().tenantId).toBe(c.id);
    // The evicted handle's database is closed; a read fails closed instead of
    // silently reopening the same path.
    expect(() => ha.brain.sources(ha.brain.ownerPrincipal())).toThrow();
    hb.release();
    hc.release();
    // Reopening the evicted account observes its persisted data.
    const reopened = acquire(a.id);
    expect(
      reopened.brain.sources(reopened.brain.ownerPrincipal()).map((s) => s.body),
    ).toContain("SYNTHETIC_OBSERVABLE_BOUND");
  } finally {
    for (const release of releases) release();
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("managed runtime rejects a tampered marker and never boots a fresh store for a broken tenant", async () => {
  current = "2026-10-16T09:00:00Z";
  const root = managedRoot();
  const runtime = new ManagedRuntime(root, { clock });
  try {
    const a = await runtime.provision(ISSUER, "subject-a");
    const b = await runtime.provision(ISSUER, "subject-b");
    const dir = resolve(root, a.id);
    // A marker that claims another account identity is rejected.
    writeFileSync(
      resolve(dir, "provisioned.json"),
      JSON.stringify({
        schema: 1,
        account_id: b.id,
        issuer: ISSUER,
        subject: "subject-a",
      }),
    );
    expect(() => runtime.acquire(a.id)).toThrow();
    // Restore a correct marker; a missing database then fails closed rather
    // than silently creating a fresh store on acquire.
    writeFileSync(
      resolve(dir, "provisioned.json"),
      JSON.stringify({
        schema: 1,
        account_id: a.id,
        issuer: ISSUER,
        subject: "subject-a",
      }),
    );
    rmSync(resolve(dir, "brain.sqlite"), { force: true });
    expect(() => runtime.acquire(a.id)).toThrow();
    expect(existsSync(resolve(dir, "brain.sqlite"))).toBe(false);
  } finally {
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("managed runtime refuses to close while a handle is pinned, then closes cleanly", async () => {
  current = "2026-10-16T09:00:00Z";
  const root = managedRoot();
  const runtime = new ManagedRuntime(root, { clock });
  try {
    const a = await runtime.provision(ISSUER, "subject-a");
    const handle = runtime.acquire(a.id);
    expect(() => runtime.close()).toThrow();
    handle.release();
    runtime.close();
    // A closed runtime never serves or reopens a tenant.
    expect(() => runtime.acquire(a.id)).toThrow();
  } finally {
    try {
      runtime.close();
    } catch {
      // The lifecycle assertion above already recorded the outcome.
    }
    rmSync(root, { recursive: true, force: true });
  }
});

it("managed mode fails closed without an explicit HTTPS public origin and refuses unsafe roots", async () => {
  const root = managedRoot();
  const runtime = new ManagedRuntime(join(root, "m"), { clock });
  try {
    await expect(
      createApp(undefined, { managed: runtime, static: false }),
    ).rejects.toThrow(/origin/i);
    expect(() => new ManagedRuntime("relative-root")).toThrow();
    writeFileSync(join(root, "afile"), "x");
    expect(() => new ManagedRuntime(join(root, "afile"))).toThrow();
  } finally {
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});
