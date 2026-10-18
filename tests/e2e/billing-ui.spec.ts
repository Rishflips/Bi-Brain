import { expect, test } from "@playwright/test";

test("managed Settings explains checkout plainly and stays confirming", async ({
  page,
}) => {
  let checkoutRequested = false;
  await page.addInitScript(() => {
    (window as any).Paddle = {
      Environment: { set() {} },
      Initialize() {},
      Checkout: {
        open(input: { transactionId: string }) {
          (window as any).__openedTransaction = input.transactionId;
        },
      },
    };
  });
  await page.route("**/api/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname.replace("/api/v1", "");
    const json = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    if (path === "/runtime")
      return json({
        mode: "managed",
        sign_in_url: "/auth/login",
        sign_in_available: true,
        pairing_available: false,
      });
    if (path === "/session")
      return json({
        csrf: "synthetic-csrf",
        account_id: "00000000-0000-4000-8000-000000000001",
      });
    if (path === "/projects" || path === "/search" || path === "/connections")
      return json([]);
    if (path === "/today")
      return json({
        briefs: [],
        goals: [],
        proposals: [],
        receipts: [],
        pings: [],
        status: { jobs: [], spend: {} },
      });
    if (path === "/preferences/background")
      return json({
        enabled: false,
        time_zone: "UTC",
        digest_hour: 9,
        quiet_start: 22,
        quiet_end: 7,
        daily_cap_micro_usd: 0,
        per_job_cap_micro_usd: 0,
        provider_enabled: false,
        decision_provider_enabled: false,
      });
    if (path === "/billing/status")
      return json({
        available: true,
        mode: "sandbox",
        client_token: "test_01234567890123456789012345",
        state: checkoutRequested ? "confirming" : "not_started",
        cadence: checkoutRequested ? "monthly" : null,
        subscription_status: null,
        transaction_ref: checkoutRequested
          ? "txn_01h00000000000000000000000"
          : null,
        management_available: false,
      });
    if (path === "/billing/checkout-intent") {
      checkoutRequested = true;
      return json({
        transaction_ref: "txn_01h00000000000000000000000",
        status: "confirming",
      });
    }
    return json(
      { error: { code: "NOT_FOUND", message: "Endpoint unavailable." } },
      404,
    );
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Settings & privacy" }).click();
  await expect(
    page.getByRole("heading", { name: "Keep one brain across every agent" }),
  ).toBeVisible();
  await expect(page.getByText("Test checkout · no real payment")).toBeVisible();
  await page.getByRole("button", { name: "Choose monthly" }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        String(
          (window as unknown as { __openedTransaction?: string })
            .__openedTransaction ?? "",
        ),
      ),
    )
    .toBe("txn_01h00000000000000000000000");
  await expect(
    page.getByRole("heading", { name: "Confirming your plan" }),
  ).toBeVisible();
  await expect(page.getByText(/No paid allowance is enabled/)).toBeVisible();
  await page.getByRole("button", { name: "Continue secure checkout" }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        String(
          (window as unknown as { __openedTransaction?: string })
            .__openedTransaction ?? "",
        ),
      ),
    )
    .toBe("txn_01h00000000000000000000000");
});
