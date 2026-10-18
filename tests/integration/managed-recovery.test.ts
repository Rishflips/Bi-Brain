import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ManagedRuntime } from "../../packages/runtime/managed.ts";
import {
  writeManagedBackup,
  restoreManagedBackup,
} from "../../packages/runtime/managed-recovery.ts";
import { controlRestoreRequired } from "../../packages/storage/managed-restore-policy.ts";
import { Storage } from "../../packages/storage/index.ts";

/**
 * Conservative cold/offline managed backup and restore over real managed roots.
 * No provider, no network; the tools are called directly or through their real
 * tsx entry points. The operator closes the runtime before a backup.
 */

const ISSUER = "https://issuer.synthetic.test";
const SENTINEL = "RECOVERY_SENTINEL_DELETED_BODY";
const clock = () => new Date("2026-10-16T09:00:00Z");
const bases: string[] = [];
afterEach(() => {
  for (const base of bases.splice(0))
    rmSync(base, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
});

function baseDir() {
  const base = realpathSync(
    mkdtempSync(join(tmpdir(), "bibrain-managed-recovery-")),
  );
  bases.push(base);
  return base;
}

function containsSentinel(root: string): boolean {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = statSync(path);
      if (stat.isDirectory()) stack.push(path);
      else if (stat.isFile() && readFileSync(path).includes(SENTINEL))
        return true;
    }
  }
  return false;
}

async function seedAndBackup(base: string) {
  const root = join(base, "managed");
  const bundle = join(base, "bundle");
  let sourceId = "";
  let sourceVersion = 1;
  let token = "";
  // Cold precondition: the runtime is closed before the backup is taken.
  const runtime = new ManagedRuntime(root, { clock });
  try {
    const account = runtime.provision(ISSUER, "recovery-account");
    const handle = runtime.acquire(account.id);
    try {
      const owner = handle.brain.ownerPrincipal();
      const captured = handle.brain.capture(owner, {
        project_id: "inbox",
        title: "note",
        body: `${SENTINEL} retained then deleted`,
      }) as { source_id: string };
      sourceId = captured.source_id;
      sourceVersion = Number(
        (
          handle.brain.store.get(
            "SELECT version FROM sources WHERE id=?",
            sourceId,
          ) as {
            version: number;
          }
        ).version,
      );
    } finally {
      handle.release();
    }
    token = runtime.control.issueSession(account.id).token;
  } finally {
    runtime.close();
  }
  await writeManagedBackup({ root, destination: bundle, offline: true });
  return { root, bundle, sourceId, sourceVersion, token };
}

function advanceCurrent(
  root: string,
  sourceId: string,
  version: number,
  token: string,
) {
  const runtime = new ManagedRuntime(root, { clock });
  const accountId = (
    runtime.control.db
      .prepare("SELECT id FROM managed_accounts LIMIT 1")
      .get() as {
      id: string;
    }
  ).id;
  const handle = runtime.acquire(accountId);
  try {
    handle.brain.removeSource(
      handle.brain.ownerPrincipal(),
      sourceId,
      version,
      true,
    );
  } finally {
    handle.release();
  }
  runtime.control.revokeSession(token);
  runtime.close();
}

describe("managed cold backup and restore", () => {
  it("restores a new root without resurrecting credentials or a deleted source", async () => {
    const base = baseDir();
    const restored = join(base, "restored");
    const { root, bundle, sourceId, sourceVersion, token } =
      await seedAndBackup(base);
    advanceCurrent(root, sourceId, sourceVersion, token);

    const result = await restoreManagedBackup({
      bundle,
      destination: restored,
      currentRoot: root,
      offline: true,
    });
    expect(result.accounts).toBe(1);
    expect(result.replayed).toBeGreaterThanOrEqual(1);

    const reopened = new ManagedRuntime(restored, { clock });
    try {
      expect(controlRestoreRequired(reopened.control)).toBe(true);
      expect(reopened.control.resolveSession(token)).toBeUndefined();
      const accountId = (
        reopened.control.db
          .prepare("SELECT id FROM managed_accounts LIMIT 1")
          .get() as {
          id: string;
        }
      ).id;
      const handle = reopened.acquire(accountId);
      try {
        const owner = handle.brain.ownerPrincipal();
        expect(handle.brain.status(owner).spend.blocked).toBe(true);
        const again = handle.brain.capture(owner, {
          project_id: "inbox",
          title: "post-restore",
          body: "RECOVERY_AFTER_RESTORE",
        }) as { source_id: string };
        expect(again.source_id).toBeTruthy();
        expect(
          handle.brain.store.get<{ state: string }>(
            "SELECT state FROM sources WHERE id=?",
            sourceId,
          )?.state,
        ).not.toBe("active");
        expect(
          handle.brain.store.get<{ n: number }>(
            "SELECT count(*) AS n FROM source_fts WHERE body LIKE '%RECOVERY_SENTINEL%'",
          )!.n,
        ).toBe(0);
      } finally {
        handle.release();
      }
      // The deleted body is gone from the restored vault/derived files too.
      expect(containsSentinel(join(restored, accountId))).toBe(false);
    } finally {
      reopened.close();
    }
  }, 15_000);

  it("performs a real CLI cold round trip", async () => {
    const base = baseDir();
    const restored = join(base, "restored");
    const { root, bundle, sourceId, sourceVersion, token } =
      await seedAndBackup(base);
    advanceCurrent(root, sourceId, sourceVersion, token);
    // Also produce a fresh bundle through the actual CLI entry point.
    const cliBundle = join(base, "cli-bundle");
    execFileSync(
      process.execPath,
      ["--import", "tsx", "scripts/managed-backup.ts", "--offline", cliBundle],
      {
        cwd: process.cwd(),
        env: { ...process.env, BRAIN_MANAGED_ROOT: root },
        stdio: "pipe",
      },
    );
    execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/managed-restore.ts",
        "--offline",
        cliBundle,
        restored,
        "--current-root",
        root,
      ],
      { cwd: process.cwd(), env: { ...process.env }, stdio: "pipe" },
    );
    const reopened = new ManagedRuntime(restored, { clock });
    try {
      expect(reopened.control.resolveSession(token)).toBeUndefined();
      const accountId = (
        reopened.control.db
          .prepare("SELECT id FROM managed_accounts LIMIT 1")
          .get() as {
          id: string;
        }
      ).id;
      const handle = reopened.acquire(accountId);
      try {
        expect(
          handle.brain.store.get<{ n: number }>(
            "SELECT count(*) AS n FROM source_fts WHERE body LIKE '%RECOVERY_SENTINEL%'",
          )!.n,
        ).toBe(0);
      } finally {
        handle.release();
      }
      expect(containsSentinel(join(restored, accountId, "vault"))).toBe(false);
    } finally {
      reopened.close();
    }
    expect(bundle).toBeTruthy();
  });

  it("leaves a marked, blocked staging root when the current replay fails", async () => {
    const base = baseDir();
    const restored = join(base, "restored");
    const { root, bundle } = await seedAndBackup(base);
    // Make the current tenant unreadable for replay.
    const accountId = (() => {
      const rt = new ManagedRuntime(root, { clock });
      const id = (
        rt.control.db
          .prepare("SELECT id FROM managed_accounts LIMIT 1")
          .get() as {
          id: string;
        }
      ).id;
      rt.close();
      return id;
    })();
    const current = new DatabaseSync(join(root, accountId, "brain.sqlite"));
    current.exec("ALTER TABLE sources RENAME TO sources_renamed");
    current.close();

    await expect(
      restoreManagedBackup({
        bundle,
        destination: restored,
        currentRoot: root,
        offline: true,
      }),
    ).rejects.toThrow();
    expect(existsSync(restored)).toBe(false);

    const staging = readdirSync(base).find((n) =>
      n.startsWith("restored.staging-"),
    );
    expect(staging).toBeTruthy();
    const stage = join(base, staging!);
    const stageControl = new DatabaseSync(join(stage, "control.sqlite"), {
      readOnly: true,
    });
    stageControl.close();
    const { ControlStore } = await import("../../packages/storage/control.ts");
    const control = new ControlStore(join(stage, "control.sqlite"), clock);
    try {
      expect(controlRestoreRequired(control)).toBe(true);
    } finally {
      control.close();
    }
    const store = new Storage(join(stage, accountId, "brain.sqlite"), {
      vault: join(stage, accountId, "vault"),
    });
    try {
      expect(store.setting("paid_processing_blocked", null)).not.toBeNull();
    } finally {
      store.close();
    }
    expect(() => new ManagedRuntime(stage, { clock })).toThrow();
  });

  it("does not reactivate a currently suspended account", async () => {
    const base = baseDir();
    const restored = join(base, "restored");
    const { root, bundle } = await seedAndBackup(base);
    const runtime = new ManagedRuntime(root, { clock });
    const accountId = (
      runtime.control.db
        .prepare("SELECT id FROM managed_accounts LIMIT 1")
        .get() as {
        id: string;
      }
    ).id;
    runtime.control.setAccountState(accountId, "suspended");
    runtime.close();

    await restoreManagedBackup({
      bundle,
      destination: restored,
      currentRoot: root,
      offline: true,
    });
    const reopened = new ManagedRuntime(restored, { clock });
    try {
      expect(reopened.control.account(accountId)?.state).toBe("suspended");
    } finally {
      reopened.close();
    }
  });

  it("rejects unsafe backup and restore inputs before creating anything", async () => {
    const base = baseDir();
    const root = join(base, "managed");
    const runtime = new ManagedRuntime(root, { clock });
    runtime.provision(ISSUER, "recovery-safety");
    runtime.close();

    await expect(
      writeManagedBackup({
        root,
        destination: join(base, "b1"),
        offline: false,
      }),
    ).rejects.toThrow();
    await expect(
      writeManagedBackup({
        root,
        destination: join(root, "b2"),
        offline: true,
      }),
    ).rejects.toThrow();

    const bundle = join(base, "bundle");
    await writeManagedBackup({ root, destination: bundle, offline: true });
    expect(existsSync(bundle)).toBe(true);
    await expect(
      writeManagedBackup({ root, destination: bundle, offline: true }),
    ).rejects.toThrow();
  });

  it("rejects a tampered hash and a missing backed account", async () => {
    const base = baseDir();
    const root = join(base, "managed");
    const bundle = join(base, "bundle");
    const restored = join(base, "restored");
    const runtime = new ManagedRuntime(root, { clock });
    runtime.provision(ISSUER, "recovery-tamper");
    runtime.close();
    await writeManagedBackup({ root, destination: bundle, offline: true });

    const controlCopy = join(base, "tamper-bundle");
    await writeManagedBackup({ root, destination: controlCopy, offline: true });
    writeFileSync(join(controlCopy, "control.sqlite"), "corrupted", {
      flag: "r+",
    });
    await expect(
      restoreManagedBackup({
        bundle: controlCopy,
        destination: restored,
        currentRoot: root,
        offline: true,
      }),
    ).rejects.toThrow();

    const otherRoot = join(base, "other");
    const other = new ManagedRuntime(otherRoot, { clock });
    other.provision(ISSUER, "unrelated-account");
    other.close();
    await expect(
      restoreManagedBackup({
        bundle,
        destination: restored,
        currentRoot: otherRoot,
        offline: true,
      }),
    ).rejects.toThrow(/resurrect/);
    expect(existsSync(restored)).toBe(false);
  });
});
