import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  PADDLE_WEBHOOK_MAX_BODY_BYTES,
  verifyPaddleWebhook,
} from "../../packages/domain/paddle-signature.ts";
import { normalizePaddleEvent } from "../../packages/domain/paddle-event.ts";

const secret = Buffer.from("SYNTHETIC-webhook-secret-only-for-tests");
const now = new Date("2026-10-18T10:00:00.000Z");
const ts = Math.floor(now.getTime() / 1000);

function signature(body: Uint8Array, at = ts) {
  return createHmac("sha256", secret)
    .update(Buffer.from(`${at}:`))
    .update(body)
    .digest("hex");
}

describe("Paddle webhook trust boundary", () => {
  it("verifies exact raw bytes, bounded skew, and a rotated h1 list", () => {
    const body = Buffer.from('{"event_id":"evt_01h00000000000000000000000"}');
    const checked = verifyPaddleWebhook({
      raw_body: body,
      signature_header: `ts=${ts};h1=${"0".repeat(64)};h1=${signature(body)}`,
      secret,
      now,
    });
    expect(checked.timestamp).toBe(ts);
    expect(Array.from(checked.raw_body)).toEqual(Array.from(body));
    expect(() =>
      verifyPaddleWebhook({
        raw_body: Buffer.from(`${body.toString()} `),
        signature_header: `ts=${ts};h1=${signature(body)}`,
        secret,
        now,
      }),
    ).toThrow();
    expect(() =>
      verifyPaddleWebhook({
        raw_body: body,
        signature_header: `ts=${ts - 6};h1=${signature(body, ts - 6)}`,
        secret,
        now,
      }),
    ).toThrow();
  });

  it("rejects duplicate timestamps, unknown fields, excess signatures, and oversized bodies", () => {
    const body = Buffer.from("{}");
    expect(() =>
      verifyPaddleWebhook({
        raw_body: body,
        signature_header: `ts=${ts};ts=${ts};h1=${signature(body)}`,
        secret,
        now,
      }),
    ).toThrow();
    expect(() =>
      verifyPaddleWebhook({
        raw_body: body,
        signature_header: `ts=${ts};v2=${signature(body)}`,
        secret,
        now,
      }),
    ).toThrow();
    expect(() =>
      verifyPaddleWebhook({
        raw_body: Buffer.alloc(PADDLE_WEBHOOK_MAX_BODY_BYTES + 1),
        signature_header: `ts=${ts};h1=${signature(body)}`,
        secret,
        now,
      }),
    ).toThrow();
  });

  it("normalizes only bounded identifiers and omits provider PII", () => {
    const normalized = normalizePaddleEvent({
      event_id: "evt_01h00000000000000000000000",
      event_type: "transaction.completed",
      occurred_at: "2026-10-18T10:00:00Z",
      data: {
        id: "txn_01h00000000000000000000000",
        subscription_id: "sub_01h00000000000000000000000",
        customer_id: "ctm_01h00000000000000000000000",
        status: "completed",
        custom_data: { bibrain_intent: "intent_123" },
        customer: { email: "never-store@example.test" },
      },
    });
    expect(normalized).toMatchObject({
      event_type: "transaction.completed",
      status: "completed",
      intent_ref: "intent_123",
    });
    expect(JSON.stringify(normalized)).not.toContain("never-store");
    expect(() =>
      normalizePaddleEvent({
        event_id: "evt_01h00000000000000000000000",
        event_type: "transaction.refunded",
        occurred_at: "2026-10-18T10:00:00Z",
        data: { id: "txn_01h00000000000000000000000" },
      }),
    ).toThrow();
  });
});
