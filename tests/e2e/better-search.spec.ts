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

// Runs before the journey below: the journey stores a choice, and the automatic state exists only while none is stored.
test("Better search fits a 320px dark screen", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.emulateMedia({ colorScheme: "dark" });
  await open(page);
  await page.getByRole("button", { name: "Settings & privacy" }).click();
  await expect(card(page)).toBeVisible();
  // The automatic state carries the longest copy: the status line and the notice.
  await expect(card(page).getByRole("status")).toHaveText(/^On \(this computer\)/, { timeout: 20000 });
  await expect(card(page).getByText("BiBrain found a search model running in Ollama on this computer")).toBeVisible();
  const fits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(fits).toBe(true);
  const cardFits = await card(page).evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
  expect(cardFits).toBe(true);
});

test("Better search is on by itself with a local model, turns off on request, and comes back when chosen", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Settings & privacy" }).click();
  await expect(card(page)).toBeVisible();
  // The worker's probe found the fake model on loopback, so the card opens on, labelled as automatic, with the notice.
  await expect(card(page).getByRole("status")).toHaveText(/^On \(this computer\) · Ollama on this computer · \d+ of \d+ passages ready/, { timeout: 20000 });
  await expect(card(page).getByText("BiBrain found a search model running in Ollama on this computer")).toBeVisible();
  await expect(card(page).getByRole("radio", { name: /^Cloudflare\./ })).toBeDisabled();

  // The card's own role="status" stays unique; the lead line is found by its test id. The measured date is yesterday on the test clock, so it passes the server's "no later than tomorrow (UTC)" check on any day the suite runs.
  const measuredOn = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const leadLine = card(page).getByTestId("meaning-lead-line");
  const today = new Date().toISOString().slice(0, 10);
  const calibratedLine = `Calibrated at 0.6: a match found by meaning alone can lead a push when its score is 0.6 or higher. From proof:search, 20 queries measured on ${measuredOn}, applied ${today}.`;
  const notCalibrated = "Not yet calibrated. A match found by meaning alone never leads a push to your agents. Run npm run proof:search or npm run calibrate for a suggested value, then enter it here.";
  const fillLead = async (score: string) => {
    await card(page).getByLabel("Score (from the tool's suggestion)").fill(score);
    await card(page).getByLabel("Queries measured").fill("20");
    await card(page).getByLabel("Measured on").fill(measuredOn);
    await card(page).getByRole("button", { name: "Apply this value" }).click();
  };
  await expect(leadLine).toHaveText(notCalibrated);
  // A value under the search model's floor is refused beside the form, in plain words, and nothing is stored.
  await fillLead("0.01");
  await expect(card(page).getByTestId("meaning-lead-error")).toHaveText(/^The value must be between \d\.\d+ \(the floor for this search model\) and 0\.99\.$/);
  await expect(leadLine).toHaveText(notCalibrated);
  await page.reload();
  await page.getByRole("button", { name: "Settings & privacy" }).click();
  await expect(leadLine).toHaveText(notCalibrated);
  await fillLead("0.6");
  await expect(page.getByText("Meaning matches can now lead a push at the value you entered.")).toBeVisible();
  await expect(leadLine).toHaveText(calibratedLine);
  await expect(card(page).getByLabel("Score (from the tool's suggestion)")).toHaveValue("");
  await expect(card(page).getByTestId("meaning-lead-error")).toHaveCount(0);
  await card(page).getByRole("button", { name: "Clear this value" }).click();
  await expect(leadLine).toHaveText(notCalibrated);
  await fillLead("0.6");
  await expect(leadLine).toHaveText(calibratedLine);

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
  await expect(leadLine).toHaveText("Turn Better search on first.");
  // A stored value can always be removed, even while Better search is off.
  await card(page).getByRole("button", { name: "Clear this value" }).click();
  await expect(card(page).getByRole("button", { name: "Clear this value" })).toHaveCount(0);
  await expect(leadLine).toHaveText("Turn Better search on first.");
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
