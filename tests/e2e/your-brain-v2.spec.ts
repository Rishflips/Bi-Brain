import { expect, test, type Browser, type Page } from "@playwright/test";
import { firstNoteFixture } from "../helpers/first-note-browser.ts";

// Each journey gets its own brain, so nothing another spec saved can crowd the Brief.
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
async function save(page: Page, text: string) {
  const bar = page.getByLabel(/save to your brain|ask your brain/i);
  await bar.fill(text);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(bar).toHaveValue("");
}
async function keepOnToday(page: Page, text: string) {
  const card = page.getByRole("article").filter({ hasText: text });
  await card.getByRole("button", { name: "Keep as true" }).click();
  await expect(card).toHaveCount(0);
}
async function openBrain(page: Page) {
  await page.getByRole("button", { name: "Your brain", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your brain", level: 1 })).toBeVisible();
}

test("Your brain shows the open project, its originals newest first, and switches projects", async ({ browser }) => {
  await journey(browser, async (page) => {
    await save(page, "First note about the Hydra launch.");
    await save(page, "Second note about the Hydra launch.");
    await openBrain(page);
    await expect(page.getByRole("heading", { name: "Inbox", level: 2 })).toBeVisible();
    await expect(page.getByText("No agent connected")).toBeVisible();
    const originals = page.getByRole("region", { name: "Originals" });
    const titles = originals.getByRole("listitem").getByRole("button");
    await expect(titles.first()).toHaveText(/Second note/);
    await expect(titles.nth(1)).toHaveText(/First note/);
    await titles.first().click();
    await expect(page.getByTestId("original")).toHaveText("Second note about the Hydra launch.");
    await page.getByRole("button", { name: "Close dialog" }).click();
    const projects = page.getByRole("navigation", { name: "Projects" });
    await projects.getByRole("button", { name: "New project" }).click();
    await page.getByLabel("Project name").fill("Hydra");
    await page.getByRole("button", { name: "Create project", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Hydra", level: 2 })).toBeVisible();
    await expect(originals).toContainText("Nothing saved here yet.");
    await projects.getByRole("button", { name: "Inbox" }).click();
    await expect(page.getByRole("heading", { name: "Inbox", level: 2 })).toBeVisible();
  });
});

test("a suggestion is counted here and reviewed on Today", async ({ browser }) => {
  await journey(browser, async (page) => {
    await save(page, "We decided that Northstar beta is invite only.");
    await openBrain(page);
    await expect(page.getByText("1 thing to look at on Today.")).toBeVisible();
    await page.getByRole("button", { name: "Review on Today" }).click();
    await expect(page.getByRole("article").filter({ hasText: "invite only" })).toBeVisible();
  });
});

test("Your brain fits a 320px screen in dark appearance", async ({ browser }) => {
  await journey(browser, async (page) => {
    await save(page, "A note with a long unbroken word Supercalifragilisticexpialidocious_and_more_words_here.");
    await page.setViewportSize({ width: 320, height: 760 });
    await page.emulateMedia({ colorScheme: "dark" });
    await openBrain(page);
    await expect(page.getByRole("navigation", { name: "Projects" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const nav = page.getByRole("navigation", { name: "Projects" });
    const columns = await nav.evaluate((el) => getComputedStyle(el).gridTemplateColumns.trim().split(/\s+/));
    expect(columns).toHaveLength(1);
    const last = await nav.locator("li button").last().boundingBox();
    const fresh = await nav.getByRole("button", { name: "New project" }).boundingBox();
    expect(fresh!.y).toBeGreaterThanOrEqual(last!.y + last!.height);
  });
});

test("a kept fact shows under True now and can be edited, with Undo", async ({ browser }) => {
  await journey(browser, async (page) => {
    await save(page, "We decided that Northstar beta is invite only.");
    await keepOnToday(page, "invite only");
    await openBrain(page);
    const facts = page.getByRole("region", { name: "True now" });
    const row = facts.getByRole("listitem").filter({ hasText: "invite only" });
    await expect(row).toContainText("version 1");
    await expect(row).toContainText("Checked");
    await row.getByRole("button", { name: "Edit" }).click();
    await facts.getByLabel("Edit fact").fill("invite only until launch");
    await facts.getByRole("button", { name: "Save as version 2" }).click();
    await expect(facts).toContainText("invite only until launch");
    const toast = page.locator(".tv-toast");
    await expect(toast).toContainText("Saved as version 2.");
    await toast.getByRole("button", { name: "Undo" }).click();
    await expect(toast).toContainText("Undone.");
    await expect(facts).not.toContainText("until launch");
    await expect(facts.getByRole("listitem").filter({ hasText: "invite only" })).toContainText("version 3");
    await page.getByRole("button", { name: "Preview handoff" }).click();
    await expect(page.getByRole("dialog", { name: "Project handoff" })).toContainText("invite only");
  });
});

test("an edit from a second tab is refused and keeps the draft", async ({ browser }) => {
  const context = await browser.newContext();
  const fixture = await firstNoteFixture(context);
  const first = await context.newPage();
  try {
    await fixture.open(first);
    await save(first, "We decided that Northstar beta is invite only.");
    await keepOnToday(first, "invite only");
    await openBrain(first);
    const second = await context.newPage();
    await fixture.open(second);
    await openBrain(second);
    // The second tab starts its edit first, from version 1.
    const secondFacts = second.getByRole("region", { name: "True now" });
    await secondFacts.getByRole("button", { name: "Edit" }).click();
    await secondFacts.getByLabel("Edit fact").fill("open to everyone");
    const firstFacts = first.getByRole("region", { name: "True now" });
    await firstFacts.getByRole("button", { name: "Edit" }).click();
    await firstFacts.getByLabel("Edit fact").fill("invite only until launch");
    await firstFacts.getByRole("button", { name: "Save as version 2" }).click();
    await expect(first.locator(".tv-toast")).toContainText("Saved as version 2.");
    // The page re-reads every 2.5 seconds; let it, so the test proves the edit stays pinned.
    await second.waitForTimeout(3000);
    await secondFacts.getByRole("button", { name: "Save as version 2" }).click();
    await expect(second.getByRole("alert").filter({ hasText: /changed since you opened it/i })).toBeVisible();
    await expect(secondFacts.getByLabel("Edit fact")).toHaveValue("open to everyone");
    await expect(firstFacts).toContainText("invite only until launch");
  } finally {
    await fixture.close();
  }
});

test("editing a fact is complete by keyboard and keeps focus in place", async ({ browser }) => {
  await journey(browser, async (page) => {
    await save(page, "We decided that Northstar beta is invite only.");
    await keepOnToday(page, "invite only");
    await openBrain(page);
    const facts = page.getByRole("region", { name: "True now" });
    const edit = facts.getByRole("button", { name: "Edit", exact: true });
    const box = facts.getByLabel("Edit fact");
    await edit.focus();
    await page.keyboard.press("Enter");
    await expect(box).toBeFocused();
    await page.keyboard.type(" for now");
    await page.keyboard.press("Escape");
    await expect(box).toHaveCount(0);
    await expect(edit).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(box).toBeFocused();
    await box.fill("invite only until launch");
    await page.keyboard.press("Tab");
    await expect(facts.getByRole("button", { name: "Save as version 2" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(facts).toContainText("invite only until launch");
    await expect(box).toHaveCount(0);
    await expect(edit).toBeFocused();
  });
});

test("an open question can be marked answered and brought back", async ({ browser }) => {
  await journey(browser, async (page) => {
    await save(page, "Launch notes\nOpen question: who writes the launch post?");
    await openBrain(page);
    const questions = page.getByRole("region", { name: "Open questions" });
    const item = questions.getByRole("listitem").filter({ hasText: "who writes the launch post?" });
    await expect(item).toBeVisible();
    await item.getByRole("button", { name: "Mark answered" }).click();
    const toast = page.locator(".tv-toast");
    await expect(toast).toContainText("Marked as answered.");
    await expect(item).toHaveCount(0);
    await expect(questions).toContainText("Nothing open.");
    await expect(questions.getByRole("heading", { name: "Open questions" })).toBeFocused();
    await toast.getByRole("button", { name: "Undo" }).click();
    await expect(item).toHaveCount(1);
    await item.getByRole("button", { name: "Mark answered" }).click();
    await expect(item).toHaveCount(0);
    await page.reload();
    await openBrain(page);
    await expect(questions).toContainText("Nothing open.");
  });
});

test("answering one of two questions moves focus to the next one", async ({ browser }) => {
  await journey(browser, async (page) => {
    await save(page, "Launch notes\nOpen question: who writes the launch post?\nOpen question: when do invites go out?");
    await openBrain(page);
    const questions = page.getByRole("region", { name: "Open questions" });
    const buttons = questions.getByRole("button", { name: "Mark answered" });
    await expect(buttons).toHaveCount(2);
    const first = questions.getByRole("listitem").filter({ hasText: "who writes the launch post?" });
    await first.getByRole("button", { name: "Mark answered" }).click();
    await expect(first).toHaveCount(0);
    await expect(buttons).toHaveCount(1);
    await expect(buttons.first()).toBeFocused();
  });
});

test("focus still lands when a refresh overlaps the re-read after an answer", async ({ browser }) => {
  await journey(browser, async (page) => {
    await save(page, "Launch notes\nOpen question: who writes the launch post?");
    await openBrain(page);
    const questions = page.getByRole("region", { name: "Open questions" });
    const item = questions.getByRole("listitem").filter({ hasText: "who writes the launch post?" });
    await expect(item).toBeVisible();
    // The app is served through a context route, so these handlers hand on with fallback().
    // After the answer is stored: hold the first read until a second read starts, then let the
    // first finish while the second is still in flight.
    let armed = false;
    let reads = 0;
    let secondStarted!: () => void;
    const second = new Promise<void>((r) => (secondStarted = r));
    await page.route("**/api/v1/questions/answer", async (route) => {
      await route.fallback();
      armed = true;
    });
    await page.route("**/api/v1/brain/projects/*", async (route) => {
      if (!armed) return route.fallback();
      reads += 1;
      if (reads === 1) {
        await second;
        return route.fallback();
      }
      if (reads === 2) {
        secondStarted();
        await new Promise((r) => setTimeout(r, 500));
      }
      return route.fallback();
    });
    await item.getByRole("button", { name: "Mark answered" }).click();
    await expect(item).toHaveCount(0, { timeout: 12_000 });
    await expect(questions.getByRole("heading", { name: "Open questions" })).toBeFocused({ timeout: 12_000 });
    await page.unrouteAll({ behavior: "ignoreErrors" });
  });
});

test("a fact opens its original with the passage highlighted and its history", async ({ browser }) => {
  await journey(browser, async (page) => {
    const body = "Kickoff notes.\nWe decided that Northstar beta is invite only.\nEverything else waits.";
    await save(page, body);
    await keepOnToday(page, "invite only");
    await openBrain(page);
    const facts = page.getByRole("region", { name: "True now" });
    await facts.getByRole("button", { name: "Edit" }).click();
    await facts.getByLabel("Edit fact").fill("invite only until launch");
    await facts.getByRole("button", { name: "Save as version 2" }).click();
    await expect(page.locator(".tv-toast")).toContainText("Saved as version 2.");
    await facts.getByRole("button", { name: "Open the original" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByTestId("original")).toHaveText(body);
    await expect(dialog.locator("mark")).toHaveCount(1);
    await expect(dialog.locator("mark")).toContainText("invite only");
    await expect(dialog.locator("mark")).not.toContainText("Everything else");
    const history = dialog.getByRole("region", { name: "History of this fact" });
    await expect(history.getByRole("listitem")).toHaveCount(2);
    await expect(history.getByRole("listitem").first()).toContainText("You edited this");
    await expect(history.getByRole("listitem").last()).toContainText("Kept from this original");
    await expect(dialog.getByRole("region", { name: "Facts taken from this" })).toContainText("invite only until launch");
    await expect(dialog.getByRole("button", { name: "Correct or move source" })).toBeVisible();
  });
});

test("a Brief card's quote opens the original with that passage highlighted", async ({ browser }) => {
  await journey(browser, async (page) => {
    await save(page, "Kickoff notes.\nWe decided that Northstar beta is invite only.");
    const card = page.getByRole("article").filter({ hasText: "invite only" });
    await card.locator(".tv-quote").first().click();
    await expect(page.getByRole("dialog").locator("mark")).toContainText("invite only");
  });
});

test("a new note's dialog does not carry the last fact's history", async ({ browser }) => {
  await journey(browser, async (page) => {
    await save(page, "Kickoff notes.\nWe decided that Northstar beta is invite only.");
    await keepOnToday(page, "invite only");
    await openBrain(page);
    await page.getByRole("region", { name: "True now" }).getByRole("button", { name: "Open the original" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("region", { name: "History of this fact" })).toBeVisible();
    await dialog.getByRole("button", { name: "Close dialog" }).click();
    await expect(dialog).toHaveCount(0);
    await page.getByRole("button", { name: "Save to this project" }).click();
    await page.getByLabel("Paste something you are working on").fill("A fresh note about something else entirely.");
    await page.getByRole("dialog").getByRole("button", { name: "Save to my brain" }).click();
    const next = page.getByRole("dialog");
    await expect(next.getByTestId("original")).toHaveText("A fresh note about something else entirely.");
    await expect(next.getByRole("region", { name: "History of this fact" })).toHaveCount(0);
    await expect(next.getByText("no longer in this original")).toHaveCount(0);
  });
});

test("search finds facts and originals and opens them; one letter sends nothing", async ({ browser }) => {
  await journey(browser, async (page) => {
    await save(page, "We decided that Northstar beta is invite only.");
    await keepOnToday(page, "invite only");
    await save(page, "Long retained passage. ".repeat(60) + "ZEBRA_SENTINEL lives at the end.");
    await openBrain(page);
    let sent = 0;
    await page.route("**/api/v1/brain/search*", (route) => {
      sent += 1;
      return route.fallback();
    });
    const search = page.getByLabel("Search your brain");
    await search.fill("n");
    await expect(page.getByText("Type at least two letters.")).toBeVisible();
    await page.waitForTimeout(400);
    expect(sent).toBe(0);
    await search.fill("northstar");
    await expect(page.getByRole("heading", { name: "Facts" })).toBeVisible();
    await expect(page.getByRole("region", { name: /match/ })).toContainText("invite only");
    await search.fill("ZEBRA_SENTINEL");
    const hit = page.getByRole("button", { name: /ZEBRA_SENTINEL/ });
    await expect(hit).toBeVisible();
    await hit.click();
    await expect(page.getByTestId("original")).toContainText("ZEBRA_SENTINEL lives at the end.");
    await page.getByRole("button", { name: "Close dialog" }).click();
    await search.fill("nothing-like-this-anywhere");
    await expect(page.getByText("No matches. Try a different word, or save something new.")).toBeVisible();
    await page.getByRole("button", { name: "Clear search" }).click();
    await expect(page.getByRole("heading", { name: "Inbox", level: 2 })).toBeVisible();
    await expect(search).toBeFocused();
  });
});

test("a late answer to an earlier search never replaces newer results", async ({ browser }) => {
  await journey(browser, async (page) => {
    await save(page, "Northstar beta note.");
    await save(page, "Zebra archive note.");
    await openBrain(page);
    let release!: () => void;
    let arrived = false;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route(
      (url) => url.pathname === "/api/v1/brain/search" && url.searchParams.get("q") === "northstar",
      async (route) => {
        arrived = true;
        await held;
        await route.fallback();
      },
    );
    const search = page.getByLabel("Search your brain");
    await search.fill("northstar");
    await expect.poll(() => arrived).toBe(true);
    await search.fill("zebra");
    await expect(page.getByRole("button", { name: /Zebra archive/ })).toBeVisible();
    const late = page.waitForResponse(
      (r) => new URL(r.url()).pathname === "/api/v1/brain/search" && r.url().includes("q=northstar"),
    );
    release();
    await late;
    await expect(page.getByRole("button", { name: /Zebra archive/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Northstar beta/ })).toHaveCount(0);
  });
});

test("a failed search says so, then recovers on the next query", async ({ browser }) => {
  await journey(browser, async (page) => {
    await save(page, "Northstar beta note.");
    await openBrain(page);
    let fail = true;
    await page.route("**/api/v1/brain/search*", (route) =>
      fail
        ? route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({ error: { code: "INTERNAL", message: "Down." } }),
          })
        : route.fallback(),
    );
    const search = page.getByLabel("Search your brain");
    await search.fill("northstar");
    await expect(page.getByRole("heading", { name: "Search failed" })).toBeVisible();
    await expect(page.getByRole("alert")).toContainText("Down.");
    await expect(page.getByRole("heading", { name: "Searching…" })).toHaveCount(0);
    fail = false;
    await search.fill("beta");
    await expect(page.getByRole("button", { name: /Northstar beta/ })).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
});
