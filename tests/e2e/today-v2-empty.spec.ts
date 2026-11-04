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

test("bring in: only instruction files are sent to be previewed, and Cancel saves nothing", async ({ page }) => {
  await pair(page);
  const repo = mkdtempSync(join(tmpdir(), "bibrain-repo-"));
  writeFileSync(join(repo, "AGENTS.md"), "Prefer small commits.");
  writeFileSync(join(repo, "README.md"), "README_MUST_NOT_BE_SENT");
  writeFileSync(join(repo, ".env"), "SECRET_MUST_NOT_BE_SENT=1");
  const bodies: string[] = [];
  let applied = 0;
  await page.route("**/import-adapters/**", (route) => {
    const url = route.request().url();
    if (url.endsWith("/preview")) bodies.push(route.request().postData() ?? "");
    if (url.endsWith("/apply")) applied += 1;
    return route.continue();
  });
  await page.getByLabel("Choose a project folder").setInputFiles(repo);
  const dialog = page.getByRole("dialog", { name: "Review import" });
  await expect(dialog).toContainText("1 agent instruction files ready");
  expect(bodies).toHaveLength(1);
  const sent = JSON.parse(bodies[0]);
  expect(sent.kind).toBe("context");
  expect(sent.entries.map((e: { path: string }) => e.path)).toEqual(["AGENTS.md"]);
  expect(bodies[0]).not.toContain("README_MUST_NOT_BE_SENT");
  expect(bodies[0]).not.toContain("SECRET_MUST_NOT_BE_SENT");
  expect(applied).toBe(0);
  await dialog.getByRole("button", { name: /cancel|close/i }).first().click();
  await expect(dialog).toBeHidden();
  expect(applied).toBe(0);
  await expect(page.getByRole("heading", { name: "Welcome to BiBrain." })).toBeVisible();
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
  await expect(page.getByText("Imported from CLAUDE.md")).toBeVisible();
  await expect(page.getByRole("button", { name: "CLAUDE.md" })).toBeVisible();
});
