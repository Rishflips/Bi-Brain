import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PaddleStore } from "../../packages/storage/paddle-store.ts";
import type { PaddleEventProjection } from "../../packages/domain/paddle-event.ts";

const root = join(process.cwd(), "test-results", "paddle-store");
const account = "00000000-0000-4000-8000-000000000001";
let now = new Date("2026-10-18T10:00:00.000Z");

beforeEach(() => {
  now = new Date("2026-10-18T10:00:00.000Z");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function store() {
  mkdirSync(root, { recursive: true });
  return new PaddleStore(join(root, "paddle.sqlite"), () => now);
}

it("migrates an existing checkout store before accepting new work", () => {
  const original = store();
  const path = join(root, "paddle.sqlite");
  original.close();
  const legacy = new DatabaseSync(path);
  legacy.exec("ALTER TABLE paddle_checkout_intents DROP COLUMN uncertain");
  legacy.close();

  const migrated = new PaddleStore(path, () => now);
  try {
    const columns = migrated.db
      .prepare("PRAGMA table_info(paddle_checkout_intents)")
      .all() as { name: string }[];
    expect(columns.map((column) => column.name)).toContain("uncertain");
    expect(
      migrated.createIntent({
        account_id: account,
        mode: "sandbox",
        cadence: "monthly",
        product_ref: "SYNTHETIC-product",
        price_ref: "SYNTHETIC-price",
      }),
    ).toMatchObject({ state: "pending" });
  } finally {
    migrated.close();
  }
});

const event: PaddleEventProjection = {
  schema: 1,
  event_id: "evt_01h00000000000000000000000",
  event_type: "transaction.completed",
  occurred_at: "2026-10-18T10:00:00.000Z",
  entity_id: "txn_01h00000000000000000000000",
  transaction_ref: "txn_01h00000000000000000000000",
  subscription_ref: "sub_01h00000000000000000000000",
  customer_ref: "ctm_01h00000000000000000000000",
  status: "completed",
  intent_ref: "intent_123",
};

it("owns one expiring checkout intent per account with versioned transaction attachment", () => {
  const db = store();
  try {
    const intent = db.createIntent({
      account_id: account,
      mode: "sandbox",
      cadence: "monthly",
      product_ref: "SYNTHETIC-product",
      price_ref: "SYNTHETIC-price",
    });
    expect(() =>
      db.createIntent({
        account_id: account,
        mode: "sandbox",
        cadence: "annual",
        product_ref: "SYNTHETIC-product",
        price_ref: "SYNTHETIC-annual",
      }),
    ).toThrow();
    expect(
      db.attachTransaction({
        intent_id: intent.intent_id,
        expected_version: 1,
        transaction_ref: "txn_01h00000000000000000000000",
      }),
    ).toMatchObject({ state: "created", version: 2 });
    expect(() =>
      db.attachTransaction({
        intent_id: intent.intent_id,
        expected_version: 1,
        transaction_ref: "txn_01h11111111111111111111111",
      }),
    ).toThrow();
  } finally {
    db.close();
  }
});

it("deduplicates exact events, detects changed-content replay, and fences stale workers", () => {
  const db = store();
  try {
    expect(
      db.ingestEvent({
        mode: "sandbox",
        endpoint_ref: "endpoint_1",
        body_digest: "a".repeat(64),
        projection: event,
      }),
    ).toEqual({ state: "accepted" });
    expect(
      db.ingestEvent({
        mode: "sandbox",
        endpoint_ref: "endpoint_1",
        body_digest: "a".repeat(64),
        projection: event,
      }),
    ).toEqual({ state: "duplicate" });
    expect(
      db.ingestEvent({
        mode: "sandbox",
        endpoint_ref: "endpoint_1",
        body_digest: "b".repeat(64),
        projection: event,
      }),
    ).toEqual({ state: "conflict" });

    const first = db.leaseEvents("worker_1")[0]!;
    now = new Date(now.getTime() + 61_000);
    const recovered = db.leaseEvents("worker_2")[0]!;
    expect(recovered.lease_fence).toBe(first.lease_fence + 1);
    expect(() =>
      db.completeEvent({
        mode: first.mode,
        endpoint_ref: first.endpoint_ref,
        event_id: first.event_id,
        owner: "worker_1",
        lease_fence: first.lease_fence,
        outcome: "done",
      }),
    ).toThrow();
    db.completeEvent({
      mode: recovered.mode,
      endpoint_ref: recovered.endpoint_ref,
      event_id: recovered.event_id,
      owner: "worker_2",
      lease_fence: recovered.lease_fence,
      outcome: "done",
    });
  } finally {
    db.close();
  }
});

it("binds only the exact server-created transaction and grants no allowance", () => {
  const db = store();
  try {
    const intent = db.createIntent({
      account_id: account,
      mode: "sandbox",
      cadence: "monthly",
      product_ref: "SYNTHETIC-product",
      price_ref: "SYNTHETIC-price",
    });
    db.attachTransaction({
      intent_id: intent.intent_id,
      expected_version: 1,
      transaction_ref: event.transaction_ref!,
    });
    const correlated = { ...event, intent_ref: intent.intent_id };
    db.ingestEvent({
      mode: "sandbox",
      endpoint_ref: "endpoint_1",
      body_digest: "c".repeat(64),
      projection: correlated,
    });
    const leased = db.leaseEvents("worker_1")[0]!;
    expect(db.applyLeasedEvent({ ...leased, owner: "worker_1" })).toMatchObject(
      {
        state: "done",
        account_id: account,
      },
    );
    expect(db.binding(account)).toMatchObject({
      status: "pending_verification",
      initial_transaction_ref: event.transaction_ref,
      subscription_ref: event.subscription_ref,
      customer_ref: event.customer_ref,
    });
    expect(
      db.ingestEvent({
        mode: "sandbox",
        endpoint_ref: "endpoint_1",
        body_digest: "f".repeat(64),
        projection: correlated,
      }),
    ).toEqual({ state: "conflict" });
    expect(db.binding(account)).toMatchObject({
      status: "attention",
      adverse_generation: 1,
    });
    // This separate store has no authority tables and cannot mint a grant.
    expect(
      db.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'control_billing_%'",
        )
        .all(),
    ).toEqual([]);
  } finally {
    db.close();
  }
});

it("denies unknown intents and backs off an event that arrived before attachment", () => {
  const db = store();
  try {
    db.ingestEvent({
      mode: "sandbox",
      endpoint_ref: "endpoint_1",
      body_digest: "d".repeat(64),
      projection: event,
    });
    const unknown = db.leaseEvents("worker_1")[0]!;
    expect(
      db.applyLeasedEvent({ ...unknown, owner: "worker_1" }),
    ).toMatchObject({ state: "denied" });

    const intent = db.createIntent({
      account_id: account,
      mode: "sandbox",
      cadence: "monthly",
      product_ref: "SYNTHETIC-product",
      price_ref: "SYNTHETIC-price",
    });
    const early = {
      ...event,
      event_id: "evt_01h11111111111111111111111",
      intent_ref: intent.intent_id,
    };
    db.ingestEvent({
      mode: "sandbox",
      endpoint_ref: "endpoint_1",
      body_digest: "e".repeat(64),
      projection: early,
    });
    const leased = db.leaseEvents("worker_1")[0]!;
    expect(db.applyLeasedEvent({ ...leased, owner: "worker_1" })).toMatchObject(
      { state: "orphan" },
    );
    expect(db.leaseEvents("worker_1")).toEqual([]);
    now = new Date(now.getTime() + 2_000);
    expect(db.leaseEvents("worker_1")).toHaveLength(1);
  } finally {
    db.close();
  }
});

it("recovers a provider create that became uncertain without allowing a second checkout", () => {
  const db = store();
  try {
    const intent = db.createIntent({
      account_id: account,
      mode: "sandbox",
      cadence: "monthly",
      product_ref: "SYNTHETIC-product",
      price_ref: "SYNTHETIC-price",
    });
    expect(
      db.beginProviderCreate({
        intent_id: intent.intent_id,
        expected_version: intent.version,
      }),
    ).toMatchObject({ uncertain: 1, version: 2 });
    now = new Date(now.getTime() + 31 * 60_000);
    expect(() =>
      db.createIntent({
        account_id: account,
        mode: "sandbox",
        cadence: "annual",
        product_ref: "SYNTHETIC-product",
        price_ref: "SYNTHETIC-annual",
      }),
    ).toThrow();

    const completed = { ...event, intent_ref: intent.intent_id };
    db.ingestEvent({
      mode: "sandbox",
      endpoint_ref: "endpoint_1",
      body_digest: "9".repeat(64),
      projection: completed,
    });
    const leased = db.leaseEvents("worker_1")[0]!;
    expect(db.applyLeasedEvent({ ...leased, owner: "worker_1" })).toMatchObject(
      { state: "done", account_id: account },
    );
    expect(db.binding(account)).toMatchObject({
      initial_transaction_ref: event.transaction_ref,
      status: "pending_verification",
    });
  } finally {
    db.close();
  }
});

it("releases only the exact canceled provider transaction for a safe retry", () => {
  const db = store();
  try {
    const intent = db.createIntent({
      account_id: account,
      mode: "sandbox",
      cadence: "monthly",
      product_ref: "SYNTHETIC-product",
      price_ref: "SYNTHETIC-price",
    });
    const attempt = db.beginProviderCreate({
      intent_id: intent.intent_id,
      expected_version: intent.version,
    });
    db.attachTransaction({
      intent_id: intent.intent_id,
      expected_version: Number(attempt.version),
      transaction_ref: event.transaction_ref!,
    });
    const canceled: PaddleEventProjection = {
      ...event,
      event_id: "evt_01h22222222222222222222222",
      event_type: "transaction.updated",
      status: "canceled",
      subscription_ref: null,
      customer_ref: null,
      intent_ref: intent.intent_id,
    };
    db.ingestEvent({
      mode: "sandbox",
      endpoint_ref: "endpoint_1",
      body_digest: "8".repeat(64),
      projection: canceled,
    });
    const leased = db.leaseEvents("worker_1")[0]!;
    expect(db.applyLeasedEvent({ ...leased, owner: "worker_1" })).toMatchObject(
      { state: "done", account_id: account },
    );
    expect(db.accountIntent(account)).toMatchObject({ state: "failed" });
    expect(
      db.createIntent({
        account_id: account,
        mode: "sandbox",
        cadence: "annual",
        product_ref: "SYNTHETIC-product",
        price_ref: "SYNTHETIC-annual",
      }),
    ).toMatchObject({ state: "pending", cadence: "annual" });
  } finally {
    db.close();
  }
});
