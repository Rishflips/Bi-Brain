import { createHmac } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../apps/server/app.ts";
import {
  PaddleClient,
  type PaddleTransport,
} from "../../packages/providers/paddle.ts";
import { PaddleBillingService } from "../../packages/runtime/paddle-billing.ts";
import { ManagedRuntime } from "../../packages/runtime/managed.ts";

const root = join(process.cwd(), "test-results", "paddle-http");
const origin = "https://brain.example.test";
const host = "brain.example.test";
const instant = new Date("2026-10-18T10:00:00.000Z");
const secret = Buffer.from("SYNTHETIC-webhook-secret-only-for-tests");
const ids = {
  product: "pro_01h00000000000000000000000",
  monthly: "pri_01h00000000000000000000000",
  annual: "pri_01h11111111111111111111111",
  transaction: "txn_01h00000000000000000000000",
};

afterEach(() => rmSync(root, { recursive: true, force: true }));

async function harness(handler: PaddleTransport["request"]) {
  mkdirSync(root, { recursive: true });
  const runtime = new ManagedRuntime(root, { clock: () => instant });
  const billing = new PaddleBillingService(
    root,
    new PaddleClient({
      mode: "sandbox",
      api_key: "apikey_01h00000000000000000000000",
      product_ref: ids.product,
      monthly_price_ref: ids.monthly,
      annual_price_ref: ids.annual,
      allowed_currencies: ["USD"],
      transport: { request: handler },
    }),
    {
      mode: "sandbox",
      public_origin: origin,
      checkout_path: "/",
      client_token: "test_01234567890123456789012345",
      webhook_secret: secret,
      webhook_endpoint_ref: "ntfset_01h00000000000000000000000",
      portal_origin: "https://sandbox-portal.example",
    },
    () => instant,
  );
  const app = await createApp(undefined, {
    managed: runtime,
    billing,
    publicOrigin: origin,
    static: false,
  });
  const account = await runtime.provision(
    "https://issuer.example.test",
    "subject-a",
  );
  const session = runtime.control.issueSession(account.id);
  const headers = {
    host,
    origin,
    cookie: `brain_session=${session.token}`,
    "x-brain-csrf": session.csrf,
  };
  return {
    app,
    runtime,
    billing,
    account,
    headers,
    close: async () => {
      await app.close();
      billing.close();
      runtime.close();
    },
  };
}

describe("managed Paddle HTTP boundary", () => {
  it("keeps billing default-off and owner-only", async () => {
    mkdirSync(root, { recursive: true });
    const runtime = new ManagedRuntime(root);
    const app = await createApp(undefined, {
      managed: runtime,
      publicOrigin: origin,
      static: false,
    });
    try {
      const account = await runtime.provision(
        "https://issuer.example.test",
        "subject-a",
      );
      const session = runtime.control.issueSession(account.id);
      const status = await app.inject({
        url: "/api/v1/billing/status",
        headers: { host, cookie: `brain_session=${session.token}` },
      });
      expect(status.statusCode).toBe(200);
      expect(status.json()).toMatchObject({
        available: false,
        state: "unavailable",
      });
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/v1/billing/checkout-intent",
            headers: { host, origin, cookie: `brain_session=${session.token}` },
            payload: { cadence: "monthly" },
          })
        ).statusCode,
      ).toBe(403);
    } finally {
      await app.close();
      runtime.close();
    }
  }, 15_000);

  it("creates a server-owned checkout intent and returns no API credential", async () => {
    const h = await harness(async (_request) => ({
      status: 201,
      body: Buffer.from(
        JSON.stringify({
          data: {
            id: ids.transaction,
            status: "draft",
            checkout: { url: `${origin}/?_ptxn=${ids.transaction}` },
          },
        }),
      ),
    }));
    try {
      const response = await h.app.inject({
        method: "POST",
        url: "/api/v1/billing/checkout-intent",
        headers: h.headers,
        payload: { cadence: "monthly" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        transaction_ref: ids.transaction,
        status: "confirming",
      });
      expect(response.body).not.toContain("apikey_");
      const status = await h.app.inject({
        url: "/api/v1/billing/status",
        headers: h.headers,
      });
      expect(status.json()).toMatchObject({
        available: true,
        state: "confirming",
        cadence: "monthly",
        transaction_ref: ids.transaction,
        management_available: false,
      });
    } finally {
      await h.close();
    }
  });

  it("presents a newly bound transaction as confirming until verification", async () => {
    const h = await harness(async () => ({
      status: 201,
      body: Buffer.from(
        JSON.stringify({
          data: {
            id: ids.transaction,
            status: "draft",
            checkout: { url: `${origin}/?_ptxn=${ids.transaction}` },
          },
        }),
      ),
    }));
    try {
      expect(
        (
          await h.app.inject({
            method: "POST",
            url: "/api/v1/billing/checkout-intent",
            headers: h.headers,
            payload: { cadence: "monthly" },
          })
        ).statusCode,
      ).toBe(200);
      const intent = h.billing.store.accountIntent(h.account.id)!;
      h.billing.store.ingestEvent({
        mode: "sandbox",
        endpoint_ref: "ntfset_01h00000000000000000000000",
        body_digest: "7".repeat(64),
        projection: {
          schema: 1,
          event_id: "evt_01h33333333333333333333333",
          event_type: "transaction.completed",
          occurred_at: instant.toISOString(),
          entity_id: ids.transaction,
          transaction_ref: ids.transaction,
          subscription_ref: "sub_01h00000000000000000000000",
          customer_ref: "ctm_01h00000000000000000000000",
          status: "completed",
          intent_ref: String(intent.intent_id),
        },
      });
      const leased = h.billing.store.leaseEvents("worker_1")[0]!;
      h.billing.store.applyLeasedEvent({ ...leased, owner: "worker_1" });
      expect(h.billing.status(h.account.id)).toMatchObject({
        state: "confirming",
        management_available: true,
        transaction_ref: null,
      });
    } finally {
      await h.close();
    }
  });

  it("blocks duplicate checkout after an uncertain provider create", async () => {
    const h = await harness(async () => ({
      status: 500,
      body: Buffer.from("{}"),
    }));
    try {
      const first = await h.app.inject({
        method: "POST",
        url: "/api/v1/billing/checkout-intent",
        headers: h.headers,
        payload: { cadence: "monthly" },
      });
      expect(first.statusCode).toBe(503);
      const status = await h.app.inject({
        url: "/api/v1/billing/status",
        headers: h.headers,
      });
      expect(status.json()).toMatchObject({
        state: "attention",
        transaction_ref: null,
        management_available: false,
      });
      const second = await h.app.inject({
        method: "POST",
        url: "/api/v1/billing/checkout-intent",
        headers: h.headers,
        payload: { cadence: "annual" },
      });
      expect(second.statusCode).toBe(409);
    } finally {
      await h.close();
    }
  });

  it("allows retry after Paddle definitively rejects a create", async () => {
    let calls = 0;
    const h = await harness(async () => {
      calls += 1;
      return calls === 1
        ? { status: 400, body: Buffer.from("{}") }
        : {
            status: 201,
            body: Buffer.from(
              JSON.stringify({
                data: {
                  id: ids.transaction,
                  status: "draft",
                  checkout: { url: `${origin}/?_ptxn=${ids.transaction}` },
                },
              }),
            ),
          };
    });
    try {
      const request = (cadence: "monthly" | "annual") =>
        h.app.inject({
          method: "POST",
          url: "/api/v1/billing/checkout-intent",
          headers: h.headers,
          payload: { cadence },
        });
      expect((await request("monthly")).statusCode).toBe(503);
      expect((await request("annual")).statusCode).toBe(200);
    } finally {
      await h.close();
    }
  });

  it("verifies raw webhook bytes without a user session and deduplicates replay", async () => {
    const h = await harness(async () => ({
      status: 500,
      body: Buffer.from("{}"),
    }));
    try {
      const body = Buffer.from(
        JSON.stringify({
          event_id: "evt_01h00000000000000000000000",
          event_type: "transaction.completed",
          occurred_at: instant.toISOString(),
          data: {
            id: ids.transaction,
            status: "completed",
            subscription_id: "sub_01h00000000000000000000000",
            customer_id: "ctm_01h00000000000000000000000",
            custom_data: { bibrain_intent: "opaque_123" },
          },
        }),
      );
      const ts = Math.floor(instant.getTime() / 1000);
      const signature = createHmac("sha256", secret)
        .update(Buffer.from(`${ts}:`))
        .update(body)
        .digest("hex");
      const send = () =>
        h.app.inject({
          method: "POST",
          url: "/api/v1/billing/webhook",
          headers: {
            host,
            "content-type": "application/json",
            "paddle-signature": `ts=${ts};h1=${signature}`,
          },
          payload: body,
        });
      expect((await send()).json()).toEqual({
        accepted: true,
        duplicate: false,
      });
      expect((await send()).json()).toEqual({
        accepted: true,
        duplicate: true,
      });
      expect(
        (
          await h.app.inject({
            method: "POST",
            url: "/api/v1/billing/webhook",
            headers: { host, "content-type": "application/json" },
            payload: body,
          })
        ).statusCode,
      ).toBe(400);
    } finally {
      await h.close();
    }
  });
});
