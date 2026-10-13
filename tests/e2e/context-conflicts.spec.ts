import { test, expect } from "@playwright/test";

test("browser approves, compares, rejects and undoes source-cited decision corrections", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Installation code").fill("e2e-local-only");
  await page.getByRole("button", { name: "Open my brain" }).click();
  await expect(page.getByRole("button", { name: "Your brain", exact: true })).toBeVisible();
  const key = `Browser${Date.now()} pricing`;
  async function save(value: string) {
    await page.getByRole("button", { name: "Save something", exact: false }).first().click();
    await page.getByLabel("Title", { exact: true }).fill(`Browser decision ${value}`);
    await page.getByLabel("Paste something you are working on").fill(`${key}: ${value}`);
    await page.getByRole("dialog").getByRole("button", { name: "Save to my brain", exact: true }).click();
    await expect(page.getByTestId("original")).toContainText(`${key}: ${value}`);
    await page.getByRole("button", { name: "Close dialog" }).click();
    await page.getByRole("button", { name: "Your brain", exact: true }).click();
  }
  function pending() { return page.locator("article[data-proposal-id]").filter({ has: page.getByRole("heading", { name: key.toLowerCase(), exact: true }) }); }
  async function current(value: string) {
    const answer = await page.request.get(`/api/v1/agent/ask?project_id=inbox&question=${encodeURIComponent(key)}`);
    expect(answer.ok()).toBe(true);
    expect((await answer.json()).answer).toContain(`statement: ${value}`);
  }
  await save("free");
  await pending().getByRole("button", { name: "Approve exact correction" }).click();
  await current("free");
  await save("paid");
  await expect(pending()).toContainText(`${key}: free`);
  await expect(pending()).toContainText(`${key}: paid`);
  await current("free");
  await pending().getByRole("button", { name: "Approve exact correction" }).click();
  await current("paid");
  await page.getByText("Reviewed decision history", { exact: true }).click();
  const history = page.locator("details article").filter({ has: page.getByRole("heading", { name: `${key.toLowerCase()}: paid`, exact: true }) });
  await history.getByRole("button", { name: "Undo correction" }).click();
  await current("free");
  await expect(history).toContainText("Undone by you");
  await save("sponsored");
  await pending().getByRole("button", { name: "Keep earlier decision" }).click();
  await current("free");
});
