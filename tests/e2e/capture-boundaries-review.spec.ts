import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { createApp } from "../../apps/server/app.ts";
import { ManagedRuntime } from "../../packages/runtime/managed.ts";
import {
  MANAGED_ORIGIN,
  installAppRoutes,
} from "../helpers/managed-browser.ts";

// These boundaries use real disposable tenant storage. Only a read failure is
// injected: a successful capture is never simulated. No real provider is used.
async function fixture(context: BrowserContext) {
  const root = mkdtempSync(join(tmpdir(), "brain-capture-boundaries-"));
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
    app,
    read(id: string) {
      const handle = runtime.acquire(account.id);
      try {
        return handle.brain.source(handle.brain.ownerPrincipal(), id);
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

const composer = (page: Page) => page.getByLabel("Save to your brain");
const save = (page: Page) =>
  page.getByRole("button", { name: "Save", exact: true });
const receipt = (page: Page) => page.getByText(/kept exactly as you wrote it/i);

async function saveInline(page: Page, original: string) {
  await expect(composer(page)).toBeVisible();
  await composer(page).fill(original);
  const capture = page.waitForResponse(
    (r) =>
      new URL(r.url()).pathname === "/api/v1/sources" &&
      r.request().method() === "POST",
  );
  await save(page).click();
  const response = await capture;
  expect(response.status()).toBe(201);
  await expect(receipt(page)).toBeVisible();
  return (await response.json()).source_id as string;
}

test("the bar empties after a save and a second save retains both actual originals", async ({
  page,
  context,
}) => {
  const f = await fixture(context);
  try {
    await page.goto(MANAGED_ORIGIN);
    const first = "SYNTHETIC_FIRST_INLINE_ORIGINAL";
    const second = "SYNTHETIC_SECOND_INLINE_ORIGINAL";
    const firstId = await saveInline(page, first);
    await expect(composer(page)).toHaveValue("");
    const secondId = await saveInline(page, second);
    expect(secondId).not.toBe(firstId);
    expect(f.read(firstId).body).toBe(first);
    expect(f.read(secondId).body).toBe(second);
  } finally {
    await f.close();
  }
});

async function purgeSavedOriginal(
  page: Page,
  context: BrowserContext,
  original: string,
  options: { askFirst?: string; todayFails?: boolean } = {},
) {
  const f = await fixture(context);
  await page.goto(MANAGED_ORIGIN);
  await saveInline(page, original);
  if (options.askFirst) {
    await page.getByRole("button", { name: "Ask mode" }).click();
    await page.getByLabel("Ask your brain").fill(options.askFirst);
    await page.getByRole("button", { name: "Ask", exact: true }).click();
    await expect(page.getByText("From your brain")).toBeVisible();
    await expect(page.locator("main")).toContainText(original);
    await page.getByRole("button", { name: new RegExp(original) }).click();
  } else {
    await page.getByRole("button", { name: "Open it", exact: true }).click();
  }
  await expect(page.getByTestId("original")).toHaveText(original);
  await page
    .getByRole("button", { name: "Delete / withdraw", exact: true })
    .click();
  await page.getByLabel("Type DELETE to permanently purge").fill("DELETE");
  if (options.todayFails)
    await context.route(`${MANAGED_ORIGIN}/api/v1/today`, (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "UNAVAILABLE", message: "Refresh unavailable." },
        }),
      }),
    );
  await page
    .getByRole("button", { name: "Permanently delete", exact: true })
    .click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  return f;
}

test("after a reload, a purged original is gone from Today", async ({
  page,
  context,
}) => {
  const original = "SYNTHETIC_PURGED_AFTER_RELOAD";
  const f = await purgeSavedOriginal(page, context, original);
  try {
    await page.reload();
    await expect(page.locator("main")).not.toContainText(original);
  } finally {
    await f.close();
  }
});

test("a purged original disappears from Today without a reload", async ({
  page,
  context,
}) => {
  const original = "SYNTHETIC_PURGED_INLINE_RECEIPT_MUST_DISAPPEAR";
  const f = await purgeSavedOriginal(page, context, original);
  try {
    await page.getByRole("button", { name: "Today", exact: true }).click();
    await expect(page.locator("main")).not.toContainText(original);
  } finally {
    await f.close();
  }
});

test("a purged original disappears from an Ask answer on Today", async ({
  page,
  context,
}) => {
  const original = "SYNTHETIC kiwimarmalade cited original MUST_DISAPPEAR";
  const f = await purgeSavedOriginal(page, context, original, {
    askFirst: "kiwimarmalade",
  });
  try {
    await page.getByRole("button", { name: "Today", exact: true }).click();
    await expect(page.locator("main")).not.toContainText("kiwimarmalade");
  } finally {
    await f.close();
  }
});

test("a purged original disappears from Today even when the workspace refresh fails", async ({
  page,
  context,
}) => {
  const original = "SYNTHETIC_PURGED_WHILE_REFRESH_FAILS";
  const f = await purgeSavedOriginal(page, context, original, {
    todayFails: true,
  });
  try {
    await page.getByRole("button", { name: "Today", exact: true }).click();
    await expect(page.locator("main")).not.toContainText(original);
  } finally {
    await f.close();
  }
});

test("a credential on the first line is never shown in the receipt", async ({
  page,
  context,
}) => {
  const f = await fixture(context);
  const sentinel = "sk-SYNTHETICQUARANTINEONLY1234567890";
  try {
    await page.route("**/api/v1/search*", (route) => route.abort());
    await page.goto(MANAGED_ORIGIN);
    await composer(page).fill(`${sentinel}
second line of a synthetic note`);
    await save(page).click();
    await expect(page.getByText(/Saved privately\./)).toBeVisible();
    await expect(page.locator("main")).not.toContainText(sentinel);
    await expect(page.locator("main")).not.toContainText(
      "kept exactly as you wrote it",
    );
  } finally {
    await f.close();
  }
});

test("a 320px saved receipt keeps long originals usable in dark appearance", async ({
  page,
  context,
}) => {
  const f = await fixture(context);
  try {
    await page.setViewportSize({ width: 320, height: 820 });
    await page.addInitScript(() => localStorage.setItem("brain-theme", "dark"));
    await page.goto(MANAGED_ORIGIN);
    const original = "unbroken".repeat(10) + "\nSYNTHETIC_MOBILE_RECEIPT";
    await saveInline(page, original);
    await expect(receipt(page)).toBeVisible();
    await expect(page.locator("main")).toContainText("unbroken".repeat(10));
    await page.getByRole("button", { name: "Open it", exact: true }).click();
    await expect(page.getByTestId("original")).toHaveText(original);
    await page.getByRole("button", { name: "Close dialog" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: "test-results/capture-mobile-dark-review.png",
      fullPage: true,
    });
  } finally {
    await f.close();
  }
});

test("a committed capture remains acknowledged when the original cannot yet be read", async ({
  page,
  context,
}) => {
  const f = await fixture(context);
  const original =
    "SYNTHETIC_POST_SAVE_READ_FAILURE\nA durable note, not an unsaved draft.";
  try {
    await page.goto(MANAGED_ORIGIN);
    await expect(composer(page)).toBeVisible();
    await composer(page).fill(original);
    await context.route(`${MANAGED_ORIGIN}/api/v1/sources/*`, (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "UNAVAILABLE",
            message: "Preview read temporarily unavailable.",
          },
        }),
      }),
    );
    const capture = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === "/api/v1/sources" &&
        r.request().method() === "POST",
    );
    await save(page).click();
    const response = await capture;
    expect(response.status()).toBe(201);
    const { source_id: id } = await response.json();
    expect(f.read(id).body).toBe(original);
    // Catch loss of the durable-save acknowledgement when a later GET fails.
    await expect(receipt(page)).toBeVisible();
    await context.unroute(`${MANAGED_ORIGIN}/api/v1/sources/*`);
    await page.getByRole("button", { name: "Your brain", exact: true }).click();
    await page
      .getByLabel("Search saved material")
      .fill("SYNTHETIC_POST_SAVE_READ_FAILURE");
    await page
      .getByRole("button", { name: /SYNTHETIC_POST_SAVE_READ_FAILURE/ })
      .click();
    await expect(page.getByTestId("original")).toHaveText(original);
  } finally {
    await f.close();
  }
});

test("quarantined capture never echoes the suspected credential into a saved preview", async ({
  page,
  context,
}) => {
  const f = await fixture(context);
  // Deliberately synthetic scanner trigger, not a real credential.
  const sentinel = "sk-SYNTHETICQUARANTINEONLY1234567890";
  try {
    await page.goto(MANAGED_ORIGIN);
    await expect(composer(page)).toBeVisible();
    await composer(page).fill(`Synthetic quarantine check\n${sentinel}`);
    const capture = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === "/api/v1/sources" &&
        r.request().method() === "POST",
    );
    await save(page).click();
    const response = await capture;
    expect(response.status()).toBe(201);
    const result = await response.json();
    expect(result.quarantined).toBe(true);
    const source = f.read(result.source_id);
    expect(source.title).toBe("Quarantined source");
    expect(source.visibility).toBe("private");
    expect(source.body).not.toContain(sentinel);
    await expect(
      page.getByText(
        "Saved privately. It looked like a secret, so it is kept protected and hidden from agents.",
      ),
    ).toBeVisible();
    // Rendering draft text instead of the retained safe source is a leak.
    await expect(page.locator("body")).not.toContainText(sentinel);
    expect(
      await page
        .locator("textarea")
        .evaluateAll(
          (fields, token) =>
            fields.some(
              (field) =>
                field instanceof HTMLTextAreaElement &&
                field.value.includes(token),
            ),
          sentinel,
        ),
    ).toBe(false);
  } finally {
    await f.close();
  }
});
