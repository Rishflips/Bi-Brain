import { expect, test } from "@playwright/test";
import { firstNoteFixture } from "../helpers/first-note-browser.ts";

test("first useful loop follows real save and review state, then gets out of the way", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const fixture = await firstNoteFixture(context);
  const page = await context.newPage();
  try {
    await fixture.open(page);
    await expect(page.locator('[data-ui="first-session-journey"]')).toHaveCount(
      0,
    );

    const entity = `first session launch ${Date.now()}`;
    await page
      .locator("main")
      .getByRole("textbox")
      .first()
      .fill(`The ${entity} is November 12.`);
    await page
      .locator("main")
      .getByRole("button", { name: /^save/i })
      .first()
      .click();

    const journey = page.locator('[data-ui="first-session-journey"]');
    await expect(journey).toBeVisible();
    await expect(journey).toContainText("Saved as an original");
    await expect(
      journey.getByRole("button", { name: "Review memory" }),
    ).toBeVisible();

    await journey.getByRole("button", { name: "Review memory" }).click();
    const candidate = page
      .locator("article")
      .filter({ has: page.getByRole("heading", { name: entity }) });
    await expect(candidate).toContainText("November 12");
    await candidate
      .getByRole("button", { name: "Accept reviewed claim" })
      .click();
    await expect(candidate).toContainText("Current · reviewed by you");

    await page.getByRole("button", { name: "Today", exact: true }).click();
    await expect(journey).toContainText("Meaning confirmed by you");
    await journey.screenshot({
      path: "docs/screenshots/first-session.png",
    });

    await journey.getByRole("button", { name: "Use with an agent" }).click();
    await expect(
      page.getByRole("heading", { name: "Connections", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Connect an agent" }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Today", exact: true }).click();
    await page.getByRole("button", { name: "Save another" }).click();
    await page
      .locator("main")
      .getByRole("textbox")
      .first()
      .fill("A second synthetic note makes the guided first loop disappear.");
    await page
      .locator("main")
      .getByRole("button", { name: /^save/i })
      .first()
      .click();
    await expect(page.locator('[data-ui="first-session-journey"]')).toHaveCount(
      0,
    );
  } finally {
    await fixture.close();
  }
});

test("first useful loop remains readable at 320px in dark appearance", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 320, height: 760 },
  });
  const fixture = await firstNoteFixture(context);
  const page = await context.newPage();
  try {
    await page.addInitScript(() => localStorage.setItem("brain-theme", "dark"));
    await fixture.open(page);
    await page
      .locator("main")
      .getByRole("textbox")
      .first()
      .fill("A first mobile note worth keeping.");
    await page
      .locator("main")
      .getByRole("button", { name: /^save/i })
      .first()
      .click();

    const journey = page.locator('[data-ui="first-session-journey"]');
    await expect(journey).toBeVisible();
    const metrics = await page.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
      journey:
        document
          .querySelector('[data-ui="first-session-journey"]')
          ?.getBoundingClientRect().width ?? 0,
    }));
    expect(metrics.document).toBeLessThanOrEqual(metrics.viewport + 1);
    expect(metrics.journey).toBeLessThanOrEqual(metrics.viewport);
  } finally {
    await fixture.close();
  }
});
