import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { BrainError } from "../../packages/domain/logic.ts";
import { DODO_WEBHOOK_MAX_BODY_BYTES } from "../../packages/domain/dodo-webhook.ts";
import type { DodoBillingService } from "../../packages/runtime/dodo-billing.ts";

const unavailable = () =>
  new BrainError(
    "UNAVAILABLE",
    "Managed billing is not configured on this installation.",
    503,
  );

function ownerAccount(req: FastifyRequest): string | null {
  req.brain.owner(req.principal);
  return req.brain.tenantId ?? null;
}

function account(req: FastifyRequest): string {
  const accountId = ownerAccount(req);
  if (!accountId)
    throw new BrainError(
      "UNAVAILABLE",
      "Subscriptions are only available on managed BiBrain.",
      503,
    );
  return accountId;
}

/** Registers the closed customer billing surface plus one raw-body webhook. */
export async function registerBillingRoutes(
  app: FastifyInstance,
  billing?: DodoBillingService,
): Promise<void> {
  app.get("/api/v1/billing/status", (req) => {
    const accountId = ownerAccount(req);
    return billing && accountId
      ? billing.status(accountId)
      : {
          available: false as const,
          state: "unavailable" as const,
          reason: accountId
            ? "Managed subscriptions are not configured yet."
            : "Subscriptions are not required for self-hosted BiBrain.",
        };
  });
  app.post("/api/v1/billing/checkout-intent", async (req) => {
    if (!billing) throw unavailable();
    const { cadence } = z
      .object({ cadence: z.enum(["monthly", "annual"]) })
      .strict()
      .parse(req.body);
    return billing.checkout(account(req), cadence);
  });
  app.post("/api/v1/billing/portal-session", async (req) => {
    if (!billing) throw unavailable();
    z.object({}).strict().parse(req.body);
    return billing.portal(account(req));
  });

  // This is the only JSON route that receives bytes rather than a parsed body.
  // Dodo verifies the Standard Webhooks signature before JSON.parse.
  await app.register(async (webhook) => {
    webhook.removeContentTypeParser("application/json");
    webhook.addContentTypeParser(
      "application/json",
      { parseAs: "buffer", bodyLimit: DODO_WEBHOOK_MAX_BODY_BYTES },
      (_req, body, done) => done(null, body),
    );
    webhook.post("/api/v1/billing/webhook", async (req) => {
      if (!billing) throw unavailable();
      if (!Buffer.isBuffer(req.body))
        throw new BrainError(
          "INVALID_INPUT",
          "The payment webhook body must be JSON bytes.",
          400,
        );
      return billing.webhook(req.body, req.headers);
    });
  });
}
