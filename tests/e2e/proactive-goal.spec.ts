import { expect, test } from "@playwright/test";
import { firstNoteFixture } from "../helpers/first-note-browser.ts";

test("a chosen goal becomes one reviewed next step without hidden automation", async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const context = await browser.newContext();
  const fixture = await firstNoteFixture(context);
  const page = await context.newPage();
  try {
    await fixture.open(page);
    const marker = `guided goal ${Date.now()}`;

    await page
      .locator("main")
      .getByRole("textbox")
      .first()
      .fill(`The ${marker} is November 12.`);
    await page
      .locator("main")
      .getByRole("button", { name: /^save/i })
      .first()
      .click();
    await page
      .locator('[data-ui="first-session-journey"]')
      .getByRole("button", { name: "Review memory" })
      .click();
    const memory = page
      .locator("article")
      .filter({ has: page.getByRole("heading", { name: marker }) });
    await memory.getByRole("button", { name: "Accept reviewed claim" }).click();

    await page.getByRole("button", { name: "Today", exact: true }).click();
    await page.getByRole("button", { name: "Save another" }).click();
    await page
      .locator("main")
      .getByRole("textbox")
      .first()
      .fill(`For the ${marker} interview, compare three onboarding notes.`);
    await page
      .locator("main")
      .getByRole("button", { name: /^save/i })
      .first()
      .click();

    const guide = page.locator('[data-ui="proactive-goal"]');
    await expect(guide).toBeVisible();
    await expect(guide).toContainText(
      "What should BiBrain help you move forward?",
    );
    await guide.getByRole("button", { name: "Choose a goal" }).click();
    await page
      .getByLabel("What do you want to accomplish?")
      .fill(`${marker} pilot`);
    await page
      .getByLabel("What would success look like?")
      .fill("Complete three interviews and record the clearest learning.");
    await page.getByRole("button", { name: "Save goal" }).click();

    await expect(guide).toContainText(`${marker} pilot`);
    await expect(
      guide.getByRole("button", { name: "Prepare a first review" }),
    ).toBeVisible();
    await guide.screenshot({ path: "docs/screenshots/proactive-goal.png" });

    await page.setViewportSize({ width: 320, height: 760 });
    await page.evaluate(() => localStorage.setItem("brain-theme", "dark"));
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(guide).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.setViewportSize({ width: 1280, height: 900 });

    await guide.getByRole("button", { name: "Prepare a first review" }).click();
    await expect(guide.getByRole("status")).toContainText("Waiting safely");

    for (let index = 0; index < 5; index += 1) await fixture.prepare();
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Review the plan" }),
    ).toBeVisible();
    await expect(guide).toHaveCount(0);

    await page.getByRole("button", { name: "Review the plan" }).click();
    await expect(page.getByRole("dialog")).toContainText(marker);
    await page.getByRole("button", { name: "Keep this plan" }).click();
    await expect(guide).toContainText(
      "Your goal is chosen. You stay in control.",
    );
    await guide.getByRole("button", { name: "Turn on Stay ahead" }).click();
    await expect(guide).toContainText("BiBrain is keeping this goal in view.");
    await expect(
      guide.getByRole("button", { name: "Check this goal now" }),
    ).toBeVisible();
  } finally {
    await fixture.close();
  }
});
