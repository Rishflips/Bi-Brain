# Open source and subscription

The owner wants an open-source career project with a subscription model and possible commercial restrictions. This requires an explicit licensing decision. The build pack does not grant a license automatically.

## Proposed split

**Owner direction accepted 2026-10-16:** browser-first managed personal accounts and monetization are the primary delivery target, alongside a useful self-hosted open-source edition sharing the core. Managed login, billing and included allowances are not yet delivered merely because this split is approved. Pricing, a payment-provider account, legal terms and the software license require their actual release gates. See [the current release design](superpowers/specs/2026-10-16-managed-suite-design.md).

Open specification, useful local application, contracts, and official adapters support adoption.
Managed hosting, always-on preparation, maintained connectors, synchronization, and operations support can justify a subscription.
Keep basic export and cross-agent portability available without a paid plan.

Do not promise unlimited reasoning. Set prices after measuring model cost, connector maintenance, and useful outcomes.

## License decision

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
