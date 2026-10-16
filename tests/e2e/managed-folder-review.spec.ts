import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, expect, type BrowserContext } from "@playwright/test";
import { createApp } from "../../apps/server/app.ts";
import { ManagedRuntime } from "../../packages/runtime/managed.ts";
import { MANAGED_ORIGIN, installAppRoutes } from "../helpers/managed-browser.ts";

/**
 * Focused regression for the folder-drop path only. A directory drop traverses
 * FileSystem entries asynchronously; if the browser's account changes while a
 * traversal is still suspended, the resumed work must not POST one account's
 * file bodies under another account's live session.
 */

async function fixture(context: BrowserContext) {
  const root = mkdtempSync(join(tmpdir(), "brain-folder-review-"));
  const runtime = new ManagedRuntime(root);
  const a = await runtime.provision("https://synthetic.example.test", "a");
  const b = await runtime.provision("https://synthetic.example.test", "b");
  const sa = runtime.control.issueSession(a.id);
  const sb = runtime.control.issueSession(b.id);
  const app = await createApp(undefined, {
    managed: runtime,
    publicOrigin: MANAGED_ORIGIN,
  });
  await installAppRoutes(context, app);
  const setSession = async (token: string) =>
    context.addCookies([
      {
        name: "brain_session",
        value: token,
        url: MANAGED_ORIGIN,
        httpOnly: true,
        secure: true,
        sameSite: "Strict",
      },
    ]);
  await setSession(sa.token);
  return {
    app,
    switchAccount: () => setSession(sb.token),
    close: async () => {
      await app.close();
      runtime.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("a folder traversal held across an account switch never previews A's file into B", async ({
  page,
  context,
}) => {
  const f = await fixture(context);
  const previewBodies: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().endsWith("/api/v1/import-adapters/preview")
    )
      previewBodies.push(request.postData() ?? "");
  });
  try {
    await page.goto(MANAGED_ORIGIN);
    await page.getByRole("button", { name: "Connections", exact: true }).click();
    await expect(page.locator(".dropzone")).toBeVisible();

    // Test-only in-page hook: a synthetic directory entry whose readEntries
    // callback is held until the test releases it. No production hook exists.
    await page.evaluate(() => {
      const state: {
        started: boolean;
        release: null | (() => void);
      } = { started: false, release: null };
      (window as unknown as { __folderDrop: typeof state }).__folderDrop = state;

      const file = new File(["SYNTHETIC_FOLDER_A_BODY"], "a-note.md", {
        type: "text/plain",
      });
      const fileEntry = {
        isFile: true,
        isDirectory: false,
        name: "a-note.md",
        file(success: (value: File) => void) {
          success(file);
        },
      };
      let delivered = false;
      const reader = {
        readEntries(success: (entries: unknown[]) => void) {
          if (delivered) {
            success([]);
            return;
          }
          delivered = true;
          state.started = true;
          state.release = () => success([fileEntry]);
        },
      };
      const directoryEntry = {
        isFile: false,
        isDirectory: true,
        name: "A-folder",
        createReader() {
          return reader;
        },
      };
      const dropzone = document.querySelector(".dropzone");
      if (!dropzone) throw new Error("dropzone missing");
      const event = new Event("drop", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", {
        value: {
          items: [{ webkitGetAsEntry: () => directoryEntry }],
          files: [],
        },
      });
      dropzone.dispatchEvent(event);
    });
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __folderDrop?: { started: boolean } })
              .__folderDrop?.started ?? false,
        ),
      )
      .toBe(true);

    // The browser now holds account B while A's traversal is still suspended.
    await f.switchAccount();
    await expect(
      page.getByText(/You signed in as a different account/).first(),
    ).toBeVisible({ timeout: 10000 });

    // Resume A's held traversal.
    await page.evaluate(() => {
      (
        window as unknown as { __folderDrop: { release: null | (() => void) } }
      ).__folderDrop.release?.();
    });
    // Give any resumed async work time to run and settle.
    await page.evaluate(
      () => new Promise<void>((resolve) => setTimeout(() => resolve(), 750)),
    );

    // B must never receive A's file body, and no review dialog may open.
    expect(
      previewBodies.filter((body) => body.includes("SYNTHETIC_FOLDER_A_BODY")),
    ).toEqual([]);
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await expect(page.getByText("SYNTHETIC_FOLDER_A_BODY")).toHaveCount(0);
    await expect(page.getByText("a-note.md")).toHaveCount(0);
  } finally {
    await f.close();
  }
});
