import type { BrowserContext } from "@playwright/test";
import type { FastifyInstance } from "fastify";
import type { FakeIssuer } from "./oidc-provider.ts";

/**
 * Test-only browser plumbing for the managed browser regression.
 *
 * IMPORTANT: this serves a synthetic HTTPS origin from the real Fastify
 * application through `app.inject`. It never opens a TLS connection, never hits
 * an external host and never reaches a live identity provider, so it is NOT a
 * hosted, certificate, DNS or network proof. It only exercises the application's
 * own request handling, redirects, cookies and static assets.
 *
 * Requests to the synthetic managed origin are forwarded to the real application
 * with their method, path, query, headers and body. Responses (status, headers,
 * body, including multiple `Set-Cookie` values) are returned to Chromium. The
 * disposable fake issuer's authorization endpoint is intercepted separately and
 * answered by the real signed-token fake provider.
 *
 * Redirects need one documented transport shim. Playwright never routes the
 * target of a redirect produced by `route.fulfill`: its request handler
 * auto-continues any redirected request (see the `redirectedFrom` branch in
 * `coreBundle`'s request handling) instead of dispatching it to registered
 * routes. A real `302` would therefore send the browser to a host that the
 * harness cannot answer. Instead a redirect response is turned into a tiny
 * same-origin "hop" page that starts a fresh, interceptable navigation to the
 * real `Location`. Cookies and redirect destinations come from the application,
 * but the hop is HTTP 200: this fixture does not prove native redirect-chain
 * behavior. HTTP integration tests check the original redirect status codes.
 */

export const MANAGED_ORIGIN = "https://brain.example.test";
export const MANAGED_HOST = "brain.example.test";

/**
 * Headers that must not be copied between the browser and `app.inject`:
 * hop-by-hop transport headers, the derived content length, the browser's
 * compression preference, and Host (set explicitly so the deployment policy sees
 * the configured origin, never a forwarded value).
 */
const REQUEST_DROP = new Set([
  "content-length",
  "transfer-encoding",
  "connection",
  "accept-encoding",
  "host",
]);
const RESPONSE_DROP = new Set(["content-length", "transfer-encoding", "connection"]);
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

/**
 * The exact subset of Fastify's overloaded `inject` this helper calls, named so a
 * single documented cast can be used instead of fighting overload resolution.
 */
type Inject = (options: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  payload?: string | Buffer;
}) => Promise<{
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  rawPayload: Buffer;
}>;

/**
 * Serves every request to `origin` from the real application, converting only
 * server redirects into interceptable client-side hops. Status codes, bodies,
 * cookies and static assets otherwise come from production code.
 */
export async function installAppRoutes(
  context: BrowserContext,
  app: FastifyInstance,
  origin: string = MANAGED_ORIGIN,
): Promise<void> {
  const inject = app.inject.bind(app) as unknown as Inject;
  const target = new URL(origin);
  await context.route(`${target.origin}/**`, async (route, request) => {
    const requested = new URL(request.url());
    const forwarded: Record<string, string> = {};
    for (const [name, value] of Object.entries(await request.allHeaders()))
      if (!REQUEST_DROP.has(name.toLowerCase())) forwarded[name] = value;
    forwarded.host = target.host;
    const body = request.postDataBuffer();
    const injected = await inject({
      method: request.method(),
      url: `${requested.pathname}${requested.search}`,
      headers: forwarded,
      ...(body && body.length ? { payload: body } : {}),
    });
    const headers = copyHeaders(injected.headers);
    const location = singleHeader(injected.headers, "location");
    if (location && REDIRECT_STATUS.has(injected.statusCode)) {
      delete headers["location"];
      // The inline hop script must run, so an inherited restrictive CSP cannot
      // apply to this harness-only document.
      delete headers["content-security-policy"];
      await route.fulfill(hopResponse(location, headers));
      return;
    }
    await route.fulfill({
      status: injected.statusCode,
      headers,
      body: injected.rawPayload,
    });
  });
}

/**
 * Intercepts the fake issuer's authorization endpoint and drives it through the
 * real protocol implementation. Discovery, JWKS and token exchange stay in-process
 * through `issuer.fetcher`, so the browser is never allowed to reach them.
 */
export async function installFakeIssuerRoutes(
  context: BrowserContext,
  issuer: FakeIssuer,
): Promise<void> {
  const origin = new URL(issuer.issuer).origin;
  await context.route(`${origin}/**`, async (route, request) => {
    const requested = new URL(request.url());
    if (requested.pathname.endsWith("/authorize")) {
      const callback = await issuer.authorize(request.url());
      await route.fulfill(hopResponse(callback));
      return;
    }
    // The browser must never reach discovery, JWKS or the token endpoint; those
    // run in-process through issuer.fetcher.
    await route.fulfill({
      status: 404,
      contentType: "text/plain",
      body: "unexpected issuer request",
    });
  });
}

/** Reads the opaque managed session cookie Chromium holds for the synthetic origin. */
export async function managedSessionCookie(
  context: BrowserContext,
  origin: string = MANAGED_ORIGIN,
): Promise<string> {
  const cookies = await context.cookies(origin);
  return cookies.find((cookie) => cookie.name === "brain_session")?.value ?? "";
}

/**
 * Copies response headers with full fidelity. Multiple `Set-Cookie` values are
 * joined with a newline, which Playwright splits back into discrete headers, so
 * every cookie keeps its own Secure, HttpOnly, SameSite, Path and expiry exactly
 * as the application set it.
 */
function copyHeaders(
  raw: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    const lower = name.toLowerCase();
    if (value === undefined || RESPONSE_DROP.has(lower)) continue;
    headers[lower] = Array.isArray(value) ? value.join("\n") : value;
  }
  return headers;
}

function singleHeader(
  raw: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = raw[name];
  return Array.isArray(value) ? value[0] : value;
}

/** A minimal same-origin document that performs one fresh, interceptable navigation. */
function hopResponse(
  location: string,
  headers: Record<string, string> = {},
): { status: number; headers: Record<string, string>; body: string } {
  const target = JSON.stringify(location).replace(/</g, "\\u003c");
  return {
    status: 200,
    headers: {
      ...headers,
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
    body:
      "<!doctype html><meta charset=\"utf-8\"><title>Redirecting…</title>" +
      `<script>location.replace(${target});</script>`,
  };
}
