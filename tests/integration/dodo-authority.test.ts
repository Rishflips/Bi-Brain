import { createHmac } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { DodoClient, DODO_PLAN_FAMILY } from "../../packages/providers/dodo.ts";
import { DodoEvidenceSource } from "../../packages/providers/dodo-evidence.ts";
import { DodoBillingService } from "../../packages/runtime/dodo-billing.ts";
import { ProviderBillingWorker } from "../../packages/runtime/paddle-worker.ts";
import { BillingAuthority } from "../../packages/storage/billing-authority.ts";
import { createBillingAdmissionFixture } from "../helpers/billing-admission-fixture.ts";
import { ManagedRuntime } from "../../packages/runtime/managed.ts";
import { DodoStore } from "../../packages/storage/dodo-store.ts";
import {
  writeManagedBackup,
  restoreManagedBackup,
} from "../../packages/runtime/managed-recovery.ts";
import { normalizeDodoEvent } from "../../packages/domain/dodo-webhook.ts";

it.each(["monthly", "annual"] as const)(
  "carries Dodo %s checkout through independent evidence and the sole authority",
  async (cadence) => {
    const base = join(process.cwd(), "test-results");
    mkdirSync(base, { recursive: true });
    const f = createBillingAdmissionFixture({
      base,
      enrolled: true,
      cadence,
      catalog: ["monthly", "annual"].map((c) => ({
        cadence: c as "monthly" | "annual",
        product_ref: DODO_PLAN_FAMILY,
        price_ref: `pdt_${c}`,
        allowance_micro_usd: 1000,
        per_job_micro_usd: 100,
        user_daily_micro_usd: 500,
      })),
    });
    const secret = `whsec_${Buffer.from("synthetic-dodo-authority-secret").toString("base64")}`;
    let intent = "",
      refunded = false,
      canceled = false;
    const period = {
      starts_at: "2027-01-31T00:00:00.000Z",
      ends_at:
        cadence === "annual"
          ? "2028-01-31T00:00:00.000Z"
          : "2027-02-28T00:00:00.000Z",
    };
    const client = new DodoClient({
      mode: "sandbox",
      api_key: "synthetic-key",
      business_id: "bus_synthetic",
      monthly_product_ref: "pdt_monthly",
      annual_product_ref: "pdt_annual",
      allowed_currencies: ["USD"],
      transport: {
        request: async (input) => {
          let data: unknown;
          if (input.url.endsWith("/checkouts")) {
            intent = JSON.parse(input.body!).metadata.bibrain_intent;
            data = {
              session_id: "cks_synthetic",
              checkout_url:
                "https://test.checkout.dodopayments.com/session/cks_synthetic",
            };
          } else if (input.url.includes("/subscriptions/"))
            data = {
              subscription_id: "sub_synthetic",
              customer: { customer_id: "cus_synthetic" },
              status: canceled ? "cancelled" : "active",
              product_id: `pdt_${cadence}`,
              quantity: 1,
              on_demand: false,
              addons: [],
              meters: [],
              previous_billing_date: period.starts_at,
              next_billing_date: period.ends_at,
              payment_frequency_count: 1,
              payment_frequency_interval:
                cadence === "monthly" ? "Month" : "Year",
            };
          else if (input.url.includes("/payments?"))
            data = { items: [{ payment_id: "pay_synthetic" }] };
          else
            data = {
              payment_id: input.url.endsWith("/pay_renewal")
                ? "pay_renewal"
                : "pay_synthetic",
              business_id: "bus_synthetic",
              customer: { customer_id: "cus_synthetic" },
              subscription_id: "sub_synthetic",
              status: "succeeded",
              total_amount: 2000,
              currency: "USD",
              metadata: { bibrain_intent: intent },
              service_periods: [
                { ...period, subscription_id: "sub_synthetic" },
              ],
              refunds: refunded ? [{ status: "succeeded" }] : [],
              disputes: [],
            };
          return { status: 200, body: Buffer.from(JSON.stringify(data)) };
        },
      },
    });
    const billing = new DodoBillingService(
      f.root,
      client,
      {
        public_origin: "https://brain.example.test",
        webhook_secret: secret,
        webhook_endpoint_ref: "ep_synthetic",
      },
      f.control.clock,
    );
    try {
      await billing.checkout(f.account_id, cadence);
      const raw = Buffer.from(
        JSON.stringify({
          business_id: "bus_synthetic",
          type: "payment.succeeded",
          timestamp: f.control.clock().toISOString(),
          data: {
            payment_id: "pay_synthetic",
            subscription_id: "sub_synthetic",
            customer: { customer_id: "cus_synthetic" },
            status: "succeeded",
            metadata: { bibrain_intent: intent },
          },
        }),
      );
      const ts = String(f.control.clock().getTime() / 1000);
      const signature = createHmac(
        "sha256",
        Buffer.from(secret.slice(6), "base64"),
      )
        .update(`msg_synthetic.${ts}.`)
        .update(raw)
        .digest("base64");
      await billing.webhook(raw, {
        "webhook-id": "msg_synthetic",
        "webhook-timestamp": ts,
        "webhook-signature": `v1,${signature}`,
      });
      expect(billing.store.binding(f.account_id)).toBeUndefined();
      const authority = new BillingAuthority({
        control: f.control,
        root: f.root,
        clock: f.control.clock,
        correlation: billing.store.correlationSource(),
        source: new DodoEvidenceSource(client, f.control.clock),
      });
      const worker = new ProviderBillingWorker(billing.store, authority);
      await worker.tick();
      expect(billing.status(f.account_id).state).toBe("active");
      expect(authority.billingEligibility(f.account_id).state).toBe("granted");
      canceled = true;
      f.setNow("2027-01-31T12:06:00.000Z");
      await worker.tick();
      expect(billing.status(f.account_id).state).toBe("attention");
      canceled = false;
      refunded = true;
      f.setNow("2027-01-31T12:12:00.000Z");
      const refundBody = Buffer.from(
        JSON.stringify({
          business_id: "bus_synthetic",
          type: "refund.succeeded",
          timestamp: f.control.clock().toISOString(),
          data: {
            refund_id: "ref_synthetic",
            payment_id: "pay_renewal",
            status: "succeeded",
          },
        }),
      );
      const refundTs = String(f.control.clock().getTime() / 1000);
      const refundSignature = createHmac(
        "sha256",
        Buffer.from(secret.slice(6), "base64"),
      )
        .update(`msg_refund.${refundTs}.`)
        .update(refundBody)
        .digest("base64");
      await billing.webhook(refundBody, {
        "webhook-id": "msg_refund",
        "webhook-timestamp": refundTs,
        "webhook-signature": `v1,${refundSignature}`,
      });
      const refundProjection = JSON.parse(
        String(
          billing.store.db
            .prepare(
              "SELECT projection_json FROM paddle_events WHERE event_id='msg_refund'",
            )
            .get()!.projection_json,
        ),
      );
      expect(refundProjection.subscription_ref).toBe("sub_synthetic");
      await worker.tick();
      expect(authority.billingEligibility(f.account_id).state).not.toBe(
        "granted",
      );
    } finally {
      billing.close();
      f.close();
    }
  },
);

it("backs up Dodo coordination and restores with checkouts expired and bindings blocked", async () => {
  const base = join(process.cwd(), "test-results");
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, "dodo-recovery-"));
  const root = join(dir, "managed");
  const clock = () => new Date("2026-10-21T10:00:00.000Z");
  try {
    const runtime = new ManagedRuntime(root, { clock });
    const account = runtime.provision(
      "https://issuer.example.test",
      "dodo-recovery",
    );
    const pendingAccount = runtime.provision(
      "https://issuer.example.test",
      "dodo-pending",
    );
    const store = new DodoStore(join(root, "dodo.sqlite"), clock);
    const intent = store.createIntent({
      account_id: account.id,
      mode: "sandbox",
      cadence: "monthly",
      product_ref: DODO_PLAN_FAMILY,
      price_ref: "pdt_monthly",
    });
    store.beginProviderCreate({
      intent_id: intent.intent_id,
      expected_version: 1,
    });
    store.saveCheckout(
      intent.intent_id,
      2,
      "cks_synthetic",
      "https://test.checkout.dodopayments.com/session/cks_synthetic",
    );
    const projection = normalizeDodoEvent(
      {
        business_id: "bus_synthetic",
        type: "payment.succeeded",
        timestamp: clock().toISOString(),
        data: {
          payment_id: "pay_synthetic",
          subscription_id: "sub_synthetic",
          customer: { customer_id: "cus_synthetic" },
          status: "succeeded",
          metadata: { bibrain_intent: intent.intent_id },
        },
      },
      "msg_restore",
      "bus_synthetic",
    )!;
    store.ingestEvent({
      mode: "sandbox",
      endpoint_ref: "ep_synthetic",
      body_digest: "a".repeat(64),
      projection,
    });
    await new ProviderBillingWorker(store, null).tick();
    const pending = store.createIntent({
      account_id: pendingAccount.id,
      mode: "sandbox",
      cadence: "annual",
      product_ref: DODO_PLAN_FAMILY,
      price_ref: "pdt_annual",
    });
    store.beginProviderCreate({
      intent_id: pending.intent_id,
      expected_version: 1,
    });
    store.saveCheckout(
      pending.intent_id,
      2,
      "cks_pending",
      "https://test.checkout.dodopayments.com/session/cks_pending",
    );
    store.close();
    runtime.close();
    const bundle = join(dir, "bundle"),
      destination = join(dir, "restored");
    await writeManagedBackup({
      root,
      destination: bundle,
      offline: true,
      clock,
    });
    expect(
      JSON.parse(readFileSync(join(bundle, "manifest.json"), "utf8"))
        .dodo_store,
    ).toBe("dodo.sqlite");
    await restoreManagedBackup({
      bundle,
      destination,
      currentRoot: root,
      offline: true,
      clock,
    });
    const restored = new DodoStore(join(destination, "dodo.sqlite"), clock);
    try {
      expect(restored.checkoutFor(pendingAccount.id)).toBeNull();
      expect(restored.accountIntent(pendingAccount.id)?.state).toBe("expired");
      expect(restored.binding(account.id)?.status).toBe("restore_blocked");
    } finally {
      restored.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
