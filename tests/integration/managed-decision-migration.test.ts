import { afterEach, expect, it } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedRuntime } from "../../packages/runtime/managed.ts";
import { ManagedSpendingStore, managedMoneySchemaVersion } from "../../packages/storage/managed-spending.ts";
import { ManagedActivationStore, readActivationRow } from "../../packages/storage/managed-activation.ts";
import { readDecisionActivationRow } from "../../packages/storage/managed-decision-activation.ts";
import { ManagedReconciliationStore } from "../../packages/storage/managed-reconciliation.ts";
import { auditManagedHistory, validateManagedAudit } from "../../packages/runtime/managed-audit.ts";
import { canonical } from "../../packages/domain/logic.ts";

const ISSUER = "https://issuer.synthetic.test";
const ACK = { offline: true as const, workers_terminated: true as const };
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function reasoningOperator(over: Record<string, unknown> = {}) {
  return {
    provider: "openai" as const,
    model: "synthetic-model-v1",
    price_version: "synthetic-price-v1",
    input_micro_usd_per_million: 1_000_000,
    output_micro_usd_per_million: 1_000_000,
    accepted_response_models: ["synthetic-model-v1"],
    max_output_tokens: 100,
    endpoint_class: "openai_responses" as const,
    ...over,
  };
}

/** Downgrade the freshly migrated control to a genuine schema-3 shape. */
function downgradeToSchemaThree(db: import("node:sqlite").DatabaseSync) {
  db.exec("DROP TRIGGER IF EXISTS managed_decision_activation_events_no_update");
  db.exec("DROP TRIGGER IF EXISTS managed_decision_activation_events_no_delete");
  db.exec("DROP TABLE IF EXISTS managed_decision_activation_events");
  db.exec("DROP TABLE IF EXISTS managed_decision_activation");
  db.prepare("DELETE FROM managed_money_schema WHERE version>=4").run();
  db.prepare("INSERT OR IGNORE INTO managed_money_schema(version,applied_at) VALUES(3,'2026-01-01T00:00:00Z')").run();
}

function snapshot(db: import("node:sqlite").DatabaseSync, table: string): string {
  return canonical(db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all());
}

it("migrates a three-marker control to 4, preserving money and reasoning with no decision profile", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bibrain-decision-migrate-")));
  roots.push(root);
  const runtime = new ManagedRuntime(root);
  try {
    const account = runtime.provision(ISSUER, "migrate-account");
    const money = new ManagedSpendingStore(runtime.control);
    money.setServicePolicy({ daily_micro_usd: 100_000 });
    money.setAccountPolicy({ account_id: account.id, per_job_micro_usd: 10_000, user_daily_micro_usd: 100_000 });
    money.configureAccountPeriod({
      account_id: account.id,
      starts_at: "2026-01-01T00:00:00Z",
      ends_at: "2030-01-01T00:00:00Z",
      allowance_micro_usd: 1_000_000,
    });
    new ManagedReconciliationStore(runtime.control, root).initEpoch(ACK);

    // A real reasoning enrollment on the current schema, then a genuine downgrade.
    const v4Audit = auditManagedHistory({ runtime, root, ...ACK });
    expect(v4Audit.ok).toBe(true);
    new ManagedActivationStore(runtime.control, root).enable(
      { ...reasoningOperator(), audit_id: v4Audit.audit_id!, expected_version: 0 },
      ACK,
    );
    const reasoningBefore = readActivationRow(runtime.control.db);
    expect(reasoningBefore?.enabled).toBe(true);

    downgradeToSchemaThree(runtime.control.db);
    runtime.control.db.prepare("INSERT INTO managed_money_blocks(key,reason,at) VALUES('block-1','Synthetic operator hold','2026-02-01T00:00:00Z')").run();

    const tables = runtime.control.db
      .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='managed_decision_activation'")
      .get() as { n: number };
    expect(Number(tables.n)).toBe(0);

    const moneyBefore = {
      policy: snapshot(runtime.control.db, "managed_account_policy"),
      periods: snapshot(runtime.control.db, "managed_account_periods"),
      service: snapshot(runtime.control.db, "managed_service_policy"),
      blocks: snapshot(runtime.control.db, "managed_money_blocks"),
    };

    // Run the CURRENT migrator (constructor migration path) 3 -> 4.
    new ManagedSpendingStore(runtime.control);
    expect(managedMoneySchemaVersion).toBe(4);
    const version = runtime.control.db
      .prepare("SELECT max(version) AS v FROM managed_money_schema")
      .get() as { v: number };
    expect(Number(version.v)).toBe(4);

    // Old money rows are byte-identical (no re-mint, no loss).
    expect(snapshot(runtime.control.db, "managed_account_policy")).toBe(moneyBefore.policy);
    expect(snapshot(runtime.control.db, "managed_account_periods")).toBe(moneyBefore.periods);
    expect(snapshot(runtime.control.db, "managed_service_policy")).toBe(moneyBefore.service);
    expect(snapshot(runtime.control.db, "managed_money_blocks")).toBe(moneyBefore.blocks);

    // The legacy reasoning enrollment is untouched: still enabled, same bytes.
    const reasoningAfter = readActivationRow(runtime.control.db);
    expect(canonical(reasoningAfter)).toBe(canonical(reasoningBefore));
    expect(reasoningAfter?.enabled).toBe(true);

    // The new decision profile is absent and was never factory-enabled.
    expect(readDecisionActivationRow(runtime.control.db)).toBeUndefined();
  } finally {
    runtime.close();
  }
});

it("an audit accepted before the decision security binding existed is refused once it is added", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bibrain-decision-binding-")));
  roots.push(root);
  const runtime = new ManagedRuntime(root);
  try {
    const account = runtime.provision(ISSUER, "binding-account");
    const money = new ManagedSpendingStore(runtime.control);
    money.setServicePolicy({ daily_micro_usd: 100_000 });
    money.setAccountPolicy({ account_id: account.id, per_job_micro_usd: 10_000, user_daily_micro_usd: 100_000 });
    money.configureAccountPeriod({
      account_id: account.id,
      starts_at: "2026-01-01T00:00:00Z",
      ends_at: "2030-01-01T00:00:00Z",
      allowance_micro_usd: 1_000_000,
    });
    new ManagedReconciliationStore(runtime.control, root).initEpoch(ACK);

    // Remove ONLY the decision security binding; the money schema marker stays current,
    // so an audit can be recorded against a signature that predates the binding.
    for (const ddl of [
      "DROP TRIGGER IF EXISTS managed_decision_activation_events_no_update",
      "DROP TRIGGER IF EXISTS managed_decision_activation_events_no_delete",
      "DROP TABLE IF EXISTS managed_decision_activation_events",
      "DROP TABLE IF EXISTS managed_decision_activation",
    ])
      runtime.control.db.exec(ddl);

    const pre = auditManagedHistory({ runtime, root, ...ACK });
    expect(pre.ok).toBe(true);

    // The real migrator re-establishes the binding (the DDL is applied on every open).
    new ManagedSpendingStore(runtime.control);

    const after = validateManagedAudit({
      control: { db: runtime.control.db, path: runtime.control.path },
      root,
      auditId: pre.audit_id!,
    });
    expect(after.valid).toBe(false);
  } finally {
    runtime.close();
  }
});
