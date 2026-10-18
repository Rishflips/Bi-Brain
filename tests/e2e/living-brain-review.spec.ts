import { expect, test } from "@playwright/test";
import { firstNoteFixture } from "../helpers/first-note-browser.ts";

let fixture: Awaited<ReturnType<typeof firstNoteFixture>>;

test.beforeEach(async ({ page, context }) => {
  fixture = await firstNoteFixture(context);
  await fixture.open(page);
});

test.afterEach(async () => {
  await fixture?.close();
});

test("Today reflects real brain state and finds saved work without setup", async ({
  page,
}) => {
  const pulse = page.locator("[data-brain-state]");
  await expect(pulse).toHaveAttribute("data-brain-state", "ready");
  await expect(
    page.getByRole("heading", { name: "Your brain is ready." }),
  ).toBeVisible();

  const marker = `LivingBrain${Date.now()}`;
  const composer = page.locator("main").getByRole("textbox").first();
  await composer.fill(`${marker}\nA decision worth carrying to another agent.`);
  await page
    .locator("main")
    .getByRole("button", { name: /^save/i })
    .first()
    .click();

  await expect(
    page.getByRole("status").filter({ hasText: /saved/i }).first(),
  ).toContainText("Saved to your brain");
  await expect(pulse).not.toHaveAttribute("data-brain-state", "ready");

  await page.getByLabel("Find something in your brain").fill(marker);
  await page.getByRole("button", { name: "Find", exact: true }).click();

  await expect(page.getByRole("heading", { name: "Your brain" })).toBeVisible();
  await expect(page.getByLabel("Search saved material")).toHaveValue(marker);
  await expect(
    page.getByRole("button", { name: new RegExp(marker) }).first(),
  ).toBeVisible();
});

test("living state remains usable at 320px", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 820 });
  await expect(page.locator("[data-brain-state]")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Your brain is ready." }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
