import { afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStore } from "../../packages/storage/control.ts";
import { ManagedSpendingStore } from "../../packages/storage/managed-spending.ts";
import { ManagedReconciliationStore } from "../../packages/storage/managed-reconciliation.ts";
import type { ManagedDispatchSpec, ManagedLimits } from "../../packages/domain/managed-spend.ts";

/**
 * Operator-attested reconciliation (Task 2).
 *
 * Attestations are external-actor claims bound to one exact dispatch identity —
 * audit provenance, not cryptographic verification. A resolution proof and its
 * money mutation commit in one owned transaction; a conflict appends a dispute
 * and a global block rather than rewriting immutable money.
 */

const ISSUER = "https://synthetic.example.test";
const clock = () => new Date("2026-10-16T09:00:00Z");
const roots: string[] = [];
const controls: ControlStore[] = [];

const limits: ManagedLimits = {
  per_job_micro_usd: 100000,
  user_daily_micro_usd: 100000,
  time_zone: "UTC",
};

afterEach(() => {
  for (const control of controls.splice(0)) {
    try {
      control.close();
    } catch {}
  }
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "bibrain-recon-"));
  roots.push(root);
  const control = new ControlStore(join(root, "control.sqlite"), clock);
  controls.push(control);
  const spending = new ManagedSpendingStore(control, clock);
  const account = control.provision(ISSUER, "recon-a");
  control.provision(ISSUER, "recon-b");
  spending.setServicePolicy({ daily_micro_usd: 100000 });
  spending.setAccountPolicy({
    account_id: account.id,
    per_job_micro_usd: 100000,
    user_daily_micro_usd: 100000,
  });
  spending.configureAccountPeriod({
    account_id: account.id,
    starts_at: "2026-10-16T00:00:00Z",
    ends_at: "2026-10-18T00:00:00Z",
    allowance_micro_usd: 100000,
  });
  const recon = new ManagedReconciliationStore(control, root, clock);
  recon.initEpoch({ offline: true, workers_terminated: true });
  return { root, control, spending, account, recon };
}

function dispatched(
  f: ReturnType<typeof setup>,
  amount = 10,
): ReturnType<ManagedSpendingStore["reserve"]> {
  const spec: ManagedDispatchSpec = {
    account_id: f.account.id,
    job_id: randomUUID(),
    dispatch_key: "reasoning",
    stage: "reasoning",
    reserved_micro_usd: amount,
    provider: "synthetic",
    model: "synthetic",
    price_version: "synthetic-v1",
    request_hash: "a".repeat(64),
    config_hash: "b".repeat(64),
    limits,
  };
  const rec = f.spending.reserve(spec);
  f.spending.mark(rec.call_id, limits);
  return rec;
}

function attestation(
  f: ReturnType<typeof setup>,
  rec: { call_id: string; identity_hash: string; provider: string; model: string; price_version: string; request_hash: string; config_hash: string },
  over: Record<string, unknown> = {},
) {
  return {
    resolution_id: randomUUID(),
    kind: "settled",
    account_id: f.account.id,
    call_id: rec.call_id,
    identity_hash: rec.identity_hash,
    provider: rec.provider,
    model: rec.model,
    price_version: rec.price_version,
    request_hash: rec.request_hash,
    config_hash: rec.config_hash,
    expected_state: "dispatched",
    expected_actual_micro_usd: null,
    cost_micro_usd: 7,
    currency: "USD",
    provider_request_id: "provider-request-1",
    evidence_digest: "c".repeat(64),
    method: "usage_response",
    actor: "operator",
    checked_at: "2026-10-16T09:00:00Z",
    epoch: 1,
    ...over,
  };
}

const ACK = { offline: true, workers_terminated: true };

it("requires the strict offline acknowledgement at the store boundary", () => {
  const f = setup();
  const rec = dispatched(f);
  const input = attestation(f, rec);
  expect(() => f.recon.attestSettled(input, undefined)).toThrow();
  expect(() => f.recon.attestSettled(input, { offline: true })).toThrow();
  expect(() =>
    f.recon.attestSettled(input, { offline: true, workers_terminated: false }),
  ).toThrow();
  expect(() => f.recon.attestZero(input, null)).toThrow();
  expect(() => f.recon.initEpoch({ offline: false })).toThrow();
  expect(f.recon.readResolution(input.resolution_id as string)).toBeUndefined();
  expect(f.spending.readReceipt(rec.call_id)).toMatchObject({
    state: "dispatched",
  });
});

it("requires USD, a safe-integer cost, an explicit expected shape and a strict kind", () => {
  const f = setup();
  const rec = dispatched(f);
  for (const bad of [
    { currency: "GBP" },
    { currency: undefined },
    { cost_micro_usd: 7.5 },
    { cost_micro_usd: 0 },
    { kind: "zero" },
    { expected_state: "dispatched", expected_actual_micro_usd: 5 },
    { epoch: 0 },
    { checked_at: "2026-10-16" },
  ]) {
    expect(() => f.recon.attestSettled(attestation(f, rec, bad), ACK)).toThrow();
  }
  expect(f.spending.readReceipt(rec.call_id)).toMatchObject({
    state: "dispatched",
  });
  expect(
    f.control.db.prepare("SELECT count(*) AS n FROM managed_resolutions").get()!.n,
  ).toBe(0);
});

it("rejects an identity, expected-state, cost or epoch mismatch without mutation", () => {
  const f = setup();
  const rec = dispatched(f);
  expect(() => f.recon.attestSettled(attestation(f, rec, { model: "other" }), ACK)).toThrow();
  expect(() =>
    f.recon.attestSettled(attestation(f, rec, { expected_actual_micro_usd: 5 }), ACK),
  ).toThrow();
  expect(() => f.recon.attestSettled(attestation(f, rec, { epoch: 2 }), ACK)).toThrow();
  expect(f.spending.readReceipt(rec.call_id)).toMatchObject({
    state: "dispatched",
    actual_micro_usd: null,
  });
});

it("never attests a reserved, never-sent call", () => {
  const f = setup();
  const spec: ManagedDispatchSpec = {
    account_id: f.account.id,
    job_id: randomUUID(),
    dispatch_key: "reasoning",
    stage: "reasoning",
    reserved_micro_usd: 10,
    provider: "synthetic",
    model: "synthetic",
    price_version: "synthetic-v1",
    request_hash: "a".repeat(64),
    config_hash: "b".repeat(64),
    limits,
  };
  const rec = f.spending.reserve(spec);
  expect(() => f.recon.attestSettled(attestation(f, rec), ACK)).toThrow();
  expect(f.spending.readReceipt(rec.call_id)).toMatchObject({ state: "reserved" });
});

it("settles a dispatched call and records the proof in one transaction", () => {
  const f = setup();
  const rec = dispatched(f);
  const input = attestation(f, rec);
  const resolution = f.recon.attestSettled(input, ACK);
  expect(resolution).toMatchObject({
    kind: "settled",
    cost_micro_usd: 7,
    currency: "USD",
    epoch: 1,
  });
  expect(f.spending.readReceipt(rec.call_id)).toMatchObject({
    state: "settled",
    actual_micro_usd: 7,
  });
  expect(f.spending.accountStatus(f.account.id).blocked).toBe(false);
});

it("is idempotent for an identical repeat and conflicts on a changed binding", () => {
  const f = setup();
  const rec = dispatched(f);
  const input = attestation(f, rec);
  const first = f.recon.attestSettled(input, ACK);
  expect(f.recon.attestSettled(input, ACK)).toEqual(first);
  expect(() =>
    f.recon.attestSettled({ ...input, actor: "someone-else" }, ACK),
  ).toThrow();
  expect(
    f.control.db.prepare("SELECT count(*) AS n FROM managed_resolutions").get()!.n,
  ).toBe(1);
});

it("checks the control generation before an idempotent return", () => {
  const f = setup();
  const rec = dispatched(f);
  const input = attestation(f, rec);
  f.recon.attestSettled(input, ACK);
  // Break the generation: the proof exists, but the epoch must be checked first.
  f.control.db.prepare("DELETE FROM managed_control_epoch").run();
  expect(() => f.recon.attestSettled(input, ACK)).toThrow();
  expect(f.recon.readResolution(input.resolution_id as string)).toBeDefined();
});

it("records an idempotent proof for a new id with the same known cost", () => {
  const f = setup();
  const rec = dispatched(f);
  f.recon.attestSettled(attestation(f, rec), ACK);
  const second = attestation(f, rec, {
    expected_state: "settled",
    expected_actual_micro_usd: 7,
    cost_micro_usd: 7,
  });
  const resolution = f.recon.attestSettled(second, ACK);
  expect(resolution).toMatchObject({ kind: "settled", cost_micro_usd: 7 });
  expect(f.spending.readReceipt(rec.call_id)).toMatchObject({
    state: "settled",
    actual_micro_usd: 7,
  });
  expect(() =>
    f.recon.attestSettled(attestation(f, rec), ACK),
  ).toThrow();
});

it("appends a dispute and a global block on a conflicting settled amount, keeping the old actual", () => {
  const f = setup();
  const rec = dispatched(f);
  f.recon.attestSettled(attestation(f, rec), ACK);
  const conflict = attestation(f, rec, {
    expected_state: "settled",
    expected_actual_micro_usd: 7,
    cost_micro_usd: 9,
  });
  const dispute = f.recon.attestSettled(conflict, ACK);
  expect(dispute).toMatchObject({ kind: "dispute", cost_micro_usd: 9 });
  expect(f.spending.readReceipt(rec.call_id)).toMatchObject({
    state: "settled",
    actual_micro_usd: 7,
  });
  expect(f.spending.accountStatus(f.account.id)).toMatchObject({
    blocked: true,
    blocked_reason: "disputed_usage",
  });
});

it("supports an explicit operator-attested zero on a sent call", () => {
  const f = setup();
  const rec = dispatched(f);
  const zero = attestation(f, rec, {
    kind: "zero",
    cost_micro_usd: 0,
    method: "call_statement",
  });
  expect(f.recon.attestZero(zero, ACK)).toMatchObject({ kind: "zero", cost_micro_usd: 0 });
  expect(f.spending.readReceipt(rec.call_id)).toMatchObject({
    state: "settled",
    actual_micro_usd: 0,
  });
});

it("settles a known charge after the account is revoked", () => {
  const f = setup();
  const rec = dispatched(f);
  f.control.setAccountState(f.account.id, "suspended");
  expect(f.recon.attestSettled(attestation(f, rec), ACK)).toMatchObject({
    kind: "settled",
    cost_micro_usd: 7,
  });
  expect(f.spending.readReceipt(rec.call_id)).toMatchObject({ state: "settled" });
});

it("rolls back the money mutation when the proof write fails, and the proof when money fails", () => {
  const f = setup();
  const moneyFail = dispatched(f);
  f.control.db.exec(
    "CREATE TRIGGER money_fault BEFORE UPDATE OF state ON managed_reservations WHEN NEW.state='settled' BEGIN SELECT RAISE(ABORT,'synthetic money fault'); END",
  );
  expect(() => f.recon.attestSettled(attestation(f, moneyFail), ACK)).toThrow();
  f.control.db.exec("DROP TRIGGER money_fault");
  expect(f.spending.readReceipt(moneyFail.call_id)).toMatchObject({
    state: "dispatched",
  });
  // Clear the durable barrier with an ordinary known settle before the next hold.
  f.spending.settleKnown(moneyFail.call_id, 7);
  expect(
    f.control.db.prepare("SELECT count(*) AS n FROM managed_resolutions").get()!.n,
  ).toBe(0);

  const proofFail = dispatched(f);
  f.control.db.exec(
    "CREATE TRIGGER proof_fault BEFORE INSERT ON managed_resolutions BEGIN SELECT RAISE(ABORT,'synthetic proof fault'); END",
  );
  expect(() => f.recon.attestSettled(attestation(f, proofFail), ACK)).toThrow();
  f.control.db.exec("DROP TRIGGER proof_fault");
  expect(f.spending.readReceipt(proofFail.call_id)).toMatchObject({
    state: "dispatched",
    actual_micro_usd: null,
  });
});

it("does not leave a dispute block when its proof write fails", () => {
  const f = setup();
  const rec = dispatched(f);
  f.recon.attestSettled(attestation(f, rec), ACK);
  f.control.db.exec(
    "CREATE TRIGGER proof_fault BEFORE INSERT ON managed_resolutions BEGIN SELECT RAISE(ABORT,'synthetic proof fault'); END",
  );
  const conflict = attestation(f, rec, {
    expected_state: "settled",
    expected_actual_micro_usd: 7,
    cost_micro_usd: 9,
  });
  expect(() => f.recon.attestSettled(conflict, ACK)).toThrow();
  f.control.db.exec("DROP TRIGGER proof_fault");
  expect(
    f.control.db.prepare("SELECT count(*) AS n FROM managed_money_blocks").get()!.n,
  ).toBe(0);
});

it("makes resolutions immutable against update and delete", () => {
  const f = setup();
  const rec = dispatched(f);
  const input = attestation(f, rec);
  f.recon.attestSettled(input, ACK);
  expect(() =>
    f.control.db
      .prepare("UPDATE managed_resolutions SET actor='x' WHERE resolution_id=?")
      .run(input.resolution_id as string),
  ).toThrow();
  expect(() =>
    f.control.db
      .prepare("DELETE FROM managed_resolutions WHERE resolution_id=?")
      .run(input.resolution_id as string),
  ).toThrow();
});

it("refuses an out-of-transaction seam write and rolls back nested or async callbacks", () => {
  const f = setup();
  const rec = dispatched(f);
  expect(() => f.spending.settleKnownWithinTx(rec.call_id, 7)).toThrow();
  expect(f.spending.readReceipt(rec.call_id)).toMatchObject({ state: "dispatched" });

  expect(() =>
    f.spending.transaction(() => f.spending.transaction(() => 1)),
  ).toThrow();
  expect(() => f.spending.transaction(async () => 1)).toThrow();
  expect(f.spending.readReceipt(rec.call_id)).toMatchObject({ state: "dispatched" });
});

it("stores only opaque ids and hashes, with the currency column persisted", () => {
  const f = setup();
  const columns = (
    f.control.db.prepare("PRAGMA table_info(managed_resolutions)").all() as {
      name: string;
    }[]
  ).map((column) => column.name);
  for (const forbidden of ["body", "prompt", "key", "text", "note"])
    expect(columns).not.toContain(forbidden);
  expect(columns).toContain("currency");
  expect(columns).toContain("evidence_digest");
  for (const table of [
    "managed_resolutions",
    "managed_control_epoch",
    "managed_audits",
    "managed_audit_accounts",
  ])
    expect(
      f.control.db
        .prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?")
        .get(table),
    ).toBeTruthy();
});

it("rejects free-form or multiline actor metadata and stores no proof text", () => {
  const f = setup();
  const rec = dispatched(f);
  const multiline = attestation(f, rec, {
    actor: "SYNTHETIC_PRIVATE_SOURCE_BODY\nnot-opaque",
  });
  expect(() => f.recon.attestSettled(multiline, ACK)).toThrow();
  const tooLong = attestation(f, rec, { actor: "a".repeat(121) });
  expect(() => f.recon.attestSettled(tooLong, ACK)).toThrow();
  const spaced = attestation(f, rec, { actor: "operator name" });
  expect(() => f.recon.attestSettled(spaced, ACK)).toThrow();
  expect(f.spending.readReceipt(rec.call_id)).toMatchObject({
    state: "dispatched",
    actual_micro_usd: null,
  });
  expect(
    f.control.db.prepare("SELECT count(*) AS n FROM managed_resolutions").get()!.n,
  ).toBe(0);
});

it("requires a non-blank bounded provider correlation identifier", () => {
  const f = setup();
  const rec = dispatched(f);
  for (const bad of [" \t ", "", "has space", "ctrl\u0001char", "x".repeat(201)]) {
    expect(() =>
      f.recon.attestSettled(
        attestation(f, rec, { provider_request_id: bad }),
        ACK,
      ),
    ).toThrow();
  }
  const ok = attestation(f, rec, {
    provider_request_id: "req_2026-10-16/abc:def+1=2",
  });
  expect(f.recon.attestSettled(ok, ACK)).toMatchObject({ kind: "settled" });
});

it("refuses a settlement whose update was ignored and records no proof", () => {
  const f = setup();
  const rec = dispatched(f);
  f.control.db.exec(
    "CREATE TRIGGER ignored_settlement BEFORE UPDATE OF state ON managed_reservations WHEN NEW.state='settled' BEGIN SELECT RAISE(IGNORE); END",
  );
  expect(() => f.recon.attestSettled(attestation(f, rec), ACK)).toThrow();
  f.control.db.exec("DROP TRIGGER ignored_settlement");
  expect(f.spending.readReceipt(rec.call_id)).toMatchObject({
    state: "dispatched",
    actual_micro_usd: null,
  });
  expect(
    f.control.db.prepare("SELECT count(*) AS n FROM managed_resolutions").get()!.n,
  ).toBe(0);
});
