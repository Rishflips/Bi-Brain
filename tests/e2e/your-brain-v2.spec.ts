import { expect, test, type Browser, type Page } from "@playwright/test";
import { firstNoteFixture } from "../helpers/first-note-browser.ts";

// Each journey gets its own brain, so nothing another spec saved can crowd the Brief.
async function journey(browser: Browser, run: (page: Page) => Promise<void>) {
  const context = await browser.newContext();
  const fixture = await firstNoteFixture(context);
  const page = await context.newPage();
  try {
    await fixture.open(page);
    await run(page);
  } finally {
    await fixture.close();
  }
}
async function save(page: Page, text: string) {
  const bar = page.getByLabel(/save to your brain|ask your brain/i);
  await bar.fill(text);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(bar).toHaveValue("");
}
async function openBrain(page: Page) {
  await page.getByRole("button", { name: "Your brain", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your brain", level: 1 })).toBeVisible();
}

test("Your brain shows the open project, its originals newest first, and switches projects", async ({ browser }) => {
  await journey(browser, async (page) => {
    await save(page, "First note about the Hydra launch.");
    await save(page, "Second note about the Hydra launch.");
    await openBrain(page);
    await expect(page.getByRole("heading", { name: "Inbox", level: 2 })).toBeVisible();
    await expect(page.getByText("No agent connected")).toBeVisible();
    const originals = page.getByRole("region", { name: "Originals" });
    const titles = originals.getByRole("listitem").getByRole("button");
    await expect(titles.first()).toHaveText(/Second note/);
    await expect(titles.nth(1)).toHaveText(/First note/);
    await titles.first().click();
    await expect(page.getByTestId("original")).toHaveText("Second note about the Hydra launch.");
    await page.getByRole("button", { name: "Close dialog" }).click();
    const projects = page.getByRole("navigation", { name: "Projects" });
    await projects.getByRole("button", { name: "New project" }).click();
    await page.getByLabel("Project name").fill("Hydra");
    await page.getByRole("button", { name: "Create project", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Hydra", level: 2 })).toBeVisible();
    await expect(originals).toContainText("Nothing saved here yet.");
    await projects.getByRole("button", { name: "Inbox" }).click();
    await expect(page.getByRole("heading", { name: "Inbox", level: 2 })).toBeVisible();
  });
});

test("a suggestion is counted here and reviewed on Today", async ({ browser }) => {
  await journey(browser, async (page) => {
    await save(page, "We decided that Northstar beta is invite only.");
    await openBrain(page);
    await expect(page.getByText("1 thing to look at on Today.")).toBeVisible();
    await page.getByRole("button", { name: "Review on Today" }).click();
    await expect(page.getByRole("article").filter({ hasText: "invite only" })).toBeVisible();
  });
});

test("Your brain fits a 320px screen in dark appearance", async ({ browser }) => {
  await journey(browser, async (page) => {
    await save(page, "A note with a long unbroken word Supercalifragilisticexpialidocious_and_more_words_here.");
    await page.setViewportSize({ width: 320, height: 760 });
    await page.emulateMedia({ colorScheme: "dark" });
    await openBrain(page);
    await expect(page.getByRole("navigation", { name: "Projects" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
