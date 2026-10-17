import { expect, it } from "vitest";
import { BrainError } from "../../packages/domain/logic.ts";
import {
  receiptFromFacts, validateProviderFacts, validateServerOwnedBinding,
  type ProviderFacts, type ServerOwnedBinding,
} from "../../packages/domain/billing-evidence.ts";

const binding: ServerOwnedBinding = {
  schema: 1, account_id: "11111111-1111-4111-8111-111111111111",
  identity_digest: "a".repeat(64), tenant_incarnation: "b".repeat(64),
  provisioning_generation: 1, mode: "sandbox", product_ref: "SYNTHETIC-product",
  price_ref: "SYNTHETIC-price", cadence: "monthly", customer_ref: "SYNTHETIC-customer",
  subscription_ref: "SYNTHETIC-subscription", initial_transaction_ref: "SYNTHETIC-transaction",
  correlation_ref: "SYNTHETIC-correlation", version: 1,
};
function facts(): ProviderFacts {
  return { transaction_ref: binding.initial_transaction_ref, subscription_ref: binding.subscription_ref,
    customer_ref: binding.customer_ref, product_ref: binding.product_ref, price_ref: binding.price_ref,
    cadence: "monthly", completed_payment: true, current_state: "active",
    paid_period_start: "2027-01-31T00:00:00.000Z", paid_period_end: "2027-02-28T00:00:00.000Z",
    verified_at: "2027-01-31T12:00:00.000Z" };
}

it("validated provider facts are an owned snapshot rather than a mutable SDK response alias", () => {
  const input = facts(), validated = validateProviderFacts(input);
  input.customer_ref = "SYNTHETIC-substituted-customer";
  input.completed_payment = false;
  expect(validated.customer_ref).toBe(binding.customer_ref);
  expect(validated.completed_payment).toBe(true);
});

it("receipt construction cannot turn an explicitly unpaid observation into completed payment", () => {
  expect(() => receiptFromFacts({ ...facts(), completed_payment: false }, binding)).toThrow(BrainError);
});

it.each(["customer_ref", "subscription_ref", "product_ref", "price_ref"] as const)(
  "receipt construction refuses a %s that does not belong to the sealed binding", (field) => {
    expect(() => receiptFromFacts({ ...facts(), [field]: "SYNTHETIC-other" }, binding)).toThrow(BrainError);
  },
);

it.each([{ account_id: binding.account_id }, { allowance_micro_usd: 100 }, { verified: true },
  { adverse_generation: 0 }])("provider data cannot contain authority-bearing extra fields: %j", (extra) => {
  expect(() => validateProviderFacts({ ...facts(), ...extra })).toThrow(BrainError);
});

it("the validated binding remains owned after the caller replaces its account references", () => {
  const input = { ...binding }, validated = validateServerOwnedBinding(input);
  input.customer_ref = "SYNTHETIC-other-customer";
  expect(validated.customer_ref).toBe("SYNTHETIC-customer");
});
