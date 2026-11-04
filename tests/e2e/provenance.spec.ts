import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function pair(page: Page) {
  await page.goto("/");
  await page.getByLabel("Installation code").fill("e2e-local-only");
  await page.getByRole("button", { name: "Open my brain" }).click();
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
}

test("an agent note shows who wrote it and that it is not yet reviewed, until the owner marks it", async ({ page }) => {
  await pair(page);
  // Add Codex to a temp folder from the signed-in page, then write a note with that connection's key, as the hook would.
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  const folder = mkdtempSync(join(tmpdir(), "bibrain-prov-"));
  const codex = page.getByRole("region", { name: "Codex" });
  await codex.getByRole("button", { name: "Add to Codex" }).click();
  await codex.getByLabel("Project", { exact: true }).selectOption({ label: "Inbox" });
  await codex.getByLabel("Project folder on this computer").fill(folder);
  await codex.getByRole("button", { name: "Add to Codex", exact: true }).last().click();
  await expect(codex).toContainText("Waiting for its first call");
  const written = readFileSync(join(folder, ".codex", "config.toml"), "utf8");
  const id = /"--connection", "([0-9a-f-]{36})"/.exec(written)![1];
  const { key } = JSON.parse(readFileSync(join("data", "agent-keys", `${id}.json`), "utf8"));
  const note = await page.request.post("/api/v1/agent/note", { headers: { Authorization: `Bearer ${key}` }, data: { project_id: "inbox", open_questions: ["Which lease length is right for the provenance journey?"] } });
  expect(note.ok()).toBe(true);
  await page.getByRole("button", { name: "Your brain", exact: true }).click();
  await expect(page.getByText("From Codex · not yet reviewed").first()).toBeVisible();
  await page.getByRole("button", { name: "Session note from Codex" }).first().click();
  await page.getByRole("button", { name: "Mark as reviewed" }).click();
  await expect(page.getByText("From Codex · reviewed").first()).toBeVisible();
});
