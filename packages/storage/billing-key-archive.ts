import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  writeFileSync,
} from "node:fs";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { BrainError, canonical } from "../domain/logic.ts";
import { assertNonLinkedPathChain } from "../runtime/managed-operator.ts";
import {
  billingKeyCommitment,
  enrollBillingKeyOffline,
  loadBillingKey,
} from "./billing-key.ts";

/**
 * Offline encrypted export for the billing authority key.
 *
 * The archive is a closed AES-256-GCM envelope. The passphrase comes from an
 * explicit regular file, never argv, an environment variable, logs, or the
 * archive. Restoring still uses the exclusive billing-key enrollment path and
 * therefore cannot overwrite or rotate an existing key.
 */

const archiveSchema = z
  .object({
    schema: z.literal(1),
    kdf: z.literal("scrypt-n16384-r8-p1"),
    cipher: z.literal("aes-256-gcm"),
    salt: z.string().regex(/^[0-9a-f]{32}$/),
    iv: z.string().regex(/^[0-9a-f]{24}$/),
    ciphertext: z.string().regex(/^[0-9a-f]{64}$/),
    tag: z.string().regex(/^[0-9a-f]{32}$/),
    key_commitment: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export type BillingKeyArchive = z.infer<typeof archiveSchema>;

const invalid = (message: string) =>
  new BrainError("INVALID_INPUT", message, 400);
const unavailable = (message: string) =>
  new BrainError("UNAVAILABLE", message, 503);

function readSecretFile(path: string): Buffer {
  if (!isAbsolute(path))
    throw invalid("The passphrase file must be an absolute path.");
  const absolute = resolve(path);
  assertNonLinkedPathChain(dirname(absolute));
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1)
    throw invalid("The passphrase must be a regular single-link file.");
  if (stat.size < 16 || stat.size > 4096)
    throw invalid(
      "The passphrase file must contain between 16 and 4096 bytes.",
    );
  if (process.platform !== "win32" && (stat.mode & 0o7777) !== 0o600)
    throw invalid("The passphrase file must have mode 0600.");
  let fd: number | undefined;
  try {
    fd = openSync(absolute, constants.O_RDONLY);
    const opened = fstatSync(fd);
    if (
      opened.ino !== stat.ino ||
      opened.dev !== stat.dev ||
      opened.size !== stat.size
    )
      throw invalid("The passphrase file changed during the read.");
    const bytes = Buffer.alloc(stat.size);
    if (readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length)
      throw unavailable("The passphrase file could not be read completely.");
    return bytes;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function readArchiveFile(path: string): string {
  const absolute = resolve(path);
  assertNonLinkedPathChain(dirname(absolute));
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1)
    throw invalid("The billing key archive must be a regular single-link file.");
  if (stat.size < 1 || stat.size > 4096)
    throw invalid("The billing key archive must be a bounded regular file.");
  let fd: number | undefined;
  let bytes: Buffer | undefined;
  try {
    fd = openSync(absolute, constants.O_RDONLY);
    const opened = fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.ino !== stat.ino ||
      opened.dev !== stat.dev ||
      opened.size !== stat.size
    )
      throw invalid("The billing key archive changed during the read.");
    bytes = Buffer.alloc(stat.size);
    if (readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length)
      throw unavailable("The billing key archive could not be read completely.");
    return bytes.toString("utf8");
  } finally {
    bytes?.fill(0);
    if (fd !== undefined) closeSync(fd);
  }
}

function derive(passphrase: Buffer, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 });
}

function archiveAad(commitment: string): Buffer {
  return Buffer.from(`bibrain-billing-key-archive/v1\n${commitment}`, "utf8");
}

export function writeBillingKeyArchive(input: {
  root: string;
  destination: string;
  passphrase_file: string;
  offline: true;
  workers_terminated: true;
}): { destination: string; key_commitment: string } {
  if (input.offline !== true || input.workers_terminated !== true)
    throw invalid(
      "Billing key backup requires offline and workers-terminated acknowledgements.",
    );
  if (!isAbsolute(input.destination))
    throw invalid("The key archive destination must be absolute.");
  const destination = resolve(input.destination);
  assertNonLinkedPathChain(dirname(destination));
  try {
    lstatSync(destination);
    throw invalid("The key archive destination already exists.");
  } catch (error) {
    if (error instanceof BrainError) throw error;
  }
  const billingKey = loadBillingKey(input.root);
  let passphrase: Buffer | undefined;
  let derived: Buffer | undefined;
  try {
    passphrase = readSecretFile(input.passphrase_file);
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    derived = derive(passphrase, salt);
    const cipher = createCipheriv("aes-256-gcm", derived, iv);
    cipher.setAAD(archiveAad(billingKey.commitment));
    const encrypted = Buffer.concat([
      cipher.update(Buffer.from(billingKey.bytes)),
      cipher.final(),
    ]);
    const archive: BillingKeyArchive = {
      schema: 1,
      kdf: "scrypt-n16384-r8-p1",
      cipher: "aes-256-gcm",
      salt: salt.toString("hex"),
      iv: iv.toString("hex"),
      ciphertext: encrypted.toString("hex"),
      tag: cipher.getAuthTag().toString("hex"),
      key_commitment: billingKey.commitment,
    };
    writeFileSync(destination, canonical(archive), { flag: "wx", mode: 0o600 });
    return { destination, key_commitment: billingKey.commitment };
  } finally {
    billingKey.bytes.fill(0);
    passphrase?.fill(0);
    derived?.fill(0);
  }
}

export function restoreBillingKeyArchive(input: {
  root: string;
  archive: string;
  passphrase_file: string;
  expected_commitment: string;
  offline: true;
  workers_terminated: true;
}): { key_commitment: string } {
  if (input.offline !== true || input.workers_terminated !== true)
    throw invalid(
      "Billing key restore requires offline and workers-terminated acknowledgements.",
    );
  if (!isAbsolute(input.archive))
    throw invalid("The key archive path must be absolute.");
  const text = readArchiveFile(input.archive);
  let parsed: BillingKeyArchive;
  try {
    parsed = archiveSchema.parse(JSON.parse(text));
  } catch {
    throw invalid("The billing key archive is invalid.");
  }
  if (parsed.key_commitment !== input.expected_commitment)
    throw invalid(
      "The billing key archive commitment does not match the operator expectation.",
    );
  const passphrase = readSecretFile(input.passphrase_file);
  let derived: Buffer | undefined;
  let clear: Buffer | undefined;
  try {
    derived = derive(passphrase, Buffer.from(parsed.salt, "hex"));
    const decipher = createDecipheriv(
      "aes-256-gcm",
      derived,
      Buffer.from(parsed.iv, "hex"),
    );
    decipher.setAAD(archiveAad(parsed.key_commitment));
    decipher.setAuthTag(Buffer.from(parsed.tag, "hex"));
    clear = Buffer.concat([
      decipher.update(Buffer.from(parsed.ciphertext, "hex")),
      decipher.final(),
    ]);
    if (
      clear.length !== 32 ||
      billingKeyCommitment(clear) !== parsed.key_commitment
    )
      throw invalid("The restored billing key does not match its commitment.");
    return {
      key_commitment: enrollBillingKeyOffline(input.root, clear, {
        offline: true,
        workers_terminated: true,
        expected_commitment: parsed.key_commitment,
      }).commitment,
    };
  } catch (error) {
    if (error instanceof BrainError) throw error;
    throw invalid("The billing key archive could not be authenticated.");
  } finally {
    passphrase.fill(0);
    derived?.fill(0);
    clear?.fill(0);
  }
}
