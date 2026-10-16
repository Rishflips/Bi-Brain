import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createApp } from "../../apps/server/app.ts";
import { ManagedRuntime } from "../../packages/runtime/managed.ts";
import { OidcClient } from "../../packages/identity/oidc.ts";
import { ManagedLogin } from "../../packages/identity/managed-login.ts";
import {
  startFakeIssuer,
  type FakeIssuer,
} from "../helpers/oidc-provider.ts";

const ORIGIN = "https://brain.example.test";
const HOST = "brain.example.test";
const CALLBACK_PATH = "/auth/callback";
const SESSION_MAX_AGE = 7 * 86400;

let currentMs = Date.now();
const clock = () => new Date(currentMs);

const cookieValue = (
  setCookie: string | string[] | undefined,
  name: string,
): string => {
  const values = Array.isArray(setCookie) ? setCookie : [setCookie ?? ""];
  for (const raw of values) {
    const match = new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(raw);
    if (match && match[1] !== "") return match[1];
  }
  return "";
};
const setCookieFor = (setCookie: string | string[] | undefined, name: string) => {
  const values = Array.isArray(setCookie) ? setCookie : [setCookie ?? ""];
  return values.find((raw) => raw.startsWith(`${name}=`)) ?? "";
};

const count = (runtime: ManagedRuntime, table: string) =>
  (
    runtime.control.db
      .prepare(`SELECT COUNT(*) AS n FROM ${table}`)
      .get() as { n: number }
  ).n;

type Harness = {
  issuer: FakeIssuer;
  runtime: ManagedRuntime;
  app: Awaited<ReturnType<typeof createApp>>;
  close: () => Promise<void>;
};

async function harness(
  options: { subject?: string; metadataLogs?: boolean } = {},
): Promise<Harness> {
  const issuer = await startFakeIssuer({ subject: options.subject ?? "subject-a" });
  const root = mkdtempSync(join(tmpdir(), "bibrain-http-login-"));
  const runtime = new ManagedRuntime(root, { clock });
  const oidc = new OidcClient({
    issuer: issuer.issuer,
    clientId: issuer.clientId,
    clientSecret: issuer.clientSecret,
    publicOrigin: ORIGIN,
    callbackPath: CALLBACK_PATH,
    customFetch: issuer.fetcher,
    now: () => currentMs,
  });
  const login = new ManagedLogin(runtime, oidc);
  const app = await createApp(undefined, {
    managed: runtime,
    login,
    oidcCallbackPath: CALLBACK_PATH,
    publicOrigin: ORIGIN,
    static: false,
    metadataLogs: options.metadataLogs,
  });
  return {
    issuer,
    runtime,
    app,
    close: async () => {
      await app.close();
      try {
        runtime.close();
      } catch {
        /* a pinned handle must not mask a test failure */
      }
      await issuer.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function startLogin(app: Harness["app"], query = "") {
  const response = await app.inject({
    url: `/auth/login${query}`,
    headers: { host: HOST },
  });
  return {
    response,
    location: String(response.headers.location),
    correlation: cookieValue(response.headers["set-cookie"], "brain_login"),
  };
}

async function finishLogin(
  app: Harness["app"],
  issuer: FakeIssuer,
  authorizationUrl: string,
  correlation: string,
  headers: Record<string, string> = {},
) {
  const callback = await issuer.authorize(authorizationUrl);
  const url = new URL(callback);
  const response = await app.inject({
    url: url.pathname + url.search,
    headers: {
      host: HOST,
      cookie: `brain_login=${correlation}`,
      ...headers,
    },
  });
  return {
    response,
    callback,
    session: cookieValue(response.headers["set-cookie"], "brain_session"),
  };
}

it("drives a real fake-issuer login through routes, cookies, capture, search, logout and relogin", async () => {
  currentMs = Date.now();
  const { issuer, runtime, app, close } = await harness();
  try {
    const login = await startLogin(app);
    expect(login.response.statusCode).toBe(302);
    expect(login.location.startsWith(`${issuer.issuer}/authorize`)).toBe(true);
    expect(login.location).toContain("code_challenge_method=S256");
    expect(login.location).toContain("response_type=code");
    expect(login.location).toContain(encodeURIComponent(`${ORIGIN}${CALLBACK_PATH}`));
    // No token, CSRF value or correlation secret is ever placed in a URL.
    expect(login.location).not.toContain(login.correlation);
    expect(login.location).not.toContain("csrf");

    const correlationCookie = setCookieFor(
      login.response.headers["set-cookie"],
      "brain_login",
    );
    expect(correlationCookie).toMatch(/HttpOnly/i);
    expect(correlationCookie).toMatch(/Secure/i);
    expect(correlationCookie).toMatch(/SameSite=Lax/i);
    expect(correlationCookie).toMatch(/Path=\/auth\/callback/i);
    expect(login.correlation).toMatch(/^[a-f0-9]{64}$/);

    const done = await finishLogin(app, issuer, login.location, login.correlation);
    expect(done.response.statusCode).toBe(303);
    expect(done.response.headers.location).toBe("/");
    expect(done.session).toMatch(/^[a-f0-9]{64}$/);
    const sessionCookie = setCookieFor(
      done.response.headers["set-cookie"],
      "brain_session",
    );
    expect(sessionCookie).toMatch(/HttpOnly/i);
    expect(sessionCookie).toMatch(/Secure/i);
    expect(sessionCookie).toMatch(/SameSite=Strict/i);
    expect(sessionCookie).toMatch(/Path=\//i);
    const maxAge = Number(/Max-Age=(\d+)/i.exec(sessionCookie)?.[1]);
    expect(maxAge).toBeGreaterThan(SESSION_MAX_AGE - 120);
    expect(maxAge).toBeLessThanOrEqual(SESSION_MAX_AGE);
    // The one-time correlation cookie is cleared on success.
    expect(
      setCookieFor(done.response.headers["set-cookie"], "brain_login"),
    ).toMatch(/brain_login=;/);

    const session = await app.inject({
      url: "/api/v1/session",
      headers: { host: HOST, cookie: `brain_session=${done.session}` },
    });
    expect(session.statusCode).toBe(200);
    expect(typeof session.json().account_id).toBe("string");
    const csrf = session.json().csrf as string;

    const saved = await app.inject({
      method: "POST",
      url: "/api/v1/sources",
      headers: {
        host: HOST,
        origin: ORIGIN,
        cookie: `brain_session=${done.session}`,
        "x-brain-csrf": csrf,
        "idempotency-key": "login-route-1",
      },
      payload: {
        project_id: "inbox",
        title: "Signed in",
        body: "SYNTHETIC_HTTP_LOGIN_MARKER",
      },
    });
    expect(saved.statusCode).toBe(201);

    const search = await app.inject({
      url: "/api/v1/search?q=SYNTHETIC_HTTP_LOGIN_MARKER",
      headers: { host: HOST, cookie: `brain_session=${done.session}` },
    });
    expect(search.body).toContain("SYNTHETIC_HTTP_LOGIN_MARKER");

    const signOut = await app.inject({
      method: "DELETE",
      url: "/api/v1/session",
      headers: {
        host: HOST,
        origin: ORIGIN,
        cookie: `brain_session=${done.session}`,
        "x-brain-csrf": csrf,
      },
    });
    expect(signOut.statusCode).toBe(200);
    expect(signOut.json().signed_out).toBe(true);
    expect(
      (
        await app.inject({
          url: "/api/v1/session",
          headers: { host: HOST, cookie: `brain_session=${done.session}` },
        })
      ).statusCode,
    ).toBe(401);

    // Relogin with the same subject recovers the same account and its work.
    const again = await startLogin(app);
    const againDone = await finishLogin(
      app,
      issuer,
      again.location,
      again.correlation,
    );
    expect(againDone.response.statusCode).toBe(303);
    const recovered = await app.inject({
      url: "/api/v1/search?q=SYNTHETIC_HTTP_LOGIN_MARKER",
      headers: { host: HOST, cookie: `brain_session=${againDone.session}` },
    });
    expect(recovered.body).toContain("SYNTHETIC_HTTP_LOGIN_MARKER");

    // Two codes were exchanged, one per successful sign-in, and no pending
    // correlation record remains.
    expect(issuer.calls.token).toBe(2);
    expect(issuer.pendingCodes()).toBe(0);
    expect(count(runtime, "oidc_transactions")).toBe(0);
  } finally {
    await close();
  }
});

it("rejects replayed and tampered callbacks without issuing a session or contacting the provider twice", async () => {
  currentMs = Date.now();
  const { issuer, runtime, app, close } = await harness();
  try {
    const started = await startLogin(app);
    const done = await finishLogin(
      app,
      issuer,
      started.location,
      started.correlation,
    );
    expect(done.response.statusCode).toBe(303);
    expect(issuer.calls.token).toBe(1);

    // Replaying the consumed correlation never reaches the token endpoint.
    const replay = await app.inject({
      url: new URL(done.callback).pathname + new URL(done.callback).search,
      headers: { host: HOST, cookie: `brain_login=${started.correlation}` },
    });
    expect(replay.statusCode).toBe(400);
    expect(String(replay.headers["content-type"])).toContain("text/html");
    expect(replay.headers["set-cookie"]).toBeDefined();
    expect(cookieValue(replay.headers["set-cookie"], "brain_session")).toBe("");
    expect(replay.body).not.toContain("code-");
    expect(issuer.calls.token).toBe(1);

    // A tampered state is refused; the correlation is still consumed.
    const fresh = await startLogin(app);
    const tampered = await issuer.authorize(fresh.location);
    const url = new URL(tampered);
    url.searchParams.set("state", "tampered-state-value");
    const wrongState = await app.inject({
      url: url.pathname + url.search,
      headers: { host: HOST, cookie: `brain_login=${fresh.correlation}` },
    });
    expect(wrongState.statusCode).toBe(400);
    expect(cookieValue(wrongState.headers["set-cookie"], "brain_session")).toBe("");
    expect(count(runtime, "oidc_transactions")).toBe(0);
  } finally {
    await close();
  }
});

it("isolates two identities and never shares one account's work with another", async () => {
  currentMs = Date.now();
  const { issuer, app, close } = await harness();
  try {
    const first = await startLogin(app);
    const a = await finishLogin(app, issuer, first.location, first.correlation);
    const sessionA = await app.inject({
      url: "/api/v1/session",
      headers: { host: HOST, cookie: `brain_session=${a.session}` },
    });
    const csrfA = sessionA.json().csrf as string;
    await app.inject({
      method: "POST",
      url: "/api/v1/sources",
      headers: {
        host: HOST,
        origin: ORIGIN,
        cookie: `brain_session=${a.session}`,
        "x-brain-csrf": csrfA,
      },
      payload: { project_id: "inbox", title: "A", body: "SYNTHETIC_ACCOUNT_A" },
    });

    issuer.setIdentity("subject-b", "Second Owner");
    const second = await startLogin(app);
    const b = await finishLogin(app, issuer, second.location, second.correlation);
    const sessionB = await app.inject({
      url: "/api/v1/session",
      headers: { host: HOST, cookie: `brain_session=${b.session}` },
    });
    const csrfB = sessionB.json().csrf as string;
    await app.inject({
      method: "POST",
      url: "/api/v1/sources",
      headers: {
        host: HOST,
        origin: ORIGIN,
        cookie: `brain_session=${b.session}`,
        "x-brain-csrf": csrfB,
      },
      payload: { project_id: "inbox", title: "B", body: "SYNTHETIC_ACCOUNT_B" },
    });

    expect(sessionA.json().account_id).not.toBe(sessionB.json().account_id);
    const searchB = await app.inject({
      url: "/api/v1/search?q=SYNTHETIC_ACCOUNT",
      headers: { host: HOST, cookie: `brain_session=${b.session}` },
    });
    expect(searchB.body).toContain("SYNTHETIC_ACCOUNT_B");
    expect(searchB.body).not.toContain("SYNTHETIC_ACCOUNT_A");
  } finally {
    await close();
  }
});

it("keeps captured work across a server restart on the same managed root", async () => {
  currentMs = Date.now();
  const issuer = await startFakeIssuer({ subject: "subject-a" });
  const root = mkdtempSync(join(tmpdir(), "bibrain-http-restart-"));
  let runtime = new ManagedRuntime(root, { clock });
  const build = async () => {
    const oidc = new OidcClient({
      issuer: issuer.issuer,
      clientId: issuer.clientId,
      clientSecret: issuer.clientSecret,
      publicOrigin: ORIGIN,
      callbackPath: CALLBACK_PATH,
      customFetch: issuer.fetcher,
      now: () => currentMs,
    });
    const login = new ManagedLogin(runtime, oidc);
    return createApp(undefined, {
      managed: runtime,
      login,
      oidcCallbackPath: CALLBACK_PATH,
      publicOrigin: ORIGIN,
      static: false,
    });
  };
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    app = await build();
    const started = await startLogin(app);
    const done = await finishLogin(app, issuer, started.location, started.correlation);
    const session = await app.inject({
      url: "/api/v1/session",
      headers: { host: HOST, cookie: `brain_session=${done.session}` },
    });
    await app.inject({
      method: "POST",
      url: "/api/v1/sources",
      headers: {
        host: HOST,
        origin: ORIGIN,
        cookie: `brain_session=${done.session}`,
        "x-brain-csrf": session.json().csrf,
      },
      payload: {
        project_id: "inbox",
        title: "Persisted",
        body: "SYNTHETIC_RESTART_MARKER",
      },
    });
    await app.close();
    app = undefined;
    runtime.close();

    runtime = new ManagedRuntime(root, { clock });
    app = await build();
    const persisted = await app.inject({
      url: "/api/v1/search?q=SYNTHETIC_RESTART_MARKER",
      headers: { host: HOST, cookie: `brain_session=${done.session}` },
    });
    expect(persisted.statusCode).toBe(200);
    expect(persisted.body).toContain("SYNTHETIC_RESTART_MARKER");
    await app.close();
    app = undefined;
    runtime.close();
  } finally {
    if (app) {
      try {
        await app.close();
      } catch {
        /* already closing */
      }
    }
    try {
      runtime.close();
    } catch {
      /* already closed */
    }
    await issuer.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("refuses a foreign origin and an over-long callback path with static, safe pages", async () => {
  currentMs = Date.now();
  const { issuer, app, close } = await harness();
  try {
    const started = await startLogin(app);
    const foreign = await app.inject({
      url: `${CALLBACK_PATH}?code=x&state=y`,
      headers: {
        host: HOST,
        origin: "https://evil.example.test",
        cookie: `brain_login=${started.correlation}`,
      },
    });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json().error.message).toBe(
      "This sign-in page cannot be opened from another site.",
    );

    const extra = await app.inject({
      url: `${CALLBACK_PATH}/extra?code=x`,
      headers: { host: HOST },
    });
    expect(extra.statusCode).toBe(404);
    // The provider is never consulted for a path this server does not serve.
    expect(issuer.calls.token).toBe(0);
  } finally {
    await close();
  }
});

it("shows an explicit unavailable state when managed sign-in is not configured", async () => {
  const root = mkdtempSync(join(tmpdir(), "bibrain-http-nologin-"));
  const runtime = new ManagedRuntime(root, { clock });
  const app = await createApp(undefined, {
    managed: runtime,
    publicOrigin: ORIGIN,
    static: false,
  });
  try {
    const page = await app.inject({
      url: "/auth/login",
      headers: { host: HOST },
    });
    expect(page.statusCode).toBe(503);
    expect(String(page.headers["content-type"])).toContain("text/html");
    expect(page.body).toContain("Sign-in is not configured");
    expect(page.headers["set-cookie"]).toBeUndefined();
  } finally {
    await app.close();
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("rate-limits sign-in starts well below the general poll limit", async () => {
  currentMs = Date.now();
  const { app, close } = await harness();
  try {
    let limited = 0;
    for (let attempt = 0; attempt < 11; attempt += 1) {
      const response = await app.inject({
        url: "/auth/login",
        headers: { host: HOST },
      });
      if (response.statusCode === 429) limited += 1;
    }
    expect(limited).toBeGreaterThanOrEqual(1);
  } finally {
    await close();
  }
});

it("never logs an authorization URL, code or correlation token", async () => {
  currentMs = Date.now();
  const spy = vi.spyOn(console, "info").mockImplementation(() => {});
  const { issuer, app, close } = await harness({ metadataLogs: true });
  try {
    const started = await startLogin(app);
    const done = await finishLogin(app, issuer, started.location, started.correlation);
    await app.inject({
      url: "/api/v1/session",
      headers: { host: HOST, cookie: `brain_session=${done.session}` },
    });
    const logged = spy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(logged).not.toContain("code=");
    expect(logged).not.toContain("state=");
    expect(logged).not.toContain(issuer.issuer);
    expect(logged).not.toContain(started.correlation);
  } finally {
    spy.mockRestore();
    await close();
  }
});
