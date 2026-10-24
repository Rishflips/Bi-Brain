import { expect, test, type Page } from "@playwright/test";

// One server, one brain, one story: the journeys below build on each other, so they
// run in order and share a single sign-in (local pairing is rate limited).
test.describe.configure({ mode: "serial" });

const LABEL = "Ollama on this computer (estimated cost)";
const nav = (page: Page) => page.getByRole("navigation", { name: "Main navigation" });

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

async function saveFromBar(page: Page, text: string) {
  await page.getByRole("button", { name: "Today", exact: true }).click();
  await page.getByLabel("Save to your brain").fill(text);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText(/kept exactly as you wrote it/i)).toBeVisible();
}

async function api(page: Page, path: string, method = "GET", body?: unknown) {
  return page.evaluate(
    async ({ path, method, body }) => {
      const session = await (await fetch("/api/v1/session")).json();
      const res = await fetch(`/api/v1${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          "X-Brain-CSRF": session.csrf,
          "Idempotency-Key": crypto.randomUUID(),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: res.status, json: await res.json().catch(() => null) };
    },
    { path, method, body },
  );
}

const fileCard = (page: Page) =>
  page.getByRole("article").filter({ has: page.getByRole("heading", { name: "File in Northstar?" }) });

test("sorting help is switched on in Settings and a note is filed with Keep", async ({ page }) => {
  await open(page);

  // Settings explains the state, then turns on with limits and consent.
  await page.getByRole("button", { name: "Settings & privacy" }).click();
  const card = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Sorting help" }) });
  await expect(card).toBeVisible();
  await expect(card.getByText("Needs a daily limit above $0 below.")).toBeVisible();
  await page.getByLabel("Prepare around chosen goals").check();
  await page.getByLabel("Daily cap (USD)").fill("0.05");
  await page.getByLabel("Per preparation cap (USD)").fill("0.01");
  const consent = page.getByLabel(/Let BiBrain sort new notes with/);
  // The worker publishes its status a moment after start; the box enables once it has.
  await expect(consent).toBeEnabled({ timeout: 20000 });
  await expect(consent).toHaveAccessibleName(`Let BiBrain sort new notes with ${LABEL} (costs count against the limits below)`);
  await consent.check();
  await page.getByRole("button", { name: "Save preferences" }).click();
  await expect(page.getByText("Background preferences saved.")).toBeVisible();
  await expect(card.getByText(`On · ${LABEL} · 0 notes sorted, 0 reviewed`)).toBeVisible();

  // A project, then a note that clearly belongs to it.
  await page.getByRole("button", { name: "Your brain", exact: true }).click();
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await page.getByLabel("Project name").fill("Northstar");
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Northstar", level: 2 })).toBeVisible();

  await saveFromBar(page, "Northstar ships with one plan.");
  // The background worker sorts it; Today offers the move.
  await expect(async () => {
    await page.reload();
    await expect(fileCard(page)).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 30000 });
  await fileCard(page).getByRole("button", { name: "Keep" }).click();
  await expect(page.locator(".tv-toast")).toContainText("Moved to Northstar.");

  // The note now sits in Northstar's originals.
  await page.getByRole("button", { name: "Your brain", exact: true }).click();
  await page.getByRole("navigation", { name: "Projects" }).getByRole("button", { name: "Northstar" }).click();
  await expect(
    page.getByRole("region", { name: "Originals" }).getByRole("button", { name: /Northstar ships with one plan/ }),
  ).toBeVisible();

  // The review log downloads as JSON with the Keep recorded and no note text.
  await page.getByRole("button", { name: "Settings & privacy" }).click();
  await expect(card.getByText(new RegExp(`^On · ${LABEL.replace(/[()]/g, "\\$&")} · [1-9]\\d* notes? sorted, [1-9]\\d* reviewed`))).toBeVisible();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download the review log" }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.json$/);
  const text = await (await import("node:fs/promises")).readFile((await download.path())!, "utf8");
  const log = JSON.parse(text);
  expect(log.rows.some((r: { action: string }) => r.action === "keep_file")).toBe(true);
  expect(text).not.toContain("Northstar ships");
});

test("Dismiss on a filing suggestion can be undone, and a stale Keep says so plainly", async ({ page }) => {
  await open(page);
  await saveFromBar(page, "Northstar needs its launch plan reviewed.");
  await expect(async () => {
    await page.reload();
    await expect(fileCard(page)).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 30000 });

  await fileCard(page).getByRole("button", { name: "Dismiss" }).click();
  await expect(page.locator(".tv-toast")).toContainText("Dismissed. The note stays in your Inbox.");
  await expect(fileCard(page)).toHaveCount(0);
  await page.locator(".tv-toast").getByRole("button", { name: "Undo" }).click();
  await expect(fileCard(page)).toBeVisible();
  // Undoing inside the window sent nothing: the suggestion is still open after a reload.
  await page.reload();
  await expect(fileCard(page)).toBeVisible();

  // The note changes after Today was drawn; Keep must not move the wrong version.
  const notes = await api(page, "/search");
  const note = (notes.json as { id: string; title: string; version: number }[]).find((n) =>
    n.title.includes("Northstar needs"),
  )!;
  const edited = await api(page, `/sources/${note.id}/versions`, "POST", {
    title: note.title,
    body: "Northstar needs its launch plan reviewed twice.",
    expected_version: note.version,
  });
  expect(edited.status).toBe(200);
  await fileCard(page).getByRole("button", { name: "Keep" }).click();
  await expect(page.getByRole("alert").filter({ hasText: /changed|no longer/i })).toBeVisible();
  await expect(page.locator(".tv-toast")).toHaveCount(0);
  // Still in the Inbox, not moved.
  const after = await api(page, `/sources/${note.id}`);
  expect(after.json.project_id).toBe("inbox");
});

test("a Watch switch hides a project's cards from Today and brings them back", async ({ page }) => {
  await open(page);
  // Give Northstar something to say on Today: a goal whose plan is prepared for review.
  const projects = await api(page, "/projects");
  const northstar = (projects.json as { id: string; title: string }[]).find((p) => p.title === "Northstar")!;
  for (const body of [
    "Northstar onboarding requires connecting an agent first.",
    "Northstar interviews ask to try one conversation before connecting accounts.",
  ]) {
    const saved = await api(page, "/sources", "POST", {
      title: body.slice(0, 24),
      body,
      project_id: northstar.id,
      visibility: "project",
    });
    expect(saved.status).toBe(201);
  }
  await page.reload();
  await page.getByRole("button", { name: "Your brain", exact: true }).click();
  await page.getByRole("navigation", { name: "Projects" }).getByRole("button", { name: "Northstar" }).click();
  await expect(page.getByRole("heading", { name: "Plan ahead (optional)" })).toBeVisible();
  await page.getByRole("button", { name: "Choose a goal", exact: true }).click();
  await page.getByLabel("What do you want to accomplish?").fill("Ship Northstar");
  await page.getByLabel("What would success look like?").fill("One plan everyone follows");
  await page.getByRole("button", { name: "Save goal", exact: true }).click();
  await page.getByLabel("Keep this up to date").check();
  await page.getByRole("button", { name: "Prepare now" }).click();
  await page.getByRole("button", { name: "Today", exact: true }).click();
  const prepared = page
    .getByRole("article")
    .filter({ hasText: "Prepared for your goal" })
    .filter({ hasText: "Ship Northstar" });
  await expect(async () => {
    await page.reload();
    await expect(prepared).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 30000 });

  const watch = page.getByRole("switch", { name: "Watch Northstar" });
  await expect(watch).toBeChecked();
  await expect(page.getByText("Watching").first()).toBeVisible();
  await watch.uncheck();
  await expect(prepared).toHaveCount(0);
  await expect(watch).not.toBeChecked();
  await expect(page.getByText("Quiet: not on Today")).toBeVisible();
  await expect(page.getByRole("switch", { name: /Watch Inbox/ })).toHaveCount(0);

  // Your brain keeps the project and its switch; nothing is waiting on Today for it.
  await page.reload();
  await expect(page.getByRole("switch", { name: "Watch Northstar" })).not.toBeChecked();
  await page.getByRole("button", { name: "Your brain", exact: true }).click();
  await page.getByRole("navigation", { name: "Projects" }).getByRole("button", { name: "Northstar" }).click();
  const headerSwitch = page.getByRole("switch", { name: "Watch Northstar" });
  await expect(headerSwitch).not.toBeChecked();
  await expect(page.getByText(/things? to look at on Today/)).toHaveCount(0);

  await headerSwitch.check();
  await expect(headerSwitch).toBeChecked();
  await page.getByRole("button", { name: "Today", exact: true }).click();
  await expect(prepared).toBeVisible();
  await expect(page.getByRole("switch", { name: "Watch Northstar" })).toBeChecked();

  // The Inbox cannot be unwatched; the server says so in plain words.
  const inbox = await api(page, "/projects/inbox/watch", "PUT", { watched: false });
  expect(inbox.status).toBe(400);
  expect(inbox.json.error.message).toBe("The Inbox is always watched.");
});

test("Sorting help fits a 320px dark screen", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.emulateMedia({ colorScheme: "dark" });
  await open(page);
  await page.getByRole("button", { name: "Settings & privacy" }).click();
  const card = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Sorting help" }) });
  await expect(card).toBeVisible();
  await expect(card.getByRole("button", { name: "Download the review log" })).toBeVisible();
  const fits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(fits).toBe(true);
  const cardFits = await card.evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
  expect(cardFits).toBe(true);
  await expect(nav(page)).toBeVisible();
});
