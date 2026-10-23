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
import { createHash, randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { z } from "zod";
import { ControlStore } from "../storage/control.ts";
import { Storage } from "../storage/index.ts";
import { Brain } from "../domain/service.ts";
import { BrainError, canonical } from "../domain/logic.ts";
import {
  ManagedActivationStore,
  activationMirrorPath,
  readActivationMirror,
  readActivationRow,
} from "../storage/managed-activation.ts";
import {
  ManagedDecisionActivationStore,
  decisionActivationMirrorPath,
  readDecisionActivationMirror,
  readDecisionActivationRow,
} from "../storage/managed-decision-activation.ts";
import {
  applyRestoreSafetyBarrier,
  purgeRetainedDeletedSource,
} from "../storage/restore-policy.ts";
import {
  MANAGED_RESTORE_INCOMPLETE,
  applyControlRestoreBarrier,
} from "../storage/managed-restore-policy.ts";
import {
  MANAGED_ROOT_MARKER,
  readRootMarker,
  rootEpochMatches,
  rootMarkerSchema,
  writeRootMarker,
} from "./managed-operator.ts";
import {
  clearFence,
  fenceAccount,
  readAccountIncarnation,
} from "../storage/managed-incarnation.ts";
import type { Incarnation } from "../domain/billing-admission.ts";
import { loadBillingKey } from "../storage/billing-key.ts";

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
const TENANT_ENTRIES = [
  "provisioned.json",
  "brain.sqlite",
  "vault",
  "vault-protected",
] as const;
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
    root_marker: z.string().min(1).max(4096).nullable().optional(),
    paddle_store: z.literal("paddle.sqlite").nullable().optional(),
    dodo_store: z.literal("dodo.sqlite").nullable().optional(),
    billing_authority: z
      .object({
        key_path: z.literal(".protected/billing-authority.key"),
        key_commitment: z.string().regex(/^[0-9a-f]{64}$/),
        key_size: z.literal(32),
        included: z.literal(false),
        restore_requires_offline_key_and_reenrollment: z.literal(true),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();

export type ManagedBundleAccount = z.infer<typeof accountSchema>;
export interface ManagedBundleManifest {
  schema: 1;
  created_at: string;
  accounts: ManagedBundleAccount[];
  files: { path: string; sha256: string; size: number }[];
  root_marker?: string | null;
  paddle_store?: "paddle.sqlite" | null;
  dodo_store?: "dodo.sqlite" | null;
  billing_authority?: {
    key_path: ".protected/billing-authority.key";
    key_commitment: string;
    key_size: 32;
    included: false;
    restore_requires_offline_key_and_reenrollment: true;
  } | null;
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
  for (let dir = resolve(path); ;) {
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
    throw recoveryError(
      "Source, destination and current root must not overlap or nest.",
    );
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
    for (const name of readdirSync(src))
      copyTree(join(src, name), join(dst, name));
    return;
  }
  if (stat.isFile()) {
    copyFileSync(src, dst);
    chmodSync(dst, 0o600);
    return;
  }
  throw recoveryError("Unsupported file type in the managed root.");
}

async function snapshotSqlite(
  source: string,
  destination: string,
): Promise<void> {
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
      { integrity_check?: string } | undefined;
    if (!integrity || integrity.integrity_check !== "ok")
      throw recoveryError(
        "A managed database snapshot failed its integrity check.",
      );
    if ((db.prepare("PRAGMA foreign_key_check").all() as unknown[]).length > 0)
      throw recoveryError(
        "A managed database snapshot failed its foreign-key check.",
      );
  } finally {
    db.close();
  }
}

function controlInventory(path: string): ManagedBundleAccount[] {
  assertRealFile(path, "The control database");
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const has = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='managed_accounts'",
      )
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

function readControlEpoch(
  path: string,
): { epoch: number; nonce: string; rotated_at: string } | undefined {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const has = db
      .prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='managed_control_epoch'",
      )
      .get();
    if (!has) return undefined;
    const row = db
      .prepare(
        "SELECT epoch,nonce,rotated_at FROM managed_control_epoch WHERE singleton=1",
      )
      .get() as
      { epoch: number; nonce: string; rotated_at: string } | undefined;
    if (!row) return undefined;
    return {
      epoch: Number(row.epoch),
      nonce: String(row.nonce),
      rotated_at: String(row.rotated_at),
    };
  } finally {
    db.close();
  }
}

/**
 * Reads the per-account provisioning incarnations from a control database, or an
 * empty map when the money-5 incarnation table is absent (a legacy root). Read-only.
 */
function readIncarnations(
  controlPath: string,
): Map<string, { incarnation: string; provisioning_generation: number }> {
  const map = new Map<
    string,
    { incarnation: string; provisioning_generation: number }
  >();
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(controlPath, { readOnly: true });
  } catch {
    return map;
  }
  try {
    const has = db
      .prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='managed_account_incarnation'",
      )
      .get();
    if (!has) return map;
    for (const row of db
      .prepare(
        "SELECT account_id,incarnation,provisioning_generation FROM managed_account_incarnation",
      )
      .all() as {
      account_id: string;
      incarnation: string;
      provisioning_generation: number;
    }[])
      map.set(row.account_id, {
        incarnation: row.incarnation,
        provisioning_generation: Number(row.provisioning_generation),
      });
  } finally {
    db.close();
  }
  return map;
}

/**
 * Atomically rewrites a staged tenant completion marker from the exact previous
 * schema-2 incarnation to the new one rotated by the restore fence. A link,
 * unreadable, foreign or tampered marker is refused, never overwritten.
 */
function replaceStagedMarker(
  markerPath: string,
  account: ManagedBundleAccount,
  previous: { incarnation: string; provisioning_generation: number },
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
    throw recoveryError("A staged account marker is not a real file.");
  let existing: any;
  try {
    existing = JSON.parse(readFileSync(markerPath, "utf8"));
  } catch {
    throw recoveryError("A staged account marker is unreadable.");
  }
  if (
    existing?.schema !== 2 ||
    existing.account_id !== account.account_id ||
    existing.issuer !== account.issuer ||
    existing.subject !== account.subject ||
    existing.incarnation !== previous.incarnation ||
    Number(existing.provisioning_generation) !==
      previous.provisioning_generation
  )
    throw recoveryError(
      "A staged account marker does not match its provisioning incarnation.",
    );
  const tmp = resolve(
    dirname(markerPath),
    `${MARKER}.${randomBytes(6).toString("hex")}.tmp`,
  );
  rmSync(tmp, { force: true });
  writeFileSync(
    tmp,
    JSON.stringify({
      schema: 2,
      account_id: account.account_id,
      issuer: account.issuer,
      subject: account.subject,
      incarnation: next.incarnation,
      provisioning_generation: next.provisioning_generation,
    }),
    { mode: 0o600 },
  );
  renameSync(tmp, markerPath);
}

/** A snapshot without any control generation is left uninitialized (the
 * operator runs the explicit init command later). A previous-format bundle with a
 * known generation but no marker derives a fresh nonce/epoch here; an approval is
 * never copied. Returns true when a marker was written.
 */
function rotateStagedEpoch(
  control: ControlStore,
  stagingRoot: string,
  clock: () => Date,
): boolean {
  const has = control.db
    .prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='managed_control_epoch'",
    )
    .get();
  if (!has) return false;
  const row = control.db
    .prepare("SELECT epoch FROM managed_control_epoch WHERE singleton=1")
    .get() as { epoch: number } | undefined;
  if (!row) return false;
  const next = Number(row.epoch) + 1;
  if (!Number.isSafeInteger(next) || next < 1)
    throw recoveryError("The control generation cannot be advanced safely.");
  const nonce = randomBytes(32).toString("hex");
  const rotated_at = clock().toISOString();
  control.db.exec("BEGIN IMMEDIATE");
  try {
    control.db
      .prepare(
        "UPDATE managed_control_epoch SET epoch=?,nonce=?,rotated_at=? WHERE singleton=1",
      )
      .run(next, nonce, rotated_at);
    control.db.exec("COMMIT");
  } catch (error) {
    control.db.exec("ROLLBACK");
    throw error;
  }
  writeRootMarker(stagingRoot, { schema: 1, epoch: next, nonce });
  return true;
}

function readManifest(bundle: string): ManagedBundleManifest {
  const path = join(bundle, "manifest.json");
  if (!existsSync(path))
    throw recoveryError("The bundle has no manifest.json.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw recoveryError("The bundle manifest is unreadable.");
  }
  const result = manifestSchema.safeParse(parsed);
  if (!result.success)
    throw recoveryError(
      "The bundle manifest has an unsupported schema, version or shape.",
    );
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
    if (
      isAbsolute(file.path) ||
      segments.includes("..") ||
      file.path.includes("\u0000")
    )
      throw recoveryError("The bundle manifest lists an unsafe path.");
    const full = join(bundle, file.path);
    const stat = lstatRequired(
      full,
      "A file recorded in the manifest is missing.",
    );
    if (stat.isSymbolicLink())
      throw recoveryError("The bundle contains a link.");
    const size = readFileSync(full).length;
    if (
      stat.size !== file.size ||
      size !== file.size ||
      sha256File(full) !== file.sha256
    )
      throw recoveryError("A bundle file does not match its recorded hash.");
  }
  const recorded = new Set(manifest.files.map((f) => f.path));
  for (const rel of walkFiles(bundle)) {
    if (HASH_SKIP.has(rel)) continue;
    if (!recorded.has(rel))
      throw recoveryError(
        "The bundle contains files that are not in the manifest.",
      );
  }
}

function assertBundleTopLevel(
  bundle: string,
  manifest: ManagedBundleManifest,
): void {
  const allowed = new Set<string>([
    "manifest.json",
    "control.sqlite",
    MANAGED_ROOT_MARKER,
    "activation.json",
    "decision-activation.json",
    "paddle.sqlite",
    "dodo.sqlite",
  ]);
  for (const account of manifest.accounts) allowed.add(account.account_id);
  for (const name of readdirSync(bundle)) {
    if (!allowed.has(name))
      throw recoveryError(
        `The bundle contains an unexpected top-level entry: ${name}`,
      );
    const stat = lstatSync(join(bundle, name));
    if (stat.isSymbolicLink())
      throw recoveryError("The bundle contains a link.");
  }
}

function lstatOptional(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

/**
 * The activation SQL row and its mirrored file must agree exactly: both present
 * and equal, or both absent. A present file with no row (or the reverse), or a
 * mismatched row, is refused rather than silently dropping a trusted activation
 * claim. Read-only; never creates the table or the marker.
 */
function assertActivationConsistent(
  controlPath: string,
  root: string,
): { present: boolean } {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(controlPath, { readOnly: true });
  } catch {
    throw recoveryError("The managed control database is unreadable.");
  }
  let row;
  try {
    row = readActivationRow(db);
  } finally {
    db.close();
  }
  const path = activationMirrorPath(root);
  const stat = lstatOptional(path);
  if (stat && (stat.isSymbolicLink() || !stat.isFile()))
    throw recoveryError("The activation mirror is not a real file.");
  if (!!row !== !!stat)
    throw recoveryError(
      "The activation profile and its mirror disagree; refusing to back up or restore this root.",
    );
  if (row) {
    let mirror;
    try {
      mirror = readActivationMirror(root);
    } catch {
      throw recoveryError("The activation mirror is invalid.");
    }
    if (!mirror || canonical(mirror) !== canonical(row))
      throw recoveryError(
        "The activation mirror does not match its stored profile.",
      );
  }
  return { present: !!row };
}

/** Same agreement rule for the separate decision activation mirror. */
function assertDecisionConsistent(
  controlPath: string,
  root: string,
): { present: boolean } {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(controlPath, { readOnly: true });
  } catch {
    throw recoveryError("The managed control database is unreadable.");
  }
  let row;
  try {
    row = readDecisionActivationRow(db);
  } finally {
    db.close();
  }
  const path = decisionActivationMirrorPath(root);
  const stat = lstatOptional(path);
  if (stat && (stat.isSymbolicLink() || !stat.isFile()))
    throw recoveryError("The decision activation mirror is not a real file.");
  if (!!row !== !!stat)
    throw recoveryError(
      "The decision activation profile and its mirror disagree; refusing to back up or restore this root.",
    );
  if (row) {
    let mirror;
    try {
      mirror = readDecisionActivationMirror(root);
    } catch {
      throw recoveryError("The decision activation mirror is invalid.");
    }
    if (!mirror || canonical(mirror) !== canonical(row))
      throw recoveryError(
        "The decision activation mirror does not match its stored profile.",
      );
  }
  return { present: !!row };
}

function assertInventoryMatches(
  manifestAccounts: ManagedBundleAccount[],
  controlAccounts: ManagedBundleAccount[],
): void {
  const key = (a: ManagedBundleAccount) =>
    `${a.account_id}|${a.issuer}|${a.subject}|${a.state}`;
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

function assertTenantMarker(
  dir: string,
  account: ManagedBundleAccount,
  expected?: { incarnation: string; provisioning_generation: number },
): void {
  assertTenantDir(dir, dirname(dir), "A backed account");
  let marker: any;
  try {
    marker = JSON.parse(readFileSync(join(dir, MARKER), "utf8"));
  } catch {
    throw recoveryError("A backed account marker is unreadable.");
  }
  if (
    marker.account_id !== account.account_id ||
    marker.issuer !== account.issuer ||
    marker.subject !== account.subject
  )
    throw recoveryError("A backed account marker does not match the manifest.");
  // Both legitimate schema variants are accepted; an arbitrary forge is not. A
  // schema-1 marker is a pre-enrollment tenant and must have no central incarnation;
  // a schema-2 marker must carry a valid incarnation that matches its control row.
  if (marker.schema === 1) {
    if (expected)
      throw recoveryError(
        "A backed account marker omits its provisioning incarnation.",
      );
    return;
  }
  if (
    marker.schema !== 2 ||
    typeof marker.incarnation !== "string" ||
    !/^[0-9a-f]{64}$/.test(marker.incarnation) ||
    !Number.isSafeInteger(marker.provisioning_generation) ||
    marker.provisioning_generation < 1
  )
    throw recoveryError("A backed account marker has an unsupported schema.");
  if (
    !expected ||
    expected.incarnation !== marker.incarnation ||
    Number(expected.provisioning_generation) !== marker.provisioning_generation
  )
    throw recoveryError(
      "A backed account marker does not match its control incarnation.",
    );
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

  // Bind the root marker to the EXACT current control generation so a backup can
  // never capture a marker from a different (or half-initialized) root.
  const rootMarker = readRootMarker(root);
  const controlEpoch = readControlEpoch(join(root, "control.sqlite"));
  if (
    rootMarker &&
    (!controlEpoch || !rootEpochMatches(rootMarker, controlEpoch))
  )
    throw recoveryError(
      "The managed root marker does not match its control generation; refusing to back it up.",
    );
  if (!rootMarker && controlEpoch)
    throw recoveryError(
      "The managed root has a control generation without a root marker; refusing to back it up.",
    );

  const staging = newStaging(destination, clock);
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  try {
    await snapshotSqlite(
      join(root, "control.sqlite"),
      join(staging, "control.sqlite"),
    );
    const paddleStorePresent = existsSync(join(root, "paddle.sqlite"));
    const dodoStorePresent = existsSync(join(root, "dodo.sqlite"));
    if (dodoStorePresent)
      await snapshotSqlite(
        join(root, "dodo.sqlite"),
        join(staging, "dodo.sqlite"),
      );
    if (paddleStorePresent)
      await snapshotSqlite(
        join(root, "paddle.sqlite"),
        join(staging, "paddle.sqlite"),
      );
    if (rootMarker)
      copyTree(
        join(root, MANAGED_ROOT_MARKER),
        join(staging, MANAGED_ROOT_MARKER),
      );
    const activation = assertActivationConsistent(
      join(staging, "control.sqlite"),
      root,
    );
    if (activation.present)
      copyTree(activationMirrorPath(root), join(staging, "activation.json"));
    const decision = assertDecisionConsistent(
      join(staging, "control.sqlite"),
      root,
    );
    if (decision.present)
      copyTree(
        decisionActivationMirrorPath(root),
        join(staging, "decision-activation.json"),
      );
    const rootIncarnations = readIncarnations(join(root, "control.sqlite"));
    for (const account of inventory) {
      const dir = join(root, account.account_id);
      assertTenantMarker(
        dir,
        account,
        rootIncarnations.get(account.account_id),
      );
      const staged = join(staging, account.account_id);
      mkdirSync(staged, { recursive: true, mode: 0o700 });
      copyTree(join(dir, MARKER), join(staged, MARKER));
      await snapshotSqlite(
        join(dir, "brain.sqlite"),
        join(staged, "brain.sqlite"),
      );
      copyTree(join(dir, "vault"), join(staged, "vault"));
      copyTree(join(dir, "vault-protected"), join(staged, "vault-protected"));
    }
    assertSqliteHealthy(join(staging, "control.sqlite"));
    if (dodoStorePresent) assertSqliteHealthy(join(staging, "dodo.sqlite"));
    if (paddleStorePresent) assertSqliteHealthy(join(staging, "paddle.sqlite"));
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
      root_marker: rootMarker ? MANAGED_ROOT_MARKER : null,
      paddle_store: paddleStorePresent ? "paddle.sqlite" : null,
      dodo_store: dodoStorePresent ? "dodo.sqlite" : null,
      billing_authority: (() => {
        const keyPath = join(root, ".protected", "billing-authority.key");
        if (!existsSync(keyPath)) return null;
        const key = loadBillingKey(root);
        return {
          key_path: ".protected/billing-authority.key" as const,
          key_commitment: key.commitment,
          key_size: 32 as const,
          included: false as const,
          restore_requires_offline_key_and_reenrollment: true as const,
        };
      })(),
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
  // A bundled activation profile and its mirror must agree; a split claim is
  // refused rather than silently dropped or half-reactivated.
  const bundleActivation = assertActivationConsistent(bundleControl, bundle);
  const bundleDecision = assertDecisionConsistent(bundleControl, bundle);
  const bundledPaddlePath = join(bundle, "paddle.sqlite");
  const bundledPaddlePresent = existsSync(bundledPaddlePath);
  if (bundledPaddlePresent !== (manifest.paddle_store === "paddle.sqlite"))
    throw recoveryError(
      "The Paddle store presence does not match its manifest declaration.",
    );
  if (bundledPaddlePresent) assertSqliteHealthy(bundledPaddlePath);
  const bundledDodoPath = join(bundle, "dodo.sqlite");
  const bundledDodoPresent = existsSync(bundledDodoPath);
  if (bundledDodoPresent !== (manifest.dodo_store === "dodo.sqlite"))
    throw recoveryError(
      "The Dodo store does not match its manifest declaration.",
    );
  if (bundledDodoPresent) assertSqliteHealthy(bundledDodoPath);

  // The portable bundle never carries the authority key. If it declares a key,
  // prove the current operator still possesses that exact protected key before
  // staging the financial history. The destination remains paid-blocked until the
  // separately encrypted key is restored and a fresh offline enrollment is made.
  if (manifest.billing_authority) {
    const currentKey = loadBillingKey(currentRoot);
    if (currentKey.commitment !== manifest.billing_authority.key_commitment)
      throw recoveryError(
        "The current billing authority key does not match the backed financial history.",
      );
  }

  // A marker in the bundle must bind the bundled control generation exactly. The
  // presence of the marker file must EQUAL the manifest declaration: a bundle can
  // never hide a present (hashed) marker by declaring it absent, or claim a marker
  // it does not carry. An old previous-format bundle without either is still
  // supported (blocked for paid activation); a declared marker whose generation is
  // absent or different is rejected before anything is published.
  const bundledEpoch = readControlEpoch(bundleControl);
  const bundledMarkerPath = join(bundle, MANAGED_ROOT_MARKER);
  const bundledMarkerStat = (() => {
    try {
      return lstatSync(bundledMarkerPath);
    } catch {
      return undefined;
    }
  })();
  const markerFilePresent = !!bundledMarkerStat;
  if (
    bundledMarkerStat &&
    (bundledMarkerStat.isSymbolicLink() || !bundledMarkerStat.isFile())
  )
    throw recoveryError("The bundle marker is not a regular file.");
  const declaredMarker = manifest.root_marker != null;
  if (markerFilePresent !== declaredMarker)
    throw recoveryError(
      "The bundle marker presence does not match its manifest declaration.",
    );
  if (declaredMarker && manifest.root_marker !== MANAGED_ROOT_MARKER)
    throw recoveryError(
      "The bundle marker name is not the supported root marker.",
    );
  if (markerFilePresent) {
    let rawMarker: unknown;
    try {
      rawMarker = JSON.parse(readFileSync(bundledMarkerPath, "utf8"));
    } catch {
      throw recoveryError("The bundle marker is unreadable.");
    }
    const parsedMarker = rootMarkerSchema.safeParse(rawMarker);
    if (
      !parsedMarker.success ||
      !bundledEpoch ||
      !rootEpochMatches(parsedMarker.data, bundledEpoch)
    )
      throw recoveryError(
        "The bundle marker does not match its control generation.",
      );
  }

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
    if (
      current.issuer !== account.issuer ||
      current.subject !== account.subject
    )
      throw recoveryError(
        "A backed account identity does not match the current root.",
      );
    assertTenantDir(
      join(currentRoot, account.account_id),
      currentRoot,
      "The current tenant",
    );
    assertSqliteHealthy(join(currentRoot, account.account_id, "brain.sqlite"));
  }

  const bundleIncarnations = readIncarnations(bundleControl);

  const staged = newStaging(destination, clock);
  mkdirSync(staged, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(staged, MANAGED_RESTORE_INCOMPLETE),
    clock().toISOString(),
    {
      mode: 0o600,
    },
  );
  let replayed = 0;
  try {
    copyTree(bundleControl, join(staged, "control.sqlite"));
    if (bundledDodoPresent)
      copyTree(bundledDodoPath, join(staged, "dodo.sqlite"));
    if (bundledPaddlePresent)
      copyTree(bundledPaddlePath, join(staged, "paddle.sqlite"));
    if (bundleActivation.present)
      copyTree(
        join(bundle, "activation.json"),
        join(staged, "activation.json"),
      );
    if (bundleDecision.present)
      copyTree(
        join(bundle, "decision-activation.json"),
        join(staged, "decision-activation.json"),
      );
    for (const account of manifest.accounts) {
      const from = join(bundle, account.account_id);
      assertTenantMarker(
        from,
        account,
        bundleIncarnations.get(account.account_id),
      );
      const to = join(staged, account.account_id);
      mkdirSync(to, { recursive: true, mode: 0o700 });
      copyTree(join(from, MARKER), join(to, MARKER));
      copyTree(join(from, "brain.sqlite"), join(to, "brain.sqlite"));
      copyTree(join(from, "vault"), join(to, "vault"));
      copyTree(join(from, "vault-protected"), join(to, "vault-protected"));
    }

    // Control barrier FIRST, then each tenant barrier, both before any replay. The
    // staging `MANAGED_RESTORE_INCOMPLETE` marker protects the whole bundle until
    // publish. Every supported v5 account is fenced and advanced BEFORE its staged
    // tenant is opened, and the fence stays active until the root is published.
    const stagingControl = new ControlStore(
      join(staged, "control.sqlite"),
      clock,
    );
    const fenced: string[] = [];
    let stagedIncarnations = new Map<
      string,
      { incarnation: string; provisioning_generation: number }
    >();
    try {
      applyControlRestoreBarrier(stagingControl, clock);
      for (const providerFile of [
        bundledPaddlePresent ? "paddle.sqlite" : null,
        bundledDodoPresent ? "dodo.sqlite" : null,
      ]) {
        if (!providerFile) continue;
        const paddle = new DatabaseSync(join(staged, providerFile));
        try {
          const restoredAt = clock().toISOString();
          paddle.exec("BEGIN IMMEDIATE");
          try {
            paddle
              .prepare(
                "UPDATE paddle_checkout_intents SET state='expired',version=version+1,updated_at=? WHERE state IN ('pending','created')",
              )
              .run(restoredAt);
            paddle
              .prepare(
                "UPDATE paddle_events SET state='pending',lease_owner=NULL,lease_expires_at=NULL WHERE state='processing'",
              )
              .run();
            paddle
              .prepare(
                "UPDATE paddle_bindings SET status='restore_blocked',adverse_generation=adverse_generation+1,version=version+1,updated_at=?",
              )
              .run(restoredAt);
            paddle.exec("COMMIT");
          } catch (error) {
            if (paddle.isTransaction) paddle.exec("ROLLBACK");
            throw error;
          }
        } finally {
          paddle.close();
        }
      }
      for (const account of manifest.accounts) {
        const current = currentById.get(account.account_id)!;
        if (account.state === "suspended" || current.state === "suspended")
          stagingControl.setAccountState(account.account_id, "suspended");
      }
      // A supported restore rotates the control generation and rewrites the root
      // marker at staging BEFORE publish, invalidating prior audits while keeping
      // every financial block. A snapshot with no generation is left for the
      // operator's explicit init; an old bundle without a marker derives a fresh
      // generation from its known control row and never copies an approval.
      const rotated = rotateStagedEpoch(stagingControl, staged, clock);
      if (rotated) {
        const epochRow = stagingControl.db
          .prepare(
            "SELECT epoch,nonce FROM managed_control_epoch WHERE singleton=1",
          )
          .get() as { epoch: number; nonce: string } | undefined;
        if (epochRow)
          new ManagedActivationStore(
            stagingControl,
            staged,
            clock,
          ).disableForRestore({
            epoch: Number(epochRow.epoch),
            nonce: String(epochRow.nonce),
          });
        if (epochRow)
          new ManagedDecisionActivationStore(
            stagingControl,
            staged,
            clock,
          ).disableForRestore({
            epoch: Number(epochRow.epoch),
            nonce: String(epochRow.nonce),
          });
      }
      // Worker readiness is ephemeral and is never copied into a restore.
      rmSync(join(staged, "worker-ready.json"), { force: true });
      rmSync(join(staged, "decision-worker-ready.json"), { force: true });

      // Fence + advance each supported v5 account in ONE control transaction BEFORE
      // any staged tenant storage mutation, so a partial restore stays fenced. A
      // missing row is a pre-enrollment schema-1 tenant, left for offline enrollment.
      stagedIncarnations = readIncarnations(join(staged, "control.sqlite"));
      for (const account of manifest.accounts) {
        if (!stagedIncarnations.has(account.account_id)) continue;
        stagingControl.db.exec("BEGIN IMMEDIATE");
        try {
          fenceAccount(
            stagingControl.db,
            account.account_id,
            "restore",
            clock().toISOString(),
          );
          stagingControl.db.exec("COMMIT");
        } catch (error) {
          stagingControl.db.exec("ROLLBACK");
          throw error;
        }
        fenced.push(account.account_id);
      }

      for (const account of manifest.accounts) {
        const store = new Storage(
          join(staged, account.account_id, "brain.sqlite"),
          {
            vault: join(staged, account.account_id, "vault"),
          },
        );
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
        // Rewrite the staged marker to the exact schema-2 incarnation rotated above.
        // The fence is NOT cleared here: it stays active until the root is published.
        if (fenced.includes(account.account_id)) {
          const previous = stagedIncarnations.get(account.account_id)!;
          const next = readAccountIncarnation(
            stagingControl.db,
            account.account_id,
          );
          if (!next)
            throw recoveryError(
              "A staged account lost its provisioning incarnation.",
            );
          replaceStagedMarker(
            join(staged, account.account_id, MARKER),
            account,
            previous,
            next,
          );
        }
      }

      // The published root marker must already match the staged control generation.
      const stagedEpoch = readControlEpoch(join(staged, "control.sqlite"));
      const stagedMarker = readRootMarker(staged);
      if (
        stagedEpoch &&
        (!stagedMarker || !rootEpochMatches(stagedMarker, stagedEpoch))
      )
        throw recoveryError(
          "The staged root marker does not match its control generation.",
        );
    } finally {
      stagingControl.close();
    }

    // Publish the whole bundle, then clear the account fences ONLY after the root is
    // actually in place. A failure to clear leaves the accounts fenced (fail closed).
    renameSync(staged, destination);
    if (fenced.length) {
      const published = new ControlStore(
        join(destination, "control.sqlite"),
        clock,
      );
      try {
        for (const accountId of fenced)
          clearFence(published.db, accountId, clock().toISOString());
      } finally {
        published.close();
      }
    }
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
    throw recoveryError(
      "The current tenant database is missing or unreadable.",
    );
  }
  let tombstones: { id: string; state: string }[] = [];
  try {
    tombstones = current
      .prepare(
        "SELECT id,state FROM sources WHERE state IN ('deleted','withdrawn')",
      )
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
      brain.removeSource(
        { kind: "owner" },
        tomb.id,
        retained.version,
        tomb.state === "deleted",
      );
    }
    applied += 1;
  }
  return applied;
}
