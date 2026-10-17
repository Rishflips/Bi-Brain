import { expect, test, type Page } from "@playwright/test";
import { firstNoteFixture } from "../helpers/first-note-browser.ts";

/**
 * Focused browser regression for the approved first-note slice:
 * a calm inline composer on Today -> a durable saved confirmation derived from
 * the real 201 `source_id` -> a truthful, source-bound offline preview ->
 * find and reopen the same original in "Your brain" after a real reload.
 *
 * Every case has isolated real storage and an authenticated synthetic account.
 * Extractive preparation runs the actual unpaid Worker, not a successful mock.
 */
function composer(page: Page) {
  return page.locator("main").getByRole("textbox").first();
}
function saveButton(page: Page) {
  return page.locator("main").getByRole("button", { name: /^save/i }).first();
}
function savedConfirmation(page: Page) {
  return page.getByRole("status").filter({ hasText: /saved/i }).first();
}

async function openFirstUse(page: Page): Promise<void> {
  await expect(
    page
      .getByRole("heading", { name: "What do you want to pick up later?" })
      .or(page.getByRole("heading", { name: "Welcome back." })),
  ).toBeVisible();
}

let fixture: Awaited<ReturnType<typeof firstNoteFixture>>;
test.beforeEach(async ({ page, context }) => {
  fixture = await firstNoteFixture(context);
  await fixture.open(page);
});
test.afterEach(async () => {
  await fixture?.close();
});

test("inline first note is durably saved, previews truthfully and reopens after reload", async ({
  page,
}) => {
  await openFirstUse(page);
  const marker = `InlineFirst${Date.now()}`;
  const body = `${marker}\nUnicode: 🧠 café — “quoted” ✓`;

  const field = composer(page);
  await expect(field).toBeVisible();
  await field.fill(body);

  const saved = page.waitForResponse(
    (r) =>
      r.url().includes("/api/v1/sources") && r.request().method() === "POST",
  );
  await saveButton(page).click();
  const response = await saved;
  expect(response.status()).toBe(201);
  const sourceId = (await response.json()).source_id as string;
  expect(sourceId).toBeTruthy();

  // The confirmation is derived from the real persisted response.
  await expect(savedConfirmation(page)).toContainText("Saved to your brain");

  // The returned id resolves on the real server to the exact original text.
  expect(fixture.source(sourceId).body).toBe(body);

  // The receipt shows the actual retained original, not the raw draft echo.
  await expect(page.getByTestId("first-note-original")).toContainText(marker);
  await fixture.prepare();

  // Truthful offline preview: the worker prepares an extractive brief that is
  // bound to this exact source. It must never masquerade as source-bound if it
  // is not (the app only shows a brief whose source_versions include this id).
  await expect(page.getByText("Extractive preview").first()).toBeVisible({
    timeout: 20000,
  });

  // Find in Your brain navigates and searches the actual note title.
  await page.getByRole("button", { name: "Find in Your brain" }).click();
  await expect(page.getByLabel("Search saved material")).toHaveValue(marker);
  const note = page.getByRole("button", { name: new RegExp(marker) }).first();
  await expect(note).toBeVisible();

  // A genuine reload must still find and reopen the same original.
  await page.reload();
  await expect(page.getByLabel("Search saved material")).toBeVisible();
  await page.getByLabel("Search saved material").fill(marker);
  const afterReload = page
    .getByRole("button", { name: new RegExp(marker) })
    .first();
  await expect(afterReload).toBeVisible();
  await afterReload.click();
  await expect(page.getByTestId("original")).toContainText(marker);
});

test("a failed save keeps the inline draft and never claims success", async ({
  page,
}) => {
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
  await openFirstUse(page);
  const marker = `InlineFail${Date.now()}`;
  const body = `${marker}\nthis draft must survive a failed save`;

  await composer(page).fill(body);
  await saveButton(page).click();

  await expect(page.getByRole("alert")).toContainText(/unavailable/i);
  await expect(composer(page)).toHaveValue(body);
  await expect(savedConfirmation(page)).toHaveCount(0);

  // Independently confirm the rejected save never reached real persistence.
  expect(fixture.sources()).toHaveLength(0);
});

test("mobile 320px keeps the composer usable and Ctrl+Enter saves without overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 820 });
  await openFirstUse(page);

  const marker = `InlineMobile${Date.now()}`;
  await composer(page).fill(marker);
  await expect(composer(page)).toBeVisible();

  // Keyboard-first capture from the field itself.
  await composer(page).press("Control+Enter");
  await expect(savedConfirmation(page)).toContainText("Saved to your brain");
  await expect(
    page.getByRole("button", { name: "Find in Your brain" }),
  ).toBeVisible();

  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
