import { expect, test } from "@playwright/test";
import { firstNoteFixture } from "../helpers/first-note-browser.ts";

test("Connections carries one real project into a reviewed handoff", async ({
  browser,
}) => {
  const context = await browser.newContext();
  const fixture = await firstNoteFixture(context);
  const page = await context.newPage();
  try {
    await fixture.open(page);
    const marker = `Agent continuity ${Date.now()}`;
    await page
      .getByLabel("Save to your brain")
      .fill(`We decided that ${marker} is source intact.`);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText(/kept exactly as you wrote it/i)).toBeVisible();

    await page
      .getByRole("button", { name: "Connections", exact: true })
      .click();
    const continuity = page.locator('[data-ui="agent-continuity"]');
    await expect(continuity).toContainText("Review meaning before sharing it");
    await continuity
      .getByRole("button", { name: "Review before sharing" })
      .click();
    await page.getByRole("button", { name: "Your brain", exact: true }).click();
    const memory = page.locator("article").filter({
      has: page.getByRole("heading", {
        name: marker.toLowerCase(),
      }),
    });
    await memory.getByRole("button", { name: "Accept reviewed claim" }).click();

    await page
      .getByRole("button", { name: "Connections", exact: true })
      .click();
    await expect(continuity).toBeVisible();
    await expect(continuity).toContainText("Inbox has reviewed context");
    await expect(continuity).toContainText("1");
    await expect(continuity).toContainText("No agent using this project yet");
    await expect(
      continuity.getByRole("button", { name: "Preview reviewed handoff" }),
    ).toBeVisible();

    await continuity
      .getByRole("button", { name: "Preview reviewed handoff" })
      .click();
    const handoff = page.getByRole("dialog", { name: "Project handoff" });
    await expect(handoff).toContainText(marker.toLowerCase());
    await page.getByRole("button", { name: "Close dialog" }).click();

    await page.getByRole("button", { name: "Your brain", exact: true }).click();
    await page
      .getByRole("button", { name: "New project", exact: true })
      .click();
    await page.getByLabel("Project name").fill("Quiet continuity project");
    await page
      .getByRole("button", { name: "Create project", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Connections", exact: true })
      .click();
    await expect(continuity).toContainText(
      "Quiet continuity project needs a first memory",
    );
    await expect(
      continuity.getByRole("button", { name: "Add something first" }),
    ).toBeVisible();
    await continuity.getByLabel("Project to continue").selectOption("inbox");
    await expect(continuity).toContainText("Inbox has reviewed context");

    await page.evaluate(() => localStorage.setItem("brain-theme", "dark"));
    await page.setViewportSize({ width: 320, height: 760 });
    await page.reload();
    await page
      .getByRole("button", { name: "Connections", exact: true })
      .click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(continuity).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: "docs/screenshots/agent-continuity.png",
      fullPage: true,
    });
  } finally {
    await fixture.close();
  }
});
