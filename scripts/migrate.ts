import { Storage } from "../packages/storage/index.ts";
const s = new Storage();
console.log({
  migrations: s.all("SELECT version,applied_at FROM migrations"),
  integrity: s.get("PRAGMA integrity_check"),
});
s.close();
