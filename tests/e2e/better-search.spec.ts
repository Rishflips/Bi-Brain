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

test("Better search is on by itself with a local model, turns off on request, and comes back when chosen", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Settings & privacy" }).click();
  await expect(card(page)).toBeVisible();
  // The worker's probe found the fake model on loopback, so the card opens on, labelled as automatic, with the notice.
  await expect(card(page).getByRole("status")).toHaveText(/^On \(this computer\) · Ollama on this computer · \d+ of \d+ passages ready/, { timeout: 20000 });
  await expect(card(page).getByText("BiBrain found a search model running in Ollama on this computer")).toBeVisible();
  await expect(card(page).getByRole("radio", { name: /^Cloudflare\./ })).toBeDisabled();

  await page.getByRole("button", { name: "Today", exact: true }).click();
  await page.getByLabel("Save to your brain").fill("The crew sync is at 9 every morning.");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText(/kept exactly as you wrote it/i)).toBeVisible();
  await expect(async () => {
    await search(page, "when does the stand-up happen");
    await expect(page.getByText(/The crew sync is at 9 every morning/).first()).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 45_000, intervals: [1000, 2000] });

  // One switch: Off is stored as the owner's choice and stays off.
  await page.getByRole("button", { name: "Settings & privacy" }).click();
  await card(page).getByRole("radio", { name: /^Off\./ }).check();
  await card(page).getByRole("button", { name: "Save better search" }).click();
  await expect(page.getByText("Better search is off.")).toBeVisible();
  await expect(card(page).getByRole("status")).toHaveText("Off. Search matches the words you used.");
  await expect(card(page).getByText("A search model is running in Ollama on this computer. Choose On this computer to use it.")).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Settings & privacy" }).click();
  await expect(card(page).getByRole("status")).toHaveText("Off. Search matches the words you used.");
  await search(page, "when does the stand-up happen");
  await expect(page.getByText(/The crew sync is at 9 every morning/)).toHaveCount(0, { timeout: 5000 });

  // Chosen by hand: on again, without the automatic label.
  await page.getByRole("button", { name: "Settings & privacy" }).click();
  await card(page).getByRole("radio", { name: /^On this computer \(Ollama\)\. Nothing leaves this computer\./ }).check();
  await card(page).getByRole("button", { name: "Save better search" }).click();
  await expect(page.getByText("Better search saved. Your notes are being prepared in the background.")).toBeVisible();
  await expect(card(page).getByRole("status")).toHaveText(/^On · Ollama on this computer · \d+ of \d+ passages ready/);
  await expect(card(page).getByText("BiBrain found a search model running in Ollama on this computer")).toHaveCount(0);
});
