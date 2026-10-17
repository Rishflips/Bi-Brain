import { expect, test, type Browser } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createApp } from "../../apps/server/app.ts";
import { ManagedRuntime, managedDecisionCapability } from "../../packages/runtime/managed.ts";
import { ManagedSpendingStore } from "../../packages/storage/managed-spending.ts";
import { ManagedReconciliationStore } from "../../packages/storage/managed-reconciliation.ts";
import { ManagedDecisionActivationStore } from "../../packages/storage/managed-decision-activation.ts";
import { auditManagedHistory } from "../../packages/runtime/managed-audit.ts";
import { writeDecisionReadiness } from "../../packages/runtime/decision-worker-readiness.ts";
import { installAppRoutes, MANAGED_ORIGIN } from "../helpers/managed-browser.ts";

test.setTimeout(60_000);
const now = new Date("2026-10-17T12:00:00.000Z"), clock = () => now;
const ACK = { offline: true as const, workers_terminated: true as const };

/** Real services/SQLite/HTTP/built UI, synthetic HTTPS-origin transport and an
 * explicit synthetic readiness file. This is not a running decision worker. */
async function fixture(browser: Browser, stored: boolean, ready: boolean) {
  const root = mkdtempSync(join(tmpdir(), "brain-decision-consent-browser-parent-"));
  const decisionCapability = () => managedDecisionCapability({ control: runtime.control, root, now, optIn: true });
  const runtime: ManagedRuntime = new ManagedRuntime(root, { clock, decisionCapability: () => {
    const c = decisionCapability(); return { ready: c.available, reason: c.reason };
  } });
  const a = runtime.provision("https://issuer.synthetic.test", "synthetic-decision-browser-a");
  const b = runtime.provision("https://issuer.synthetic.test", "synthetic-decision-browser-b");
  const money = new ManagedSpendingStore(runtime.control, clock);
  money.setServicePolicy({ daily_micro_usd: 100_000 });
  for (const account of [a, b]) {
    money.setAccountPolicy({ account_id: account.id, per_job_micro_usd: 10_000, user_daily_micro_usd: 100_000 });
    money.configureAccountPeriod({ account_id: account.id, starts_at: "2026-10-17T00:00:00Z", ends_at: "2026-10-18T00:00:00Z", allowance_micro_usd: 100_000 });
  }
  new ManagedReconciliationStore(runtime.control, root, clock).initEpoch(ACK);
  const audit = auditManagedHistory({ runtime, root, ...ACK, clock });
  expect(audit.ok).toBe(true);
  const profile = new ManagedDecisionActivationStore(runtime.control, root, clock).enable({
    provider: "typesafe", endpoint: "https://api.typesafe.ai/v1/systemone", model: "jev-synthetic-v1",
    accepted_response_models: ["jev-synthetic-v1"], price_version: "synthetic-price-v1",
    input_micro_usd_per_million: 1000, output_micro_usd_per_million: 0,
    timeout_ms: 1000, max_request_bytes: 1_048_576, max_response_bytes: 262_144,
    audit_id: audit.audit_id!, expected_version: 0,
  }, ACK);
  if (ready) writeDecisionReadiness(root, {
    schema: 1, worker_id: randomUUID(), stage_scope: "decision", provider_family: profile.provider,
    endpoint_digest: profile.endpoint_digest, epoch: profile.epoch, root_nonce: profile.root_nonce,
    activation_fingerprint: profile.fingerprint, config_digest: profile.config_digest, model: profile.model,
    price_version: profile.price_version, booted_at: now.toISOString(), heartbeat_at: now.toISOString(),
    expires_at: "2026-10-17T12:00:15.000Z",
  }, clock);
  const handle = runtime.acquire(a.id), brain = handle.brain, owner = brain.ownerPrincipal();
  brain.prefs(owner, { ...brain.prefs(owner), provider_enabled: true, decision_provider_enabled: ready && stored,
    time_zone: "UTC", per_job_cap_micro_usd: 10_000, daily_cap_micro_usd: 100_000 });
  // Historical retained consent for a NEGATIVE unavailable-state test, not an
  // authorization shortcut or evidence that a worker was installed.
  if (stored && !ready) brain.store.set("preferences", { ...brain.store.setting("preferences", {}), decision_provider_enabled: true });
  const app = await createApp(undefined, { managed: runtime, static: true, publicOrigin: MANAGED_ORIGIN, decisionCapability });
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
    async switchAccount() {
      const next = runtime.control.issueSession(b.id);
      await context.addCookies([{ name: "brain_session", value: next.token, url: MANAGED_ORIGIN, secure: true, httpOnly: true, sameSite: "Strict" }]);
    },
    decisionConsentB() {
      const other = runtime.acquire(b.id);
      try { return other.brain.decisionBackgroundConsent(other.brain.ownerPrincipal()); }
      finally { other.release(); }
    },
    async close() { await context.close(); await app.close(); handle.release(); runtime.close(); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } };
}

test("decision consent stays checked and withdrawable while unavailable, and an unrelated save omits both consent fields", async ({ browser }) => {
  const f = await fixture(browser, true, false);
  try {
    await f.open();
    const decision = f.page.getByRole("checkbox", { name: "Additional background checks", exact: true });
    await expect(decision).toBeChecked();
    await expect(decision).toBeEnabled();
    await f.page.getByLabel("Per preparation cap (USD)").fill("0.001234");
    const request = f.page.waitForRequest((r) => r.url().endsWith("/api/v1/preferences/background") && r.method() === "PATCH");
    await f.page.getByRole("button", { name: "Save preferences" }).click();
    const body = (await request).postDataJSON();
    expect(body).not.toHaveProperty("provider_enabled");
    expect(body).not.toHaveProperty("decision_provider_enabled");
    await expect(f.page.getByText("Background preferences saved.")).toBeVisible();
    expect(f.brain.decisionBackgroundConsent(f.owner)).toBe(true);
    expect(f.brain.prefs(f.owner).per_job_cap_micro_usd).toBe(1234);
    await decision.uncheck();
    const response = f.page.waitForResponse((r) => r.url().endsWith("/api/v1/preferences/background") && r.request().method() === "PATCH");
    await f.page.getByRole("button", { name: "Save preferences" }).click();
    expect((await response).status()).toBe(200);
    expect(f.brain.decisionBackgroundConsent(f.owner)).toBe(false);
    expect(f.brain.backgroundConsent(f.owner)).toBe(true);
    await expect(decision).not.toBeChecked();
    await expect(decision).toBeDisabled();
  } finally { await f.close(); }
});

test("without an installed decision worker the optional control is unavailable but saving other preferences still works", async ({ browser }) => {
  const f = await fixture(browser, false, false);
  try {
    await f.open();
    const decision = f.page.getByRole("checkbox", { name: "Additional background checks", exact: true });
    await expect(decision).not.toBeChecked();
    await expect(decision).toBeDisabled();
    await f.page.getByLabel("Per preparation cap (USD)").fill("0.002345");
    await f.page.getByRole("button", { name: "Save preferences" }).click();
    await expect(f.page.getByText("Background preferences saved.")).toBeVisible();
    expect(f.brain.prefs(f.owner).per_job_cap_micro_usd).toBe(2345);
    expect(f.brain.decisionBackgroundConsent(f.owner)).toBe(false);
  } finally { await f.close(); }
});

test("transient usage pending does not impersonate missing capability, and loss of decision readiness never traps consent", async ({ browser }) => {
  const f = await fixture(browser, false, true);
  try {
    const limits = { per_job_micro_usd: 10_000, user_daily_micro_usd: 100_000, time_zone: "UTC" };
    const other = f.money.reserve({ account_id: f.b.id, job_id: "synthetic-other-stage-inflight", dispatch_key: "reasoning", stage: "reasoning",
      provider: "synthetic", model: "synthetic", price_version: "synthetic-v1", reserved_micro_usd: 10,
      request_hash: "a".repeat(64), config_hash: "b".repeat(64), limits });
    f.money.mark(other.call_id, limits);
    await f.open();
    const decision = f.page.getByRole("checkbox", { name: "Additional background checks", exact: true });
    await expect(decision).not.toBeChecked();
    await expect(decision).toBeEnabled();
    await decision.check();
    const grant = f.page.waitForResponse((r) => r.url().endsWith("/api/v1/preferences/background") && r.request().method() === "PATCH");
    await f.page.getByRole("button", { name: "Save preferences" }).click();
    expect((await grant).status()).toBe(200);
    expect(f.brain.decisionBackgroundConsent(f.owner)).toBe(true);
    rmSync(join(f.root, "decision-worker-ready.json"));
    await f.open();
    await expect(decision).toBeChecked();
    await expect(decision).toBeEnabled();
    await decision.uncheck();
    const revoke = f.page.waitForResponse((r) => r.url().endsWith("/api/v1/preferences/background") && r.request().method() === "PATCH");
    await f.page.getByRole("button", { name: "Save preferences" }).click();
    expect((await revoke).status()).toBe(200);
    expect(f.brain.decisionBackgroundConsent(f.owner)).toBe(false);
  } finally { await f.close(); }
});

test("a durable paid-processing block never tells an already-consenting owner that consent is missing", async ({ browser }) => {
  const f = await fixture(browser, true, true);
  try {
    expect(f.brain.backgroundConsent(f.owner)).toBe(true);
    expect(f.brain.decisionBackgroundConsent(f.owner)).toBe(true);
    const limits = { per_job_micro_usd: 10_000, user_daily_micro_usd: 100_000, time_zone: "UTC" };
    // The real money service creates a durable overrun block. No raw SQL or
    // simulated browser status replaces the persisted block under test.
    const other = f.money.reserve({ account_id: f.b.id, job_id: "synthetic-durable-overrun", dispatch_key: "reasoning", stage: "reasoning",
      provider: "synthetic", model: "synthetic", price_version: "synthetic-v1", reserved_micro_usd: 10,
      request_hash: "c".repeat(64), config_hash: "d".repeat(64), limits });
    f.money.mark(other.call_id, limits);
    f.money.settleKnown(other.call_id, 11);
    expect(f.brain.status(f.owner).spend).toMatchObject({
      blocked_reason: "overrun", stored_consent_active: true,
      decision_capability_ready: true, decision_stored_consent_active: true,
      decision_consent_effective: false,
    });
    await f.open();
    const decision = f.page.getByRole("checkbox", { name: "Additional background checks", exact: true });
    await expect(decision).toBeChecked();
    await expect(decision).toBeEnabled();
    await expect(f.page.getByText("The connected-model consent is also required", { exact: false })).toHaveCount(0);
    await expect(f.page.getByText("Your authorization for additional background checks is saved. Paid processing is not available right now; saved work stays available.", { exact: true })).toBeVisible();
    await decision.uncheck();
    const revoke = f.page.waitForResponse((r) => r.url().endsWith("/api/v1/preferences/background") && r.request().method() === "PATCH");
    await f.page.getByRole("button", { name: "Save preferences" }).click();
    expect((await revoke).status()).toBe(200);
    expect(f.brain.decisionBackgroundConsent(f.owner)).toBe(false);
    expect(f.brain.backgroundConsent(f.owner)).toBe(true);
  } finally { await f.close(); }
});

test("unsaved decision consent cannot follow an account switch or be echoed into the next account's save", async ({ browser }) => {
  const f = await fixture(browser, false, true);
  try {
    await f.open();
    const decision = f.page.getByRole("checkbox", { name: "Additional background checks", exact: true });
    await expect(decision).not.toBeChecked();
    await decision.check();
    await expect(decision).toBeChecked();
    await f.switchAccount();
    await expect(f.page.getByText(/You signed in as a different account/).first()).toBeVisible({ timeout: 10_000 });
    await expect(f.page.getByRole("dialog")).not.toBeVisible();
    // Do not reload the page: the existing App must fence/reset the old override.
    await f.page.getByRole("button", { name: "Settings & privacy" }).click();
    await expect(decision).not.toBeChecked();
    await f.page.getByLabel("Per preparation cap (USD)").fill("0.003456");
    const request = f.page.waitForRequest((r) => r.url().endsWith("/api/v1/preferences/background") && r.method() === "PATCH");
    await f.page.getByRole("button", { name: "Save preferences" }).click();
    const body = (await request).postDataJSON();
    expect(body).not.toHaveProperty("decision_provider_enabled");
    expect(body).not.toHaveProperty("provider_enabled");
    await expect(f.page.getByText("Background preferences saved.")).toBeVisible();
    expect(f.decisionConsentB()).toBe(false);
    expect(f.brain.decisionBackgroundConsent(f.owner)).toBe(false);
  } finally { await f.close(); }
});
