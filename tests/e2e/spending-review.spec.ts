import { expect, test } from "@playwright/test";
import { createApp } from "../../apps/server/app.ts";
import { Brain } from "../../packages/domain/service.ts";
import { Storage } from "../../packages/storage/index.ts";
import { DispatchLedger } from "../../packages/storage/spend.ts";
import type {
  DispatchSpec,
  JobLease,
  SpendLimits,
} from "../../packages/domain/spend.ts";
import {
  MANAGED_HOST,
  MANAGED_ORIGIN,
  installAppRoutes,
} from "../helpers/managed-browser.ts";

/**
 * User-visible money guard. A real local brain carries a durable over-bound
 * dispatch block plus one unresolved "usage unknown" hold. The built UI must:
 *  - disable the paid-processing authorization and show the effective opt-out
 *    without silently rewriting the stored preference;
 *  - render the unresolved hold as a positive amount ("<$0.0001"), never $0.0000;
 *  - show the actual overrun reason rather than the generic "unknown charge" text;
 *  - still let the owner save preferences, and retain the block.
 * Core capture stays available while only paid processing is blocked.
 *
 * The browser talks to the real Fastify app over a synthetic HTTPS origin via
 * `installAppRoutes` (real inject + real cookies). It is not a TLS/hosted proof.
 */
test.setTimeout(60_000);

test("blocked paid processing is honest and honest money stays visible", async ({
  browser,
}) => {
  const store = new Storage(":memory:");
  // Deterministic October 16 clock; leases and accounting days are stable.
  const clock = () => new Date("2026-10-16T10:00:00.000Z");
  const brain = new Brain(store, clock);
  const owner = brain.ownerPrincipal();

  // 1. Opt in and set caps before any block exists.
  brain.prefs(owner, {
    enabled: true,
    time_zone: "UTC",
    digest_hour: 9,
    quiet_start: 22,
    quiet_end: 8,
    daily_cap_micro_usd: 1000,
    per_job_cap_micro_usd: 1000,
    provider_enabled: true,
  });

  // 2. Real queued jobs, promoted to running with a current worker lease.
  const leaseUntil = new Date(clock().getTime() + 3_600_000).toISOString();
  const startJob = (ownerName: string) => {
    const job = brain.enqueue("inbox", "derive_brief", {});
    store.run(
      "UPDATE jobs SET status='running',lease_owner=?,lease_until=?,fence=? WHERE id=?",
      ownerName,
      leaseUntil,
      1,
      job.id,
    );
    const lease: JobLease = {
      job_id: job.id,
      owner: ownerName,
      fence: 1,
      expires_at: leaseUntil,
    };
    return { jobId: job.id, lease };
  };
  const a = startJob("worker-a");
  const b = startJob("worker-b");

  const ledger = new DispatchLedger(store, clock);
  const limits: SpendLimits = {
    per_job_micro_usd: 1000,
    daily_micro_usd: 1000,
    time_zone: "UTC",
  };
  const dispatch = (jobId: string, reserved: number, key: string): DispatchSpec => ({
    job_id: jobId,
    dispatch_key: key,
    stage: "decision",
    reserved_micro_usd: reserved,
    provider: "synthetic-provider",
    model: "synthetic-model",
    price_version: "1",
    request_hash: "a".repeat(64),
    config_hash: "b".repeat(64),
  });

  // 3. job A: reserve an unknown-cost hold of 1 micro and mark it dispatched, so
  // the unresolved hold exists BEFORE the block is set.
  const holdA = ledger.reserve(dispatch(a.jobId, 1, "decision"), a.lease, limits);
  ledger.markDispatched(holdA.call_id, a.lease);

  // 4. job B: reserve 20, dispatch, then settle 30. Over-reservation records the
  // durable overrun block and retains the real expenditure.
  const holdB = ledger.reserve(dispatch(b.jobId, 20, "decision"), b.lease, limits);
  ledger.markDispatched(holdB.call_id, b.lease);
  ledger.settle(holdB.call_id, 30);

  const summary = ledger.summary(limits);
  expect(summary.unresolved_micro_usd).toBe(1);
  expect(summary.settled_micro_usd).toBe(30);
  expect(summary.blocked).toBe(true);

  const app = await createApp(brain, {
    publicOrigin: MANAGED_ORIGIN,
    pairSecret: "synthetic-operator-pairing-code-over32chars",
  });
  const context = await browser.newContext();
  const session = brain.issueSession();
  await installAppRoutes(context, app, MANAGED_ORIGIN);
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
  const page = await context.newPage();

  try {
    await page.goto(MANAGED_ORIGIN);

    // The browser holds a real Secure/HttpOnly/Strict session cookie, and the app
    // answers as the local single-owner deployment with that session.
    const held = (await context.cookies(MANAGED_ORIGIN)).find(
      (cookie) => cookie.name === "brain_session",
    );
    expect(held).toMatchObject({ httpOnly: true, secure: true, sameSite: "Strict" });
    const runtime = await page.evaluate(() =>
      fetch("/api/v1/runtime").then((response) => response.json()),
    );
    expect(runtime.mode).toBe("local");
    const live = await page.evaluate(() =>
      fetch("/api/v1/session").then((response) => response.json()),
    );
    expect(live.csrf).toBe(session.csrf);

    // Capture stays globally available while paid processing is blocked.
    await expect(
      page.getByRole("button", { name: "Save something", exact: false }).first(),
    ).toBeEnabled();

    // The stored preference is still opted in; only the effective view is off.
    expect(
      store.setting<{ provider_enabled?: boolean } | null>("preferences", null)
        ?.provider_enabled,
    ).toBe(true);

    await page.getByRole("button", { name: "Settings & privacy" }).click();

    // Paid authorization is disabled and shows the effective opt-out.
    const paid = page.getByRole("checkbox", {
      name: /I authorize selected text/,
    });
    await expect(paid).toBeVisible();
    await expect(paid).toBeDisabled();
    await expect(paid).not.toBeChecked();

    // The unresolved "usage unknown" hold is a positive amount, never $0.0000.
    const usage = page.locator("p.muted", {
      hasText: "unresolved (usage unknown)",
    });
    await expect(usage).toBeVisible();
    const unresolved = (await usage.innerText()).match(
      /unresolved \(usage unknown\)\s*(\S+)/,
    );
    expect(unresolved?.[1]).toBe("<$0.0001");

    // The visible reason is the real overrun, not a vague "unknown charge".
    await expect(page.getByText(/exceeded its reserved bound/)).toBeVisible();
    await expect(
      page.getByText(/Paid preparation is blocked until the recorded accounting is reconciled/),
    ).toHaveCount(0);

    // Saving is still permitted; it reports success and keeps the block.
    for (const label of ["Daily cap (USD)", "Per preparation cap (USD)"])
      expect(await page.getByLabel(label).evaluate((input: HTMLInputElement) => input.validity.stepMismatch)).toBe(false);
    await page.getByRole("button", { name: "Save preferences" }).click();
    await expect(page.getByText("Background preferences saved.")).toBeVisible();
    await expect(page.getByText(/exceeded its reserved bound/)).toBeVisible();
    await expect(paid).toBeDisabled();
    await expect(paid).not.toBeChecked();

    // Only the explicit save rewrote the stored opt-out; the block itself stays.
    expect(
      store.setting<{ provider_enabled?: boolean } | null>("preferences", null)
        ?.provider_enabled,
    ).toBe(false);

    // Server-side guard: re-enabling paid processing is refused with BUDGET_BLOCKED.
    const refused = await app.inject({
      method: "PATCH",
      url: "/api/v1/preferences/background",
      headers: {
        host: MANAGED_HOST,
        cookie: `brain_session=${session.token}`,
        "x-brain-csrf": session.csrf,
        "content-type": "application/json",
      },
      payload: {
        enabled: true,
        time_zone: "UTC",
        digest_hour: 9,
        quiet_start: 22,
        quiet_end: 8,
        daily_cap_micro_usd: 1000,
        per_job_cap_micro_usd: 1000,
        provider_enabled: true,
      },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe("BUDGET_BLOCKED");
  } finally {
    // Close the polling browser context before the app, then release storage, so a
    // closed server never races the page's refresh loop. Teardown errors surface.
    await context.close();
    await app.close();
    store.close();
  }
});
