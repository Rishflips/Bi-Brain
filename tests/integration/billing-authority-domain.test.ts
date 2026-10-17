import { describe, it, expect } from "vitest";
import {
  BILLING_FRESHNESS_MAX_MS,
  BILLING_MAX_FRAME_BYTES,
  BILLING_MAX_SOURCE_IDS,
  billingWindow,
  windowId,
  clampAddMonths,
  paidTermFreshUntil,
  admissionExpiresAt,
  validateStoredPaidTermReference,
} from "../../packages/domain/billing-authority.ts";
import {
  canonicalSealFrame,
  sealMac,
  verifySealMac,
} from "../../packages/domain/billing-seal.ts";

/**
 * T1 domain gate — SYNTHETIC fixtures only. No network, credentials or real keys.
 * These tests are written FIRST; the modules do not exist yet, so the run is RED.
 * Expected values are hand-derived literals (never computed by the code under test).
 */

const ACCOUNT = "3f1c2e4a-9b7d-4c1e-8f2a-000000000001";
const SUB = "syn-sub-1";
const H1 = "a".repeat(64);
const H2 = "b".repeat(64);
const KEY = new Uint8Array(32).fill(7);

function windowArgs(over: Partial<Record<string, unknown>> = {}) {
  return {
    account_id: ACCOUNT,
    subscription_ref: SUB,
    paid_term_start: "2027-01-31T00:00:00.000Z",
    window_start: "2027-01-31T00:00:00.000Z",
    window_end: "2027-02-28T00:00:00.000Z",
    ...over,
  };
}

describe("clampAddMonths", () => {
  it("preserves the original UTC millisecond time", () => {
    expect(clampAddMonths("2027-01-31T13:45:30.123Z", 1)).toBe(
      "2027-02-28T13:45:30.123Z",
    );
    expect(clampAddMonths("2027-01-31T13:45:30.123Z", 0)).toBe(
      "2027-01-31T13:45:30.123Z",
    );
  });

  it("clamps Jan31 -> Feb28 -> Mar31 without drift and handles leaps", () => {
    expect(clampAddMonths("2027-01-31T00:00:00.000Z", 1)).toBe(
      "2027-02-28T00:00:00.000Z",
    );
    expect(clampAddMonths("2027-01-31T00:00:00.000Z", 2)).toBe(
      "2027-03-31T00:00:00.000Z",
    );
    expect(clampAddMonths("2028-01-31T00:00:00.000Z", 1)).toBe(
      "2028-02-29T00:00:00.000Z",
    );
  });

  it("handles century leap rules", () => {
    expect(clampAddMonths("2100-01-31T00:00:00.000Z", 1)).toBe(
      "2100-02-28T00:00:00.000Z",
    );
    expect(clampAddMonths("2000-01-31T00:00:00.000Z", 1)).toBe(
      "2000-02-29T00:00:00.000Z",
    );
    expect(clampAddMonths("1900-01-31T00:00:00.000Z", 1)).toBe(
      "1900-02-28T00:00:00.000Z",
    );
  });

  it("handles years 0001..0099 without the JS 0..99 year gotcha", () => {
    expect(clampAddMonths("0001-01-31T00:00:00.000Z", 1)).toBe(
      "0001-02-28T00:00:00.000Z",
    );
    expect(clampAddMonths("0004-01-31T00:00:00.000Z", 1)).toBe(
      "0004-02-29T00:00:00.000Z",
    );
    expect(clampAddMonths("0099-01-31T00:00:00.000Z", 1)).toBe(
      "0099-02-28T00:00:00.000Z",
    );
  });

  it("accepts only integer months 0..12", () => {
    expect(() => clampAddMonths("2027-01-31T00:00:00.000Z", 13)).toThrow();
    expect(() => clampAddMonths("2027-01-31T00:00:00.000Z", -1)).toThrow();
    expect(() => clampAddMonths("2027-01-31T00:00:00.000Z", 1.5)).toThrow();
    expect(() => clampAddMonths("2027-01-31T00:00:00.000Z", Number.NaN)).toThrow();
  });

  it("rejects non-canonical or Date-normalized instants", () => {
    expect(() => clampAddMonths("2027-02-30T00:00:00.000Z", 1)).toThrow();
    expect(() => clampAddMonths("0000-01-01T00:00:00.000Z", 1)).toThrow();
    expect(() => clampAddMonths("2027-01-31T00:00:00+00:00", 1)).toThrow();
    expect(() => clampAddMonths("2027-01-31T00:00:00Z", 1)).toThrow();
    expect(() => clampAddMonths("2027-01-31", 1)).toThrow();
  });
});

describe("windowId", () => {
  it("is a stable hex64 for the same input and mutates no frozen input", () => {
    const args = Object.freeze(windowArgs());
    const first = windowId(args);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(windowId(args)).toBe(first);
  });

  it("changes when any identity component changes, including a new annual year", () => {
    const base = windowId(windowArgs());
    expect(windowId(windowArgs({ account_id: "3f1c2e4a-9b7d-4c1e-8f2a-000000000002" }))).not.toBe(base);
    expect(windowId(windowArgs({ subscription_ref: "syn-sub-2" }))).not.toBe(base);
    expect(
      windowId(
        windowArgs({
          paid_term_start: "2028-01-31T00:00:00.000Z",
          window_start: "2028-01-31T00:00:00.000Z",
          window_end: "2028-02-29T00:00:00.000Z",
        }),
      ),
    ).not.toBe(base);
    expect(windowId(windowArgs({ window_end: "2027-03-01T00:00:00.000Z" }))).not.toBe(base);
  });

  it("rejects unknown keys and out-of-range windows", () => {
    expect(() => windowId(windowArgs({ policy_id: "ignored" }))).toThrow();
    expect(() => windowId(windowArgs({ transaction_ref: "ignored" }))).toThrow();
    expect(() => windowId(windowArgs({ window_start: "2027-01-01T00:00:00.000Z" }))).toThrow();
    expect(() => windowId(windowArgs({ window_end: "2027-01-31T00:00:00.000Z" }))).toThrow();
  });
});

describe("billingWindow", () => {
  it("returns the exact provider monthly period, index 0", () => {
    const args = {
      account_id: ACCOUNT,
      subscription_ref: SUB,
      cadence: "monthly" as const,
      paid_term_start: "2027-02-28T00:00:00.000Z",
      paid_term_end: "2027-03-31T00:00:00.000Z",
      now: new Date("2027-03-10T00:00:00Z"),
    };
    const result = billingWindow(args);
    expect(result.state).toBe("window");
    if (result.state !== "window") throw new Error("expected window");
    expect(result.window.window_start).toBe(args.paid_term_start);
    expect(result.window.window_end).toBe(args.paid_term_end);
    expect(result.window.index).toBe(0);
    expect(result.window.window_id).toBe(
      windowId({
        account_id: args.account_id,
        subscription_ref: args.subscription_ref,
        paid_term_start: args.paid_term_start,
        window_start: args.paid_term_start,
        window_end: args.paid_term_end,
      }),
    );
  });

  it("returns all 12 annual windows half-open with no 13th", () => {
    const start = "2027-01-31T00:00:00.000Z";
    const termEnd = "2028-01-31T00:00:00.000Z";
    const table: Array<[string, string, number]> = [
      ["2027-01-31T00:00:00.000Z", "2027-02-28T00:00:00.000Z", 0],
      ["2027-02-28T00:00:00.000Z", "2027-03-31T00:00:00.000Z", 1],
      ["2027-03-31T00:00:00.000Z", "2027-04-30T00:00:00.000Z", 2],
      ["2027-04-30T00:00:00.000Z", "2027-05-31T00:00:00.000Z", 3],
      ["2027-05-31T00:00:00.000Z", "2027-06-30T00:00:00.000Z", 4],
      ["2027-06-30T00:00:00.000Z", "2027-07-31T00:00:00.000Z", 5],
      ["2027-07-31T00:00:00.000Z", "2027-08-31T00:00:00.000Z", 6],
      ["2027-08-31T00:00:00.000Z", "2027-09-30T00:00:00.000Z", 7],
      ["2027-09-30T00:00:00.000Z", "2027-10-31T00:00:00.000Z", 8],
      ["2027-10-31T00:00:00.000Z", "2027-11-30T00:00:00.000Z", 9],
      ["2027-11-30T00:00:00.000Z", "2027-12-31T00:00:00.000Z", 10],
      ["2027-12-31T00:00:00.000Z", "2028-01-31T00:00:00.000Z", 11],
    ];
    for (const [wStart, wEnd, index] of table) {
      const result = billingWindow({
        account_id: ACCOUNT,
        subscription_ref: SUB,
        cadence: "annual",
        paid_term_start: start,
        paid_term_end: termEnd,
        now: new Date(new Date(wStart).getTime() + 1000),
      });
      expect(result.state).toBe("window");
      if (result.state !== "window") throw new Error("expected window");
      expect([result.window.window_start, result.window.window_end, result.window.index]).toEqual([
        wStart,
        wEnd,
        index,
      ]);
    }
    expect(
      billingWindow({
        account_id: ACCOUNT,
        subscription_ref: SUB,
        cadence: "annual",
        paid_term_start: start,
        paid_term_end: termEnd,
        now: new Date(termEnd),
      }),
    ).toEqual({ state: "unavailable", reason: "no_grant" });
  });

  it("clips the final window of a shortened annual term", () => {
    const result = billingWindow({
      account_id: ACCOUNT,
      subscription_ref: SUB,
      cadence: "annual",
      paid_term_start: "2027-01-31T00:00:00.000Z",
      paid_term_end: "2027-04-01T00:00:00.000Z",
      now: new Date("2027-03-31T12:00:00Z"),
    });
    expect(result.state).toBe("window");
    if (result.state !== "window") throw new Error("expected window");
    expect(result.window.window_start).toBe("2027-03-31T00:00:00.000Z");
    expect(result.window.window_end).toBe("2027-04-01T00:00:00.000Z");
  });

  it("gives distinct window ids for two annual years", () => {
    const year1 = billingWindow({
      account_id: ACCOUNT,
      subscription_ref: SUB,
      cadence: "annual",
      paid_term_start: "2027-01-31T00:00:00.000Z",
      paid_term_end: "2028-01-31T00:00:00.000Z",
      now: new Date("2027-02-15T00:00:00Z"),
    });
    const year2 = billingWindow({
      account_id: ACCOUNT,
      subscription_ref: SUB,
      cadence: "annual",
      paid_term_start: "2028-01-31T00:00:00.000Z",
      paid_term_end: "2029-01-31T00:00:00.000Z",
      now: new Date("2028-02-15T00:00:00Z"),
    });
    if (year1.state !== "window" || year2.state !== "window") throw new Error("expected windows");
    expect(year1.window.window_id).not.toBe(year2.window.window_id);
  });

  it("validates the whole input before treating the clock as outside", () => {
    expect(
      billingWindow({
        account_id: ACCOUNT,
        subscription_ref: SUB,
        cadence: "monthly",
        paid_term_start: "2027-01-31T00:00:00.000Z",
        paid_term_end: "2027-02-28T00:00:00.000Z",
        now: new Date("2027-06-01T00:00:00Z"),
      }),
    ).toEqual({ state: "unavailable", reason: "no_grant" });
    expect(() =>
      billingWindow({
        account_id: ACCOUNT,
        subscription_ref: SUB,
        cadence: "monthly",
        paid_term_start: "2027-02-01T00:00:00.000Z",
        paid_term_end: "2027-03-05T00:00:00.000Z",
        now: new Date("2027-06-01T00:00:00Z"),
      }),
    ).toThrow();
    expect(() =>
      billingWindow({
        account_id: ACCOUNT,
        subscription_ref: SUB,
        cadence: "annual",
        paid_term_start: "2027-01-31T00:00:00.000Z",
        paid_term_end: "2028-02-01T00:00:00.000Z",
        now: new Date("2027-06-01T00:00:00Z"),
      }),
    ).toThrow();
  });

  it("rejects unknown keys and a non-Date clock", () => {
    expect(() =>
      billingWindow({
        account_id: ACCOUNT,
        subscription_ref: SUB,
        cadence: "monthly",
        paid_term_start: "2027-01-31T00:00:00.000Z",
        paid_term_end: "2027-02-28T00:00:00.000Z",
        now: new Date("2027-02-01T00:00:00Z"),
        policy_id: "ignored",
      }),
    ).toThrow();
    expect(() =>
      billingWindow({
        account_id: ACCOUNT,
        subscription_ref: SUB,
        cadence: "monthly",
        paid_term_start: "2027-01-31T00:00:00.000Z",
        paid_term_end: "2027-02-28T00:00:00.000Z",
        now: "2027-02-01T00:00:00Z" as unknown as Date,
      }),
    ).toThrow();
  });
});

describe("freshness and admission expiry", () => {
  it("is the minimum of the freshness bound and the term end", () => {
    const verified = new Date("2027-02-01T00:00:00Z");
    expect(paidTermFreshUntil(verified, "2027-02-01T00:05:00.000Z").toISOString()).toBe(
      "2027-02-01T00:05:00.000Z",
    );
    expect(paidTermFreshUntil(verified, "2027-03-01T00:00:00.000Z").toISOString()).toBe(
      new Date(verified.getTime() + BILLING_FRESHNESS_MAX_MS).toISOString(),
    );
  });

  it("returns an already-expired term end unchanged (no future permission)", () => {
    expect(
      paidTermFreshUntil(new Date("2027-02-01T00:00:00Z"), "2027-01-15T00:00:00.000Z").toISOString(),
    ).toBe("2027-01-15T00:00:00.000Z");
  });

  it("expires admission at the minimum of term freshness and window end", () => {
    expect(
      admissionExpiresAt(new Date("2027-02-01T00:10:00Z"), "2027-02-01T00:07:00.000Z").toISOString(),
    ).toBe("2027-02-01T00:07:00.000Z");
    expect(
      admissionExpiresAt(new Date("2027-02-01T00:07:00Z"), "2027-02-01T00:10:00.000Z").toISOString(),
    ).toBe("2027-02-01T00:07:00.000Z");
  });
});

describe("validateStoredPaidTermReference", () => {
  const ref = {
    term_id: "term-1",
    receipt_id: "receipt-1",
    account_binding: H1,
    subscription_ref: SUB,
    transaction_ref: "txn-1",
    term_start: "2027-01-31T00:00:00.000Z",
    term_end: "2027-02-28T00:00:00.000Z",
    cadence: "monthly",
    window_id: H2,
    window_start: "2027-01-31T00:00:00.000Z",
    window_end: "2027-02-28T00:00:00.000Z",
    policy_id: "policy-1",
    root_epoch: 1,
    provenance_mac: H1,
  };

  it("accepts the exact approved shape", () => {
    expect(validateStoredPaidTermReference(ref)).toEqual(ref);
  });

  it("rejects a missing field and a non-uuid-ish unknown extra field is rejected", () => {
    const { window_id: _window_id, ...missing } = ref;
    expect(() => validateStoredPaidTermReference(missing)).toThrow();
    expect(() => validateStoredPaidTermReference({ ...ref, extra: "nope" })).toThrow();
  });
});

function grantFrame(over: Record<string, unknown> = {}) {
  return {
    schema: 1,
    purpose: "grant",
    epoch: 1,
    root_nonce: H1,
    policy_id: "policy-1",
    source_ids: ["src-a", "src-b"],
    ordinal: 0,
    prev_mac: "",
    body: {
      account_id: ACCOUNT,
      window_id: H2,
      term_id: "term-1",
      period_id: "3f1c2e4a-9b7d-4c1e-8f2a-000000000002",
      window_start: "2027-01-31T00:00:00.000Z",
      window_end: "2027-02-28T00:00:00.000Z",
      allowance_micro_usd: 100000,
    },
    ...over,
  };
}

describe("closed seal frame", () => {
  it("seals and verifies a valid grant frame without mutating the key", () => {
    const key = new Uint8Array(32).fill(9);
    const before = Array.from(key);
    const mac = sealMac(grantFrame(), key);
    expect(mac).toMatch(/^[a-f0-9]{64}$/);
    expect(verifySealMac(grantFrame(), key, mac)).toBe(true);
    expect(Array.from(key)).toEqual(before);
  });

  it("cannot validly rewrap a body under a different purpose", () => {
    const mac = sealMac(grantFrame(), KEY);
    const rewrapped = { ...grantFrame(), purpose: "admission" };
    expect(verifySealMac(rewrapped, KEY, mac)).toBe(false);
    expect(() => canonicalSealFrame(rewrapped)).toThrow();
  });

  it("canonicalizes independent of key insertion order", () => {
    const a = canonicalSealFrame(grantFrame());
    const reordered = {
      body: grantFrame().body,
      purpose: "grant",
      schema: 1,
      epoch: 1,
      root_nonce: H1,
      policy_id: "policy-1",
      source_ids: ["src-a", "src-b"],
      ordinal: 0,
      prev_mac: "",
    };
    expect(typeof a).toBe("string");
    expect(canonicalSealFrame(reordered)).toBe(a);
  });

  it("rejects unknown keys, unsupported purpose/schema and floats", () => {
    expect(() => canonicalSealFrame(grantFrame({ extra: "nope" }))).toThrow();
    expect(() => canonicalSealFrame(grantFrame({ body: { ...grantFrame().body, extra: 1 } }))).toThrow();
    expect(() => canonicalSealFrame(grantFrame({ purpose: "unknown" }))).toThrow();
    expect(() => canonicalSealFrame(grantFrame({ schema: 2 }))).toThrow();
    expect(() => canonicalSealFrame(grantFrame({ epoch: 1.5 }))).toThrow();
    expect(() => canonicalSealFrame(grantFrame({ epoch: Number.POSITIVE_INFINITY }))).toThrow();
    expect(() => canonicalSealFrame(grantFrame({ body: { ...grantFrame().body, allowance_micro_usd: 1.5 } }))).toThrow();
  });

  it("enforces frame identity rules", () => {
    expect(() => canonicalSealFrame(grantFrame({ ordinal: 0, prev_mac: H1 }))).toThrow();
    expect(() => canonicalSealFrame(grantFrame({ ordinal: 1, prev_mac: "" }))).toThrow();
    expect(() => canonicalSealFrame(grantFrame({ root_nonce: "abc" }))).toThrow();
    expect(() => canonicalSealFrame(grantFrame({ policy_id: "has spaces" }))).toThrow();
    expect(() => canonicalSealFrame(grantFrame({ policy_id: "" }))).toThrow();
    expect(() => canonicalSealFrame(grantFrame({ source_ids: [] }))).toThrow();
    expect(() => canonicalSealFrame(grantFrame({ source_ids: ["src-a", "src-a"] }))).toThrow();
    expect(() => canonicalSealFrame(grantFrame({ source_ids: [""] }))).toThrow();
  });

  it("bounds source ids and canonical frame size", () => {
    const ok = Array.from({ length: BILLING_MAX_SOURCE_IDS }, (_v, i) => `src-${i}`);
    expect(() => canonicalSealFrame(grantFrame({ source_ids: ok }))).not.toThrow();
    const tooMany = [...ok, "src-one-more"];
    expect(() => canonicalSealFrame(grantFrame({ source_ids: tooMany }))).toThrow();
    const huge = "x".repeat(BILLING_MAX_FRAME_BYTES);
    expect(() => canonicalSealFrame(grantFrame({ body: { ...grantFrame().body, term_id: huge } }))).toThrow();
  });

  it("rejects non-dense or non-data source arrays without a second iteration", () => {
    const sparse: string[] = ["src-a", "src-b"];
    delete sparse[1];
    expect(() => canonicalSealFrame(grantFrame({ source_ids: sparse }))).toThrow();

    const extra = ["src-a"];
    (extra as unknown as Record<string, unknown>).extra = "x";
    expect(() => canonicalSealFrame(grantFrame({ source_ids: extra }))).toThrow();

    const symbol = ["src-a"];
    Object.defineProperty(symbol, Symbol("extra"), { value: "x" });
    expect(() => canonicalSealFrame(grantFrame({ source_ids: symbol }))).toThrow();

    const accessor = ["src-a"];
    Object.defineProperty(accessor, "0", { enumerable: true, configurable: true, get: () => "src-a" });
    expect(() => canonicalSealFrame(grantFrame({ source_ids: accessor }))).toThrow();
  });

  it("bounds grant amounts and freshness shape", () => {
    expect(() =>
      canonicalSealFrame(grantFrame({ body: { ...grantFrame().body, allowance_micro_usd: -1 } })),
    ).toThrow();
    expect(() =>
      canonicalSealFrame(grantFrame({ body: { ...grantFrame().body, allowance_micro_usd: 9007199254740992 } })),
    ).toThrow();

    const freshness = {
      ...grantFrame(),
      purpose: "freshness",
      body: {
        account_id: ACCOUNT,
        term_id: "term-1",
        verified_at: "2027-02-01T00:00:00.000Z",
        expires_at: "2027-02-01T00:15:00.000Z",
        revision: 1,
        adverse_generation: 0,
      },
    };
    expect(() => canonicalSealFrame(freshness)).not.toThrow();
    expect(() =>
      canonicalSealFrame({
        ...freshness,
        body: { ...freshness.body, expires_at: "2027-02-01T00:16:00.000Z" },
      }),
    ).toThrow();
    expect(() =>
      canonicalSealFrame({
        ...freshness,
        body: { ...freshness.body, expires_at: "2027-02-01T00:00:00.000Z" },
      }),
    ).toThrow();
    expect(() =>
      canonicalSealFrame({ ...freshness, body: { ...freshness.body, revision: 0 } }),
    ).toThrow();
    expect(() =>
      canonicalSealFrame({ ...freshness, body: { ...freshness.body, adverse_generation: -1 } }),
    ).toThrow();
  });

  it("rejects an unknown revocation reason", () => {
    const revocation = {
      ...grantFrame(),
      purpose: "revocation",
      body: {
        account_id: ACCOUNT,
        term_id: "term-1",
        adverse_generation: 1,
        reason: "past_due",
      },
    };
    expect(() => canonicalSealFrame(revocation)).not.toThrow();
    expect(() =>
      canonicalSealFrame({ ...revocation, body: { ...revocation.body, reason: "unknown" } }),
    ).toThrow();
  });

  it("fail-closes verifySealMac instead of throwing on malformed input", () => {
    const mac = sealMac(grantFrame(), KEY);
    expect(verifySealMac(grantFrame(), new Uint8Array(16), mac)).toBe(false);
    expect(verifySealMac(grantFrame(), KEY, "not-hex")).toBe(false);
    expect(verifySealMac(grantFrame(), KEY, "ab".repeat(32))).toBe(false);
    expect(verifySealMac(grantFrame({ extra: "nope" }), KEY, mac)).toBe(false);
    expect(verifySealMac(grantFrame({ purpose: "unknown" }), KEY, mac)).toBe(false);
    expect(verifySealMac(null, KEY, mac)).toBe(false);
  });

  it("rejects a non-32-byte key when sealing", () => {
    expect(() => sealMac(grantFrame(), new Uint8Array(16))).toThrow();
    expect(() => sealMac(grantFrame(), new Uint8Array(64))).toThrow();
  });

  it("does not mutate a frozen frame", () => {
    const frame = Object.freeze(grantFrame());
    expect(() => canonicalSealFrame(frame)).not.toThrow();
  });
});
