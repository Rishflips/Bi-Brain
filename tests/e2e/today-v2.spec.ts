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
