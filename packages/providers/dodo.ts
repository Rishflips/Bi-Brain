import { z } from "zod";
import { BrainError } from "../domain/logic.ts";
import type { PaddleTransport } from "./paddle.ts";

export type DodoMode = "sandbox" | "live";
// The authority catalog has one logical plan family with two provider prices.
// Dodo represents those recurring prices as separate product IDs.
export const DODO_PLAN_FAMILY = "dodo-bibrain-personal-v1";
export type DodoConfig = {
  mode: DodoMode;
  api_key: string;
  business_id: string;
  monthly_product_ref: string;
  annual_product_ref: string;
  allowed_currencies: readonly string[];
  transport: PaddleTransport;
};
export const dodoId = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/);
export const dodoDate = z.string().datetime({ offset: true });
const customer = z.object({ customer_id: dodoId });
export const dodoSubscription = z.object({
  subscription_id: dodoId,
  customer,
  product_id: dodoId,
  status: z.enum([
    "pending",
    "active",
    "on_hold",
    "cancelled",
    "failed",
    "expired",
  ]),
  quantity: z.number().int(),
  on_demand: z.boolean(),
  payment_frequency_count: z.number().int(),
  payment_frequency_interval: z.string(),
  previous_billing_date: dodoDate,
  next_billing_date: dodoDate,
  addons: z.array(z.unknown()).max(20),
  meters: z.array(z.unknown()).max(20),
});
export const dodoPayment = z.object({
  payment_id: dodoId,
  business_id: dodoId,
  customer,
  status: z.string(),
  subscription_id: dodoId.nullable(),
  checkout_session_id: dodoId.nullable().optional(),
  metadata: z.record(z.string(), z.string()),
  total_amount: z.number().int().safe().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  service_periods: z
    .array(
      z.object({
        subscription_id: dodoId,
        starts_at: dodoDate,
        ends_at: dodoDate,
      }),
    )
    .max(20),
  refunds: z.array(z.object({ status: z.string() })).max(50),
  disputes: z.array(z.object({ dispute_status: z.string() })).max(50),
});
export class DodoRequestRejectedError extends BrainError {
  constructor() {
    super("UNAVAILABLE", "Secure checkout is temporarily unavailable.", 503);
  }
}
const unavailable = () =>
  new BrainError(
    "UNAVAILABLE",
    "Dodo Payments could not be verified. Try again later.",
    503,
  );

export class DodoClient {
  readonly mode: DodoMode;
  constructor(private readonly config: DodoConfig) {
    this.mode = z.enum(["sandbox", "live"]).parse(config.mode);
    dodoId.parse(config.business_id);
    dodoId.parse(config.monthly_product_ref);
    dodoId.parse(config.annual_product_ref);
    if (
      config.monthly_product_ref === config.annual_product_ref ||
      !config.api_key ||
      /\s/.test(config.api_key) ||
      config.api_key.length > 512 ||
      config.allowed_currencies.length < 1 ||
      config.allowed_currencies.length > 20 ||
      config.allowed_currencies.some((c) => !/^[A-Z]{3}$/.test(c))
    )
      throw unavailable();
  }
  productFor(cadence: "monthly" | "annual") {
    return cadence === "monthly"
      ? this.config.monthly_product_ref
      : this.config.annual_product_ref;
  }
  businessId() {
    return this.config.business_id;
  }
  allowsCurrency(currency: string) {
    return this.config.allowed_currencies.includes(currency);
  }
  private async call(method: "GET" | "POST", path: string, body?: unknown) {
    const base =
      this.mode === "sandbox"
        ? "https://test.dodopayments.com"
        : "https://live.dodopayments.com";
    const response = await this.config.transport.request({
      url: `${base}${path}`,
      method,
      headers: {
        Authorization: `Bearer ${this.config.api_key}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      timeout_ms: 3000,
      max_response_bytes: 1024 * 1024,
    });
    if (response.body.byteLength > 1024 * 1024) throw unavailable();
    // Rate limits, conflicts and server failures can be ambiguous: never automatically recreate.
    if ([400, 401, 403, 404, 405, 422].includes(response.status))
      throw new DodoRequestRejectedError();
    if (response.status < 200 || response.status >= 300) throw unavailable();
    try {
      return JSON.parse(Buffer.from(response.body).toString("utf8")) as unknown;
    } catch {
      throw unavailable();
    }
  }
  validateCheckoutUrl(value: string) {
    const url = new URL(value);
    const host =
      this.mode === "sandbox"
        ? "test.checkout.dodopayments.com"
        : "checkout.dodopayments.com";
    if (
      url.protocol !== "https:" ||
      url.host !== host ||
      url.username ||
      url.password ||
      url.hash ||
      !url.pathname.startsWith("/")
    )
      throw unavailable();
    return url.toString();
  }
  async checkout(input: {
    cadence: "monthly" | "annual";
    intent_ref: string;
    return_url: string;
  }) {
    z.string().uuid().parse(input.intent_ref);
    const result = z
      .object({ session_id: dodoId, checkout_url: z.string().url() })
      .parse(
        await this.call("POST", "/checkouts", {
          product_cart: [
            { product_id: this.productFor(input.cadence), quantity: 1 },
          ],
          metadata: { bibrain_intent: input.intent_ref },
          return_url: input.return_url,
          billing_currency: this.config.allowed_currencies[0],
          subscription_data: { trial_period_days: 0 },
          feature_flags: {
            allow_discount_code: false,
            allow_currency_selection: false,
          },
        }),
      );
    const checkoutUrl = this.validateCheckoutUrl(result.checkout_url);
    if (new URL(checkoutUrl).pathname !== `/session/${result.session_id}`)
      throw unavailable();
    return {
      session_id: result.session_id,
      checkout_url: checkoutUrl,
    };
  }
  async subscription(id: string) {
    return dodoSubscription.parse(
      await this.call("GET", `/subscriptions/${dodoId.parse(id)}`),
    );
  }
  async payment(id: string) {
    return dodoPayment.parse(
      await this.call("GET", `/payments/${dodoId.parse(id)}`),
    );
  }
  async payments(subscriptionId: string, since: string) {
    const result = z
      .object({ items: z.array(z.object({ payment_id: dodoId })).max(50) })
      .parse(
        await this.call(
          "GET",
          `/payments?subscription_id=${dodoId.parse(subscriptionId)}&status=succeeded&page_size=50&page_number=0&created_at_gte=${encodeURIComponent(dodoDate.parse(since))}`,
        ),
      );
    if (result.items.length >= 50) throw unavailable();
    return result.items;
  }
  async portal(customerId: string, returnUrl: string) {
    const result = z
      .object({ link: z.string().url() })
      .parse(
        await this.call(
          "POST",
          `/customers/${dodoId.parse(customerId)}/customer-portal/session?send_email=false&return_url=${encodeURIComponent(returnUrl)}`,
        ),
      );
    const url = new URL(result.link);
    const allowed =
      this.mode === "sandbox"
        ? "test.customer.dodopayments.com"
        : "customer.dodopayments.com";
    if (
      url.protocol !== "https:" ||
      url.host !== allowed ||
      url.username ||
      url.password ||
      url.hash
    )
      throw unavailable();
    return { url: url.toString() };
  }
}
