import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { expect, it } from "vitest";
import { BrainError } from "../../packages/domain/logic.ts";
import {
  billingKeyCommitment,
  billingKeyPath,
  enrollBillingKeyOffline,
  loadBillingKey,
} from "../../packages/storage/billing-key.ts";

// Parent-owned SYNTHETIC authority key tests. No owner roots or provider secrets.
const binaryKey = Uint8Array.from({ length: 32 }, (_, i) =>
  i % 3 === 0 ? 255 : i % 3 === 1 ? 0 : 128,
);
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const enrollment = (bytes = binaryKey) => ({
  offline: true as const,
  workers_terminated: true as const,
  expected_commitment: sha(bytes),
});

function fixture() {
  const base =
    process.platform === "win32"
      ? "C:/Users/Gowrishankar/AppData/Local/Temp/opencode"
      : tmpdir();
  const dir = mkdtempSync(join(base, "brain-key-parent-"));
  const root = join(dir, "managed");
  mkdirSync(root, { mode: 0o700 });
  return {
    dir,
    root,
    protectedDir: join(root, ".protected"),
    key: join(root, ".protected", "billing-authority.key"),
    close() {
      rmSync(dir, {
        recursive: true,
        force: true,
        maxRetries: 8,
        retryDelay: 50,
      });
    },
  };
}

it("key path derivation is fixed and creates nothing, even for a missing root", () => {
  const f = fixture();
  try {
    const missing = join(f.dir, "does-not-exist");
    const path = billingKeyPath(missing);
    expect(path).toBe(join(missing, ".protected", "billing-authority.key"));
    expect(isAbsolute(path)).toBe(true);
    expect(existsSync(missing)).toBe(false);
  } finally {
    f.close();
  }
});

it.each(["", "relative/root", "file:///managed", "."])(
  "rejects nonabsolute root %j without creating it",
  (root) => {
    expect(() => billingKeyPath(root)).toThrow(BrainError);
  },
);

it("commitment hashes exactly the supplied binary bytes rather than their text representation", () => {
  expect(billingKeyCommitment(binaryKey)).toBe(sha(binaryKey));
  expect(billingKeyCommitment(binaryKey)).not.toBe(
    sha(Buffer.from(Buffer.from(binaryKey).toString("hex"), "utf8")),
  );
});

it.each([
  new Uint8Array(31),
  new Uint8Array(33),
  Array(32).fill(1),
  "SYNTHETIC-NOT-A-KEY",
  null,
])(
  "invalid key %j is refused before a protected directory can be created",
  (bytes) => {
    const f = fixture();
    try {
      expect(() =>
        enrollBillingKeyOffline(f.root, bytes as Uint8Array, enrollment()),
      ).toThrow(BrainError);
      expect(existsSync(f.protectedDir)).toBe(false);
    } finally {
      f.close();
    }
  },
);

it.each([
  {
    offline: false,
    workers_terminated: true,
    expected_commitment: sha(binaryKey),
  },
  {
    offline: true,
    workers_terminated: false,
    expected_commitment: sha(binaryKey),
  },
  { offline: true, expected_commitment: sha(binaryKey) },
  {
    offline: true,
    workers_terminated: true,
    expected_commitment: "a".repeat(64),
  },
  { offline: true, workers_terminated: true, expected_commitment: "bad" },
  { ...enrollment(), approved_by_model: true },
])(
  "enrollment validates closed acknowledgements and commitment before filesystem mutation: %j",
  (options) => {
    const f = fixture();
    try {
      expect(() =>
        enrollBillingKeyOffline(
          f.root,
          binaryKey,
          options as Parameters<typeof enrollBillingKeyOffline>[2],
        ),
      ).toThrow(BrainError);
      expect(existsSync(f.protectedDir)).toBe(false);
    } finally {
      f.close();
    }
  },
);

it("load never initializes either a missing root or a missing protected directory", () => {
  const f = fixture();
  try {
    const missing = join(f.dir, "missing");
    expect(() => loadBillingKey(missing)).toThrow(BrainError);
    expect(() => loadBillingKey(f.root)).toThrow(BrainError);
    expect(existsSync(missing)).toBe(false);
    expect(existsSync(f.protectedDir)).toBe(false);
  } finally {
    f.close();
  }
});

it("enrollment does not create a missing managed root", () => {
  const f = fixture();
  try {
    const missing = join(f.dir, "missing");
    expect(() =>
      enrollBillingKeyOffline(missing, binaryKey, enrollment()),
    ).toThrow(BrainError);
    expect(existsSync(missing)).toBe(false);
  } finally {
    f.close();
  }
});

it("binary enrollment and replay preserve exact disk contents, identity and mtime", () => {
  const f = fixture();
  try {
    expect(enrollBillingKeyOffline(f.root, binaryKey, enrollment())).toEqual({
      commitment: sha(binaryKey),
    });
    const oldTime = new Date("2020-01-01T00:00:00.000Z");
    utimesSync(f.key, oldTime, oldTime);
    const before = statSync(f.key);
    expect(Array.from(readFileSync(f.key))).toEqual(Array.from(binaryKey));
    expect(enrollBillingKeyOffline(f.root, binaryKey, enrollment())).toEqual({
      commitment: sha(binaryKey),
    });
    const after = statSync(f.key);
    expect([after.ino, after.mtimeMs, after.size]).toEqual([
      before.ino,
      before.mtimeMs,
      32,
    ]);
    const loaded = loadBillingKey(f.root);
    loaded.bytes.fill(42);
    expect(Array.from(loadBillingKey(f.root).bytes)).toEqual(
      Array.from(binaryKey),
    );
  } finally {
    f.close();
  }
});

it("a different matching-input commitment cannot replace an enrolled key", () => {
  const f = fixture();
  try {
    enrollBillingKeyOffline(f.root, binaryKey, enrollment());
    const oldTime = new Date("2020-01-01T00:00:00.000Z");
    utimesSync(f.key, oldTime, oldTime);
    const before = statSync(f.key),
      other = new Uint8Array(32).fill(17);
    expect(() =>
      enrollBillingKeyOffline(f.root, other, enrollment(other)),
    ).toThrow(BrainError);
    expect(Array.from(readFileSync(f.key))).toEqual(Array.from(binaryKey));
    expect(statSync(f.key).mtimeMs).toBe(before.mtimeMs);
  } finally {
    f.close();
  }
});

it("a lost enrolled key cannot be silently replaced by treating its protected directory as new", () => {
  const f = fixture();
  try {
    enrollBillingKeyOffline(f.root, binaryKey, enrollment());
    unlinkSync(f.key); // Only this test's own disposable synthetic key.
    const replacement = new Uint8Array(32).fill(17);
    expect(() =>
      enrollBillingKeyOffline(f.root, replacement, enrollment(replacement)),
    ).toThrow(BrainError);
    expect(existsSync(f.key)).toBe(false);
    expect(lstatSync(f.protectedDir).isDirectory()).toBe(true);
  } finally {
    f.close();
  }
});

it.each([0, 31, 33, 1024 * 1024])(
  "a %i-byte existing file is not repaired, truncated or re-enrolled",
  (size) => {
    const f = fixture();
    try {
      mkdirSync(f.protectedDir, { mode: 0o700 });
      writeFileSync(f.key, Buffer.alloc(size, 17), { mode: 0o600 });
      const before = statSync(f.key),
        contents = readFileSync(f.key);
      expect(() => loadBillingKey(f.root)).toThrow(BrainError);
      expect(() =>
        enrollBillingKeyOffline(f.root, binaryKey, enrollment()),
      ).toThrow(BrainError);
      expect(readFileSync(f.key)).toEqual(contents);
      expect(statSync(f.key).mtimeMs).toBe(before.mtimeMs);
    } finally {
      f.close();
    }
  },
  15000,
);

it("a directory at the key path is not overwritten or deleted", () => {
  const f = fixture();
  try {
    mkdirSync(f.protectedDir, { mode: 0o700 });
    mkdirSync(f.key);
    expect(() => loadBillingKey(f.root)).toThrow(BrainError);
    expect(() =>
      enrollBillingKeyOffline(f.root, binaryKey, enrollment()),
    ).toThrow(BrainError);
    expect(lstatSync(f.key).isDirectory()).toBe(true);
  } finally {
    f.close();
  }
});

it("a regular file at .protected is not replaced by a directory", () => {
  const f = fixture();
  try {
    writeFileSync(f.protectedDir, "SYNTHETIC-preserve-me");
    expect(() =>
      enrollBillingKeyOffline(f.root, binaryKey, enrollment()),
    ).toThrow(BrainError);
    expect(readFileSync(f.protectedDir, "utf8")).toBe("SYNTHETIC-preserve-me");
  } finally {
    f.close();
  }
});

it("a .protected junction/symlink cannot redirect enrollment into another directory", () => {
  const f = fixture();
  try {
    const target = join(f.dir, "target");
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(
      target,
      f.protectedDir,
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(() => loadBillingKey(f.root)).toThrow(BrainError);
    expect(() =>
      enrollBillingKeyOffline(f.root, binaryKey, enrollment()),
    ).toThrow(BrainError);
    expect(existsSync(join(target, "billing-authority.key"))).toBe(false);
  } finally {
    f.close();
  }
});

it("a linked ancestor of the managed root cannot be used to load or create a key", () => {
  const f = fixture();
  try {
    const link = join(f.dir, "alias");
    symlinkSync(
      f.root,
      link,
      process.platform === "win32" ? "junction" : "dir",
    );
    const aliasedRoot = join(link, "nested");
    mkdirSync(join(f.root, "nested"), { mode: 0o700 });
    expect(() => loadBillingKey(aliasedRoot)).toThrow(BrainError);
    expect(() =>
      enrollBillingKeyOffline(aliasedRoot, binaryKey, enrollment()),
    ).toThrow(BrainError);
    expect(existsSync(join(f.root, "nested", ".protected"))).toBe(false);
  } finally {
    f.close();
  }
});

it("a hard-linked authority file is rejected without changing either name's bytes", () => {
  const f = fixture();
  try {
    enrollBillingKeyOffline(f.root, binaryKey, enrollment());
    const alias = join(f.dir, "SYNTHETIC-alias");
    linkSync(f.key, alias);
    expect(statSync(f.key).nlink).toBeGreaterThan(1);
    expect(() => loadBillingKey(f.root)).toThrow(BrainError);
    expect(() =>
      enrollBillingKeyOffline(f.root, binaryKey, enrollment()),
    ).toThrow(BrainError);
    expect(Array.from(readFileSync(alias))).toEqual(Array.from(binaryKey));
  } finally {
    f.close();
  }
});

it.skipIf(process.platform === "win32")(
  "POSIX group-readable key is refused, not chmod-repaired",
  () => {
    const f = fixture();
    try {
      enrollBillingKeyOffline(f.root, binaryKey, enrollment());
      chmodSync(f.key, 0o640);
      expect(() => loadBillingKey(f.root)).toThrow(BrainError);
      expect(() =>
        enrollBillingKeyOffline(f.root, binaryKey, enrollment()),
      ).toThrow(BrainError);
      expect(statSync(f.key).mode & 0o777).toBe(0o640);
    } finally {
      f.close();
    }
  },
);

it.skipIf(process.platform === "win32")(
  "POSIX permissive protected directory is refused without repairing its mode",
  () => {
    const f = fixture();
    try {
      mkdirSync(f.protectedDir, { mode: 0o700 });
      chmodSync(f.protectedDir, 0o755);
      expect(() =>
        enrollBillingKeyOffline(f.root, binaryKey, enrollment()),
      ).toThrow(BrainError);
      expect(existsSync(f.key)).toBe(false);
      expect(statSync(f.protectedDir).mode & 0o777).toBe(0o755);
    } finally {
      f.close();
    }
  },
);

it("failure messages expose neither filesystem paths nor key contents", () => {
  const f = fixture();
  try {
    try {
      loadBillingKey(f.root);
      throw new Error("Expected missing-key refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(BrainError);
      const message = (error as Error).message;
      expect(message).not.toContain(resolve(f.root));
      expect(message).not.toContain(Buffer.from(binaryKey).toString("hex"));
      expect(message).not.toContain("ENOENT");
    }
  } finally {
    f.close();
  }
});
