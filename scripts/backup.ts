import { backup } from "node:sqlite";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Storage } from "../packages/storage/index.ts";
const destination = resolve(
  "data/backups",
  process.argv[2] ?? `${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite`,
);
const root = resolve("data/backups");
if (!destination.startsWith(root + "\\") && !destination.startsWith(root + "/"))
  throw new Error("Backup must remain inside data/backups.");
if (existsSync(destination)) throw new Error("Backup already exists.");
mkdirSync(root, { recursive: true });
const s = new Storage();
await backup(s.db, destination);
s.close();
writeFileSync(
  destination + ".json",
  JSON.stringify({
    format: 1,
    created_at: new Date().toISOString(),
    sensitive: true,
  }),
);
console.log("Consistent backup created in data/backups.");
