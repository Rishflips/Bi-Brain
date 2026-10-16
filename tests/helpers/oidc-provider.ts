import {
  createHash,
  createSign,
  generateKeyPairSync,
  type KeyObject,
} from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { CustomFetch } from "openid-client";

/**
 * Disposable local OpenID Connect authorization server used only by tests. It is
 * deliberately concise: a single RSA signing key, discovery, JWKS, an
 * authorization endpoint that mints one-time codes bound to state/nonce/PKCE,
 * and a token endpoint that verifies the client secret and S256 code verifier
 * before signing an ID token. It is test infrastructure, never a production
 * authentication bypass, and it never accepts a caller-supplied issuer.
 */
export type FakeIssuer = {
  issuer: string;
  clientId: string;
  clientSecret: string;
  publicOrigin: string;
  callbackPath: string;
  callbackUri: string;
  fetcher: CustomFetch;
  calls: { discovery: number; jwks: number; authorize: number; token: number };
  pendingCodes(): number;
  setIdentity(subject: string, displayName?: string): void;
  /** Drives the authorization endpoint and returns the resulting callback URL. */
  authorize(authorizationUrl: string): Promise<string>;
  close(): Promise<void>;
};

export type FakeIssuerOptions = {
  issuer?: string;
  clientId?: string;
  clientSecret?: string;
  publicOrigin?: string;
  callbackPath?: string;
  subject?: string;
  displayName?: string;
};

type SigningKey = {
  kid: string;
  privateKey: KeyObject;
  publicJwk: Record<string, unknown>;
};

type CodeEntry = {
  challenge: string;
  nonce: string;
  subject: string;
  redirectUri: string;
  used: boolean;
};

const base64url = (value: string | Buffer) =>
  Buffer.from(value).toString("base64url");

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

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function startFakeIssuer(
  options: FakeIssuerOptions = {},
): Promise<FakeIssuer> {
  const issuer = options.issuer ?? "https://issuer.example.test";
  const clientId = options.clientId ?? "client-1";
  const clientSecret = options.clientSecret ?? "synthetic-client-secret";
  const publicOrigin = options.publicOrigin ?? "https://brain.example.test";
  const callbackPath = options.callbackPath ?? "/auth/callback";
  const callbackUri = `${new URL(publicOrigin).origin}${callbackPath}`;
  const issuerOrigin = new URL(issuer).origin;
  const basePath = new URL(issuer).pathname.replace(/\/+$/, "");

  const key = makeKey("key-1");
  const codes = new Map<string, CodeEntry>();
  const calls = { discovery: 0, jwks: 0, authorize: 0, token: 0 };
  let subject = options.subject ?? "subject-a";
  let displayName = options.displayName ?? "Synthetic Owner";

  const sendJson = (
    response: ServerResponse,
    status: number,
    value: unknown,
  ) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  };

  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === `${basePath}/.well-known/openid-configuration`) {
        calls.discovery += 1;
        sendJson(response, 200, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          code_challenge_methods_supported: ["S256"],
        });
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
          url.searchParams.get("client_id") !== clientId ||
          url.searchParams.get("response_type") !== "code" ||
          url.searchParams.get("code_challenge_method") !== "S256" ||
          !challenge ||
          !state ||
          !nonce ||
          redirectUri !== callbackUri
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
          subject,
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
        const params = new URLSearchParams(await readBody(request));
        if (
          params.get("grant_type") !== "authorization_code" ||
          params.get("client_id") !== clientId ||
          params.get("client_secret") !== clientSecret
        ) {
          sendJson(response, 400, { error: "invalid_client" });
          return;
        }
        const code = params.get("code") ?? "";
        const entry = codes.get(code);
        if (
          !entry ||
          entry.used ||
          params.get("redirect_uri") !== entry.redirectUri
        ) {
          sendJson(response, 400, { error: "invalid_grant" });
          return;
        }
        const verifier = params.get("code_verifier") ?? "";
        const challenge = createHash("sha256")
          .update(verifier)
          .digest("base64url");
        if (!verifier || challenge !== entry.challenge) {
          sendJson(response, 400, { error: "invalid_grant" });
          return;
        }
        entry.used = true;
        const now = Math.floor(Date.now() / 1000);
        const claims: Record<string, unknown> = {
          iss: issuer,
          sub: entry.subject,
          aud: clientId,
          exp: now + 300,
          iat: now,
          nonce: entry.nonce,
        };
        if (displayName) claims.name = displayName;
        sendJson(response, 200, {
          access_token: "synthetic-access-token",
          token_type: "Bearer",
          expires_in: 300,
          id_token: signIdToken(key, claims),
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

  const fetcher: CustomFetch = async (url, init) => {
    const target = new URL(url.toString());
    if (target.origin !== issuerOrigin)
      throw new Error("unexpected issuer origin");
    const rewritten = new URL(
      target.pathname + target.search,
      `http://127.0.0.1:${port}`,
    );
    return fetch(rewritten, {
      method: init.method,
      headers: init.headers,
      body: init.body as RequestInit["body"],
      redirect: "manual",
      signal: init.signal,
    });
  };

  let closed = false;
  return {
    issuer,
    clientId,
    clientSecret,
    publicOrigin,
    callbackPath,
    callbackUri,
    fetcher,
    calls,
    pendingCodes: () => [...codes.values()].filter((entry) => !entry.used).length,
    setIdentity: (nextSubject: string, nextDisplayName?: string) => {
      subject = nextSubject;
      displayName = nextDisplayName ?? "";
    },
    authorize: async (authorizationUrl: string) => {
      const response = await fetcher(authorizationUrl, {
        method: "GET",
        headers: {},
        body: undefined,
        redirect: "manual",
      });
      if (response.status !== 302)
        throw new Error("fake issuer did not redirect");
      const location = response.headers.get("location");
      if (!location) throw new Error("fake issuer produced no location");
      return location;
    },
    close: async () => {
      if (closed) return;
      closed = true;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
