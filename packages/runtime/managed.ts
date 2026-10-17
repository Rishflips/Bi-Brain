import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { Storage } from "../storage/index.ts";
import { ControlStore, type Account } from "../storage/control.ts";
import { Brain } from "../domain/service.ts";
import { BrainError } from "../domain/logic.ts";
import { MANAGED_RESTORE_INCOMPLETE } from "../storage/managed-restore-policy.ts";
import { managedMoneyView } from "./managed-money.ts";
import {
  activeFence,
  clearFence,
  fenceAccount,
  mintAccountIncarnation,
  readAccountIncarnation,
} from "../storage/managed-incarnation.ts";
import type { Incarnation } from "../domain/billing-admission.ts";
import {
  decisionServerCapability,
  evaluateConfiguredDecisionPolicy,
  evaluateConfiguredPolicy,
  readActivation,
  readDecisionActivation,
  serverCapability,
} from "./managed-activation.ts";
import { readWorkerReadiness } from "./worker-readiness.ts";
import { readDecisionReadiness } from "./decision-worker-readiness.ts";
import type { ActivationReason } from "../domain/managed-activation.ts";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MARKER = "provisioned.json";

export type ManagedAccount = Account;
export type ManagedHandle = { brain: Brain; release: () => void };

/**
 * Trusted DECISION-stage runtime capability helper. It is the exact decision
 * analogue of `managedCapability`, using only the separate decision manifest and
 * the separate `decision-worker-ready.json` lease. It never reads the reasoning
 * readiness file, never trusts a caller field and never grants admission.
 */
export function managedDecisionCapability(input: {
  control: { db: DatabaseSync; path: string };
  root: string;
  now: Date;
  optIn: boolean;
}): { available: boolean; reason: ActivationReason } {
  const configured = evaluateConfiguredDecisionPolicy({
    control: input.control,
    root: input.root,
    now: input.now,
    optIn: input.optIn,
  });
  if (!configured.ready) return { available: false, reason: configured.reason };
  const profile = readDecisionActivation(input.control, input.root);
  if (!profile) return { available: false, reason: "profile_invalid" };
  const readiness = readDecisionReadiness(input.root, input.now);
  const cap = decisionServerCapability({ configured, readiness, profile });
  return { available: cap.ready, reason: cap.reason };
}

/**
 * Trusted runtime capability helper. Derives the CURRENT shared-loader configured
 * policy plus the fresh worker readiness lease for this exact root/control and
 * returns a boolean + static reason. It never reads a caller field, an audit row,
 * another account or a global total, and never grants admission.
 */
export function managedCapability(input: {
  control: { db: DatabaseSync; path: string };
  root: string;
  now: Date;
  optIn: boolean;
}): { available: boolean; reason: ActivationReason } {
  const configured = evaluateConfiguredPolicy({
    control: input.control,
    root: input.root,
    now: input.now,
    optIn: input.optIn,
  });
  if (!configured.ready) return { available: false, reason: configured.reason };
  const profile = readActivation(input.control, input.root);
  if (!profile) return { available: false, reason: "profile_invalid" };
  const readiness = readWorkerReadiness(input.root, input.now);
  const cap = serverCapability({ configured, readiness, profile });
  return { available: cap.ready, reason: cap.reason };
}

type Entry = { brain: Brain; pins: number; lastUsed: number };
type TenantPaths = {
  dir: string;
  db: string;
  vault: string;
  protected: string;
  marker: string;
};

type TenantStorageProbe = {
  dbPresent: boolean;
  dbOperational: boolean;
  vaultManifest: boolean;
};

/**
 * Reads only the tenant's own structural metadata (never a financial row) to decide
 * whether opening it would rebuild its operational database from an existing vault.
 * It opens the database read-only and closes it immediately; it never migrates,
 * repairs or writes. A missing/empty/unreadable database with a valid vault is
 * exactly the constructor's history-changing rebuild branch.
 */
function probeTenantStorage(
  dbPath: string,
  vaultPath: string,
): TenantStorageProbe {
  const dbPresent = existsSync(dbPath);
  let dbOperational = false;
  if (dbPresent) {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      dbOperational = !!db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='migrations'",
        )
        .get();
    } catch {
      dbOperational = false;
    } finally {
      try {
        db?.close();
      } catch {
        /* an unreadable tenant database is treated as not operational */
      }
    }
  }
  return {
    dbPresent,
    dbOperational,
    vaultManifest: existsSync(resolve(vaultPath, "manifest.json")),
  };
}

/** Atomic marker write (tmp + rename) inside the tenant directory. */
function writeTenantMarker(
  markerPath: string,
  payload: Record<string, unknown>,
): void {
  const tmp = resolve(
    dirname(markerPath),
    `${MARKER}.${randomBytes(6).toString("hex")}.tmp`,
  );
  rmSync(tmp, { force: true });
  writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
  renameSync(tmp, markerPath);
}

/**
 * Replaces a tenant completion marker after its exact identity has been verified:
 * it must already be a schema-2 marker for this account/subject bound to the exact
 * previous incarnation. A link, unreadable, foreign or tampered marker is refused
 * and never overwritten.
 */
function replaceTenantMarker(
  markerPath: string,
  account: { id: string; issuer: string; subject: string },
  previous: Incarnation,
  next: Incarnation,
): void {
  const stat = (() => {
    try {
      return lstatSync(markerPath);
    } catch {
      return undefined;
    }
  })();
  if (!stat || stat.isSymbolicLink() || !stat.isFile())
    throw new BrainError(
      "UNAUTHORIZED",
      "Managed account marker is not a real file.",
      401,
    );
  let existing: any;
  try {
    existing = JSON.parse(readFileSync(markerPath, "utf8"));
  } catch {
    throw new BrainError(
      "UNAUTHORIZED",
      "Managed account marker is unreadable.",
      401,
    );
  }
  if (
    existing?.schema !== 2 ||
    existing.account_id !== account.id ||
    existing.issuer !== account.issuer ||
    existing.subject !== account.subject ||
    existing.incarnation !== previous.incarnation ||
    Number(existing.provisioning_generation) !== previous.provisioning_generation
  )
    throw new BrainError(
      "UNAUTHORIZED",
      "Managed account marker does not match its provisioning incarnation.",
      401,
    );
  writeTenantMarker(markerPath, {
    schema: 2,
    account_id: account.id,
    issuer: account.issuer,
    subject: account.subject,
    incarnation: next.incarnation,
    provisioning_generation: next.provisioning_generation,
  });
}

/**
 * Owns one explicit managed filesystem root and the control store beside it.
 * Each managed account gets its own SQLite database, Git vault and protected
 * quarantine directory under a server-created UUID directory. Nothing here
 * reads or writes the local single-owner database, and callers never supply a
 * filesystem path.
 *
 * Every tenant entry path (database, vault, protected quarantine and marker)
 * is validated as a real, non-linked descendant of the tenant directory before
 * any store is opened, on first and cached acquisition alike.
 */
export class ManagedRuntime {
  readonly root: string;
  readonly control: ControlStore;
  private readonly clock: () => Date;
  private readonly maxOpen: number;
  private readonly capability?: () => { ready: boolean; reason: string };
  private readonly decisionCapability?: () => { ready: boolean; reason: string };
  private readonly cache = new Map<string, Entry>();
  private closed = false;

  constructor(
    root: string,
    options: {
      maxOpen?: number;
      clock?: () => Date;
      /**
       * Trusted, closed capability accessor bound to this exact root/control and the
       * deployment opt-in. It returns a boolean + static reason only; it never reads a
       * caller field and never grants admission. Absent => fail-closed false.
       */
      capability?: () => { ready: boolean; reason: string };
      /**
       * Trusted, closed DECISION-stage capability accessor (separate live decision
       * profile + fresh decision worker lease). Distinct from `capability`; absent =>
       * fail-closed false, so a local brain can never enable decision consent.
       */
      decisionCapability?: () => { ready: boolean; reason: string };
    } = {},
  ) {
    if (typeof root !== "string" || !root || !isAbsolute(root))
      throw new BrainError(
        "INVALID_INPUT",
        "Managed storage root must be one explicit absolute path.",
        400,
      );
    this.root = resolve(root);
    this.clock = options.clock ?? (() => new Date());
    this.capability = options.capability;
    this.decisionCapability = options.decisionCapability;
    this.maxOpen = z
      .number()
      .int()
      .min(1)
      .max(1024)
      .parse(options.maxOpen ?? 32);
    this.prepareRoot();
    // A root that is mid-restore must never be opened or re-provisioned. A
    // marker that exists as a link (even dangling) also refuses, so no link is
    // followed before the control store opens.
    let markerStat;
    try {
      markerStat = lstatSync(resolve(this.root, MANAGED_RESTORE_INCOMPLETE));
    } catch {
      markerStat = undefined;
    }
    if (markerStat)
      throw new BrainError(
        "UNAVAILABLE",
        "This managed root is mid-restore and is unavailable until recovery completes.",
        503,
      );
    this.control = new ControlStore(
      resolve(this.root, "control.sqlite"),
      this.clock,
    );
  }

  private assertOpen() {
    if (this.closed)
      throw new BrainError(
        "UNAVAILABLE",
        "Managed runtime has been closed.",
        503,
      );
  }

  /**
   * Rejects any existing ancestor of the root that is a symlink or junction,
   * creates the root, then confirms the root is its own real directory so a
   * redirected ancestor cannot silently place tenant data elsewhere.
   */
  private prepareRoot() {
    const chain: string[] = [];
    for (let dir = this.root; ; ) {
      chain.unshift(dir);
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    for (const candidate of chain) {
      if (!existsSync(candidate)) continue;
      const stat = lstatSync(candidate);
      if (stat.isSymbolicLink())
        throw new BrainError(
          "INVALID_INPUT",
          "Managed storage root passes through a link or junction.",
          400,
        );
      if (!stat.isDirectory())
        throw new BrainError(
          "INVALID_INPUT",
          "Managed storage root passes through a non-directory.",
          400,
        );
    }
    if (!existsSync(this.root))
      mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const stat = lstatSync(this.root);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new BrainError(
        "INVALID_INPUT",
        "Managed storage root must be a real directory, not a link or file.",
        400,
      );
    if (realpathSync(this.root).toLowerCase() !== this.root.toLowerCase())
      throw new BrainError(
        "INVALID_INPUT",
        "Managed storage root is not its own real path.",
        400,
      );
  }

  private tenantDir(tenantId: string) {
    return resolve(this.root, tenantId);
  }

  /**
   * Confirms the tenant directory is a direct, real, non-linked child of the
   * managed root. `create` is only ever true during provisioning.
   */
  private container(tenantId: string, create: boolean) {
    const dir = this.tenantDir(tenantId);
    if (dirname(dir) !== this.root)
      throw new BrainError("UNAUTHORIZED", "Managed account unavailable.", 401);
    if (!existsSync(dir)) {
      if (!create)
        throw new BrainError(
          "UNAUTHORIZED",
          "Managed account is not provisioned.",
          401,
        );
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const stat = lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new BrainError(
        "UNAUTHORIZED",
        "Managed account directory is not trusted.",
        401,
      );
    const real = realpathSync(dir);
    if (real.toLowerCase() !== dir.toLowerCase())
      throw new BrainError(
        "UNAUTHORIZED",
        "Managed account directory is not its own real path.",
        401,
      );
    const base = realpathSync(this.root);
    if (real !== base && !real.startsWith(base + sep))
      throw new BrainError(
        "UNAUTHORIZED",
        "Managed account directory escapes the managed root.",
        401,
      );
    return { dir, real };
  }

  /**
   * Validates a fully provisioned tenant before any store is opened: the
   * database, vault, protected quarantine and marker must all exist, be the
   * right type, not be links, resolve inside the tenant directory, and the
   * marker must name this exact account.
   */
  private assertTenant(tenantId: string, account: Account): TenantPaths {
    const { dir, real } = this.container(tenantId, false);
    const paths: TenantPaths = {
      dir,
      db: resolve(dir, "brain.sqlite"),
      vault: resolve(dir, "vault"),
      protected: resolve(dir, "vault-protected"),
      marker: resolve(dir, MARKER),
    };
    const entry = (path: string, kind: "file" | "dir") => {
      if (!existsSync(path))
        throw new BrainError(
          "UNAUTHORIZED",
          `Managed account ${kind} is missing.`,
          401,
        );
      const stat = lstatSync(path);
      if (stat.isSymbolicLink())
        throw new BrainError(
          "UNAUTHORIZED",
          `Managed account ${kind} is a link.`,
          401,
        );
      if (kind === "dir" ? !stat.isDirectory() : !stat.isFile())
        throw new BrainError(
          "UNAUTHORIZED",
          `Managed account ${kind} has the wrong type.`,
          401,
        );
      if (dirname(realpathSync(path)) !== real)
        throw new BrainError(
          "UNAUTHORIZED",
          `Managed account ${kind} escapes its directory.`,
          401,
        );
    };
    entry(paths.db, "file");
    entry(paths.vault, "dir");
    entry(paths.protected, "dir");
    entry(paths.marker, "file");
    let marker: any;
    try {
      marker = JSON.parse(readFileSync(paths.marker, "utf8"));
    } catch {
      throw new BrainError(
        "UNAUTHORIZED",
        "Managed account marker is unreadable.",
        401,
      );
    }
    const hasIncarnation = !!this.control.db
      .prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='managed_account_incarnation'",
      )
      .get();
    const incarnation = hasIncarnation
      ? readAccountIncarnation(this.control.db, tenantId)
      : undefined;
    if (incarnation) {
      if (
        marker?.schema !== 2 ||
        marker.account_id !== tenantId ||
        marker.issuer !== account.issuer ||
        marker.incarnation !== incarnation.incarnation ||
        Number(marker.provisioning_generation) !== incarnation.provisioning_generation
      )
        throw new BrainError(
          "UNAUTHORIZED",
          "Managed account marker does not match its provisioning incarnation.",
          401,
        );
      if (activeFence(this.control.db, tenantId))
        throw new BrainError(
          "UNAUTHORIZED",
          "Managed account is fenced for a history-changing operation.",
          401,
        );
    } else if (
      marker?.schema !== 1 ||
      marker.account_id !== tenantId ||
      marker.issuer !== account.issuer
    ) {
      // A pre-enrollment schema-1 tenant (no incarnation row yet) stays trusted and
      // knowledge-readable; it is simply non-funding until the offline enrollment
      // backfills a generation. This is never a manual/billing fallback.
      throw new BrainError(
        "UNAUTHORIZED",
        "Managed account marker does not match its account.",
        401,
      );
    }
    return paths;
  }

  private hasIncarnationTable(): boolean {
    return !!this.control.db
      .prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='managed_account_incarnation'",
      )
      .get();
  }

  /**
   * If opening this tenant would rebuild its operational database from an existing
   * vault — silently losing any tenant-side financial history — fence and advance the
   * account's provisioning generation in ONE control transaction BEFORE the storage
   * constructor runs. A legacy money-4 root or a pre-enrollment schema-1 tenant (no
   * incarnation row) is left exactly as before. Returns true when it rebuilt; a
   * failure after the fence leaves that fence ACTIVE.
   */
  private rebuildIfHistoryChanging(
    account: ManagedAccount,
    paths: TenantPaths,
  ): boolean {
    if (!this.hasIncarnationTable()) return false;
    const previous = readAccountIncarnation(this.control.db, account.id);
    if (!previous) return false;
    const probe = probeTenantStorage(paths.db, paths.vault);
    if (!probe.vaultManifest || probe.dbOperational) return false;
    this.fencedRebuild(account, paths, previous);
    return true;
  }

  private fencedRebuild(
    account: ManagedAccount,
    paths: TenantPaths,
    previous: Incarnation,
  ): void {
    const now = this.clock().toISOString();
    let next!: Incarnation;
    this.control.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.control.db
        .prepare("SELECT id,issuer,subject,state FROM managed_accounts WHERE id=?")
        .get(account.id) as
        | { id: string; issuer: string; subject: string; state: string }
        | undefined;
      if (
        !row ||
        row.state !== "active" ||
        row.issuer !== account.issuer ||
        row.subject !== account.subject
      )
        throw new BrainError("UNAUTHORIZED", "Managed account unavailable.", 401);
      const current = readAccountIncarnation(this.control.db, account.id);
      if (!current || current.incarnation !== previous.incarnation)
        throw new BrainError(
          "CONFLICT",
          "The provisioning incarnation changed concurrently.",
          409,
        );
      fenceAccount(this.control.db, account.id, "rebuild", now);
      next = readAccountIncarnation(this.control.db, account.id)!;
      this.control.db.exec("COMMIT");
    } catch (error) {
      this.control.db.exec("ROLLBACK");
      throw error;
    }
    // The fence is now ACTIVE. There is deliberately no try/finally clear: any
    // failure below leaves it active (paid held) until the operator explicitly
    // re-admits offline. Old admissions stay stale forever otherwise.
    const store = new Storage(paths.db, { vault: paths.vault });
    store.close();
    replaceTenantMarker(paths.marker, account, previous, next);
    clearFence(this.control.db, account.id, this.clock().toISOString());
    this.assertTenant(account.id, account);
  }

  private tenantPaths(dir: string): TenantPaths {
    return {
      dir,
      db: resolve(dir, "brain.sqlite"),
      vault: resolve(dir, "vault"),
      protected: resolve(dir, "vault-protected"),
      marker: resolve(dir, MARKER),
    };
  }

  /**
   * Idempotent, atomic-enough provisioning: the trusted control row is created
   * first, then the tenant store is initialized and only then is the completion
   * marker written. A tampered marker is never overwritten. An account without
   * a marker can never be acquired.
   */
  provision(issuer: string, subject: string): ManagedAccount {
    this.assertOpen();
    const account = this.control.provision(issuer, subject);
    const dir = this.container(account.id, true).dir;
    const paths = this.tenantPaths(dir);
    for (const path of [paths.db, paths.vault, paths.protected, paths.marker])
      if (existsSync(path) && lstatSync(path).isSymbolicLink())
        throw new BrainError(
          "INVALID_INPUT",
          "Managed account path is occupied by a link.",
          409,
        );
    const rebuilt = this.rebuildIfHistoryChanging(account, paths);
    if (!rebuilt && (!existsSync(paths.db) || !existsSync(paths.vault))) {
      const store = new Storage(paths.db, { vault: paths.vault });
      store.close();
    }
    if (!existsSync(paths.protected))
      mkdirSync(paths.protected, { recursive: true, mode: 0o700 });

    const hasIncarnationTable = this.hasIncarnationTable();
    let incarnation = hasIncarnationTable
      ? readAccountIncarnation(this.control.db, account.id)
      : undefined;
    const markerPresent = existsSync(paths.marker);
    // A newly provisioned v5 account mints exactly one generation-1 incarnation. An
    // already-marked account (including a pre-enrollment schema-1 tenant) is never
    // silently adopted into billing by minting a generation during provision.
    if (hasIncarnationTable && !incarnation && !markerPresent) {
      incarnation = mintAccountIncarnation(this.control.db, {
        account_id: account.id,
        issuer: account.issuer,
        subject: account.subject,
        now: this.clock().toISOString(),
        nonce: randomBytes(32).toString("hex"),
      });
    }
    if (!markerPresent) {
      writeTenantMarker(
        paths.marker,
        incarnation
          ? {
              schema: 2,
              account_id: account.id,
              issuer: account.issuer,
              subject: account.subject,
              incarnation: incarnation.incarnation,
              provisioning_generation: incarnation.provisioning_generation,
            }
          : {
              schema: 1,
              account_id: account.id,
              issuer: account.issuer,
              subject: account.subject,
            },
      );
    }
    this.assertTenant(account.id, account);
    return account;
  }

  /**
   * Explicit supported rebuild of one provisioned tenant from its own vault. It is
   * the only operation that rebuilds a missing/empty operational database for an
   * enrolled schema-2 account, and it fences and advances that account's generation
   * first, so any pre-rebuild admission is stale and paid work is held. A failure
   * leaves the fence active; only an explicit offline re-admit restores funding. A
   * legacy money-4 root and a healthy tenant are left unchanged.
   */
  reprovision(tenantId: string): ManagedAccount {
    this.assertOpen();
    if (typeof tenantId !== "string" || !UUID.test(tenantId))
      throw new BrainError("UNAUTHORIZED", "Managed account unavailable.", 401);
    const account = this.control.account(tenantId);
    if (!account || account.state !== "active")
      throw new BrainError("UNAUTHORIZED", "Managed account unavailable.", 401);
    const dir = this.container(tenantId, false).dir;
    const paths = this.tenantPaths(dir);
    const rebuilt = this.rebuildIfHistoryChanging(account, paths);
    if (!rebuilt && (!existsSync(paths.db) || !existsSync(paths.vault))) {
      const store = new Storage(paths.db, { vault: paths.vault });
      store.close();
    }
    if (!existsSync(paths.protected))
      mkdirSync(paths.protected, { recursive: true, mode: 0o700 });
    if (!rebuilt) this.assertTenant(tenantId, account);
    return account;
  }

  /**
   * Returns a pinned handle for one active, fully provisioned tenant. Repeated
   * acquisitions share the same brain and increment its pin count. Idle handles
   * are evicted to stay within the open-handle bound; if every open handle is
   * pinned the runtime fails closed instead of opening an unbounded connection.
   */
  acquire(tenantId: string): ManagedHandle {
    this.assertOpen();
    if (typeof tenantId !== "string" || !UUID.test(tenantId))
      throw new BrainError("UNAUTHORIZED", "Managed account unavailable.", 401);
    const account = this.control.account(tenantId);
    if (!account || account.state !== "active")
      throw new BrainError("UNAUTHORIZED", "Managed account unavailable.", 401);
    const paths = this.assertTenant(tenantId, account);
    const cached = this.cache.get(tenantId);
    if (cached) {
      cached.pins += 1;
      cached.lastUsed = this.clock().getTime();
      return this.handle(tenantId, cached);
    }
    // Fence and advance BEFORE the storage constructor can rebuild an empty
    // operational database from the vault. A healthy tenant is untouched.
    this.rebuildIfHistoryChanging(account, paths);
    this.evictIdle(this.maxOpen - 1);
    if (this.cache.size >= this.maxOpen)
      throw new BrainError(
        "UNAVAILABLE",
        "Managed runtime is at capacity; retry shortly.",
        503,
      );
    const entry: Entry = {
      brain: new Brain(
        new Storage(paths.db, { vault: paths.vault }),
        this.clock,
        tenantId,
        () => this.control.account(tenantId)?.state === "active",
        () => managedMoneyView(this.control, tenantId, this.clock),
        this.capability,
        this.decisionCapability,
      ),
      pins: 1,
      lastUsed: this.clock().getTime(),
    };
    this.cache.set(tenantId, entry);
    return this.handle(tenantId, entry);
  }

  private handle(tenantId: string, entry: Entry): ManagedHandle {
    let released = false;
    return {
      brain: entry.brain,
      release: () => {
        if (released) return;
        released = true;
        const current = this.cache.get(tenantId);
        if (current === entry && entry.pins > 0) entry.pins -= 1;
      },
    };
  }

  private evictIdle(limit: number) {
    while (this.cache.size > limit) {
      const victim = [...this.cache.entries()]
        .filter(([, entry]) => entry.pins === 0)
        .sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      if (!victim) return;
      victim[1].brain.store.close();
      this.cache.delete(victim[0]);
    }
  }

  /**
   * Closes the control store and every open handle. Fails closed if any handle
   * is still pinned so an in-flight request is never closed underneath itself;
   * the caller must release handles (for example, after shutdown) and retry.
   */
  close() {
    if (this.closed) return;
    if ([...this.cache.values()].some((entry) => entry.pins > 0))
      throw new BrainError(
        "UNAVAILABLE",
        "Release managed handles before closing the runtime.",
        409,
      );
    this.closed = true;
    for (const entry of this.cache.values()) entry.brain.store.close();
    this.cache.clear();
    this.control.close();
  }
}
