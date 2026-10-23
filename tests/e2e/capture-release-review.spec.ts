import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { createApp } from "../../apps/server/app.ts";
import { ManagedRuntime } from "../../packages/runtime/managed.ts";
import {
  MANAGED_ORIGIN,
  installAppRoutes,
} from "../helpers/managed-browser.ts";
import { firstNoteFixture } from "../helpers/first-note-browser.ts";

/**
 * Independent regressions for the approved first-note slice:
 * one bar on Today -> durable saved confirmation -> find and
 * reopen in "Your brain" after a real browser reload.
 *
 * Selector contract (Today v2):
 *  - the bar textbox is labelled "Save to your brain";
 *  - the save control is the button named exactly "Save";
 *  - the durable confirmation reads "kept exactly as you wrote it".
 * The tests assert real server behavior (`/api/v1/sources`, `/api/v1/search`)
 * and the `source_id` returned by an actual capture. Failure is injected once
 * for the draft-retention case only; no successful persistence is ever faked.
 */

test.setTimeout(60_000);

function todayComposer(page: Page) {
  return page.getByLabel("Save to your brain");
}
function todaySave(page: Page) {
  return page.getByRole("button", { name: "Save", exact: true });
}
function savedConfirmation(page: Page) {
  return page.getByText(/kept exactly as you wrote it/i);
}
async function reopenInBrain(page: Page, marker: string): Promise<void> {
  await page.getByRole("button", { name: "Your brain", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Your brain", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Search your brain").fill(marker);
  const result = page
    .getByRole("button", {
      name: new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    })
    .first();
  await expect(result).toBeVisible();
  await result.click();
  await expect(page.getByTestId("original")).toContainText(marker);
}

test("inline capture keeps a real Unicode multiline original across reload", async ({
  page,
  context,
}) => {
  const f = await firstNoteFixture(context);
  try {
    await f.open(page);
    const marker = `InlineCapture${Date.now()}`;
    const body = `${marker}\nUnicode: 🧠 café — “quoted” ✓`;
    const composer = todayComposer(page);
    await expect(composer).toBeVisible();
    await composer.fill(body);
    const saved = page.waitForResponse(
      (r) =>
        r.url().includes("/api/v1/sources") && r.request().method() === "POST",
    );
    await todaySave(page).click();
    const response = await saved;
    expect(response.status()).toBe(201);
    const sourceId = (await response.json()).source_id as string;
    expect(sourceId).toBeTruthy();
    await expect(savedConfirmation(page).first()).toBeVisible();

    // The ID returned by the real capture resolves to the exact original text.
    expect(f.source(sourceId).body).toBe(body);

    await reopenInBrain(page, marker);
    await expect(page.getByTestId("original")).toHaveText(body);
    await page.getByRole("button", { name: "Close dialog" }).click();

    // A genuine browser reload must still find and reopen the same original.
    await page.reload();
    await reopenInBrain(page, marker);
    await expect(page.getByTestId("original")).toHaveText(body);
  } finally {
    await f.close();
  }
});

test("failed save keeps the inline draft, surfaces failure and invents no success", async ({
  page,
  context,
}) => {
  const f = await firstNoteFixture(context);
  try {
    await f.open(page);
    const marker = `FailedSave${Date.now()}`;
    const body = `${marker}\nthis draft must survive a failed save`;
    await page.route("**/api/v1/sources", async (route, request) => {
      if (request.method() !== "POST") return route.fallback();
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "UNAVAILABLE", message: "Your brain is unavailable." },
        }),
      });
    });
    const composer = todayComposer(page);
    await composer.fill(body);
    await todaySave(page).click();
    await expect(page.getByRole("alert")).toContainText(/not saved/i);
    await expect(page.getByRole("alert")).toContainText(/unavailable/i);
    await expect(composer).toHaveValue(body);
    await expect(savedConfirmation(page)).toHaveCount(0);
    // Independently confirm the rejected save never reached real persistence.
    expect(f.sources()).toHaveLength(0);
  } finally {
    await f.close();
  }
});

async function managedFixture(context: BrowserContext) {
  const root = mkdtempSync(join(tmpdir(), "brain-capture-review-"));
  const runtime = new ManagedRuntime(root);
  const a = await runtime.provision("https://synthetic.example.test", "a");
  const b = await runtime.provision("https://synthetic.example.test", "b");
  const sessionA = runtime.control.issueSession(a.id);
  const sessionB = runtime.control.issueSession(b.id);
  const app = await createApp(undefined, {
    managed: runtime,
    publicOrigin: MANAGED_ORIGIN,
  });
  await installAppRoutes(context, app);
  const asAccount = (token: string) =>
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
  return {
    app,
    asA: () => asAccount(sessionA.token),
    asB: () => asAccount(sessionB.token),
    close: async () => {
      await context.close();
      await app.close();
      runtime.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("account switch clears the inline draft and a late capture cannot repopulate it", async ({
  page,
  context,
}) => {
  const f = await managedFixture(context);
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  let started!: () => void;
  const begun = new Promise<void>((resolve) => (started = resolve));
  let delivered!: () => void;
  const done = new Promise<void>((resolve) => (delivered = resolve));
  const marker = `AccountA${Date.now()}`;
  try {
    await f.asA();
    await page.goto(MANAGED_ORIGIN);
    const composer = todayComposer(page);
    await expect(composer).toBeVisible({ timeout: 15_000 });
    // A held capture request, answered by the real app for account A.
    await context.route(
      `${MANAGED_ORIGIN}/api/v1/sources`,
      async (route, request) => {
        const headers = await request.allHeaders();
        const response = await f.app.inject({
          method: "POST",
          url: "/api/v1/sources",
          headers: {
            host: new URL(MANAGED_ORIGIN).host,
            cookie: headers.cookie ?? "",
            "content-type": "application/json",
            "x-brain-csrf": headers["x-brain-csrf"] ?? "",
          },
          payload: request.postDataBuffer() ?? "",
        });
        started();
        await held;
        await route.fulfill({
          status: response.statusCode,
          contentType: "application/json",
          body: response.body,
        });
        delivered();
      },
    );
    await composer.fill(`${marker} private draft`);
    await todaySave(page).click();
    await begun;

    // The browser now holds account B's session while A's capture is in flight.
    await f.asB();
    await expect(
      page.getByText(/You signed in as a different account/).first(),
    ).toBeVisible({ timeout: 15_000 });
    release();
    await done;
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );

    // A's late response is fenced: no confirmation, no A text, empty B draft.
    await expect(savedConfirmation(page)).toHaveCount(0);
    await expect(page.getByText(marker)).toHaveCount(0);
    await expect(todayComposer(page)).toHaveValue("", { timeout: 15_000 });
  } finally {
    release();
    await f.close();
  }
});
