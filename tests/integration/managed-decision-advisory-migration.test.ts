import { expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Storage } from "../../packages/storage/index.ts";
import {
  createTenantV4,
} from "../helpers/tenant-v4-fixture.ts";

/**
 * Executor-owned advisory migration gate. It starts from the genuine frozen v4
 * DDL in `tests/helpers/tenant-v4-fixture.ts` (not a downgraded runtime), so a
 * real old database with reserved / dispatched-unknown / settled money rows,
 * legacy reservations, original source bodies, a goal and raw consent migrates
 * forward without rewriting any of them.
 */

const AT = "2026-10-17T12:00:00.000Z";

function seeded() {
  const dir = mkdtempSync(join(tmpdir(), "brain-advisory-v4-"));
  const path = join(dir, "brain.sqlite");
  createTenantV4(path, AT);
  const db = new DatabaseSync(path);
  try {
    db.prepare("INSERT INTO sources VALUES(?,?,?,?,?,?,?)").run(
      "synthetic-source",
      "inbox",
      1,
      "active",
      "project",
      "note",
      AT,
    );
    db.prepare("INSERT INTO source_versions VALUES(?,?,?,?,?)").run(
      "synthetic-source",
      1,
      "SYNTHETIC source",
      "SYNTHETIC_RETAINED_ORIGINAL",
      AT,
    );
    db.prepare("INSERT INTO source_fts VALUES(?,?,?)").run(
      "synthetic-source",
      "SYNTHETIC source",
      "SYNTHETIC_RETAINED_ORIGINAL",
    );
    db.prepare("INSERT INTO settings VALUES(?,?)").run(
      "preferences",
      JSON.stringify({
        enabled: true,
        provider_enabled: true,
        decision_provider_enabled: true,
      }),
    );
    const goal = JSON.stringify({
      title: "SYNTHETIC original goal",
      plan_version: 0,
      status: "active",
      preparation_enabled: true,
    });
    db.prepare("INSERT INTO entities VALUES(?,?,?,?,?,?)").run(
      "synthetic-goal",
      "inbox",
      "goal",
      1,
      goal,
      AT,
    );
    db.prepare("INSERT INTO entity_versions VALUES(?,?,?,?)").run(
      "synthetic-goal",
      1,
      goal,
      AT,
    );
    for (const state of ["reserved", "dispatched", "settled"]) {
      const job = `synthetic-job-${state}`;
      db.prepare(
        "INSERT INTO jobs(id,project_id,kind,payload,next_at,created_at) VALUES(?,?,?,?,?,?)",
      ).run(
        job,
        "inbox",
        "review_changed_assumption",
        JSON.stringify({ goal_id: "synthetic-goal", principal: { kind: "owner" } }),
        AT,
        AT,
      );
      db.prepare("INSERT INTO provider_dispatches VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
        `synthetic-call-${state}`,
        job,
        "reasoning",
        "reasoning",
        state,
        19,
        state === "settled" ? 7 : null,
        "synthetic-provider",
        "synthetic-model",
        "synthetic-price-v1",
        "a".repeat(64),
        "b".repeat(64),
        "c".repeat(64),
        "2026-10-17",
        "UTC",
        AT,
        state === "reserved" ? null : AT,
        state === "settled" ? AT : null,
      );
      db.prepare("INSERT INTO reservations VALUES(?,?,?,?,?)").run(
        job,
        "2026-10-17",
        5,
        0,
        "reserved",
      );
    }
    const before = {
      dispatches: db.prepare("SELECT * FROM provider_dispatches ORDER BY call_id").all(),
      legacy: db.prepare("SELECT * FROM reservations ORDER BY job_id").all(),
      sources: db.prepare("SELECT * FROM source_versions ORDER BY source_id,version").all(),
      entities: db.prepare("SELECT * FROM entities ORDER BY id").all(),
      prefs: db.prepare("SELECT * FROM settings ORDER BY key").all(),
    };
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name='advisory_attempts'").get(),
    ).toBeUndefined();
    return { dir, path, before, cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) };
  } finally {
    db.close();
  }
}

it("migrates a genuine tenant v4 database to 5 without rewriting originals, raw consent or money state", () => {
  const f = seeded();
  let store: Storage | undefined;
  try {
    store = new Storage(f.path);
    expect(store.get("SELECT MAX(version) AS version FROM migrations")?.version).toBe(6);
    expect(
      store.get("SELECT name FROM sqlite_master WHERE type='table' AND name='advisory_attempts'")?.name,
    ).toBe("advisory_attempts");
    expect(
      store.get("SELECT name FROM sqlite_master WHERE type='table' AND name='advisory_tombstones'")?.name,
    ).toBe("advisory_tombstones");
    expect(store.all("SELECT * FROM provider_dispatches ORDER BY call_id")).toEqual(f.before.dispatches);
    expect(store.all("SELECT * FROM reservations ORDER BY job_id")).toEqual(f.before.legacy);
    expect(store.all("SELECT * FROM source_versions ORDER BY source_id,version")).toEqual(f.before.sources);
    expect(store.all("SELECT * FROM entities ORDER BY id")).toEqual(f.before.entities);
    expect(store.all("SELECT * FROM settings ORDER BY key")).toEqual(f.before.prefs);
    // Reopening an already-migrated v5 database is an idempotent no-op.
    store.close();
    store = new Storage(f.path);
    expect(store.get("SELECT COUNT(*) AS count FROM migrations WHERE version=5")?.count).toBe(1);
    expect(store.get("SELECT MAX(version) AS version FROM migrations")?.version).toBe(6);
    expect(store.all("SELECT * FROM provider_dispatches ORDER BY call_id")).toEqual(f.before.dispatches);
  } finally {
    store?.close();
    f.cleanup();
  }
});

it("rolls the whole advisory DDL back if the v5 marker write fails, holding originals and money", () => {
  const f = seeded();
  try {
    const db = new DatabaseSync(f.path);
    db.exec(
      "CREATE TRIGGER synthetic_block_v5 BEFORE INSERT ON migrations WHEN NEW.version=5 BEGIN SELECT RAISE(ABORT,'SYNTHETIC v5 marker failure'); END;",
    );
    db.close();
    // A separate process proves the rollback does not depend on a retained
    // constructor handle; the OS closes its SQLite handles on exit.
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e",
        "import { Storage } from './packages/storage/index.ts'; new Storage(process.argv[1]);", f.path],
      { cwd: process.cwd(), encoding: "utf8", timeout: 20_000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("SYNTHETIC v5 marker failure");
    const check = new DatabaseSync(f.path);
    try {
      expect(check.prepare("SELECT MAX(version) AS version FROM migrations").get()?.version).toBe(4);
      expect(check.prepare("SELECT name FROM sqlite_master WHERE name='advisory_attempts'").get()).toBeUndefined();
      expect(check.prepare("SELECT name FROM sqlite_master WHERE name='advisory_tombstones'").get()).toBeUndefined();
      expect(check.prepare("SELECT * FROM provider_dispatches ORDER BY call_id").all()).toEqual(f.before.dispatches);
      expect(check.prepare("SELECT * FROM source_versions ORDER BY source_id,version").all()).toEqual(f.before.sources);
      expect(check.prepare("SELECT * FROM settings ORDER BY key").all()).toEqual(f.before.prefs);
    } finally {
      check.close();
    }
  } finally {
    f.cleanup();
  }
});

it("refuses a tenant schema newer than 6 without changing retained data", () => {
  const f = seeded();
  try {
    const db = new DatabaseSync(f.path);
    db.prepare("INSERT INTO migrations VALUES(?,?)").run(7, AT);
    db.close();
    expect(() => new Storage(f.path)).toThrow(/newer Bi Brain version/);
    const check = new DatabaseSync(f.path);
    try {
      expect(check.prepare("SELECT MAX(version) AS version FROM migrations").get()?.version).toBe(7);
      expect(check.prepare("SELECT * FROM provider_dispatches ORDER BY call_id").all()).toEqual(f.before.dispatches);
      expect(check.prepare("SELECT * FROM source_versions ORDER BY source_id,version").all()).toEqual(f.before.sources);
      expect(check.prepare("SELECT name FROM sqlite_master WHERE name='advisory_attempts'").get()).toBeUndefined();
    } finally {
      check.close();
    }
  } finally {
    f.cleanup();
  }
});
