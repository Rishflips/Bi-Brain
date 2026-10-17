import { createHash, createHmac } from "node:crypto";
import { expect, it } from "vitest";
import { BrainError } from "../../packages/domain/logic.ts";
import {
  admissionExpiresAt,
  billingWindow,
  clampAddMonths,
  paidTermFreshUntil,
  validateStoredPaidTermReference,
  windowId,
} from "../../packages/domain/billing-authority.ts";
import {
  canonicalSealFrame,
  sealMac,
  verifySealMac,
} from "../../packages/domain/billing-seal.ts";

// Parent-owned independent checks. All identities, money and key bytes are SYNTHETIC.
const account = "11111111-1111-4111-8111-111111111111";
const period = "22222222-2222-4222-8222-222222222222";
const root = "a".repeat(64);
const digest = "b".repeat(64);
const key = Uint8Array.from({ length: 32 }, (_, i) => i);
const start = "2028-01-31T13:45:30.123Z";
const feb = "2028-02-29T13:45:30.123Z";
const mar = "2028-03-31T13:45:30.123Z";

function annual(over: Record<string, unknown> = {}) {
  return {
    account_id: account, subscription_ref: "SYNTHETIC-sub", cadence: "annual",
    paid_term_start: start, paid_term_end: "2029-01-31T13:45:30.123Z",
    now: new Date(feb), ...over,
  };
}

function grant() {
  return {
    schema: 1, purpose: "grant", epoch: 1, root_nonce: root, policy_id: "SYNTHETIC-policy",
    source_ids: ["SYNTHETIC-receipt"], ordinal: 0, prev_mac: "",
    body: {
      account_id: account, window_id: digest, term_id: "SYNTHETIC-term", period_id: period,
      window_start: start, window_end: feb, allowance_micro_usd: 100,
    },
  };
}

function reference(over: Record<string, unknown> = {}) {
  return {
    term_id: "SYNTHETIC-term", receipt_id: "SYNTHETIC-receipt", account_binding: root,
    subscription_ref: "SYNTHETIC-sub", transaction_ref: "SYNTHETIC-transaction",
    term_start: start, term_end: "2029-01-31T13:45:30.123Z", cadence: "annual",
    window_id: digest, window_start: feb, window_end: mar,
    policy_id: "SYNTHETIC-policy", root_epoch: 1, provenance_mac: root, ...over,
  };
}

it("window identity is the specified canonical hash, not a provider transaction or policy key", () => {
  const input = {
    account_id: account, subscription_ref: "SYNTHETIC-sub", paid_term_start: start,
    window_start: feb, window_end: mar,
  };
  const literal = `{"account_id":"${account}","paid_term_start":"${start}","subscription_ref":"SYNTHETIC-sub","window_end":"${mar}","window_start":"${feb}"}`;
  expect(windowId(input)).toBe(createHash("sha256").update(literal, "utf8").digest("hex"));
});

it("window identity binds term start and window start independently", () => {
  const input = {
    account_id: account, subscription_ref: "SYNTHETIC-sub", paid_term_start: start,
    window_start: feb, window_end: mar,
  };
  expect(windowId({ ...input, paid_term_start: "2028-01-30T13:45:30.123Z" })).not.toBe(windowId(input));
  expect(windowId({ ...input, window_start: "2028-03-01T13:45:30.123Z" })).not.toBe(windowId(input));
});

it("a leap-year annual boundary switches windows at the exact millisecond", () => {
  const before = billingWindow(annual({ now: new Date("2028-02-29T13:45:30.122Z") }));
  const at = billingWindow(annual());
  expect(before).toMatchObject({ state: "window", window: { window_start: start, window_end: feb, index: 0 } });
  expect(at).toMatchObject({ state: "window", window: { window_start: feb, window_end: mar, index: 1 } });
});

it("skipping eight annual months returns only the current window, not a catch-up allowance list", () => {
  expect(billingWindow(annual({ now: new Date("2028-10-10T00:00:00.000Z") }))).toMatchObject({
    state: "window", window: {
      window_start: "2028-09-30T13:45:30.123Z", window_end: "2028-10-31T13:45:30.123Z", index: 8,
    },
  });
});

it("Feb29 annual anchors preserve day 29 until the final non-leap February clamp", () => {
  expect(clampAddMonths("2028-02-29T23:59:59.999Z", 12)).toBe("2029-02-28T23:59:59.999Z");
  expect(billingWindow(annual({
    paid_term_start: "2028-02-29T23:59:59.999Z", paid_term_end: "2029-02-28T23:59:59.999Z",
    now: new Date("2029-02-28T23:59:59.998Z"),
  }))).toMatchObject({ state: "window", window: {
    window_start: "2029-01-29T23:59:59.999Z", window_end: "2029-02-28T23:59:59.999Z", index: 11,
  } });
});

it.each([
  "2028-02-30T00:00:00.000Z", "2027-02-29T00:00:00.000Z", "2028-01-31T24:00:00.000Z",
  "2028-01-31T13:45:30Z", "2028-01-31T13:45:30.123+00:00", "0000-01-31T13:45:30.123Z",
])("rejects a noncanonical or normalized term timestamp before an out-of-window clock: %s", (bad) => {
  expect(() => billingWindow(annual({ paid_term_start: bad, now: new Date("2031-01-01T00:00:00Z") })))
    .toThrow(BrainError);
});

it.each([
  { account_id: "other-account" }, { subscription_ref: "" }, { subscription_ref: "has\nnewline" },
  { subscription_ref: "x".repeat(201) }, { cadence: "trial" }, { paid_term_end: start },
  { paid_term_end: "2028-01-01T00:00:00.000Z" }, { paid_term_end: "2030-01-31T13:45:30.123Z" },
  { now: new Date(Number.NaN) }, { provider_says_paid: true },
])("rejects invalid billing arguments rather than returning a grant: %j", (change) => {
  expect(() => billingWindow(annual(change))).toThrow(BrainError);
});

it("a fresh annual term survives a monthly boundary while each admission ends at its own window", () => {
  const verified = new Date("2028-02-29T13:40:30.123Z");
  const until = paidTermFreshUntil(verified, "2029-01-31T13:45:30.123Z");
  expect(until.toISOString()).toBe("2028-02-29T13:55:30.123Z");
  expect(admissionExpiresAt(until, feb).toISOString()).toBe(feb);
  expect(admissionExpiresAt(until, mar).toISOString()).toBe("2028-02-29T13:55:30.123Z");
  expect(verified.toISOString()).toBe("2028-02-29T13:40:30.123Z");
  expect(until.toISOString()).toBe("2028-02-29T13:55:30.123Z");
});

it("expiry helpers reject invalid Date inputs, never manufacture a future validity", () => {
  expect(() => paidTermFreshUntil(new Date(Number.NaN), mar)).toThrow(BrainError);
  expect(() => admissionExpiresAt(new Date(Number.NaN), mar)).toThrow(BrainError);
  expect(() => paidTermFreshUntil(new Date(feb), "2028-02-30T13:45:30.123Z")).toThrow(BrainError);
});

it("stored references validate calendar bounds but remain lookup data, not payment proof", () => {
  const valid = reference();
  expect(validateStoredPaidTermReference(valid)).toEqual(valid);
  // These structurally valid digest bytes do not prove any payment or account ownership.
  expect(validateStoredPaidTermReference({ ...valid, provenance_mac: digest }).provenance_mac).toBe(digest);
});

it.each([
  { window_start: "2028-03-01T13:45:30.123Z" }, { window_end: "2028-04-01T13:45:30.123Z" },
  { window_start: start, window_end: mar }, { window_start: start, window_end: start },
  { window_start: "2027-12-31T13:45:30.123Z" }, { root_epoch: 0 }, { provenance_mac: "not-a-mac" },
  { cadence: "monthly" }, { verified: true },
])("rejects a malformed, non-calendar or widened paid-term lookup: %j", (change) => {
  expect(() => validateStoredPaidTermReference(reference(change))).toThrow(BrainError);
});

it("a monthly reference cannot shrink the provider-paid period to mint another subwindow", () => {
  const input = reference({ cadence: "monthly", term_end: feb, window_start: start, window_end: feb });
  expect(validateStoredPaidTermReference(input)).toEqual(input);
  expect(() => validateStoredPaidTermReference({ ...input, window_end: "2028-02-15T13:45:30.123Z" }))
    .toThrow(BrainError);
});

it("canonical frame bytes and HMAC match an independently serialized closed grant", () => {
  const literal = JSON.stringify({
    body: { account_id: account, allowance_micro_usd: 100, period_id: period, term_id: "SYNTHETIC-term",
      window_end: feb, window_id: digest, window_start: start },
    epoch: 1, ordinal: 0, policy_id: "SYNTHETIC-policy", prev_mac: "", purpose: "grant",
    root_nonce: root, schema: 1, source_ids: ["SYNTHETIC-receipt"],
  });
  const expectedMac = createHmac("sha256", key).update(literal, "utf8").digest("hex");
  expect(canonicalSealFrame(grant())).toBe(literal);
  expect(sealMac(grant(), key)).toBe(expectedMac);
  expect(verifySealMac(grant(), key, expectedMac)).toBe(true);
});

it.each([
  { epoch: 2 }, { root_nonce: digest }, { policy_id: "SYNTHETIC-other-policy" },
  { source_ids: ["SYNTHETIC-other-receipt"] }, { ordinal: 1, prev_mac: digest },
])("a previously valid MAC cannot authenticate substituted authority context: %j", (change) => {
  const mac = sealMac(grant(), key);
  expect(verifySealMac({ ...grant(), ...change }, key, mac)).toBe(false);
});

it("a valid MAC cannot authenticate another account, budget or interval", () => {
  const frame = grant(), mac = sealMac(frame, key);
  for (const change of [
    { account_id: period }, { allowance_micro_usd: 101 }, { window_end: mar },
    { period_id: account }, { term_id: "SYNTHETIC-other-term" }, { window_id: root },
  ]) {
    expect(verifySealMac({ ...frame, body: { ...frame.body, ...change } }, key, mac)).toBe(false);
  }
});

it("all four purpose-specific records round-trip without sharing body schemas", () => {
  const base = grant();
  const frames = [
    base,
    { ...base, purpose: "admission", body: {
      account_id: account, identity_digest: root, tenant_incarnation: digest, clean_baseline_proof: root,
    } },
    { ...base, purpose: "revocation", body: {
      account_id: account, term_id: "SYNTHETIC-term", adverse_generation: 1, reason: "refunded",
    } },
    { ...base, purpose: "freshness", body: {
      account_id: account, term_id: "SYNTHETIC-term", verified_at: feb,
      expires_at: "2028-02-29T14:00:30.123Z", revision: 1, adverse_generation: 0,
    } },
  ];
  for (const frame of frames) {
    expect(verifySealMac(frame, key, sealMac(frame, key))).toBe(true);
    expect(() => canonicalSealFrame({ ...frame, body: { ...frame.body, authorized: true } })).toThrow(BrainError);
  }
});

it("freshness cannot carry any allowance, even with otherwise valid signed fields", () => {
  const input = { ...grant(), purpose: "freshness", body: {
    account_id: account, term_id: "SYNTHETIC-term", verified_at: feb,
    expires_at: "2028-02-29T14:00:30.123Z", revision: 1, adverse_generation: 0, allowance_micro_usd: 1,
  } };
  expect(() => sealMac(input, key)).toThrow(BrainError);
  expect(verifySealMac(input, key, root)).toBe(false);
});

it("revocation generation zero is not an adverse record", () => {
  expect(() => canonicalSealFrame({ ...grant(), purpose: "revocation", body: {
    account_id: account, term_id: "SYNTHETIC-term", adverse_generation: 0, reason: "past_due",
  } })).toThrow(BrainError);
});

it.each([Number.NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])("rejects unsafe budget %s before MAC computation", (amount) => {
  const input = grant();
  input.body.allowance_micro_usd = amount;
  expect(() => sealMac(input, key)).toThrow(BrainError);
  expect(verifySealMac(input, key, root)).toBe(false);
});

it.each([0, Number.MAX_SAFE_INTEGER])("preserves safe integer budget %s in canonical bytes", (amount) => {
  const input = grant();
  input.body.allowance_micro_usd = amount;
  expect(JSON.parse(canonicalSealFrame(input)).body.allowance_micro_usd).toBe(amount);
});

it.each([null, "SYNTHETIC-key", Array(32).fill(0), new Uint8Array(31), new Uint8Array(33)])(
  "key bytes must be a real 32-byte Uint8Array, not %j", (badKey) => {
    expect(() => sealMac(grant(), badKey as Uint8Array)).toThrow(BrainError);
    expect(verifySealMac(grant(), badKey as Uint8Array, root)).toBe(false);
  },
);

it.each([null, "", "f".repeat(63), "f".repeat(65), "G".repeat(64), root.toUpperCase(), new Uint8Array(32)])(
  "verification fail-closes malformed MAC %j without throwing", (mac) => {
    expect(verifySealMac(grant(), key, mac)).toBe(false);
  },
);

it("validation errors use a content-safe INVALID_INPUT code", () => {
  try {
    canonicalSealFrame({ ...grant(), source_ids: ["SYNTHETIC-private-PII@invalid"] });
    throw new Error("Invalid input unexpectedly accepted");
  } catch (error) {
    expect(error).toBeInstanceOf(BrainError);
    expect((error as BrainError).code).toBe("INVALID_INPUT");
    expect((error as Error).message).not.toContain("SYNTHETIC-private-PII");
  }
});

it("UUID fields reject invalid version/variant strings rather than just five hex groups", () => {
  const malformed = "11111111-1111-0111-0111-111111111111";
  expect(() => billingWindow(annual({ account_id: malformed }))).toThrow(BrainError);
  const input = grant();
  expect(() => canonicalSealFrame({ ...input, body: { ...input.body, period_id: malformed } }))
    .toThrow(BrainError);
});

it("a canonical seal never serializes a different, unvalidated getter value", () => {
  const frame = grant();
  let reads = 0;
  Object.defineProperty(frame, "epoch", { enumerable: true, get: () => reads++ === 0 ? 1 : 0 });
  // Rejecting accessors is valid; accepting them requires a validated owned snapshot.
  let serialized: string | undefined;
  try {
    serialized = canonicalSealFrame(frame);
  } catch (error) {
    expect(error).toBeInstanceOf(BrainError);
  }
  if (serialized !== undefined) expect(JSON.parse(serialized).epoch).toBe(1);
});

it("source lists cannot change between validation and the owned serialization snapshot", () => {
  const frame = grant();
  let iterations = 0;
  Object.defineProperty(frame.source_ids, Symbol.iterator, {
    value: function* () { yield iterations++ === 0 ? "SYNTHETIC-receipt" : "invalid source"; },
  });
  let serialized: string | undefined;
  try {
    serialized = canonicalSealFrame(frame);
  } catch (error) {
    expect(error).toBeInstanceOf(BrainError);
  }
  if (serialized !== undefined) expect(JSON.parse(serialized).source_ids).toEqual(["SYNTHETIC-receipt"]);
});
