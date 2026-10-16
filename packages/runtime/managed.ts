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
import type { DatabaseSync } from "node:sqlite";
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
  evaluateConfiguredPolicy,
  readActivation,
  serverCapability,
} from "./managed-activation.ts";
import { readWorkerReadiness } from "./worker-readiness.ts";
import type { ActivationReason } from "../domain/managed-activation.ts";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MARKER = "provisioned.json";

export type ManagedAccount = Account;
export type ManagedHandle = { brain: Brain; release: () => void };

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
    if (
      marker?.schema !== 1 ||
      marker.account_id !== tenantId ||
      marker.issuer !== account.issuer
    )
      throw new BrainError(
        "UNAUTHORIZED",
        "Managed account marker does not match its account.",
        401,
      );
    return paths;
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
    const db = resolve(dir, "brain.sqlite");
    const vault = resolve(dir, "vault");
    const protectedDir = resolve(dir, "vault-protected");
    const marker = resolve(dir, MARKER);
    for (const path of [db, vault, protectedDir, marker])
      if (existsSync(path) && lstatSync(path).isSymbolicLink())
        throw new BrainError(
          "INVALID_INPUT",
          "Managed account path is occupied by a link.",
          409,
        );
    if (!existsSync(db) || !existsSync(vault)) {
      const store = new Storage(db, { vault });
      store.close();
    }
    if (!existsSync(protectedDir))
      mkdirSync(protectedDir, { recursive: true, mode: 0o700 });
    if (!existsSync(marker)) {
      const tmp = resolve(
        dir,
        `${MARKER}.${randomBytes(6).toString("hex")}.tmp`,
      );
      rmSync(tmp, { force: true });
      writeFileSync(
        tmp,
        JSON.stringify({
          schema: 1,
          account_id: account.id,
          issuer: account.issuer,
          subject: account.subject,
        }),
        { mode: 0o600 },
      );
      renameSync(tmp, marker);
    }
    this.assertTenant(account.id, account);
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
