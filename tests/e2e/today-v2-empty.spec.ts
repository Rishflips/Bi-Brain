import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function pair(page: Page) {
  await page.goto("/");
  await page.getByLabel("Installation code").fill("e2e-local-only");
  await page.getByRole("button", { name: "Open my brain" }).click();
  await expect(
    page.getByRole("navigation", { name: "Main navigation" }),
  ).toBeVisible();
}

// Runs in its own Playwright project with its own fresh database, so the brain is
// genuinely empty regardless of what the other specs saved.
test("a new brain shows three ways to start and no fake activity", async ({
  page,
}) => {
  await pair(page);
  await expect(
    page.getByRole("heading", { name: "Welcome to BiBrain." }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Choose an agent" }),
  ).toBeVisible();
  await expect(page.getByText(/things to look at/i)).toHaveCount(0);
  await expect(page.locator(".tv-state")).toHaveText("Empty brain");

  await page.setViewportSize({ width: 320, height: 700 });
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);

  await page.getByRole("button", { name: "Choose an agent" }).click();
  await expect(
    page.getByRole("heading", { name: /connections/i }).first(),
  ).toBeVisible();
});

test("bring in what you already have: only instruction files are read, shown first, then saved as your originals", async ({ page }) => {
  await pair(page);
  const repo = mkdtempSync(join(tmpdir(), "bibrain-repo-"));
  writeFileSync(join(repo, "CLAUDE.md"), "# Northstar\nRun the tests before every commit. BRING_IN_E2E_CANARY");
  writeFileSync(join(repo, "README.md"), "# Not an instruction file");
  mkdirSync(join(repo, ".cursor", "rules"), { recursive: true });
  writeFileSync(join(repo, ".cursor", "rules", "style.mdc"), "Use two spaces.");
  mkdirSync(join(repo, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(repo, "node_modules", "pkg", "CLAUDE.md"), "never read");
  writeFileSync(join(repo, "GEMINI.md"), "y".repeat(2 * 1048576));
  await expect(page.getByRole("heading", { name: "Bring in what you already have" })).toBeVisible();
  await page.getByLabel("Choose a project folder").setInputFiles(repo);
  const dialog = page.getByRole("dialog", { name: "Review import" });
  await expect(dialog).toContainText("2 agent instruction files ready for Inbox");
  await expect(dialog).toContainText("Only bring in projects you trust.");
  await expect(dialog).toContainText("CLAUDE.md");
  await expect(dialog).toContainText(".cursor/rules/style.mdc");
  await expect(dialog).not.toContainText("README.md");
  await expect(dialog).not.toContainText("node_modules");
  await dialog.getByText("1 skipped or limited").click();
  await expect(dialog).toContainText("GEMINI.md: larger than 1 MiB, skipped");
  await dialog.getByRole("button", { name: "Save selected items" }).click();
  await expect(page.getByRole("heading", { name: "Good to see you." })).toBeVisible();
  await page.getByRole("button", { name: "Your brain", exact: true }).click();
  await expect(page.getByText("Imported").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "CLAUDE.md" })).toBeVisible();
});
