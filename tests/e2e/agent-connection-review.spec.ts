import { expect, test } from "@playwright/test";
import { firstNoteFixture } from "../helpers/first-note-browser.ts";

test("owner connects Claude Code with bounded access, sees real verification and revokes it", async ({
  browser,
}) => {
  const context = await browser.newContext();
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const fixture = await firstNoteFixture(context);
  const page = await context.newPage();
  try {
    await fixture.open(page);
    await page
      .getByRole("button", { name: "Connections", exact: true })
      .click();
    const continuity = page.locator('[data-ui="agent-continuity"]');
    await expect(continuity).toContainText("Inbox needs a first memory");
    await expect(page.locator('[data-ui="connection-empty"]')).toContainText(
      "No agent has access",
    );

    await page.getByRole("button", { name: "Connect an agent" }).click();
    const dialog = page.getByRole("dialog", { name: "Connect an agent" });
    await expect(dialog.getByLabel("Codex")).toBeChecked();
    await expect(dialog.getByLabel("Inbox")).toBeChecked();
    await dialog.getByLabel("Claude Code").check();
    await dialog.getByLabel("Read and suggest").check();
    await dialog.getByLabel("Access duration").selectOption("168");
    await page.screenshot({
      path: "docs/screenshots/agent-connection.png",
      fullPage: true,
      mask: [page.getByTestId("agent-connection-key")],
    });

    const requestPromise = page.waitForRequest(
      (request) =>
        request.url().endsWith("/api/v1/agent-grants") &&
        request.method() === "POST",
    );
    await dialog
      .getByRole("button", { name: "Create private connection" })
      .click();
    const grantRequest = await requestPromise;
    const grantInput = grantRequest.postDataJSON();
    expect(grantInput.projects).toEqual(["inbox"]);
    expect(grantInput.operations).toEqual(["read", "propose_memory"]);
    const duration = Date.parse(grantInput.expires_at) - Date.now();
    expect(duration).toBeGreaterThan(167 * 60 * 60 * 1000);
    expect(duration).toBeLessThanOrEqual(168 * 60 * 60 * 1000);

    const guide = page.locator('[data-ui="agent-setup-guide"]');
    await expect(guide).toContainText("Private access is ready");
    const token = await page.getByTestId("agent-connection-key").innerText();
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    const setup =
      (await page.getByTestId("agent-setup-command").textContent()) ?? "";
    expect(setup).toContain("claude mcp add --scope local bibrain");
    expect(setup).toContain('BRAIN_API_URL = "https://brain.example.test"');
    expect(setup).not.toContain(token);

    await guide.getByRole("button", { name: "Copy Claude Code setup" }).click();
    expect(
      (await page.evaluate(() => navigator.clipboard.readText())).replace(
        /\r\n?/g,
        "\n",
      ),
    ).toBe(setup.replace(/\r\n?/g, "\n"));
    await guide.getByRole("button", { name: "Copy connection key" }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      token,
    );
    await guide.getByRole("button", { name: "Done" }).click();

    const row = page.locator('[data-ui="connection-row"]');
    await expect(row).toContainText("Not connected");
    await expect(row).toContainText("waiting for first use");
    await expect(continuity).toContainText("1 waiting for first use");

    const verified = await page.evaluate(
      async (connectionKey) =>
        (
          await fetch("/api/v1/agent/verify", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${connectionKey}`,
              "Content-Type": "application/json",
            },
            body: "{}",
          })
        ).status,
      token,
    );
    expect(verified).toBe(200);
    await page.reload();
    await expect(row).toContainText("Connected");
    await expect(row).toContainText("Verified");
    await expect(continuity).toContainText("1 connected agent");

    await row.getByRole("button", { name: "Revoke access" }).click();
    await expect(row).toContainText("Revoked");
    await expect(row).toContainText("Access ended");
    await expect(continuity).toContainText("No agent using this project yet");
    const denied = await page.evaluate(
      async (connectionKey) =>
        (
          await fetch("/api/v1/agent/capabilities", {
            headers: { Authorization: `Bearer ${connectionKey}` },
          })
        ).status,
      token,
    );
    expect(denied).toBe(401);
  } finally {
    await fixture.close();
  }
});

test("guided connection remains usable at 320px in dark appearance", async ({
  browser,
}) => {
  const context = await browser.newContext({
    viewport: { width: 320, height: 760 },
  });
  const fixture = await firstNoteFixture(context);
  const page = await context.newPage();
  try {
    await page.addInitScript(() => localStorage.setItem("brain-theme", "dark"));
    await fixture.open(page);
    await page
      .getByRole("button", { name: "Connections", exact: true })
      .click();
    await page.getByRole("button", { name: "Connect an agent" }).click();
    const dialog = page.getByRole("dialog", { name: "Connect an agent" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("Codex")).toBeChecked();
    await expect(dialog.getByLabel("Read only")).toBeChecked();
    await dialog
      .getByRole("button", { name: "Create private connection" })
      .scrollIntoViewIfNeeded();
    await expect(
      dialog.getByRole("button", { name: "Create private connection" }),
    ).toBeVisible();
    const metrics = await page.evaluate(() => ({
      viewport: innerWidth,
      document: document.documentElement.scrollWidth,
      dialog: document.querySelector("dialog")?.getBoundingClientRect().width,
    }));
    expect(metrics.document).toBeLessThanOrEqual(metrics.viewport + 1);
    expect(metrics.dialog).toBeLessThanOrEqual(metrics.viewport);
  } finally {
    await fixture.close();
  }
});
