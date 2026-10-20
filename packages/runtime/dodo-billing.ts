import { resolve } from "node:path";
import { BrainError } from "../domain/logic.ts";
import {
  normalizeDodoEvent,
  verifyDodoWebhook,
} from "../domain/dodo-webhook.ts";
import {
  DodoClient,
  DodoRequestRejectedError,
  DODO_PLAN_FAMILY,
} from "../providers/dodo.ts";
import { DodoStore } from "../storage/dodo-store.ts";

export class DodoBillingService {
  readonly provider = "dodo" as const;
  readonly store: DodoStore;
  constructor(
    root: string,
    private readonly client: DodoClient,
    private readonly config: {
      public_origin: string;
      webhook_secret: string;
      webhook_endpoint_ref: string;
    },
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.store = new DodoStore(resolve(root, "dodo.sqlite"), clock);
  }
  close() {
    this.store.close();
  }
  status(accountId: string) {
    const binding = this.store.binding(accountId);
    const intent = this.store.accountIntent(accountId);
    const checkout = !binding ? this.store.checkoutFor(accountId) : null;
    const active = binding?.status === "active";
    const attention = !binding && Number(intent?.uncertain) === 1 && !checkout;
    const pending =
      binding?.status === "pending_verification" ||
      (!binding &&
        intent &&
        ["pending", "created", "bound"].includes(String(intent.state)));
    return {
      available: true as const,
      provider: this.provider,
      mode: this.client.mode,
      state: active
        ? ("active" as const)
        : attention || (binding && !pending)
          ? ("attention" as const)
          : pending
            ? ("confirming" as const)
            : ("not_started" as const),
      cadence: (binding?.cadence ?? intent?.cadence ?? null) as
        "monthly" | "annual" | null,
      subscription_status:
        typeof binding?.status === "string" ? binding.status : null,
      checkout_url: checkout,
      management_available: !!binding,
    };
  }
  async checkout(accountId: string, cadence: "monthly" | "annual") {
    if (this.store.binding(accountId))
      throw new BrainError(
        "CONFLICT",
        "Use Manage billing for this account.",
        409,
      );
    const product = this.client.productFor(cadence);
    const intent = this.store.createIntent({
      account_id: accountId,
      mode: this.client.mode,
      cadence,
      product_ref: DODO_PLAN_FAMILY,
      price_ref: product,
    });
    const attempt = this.store.beginProviderCreate({
      intent_id: intent.intent_id,
      expected_version: intent.version,
    });
    try {
      const result = await this.client.checkout({
        cadence,
        intent_ref: intent.intent_id,
        return_url: new URL(
          "/?billing_return=1",
          this.config.public_origin,
        ).toString(),
      });
      this.store.saveCheckout(
        intent.intent_id,
        Number(attempt.version),
        result.session_id,
        result.checkout_url,
      );
      // Payment IDs arrive later. Never confuse a checkout session with payment proof.
      return {
        checkout_url: result.checkout_url,
        status: "confirming" as const,
      };
    } catch (error) {
      if (error instanceof DodoRequestRejectedError)
        this.store.failIntent(intent.intent_id, Number(attempt.version));
      throw error;
    }
  }
  async portal(accountId: string) {
    const binding = this.store.binding(accountId);
    if (!binding)
      throw new BrainError(
        "UNAVAILABLE",
        "Billing management is not available yet.",
        503,
      );
    return this.client.portal(
      String(binding.customer_ref),
      this.config.public_origin,
    );
  }
  async webhook(
    rawBody: Uint8Array,
    headers: Record<string, string | string[] | undefined>,
  ) {
    const verified = verifyDodoWebhook({
      raw_body: rawBody,
      headers,
      secret: this.config.webhook_secret,
      now: this.clock(),
    });
    let body: unknown;
    try {
      body = JSON.parse(Buffer.from(rawBody).toString("utf8"));
    } catch {
      throw new BrainError(
        "INVALID_INPUT",
        "The Dodo webhook body is invalid.",
        400,
      );
    }
    const projection = normalizeDodoEvent(
      body,
      verified.id,
      this.client.businessId(),
    );
    if (!projection) return { accepted: true, ignored: true };
    // Refund/dispute payloads may only identify a payment. Resolve its bound
    // subscription through the closed API so renewal refunds also trigger an
    // immediate adverse refresh, rather than waiting for periodic polling.
    if (
      projection.event_type.startsWith("adjustment.") &&
      projection.transaction_ref &&
      !projection.subscription_ref
    ) {
      const payment = await this.client.payment(projection.transaction_ref);
      if (
        payment.payment_id !== projection.transaction_ref ||
        payment.business_id !== this.client.businessId()
      )
        throw new BrainError(
          "UNAVAILABLE",
          "The payment event could not be verified.",
          503,
        );
      projection.subscription_ref = payment.subscription_id;
      projection.customer_ref = payment.customer.customer_id;
    }
    const result = this.store.ingestEvent({
      mode: this.client.mode,
      endpoint_ref: this.config.webhook_endpoint_ref,
      body_digest: verified.digest,
      projection,
    });
    if (result.state === "conflict")
      throw new BrainError(
        "CONFLICT",
        "The payment event conflicts with an earlier delivery.",
        400,
      );
    return { accepted: true, duplicate: result.state === "duplicate" };
  }
}
