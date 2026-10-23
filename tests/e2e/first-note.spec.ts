import { expect, test, type Page } from "@playwright/test";
import { firstNoteFixture } from "../helpers/first-note-browser.ts";

/**
 * Browser regression for the first note on Today v2: the bar saves what was
 * typed, the receipt comes from the real 201 response, and the original can be
 * found and reopened in "Your brain" after a real reload.
 *
 * Every case has isolated real storage and an authenticated synthetic account.
 */
function composer(page: Page) {
  return page.getByLabel("Save to your brain");
}
function saveButton(page: Page) {
  return page.getByRole("button", { name: "Save", exact: true });
}
function receipt(page: Page) {
  return page.getByText(/kept exactly as you wrote it/i);
}

async function openFirstUse(page: Page): Promise<void> {
  await expect(
    page
      .getByRole("heading", { name: "Welcome to BiBrain." })
      .or(page.getByRole("heading", { name: "Good to see you." })),
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

test("a first note is durably saved, kept exactly, and reopens after reload", async ({
  page,
}) => {
  await openFirstUse(page);
  const marker = `InlineFirst${Date.now()}`;
  const body = `${marker}
Unicode: 🧠 café — “quoted” ✓`;

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

  // The receipt comes from the real persisted response, and the bar is empty again.
  await expect(receipt(page)).toBeVisible();
  await expect(composer(page)).toHaveValue("");

  // The returned id resolves on the real server to the exact original text.
  expect(fixture.source(sourceId).body).toBe(body);

  // The receipt opens the real original.
  await page.getByRole("button", { name: "Open it" }).click();
  await expect(page.getByTestId("original")).toContainText(marker);

  // A genuine reload must still find and reopen the same original in Your brain.
  await page.reload();
  await page.getByRole("button", { name: "Your brain", exact: true }).click();
  await expect(page.getByLabel("Search saved material")).toBeVisible();
  await page.getByLabel("Search saved material").fill(marker);
  const afterReload = page
    .getByRole("button", { name: new RegExp(marker) })
    .first();
  await expect(afterReload).toBeVisible();
  await afterReload.click();
  await expect(page.getByTestId("original")).toContainText(marker);
});

test("a failed save keeps the draft and never claims success", async ({
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
  const body = `${marker}
this draft must survive a failed save`;

  await composer(page).fill(body);
  await saveButton(page).click();

  await expect(page.getByRole("alert")).toContainText(/not saved/i);
  await expect(page.getByRole("alert")).toContainText(/unavailable/i);
  await expect(page.getByRole("alert")).toContainText(
    "Your text is still here.",
  );
  await expect(composer(page)).toHaveValue(body);
  await expect(receipt(page)).toHaveCount(0);

  // Independently confirm the rejected save never reached real persistence.
  expect(fixture.sources()).toHaveLength(0);
});

test("mobile 320px keeps the bar usable and Enter saves without overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 820 });
  await openFirstUse(page);

  const marker = `InlineMobile${Date.now()}`;
  await composer(page).fill(marker);
  await expect(composer(page)).toBeVisible();

  // Keyboard-first capture from the field itself.
  await composer(page).press("Enter");
  await expect(receipt(page)).toBeVisible();
  await expect(page.getByRole("button", { name: "Open it" })).toBeVisible();

  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
