import { expect, test } from "@playwright/test";

test("official first use stays readable at 320px and explains the correct local secret", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto("/");

  await expect(page.locator('[data-ui="first-use"]')).toBeVisible();
  await expect(
    page.locator('[data-ui="first-use"]').getByRole("img", { name: "BiBrain" }),
  ).toBeVisible();
  await expect(
    page.locator('[data-ui="first-use"] .brand-lockup svg'),
  ).toHaveCount(1);
  await expect(page.locator('[data-ui="first-use"] img')).toHaveCount(0);
  await expect(
    page.locator('[data-ui="entry-living-field"] .brain-emblem'),
  ).toHaveCount(0);
  await expect(page.locator("html")).not.toHaveCSS("font-family", /inter/i);
  await expect(
    page.getByRole("heading", {
      name: "A private brain for everything you’re building.",
    }),
  ).toBeVisible();
  await expect(page.getByLabel("Installation code")).toBeVisible();

  await page.getByText("Where is my code?").click();
  await expect(
    page.getByText(/separate preview or custom data folder has its own code/i),
  ).toBeVisible();

  const layout = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(layout.document).toBeLessThanOrEqual(layout.viewport + 1);
});
