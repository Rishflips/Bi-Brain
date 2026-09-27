import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
export class Storage {
  readonly db: DatabaseSync;
  constructor(
    readonly path = resolve(process.env.BRAIN_DB ?? "data/brain.sqlite"),
  ) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    const hasMigrations = this.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='migrations'",
      )
      .get();
    if (
      hasMigrations &&
      Number(
        this.db.prepare("SELECT max(version) AS version FROM migrations").get()
          ?.version,
      ) > 3
    ) {
      this.db.close();
      throw new Error(
        "Database is from a newer Bi Brain version. Use a matching application or restore a backup.",
      );
    }
    this.db.exec(
      "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;",
    );
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,title TEXT NOT NULL,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),version INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN ('active','withdrawn','deleted')),visibility TEXT NOT NULL CHECK(visibility IN ('private','project')),origin TEXT NOT NULL,captured_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS source_versions(source_id TEXT NOT NULL REFERENCES sources(id),version INTEGER NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(source_id,version));
  CREATE VIRTUAL TABLE IF NOT EXISTS source_fts USING fts5(source_id UNINDEXED,title,body);
  CREATE TABLE IF NOT EXISTS entities(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),kind TEXT NOT NULL,version INTEGER NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS entity_versions(entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,version INTEGER NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(entity_id,version));
  CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),kind TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',attempts INTEGER NOT NULL DEFAULT 0,max_attempts INTEGER NOT NULL DEFAULT 3,next_at TEXT NOT NULL,lease_owner TEXT,lease_until TEXT,fence INTEGER NOT NULL DEFAULT 0,error TEXT,result_id TEXT,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS grants(id TEXT PRIMARY KEY,token_hash TEXT UNIQUE NOT NULL,projects TEXT NOT NULL,operations TEXT NOT NULL,expires_at TEXT NOT NULL,revoked_at TEXT,last_verified_at TEXT);
  CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,csrf TEXT NOT NULL,expires_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS idempotency(principal TEXT NOT NULL,operation TEXT NOT NULL,key TEXT NOT NULL,hash TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(principal,operation,key));
  CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS reservations(job_id TEXT PRIMARY KEY REFERENCES jobs(id),day TEXT NOT NULL,reserved INTEGER NOT NULL CHECK(reserved>=0),actual INTEGER NOT NULL DEFAULT 0 CHECK(actual>=0),status TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS imports(id TEXT PRIMARY KEY,manifest TEXT NOT NULL,created_at TEXT NOT NULL);
  INSERT OR IGNORE INTO migrations VALUES(1,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
  INSERT OR IGNORE INTO projects VALUES('inbox','Inbox',strftime('%Y-%m-%dT%H:%M:%fZ','now'));`);
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS source_changes(seq INTEGER PRIMARY KEY AUTOINCREMENT,source_id TEXT NOT NULL,project_id TEXT NOT NULL,version INTEGER NOT NULL,state TEXT NOT NULL);
    INSERT INTO source_changes(source_id,project_id,version,state) SELECT id,project_id,version,state FROM sources s WHERE NOT EXISTS(SELECT 1 FROM source_changes c WHERE c.source_id=s.id);
    CREATE TRIGGER IF NOT EXISTS source_insert_change AFTER INSERT ON sources BEGIN INSERT INTO source_changes(source_id,project_id,version,state) VALUES(new.id,new.project_id,new.version,new.state); END;
    CREATE TRIGGER IF NOT EXISTS source_update_change AFTER UPDATE ON sources BEGIN INSERT INTO source_changes(source_id,project_id,version,state) VALUES(new.id,new.project_id,new.version,new.state); END;
    INSERT OR IGNORE INTO migrations VALUES(2,strftime('%Y-%m-%dT%H:%M:%fZ','now'));`);
    this.transaction(() => {
      if (
        !this.all("PRAGMA table_info(jobs)").some(
          (c) => c.name === "deadline_at",
        )
      )
        this.db.exec("ALTER TABLE jobs ADD COLUMN deadline_at TEXT");
      this.db
        .exec(`CREATE INDEX IF NOT EXISTS sources_project ON sources(project_id,state,visibility);
      CREATE INDEX IF NOT EXISTS entities_project_kind ON entities(project_id,kind);
      CREATE INDEX IF NOT EXISTS jobs_ready ON jobs(status,next_at,lease_until);
      INSERT OR IGNORE INTO migrations VALUES(3,strftime('%Y-%m-%dT%H:%M:%fZ','now'));`);
    });
  }
  run(sql: string, ...args: any[]) {
    return this.db.prepare(sql).run(...args);
  }
  get<T = Record<string, any>>(sql: string, ...args: any[]): T | undefined {
    return this.db.prepare(sql).get(...args) as T | undefined;
  }
  all<T = Record<string, any>>(sql: string, ...args: any[]): T[] {
    return this.db.prepare(sql).all(...args) as T[];
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  setting<T>(key: string, fallback: T): T {
    const row = this.get("SELECT value FROM settings WHERE key=?", key);
    return row ? JSON.parse(row.value) : fallback;
  }
  set(key: string, value: unknown) {
    this.run(
      "INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      key,
      JSON.stringify(value),
    );
  }
  close() {
    this.db.close();
  }
}
