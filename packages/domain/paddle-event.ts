import { z } from "zod";
import { BrainError } from "./logic.ts";

/** Minimal, PII-free webhook projection. Unknown provider fields never become authority. */

const paddleId = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[a-z0-9]{26}$`));
const token = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._:-]+$/);
const eventType = z.enum([
  "transaction.completed",
  "transaction.updated",
  "subscription.created",
  "subscription.updated",
  "adjustment.created",
  "adjustment.updated",
]);

const eventSchema = z
  .object({
    event_id: paddleId("evt"),
    event_type: eventType,
    occurred_at: z.string().datetime({ offset: true }),
    data: z.object({}).passthrough(),
  })
  .passthrough();

export interface PaddleEventProjection {
  schema: 1;
  event_id: string;
  event_type: z.infer<typeof eventType>;
  occurred_at: string;
  entity_id: string;
  transaction_ref: string | null;
  subscription_ref: string | null;
  customer_ref: string | null;
  status: string | null;
  intent_ref: string | null;
}

const invalid = (message: string) =>
  new BrainError("INVALID_INPUT", message, 400);

function optionalId(value: unknown, prefix: string): string | null {
  if (value === null || value === undefined) return null;
  const parsed = paddleId(prefix).safeParse(value);
  if (!parsed.success)
    throw invalid(`The Paddle ${prefix} reference is invalid.`);
  return parsed.data;
}

export function normalizePaddleEvent(input: unknown): PaddleEventProjection {
  const parsed = eventSchema.safeParse(input);
  if (!parsed.success)
    throw invalid("The Paddle webhook event is unsupported or malformed.");
  const data = parsed.data.data as Record<string, unknown>;
  const entityPrefix = parsed.data.event_type.startsWith("transaction.")
    ? "txn"
    : parsed.data.event_type.startsWith("subscription.")
      ? "sub"
      : "adj";
  const entityId = optionalId(data.id, entityPrefix);
  if (!entityId) throw invalid("The Paddle webhook entity id is missing.");

  let intentRef: string | null = null;
  if (
    data.custom_data &&
    typeof data.custom_data === "object" &&
    !Array.isArray(data.custom_data)
  ) {
    const candidate = (data.custom_data as Record<string, unknown>)
      .bibrain_intent;
    if (candidate !== undefined) {
      const validated = token.safeParse(candidate);
      if (!validated.success)
        throw invalid("The Paddle checkout intent reference is invalid.");
      intentRef = validated.data;
    }
  }
  const status =
    data.status === undefined || data.status === null
      ? null
      : token.safeParse(data.status);
  if (status !== null && !status.success)
    throw invalid("The Paddle entity status is invalid.");

  return {
    schema: 1,
    event_id: parsed.data.event_id,
    event_type: parsed.data.event_type,
    occurred_at: new Date(parsed.data.occurred_at).toISOString(),
    entity_id: entityId,
    transaction_ref:
      entityPrefix === "txn"
        ? entityId
        : optionalId(data.transaction_id, "txn"),
    subscription_ref:
      entityPrefix === "sub"
        ? entityId
        : optionalId(data.subscription_id, "sub"),
    customer_ref: optionalId(data.customer_id, "ctm"),
    status: status === null ? null : status.data,
    intent_ref: intentRef,
  };
}
