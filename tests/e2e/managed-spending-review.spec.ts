import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type BrowserContext } from "@playwright/test";
import { createApp } from "../../apps/server/app.ts";
import {
  ManagedRuntime,
  type ManagedHandle,
} from "../../packages/runtime/managed.ts";
import { ManagedSpendingStore } from "../../packages/storage/managed-spending.ts";
import { DispatchLedger } from "../../packages/storage/spend.ts";
import type {
  DispatchSpec,
  JobLease,
  SpendLimits,
} from "../../packages/domain/spend.ts";
import type {
  ManagedDispatchSpec,
  ManagedLimits,
} from "../../packages/domain/managed-spend.ts";
import {
  MANAGED_HOST,
  MANAGED_ORIGIN,
  installAppRoutes,
} from "../helpers/managed-browser.ts";

/**
 * Independent browser regression for the owner-visible managed money view.
 *
 * It drives the real `ManagedRuntime` (real per-tenant SQLite, real control
 * store), the real `ManagedSpendingStore`, a real provisioned tenant job/lease
 * and the real Fastify app serving the built UI through the synthetic HTTPS
 * interception in `../helpers/managed-browser.ts`. That helper forwards every
 * request to `app.inject`, so status text, cookies and static assets come from
 * production code. The browser holds only an opaque control-store session
 * (`control.issueSession`): no tenant header or payload claim is trusted and no
 * live identity provider is contacted. All bodies are synthetic and no provider
 * or network is constructed, so this is not a TLS, hosted or live-provider proof.
 *
 * The central ledger is the single authority. The tenant `DispatchLedger` is a
 * conservative projection, so a settled central charge must win over a stale
 * held tenant row, and the public view must never expose another account's
 * money, the singleton service cap or a service-wide committed total.
 *
 * Assertions that depend on the current UI copy are intentionally narrow; if the
 * UI cannot yet be coupled to a plain reason, this test is expected to start RED
 * rather than invent a new API.
 */
test.setTimeout(60_000);

const ISSUER = "https://issuer.synthetic.test";
const NOW = "2026-10-16T10:00:00Z";
const clock = () => new Date(NOW);

/** One positive operator ceiling per dimension: $1.000000 in integer micro-USD. */
const MICRO_USD = 1_000_000;

const TENANT_LIMITS: SpendLimits = {
  per_job_micro_usd: MICRO_USD,
  daily_micro_usd: MICRO_USD,
  time_zone: "UTC",
};
const CENTRAL_LIMITS: ManagedLimits = {
  per_job_micro_usd: MICRO_USD,
  user_daily_micro_usd: MICRO_USD,
  time_zone: "UTC",
};

function tenantSpec(jobId: string, amount: number): DispatchSpec {
  return {
    job_id: jobId,
    dispatch_key: "reasoning",
    stage: "reasoning",
    reserved_micro_usd: amount,
    provider: "synthetic-provider",
    model: "synthetic-model",
    price_version: "synthetic-v1",
    request_hash: "a".repeat(64),
    config_hash: "b".repeat(64),
  };
}

function centralSpec(accountId: string, spec: DispatchSpec): ManagedDispatchSpec {
  return { account_id: accountId, ...spec, limits: CENTRAL_LIMITS };
}

/** Promotes a queued tenant job to a real running lease, exactly as the worker does. */
function runningLease(handle: ManagedHandle, jobId: string): JobLease {
  const until = "2026-10-16T10:30:00Z";
  handle.brain.store.run(
    "UPDATE jobs SET status='running',lease_owner=?,lease_until=?,fence=?,attempts=attempts+1 WHERE id=?",
    "synthetic-worker",
    until,
    1,
    jobId,
  );
  return { job_id: jobId, owner: "synthetic-worker", fence: 1, expires_at: until };
}

test("a settled managed charge stays honest while a stale tenant hold, another account and a safety pause never reach the owner", async ({
  browser,
}) => {
  const root = mkdtempSync(join(tmpdir(), "bibrain-managed-spending-review-"));
  const runtime = new ManagedRuntime(root, { clock });
  const central = new ManagedSpendingStore(runtime.control, clock);
  const releases: Array<() => void> = [];
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  let context: BrowserContext | undefined;
  let failure: unknown;

  try {
    // 1. Two real accounts, one positive operator ceiling per dimension and a
    //    fixed 2026-10-16 → 2026-10-17 UTC allowance period.
    const a = runtime.provision(ISSUER, "synthetic-owner-a");
    const b = runtime.provision(ISSUER, "synthetic-owner-b");
    central.setServicePolicy({ daily_micro_usd: MICRO_USD });
    for (const account of [a, b]) {
      central.configureAccountPeriod({
        account_id: account.id,
        starts_at: "2026-10-16T00:00:00Z",
        ends_at: "2026-10-17T00:00:00Z",
        allowance_micro_usd: MICRO_USD,
      });
      central.setAccountPolicy({
        account_id: account.id,
        per_job_micro_usd: MICRO_USD,
        user_daily_micro_usd: MICRO_USD,
      });
    }

    // 2. A's real tenant job + lease, then a stale tenant projection held at
    //    $0.010000 while the central authority settles the same slot at $0.005000.
    const handleA = runtime.acquire(a.id);
    releases.push(handleA.release);
    const ownerA = handleA.brain.ownerPrincipal();
    const jobA = handleA.brain.enqueue("inbox", "derive_brief", {
      principal: ownerA,
    });
    const leaseA = runningLease(handleA, jobA.id);
    const tenantLedger = new DispatchLedger(handleA.brain.store, clock);
    const tenantA = tenantLedger.reserve(
      tenantSpec(jobA.id, 10_000),
      leaseA,
      TENANT_LIMITS,
    );
    tenantLedger.markDispatched(tenantA.call_id, leaseA);
    const centralA = central.reserve(centralSpec(a.id, tenantSpec(jobA.id, 10_000)));
    central.linkProjection(centralA.call_id, tenantA.call_id);
    central.mark(centralA.call_id, CENTRAL_LIMITS);
    central.settleKnown(centralA.call_id, 5_000);
    expect(central.receiptByProjection(tenantA.call_id)).toMatchObject({
      state: "settled",
      actual_micro_usd: 5_000,
    });
    // The tenant projection stays deliberately stale at the held amount.
    expect(tenantLedger.get(tenantA.call_id)).toMatchObject({
      state: "dispatched",
    });

    // 3. B's unrelated central unresolved hold of $0.020000.
    const centralB = central.reserve(
      centralSpec(b.id, tenantSpec("synthetic-job-b", 20_000)),
    );
    central.mark(centralB.call_id, CENTRAL_LIMITS);

    // 4. Real managed Fastify app serving the built UI over the synthetic HTTPS
    //    origin. The browser holds only a trusted opaque control-store session.
    const createdApp = await createApp(undefined, {
      managed: runtime,
      publicOrigin: MANAGED_ORIGIN,
      static: true,
    });
    app = createdApp;
    const browserContext = await browser.newContext();
    context = browserContext;
    await installAppRoutes(browserContext, createdApp, MANAGED_ORIGIN);
    const session = runtime.control.issueSession(a.id);
    expect(session.token).toMatch(/^[a-f0-9]{64}$/);
    await browserContext.addCookies([
      {
        name: "brain_session",
        value: session.token,
        url: MANAGED_ORIGIN,
        httpOnly: true,
        secure: true,
        sameSite: "Strict",
      },
    ]);
    const page = await browserContext.newPage();

    await page.goto(MANAGED_ORIGIN);
    await expect(
      page.getByRole("button", { name: "Settings & privacy" }),
    ).toBeEnabled();

    // The browser really holds the opaque Secure/HttpOnly/Strict session.
    const held = (await browserContext.cookies(MANAGED_ORIGIN)).find(
      (cookie) => cookie.name === "brain_session",
    );
    expect(held).toMatchObject({
      value: session.token,
      httpOnly: true,
      secure: true,
      sameSite: "Strict",
    });

    // Runtime metadata is honest: managed, and connected paid processing is off.
    const meta = await page.evaluate(() =>
      fetch("/api/v1/runtime").then((response) => response.json()),
    );
    expect(meta.mode).toBe("managed");
    expect(meta.connected_processing_available).toBe(false);

    await page.getByRole("button", { name: "Settings & privacy" }).click();
    const spending = page
      .locator("article")
      .filter({
        has: page.getByRole("heading", { name: "Background help & spending" }),
      });
    await expect(spending).toBeVisible();

    // Only A's central settled charge is shown; its own unresolved hold is zero.
    // The stale tenant $0.010000 and B's $0.020000 must never surface.
    const money = page.locator("p.muted", {
      hasText: "unresolved (usage unknown)",
    });
    await expect(money).toBeVisible();
    const moneyText = await money.innerText();
    expect(moneyText).toContain("settled $0.005000");
    expect(moneyText).toContain("unresolved (usage unknown) $0.0000");
    expect(moneyText).not.toContain("$0.010000");
    expect(moneyText).not.toContain("$0.020000");
    const spendingText = await spending.innerText();
    expect(spendingText).not.toContain(b.id);
    // Own allowance: $1.000000 ceiling minus the $0.005000 settled commitment.
    await expect(spending).toContainText("Allowance left $0.995000.");

    // Connected paid is hard-off: the authorization toggle is disabled and the
    // plaintext note gives the reason without naming a vendor or a model.
    const paid = page.getByRole("checkbox", {
      name: /I authorize selected text/,
    });
    await expect(paid).toBeVisible();
    await expect(paid).toBeDisabled();
    await expect(paid).not.toBeChecked();
    const note = page.getByText(/not available on managed hosting/);
    await expect(note).toBeVisible();
    const noteText = await note.innerText();
    expect(noteText).toContain("not available on managed hosting");
    expect(noteText).toContain("Your saved work stays");
    expect(noteText).not.toMatch(/OpenAI|Codex|GPT|Claude|Anthropic|Gemini|Llama/i);

    // A real cookie + CSRF switch-on request is refused even though the operator
    // policy is configured, while the browser control stays disabled.
    const cookie = `brain_session=${session.token}`;
    const current = (
      await createdApp.inject({
        url: "/api/v1/preferences/background",
        headers: { host: MANAGED_HOST, cookie },
      })
    ).json();
    expect(current.provider_enabled).toBe(false);
    const refused = await createdApp.inject({
      method: "PATCH",
      url: "/api/v1/preferences/background",
      headers: {
        host: MANAGED_HOST,
        cookie,
        "x-brain-csrf": session.csrf,
        "content-type": "application/json",
      },
      payload: { ...current, provider_enabled: true },
    });
    expect(refused.statusCode).toBe(503);
    expect(refused.json().error.code).toBe("PROVIDER_UNAVAILABLE");
    await expect(paid).toBeDisabled();

    // Unrelated fractional caps go through the native number fields with no
    // stepMismatch and persist as real integer micro-USD preferences.
    const dailyCap = page.getByLabel("Daily cap (USD)");
    const perJobCap = page.getByLabel("Per preparation cap (USD)");
    await dailyCap.fill("0.200002");
    await perJobCap.fill("0.100001");
    expect(
      await dailyCap.evaluate(
        (input: HTMLInputElement) => input.validity.stepMismatch,
      ),
    ).toBe(false);
    expect(
      await perJobCap.evaluate(
        (input: HTMLInputElement) => input.validity.stepMismatch,
      ),
    ).toBe(false);
    await page.getByRole("button", { name: "Save preferences" }).click();
    await expect(page.getByText("Background preferences saved.")).toBeVisible();
    const saved = (
      await createdApp.inject({
        url: "/api/v1/preferences/background",
        headers: { host: MANAGED_HOST, cookie },
      })
    ).json();
    expect(saved).toMatchObject({
      daily_cap_micro_usd: 200_002,
      per_job_cap_micro_usd: 100_001,
      provider_enabled: false,
    });

    // The owner's own limits stay exact and never grow into a global figure; the
    // effective caps are the lower of the saved preference and the operator policy.
    const today = await page.evaluate(() =>
      fetch("/api/v1/today").then((response) => response.json()),
    );
    expect(today.status.spend).toMatchObject({
      settled_micro_usd: 5_000,
      unresolved_micro_usd: 0,
      actual: 5_000,
      reserved: 0,
      daily_limit_micro_usd: 200_002,
      per_job_limit_micro_usd: 100_001,
      // B's unknown dispatched call now pauses all managed paid admission, but
      // must not contaminate A's own central amounts or saved preferences.
      blocked: true,
      paused: true,
      paused_reason: "usage_pending",
    });
    expect(today.status.spend.allowance).toMatchObject({
      limit_micro_usd: MICRO_USD,
      committed_micro_usd: 5_000,
      remaining_micro_usd: 995_000,
      window_start: "2026-10-16T00:00:00.000Z",
      window_end: "2026-10-17T00:00:00.000Z",
    });
    expect(JSON.stringify(today.status.spend)).not.toContain(b.id);

    // A central safety failure pauses paid processing. On a real reload the owner
    // sees the plain, content-free reconciliation reason; nothing is invented.
    central.flagSettlementFailure(centralA.call_id);
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Settings & privacy" }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "Settings & privacy" }).click();
    const paused = page.locator("p.muted", {
      hasText: "Managed paid processing is paused",
    });
    await expect(paused).toBeVisible();
    await expect(paused).toContainText("a safety record could not be saved");
    await expect(paused).toContainText("an operator must reconcile");
    expect(await paused.innerText()).not.toMatch(/[0-9]/);
    await expect(paid).toBeDisabled();
    await expect(paid).not.toBeChecked();

    // Explicit capture is still retained while paid processing is paused: the
    // original text survives and is shown unchanged.
    const body = "SYNTHETIC_RECONCILIATION_CAPTURE retained original";
    await page
      .getByRole("button", { name: /Save something/ })
      .first()
      .click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Title", { exact: true }).fill("Reconciliation capture");
    await dialog.getByLabel("Paste something you are working on").fill(body);
    await dialog.getByRole("button", { name: "Save to my brain" }).click();
    await expect(page.getByTestId("original")).toContainText(body);
    await page.getByRole("button", { name: "Close dialog" }).click();
  } catch (error) {
    failure = error;
  } finally {
    // Stop browser polling and drain intercepted requests before closing their
    // server, release this test's own pinned handles before the runtime, and
    // remove only the temp root this test created. Never swallow failures.
    try {
      if (context) await context.close();
    } catch (error) {
      failure ??= error;
    }
    try {
      if (app) await app.close();
    } catch (error) {
      failure ??= error;
    }
    for (const release of releases) {
      try {
        release();
      } catch (error) {
        failure ??= error;
      }
    }
    try {
      runtime.close();
    } catch (error) {
      failure ??= error;
    }
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) throw failure;
});
