import { BrainError } from "../domain/logic.ts";
import type {
  EvidenceSource,
  ProviderFacts,
  ServerOwnedBinding,
} from "../domain/billing-evidence.ts";
import { PaddleClient } from "./paddle.ts";

const unavailable = (message: string) =>
  new BrainError("UNAVAILABLE", message, 503);

/** Current, bounded Paddle reads used by B0. Webhook payloads never enter here. */
export class PaddleEvidenceSource implements EvidenceSource {
  constructor(
    private readonly client: PaddleClient,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async read(binding: ServerOwnedBinding): Promise<ProviderFacts> {
    if (binding.mode !== this.client.mode)
      throw unavailable(
        "The billing binding belongs to another Paddle environment.",
      );
    const subscription = await this.client.readEvidenceSubscription(
      binding.subscription_ref,
    );
    const item = subscription.items[0];
    const cadence = item?.price.billing_cycle?.interval;
    const subscriptionMatches =
      subscription.items.length === 1 &&
      item?.quantity === 1 &&
      item.price.id === binding.price_ref &&
      item.price.product_id === binding.product_ref &&
      item.price.billing_cycle?.frequency === 1 &&
      cadence === (binding.cadence === "monthly" ? "month" : "year") &&
      subscription.customer_id === binding.customer_ref;
    if (!subscriptionMatches)
      throw unavailable(
        "The Paddle subscription no longer matches the enrolled plan.",
      );

    const transactions = await this.client.listCompletedTransactions(
      binding.subscription_ref,
    );
    const matching = transactions.filter((transaction) => {
      const line = transaction.items[0];
      return (
        transaction.status === "completed" &&
        transaction.subscription_id === binding.subscription_ref &&
        transaction.customer_id === binding.customer_ref &&
        transaction.items.length === 1 &&
        this.client.allowsCurrency(transaction.currency_code) &&
        line?.quantity === 1 &&
        line.price.id === binding.price_ref &&
        line.price.product_id === binding.product_ref &&
        transaction.billing_period !== null &&
        BigInt(transaction.details.totals.total) > 0n
      );
    });
    const currentPeriod = subscription.current_billing_period;
    const eligible = currentPeriod
      ? matching.filter(
          (transaction) =>
            transaction.billing_period?.starts_at === currentPeriod.starts_at &&
            transaction.billing_period?.ends_at === currentPeriod.ends_at,
        )
      : matching.sort((left, right) =>
          right.billing_period!.ends_at.localeCompare(
            left.billing_period!.ends_at,
          ),
        );
    if (
      eligible.length < 1 ||
      (currentPeriod !== null && eligible.length !== 1)
    )
      throw unavailable(
        "The current paid Paddle transaction is ambiguous or missing.",
      );
    const transaction = eligible[0]!;
    const paidPeriod = transaction.billing_period!;
    const adjustments = await this.client.readEvidenceAdjustments(
      transaction.id,
    );
    const pendingAdjustment = adjustments.some((item) =>
      ["pending_approval", "approved"].includes(item.status),
    );
    const approvedAdverse = adjustments.some(
      (item) =>
        item.status === "approved" &&
        ["refund", "chargeback", "chargeback_warning"].includes(item.action),
    );
    const state = approvedAdverse
      ? "refunded"
      : pendingAdjustment
        ? "unknown"
        : subscription.status === "trialing"
          ? "unknown"
          : subscription.status;
    return {
      transaction_ref: transaction.id,
      subscription_ref: subscription.id,
      customer_ref: subscription.customer_id,
      product_ref: binding.product_ref,
      price_ref: binding.price_ref,
      cadence: binding.cadence,
      completed_payment: transaction.status === "completed",
      current_state: state,
      paid_period_start: new Date(paidPeriod.starts_at).toISOString(),
      paid_period_end: new Date(paidPeriod.ends_at).toISOString(),
      verified_at: this.clock().toISOString(),
    };
  }
}
