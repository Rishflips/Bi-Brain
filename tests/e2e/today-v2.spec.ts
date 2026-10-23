import { expect, test, type BrowserContext, type Page } from "@playwright/test";

// Local pairing is limited to 10 a minute, so pair once and reuse the session.
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

test("a brain with saved work and nothing to review says it is quiet", async ({
  page,
}) => {
  await pair(page);
  const status = await page.evaluate(async () => {
    const session = await (await fetch("/api/v1/session")).json();
    const res = await fetch("/api/v1/sources", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Brain-CSRF": session.csrf,
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({
        title: "Quiet state note",
        body: "Plain note for the quiet state check.",
        project_id: "inbox",
        visibility: "private",
      }),
    });
    return res.status;
  });
  expect(status).toBe(201);
  // Turn background help on through the real preferences route, so the quiet
  // copy under test is the one an owner with help on actually sees.
  const prefStatus = await page.evaluate(async () => {
    const session = await (await fetch("/api/v1/session")).json();
    const current = await (
      await fetch("/api/v1/preferences/background")
    ).json();
    const res = await fetch("/api/v1/preferences/background", {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-Brain-CSRF": session.csrf,
        "Idempotency-Key": crypto.randomUUID(),
      },
      body: JSON.stringify({ ...current, enabled: true }),
    });
    return res.status;
  });
  expect(prefStatus).toBe(200);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Good to see you." }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Since you were last here" }),
  ).toBeVisible();
  await expect(page.getByText("You are caught up.")).toBeVisible();
  await expect(page.getByText("Background help is off")).toHaveCount(0);
  await expect(page.getByText(/things to look at/i)).toHaveCount(0);
});

test("saving from the bar keeps the original across reload", async ({
  page,
}) => {
  await pair(page);
  await page
    .getByLabel("Save to your brain")
    .fill(
      "Northstar launch checklist: invites, pricing page, onboarding copy.",
    );
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText(/kept exactly as you wrote it/i)).toBeVisible();
  await page.reload();
  await page
    .getByRole("link", { name: /your brain/i })
    .or(page.getByRole("button", { name: /your brain/i }))
    .first()
    .click();
  await expect(
    page.getByText("Northstar launch checklist", { exact: false }).first(),
  ).toBeVisible();
});

test("a failed save keeps the draft and claims nothing", async ({ page }) => {
  await pair(page);
  await page.route("**/api/v1/sources", (route) =>
    route.request().method() === "POST" ? route.abort() : route.continue(),
  );
  const bar = page.getByLabel("Save to your brain");
  await bar.fill("Draft that must survive");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: /not saved/i }),
  ).toBeVisible();
  await expect(bar).toHaveValue("Draft that must survive");
  await expect(page.getByText(/kept exactly as you wrote it/i)).toHaveCount(0);
});

test("asking answers from saved material, says when nothing matches, and validates input", async ({
  page,
}) => {
  await pair(page);
  await page
    .getByLabel("Save to your brain")
    .fill("The private beta opens on November 14 for 50 invited builders.");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText(/kept exactly as you wrote it/i)).toBeVisible();
  const bar = page.getByLabel(/save to your brain|ask your brain/i);
  await bar.fill("When does the beta open?");
  await expect(
    page.getByRole("button", { name: "Ask", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.getByText("From your brain")).toBeVisible();
  await expect(page.getByText(/November 14/).first()).toBeVisible();
  await bar.fill("quantum gravity?");
  await page.keyboard.press("Enter");
  await expect(
    page.getByText("Nothing in your brain answers that yet."),
  ).toBeVisible();
  await bar.fill("??");
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("alert").filter({ hasText: /a few words/i }),
  ).toBeVisible();
});

test("a two-line note that ends in a question mark is saved, not asked", async ({
  page,
}) => {
  await pair(page);
  await page
    .getByLabel(/save to your brain|ask your brain/i)
    .fill("Pricing review notes for Zephyr\nWho owns the final call on tiers?");
  await page.keyboard.press("Enter");
  await expect(page.getByText(/kept exactly as you wrote it/i)).toBeVisible();
  await expect(page.getByText("From your brain")).toHaveCount(0);
});

test("a question over 500 characters is refused before it is sent", async ({
  page,
}) => {
  await pair(page);
  let sent = 0;
  await page.route("**/api/v1/ask*", (route) => {
    sent += 1;
    return route.continue();
  });
  await page.getByRole("button", { name: "Ask mode" }).click();
  await page.getByLabel("Ask your brain").fill("word ".repeat(120));
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Questions can be up to 500 characters." }),
  ).toBeVisible();
  expect(sent).toBe(0);
});

const decision = "We decided that Northstar beta is invite only.";

test("a found decision can be kept, undone, and never kept twice", async ({
  page,
}) => {
  await pair(page);
  await page.getByLabel("Save to your brain").fill(decision);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const card = page.getByRole("article").filter({ hasText: "invite only" });
  await expect(card).toBeVisible();
  await expect(card.getByText(decision)).toBeVisible();
  await card.getByRole("button", { name: "Keep as true" }).click();
  await expect(page.getByText(/kept as a fact/i)).toBeVisible();
  await expect(card).toHaveCount(0);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByText(/undone/i)).toBeVisible();
  // Undo puts the suggestion back, so it is still the owner's call.
  await expect(card).toBeVisible();
  const claims = await (
    await page.request.get("/api/v1/claims?project_id=inbox")
  ).json();
  expect(
    claims.filter((c: any) => JSON.stringify(c.data).includes("invite only"))
      .length,
  ).toBe(0);
  await card.getByRole("button", { name: "Keep as true" }).click();
  await expect(page.getByText(/kept as a fact/i)).toBeVisible();
  const again = await (
    await page.request.get("/api/v1/claims?project_id=inbox")
  ).json();
  expect(
    again.filter((c: any) => JSON.stringify(c.data).includes("invite only"))
      .length,
  ).toBe(1);
});

test("Fix keeps the owner's own wording", async ({ page }) => {
  await pair(page);
  await page
    .getByLabel("Save to your brain")
    .fill("We decided that Orion pilot is limited to five teams.");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const card = page.getByRole("article").filter({ hasText: "five teams" });
  await card.getByRole("button", { name: "Fix" }).click();
  await card
    .getByLabel("Your wording")
    .fill("limited to five teams until December");
  await card.getByRole("button", { name: "Save my version" }).click();
  await expect(page.getByText(/your wording/i)).toBeVisible();
  const claims = await (
    await page.request.get("/api/v1/claims?project_id=inbox")
  ).json();
  expect(
    claims.some(
      (c: any) => c.data.value === "limited to five teams until December",
    ),
  ).toBe(true);
});

test("an item acted on in another tab is refused and the brief refreshes", async ({
  page,
  context,
}) => {
  await pair(page);
  await page
    .getByLabel("Save to your brain")
    .fill("We decided that Vega launch is postponed to spring.");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const card = page.getByRole("article").filter({ hasText: "spring" });
  await expect(card).toBeVisible();
  const other = await context.newPage();
  await other.goto("/");
  await other
    .getByRole("article")
    .filter({ hasText: "spring" })
    .getByRole("button", { name: "Keep as true" })
    .click();
  await expect(other.getByText(/kept as a fact/i)).toBeVisible();
  await card.getByRole("button", { name: "Keep as true" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: /changed|already/i }),
  ).toBeVisible();
  await expect(card).toHaveCount(0);
});

test("dismiss can be undone before it is sent", async ({ page }) => {
  await pair(page);
  await page
    .getByLabel("Save to your brain")
    .fill("We decided that Lyra docs is public.");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const card = page.getByRole("article").filter({ hasText: "public" });
  let sent = 0;
  await page.route("**/api/v1/proposals/gate/*/review", (route) => {
    sent += 1;
    return route.continue();
  });
  await card.getByRole("button", { name: "Dismiss" }).click();
  await expect(card).toHaveCount(0);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(
    page.getByRole("article").filter({ hasText: "public" }),
  ).toBeVisible();
  await page.waitForTimeout(6500);
  expect(sent).toBe(0);
});

test("the brief never shows more than three items", async ({ page }) => {
  await pair(page);
  for (const name of ["Atlas", "Borealis", "Cygnus", "Draco"]) {
    await page
      .getByLabel("Save to your brain")
      .fill(`We decided that ${name} project is paused.`);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText(/kept exactly as you wrote it/i)).toBeVisible();
  }
  await expect(page.getByRole("article")).toHaveCount(3);
  await expect(page.getByText(/\d+ more waiting/i)).toBeVisible();
});

test("a double click on Keep sends one request", async ({ page }) => {
  await pair(page);
  await page
    .getByLabel("Save to your brain")
    .fill("We decided that Pavo tour is sold out.");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const card = page.getByRole("article").filter({ hasText: "sold out" });
  await expect(card).toBeVisible();
  let sent = 0;
  await page.route("**/api/v1/proposals/gate/*/review", (route) => {
    sent += 1;
    return route.continue();
  });
  await card.getByRole("button", { name: "Keep as true" }).dblclick();
  await expect(page.getByText(/kept as a fact/i)).toBeVisible();
  expect(sent).toBe(1);
});

// Request-contract tests. The Brief and the action routes are served by the
// test with obviously fake ids, so they check the exact path and body each
// button sends. They do not prove the server accepts those requests.
type Call = { path: string; body: any };
const fakeItem = (kind: string, target: any, extra: any = {}) => ({
  signature: `${target.type}:${target.id}:${target.version}`,
  kind,
  project_id: "inbox",
  title: `Fake ${kind} item`,
  why: "A synthetic item for a request-contract test.",
  evidence: [
    { source_id: "src-fake-1", source_version: 1, quote: "fake quote" },
  ],
  target,
  created_at: "2026-10-22T09:00:00Z",
  ...extra,
});

async function contract(page: Page, items: any[]) {
  const calls: Call[] = [];
  let live = items;
  await page.route("**/api/v1/brief", (route) =>
    route.fulfill({ json: { items: live, waiting: 0 } }),
  );
  const record =
    (reply: unknown, clear = true) =>
    (route: any) => {
      const url = new URL(route.request().url());
      calls.push({
        path: url.pathname.replace("/api/v1", ""),
        body: route.request().postDataJSON(),
      });
      if (clear)
        live = live.filter((i) => !url.pathname.includes(`/${i.target.id}/`));
      return route.fulfill({ json: reply });
    };
  await page.route(
    "**/api/v1/proposals/*/accept",
    record({
      receipt: { id: "rcpt-fake-1", version: 1 },
      goal: { data: { plan_version: 7 } },
    }),
  );
  await page.route("**/api/v1/proposals/*/dismiss", record({}));
  await page.route("**/api/v1/receipts/*/undo", record({}, false));
  await page.route("**/api/v1/claims/*/confirm", record({}));
  await page.route("**/api/v1/jobs/*/retry", record({}));
  await page.route("**/api/v1/brief/dismiss", record({}));
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
        title: "Contract seed",
        body: "Seed note so Today shows the Brief.",
        project_id: "inbox",
        visibility: "private",
      }),
    });
  });
  await page.reload();
  return calls;
}

test("request contract: proposal Keep, then Undo with the goal plan version", async ({
  page,
}) => {
  const calls = await contract(page, [
    fakeItem("proposal", { type: "proposal", id: "prop-fake-1", version: 3 }),
  ]);
  const card = page.getByRole("article").filter({ hasText: "Fake proposal" });
  await card.getByRole("button", { name: "Keep this plan" }).click();
  await expect(page.getByText(/plan kept/i)).toBeVisible();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByText(/undone/i)).toBeVisible();
  expect(calls).toEqual([
    { path: "/proposals/prop-fake-1/accept", body: { expected_version: 3 } },
    { path: "/receipts/rcpt-fake-1/undo", body: { expected_version: 7 } },
  ]);
});

test("request contract: proposal Dismiss is sent after the undo window with its version", async ({
  page,
}) => {
  const calls = await contract(page, [
    fakeItem("proposal", { type: "proposal", id: "prop-fake-2", version: 4 }),
  ]);
  const card = page.getByRole("article").filter({ hasText: "Fake proposal" });
  await card.getByRole("button", { name: "Dismiss" }).click();
  await expect(card).toHaveCount(0);
  expect(calls).toEqual([]);
  await expect.poll(() => calls.length, { timeout: 9000 }).toBe(1);
  expect(calls[0]).toEqual({
    path: "/proposals/prop-fake-2/dismiss",
    body: { expected_version: 4 },
  });
});

test("request contract: stale Still true and failed job Try again", async ({
  page,
}) => {
  const calls = await contract(page, [
    fakeItem(
      "stale",
      { type: "claim", id: "claim-fake-1", version: 2 },
      { aspect: "statement" },
    ),
    fakeItem(
      "failed_job",
      { type: "job", id: "job-fake-1", version: 1 },
      {
        evidence: [],
        source_id: "src-fake-1",
      },
    ),
  ]);
  const stale = page.getByRole("article").filter({ hasText: "Fake stale" });
  const failed = page
    .getByRole("article")
    .filter({ hasText: "Fake failed_job" });
  await expect(
    failed.getByRole("button", { name: "Open the original" }),
  ).toBeVisible();
  await expect(
    stale.getByRole("button", { name: "Open the original" }).first(),
  ).toBeVisible();
  await failed.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText(/trying again/i)).toBeVisible();
  await stale.getByRole("button", { name: "Still true" }).click();
  await expect(page.getByText(/still true today/i)).toBeVisible();
  expect(calls.map((c) => c.path).sort()).toEqual([
    "/claims/claim-fake-1/confirm",
    "/jobs/job-fake-1/retry",
  ]);
});

test("request contract: a failed job without an original has no Open the original button", async ({
  page,
}) => {
  await contract(page, [
    fakeItem(
      "failed_job",
      { type: "job", id: "job-fake-2", version: 1 },
      { evidence: [] },
    ),
  ]);
  const card = page.getByRole("article").filter({ hasText: "Fake failed_job" });
  await expect(card.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(
    card.getByRole("button", { name: "Open the original" }),
  ).toHaveCount(0);
});

test("a failed Undo shows a plain alert and focus moves to the Brief heading when the last card goes", async ({
  page,
}) => {
  await contract(page, [
    fakeItem("proposal", { type: "proposal", id: "prop-fake-3", version: 1 }),
  ]);
  await page.route("**/api/v1/receipts/*/undo", (route) =>
    route.fulfill({
      status: 409,
      json: {
        error: { code: "CONFLICT", message: "This changed since you kept it." },
      },
    }),
  );
  const card = page.getByRole("article").filter({ hasText: "Fake proposal" });
  await card.getByRole("button", { name: "Keep this plan" }).click();
  await expect(card).toHaveCount(0);
  await expect(page.locator("#tv-brief-h")).toBeFocused();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: "changed since" }),
  ).toBeVisible();
  // The failure is said once: the toast does not repeat it.
  await expect(page.getByText("This changed since you kept it.")).toHaveCount(
    1,
  );
});

test("Fix puts the cursor in the wording box and Cancel returns to Keep", async ({
  page,
}) => {
  await pair(page);
  await page
    .getByLabel("Save to your brain")
    .fill("We decided that Corvus rollout is staged.");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const card = page.getByRole("article").filter({ hasText: "staged" });
  await card.getByRole("button", { name: "Fix" }).click();
  await expect(card.getByLabel("Your wording")).toBeFocused();
  await card.getByRole("button", { name: "Cancel" }).click();
  await expect(
    card.getByRole("button", { name: "Keep as true" }),
  ).toBeFocused();
});

test("project cards show real counts and open the project that was clicked", async ({
  page,
}) => {
  await pair(page);
  const name = `Cards ${Date.now()}`;
  // Writes are rate limited per minute and this file writes a lot, so wait and retry.
  let status = 0;
  for (let attempt = 0; attempt < 12 && status !== 200; attempt++) {
    status = await page.evaluate(async (title) => {
      const session = await (await fetch("/api/v1/session")).json();
      const res = await fetch("/api/v1/projects", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Brain-CSRF": session.csrf,
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({ title }),
      });
      return res.status;
    }, name);
    if (status !== 429) break;
    await page.waitForTimeout(5000);
  }
  expect(status).toBe(200);
  await page.reload();
  const inbox = page.locator(".tv-proj").filter({ hasText: "Inbox" });
  await expect(inbox).toContainText(/\d+ facts?/);
  await expect(inbox).toContainText("No agent connected");
  await expect(page.locator(".tv-state")).toHaveText(
    /Caught up|\d+ to look at|Background help off/,
  );
  const other = page.locator(".tv-proj").filter({ hasText: name });
  await expect(other).toContainText("0 facts");
  // Reachable and operable from the keyboard.
  const open = other.getByRole("button", { name });
  await open.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Your brain" })).toBeVisible();
  await expect(page.getByRole("heading", { name, level: 2 })).toBeVisible();
});

test("Today fits a 320px screen in dark appearance", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.emulateMedia({ colorScheme: "dark" });
  await pair(page);
  const state = page.locator(".tv-state");
  await expect(state).toBeVisible();
  const clipped = await state.evaluate((el) => el.scrollWidth > el.clientWidth);
  expect(clipped).toBe(false);
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(320);
  await expect(
    page.getByLabel(/save to your brain|ask your brain/i),
  ).toBeVisible();
});
