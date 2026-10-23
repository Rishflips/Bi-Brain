import { test, expect } from "@playwright/test";
import { MANAGED_ORIGIN } from "../helpers/managed-browser.ts";
import { firstNoteFixture } from "../helpers/first-note-browser.ts";

test("a committed correction invalidates its old receipt even when workspace refresh fails", async ({
  page,
  context,
}) => {
  const f = await firstNoteFixture(context);
  const original = "SYNTHETIC_BEFORE_CORRECTION_MUST_NOT_LINGER";
  const corrected = "SYNTHETIC_CURRENT_CORRECTED_ORIGINAL";
  try {
    await f.open(page);
    await page.getByLabel("Save to your brain").fill(original);
    const saved = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === "/api/v1/sources" &&
        r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Save", exact: true }).click();
    const sourceId = (await (await saved).json()).source_id;
    await page.getByRole("button", { name: "Open it", exact: true }).click();
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
    await expect(page.locator("main")).not.toContainText(original);
  } finally {
    await f.close();
  }
});

test("saving the same text as a corrected note still shows a receipt", async ({
  page,
  context,
}) => {
  const f = await firstNoteFixture(context);
  const corrected = "SYNTHETIC_CORRECTED_THEN_SAVED_AGAIN";
  try {
    await f.open(page);
    const bar = page.getByLabel("Save to your brain");
    await bar.fill("SYNTHETIC_BEFORE_SECOND_CORRECTION");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("button", { name: "Open it", exact: true }).click();
    await page
      .getByRole("button", { name: "Correct or move source", exact: true })
      .click();
    await page.getByLabel("Title", { exact: true }).fill(corrected);
    await page.getByLabel("Source text", { exact: true }).fill(corrected);
    await page
      .getByRole("button", { name: "Save correction", exact: true })
      .click();
    await page.getByRole("button", { name: "Close dialog" }).click();
    await page.getByRole("button", { name: "Today", exact: true }).click();
    await expect(page.locator("main")).not.toContainText(
      "kept exactly as you wrote it",
    );
    await bar.fill(corrected);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText(/kept exactly as you wrote it/i)).toBeVisible();
  } finally {
    await f.close();
  }
});
