# Dodo Payments setup and acceptance

The owner selected Dodo Payments on 2026-10-21 after Paddle rejected the
application. Dodo is the production startup adapter. Paddle configuration now
refuses startup; historical tests and old recovery files remain supported.

## What is implemented

Managed accounts can create a hosted checkout for one monthly or annual product,
resume its saved link, and open their own customer portal. The browser receives
no payment API key, webhook secret, customer email, or third-party checkout script.
Self-hosting needs no subscription. Export, correction, deletion, and agent access
remain available independently of payment state.

Creation persists an uncertainty barrier before contacting Dodo. Timeouts, 5xx,
rate limits, invalid responses, and unsafe returned URLs cannot create a second
checkout automatically. A signed successful payment with the exact intent metadata
can recover an ambiguous attempt. Failed attempts inside the same hosted session
do not establish a binding or prevent a later successful payment ID.

The raw webhook uses Standard Webhooks signing with authenticated delivery ID,
timestamp, exact bytes, a five-minute replay window and constant-time comparison.
The durable inbox retains a minimal projection and digest, not raw customer PII.
Replayed IDs are idempotent; changed content under an existing ID requires attention.
Webhooks establish correlation only. Independent current subscription/payment reads
must match the account binding, Dodo business, configured product, customer,
cadence, quantity one, currency allowlist, positive succeeded payment, and explicit
service period before the existing BillingAuthority can grant anything. Refunds,
disputes, cancellation, missing facts and provider outages block new paid processing.

Dodo has separate recurring product IDs for the two cadences. The authority's
logical `product_ref` is `dodo-bibrain-personal-v1`; each catalog `price_ref` is the
corresponding Dodo product ID. Both catalog entries must retain equal monthly
allowances/caps, no rollover and no automatic overages. Do not change the frozen
authority schema or bypass offline operator enrollment to activate payments.

`dodo.sqlite` is separate from historical `paddle.sqlite`. Its internal coordination
tables reuse the proven schema and retain legacy table names. Cold backups include
both when present. Restore expires checkout intents, resets leases, blocks bindings,
and retains the independent authority re-enrollment barrier. Never adopt old Paddle
payment evidence as Dodo evidence.

## Operator setup

Use a Dodo test-mode business first. Configure the monthly and annual recurring
products without trial, usage-based meters, on-demand charges or add-ons. Select
prices and processing allowance amounts before enrolling the catalog.

Set all required `BRAIN_DODO_*` fields in the server/worker secret environment,
following `.env.example`: mode, API key, business ID, distinct monthly/annual product
IDs, allowed charged currencies, webhook signing secret and webhook endpoint ID.
Use the same environment for both processes. Remove old `BRAIN_PADDLE_*` fields.
The first allowlisted currency is the fixed checkout currency; customer currency
switching and discount-code entry are disabled so payment cannot drift outside
the configured verification boundary.
No environment variable with a secret may have a `VITE_` prefix.

Register the HTTPS webhook endpoint:

`https://<chosen BiBrain host>/api/v1/billing/webhook`

Subscribe to `payment.succeeded`, subscription lifecycle changes, refunds and
disputes. Other authenticated event families are acknowledged and ignored. Dodo
must preserve the server-created `bibrain_intent` metadata on the payment.
The return address is fixed to the configured BiBrain origin. A return page never
enables allowance. The portal uses `send_email=false`, so opening it does not send
an external message.

Supported hosted origins are `test.checkout.dodopayments.com` / `checkout.dodopayments.com`
and `test.customer.dodopayments.com` / `customer.dodopayments.com`. Returned URLs
outside the environment-specific allowlist are refused. Verify the actual account's
test responses; custom checkout domains require a reviewed allowlist change.

Paid model processing remains independently default-off behind authority enrollment,
provider activation, current evidence, account consent, explicit monetary caps and
send-time checks. `BRAIN_DODO_ALLOW_LIVE=1` is a separate live-startup gate, not
authorization to enable live billing or paid model traffic.

## Remaining acceptance gates

- Actual Dodo account approval, secure test credentials, product IDs and webhook registration.
- Test checkout, signed delivery, independent current payment proof and correct allowance.
- Monthly renewal and annual billing with monthly no-rollover processing windows.
- Payment failure, same-session retry, delayed/out-of-order replay, refund and dispute.
- Portal cancellation and current-term behavior; export/deletion without payment.
- Chosen host HTTPS, real identity recovery, cold encrypted recovery and deletion drill.
- Explicit live business/release approval, prices, allowance amounts and support/legal decisions.

No real Dodo request, customer payment or paid-model activation is implied by local
tests. Oversized or ambiguous provider histories fail closed for operator review;
the adapter does not infer service dates from a payment timestamp.

## Primary API references checked

- [Hosted checkout](https://docs.dodopayments.com/developer-resources/checkout-session)
- [Subscription integration](https://docs.dodopayments.com/developer-resources/subscription-integration-guide)
- [Official TypeScript API definitions](https://github.com/dodopayments/dodopayments-typescript/tree/main/src/resources)
- [Standard Webhooks specification](https://www.standardwebhooks.com/)
