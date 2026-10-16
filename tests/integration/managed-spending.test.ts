import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStore } from "../../packages/storage/control.ts";
import { ManagedSpendingStore } from "../../packages/storage/managed-spending.ts";
import { BrainError } from "../../packages/domain/logic.ts";
import {
  MANAGED_SERVICE_ID,
  type ManagedDispatchSpec,
  type ManagedLimits,
} from "../../packages/domain/managed-spend.ts";

/**
 * Central managed money ledger over the real control database. Every amount is
 * an integer micro-USD, the accounting clock is deterministic, and the single
 * global service bucket is exercised directly. No provider or network is used.
 */

const ISSUER = "https://issuer.synthetic.test";
const DAY = { starts: "2026-10-16T00:00:00Z", ends: "2026-10-17T00:00:00Z" };

let current = "2026-10-16T09:00:00Z";
let seq = 0;
const clock = () => new Date(current);
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const dirs: string[] = [];
const controls: ControlStore[] = [];

afterEach(() => {
  current = "2026-10-16T09:00:00Z";
  for (const control of controls.splice(0)) {
    try {
      control.close();
    } catch {
      /* already closed */
    }
  }
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "bibrain-managed-spend-"));
  dirs.push(dir);
  const control = new ControlStore(join(dir, "control.sqlite"), clock);
  controls.push(control);
  const spending = new ManagedSpendingStore(control, clock);
  return { control, spending };
}

type Grant = {
  allowance_micro_usd: number;
  service_micro_usd: number;
  per_job_micro_usd: number;
  user_daily_micro_usd: number;
  starts_at?: string;
  ends_at?: string;
};

function accountWith(spending: ManagedSpendingStore, control: ControlStore, over: Partial<Grant> = {}) {
  const account = control.provision(ISSUER, `subject-${++seq}`);
  const grant: Grant = {
    allowance_micro_usd: 20,
    service_micro_usd: 10,
    per_job_micro_usd: 10,
    user_daily_micro_usd: 10,
    ...over,
  };
  const period = spending.configureAccountPeriod({
    account_id: account.id,
    starts_at: grant.starts_at ?? DAY.starts,
    ends_at: grant.ends_at ?? DAY.ends,
    allowance_micro_usd: grant.allowance_micro_usd,
  });
  spending.setServicePolicy({ daily_micro_usd: grant.service_micro_usd });
  spending.setAccountPolicy({
    account_id: account.id,
    per_job_micro_usd: grant.per_job_micro_usd,
    user_daily_micro_usd: grant.user_daily_micro_usd,
  });
  return { account, period };
}

const limits = (over: Partial<ManagedLimits> = {}): ManagedLimits => ({
  per_job_micro_usd: 10,
  user_daily_micro_usd: 10,
  time_zone: "UTC",
  ...over,
});

function specFor(
  accountId: string,
  amount: number,
  over: Partial<ManagedDispatchSpec> = {},
): ManagedDispatchSpec {
  const tag = `${accountId}:${over.job_id ?? "job"}:${over.dispatch_key ?? "decision"}`;
  return {
    account_id: accountId,
    job_id: `job-${++seq}`,
    dispatch_key: "decision",
    stage: "decision",
    reserved_micro_usd: amount,
    provider: "synthetic",
    model: "synthetic",
    price_version: "synthetic-v1",
    request_hash: sha(`request:${tag}`),
    config_hash: sha(`config:${tag}`),
    limits: limits(),
    ...over,
  };
}

function expectCode(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (error) {
    expect((error as BrainError).code).toBe(code);
    return;
  }
  throw new Error(`Expected BrainError ${code}`);
}

describe("central managed spending primitives", () => {
  it("denies by default with no period, service policy or account policy", () => {
    const { spending, control } = setup();
    const account = control.provision(ISSUER, "subject-defaults");
    expectCode(
      () => spending.reserve(specFor(account.id, 7)),
      "BUDGET_EXHAUSTED",
    );
  });

  it("isolates each admission dimension by making the others generous", () => {
    const { spending, control } = setup();

    const periodOnly = accountWith(spending, control, {
      allowance_micro_usd: 5,
      service_micro_usd: 100,
      per_job_micro_usd: 100,
      user_daily_micro_usd: 100,
    });
    expectCode(
      () => spending.reserve(specFor(periodOnly.account.id, 7)),
      "BUDGET_EXHAUSTED",
    );

    const serviceOnly = accountWith(spending, control, {
      allowance_micro_usd: 100,
      service_micro_usd: 5,
      per_job_micro_usd: 100,
      user_daily_micro_usd: 100,
    });
    expectCode(
      () => spending.reserve(specFor(serviceOnly.account.id, 7)),
      "BUDGET_EXHAUSTED",
    );

    const jobOnly = accountWith(spending, control, {
      allowance_micro_usd: 100,
      service_micro_usd: 100,
      per_job_micro_usd: 5,
      user_daily_micro_usd: 100,
    });
    spending.reserve(
      specFor(jobOnly.account.id, 3, { job_id: "shared-job" }),
    );
    expectCode(
      () =>
        spending.reserve(
          specFor(jobOnly.account.id, 3, {
            job_id: "shared-job",
            dispatch_key: "reasoning",
            stage: "reasoning",
          }),
        ),
      "BUDGET_EXHAUSTED",
    );

    const userOnly = accountWith(spending, control, {
      allowance_micro_usd: 100,
      service_micro_usd: 100,
      per_job_micro_usd: 100,
      user_daily_micro_usd: 5,
    });
    expectCode(
      () => spending.reserve(specFor(userOnly.account.id, 7)),
      "BUDGET_EXHAUSTED",
    );
  });

  it("admits one bounded call and binds it to the single service and days", () => {
    const { spending, control } = setup();
    const { account } = accountWith(spending, control);
    const row = spending.reserve(specFor(account.id, 7));
    expect(row.state).toBe("reserved");
    expect(row.service).toBe(MANAGED_SERVICE_ID);
    expect(row.service_day).toBe("2026-10-16");
    expect(row.user_day).toBe("2026-10-16");
    expect(row.accounting_tz).toBe("UTC");
    expect(row.stored_per_job_micro_usd).toBe(10);
    expect(row.identity_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("carries an unresolved hold from an earlier period into a later one", () => {
    const { spending, control } = setup();
    const account = control.provision(ISSUER, "subject-rollover");
    spending.configureAccountPeriod({
      account_id: account.id,
      starts_at: DAY.starts,
      ends_at: DAY.ends,
      allowance_micro_usd: 10,
    });
    spending.configureAccountPeriod({
      account_id: account.id,
      starts_at: "2026-10-17T00:00:00Z",
      ends_at: "2026-10-18T00:00:00Z",
      allowance_micro_usd: 10,
    });
    spending.setServicePolicy({ daily_micro_usd: 100 });
    spending.setAccountPolicy({
      account_id: account.id,
      per_job_micro_usd: 100,
      user_daily_micro_usd: 100,
    });
    spending.reserve(specFor(account.id, 7));
    current = "2026-10-17T09:00:00Z";
    expectCode(
      () => spending.reserve(specFor(account.id, 7)),
      "BUDGET_EXHAUSTED",
    );
  });

  it("refuses a mark once the caller lowers a cap below the committed hold", () => {
    const { spending, control } = setup();
    const { account } = accountWith(spending, control, {
      allowance_micro_usd: 100,
      service_micro_usd: 100,
      per_job_micro_usd: 100,
      user_daily_micro_usd: 100,
    });
    const row = spending.reserve(specFor(account.id, 7));
    expectCode(
      () => spending.mark(row.call_id, limits({ per_job_micro_usd: 5 })),
      "BUDGET_EXHAUSTED",
    );
    expect(spending.readReceipt(row.call_id).state).toBe("reserved");
  });

  it("refuses a mark after revoke but still settles a known charge after a mark", () => {
    const { spending, control } = setup();
    const first = accountWith(spending, control, {
      allowance_micro_usd: 100,
      service_micro_usd: 100,
      per_job_micro_usd: 100,
      user_daily_micro_usd: 100,
    });
    const revoked = spending.reserve(specFor(first.account.id, 7));
    spending.revokeAccountPeriod(first.period.period_id);
    expectCode(
      () => spending.mark(revoked.call_id, limits()),
      "PERIOD_EXPIRED",
    );

    const second = accountWith(spending, control, {
      allowance_micro_usd: 100,
      service_micro_usd: 100,
      per_job_micro_usd: 100,
      user_daily_micro_usd: 100,
    });
    const sent = spending.reserve(specFor(second.account.id, 7));
    spending.mark(sent.call_id, limits());
    control.setAccountState(second.account.id, "suspended");
    expect(spending.settleKnown(sent.call_id, 7).state).toBe("settled");
  });

  it("keeps an identical job id independent across two accounts", () => {
    const { spending, control } = setup();
    const a = accountWith(spending, control, {
      allowance_micro_usd: 20,
      service_micro_usd: 1000,
      per_job_micro_usd: 100,
      user_daily_micro_usd: 100,
    });
    const b = accountWith(spending, control, {
      allowance_micro_usd: 20,
      service_micro_usd: 1000,
      per_job_micro_usd: 100,
      user_daily_micro_usd: 100,
    });
    spending.reserve(specFor(a.account.id, 7, { job_id: "same-job" }));
    const second = spending.reserve(specFor(b.account.id, 7, { job_id: "same-job" }));
    expect(second.account_id).toBe(b.account.id);
    expect(second.state).toBe("reserved");
  });

  it("shares one global service cap across two different accounts", () => {
    const { spending, control } = setup();
    const a = accountWith(spending, control, {
      allowance_micro_usd: 20,
      service_micro_usd: 10,
      per_job_micro_usd: 100,
      user_daily_micro_usd: 100,
    });
    const b = accountWith(spending, control, {
      allowance_micro_usd: 20,
      service_micro_usd: 10,
      per_job_micro_usd: 100,
      user_daily_micro_usd: 100,
    });
    spending.reserve(specFor(a.account.id, 7, { job_id: "global-a" }));
    expectCode(
      () => spending.reserve(specFor(b.account.id, 7, { job_id: "global-b" })),
      "BUDGET_EXHAUSTED",
    );
  });

  it("returns the stored slot for an identical reserve and conflicts on any change", () => {
    const { spending, control } = setup();
    const { account } = accountWith(spending, control, {
      allowance_micro_usd: 100,
      service_micro_usd: 100,
      per_job_micro_usd: 100,
      user_daily_micro_usd: 100,
    });
    const first = spending.reserve(specFor(account.id, 7, { job_id: "dup" }));
    const same = spending.reserve(specFor(account.id, 7, { job_id: "dup" }));
    expect(same.call_id).toBe(first.call_id);
    expectCode(
      () => spending.reserve(specFor(account.id, 8, { job_id: "dup" })),
      "DISPATCH_CONFLICT",
    );
    expectCode(
      () =>
        spending.reserve(
          specFor(account.id, 7, { job_id: "dup", request_hash: sha("changed") }),
        ),
      "DISPATCH_CONFLICT",
    );
    expectCode(
      () =>
        spending.reserve(
          specFor(account.id, 7, {
            job_id: "dup",
            limits: limits({ per_job_micro_usd: 9 }),
          }),
        ),
      "DISPATCH_CONFLICT",
    );
    expect(
      control.db
        .prepare("SELECT count(*) AS n FROM managed_reservations")
        .get()!.n,
    ).toBe(1);
  });

  it("returns the stored hold for a repeat after a rollover instead of new money", () => {
    const { spending, control } = setup();
    const { account } = accountWith(spending, control);
    const first = spending.reserve(specFor(account.id, 7, { job_id: "slot" }));
    current = "2026-10-17T09:00:00Z";
    const again = spending.reserve(specFor(account.id, 7, { job_id: "slot" }));
    expect(again.call_id).toBe(first.call_id);
    expect(again.service_day).toBe("2026-10-16");
    expect(
      control.db
        .prepare("SELECT count(*) AS n FROM managed_reservations")
        .get()!.n,
    ).toBe(1);
  });

  it("refuses a mark on an expired period, UTC service day or user day", () => {
    const { spending, control } = setup();

    const periodAccount = accountWith(spending, control, {
      allowance_micro_usd: 100,
      service_micro_usd: 100,
      per_job_micro_usd: 100,
      user_daily_micro_usd: 100,
    });
    const periodCall = spending.reserve(specFor(periodAccount.account.id, 7));
    current = "2026-10-17T09:00:00Z";
    expectCode(() => spending.mark(periodCall.call_id, limits()), "PERIOD_EXPIRED");

    current = "2026-10-16T23:00:00Z";
    const dayAccount = accountWith(spending, control, {
      allowance_micro_usd: 100,
      service_micro_usd: 100,
      per_job_micro_usd: 100,
      user_daily_micro_usd: 100,
      ends_at: "2026-10-18T00:00:00Z",
    });
    const dayCall = spending.reserve(specFor(dayAccount.account.id, 7));
    expect(dayCall.service_day).toBe("2026-10-16");
    current = "2026-10-17T00:01:00Z";
    expectCode(() => spending.mark(dayCall.call_id, limits()), "PERIOD_EXPIRED");

    current = "2026-10-16T17:00:00Z";
    const tzAccount = accountWith(spending, control, {
      allowance_micro_usd: 100,
      service_micro_usd: 100,
      per_job_micro_usd: 100,
      user_daily_micro_usd: 100,
    });
    const tzCall = spending.reserve(
      specFor(tzAccount.account.id, 7, {
        limits: limits({ time_zone: "Asia/Calcutta" }),
      }),
    );
    expect(tzCall.user_day).toBe("2026-10-16");
    current = "2026-10-16T19:00:00Z";
    expectCode(
      () =>
        spending.mark(
          tzCall.call_id,
          limits({ time_zone: "Asia/Calcutta" }),
        ),
      "PERIOD_EXPIRED",
    );
  });

  it("records an overrun, blocks the service and reports the reason", () => {
    const { spending, control } = setup();
    const { account } = accountWith(spending, control, {
      allowance_micro_usd: 100,
      service_micro_usd: 100,
      per_job_micro_usd: 100,
      user_daily_micro_usd: 100,
    });
    const row = spending.reserve(specFor(account.id, 7, { job_id: "over" }));
    spending.mark(row.call_id, limits());
    expect(spending.settleKnown(row.call_id, 12).actual_micro_usd).toBe(12);
    expectCode(
      () => spending.reserve(specFor(account.id, 1, { job_id: "after" })),
      "BUDGET_BLOCKED",
    );
    const status = spending.accountStatus(account.id);
    expect(status.blocked).toBe(true);
    expect(status.blocked_reason).toBe("overrun");
  });

  it("checks fixed money instead of wrapping at the safe-integer boundary", () => {
    const { spending, control } = setup();
    const { account } = accountWith(spending, control, {
      allowance_micro_usd: Number.MAX_SAFE_INTEGER,
      service_micro_usd: Number.MAX_SAFE_INTEGER,
      per_job_micro_usd: Number.MAX_SAFE_INTEGER,
      user_daily_micro_usd: Number.MAX_SAFE_INTEGER,
    });
    spending.reserve(
      specFor(account.id, Number.MAX_SAFE_INTEGER, {
        job_id: "max",
        limits: limits({
          per_job_micro_usd: Number.MAX_SAFE_INTEGER,
          user_daily_micro_usd: Number.MAX_SAFE_INTEGER,
        }),
      }),
    );
    expectCode(
      () =>
        spending.reserve(
          specFor(account.id, 1, {
            job_id: "plus",
            limits: limits({
              per_job_micro_usd: Number.MAX_SAFE_INTEGER,
              user_daily_micro_usd: Number.MAX_SAFE_INTEGER,
            }),
          }),
        ),
      "SPEND_OVERFLOW",
    );
  });

  it("canonicalizes instants and rejects an overlapping window expressed differently", () => {
    const { spending, control } = setup();
    const account = control.provision(ISSUER, "subject-iso");
    const period = spending.configureAccountPeriod({
      account_id: account.id,
      starts_at: "2026-10-16T05:30:00+05:30",
      ends_at: "2026-10-17T05:30:00+05:30",
      allowance_micro_usd: 10,
    });
    expect(period.starts_at).toBe("2026-10-16T00:00:00.000Z");
    expectCode(
      () =>
        spending.configureAccountPeriod({
          account_id: account.id,
          starts_at: "2026-10-16T01:00:00Z",
          ends_at: "2026-10-16T02:00:00Z",
          allowance_micro_usd: 10,
        }),
      "PERIOD_CONFLICT",
    );
  });

  it("freezes the accounting zone on the first successful admission, not a failure", () => {
    const { spending, control } = setup();
    const { account } = accountWith(spending, control, {
      allowance_micro_usd: 20,
      service_micro_usd: 10,
      per_job_micro_usd: 0,
      user_daily_micro_usd: 0,
    });
    expectCode(
      () =>
        spending.reserve(
          specFor(account.id, 7, {
            limits: limits({ time_zone: "Asia/Calcutta" }),
          }),
        ),
      "BUDGET_EXHAUSTED",
    );
    expect(spending.accountStatus(account.id).policy!.accounting_tz).toBeNull();

    spending.setAccountPolicy({
      account_id: account.id,
      per_job_micro_usd: 100,
      user_daily_micro_usd: 100,
    });
    spending.reserve(specFor(account.id, 7));
    expect(spending.accountStatus(account.id).policy!.accounting_tz).toBe("UTC");
    expectCode(
      () =>
        spending.reserve(
          specFor(account.id, 7, {
            limits: limits({ time_zone: "Asia/Calcutta" }),
          }),
        ),
      "ACCOUNTING_TIMEZONE_FROZEN",
    );
  });

  it("never stores a source body, prompt or key column", () => {
    const { control } = setup();
    const columns = (
      control.db.prepare("PRAGMA table_info(managed_reservations)").all() as {
        name: string;
      }[]
    ).map((column) => column.name);
    for (const forbidden of ["body", "prompt", "key", "evidence", "output"])
      expect(columns).not.toContain(forbidden);
  });

  it("refuses a newer money schema and preserves the identity tables", () => {
    const { control } = setup();
    const account = control.provision(ISSUER, "subject-guard");
    const session = control.issueSession(account.id);
    control.db.exec(
      "INSERT INTO managed_money_schema(version,applied_at) VALUES(2,'2026-10-16T00:00:00Z')",
    );
    expect(() => new ManagedSpendingStore(control, clock)).toThrow(
      "newer version",
    );
    expect(control.account(account.id)?.id).toBe(account.id);
    expect(control.resolveSession(session.token)?.account_id).toBe(account.id);
  });

  it("denies a reserve with a zero estimate when any one cap is zero", () => {
    const { spending, control } = setup();
    const cases: Partial<Grant>[] = [
      { per_job_micro_usd: 0 },
      { user_daily_micro_usd: 0 },
      { allowance_micro_usd: 0 },
      { service_micro_usd: 0 },
    ];
    for (const over of cases) {
      const { account } = accountWith(spending, control, {
        allowance_micro_usd: 100,
        service_micro_usd: 100,
        per_job_micro_usd: 100,
        user_daily_micro_usd: 100,
        ...over,
      });
      expectCode(
        () => spending.reserve(specFor(account.id, 0, { limits: limits() })),
        "BUDGET_EXHAUSTED",
      );
    }
  });

  it("admits a legitimate zero estimate under positive caps", () => {
    const { spending, control } = setup();
    const { account } = accountWith(spending, control, {
      allowance_micro_usd: 20,
      service_micro_usd: 10,
      per_job_micro_usd: 10,
      user_daily_micro_usd: 10,
    });
    const row = spending.reserve(specFor(account.id, 0));
    expect(row.state).toBe("reserved");
    expect(row.reserved_micro_usd).toBe(0);
  });

  it("denies a mark once any cap is lowered to zero, even for a zero estimate", () => {
    const { spending, control } = setup();

    const perJob = accountWith(spending, control, {
      allowance_micro_usd: 100,
      service_micro_usd: 100,
      per_job_micro_usd: 100,
      user_daily_micro_usd: 100,
    });
    const perJobCall = spending.reserve(specFor(perJob.account.id, 7));
    expectCode(
      () => spending.mark(perJobCall.call_id, limits({ per_job_micro_usd: 0 })),
      "BUDGET_EXHAUSTED",
    );

    const userCap = accountWith(spending, control, {
      allowance_micro_usd: 100,
      service_micro_usd: 100,
      per_job_micro_usd: 100,
      user_daily_micro_usd: 100,
    });
    const userCall = spending.reserve(specFor(userCap.account.id, 7));
    expectCode(
      () =>
        spending.mark(userCall.call_id, limits({ user_daily_micro_usd: 0 })),
      "BUDGET_EXHAUSTED",
    );

    // Parent case: a zero estimate admitted under a positive policy must be
    // refused once the service cap becomes zero.
    const serviceCap = accountWith(spending, control, {
      allowance_micro_usd: 100,
      service_micro_usd: 100,
      per_job_micro_usd: 100,
      user_daily_micro_usd: 100,
    });
    const zeroCall = spending.reserve(specFor(serviceCap.account.id, 0));
    spending.setServicePolicy({ daily_micro_usd: 0 });
    expectCode(
      () => spending.mark(zeroCall.call_id, limits()),
      "BUDGET_EXHAUSTED",
    );
  });

  it("rejects date-only, offset-less, locale and impossible period instants", () => {
    const { spending, control } = setup();
    const account = control.provision(ISSUER, "subject-instant");
    for (const bad of [
      "2026-10-16",
      "2026-10-16T00:00:00",
      "Oct 16 2026",
      "2026-02-30T00:00:00Z",
    ]) {
      expectCode(
        () =>
          spending.configureAccountPeriod({
            account_id: account.id,
            starts_at: bad,
            ends_at: "2026-10-17T00:00:00Z",
            allowance_micro_usd: 10,
          }),
        "INVALID_INPUT",
      );
    }
    const accepted = spending.configureAccountPeriod({
      account_id: account.id,
      starts_at: "2026-10-16T00:00:00+00:00",
      ends_at: "2026-10-17T05:30:00+05:30",
      allowance_micro_usd: 10,
    });
    expect(accepted.starts_at).toBe("2026-10-16T00:00:00.000Z");
    expect(accepted.ends_at).toBe("2026-10-17T00:00:00.000Z");
  });
});
