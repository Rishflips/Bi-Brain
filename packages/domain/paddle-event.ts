/**
 * Minimal, PII-free webhook projection, kept under its historical name because
 * the frozen Dodo webhook (`dodo-webhook.ts`) and `paddle-store.ts` import it
 * from here. The Paddle normaliser was removed in plan 6.
 */
export interface PaddleEventProjection {
  schema: 1;
  event_id: string;
  event_type:
    | "transaction.completed"
    | "transaction.updated"
    | "subscription.created"
    | "subscription.updated"
    | "adjustment.created"
    | "adjustment.updated";
  occurred_at: string;
  entity_id: string;
  transaction_ref: string | null;
  subscription_ref: string | null;
  customer_ref: string | null;
  status: string | null;
  intent_ref: string | null;
}
