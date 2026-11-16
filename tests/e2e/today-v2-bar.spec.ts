import { expect, test, type BrowserContext, type Page } from "@playwright/test";

// These journeys run in their own Playwright project with their own server, so
// their requests do not count against the per-minute budget of today-v2.spec.ts.
type Cookies = Parameters<BrowserContext["addCookies"]>[0];
let paired: Cookies | null = null;
async function pair(page: Page) {
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  if (paired) await page.context().addCookies(paired);
  await page.goto("/");
  if (!paired) {
    await page.getByLabel("Installation code").fill("e2e-local-only");
    await page.getByRole("button", { name: "Open my brain" }).click();
    await expect(nav).toBeVisible();
    paired = await page.context().cookies();
  }
  await expect(nav).toBeVisible();
}

test("the bar goes back to Save when an automatic Ask no longer fits, and never overrides the owner", async ({
  page,
}) => {
  await pair(page);
  const bar = page.getByLabel(/save to your brain|ask your brain/i);
  const mode = (name: "Save mode" | "Ask mode") =>
    page.getByRole("button", { name });
  await bar.fill("Remember to call Sam?");
  await expect(mode("Ask mode")).toHaveAttribute("aria-pressed", "true");
  // The owner deletes the question mark and keeps writing a note.
  await bar.press("Backspace");
  await expect(mode("Save mode")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Save mode", { exact: true })).toBeVisible();
  await bar.fill("Remember to call Sam about the venue\nsecond line");
  await page.keyboard.press("Enter");
  await expect(page.getByText(/kept exactly as you wrote it/i)).toBeVisible();
  await expect(page.getByText("From your brain")).toHaveCount(0);
  // A mode the owner chose is left alone, whatever the text looks like.
  await mode("Ask mode").click();
  await bar.fill("not a question at all");
  await expect(mode("Ask mode")).toHaveAttribute("aria-pressed", "true");
});

test("a dismissal is dropped, not sent, when the owner leaves Today first", async ({
  page,
}) => {
  await pair(page);
  await page
    .getByLabel("Save to your brain")
    .fill("We decided that Hydra pad is red.");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const card = page.getByRole("article").filter({ hasText: "Hydra" });
  await expect(card).toBeVisible();
  let sent = 0;
  await page.route("**/api/v1/proposals/gate/*/review", (route) => {
    sent += 1;
    return route.continue();
  });
  await card.getByRole("button", { name: "Dismiss" }).click();
  await expect(card).toHaveCount(0);
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  await nav.getByText("Your brain", { exact: false }).first().click();
  await expect(page.getByRole("heading", { name: "Your brain" })).toBeVisible();
  await page.waitForTimeout(6500);
  expect(sent).toBe(0);
  await nav.getByText("Today", { exact: false }).first().click();
  await expect(
    page.getByRole("article").filter({ hasText: "Hydra" }),
  ).toBeVisible();
});

test("an answer that cites a note outside the newest 50 clears when that note is withdrawn", async ({
  page,
}) => {
  await pair(page);
  const stamp = Date.now();
  const save = async (text: string) => {
    await page.getByLabel(/save to your brain|ask your brain/i).fill(text);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText(/kept exactly as you wrote it/i)).toBeVisible();
  };
  const cited = `Zebra archive ${stamp} stored in the east vault.`;
  await save(cited);
  await save(`Other plain note ${stamp} so Today is not empty.`);
  const found = await (
    await page.request.get(
      `/api/v1/search?q=${encodeURIComponent(`Zebra archive ${stamp}`)}`,
    )
  ).json();
  const id: string = (Array.isArray(found) ? found : found.items)[0].id;
  // The note list is capped at the newest 50, so an older cited note is not in it.
  await page.route(/\/api\/v1\/search$/u, async (route) => {
    const res = await route.fetch();
    const list = await res.json();
    await route.fulfill({
      response: res,
      json: list.filter((n: any) => n.id !== id),
    });
  });
  await page.route("**/api/v1/ask*", (route) =>
    route.fulfill({
      json: {
        question: "Where is the zebra archive?",
        hits: [
          {
            type: "original",
            id,
            project_id: "inbox",
            title: `Zebra archive ${stamp}`,
            snippet: cited,
            source_version: 1,
          },
        ],
      },
    }),
  );
  await page.reload();
  const bar = page.getByLabel(/save to your brain|ask your brain/i);
  await bar.fill("Where is the zebra archive?");
  await page.keyboard.press("Enter");
  await expect(page.getByText("From your brain")).toBeVisible();
  await page.getByRole("button", { name: `Zebra archive ${stamp}` }).click();
  await page.getByRole("button", { name: "Delete / withdraw" }).click();
  await page
    .getByRole("button", { name: "Withdraw from active use" })
    .click();
  await expect(page.getByText("From your brain")).toHaveCount(0);
  // The withdraw starts a background refresh whose /search request may still be
  // inside the route handler above; release it so the test can end cleanly.
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("the header says so when the Brief cannot be checked", async ({ page }) => {
  await pair(page);
  await page.evaluate(async () => {
    const session = await (await fetch("/api/v1/session")).json();
    await fetch("/api/v1/sources", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Brain-CSRF": session.csrf,
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({
        title: "Header check note",
        body: "A plain note so the brain is not empty.",
        project_id: "inbox",
        visibility: "private",
      }),
    });
  });
  await page.route("**/api/v1/brief", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "INTERNAL", message: "Down." } }),
    }),
  );
  await page.reload();
  await expect(page.locator(".tv-state")).toHaveText(
    "Couldn't check for changes",
  );
});

test("text follows a larger default text size on a phone without sideways scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // A larger text size in the browser arrives as a larger root font size. The page's policy forbids an inline <style>, so use a constructable sheet.
  await page.addInitScript(() => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync("html { font-size: 20px; }");
    document.adoptedStyleSheets = [sheet];
  });
  await pair(page);
  await expect(page.locator("body")).toHaveCSS("font-size", "20px");
  const title = await page.locator(".tv-title").evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(title).toBeGreaterThan(30);
  const bar = page.getByLabel(/save to your brain|ask your brain/i);
  await expect(bar).toBeVisible();
  expect(await bar.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(18);
  for (const tab of ["Today", "Your brain", "Connections"]) {
    await page.getByRole("button", { name: tab, exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), tab).toBe(true);
  }
  await page.getByRole("button", { name: "Settings & privacy" }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("Today has one way to save and carries its own status; other pages keep Save something", async ({ page }) => {
  await pair(page);
  const header = page.locator("header.masthead");
  await expect(page.locator("main .tv-head .tv-state")).toHaveText(/Caught up|\d+ to look at|Background help off/);
  await expect(page.locator(".tv-state")).toHaveCount(1);
  await expect(header.getByRole("button", { name: /Save something/ })).toHaveCount(0);
  for (const tab of ["Your brain", "Connections"]) {
    await page.getByRole("button", { name: tab, exact: true }).click();
    await expect(header.getByRole("button", { name: /Save something/ })).toBeVisible();
    await expect(page.locator(".tv-state")).toHaveCount(0);
  }
  // The header button still opens the save dialog and takes focus back.
  await header.getByRole("button", { name: /Save something/ }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(header.getByRole("button", { name: /Save something/ })).toBeFocused();
});

test("the status wraps under the title on a 320px screen", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.route("**/api/v1/brief", (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "INTERNAL", message: "Down." } }) }),
  );
  await pair(page);
  const state = page.locator(".tv-state");
  await expect(state).toHaveText("Couldn't check for changes");
  expect(await state.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});

test("on a phone the header is one row and Settings is an icon button in it", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await pair(page);
  const header = page.locator("header.masthead");
  const settings = header.getByRole("button", { name: "Settings & privacy" });
  await expect(settings).toBeVisible();
  await expect(page.locator("aside").getByRole("button", { name: "Settings & privacy" })).toHaveCount(0);
  const box = (await settings.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);
  for (const tab of ["Today", "Your brain", "Connections"]) {
    await page.getByRole("button", { name: tab, exact: true }).click();
    expect((await header.boundingBox())!.height, tab).toBeLessThanOrEqual(72);
  }
  await page.getByRole("button", { name: "Your brain", exact: true }).click();
  const newProject = page.getByRole("button", { name: "New project" });
  await expect(newProject).toBeVisible();
  expect((await newProject.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await settings.click();
  await expect(page.getByRole("heading", { name: "Settings & privacy", level: 1 })).toBeVisible();
  await expect(settings).toHaveAttribute("aria-current", "page");
  // The narrowest screen, with both header actions present.
  await page.setViewportSize({ width: 320, height: 720 });
  await expect(header.getByRole("button", { name: /Save something/ })).toBeVisible();
  expect((await header.boundingBox())!.height).toBeLessThanOrEqual(72);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});

test("on a wide screen Settings stays in the side rail", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await pair(page);
  await expect(page.locator("header.masthead").getByRole("button", { name: "Settings & privacy" })).toHaveCount(0);
  const rail = page.locator("aside").getByRole("button", { name: "Settings & privacy" });
  await expect(rail).toBeVisible();
  await expect(rail).not.toHaveAttribute("aria-current", "page");
  await rail.click();
  await expect(rail).toHaveAttribute("aria-current", "page");
});
