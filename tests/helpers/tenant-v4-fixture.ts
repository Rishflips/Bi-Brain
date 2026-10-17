import { DatabaseSync } from "node:sqlite";

/**
 * FROZEN verbatim tenant schema-4 DDL captured from commit
 * `5fbb3a1:packages/storage/index.ts`. This is the real old tenant schema (WAL
 * mode, forward-only `migrations` table, legacy `reservations` and the S1
 * `provider_dispatches` money ledger), NOT a freshly created runtime database
 * with a downgraded version marker. Do NOT edit to track the current schema; it
 * exists only so the advisory migration test proves a genuine v4 -> v5 upgrade.
 */
export const TENANT_V4_DDL = `
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

export const TENANT_V4_SCHEMA_VERSION = 4 as const;

/**
 * Creates a genuine schema-4 tenant database at `path` and performs the same
 * first-use bootstrap the old runtime did (inbox project, WAL, foreign keys).
 * It never touches the new runtime migrator. Returns a closed handle.
 */
export function createTenantV4(
  path: string,
  at = "2026-10-17T12:00:00.000Z",
): void {
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;");
    db.exec(TENANT_V4_DDL);
    db.prepare("INSERT INTO projects VALUES(?,?,?)").run(
      "inbox",
      "SYNTHETIC original project",
      at,
    );
  } finally {
    db.close();
  }
}
