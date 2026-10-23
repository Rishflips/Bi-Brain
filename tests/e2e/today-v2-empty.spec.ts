import { expect, test, type Page } from "@playwright/test";

async function pair(page: Page) {
  await page.goto("/");
  await page.getByLabel("Installation code").fill("e2e-local-only");
  await page.getByRole("button", { name: "Open my brain" }).click();
  await expect(
    page.getByRole("navigation", { name: "Main navigation" }),
  ).toBeVisible();
}

// Runs in its own Playwright project with its own fresh database, so the brain is
// genuinely empty regardless of what the other specs saved.
test("a new brain shows three ways to start and no fake activity", async ({
  page,
}) => {
  await pair(page);
  await expect(
    page.getByRole("heading", { name: "Welcome to BiBrain." }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Choose an agent" }),
  ).toBeVisible();
  await expect(page.getByText(/things to look at/i)).toHaveCount(0);
  await expect(page.locator(".tv-state")).toHaveText("Empty brain");

  await page.setViewportSize({ width: 320, height: 700 });
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);

  await page.getByRole("button", { name: "Choose an agent" }).click();
  await expect(
    page.getByRole("heading", { name: /connections/i }).first(),
  ).toBeVisible();
});
