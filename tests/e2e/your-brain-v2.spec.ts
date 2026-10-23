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
async function keepOnToday(page: Page, text: string) {
  const card = page.getByRole("article").filter({ hasText: text });
  await card.getByRole("button", { name: "Keep as true" }).click();
  await expect(card).toHaveCount(0);
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
    const nav = page.getByRole("navigation", { name: "Projects" });
    const columns = await nav.evaluate((el) => getComputedStyle(el).gridTemplateColumns.trim().split(/\s+/));
    expect(columns).toHaveLength(1);
    const last = await nav.locator("li button").last().boundingBox();
    const fresh = await nav.getByRole("button", { name: "New project" }).boundingBox();
    expect(fresh!.y).toBeGreaterThanOrEqual(last!.y + last!.height);
  });
});

test("a kept fact shows under True now and can be edited, with Undo", async ({ browser }) => {
  await journey(browser, async (page) => {
    await save(page, "We decided that Northstar beta is invite only.");
    await keepOnToday(page, "invite only");
    await openBrain(page);
    const facts = page.getByRole("region", { name: "True now" });
    const row = facts.getByRole("listitem").filter({ hasText: "invite only" });
    await expect(row).toContainText("version 1");
    await expect(row).toContainText("Checked");
    await row.getByRole("button", { name: "Edit" }).click();
    await facts.getByLabel("Edit fact").fill("invite only until launch");
    await facts.getByRole("button", { name: "Save as version 2" }).click();
    await expect(facts).toContainText("invite only until launch");
    const toast = page.locator(".tv-toast");
    await expect(toast).toContainText("Saved as version 2.");
    await toast.getByRole("button", { name: "Undo" }).click();
    await expect(toast).toContainText("Undone.");
    await expect(facts).not.toContainText("until launch");
    await expect(facts.getByRole("listitem").filter({ hasText: "invite only" })).toContainText("version 3");
    await page.getByRole("button", { name: "Preview handoff" }).click();
    await expect(page.getByRole("dialog", { name: "Project handoff" })).toContainText("invite only");
  });
});

test("an edit from a second tab is refused and keeps the draft", async ({ browser }) => {
  const context = await browser.newContext();
  const fixture = await firstNoteFixture(context);
  const first = await context.newPage();
  try {
    await fixture.open(first);
    await save(first, "We decided that Northstar beta is invite only.");
    await keepOnToday(first, "invite only");
    await openBrain(first);
    const second = await context.newPage();
    await fixture.open(second);
    await openBrain(second);
    // The second tab starts its edit first, from version 1.
    const secondFacts = second.getByRole("region", { name: "True now" });
    await secondFacts.getByRole("button", { name: "Edit" }).click();
    await secondFacts.getByLabel("Edit fact").fill("open to everyone");
    const firstFacts = first.getByRole("region", { name: "True now" });
    await firstFacts.getByRole("button", { name: "Edit" }).click();
    await firstFacts.getByLabel("Edit fact").fill("invite only until launch");
    await firstFacts.getByRole("button", { name: "Save as version 2" }).click();
    await expect(first.locator(".tv-toast")).toContainText("Saved as version 2.");
    // The page re-reads every 2.5 seconds; let it, so the test proves the edit stays pinned.
    await second.waitForTimeout(3000);
    await secondFacts.getByRole("button", { name: "Save as version 2" }).click();
    await expect(second.getByRole("alert").filter({ hasText: /changed since you opened it/i })).toBeVisible();
    await expect(secondFacts.getByLabel("Edit fact")).toHaveValue("open to everyone");
    await expect(firstFacts).toContainText("invite only until launch");
  } finally {
    await fixture.close();
  }
});

test("editing a fact is complete by keyboard and keeps focus in place", async ({ browser }) => {
  await journey(browser, async (page) => {
    await save(page, "We decided that Northstar beta is invite only.");
    await keepOnToday(page, "invite only");
    await openBrain(page);
    const facts = page.getByRole("region", { name: "True now" });
    const edit = facts.getByRole("button", { name: "Edit", exact: true });
    const box = facts.getByLabel("Edit fact");
    await edit.focus();
    await page.keyboard.press("Enter");
    await expect(box).toBeFocused();
    await page.keyboard.type(" for now");
    await page.keyboard.press("Escape");
    await expect(box).toHaveCount(0);
    await expect(edit).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(box).toBeFocused();
    await box.fill("invite only until launch");
    await page.keyboard.press("Tab");
    await expect(facts.getByRole("button", { name: "Save as version 2" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(facts).toContainText("invite only until launch");
    await expect(box).toHaveCount(0);
    await expect(edit).toBeFocused();
  });
});
