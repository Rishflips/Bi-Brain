import { expect, test, type Page } from "@playwright/test";

async function pair(page: Page) {
  await page.goto("/");
  await page.getByLabel("Installation code").fill("e2e-local-only");
  await page.getByRole("button", { name: "Open my brain" }).click();
  await expect(
    page.getByRole("navigation", { name: "Main navigation" }),
  ).toBeVisible();
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
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Good to see you." }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Since you were last here" }),
  ).toBeVisible();
  await expect(
    page
      .getByText("You are caught up.")
      .or(page.getByText("Background help is off")),
  ).toBeVisible();
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
  await expect(page.getByRole("alert")).toContainText(/not saved/i);
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
  await expect(page.getByRole("alert")).toContainText(/a few words/i);
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
  await expect(page.getByRole("alert")).toContainText(
    "Questions can be up to 500 characters.",
  );
  expect(sent).toBe(0);
});
