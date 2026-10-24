import { expect, test } from "@playwright/test";

test("a one-time link opens BiBrain signed in, once", async ({ page, request, browser }) => {
  const minted = await request.post("/api/v1/session/pair-link", { data: { secret: "e2e-local-only" } });
  expect(minted.ok()).toBe(true);
  const { token } = await minted.json();
  await page.goto(`/#pair=${token}`);
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
  expect(page.url()).not.toContain(token);

  const fresh = await browser.newContext();
  const other = await fresh.newPage();
  await other.goto(`/#pair=${token}`);
  await expect(other.getByText("This link was already used or has expired. Use the installation code instead.")).toBeVisible();
  await expect(other.getByLabel("Installation code")).toBeVisible();
  expect(other.url()).not.toContain(token);
  await fresh.close();
});
