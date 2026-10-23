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
