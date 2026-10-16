import { expect, test, type Browser } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createApp } from "../../apps/server/app.ts";
import { managedCapability } from "../../apps/server/startup-gates.ts";
import { ManagedRuntime } from "../../packages/runtime/managed.ts";
import { ManagedSpendingStore } from "../../packages/storage/managed-spending.ts";
import { ManagedReconciliationStore } from "../../packages/storage/managed-reconciliation.ts";
import { ManagedActivationStore } from "../../packages/storage/managed-activation.ts";
import { auditManagedHistory } from "../../packages/runtime/managed-audit.ts";
import { writeWorkerReadiness } from "../../packages/runtime/worker-readiness.ts";
import { installAppRoutes, MANAGED_ORIGIN } from "../helpers/managed-browser.ts";

test.setTimeout(60_000);
const now = new Date("2026-10-16T09:00:00.000Z"), clock = () => now;

/** Real SQLite/HTTP/built UI with synthetic-origin interception and an explicit
 * synthetic readiness record. Actual worker bootstrap is a separate process test. */
async function fixture(browser: Browser, stored: boolean, ready: boolean) {
  const root = mkdtempSync(join(tmpdir(), "brain-consent-browser-parent-"));
  const capability = () => managedCapability({ control: runtime.control, root, now, optIn: true });
  const runtime: ManagedRuntime = new ManagedRuntime(root, { clock, capability: () => { const c = capability(); return { ready: c.available, reason: c.reason }; } });
  const a = runtime.provision("https://synthetic.example.test", "synthetic-browser-a");
  const b = runtime.provision("https://synthetic.example.test", "synthetic-browser-b");
  const money = new ManagedSpendingStore(runtime.control, clock);
  money.setServicePolicy({ daily_micro_usd: 100_000 });
  for (const account of [a, b]) {
    money.setAccountPolicy({ account_id: account.id, per_job_micro_usd: 10_000, user_daily_micro_usd: 100_000 });
    money.configureAccountPeriod({ account_id: account.id, starts_at: "2026-10-16T00:00:00Z", ends_at: "2026-10-17T00:00:00Z", allowance_micro_usd: 100_000 });
  }
  const handle = runtime.acquire(a.id), brain = handle.brain, owner = brain.ownerPrincipal();
  brain.prefs(owner, { ...brain.prefs(owner), provider_enabled: stored, time_zone: "UTC", per_job_cap_micro_usd: 10_000, daily_cap_micro_usd: 100_000 });
  const ack = { offline: true as const, workers_terminated: true as const };
  new ManagedReconciliationStore(runtime.control, root, clock).initEpoch(ack);
  const audit = auditManagedHistory({ runtime, root, clock, ...ack });
  expect(audit.ok).toBe(true);
  const profile = new ManagedActivationStore(runtime.control, root, clock).enable({ provider: "openai", model: "synthetic-model-v1", price_version: "synthetic-price-v1", input_micro_usd_per_million: 10_000, output_micro_usd_per_million: 10_000, accepted_response_models: ["synthetic-model-v1"], max_output_tokens: 100, endpoint_class: "openai_responses", audit_id: audit.audit_id!, expected_version: 0 }, ack);
  if (ready) writeWorkerReadiness(root, {
    schema: 1, worker_id: randomUUID(), epoch: profile.epoch, root_nonce: profile.root_nonce,
    activation_fingerprint: profile.fingerprint, config_digest: profile.config_digest,
    provider: profile.provider, model: profile.model, price_version: profile.price_version, endpoint_class: profile.endpoint_class,
    booted_at: now.toISOString(), heartbeat_at: now.toISOString(), expires_at: "2026-10-16T09:00:15.000Z",
  });
  const app = await createApp(undefined, { managed: runtime, static: true, publicOrigin: MANAGED_ORIGIN, capability });
  const context = await browser.newContext();
  await installAppRoutes(context, app, MANAGED_ORIGIN);
  const session = runtime.control.issueSession(a.id);
  await context.addCookies([{ name: "brain_session", value: session.token, url: MANAGED_ORIGIN, secure: true, httpOnly: true, sameSite: "Strict" }]);
  const page = await context.newPage();
  async function open() {
    await page.goto(MANAGED_ORIGIN);
    await page.getByRole("button", { name: "Settings & privacy" }).click();
    await expect(page.getByRole("heading", { name: "Background help & spending" })).toBeVisible();
  }
  return { root, a, b, money, brain, owner, page, open,
    async close() { await context.close(); await app.close(); handle.release(); runtime.close(); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } };
}

test("stored true remains checked and revocable while unavailable, and an unrelated cap save never rewrites consent", async ({ browser }) => {
  const f = await fixture(browser, true, false);
  try {
    await f.open();
    const paid = f.page.getByRole("checkbox", { name: /I authorize selected text/ });
    await expect(paid).toBeChecked();
    await expect(paid).toBeEnabled();
    await f.page.getByLabel("Per preparation cap (USD)").fill("0.001234");
    const request = f.page.waitForRequest((r) => r.url().endsWith("/api/v1/preferences/background") && r.method() === "PATCH");
    await f.page.getByRole("button", { name: "Save preferences" }).click();
    expect((await request).postDataJSON()).not.toHaveProperty("provider_enabled");
    await expect(f.page.getByText("Background preferences saved.")).toBeVisible();
    expect(f.brain.backgroundConsent(f.owner)).toBe(true);
    expect(f.brain.prefs(f.owner).per_job_cap_micro_usd).toBe(1234);
    await expect(paid).toBeChecked();

    await paid.uncheck();
    const revoke = f.page.waitForResponse((r) => r.url().endsWith("/api/v1/preferences/background") && r.request().method() === "PATCH");
    await f.page.getByRole("button", { name: "Save preferences" }).click();
    expect((await revoke).status()).toBe(200);
    expect(f.brain.backgroundConsent(f.owner)).toBe(false);
    await expect(paid).not.toBeChecked();
    await expect(paid).toBeDisabled();
  } finally { await f.close(); }
});

test("momentary usage pending permits consent, and losing worker readiness never traps the stored true toggle", async ({ browser }) => {
  const f = await fixture(browser, false, true);
  try {
    const limits = { per_job_micro_usd: 10_000, user_daily_micro_usd: 100_000, time_zone: "UTC" };
    const other = f.money.reserve({ account_id: f.b.id, job_id: "synthetic-other-in-flight", dispatch_key: "reasoning", stage: "reasoning", provider: "synthetic", model: "synthetic", price_version: "synthetic-v1", reserved_micro_usd: 10, request_hash: "a".repeat(64), config_hash: "b".repeat(64), limits });
    f.money.mark(other.call_id, limits);
    await f.open();
    const paid = f.page.getByRole("checkbox", { name: /I authorize selected text/ });
    await expect(paid).not.toBeChecked();
    await expect(paid).toBeEnabled();
    await expect(f.page.getByText(/not available on managed hosting yet/)).toHaveCount(0);
    await expect(f.page.getByText(/paid processing is not enabled yet/)).toHaveCount(0);
    await paid.check();
    const grant = f.page.waitForResponse((r) => r.url().endsWith("/api/v1/preferences/background") && r.request().method() === "PATCH");
    await f.page.getByRole("button", { name: "Save preferences" }).click();
    expect((await grant).status()).toBe(200);
    expect(f.brain.backgroundConsent(f.owner)).toBe(true);
    const today = await f.page.evaluate(() => fetch("/api/v1/today").then((r) => r.json()));
    expect(today.status.spend).toMatchObject({ capability_ready: true, consent_effective: true, blocked: true, available: false });

    rmSync(join(f.root, "worker-ready.json"));
    await f.open();
    await expect(paid).toBeChecked();
    await expect(paid).toBeEnabled();
    await paid.uncheck();
    const revoke = f.page.waitForResponse((r) => r.url().endsWith("/api/v1/preferences/background") && r.request().method() === "PATCH");
    await f.page.getByRole("button", { name: "Save preferences" }).click();
    expect((await revoke).status()).toBe(200);
    expect(f.brain.backgroundConsent(f.owner)).toBe(false);
    await expect(paid).not.toBeChecked();
  } finally { await f.close(); }
});
