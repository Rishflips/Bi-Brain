import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { PaddleEventProjection } from "../../packages/domain/paddle-event.ts";
import {
  syntheticFacts,
  createBillingAdmissionFixture,
} from "../helpers/billing-admission-fixture.ts";
import { BillingAuthority } from "../../packages/storage/billing-authority.ts";
import { PaddleStore } from "../../packages/storage/paddle-store.ts";
import { PaddleBillingWorker } from "../../packages/runtime/paddle-worker.ts";

it("carries checkout correlation through the sole billing authority before granting", async () => {
  const base = join(process.cwd(), "test-results");
  mkdirSync(base, { recursive: true });
  const f = createBillingAdmissionFixture({ base, enrolled: true });
  const store = new PaddleStore(join(f.root, "paddle.sqlite"), f.control.clock);
  try {
    const intent = store.createIntent({
      account_id: f.account_id,
      mode: f.binding.mode,
      cadence: f.binding.cadence,
      product_ref: f.binding.product_ref,
      price_ref: f.binding.price_ref,
    });
    store.attachTransaction({
      intent_id: intent.intent_id,
      expected_version: 1,
      transaction_ref: "txn_01h00000000000000000000000",
    });
    const projection: PaddleEventProjection = {
      schema: 1,
      event_id: "evt_01h00000000000000000000000",
      event_type: "transaction.completed",
      occurred_at: f.control.clock().toISOString(),
      entity_id: "txn_01h00000000000000000000000",
      transaction_ref: "txn_01h00000000000000000000000",
      subscription_ref: "sub_01h00000000000000000000000",
      customer_ref: "ctm_01h00000000000000000000000",
      status: "completed",
      intent_ref: intent.intent_id,
    };
    store.ingestEvent({
      mode: "sandbox",
      endpoint_ref: "ntfset_01h00000000000000000000000",
      body_digest: "a".repeat(64),
      projection,
    });

    let providerAvailable = true;
    const authority = new BillingAuthority({
      control: f.control,
      root: f.root,
      clock: f.control.clock,
      correlation: store.correlationSource(),
      source: {
        read: async (binding) => {
          if (!providerAvailable) throw new Error("synthetic outage");
          return syntheticFacts(binding, f.control.clock().toISOString());
        },
      },
    });
    const worker = new PaddleBillingWorker(store, authority, "worker_1");
    await expect(worker.tick()).resolves.toBe(true);
    expect(store.binding(f.account_id)).toMatchObject({ status: "active" });
    expect(authority.billingEligibility(f.account_id)).toMatchObject({
      state: "granted",
    });
    expect(
      store.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'control_billing_%'",
        )
        .all(),
    ).toEqual([]);

    providerAvailable = false;
    f.setNow("2027-01-31T12:06:00.000Z");
    await expect(worker.tick()).resolves.toBe(true);
    expect(store.binding(f.account_id)).toMatchObject({
      status: "attention",
      verified_at: null,
    });
  } finally {
    store.close();
    f.close();
  }
});
