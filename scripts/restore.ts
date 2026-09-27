import { DatabaseSync, backup } from "node:sqlite";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { resolve, relative, isAbsolute, join } from "node:path";
import { Storage } from "../packages/storage/index.ts";
import { Brain } from "../packages/domain/service.ts";
const root = resolve("data/backups");
const source = resolve(root, process.argv[2] ?? "");
const rel = relative(root, source);
if (!rel || rel.startsWith("..") || isAbsolute(rel) || !existsSync(source))
  throw new Error("Choose an existing SQLite backup inside data/backups.");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const dir = resolve("data", "restored-" + stamp);
if (existsSync(dir)) throw new Error("Restore destination exists.");
mkdirSync(dir, { recursive: true });
const db = new DatabaseSync(source, { readOnly: true });
if (
  db.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok" ||
  db.prepare("PRAGMA foreign_key_check").all().length
)
  throw new Error("Backup integrity check failed.");
await backup(db, join(dir, "brain.sqlite"));
db.close();
const restored = new Storage(join(dir, "brain.sqlite"));
const currentPath = resolve(process.env.BRAIN_DB ?? "data/brain.sqlite");
let applied = 0;
if (existsSync(currentPath) && currentPath !== source) {
  const current = new DatabaseSync(currentPath, { readOnly: true });
  try {
    for (const tomb of current
      .prepare(
        "SELECT id,state FROM sources WHERE state IN ('deleted','withdrawn')",
      )
      .all()) {
      const retained = restored.get(
        "SELECT version,state FROM sources WHERE id=?",
        tomb.id,
      );
      if (retained && retained.state !== "deleted") {
        new Brain(restored).removeSource(
          { kind: "owner" },
          String(tomb.id),
          retained.version,
          tomb.state === "deleted",
        );
        applied++;
      }
    }
  } finally {
    current.close();
  }
}
restored.run("DELETE FROM sessions");
restored.run("UPDATE grants SET revoked_at=?", new Date().toISOString());
restored.close();
writeFileSync(
  join(dir, "RESTORE_NOTICE.txt"),
  `Sensitive operational restore. Applied ${applied} currently available local deletion/withdrawal tombstones. All browser sessions and agent grants were revoked. Review later deletions from any other copies before use. Start with BRAIN_DB pointing to this brain.sqlite; do not replace a running database. A new pairing code will be created in this folder.`,
);
console.log(
  "Restored to a new directory under data. Review retained content and deletions before use.",
);
