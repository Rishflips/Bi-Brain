import { describe, expect, it } from "vitest";
import {
  PaddleClient,
  PaddleRequestRejectedError,
  type PaddleTransport,
} from "../../packages/providers/paddle.ts";

const ids = {
  product: "pro_01h00000000000000000000000",
  monthly: "pri_01h00000000000000000000000",
  annual: "pri_01h11111111111111111111111",
  transaction: "txn_01h00000000000000000000000",
  subscription: "sub_01h00000000000000000000000",
  customer: "ctm_01h00000000000000000000000",
};

function client(handler: PaddleTransport["request"]) {
  return new PaddleClient({
    mode: "sandbox",
    api_key: "apikey_01h00000000000000000000000",
    product_ref: ids.product,
    monthly_price_ref: ids.monthly,
    annual_price_ref: ids.annual,
    allowed_currencies: ["USD", "EUR"],
    transport: { request: handler },
  });
}

describe("closed Paddle provider adapter", () => {
  it("creates only an automatic quantity-one configured-price transaction", async () => {
    let request: Parameters<PaddleTransport["request"]>[0] | undefined;
    const paddle = client(async (input) => {
      request = input;
      return {
        status: 201,
        body: Buffer.from(
          JSON.stringify({
            data: {
              id: ids.transaction,
              status: "draft",
              checkout: {
                url: `https://brain.example.test/?_ptxn=${ids.transaction}`,
              },
            },
          }),
        ),
      };
    });
    await expect(
      paddle.createCheckoutTransaction({
        cadence: "annual",
        intent_ref: "intent_123",
        checkout_url: "https://brain.example.test/",
      }),
    ).resolves.toEqual({
      transaction_ref: ids.transaction,
      checkout_url: `https://brain.example.test/?_ptxn=${ids.transaction}`,
      status: "draft",
    });
    expect(request?.url).toBe("https://sandbox-api.paddle.com/transactions");
    expect(JSON.parse(request?.body ?? "{}")).toEqual({
      items: [{ price_id: ids.annual, quantity: 1 }],
      collection_mode: "automatic",
      checkout: { url: "https://brain.example.test/" },
      custom_data: { bibrain_intent: "intent_123" },
    });
    expect(request?.headers["Paddle-Version"]).toBe("1");
  });

  it("allows only the configured portal origin and /cpl_ path", async () => {
    const ok = client(async () => ({
      status: 201,
      body: Buffer.from(
        JSON.stringify({
          data: {
            urls: {
              general: {
                overview: "https://sandbox-portal.example/cpl_123?token=secret",
              },
            },
          },
        }),
      ),
    }));
    await expect(
      ok.createPortalSession({
        customer_ref: ids.customer,
        subscription_ref: ids.subscription,
        allowed_origin: "https://sandbox-portal.example",
      }),
    ).resolves.toMatchObject({ url: expect.stringContaining("/cpl_123") });

    await expect(
      ok.createPortalSession({
        customer_ref: ids.customer,
        subscription_ref: ids.subscription,
        allowed_origin: "https://customer-portal.paddle.com",
      }),
    ).rejects.toThrow();

    const fragment = client(async () => ({
      status: 201,
      body: Buffer.from(
        JSON.stringify({
          data: {
            urls: {
              general: {
                overview: "https://sandbox-portal.example/cpl_123#unexpected",
              },
            },
          },
        }),
      ),
    }));
    await expect(
      fragment.createPortalSession({
        customer_ref: ids.customer,
        subscription_ref: ids.subscription,
        allowed_origin: "https://sandbox-portal.example",
      }),
    ).rejects.toThrow();
  });

  it("rejects an unconfigured id, non-2xx response, or oversized response", async () => {
    const denied = client(async () => ({
      status: 500,
      body: Buffer.from("{}"),
    }));
    await expect(denied.readTransaction(ids.transaction)).rejects.toThrow();
    await expect(denied.readTransaction("txn_wrong")).rejects.toThrow();
    const oversized = client(async () => ({
      status: 200,
      body: Buffer.alloc(1024 * 1024 + 1),
    }));
    await expect(oversized.readTransaction(ids.transaction)).rejects.toThrow();
  });

  it("distinguishes a definitive create rejection from an ambiguous timeout response", async () => {
    const rejected = client(async () => ({
      status: 422,
      body: Buffer.from("{}"),
    }));
    await expect(
      rejected.createCheckoutTransaction({
        cadence: "monthly",
        intent_ref: "intent_123",
        checkout_url: "https://brain.example.test/",
      }),
    ).rejects.toBeInstanceOf(PaddleRequestRejectedError);

    const ambiguous = client(async () => ({
      status: 408,
      body: Buffer.from("{}"),
    }));
    try {
      await ambiguous.createCheckoutTransaction({
        cadence: "monthly",
        intent_ref: "intent_123",
        checkout_url: "https://brain.example.test/",
      });
      throw new Error("Expected the ambiguous response to fail.");
    } catch (error) {
      expect(error).not.toBeInstanceOf(PaddleRequestRejectedError);
    }
  });
});
