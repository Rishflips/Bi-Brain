import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test, expect, type BrowserContext } from "@playwright/test";
import { createApp } from "../../apps/server/app.ts";
import { ManagedRuntime } from "../../packages/runtime/managed.ts";
import { MANAGED_ORIGIN, installAppRoutes } from "../helpers/managed-browser.ts";

// Independent UI regressions. Trusted fixture provisioning only sets up real
// accounts/sessions; every browser read uses the actual authenticated HTTP app.
async function fixture(context: BrowserContext) {
  const root = mkdtempSync(join(tmpdir(), "brain-ui-review-"));
  const runtime = new ManagedRuntime(root);
  const a = await runtime.provision("https://synthetic.example.test", "a");
  const b = await runtime.provision("https://synthetic.example.test", "b");
  const sa = runtime.control.issueSession(a.id);
  const sb = runtime.control.issueSession(b.id);
  const handle = runtime.acquire(a.id);
  let id: string;
  try {
    id = (handle.brain.capture(handle.brain.ownerPrincipal(), {
      title: "Synthetic private A note", body: "SYNTHETIC_A_PRIVATE_INSPECTOR", visibility: "private",
    }) as { source_id: string }).source_id;
  } finally { handle.release(); }
  const app = await createApp(undefined, { managed: runtime, publicOrigin: MANAGED_ORIGIN });
  await installAppRoutes(context, app);
  const setSession = async (token: string) => context.addCookies([{
    name: "brain_session", value: token, url: MANAGED_ORIGIN, httpOnly: true, secure: true, sameSite: "Strict",
  }]);
  await setSession(sa.token);
  return { app, id, switchAccount: () => setSession(sb.token), close: async () => {
    // Stop polling and drain intercepted requests before closing their server.
    await context.close();
    await app.close(); runtime.close(); rmSync(root, { recursive: true, force: true });
  } };
}

test("account switch closes an already open private inspector", async ({ page, context }) => {
  const f = await fixture(context);
  try {
    await page.goto(MANAGED_ORIGIN);
    await page.getByRole("button", { name: "Your brain", exact: true }).click();
    await page.getByRole("button", { name: /Synthetic private A note/ }).click();
    await expect(page.getByTestId("original")).toContainText("SYNTHETIC_A_PRIVATE_INSPECTOR");
    await f.switchAccount();
    await expect(page.getByText(/You signed in as a different account/).first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await expect(page.getByText("SYNTHETIC_A_PRIVATE_INSPECTOR", { exact: true })).toHaveCount(0);
  } finally { await f.close(); }
});

test("a delayed private source response cannot reopen a dialog after account switch", async ({ page, context }) => {
  const f = await fixture(context);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let received!: () => void;
  const started = new Promise<void>((resolve) => { received = resolve; });
  let finished!: () => void;
  const delivered = new Promise<void>((resolve) => { finished = resolve; });
  try {
    await context.route(`${MANAGED_ORIGIN}/api/v1/sources/${f.id}`, async (route, request) => {
      const response = await f.app.inject({ url: `/api/v1/sources/${f.id}`, headers: {
        host: new URL(MANAGED_ORIGIN).host, cookie: (await request.allHeaders()).cookie,
      } });
      received();
      await held;
      await route.fulfill({ status: response.statusCode, contentType: "application/json", body: response.body });
      finished();
    });
    await page.goto(MANAGED_ORIGIN);
    await page.getByRole("button", { name: "Your brain", exact: true }).click();
    await page.getByRole("button", { name: /Synthetic private A note/ }).click();
    await started;
    await f.switchAccount();
    await expect(page.getByText(/You signed in as a different account/).first()).toBeVisible({ timeout: 10000 });
    release();
    await delivered;
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await expect(page.getByText("SYNTHETIC_A_PRIVATE_INSPECTOR", { exact: true })).toHaveCount(0);
  } finally { release(); await f.close(); }
});

test("runtime discovery failure cannot authenticate a workspace or default to local pairing", async ({ page, context }) => {
  const f = await fixture(context);
  try {
    const runtimeUrl = `${MANAGED_ORIGIN}/api/v1/runtime`;
    await context.route(runtimeUrl, (route) => route.fulfill({
      status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "UNAVAILABLE" } }),
    }));
    await page.goto(MANAGED_ORIGIN);
    await expect(page.getByRole("button", { name: /Save something/ }).first()).toBeDisabled();
    await expect(page.getByLabel("Installation code")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Retry|Try again|Reload/i })).toBeVisible();
    await context.unroute(runtimeUrl);
    await page.getByRole("button", { name: /Retry|Try again|Reload/i }).click();
    await expect(page.getByRole("button", { name: /Save something/ }).first()).toBeEnabled();
  } finally { await f.close(); }
});

test("a signed-out managed browser never offers local pairing when runtime discovery fails", async ({ page, context }) => {
  const f = await fixture(context);
  try {
    await context.clearCookies();
    await context.route(`${MANAGED_ORIGIN}/api/v1/runtime`, (route) => route.fulfill({
      status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "UNAVAILABLE" } }),
    }));
    await page.goto(MANAGED_ORIGIN);
    await expect(page.getByRole("button", { name: /Retry|Try again|Reload/i })).toBeVisible();
    await expect(page.getByLabel("Installation code")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Save something/ }).first()).toBeDisabled();
  } finally { await f.close(); }
});
