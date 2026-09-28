import { existsSync, copyFileSync, readFileSync } from "node:fs";
import { resolve, dirname, join, basename, extname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Storage } from "../packages/storage/index.ts";
const mode = process.argv[2];
const dbPath = resolve(process.env.BRAIN_DB ?? "data/brain.sqlite");
const root = resolve(
  process.env.BRAIN_VAULT ??
    join(dirname(dbPath), `${basename(dbPath, extname(dbPath))}.vault`),
);
if (mode === "dry-run") {
  if (!existsSync(dbPath))
    throw new Error("No existing database; run db:migrate for a new vault.");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const count = (table: string) =>
      Number(
        db.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.count ?? 0,
      );
    console.log(
      JSON.stringify({
        path: dbPath,
        vault: root,
        projects: count("projects"),
        sources: count("sources"),
        versions: count("source_versions"),
        entities: count("entities"),
        action: "dry-run only; no data changed",
      }),
    );
  } finally {
    db.close();
  }
} else if (mode === "migrate" || mode === "rebuild") {
  const s = new Storage(dbPath, { vault: root });
  try {
    if (mode === "rebuild") s.rebuild();
    console.log(
      JSON.stringify({
        mode,
        vault: root,
        generation: JSON.parse(
          readFileSync(join(root, "manifest.json"), "utf8"),
        ).generation,
        sources: s.all("SELECT id FROM sources").length,
        integrity: s.get("PRAGMA integrity_check"),
      }),
    );
  } finally {
    s.close();
  }
} else if (mode === "rollback") {
  const protectedRoot = root + "-protected";
  const record = JSON.parse(
    readFileSync(join(protectedRoot, "migration.json"), "utf8"),
  );
  if (!existsSync(record.backup))
    throw new Error("Pre-migration backup unavailable; rollback refused.");
  const target = dbPath + ".rollback.sqlite";
  if (existsSync(target))
    throw new Error("Rollback target exists; no overwrite.");
  copyFileSync(record.backup, target);
  const check = new DatabaseSync(target);
  try {
    if (check.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok")
      throw new Error("Rollback backup integrity failed");
  } finally {
    check.close();
  }
  console.log(
    JSON.stringify({
      rollback_copy: target,
      action:
        "Verified copy only; stop the app and select this database deliberately. Current files were not overwritten.",
    }),
  );
} else
  throw new Error(
    "Usage: npm run vault:dry-run | vault:migrate | vault:rebuild | vault:rollback",
  );
