import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { createApp } from "../../apps/server/app.ts";
import { ManagedRuntime } from "../../packages/runtime/managed.ts";
import { OidcClient } from "../../packages/identity/oidc.ts";
import { ManagedLogin } from "../../packages/identity/managed-login.ts";
import { startFakeIssuer } from "../helpers/oidc-provider.ts";
import {
  MANAGED_HOST,
  MANAGED_ORIGIN,
  installAppRoutes,
  installFakeIssuerRoutes,
  managedSessionCookie,
} from "../helpers/managed-browser.ts";

/**
 * Browser-first managed regression. It drives the real application at a synthetic
 * HTTPS origin through Playwright interception that forwards to `app.inject`, and
 * the real signed-token disposable fake issuer. It proves two managed accounts stay
 * isolated across sign-in, capture, sign-out and re-login, and that the sign-in
 * screen never shows another account's text.
 *
 * This is not a TLS, DNS, hosted-deployment or live-provider proof: no socket is
 * opened to the synthetic origin and no live identity provider is contacted. All
 * identity, session and isolation behavior comes from real application code and
 * signed synthetic tokens.
 */
test.setTimeout(120_000);

test("managed accounts stay isolated across sign-in, capture, sign-out and re-login", async ({
  browser,
}) => {
  const root = mkdtempSync(join(tmpdir(), "bibrain-browser-managed-"));
  const issuer = await startFakeIssuer({
    subject: "subject-a",
    displayName: "Synthetic A",
  });
  const runtime = new ManagedRuntime(root);
  const oidc = new OidcClient({
    issuer: issuer.issuer,
    clientId: issuer.clientId,
    clientSecret: issuer.clientSecret,
    publicOrigin: MANAGED_ORIGIN,
    callbackPath: issuer.callbackPath,
    customFetch: issuer.fetcher,
  });
  const login = new ManagedLogin(runtime, oidc);
  const app = await createApp(undefined, {
    managed: runtime,
    login,
    publicOrigin: MANAGED_ORIGIN,
    oidcCallbackPath: issuer.callbackPath,
    static: true,
  });

  let contextA: BrowserContext | undefined;
  let contextB: BrowserContext | undefined;
  const markerA = `SYNTHETIC_ACCOUNT_A ${Date.now()}`;
  const markerB = `SYNTHETIC_ACCOUNT_B ${Date.now()}`;
  try {
    // The public runtime metadata advertises a real managed sign-in link and no
    // local pairing, so the UI can never present pairing as managed login.
    const runtimeMeta = await app.inject({
      method: "GET",
      url: "/api/v1/runtime",
      headers: { host: MANAGED_HOST },
    });
    expect(runtimeMeta.statusCode).toBe(200);
    expect(runtimeMeta.json()).toMatchObject({
      mode: "managed",
      sign_in_url: "/auth/login",
      sign_in_available: true,
      pairing_available: false,
    });

    // Account A signs in with a real code exchange and captures one marker note.
    contextA = await openManagedContext(browser, app, issuer);
    const pageA = await contextA.newPage();
    await signIn(pageA);
    await capture(pageA, "Account A note", `${markerA} status active`);
    await expectNoteVisible(pageA, markerA);

    // Account B is a separate browser context bound to a different trusted
    // subject. It starts empty and cannot see anything A saved.
    issuer.setIdentity("subject-b", "Synthetic B");
    contextB = await openManagedContext(browser, app, issuer);
    const pageB = await contextB.newPage();
    await signIn(pageB);
    await expectNoteMissing(pageB, markerA);
    await capture(pageB, "Account B note", `${markerB} status paused`);
    await expectNoteVisible(pageB, markerB);
    await expectNoteMissing(pageB, markerA);

    // The injected application enforces the same separation server-side: each
    // opaque session reads only its own tenant.
    const cookieA = await managedSessionCookie(contextA);
    const cookieB = await managedSessionCookie(contextB);
    expect(cookieA).toMatch(/^[a-f0-9]{64}$/);
    expect(cookieB).toMatch(/^[a-f0-9]{64}$/);
    expect(cookieA).not.toBe(cookieB);
    expect((await injectRead(app, markerA, cookieA)).body).toContain(markerA);
    expect((await injectRead(app, markerA, cookieB)).body).not.toContain(markerA);
    expect((await injectRead(app, markerB, cookieA)).body).not.toContain(markerB);
    expect((await injectRead(app, markerB, cookieB)).body).toContain(markerB);

    // A signs out. The browser returns to the managed sign-in screen, holds no
    // session, and shows none of A's text.
    await signOut(pageA);
    await expect(
      pageA.getByRole("heading", { name: "Your work, remembered." }),
    ).toBeVisible();
    await expect(
      pageA.getByRole("link", { name: "Sign in to BiBrain" }),
    ).toBeVisible();
    await expect(pageA.getByText(markerA)).toHaveCount(0);
    expect(await managedSessionCookie(contextA)).toBe("");

    // A refresh keeps the signed-out state, and signing back in as the same
    // account restores exactly that account's original note.
    await pageA.reload();
    await expect(
      pageA.getByRole("heading", { name: "Your work, remembered." }),
    ).toBeVisible();
    await expect(pageA.getByText(markerA)).toHaveCount(0);
    issuer.setIdentity("subject-a", "Synthetic A");
    await signIn(pageA);
    await expectNoteVisible(pageA, markerA);
    await expectNoteMissing(pageA, markerB);
  } finally {
    if (contextA) await contextA.close();
    if (contextB) await contextB.close();
    await app.close();
    try {
      runtime.close();
    } catch {
      // A pinned handle must not crash cleanup; release happens per request.
    }
    await issuer.close();
    rmSync(root, { recursive: true, force: true });
  }
});

async function openManagedContext(
  browser: Browser,
  app: Awaited<ReturnType<typeof createApp>>,
  issuer: Awaited<ReturnType<typeof startFakeIssuer>>,
): Promise<BrowserContext> {
  const context = await browser.newContext();
  await installAppRoutes(context, app);
  await installFakeIssuerRoutes(context, issuer);
  return context;
}

/** Starts at the real sign-in screen and returns once the account is signed in. */
async function signIn(page: Page): Promise<void> {
  await page.goto(`${MANAGED_ORIGIN}/`);
  await page.getByRole("link", { name: "Sign in to BiBrain" }).click();
  await expect(
    page.getByRole("button", { name: "Save something", exact: false }).first(),
  ).toBeEnabled({ timeout: 30_000 });
}

/** Signs out through the managed Settings control. */
async function signOut(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Settings & privacy" }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
}

/** Captures a note through the same accessible controls the existing journeys use. */
async function capture(page: Page, title: string, body: string): Promise<void> {
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
  await page.getByRole("button", { name: "Close dialog" }).click();
}

async function searchBrain(page: Page, query: string): Promise<void> {
  await page.getByRole("button", { name: "Your brain", exact: true }).click();
  await page.getByLabel("Search your brain").fill(query);
}

async function expectNoteVisible(page: Page, marker: string): Promise<void> {
  await searchBrain(page, marker);
  await expect(
    page.getByRole("button", { name: new RegExp(escapeRegExp(marker)) }),
  ).toBeVisible();
}

async function expectNoteMissing(page: Page, marker: string): Promise<void> {
  await searchBrain(page, marker);
  await expect(
    page.getByText("No matches. Try a different word, or save something new."),
  ).toBeVisible();
}

function injectRead(
  app: Awaited<ReturnType<typeof createApp>>,
  query: string,
  session: string,
) {
  return app.inject({
    method: "GET",
    url: `/api/v1/search?q=${encodeURIComponent(query)}`,
    headers: { host: MANAGED_HOST, cookie: `brain_session=${session}` },
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
