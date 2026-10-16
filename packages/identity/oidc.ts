import {
  ClientSecretPost,
  authorizationCodeGrant,
  buildAuthorizationUrl,
  calculatePKCECodeChallenge,
  customFetch as customFetchKey,
  discovery,
  enableNonRepudiationChecks,
  randomNonce,
  randomPKCECodeVerifier,
  randomState,
  type Configuration,
  type CustomFetch,
} from "openid-client";

/**
 * Bounded outbound timeout for every identity-provider request. Hard-coded so a
 * deployment cannot silently raise it; there are no hidden retries.
 */
export const OIDC_REQUEST_TIMEOUT_MS = 10_000;

/** A login transaction may only be redeemed within five minutes of {@link OidcClient.begin}. */
export const OIDC_TRANSACTION_TTL_MS = 5 * 60 * 1000;

/** Maximum identity-provider response body buffered before library parsing. */
export const OIDC_MAX_RESPONSE_BYTES = 262_144;

/** Content-free identity error. Messages never contain secrets, codes or provider bodies. */
export class OidcError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "OidcError";
  }
}

export type OidcConfig = {
  /** Exact authorization-server issuer identifier. HTTPS only; no credentials, query or fragment. */
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Fixed HTTPS origin this deployment is served from. No path, credentials, query or fragment. */
  publicOrigin: string;
  /** Fixed absolute callback path, for example `/auth/callback`. No query or fragment. */
  callbackPath: string;
  /**
   * Test-only transport injection. Production omits this and uses global `fetch`.
   * It is validated as a function but never enabled by a plaintext flag.
   */
  customFetch?: CustomFetch;
  /** Deterministic clock in milliseconds; defaults to `Date.now`. */
  now?: () => number;
};

/**
 * Server-side correlation record for one authorization attempt. The caller must persist this
 * (for example in the control store) and must atomically consume it exactly once on callback.
 * The adapter deliberately performs no in-memory replay tracking: a durable, single-use store is
 * the caller's responsibility, and pretending otherwise would be unsafe.
 */
export type LoginTransaction = {
  state: string;
  nonce: string;
  codeVerifier: string;
  issuedAt: number;
  redirectUri: string;
};

/** Only trusted identity is returned. No access, refresh or ID tokens cross this boundary. */
export type AuthenticatedIdentity = {
  issuer: string;
  subject: string;
  displayName?: string;
};

type ResolvedConfig = {
  issuer: string;
  clientId: string;
  clientSecret: string;
  callbackUri: string;
  customFetch?: CustomFetch;
  now: () => number;
};

/**
 * Per-operation holder for a transport-level {@link OidcError}. The OIDC library wraps fetcher
 * rejections in its own error types, so we retain the precise transport failure here instead of
 * relying on shared instance state or string matching.
 */
type TransportState = { error?: OidcError };

function configError(message: string): OidcError {
  return new OidcError("OIDC_CONFIG_INVALID", message);
}

function requireHttpsUrl(
  value: unknown,
  label: string,
  allowPath: boolean,
): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048)
    throw configError(`The ${label} must be a bounded HTTPS URL.`);
  if (value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value))
    throw configError(
      `The ${label} must not contain surrounding whitespace or control characters.`,
    );
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw configError(`The ${label} must be a bounded HTTPS URL.`);
  }
  if (url.protocol !== "https:")
    throw configError(`The ${label} must use HTTPS.`);
  if (url.username || url.password || url.search || url.hash)
    throw configError(
      `The ${label} must not contain credentials, a query or a fragment.`,
    );
  if (!allowPath && url.pathname !== "/")
    throw configError(`The ${label} must be a bare HTTPS origin.`);
  return value;
}

/**
 * Rejects path forms whose meaning depends on URL normalization: dot segments, encoded dots or
 * slashes, empty segments and backslashes. This keeps the registered callback an unambiguous
 * literal so a normalizing parser cannot turn one path into another.
 */
function isUnambiguousPath(path: string): boolean {
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("?") ||
    path.includes("#") ||
    path.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(path)
  )
    return false;
  if (/(^|\/)\.{1,2}(\/|$)/.test(path)) return false;
  if (/%2e|%2f|%5c/i.test(path)) return false;
  if (path.includes("//")) return false;
  return true;
}

function requireCallbackPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 2 ||
    value.length > 512 ||
    value !== value.trim() ||
    !isUnambiguousPath(value) ||
    new URL(value, "https://placeholder.invalid").pathname !== value
  )
    throw configError(
      "The callback path must be a fixed, unambiguous absolute path without a query or fragment.",
    );
  return value;
}

/** Extracts the raw, unnormalized path from a URL string, if one is present. */
function rawPathOf(url: string): string | null {
  const match = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/?#]*(\/[^?#]*)?/.exec(url);
  if (!match) return null;
  return match[1] ?? "/";
}

function requireText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max)
    throw configError(`The ${label} is invalid.`);
  return value;
}

const defaultFetch: CustomFetch = (url, options) =>
  fetch(url, options as RequestInit);

/** Sentinel distinguishing an abort from a genuine stream/network read failure. */
const ABORTED = Symbol("oidc-aborted");

async function readBounded(
  body: ReadableStream<Uint8Array>,
  max: number,
  signal: AbortSignal | undefined,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<typeof ABORTED>((resolve) => {
    if (!signal) return;
    onAbort = () => resolve(ABORTED);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  // Cancel without awaiting: a provider or test stream may return a pending promise from
  // cancel(), and teardown must never block the rejection that the caller is waiting for.
  const cancelReader = () => {
    try {
      void reader.cancel().catch(() => {});
    } catch {
      /* reader already closed */
    }
  };
  try {
    for (;;) {
      const outcome = await Promise.race([
        reader.read().then((chunk) => ({ chunk })),
        aborted,
      ]);
      if (outcome === ABORTED) {
        cancelReader();
        throw ABORTED;
      }
      if (outcome.chunk.done) break;
      const value = outcome.chunk.value;
      if (!value) continue;
      total += value.byteLength;
      if (total > max) {
        cancelReader();
        return null;
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error !== ABORTED) cancelReader();
    throw error;
  } finally {
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
  const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Standards-based OpenID Connect authorization-code adapter with PKCE S256, state, nonce,
 * issuer/audience/expiry validation and ID token signature verification against the provider
 * JWKS. The configured issuer is the only issuer accepted; the caller cannot select one.
 */
export class OidcClient {
  readonly #config: ResolvedConfig;

  constructor(config: OidcConfig) {
    if (!config || typeof config !== "object")
      throw configError("The OIDC configuration is missing.");
    const issuer = requireHttpsUrl(config.issuer, "issuer", true);
    const publicOrigin = requireHttpsUrl(
      config.publicOrigin,
      "public origin",
      false,
    );
    const callbackPath = requireCallbackPath(config.callbackPath);
    const clientId = requireText(config.clientId, "client identifier", 255);
    const clientSecret = requireText(config.clientSecret, "client secret", 1024);
    if (
      config.customFetch !== undefined &&
      typeof config.customFetch !== "function"
    )
      throw configError("The custom transport must be a function.");
    if (config.now !== undefined && typeof config.now !== "function")
      throw configError("The clock must be a function.");
    this.#config = {
      issuer,
      clientId,
      clientSecret,
      callbackUri: `${new URL(publicOrigin).origin}${callbackPath}`,
      customFetch: config.customFetch,
      now: config.now ?? Date.now,
    };
  }

  /** The exact registered redirect URI. Exposed for diagnostics, never caller-overridable. */
  get callbackUri(): string {
    return this.#config.callbackUri;
  }

  /**
   * Starts a login. Returns the authorization URL for the browser plus the server-side
   * transaction to persist. The frontend only ever sees protocol state, nonce and the S256
   * challenge embedded in the URL; the PKCE verifier stays in the transaction.
   */
  async begin(
    signal?: AbortSignal,
  ): Promise<{ authorizationUrl: string; transaction: LoginTransaction }> {
    const state: TransportState = {};
    const config = await this.#configure(signal, state);
    const nonce = randomNonce();
    const codeVerifier = randomPKCECodeVerifier();
    const stateParam = randomState();
    try {
      const codeChallenge = await calculatePKCECodeChallenge(codeVerifier);
      const authorizationUrl = buildAuthorizationUrl(config, {
        redirect_uri: this.#config.callbackUri,
        response_type: "code",
        scope: "openid profile",
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        state: stateParam,
        nonce,
      }).href;
      return {
        authorizationUrl,
        transaction: {
          state: stateParam,
          nonce,
          codeVerifier,
          issuedAt: this.#config.now(),
          redirectUri: this.#config.callbackUri,
        },
      };
    } catch (error) {
      throw state.error ?? this.#mapError(error);
    }
  }

  /**
   * Completes a login from the callback URL and the persisted transaction. Returns only the
   * trusted `(issuer, subject)` and an optional bounded display name. Any failure raises a
   * content-free {@link OidcError}.
   */
  async complete(
    callbackUrl: string | URL,
    transaction: LoginTransaction,
    signal?: AbortSignal,
  ): Promise<AuthenticatedIdentity> {
    this.#assertTransaction(transaction);
    const currentUrl = this.#assertCallback(callbackUrl);
    const age = this.#config.now() - transaction.issuedAt;
    if (!Number.isFinite(age) || age > OIDC_TRANSACTION_TTL_MS || age < 0)
      throw new OidcError(
        "OIDC_TRANSACTION_EXPIRED",
        "This sign-in attempt expired. Start again from the beginning.",
      );

    const state: TransportState = {};
    const config = await this.#configure(signal, state);
    let response;
    try {
      response = await authorizationCodeGrant(config, currentUrl, {
        expectedState: transaction.state,
        expectedNonce: transaction.nonce,
        pkceCodeVerifier: transaction.codeVerifier,
        idTokenExpected: true,
      });
    } catch (error) {
      throw state.error ?? this.#mapError(error);
    }

    const claims = response.claims();
    if (
      !claims ||
      claims.iss !== this.#config.issuer ||
      typeof claims.sub !== "string" ||
      claims.sub.length === 0 ||
      claims.sub.length > 255
    )
      throw new OidcError(
        "OIDC_IDENTITY_INVALID",
        "The identity provider response could not be trusted.",
      );
    const identity: AuthenticatedIdentity = {
      issuer: this.#config.issuer,
      subject: claims.sub,
    };
    if (typeof claims.name === "string" && claims.name.length > 0)
      identity.displayName = claims.name.slice(0, 256);
    return identity;
  }

  async #configure(
    signal: AbortSignal | undefined,
    state: TransportState,
  ): Promise<Configuration> {
    try {
      return await discovery(
        new URL(this.#config.issuer),
        this.#config.clientId,
        { client_secret: this.#config.clientSecret },
        ClientSecretPost(),
        {
          [customFetchKey]: this.#transport(signal, state),
          timeout: OIDC_REQUEST_TIMEOUT_MS / 1000,
          execute: [enableNonRepudiationChecks],
        },
      );
    } catch (error) {
      throw state.error ?? this.#mapError(error);
    }
  }

  #transport(signal: AbortSignal | undefined, state: TransportState): CustomFetch {
    const base = this.#config.customFetch ?? defaultFetch;
    const fail = (error: OidcError): never => {
      state.error = error;
      throw error;
    };
    const discard = (response: Response) => {
      try {
        void response.body?.cancel().catch(() => {});
      } catch {
        /* body already settled */
      }
    };
    const cancellation = (timeout: AbortSignal): OidcError => {
      if (signal?.aborted)
        return new OidcError(
          "OIDC_CANCELLED",
          "The sign-in attempt was cancelled.",
        );
      if (timeout.aborted)
        return new OidcError(
          "OIDC_TIMEOUT",
          "The identity provider did not respond in time.",
        );
      return new OidcError(
        "OIDC_UNREACHABLE",
        "The identity provider could not be reached.",
      );
    };
    return async (url, options) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), OIDC_REQUEST_TIMEOUT_MS);
      const signals = [controller.signal, options.signal, signal].filter(
        (value): value is AbortSignal => value instanceof AbortSignal,
      );
      const merged =
        signals.length === 1 ? signals[0] : AbortSignal.any(signals);
      let resolveAborted: (() => void) | undefined;
      const aborted = new Promise<typeof ABORTED>((resolve) => {
        resolveAborted = () => resolve(ABORTED);
        if (merged.aborted) resolveAborted();
        else merged.addEventListener("abort", resolveAborted, { once: true });
      });
      let cancelled = false;
      // Redirects are forced to manual regardless of any library/caller option, then rejected.
      const settle = base(url, {
        ...options,
        signal: merged,
        redirect: "manual",
      });
      // A transport that ignores the signal may resolve after we gave up. Discard that late
      // body so nothing is parsed and no follow-up request is attempted.
      void settle.then(
        (late) => {
          if (cancelled) discard(late);
        },
        () => {},
      );
      try {
        let response: Response;
        try {
          const outcome = await Promise.race([
            settle.then((value) => ({ value })),
            aborted,
          ]);
          if (outcome === ABORTED) {
            cancelled = true;
            return fail(cancellation(controller.signal));
          }
          response = outcome.value;
        } catch (error) {
          if (error instanceof OidcError) return fail(error);
          return fail(cancellation(controller.signal));
        }
        if (
          response.redirected ||
          response.type === "opaqueredirect" ||
          (response.status >= 300 && response.status < 400)
        ) {
          discard(response);
          return fail(
            new OidcError(
              "OIDC_REDIRECT_REJECTED",
              "The identity provider attempted an unexpected redirect.",
            ),
          );
        }
        const declared = response.headers.get("content-length");
        if (declared !== null && Number(declared) > OIDC_MAX_RESPONSE_BYTES) {
          discard(response);
          return fail(
            new OidcError(
              "OIDC_RESPONSE_TOO_LARGE",
              "The identity provider response was too large.",
            ),
          );
        }
        if (!response.body) return response;
        let body: Uint8Array<ArrayBuffer> | null;
        try {
          body = await readBounded(
            response.body,
            OIDC_MAX_RESPONSE_BYTES,
            merged,
          );
        } catch (error) {
          if (error === ABORTED) {
            cancelled = true;
            return fail(cancellation(controller.signal));
          }
          return fail(
            new OidcError(
              "OIDC_RESPONSE_INVALID",
              "The identity provider response could not be read.",
            ),
          );
        }
        if (body === null)
          return fail(
            new OidcError(
              "OIDC_RESPONSE_TOO_LARGE",
              "The identity provider response was too large.",
            ),
          );
        const headers = new Headers(response.headers);
        headers.delete("content-length");
        headers.delete("content-encoding");
        return new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      } finally {
        clearTimeout(timer);
        if (resolveAborted) merged.removeEventListener("abort", resolveAborted);
      }
    };
  }

  #assertTransaction(transaction: LoginTransaction): void {
    if (!transaction || typeof transaction !== "object")
      throw new OidcError(
        "OIDC_TRANSACTION_INVALID",
        "The sign-in transaction is invalid.",
      );
    for (const field of ["state", "nonce", "codeVerifier"] as const)
      if (
        typeof transaction[field] !== "string" ||
        transaction[field].length === 0 ||
        transaction[field].length > 2048
      )
        throw new OidcError(
          "OIDC_TRANSACTION_INVALID",
          "The sign-in transaction is invalid.",
        );
    if (
      !Number.isFinite(transaction.issuedAt) ||
      transaction.redirectUri !== this.#config.callbackUri
    )
      throw new OidcError(
        "OIDC_TRANSACTION_INVALID",
        "The sign-in transaction is invalid.",
      );
  }

  #assertCallback(callbackUrl: string | URL): URL {
    let url: URL;
    try {
      url = callbackUrl instanceof URL ? callbackUrl : new URL(callbackUrl);
    } catch {
      throw new OidcError(
        "OIDC_CALLBACK_MISMATCH",
        "The sign-in callback did not match the registered redirect address.",
      );
    }
    const expected = new URL(this.#config.callbackUri);
    const rawPath =
      typeof callbackUrl === "string" ? rawPathOf(callbackUrl) : null;
    if (
      url.username ||
      url.password ||
      url.hash ||
      url.protocol !== expected.protocol ||
      url.host !== expected.host ||
      url.pathname !== expected.pathname ||
      (rawPath !== null && (!isUnambiguousPath(rawPath) || rawPath !== expected.pathname))
    )
      throw new OidcError(
        "OIDC_CALLBACK_MISMATCH",
        "The sign-in callback did not match the registered redirect address.",
      );
    return url;
  }

  #mapError(error: unknown): OidcError {
    if (error instanceof OidcError) return error;
    const code =
      error && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
    const safe =
      typeof code === "string" && /^[A-Z0-9_]{2,64}$/.test(code)
        ? code
        : "OIDC_FAILED";
    return new OidcError(safe, "The identity provider sign-in failed.");
  }
}
