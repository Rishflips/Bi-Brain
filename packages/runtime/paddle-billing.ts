import { resolve } from "node:path";
import { BrainError } from "../domain/logic.ts";
import { normalizePaddleEvent } from "../domain/paddle-event.ts";
import { verifyPaddleWebhook } from "../domain/paddle-signature.ts";
import {
  PaddleClient,
  PaddleCreatedButUnusableError,
  PaddleRequestRejectedError,
  type PaddleMode,
} from "../providers/paddle.ts";
import { PaddleStore } from "../storage/paddle-store.ts";

export interface PaddleBillingConfig {
  mode: PaddleMode;
  public_origin: string;
  checkout_path: string;
  client_token: string;
  webhook_secret: Uint8Array;
  webhook_endpoint_ref: string;
  portal_origin: string;
}

export type PaddleBillingStatus = {
  available: true;
  mode: PaddleMode;
  client_token: string;
  state: "not_started" | "confirming" | "active" | "attention";
  cadence: "monthly" | "annual" | null;
  subscription_status: string | null;
  transaction_ref: string | null;
  management_available: boolean;
};

const unavailable = (message: string) =>
  new BrainError("UNAVAILABLE", message, 503);

/**
 * Account-bound orchestration for customer-initiated billing actions and the
 * signed webhook inbox. It deliberately has no entitlement/grant method: B0
 * remains the only authority and requires independent current provider reads.
 */
export class PaddleBillingService {
  readonly store: PaddleStore;

  constructor(
    root: string,
    private readonly client: PaddleClient,
    private readonly config: PaddleBillingConfig,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.store = new PaddleStore(resolve(root, "paddle.sqlite"), clock);
  }

  close(): void {
    this.store.close();
  }

  status(accountId: string): PaddleBillingStatus {
    const binding = this.store.binding(accountId);
    const intent = this.store.accountIntent(accountId);
    const bindingStatus = binding?.status;
    const active = bindingStatus === "active";
    const uncertain = !binding && Number(intent?.uncertain) === 1;
    const attention =
      uncertain ||
      (!!binding &&
        !["active", "pending_verification"].includes(String(bindingStatus)));
    const confirming =
      bindingStatus === "pending_verification" ||
      (!binding &&
        !!intent &&
        ["pending", "created", "bound"].includes(String(intent.state)));
    return {
      available: true,
      mode: this.config.mode,
      client_token: this.config.client_token,
      state: active
        ? "active"
        : attention
          ? "attention"
          : confirming
            ? "confirming"
            : "not_started",
      cadence:
        binding?.cadence === "monthly" || binding?.cadence === "annual"
          ? binding.cadence
          : intent?.cadence === "monthly" || intent?.cadence === "annual"
            ? intent.cadence
            : null,
      subscription_status:
        typeof bindingStatus === "string" ? bindingStatus : null,
      transaction_ref:
        intent?.state === "created" &&
        typeof intent.transaction_ref === "string"
          ? intent.transaction_ref
          : null,
      management_available: !!binding,
    };
  }

  async checkout(accountId: string, cadence: "monthly" | "annual") {
    if (this.store.binding(accountId))
      throw new BrainError(
        "CONFLICT",
        "This account already has a billing connection. Use Manage billing instead.",
        409,
      );
    const intent = this.store.createIntent({
      account_id: accountId,
      mode: this.config.mode,
      cadence,
      product_ref: this.client.productRef(),
      price_ref: this.client.priceFor(cadence),
    });
    const attempt = this.store.beginProviderCreate({
      intent_id: intent.intent_id,
      expected_version: intent.version,
    });
    try {
      const created = await this.client.createCheckoutTransaction({
        cadence,
        intent_ref: intent.intent_id,
        checkout_url: new URL(
          this.config.checkout_path,
          this.config.public_origin,
        ).toString(),
      });
      this.store.attachTransaction({
        intent_id: intent.intent_id,
        expected_version: Number(attempt.version),
        transaction_ref: created.transaction_ref,
      });
      return {
        transaction_ref: created.transaction_ref,
        checkout_url: created.checkout_url,
        status: "confirming" as const,
      };
    } catch (error) {
      if (error instanceof PaddleCreatedButUnusableError) {
        this.store.attachTransaction({
          intent_id: intent.intent_id,
          expected_version: Number(attempt.version),
          transaction_ref: error.transaction_ref,
        });
      } else if (
        error instanceof PaddleRequestRejectedError ||
        (error instanceof BrainError && error.code === "INVALID_INPUT")
      ) {
        this.store.failIntent(intent.intent_id, Number(attempt.version));
      }
      throw error;
    }
  }

  async portal(accountId: string) {
    const binding = this.store.binding(accountId);
    if (!binding)
      throw unavailable(
        "Billing management is not available for this account yet.",
      );
    return this.client.createPortalSession({
      customer_ref: String(binding.customer_ref),
      subscription_ref: String(binding.subscription_ref),
      allowed_origin: this.config.portal_origin,
    });
  }

  webhook(rawBody: Uint8Array, signatureHeader: string) {
    const verified = verifyPaddleWebhook({
      raw_body: rawBody,
      signature_header: signatureHeader,
      secret: this.config.webhook_secret,
      now: this.clock(),
    });
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(verified.raw_body).toString("utf8"));
    } catch {
      throw new BrainError(
        "INVALID_INPUT",
        "The Paddle webhook body is not valid JSON.",
        400,
      );
    }
    const projection = normalizePaddleEvent(decoded);
    const result = this.store.ingestEvent({
      mode: this.config.mode,
      endpoint_ref: this.config.webhook_endpoint_ref,
      body_digest: verified.body_sha256,
      projection,
    });
    if (result.state === "conflict")
      throw new BrainError(
        "CONFLICT",
        "The Paddle event conflicts with an earlier delivery.",
        400,
      );
    return { accepted: true, duplicate: result.state === "duplicate" };
  }
}
