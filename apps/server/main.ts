import { dirname, resolve } from "node:path";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { ManagedRuntime } from "../../packages/runtime/managed.ts";
import { OidcClient } from "../../packages/identity/oidc.ts";
import { ManagedLogin } from "../../packages/identity/managed-login.ts";
import {
  managedAllowPaidFlag,
  managedCapability,
  managedDecisionCapability,
} from "./startup-gates.ts";
import { BoundedFetchTransport } from "../../packages/providers/bounded-fetch.ts";
import { DodoClient } from "../../packages/providers/dodo.ts";
import { DodoBillingService } from "../../packages/runtime/dodo-billing.ts";

// Fail closed before any storage or adapter is constructed: an unknown mode or
// a missing managed field throws here rather than silently serving local data.
const config = loadConfig();
if (config.mode === "managed" && config.paddle)
  throw new Error("Paddle is retired. Configure BRAIN_DODO_* instead.");

const host = process.env.BRAIN_CONTAINER === "1" ? "0.0.0.0" : "127.0.0.1";
const port = Number(process.env.BRAIN_PORT ?? 4317);

if (config.mode === "managed") {
  // The adapter is pure configuration; it is created before the runtime so a
  // bad issuer cannot leave a half-open managed root behind.
  const oidc = new OidcClient({
    issuer: config.oidc.issuer,
    clientId: config.oidc.clientId,
    clientSecret: config.oidc.clientSecret,
    publicOrigin: config.publicOrigin,
    callbackPath: config.oidc.callbackPath,
  });
  let capability = (): { available: boolean; reason: string } => ({
    available: false,
    reason: "off",
  });
  let decisionCapability = (): { available: boolean; reason: string } => ({
    available: false,
    reason: "off",
  });
  const runtime = new ManagedRuntime(config.managedRoot, {
    capability: () => {
      const c = capability();
      return { ready: c.available, reason: c.reason };
    },
    decisionCapability: () => {
      const c = decisionCapability();
      return { ready: c.available, reason: c.reason };
    },
  });
  capability = () => {
    const c = managedCapability({
      control: runtime.control,
      root: runtime.root,
      clock: runtime.control.clock,
      optIn: managedAllowPaidFlag(),
    });
    return { available: c.available, reason: c.reason };
  };
  decisionCapability = () => {
    const c = managedDecisionCapability({
      control: runtime.control,
      root: runtime.root,
      clock: runtime.control.clock,
      optIn: managedAllowPaidFlag(),
    });
    return { available: c.available, reason: c.reason };
  };
  const login = new ManagedLogin(runtime, oidc);
  const billing = config.dodo
    ? new DodoBillingService(
        runtime.root,
        new DodoClient({
          mode: config.dodo.mode,
          api_key: config.dodo.apiKey,
          business_id: config.dodo.businessId,
          monthly_product_ref: config.dodo.monthlyProductRef,
          annual_product_ref: config.dodo.annualProductRef,
          allowed_currencies: config.dodo.allowedCurrencies,
          transport: new BoundedFetchTransport(),
        }),
        {
          public_origin: config.publicOrigin,
          webhook_secret: config.dodo.webhookSecret,
          webhook_endpoint_ref: config.dodo.webhookEndpointRef,
        },
      )
    : undefined;
  const app = await createApp(undefined, {
    managed: runtime,
    login,
    oidcCallbackPath: config.oidc.callbackPath,
    publicOrigin: config.publicOrigin,
    metadataLogs: true,
    capability: () => capability(),
    decisionCapability: () => decisionCapability(),
    billing,
  });
  await app.listen({ host, port });
  // No secret is ever printed; the operator learns the mode and origin only.
  console.log(
    `Bi Brain: managed sign-in for ${config.publicOrigin} on ${config.oidc.issuer}.`,
  );
  let shuttingDown = false;
  const stop = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await app.close();
    } catch {
      /* already closing */
    }
    try {
      runtime.close();
    } catch {
      /* release happens per request; a pinned handle must not crash shutdown */
    }
    try {
      billing?.close();
    } catch {
      /* already closed */
    }
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
} else {
  const app = await createApp(undefined, { metadataLogs: true });
  await app.listen({ host, port });
  console.log(
    `Bi Brain: ${process.env.BRAIN_PUBLIC_ORIGIN ?? `http://127.0.0.1:${process.env.BRAIN_PORT ?? 4317}`} — ${process.env.BRAIN_OWNER_SECRET !== undefined ? "installation code supplied by the operator" : `installation code is in ${resolve(dirname(process.env.BRAIN_DB ?? "data/brain.sqlite"), "owner-secret")}`}`,
  );
  process.on("SIGINT", () => void app.close());
  process.on("SIGTERM", () => void app.close());
}
