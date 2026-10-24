# Open source and subscription

The owner wants an open-source career project with a subscription model and possible commercial restrictions. This requires an explicit licensing decision. The build pack does not grant a license automatically.

## Proposed split

**Owner direction accepted 2026-10-16:** browser-first managed personal accounts and monetization are the primary delivery target, alongside a useful self-hosted open-source edition sharing the core. Managed login and the default-off subscription/allowance boundary are implemented and locally verified with synthetic providers; no real payment, customer price, hosted service or live allowance exists. Pricing, a payment-provider account, legal terms and the software license require their actual release gates. See [the current release design](superpowers/specs/2026-10-16-managed-suite-design.md).

Open specification, useful local application, contracts, and official adapters support adoption.
Managed hosting, always-on preparation, maintained connectors, synchronization, and operations support can justify a subscription.
Keep basic export and cross-agent portability available without a paid plan.

Do not promise unlimited reasoning. Set prices after measuring model cost, connector maintenance, and useful outcomes.

## License decision

**Decided 2026-10-24:** the app is `AGPL-3.0-only` ([LICENSE](../LICENSE)). The agent connector (`apps/mcp` and `apps/cli`) is `Apache-2.0`, so other tools can embed it. Every workspace `package.json` declares its license. A contributor agreement, which would keep the option of offering the hosted edition under other terms, is recommended but not yet in place.

Background considered before the decision:

Permissive open source permits broad commercial reuse. A restriction on competing hosted services generally requires a source-available approach for affected code.
Do not attach contradictory no-competition terms to the same code granted under MIT/Apache.
Hosted service terms and software licenses govern different things.

Root licenses reviewed during brainstorming were MIT for GBrain, gstack, and Supermemory. Hosted services and separately distributed components may differ. Recheck terms before reusing code.

Provisional recommendation: a genuinely useful local core plus a managed service. The owner must choose which rights to grant before public release.

## Packaging to validate

Free/local: capture, inspect, edit, search, export, portable briefs, multiple local agents.
Managed personal: synchronization, maintained connectors, hosted background work, visible compute allowance.
Higher usage: additional explicit allowance and operational features.
Teams: after tenancy and collaboration.

No price is asserted. Grok's competitor prices and costs are not adopted as verified facts.

## Validation and career value

Measure return behavior, useful prepared artifacts, interruption burden, cost per useful outcome, and support load.
Publish architecture, revision semantics, reproducible failure tests, supported client evidence, and honest tradeoffs.
Payment implementation follows willingness-to-pay evidence and reliable metering.
Subscription enforcement may restrict new expensive managed processing, but must not strand already saved knowledge, correction, export or deletion. Server-verified, replay-safe payment events and reconciliation determine entitlements; a checkout return URL never proves payment. A payment provider's test mode is distinct from live billing.

## Payment-provider direction — Paddle, subject to seller approval

On 2026-10-17 the owner preferred Paddle over Stripe if it is suitable for an
India-based seller serving global customers. Official documentation checked on
that date supports using **Paddle Billing as the design target, sandbox first**:

The owner subsequently specified **individual/sole proprietor** as the intended
seller form. Plan onboarding accordingly, without assuming an approved account,
waived identity/domain checks, bank eligibility or a particular Indian tax status.

The owner selected **monthly and annual subscriptions** for the first managed
release, rather than monthly-only. The proposed scope retains a fixed included
processing allowance and no automatic overage charges; saved knowledge,
export/deletion remain payment-independent. The owner explicitly approved that
annual subscriptions are billed yearly but their processing allowance renews
**monthly, with no rollover**, rather than granting a year's processing upfront.
Use the same monthly no-rollover rule for monthly subscriptions. Exact prices,
any annual discount, allowance amounts and cancellation/refund lifecycle remain
separate design/economic decisions. The subsequently approved default-off local
billing boundary supports both cadences without creating Paddle products/prices or
guessing those decisions; real Sandbox and live execution remain gated.

- Paddle says it supports software sellers worldwide except its listed unsupported
  countries; India is not on that list. This is eligibility in principle, not
  approval of the owner's identity, bank account, domain or BiBrain product.
- Its Merchant of Record service covers customer payment/billing and sales-tax
  collection/remittance. It does not eliminate the seller's own Indian tax,
  accounting or export-reporting obligations; confirm those with a qualified
  adviser and the receiving bank.
- Published standard pricing is **5% + US$0.50 per checkout transaction**. Payout
  and currency-conversion charges can be additional; do not assume this is the
  entire cost of receiving funds in India or adopt an application subscription
  price without cost measurement/owner approval.
- Published payouts are monthly, with a minimum threshold of **US$100**. INR is
  not listed as a direct payout currency. Paddle describes foreign-currency
  payouts with bank conversion when the local currency is unsupported; SWIFT,
  receiving-bank and FX costs require account-specific confirmation.
- Onboarding requires domain review and identity verification; business
  verification is additionally required where applicable (individuals/sole
  traders are exempt from that business-verification phase, not all checks).
  Product eligibility remains subject to Paddle's acceptable-use review.

No Paddle account was created, bank/KYC information collected, product/price
created, checkout launched or payment enabled. Provider preference is not approval
of a billing architecture, customer pricing, refunds policy or live rollout.
The billing design is now approved for the implemented default-off local boundary.
Actual Sandbox acceptance and every live/business gate below remain open.

Official sources (accessed 2026-10-17):

- [Seller countries](https://www.paddle.com/help/start/intro-to-paddle/which-countries-are-supported-by-paddle)
- [Pricing / Merchant of Record](https://www.paddle.com/pricing)
- [Payout schedule and threshold](https://www.paddle.com/help/manage/get-paid/when-and-how-do-i-get-paid)
- [Payout currencies](https://www.paddle.com/help/manage/get-paid/can-i-be-paid-in-my-local-currency)
- [Payout/FX fees](https://www.paddle.com/help/manage/get-paid/is-there-a-fee-taken-for-payouts)
- [Account verification](https://www.paddle.com/help/start/account-verification/what-is-account-verification)
- [Acceptable use](https://www.paddle.com/help/start/intro-to-paddle/what-am-i-not-allowed-to-sell-on-paddle)
