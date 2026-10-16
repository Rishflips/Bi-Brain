import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStore } from "../../packages/storage/control.ts";
import { ManagedSpendingStore } from "../../packages/storage/managed-spending.ts";
import {
  MANAGED_RESTORE_INCOMPLETE,
  applyControlRestoreBarrier,
  controlRestoreRequired,
} from "../../packages/storage/managed-restore-policy.ts";
import { ManagedRuntime } from "../../packages/runtime/managed.ts";

/**
 * Control restore barrier behavior. It runs over a real in-memory control store;
 * the barrier was already present when this suite was written, so this is the
 * GREEN proof, not a fresh production RED.
 */

const clock = () => new Date("2026-10-16T09:00:00Z");
const ISSUER = "https://issuer.synthetic.test";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function setup() {
  const control = new ControlStore(":memory:", clock);
  const central = new ManagedSpendingStore(control, clock);
  const account = control.provision(ISSUER, "restore-account");
  central.configureAccountPeriod({
    account_id: account.id,
    starts_at: "2026-10-16T00:00:00Z",
    ends_at: "2026-10-18T00:00:00Z",
    allowance_micro_usd: 1000,
  });
  central.setServicePolicy({ daily_micro_usd: 1000 });
  central.setAccountPolicy({
    account_id: account.id,
    per_job_micro_usd: 1000,
    user_daily_micro_usd: 1000,
  });
  return { control, central, account };
}

function spec(accountId: string, amount: number) {
  return {
    account_id: accountId,
    job_id: "restore-job",
    dispatch_key: "reasoning",
    stage: "reasoning" as const,
    reserved_micro_usd: amount,
    provider: "synthetic",
    model: "synthetic",
    price_version: "synthetic-v1",
    request_hash: "a".repeat(64),
    config_hash: "b".repeat(64),
    limits: { per_job_micro_usd: 1000, user_daily_micro_usd: 1000, time_zone: "UTC" },
  };
}

describe("managed control restore barrier", () => {
  it("is idempotent, preserves financial rows exactly, and keeps restored credentials dead forever", () => {
    const { control, central, account } = setup();
    try {
      const held = central.reserve(spec(account.id, 10));
      central.mark(held.call_id, {
        per_job_micro_usd: 1000,
        user_daily_micro_usd: 1000,
        time_zone: "UTC",
      });
      const session = control.issueSession(account.id);
      const tokenHash = "c".repeat(64);
      control.registerAgentToken(tokenHash, account.id, "grant-1");
      control.db.exec(
        "CREATE TABLE IF NOT EXISTS oidc_transactions(token_hash TEXT PRIMARY KEY, \"transaction\" TEXT NOT NULL, expires_at TEXT NOT NULL)",
      );
      control.db
        .prepare("INSERT INTO oidc_transactions VALUES(?,?,?)")
        .run("d".repeat(64), "{}", "2026-10-16T10:00:00Z");

      const snapshot = (table: string) =>
        control.db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all();
      const before = {
        accounts: snapshot("managed_accounts"),
        periods: snapshot("managed_account_periods"),
        policies: snapshot("managed_account_policy"),
        reservations: snapshot("managed_reservations"),
      };

      applyControlRestoreBarrier(control, clock);
      applyControlRestoreBarrier(control, clock);

      expect(controlRestoreRequired(control)).toBe(true);
      expect(control.db.prepare("SELECT * FROM managed_accounts ORDER BY 1").all()).toEqual(
        before.accounts,
      );
      expect(
        control.db.prepare("SELECT * FROM managed_account_periods ORDER BY 1").all(),
      ).toEqual(before.periods);
      expect(
        control.db.prepare("SELECT * FROM managed_account_policy ORDER BY 1").all(),
      ).toEqual(before.policies);
      expect(
        control.db.prepare("SELECT * FROM managed_reservations ORDER BY 1").all(),
      ).toEqual(before.reservations);

      expect(control.resolveSession(session.token)).toBeUndefined();
      expect(control.agentTokenTenant(tokenHash)).toBeUndefined();
      expect(
        control.db.prepare("SELECT count(*) AS n FROM oidc_transactions").get()!.n,
      ).toBe(0);

      // Even if an operator later removes the financial block, the restored
      // credentials must not come back.
      control.db.prepare("DELETE FROM managed_money_blocks").run();
      expect(controlRestoreRequired(control)).toBe(false);
      expect(control.resolveSession(session.token)).toBeUndefined();
      expect(control.agentTokenTenant(tokenHash)).toBeUndefined();

      // A known charge still settles after the restored block.
      expect(central.settleKnown(held.call_id, 7).state).toBe("settled");
    } finally {
      control.close();
    }
  });

  it("blocks an empty restored history even after a positive operator policy", () => {
    const { control, central, account } = setup();
    try {
      expect(
        control.db.prepare("SELECT count(*) AS n FROM managed_reservations").get()!.n,
      ).toBe(0);
      applyControlRestoreBarrier(control, clock);
      expect(controlRestoreRequired(control)).toBe(true);
      expect(() => central.reserve(spec(account.id, 10))).toThrow();
      expect(central.accountStatus(account.id).blocked).toBe(true);
      expect(central.accountStatus(account.id).blocked_reason).toBe("restored_backup");
    } finally {
      control.close();
    }
  });

  it("refuses a mid-restore root before the control store is opened or provisioned", () => {
    const dir = mkdtempSync(join(tmpdir(), "bibrain-restore-marker-"));
    dirs.push(dir);
    const root = join(dir, "managed");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, MANAGED_RESTORE_INCOMPLETE), clock().toISOString());
    expect(() => new ManagedRuntime(root, { clock })).toThrow();
    expect(existsSync(join(root, "control.sqlite"))).toBe(false);
  });
});
