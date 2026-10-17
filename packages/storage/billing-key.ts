import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  writeSync,
  type Stats,
} from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { BrainError } from "../domain/logic.ts";
import { assertNonLinkedPathChain } from "../runtime/managed-operator.ts";

/**
 * Protected billing-authority key file.
 *
 * This module is a small, deep, self-contained helper: it derives, loads and
 * explicitly enrolls one 32-byte binary key under `<root>/.protected`. It opens no
 * control DB, creates no schema, holds no policy and has no production consumer yet.
 *
 * The key is never text/hex, never generated here (the caller supplies the bytes),
 * never placed in the DB, vault, logs, URL or environment, and is never repaired,
 * re-signed, rotated or deleted. Reading never creates the root or `.protected`.
 *
 * Honest limits: this does not claim cryptographic safety against a hostile process
 * that already controls the trusted filesystem root, and Windows `chmod` is **not**
 * ACL verification — POSIX modes are enforced, a separately verified deployment ACL
 * remains a live gate. The offline acknowledgements assert quiescence; they do not
 * prove that every other worker is stopped.
 */

const PROTECTED_DIR = ".protected";
const KEY_NAME = "billing-authority.key";
const KEY_BYTES = 32;
const NOFOLLOW = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;

export interface BillingKey {
  bytes: Uint8Array;
  commitment: string;
}

export interface BillingKeyEnrollment {
  offline: true;
  workers_terminated: true;
  expected_commitment: string;
}

const invalid = (message = "Invalid billing key request.") =>
  new BrainError("INVALID_INPUT", message, 400);
const unauthorized = (message = "The billing key path is not trusted.") =>
  new BrainError("UNAUTHORIZED", message, 401);
const unavailable = (message = "The billing key is unavailable.") =>
  new BrainError("UNAVAILABLE", message, 503);
const conflict = (message = "A different billing key is already enrolled.") =>
  new BrainError("CONFLICT", message, 409);

function lstatOptional(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

function assertAbsoluteRoot(root: unknown): string {
  if (typeof root !== "string" || root.length === 0 || !isAbsolute(root))
    throw invalid("The billing key root must be one absolute path.");
  return root;
}

function assertKeyBytes(bytes: unknown): asserts bytes is Uint8Array {
  if (!(bytes instanceof Uint8Array) || bytes.length !== KEY_BYTES)
    throw invalid("The billing key must be exactly 32 raw bytes.");
}

/** POSIX only: Windows file modes are not ACL verification. */
function assertPrivateMode(stat: Stats, expected: number): void {
  if (process.platform === "win32") return;
  if ((stat.mode & 0o7777) !== expected)
    throw unauthorized("The billing key path has unsafe permissions.");
}

function commitmentOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** Explicit, non-probing path derivation. Absolute root required; nothing is created. */
export function billingKeyPath(root: string): string {
  return join(assertAbsoluteRoot(root), PROTECTED_DIR, KEY_NAME);
}

/** SHA-256 of the raw 32 bytes (never of a hex/JSON text encoding). */
export function billingKeyCommitment(bytes: Uint8Array): string {
  assertKeyBytes(bytes);
  return commitmentOf(bytes);
}

/**
 * Bounded, link-safe read of one exact 32-byte regular key file. Validates the
 * directory chain, private modes, single link and size, then reads with a final
 * identity check so a stale swap is detected. Never creates, repairs or follows a
 * link (O_NOFOLLOW where the platform supports it).
 */
function readKeyBytes(root: string): Uint8Array {
  const path = billingKeyPath(root);
  const dir = join(root, PROTECTED_DIR);
  assertNonLinkedPathChain(dir);
  const dirStat = lstatOptional(dir);
  if (!dirStat || dirStat.isSymbolicLink() || !dirStat.isDirectory())
    throw unauthorized("The billing key directory is not usable.");
  assertPrivateMode(dirStat, 0o700);
  const pre = lstatOptional(path);
  if (!pre || pre.isSymbolicLink() || !pre.isFile())
    throw unauthorized("The billing key must be a real file.");
  if (pre.nlink !== 1) throw unauthorized("The billing key must have a single link.");
  if (pre.size !== KEY_BYTES) throw invalid("The billing key must be exactly 32 bytes.");
  assertPrivateMode(pre, 0o600);

  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.size !== KEY_BYTES)
      throw unauthorized("The billing key changed during the read.");
    if (
      opened.ino !== pre.ino ||
      opened.dev !== pre.dev ||
      opened.size !== pre.size
    )
      throw unauthorized("The billing key changed during the read.");
    assertPrivateMode(opened, 0o600);
    const buffer = Buffer.alloc(KEY_BYTES + 1);
    const read = readSync(fd, buffer, 0, KEY_BYTES + 1, 0);
    if (read !== KEY_BYTES) throw unavailable("The billing key is unreadable.");
    const post = fstatSync(fd);
    const after = lstatOptional(path);
    if (
      !after ||
      after.isSymbolicLink() ||
      !after.isFile() ||
      after.nlink !== 1 ||
      after.ino !== opened.ino ||
      after.dev !== opened.dev ||
      after.size !== opened.size ||
      post.ino !== opened.ino ||
      post.dev !== opened.dev ||
      post.size !== opened.size
    )
      throw unauthorized("The billing key changed during the read.");
    assertPrivateMode(after, 0o600);
    return Uint8Array.from(buffer.subarray(0, KEY_BYTES));
  } catch (error) {
    if (error instanceof BrainError) throw error;
    throw unavailable("The billing key is unreadable.");
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* the descriptor was already released */
      }
    }
  }
}

/** Read-only. Requires an existing real absolute root; never creates or repairs. */
export function loadBillingKey(root: string): BillingKey {
  const absolute = assertAbsoluteRoot(root);
  const rootStat = lstatOptional(absolute);
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory())
    throw unauthorized("The billing key root is not usable.");
  const bytes = readKeyBytes(absolute);
  return { bytes, commitment: commitmentOf(bytes) };
}

function validateEnrollment(options: unknown, bytes: Uint8Array): void {
  if (typeof options !== "object" || options === null || Array.isArray(options))
    throw invalid("The billing key enrollment options are required.");
  const allowed = new Set(["offline", "workers_terminated", "expected_commitment"]);
  const own = Reflect.ownKeys(options);
  if (own.length !== allowed.size) throw invalid("The billing key enrollment options are not closed.");
  for (const key of own) {
    if (typeof key !== "string" || !allowed.has(key))
      throw invalid("The billing key enrollment options are not closed.");
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (!descriptor || !("value" in descriptor))
      throw invalid("The billing key enrollment options must be plain data.");
  }
  const record = options as Record<string, unknown>;
  if (record.offline !== true || record.workers_terminated !== true)
    throw invalid("The billing key enrollment requires explicit offline acknowledgements.");
  const expected = record.expected_commitment;
  if (typeof expected !== "string" || !/^[0-9a-f]{64}$/.test(expected))
    throw invalid("The billing key enrollment commitment is invalid.");
  if (expected !== commitmentOf(bytes))
    throw invalid("The billing key enrollment commitment does not match the supplied bytes.");
}

/**
 * Explicit offline enrollment. Validates the closed acknowledgements, byte length
 * and commitment BEFORE any filesystem mutation, then creates `.protected` (0700
 * POSIX) only if absent and the key exclusively (`wx`, 0600 POSIX). An identical
 * existing key is an idempotent no-op; anything different is refused without
 * overwrite, repair or deletion. A concurrent loser may accept the winner only when
 * the complete validated bytes match exactly.
 */
export function enrollBillingKeyOffline(
  root: string,
  bytes: Uint8Array,
  options: BillingKeyEnrollment,
): { commitment: string } {
  assertKeyBytes(bytes);
  // Own the caller's bytes for the whole operation (no re-read across the
  // validation and filesystem steps).
  const keyBytes = Uint8Array.from(bytes);
  validateEnrollment(options, keyBytes);
  const commitment = commitmentOf(keyBytes);
  const absolute = assertAbsoluteRoot(root);
  const rootStat = lstatOptional(absolute);
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory())
    throw unauthorized("The billing key root is not usable.");

  const dir = join(absolute, PROTECTED_DIR);
  assertNonLinkedPathChain(dir);
  let dirStat = lstatOptional(dir);
  if (dirStat && (dirStat.isSymbolicLink() || !dirStat.isDirectory()))
    throw unauthorized("The billing key directory is not usable.");
  let createdDirectory = false;
  if (!dirStat) {
    try {
      mkdirSync(dir, { mode: 0o700 });
      createdDirectory = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST")
        throw unavailable("The billing key directory could not be created.");
    }
    if (createdDirectory) {
      try {
        chmodSync(dir, 0o700);
      } catch {
        /* best-effort: a stricter inherited mode is acceptable */
      }
    }
    dirStat = lstatOptional(dir);
    if (!dirStat || dirStat.isSymbolicLink() || !dirStat.isDirectory())
      throw unauthorized("The billing key directory is not usable.");
  }
  assertPrivateMode(dirStat, 0o700);

  const path = billingKeyPath(absolute);
  if (lstatOptional(path)) {
    const current = readKeyBytes(absolute);
    if (!bytesEqual(current, keyBytes)) throw conflict();
    return { commitment };
  }
  // A missing key inside a protected directory this invocation did NOT create is a
  // lost key (or a concurrent partial winner), never permission to mint a new one.
  if (!createdDirectory)
    throw unavailable("The billing key is missing from an existing protected directory.");

  let fd: number | undefined;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
      0o600,
    );
    const written = writeSync(fd, keyBytes, 0, KEY_BYTES, 0);
    if (written !== KEY_BYTES) throw unavailable("The billing key could not be written.");
  } catch (error) {
    if (error instanceof BrainError) throw error;
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const winner = readKeyBytes(absolute);
      if (!bytesEqual(winner, keyBytes)) throw conflict();
      return { commitment };
    }
    throw unavailable("The billing key could not be written.");
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* the descriptor was already released */
      }
    }
  }

  const readBack = readKeyBytes(absolute);
  if (!bytesEqual(readBack, keyBytes))
    throw conflict("The billing key could not be verified after writing.");
  return { commitment };
}
