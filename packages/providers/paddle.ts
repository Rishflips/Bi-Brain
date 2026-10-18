import { z } from "zod";
import { BrainError } from "../domain/logic.ts";

/** Closed Paddle Billing API adapter. No generic URL or method is exposed. */

export type PaddleMode = "sandbox" | "live";

export interface PaddleTransport {
  request(input: {
    url: string;
    method: "GET" | "POST";
    headers: Record<string, string>;
    body?: string;
    timeout_ms: number;
    max_response_bytes: number;
  }): Promise<{ status: number; body: Uint8Array }>;
}

export interface PaddleClientConfig {
  mode: PaddleMode;
  api_key: string;
  product_ref: string;
  monthly_price_ref: string;
  annual_price_ref: string;
  allowed_currencies: readonly string[];
  transport: PaddleTransport;
}

/** A provider response that proves the create request was rejected. */
export class PaddleRequestRejectedError extends BrainError {
  constructor() {
    super("UNAVAILABLE", "Paddle Billing is temporarily unavailable.", 503);
  }
}

/** Paddle created the transaction, but its checkout link failed validation. */
export class PaddleCreatedButUnusableError extends BrainError {
  constructor(readonly transaction_ref: string) {
    super(
      "UNAVAILABLE",
      "Paddle Billing returned an unusable checkout link.",
      503,
    );
  }
}

const ID = /^[a-z]+_[a-z0-9]{26}$/;
const TOKEN = /^[A-Za-z0-9._:-]{1,200}$/;
const MAX_RESPONSE = 1024 * 1024;
const TIMEOUT_MS = 3000;
const DEFINITIVE_CREATE_REJECTIONS = new Set([
  400, 401, 403, 404, 405, 409, 422, 429,
]);

const unavailable = (message: string) =>
  new BrainError("UNAVAILABLE", message, 503);
const invalid = (message: string) =>
  new BrainError("INVALID_INPUT", message, 400);

const transactionResponse = z
  .object({
    data: z.object({
      id: z.string().regex(/^txn_[a-z0-9]{26}$/),
      status: z.enum([
        "draft",
        "ready",
        "paid",
        "completed",
        "past_due",
        "canceled",
      ]),
      checkout: z
        .object({ url: z.string().url().nullable() })
        .nullable()
        .optional(),
    }),
  })
  .passthrough();

const subscriptionResponse = z
  .object({
    data: z.object({
      id: z.string().regex(/^sub_[a-z0-9]{26}$/),
      customer_id: z.string().regex(/^ctm_[a-z0-9]{26}$/),
      status: z.enum(["active", "trialing", "past_due", "paused", "canceled"]),
      current_billing_period: z
        .object({
          starts_at: z.string().datetime({ offset: true }),
          ends_at: z.string().datetime({ offset: true }),
        })
        .nullable(),
    }),
  })
  .passthrough();

const portalResponse = z
  .object({
    data: z.object({
      urls: z.object({ general: z.object({ overview: z.string().url() }) }),
    }),
  })
  .passthrough();

const period = z.object({
  starts_at: z.string().datetime({ offset: true }),
  ends_at: z.string().datetime({ offset: true }),
});
const evidenceItem = z.object({
  quantity: z.number().int().positive(),
  price: z.object({
    id: z.string().regex(/^pri_[a-z0-9]{26}$/),
    product_id: z.string().regex(/^pro_[a-z0-9]{26}$/),
    billing_cycle: z
      .object({
        interval: z.enum(["month", "year"]),
        frequency: z.number().int().positive(),
      })
      .nullable(),
  }),
});
const evidenceTransaction = z.object({
  id: z.string().regex(/^txn_[a-z0-9]{26}$/),
  status: z.enum([
    "draft",
    "ready",
    "paid",
    "completed",
    "past_due",
    "canceled",
  ]),
  customer_id: z
    .string()
    .regex(/^ctm_[a-z0-9]{26}$/)
    .nullable(),
  subscription_id: z
    .string()
    .regex(/^sub_[a-z0-9]{26}$/)
    .nullable(),
  billing_period: period.nullable(),
  currency_code: z.string().regex(/^[A-Z]{3}$/),
  items: z.array(evidenceItem).max(20),
  details: z.object({ totals: z.object({ total: z.string().regex(/^\d+$/) }) }),
});
const transactionListResponse = z.object({
  data: z.array(evidenceTransaction).max(50),
  meta: z.object({ pagination: z.object({ has_more: z.boolean() }) }),
});
const adjustmentListResponse = z.object({
  data: z
    .array(
      z.object({
        id: z.string().regex(/^adj_[a-z0-9]{26}$/),
        action: z.enum([
          "refund",
          "credit",
          "chargeback",
          "chargeback_warning",
          "chargeback_reverse",
          "chargeback_warning_reverse",
          "credit_reverse",
        ]),
        status: z.enum([
          "pending_approval",
          "approved",
          "rejected",
          "reversed",
        ]),
        transaction_id: z.string().regex(/^txn_[a-z0-9]{26}$/),
      }),
    )
    .max(50),
  meta: z.object({ pagination: z.object({ has_more: z.boolean() }) }),
});
const evidenceSubscriptionResponse = z.object({
  data: z.object({
    id: z.string().regex(/^sub_[a-z0-9]{26}$/),
    customer_id: z.string().regex(/^ctm_[a-z0-9]{26}$/),
    status: z.enum(["active", "trialing", "past_due", "paused", "canceled"]),
    current_billing_period: period.nullable(),
    items: z.array(evidenceItem).max(20),
  }),
});

function exactId(value: string, prefix: string): string {
  if (!ID.test(value) || !value.startsWith(`${prefix}_`))
    throw invalid(`The Paddle ${prefix} reference is invalid.`);
  return value;
}

export class PaddleClient {
  readonly mode: PaddleMode;
  private readonly base: string;
  private readonly config: PaddleClientConfig;
  private readonly allowedCurrencies: ReadonlySet<string>;

  constructor(config: PaddleClientConfig) {
    if (config.mode !== "sandbox" && config.mode !== "live")
      throw invalid("The Paddle mode is invalid.");
    const currentKey =
      /^pdl_(live|sdbx)_apikey_[a-z0-9]{26}_[A-Za-z0-9]{22}_[A-Za-z0-9]{3}$/.exec(
        config.api_key,
      );
    const legacyKey = /^apikey_[a-z0-9]{26}$/.test(config.api_key);
    if (
      (!currentKey && !legacyKey) ||
      (currentKey &&
        currentKey[1] !== (config.mode === "live" ? "live" : "sdbx"))
    )
      throw invalid("The Paddle API key is invalid.");
    exactId(config.product_ref, "pro");
    exactId(config.monthly_price_ref, "pri");
    exactId(config.annual_price_ref, "pri");
    if (config.monthly_price_ref === config.annual_price_ref)
      throw invalid("The Paddle cadence prices must be distinct.");
    if (
      !Array.isArray(config.allowed_currencies) ||
      config.allowed_currencies.length < 1 ||
      config.allowed_currencies.length > 20 ||
      config.allowed_currencies.some(
        (currency) =>
          typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency),
      ) ||
      new Set(config.allowed_currencies).size !==
        config.allowed_currencies.length
    )
      throw invalid("The Paddle charged-currency allowlist is invalid.");
    if (!config.transport || typeof config.transport.request !== "function")
      throw invalid("The Paddle transport is unavailable.");
    this.mode = config.mode;
    this.base =
      config.mode === "sandbox"
        ? "https://sandbox-api.paddle.com"
        : "https://api.paddle.com";
    this.config = { ...config };
    this.allowedCurrencies = new Set(config.allowed_currencies);
  }

  priceFor(cadence: "monthly" | "annual"): string {
    return cadence === "monthly"
      ? this.config.monthly_price_ref
      : this.config.annual_price_ref;
  }

  productRef(): string {
    return this.config.product_ref;
  }

  allowsCurrency(currency: string): boolean {
    return this.allowedCurrencies.has(currency);
  }

  private async call(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    if (!path.startsWith("/") || path.includes("..") || path.includes("//"))
      throw invalid("The Paddle API path is invalid.");
    const response = await this.config.transport.request({
      url: `${this.base}${path}`,
      method,
      headers: {
        Authorization: `Bearer ${this.config.api_key}`,
        "Content-Type": "application/json",
        "Paddle-Version": "1",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      timeout_ms: TIMEOUT_MS,
      max_response_bytes: MAX_RESPONSE,
    });
    if (response.body.byteLength > MAX_RESPONSE)
      throw unavailable("The Paddle response exceeded its byte limit.");
    if (DEFINITIVE_CREATE_REJECTIONS.has(response.status))
      throw new PaddleRequestRejectedError();
    if (response.status < 200 || response.status >= 300)
      throw unavailable("Paddle Billing is temporarily unavailable.");
    try {
      return JSON.parse(Buffer.from(response.body).toString("utf8"));
    } catch {
      throw unavailable("Paddle Billing returned an unreadable response.");
    }
  }

  async createCheckoutTransaction(input: {
    cadence: "monthly" | "annual";
    intent_ref: string;
    checkout_url: string;
  }): Promise<{
    transaction_ref: string;
    checkout_url: string;
    status: "draft" | "ready" | "paid" | "completed" | "past_due" | "canceled";
  }> {
    if (!TOKEN.test(input.intent_ref))
      throw invalid("The checkout intent reference is invalid.");
    let checkout: URL;
    try {
      checkout = new URL(input.checkout_url);
    } catch {
      throw invalid("The Paddle checkout URL is invalid.");
    }
    if (
      checkout.protocol !== "https:" ||
      checkout.username ||
      checkout.password ||
      checkout.search ||
      checkout.hash
    )
      throw invalid("The Paddle checkout URL is invalid.");
    let parsed: z.infer<typeof transactionResponse>;
    try {
      parsed = transactionResponse.parse(
        await this.call("POST", "/transactions", {
          items: [{ price_id: this.priceFor(input.cadence), quantity: 1 }],
          collection_mode: "automatic",
          checkout: { url: checkout.toString() },
          custom_data: { bibrain_intent: input.intent_ref },
        }),
      );
    } catch (error) {
      if (error instanceof BrainError) throw error;
      throw unavailable("Paddle Billing returned an unexpected transaction.");
    }
    const returned = new URL(parsed.data.checkout?.url ?? "", checkout);
    if (
      returned.origin !== checkout.origin ||
      returned.pathname !== checkout.pathname ||
      returned.username ||
      returned.password ||
      returned.hash ||
      returned.searchParams.get("_ptxn") !== parsed.data.id
    )
      throw new PaddleCreatedButUnusableError(parsed.data.id);
    return {
      transaction_ref: parsed.data.id,
      checkout_url: returned.toString(),
      status: parsed.data.status,
    };
  }

  async readSubscription(subscriptionRef: string) {
    const id = exactId(subscriptionRef, "sub");
    let parsed: z.infer<typeof subscriptionResponse>;
    try {
      parsed = subscriptionResponse.parse(
        await this.call("GET", `/subscriptions/${id}`),
      );
    } catch (error) {
      if (error instanceof BrainError) throw error;
      throw unavailable("Paddle Billing returned an unexpected subscription.");
    }
    return {
      subscription_ref: parsed.data.id,
      customer_ref: parsed.data.customer_id,
      status: parsed.data.status,
      current_billing_period: parsed.data.current_billing_period,
    };
  }

  async readTransaction(transactionRef: string): Promise<unknown> {
    return this.call("GET", `/transactions/${exactId(transactionRef, "txn")}`);
  }

  async listAdjustments(transactionRef: string): Promise<unknown> {
    const id = exactId(transactionRef, "txn");
    return this.call(
      "GET",
      `/adjustments?transaction_id=${encodeURIComponent(id)}&per_page=50`,
    );
  }

  async readEvidenceSubscription(subscriptionRef: string) {
    const id = exactId(subscriptionRef, "sub");
    try {
      return evidenceSubscriptionResponse.parse(
        await this.call("GET", `/subscriptions/${id}`),
      ).data;
    } catch (error) {
      if (error instanceof BrainError) throw error;
      throw unavailable(
        "Paddle Billing returned incomplete subscription evidence.",
      );
    }
  }

  async listCompletedTransactions(subscriptionRef: string) {
    const id = exactId(subscriptionRef, "sub");
    try {
      const parsed = transactionListResponse.parse(
        await this.call(
          "GET",
          `/transactions?subscription_id=${encodeURIComponent(id)}&status=completed&per_page=50`,
        ),
      );
      if (parsed.meta.pagination.has_more)
        throw unavailable(
          "Paddle transaction history exceeds the verification bound.",
        );
      return parsed.data;
    } catch (error) {
      if (error instanceof BrainError) throw error;
      throw unavailable(
        "Paddle Billing returned incomplete transaction evidence.",
      );
    }
  }

  async readEvidenceAdjustments(transactionRef: string) {
    const id = exactId(transactionRef, "txn");
    try {
      const parsed = adjustmentListResponse.parse(
        await this.call(
          "GET",
          `/adjustments?transaction_id=${encodeURIComponent(id)}&per_page=50`,
        ),
      );
      if (parsed.meta.pagination.has_more)
        throw unavailable(
          "Paddle adjustment history exceeds the verification bound.",
        );
      return parsed.data;
    } catch (error) {
      if (error instanceof BrainError) throw error;
      throw unavailable(
        "Paddle Billing returned incomplete adjustment evidence.",
      );
    }
  }

  async createPortalSession(input: {
    customer_ref: string;
    subscription_ref: string;
    allowed_origin: string;
  }): Promise<{ url: string }> {
    const customer = exactId(input.customer_ref, "ctm");
    const subscription = exactId(input.subscription_ref, "sub");
    let parsed: z.infer<typeof portalResponse>;
    try {
      parsed = portalResponse.parse(
        await this.call("POST", `/customers/${customer}/portal-sessions`, {
          subscription_ids: [subscription],
        }),
      );
    } catch (error) {
      if (error instanceof BrainError) throw error;
      throw unavailable(
        "Paddle Billing returned an unexpected portal session.",
      );
    }
    const url = new URL(parsed.data.urls.general.overview);
    const allowed = new URL(input.allowed_origin);
    if (
      allowed.protocol !== "https:" ||
      url.origin !== allowed.origin ||
      !url.pathname.startsWith("/cpl_") ||
      url.username ||
      url.password ||
      url.hash
    )
      throw unavailable(
        "Paddle returned a portal URL outside the configured origin.",
      );
    return { url: url.toString() };
  }
}
