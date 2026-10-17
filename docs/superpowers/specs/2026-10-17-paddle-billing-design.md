# Paddle Billing integration (B1) — DRAFT

**Status: DRAFT — UNAPPROVED. TOP DRAFT for review only; this creates no account, price,
product, key, environment variable, route, dependency, schema or code.** It consumes the B0
contract (`2026-10-17-renewal-safe-financial-authority-design.md`) as a document only and
never authorizes B0 implementation. No exact prices, provider ids or allowance amounts appear
here; every monetary value is a required operator enrollment input with default off/zero.
Lifecycle rules here are **PROPOSED**, not owner policy.

The owner has approved the separate **B0 written design**, not this B1 draft. B0's
implementation and independent verification are still prerequisites. No Paddle transport,
checkout, webhook, price or payment implementation is authorized by B0's approval.

## Scope

The provider side of managed subscriptions on **Paddle Billing** (not Classic): webhook and
checkout transport, the lean verified cache, the correlation between a verified payment and a
B0 grant, currency handling and lifecycle. Out of scope: prices, allowance amounts, refunds
policy, taxes, KYC, payouts, live execution.

## Official facts and sources

- https://developer.paddle.com/llms.txt — Billing, not Classic; `api.paddle.com` /
  `sandbox-api.paddle.com`; version header pinned to `1`; Paddle.js v2 uses a client token, not
  an API key.
- https://developer.paddle.com/api-reference/about/versioning.md — pin version `1`; webhook
  destination API version `1`.
- https://developer.paddle.com/webhooks/about/signature-verification.md — `Paddle-Signature:
  ts=<seconds>;h1=<hex>`, `HMAC-SHA256(secret, "${ts}:${RAW_BODY}")`; accept multiple `h1` for
  future key rotation; SDK default tolerance 5 seconds. Samples that log raw payloads or
  assume exactly one signature are not copied into our integration.
- https://developer.paddle.com/webhooks/about/respond-to-webhooks.md — sandbox 3 attempts in
  15 min, live 60 in 3 days; at-least-once, out-of-order.
- https://developer.paddle.com/webhooks/transactions/transaction-completed.md —
  `transaction.paid` precedes completion; completion adds fees/payments and creates the
  recurring subscription with `subscription_id`.
- https://developer.paddle.com/build/subscriptions/provision-access-webhooks.md — lean cache
  recommended over a full mirror; `subscription.created/updated` cover state; portal handles
  payment methods, cancellation, invoices. Paddle’s “grant on trial/past_due” advice is for a
  different product and is **not** ours.
- https://developer.paddle.com/api-reference/transactions/create-transaction.md — draft/ready
  transaction from recurring price ids, quantity 1, automatic collection.
- https://developer.paddle.com/api-reference/adjustments/list-adjustments.md — filters by
  `subscription_id`/`customer_id`/`transaction_id`; `per_page` max 50; cursor `next` URL
  untrusted; actions `refund`/`chargeback`/`chargeback_warning` + reversals; statuses
  `pending_approval`/`approved`/`rejected`/`reversed`.
- India/INR: no direct INR payout, monthly minimum payout 100, merchant fee 5% + 0.50, FX/wire
  fees, CA/overseas obligation — links already in `docs/BUSINESS.md`.

Additional operator facts (also parent-verified): a draft transaction does not charge until
the user completes checkout; we do not set `status = billed`, force manual collection or send
addresses; `customer` is optional on a draft, so we create the first draft **without** a
customer and bind `customer_id` onto the stored intent when verified completion arrives; email
is never identity. `Get subscription.current_billing_period` is NULL on canceled/paused. The
Paddle subscription state enum is lowercase `active`, not `ACTIVE`.

## Approaches

**A — Lean cache + strict verified paid term (recommended).** Cache only what answers “is
there a current, verified, paid term for this account?” from verified events plus a bounded
read. **B — Full local mirror (rejected):** drift and duplicated authority. **C — Grant on
checkout return/`custom_data` (rejected):** a return URL is not payment proof.

## Static vs dynamic; currency

- **Static frozen operator enrollment (default off/zero):** sandbox/live plan-and-price map,
  provider product/cadence, the **base catalog price currency**, and an allowlist of permitted
  **charged** ISO currencies. Price ids are a server whitelist of exactly the monthly and
  yearly recurring prices; no other id is accepted. This is catalog validation, not permission
  to alter a schema. There is no asserted “yearly discount”. Sandbox/live scopes never mix;
  sandbox receipts do not authorize live processing (B0 §Live gate).
- **Dynamic verified:** the lean subscription state and authoritative receipts feeding B0.
- **Currency ≠ budget.** The customer price (minor units, its ISO currency, possible localized
  conversion and tax) is never the monthly model budget (integer micro-USD). We do not assume
  all currencies have 2 decimals, and a non-base actual currency does not reject a legitimate
  buyer. We accept only a configured price id/product, quantity 1 and cadence, plus an
  authoritative provider-priced **positive** paid transaction in the approved currency
  allowlist. The provider paid amount never computes the grant.
- Mapping is by provider ids; the account id is never sent to Paddle except as an opaque local
  intent nonce. No knowledge, session or model key, and no raw tenant identity, leaves.

## Verified payment proof (PROPOSED, closed)

A grant requires, together: a CURRENT provider `GET` (our own source) of the subscription in
lowercase `active`; a matching **COMPLETED** paid transaction with the configured price,
product, quantity and cadence and a provider-computed amount/currency accepted under the
enrolled charged-currency policy; and immutable account/customer/subscription correlation.
Actual localized currency need not equal the intent's base catalog currency. The event
alone is never authority. For the **initial** purchase, require the exact transaction ID
returned to the server for its persisted intent. For a **renewal**, a new checkout intent is
neither needed nor accepted: bind the new completed recurring transaction to the already
sealed customer/subscription, verified paid period and enrolled catalog. Its new transaction
ID is payment provenance, not a way to recharge an existing allowance interval.
`subscription.status` alone, a zero-value payment-method-change transaction, a trial, a manual
invoice, proration or extra items never grant. Renewal must bind the renewal term and current
billing period exactly to the owner’s cadence at quantity 1. An unknown change is manual
attention and denies new paid calls. `transaction.paid` may arrive first; only completion
creates the recurring binding.

## Correlation, checkout, orphan

- A server-owned **checkout intent** row (nonce, local account, cadence, expected catalog
  product/price, base currency, created, expiry) is written before any provider call; the
  pre-provider response exposes only an opaque intent id. Exactly one pending intent per account.
- Checkout input carries **cadence only** plus our **own** `Idempotency-Key` UUID bound to the
  account and request payload. We do **not** assume Paddle has its own idempotency key.
- The creation result returns the opaque intent, the ready transaction id (public), and the
  public client token/mode needed to open `Paddle.Checkout.open`; a bounded response shape. It
  is not “only an opaque intent” with no way to open checkout.
- `custom_data`, return URLs, callbacks and email are never proof. Events only schedule a
  CURRENT provider read; apply the initial-versus-renewal correlation above, not a comparison
  of every future renewal to the first checkout's transaction ID.
- Our checkout return URLs are our own origin, allowlisted, never a user-chosen redirect; the
  `Checkout.open` transaction id is public and not proof.
- A signed webhook may arrive **before** the POST response: store an ORPHAN pending record keyed
  by intent nonce and grant **no** admission until the creation result exists or a strict
  reconciliation correlates the real transaction from the provider list. A nonce alone is not
  proof (it can be copied from the public frontend); an ambiguous case is manual attention,
  never an automatic bind. A second active completion for the same account grants no extra
  allowance and blocks paid until operator resolution; only one active provider binding per
  account.

## Webhook verification and inbox (PROPOSED)

- Only this route bypasses session/CSRF; Host/Origin and global guards are not disabled.
- Body > 256 KiB or header > 4 KiB rejected. Exactly one `ts` (strict digits) and 1–4 `h1`
  values of 64 hex; absolute skew ≤ 5 s (NTP required). Length-safe `timingSafeEqual` on 32-byte
  buffers; JSON parsed only after verification.
- `occurred_at` orders events but is not authority; a same-time conflict resolves from the
  authoritative provider read, never the timestamp. Unknown additive fields are ignored; an
  unknown field can never silently grant a plan or enum.
- Bounded **control-side** leased inbox (never a tenant job or the tenant vault): owner, fence,
  future expiry, `BEGIN IMMEDIATE`, CAS completion. Uniqueness is `(mode, merchant endpoint,
  event_id)` — **not** global event id. Ack 200 only after committing a minimal verified
  projection (≤256 KiB) plus body hash. Same event id with different content → 400 + durable
  deny **only for a known binding**, never a global DoS from an unknown signed bogus event.
  Unknown/unmapped ids carry no account authority. Persist failure → 503, no fake ack.
- Raw payload is verified in memory only, then reduced to sealed normalized fields
  (root/MAC provenance + request digest); no email, card data or whole payload is logged or
  stored.

## Adjustments and refunds (PROPOSED)

Adjustments are read for the CURRENT paid transaction and all known related transactions.
A fully refunded annual term strictly revokes future monthly grants. Pending or partial
adjustments are a manual review with no automatic prorated budget and no erased consumption.
Approved refunds and injected synthetic data can never refund model spend. No background
`POST` refunds — only user-initiated checkout and portal writes.

## Lifecycle (PROPOSED, not owner policy)

Cancel-at-term-end via portal by default; annual continues monthly renewals only to the paid
year end. Cadence chosen at first purchase and after expiry; switching an active cadence is
not implicit proration and must not double-credit — if the portal still allows it, we deny new
paid processing and reconcile manually. No admin refund API, no immediate plan upgrade, no
automated refunds/merchant actions in V1. past_due/paused/canceled/refund/chargeback restrict
new admission promptly; in-flight known charges settle; knowledge/correction/export/deletion
and re-login are never suspended and `managed_accounts.state` is never mutated by billing. No
price or cadence changes mid-active-period in V1.

## Freshness and reconciliation bounds

Eligibility needs a verified fresh-state projection within 15 minutes, `now <` paid term end,
and `now` inside the B0 current window. A 5-minute reconciliation refreshes term state.
Term-state freshness ends at `min(verified_at + 15m, paid_term_end)`; each spending admission
additionally ends at its **own** `window_end`. Thus a fresh annual paid term can create its
new current month at the boundary without another payment or reuse of an expired budget.
There is no stale-webhook authority, offline paid fallback or unpaid free allowance. Work
runs in the existing worker loop, a bounded pass **before** the
tenant tick, outside any transaction and independent of the model-paid opt-in. Proposed
bounds: at most 10 local items and 4 GETs per pass, 3-second provider timeout, 12-second total
pass deadline, 1 MiB per response and 4 MiB total response bytes. A resource scan may traverse
at most 10 pages of 50 items **across leased continuation passes**, not 10 pages within a
4-request pass. Fixed-origin/path cursors, captured subscription/adverse generation and lease
fences persist with the continuation; a partial scan grants nothing. A newer event or expired
snapshot restarts verification, not permission. Bound exhaustion means unavailable/manual
attention—never an assumption that no refund exists. No unbounded historical scan each tick.
An adverse signed event for a known binding records a deny generation before expensive reads;
an older in-flight GET cannot override it. Without such an event, provider changes may remain
unobserved until reconciliation/expiry: the 15-minute cache is a disclosed delay bound, not
instantaneous remote revocation. None of these reads block the independent heartbeat timer.

## Modules and adapters

- `packages/domain/paddle-signature.ts`, `packages/domain/paddle-event.ts` — pure rules and
  closed event normalization.
- `packages/storage/billing-inbox.ts`, `billing-cache.ts`, `billing-checkout-intent.ts` —
  leased inbox, lean cache, intents in `control_billing_*`.
- `packages/providers/paddle.ts` — three explicit operations with phase/audience keys:
  bounded `readSnapshot` GETs on closed subscription/transaction/adjustment paths, a user-only
  `createCheckoutTransaction` POST and a user-only `createPortalSession` POST. No arbitrary
  URL/method surface. Writing is **not** hidden inside a “read.ts”. Server/webhook transport classes
  are backend-only; env keys are never client-side except the public Paddle.js token.
- `packages/runtime/billing-grants.ts` — implements B0’s dependency; calls
  `ensureCurrentGrant`/`admitNewAccount`.
- `apps/worker/managed-billing.ts` — bounded reconciliation pass.
- `apps/server/billing-routes.ts` — the routes below.
- `apps/web/billing.tsx` (new, proposed) and narrow `apps/web/src.tsx` wiring — a Settings
  billing section, not a fourth primary navigation item. Show both cadences, plain-language
  allowance/reset and renewal dates, pending confirmation, failure and cancellation. Checkout
  return remains **Confirming payment** until server verification, never a paid-success badge
  from the redirect. Discard billing dialogs/responses on account switch/logout. Missing
  setup is explicitly unavailable; local/self-hosted mode has no billing dependency.

### Interfaces

B1 does **not** hand B0 a free-form `{state:"verified"}`. It uses B0's
`StoredPaidTermReference` format as a lookup view. B0 re-loads its referenced record from the
**authority-owned store under transaction**, checks MAC/purpose/root/policy/provenance and
fresh-state projection, and computes the grant itself. References are not signing permits;
the closed writer validates the pinned provider reads and server-owned correlation first.

```ts
// StoredPaidTermReference is defined in B0 §Interfaces, not independently here.
interface BillingGrantSource {
  verifiedPaidTerm(account: string, now: Date): StoredPaidTermReference | "stale" | "none" | "restricted";
}
```

B0 itself owns `billingEligibility` / `ensureCurrentGrant` / `admitNewAccount` exactly as
defined in B0 §Interfaces.

## Routes

- `POST /api/v1/billing/webhook` — single narrow exception: no session/CSRF; raw body; Host and
  Origin still enforced.
- `POST /api/v1/billing/checkout-intent` — session + CSRF; owner only; no agent.
- `GET /api/v1/billing/status` — session; owner’s own state only.
- `POST /api/v1/billing/portal-session` — session + CSRF; user-initiated; returns a short-TTL
  portal URL.

## Return URL and portal hosts

Portal `POST` is user-initiated and allowed (not a background call). Portal URLs are private
bearer links: never persisted, logged, or returned to an agent; responses use `no-store` and
the browser link uses `noreferrer` rather than embedding a portal iframe. The enrolled portal
origin is a **BOOT-REQUIRED HTTPS configuration**, never a request field. Official API docs
verify the live origin `https://customer-portal.paddle.com` and `/cpl_` path prefix. Sandbox
origin is a required independently verified sandbox-account input: leave the portal disabled
until its returned origin is verified against Paddle's official setup. Do not guess a sandbox
hostname, infer it from the live hostname or dynamically expand an allowlist from API output.
Use the exact mode-bound configured origin and `/cpl_` prefix, with no userinfo or alternate
port. The actual Sandbox gate must verify this input before claiming portal integration.

Checkout returns to the fixed application-root URL `PUBLIC_ORIGIN + '/?billing_return=1'`.
The flag contains no identity, token or payment claim. The UI removes it with `replaceState`
and reads its authenticated own-account billing status. It never accepts a caller-chosen
return URL or grants entitlement from the flag. No extra public server route is needed.

## PII, export and restore

The app sends only the opaque intent nonce and provider catalog ids; Paddle’s checkout collects
the necessary customer PII directly, disclosed in privacy. Merchant billing data is **not**
part of the portable knowledge export, and we do not auto-delete legally required receipts or
claim a complete data-protection export. A whole control backup already carries any
`control_billing_*` tables; restore keeps money blocks and the rotated epoch and keeps denying
new paid calls until re-verification.

## Fault and recovery matrix (closed)

| Fault | Webhook reply | New paid model call | Knowledge/auth |
|---|---|---|---|
| Bad/absent signature | 400 static | unchanged | available |
| Body/header over bound | 413/400 | unchanged | available |
| Duplicate same digest | 200 | unchanged | available |
| Same event id, different content (known binding) | 400 + durable deny | denied | available |
| Inbox insert unavailable | 503 | unchanged | available |
| Provider read timeout / stale cache | n/a | denied after freshness | available |
| past_due/canceled/refund/chargeback | 200 | denied | available |
| Early webhook before POST response (orphan) | 200 pending | no admission until correlated | available |
| Adjustment pending/partial | 200 | denied; manual review | available |
| Fully refunded annual term | 200 | future monthly grants revoked | available |
| Cadence/anchor drift or price change mid-period | 200 | denied; manual attention | available |
| Local duplicate active subscription | 200 | no extra allowance; manual gate | available |
| Supported restore | n/a | denied until re-verify | available |

## Negative acceptance proofs

- Signature-valid event binding an unknown/wrong account, or a public frontend nonce, grants nothing.
- A zero-value method-change transaction, a trial, or a status-only read never grants.
- A paid renewal uses its new verified recurring transaction without a new checkout intent;
  comparing all renewals to the initial checkout ID is a failing regression.
- A localized charged currency in the enrolled allowlist is not rejected because it differs
  from the catalog currency, and it cannot change the processing budget.
- Duplicate same-digest → 200 no second grant; same id different content → 400 + deny, no overwrite.
- A webhook before the POST response stays orphaned with no admission until strict correlation.
- A `next` page URL off the fixed official origin/path is rejected.
- A fully refunded annual term revokes future grants; pending/partial grants no prorated budget.
- A user-chosen redirect and any non-HTTPS portal host are rejected.
- JSON is parsed only after the signature check.
- A partial adjustment scan or a stale lease/adverse generation cannot publish a fresh grant.

## Test acceptance batches

1. **Frozen regression:** the 984 locally-accepted tests stay green; money bytes unchanged.
2. **Synthetic injection:** locally-signed synthetic webhooks, labelled synthetic — never
   presented as a real Paddle Sandbox integration.
3. **Paddle Sandbox:** gated on external credentials; real sandbox events and portal.
4. **LIVE:** hard-off during implementation; requires the live gate.

## Live gate (blocked inputs)

Owner-approved prices/allowances; configured and verified plan/price map; Paddle account with
KYC and India/INR resolved; runtime key storage with verified ACL; verified B1 sandbox; approved
B0; and written review of both drafts. Until then, live execution stays hard-off and sandbox
credentials are supplied only at the execution stage.

## Sources

The URLs in §Official facts and sources above (`llms.txt`, versioning, signature-verification,
respond-to-webhooks, transaction-completed, provision-access-webhooks, create-transaction,
list-adjustments) are the cited Paddle documents.

- https://developer.paddle.com/api-reference/customer-portals/create-customer-portal-session.md
- https://developer.paddle.com/build/customers/integrate-customer-portal.md
- https://developer.paddle.com/sdks/sandbox.md

**Cross-reference:** B0 is the prerequisite and must be separately user-approved and verified
first; this document is the consumer contract only and implies no B0 implementation
authorization and no circular approval.
