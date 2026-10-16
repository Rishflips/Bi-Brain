import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { z } from "zod";
import { ControlStore } from "../storage/control.ts";
import { Storage } from "../storage/index.ts";
import { Brain } from "../domain/service.ts";
import { BrainError } from "../domain/logic.ts";
import {
  applyRestoreSafetyBarrier,
  purgeRetainedDeletedSource,
} from "../storage/restore-policy.ts";
import {
  MANAGED_RESTORE_INCOMPLETE,
  applyControlRestoreBarrier,
} from "../storage/managed-restore-policy.ts";

/**
 * Conservative cold/offline managed backup and restore.
 *
 * Not a hot distributed snapshot. The operator must stop the API and worker and
 * acknowledge `--offline`; the tool cannot prove the filesystem is quiesced. All
 * paths are explicit absolute paths, nothing is overwritten in place, and a
 * bundle binds its control database, each tenant database, vault, protected
 * quarantine and markers by strict schema, account inventory and per-file
 * SHA-256. The hashes are an integrity check, not an adversarial signature.
 */
export const managedBundleSchemaVersion = 1;

const MARKER = "provisioned.json";
const TENANT_ENTRIES = ["provisioned.json", "brain.sqlite", "vault", "vault-protected"] as const;
const TENANT_DIRS = new Set(["vault", "vault-protected"]);
const HASH_SKIP = new Set(["manifest.json"]);

const accountSchema = z
  .object({
    account_id: z.string().uuid(),
    issuer: z.string().min(1).max(300),
    subject: z.string().min(1).max(300),
    state: z.enum(["active", "suspended"]),
  })
  .strict();
const fileSchema = z
  .object({
    path: z.string().min(1).max(4096),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
const manifestSchema = z
  .object({
    schema: z.literal(managedBundleSchemaVersion),
    created_at: z.string().datetime({ offset: true }),
    accounts: z.array(accountSchema).max(10000),
    files: z.array(fileSchema).max(1_000_000),
  })
  .strict();

export type ManagedBundleAccount = z.infer<typeof accountSchema>;
export interface ManagedBundleManifest {
  schema: 1;
  created_at: string;
  accounts: ManagedBundleAccount[];
  files: { path: string; sha256: string; size: number }[];
}

const recoveryError = (message: string) =>
  new BrainError("INVALID_INPUT", message, 400);

function assertOffline(offline: boolean): void {
  if (!offline)
    throw recoveryError(
      "Pass --offline to confirm the API and worker are stopped. This tool cannot prove the filesystem is quiesced.",
    );
}

function assertAbsolute(path: string, label: string): string {
  if (typeof path !== "string" || !isAbsolute(path))
    throw recoveryError(`${label} must be one absolute path.`);
  return resolve(path);
}

/**
 * Rejects a path whose real self or any existing ancestor is a link (including a
 * dangling link) or a non-directory. It never follows a link to check.
 */
function assertNoLinks(path: string): void {
  const chain: string[] = [];
  for (let dir = resolve(path); ; ) {
    chain.unshift(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const candidate of chain) {
    let stat;
    try {
      stat = lstatSync(candidate);
    } catch {
      continue; // ENOENT: an ancestor that does not exist yet is fine.
    }
    if (stat.isSymbolicLink())
      throw recoveryError("The path passes through a link or junction.");
    if (!stat.isDirectory())
      throw recoveryError("The path passes through a non-directory.");
  }
}

function lstatRequired(path: string, message: string): Stats {
  try {
    return lstatSync(path);
  } catch {
    throw recoveryError(message);
  }
}

function assertRealDirectory(path: string, label: string): void {
  assertNoLinks(path);
  const stat = lstatRequired(path, `${label} does not exist.`);
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw recoveryError(`${label} must be a real directory, not a link.`);
}

function assertRealFile(path: string, label: string): void {
  assertNoLinks(dirname(path));
  const stat = lstatRequired(path, `${label} is missing.`);
  if (stat.isSymbolicLink() || !stat.isFile())
    throw recoveryError(`${label} must be a real file, not a link.`);
}

function assertAbsent(path: string, label: string): void {
  if (existsSync(path)) throw recoveryError(`${label} already exists.`);
}

function assertDisjoint(a: string, b: string): void {
  const contains = (from: string, to: string) => {
    const rel = relative(from, to);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  };
  if (contains(a, b) || contains(b, a))
    throw recoveryError("Source, destination and current root must not overlap or nest.");
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function walkFiles(root: string, base = ""): string[] {
  const found: string[] = [];
  for (const name of readdirSync(join(root, base))) {
    const rel = base ? join(base, name) : name;
    const stat = lstatSync(join(root, rel));
    if (stat.isSymbolicLink())
      throw recoveryError("Refusing to copy or hash a link or junction.");
    if (stat.isDirectory()) found.push(...walkFiles(root, rel));
    else if (stat.isFile()) found.push(rel);
    else throw recoveryError("Unsupported file type in the managed root.");
  }
  return found;
}

/**
 * Recursively copies regular files and directories. It never follows a link and
 * preserves every regular file, including a retained-source WAL inside the
 * protected quarantine; SQLite databases are snapshotted separately so we never
 * need to skip a sidecar here.
 */
function copyTree(src: string, dst: string): void {
  const stat = lstatRequired(src, "A source file is missing.");
  if (stat.isSymbolicLink())
    throw recoveryError("Refusing to copy a link or junction.");
  if (stat.isDirectory()) {
    mkdirSync(dst, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(src)) copyTree(join(src, name), join(dst, name));
    return;
  }
  if (stat.isFile()) {
    copyFileSync(src, dst);
    chmodSync(dst, 0o600);
    return;
  }
  throw recoveryError("Unsupported file type in the managed root.");
}

async function snapshotSqlite(source: string, destination: string): Promise<void> {
  assertRealFile(source, "A managed database");
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    await backup(db, destination);
  } finally {
    db.close();
  }
  // Consolidate the snapshot to one file: the backup API can leave a WAL/SHM
  // sidecar, which must never appear in the bundle.
  const target = new DatabaseSync(destination);
  try {
    target.exec("PRAGMA journal_mode=DELETE;");
  } finally {
    target.close();
  }
  rmSync(`${destination}-wal`, { force: true });
  rmSync(`${destination}-shm`, { force: true });
}

function assertSqliteHealthy(path: string): void {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const integrity = db.prepare("PRAGMA integrity_check").get() as
      | { integrity_check?: string }
      | undefined;
    if (!integrity || integrity.integrity_check !== "ok")
      throw recoveryError("A managed database snapshot failed its integrity check.");
    if ((db.prepare("PRAGMA foreign_key_check").all() as unknown[]).length > 0)
      throw recoveryError("A managed database snapshot failed its foreign-key check.");
  } finally {
    db.close();
  }
}

function controlInventory(path: string): ManagedBundleAccount[] {
  assertRealFile(path, "The control database");
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const has = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='managed_accounts'")
      .get();
    if (!has) throw recoveryError("Not a Bi Brain control database.");
    return db
      .prepare(
        "SELECT id AS account_id,issuer,subject,state FROM managed_accounts ORDER BY id",
      )
      .all() as ManagedBundleAccount[];
  } finally {
    db.close();
  }
}

function readManifest(bundle: string): ManagedBundleManifest {
  const path = join(bundle, "manifest.json");
  if (!existsSync(path)) throw recoveryError("The bundle has no manifest.json.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw recoveryError("The bundle manifest is unreadable.");
  }
  const result = manifestSchema.safeParse(parsed);
  if (!result.success)
    throw recoveryError("The bundle manifest has an unsupported schema, version or shape.");
  const manifest = result.data as ManagedBundleManifest;
  const accountIds = new Set(manifest.accounts.map((a) => a.account_id));
  if (accountIds.size !== manifest.accounts.length)
    throw recoveryError("The bundle manifest has duplicate accounts.");
  const paths = new Set(manifest.files.map((f) => f.path));
  if (paths.size !== manifest.files.length)
    throw recoveryError("The bundle manifest has duplicate file paths.");
  return manifest;
}

function verifyBundle(bundle: string, manifest: ManagedBundleManifest): void {
  for (const file of manifest.files) {
    const segments = file.path.split(/[\\/]/);
    if (isAbsolute(file.path) || segments.includes("..") || file.path.includes("\u0000"))
      throw recoveryError("The bundle manifest lists an unsafe path.");
    const full = join(bundle, file.path);
    const stat = lstatRequired(full, "A file recorded in the manifest is missing.");
    if (stat.isSymbolicLink())
      throw recoveryError("The bundle contains a link.");
    const size = readFileSync(full).length;
    if (stat.size !== file.size || size !== file.size || sha256File(full) !== file.sha256)
      throw recoveryError("A bundle file does not match its recorded hash.");
  }
  const recorded = new Set(manifest.files.map((f) => f.path));
  for (const rel of walkFiles(bundle)) {
    if (HASH_SKIP.has(rel)) continue;
    if (!recorded.has(rel))
      throw recoveryError("The bundle contains files that are not in the manifest.");
  }
}

function assertBundleTopLevel(bundle: string, manifest: ManagedBundleManifest): void {
  const allowed = new Set<string>(["manifest.json", "control.sqlite"]);
  for (const account of manifest.accounts) allowed.add(account.account_id);
  for (const name of readdirSync(bundle)) {
    if (!allowed.has(name))
      throw recoveryError(`The bundle contains an unexpected top-level entry: ${name}`);
    const stat = lstatSync(join(bundle, name));
    if (stat.isSymbolicLink()) throw recoveryError("The bundle contains a link.");
  }
}

function assertInventoryMatches(
  manifestAccounts: ManagedBundleAccount[],
  controlAccounts: ManagedBundleAccount[],
): void {
  const key = (a: ManagedBundleAccount) => `${a.account_id}|${a.issuer}|${a.subject}|${a.state}`;
  const a = [...manifestAccounts].map(key).sort();
  const b = [...controlAccounts].map(key).sort();
  if (a.length !== b.length || a.some((value, i) => value !== b[i]))
    throw recoveryError(
      "The bundle manifest account inventory does not match its control database.",
    );
}

function assertTenantDir(dir: string, parent: string, label: string): void {
  if (dirname(dir) !== parent)
    throw recoveryError(`${label} is not a direct child of its root.`);
  assertNoLinks(dir);
  const stat = lstatRequired(dir, `${label} is missing.`);
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw recoveryError(`${label} must be a real directory, not a link.`);
  for (const entry of TENANT_ENTRIES) {
    const path = join(dir, entry);
    const entryStat = lstatRequired(path, `${label} is incomplete.`);
    if (entryStat.isSymbolicLink())
      throw recoveryError(`${label} contains a link or junction.`);
    const wantDir = TENANT_DIRS.has(entry);
    if (wantDir ? !entryStat.isDirectory() : !entryStat.isFile())
      throw recoveryError(`${label} has an entry of the wrong type.`);
  }
}

function assertTenantMarker(dir: string, account: ManagedBundleAccount): void {
  assertTenantDir(dir, dirname(dir), "A backed account");
  let marker: any;
  try {
    marker = JSON.parse(readFileSync(join(dir, MARKER), "utf8"));
  } catch {
    throw recoveryError("A backed account marker is unreadable.");
  }
  if (
    marker?.schema !== 1 ||
    marker.account_id !== account.account_id ||
    marker.issuer !== account.issuer ||
    marker.subject !== account.subject
  )
    throw recoveryError("A backed account marker does not match the manifest.");
}

function applyTenantRestoreBarrier(store: Storage, clock: () => Date): void {
  applyRestoreSafetyBarrier(store, clock);
  store.run("DELETE FROM sessions");
  store.run("UPDATE grants SET revoked_at=?", clock().toISOString());
}

function newStaging(destination: string, clock: () => Date): string {
  return `${destination}.staging-${createHash("sha256")
    .update(clock().toISOString() + Math.random())
    .digest("hex")
    .slice(0, 12)}`;
}

// ------------------------------------------------------------------ backup

export interface ManagedBackupInput {
  root: string;
  destination: string;
  offline: boolean;
  clock?: () => Date;
}
export interface ManagedBackupResult {
  destination: string;
  accounts: number;
  files: number;
}

export async function writeManagedBackup(
  input: ManagedBackupInput,
): Promise<ManagedBackupResult> {
  assertOffline(input.offline);
  const root = assertAbsolute(input.root, "The managed root");
  const destination = assertAbsolute(input.destination, "The destination");
  assertRealDirectory(root, "The managed root");
  assertAbsent(destination, "The destination");
  // Validate every existing ancestor of the output before creating anything.
  assertNoLinks(dirname(destination));
  assertDisjoint(root, destination);
  assertRealFile(join(root, "control.sqlite"), "The control database");
  const inventory = controlInventory(join(root, "control.sqlite"));
  const clock = input.clock ?? (() => new Date());

  const staging = newStaging(destination, clock);
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  try {
    await snapshotSqlite(join(root, "control.sqlite"), join(staging, "control.sqlite"));
    for (const account of inventory) {
      const dir = join(root, account.account_id);
      assertTenantMarker(dir, account);
      const staged = join(staging, account.account_id);
      mkdirSync(staged, { recursive: true, mode: 0o700 });
      copyTree(join(dir, MARKER), join(staged, MARKER));
      await snapshotSqlite(join(dir, "brain.sqlite"), join(staged, "brain.sqlite"));
      copyTree(join(dir, "vault"), join(staged, "vault"));
      copyTree(join(dir, "vault-protected"), join(staged, "vault-protected"));
    }
    assertSqliteHealthy(join(staging, "control.sqlite"));
    for (const account of inventory)
      assertSqliteHealthy(join(staging, account.account_id, "brain.sqlite"));
    const files = walkFiles(staging)
      .filter((p) => !HASH_SKIP.has(p))
      .map((p) => ({
        path: p,
        sha256: sha256File(join(staging, p)),
        size: readFileSync(join(staging, p)).length,
      }));
    const manifest: ManagedBundleManifest = {
      schema: managedBundleSchemaVersion,
      created_at: clock().toISOString(),
      accounts: inventory,
      files,
    };
    writeFileSync(join(staging, "manifest.json"), JSON.stringify(manifest), {
      mode: 0o600,
    });
    renameSync(staging, destination);
    return { destination, accounts: inventory.length, files: files.length };
  } catch (error) {
    // Never leave a full sensitive bundle in the failed output target.
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

// ----------------------------------------------------------------- restore

export interface ManagedRestoreInput {
  bundle: string;
  destination: string;
  currentRoot: string;
  offline: boolean;
  clock?: () => Date;
}
export interface ManagedRestoreResult {
  destination: string;
  accounts: number;
  replayed: number;
}

export async function restoreManagedBackup(
  input: ManagedRestoreInput,
): Promise<ManagedRestoreResult> {
  assertOffline(input.offline);
  const bundle = assertAbsolute(input.bundle, "The bundle");
  const destination = assertAbsolute(input.destination, "The new destination");
  const currentRoot = assertAbsolute(input.currentRoot, "The current root");
  assertRealDirectory(bundle, "The bundle");
  assertRealDirectory(currentRoot, "The current root");
  assertAbsent(destination, "The new destination");
  assertNoLinks(dirname(destination));
  assertDisjoint(bundle, destination);
  assertDisjoint(currentRoot, destination);
  assertDisjoint(bundle, currentRoot);
  const clock = input.clock ?? (() => new Date());

  const manifest = readManifest(bundle);
  verifyBundle(bundle, manifest);
  assertBundleTopLevel(bundle, manifest);
  const bundleControl = join(bundle, "control.sqlite");
  assertSqliteHealthy(bundleControl);
  const bundledInventory = controlInventory(bundleControl);
  assertInventoryMatches(manifest.accounts, bundledInventory);

  // Bind backed accounts to the CURRENT trusted identities and require a
  // readable current tenant for every one before any SQLite open for replay.
  const currentControlPath = join(currentRoot, "control.sqlite");
  assertRealFile(currentControlPath, "The current control database");
  const currentById = new Map(
    controlInventory(currentControlPath).map((a) => [a.account_id, a]),
  );
  for (const account of manifest.accounts) {
    const current = currentById.get(account.account_id);
    if (!current)
      throw recoveryError(
        "A backed account no longer exists in the current root; it must not be resurrected.",
      );
    if (current.issuer !== account.issuer || current.subject !== account.subject)
      throw recoveryError("A backed account identity does not match the current root.");
    assertTenantDir(join(currentRoot, account.account_id), currentRoot, "The current tenant");
    assertSqliteHealthy(join(currentRoot, account.account_id, "brain.sqlite"));
  }

  const staged = newStaging(destination, clock);
  mkdirSync(staged, { recursive: true, mode: 0o700 });
  writeFileSync(join(staged, MANAGED_RESTORE_INCOMPLETE), clock().toISOString(), {
    mode: 0o600,
  });
  let replayed = 0;
  try {
    copyTree(bundleControl, join(staged, "control.sqlite"));
    for (const account of manifest.accounts) {
      const from = join(bundle, account.account_id);
      assertTenantMarker(from, account);
      const to = join(staged, account.account_id);
      mkdirSync(to, { recursive: true, mode: 0o700 });
      copyTree(join(from, MARKER), join(to, MARKER));
      copyTree(join(from, "brain.sqlite"), join(to, "brain.sqlite"));
      copyTree(join(from, "vault"), join(to, "vault"));
      copyTree(join(from, "vault-protected"), join(to, "vault-protected"));
    }

    // Control barrier FIRST, then each tenant barrier, both before any replay.
    const stagingControl = new ControlStore(join(staged, "control.sqlite"), clock);
    try {
      applyControlRestoreBarrier(stagingControl, clock);
      for (const account of manifest.accounts) {
        const current = currentById.get(account.account_id)!;
        if (account.state === "suspended" || current.state === "suspended")
          stagingControl.setAccountState(account.account_id, "suspended");
      }
    } finally {
      stagingControl.close();
    }

    for (const account of manifest.accounts) {
      const store = new Storage(join(staged, account.account_id, "brain.sqlite"), {
        vault: join(staged, account.account_id, "vault"),
      });
      try {
        applyTenantRestoreBarrier(store, clock);
        // A missing or unreadable current tenant must reject the whole restore,
        // never silently publish older content.
        replayed += replayCurrentDeletions(
          join(currentRoot, account.account_id, "brain.sqlite"),
          store,
          clock,
        );
      } finally {
        store.close();
      }
    }

    // Keep the marker inside through the rename: a rename failure cannot publish
    // an unmarked, partially-ready root. If removing the marker fails, the
    // destination stays unavailable, which is correct.
    renameSync(staged, destination);
    rmSync(join(destination, MANAGED_RESTORE_INCOMPLETE), { force: true });
    return { destination, accounts: manifest.accounts.length, replayed };
  } catch (error) {
    // A failed restore leaves its marker and staging for inspection.
    throw error;
  }
}

function replayCurrentDeletions(
  currentTenantPath: string,
  restored: Storage,
  clock: () => Date,
): number {
  assertNoLinks(dirname(currentTenantPath));
  assertRealFile(currentTenantPath, "The current tenant database");
  let current: DatabaseSync;
  try {
    current = new DatabaseSync(currentTenantPath, { readOnly: true });
  } catch {
    throw recoveryError("The current tenant database is missing or unreadable.");
  }
  let tombstones: { id: string; state: string }[] = [];
  try {
    tombstones = current
      .prepare("SELECT id,state FROM sources WHERE state IN ('deleted','withdrawn')")
      .all() as { id: string; state: string }[];
  } catch {
    throw recoveryError("The current tenant database is unreadable.");
  } finally {
    current.close();
  }
  const brain = new Brain(restored, clock);
  let applied = 0;
  for (const tomb of tombstones) {
    const retained = restored.get<{ version: number; state: string }>(
      "SELECT version,state FROM sources WHERE id=?",
      tomb.id,
    );
    if (!retained) continue;
    if (tomb.state === "deleted" && retained.state === "deleted") {
      purgeRetainedDeletedSource(restored, tomb.id);
    } else if (retained.state !== "deleted") {
      brain.removeSource({ kind: "owner" }, tomb.id, retained.version, tomb.state === "deleted");
    }
    applied += 1;
  }
  return applied;
}
