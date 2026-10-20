import { expect, test } from "@playwright/test";
import { firstNoteFixture } from "../helpers/first-note-browser.ts";

test("Your brain turns one real project into a focused, portable workspace", async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const context = await browser.newContext();
  const fixture = await firstNoteFixture(context);
  const page = await context.newPage();
  try {
    await fixture.open(page);
    const marker = "Project focus " + Date.now();

    await page
      .locator("main")
      .getByRole("textbox")
      .first()
      .fill("We decided that " + marker + " is invite only.");
    await page
      .locator("main")
      .getByRole("button", { name: /^save/i })
      .first()
      .click();

    await page
      .locator('[data-ui="first-session-journey"]')
      .getByRole("button", { name: "Review memory" })
      .click();
    const memory = page.locator("article").filter({
      has: page.getByRole("heading", { name: marker.toLowerCase() }),
    });
    await memory.getByRole("button", { name: "Accept reviewed claim" }).click();

    const focus = page.locator('[data-ui="project-focus"]');
    await expect(focus).toBeVisible();
    await expect(focus.getByRole("heading", { name: "Inbox" })).toBeVisible();
    await expect(focus).toContainText("1 reviewed memory");
    await expect(focus).toContainText("invite only");
    await expect(focus).toContainText("Reviewed by you");
    await expect(focus).toContainText("Nothing waiting for review");

    await focus.getByRole("button", { name: "Set project direction" }).click();
    await page
      .getByLabel("What do you want to accomplish?")
      .fill(marker + " launch");
    await page
      .getByLabel("What would success look like?")
      .fill("Invite five people and record their first useful moment.");
    await page.getByRole("button", { name: "Save goal" }).click();
    await expect(focus).toContainText(marker + " launch");
    await expect(focus).toContainText(
      "Invite five people and record their first useful moment.",
    );

    await focus.getByRole("button", { name: "Preview agent handoff" }).click();
    const handoff = page.getByRole("dialog", { name: "Project handoff" });
    await expect(handoff).toBeVisible();
    await expect(handoff).toContainText(marker);
    await expect(handoff).toContainText(marker + " launch");
    await page.getByRole("button", { name: "Close dialog" }).click();

    await focus.getByRole("button", { name: "Open recent original 1" }).click();
    await expect(page.getByRole("dialog")).toContainText(
      "We decided that " + marker + " is invite only.",
    );
    await page.getByRole("button", { name: "Close dialog" }).click();

    await page.getByLabel("Project", { exact: true }).selectOption("");
    const overview = page.locator('[data-ui="project-overview"]');
    await expect(overview).toBeVisible();
    await expect(overview).toContainText("Pick up where you left off.");
    await overview.getByRole("button", { name: /Inbox/ }).click();
    await expect(focus).toBeVisible();

    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({
      path: "docs/screenshots/project-focus.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 320, height: 760 });
    await page.evaluate(() => localStorage.setItem("brain-theme", "dark"));
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(focus).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  } finally {
    await fixture.close();
  }
});
