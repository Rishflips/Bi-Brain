# Managed spending authority design

**Status: IMPLEMENTED AND VERIFIED LOCALLY — owner approval on 2026-10-16 ("approved, go ahead ship it!"). Parent checkpoint: 396 tests, 17 Chromium journeys and 4 offline evaluations. Production managed paid processing remains off; this is not a hosted release. See BUILD_STATE.md and the executed plan for remaining activation gates.**

Scope: the financial-authority layer for the approved managed suite. This is not a
payment/checkout launch and adds no billing UI. It defines how one authoritative
ledger governs all managed paid spend while the existing per-tenant ledger stays a
conservative journal/projection. Local self-hosted accounting is unchanged.

## Verified interfaces (inspected, not assumed)
- `ControlStore` (`packages/storage/control.ts`): `managed_accounts(id,issuer,subject,state)`, sessions, token routing.
- `ManagedRuntime.acquire(tenantId)` (`packages/runtime/managed.ts`): pinned handle; the
  `Brain` carries a runtime `active()` predicate re-checked at every authorization boundary.
- `ManagedWorker` (`apps/worker/managed.ts`): selects the next `active` account from the
  control DB, acquires a pinned handle, runs one job. No caller-supplied tenant.
- `dispatchPrepared` (`apps/worker/dispatch.ts`): `reserve → markDispatched → execute → settle`.
- `DispatchLedger` (`packages/storage/spend.ts`): per-tenant SQLite, states
  `reserved|dispatched|settled|released`, frozen accounting TZ, durable overrun block.
- `packages/domain/spend.ts`: `DispatchSpec` (job_id, dispatch_key, stage, reserved_micro_usd,
  provider/model/price_version, request_hash, config_hash), identity hash, `SpendLimits`,
  `SpendSummary`, `safeAdd`. `Brain` prefs default all caps to `0`.

## Decision: one central money ledger, tenant ledger as projection
**Recommended (A).** A new central ledger (`ManagedSpendingStore`, in the control DB) is the
single authoritative source of all managed money. The existing per-tenant `DispatchLedger` is
retained unchanged in contract and becomes a **conservative journal/status projection**, never
an independent authority.

**Rejected (B).** Two independent budget ledgers reconciled later: two truths, unbounded
reconciliation complexity, and unsafe last-unit races.

**Rejected for this batch (C).** Replacing the tenant journal entirely would remove the
existing lease-fenced dispatch marker and require a broader worker/recovery redesign.

## Limits and authority
- **Account allowance:** operator-trusted, default `0`. Periods are explicit, non-overlapping
  `UTC [start, end)` windows with immutable period IDs. No monthly subscription inference; a
  period is data, not a guess.
- **Service daily cap:** operator-trusted, default `0`.
- **Per-job cumulative cap** and **user daily cap** in the frozen accounting time zone.
- Central reservation is admitted against all four dimensions atomically: account / service / job / user.
- **User preferences may only lower a policy; they can never grant authority.**
- Account identity comes from the **trusted pinned runtime handle + `active()` predicate**.
  Frontend-supplied tenant IDs are never authority.

## Dispatch identity and reservation
- Unique key `(account_id, job_id, dispatch_key)` with immutable pricing/request/config hashes
  and a server-generated `call_id` (extends existing `dispatchIdentityHash`).
- One central short `BEGIN IMMEDIATE` reserve that includes **all unresolved holds across every
  period** for the account and service — not only the current one.
- Before authority switches to central, existing legacy rows are **imported/reconciled**, or
  zero paid history is proven. No silent trust of unknown history.
- **No automatic replenishment on unknown usage**; unknown stays held.
- Reservation captures immutable allowance/service/user-period IDs. Late settlement
  applies to those IDs, never whichever period happens to be current. A new send must
  not use an expired admission period; expiration never releases a marked hold.

## Crash-safe two-store sequence (no new distributed tx framework)
Central reserve → tenant journal reserve → central mark → tenant mark → **execute only when both
marks exist**. Each mark re-checks centrally: active account, policy, budget, block; and locally:
its own lease/guard, before any network call. Cross-database atomicity is deliberately absent;
**stranded holds are an accepted, surfaced state**.

## Settlement, reconciliation and restore
- **Central settles first**, then the tenant projection is attempted independently even if the
  central step fails. The central actual-overrun is persisted together with the service block
  atomically.
- A projection failure **never undoes committed money and never triggers a resend**; it records
  `reconciliation_required`.
- Unknown holds remain in central + projection. Timed-out marked records are **not** auto-refunded.
- On restore, the central and tenant paid-blocks remain until reconciled; a stale projection must
  not present an authoritative remaining-managed-allowance figure.

## Worker seam and status
- The accounting seam is an **internal, account-bound dependency injected by `ManagedWorker`** —
  not provider authorization. Local/adapter dispatchers keep the existing `DispatchLedger`
  contract behind it.
- Shared managed **status/money views read the central ledger** and repeat the account `active()`
  authorization on every read.

## Release gates (separate, remain open)
- No production managed `HTTP 503` / main denial is lifted until concurrency, crash, restore,
  revocation-period and consent gates are all verified **and** operator policy is configured.
  **No live paid calls as part of implementation.**
- Billing (later) writes trusted entitlements to the control plane, never browser-supplied policy.
  Live TLS, native-client and license gates remain open and separate.

## Risks, defaults, and failure evidence (max 3 core scenarios)
1. **Competing processes, last service allowance:** two account workers race the final unit →
   exactly one reservation succeeds, never two.
2. **Crash + retry:** crash after every reserve/mark step, restart with a revoked/retried lease →
   no duplicate holds, no double send.
3. **Cross-period unknown + late overrun + projection failure:** central persists the overrun and
   service block atomically; the tenant projection failure surfaces as `reconciliation_required`
   without altering money.

Defaults everywhere are `0` (deny). A failed or absent gate means paid managed processing stays
off, in plain language, while capture remains available.
