import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ManagedRuntime } from "../../packages/runtime/managed.ts";
import {
  OidcClient,
  OIDC_TRANSACTION_TTL_MS,
} from "../../packages/identity/oidc.ts";
import {
  ManagedLogin,
  ManagedLoginError,
  OIDC_CORRELATION_TTL_MS,
  type BeginResult,
  type LoginAdapter,
} from "../../packages/identity/managed-login.ts";
import { startFakeIssuer } from "../helpers/oidc-provider.ts";
import { createApp } from "../../apps/server/app.ts";

const ISSUER = "https://issuer.example.test";
const ORIGIN = "https://brain.example.test";
const HOST = "brain.example.test";
const CALLBACK = `${ORIGIN}/auth/callback`;
const START = Date.parse("2026-10-16T09:00:00Z");

let currentMs = START;
const clock = () => new Date(currentMs);
const managedRoot = () => mkdtempSync(join(tmpdir(), "bibrain-login-"));

const cookies = (session: { token: string; csrf: string }) => ({
  host: HOST,
  origin: ORIGIN,
  cookie: `brain_session=${session.token}`,
  "x-brain-csrf": session.csrf,
});

const hash = (token: string) =>
  createHash("sha256").update(token).digest("hex");

const count = (runtime: ManagedRuntime, table: string) =>
  (
    runtime.control.db
      .prepare(`SELECT COUNT(*) AS n FROM ${table}`)
      .get() as { n: number }
  ).n;

type Stub = LoginAdapter & {
  calls: { begin: number; complete: number };
  identity: { issuer: string; subject: string; displayName?: string };
  failComplete: boolean;
};

/**
 * Structural boundary fake implementing only the public adapter surface. The
 * real OidcClient is exercised separately against the local fake issuer; these
 * cases isolate coordinator durability, atomicity and normalization.
 */
function makeStub(): Stub {
  const stub: Stub = {
    callbackUri: CALLBACK,
    calls: { begin: 0, complete: 0 },
    identity: {
      issuer: ISSUER,
      subject: "subject-a",
      displayName: "Synthetic Owner",
    },
    failComplete: false,
    async begin() {
      stub.calls.begin += 1;
      return {
        authorizationUrl: `${ISSUER}/authorize?client_id=stub`,
        transaction: {
          state: `state-${stub.calls.begin}`,
          nonce: `nonce-${stub.calls.begin}`,
          codeVerifier: "synthetic-code-verifier-value-for-tests",
          issuedAt: currentMs,
          redirectUri: CALLBACK,
        },
      };
    },
    async complete() {
      stub.calls.complete += 1;
      if (stub.failComplete)
        throw new Error("synthetic identity rejection with no secrets");
      return { ...stub.identity };
    },
  };
  return stub;
}

it("begin persists a hashed, short-lived correlation transaction in the shared control database", async () => {
  currentMs = START;
  const root = managedRoot();
  const runtime = new ManagedRuntime(root, { clock });
  try {
    const login = new ManagedLogin(runtime, makeStub());
    const started = await login.begin();
    expect(started.correlationToken).toMatch(/^[a-f0-9]{64}$/);
    expect(started.authorizationUrl).toContain(ISSUER);
    expect(started.expires_at).toBe(
      new Date(currentMs + OIDC_TRANSACTION_TTL_MS).toISOString(),
    );

    const rows = runtime.control.db
      .prepare(
        'SELECT token_hash, "transaction", expires_at FROM oidc_transactions',
      )
      .all() as Array<{
      token_hash: string;
      transaction: string;
      expires_at: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).toBe(hash(started.correlationToken));
    expect(rows[0].token_hash).not.toBe(started.correlationToken);
    expect(rows[0].transaction).not.toContain(started.correlationToken);
    expect(rows[0].expires_at).toBe(started.expires_at);
  } finally {
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("keeps a pending login durable across a new runtime and coordinator instance on the same root", async () => {
  currentMs = START;
  const root = managedRoot();
  let runtime = new ManagedRuntime(root, { clock });
  try {
    const first = new ManagedLogin(runtime, makeStub());
    const started = await first.begin();
    runtime.close();

    runtime = new ManagedRuntime(root, { clock });
    const resumed = new ManagedLogin(runtime, makeStub());
    const session = await resumed.complete(
      `${CALLBACK}?code=stub&state=stub`,
      started.correlationToken,
    );
    const account = await runtime.provision(ISSUER, "subject-a");
    expect(runtime.control.resolveSession(session.token)?.account_id).toBe(
      account.id,
    );
    // The correlation row is consumed and cannot be replayed after restart.
    expect(count(runtime, "oidc_transactions")).toBe(0);
    await expect(
      resumed.complete(`${CALLBACK}?code=stub&state=stub`, started.correlationToken),
    ).rejects.toMatchObject({ code: "LOGIN_CORRELATION_MISSING" });
  } finally {
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("atomically consumes the record so simultaneous callbacks yield exactly one session", async () => {
  currentMs = START;
  const root = managedRoot();
  const runtime = new ManagedRuntime(root, { clock });
  const stub = makeStub();
  try {
    const login = new ManagedLogin(runtime, stub);
    const started = await login.begin();
    const callback = `${CALLBACK}?code=stub&state=stub`;
    const results = await Promise.allSettled([
      login.complete(callback, started.correlationToken),
      login.complete(callback, started.correlationToken),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(ManagedLoginError);
    expect((rejected[0].reason as ManagedLoginError).code).toBe(
      "LOGIN_CORRELATION_MISSING",
    );
    // The provider is contacted at most once for the single-use record.
    expect(stub.calls.complete).toBe(1);
    expect(count(runtime, "managed_sessions")).toBe(1);
  } finally {
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("denies expired, malformed and missing correlations without contacting the provider", async () => {
  currentMs = START;
  const root = managedRoot();
  const runtime = new ManagedRuntime(root, { clock });
  const stub = makeStub();
  try {
    const login = new ManagedLogin(runtime, stub);
    // Missing and malformed tokens are rejected before any network call.
    await expect(
      login.complete(CALLBACK, "a".repeat(64)),
    ).rejects.toMatchObject({ code: "LOGIN_CORRELATION_MISSING" });
    await expect(
      login.complete(CALLBACK, "not-a-correlation-token"),
    ).rejects.toMatchObject({ code: "LOGIN_CORRELATION_INVALID" });
    await expect(
      login.complete(CALLBACK, "A".repeat(64)),
    ).rejects.toMatchObject({ code: "LOGIN_CORRELATION_INVALID" });
    expect(stub.calls.complete).toBe(0);

    // An expired correlation is consumed and denied without a provider call.
    const expired = await login.begin();
    currentMs = START + OIDC_TRANSACTION_TTL_MS + 1;
    await expect(
      login.complete(`${CALLBACK}?code=x&state=y`, expired.correlationToken),
    ).rejects.toMatchObject({ code: "LOGIN_TRANSACTION_EXPIRED" });
    expect(stub.calls.complete).toBe(0);
    expect(count(runtime, "oidc_transactions")).toBe(0);

    // A persisted record whose JSON does not match the schema is denied.
    currentMs = START;
    const malformed = await login.begin();
    runtime.control.db
      .prepare(
        'UPDATE oidc_transactions SET "transaction"=? WHERE token_hash=?',
      )
      .run("{not valid json", hash(malformed.correlationToken));
    await expect(
      login.complete(`${CALLBACK}?code=x&state=y`, malformed.correlationToken),
    ).rejects.toMatchObject({ code: "LOGIN_TRANSACTION_INVALID" });
    expect(stub.calls.complete).toBe(0);
    expect(count(runtime, "managed_sessions")).toBe(0);
  } finally {
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("consumes the record when the provider rejects the identity and denies the replay", async () => {
  currentMs = START;
  const root = managedRoot();
  const runtime = new ManagedRuntime(root, { clock });
  const stub = makeStub();
  stub.failComplete = true;
  try {
    const login = new ManagedLogin(runtime, stub);
    const started = await login.begin();
    const callback = `${CALLBACK}?code=stub&state=stub`;
    await expect(
      login.complete(callback, started.correlationToken),
    ).rejects.toBeInstanceOf(ManagedLoginError);
    expect(stub.calls.complete).toBe(1);
    // The failed attempt is still consumed; a replay never reaches the provider.
    await expect(
      login.complete(callback, started.correlationToken),
    ).rejects.toMatchObject({ code: "LOGIN_CORRELATION_MISSING" });
    expect(stub.calls.complete).toBe(1);
    expect(count(runtime, "managed_sessions")).toBe(0);
  } finally {
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("never issues a session for a suspended account and never reactivates it", async () => {
  currentMs = START;
  const root = managedRoot();
  const runtime = new ManagedRuntime(root, { clock });
  try {
    const account = await runtime.provision(ISSUER, "subject-a");
    runtime.control.setAccountState(account.id, "suspended");
    const login = new ManagedLogin(runtime, makeStub());
    const started = await login.begin();
    await expect(
      login.complete(`${CALLBACK}?code=x&state=y`, started.correlationToken),
    ).rejects.toMatchObject({ code: "LOGIN_ACCOUNT_UNAVAILABLE" });
    expect(runtime.control.account(account.id)?.state).toBe("suspended");
    expect(count(runtime, "managed_sessions")).toBe(0);
    expect(() => runtime.acquire(account.id)).toThrow();
  } finally {
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("rotates the previous same-account session only after a successful new issuance", async () => {
  currentMs = START;
  const root = managedRoot();
  const runtime = new ManagedRuntime(root, { clock });
  const stub = makeStub();
  try {
    const login = new ManagedLogin(runtime, stub);
    const first = await login.complete(
      `${CALLBACK}?code=1&state=1`,
      (await login.begin()).correlationToken,
    );
    const second = await login.complete(
      `${CALLBACK}?code=2&state=2`,
      (await login.begin()).correlationToken,
      first.token,
    );
    const account = await runtime.provision(ISSUER, "subject-a");
    expect(runtime.control.resolveSession(first.token)).toBeUndefined();
    expect(runtime.control.resolveSession(second.token)?.account_id).toBe(
      account.id,
    );

    // A token belonging to another account is never revoked by a login into a
    // different account, and it does not rotate the current account's session.
    stub.identity = { issuer: ISSUER, subject: "subject-b" };
    const other = await login.complete(
      `${CALLBACK}?code=3&state=3`,
      (await login.begin()).correlationToken,
    );
    stub.identity = { issuer: ISSUER, subject: "subject-a" };
    const again = await login.complete(
      `${CALLBACK}?code=4&state=4`,
      (await login.begin()).correlationToken,
      other.token,
    );
    const accountB = await runtime.provision(ISSUER, "subject-b");
    expect(runtime.control.resolveSession(other.token)?.account_id).toBe(
      accountB.id,
    );
    // The unrelated token did not rotate account A's live session either.
    expect(runtime.control.resolveSession(second.token)?.account_id).toBe(
      account.id,
    );
    expect(runtime.control.resolveSession(again.token)?.account_id).toBe(
      account.id,
    );
  } finally {
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("rejects admission at capacity instead of evicting a valid pending callback", async () => {
  currentMs = START;
  const root = managedRoot();
  const runtime = new ManagedRuntime(root, { clock });
  try {
    const login = new ManagedLogin(runtime, makeStub(), { maxOutstanding: 3 });
    const first = await login.begin();
    currentMs += 1;
    await login.begin();
    currentMs += 1;
    await login.begin();
    expect(count(runtime, "oidc_transactions")).toBe(3);

    // A public start at capacity is refused with a content-free error and
    // destroys no valid, unexpired callback.
    await expect(login.begin()).rejects.toMatchObject({
      code: "LOGIN_CAPACITY",
    });
    expect(count(runtime, "oidc_transactions")).toBe(3);

    // Every preserved callback is still redeemable after the refusal.
    const session = await login.complete(
      `${CALLBACK}?code=keep&state=keep`,
      first.correlationToken,
    );
    expect(runtime.control.resolveSession(session.token)).toBeTruthy();
    expect(count(runtime, "oidc_transactions")).toBe(2);

    // Expired rows are pruned on admission; only then is a fresh start accepted.
    currentMs = START + OIDC_CORRELATION_TTL_MS + 1000;
    const fresh = await login.begin();
    expect(count(runtime, "oidc_transactions")).toBe(1);
    await expect(
      login.complete(
        `${CALLBACK}?code=fresh&state=fresh`,
        fresh.correlationToken,
      ),
    ).resolves.toBeTruthy();
  } finally {
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("admits no more than the shared capacity across two control-store connections with no leak or race", async () => {
  currentMs = START;
  const root = managedRoot();
  const runtimeA = new ManagedRuntime(root, { clock });
  const runtimeB = new ManagedRuntime(root, { clock });
  try {
    const loginA = new ManagedLogin(runtimeA, makeStub(), { maxOutstanding: 4 });
    const loginB = new ManagedLogin(runtimeB, makeStub(), { maxOutstanding: 4 });
    const results = await Promise.allSettled([
      loginA.begin(),
      loginA.begin(),
      loginA.begin(),
      loginA.begin(),
      loginB.begin(),
      loginB.begin(),
      loginB.begin(),
      loginB.begin(),
    ]);
    const admitted = results.filter(
      (result): result is PromiseFulfilledResult<BeginResult> =>
        result.status === "fulfilled",
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(admitted).toHaveLength(4);
    expect(rejected).toHaveLength(4);
    for (const result of rejected)
      expect(result.reason).toMatchObject({ code: "LOGIN_CAPACITY" });

    // Exactly the admitted rows exist, seen identically from either connection:
    // no overflow rows and no unexpired row evicted.
    expect(count(runtimeA, "oidc_transactions")).toBe(4);
    expect(count(runtimeB, "oidc_transactions")).toBe(4);

    // A correlation admitted on connection A is redeemable through connection B.
    const session = await loginB.complete(
      `${CALLBACK}?code=cross&state=cross`,
      admitted[0].value.correlationToken,
    );
    expect(runtimeA.control.resolveSession(session.token)).toBeTruthy();
    expect(count(runtimeA, "oidc_transactions")).toBe(3);
  } finally {
    runtimeA.close();
    runtimeB.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("completes a real fake-issuer code exchange and isolates two captured identities through the app", async () => {
  currentMs = START;
  const issuer = await startFakeIssuer({ subject: "subject-a" });
  const root = managedRoot();
  const runtime = new ManagedRuntime(root, { clock });
  const app = await createApp(undefined, {
    managed: runtime,
    publicOrigin: ORIGIN,
    static: false,
  });
  try {
    const oidc = new OidcClient({
      issuer: issuer.issuer,
      clientId: issuer.clientId,
      clientSecret: issuer.clientSecret,
      publicOrigin: ORIGIN,
      callbackPath: issuer.callbackPath,
      customFetch: issuer.fetcher,
      now: () => currentMs,
    });
    const login = new ManagedLogin(runtime, oidc);

    const startA = await login.begin();
    const callbackA = await issuer.authorize(startA.authorizationUrl);
    const sessionA = await login.complete(callbackA, startA.correlationToken);

    issuer.setIdentity("subject-b", "Second Owner");
    const startB = await login.begin();
    const callbackB = await issuer.authorize(startB.authorizationUrl);
    const sessionB = await login.complete(callbackB, startB.correlationToken);

    // Identity is keyed by (issuer, subject); display names are never keys.
    const accountA = await runtime.provision(issuer.issuer, "subject-a");
    const accountB = await runtime.provision(issuer.issuer, "subject-b");
    expect(accountA.id).not.toBe(accountB.id);
    expect(
      runtime.control.resolveSession(sessionA.token)?.account_id,
    ).toBe(accountA.id);
    expect(
      runtime.control.resolveSession(sessionB.token)?.account_id,
    ).toBe(accountB.id);

    const savedA = await app.inject({
      method: "POST",
      url: "/api/v1/sources",
      headers: cookies(sessionA),
      payload: {
        project_id: "inbox",
        title: "Signed in A",
        body: "SYNTHETIC_LOGIN_A",
      },
    });
    expect(savedA.statusCode).toBe(201);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/sources",
          headers: cookies(sessionB),
          payload: {
            project_id: "inbox",
            title: "Signed in B",
            body: "SYNTHETIC_LOGIN_B",
          },
        })
      ).statusCode,
    ).toBe(201);

    const sourceA = savedA.json().source_id as string;
    expect(
      (
        await app.inject({
          url: `/api/v1/sources/${sourceA}`,
          headers: cookies(sessionB),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          url: "/api/v1/search?q=SYNTHETIC_LOGIN",
          headers: cookies(sessionB),
        })
      ).body,
    ).not.toContain("SYNTHETIC_LOGIN_A");

    // The real adapter exchanged both codes exactly once and no correlation
    // record or raw cookie token remains at rest.
    expect(issuer.calls.token).toBe(2);
    expect(issuer.pendingCodes()).toBe(0);
    expect(count(runtime, "oidc_transactions")).toBe(0);
  } finally {
    await app.close();
    runtime.close();
    await issuer.close();
    rmSync(root, { recursive: true, force: true });
  }
});
