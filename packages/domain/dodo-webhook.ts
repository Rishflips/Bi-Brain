import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { BrainError } from "./logic.ts";
import type { PaddleEventProjection } from "./paddle-event.ts";

export const DODO_WEBHOOK_MAX_BODY_BYTES = 256 * 1024;
const token = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._:-]+$/);
const invalid = () =>
  new BrainError("INVALID_INPUT", "The Dodo webhook is invalid.", 400);

/** Standard Webhooks: authenticate the delivery ID, timestamp and exact bytes. */
export function verifyDodoWebhook(input: {
  raw_body: Uint8Array;
  headers: Record<string, string | string[] | undefined>;
  secret: string;
  now: Date;
}) {
  const id = token.safeParse(input.headers["webhook-id"]);
  const timestamp = input.headers["webhook-timestamp"];
  const signatures = input.headers["webhook-signature"];
  if (
    !id.success ||
    typeof timestamp !== "string" ||
    !/^\d{1,12}$/.test(timestamp) ||
    typeof signatures !== "string" ||
    signatures.length > 4096 ||
    input.raw_body.byteLength > DODO_WEBHOOK_MAX_BODY_BYTES ||
    !Number.isFinite(input.now.getTime()) ||
    Math.abs(input.now.getTime() / 1000 - Number(timestamp)) > 300
  )
    throw invalid();
  const encoded = input.secret.replace(/^whsec_/, "");
  const key = Buffer.from(encoded, "base64");
  if (key.length < 16 || key.toString("base64") !== encoded) throw invalid();
  const expected = createHmac("sha256", key)
    .update(`${id.data}.${timestamp}.`)
    .update(input.raw_body)
    .digest();
  const matches = signatures
    .split(" ")
    .slice(0, 8)
    .some((signature) => {
      if (!signature.startsWith("v1,")) return false;
      const value = Buffer.from(signature.slice(3), "base64");
      return (
        value.length === expected.length && timingSafeEqual(value, expected)
      );
    });
  if (!matches) throw invalid();
  return {
    id: id.data,
    digest: createHash("sha256").update(input.raw_body).digest("hex"),
  };
}

/** Provider-neutral internal event vocabulary; no raw payload or customer PII retained. */
export function normalizeDodoEvent(
  input: unknown,
  eventId: string,
  businessId: string,
): PaddleEventProjection | null {
  const event = z
    .object({
      business_id: token,
      type: token,
      timestamp: z.string().datetime({ offset: true }),
      data: z.record(z.string(), z.unknown()),
    })
    .safeParse(input);
  if (!event.success || event.data.business_id !== businessId) throw invalid();
  const { type, data, timestamp } = event.data;
  if (!/^(payment|subscription|refund|dispute)\./.test(type)) return null;
  const customer = z.object({ customer_id: token }).safeParse(data.customer);
  const optional = (value: unknown) =>
    value == null ? null : token.parse(value);
  const metadata = z.record(z.string(), z.unknown()).safeParse(data.metadata);
  const intent = metadata.success
    ? optional(metadata.data.bibrain_intent)
    : null;
  const payment = type.startsWith("payment.");
  const subscription = type.startsWith("subscription.");
  const entity = token.parse(
    payment
      ? data.payment_id
      : subscription
        ? data.subscription_id
        : (data.refund_id ?? data.dispute_id),
  );
  return {
    schema: 1,
    event_id: token.parse(eventId),
    event_type: payment
      ? type === "payment.succeeded"
        ? "transaction.completed"
        : "subscription.updated"
      : subscription
        ? "subscription.updated"
        : "adjustment.updated",
    occurred_at: new Date(timestamp).toISOString(),
    entity_id: entity,
    transaction_ref: payment ? entity : optional(data.payment_id),
    subscription_ref: subscription ? entity : optional(data.subscription_id),
    customer_ref: customer.success ? customer.data.customer_id : null,
    status:
      type === "payment.succeeded"
        ? "completed"
        : type === "payment.cancelled"
          ? "canceled"
          : optional(data.status),
    // An unsuccessful attempt may be retried with a different payment ID inside
    // the same hosted checkout. Only success can establish initial correlation.
    intent_ref: payment && type !== "payment.succeeded" ? null : intent,
  };
}
