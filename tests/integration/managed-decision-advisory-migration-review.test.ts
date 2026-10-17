import { expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Storage } from "../../packages/storage/index.ts";

// Frozen tenant-v4 DDL from 5fbb3a1:packages/storage/index.ts. This creates the
// actual old schema, not a new runtime database with a downgraded version marker.
// Keep it independent of the new migrator and its own fixture helper.
const V4_DDL = `
CREATE TABLE migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL);
CREATE TABLE projects(id TEXT PRIMARY KEY,title TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE sources(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),version INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN ('active','withdrawn','deleted')),visibility TEXT NOT NULL CHECK(visibility IN ('private','project')),origin TEXT NOT NULL,captured_at TEXT NOT NULL);
CREATE TABLE source_versions(source_id TEXT NOT NULL REFERENCES sources(id),version INTEGER NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(source_id,version));
CREATE VIRTUAL TABLE source_fts USING fts5(source_id UNINDEXED,title,body);
CREATE TABLE entities(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),kind TEXT NOT NULL,version INTEGER NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE entity_versions(entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,version INTEGER NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(entity_id,version));
CREATE TABLE jobs(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),kind TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',attempts INTEGER NOT NULL DEFAULT 0,max_attempts INTEGER NOT NULL DEFAULT 3,next_at TEXT NOT NULL,lease_owner TEXT,lease_until TEXT,fence INTEGER NOT NULL DEFAULT 0,error TEXT,result_id TEXT,created_at TEXT NOT NULL,deadline_at TEXT);
CREATE TABLE grants(id TEXT PRIMARY KEY,token_hash TEXT UNIQUE NOT NULL,projects TEXT NOT NULL,operations TEXT NOT NULL,expires_at TEXT NOT NULL,revoked_at TEXT,last_verified_at TEXT);
CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,csrf TEXT NOT NULL,expires_at TEXT NOT NULL);
CREATE TABLE idempotency(principal TEXT NOT NULL,operation TEXT NOT NULL,key TEXT NOT NULL,hash TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(principal,operation,key));
CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE reservations(job_id TEXT PRIMARY KEY REFERENCES jobs(id),day TEXT NOT NULL,reserved INTEGER NOT NULL CHECK(reserved>=0),actual INTEGER NOT NULL DEFAULT 0 CHECK(actual>=0),status TEXT NOT NULL);
CREATE TABLE imports(id TEXT PRIMARY KEY,manifest TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE source_changes(seq INTEGER PRIMARY KEY AUTOINCREMENT,source_id TEXT NOT NULL,project_id TEXT NOT NULL,version INTEGER NOT NULL,state TEXT NOT NULL);
CREATE TRIGGER source_insert_change AFTER INSERT ON sources BEGIN INSERT INTO source_changes(source_id,project_id,version,state) VALUES(new.id,new.project_id,new.version,new.state); END;
CREATE TRIGGER source_update_change AFTER UPDATE ON sources BEGIN INSERT INTO source_changes(source_id,project_id,version,state) VALUES(new.id,new.project_id,new.version,new.state); END;
CREATE INDEX sources_project ON sources(project_id,state,visibility);
CREATE INDEX entities_project_kind ON entities(project_id,kind);
CREATE INDEX jobs_ready ON jobs(status,next_at,lease_until);
CREATE TABLE provider_dispatches(
call_id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES jobs(id),dispatch_key TEXT NOT NULL,
stage TEXT NOT NULL CHECK(stage IN ('decision','reasoning','repair')),
state TEXT NOT NULL CHECK(state IN ('reserved','dispatched','settled','released')),
reserved_micro_usd INTEGER NOT NULL CHECK(reserved_micro_usd>=0),actual_micro_usd INTEGER CHECK(actual_micro_usd IS NULL OR actual_micro_usd>=0),
provider TEXT NOT NULL,model TEXT NOT NULL,price_version TEXT NOT NULL,request_hash TEXT NOT NULL,config_hash TEXT NOT NULL,identity_hash TEXT NOT NULL,
budget_day TEXT NOT NULL,time_zone TEXT NOT NULL,created_at TEXT NOT NULL,dispatched_at TEXT,settled_at TEXT,UNIQUE(job_id,dispatch_key));
CREATE INDEX provider_dispatches_job ON provider_dispatches(job_id,state);
CREATE INDEX provider_dispatches_day ON provider_dispatches(budget_day,state);
INSERT INTO migrations VALUES(1,'2026-10-16T00:00:00Z'),(2,'2026-10-16T00:00:00Z'),(3,'2026-10-16T00:00:00Z'),(4,'2026-10-16T00:00:00Z');
`;
const at = "2026-10-17T12:00:00.000Z";
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "brain-advisory-v4-parent-")), path = join(root, "brain.sqlite");
  const db = new DatabaseSync(path);
  let initialized = false;
  try {
    db.exec("PRAGMA foreign_keys=ON");
    db.exec(V4_DDL);
    db.prepare("INSERT INTO projects VALUES(?,?,?)").run("inbox", "SYNTHETIC original project", at);
    db.prepare("INSERT INTO sources VALUES(?,?,?,?,?,?,?)").run("synthetic-source", "inbox", 1, "active", "project", "note", at);
    db.prepare("INSERT INTO source_versions VALUES(?,?,?,?,?)").run("synthetic-source", 1, "SYNTHETIC source", "SYNTHETIC_RETAINED_ORIGINAL", at);
    db.prepare("INSERT INTO source_fts VALUES(?,?,?)").run("synthetic-source", "SYNTHETIC source", "SYNTHETIC_RETAINED_ORIGINAL");
    db.prepare("INSERT INTO settings VALUES(?,?)").run("preferences", JSON.stringify({ enabled: true, provider_enabled: true, decision_provider_enabled: true }));
    const data = JSON.stringify({ title: "SYNTHETIC original goal", plan_version: 0, status: "active", preparation_enabled: true });
    db.prepare("INSERT INTO entities VALUES(?,?,?,?,?,?)").run("synthetic-goal", "inbox", "goal", 1, data, at);
    db.prepare("INSERT INTO entity_versions VALUES(?,?,?,?)").run("synthetic-goal", 1, data, at);
    for (const state of ["reserved", "dispatched", "settled"]) {
      const job = `synthetic-job-${state}`;
      db.prepare("INSERT INTO jobs(id,project_id,kind,payload,next_at,created_at) VALUES(?,?,?,?,?,?)").run(job, "inbox", "review_changed_assumption", JSON.stringify({ goal_id: "synthetic-goal", principal: { kind: "owner" } }), at, at);
      db.prepare("INSERT INTO provider_dispatches VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(
        `synthetic-call-${state}`, job, "reasoning", "reasoning", state, 19, state === "settled" ? 7 : null,
        "synthetic-provider", "synthetic-model", "synthetic-price-v1", "a".repeat(64), "b".repeat(64), "c".repeat(64),
        "2026-10-17", "UTC", at, state === "reserved" ? null : at, state === "settled" ? at : null,
      );
      db.prepare("INSERT INTO reservations VALUES(?,?,?,?,?)").run(job, "2026-10-17", 5, 0, "reserved");
    }
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='advisory_attempts'").get()).toBeUndefined();
    const before = {
      dispatches: db.prepare("SELECT * FROM provider_dispatches ORDER BY call_id").all(),
      legacy: db.prepare("SELECT * FROM reservations ORDER BY job_id").all(),
      sources: db.prepare("SELECT * FROM source_versions ORDER BY source_id,version").all(),
      goals: db.prepare("SELECT * FROM entities ORDER BY id").all(),
      prefs: db.prepare("SELECT * FROM settings ORDER BY key").all(),
    };
    initialized = true;
    return { root, path, before, close: () => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) };
  } finally {
    db.close();
    if (!initialized) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

it("migrates a genuine tenant v4 database without rewriting original content, raw consent or any money state", () => {
  const f = fixture();
  let store: Storage | undefined;
  try {
    store = new Storage(f.path);
    expect(store.get("SELECT MAX(version) AS version FROM migrations")?.version).toBe(5);
    expect(store.get("SELECT name FROM sqlite_master WHERE type='table' AND name='advisory_attempts'")?.name).toBe("advisory_attempts");
    expect(store.all("SELECT * FROM provider_dispatches ORDER BY call_id")).toEqual(f.before.dispatches);
    expect(store.all("SELECT * FROM reservations ORDER BY job_id")).toEqual(f.before.legacy);
    expect(store.all("SELECT * FROM source_versions ORDER BY source_id,version")).toEqual(f.before.sources);
    expect(store.all("SELECT * FROM entities ORDER BY id")).toEqual(f.before.goals);
    expect(store.all("SELECT * FROM settings ORDER BY key")).toEqual(f.before.prefs);
    store.close(); store = new Storage(f.path);
    expect(store.get("SELECT COUNT(*) AS count FROM migrations WHERE version=5")?.count).toBe(1);
    expect(store.all("SELECT * FROM provider_dispatches ORDER BY call_id")).toEqual(f.before.dispatches);
  } finally { store?.close(); f.close(); }
});

it("rolls back new advisory DDL if the v5 marker fails, preserving old holds and originals", () => {
  const f = fixture();
  try {
    const db = new DatabaseSync(f.path);
    db.exec("CREATE TRIGGER synthetic_block_v5 BEFORE INSERT ON migrations WHEN NEW.version=5 BEGIN SELECT RAISE(ABORT,'SYNTHETIC v5 marker failure'); END;");
    db.close();
    // A separate process also proves failure does not depend on a retained
    // constructor handle; the OS closes all its SQLite handles on exit.
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
      "import { Storage } from './packages/storage/index.ts'; new Storage(process.argv[1]);", f.path],
    { cwd: process.cwd(), encoding: "utf8", timeout: 20_000 });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("SYNTHETIC v5 marker failure");
    const check = new DatabaseSync(f.path);
    try {
      expect(check.prepare("SELECT MAX(version) AS version FROM migrations").get()?.version).toBe(4);
      expect(check.prepare("SELECT name FROM sqlite_master WHERE name='advisory_attempts'").get()).toBeUndefined();
      expect(check.prepare("SELECT * FROM provider_dispatches ORDER BY call_id").all()).toEqual(f.before.dispatches);
      expect(check.prepare("SELECT * FROM source_versions ORDER BY source_id,version").all()).toEqual(f.before.sources);
    } finally { check.close(); }
  } finally { f.close(); }
});

it("refuses a future tenant schema without changing retained data or financial ambiguity", () => {
  const f = fixture();
  try {
    const db = new DatabaseSync(f.path);
    db.prepare("INSERT INTO migrations VALUES(?,?)").run(6, at);
    db.close();
    expect(() => new Storage(f.path)).toThrow(/newer Bi Brain version/);
    const check = new DatabaseSync(f.path);
    try {
      expect(check.prepare("SELECT MAX(version) AS version FROM migrations").get()?.version).toBe(6);
      expect(check.prepare("SELECT * FROM provider_dispatches ORDER BY call_id").all()).toEqual(f.before.dispatches);
      expect(check.prepare("SELECT * FROM source_versions ORDER BY source_id,version").all()).toEqual(f.before.sources);
    } finally { check.close(); }
  } finally { f.close(); }
});
