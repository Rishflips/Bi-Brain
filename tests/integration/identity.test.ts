import { createHash, createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { CustomFetch } from "openid-client";
import {
  OidcClient,
  OidcError,
  OIDC_MAX_RESPONSE_BYTES,
  OIDC_REQUEST_TIMEOUT_MS,
  OIDC_TRANSACTION_TTL_MS,
} from "../../packages/identity/oidc.ts";

const ISSUER = "https://issuer.example.test";
const CLIENT_ID = "client-1";
const CLIENT_SECRET = "synthetic-client-secret-never-logged";
const CALLBACK = "https://brain.example.test/auth/callback";
const SUBJECT_A = "subject-a";

type SigningKey = {
  kid: string;
  privateKey: KeyObject;
  publicJwk: Record<string, unknown>;
};

function makeKey(kid: string): SigningKey {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const jwk = publicKey.export({ format: "jwk" }) as Record<string, unknown>;
  return {
    kid,
    privateKey,
    publicJwk: { ...jwk, kid, use: "sig", alg: "RS256" },
  };
}

const base64url = (value: string | Buffer) =>
  Buffer.from(value).toString("base64url");

function signIdToken(key: SigningKey, claims: Record<string, unknown>): string {
  const header = base64url(
    JSON.stringify({ alg: "RS256", typ: "JWT", kid: key.kid }),
  );
  const payload = base64url(JSON.stringify(claims));
  const signature = createSign("RSA-SHA256")
    .update(`${header}.${payload}`)
    .sign(key.privateKey);
  return `${header}.${payload}.${signature.toString("base64url")}`;
}

function localFetcher(port: number): CustomFetch {
  return async (url, options) => {
    const target = new URL(url);
    if (target.origin !== new URL(ISSUER).origin)
      throw new Error("unexpected issuer origin");
    const rewritten = new URL(
      target.pathname + target.search,
      `http://127.0.0.1:${port}`,
    );
    return fetch(rewritten, {
      method: options.method,
      headers: options.headers,
      body: options.body as RequestInit["body"],
      redirect: "manual",
      signal: options.signal,
    });
  };
}

type IdTokenKnobs = {
  issuer: string;
  audience: string;
  nonce: string | null;
  expOffset: number;
  name: string;
  key: SigningKey;
};

type Knobs = {
  omitTokenEndpoint: boolean;
  oversizeDiscovery: boolean;
  oversizeToken: boolean;
  redirectToken: boolean;
  hangToken: boolean;
  subject: string;
  idToken: IdTokenKnobs;
};

type Provider = {
  port: number;
  fetcher: CustomFetch;
  knobs: Knobs;
  calls: { discovery: number; jwks: number; authorize: number; token: number };
  codes: Map<
    string,
    { challenge: string; nonce: string; sub: string; redirectUri: string; used: boolean }
  >;
  close: () => Promise<void>;
};

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function startProvider(issuerBase: string = ISSUER): Promise<Provider> {
  const basePath = new URL(issuerBase).pathname.replace(/\/+$/, "");
  const key = makeKey("key-1");
  const codes: Provider["codes"] = new Map();
  const calls: Provider["calls"] = {
    discovery: 0,
    jwks: 0,
    authorize: 0,
    token: 0,
  };
  const knobs: Knobs = {
    omitTokenEndpoint: false,
    oversizeDiscovery: false,
    oversizeToken: false,
    redirectToken: false,
    hangToken: false,
    subject: SUBJECT_A,
    idToken: {
      issuer: issuerBase,
      audience: CLIENT_ID,
      nonce: null,
      expOffset: 300,
      name: "Synthetic Owner",
      key: key,
    },
  };

  const sendJson = (response: ServerResponse, status: number, value: unknown) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  };

  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === `${basePath}/.well-known/openid-configuration`) {
        calls.discovery += 1;
        if (knobs.oversizeDiscovery) {
          sendJson(response, 200, { padding: "x".repeat(300_000) });
          return;
        }
        const metadata: Record<string, unknown> = {
          issuer: issuerBase,
          authorization_endpoint: `${issuerBase}/authorize`,
          jwks_uri: `${issuerBase}/jwks`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          code_challenge_methods_supported: ["S256"],
        };
        if (!knobs.omitTokenEndpoint) metadata.token_endpoint = `${issuerBase}/token`;
        sendJson(response, 200, metadata);
        return;
      }
      if (url.pathname === `${basePath}/jwks`) {
        calls.jwks += 1;
        sendJson(response, 200, { keys: [key.publicJwk] });
        return;
      }
      if (url.pathname === `${basePath}/authorize`) {
        calls.authorize += 1;
        const redirectUri = url.searchParams.get("redirect_uri") ?? "";
        const challenge = url.searchParams.get("code_challenge") ?? "";
        const state = url.searchParams.get("state") ?? "";
        const nonce = url.searchParams.get("nonce") ?? "";
        if (
          url.searchParams.get("client_id") !== CLIENT_ID ||
          url.searchParams.get("response_type") !== "code" ||
          url.searchParams.get("code_challenge_method") !== "S256" ||
          !challenge ||
          !state ||
          !nonce ||
          redirectUri !== CALLBACK
        ) {
          response.writeHead(400);
          response.end();
          return;
        }
        const code = `code-${codes.size + 1}-${createHash("sha256")
          .update(`${state}:${nonce}`)
          .digest("hex")
          .slice(0, 16)}`;
        codes.set(code, {
          challenge,
          nonce,
          sub: knobs.subject,
          redirectUri,
          used: false,
        });
        const location = new URL(redirectUri);
        location.searchParams.set("code", code);
        location.searchParams.set("state", state);
        response.writeHead(302, { location: location.href });
        response.end();
        return;
      }
      if (url.pathname === `${basePath}/token`) {
        calls.token += 1;
        if (knobs.hangToken) return;
        if (knobs.redirectToken) {
          response.writeHead(302, { location: `${issuerBase}/elsewhere` });
          response.end();
          return;
        }
        if (knobs.oversizeToken) {
          sendJson(response, 200, { padding: "x".repeat(300_000) });
          return;
        }
        const params = new URLSearchParams(await readBody(request));
        if (
          params.get("grant_type") !== "authorization_code" ||
          params.get("client_id") !== CLIENT_ID ||
          params.get("client_secret") !== CLIENT_SECRET
        ) {
          sendJson(response, 400, { error: "invalid_client" });
          return;
        }
        const code = params.get("code") ?? "";
        const entry = codes.get(code);
        if (!entry || entry.used || params.get("redirect_uri") !== entry.redirectUri) {
          sendJson(response, 400, { error: "invalid_grant" });
          return;
        }
        const verifier = params.get("code_verifier") ?? "";
        const challenge = createHash("sha256").update(verifier).digest("base64url");
        if (!verifier || challenge !== entry.challenge) {
          sendJson(response, 400, { error: "invalid_grant" });
          return;
        }
        entry.used = true;
        const now = Math.floor(Date.now() / 1000);
        const claims: Record<string, unknown> = {
          iss: knobs.idToken.issuer,
          sub: entry.sub,
          aud: knobs.idToken.audience,
          exp: now + knobs.idToken.expOffset,
          iat: now,
          nonce: knobs.idToken.nonce ?? entry.nonce,
        };
        if (knobs.idToken.name) claims.name = knobs.idToken.name;
        sendJson(response, 200, {
          access_token: "synthetic-access-token",
          token_type: "Bearer",
          expires_in: 300,
          id_token: signIdToken(knobs.idToken.key, claims),
        });
        return;
      }
      response.writeHead(404);
      response.end();
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });

  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const port = (server.address() as { port: number }).port;
  let closed = false;
  return {
    port,
    fetcher: localFetcher(port),
    knobs,
    calls,
    codes,
    close: async () => {
      if (closed) return;
      closed = true;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

let provider: Provider;
let oidc: OidcClient;
let clock: number;

const configure = (overrides: Partial<ConstructorParameters<typeof OidcClient>[0]> = {}) =>
  new OidcClient({
    issuer: ISSUER,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    publicOrigin: "https://brain.example.test",
    callbackPath: "/auth/callback",
    customFetch: provider.fetcher,
    now: () => clock,
    ...overrides,
  });

beforeEach(async () => {
  provider = await startProvider();
  clock = 1_700_000_000_000;
  oidc = configure();
});

afterEach(async () => {
  await provider.close();
});

async function authorize(
  current: Provider,
  authorizationUrl: string,
): Promise<string> {
  const response = await current.fetcher(authorizationUrl, {
    method: "GET",
    headers: {},
    body: undefined,
    redirect: "manual",
  });
  expect(response.status).toBe(302);
  const location = response.headers.get("location");
  if (!location) throw new Error("provider did not redirect");
  return location;
}

async function login(current = provider, client = oidc) {
  const { authorizationUrl, transaction } = await client.begin();
  const callback = await authorize(current, authorizationUrl);
  const identity = await client.complete(callback, transaction);
  return { authorizationUrl, transaction, callback, identity };
}

async function waitFor(check: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

it("begins an authorization request with S256 PKCE, state, nonce and a server-side transaction", async () => {
  const { authorizationUrl, transaction } = await oidc.begin();
  const url = new URL(authorizationUrl);
  expect(OIDC_REQUEST_TIMEOUT_MS).toBe(10_000);
  expect(OIDC_TRANSACTION_TTL_MS).toBe(300_000);
  expect(url.origin).toBe(ISSUER);
  expect(url.pathname).toBe("/authorize");
  expect(url.searchParams.get("response_type")).toBe("code");
  expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
  expect(url.searchParams.get("redirect_uri")).toBe(CALLBACK);
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(url.searchParams.get("state")).toBe(transaction.state);
  expect(url.searchParams.get("nonce")).toBe(transaction.nonce);
  expect(url.searchParams.get("code_challenge")).toBe(
    createHash("sha256").update(transaction.codeVerifier).digest("base64url"),
  );
  expect(authorizationUrl).not.toContain(transaction.codeVerifier);
  expect(authorizationUrl).not.toContain(CLIENT_SECRET);
  expect(transaction.issuedAt).toBe(clock);
  expect(transaction.redirectUri).toBe(CALLBACK);
});

it("completes a real code exchange against a signed JWKS and returns only issuer and subject", async () => {
  const { identity, transaction, callback } = await login();
  expect(identity).toEqual({
    issuer: ISSUER,
    subject: SUBJECT_A,
    displayName: "Synthetic Owner",
  });
  expect(Object.keys(identity).sort()).toEqual([
    "displayName",
    "issuer",
    "subject",
  ]);
  expect(JSON.stringify(identity)).not.toContain("synthetic-access-token");
  expect(JSON.stringify(identity)).not.toContain("id_token");
  expect(callback).toContain(`state=${transaction.state}`);
  expect(provider.calls.authorize).toBe(1);
  expect(provider.calls.token).toBe(1);
  expect(provider.calls.jwks).toBe(1);
});

it("omits an empty display name and keeps two identities separate", async () => {
  provider.knobs.idToken.name = "";
  provider.knobs.subject = "subject-a";
  const a = await login();
  provider.knobs.subject = "subject-b";
  const b = await login();
  expect(a.identity).toEqual({ issuer: ISSUER, subject: "subject-a" });
  expect(b.identity).toEqual({ issuer: ISSUER, subject: "subject-b" });
  expect(a.identity.subject).not.toBe(b.identity.subject);
});

it("rejects a replayed code through the provider without faking durable replay protection", async () => {
  const { callback, transaction, identity } = await login();
  expect(identity.subject).toBe(SUBJECT_A);
  expect(provider.calls.token).toBe(1);
  await expect(oidc.complete(callback, transaction)).rejects.toBeInstanceOf(
    OidcError,
  );
  expect(provider.calls.token).toBe(2);
});

it("rejects a callback that is not the fixed redirect address, carries credentials or plaintext", async () => {
  const { transaction } = await oidc.begin();
  for (const callback of [
    "https://evil.example.test/auth/callback?code=x&state=y",
    "https://brain.example.test/other?code=x&state=y",
    "https://user:pass@brain.example.test/auth/callback?code=x&state=y",
    "http://brain.example.test/auth/callback?code=x&state=y",
    "https://brain.example.test/auth/callback?code=x&state=y#fragment",
  ])
    await expect(oidc.complete(callback, transaction)).rejects.toBeInstanceOf(
      OidcError,
    );
});

it("rejects bad state, nonce, issuer, audience and signature", async () => {
  const { authorizationUrl, transaction } = await oidc.begin();
  const callback = await authorize(provider, authorizationUrl);
  const tampered = new URL(callback);
  tampered.searchParams.set("state", "tampered");
  await expect(
    oidc.complete(tampered.href, transaction),
  ).rejects.toBeInstanceOf(OidcError);

  for (const change of [
    () => (provider.knobs.idToken.nonce = "wrong-nonce"),
    () => (provider.knobs.idToken.issuer = "https://evil.example.test"),
    () => (provider.knobs.idToken.audience = "other-client"),
    () => (provider.knobs.idToken.key = makeKey("key-rogue")),
  ]) {
    provider.knobs.idToken.nonce = null;
    provider.knobs.idToken.issuer = ISSUER;
    provider.knobs.idToken.audience = CLIENT_ID;
    change();
    await expect(login()).rejects.toBeInstanceOf(OidcError);
  }
});

it("rejects an expired transaction with the injected clock and an expired ID token", async () => {
  const { authorizationUrl, transaction } = await oidc.begin();
  const callback = await authorize(provider, authorizationUrl);
  clock += OIDC_TRANSACTION_TTL_MS + 1;
  await expect(oidc.complete(callback, transaction)).rejects.toMatchObject({
    code: "OIDC_TRANSACTION_EXPIRED",
  });
  clock = 1_700_000_000_000;
  provider.knobs.idToken.expOffset = -3600;
  await expect(login()).rejects.toBeInstanceOf(OidcError);
});

it("cancels a hung provider request through the caller signal", async () => {
  provider.knobs.hangToken = true;
  const { authorizationUrl, transaction } = await oidc.begin();
  const callback = await authorize(provider, authorizationUrl);
  const controller = new AbortController();
  const pending = oidc.complete(callback, transaction, controller.signal);
  await waitFor(() => provider.calls.token >= 1);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: "OIDC_CANCELLED" });
});

it("rejects oversized and redirected provider responses before parsing them", async () => {
  provider.knobs.oversizeDiscovery = true;
  await expect(oidc.begin()).rejects.toMatchObject({
    code: "OIDC_RESPONSE_TOO_LARGE",
  });
  provider.knobs.oversizeDiscovery = false;

  provider.knobs.oversizeToken = true;
  const oversize = await oidc.begin();
  const oversizeCallback = await authorize(provider, oversize.authorizationUrl);
  await expect(
    oidc.complete(oversizeCallback, oversize.transaction),
  ).rejects.toMatchObject({ code: "OIDC_RESPONSE_TOO_LARGE" });
  provider.knobs.oversizeToken = false;

  provider.knobs.redirectToken = true;
  const redirected = await oidc.begin();
  const redirectedCallback = await authorize(provider, redirected.authorizationUrl);
  await expect(
    oidc.complete(redirectedCallback, redirected.transaction),
  ).rejects.toMatchObject({ code: "OIDC_REDIRECT_REJECTED" });
});

it("fails closed on a disabled token endpoint and an unreachable provider", async () => {
  provider.knobs.omitTokenEndpoint = true;
  const { authorizationUrl, transaction } = await oidc.begin();
  const callback = await authorize(provider, authorizationUrl);
  await expect(oidc.complete(callback, transaction)).rejects.toBeInstanceOf(
    OidcError,
  );

  const dead = createServer();
  await new Promise<void>((resolve) =>
    dead.listen(0, "127.0.0.1", () => resolve()),
  );
  const deadPort = (dead.address() as { port: number }).port;
  await new Promise<void>((resolve) => dead.close(() => resolve()));
  const unreachable = configure({ customFetch: localFetcher(deadPort) });
  await expect(unreachable.begin()).rejects.toMatchObject({
    code: "OIDC_UNREACHABLE",
  });
});

it("fails closed on invalid or plaintext configuration and keeps secrets out of errors", async () => {
  for (const overrides of [
    { issuer: "http://issuer.example.test" },
    { issuer: "https://user:pass@issuer.example.test" },
    { issuer: `${ISSUER}?tenant=1` },
    { issuer: `${ISSUER}#frag` },
    { publicOrigin: "http://brain.example.test" },
    { publicOrigin: "https://brain.example.test/app" },
    { callbackPath: "auth/callback" },
    { callbackPath: "/auth/callback?next=https://evil.test" },
    { callbackPath: "/auth/callback#fragment" },
    { clientId: "" },
    { clientSecret: "" },
  ])
    expect(() => configure(overrides)).toThrow(OidcError);

  provider.knobs.idToken.nonce = "wrong-nonce";
  let error: OidcError | undefined;
  try {
    await login();
  } catch (caught) {
    error = caught as OidcError;
  }
  expect(error).toBeInstanceOf(OidcError);
  expect(error?.message).not.toContain(CLIENT_SECRET);
  expect(error?.message).not.toContain("synthetic-access-token");
  expect(error?.message).not.toContain("code=");
  expect(String(error?.stack)).not.toContain(CLIENT_SECRET);
});

it("rejects issuer and origin whitespace, control characters and ambiguous callback paths", () => {
  for (const overrides of [
    { issuer: ` ${ISSUER}` },
    { issuer: `${ISSUER} ` },
    { issuer: `${ISSUER}\n` },
    { issuer: `${ISSUER}\u0000` },
    { publicOrigin: " https://brain.example.test" },
    { publicOrigin: "https://brain.example.test\u007f" },
    { callbackPath: "/auth/./callback" },
    { callbackPath: "/auth/../callback" },
    { callbackPath: "/auth/%2e%2e/callback" },
    { callbackPath: "/auth/%2f/callback" },
    { callbackPath: "/auth//callback" },
    { callbackPath: "/auth/\\callback" },
  ])
    expect(() => configure(overrides)).toThrow(OidcError);
  // A real issuer path remains supported.
  expect(() => configure({ issuer: `${ISSUER}/tenant` })).not.toThrow();
});

it("accepts a real issuer path and completes discovery, authorization and token exchange", async () => {
  const pathIssuer = `${ISSUER}/tenant`;
  const pathProvider = await startProvider(pathIssuer);
  try {
    const client = configure({
      issuer: pathIssuer,
      customFetch: pathProvider.fetcher,
    });
    const { authorizationUrl, transaction } = await client.begin();
    expect(new URL(authorizationUrl).pathname).toBe("/tenant/authorize");
    const callback = await authorize(pathProvider, authorizationUrl);
    const identity = await client.complete(callback, transaction);
    expect(identity).toEqual({
      issuer: pathIssuer,
      subject: SUBJECT_A,
      displayName: "Synthetic Owner",
    });
  } finally {
    await pathProvider.close();
  }
});

it("rejects a callback whose raw path only matches after URL normalization", async () => {
  const { transaction } = await oidc.begin();
  for (const callback of [
    "https://brain.example.test/auth/./callback?code=x&state=y",
    "https://brain.example.test/auth/x/../callback?code=x&state=y",
    "https://brain.example.test/auth/%2e/callback?code=x&state=y",
  ])
    await expect(oidc.complete(callback, transaction)).rejects.toMatchObject({
      code: "OIDC_CALLBACK_MISMATCH",
    });
});

it("forces redirect rejection even when the injected transport ignores redirect options", async () => {
  const redirecting = configure({
    customFetch: async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://evil.example.test/" },
      }),
  });
  await expect(redirecting.begin()).rejects.toMatchObject({
    code: "OIDC_REDIRECT_REJECTED",
  });
});

it("cancels a body rejected by content-length before consuming it", async () => {
  let cancelled = false;
  const oversized = configure({
    customFetch: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(stream) {
            stream.enqueue(new TextEncoder().encode("x"));
          },
          cancel() {
            cancelled = true;
          },
        }),
        {
          headers: {
            "content-type": "application/json",
            "content-length": `${OIDC_MAX_RESPONSE_BYTES + 1}`,
          },
        },
      ),
  });
  await expect(oversized.begin()).rejects.toMatchObject({
    code: "OIDC_RESPONSE_TOO_LARGE",
  });
  expect(cancelled).toBe(true);
});

it("enforces caller cancellation over a stalled body and cancels the active reader", async () => {
  let bodyCancelled = false;
  const stalled = configure({
    customFetch: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(stream) {
            stream.enqueue(new TextEncoder().encode('{"issuer":'));
          },
          cancel() {
            bodyCancelled = true;
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
  });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 10);
  await expect(stalled.begin(controller.signal)).rejects.toMatchObject({
    code: "OIDC_CANCELLED",
  });
  expect(bodyCancelled).toBe(true);
});

it("maps a stream read failure to a content-free error code", async () => {
  const broken = configure({
    customFetch: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(stream) {
            stream.error(new Error("secret-provider-failure"));
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
  });
  let error: OidcError | undefined;
  try {
    await broken.begin();
  } catch (caught) {
    error = caught as OidcError;
  }
  expect(error).toMatchObject({ code: "OIDC_RESPONSE_INVALID" });
  expect(error?.message).not.toContain("secret-provider-failure");
});

it("enforces cancellation before headers when a transport ignores its signal, without retrying", async () => {
  let calls = 0;
  const ignoring = configure({
    customFetch: () => {
      calls += 1;
      return new Promise<Response>(() => {});
    },
  });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 5);
  await expect(ignoring.begin(controller.signal)).rejects.toMatchObject({
    code: "OIDC_CANCELLED",
  });
  expect(calls).toBe(1);
});

it("discards a late provider body that arrives after cancellation instead of parsing it", async () => {
  let lateCancelled = false;
  const late = configure({
    customFetch: () =>
      new Promise<Response>((resolve) => {
        setTimeout(
          () =>
            resolve(
              new Response(
                new ReadableStream<Uint8Array>({
                  start(stream) {
                    stream.enqueue(new TextEncoder().encode("late-body"));
                  },
                  cancel() {
                    lateCancelled = true;
                  },
                }),
                { headers: { "content-type": "application/json" } },
              ),
            ),
          30,
        );
      }),
  });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 5);
  await expect(late.begin(controller.signal)).rejects.toMatchObject({
    code: "OIDC_CANCELLED",
  });
  await waitFor(() => lateCancelled);
  expect(lateCancelled).toBe(true);
});
