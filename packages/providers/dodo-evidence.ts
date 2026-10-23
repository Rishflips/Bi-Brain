import type {
  EvidenceSource,
  ProviderFacts,
  ServerOwnedBinding,
} from "../domain/billing-evidence.ts";
import { BrainError } from "../domain/logic.ts";
import { DodoClient, DODO_PLAN_FAMILY } from "./dodo.ts";

const unavailable = () =>
  new BrainError(
    "UNAVAILABLE",
    "The current paid Dodo subscription could not be verified.",
    503,
  );
/** Current API facts, never webhook-derived allowance. Explicit service periods only. */
export class DodoEvidenceSource implements EvidenceSource {
  constructor(
    private readonly client: DodoClient,
    private readonly clock: () => Date = () => new Date(),
  ) {}
  async read(binding: ServerOwnedBinding): Promise<ProviderFacts> {
    if (binding.mode !== this.client.mode) throw unavailable();
    const subscription = await this.client.subscription(
      binding.subscription_ref,
    );
    if (
      subscription.subscription_id !== binding.subscription_ref ||
      subscription.customer.customer_id !== binding.customer_ref ||
      binding.product_ref !== DODO_PLAN_FAMILY ||
      binding.price_ref !== subscription.product_id ||
      subscription.product_id !== this.client.productFor(binding.cadence) ||
      subscription.quantity !== 1 ||
      subscription.on_demand ||
      subscription.addons.length ||
      subscription.meters.length ||
      subscription.payment_frequency_count !== 1 ||
      subscription.payment_frequency_interval !==
        (binding.cadence === "monthly" ? "Month" : "Year")
    )
      throw unavailable();
    // Confirm the original payment really belongs to our server-created checkout intent.
    const initial = await this.client.payment(binding.initial_transaction_ref);
    if (
      initial.payment_id !== binding.initial_transaction_ref ||
      initial.business_id !== this.client.businessId() ||
      initial.subscription_id !== binding.subscription_ref ||
      initial.customer.customer_id !== binding.customer_ref ||
      initial.metadata.bibrain_intent !== binding.correlation_ref
    )
      throw unavailable();
    const listed = await this.client.payments(
      binding.subscription_ref,
      new Date(
        new Date(subscription.previous_billing_date).getTime() - 7 * 86400_000,
      ).toISOString(),
    );
    // Bound total provider work; a large history is an explicit operator gate.
    if (listed.length > 12) throw unavailable();
    const candidates = [];
    for (const entry of listed) {
      const payment =
        entry.payment_id === initial.payment_id
          ? initial
          : await this.client.payment(entry.payment_id);
      const periods = payment.service_periods;
      if (
        payment.payment_id !== entry.payment_id ||
        payment.business_id !== this.client.businessId() ||
        payment.customer.customer_id !== binding.customer_ref ||
        payment.subscription_id !== binding.subscription_ref ||
        payment.status !== "succeeded" ||
        !this.client.allowsCurrency(payment.currency) ||
        payment.total_amount <= 0 ||
        periods.length !== 1 ||
        periods[0]!.subscription_id !== binding.subscription_ref
      )
        continue;
      const period = periods[0]!;
      if (
        new Date(period.starts_at).getTime() !==
          new Date(subscription.previous_billing_date).getTime() ||
        new Date(period.ends_at).getTime() !==
          new Date(subscription.next_billing_date).getTime()
      )
        continue;
      candidates.push(payment);
    }
    if (candidates.length !== 1) throw unavailable();
    const payment = candidates[0]!;
    const adverse =
      payment.refunds.some((r) => r.status !== "failed") ||
      payment.disputes.some((d) => d.dispute_status !== "dispute_won");
    const state = adverse
      ? "refunded"
      : subscription.status === "active"
        ? "active"
        : subscription.status === "cancelled" ||
            subscription.status === "expired"
          ? "canceled"
          : subscription.status === "on_hold"
            ? "past_due"
            : "unknown";
    return {
      transaction_ref: payment.payment_id,
      subscription_ref: binding.subscription_ref,
      customer_ref: binding.customer_ref,
      product_ref: binding.product_ref,
      price_ref: binding.price_ref,
      cadence: binding.cadence,
      completed_payment: true,
      current_state: state,
      paid_period_start: new Date(
        payment.service_periods[0]!.starts_at,
      ).toISOString(),
      paid_period_end: new Date(
        payment.service_periods[0]!.ends_at,
      ).toISOString(),
      verified_at: this.clock().toISOString(),
    };
  }
}
