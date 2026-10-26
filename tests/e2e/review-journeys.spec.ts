import { expect, test, type Browser, type Page } from "@playwright/test";
import { firstNoteFixture } from "../helpers/first-note-browser.ts";

// Journeys that keep a suggestion run on their own brain, so Today's Brief holds only their items.
async function journey(browser: Browser, run: (page: Page) => Promise<void>) {
  const context = await browser.newContext();
  const fixture = await firstNoteFixture(context);
  const page = await context.newPage();
  try {
    await fixture.open(page);
    await run(page);
  } finally {
    await fixture.close();
  }
}
const getJson = (page: Page, url: string) =>
  page.evaluate(async (u) => (await fetch(u, { credentials: "same-origin" })).json(), url);
// Recall also returns unreviewed originals next to a reviewed fact; the journeys assert on the reviewed facts only.
const factTexts = (r: any) => r.hits.filter((h: any) => h.kind === "fact").map((h: any) => h.text).join("\n");
// Saves and leaves the original open, so a test can add a fact from it.
async function saveAndStay(page: Page, title: string, body: string) {
  await page.getByRole("button", { name: "Save something", exact: false }).first().click();
  await page.getByLabel("Title", { exact: true }).fill(title);
  await page.getByLabel("Paste something you are working on").fill(body);
  await page.getByRole("dialog").getByRole("button", { name: "Save to my brain", exact: true }).click();
  await expect(page.getByTestId("original")).toContainText(body);
}
async function saveInDialog(page: Page, title: string, body: string) {
  await saveAndStay(page, title, body);
  await page.getByRole("button", { name: "Close dialog" }).click();
}
async function keep(page: Page, hasText: string, button = "Keep as true") {
  await page.getByRole("button", { name: "Today", exact: true }).click();
  const card = page.getByRole("article").filter({ hasText });
  await card.getByRole("button", { name: button }).click();
  await expect(card).toHaveCount(0);
}

test("ordinary capture becomes reviewed current truth and agent retrieval", async ({ browser }) => {
  await journey(browser, async (page) => {
    const entity = `browser${Date.now()}`;
    await saveInDialog(page, "Current truth evidence", `${entity} status active`);
    await keep(page, entity);
    await page.getByRole("button", { name: "Your brain", exact: true }).click();
    await expect(page.getByRole("region", { name: "True now" })).toContainText(`${entity} is active.`);
    const recall = await getJson(page, `/api/v1/agent/recall?query=${entity}%20status`);
    expect(recall.status).toBe("found");
    expect(JSON.stringify(recall.hits)).toContain(`${entity} is active.`);
  });
});

test("owner promotes an exact passage from ordinary prose through review", async ({ browser }) => {
  await journey(browser, async (page) => {
    const entity = `prose${Date.now()}`;
    const passage = `According to my note, ${entity} is paused this week.`;
    await saveAndStay(page, "Prose evidence", passage);
    await page.getByRole("button", { name: "Add a fact for review" }).click();
    await page.getByLabel("Topic or entity").fill(entity);
    await page.getByRole("combobox", { name: "Status" }).selectOption("paused");
    await expect(page.getByLabel("Exact passage from original")).toHaveValue(passage);
    await page.getByRole("button", { name: "Send for review" }).click();
    await keep(page, entity);
    await page.getByRole("button", { name: "Your brain", exact: true }).click();
    await expect(page.getByRole("region", { name: "True now" })).toContainText(entity);
    await expect(page.getByRole("region", { name: "True now" })).toContainText("paused");
  });
});

test("browser keeps, compares, dismisses and undoes source-cited decision corrections", async ({ browser }) => {
  test.setTimeout(90_000);
  await journey(browser, async (page) => {
    const key = `Browser${Date.now()} pricing`;
    const save = (value: string) => saveInDialog(page, `Browser decision ${value}`, `${key}: ${value}`);
    const current = async (value: string) => {
      const answer = await getJson(page, `/api/v1/agent/recall?query=${encodeURIComponent(key)}`);
      expect(factTexts(answer)).toContain(`: ${value}`);
    };
    await save("free");
    await keep(page, `${key}: free`);
    await current("free");
    await save("paid");
    await page.getByRole("button", { name: "Today", exact: true }).click();
    const correction = page.getByRole("article").filter({ hasText: "paid" });
    await expect(correction.getByRole("heading")).toHaveText(`${key.toLowerCase()}: paid`);
    await expect(correction).toContainText("Replaces: free");
    await current("free");
    // A correction card keeps its change with "Update the decision".
    await keep(page, "paid", "Update the decision");
    await current("paid");
    await page.getByRole("button", { name: "Your brain", exact: true }).click();
    await page.getByText("Reviewed decision history", { exact: true }).click();
    const history = page.locator("details article").filter({
      has: page.getByRole("heading", { name: `${key.toLowerCase()}: paid`, exact: true }),
    });
    await history.getByRole("button", { name: "Undo correction" }).click();
    await current("free");
    await expect(history).toContainText("Undone by you");
    await save("sponsored");
    await page.getByRole("button", { name: "Today", exact: true }).click();
    const sponsored = page.getByRole("article").filter({ hasText: "sponsored" });
    // Dismiss is sent once the 6-second undo window passes while the owner stays on Today.
    const dismissed = page.waitForResponse(
      (r) => /\/proposals\/gate\/[^/]+\/review$/.test(new URL(r.url()).pathname) && r.request().method() === "POST",
      { timeout: 15_000 },
    );
    await sponsored.getByRole("button", { name: "Dismiss" }).click();
    await expect(sponsored).toHaveCount(0);
    expect((await dismissed).ok()).toBe(true);
    await page.reload();
    await page.getByRole("button", { name: "Today", exact: true }).click();
    await expect(page.getByRole("article").filter({ hasText: "sponsored" })).toHaveCount(0);
    await current("free");
  });
});

test("plain language becomes a cited suggestion and only reaches agents after review", async ({ browser }) => {
  await journey(browser, async (page) => {
    const entity = `launch window ${Date.now()}`;
    await saveInDialog(page, "Launch timing", `The ${entity} is November 12.`);
    await page.getByRole("button", { name: "Today", exact: true }).click();
    const card = page.getByRole("article").filter({ hasText: entity });
    await expect(card).toBeVisible();
    await expect(card).toContainText("November 12");

    const before = await getJson(page, `/api/v1/agent/recall?query=${encodeURIComponent(entity)}`);
    expect(before.hits.every((h: any) => h.kind !== "fact")).toBe(true);

    await keep(page, entity);
    await page.getByRole("button", { name: "Your brain", exact: true }).click();
    await expect(page.getByRole("region", { name: "True now" })).toContainText("November 12");
    const after = await getJson(page, `/api/v1/agent/recall?query=${encodeURIComponent(entity)}`);
    expect(factTexts(after)).toContain("November 12");
  });
});

test("owner can teach a decision from an arbitrary exact passage", async ({ browser }) => {
  await journey(browser, async (page) => {
    const entity = `launch scope ${Date.now()}`;
    const body = "After discussion, the team leaned toward the smaller launch.";
    await saveAndStay(page, "Scope discussion", body);
    await page.getByRole("button", { name: "Add a fact for review" }).click();
    await page.getByLabel("Topic or entity").fill(entity);
    await page.getByLabel("What kind of memory is this?").selectOption("decision");
    await page.getByLabel("What should BiBrain remember?").fill("smaller launch");
    await expect(page.getByLabel("Exact passage from original")).toHaveValue(body);
    await page.getByRole("button", { name: "Send for review" }).click();

    await page.getByRole("button", { name: "Today", exact: true }).click();
    const card = page.getByRole("article").filter({ hasText: entity });
    await expect(card).toBeVisible();
    await expect(card).toContainText("smaller launch");
    const before = await getJson(page, `/api/v1/agent/recall?query=${encodeURIComponent(entity)}`);
    expect(before.hits.every((h: any) => h.kind !== "fact")).toBe(true);
    await keep(page, entity);

    const answer = await getJson(page, `/api/v1/agent/recall?query=${encodeURIComponent(entity)}`);
    expect(factTexts(answer)).toContain("smaller launch");
  });
});
