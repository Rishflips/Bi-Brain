import { expect, test } from "@playwright/test";
import { firstNoteFixture } from "../helpers/first-note-browser.ts";

// The guided goal flow lives in Your brain. Today only shows the finished,
// evidence-linked plan in the Brief, where the owner keeps, fixes or dismisses it.
test("a chosen goal in Your brain becomes one reviewed next step on Today", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const context = await browser.newContext();
  const fixture = await firstNoteFixture(context);
  const page = await context.newPage();
  try {
    await fixture.open(page);
    const marker = `guided goal ${Date.now()}`;
    const bar = page.getByLabel("Save to your brain");
    const saveBtn = page.getByRole("button", { name: "Save", exact: true });

    await bar.fill(`The ${marker} is November 12.`);
    await saveBtn.click();
    await expect(page.getByText(/kept exactly as you wrote it/i)).toBeVisible();
    await bar.fill(
      `For the ${marker} interview, compare three onboarding notes.`,
    );
    await saveBtn.click();
    await expect(bar).toHaveValue("");

    await page.getByRole("button", { name: "Today", exact: true }).click();
    const memory = page.getByRole("article").filter({ hasText: marker });
    await memory.getByRole("button", { name: "Keep as true" }).click();
    await expect(memory).toHaveCount(0);

    await page.getByRole("button", { name: "Your brain", exact: true }).click();
    await page
      .getByRole("button", { name: "Choose a goal", exact: true })
      .click();
    await page
      .getByLabel("What do you want to accomplish?")
      .fill(`${marker} pilot`);
    await page
      .getByLabel("What would success look like?")
      .fill("Complete three interviews and record the clearest learning.");
    await page.getByRole("button", { name: "Save goal", exact: true }).click();
    // The handoff lists the chosen goal.
    await page.getByRole("button", { name: "Preview handoff" }).click();
    await expect(page.getByRole("dialog", { name: "Project handoff" })).toContainText(`${marker} pilot`);
    await page.getByRole("button", { name: "Close dialog" }).click();
    // Nothing is prepared until the owner asks for it.
    await expect(
      page.getByRole("button", { name: "Prepare now" }),
    ).toBeDisabled();
    await page.getByLabel("Keep this up to date").check();
    await expect(
      page.getByRole("button", { name: "Prepare now" }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "Prepare now" }).click();

    for (let index = 0; index < 5; index += 1) await fixture.prepare();

    // Fits a 320px screen in dark appearance with the plan waiting on Today.
    await page.setViewportSize({ width: 320, height: 760 });
    await page.evaluate(() => localStorage.setItem("brain-theme", "dark"));
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.getByRole("button", { name: "Today", exact: true }).click();
    const card = page
      .getByRole("article")
      .filter({ hasText: "Prepared for your goal" });
    await expect(card).toContainText(marker);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.setViewportSize({ width: 1280, height: 900 });

    await card.getByRole("button", { name: "Keep this plan" }).click();
    await expect(page.locator(".tv-toast")).toContainText(/plan kept/i);
    await expect(card).toHaveCount(0);
  } finally {
    await fixture.close();
  }
});
