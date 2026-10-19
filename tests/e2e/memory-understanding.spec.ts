import { expect, test, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Installation code").fill("e2e-local-only");
  await page.getByRole("button", { name: "Open my brain" }).click();
  await expect(
    page
      .getByRole("heading", { name: "What do you want to pick up later?" })
      .or(page.getByRole("heading", { name: "Welcome back." })),
  ).toBeVisible();
});

async function save(page: Page, title: string, body: string) {
  await page
    .getByRole("button", { name: "Save something", exact: false })
    .first()
    .click();
  await page.getByLabel("Title", { exact: true }).fill(title);
  await page.getByLabel("Paste something you are working on").fill(body);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Save to my brain", exact: true })
    .click();
  await expect(page.getByTestId("original")).toContainText(body);
}

test("plain language becomes a cited suggestion and only reaches agents after review", async ({
  page,
}) => {
  const entity = `launch window ${Date.now()}`;
  const body = `The ${entity} is November 12.`;
  await save(page, "Launch timing", body);
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("button", { name: "Your brain", exact: true }).click();

  const candidate = page
    .locator("article")
    .filter({ has: page.getByRole("heading", { name: entity }) });
  await expect(candidate.getByText("statement: November 12")).toBeVisible();
  await expect(
    candidate.getByText(/Found in ordinary language/),
  ).toBeVisible();

  const before = await page.request.get(
    `/api/v1/agent/ask?project_id=inbox&question=${encodeURIComponent(entity)}`,
  );
  expect((await before.json()).abstained).toBe(true);

  await candidate
    .getByRole("button", { name: "Accept reviewed claim" })
    .click();
  await expect(
    page.getByText("Current · reviewed by you", { exact: false }),
  ).toBeVisible();
  const after = await page.request.get(
    `/api/v1/agent/ask?project_id=inbox&question=${encodeURIComponent(entity)}`,
  );
  expect((await after.json()).answer).toContain("November 12");
});

test("owner can teach a decision from an arbitrary exact passage", async ({
  page,
}) => {
  const entity = `launch scope ${Date.now()}`;
  const body = "After discussion, the team leaned toward the smaller launch.";
  await save(page, "Scope discussion", body);
  await page.getByRole("button", { name: "Add a fact for review" }).click();
  await page.getByLabel("Topic or entity").fill(entity);
  await page
    .getByLabel("What kind of memory is this?")
    .selectOption("decision");
  await page
    .getByLabel("What should BiBrain remember?")
    .fill("smaller launch");
  await expect(page.getByLabel("Exact passage from original")).toHaveValue(body);
  await page.getByRole("button", { name: "Send for review" }).click();

  const candidate = page
    .locator("article")
    .filter({ has: page.getByRole("heading", { name: entity }) });
  await expect(candidate.getByText("statement: smaller launch")).toBeVisible();
  await expect(candidate.getByText(/Meaning supplied by you/)).toBeVisible();
  await candidate
    .getByRole("button", { name: "Accept reviewed claim" })
    .click();

  const answer = await page.request.get(
    `/api/v1/agent/ask?project_id=inbox&question=${encodeURIComponent(entity)}`,
  );
  expect((await answer.json()).answer).toContain("smaller launch");
});
