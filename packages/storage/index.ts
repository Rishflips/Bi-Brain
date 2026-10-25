import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { basename, extname, dirname, resolve } from "node:path";
import {
  existsSync,
  writeFileSync,
  readFileSync,
  rmSync,
  renameSync,
} from "node:fs";
import { Vault, type PortableState } from "./vault.ts";
import { detectSecrets } from "./secrets.ts";
import { applyRestoreSafetyBarrier, withdrawAllAdvisories } from "./restore-policy.ts";
import { RECALL_DDL, fillRecallIndex, recallIndexComplete, rebuildRecallIndex } from "./recall-index.ts";
export class Storage {
  readonly db: DatabaseSync;
  vault?: Vault;
  private inTransaction = false;
  constructor(
    readonly path = resolve(process.env.BRAIN_DB ?? "data/brain.sqlite"),
    options: { vault?: string } = {},
  ) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    // The server and the worker open the same file at startup, so wait for the
    // other one's lock before the first read instead of failing at once.
    this.db.exec("PRAGMA busy_timeout=5000;");
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
      ) > 7
    ) {
      this.db.close();
      throw new Error(
        "Database is from a newer Bi Brain version. Use a matching application or restore a backup.",
      );
    }
    // Whether an operational database already existed before this constructor
    // initialized the schema. A fresh database combined with an existing vault
    // means knowledge survived but financial history did not.
    const existingOperationalDatabase = !!hasMigrations;
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
    this.transaction(() => {
      this.db
        .exec(`CREATE TABLE IF NOT EXISTS provider_dispatches(
      call_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(id),
      dispatch_key TEXT NOT NULL,
      stage TEXT NOT NULL CHECK(stage IN ('decision','reasoning','repair')),
      state TEXT NOT NULL CHECK(state IN ('reserved','dispatched','settled','released')),
      reserved_micro_usd INTEGER NOT NULL CHECK(reserved_micro_usd>=0),
      actual_micro_usd INTEGER CHECK(actual_micro_usd IS NULL OR actual_micro_usd>=0),
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      price_version TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      config_hash TEXT NOT NULL,
      identity_hash TEXT NOT NULL,
      budget_day TEXT NOT NULL,
      time_zone TEXT NOT NULL,
      created_at TEXT NOT NULL,
      dispatched_at TEXT,
      settled_at TEXT,
      UNIQUE(job_id,dispatch_key));
    CREATE INDEX IF NOT EXISTS provider_dispatches_job ON provider_dispatches(job_id,state);
    CREATE INDEX IF NOT EXISTS provider_dispatches_day ON provider_dispatches(budget_day,state);
    INSERT OR IGNORE INTO migrations VALUES(4,strftime('%Y-%m-%dT%H:%M:%fZ','now'));`);
    });
    // Tenant migration 5: the advisory decision attempt ledger and its hash-only
    // tombstones. The DDL and the version marker commit in ONE transaction, so a
    // failed marker rolls the whole new schema back and never leaves a half
    // migrated tenant. Operational only — never exported by `portableState()`.
    this.transaction(() => {
      this.db
        .exec(`CREATE TABLE IF NOT EXISTS advisory_attempts(
      idempotency_key TEXT PRIMARY KEY CHECK(length(idempotency_key)=64),
      job_id TEXT NOT NULL,
      dispatch_key TEXT NOT NULL CHECK(dispatch_key='decision'),
      project_id TEXT NOT NULL,
      goal_id TEXT NOT NULL,
      goal_entity_version INTEGER NOT NULL CHECK(goal_entity_version>=1),
      plan_version INTEGER NOT NULL CHECK(plan_version>=0),
      source_refs_json TEXT NOT NULL,
      request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
      config_hash TEXT NOT NULL CHECK(length(config_hash)=64),
      question_hash TEXT NOT NULL CHECK(length(question_hash)=64),
      owner TEXT NOT NULL,
      fence INTEGER NOT NULL CHECK(fence>=0),
      state TEXT NOT NULL CHECK(state IN ('claimed','published','unavailable')),
      advisory_id TEXT,
      claimed_at TEXT NOT NULL,
      updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS advisory_tombstones(
      idempotency_key TEXT PRIMARY KEY,
      question_hash TEXT NOT NULL,
      created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS advisory_attempts_goal ON advisory_attempts(goal_id,state);
    CREATE TRIGGER IF NOT EXISTS advisory_attempts_identity_immutable BEFORE UPDATE ON advisory_attempts
    WHEN NEW.idempotency_key<>OLD.idempotency_key OR NEW.job_id<>OLD.job_id OR NEW.dispatch_key<>OLD.dispatch_key
      OR NEW.project_id<>OLD.project_id OR NEW.goal_id<>OLD.goal_id OR NEW.goal_entity_version<>OLD.goal_entity_version
      OR NEW.plan_version<>OLD.plan_version OR NEW.source_refs_json<>OLD.source_refs_json OR NEW.request_hash<>OLD.request_hash
      OR NEW.config_hash<>OLD.config_hash OR NEW.question_hash<>OLD.question_hash OR NEW.owner<>OLD.owner
      OR NEW.fence<>OLD.fence OR NEW.claimed_at<>OLD.claimed_at
    BEGIN SELECT RAISE(ABORT,'advisory attempt identity is immutable'); END;
    INSERT OR IGNORE INTO migrations VALUES(5,strftime('%Y-%m-%dT%H:%M:%fZ','now'));`);
    });
    this.transaction(() => {
      const columns = this.all("PRAGMA table_info(grants)").map((c) => c.name);
      if (!columns.includes("client"))
        this.db.exec("ALTER TABLE grants ADD COLUMN client TEXT");
      if (!columns.includes("folder"))
        this.db.exec("ALTER TABLE grants ADD COLUMN folder TEXT");
      this.db.exec(
        "INSERT OR IGNORE INTO migrations VALUES(6,strftime('%Y-%m-%dT%H:%M:%fZ','now'));",
      );
    });
    // Migration 7: the derived recall index. DDL and marker commit together; the
    // backfill runs AFTER the constructor's vault checks, in short batches.
    this.transaction(() => {
      this.db.exec(RECALL_DDL);
      this.db.exec("INSERT OR IGNORE INTO migrations VALUES(7,strftime('%Y-%m-%dT%H:%M:%fZ','now'));");
    });
    const vaultRoot =
      options.vault ??
      (arguments.length === 0
        ? resolve(dirname(path), `${basename(path, extname(path))}.vault`)
        : undefined);
    if (vaultRoot && path !== ":memory:") {
      const vault = new Vault(vaultRoot);
      // Recovery case: the operational database is missing (no migrations yet)
      // but a vault manifest already exists, so the schema is about to be
      // rebuilt from the vault while any prior financial history is gone.
      // Block paid processing before the rebuild (and before any failure), so
      // restored knowledge can never silently re-enable paid work. A normal
      // first use (new vault) and a normal rebuild on an existing operational
      // database both keep paid processing unchanged.
      const recoveringFromExistingVault =
        !existingOperationalDatabase &&
        existsSync(resolve(vault.root, "manifest.json"));
      if (recoveringFromExistingVault) applyRestoreSafetyBarrier(this);
      this.vault = vault;
      vault.withLock(() => {
        // A pending journal is only publishable if its operational transaction committed.
        const journalPath = resolve(vault.protectedRoot, "journal.json");
        if (existsSync(journalPath)) {
          const pending = JSON.parse(readFileSync(journalPath, "utf8"));
          if (this.setting("vault_generation", "") === pending.generation)
            vault.recover();
          else rmSync(journalPath);
        }
        if (!existsSync(resolve(vault.root, "manifest.json"))) {
          const backupPath = resolve(vault.protectedRoot, "pre-vault.sqlite");
          if (!existsSync(backupPath))
            this.db.prepare("VACUUM INTO ?").run(backupPath);
          this.transaction(() => {
            for (const v of this.all("SELECT * FROM source_versions")) {
              const result = vault.capture(
                v.source_id,
                v.version,
                v.body,
                detectSecrets(v.title).length > 0,
              );
              if (result.quarantined)
                this.run(
                  "UPDATE source_versions SET body=?,title=? WHERE source_id=? AND version=?",
                  "[Quarantined: suspected secret. Original retained outside the vault.]",
                  "Quarantined source",
                  v.source_id,
                  v.version,
                );
            }
            // Existing derived text containing suspected credentials is never migrated into Git.
            for (const e of this.all("SELECT * FROM entities")) {
              if (
                detectSecrets(e.data).length ||
                this.all(
                  "SELECT data FROM entity_versions WHERE entity_id=?",
                  e.id,
                ).some((v) => detectSecrets(v.data).length)
              )
                this.run("DELETE FROM entities WHERE id=?", e.id);
            }
            this.run("DELETE FROM source_fts");
            this.run(
              "INSERT INTO source_fts SELECT s.id,v.title,v.body FROM sources s JOIN source_versions v ON s.id=v.source_id AND s.version=v.version WHERE s.state='active'",
            );
            fillRecallIndex(this);
          });
          writeFileSync(
            resolve(vault.protectedRoot, "migration.json"),
            JSON.stringify({
              schema: 1,
              backup: backupPath,
              sources: this.all("SELECT id FROM sources").length,
              stable_ids: true,
            }),
            { mode: 0o600 },
          );
        }
        if (!existsSync(resolve(vault.root, "manifest.json")))
          this.transaction(() => {});
        const sanitation = resolve(vault.protectedRoot, "sanitize.pending");
        if (existsSync(sanitation)) {
          const pending = JSON.parse(readFileSync(sanitation, "utf8"));
          if (pending.source_id) {
            const source = this.get(
              "SELECT state FROM sources WHERE id=?",
              pending.source_id,
            );
            if (source?.state !== "deleted")
              throw new Error(
                "Pending vault erasure has no matching deletion tombstone.",
              );
            vault.forget(pending.source_id, this.portableState());
          } else vault.sanitizeManagedHistory(this.portableState());
        }
        if (
          JSON.stringify(this.portableState()) !== JSON.stringify(vault.read())
        )
          this.rebuild();
      });
      // A snapshot rebuilt from an existing vault must not leave restored
      // advisories actively readable. Withdraw them AFTER the rebuild, in one
      // transaction so the operational database and the vault stay consistent
      // (a later reopen cannot silently rebuild the withdrawn state away).
      if (recoveringFromExistingVault)
        this.transaction(() => withdrawAllAdvisories(this, () => new Date()));
    }
    if (!recallIndexComplete(this)) this.rebuildRecallIndex();
  }
  sanitizeMigrationBackup() {
    if (!this.vault) return { configured: false, sanitized: false };
    const backupPath = resolve(this.vault.protectedRoot, "pre-vault.sqlite");
    if (!existsSync(backupPath)) return { configured: false, sanitized: true };
    const next = backupPath + ".sanitized";
    rmSync(next, { force: true });
    this.db.prepare("VACUUM INTO ?").run(next);
    rmSync(backupPath);
    renameSync(next, backupPath);
    return { configured: true, sanitized: true };
  }
  verifyMigrationBackup(id: string) {
    if (!this.vault) return { configured: false, absent: true };
    const backupPath = resolve(this.vault.protectedRoot, "pre-vault.sqlite");
    if (!existsSync(backupPath)) return { configured: false, absent: true };
    const backup = new DatabaseSync(backupPath, { readOnly: true });
    try {
      const originals = Number(
        backup
          .prepare(
            "SELECT count(*) AS n FROM source_versions WHERE source_id=?",
          )
          .get(id)?.n ?? 0,
      );
      const search = Number(
        backup
          .prepare("SELECT count(*) AS n FROM source_fts WHERE source_id=?")
          .get(id)?.n ?? 0,
      );
      const derived =
        Number(
          backup
            .prepare("SELECT count(*) AS n FROM entities WHERE data LIKE ?")
            .get(`%${id}%`)?.n ?? 0,
        ) +
        Number(
          backup
            .prepare(
              "SELECT count(*) AS n FROM entity_versions WHERE data LIKE ?",
            )
            .get(`%${id}%`)?.n ?? 0,
        );
      return {
        configured: true,
        absent: originals === 0 && search === 0 && derived === 0,
        originals,
        search,
        derived,
      };
    } finally {
      backup.close();
    }
  }
  run(
    sql: string,
    ...args: any[]
  ): ReturnType<DatabaseSync["prepare"]>["run"] extends (
    ...args: any[]
  ) => infer R
    ? R
    : never {
    if (
      this.vault &&
      !this.inTransaction &&
      /^(INSERT INTO|UPDATE|DELETE FROM) (projects|sources|source_versions|entities|entity_versions)\b/i.test(
        sql.trim(),
      )
    )
      return this.transaction(() => this.run(sql, ...args));
    return this.db.prepare(sql).run(...args);
  }
  get<T = Record<string, any>>(sql: string, ...args: any[]): T | undefined {
    return this.db.prepare(sql).get(...args) as T | undefined;
  }
  all<T = Record<string, any>>(sql: string, ...args: any[]): T[] {
    return this.db.prepare(sql).all(...args) as T[];
  }
  transaction<T>(fn: () => T): T {
    return this.vault
      ? this.vault.withLock(() => this.transactionLocked(fn))
      : this.transactionLocked(fn);
  }
  private transactionLocked<T>(fn: () => T): T {
    if (this.vault) {
      const pendingPath = resolve(this.vault.protectedRoot, "journal.json");
      if (existsSync(pendingPath)) {
        const pending = JSON.parse(readFileSync(pendingPath, "utf8"));
        if (this.setting("vault_generation", "") === pending.generation)
          this.vault.recover();
        else rmSync(pendingPath);
      }
    }
    this.db.exec("BEGIN IMMEDIATE");
    this.inTransaction = true;
    let result: T;
    let journal: ReturnType<Vault["stage"]> | undefined;
    try {
      result = fn();
      if (this.vault) {
        const state = this.portableState();
        const manifestExists = existsSync(
          resolve(this.vault.root, "manifest.json"),
        );
        if (
          !manifestExists ||
          JSON.stringify(state) !== JSON.stringify(this.vault.read())
        ) {
          journal = this.vault.stage(state);
          this.set("vault_generation", journal.generation);
        }
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    } finally {
      this.inTransaction = false;
    }
    if (journal) this.vault!.publish(journal);
    return result;
  }
  portableState(): PortableState {
    return {
      projects: this.all("SELECT * FROM projects ORDER BY id"),
      sources: this.all("SELECT * FROM sources ORDER BY id"),
      source_versions: this.all(
        "SELECT * FROM source_versions ORDER BY source_id,version",
      ),
      entities: this.all("SELECT * FROM entities ORDER BY id"),
      entity_versions: this.all(
        "SELECT * FROM entity_versions ORDER BY entity_id,version",
      ),
    };
  }
  rebuild() {
    if (!this.vault) throw new Error("No managed vault configured");
    const state = this.vault.read();
    this.transaction(() => {
      for (const table of [
        "entity_versions",
        "entities",
        "source_versions",
        "sources",
      ])
        this.run(`DELETE FROM ${table}`);
      for (const table of [
        "projects",
        "sources",
        "source_versions",
        "entities",
        "entity_versions",
      ] as const)
        for (const row of state[table]) {
          const keys = Object.keys(row);
          if (table === "projects")
            this.run(
              "INSERT INTO projects(id,title,created_at) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title",
              row.id,
              row.title,
              row.created_at,
            );
          else
            this.run(
              `INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
              ...keys.map((k) => row[k]),
            );
        }
      this.run("DELETE FROM source_fts");
      this.run(
        "INSERT INTO source_fts SELECT s.id,v.title,v.body FROM sources s JOIN source_versions v ON s.id=v.source_id AND s.version=v.version WHERE s.state='active'",
      );
      fillRecallIndex(this);
    });
  }
  /** Rebuilds the derived recall index in batches of 200 sources per transaction. Idempotent. */
  rebuildRecallIndex() {
    rebuildRecallIndex(this, 200);
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
