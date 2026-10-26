import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Cookies = Parameters<BrowserContext["addCookies"]>[0];
let paired: Cookies | null = null;
async function open(page: Page) {
  if (paired) await page.context().addCookies(paired);
  await page.goto("/");
  if (!paired) {
    await page.getByLabel("Installation code").fill("e2e-local-only");
    await page.getByRole("button", { name: "Open my brain" }).click();
    await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
    paired = await page.context().cookies();
  }
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Connections", level: 1 })).toBeVisible();
}
const tile = (page: Page, name: string) => page.getByRole("region", { name });

test("Codex is found, added to a folder in one step, connected by its first call, and revoked", async ({ page, request }) => {
  await open(page);
  const folder = mkdtempSync(join(tmpdir(), "bibrain-proj-"));
  const codex = tile(page, "Codex");
  await expect(codex).toContainText("Found on this computer");
  await expect(tile(page, "Claude Code")).toContainText("Not found on this computer");
  await codex.getByRole("button", { name: "Add to Codex" }).click();
  await codex.getByLabel("Project", { exact: true }).selectOption({ label: "Inbox" });
  await codex.getByLabel("Project folder on this computer").fill(folder);
  await codex.getByText("See the file BiBrain will add").click();
  const preview = codex.getByTestId("agent-file");
  await expect(preview).toContainText("[mcp_servers.bibrain]");
  await expect(codex.getByText("This runs BiBrain's recall on every prompt. It pre-approves nothing; Codex asks you to trust it once.")).toBeVisible();
  const contents = (await preview.textContent())!;
  expect(contents).not.toMatch(/[0-9a-f]{64}/);
  await codex.getByRole("button", { name: "Add to Codex", exact: true }).last().click();
  await expect(codex).toContainText("Waiting for its first call");
  await expect(codex).toContainText("Recall on every prompt: on after Codex trusts the hook");
  const written = readFileSync(join(folder, ".codex", "config.toml"), "utf8");
  expect(written).toBe(contents);
  const id = /"--connection", "([0-9a-f-]{36})"/.exec(written)![1];
  const keyFile = join("data", "agent-keys", `${id}.json`);
  const { key } = JSON.parse(readFileSync(keyFile, "utf8"));
  expect((await request.post("/api/v1/agent/verify", { headers: { Authorization: `Bearer ${key}` }, data: {} })).ok()).toBe(true);
  await expect(codex).toContainText("Connected", { timeout: 10_000 });
  await expect(codex).toContainText("last used");
  await codex.getByRole("button", { name: "Revoke" }).click();
  await expect(codex.getByText(/Earlier connections \(1\)/)).toBeVisible();
  expect(existsSync(keyFile)).toBe(false);
  expect((await request.post("/api/v1/agent/verify", { headers: { Authorization: `Bearer ${key}` }, data: {} })).status()).toBe(401);
});

test("an existing project file is never changed", async ({ page }) => {
  await open(page);
  const folder = mkdtempSync(join(tmpdir(), "bibrain-proj-"));
  writeFileSync(join(folder, ".mcp.json"), '{"mcpServers":{}}\n');
  const claude = tile(page, "Claude Code");
  await claude.getByRole("button", { name: "Add to Claude Code" }).click();
  await claude.getByLabel("Project folder on this computer").fill(folder);
  await claude.getByRole("button", { name: "Add to Claude Code", exact: true }).last().click();
  await expect(claude).toContainText("BiBrain will not change your existing .mcp.json");
  await expect(claude.getByTestId("agent-file-to-add")).toContainText('"mcpServers"');
  expect(readFileSync(join(folder, ".mcp.json"), "utf8")).toBe('{"mcpServers":{}}\n');
});

test("a relative folder is refused with a plain message", async ({ page }) => {
  await open(page);
  const cursor = tile(page, "Cursor");
  await cursor.getByRole("button", { name: "Add to Cursor" }).click();
  await cursor.getByLabel("Project folder on this computer").fill("northstar");
  await cursor.getByRole("button", { name: "Add to Cursor", exact: true }).last().click();
  await expect(cursor.getByRole("alert")).toContainText("Use the full path of the project folder");
});

test("any other agent gets a handoff or a manual setup", async ({ page }) => {
  await open(page);
  const other = tile(page, "Any other agent");
  await other.getByRole("button", { name: "Preview handoff" }).click();
  await expect(page.getByRole("dialog", { name: "Project handoff" })).toBeVisible();
  await page.getByRole("button", { name: "Close dialog" }).click();
  await other.getByRole("button", { name: "Set up by hand" }).click();
  await expect(page.getByRole("dialog", { name: "Connect an agent" })).toBeVisible();
});

test("Connections fits a 320px screen in dark appearance", async ({ page }) => {
  await open(page);
  await page.evaluate(() => localStorage.setItem("brain-theme", "dark"));
  await page.setViewportSize({ width: 320, height: 760 });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  await tile(page, "Codex").getByRole("button", { name: "Add to Codex" }).click();
  await tile(page, "Codex").getByLabel("Project folder on this computer").fill(mkdtempSync(join(tmpdir(), "bibrain-proj-")));
  await tile(page, "Codex").getByText("See the file BiBrain will add").click();
  await expect(tile(page, "Codex").getByTestId("agent-file")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("a connection with no named agent is listed under Any other agent and can be revoked", async ({ page }) => {
  await open(page);
  const status = await page.evaluate(async () => {
    const { csrf } = await (await fetch("/api/v1/session")).json();
    const res = await fetch("/api/v1/agent-grants", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Brain-CSRF": csrf, "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ projects: ["inbox"], operations: ["read"], expires_at: new Date(Date.now() + 3600_000).toISOString() }),
    });
    return res.status;
  });
  expect(status).toBeLessThan(300);
  const other = tile(page, "Any other agent");
  await expect(other).toContainText("Waiting for its first call", { timeout: 10_000 });
  await other.getByRole("button", { name: "Revoke" }).click();
  await expect(other.getByText(/Earlier connections \(1\)/)).toBeVisible();
});

test("Claude Code gets the server file and the prompt hook, and an existing hook file is left alone", async ({ page }) => {
  await open(page);
  const folder = mkdtempSync(join(tmpdir(), "bibrain-proj-"));
  const claude = tile(page, "Claude Code");
  await claude.getByRole("button", { name: "Add to Claude Code" }).click();
  await claude.getByLabel("Project folder on this computer").fill(folder);
  await claude.getByText("See the file BiBrain will add").click();
  await expect(claude.getByTestId("agent-file-hook")).toContainText("mcp__bibrain__brain_recall");
  await expect(claude.getByText("The second file turns on recall on every prompt. Only two read-only tools are pre-approved; nothing in it can write.")).toBeVisible();
  await claude.getByRole("button", { name: "Add to Claude Code", exact: true }).last().click();
  await expect(claude).toContainText("Recall on every prompt: on");
  const hook = readFileSync(join(folder, ".claude", "settings.local.json"), "utf8");
  expect(hook).toContain('"timeout": 5');
  expect(hook).not.toMatch(/[0-9a-f]{64}/);
  const second = mkdtempSync(join(tmpdir(), "bibrain-proj-"));
  mkdirSync(join(second, ".claude"));
  writeFileSync(join(second, ".claude", "settings.local.json"), "{}\n");
  await claude.getByRole("button", { name: "Add to Claude Code" }).click();
  await claude.getByLabel("Project folder on this computer").fill(second);
  await claude.getByRole("button", { name: "Add to Claude Code", exact: true }).last().click();
  await expect(claude).toContainText("Recall on every prompt: add it yourself");
  await expect(claude.getByText("Paste it into the file, or run /hooks in Claude Code.")).toBeVisible();
  expect(readFileSync(join(second, ".claude", "settings.local.json"), "utf8")).toBe("{}\n");
  expect(existsSync(join(second, ".mcp.json"))).toBe(true);
});
