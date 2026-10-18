import { describe, expect, it } from "vitest";
import type { ServerOwnedBinding } from "../../packages/domain/billing-evidence.ts";
import {
  PaddleClient,
  type PaddleTransport,
} from "../../packages/providers/paddle.ts";
import { PaddleEvidenceSource } from "../../packages/providers/paddle-evidence.ts";

const ids = {
  product: "pro_01h00000000000000000000000",
  price: "pri_01h00000000000000000000000",
  annual: "pri_01h11111111111111111111111",
  transaction: "txn_01h00000000000000000000000",
  subscription: "sub_01h00000000000000000000000",
  customer: "ctm_01h00000000000000000000000",
};
const period = {
  starts_at: "2026-10-01T00:00:00.000Z",
  ends_at: "2026-11-01T00:00:00.000Z",
};
const item = {
  quantity: 1,
  price: {
    id: ids.price,
    product_id: ids.product,
    billing_cycle: { interval: "month", frequency: 1 },
  },
};
const binding: ServerOwnedBinding = {
  schema: 1,
  account_id: "00000000-0000-4000-8000-000000000001",
  identity_digest: "a".repeat(64),
  tenant_incarnation: "b".repeat(64),
  provisioning_generation: 1,
  mode: "sandbox",
  product_ref: ids.product,
  price_ref: ids.price,
  cadence: "monthly",
  customer_ref: ids.customer,
  subscription_ref: ids.subscription,
  initial_transaction_ref: ids.transaction,
  correlation_ref: "correlation_1",
  version: 1,
};

function source(
  adjustments: unknown[] = [],
  subscription: { status?: string; currentPeriod?: typeof period | null } = {},
  currency = "USD",
) {
  const transport: PaddleTransport = {
    async request(request) {
      if (request.url.includes("/subscriptions/"))
        return {
          status: 200,
          body: Buffer.from(
            JSON.stringify({
              data: {
                id: ids.subscription,
                customer_id: ids.customer,
                status: subscription.status ?? "active",
                current_billing_period:
                  subscription.currentPeriod === undefined
                    ? period
                    : subscription.currentPeriod,
                items: [item],
              },
            }),
          ),
        };
      if (request.url.includes("/transactions?"))
        return {
          status: 200,
          body: Buffer.from(
            JSON.stringify({
              data: [
                {
                  id: ids.transaction,
                  status: "completed",
                  customer_id: ids.customer,
                  subscription_id: ids.subscription,
                  billing_period: period,
                  currency_code: currency,
                  items: [item],
                  details: { totals: { total: "1000" } },
                },
              ],
              meta: { pagination: { has_more: false } },
            }),
          ),
        };
      return {
        status: 200,
        body: Buffer.from(
          JSON.stringify({
            data: adjustments,
            meta: { pagination: { has_more: false } },
          }),
        ),
      };
    },
  };
  const client = new PaddleClient({
    mode: "sandbox",
    api_key: "apikey_01h00000000000000000000000",
    product_ref: ids.product,
    monthly_price_ref: ids.price,
    annual_price_ref: ids.annual,
    allowed_currencies: ["USD"],
    transport,
  });
  return new PaddleEvidenceSource(
    client,
    () => new Date("2026-10-18T10:00:00.000Z"),
  );
}

describe("current Paddle evidence", () => {
  it("requires one current completed transaction with the configured quantity-one plan", async () => {
    await expect(source().read(binding)).resolves.toEqual({
      transaction_ref: ids.transaction,
      subscription_ref: ids.subscription,
      customer_ref: ids.customer,
      product_ref: ids.product,
      price_ref: ids.price,
      cadence: "monthly",
      completed_payment: true,
      current_state: "active",
      paid_period_start: period.starts_at,
      paid_period_end: period.ends_at,
      verified_at: "2026-10-18T10:00:00.000Z",
    });
  });

  it("turns an approved refund into adverse evidence", async () => {
    await expect(
      source([
        {
          id: "adj_01h00000000000000000000000",
          action: "refund",
          status: "approved",
          transaction_id: ids.transaction,
        },
      ]).read(binding),
    ).resolves.toMatchObject({ current_state: "refunded" });
  });

  it("accepts provider reversal records but keeps the allowance paused", async () => {
    await expect(
      source([
        {
          id: "adj_01h00000000000000000000000",
          action: "chargeback_warning",
          status: "reversed",
          transaction_id: ids.transaction,
        },
        {
          id: "adj_01h11111111111111111111111",
          action: "chargeback_warning_reverse",
          status: "approved",
          transaction_id: ids.transaction,
        },
      ]).read(binding),
    ).resolves.toMatchObject({ current_state: "unknown" });
  });

  it("uses the latest completed paid period when a canceled subscription has no current period", async () => {
    await expect(
      source([], { status: "canceled", currentPeriod: null }).read(binding),
    ).resolves.toMatchObject({
      current_state: "canceled",
      paid_period_start: period.starts_at,
      paid_period_end: period.ends_at,
    });
  });

  it("rejects a completed payment outside the operator currency allowlist", async () => {
    await expect(source([], {}, "GBP").read(binding)).rejects.toThrow(
      /ambiguous or missing/,
    );
  });
});
