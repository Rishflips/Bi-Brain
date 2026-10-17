import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, Page } from "@playwright/test";
import { createApp } from "../../apps/server/app.ts";
import { Worker } from "../../apps/worker/engine.ts";
import { ManagedRuntime } from "../../packages/runtime/managed.ts";
import { MANAGED_ORIGIN, installAppRoutes } from "./managed-browser.ts";

/** Real isolated storage/application/session; no shared pairing throttle or fake success. */
export async function firstNoteFixture(context: BrowserContext) {
  const root = mkdtempSync(join(tmpdir(), "brain-first-note-browser-"));
  const runtime = new ManagedRuntime(root);
  const account = await runtime.provision(
    "https://synthetic.example.test",
    "owner",
  );
  const session = runtime.control.issueSession(account.id);
  const app = await createApp(undefined, {
    managed: runtime,
    publicOrigin: MANAGED_ORIGIN,
  });
  await installAppRoutes(context, app);
  await context.addCookies([
    {
      name: "brain_session",
      value: session.token,
      url: MANAGED_ORIGIN,
      httpOnly: true,
      secure: true,
      sameSite: "Strict",
    },
  ]);
  return {
    open: (page: Page) => page.goto(MANAGED_ORIGIN),
    source(id: string) {
      const handle = runtime.acquire(account.id);
      try {
        return handle.brain.source(handle.brain.ownerPrincipal(), id);
      } finally {
        handle.release();
      }
    },
    sources() {
      const handle = runtime.acquire(account.id);
      try {
        return handle.brain.sources(handle.brain.ownerPrincipal());
      } finally {
        handle.release();
      }
    },
    async prepare() {
      const handle = runtime.acquire(account.id);
      try {
        await new Worker(handle.brain).tick();
      } finally {
        handle.release();
      }
    },
    async close() {
      await context.close();
      await app.close();
      runtime.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
