import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, existsSync, lstatSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";

const hex = (value: string) =>
  createHash("sha256").update(value).digest("hex");

const identitySchema = z
  .object({
    issuer: z.string().min(1).max(300),
    subject: z.string().min(1).max(300),
  })
  .strict();

const uuidSchema = z.string().uuid();

export type AccountState = "active" | "suspended";

export type Account = {
  id: string;
  issuer: string;
  subject: string;
  state: AccountState;
  created_at: string;
};

export type ResolvedSession = {
  account_id: string;
  csrf: string;
  expires_at: string;
};

export type AgentTokenRoute = {
  account_id: string;
  grant_id: string;
};

const SESSION_TTL_MS = 7 * 86400000;

/**
 * Small trusted control plane for managed accounts. It holds only identity
 * routing: which (issuer, subject) owns which server-created tenant id, which
 * opaque session is live, and which agent-token hash belongs to which tenant.
 * It never stores tenant knowledge, and it never adopts or rewrites the local
 * single-owner database.
 */
export class ControlStore {
  readonly db: DatabaseSync;
  readonly path: string;
  constructor(
    path = resolve(process.env.BRAIN_CONTROL_DB ?? "data/managed/control.sqlite"),
    readonly clock: () => Date = () => new Date(),
  ) {
    z.string().min(1).max(4096).parse(path);
    this.path = path === ":memory:" ? path : resolve(path);
    if (path !== ":memory:") {
      const parent = dirname(this.path);
      if (existsSync(parent)) {
        const parentStat = lstatSync(parent);
        if (parentStat.isSymbolicLink() || !parentStat.isDirectory())
          throw new Error(
            "Control database directory must be a real directory, not a link.",
          );
      }
      if (existsSync(this.path)) {
        const stat = lstatSync(this.path);
        if (stat.isSymbolicLink() || !stat.isFile())
          throw new Error(
            "Control database path must be a real file, not a link or directory.",
          );
      }
      mkdirSync(parent, { recursive: true });
    }
    this.db = new DatabaseSync(this.path);
    this.db.exec(
      "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;",
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS managed_accounts(
         id TEXT PRIMARY KEY,
         issuer TEXT NOT NULL,
         subject TEXT NOT NULL,
         state TEXT NOT NULL CHECK(state IN ('active','suspended')),
         created_at TEXT NOT NULL,
         UNIQUE(issuer, subject));
       CREATE TABLE IF NOT EXISTS managed_sessions(
         token_hash TEXT PRIMARY KEY,
         account_id TEXT NOT NULL REFERENCES managed_accounts(id),
         csrf TEXT NOT NULL,
         created_at TEXT NOT NULL,
         expires_at TEXT NOT NULL);
       CREATE TABLE IF NOT EXISTS managed_agent_tokens(
         token_hash TEXT PRIMARY KEY,
         account_id TEXT NOT NULL REFERENCES managed_accounts(id),
         grant_id TEXT NOT NULL,
         created_at TEXT NOT NULL);
       CREATE INDEX IF NOT EXISTS managed_sessions_account ON managed_sessions(account_id);
       CREATE INDEX IF NOT EXISTS managed_agent_tokens_account ON managed_agent_tokens(account_id);`,
    );
  }
  now() {
    return this.clock().toISOString();
  }
  /**
   * Idempotent trusted provisioning keyed by the identity pair. Account and
   * tenant identifiers are server-created UUIDs; the subject is never used as
   * a key. Existing accounts are returned unchanged, so a suspended account is
   * not silently reactivated.
   */
  provision(issuer: string, subject: string): Account {
    const identity = identitySchema.parse({ issuer, subject });
    // ON CONFLICT + read-back makes provisioning idempotent across separate
    // process handles without ever reactivating or overwriting an account.
    this.db
      .prepare(
        "INSERT INTO managed_accounts(id,issuer,subject,state,created_at) VALUES(?,?,?,?,?) ON CONFLICT(issuer,subject) DO NOTHING",
      )
      .run(randomUUID(), identity.issuer, identity.subject, "active", this.now());
    return this.db
      .prepare(
        "SELECT id,issuer,subject,state,created_at FROM managed_accounts WHERE issuer=? AND subject=?",
      )
      .get(identity.issuer, identity.subject) as Account;
  }
  account(id: string): Account | undefined {
    if (!uuidSchema.safeParse(id).success) return undefined;
    return this.db
      .prepare(
        "SELECT id,issuer,subject,state,created_at FROM managed_accounts WHERE id=?",
      )
      .get(id) as Account | undefined;
  }
  setAccountState(id: string, state: AccountState) {
    z.enum(["active", "suspended"]).parse(state);
    const result = this.db
      .prepare("UPDATE managed_accounts SET state=? WHERE id=?")
      .run(state, id);
    if (result.changes !== 1) throw new Error("Managed account not found.");
    return this.account(id)!;
  }
  issueSession(accountId: string, ttlMs = SESSION_TTL_MS) {
    const account = this.account(accountId);
    if (!account || account.state !== "active")
      throw new Error("Managed account unavailable.");
    z.number().int().min(1000).max(90 * 86400000).parse(ttlMs);
    const token = randomBytes(32).toString("hex");
    const csrf = randomBytes(24).toString("hex");
    const expires_at = new Date(this.clock().getTime() + ttlMs).toISOString();
    this.db
      .prepare(
        "INSERT INTO managed_sessions(token_hash,account_id,csrf,created_at,expires_at) VALUES(?,?,?,?,?)",
      )
      .run(hex(token), account.id, csrf, this.now(), expires_at);
    return { token, csrf, expires_at };
  }
  /**
   * Resolves an opaque session only while its account is active and the
   * session has not expired. A suspended account therefore loses every live
   * session immediately.
   */
  resolveSession(token: string): ResolvedSession | undefined {
    if (typeof token !== "string" || !token) return undefined;
    const row = this.db
      .prepare(
        `SELECT s.account_id AS account_id,s.csrf AS csrf,s.expires_at AS expires_at,a.state AS state
         FROM managed_sessions s JOIN managed_accounts a ON a.id=s.account_id
         WHERE s.token_hash=?`,
      )
      .get(hex(token)) as
      | (ResolvedSession & { state: AccountState })
      | undefined;
    if (!row || row.state !== "active") return undefined;
    if (row.expires_at <= this.now()) {
      this.db
        .prepare("DELETE FROM managed_sessions WHERE token_hash=?")
        .run(hex(token));
      return undefined;
    }
    return {
      account_id: row.account_id,
      csrf: row.csrf,
      expires_at: row.expires_at,
    };
  }
  revokeSession(token: string) {
    this.db
      .prepare("DELETE FROM managed_sessions WHERE token_hash=?")
      .run(hex(token));
    return { signed_out: true };
  }
  /** Registers an agent-token hash for routing; a repeated identical mapping
   * is a no-op, but a conflicting tenant/grant mapping is refused. */
  registerAgentToken(tokenHash: string, accountId: string, grantId: string) {
    const h = z.string().regex(/^[a-f0-9]{64}$/).parse(tokenHash);
    if (!this.account(accountId))
      throw new Error("Managed account unavailable.");
    const grant = z.string().min(1).max(100).parse(grantId);
    const existing = this.db
      .prepare(
        "SELECT account_id,grant_id FROM managed_agent_tokens WHERE token_hash=?",
      )
      .get(h) as AgentTokenRoute | undefined;
    if (existing) {
      if (existing.account_id !== accountId || existing.grant_id !== grant)
        throw new Error(
          "Agent token hash is already routed to another account or grant.",
        );
      return;
    }
    this.db
      .prepare(
        "INSERT INTO managed_agent_tokens(token_hash,account_id,grant_id,created_at) VALUES(?,?,?,?)",
      )
      .run(h, accountId, grant, this.now());
  }
  /**
   * Hash-indexed routing only. Whether the grant is still valid is decided
   * again against the tenant-local database on every request.
   */
  agentTokenTenant(tokenHash: string): AgentTokenRoute | undefined {
    if (!/^[a-f0-9]{64}$/.test(tokenHash)) return undefined;
    const row = this.db
      .prepare(
        "SELECT account_id,grant_id FROM managed_agent_tokens WHERE token_hash=?",
      )
      .get(tokenHash) as AgentTokenRoute | undefined;
    return row;
  }
  close() {
    this.db.close();
  }
}
