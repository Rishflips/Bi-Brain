import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { createApp } from "../../apps/server/app.ts";
import { ManagedRuntime } from "../../packages/runtime/managed.ts";
import {
  MANAGED_ORIGIN,
  installAppRoutes,
} from "../helpers/managed-browser.ts";

// Additional parent verification: actual capture through the application, not
// a screenshot-only acceptance or a simulated successful save.
for (const theme of ["light", "dark"] as const) {
  test(`inline keyboard capture fits 320px in ${theme} appearance`, async ({
    page,
    context,
  }) => {
    const root = mkdtempSync(join(tmpdir(), "brain-inline-layout-"));
    const runtime = new ManagedRuntime(root);
    const account = await runtime.provision(
      "https://synthetic.example.test",
      theme,
    );
    const session = runtime.control.issueSession(account.id);
    const app = await createApp(undefined, {
      managed: runtime,
      publicOrigin: MANAGED_ORIGIN,
    });
    try {
      await installAppRoutes(context, app);
      await context.addCookies([
        {
          name: "brain_session",
          value: session.token,
          url: MANAGED_ORIGIN,
          httpOnly: true,
          secure: true,
          sameSite: "Strict",
        },
      ]);
      await context.addInitScript(
        (value) => localStorage.setItem("brain-theme", value),
        theme,
      );
      await page.setViewportSize({ width: 320, height: 780 });
      await page.goto(MANAGED_ORIGIN);
      const composer = page.getByLabel("Save to your brain");
      await expect(composer).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute(
        "content",
        theme === "dark" ? "#111111" : "#f7f5ef",
      );
      const navigationRows = await page
        .locator('[data-ui="primary-navigation"] button')
        .evaluateAll(
          (buttons) =>
            new Set(buttons.map((button) => button.getBoundingClientRect().top))
              .size,
        );
      expect(navigationRows).toBe(1);
      // An empty Save is refused in plain words and sends nothing.
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByRole("alert")).toContainText(
        "Type or paste something first.",
      );
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      const original = `SYNTHETIC_KEYBOARD_${theme}\nUnicode café 🧠 and a multiline original.`;
      await composer.fill(original);
      await expect(composer).toBeFocused();
      const saved = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/v1/sources" &&
          response.request().method() === "POST",
      );
      await composer.press("Control+Enter");
      const response = await saved;
      expect(response.status()).toBe(201);
      const { source_id: id } = await response.json();
      const handle = runtime.acquire(account.id);
      try {
        expect(
          handle.brain.source(handle.brain.ownerPrincipal(), id).body,
        ).toBe(original);
      } finally {
        handle.release();
      }
      await expect(
        page.getByText(/kept exactly as you wrote it/i),
      ).toBeVisible();
      await page.getByRole("button", { name: "Open it", exact: true }).click();
      await expect(page.getByTestId("original")).toHaveText(original);
      await page.getByRole("button", { name: "Close dialog" }).click();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: `test-results/visible-inline-${theme}-320.png`,
        fullPage: true,
      });
    } finally {
      await context.close();
      await app.close();
      runtime.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("oversized inline input explains the limit and retains the draft without capture", async ({
  page,
  context,
}) => {
  const root = mkdtempSync(join(tmpdir(), "brain-inline-limit-"));
  const runtime = new ManagedRuntime(root);
  const account = await runtime.provision(
    "https://synthetic.example.test",
    "owner",
  );
  const session = runtime.control.issueSession(account.id);
  const app = await createApp(undefined, {
    managed: runtime,
    publicOrigin: MANAGED_ORIGIN,
  });
  let captureRequests = 0;
  try {
    await installAppRoutes(context, app);
    await context.addCookies([
      {
        name: "brain_session",
        value: session.token,
        url: MANAGED_ORIGIN,
        httpOnly: true,
        secure: true,
        sameSite: "Strict",
      },
    ]);
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        new URL(request.url()).pathname === "/api/v1/sources"
      )
        captureRequests++;
    });
    await page.goto(MANAGED_ORIGIN);
    await expect(page.getByLabel("Save to your brain")).toBeVisible();
    const draft = "x".repeat(100001);
    const composer = page.getByLabel("Save to your brain");
    await composer.fill(draft);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText(/100,000 characters/);
    await expect(composer).toHaveValue(draft);
    expect(captureRequests).toBe(0);
    const handle = runtime.acquire(account.id);
    try {
      expect(handle.brain.sources(handle.brain.ownerPrincipal())).toHaveLength(
        0,
      );
    } finally {
      handle.release();
    }
  } finally {
    await context.close();
    await app.close();
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});
