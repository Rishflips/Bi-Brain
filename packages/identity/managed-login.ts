import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { ManagedRuntime } from "../runtime/managed.ts";
import {
  OIDC_TRANSACTION_TTL_MS,
  type AuthenticatedIdentity,
  type LoginTransaction,
} from "./oidc.ts";

/**
 * How long a browser callback correlation stays valid. It is deliberately tied
 * to the adapter transaction TTL so the two boundaries cannot drift apart.
 */
export const OIDC_CORRELATION_TTL_MS = OIDC_TRANSACTION_TTL_MS;

/** Upper bound on pending callback correlations, so the control DB cannot grow without limit. */
export const OIDC_MAX_OUTSTANDING_TRANSACTIONS = 1000;

/** Content-free managed-login failure. Messages never contain codes, secrets or raw tokens. */
export class ManagedLoginError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ManagedLoginError";
  }
}

/**
 * Minimal public surface of a standards-based login adapter. `OidcClient`
 * satisfies it structurally; tests substitute a bounded fake for coordinator
 * cases without importing the production adapter implementation.
 */
export type LoginAdapter = {
  readonly callbackUri: string;
  begin(
    signal?: AbortSignal,
  ): Promise<{ authorizationUrl: string; transaction: LoginTransaction }>;
  complete(
    callbackUrl: string | URL,
    transaction: LoginTransaction,
    signal?: AbortSignal,
  ): Promise<AuthenticatedIdentity>;
};

/** What the browser needs from {@link ManagedLogin.begin}. */
export type BeginResult = {
  authorizationUrl: string;
  /** Opaque correlation cookie value. Only its SHA-256 hash is stored server-side. */
  correlationToken: string;
  expires_at: string;
};

/** What the session layer needs from {@link ManagedLogin.complete}. */
export type CompleteResult = {
  token: string;
  csrf: string;
  expires_at: string;
};

const TOKEN_RE = /^[a-f0-9]{64}$/;
const SAFE_CODE_RE = /^[A-Z0-9_]{2,64}$/;

const transactionSchema = z
  .object({
    state: z.string().min(1).max(2048),
    nonce: z.string().min(1).max(2048),
    codeVerifier: z.string().min(1).max(2048),
    issuedAt: z.number().int().nonnegative(),
    redirectUri: z.string().min(1).max(2048),
  })
  .strict();

const SAFE_MESSAGES: Record<string, string> = {
  OIDC_CANCELLED: "The sign-in attempt was cancelled.",
  OIDC_TIMEOUT: "The identity provider did not respond in time.",
  OIDC_UNREACHABLE: "The identity provider could not be reached.",
  OIDC_CONFIG_INVALID: "Sign-in is not configured correctly.",
  OIDC_TRANSACTION_EXPIRED: "This sign-in attempt expired. Start again.",
  OIDC_TRANSACTION_INVALID: "The sign-in attempt is invalid. Start again.",
  OIDC_CALLBACK_MISMATCH: "The sign-in callback did not match.",
  OIDC_IDENTITY_INVALID: "The identity provider response could not be trusted.",
  OIDC_REDIRECT_REJECTED: "The identity provider attempted an unexpected redirect.",
  OIDC_RESPONSE_TOO_LARGE: "The identity provider response was too large.",
  OIDC_RESPONSE_INVALID: "The identity provider response could not be read.",
  LOGIN_START_FAILED: "Sign-in could not be started. Try again.",
  LOGIN_IDENTITY_REJECTED: "The identity provider sign-in failed.",
  LOGIN_CAPACITY: "Sign-in is temporarily busy. Try again shortly.",
};

const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");

function safeCodeOf(error: unknown): string | undefined {
  const raw =
    error && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  return typeof raw === "string" && SAFE_CODE_RE.test(raw) ? raw : undefined;
}

/**
 * Content-free normalization of any adapter or transport failure. The provider
 * is untrusted, so its message and body are never propagated; only a bounded
 * safe code and a fixed message cross this boundary.
 */
function normalizeFailure(error: unknown, fallback: string): ManagedLoginError {
  if (error instanceof ManagedLoginError) return error;
  const code = safeCodeOf(error) ?? fallback;
  return new ManagedLoginError(code, SAFE_MESSAGES[code] ?? SAFE_MESSAGES[fallback]);
}

/**
 * Coordinates a standards-based login against one managed runtime. It owns no
 * routes, cookies or UI: it returns protocol values and an opaque session for
 * the caller to place in Secure HttpOnly cookies. Short-lived callback
 * correlations live in the SAME control database as the managed sessions, so a
 * pending login survives a restart and never depends on process memory.
 *
 * Replay protection is structural: {@link complete} atomically consumes the
 * correlation with a single `DELETE ... RETURNING` before any token exchange,
 * so a provider that would tolerate code replay still cannot redeem a
 * correlation twice. A failed or rejected identity consumes the record too.
 */
export class ManagedLogin {
  readonly #runtime: ManagedRuntime;
  readonly #oidc: LoginAdapter;
  readonly #maxOutstanding: number;

  constructor(
    runtime: ManagedRuntime,
    oidc: LoginAdapter,
    options: { maxOutstanding?: number } = {},
  ) {
    if (
      !runtime ||
      typeof runtime !== "object" ||
      !runtime.control ||
      typeof runtime.control.db !== "object"
    )
      throw new ManagedLoginError(
        "LOGIN_CONFIG_INVALID",
        "Managed login requires the managed runtime control store.",
      );
    if (
      !oidc ||
      typeof oidc !== "object" ||
      typeof oidc.callbackUri !== "string" ||
      typeof oidc.begin !== "function" ||
      typeof oidc.complete !== "function"
    )
      throw new ManagedLoginError(
        "LOGIN_CONFIG_INVALID",
        "Managed login requires a standards-based OIDC adapter.",
      );
    this.#runtime = runtime;
    this.#oidc = oidc;
    this.#maxOutstanding = z
      .number()
      .int()
      .min(1)
      .max(100_000)
      .parse(options.maxOutstanding ?? OIDC_MAX_OUTSTANDING_TRANSACTIONS);
    runtime.control.db.exec(
      `CREATE TABLE IF NOT EXISTS oidc_transactions(
         token_hash TEXT PRIMARY KEY,
         "transaction" TEXT NOT NULL,
         expires_at TEXT NOT NULL);
       CREATE INDEX IF NOT EXISTS oidc_transactions_expiry ON oidc_transactions(expires_at);`,
    );
  }

  /**
   * Starts a login. The adapter builds the authorization URL and its PKCE
   * transaction; this method stores the transaction under a hashed random
   * correlation token and returns that token for a Secure HttpOnly cookie.
   */
  async begin(signal?: AbortSignal): Promise<BeginResult> {
    let started: { authorizationUrl: string; transaction: LoginTransaction };
    try {
      started = await this.#oidc.begin(signal);
    } catch (error) {
      throw normalizeFailure(error, "LOGIN_START_FAILED");
    }
    const transaction = this.#validate(started.transaction);
    if (transaction.redirectUri !== this.#oidc.callbackUri)
      throw new ManagedLoginError(
        "LOGIN_TRANSACTION_INVALID",
        SAFE_MESSAGES.LOGIN_TRANSACTION_INVALID,
      );
    const expires_at = new Date(
      transaction.issuedAt + OIDC_CORRELATION_TTL_MS,
    ).toISOString();
    const correlationToken = randomBytes(32).toString("hex");
    this.#admit(correlationToken, transaction, expires_at);
    return {
      authorizationUrl: started.authorizationUrl,
      correlationToken,
      expires_at,
    };
  }

  /**
   * Completes a login from the callback URL and the correlation cookie. The
   * record is consumed atomically before the provider is contacted, so a
   * replayed code never reaches the token endpoint. Only after trusted
   * identity is confirmed does this provision the tenant, verify the
   * active-and-complete runtime boundary, issue an opaque session and rotate
   * any previous session for the same account.
   */
  async complete(
    callbackURL: string | URL,
    correlationToken: string,
    oldSessionToken?: string,
    signal?: AbortSignal,
  ): Promise<CompleteResult> {
    if (typeof correlationToken !== "string" || !TOKEN_RE.test(correlationToken))
      throw new ManagedLoginError(
        "LOGIN_CORRELATION_INVALID",
        "The sign-in callback is invalid. Start again.",
      );
    // Atomic single-use consume: no await may precede this statement.
    const row = this.#runtime.control.db
      .prepare(
        'DELETE FROM oidc_transactions WHERE token_hash=? RETURNING "transaction"',
      )
      .get(hashToken(correlationToken)) as { transaction: string } | undefined;
    if (!row)
      throw new ManagedLoginError(
        "LOGIN_CORRELATION_MISSING",
        "This sign-in attempt expired or was already used. Start again.",
      );
    const transaction = this.#parse(row.transaction);
    if (this.#expired(transaction))
      throw new ManagedLoginError(
        "LOGIN_TRANSACTION_EXPIRED",
        SAFE_MESSAGES.OIDC_TRANSACTION_EXPIRED,
      );
    if (transaction.redirectUri !== this.#oidc.callbackUri)
      throw new ManagedLoginError(
        "LOGIN_TRANSACTION_INVALID",
        SAFE_MESSAGES.OIDC_TRANSACTION_INVALID,
      );

    let identity: AuthenticatedIdentity;
    try {
      identity = await this.#oidc.complete(callbackURL, transaction, signal);
    } catch (error) {
      throw normalizeFailure(error, "LOGIN_IDENTITY_REJECTED");
    }

    const accountId = await this.#activate(identity);
    return this.#session(accountId, oldSessionToken);
  }

  /** Validates a transaction shape and maps any failure to a content-free error. */
  #validate(value: unknown): LoginTransaction {
    try {
      return transactionSchema.parse(value);
    } catch {
      throw new ManagedLoginError(
        "LOGIN_TRANSACTION_INVALID",
        SAFE_MESSAGES.OIDC_TRANSACTION_INVALID,
      );
    }
  }

  /** Validates the persisted JSON; a malformed record can never be trusted. */
  #parse(serialized: string): LoginTransaction {
    let value: unknown;
    try {
      value = JSON.parse(serialized);
    } catch {
      throw new ManagedLoginError(
        "LOGIN_TRANSACTION_INVALID",
        SAFE_MESSAGES.OIDC_TRANSACTION_INVALID,
      );
    }
    return this.#validate(value);
  }

  /**
   * Enforces the five-minute TTL from the adapter's own record, not from a
   * caller-controlled value. A clock that moves backwards is treated as
   * expired so a stale callback cannot be stretched.
   */
  #expired(transaction: LoginTransaction): boolean {
    const now = Date.parse(this.#runtime.control.now());
    const age = now - transaction.issuedAt;
    return !Number.isFinite(age) || age < 0 || age > OIDC_CORRELATION_TTL_MS;
  }

  /**
   * Idempotent tenant provisioning through the runtime (never the bare control
   * store), then an acquire/release to prove the account is active and fully
   * provisioned. A suspended account therefore yields no session and is never
   * silently reactivated.
   */
  async #activate(identity: AuthenticatedIdentity): Promise<string> {
    let account: { id: string };
    try {
      account = await this.#runtime.provision(identity.issuer, identity.subject);
    } catch {
      throw new ManagedLoginError(
        "LOGIN_ACCOUNT_UNAVAILABLE",
        "This account cannot sign in right now.",
      );
    }
    let handle: { brain: { ownerPrincipal(): unknown }; release(): void };
    try {
      handle = this.#runtime.acquire(account.id);
    } catch {
      throw new ManagedLoginError(
        "LOGIN_ACCOUNT_UNAVAILABLE",
        "This account cannot sign in right now.",
      );
    }
    try {
      const principal = handle.brain.ownerPrincipal() as { tenantId?: string };
      if (principal.tenantId !== account.id)
        throw new ManagedLoginError(
          "LOGIN_ACCOUNT_UNAVAILABLE",
          "This account cannot sign in right now.",
        );
    } finally {
      handle.release();
    }
    return account.id;
  }

  /**
   * Issues the new opaque session first, then rotates the previous session
   * only when it belongs to the same account. Ordering means a caller can never
   * sign out a different account by presenting its token, and no long
   * transaction straddles issuance.
   */
  #session(accountId: string, oldSessionToken?: string): CompleteResult {
    let session: { token: string; csrf: string; expires_at: string };
    try {
      session = this.#runtime.control.issueSession(accountId);
    } catch {
      throw new ManagedLoginError(
        "LOGIN_ACCOUNT_UNAVAILABLE",
        "This account cannot sign in right now.",
      );
    }
    if (typeof oldSessionToken === "string" && TOKEN_RE.test(oldSessionToken)) {
      const previous = this.#runtime.control.resolveSession(oldSessionToken);
      if (previous && previous.account_id === accountId)
        this.#runtime.control.revokeSession(oldSessionToken);
    }
    return {
      token: session.token,
      csrf: session.csrf,
      expires_at: session.expires_at,
    };
  }

  /**
   * Admits one pending correlation atomically. `BEGIN IMMEDIATE` serializes
   * expiry pruning, the capacity count and the insert across every connection
   * sharing the control database, so concurrent starts cannot race past the
   * cap. Expired rows are removed; unexpired rows are never evicted, so a
   * public sign-in start can never invalidate someone else's pending attempt.
   * At capacity the new start is rejected instead of discarding a valid one.
   */
  #admit(
    correlationToken: string,
    transaction: LoginTransaction,
    expires_at: string,
  ): void {
    const db = this.#runtime.control.db;
    db.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
      db.prepare("DELETE FROM oidc_transactions WHERE expires_at <= ?").run(
        this.#runtime.control.now(),
      );
      const { n } = db
        .prepare("SELECT COUNT(*) AS n FROM oidc_transactions")
        .get() as { n: number };
      if (n >= this.#maxOutstanding)
        throw new ManagedLoginError(
          "LOGIN_CAPACITY",
          SAFE_MESSAGES.LOGIN_CAPACITY,
        );
      db.prepare(
        'INSERT INTO oidc_transactions(token_hash, "transaction", expires_at) VALUES(?,?,?)',
      ).run(hashToken(correlationToken), JSON.stringify(transaction), expires_at);
      db.exec("COMMIT");
      committed = true;
    } finally {
      if (!committed) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // A failed BEGIN or an already-rolled-back transaction needs no undo.
        }
      }
    }
  }
}
