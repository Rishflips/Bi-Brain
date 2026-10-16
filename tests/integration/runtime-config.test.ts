import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { SignIn, ConnectionUnavailable } from "../../apps/web/sign-in.tsx";
import {
  DEFAULT_OIDC_CALLBACK_PATH,
  RuntimeConfigError,
  describeConfig,
  loadConfig,
} from "../../apps/server/config.ts";
import { createApp } from "../../apps/server/app.ts";
import { ManagedRuntime } from "../../packages/runtime/managed.ts";
import { ManagedLogin } from "../../packages/identity/managed-login.ts";
import { Brain } from "../../packages/domain/service.ts";
import { Storage } from "../../packages/storage/index.ts";

const ISSUER = "https://issuer.example.test";
const ORIGIN = "https://brain.example.test";
const HOST = "brain.example.test";
const CALLBACK = `${ORIGIN}/auth/callback`;

const baseManaged = {
  BRAIN_MODE: "managed",
  BRAIN_MANAGED_ROOT: "/var/lib/bibrain/managed",
  BRAIN_PUBLIC_ORIGIN: ORIGIN,
  BRAIN_OIDC_ISSUER: ISSUER,
  BRAIN_OIDC_CLIENT_ID: "client-1",
  BRAIN_OIDC_CLIENT_SECRET: "synthetic-client-secret",
} as const;

const managedRoot = () => mkdtempSync(join(tmpdir(), "bibrain-config-"));
/** Always inject an in-memory brain so a test never creates the local database. */
const localBrain = () => new Brain(new Storage(":memory:"));

/** Minimal structural login adapter: these tests never reach a provider. */
const stubLogin = (runtime: ManagedRuntime) =>
  new ManagedLogin(runtime, {
    callbackUri: CALLBACK,
    async begin() {
      return {
        authorizationUrl: `${ISSUER}/authorize`,
        transaction: {
          state: "state",
          nonce: "nonce",
          codeVerifier: "synthetic-code-verifier-value-for-tests",
          issuedAt: Date.now(),
          redirectUri: CALLBACK,
        },
      };
    },
    async complete() {
      return { issuer: ISSUER, subject: "subject-a" };
    },
  });

const noop = () => {};
const render = (props: ComponentProps<typeof SignIn>) =>
  renderToStaticMarkup(createElement(SignIn, props));

it("renders a real managed sign-in link, an explicit unavailable state, and the local form", () => {
  const managed = render({
    mode: "managed",
    signInUrl: "/auth/login",
    signInAvailable: true,
    busy: false,
    onPair: noop,
    onDemo: noop,
  });
  expect(managed).toContain("Your work, remembered.");
  expect(managed).toContain('href="/auth/login"');
  expect(managed).toContain("Sign in to BiBrain");
  expect(managed).not.toContain("Installation code");

  const unavailable = render({
    mode: "managed",
    signInUrl: null,
    signInAvailable: false,
    busy: false,
    onPair: noop,
    onDemo: noop,
  });
  expect(unavailable).toContain("Sign-in is not available yet");
  expect(unavailable).not.toContain('href="/auth/login"');

  const local = render({
    mode: "local",
    signInUrl: null,
    signInAvailable: false,
    busy: false,
    onPair: noop,
    onDemo: noop,
  });
  expect(local).toContain("Open your local brain");
  expect(local).toContain("Installation code");
  expect(local).toContain("Open my brain");

  // A failed/unvalidated runtime is never presented as a local install.
  const unavailableRuntime = renderToStaticMarkup(
    createElement(ConnectionUnavailable, { busy: false, onRetry: noop }),
  );
  expect(unavailableRuntime).toContain("Retry");
  expect(unavailableRuntime).not.toContain("Installation code");
  expect(unavailableRuntime).not.toContain("Open my brain");
});

it("defaults to the unchanged local runtime", () => {
  expect(loadConfig({})).toEqual({ mode: "local" });
  expect(describeConfig({ mode: "local" })).not.toContain("secret");
});

it("rejects an unknown mode before any runtime is built", () => {
  expect(() => loadConfig({ BRAIN_MODE: "cloud" })).toThrow(RuntimeConfigError);
  expect(() => loadConfig({ BRAIN_MODE: "cloud" })).toThrow(
    /BRAIN_MODE must be "local" or "managed"/,
  );
});

it("fails closed on every missing or malformed managed field, naming only the variable", () => {
  const cases: Array<[Record<string, string | undefined>, RegExp]> = [
    [{ BRAIN_MODE: "managed" }, /BRAIN_MANAGED_ROOT/],
    [{ ...baseManaged, BRAIN_MANAGED_ROOT: undefined }, /BRAIN_MANAGED_ROOT/],
    [{ ...baseManaged, BRAIN_MANAGED_ROOT: "relative/path" }, /absolute/],
    [{ ...baseManaged, BRAIN_PUBLIC_ORIGIN: undefined }, /BRAIN_PUBLIC_ORIGIN/],
    [
      { ...baseManaged, BRAIN_PUBLIC_ORIGIN: "http://brain.example.test" },
      /BRAIN_PUBLIC_ORIGIN/,
    ],
    [
      { ...baseManaged, BRAIN_PUBLIC_ORIGIN: `${ORIGIN}/deep` },
      /BRAIN_PUBLIC_ORIGIN/,
    ],
    [{ ...baseManaged, BRAIN_OIDC_ISSUER: undefined }, /BRAIN_OIDC_ISSUER/],
    [
      { ...baseManaged, BRAIN_OIDC_ISSUER: "http://issuer.example.test" },
      /BRAIN_OIDC_ISSUER must use HTTPS/,
    ],
    [
      { ...baseManaged, BRAIN_OIDC_CLIENT_ID: undefined },
      /BRAIN_OIDC_CLIENT_ID/,
    ],
    [
      { ...baseManaged, BRAIN_OIDC_CLIENT_SECRET: undefined },
      /BRAIN_OIDC_CLIENT_SECRET/,
    ],
    [
      { ...baseManaged, BRAIN_OIDC_CALLBACK_PATH: "/auth/callback?next=x" },
      /BRAIN_OIDC_CALLBACK_PATH/,
    ],
  ];
  for (const [env, message] of cases) {
    let error: unknown;
    try {
      loadConfig(env);
    } catch (caught) {
      error = caught;
    }
    expect(error, JSON.stringify(env)).toBeInstanceOf(RuntimeConfigError);
    expect((error as Error).message).toMatch(message);
    // No configuration value, and never a secret, is echoed back.
    expect((error as Error).message).not.toContain("synthetic-client-secret");
  }
});

it("returns a fully specified managed config with the fixed callback default", () => {
  const config = loadConfig({ ...baseManaged });
  expect(config.mode).toBe("managed");
  if (config.mode !== "managed") throw new Error("unreachable");
  expect(config.managedRoot).toBe("/var/lib/bibrain/managed");
  expect(config.publicOrigin).toBe(ORIGIN);
  expect(config.oidc.callbackPath).toBe(DEFAULT_OIDC_CALLBACK_PATH);
  const described = describeConfig(config);
  expect(described).toContain(ORIGIN);
  expect(described).not.toContain("synthetic-client-secret");
});

it("refuses to attach managed sign-in to a local runtime, or a shared brain to managed", async () => {
  const root = managedRoot();
  const runtime = new ManagedRuntime(root);
  const brain = localBrain();
  try {
    const login = stubLogin(runtime);
    await expect(
      createApp(brain, { login, static: false }),
    ).rejects.toThrow(/Managed sign-in requires a managed runtime/);
    await expect(
      createApp(brain, { managed: runtime, static: false }),
    ).rejects.toThrow(/do not pass a shared brain/);
    await expect(
      createApp(undefined, {
        managed: runtime,
        oidcCallbackPath: "/auth/callback?x=1",
        publicOrigin: ORIGIN,
        static: false,
      }),
    ).rejects.toThrow(/callback path/);
  } finally {
    brain.store.close();
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("reports local versus managed runtime metadata without any identity or secret", async () => {
  const root = managedRoot();
  const runtime = new ManagedRuntime(root);
  const brain = localBrain();
  const local = await createApp(brain, {
    pairSecret: "local-code",
    static: false,
  });
  const unconfigured = await createApp(undefined, {
    managed: runtime,
    publicOrigin: ORIGIN,
    static: false,
  });
  const configured = await createApp(undefined, {
    managed: runtime,
    login: stubLogin(runtime),
    publicOrigin: ORIGIN,
    static: false,
  });
  try {
    const localBody = (await local.inject({ url: "/api/v1/runtime" })).json();
    expect(localBody).toMatchObject({
      mode: "local",
      sign_in_url: null,
      sign_in_available: false,
      pairing_available: true,
    });

    const unconfiguredBody = (
      await unconfigured.inject({
        url: "/api/v1/runtime",
        headers: { host: HOST },
      })
    ).json();
    expect(unconfiguredBody).toMatchObject({
      mode: "managed",
      sign_in_url: null,
      sign_in_available: false,
      pairing_available: false,
    });

    const configuredBody = (
      await configured.inject({
        url: "/api/v1/runtime",
        headers: { host: HOST },
      })
    ).json();
    expect(configuredBody).toMatchObject({
      mode: "managed",
      sign_in_url: "/auth/login",
      sign_in_available: true,
    });

    // The public metadata never leaks configuration or provider secrets.
    const serialized = JSON.stringify([
      localBody,
      unconfiguredBody,
      configuredBody,
    ]);
    expect(serialized).not.toContain("synthetic-client-secret");
    expect(serialized).not.toContain(ISSUER);
    expect(serialized).not.toContain("callback");
  } finally {
    await local.close();
    await unconfigured.close();
    await configured.close();
    brain.store.close();
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("denies managed paid processing to a valid owner cookie and keeps extractive preferences", async () => {
  const root = managedRoot();
  const runtime = new ManagedRuntime(root);
  const app = await createApp(undefined, {
    managed: runtime,
    publicOrigin: ORIGIN,
    static: false,
  });
  try {
    const account = await runtime.provision(ISSUER, "subject-a");
    const session = runtime.control.issueSession(account.id);
    const headers = {
      host: HOST,
      origin: ORIGIN,
      cookie: `brain_session=${session.token}`,
      "x-brain-csrf": session.csrf,
    };
    // A valid cookie and CSRF still cannot switch on globally configured keys.
    const denied = await app.inject({
      method: "PATCH",
      url: "/api/v1/preferences/background",
      headers,
      payload: { provider_enabled: true },
    });
    expect(denied.statusCode).toBe(503);
    expect(denied.json().error.code).toBe("PROVIDER_UNAVAILABLE");

    const kept = await app.inject({
      method: "PATCH",
      url: "/api/v1/preferences/background",
      headers,
      payload: {
        enabled: true,
        time_zone: "UTC",
        digest_hour: 9,
        quiet_start: 22,
        quiet_end: 7,
        daily_cap_micro_usd: 0,
        per_job_cap_micro_usd: 0,
        provider_enabled: false,
      },
    });
    expect(kept.statusCode).toBe(200);
    expect(kept.json().provider_enabled).toBe(false);
    expect(kept.json().enabled).toBe(true);
  } finally {
    await app.close();
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("keeps managed pairing unavailable and returns 404 for an unknown API route", async () => {
  const root = managedRoot();
  const runtime = new ManagedRuntime(root);
  const app = await createApp(undefined, {
    managed: runtime,
    publicOrigin: ORIGIN,
    static: false,
  });
  try {
    const paired = await app.inject({
      method: "POST",
      url: "/api/v1/session/pair",
      headers: { host: HOST, origin: ORIGIN },
      payload: { secret: "anything" },
    });
    expect(paired.statusCode).toBe(403);
    expect(paired.json().error.code).toBe("PAIRING_UNAVAILABLE");

    const account = await runtime.provision(ISSUER, "subject-a");
    const session = runtime.control.issueSession(account.id);
    const unknown = await app.inject({
      url: "/api/v1/not-a-real-route",
      headers: { host: HOST, cookie: `brain_session=${session.token}` },
    });
    expect(unknown.statusCode).toBe(404);
    // The unknown route never falls through to a brain or the app shell.
    expect(unknown.body).not.toContain("SYNTHETIC");
  } finally {
    await app.close();
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("local mode keeps the session shape and never reports a managed account", async () => {
  const brain = localBrain();
  const app = await createApp(brain, { pairSecret: "local-code", static: false });
  try {
    const paired = await app.inject({
      method: "POST",
      url: "/api/v1/session/pair",
      payload: { secret: "local-code" },
    });
    expect(paired.statusCode).toBe(200);
    const cookie = String(paired.headers["set-cookie"]);
    const session = await app.inject({
      url: "/api/v1/session",
      headers: { cookie },
    });
    expect(session.statusCode).toBe(200);
    expect(session.json().account_id).toBeNull();
    expect(typeof session.json().csrf).toBe("string");
  } finally {
    await app.close();
    brain.store.close();
  }
});
