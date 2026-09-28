import { it, expect } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
it("actual API and separate worker restart preserves browser session, arbitrary original and preview", async () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-restart-"));
  const port = await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string")
        return reject(new Error("No test port"));
      server.close(() => resolve(address.port));
    });
  });
  const base = `http://127.0.0.1:${port}`;
  let child: ChildProcess | undefined;
  function start() {
    child = spawn(process.execPath, ["scripts/run.mjs", "production"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BRAIN_DB: join(dir, "brain.sqlite"),
        BRAIN_OWNER_SECRET: "restart-test-only",
        BRAIN_PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
    });
    child.stdout?.resume();
    child.stderr?.resume();
  }
  async function stop() {
    if (!child) return;
    child.send("stop");
    await new Promise<void>((resolve) => {
      if (child!.exitCode !== null) return resolve();
      child!.once("exit", () => resolve());
    });
  }
  async function ready() {
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(`${base}/api/v1/health/live`)).ok) return;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("Server failed to start");
  }
  try {
    start();
    await ready();
    const paired = await fetch(`${base}/api/v1/session/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: "restart-test-only" }),
    });
    const { csrf } = (await paired.json()) as any;
    const cookie = paired.headers.get("set-cookie")!.split(";")[0];
    const headers = {
      "Content-Type": "application/json",
      Cookie: cookie,
      "X-Brain-CSRF": csrf,
    };
    const saved = await fetch(`${base}/api/v1/sources`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "Restart original",
        body: "RESTART_ARBITRARY_🧠_Friday",
        project_id: "inbox",
      }),
    });
    expect(saved.status).toBe(201);
    const { source_id } = (await saved.json()) as any;
    await stop();
    start();
    await ready();
    const source = await fetch(`${base}/api/v1/sources/${source_id}`, {
      headers,
    });
    expect(source.status).toBe(200);
    expect(((await source.json()) as any).body).toBe(
      "RESTART_ARBITRARY_🧠_Friday",
    );
    let complete = false;
    for (let i = 0; i < 50; i++) {
      const today = (await (
        await fetch(`${base}/api/v1/today`, { headers })
      ).json()) as any;
      if (today.briefs[0]?.data.status === "current") {
        expect(today.briefs[0].data.items[0].text).toContain(
          "RESTART_ARBITRARY",
        );
        complete = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(complete).toBe(true);
  } finally {
    await stop();
    rmSync(dir, { recursive: true, force: true });
  }
}, 20000);
