import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { createApp } from "../../apps/server/app.ts";
import { ManagedRuntime } from "../../packages/runtime/managed.ts";
import {
  MANAGED_ORIGIN,
  installAppRoutes,
} from "../helpers/managed-browser.ts";
import { firstNoteFixture } from "../helpers/first-note-browser.ts";

test("a delayed pre-purge source read cannot resurrect the retained receipt", async ({
  page,
  context,
}) => {
  const root = mkdtempSync(join(tmpdir(), "brain-inline-lifecycle-"));
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
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let received!: () => void;
  const started = new Promise<void>((resolve) => {
    received = resolve;
  });
  let delivered!: () => void;
  const done = new Promise<void>((resolve) => {
    delivered = resolve;
  });
  let firstRead = true;
  const original = "SYNTHETIC_PRE_PURGE_DELAYED_READ_MUST_NOT_RETURN";
  try {
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
    await context.route(
      `${MANAGED_ORIGIN}/api/v1/sources/*`,
      async (route, request) => {
        if (request.method() !== "GET" || !firstRead) return route.fallback();
        firstRead = false;
        const headers = await request.allHeaders();
        const response = await app.inject({
          method: "GET",
          url: new URL(request.url()).pathname,
          headers: {
            host: new URL(MANAGED_ORIGIN).host,
            cookie: headers.cookie ?? "",
          },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json().body).toBe(original);
        received();
        await held;
        await route.fulfill({
          status: response.statusCode,
          contentType: "application/json",
          body: response.body,
        });
        delivered();
      },
    );
    await page.goto(MANAGED_ORIGIN);
    await page.locator("main textarea").first().fill(original);
    await page
      .locator("main")
      .getByRole("button", { name: "Save to my brain", exact: true })
      .click();
    await started;
    // Reopen independently through real search while the receipt's initial
    // original read is held, then purge through the existing inspector.
    await page.getByRole("button", { name: "Your brain", exact: true }).click();
    await page.getByLabel("Search saved material").fill(original);
    await page.getByRole("button", { name: new RegExp(original) }).click();
    await expect(page.getByTestId("original")).toHaveText(original);
    await page
      .getByRole("button", { name: "Delete / withdraw", exact: true })
      .click();
    await page.getByLabel("Type DELETE to permanently purge").fill("DELETE");
    await page
      .getByRole("button", { name: "Permanently delete", exact: true })
      .click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await page.getByRole("button", { name: "Today", exact: true }).click();
    await expect(page.locator("main")).not.toContainText(original);
    release();
    await done;
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(page.locator("main")).not.toContainText(original);
    await expect(
      page.getByRole("button", { name: "Open this note", exact: true }),
    ).toHaveCount(0);
  } finally {
    release();
    await context.close();
    await app.close();
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a committed correction invalidates its old receipt even when workspace refresh fails", async ({
  page,
  context,
}) => {
  const f = await firstNoteFixture(context);
  const original = "SYNTHETIC_BEFORE_CORRECTION_MUST_NOT_LINGER";
  const corrected = "SYNTHETIC_CURRENT_CORRECTED_ORIGINAL";
  try {
    await f.open(page);
    await page.locator("main textarea").first().fill(original);
    const saved = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === "/api/v1/sources" &&
        r.request().method() === "POST",
    );
    await page
      .locator("main")
      .getByRole("button", { name: "Save to my brain", exact: true })
      .click();
    const sourceId = (await (await saved).json()).source_id;
    await page
      .getByRole("button", { name: "Open this note", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Correct or move source", exact: true })
      .click();
    await page
      .getByLabel("Title", { exact: true })
      .fill("Corrected synthetic note");
    await page.getByLabel("Source text", { exact: true }).fill(corrected);
    await context.route(`${MANAGED_ORIGIN}/api/v1/today`, (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "UNAVAILABLE",
            message: "Workspace refresh unavailable.",
          },
        }),
      }),
    );
    const mutation = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname.endsWith("/versions") &&
        r.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Save correction", exact: true })
      .click();
    expect((await mutation).ok()).toBe(true);
    expect(f.source(sourceId).body).toBe(corrected);
    await expect(page.getByRole("alert").first()).toContainText(/unavailable/i);
    await page.getByRole("button", { name: "Close dialog" }).click();
    await page.getByRole("button", { name: "Today", exact: true }).click();
    await expect(page.getByTestId("first-note-original")).toHaveText(corrected);
    await expect(page.locator("main")).not.toContainText(original);
  } finally {
    await f.close();
  }
});
