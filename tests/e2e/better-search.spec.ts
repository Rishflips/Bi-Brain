import { expect, test, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });
test.setTimeout(90_000);

async function open(page: Page) {
  await page.goto("/");
  const code = page.getByLabel("Installation code");
  const bar = page.getByLabel("Save to your brain");
  await expect(code.or(bar)).toBeVisible();
  if (await code.isVisible()) {
    await code.fill("e2e-local-only");
    await page.getByRole("button", { name: "Open my brain" }).click();
  }
  await expect(bar).toBeVisible();
}
const card = (page: Page) => page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Better search" }) });
async function search(page: Page, q: string) {
  await page.getByRole("button", { name: "Your brain", exact: true }).click();
  const field = page.getByPlaceholder("Search facts and originals");
  await field.fill("");
  await field.fill(q);
}

test("Better search is chosen in Settings, finds a note by meaning, and goes back to words only", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Settings & privacy" }).click();
  await expect(card(page)).toBeVisible();
  await expect(card(page).getByRole("status")).toHaveText("Off. Search matches the words you used.");
  const cloud = card(page).getByRole("radio", { name: /^Cloudflare\./ });
  await expect(cloud).toBeDisabled();
  await expect(card(page).getByText("Not set up on this computer.")).toBeVisible();
  const local = card(page).getByRole("radio", { name: /^On this computer \(Ollama\)\. Nothing leaves this computer\./ });
  // The worker publishes its setup a moment after start; the choice enables once it has.
  await expect(local).toBeEnabled({ timeout: 20000 });
  await local.check();
  await card(page).getByRole("button", { name: "Save better search" }).click();
  await expect(page.getByText("Better search saved. Your notes are being prepared in the background.")).toBeVisible();
  await expect(card(page).getByRole("status")).toHaveText(/^On · Ollama on this computer · \d+ of \d+ passages ready/);

  await page.getByRole("button", { name: "Today", exact: true }).click();
  await page.getByLabel("Save to your brain").fill("The crew sync is at 9 every morning.");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText(/kept exactly as you wrote it/i)).toBeVisible();

  // No shared word with the note; only meaning finds it, once the worker has prepared it.
  await expect(async () => {
    await search(page, "when does the stand-up happen");
    await expect(page.getByText(/The crew sync is at 9 every morning/).first()).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 45_000, intervals: [1000, 2000] });
  await expect(page.getByText("Search is using words only right now.")).toHaveCount(0);

  await page.getByRole("button", { name: "Settings & privacy" }).click();
  await card(page).getByRole("radio", { name: /^Off\./ }).check();
  await card(page).getByRole("button", { name: "Save better search" }).click();
  await expect(page.getByText("Better search is off.")).toBeVisible();
  await expect(card(page).getByRole("status")).toHaveText("Off. Search matches the words you used.");
  await search(page, "when does the stand-up happen");
  await expect(page.getByText(/The crew sync is at 9 every morning/)).toHaveCount(0, { timeout: 5000 });
});

test("Better search fits a 320px dark screen", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.emulateMedia({ colorScheme: "dark" });
  await open(page);
  await page.getByRole("button", { name: "Settings & privacy" }).click();
  await expect(card(page)).toBeVisible();
  const fits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(fits).toBe(true);
  const cardFits = await card(page).evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
  expect(cardFits).toBe(true);
});
