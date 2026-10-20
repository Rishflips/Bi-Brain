import { createHmac, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DodoClient, type DodoConfig } from "../../packages/providers/dodo.ts";
import { DodoEvidenceSource } from "../../packages/providers/dodo-evidence.ts";
import { DodoBillingService } from "../../packages/runtime/dodo-billing.ts";
import { verifyDodoWebhook } from "../../packages/domain/dodo-webhook.ts";
import { dodoConfig } from "../../apps/server/dodo-config.ts";
import { ProviderBillingWorker } from "../../packages/runtime/paddle-worker.ts";
import type { ServerOwnedBinding } from "../../packages/domain/billing-evidence.ts";
import { createApp } from "../../apps/server/app.ts";
import { ManagedRuntime } from "../../packages/runtime/managed.ts";

const now = new Date("2026-10-21T10:00:00.000Z");
const secret = `whsec_${Buffer.from("synthetic-dodo-webhook-secret-only").toString("base64")}`;
const checkoutUrl =
  "https://test.checkout.dodopayments.com/session/cks_synthetic";
const roots: string[] = [];
const services: DodoBillingService[] = [];
const config = (request: DodoConfig["transport"]["request"]): DodoConfig => ({
  mode: "sandbox",
  api_key: "synthetic-key",
  business_id: "bus_synthetic",
  monthly_product_ref: "pdt_monthly",
  annual_product_ref: "pdt_annual",
  allowed_currencies: ["USD"],
  transport: { request },
});
const response = (body: unknown, status = 200) => ({
  status,
  body: Buffer.from(JSON.stringify(body)),
});
function root() {
  const base = join(process.cwd(), "test-results");
  mkdirSync(base, { recursive: true });
  const path = mkdtempSync(join(base, "dodo-"));
  roots.push(path);
  return path;
}
function service(request: DodoConfig["transport"]["request"], path = root()) {
  const value = new DodoBillingService(
    path,
    new DodoClient(config(request)),
    {
      public_origin: "https://brain.example.test",
      webhook_secret: secret,
      webhook_endpoint_ref: "ep_synthetic",
    },
    () => now,
  );
  services.push(value);
  return value;
}
function delivery(body: unknown, id = "msg_synthetic") {
  const raw = Buffer.from(JSON.stringify(body));
  const timestamp = String(now.getTime() / 1000);
  const signature = createHmac("sha256", Buffer.from(secret.slice(6), "base64"))
    .update(`${id}.${timestamp}.`)
    .update(raw)
    .digest("base64");
  return {
    raw,
    headers: {
      "webhook-id": id,
      "webhook-timestamp": timestamp,
      "webhook-signature": `v1,${signature}`,
    },
  };
}
function event(intent: string) {
  return {
    business_id: "bus_synthetic",
    type: "payment.succeeded",
    timestamp: now.toISOString(),
    data: {
      payment_id: "pay_synthetic",
      subscription_id: "sub_synthetic",
      customer: { customer_id: "cus_synthetic", email: "discard@example.test" },
      metadata: { bibrain_intent: intent },
      status: "succeeded",
    },
  };
}
afterEach(() => {
  for (const s of services.splice(0)) s.close();
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
});

describe("Dodo payment boundary", () => {
  it("keeps configuration off by default, complete, test-first and secret-free in errors", () => {
    expect(dodoConfig({})).toBeUndefined();
    const env = {
      BRAIN_DODO_MODE: "sandbox",
      BRAIN_DODO_API_KEY: "synthetic-key",
      BRAIN_DODO_BUSINESS_ID: "bus_synthetic",
      BRAIN_DODO_MONTHLY_PRODUCT_ID: "pdt_monthly",
      BRAIN_DODO_ANNUAL_PRODUCT_ID: "pdt_annual",
      BRAIN_DODO_ALLOWED_CURRENCIES: "USD",
      BRAIN_DODO_WEBHOOK_SECRET: secret,
      BRAIN_DODO_WEBHOOK_ENDPOINT_ID: "ep_synthetic",
    };
    expect(dodoConfig(env)?.mode).toBe("sandbox");
    expect(() => dodoConfig({ BRAIN_DODO_API_KEY: "SENSITIVE" })).toThrow(
      /BRAIN_DODO_MODE/,
    );
    expect(() => dodoConfig({ ...env, BRAIN_DODO_MODE: "live" })).toThrow(
      /stays off/,
    );
    expect(() =>
      dodoConfig({ ...env, BRAIN_DODO_ALLOWED_CURRENCIES: "USD,USD" }),
    ).toThrow();
    expect(() =>
      dodoConfig({ ...env, BRAIN_DODO_ANNUAL_PRODUCT_ID: "pdt_monthly" }),
    ).toThrow();
  });
  it("verifies Standard Webhooks raw bytes, rotation, replay window and authenticated delivery IDs", () => {
    const d = delivery(event(randomUUID()));
    const check = (raw = d.raw, headers = d.headers, instant = now) =>
      verifyDodoWebhook({ raw_body: raw, headers, secret, now: instant });
    expect(check().id).toBe("msg_synthetic");
    expect(() => check(Buffer.from("{}"))).toThrow();
    expect(() =>
      check(d.raw, { ...d.headers, "webhook-id": "msg_forged" }),
    ).toThrow();
    expect(() =>
      check(d.raw, d.headers, new Date(now.getTime() + 301_000)),
    ).toThrow();
    expect(
      check(d.raw, {
        ...d.headers,
        "webhook-signature": `v2,ignored ${d.headers["webhook-signature"]}`,
      }).id,
    ).toBe("msg_synthetic");
  });
  it("creates one hosted checkout, resumes it across restart and keeps accounts isolated", async () => {
    const requests: unknown[] = [];
    const s = service(async (input) => {
      requests.push(input);
      return response({
        session_id: "cks_synthetic",
        checkout_url: checkoutUrl,
      });
    });
    const account = randomUUID();
    expect(await s.checkout(account, "monthly")).toMatchObject({
      checkout_url: checkoutUrl,
      status: "confirming",
    });
    expect(requests).toHaveLength(1);
    const request = requests[0] as { url: string; body: string };
    expect(request.url).toBe("https://test.dodopayments.com/checkouts");
    expect(JSON.parse(request.body)).toMatchObject({
      product_cart: [{ product_id: "pdt_monthly", quantity: 1 }],
      billing_currency: "USD",
      feature_flags: {
        allow_currency_selection: false,
        allow_discount_code: false,
      },
    });
    expect(s.status(account)).toMatchObject({
      state: "confirming",
      checkout_url: checkoutUrl,
      management_available: false,
    });
    expect(s.status(randomUUID()).checkout_url).toBeNull();
    await expect(s.checkout(account, "annual")).rejects.toThrow(
      /awaiting confirmation/,
    );
    expect(requests).toHaveLength(1);
    const reopened = service(async () => {
      throw new Error("no network");
    }, roots[0]!);
    expect(reopened.status(account).checkout_url).toBe(checkoutUrl);
  });
  it.each([500, 409, 429])(
    "retains ambiguous create %s and rejects duplicate checkout",
    async (status) => {
      const s = service(async () => response({}, status));
      const account = randomUUID();
      await expect(s.checkout(account, "monthly")).rejects.toThrow();
      await expect(s.checkout(account, "monthly")).rejects.toThrow(
        /awaiting confirmation/,
      );
      expect(s.store.accountIntent(account)).toMatchObject({ uncertain: 1 });
      expect(s.status(account).state).toBe("attention");
    },
  );
  it("allows retry only after definitive rejection; rejects untrusted hosted URLs", async () => {
    const s = service(async () => response({}, 422));
    const account = randomUUID();
    await expect(s.checkout(account, "monthly")).rejects.toThrow();
    expect(s.store.accountIntent(account)).toMatchObject({ state: "failed" });
    const client = new DodoClient(config(async () => response({})));
    expect(() =>
      client.validateCheckoutUrl(
        "https://test.checkout.dodopayments.com.evil.test/session/x",
      ),
    ).toThrow();
    expect(() =>
      client.validateCheckoutUrl("https://checkout.dodopayments.com/session/x"),
    ).toThrow();
    await expect(client.payment("../../secrets")).rejects.toThrow();
  });
  it("recovers ambiguous creation from signed payment, deduplicates delivery and never grants from webhook", async () => {
    const s = service(async () => {
      throw new Error("synthetic timeout");
    });
    const account = randomUUID();
    await expect(s.checkout(account, "monthly")).rejects.toThrow();
    const intent = String(s.store.accountIntent(account)!.intent_id);
    const d = delivery(event(intent));
    expect(await s.webhook(d.raw, d.headers)).toMatchObject({
      accepted: true,
      duplicate: false,
    });
    expect(await s.webhook(d.raw, d.headers)).toMatchObject({
      duplicate: true,
    });
    await new ProviderBillingWorker(s.store, null).tick();
    expect(s.store.binding(account)).toMatchObject({
      status: "pending_verification",
      initial_transaction_ref: "pay_synthetic",
    });
    expect(s.status(account).state).toBe("confirming");
    const serialized = JSON.stringify(
      s.store.db.prepare("SELECT * FROM paddle_events").all(),
    );
    expect(serialized).not.toContain("discard@example.test");
    const changed = delivery({
      ...event(intent),
      data: { ...event(intent).data, status: "failed" },
    });
    await expect(s.webhook(changed.raw, changed.headers)).rejects.toThrow(
      /conflicts/,
    );
    expect(s.store.binding(account)?.status).toBe("attention");
  });
  it("rejects other-business webhooks even when signed", async () => {
    const s = service(async () => response({}));
    const d = delivery({ ...event(randomUUID()), business_id: "bus_other" });
    await expect(s.webhook(d.raw, d.headers)).rejects.toThrow();
  });
  it("allows a failed attempt followed by a different successful payment inside one checkout", async () => {
    const s = service(async () =>
      response({ session_id: "cks_synthetic", checkout_url: checkoutUrl }),
    );
    const account = randomUUID();
    await s.checkout(account, "monthly");
    const intent = String(s.store.accountIntent(account)!.intent_id);
    const failed = delivery(
      {
        ...event(intent),
        type: "payment.failed",
        data: {
          ...event(intent).data,
          payment_id: "pay_failed",
          status: "failed",
        },
      },
      "msg_failed",
    );
    await s.webhook(failed.raw, failed.headers);
    await new ProviderBillingWorker(s.store, null).tick();
    expect(s.store.binding(account)).toBeUndefined();
    expect(s.store.accountIntent(account)!.transaction_ref).toBeNull();
    const paid = delivery(event(intent));
    await s.webhook(paid.raw, paid.headers);
    await new ProviderBillingWorker(s.store, null).tick();
    expect(s.store.binding(account)).toMatchObject({
      initial_transaction_ref: "pay_synthetic",
      status: "pending_verification",
    });
  });
  it("enforces owner/session scope through real managed HTTP and keeps the webhook raw", async () => {
    const path = root();
    const runtime = new ManagedRuntime(path, { clock: () => now });
    const billing = service(
      async () =>
        response({ session_id: "cks_synthetic", checkout_url: checkoutUrl }),
      path,
    );
    const app = await createApp(undefined, {
      managed: runtime,
      billing,
      publicOrigin: "https://brain.example.test",
      static: false,
    });
    try {
      const a = await runtime.provision(
        "https://issuer.example.test",
        "dodo-a",
      );
      const b = await runtime.provision(
        "https://issuer.example.test",
        "dodo-b",
      );
      const session = runtime.control.issueSession(a.id),
        other = runtime.control.issueSession(b.id);
      const headers = {
        host: "brain.example.test",
        origin: "https://brain.example.test",
        cookie: `brain_session=${session.token}`,
        "x-brain-csrf": session.csrf,
      };
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/v1/billing/checkout-intent",
            headers,
            payload: { cadence: "monthly", account_id: b.id },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/v1/billing/checkout-intent",
            headers,
            payload: { cadence: "monthly" },
          })
        ).statusCode,
      ).toBe(200);
      const status = await app.inject({
        url: "/api/v1/billing/status",
        headers: { ...headers, cookie: `brain_session=${other.token}` },
      });
      expect(status.json()).toMatchObject({
        state: "not_started",
        checkout_url: null,
      });
      const d = delivery(
        event(String(billing.store.accountIntent(a.id)!.intent_id)),
      );
      const delivered = await app.inject({
        method: "POST",
        url: "/api/v1/billing/webhook",
        headers: {
          host: "brain.example.test",
          "content-type": "application/json",
          ...d.headers,
        },
        payload: d.raw,
      });
      expect(delivered.statusCode).toBe(200);
      expect(JSON.stringify(status.json())).not.toContain("synthetic-key");
    } finally {
      await app.close();
      runtime.close();
    }
  });
});

describe("current Dodo evidence", () => {
  const binding = {
    mode: "sandbox",
    product_ref: "dodo-bibrain-personal-v1",
    price_ref: "pdt_monthly",
    cadence: "monthly",
    customer_ref: "cus_synthetic",
    subscription_ref: "sub_synthetic",
    initial_transaction_ref: "pay_synthetic",
    correlation_ref: "intent_synthetic",
  } as ServerOwnedBinding;
  const subscription = {
    subscription_id: "sub_synthetic",
    customer: { customer_id: "cus_synthetic" },
    product_id: "pdt_monthly",
    status: "active",
    quantity: 1,
    on_demand: false,
    addons: [],
    meters: [],
    payment_frequency_count: 1,
    payment_frequency_interval: "Month",
    previous_billing_date: "2026-10-01T00:00:00Z",
    next_billing_date: "2026-11-01T00:00:00Z",
  };
  const payment = {
    payment_id: "pay_synthetic",
    business_id: "bus_synthetic",
    customer: { customer_id: "cus_synthetic" },
    subscription_id: "sub_synthetic",
    metadata: { bibrain_intent: "intent_synthetic" },
    status: "succeeded",
    total_amount: 1500,
    currency: "USD",
    service_periods: [
      {
        subscription_id: "sub_synthetic",
        starts_at: subscription.previous_billing_date,
        ends_at: subscription.next_billing_date,
      },
    ],
    refunds: [],
    disputes: [],
  };
  const source = (
    sub = subscription,
    pay: unknown = payment,
    list = [{ payment_id: "pay_synthetic" }],
  ) =>
    new DodoEvidenceSource(
      new DodoClient(
        config(async (input) =>
          response(
            input.url.includes("/subscriptions/")
              ? sub
              : input.url.includes("/payments?")
                ? { items: list }
                : pay,
          ),
        ),
      ),
      () => now,
    );
  it("requires independent current paid-period evidence", async () => {
    expect(await source().read(binding)).toMatchObject({
      completed_payment: true,
      current_state: "active",
      transaction_ref: "pay_synthetic",
    });
  });
  it.each([
    { status: "failed" },
    { total_amount: 0 },
    { currency: "ZZZ" },
    { customer: { customer_id: "cus_other" } },
    { service_periods: [] },
    { metadata: { bibrain_intent: "other" } },
    { business_id: "bus_other" },
  ])(
    "refuses incomplete, unpaid, foreign or stale evidence %j",
    async (patch) => {
      await expect(
        source(subscription, { ...payment, ...patch }).read(binding),
      ).rejects.toThrow();
    },
  );
  it("returns adverse facts for refunds, disputes and cancellation", async () => {
    expect(
      (
        await source(subscription, {
          ...payment,
          refunds: [{ status: "succeeded" }],
        }).read(binding)
      ).current_state,
    ).toBe("refunded");
    expect(
      (
        await source(subscription, {
          ...payment,
          disputes: [{ dispute_status: "dispute_opened" }],
        }).read(binding)
      ).current_state,
    ).toBe("refunded");
    expect(
      (await source({ ...subscription, status: "cancelled" }).read(binding))
        .current_state,
    ).toBe("canceled");
  });
  it("rejects ambiguous payments, extra quantities and changed plan cadence", async () => {
    await expect(
      source(subscription, payment, [
        { payment_id: "pay_synthetic" },
        { payment_id: "pay_synthetic" },
      ]).read(binding),
    ).rejects.toThrow();
    await expect(
      source({ ...subscription, quantity: 2 }).read(binding),
    ).rejects.toThrow();
    await expect(
      source({ ...subscription, payment_frequency_interval: "Year" }).read(
        binding,
      ),
    ).rejects.toThrow();
  });
});
