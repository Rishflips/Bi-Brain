import { afterEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Storage } from "../../packages/storage/index.ts";
import { Brain } from "../../packages/domain/service.ts";
import { applyRestoreSafetyBarrier } from "../../packages/storage/restore-policy.ts";
import { paidProcessingBlockedSetting } from "../../packages/storage/spend.ts";

/**
 * Runs the real `scripts/restore.ts` CLI against disposable data under a
 * temporary working directory, so no owner database or repository `data/` is
 * touched. The tsx loader is passed as an absolute file URL so the child's cwd
 * can differ from the repository.
 */
const TSX_LOADER = pathToFileURL(
  resolve("node_modules/tsx/dist/loader.mjs"),
).href;
const RESTORE_SCRIPT = resolve("scripts/restore.ts");

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function disposable() {
  const root = mkdtempSync(join(tmpdir(), "bibrain-restore-"));
  roots.push(root);
  mkdirSync(join(root, "data", "backups"), { recursive: true });
  return root;
}

const owner = { kind: "owner" } as const;
const clock = () => new Date("2026-10-16T09:00:00Z");

/** A real settled dispatch plus a held reservation, backed by a real job FK. */
function seedAccounting(store: Storage, jobId: string) {
  store.run(
    "INSERT INTO jobs(id,project_id,kind,payload,status,attempts,max_attempts,next_at,fence,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    jobId,
    "inbox",
    "derive_brief",
    "{}",
    "succeeded",
    1,
    3,
    "2026-10-16T09:00:00Z",
    0,
    "2026-10-16T09:00:00Z",
  );
  store.set("preferences", {
    enabled: true,
    time_zone: "UTC",
    digest_hour: 9,
    quiet_start: 22,
    quiet_end: 8,
    daily_cap_micro_usd: 5000,
    per_job_cap_micro_usd: 500,
    provider_enabled: true,
  });
  // A prior over-bound block must be superseded by, not silently trusted after,
  // a restore.
  store.set(paidProcessingBlockedSetting, {
    call_id: "prior-call",
    job_id: jobId,
    at: "2026-10-16T08:30:00Z",
    over_micro_usd: 40,
  });
  const settledJob = `${jobId}-settled`;
  store.run(
    "INSERT INTO jobs(id,project_id,kind,payload,status,attempts,max_attempts,next_at,fence,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    settledJob,
    "inbox",
    "derive_brief",
    "{}",
    "succeeded",
    1,
    3,
    "2026-10-16T09:00:00Z",
    0,
    "2026-10-16T09:00:00Z",
  );
  store.run(
    `INSERT INTO provider_dispatches(call_id,job_id,dispatch_key,stage,state,reserved_micro_usd,actual_micro_usd,provider,model,price_version,request_hash,config_hash,identity_hash,budget_day,time_zone,created_at,dispatched_at,settled_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    "settled-call",
    settledJob,
    "reasoning",
    "reasoning",
    "settled",
    10,
    12,
    "openai",
    "m",
    "v",
    "a".repeat(64),
    "b".repeat(64),
    "c".repeat(64),
    "2026-10-16",
    "UTC",
    "2026-10-16T08:00:00Z",
    "2026-10-16T08:00:00Z",
    "2026-10-16T08:00:00Z",
  );
  store.run("INSERT INTO reservations VALUES(?,?,?,?,?)", jobId, "2026-10-16", 5, 0, "held");
}

function runRestore(root: string, name: string, brainDb: string): void {
  execFileSync(process.execPath, ["--import", TSX_LOADER, RESTORE_SCRIPT, name], {
    cwd: root,
    env: { ...process.env, BRAIN_DB: brainDb },
    windowsHide: true,
    stdio: "pipe",
  });
}

function restoredDir(root: string): string {
  const found = readdirSync(join(root, "data")).filter((n) =>
    n.startsWith("restored-"),
  );
  expect(found).toHaveLength(1);
  return join(root, "data", found[0]!);
}

it("applies the barrier during the real CLI, preserves accounting and replays tombstones", () => {
  const root = disposable();
  const name = `restore-barrier-${randomUUID()}.sqlite`;
  const backupPath = join(root, "data", "backups", name);
  const currentPath = join(root, "data", "brain.sqlite");

  // Older backup: prefs provider_enabled true, a prior overrun block, a source
  // and known accounting.
  const backup = new Storage(backupPath);
  const backupBrain = new Brain(backup, clock);
  const source = backupBrain.capture(owner, {
    project_id: "inbox",
    title: "note",
    body: "RESTORE_BARRIER_SENTINEL",
  }) as { source_id: string };
  seedAccounting(backup, "job-backup");
  backup.close();

  // Current database: the source was deleted after the backup, so restore must
  // replay that tombstone.
  const current = new Storage(currentPath);
  current.run(
    "INSERT INTO sources VALUES(?,?,?,?,?,?,?)",
    source.source_id,
    "inbox",
    1,
    "deleted",
    "project",
    "manual",
    "2026-10-16T09:00:00Z",
  );
  current.run(
    "INSERT INTO source_versions VALUES(?,?,?,?,?)",
    source.source_id,
    1,
    "note",
    "RESTORE_BARRIER_SENTINEL",
    "2026-10-16T09:00:00Z",
  );
  current.close();

  runRestore(root, name, currentPath);

  const dir = restoredDir(root);
  const restored = new Storage(join(dir, "brain.sqlite"));
  try {
    const prefs = restored.setting<any>("preferences", {});
    expect(prefs.provider_enabled).toBe(false);
    expect(prefs.daily_cap_micro_usd).toBe(5000);
    expect(restored.setting(paidProcessingBlockedSetting, null)).toMatchObject({
      reason: "restored_backup",
    });
    // Accounting rows are preserved value-for-value.
    expect(
      restored.get<{ reserved: number; actual: number; status: string }>(
        "SELECT reserved,actual,status FROM reservations",
      ),
    ).toMatchObject({ reserved: 5, actual: 0, status: "held" });
    expect(
      restored.get<{ state: string; reserved_micro_usd: number; actual_micro_usd: number }>(
        "SELECT state,reserved_micro_usd,actual_micro_usd FROM provider_dispatches WHERE call_id=?",
        "settled-call",
      ),
    ).toMatchObject({ state: "settled", reserved_micro_usd: 10, actual_micro_usd: 12 });
    // Tombstone replay ran: the replayed source is no longer active.
    expect(
      restored.get<{ state: string }>(
        "SELECT state FROM sources WHERE id=?",
        source.source_id,
      )?.state,
    ).not.toBe("active");
    // Ordinary preferences cannot clear the block.
    expect(() =>
      new Brain(restored, clock).prefs(owner, {
        ...new Brain(restored, clock).prefs(owner),
        provider_enabled: true,
      }),
    ).toThrow("blocked");
    expect(new Brain(restored, clock).status(owner).spend.blocked).toBe(true);
    expect(readFileSync(join(dir, "RESTORE_NOTICE.txt"), "utf8")).toContain(
      "paid processing was disabled",
    );
  } finally {
    restored.close();
  }
});

it("persists the barrier before a failing tombstone replay", () => {
  const root = disposable();
  const name = `restore-barrier-fail-${randomUUID()}.sqlite`;
  const backupPath = join(root, "data", "backups", name);
  // A current database that exists but is not usable, so tombstone replay
  // throws after the barrier has already been applied.
  const currentPath = join(root, "data", "brain.sqlite");
  mkdirSync(join(root, "data"), { recursive: true });

  const backup = new Storage(backupPath);
  const restoreOwner = { kind: "owner" } as const;
  new Brain(backup, clock).capture(restoreOwner, {
    project_id: "inbox",
    title: "note",
    body: "RESTORE_FAIL_SENTINEL",
  });
  seedAccounting(backup, "job-backup");
  backup.close();

  // Not a SQLite database at all: opening/querying it will fail.
  rmSync(currentPath, { force: true });
  writeFileSync(currentPath, "NOT_A_SQLITE_DATABASE");

  expect(() => runRestore(root, name, currentPath)).toThrow();

  // Despite the failure, the restored artifact already carries the barrier.
  const dir = restoredDir(root);
  const restored = new Storage(join(dir, "brain.sqlite"));
  try {
    expect(restored.setting(paidProcessingBlockedSetting, null)).toMatchObject({
      reason: "restored_backup",
    });
    expect(restored.setting<any>("preferences", {}).provider_enabled).toBe(false);
    expect(
      restored.get<{ n: number }>("SELECT count(*) AS n FROM provider_dispatches")!.n,
    ).toBe(1);
    expect(new Brain(restored, clock).status(owner).spend.blocked).toBe(true);
  } finally {
    restored.close();
  }
});

it("blocks a stale backup that predates a known charge, so no free allowance is inferred", () => {
  const root = disposable();
  const name = `restore-stale-${randomUUID()}.sqlite`;
  const backupPath = join(root, "data", "backups", name);
  const currentPath = join(root, "data", "brain.sqlite");

  // Older backup with no accounting rows at all.
  const backup = new Storage(backupPath);
  backup.set("preferences", {
    enabled: true,
    time_zone: "UTC",
    digest_hour: 9,
    quiet_start: 22,
    quiet_end: 8,
    daily_cap_micro_usd: 5000,
    per_job_cap_micro_usd: 500,
    provider_enabled: true,
  });
  backup.close();

  // Current database has a known settled charge the backup lacks.
  const current = new Storage(currentPath);
  seedAccounting(current, "job-current");
  current.close();

  runRestore(root, name, currentPath);

  const dir = restoredDir(root);
  const restored = new Storage(join(dir, "brain.sqlite"));
  try {
    // The restored ledger is empty, so the durable block is what prevents
    // treating the older backup as a fresh, free allowance.
    expect(
      restored.get<{ n: number }>("SELECT count(*) AS n FROM provider_dispatches")!.n,
    ).toBe(0);
    expect(restored.setting(paidProcessingBlockedSetting, null)).toMatchObject({
      reason: "restored_backup",
    });
    const status = new Brain(restored, clock).status(owner);
    expect(status.spend.blocked).toBe(true);
    expect(status.spend.blocked_reason).toBe("recovery");
    expect(status.spend.settled_micro_usd).toBe(0);
  } finally {
    restored.close();
  }
});

it("applyRestoreSafetyBarrier is idempotent and preserves accounting", () => {
  const root = disposable();
  const path = join(root, "data", "brain.sqlite");
  const store = new Storage(path);
  try {
    store.set("preferences", {
      enabled: true,
      time_zone: "UTC",
      digest_hour: 9,
      quiet_start: 22,
      quiet_end: 8,
      daily_cap_micro_usd: 5000,
      per_job_cap_micro_usd: 500,
      provider_enabled: true,
    });
    seedAccounting(store, "job-unit");
    const before = store.all("SELECT * FROM provider_dispatches");
    const reservationsBefore = store.all("SELECT * FROM reservations");

    applyRestoreSafetyBarrier(store, clock);
    applyRestoreSafetyBarrier(store, clock);

    expect(store.setting(paidProcessingBlockedSetting, null)).toMatchObject({
      reason: "restored_backup",
    });
    expect(store.setting<any>("preferences", {}).provider_enabled).toBe(false);
    expect(store.all("SELECT * FROM provider_dispatches")).toEqual(before);
    expect(store.all("SELECT * FROM reservations")).toEqual(reservationsBefore);
  } finally {
    store.close();
  }
});

it("applyRestoreSafetyBarrier protects a future enable when preferences are absent", () => {
  const root = disposable();
  const store = new Storage(join(root, "data", "brain.sqlite"));
  try {
    applyRestoreSafetyBarrier(store, clock);
    expect(store.setting(paidProcessingBlockedSetting, null)).toMatchObject({
      reason: "restored_backup",
    });
    const brain = new Brain(store, clock);
    expect(brain.prefs(owner).provider_enabled).toBe(false);
    expect(() =>
      brain.prefs(owner, { ...brain.prefs(owner), provider_enabled: true }),
    ).toThrow("blocked");
  } finally {
    store.close();
  }
});

const VAULT_SCRIPT = resolve("scripts/vault.ts");

it("the vault rollback CLI blocks the verified copy and leaves the source database unchanged", () => {
  const root = disposable();
  const dbPath = join(root, "data", "brain.sqlite");
  const vaultRoot = join(root, "data", "brain.vault");
  const protectedRoot = vaultRoot + "-protected";
  const backupPath = join(root, "pre-vault.sqlite");

  // The pre-vault backup is the rollback source; it must not be modified.
  const backup = new Storage(backupPath);
  const backupBrain = new Brain(backup, clock);
  backupBrain.capture(owner, {
    project_id: "inbox",
    title: "note",
    body: "VAULT_ROLLBACK_SENTINEL",
  });
  seedAccounting(backup, "job-rollback");
  backup.close();

  mkdirSync(protectedRoot, { recursive: true });
  writeFileSync(
    join(protectedRoot, "migration.json"),
    JSON.stringify({ schema: 1, backup: backupPath, sources: 1, stable_ids: true }),
  );

  execFileSync(
    process.execPath,
    ["--import", TSX_LOADER, VAULT_SCRIPT, "rollback"],
    {
      cwd: root,
      env: { ...process.env, BRAIN_DB: dbPath, BRAIN_VAULT: vaultRoot },
      windowsHide: true,
      stdio: "pipe",
    },
  );

  const target = dbPath + ".rollback.sqlite";
  const copy = new Storage(target);
  try {
    expect(copy.setting(paidProcessingBlockedSetting, null)).toMatchObject({
      reason: "restored_backup",
    });
    const prefs = copy.setting<any>("preferences", {});
    expect(prefs.provider_enabled).toBe(false);
    expect(prefs.daily_cap_micro_usd).toBe(5000);
    expect(
      copy.get<{ reserved: number; actual: number; status: string }>(
        "SELECT reserved,actual,status FROM reservations",
      ),
    ).toMatchObject({ reserved: 5, actual: 0, status: "held" });
    expect(
      copy.get<{ state: string; actual_micro_usd: number }>(
        "SELECT state,actual_micro_usd FROM provider_dispatches WHERE call_id=?",
        "settled-call",
      ),
    ).toMatchObject({ state: "settled", actual_micro_usd: 12 });
    expect(
      copy.get<{ state: string }>(
        "SELECT s.state AS state FROM sources s JOIN source_versions v ON s.id=v.source_id AND s.version=v.version WHERE v.body LIKE '%VAULT_ROLLBACK%'",
      )?.state,
    ).toBe("active");
    expect(() =>
      new Brain(copy, clock).prefs(owner, {
        ...new Brain(copy, clock).prefs(owner),
        provider_enabled: true,
      }),
    ).toThrow("blocked");
  } finally {
    copy.close();
  }

  // The rollback source database itself is untouched: its pre-existing
  // over-bound block is unchanged and was not rewritten by the copy's barrier.
  const source = new DatabaseSync(backupPath, { readOnly: true });
  try {
    const sourceBlock = JSON.parse(
      (
        source
          .prepare("SELECT value FROM settings WHERE key=?")
          .get(paidProcessingBlockedSetting) as { value: string }
      ).value,
    );
    expect(sourceBlock).toMatchObject({ call_id: "prior-call", over_micro_usd: 40 });
    expect(sourceBlock.reason).toBeUndefined();
    expect(
      source
        .prepare(
          "SELECT s.state AS state FROM sources s JOIN source_versions v ON s.id=v.source_id AND s.version=v.version WHERE v.body LIKE '%VAULT_ROLLBACK%'",
        )
        .get(),
    ).toMatchObject({ state: "active" });
  } finally {
    source.close();
  }
});

it("a fresh operational database rebuilt from an existing vault is blocked", () => {
  const root = disposable();
  const dbPath = join(root, "data", "brain.sqlite");
  const vaultRoot = join(root, "data", "brain.vault");

  // Build a vault with knowledge, then lose the operational database.
  const first = new Storage(dbPath, { vault: vaultRoot });
  new Brain(first, clock).capture(owner, {
    project_id: "inbox",
    title: "note",
    body: "VAULT_RECOVERY_KNOWLEDGE",
  });
  first.close();
  rmSync(dbPath, { force: true });
  rmSync(dbPath + "-wal", { force: true });
  rmSync(dbPath + "-shm", { force: true });

  const recovered = new Storage(dbPath, { vault: vaultRoot });
  try {
    expect(recovered.setting(paidProcessingBlockedSetting, null)).toMatchObject({
      reason: "restored_backup",
    });
    // Knowledge is restored from the vault, but the financial history is gone:
    // the durable block is what prevents inferring a fresh allowance.
    expect(
      recovered.get<{ n: number }>("SELECT count(*) AS n FROM sources")!.n,
    ).toBeGreaterThan(0);
    expect(
      recovered.get<{ n: number }>("SELECT count(*) AS n FROM provider_dispatches")!.n,
    ).toBe(0);
    const brain = new Brain(recovered, clock);
    expect(brain.status(owner).spend.blocked).toBe(true);
    expect(brain.status(owner).spend.blocked_reason).toBe("recovery");
    expect(() =>
      brain.prefs(owner, { ...brain.prefs(owner), provider_enabled: true }),
    ).toThrow("blocked");
  } finally {
    recovered.close();
  }
});

it("does not block a normal first use with a new vault or a normal rebuild", () => {
  const root = disposable();
  const dbPath = join(root, "data", "brain.sqlite");
  const vaultRoot = join(root, "data", "brain.vault");

  // Fresh database + new vault: ordinary first use, no recovery block.
  const fresh = new Storage(dbPath, { vault: vaultRoot });
  try {
    expect(fresh.setting(paidProcessingBlockedSetting, null)).toBeNull();
  } finally {
    fresh.close();
  }

  // Existing operational database + existing vault: a normal rebuild keeps any
  // valid paid processing enabled.
  const existing = new Storage(dbPath, { vault: vaultRoot });
  existing.set("preferences", {
    enabled: true,
    time_zone: "UTC",
    digest_hour: 9,
    quiet_start: 22,
    quiet_end: 8,
    daily_cap_micro_usd: 5000,
    per_job_cap_micro_usd: 500,
    provider_enabled: true,
  });
  existing.close();

  const reopened = new Storage(dbPath, { vault: vaultRoot });
  try {
    expect(reopened.setting(paidProcessingBlockedSetting, null)).toBeNull();
    expect(reopened.setting<any>("preferences", {}).provider_enabled).toBe(true);
  } finally {
    reopened.close();
  }
});
