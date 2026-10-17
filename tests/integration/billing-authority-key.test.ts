import { afterEach, describe, expect, it } from "vitest";
import type { TestContext } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BrainError } from "../../packages/domain/logic.ts";
import {
  billingKeyCommitment,
  billingKeyPath,
  enrollBillingKeyOffline,
  loadBillingKey,
} from "../../packages/storage/billing-key.ts";

/**
 * T2K protected key-file helper — SYNTHETIC fixtures only. No real key, provider,
 * network or DB. The module does not exist yet, so this first run is RED.
 *
 * All byte arrays here are disposable synthetic values; every root is a fresh
 * temporary directory cleaned up in `finally`-style teardown.
 */

const SYNTHETIC_A = Uint8Array.from({ length: 32 }, (_v, i) => (i % 2 === 0 ? 0 : 0xff)); // raw binary with NUL and 0xFF bytes
const SYNTHETIC_B = Uint8Array.from({ length: 32 }, () => 0xff);
const SYNTHETIC_ZERO = new Uint8Array(32);

const WINDOWS_BASE = "C:/Users/Gowrishankar/AppData/Local/Temp/opencode";
const cleanupDirs: string[] = [];
const cleanupLinks: string[] = [];

function fixtureBase(): string {
  if (process.platform !== "win32") return tmpdir();
  if (!existsSync(WINDOWS_BASE)) throw new Error("The approved Windows fixture base is missing.");
  return WINDOWS_BASE;
}

function newRoot(): string {
  const dir = mkdtempSync(join(fixtureBase(), "billing-key-"));
  cleanupDirs.push(dir);
  return dir;
}

function commitmentOf(bytes: Uint8Array): string {
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

function keyFileOf(root: string): string {
  return join(root, ".protected", "billing-authority.key");
}

function writeKeyFile(root: string, bytes: Uint8Array, mode = 0o600): string {
  const dir = join(root, ".protected");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = keyFileOf(root);
  writeFileSync(file, bytes, { mode });
  return file;
}

function enrollOptions(bytes: Uint8Array) {
  return {
    offline: true as const,
    workers_terminated: true as const,
    expected_commitment: commitmentOf(bytes),
  };
}

/** Creates a junction/file link, or skips ONLY on the known Windows privilege error. */
function tryLink(ctx: TestContext, target: string, path: string, type: "file" | "junction"): void {
  try {
    symlinkSync(target, path, type);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform === "win32" && (code === "EPERM" || code === "EACCES")) {
      ctx.skip("Windows link privilege is unavailable on this host.");
      return;
    }
    throw error;
  }
}

const posixOnly = process.platform === "win32" ? it.skip : it;

afterEach(() => {
  for (const link of cleanupLinks.splice(0))
    rmSync(link, { force: true, recursive: false, maxRetries: 8, retryDelay: 50 });
  for (const dir of cleanupDirs.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
});

describe("billingKeyPath", () => {
  it("derives the fixed path from an absolute root without probing or creating it", () => {
    const root = join(fixtureBase(), `billing-key-absent-${randomUUID()}`);
    expect(existsSync(root)).toBe(false);
    expect(billingKeyPath(root)).toBe(keyFileOf(root));
    expect(existsSync(root)).toBe(false);
    expect(existsSync(join(root, ".protected"))).toBe(false);
  });
});

describe("billingKeyCommitment", () => {
  it("hashes the raw 32 bytes, not a hex encoding", () => {
    expect(billingKeyCommitment(SYNTHETIC_A)).toBe(commitmentOf(SYNTHETIC_A));
    expect(billingKeyCommitment(SYNTHETIC_ZERO)).toBe(commitmentOf(SYNTHETIC_ZERO));
    expect(billingKeyCommitment(SYNTHETIC_B)).toBe(commitmentOf(SYNTHETIC_B));
    const hexText = createHash("sha256")
      .update(Buffer.from(SYNTHETIC_A).toString("hex"), "utf8")
      .digest("hex");
    expect(billingKeyCommitment(SYNTHETIC_A)).not.toBe(hexText);
  });

  it("rejects a non-32-byte or non-Uint8Array commitment input", () => {
    expect(() => billingKeyCommitment(new Uint8Array(31))).toThrow(BrainError);
    expect(() => billingKeyCommitment(new Uint8Array(33))).toThrow(BrainError);
    expect(() => billingKeyCommitment("a".repeat(32) as unknown as Uint8Array)).toThrow(BrainError);
    expect(() => billingKeyCommitment(null as unknown as Uint8Array)).toThrow(BrainError);
  });
});

describe("loadBillingKey", () => {
  it("never creates the root or .protected when the key is absent", () => {
    const root = newRoot();
    expect(() => loadBillingKey(root)).toThrow(BrainError);
    expect(existsSync(join(root, ".protected"))).toBe(false);
  });

  it("rejects relative and missing roots without creating anything", () => {
    expect(() => loadBillingKey("relative/root")).toThrow(BrainError);
    const missing = join(fixtureBase(), `billing-key-nope-${randomUUID()}`);
    expect(() => loadBillingKey(missing)).toThrow(BrainError);
    expect(existsSync(missing)).toBe(false);
  });

  it("loads an exact 32-byte binary key as an owned copy", () => {
    const root = newRoot();
    writeKeyFile(root, SYNTHETIC_A);
    const first = loadBillingKey(root);
    expect(first.bytes).toEqual(SYNTHETIC_A);
    expect(first.commitment).toBe(commitmentOf(SYNTHETIC_A));
    first.bytes[0] = 0x99;
    const second = loadBillingKey(root);
    expect(second.bytes).toEqual(SYNTHETIC_A);
    expect(second.bytes).not.toBe(first.bytes);
  });

  it("rejects oversize, short and directory keys", () => {
    const oversize = newRoot();
    writeKeyFile(oversize, new Uint8Array(33));
    expect(() => loadBillingKey(oversize)).toThrow(BrainError);

    const short = newRoot();
    writeKeyFile(short, new Uint8Array(31));
    expect(() => loadBillingKey(short)).toThrow(BrainError);

    const directory = newRoot();
    mkdirSync(join(directory, ".protected", "billing-authority.key"), { recursive: true, mode: 0o700 });
    expect(() => loadBillingKey(directory)).toThrow(BrainError);
  });

  it("rejects a hard-linked key", () => {
    const root = newRoot();
    const file = writeKeyFile(root, SYNTHETIC_A);
    linkSync(file, join(dirname(file), "billing-authority.key.hard"));
    expect(() => loadBillingKey(root)).toThrow(BrainError);
  });

  it("rejects a linked .protected directory", (ctx) => {
    const root = newRoot();
    const outside = newRoot();
    tryLink(ctx, outside, join(root, ".protected"), "junction");
    expect(() => loadBillingKey(root)).toThrow(BrainError);
  });

  it("rejects a linked or junction ancestor root", (ctx) => {
    const real = newRoot();
    const link = join(fixtureBase(), `billing-key-junction-${randomUUID()}`);
    tryLink(ctx, real, link, "junction");
    cleanupLinks.push(link);
    expect(() => loadBillingKey(link)).toThrow(BrainError);
  });

  it("rejects a symlinked key file", (ctx) => {
    const root = newRoot();
    mkdirSync(join(root, ".protected"), { recursive: true, mode: 0o700 });
    const outsideFile = join(newRoot(), "outside.key");
    writeFileSync(outsideFile, SYNTHETIC_A, { mode: 0o600 });
    tryLink(ctx, outsideFile, keyFileOf(root), "file");
    expect(() => loadBillingKey(root)).toThrow(BrainError);
  });

  it("fails with a content-safe BrainError that leaks no key or path", () => {
    const bad = newRoot();
    writeKeyFile(bad, new Uint8Array(7));
    try {
      loadBillingKey(bad);
      throw new Error("a malformed key was unexpectedly accepted");
    } catch (error) {
      expect(error).toBeInstanceOf(BrainError);
      expect((error as Error).message).not.toContain(bad);
      expect((error as Error).message).not.toContain("ENOENT");
    }
  });

  posixOnly("rejects a group/other-readable, executable or permissive-mode key", () => {
    const permissive = newRoot();
    writeKeyFile(permissive, SYNTHETIC_A, 0o644);
    expect(() => loadBillingKey(permissive)).toThrow(BrainError);

    const executable = newRoot();
    writeKeyFile(executable, SYNTHETIC_A, 0o700);
    expect(() => loadBillingKey(executable)).toThrow(BrainError);

    const openDir = newRoot();
    mkdirSync(join(openDir, ".protected"), { recursive: true, mode: 0o755 });
    writeFileSync(keyFileOf(openDir), SYNTHETIC_A, { mode: 0o600 });
    expect(() => loadBillingKey(openDir)).toThrow(BrainError);
  });

  posixOnly("loads a 0600 key inside a 0700 .protected", () => {
    const root = newRoot();
    writeKeyFile(root, SYNTHETIC_A, 0o600);
    expect(loadBillingKey(root).commitment).toBe(commitmentOf(SYNTHETIC_A));
  });
});

describe("enrollBillingKeyOffline", () => {
  it("requires both literal acknowledgements and exact option keys", () => {
    const root = newRoot();
    expect(() =>
      enrollBillingKeyOffline(root, SYNTHETIC_A, {
        ...enrollOptions(SYNTHETIC_A),
        offline: undefined as unknown as true,
      }),
    ).toThrow(BrainError);
    expect(() =>
      enrollBillingKeyOffline(root, SYNTHETIC_A, {
        ...enrollOptions(SYNTHETIC_A),
        workers_terminated: false as unknown as true,
      }),
    ).toThrow(BrainError);
    expect(() =>
      enrollBillingKeyOffline(root, SYNTHETIC_A, {
        ...enrollOptions(SYNTHETIC_A),
        extra: true,
      } as unknown as ReturnType<typeof enrollOptions>),
    ).toThrow(BrainError);
    expect(existsSync(join(root, ".protected"))).toBe(false);
  });

  it("rejects invalid bytes or a commitment mismatch before any mutation", () => {
    const root = newRoot();
    expect(() =>
      enrollBillingKeyOffline(root, new Uint8Array(31), enrollOptions(new Uint8Array(31))),
    ).toThrow(BrainError);
    expect(() =>
      enrollBillingKeyOffline(root, SYNTHETIC_A, {
        offline: true,
        workers_terminated: true,
        expected_commitment: commitmentOf(SYNTHETIC_B),
      }),
    ).toThrow(BrainError);
    expect(existsSync(join(root, ".protected"))).toBe(false);
  });

  it("enrolls exactly 32 raw bytes and reads them back", () => {
    const root = newRoot();
    const commitment = commitmentOf(SYNTHETIC_A);
    const result = enrollBillingKeyOffline(root, SYNTHETIC_A, enrollOptions(SYNTHETIC_A));
    expect(result).toEqual({ commitment });
    const file = readFileSync(keyFileOf(root));
    expect(file.length).toBe(32);
    expect(new Uint8Array(file)).toEqual(SYNTHETIC_A);
    expect(loadBillingKey(root)).toEqual({ bytes: SYNTHETIC_A, commitment });
  });

  it("is an idempotent no-op for identical bytes and refuses a different key without overwriting", () => {
    const root = newRoot();
    enrollBillingKeyOffline(root, SYNTHETIC_A, enrollOptions(SYNTHETIC_A));
    const before = statSync(keyFileOf(root)).mtimeMs;
    expect(enrollBillingKeyOffline(root, SYNTHETIC_A, enrollOptions(SYNTHETIC_A))).toEqual({
      commitment: commitmentOf(SYNTHETIC_A),
    });
    expect(statSync(keyFileOf(root)).mtimeMs).toBe(before);
    expect(() =>
      enrollBillingKeyOffline(root, SYNTHETIC_B, enrollOptions(SYNTHETIC_B)),
    ).toThrow(BrainError);
    expect(new Uint8Array(readFileSync(keyFileOf(root)))).toEqual(SYNTHETIC_A);
  });

  it("refuses to enroll into a pre-existing empty .protected or a lost key", () => {
    const empty = newRoot();
    mkdirSync(join(empty, ".protected"), { recursive: true, mode: 0o700 });
    expect(() =>
      enrollBillingKeyOffline(empty, SYNTHETIC_A, enrollOptions(SYNTHETIC_A)),
    ).toThrow(BrainError);
    expect(existsSync(keyFileOf(empty))).toBe(false);

    const lost = newRoot();
    enrollBillingKeyOffline(lost, SYNTHETIC_A, enrollOptions(SYNTHETIC_A));
    rmSync(keyFileOf(lost), { force: true });
    expect(() =>
      enrollBillingKeyOffline(lost, SYNTHETIC_B, enrollOptions(SYNTHETIC_B)),
    ).toThrow(BrainError);
    expect(existsSync(keyFileOf(lost))).toBe(false);
  });

  it("idempotently accepts an identical key already present in a pre-created .protected", () => {
    const root = newRoot();
    writeKeyFile(root, SYNTHETIC_A);
    expect(enrollBillingKeyOffline(root, SYNTHETIC_A, enrollOptions(SYNTHETIC_A))).toEqual({
      commitment: commitmentOf(SYNTHETIC_A),
    });
  });

  posixOnly("creates .protected as 0700 and the key as 0600", () => {
    const root = newRoot();
    enrollBillingKeyOffline(root, SYNTHETIC_A, enrollOptions(SYNTHETIC_A));
    expect(statSync(join(root, ".protected")).mode & 0o777).toBe(0o700);
    expect(statSync(keyFileOf(root)).mode & 0o777).toBe(0o600);
  });
});
