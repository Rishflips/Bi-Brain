import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Storage } from "../../packages/storage/index.ts";

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.reverse()) fn();
  cleanup = [];
});

// `npm start` opens the same fresh database from the server and the worker at
// the same moment. Opening must wait for the other process, not fail at once.
it("waits for another process that is holding the database lock", async () => {
  const dir = mkdtempSync(join(tmpdir(), "storage-open-lock-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "brain.sqlite");
  const holder = spawn(
    process.execPath,
    [
      "-e",
      `const { DatabaseSync } = require("node:sqlite");
       const db = new DatabaseSync(process.argv[1]);
       db.exec("BEGIN EXCLUSIVE; CREATE TABLE held(x)");
       process.stdout.write("locked\\n");
       Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800);
       db.exec("COMMIT");
       db.close();`,
      path,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  cleanup.push(() => holder.kill());
  await new Promise<void>((ready) => holder.stdout.on("data", (d) => String(d).includes("locked") && ready()));

  const s = new Storage(path);
  cleanup.push(() => s.close());
  expect(s.get<{ n: number }>("SELECT count(*) AS n FROM projects")?.n).toBeGreaterThanOrEqual(0);
});
