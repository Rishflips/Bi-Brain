# Managed Spending Authority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Ollama DeepSeek V4.1 Flash executes; the parent agent independently reviews/tests/verifies and owns `BUILD_STATE.md` and every Playwright run; GPT-6 Astra supplied the architecture (no new Astra or model call is needed).

**Goal:** Make one central control-plane ledger the single authoritative source of all managed paid spend while the existing per-tenant `DispatchLedger` becomes a conservative journal/projection, with paid activation still off.

**Architecture:** Add a pure `packages/domain/managed-spend.ts` type/validation module and a `ManagedSpendingStore` over the **existing** control database, admitting one short `BEGIN IMMEDIATE` reserve across a single global service cap plus account-period, cumulative-job and frozen-user-day limits. A narrow internal `DispatchAccounting` seam is injected into the worker; a managed coordinator runs the ordered central-reserve → tenant-reserve → central-mark → tenant-mark sequence before any I/O and settles centrally first.

**Tech Stack:** Existing strict TypeScript, Node 24.19 LTS, `node:sqlite`, Fastify, React, Zod, Vitest. No new service, dependency, queue or graph store; self-hosted behavior unchanged.

**Spec:** `docs/superpowers/specs/2026-10-16-managed-spending-design.md` (approved 2026-10-16, "approved, go ahead ship it!"). Supporting: `docs/superpowers/specs/2026-10-16-managed-suite-design.md`, `docs/superpowers/plans/2026-10-16-dispatch-accounting.md`, `docs/superpowers/plans/2026-10-16-worker-dispatch-integration.md`.

## Global Constraints

- Integer micro-USD only; every sum goes through `safeAdd`/`checkedSum`. Deterministic clocks in tests; every authoritative clock read happens **inside** the acquired write transaction.
- One global service bucket only: `MANAGED_SERVICE_ID = "managed-processing"`. There is no client-supplied service string; the service cap spans every provider, stage and account.
- Defaults everywhere are `0` (deny). A user preference may only **lower** an operator policy: effective cap = `Math.min(stored, current, policy)`.
- Short SQLite transactions; no model/network call inside a transaction.
- Never persist a source body, prompt, key, evidence text or model output in the money tables — only opaque identity hashes and amounts.
- Preserve every existing account/session/token-routing row and every tenant `reservations`/`provider_dispatches` row value-for-value. No destructive migration; the control identity schema is not rewritten and tenant migration 4 is not touched.
- **Restore-only exception:** a managed restore must revoke or permanently invalidate restored opaque session/token-routing credentials (an old backup must not resurrect access), while preserving account identities, policies and financial rows. Normal migration still preserves every row unchanged.
- No admin HTTP/browser policy setter. Operator policy is written only by the trusted internal CLI/store API with Zod validation.
- Managed paid activation stays **off** in this batch. The server must report `connected_processing_available: false` while the production feature is off, **regardless** of an allow flag or configured policy. The only policy signal is the authenticated owner's per-account `spend.configured` (their own allowance exists); the public runtime metadata carries no account/policy field, only a plain `managed_paid_reason`. Report the exact gate instead of faking availability.
- No real provider/identity/payment/network paid call, commit, push, deployment or global config change by an implementer. No secrets in bundles, URLs, logs, fixtures or `.env` docs.
- Each task owns its listed files exclusively. Run tasks in order; stop and report if a prerequisite interface differs rather than rewriting a neighbour. Parent-owned review tests (`*-review.test.ts`, `BUILD_STATE.md`, Playwright) are never edited by the executor.
- Heavy commands run **serially** on Windows: focused `npm test` first, then `npm run typecheck && npm run lint && npm run build`. Do not rerun or reset the deliberate ~20-second Git fixture deadline.

## File structure

| File | Task | Responsibility |
|---|---|---|
| `packages/domain/managed-spend.ts` | 1 (new) | Pure managed money types, singleton service id, validators, canonical UTC/instant helpers, content/binding identity hashes. |
| `packages/storage/managed-spending.ts` | 1 (new) | `ManagedSpendingStore`: schema v1, policy setters, reserve/mark/settle/release/receipt/status over the control DB. |
| `tests/integration/managed-spending.test.ts` | 1 (new) | Policy, four-dimension admission, immutability, rollover, expiry, overrun, schema guard. |
| `tests/integration/managed-spending-contention.test.ts` | 1 (new) | Real two-process contention and expired-while-lock-wait. |
| `apps/worker/accounting.ts` | 2 (new) | `DispatchAccounting` seam interface (no provider authority). |
| `apps/worker/managed-accounting.ts` | 2 (new) | `ManagedDispatchAccounting` coordinator (central + tenant ordering, history eligibility). |
| `packages/storage/spend.ts` | 2 (modify) | Add `readReceipt` alias so `DispatchLedger` satisfies the seam. |
| `apps/worker/dispatch.ts` | 2 (modify) | Type `deps.ledger` as `DispatchAccounting`. |
| `apps/worker/engine.ts` | 2 (modify) | Require an accounting seam for any tenant-bound brain; inject instead of constructing a local ledger. |
| `apps/worker/managed.ts` | 2 (modify) | `accountingFactory` injection; default central coordinator. |
| `packages/runtime/managed-money.ts` | 3 (new) | Central money view for one account; re-checks `active()`. |
| `packages/domain/service.ts` | 3 (modify) | `Brain.status()` overlays the central view; local path unchanged. |
| `packages/runtime/managed.ts` | 3 (modify) | Supply the central view closure to each managed `Brain`. |
| `apps/server/startup-gates.ts` | 3 (new) | `managedActivationGate`: paid stays off; reports policy readiness internally, availability always false. |
| `scripts/managed-policy.ts` | 3 (new) | Trusted operator CLI for period/service/account policy. |
| `apps/server/app.ts` | 3 (modify) | Runtime metadata reads the gate; `connected_processing_available` stays false. |
| `apps/web/src.tsx` | 3 (modify) | Show central remaining/blocked reason; no dead re-enable button. |
| `packages/storage/managed-restore-policy.ts` | 4 (new) | `applyControlRestoreBarrier`; revoke restored credentials; central default-deny. |
| `scripts/backup.ts`, `scripts/restore.ts` | 4 (modify) | Scoped managed backup/restore pairing root/control/tenant; never break local. |
| `docs/MANAGED_RUN.md` | 4 (modify) | Operator policy + restore instructions, no secrets. |
| `tests/integration/managed-accounting.test.ts` | 2 (new) | Crash/revocation/known-settlement/projection-failure/no-resend ordering. |
| `tests/integration/managed-money-view.test.ts` | 3 (new) | Central status view, blocked re-enable refusal, gate default-off. |
| `tests/integration/managed-activation.test.ts` | 3 (new) | Actual server/worker process fixture for the exact gate. |
| `tests/integration/managed-restore-policy.test.ts` | 4 (new) | Default-deny after restore; restored credentials never work; identity preserved. |

---

## Task 1: Central money primitives (independently green, worker untouched)

> **Status: verified (2026-10-16).** Parent independently reran the four owned files plus its `managed-spending-review.test.ts`: **29/29** green after the zero-cap and strict-ISO repairs.

Deliverable: a tested central money module over the control DB. Nothing in `apps/worker`, `packages/runtime` or the tenant ledger changes, so the existing suite stays green.

**Files:** Create `packages/domain/managed-spend.ts`, `packages/storage/managed-spending.ts`, `tests/integration/managed-spending.test.ts`, `tests/integration/managed-spending-contention.test.ts`.

**Interfaces — `packages/domain/managed-spend.ts` (pure):**
```ts
export const MANAGED_SERVICE_ID = "managed-processing" as const;
export type ManagedServiceId = typeof MANAGED_SERVICE_ID;

export type ManagedLimits = { per_job_micro_usd: number; user_daily_micro_usd: number; time_zone: string };
export type ManagedDispatchSpec = {
  account_id: string; job_id: string; dispatch_key: string; stage: DispatchStage;
  reserved_micro_usd: number; provider: string; model: string; price_version: string;
  request_hash: string; config_hash: string; limits: ManagedLimits;
};
export type ManagedReservationState = "reserved" | "dispatched" | "settled" | "released";
export type AccountAllowancePeriod = {
  period_id: string; account_id: string; starts_at: string; ends_at: string;
  allowance_micro_usd: number; state: "active" | "revoked"; granted_at: string; revoked_at: string | null;
};
export type ServicePolicy = { service: ManagedServiceId; daily_micro_usd: number; version: number; updated_at: string };
export type AccountSpendingPolicy = {
  account_id: string; per_job_micro_usd: number; user_daily_micro_usd: number;
  accounting_tz: string | null; version: number; updated_at: string;
};
export type ManagedReservation = {
  call_id: string; account_id: string; job_id: string; dispatch_key: string; service: ManagedServiceId; stage: DispatchStage;
  state: ManagedReservationState; reserved_micro_usd: number; actual_micro_usd: number | null;
  content_hash: string; identity_hash: string;
  account_period_id: string; service_day: string; user_day: string; accounting_tz: string;
  stored_per_job_micro_usd: number; stored_user_daily_micro_usd: number;
  provider: string; model: string; price_version: string; request_hash: string; config_hash: string;
  projection_call_id: string | null; reconciliation_required: boolean;
  created_at: string; marked_at: string | null; settled_at: string | null;
};
export interface ManagedMoneyReceipt {
  call_id: string; state: ManagedReservationState; reserved_micro_usd: number; actual_micro_usd: number | null;
  reconciliation_required: boolean; account_period_id: string; service_day: string; user_day: string;
}
export interface ManagedAccountStatus {
  account_id: string; active: boolean; period: AccountAllowancePeriod | null; service: ServicePolicy | null;
  policy: AccountSpendingPolicy | null;
  committed: { account_period_micro_usd: number; service_day_micro_usd: number; user_day_micro_usd: number; unresolved_micro_usd: number };
  blocked: boolean; blocked_reason: "overrun" | "restored_backup" | "reconciliation_required" | null; reconciliation_required: boolean;
}
export function utcDay(now: Date): string;                                  // YYYY-MM-DD in UTC
export function managedContentHash(spec: ManagedDispatchSpec): string;    // request/config/amount/pricing/stage + account/job/slot
export function managedIdentityHash(spec: ManagedDispatchSpec, binding: {
  content_hash: string; account_period_id: string; service: ManagedServiceId; service_day: string; user_day: string;
  accounting_tz: string; stored_per_job_micro_usd: number; stored_user_daily_micro_usd: number;
}): string;                                                                 // binding spans period ids, service, tz and the stored USER caps
export function validateManagedLimits(input: unknown): ManagedLimits;
export function validateManagedDispatchSpec(input: unknown): ManagedDispatchSpec;
export function validateAllowancePeriodInput(input: unknown): { account_id: string; starts_at: string; ends_at: string; allowance_micro_usd: number };
export function validateServicePolicyInput(input: unknown): { daily_micro_usd: number };
export function validateAccountPolicyInput(input: unknown): { account_id: string; per_job_micro_usd: number; user_daily_micro_usd: number };
```
Reuse `accountingDay`, `checkedSum`, `safeAdd`, `validateActualMicroUsd`, `microUsd`, `boundedText`, the IANA-time-zone check and `canonical` from `packages/domain/spend.ts` and `logic.ts`. `validateAllowancePeriodInput` requires a strict ISO 8601 date-time with an explicit `Z` or numeric offset (`z.string().datetime({ offset: true })`), rejecting date-only, offset-less, locale-text and impossible-calendar values as well as `ends_at <= starts_at`, and returns `new Date(x).toISOString()` so every stored/compared instant is one canonical UTC form; an explicit offset such as `+05:30` is accepted and normalized.

**Interfaces — `packages/storage/managed-spending.ts`:**
```ts
export const managedMoneySchemaVersion = 1;
export class ManagedSpendingStore {
  constructor(readonly control: ControlStore, readonly clock: () => Date = control.clock);
  configureAccountPeriod(input: unknown): AccountAllowancePeriod;   // overlap rejected; exact duplicate idempotent
  revokeAccountPeriod(periodId: string): AccountAllowancePeriod;     // active -> revoked; idempotent
  setServicePolicy(input: unknown): ServicePolicy;                  // singleton service; version+1
  setAccountPolicy(input: unknown): AccountSpendingPolicy;          // per-job/user-day ceilings; tz NOT set here
  reserve(spec: ManagedDispatchSpec): ManagedReservation;
  mark(call_id: string, current_limits: ManagedLimits): ManagedReservation;
  settleKnown(call_id: string, actual_micro_usd: number): ManagedReservation;
  releaseUndispatched(call_id: string): ManagedReservation;
  readReceipt(call_id: string): ManagedMoneyReceipt;
  linkProjection(call_id: string, projection_call_id: string): void;
  receiptByProjection(projection_call_id: string): ManagedReservation | undefined;
  flagReconciliationRequired(call_id: string): void;
  /** Central settlement failure: account flag + durable service-wide deny. */
  flagSettlementFailure(call_id: string): void;
  accountStatus(account_id: string): ManagedAccountStatus;
}
```
`ControlStore` already exposes `readonly db` and `readonly clock`; add a private `tx<T>(fn)` helper using `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK`.

**Schema (control DB, namespace version 1, created in one immediate transaction whose future-version guard runs before any money DDL):**
```sql
CREATE TABLE IF NOT EXISTS managed_money_schema(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS managed_account_periods(
  period_id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES managed_accounts(id),
  starts_at TEXT NOT NULL, ends_at TEXT NOT NULL,
  allowance_micro_usd INTEGER NOT NULL CHECK(allowance_micro_usd>=0),
  state TEXT NOT NULL CHECK(state IN ('active','revoked')),
  granted_at TEXT NOT NULL, revoked_at TEXT,
  UNIQUE(account_id, starts_at, ends_at));
CREATE TABLE IF NOT EXISTS managed_service_policy(
  service TEXT PRIMARY KEY CHECK(service='managed-processing'),
  daily_micro_usd INTEGER NOT NULL CHECK(daily_micro_usd>=0), version INTEGER NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS managed_account_policy(
  account_id TEXT PRIMARY KEY REFERENCES managed_accounts(id),
  per_job_micro_usd INTEGER NOT NULL CHECK(per_job_micro_usd>=0),
  user_daily_micro_usd INTEGER NOT NULL CHECK(user_daily_micro_usd>=0),
  accounting_tz TEXT, version INTEGER NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS managed_reservations(
  call_id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES managed_accounts(id),
  job_id TEXT NOT NULL, dispatch_key TEXT NOT NULL,
  service TEXT NOT NULL CHECK(service='managed-processing'),
  stage TEXT NOT NULL CHECK(stage IN ('decision','reasoning','repair')),
  state TEXT NOT NULL CHECK(state IN ('reserved','dispatched','settled','released')),
  reserved_micro_usd INTEGER NOT NULL CHECK(reserved_micro_usd>=0),
  actual_micro_usd INTEGER CHECK(actual_micro_usd IS NULL OR actual_micro_usd>=0),
  content_hash TEXT NOT NULL, identity_hash TEXT NOT NULL,
  account_period_id TEXT NOT NULL REFERENCES managed_account_periods(period_id),
  service_day TEXT NOT NULL, user_day TEXT NOT NULL, accounting_tz TEXT NOT NULL,
  stored_per_job_micro_usd INTEGER NOT NULL CHECK(stored_per_job_micro_usd>=0),
  stored_user_daily_micro_usd INTEGER NOT NULL CHECK(stored_user_daily_micro_usd>=0),
  provider TEXT NOT NULL, model TEXT NOT NULL, price_version TEXT NOT NULL,
  request_hash TEXT NOT NULL, config_hash TEXT NOT NULL,
  projection_call_id TEXT, reconciliation_required INTEGER NOT NULL DEFAULT 0 CHECK(reconciliation_required IN (0,1)),
  created_at TEXT NOT NULL, marked_at TEXT, settled_at TEXT,
  UNIQUE(account_id, job_id, dispatch_key));
CREATE TABLE IF NOT EXISTS managed_service_blocks(
  service TEXT PRIMARY KEY CHECK(service='managed-processing'),
  call_id TEXT NOT NULL, account_id TEXT NOT NULL,
  over_micro_usd INTEGER NOT NULL CHECK(over_micro_usd>=0), at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS managed_money_blocks(key TEXT PRIMARY KEY, reason TEXT NOT NULL, at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS managed_reservations_account ON managed_reservations(account_id,state);
CREATE INDEX IF NOT EXISTS managed_reservations_job ON managed_reservations(account_id,job_id,state);
CREATE INDEX IF NOT EXISTS managed_reservations_service_day ON managed_reservations(service_day,state);
CREATE UNIQUE INDEX IF NOT EXISTS managed_reservations_projection ON managed_reservations(projection_call_id);
INSERT OR IGNORE INTO managed_money_schema VALUES(1, <now>);
```
The constructor's immediate transaction reads `max(version)` (creating the meta table first if absent) and throws `BrainError("UNAVAILABLE", "Managed spending schema is from a newer version.", 503)` when it exceeds 1, rolling back before money DDL; the identity tables are never altered.

**Admission (`reserve`) rules:** inside the TX (clock read after `BEGIN IMMEDIATE`): (1) look up the slot `(account_id, job_id, dispatch_key)` **first**; if present, require `content_hash` to equal `managedContentHash(spec)` and the incoming per-job/user-day caps to equal the stored caps, then return the stored row unchanged — never recompute the day, so the same slot after rollover is never new money; any mismatch (amount, request/config, pricing, stage, caps) throws `DISPATCH_CONFLICT` 409. (2) account exists and is `active`, else `UNAUTHORIZED` 401. (3) the single active period containing `now` (`state='active'`, `starts_at <= now < ends_at`), else `BUDGET_EXHAUSTED` 409. (4) reject a `managed_money_blocks` row or a `managed_service_blocks` row with `BUDGET_BLOCKED` 409. (5) require the service policy and account policy; each missing or `0` denies. (6) effective caps: `min(spec.limits.per_job, policy.per_job)` and `min(spec.limits.user_daily, policy.user_daily)`. (7) committed sums (all with `checkedSum`): `job` = settled actual + unresolved holds for `(account_id, job_id)`; `user_day` = settled actual for the account-day + **all** unresolved holds for the account; `account_period` = settled actual in the period + all unresolved holds for the account; `service_day` = settled actual for the UTC day + all unresolved holds for the service. (8) each of the four caps must be positive — effective per-job, effective user-day, the period allowance and the service policy; a zero cap denies even when the estimate itself is zero, while a legitimate zero estimate is admitted under positive caps. (9) admit only if each `committed + amount <= cap`; else `BUDGET_EXHAUSTED`. (10) freeze `accounting_tz` into the account policy on this **successful** admission only; a later different `spec.limits.time_zone` throws `ACCOUNTING_TIMEZONE_FROZEN` 409. (11) insert `reserved` with stored cap snapshots, `content_hash` and `identity_hash`.

**`mark(call_id, current_limits)`:** inside the TX: load the row; `dispatched` → `ALREADY_DISPATCHED` 409, `settled`/`released` → `INVALID_STATE` 409 (a mark never becomes a fresh permission for an already-marked call). Re-check account active (`UNAUTHORIZED`), no block (`BUDGET_BLOCKED`), and that the original bindings are live: period still `active` with `now < ends_at`, `service_day === utcDay(now)`, `user_day === accountingDay(now, row.accounting_tz)`, else `PERIOD_EXPIRED` 409. Validate `current_limits`; require `current_limits.time_zone === row.accounting_tz` else `ACCOUNTING_TIMEZONE_FROZEN`. Effective caps = `min(stored, current, operator policy)`; a zero effective cap in any of the four dimensions denies the mark, then re-check the already-counted committed sums against the effective caps with **no** extra debit of this row. Compare-and-set `reserved → dispatched`.

**`settleKnown`:** works regardless of account state or period expiry and never re-checks the period; an identical repeat is idempotent, a conflicting amount throws `SETTLEMENT_CONFLICT`. `reserved` → `INVALID_STATE` (mark first); `released` → `INVALID_STATE`. When `actual > reserved`, persist the actual and upsert the singleton `managed_service_blocks` row (`over = actual - reserved`) in the same transaction. **`releaseUndispatched`** only compares-and-sets `reserved → released`.

- [x] **Step 1: Write the failing store test** (batch 1). `tests/integration/managed-spending.test.ts` uses a real temp-file `ControlStore`, a mutable `testClock`, and `provision`ed accounts. Cases: (a) missing period/service/account policy all deny with `BUDGET_EXHAUSTED`; (b) each of the four dimensions isolated by making the others high — allowance `5`/service `100`/job `100`/user `100` with a `7` request denies, service `5` denies, job `5` denies a second `3`, user `5` denies; (c) the happy case allowance `20`/service `10`/job `10`/user `10`/`7` admits with `service_day==="2026-10-16"`; (d) an unresolved hold from `2026-10-16` counts against a `2026-10-17` period (allowance `10` ⇒ second `7` denies); (e) `mark` refuses a lowered cap; (f) `mark` after a revoked period throws `PERIOD_EXPIRED` while `settleKnown` after a mark on a suspended account succeeds.
- [x] **Step 2: Observe RED.** Run `npm test -- tests/integration/managed-spending.test.ts` → FAIL (module absent).
- [x] **Step 3: Implement** the pure module and the store exactly to the interfaces/rules above.
- [x] **Step 4: Observe GREEN** for batch 1; then `npm run typecheck && npm run lint`.
- [x] **Step 5: Extend the test** (batch 2, run to GREEN as each behavior is added). Add: identical `job_id` across two accounts stays independent for the job dimension; the global service cap spans two **different** accounts (each allowance `20`, caps `100`, service cap `10`, two `7` requests ⇒ exactly one); duplicate `reserve` is idempotent and any changed immutable field conflicts; the same slot after a rollover returns the stored `service_day` with no new row; `mark` rejects an expired period, an expired UTC service day and an expired user day; overrun `settleKnown(call,12)` writes the service block and makes the next reserve `BUDGET_BLOCKED` with `accountStatus.blocked_reason === "overrun"`; a max-safe-integer row then `+1` throws `SPEND_OVERFLOW`; `configureAccountPeriod` canonicalizes `+05:30` instants and rejects an overlapping window expressed differently (`PERIOD_CONFLICT`); a failed reserve does not freeze the time zone while the first success does; `PRAGMA table_info(managed_reservations)` has no `body`/`prompt`/`key` column; a pre-seeded `managed_money_schema` version `2` makes construction throw while `managed_accounts`/`managed_sessions`/`managed_agent_tokens` rows stay equal.
- [x] **Step 6: Write the failing contention test.** `tests/integration/managed-spending-contention.test.ts` mirrors `spend-contention.test.ts`: (a) two real Node children (`--import tsx`) each build `ControlStore` + `ManagedSpendingStore` over two **different** accounts (allowance `20`, caps `100`) with the singleton service cap `10`, wait at an IPC barrier, then `reserve` `7`; assert exactly one `ok`, loser code `BUDGET_EXHAUSTED`, and a verifying `accountStatus` sees `unresolved_micro_usd === 7`. (b) reuse the `holdWriteLock` child pattern: seed an active period ending ~1500 ms ahead plus a reserved row, hold the write lock ~1800 ms, then `mark` with a real-clock store ⇒ `PERIOD_EXPIRED`, proving the clock read happens inside the acquired transaction.
- [x] **Step 7: GREEN + report.** Run the contention file → PASS; run `npm run typecheck && npm run lint && npm run build`. Report exact RED/GREEN counts, the exported interfaces/schema and that no worker/runtime/existing file changed. Do not commit; do not run the full `npm test` (the parent owns that); do not claim any paid activation.

---

## Task 2: Account-bound coordinator and worker accounting seam

> **Status: implemented locally (2026-10-16); review repairs applied; accepted locally.** The parent independently reran the coordinator plus its `managed-accounting-review.test.ts` (4/4) and `managed-worker.test.ts` (9) — **31/31 green**. Full serially-run suite **356/356 across 41 files** green at Task 2 scope; typecheck, lint and build pass. Repairs: the history audit now spans every tenant paid record (with `stage`) rather than only the current job; a re-reserve returns the central authority; a central settlement failure writes a durable service-wide deny via `flagSettlementFailure`; and a failure to persist that safety marker trips a process-local shared-handle fuse that fail-stops managed scheduling while capture stays available. The worker also re-checks trusted state (abort, the caller guard for consent/sources/goal/principal, and that the user's caps were not lowered) after the dispatch mark commits and before the single network call; a post-mark failure throws `PROVIDER_UNAVAILABLE` so the job ends failed with its hold retained and is never resent or refunded.

Deliverable: the worker depends only on a narrow internal accounting seam; for managed tenants, `ManagedDispatchAccounting` runs the ordered two-store sequence, and **only a fresh successful central mark may permit the current invocation to execute**.

**Files:** Create `apps/worker/accounting.ts`, `apps/worker/managed-accounting.ts`, `tests/integration/managed-accounting.test.ts`; modify `packages/storage/spend.ts`, `packages/storage/managed-spending.ts` (read-only lookups only), `apps/worker/dispatch.ts`, `apps/worker/engine.ts`, `apps/worker/managed.ts`, `tests/integration/worker-dispatch.test.ts`, `tests/integration/managed-worker.test.ts`.

**Interfaces:**
```ts
// apps/worker/accounting.ts
export interface DispatchAccounting {
  readonly accountId?: string; // present only for a tenant-bound central coordinator
  reserve(spec: DispatchSpec, lease: JobLease, limits: SpendLimits): DispatchRecord;
  markDispatched(callId: string, lease: JobLease): DispatchRecord;
  settle(callId: string, actualMicroUsd: number): DispatchRecord;
  releaseUndispatched(callId: string): DispatchRecord;
  readReceipt(callId: string): DispatchRecord | undefined;
  /** Authoritative latest receipt for a job, available before a call id is known. */
  receiptForJob(jobId: string): DispatchRecord | undefined;
  /** True while the job has an unresolved (non-released) paid record. */
  hasUnresolved(jobId: string): boolean;
}
export class LocalDispatchAccounting implements DispatchAccounting {
  constructor(store: Storage, clock: () => Date); // self-hosted tenant journal, unchanged behavior
}
export class TenantOnlyAccounting implements DispatchAccounting {
  constructor(store: Storage, clock: () => Date, accountId: string); // refuse paid, serve reads
}
// apps/worker/managed-accounting.ts
export class ManagedDispatchAccounting implements DispatchAccounting {
  constructor(central: ManagedSpendingStore, brain: Brain, clock?: () => Date);
  // accountId is `brain.tenantId`; binding is refused when the control store
  // does not know that account, so an A coordinator cannot attach to a B brain.
}
```
`DispatchLedger` (tenant) gains a one-line `readReceipt(callId) { return this.get(callId); }` alias. The Task 1 store gains three **read-only** lookups used by the coordinator — no financial transition and no schema change: `reservationForSlot(accountId, jobId, dispatchKey)`, `latestForJob(accountId, jobId)` and `hasUnresolvedForJob(accountId, jobId)`. `dispatchPrepared`'s `deps.ledger` becomes `DispatchAccounting` while keeping the existing method names; `Worker` requires the account-bound seam for any tenant-bound brain (extractive still works through `TenantOnlyAccounting`) and the engine reads receipts through `receiptForJob`/`hasUnresolved` instead of raw tenant SQL. `ManagedWorkerOptions` gains `accountingFactory?: (brain: Brain) => DispatchAccounting`, defaulting to a coordinator over a fresh `ManagedSpendingStore(runtime.control)` and the trusted pinned brain.

Coordinator semantics (fail closed): `reserve` = central reserve → verify the returned row belongs to `this.accountId` (reject foreign ids with `UNAUTHORIZED`) → tenant reserve → `linkProjection`; a tenant failure leaves a surfaced central hold. `markDispatched` = central `mark` **only**; a fresh `reserved → dispatched` CAS is the sole permission for the caller to execute. Any `ALREADY_DISPATCHED`/`settled`/`released` central row denies this invocation (safe stranded hold) — never treat a pre-existing mark as success and never complete a both-marked record. Only after the fresh central CAS does it attempt the tenant mark; a tenant mark failure is surfaced, not auto-healed. `settle` = central `settleKnown` first, then the tenant `settle` independently; a tenant failure calls `flagReconciliationRequired` and never undoes central money or resends. `readReceipt` returns the **central** authoritative state/cost (mapped to the tenant `DispatchRecord` shape) even when the projection failed; `released` maps to `no_attempt`, an unknown marked hold maps to `cost_micro_usd: null`. `releaseUndispatched` refuses unless both rows are still `reserved`. History eligibility is enforced before any reserve and audits **every** paid record of this tenant (any job), matching strictly on account/job/slot/stage/price/request/config/bound: any unmapped legacy hold, unmapped settled/new record or restored-tenant block is denied pending operator reconciliation — never auto-imported — while a legitimate crash orphan is linked only on a full immutable match and a mapped record is never re-executed. A reserve whose central row already exists returns the **central** authority mapped to the tenant call id, so the centre stays the single truth even after projection drift. When the central settlement itself cannot commit, the coordinator persists a durable service-wide deny (`flagSettlementFailure`: `reconciliation_required` plus a `managed_money_blocks` row) so no account can under-count the known charge; a failure to persist that marker is escalated, not swallowed.

**Fatal IO fuse (narrow, process-local).** If the safety marker cannot be persisted — because that same write may have been lost — `flagSettlementFailure` poisons the shared `ControlStore` handle in a module `WeakSet` and throws the typed internal `AccountingPersistenceError`. Every `reserve`/`mark` on that handle then fails closed even through a brand-new `ManagedSpendingStore`, and `accountStatus` reports `blocked: true`, `blocked_reason: "reconciliation_required"`. `ManagedDispatchAccounting.settle` still attempts the independent tenant projection, then rethrows the fatal; the worker engine rethrows it instead of downgrading it to an ordinary job error; and `ManagedWorker` sets `stopped = true` and propagates it once (releasing the pinned handle in `finally`). Capture through the brain/HTTP is unaffected. The fuse is in-memory only and is never cleared on DB recovery — it is **not** a durable or multi-process guarantee. The narrow remaining gate is that a process restart relies on managed paid processing defaulting to off (`apps/worker/main.ts` `unavailableProvider`); future managed activation stays blocked pending an explicit operator reconciliation/restart/control-IO drill. No outbox, process registry or 2PC framework is added.

- [x] **Step 1: Write the failing test.** `tests/integration/managed-accounting.test.ts` uses a temp `ControlStore`, a provisioned account, real `Storage`/`Brain`/`DispatchLedger`, a fixed clock and `fakePreparedProvider`. Cases: (a) a tenant legacy `reservations` row means `reserve` throws and a central `reserved` hold with `projection_call_id IS NULL` remains; (b) crash after each boundary (central reserve only, central+tenant reserved, central marked but tenant not) leaves holds and `provider.calls === 0` — a retry never resumes a pre-existing central mark and never resends; (c) a suspended account denies the mark with `UNAUTHORIZED` and no provider call; (d) known settlement `7` settles both stores; a projection failure leaves central `settled 7`, tenant held, `reconciliation_required === 1`, `readReceipt` still reporting central `settled 7`, with `provider.calls` unchanged; (e) a foreign central/projection id is rejected.
- [x] **Step 2: Observe RED.** Run `npm test -- tests/integration/managed-accounting.test.ts` → FAIL.
- [x] **Step 3: Implement** the seam, the `readReceipt` alias, the coordinator, and the `Worker`/`ManagedWorker` injection.
- [x] **Step 4: Observe GREEN, then verify the local contract is unchanged.** Run the new file plus `worker-dispatch`, `brain`, `safety`, `managed-worker` → PASS. Run `npm run typecheck && npm run lint`. Do not commit; managed paid processing stays denied by `apps/worker/main.ts`.

---

## Task 3: Central money view, status and safe activation gate

> **Status: implemented locally (2026-10-16).** Task 3 focused files green **18/18** (my `managed-money-view.test.ts` 6, `managed-activation.test.ts` 4, the parent's independent `managed-money-view-review.test.ts` 6 and `managed-policy-review.test.ts` 2); typecheck, lint and build pass. `configured` reflects a positive account+service policy; `service_available` reflects service **capacity** today (positive policy AND headroom AND unblocked), never paid activation, and `available` stays hard-false. The operator CLI validates arity, UUID/ISO/integer arguments, an existing real managed root and a read-only control-schema preflight **before** the runtime opens, so it never creates or rewrites a wrong/unrelated database.

Deliverable: managed status/money reads the central ledger and re-checks `active()`; the batch reports the exact gate while paid stays off.

**Files:** Create `packages/runtime/managed-money.ts`, `apps/server/startup-gates.ts`, `scripts/managed-policy.ts`, `tests/integration/managed-money-view.test.ts`, `tests/integration/managed-activation.test.ts`; modify `packages/domain/service.ts`, `packages/runtime/managed.ts`, `apps/server/app.ts`, `apps/web/src.tsx`.

**Interfaces:** `managedMoneyView(control, accountId, clock?)` returns the `spend` view from `accountStatus` and throws `UNAUTHORIZED` when the account is not active (never a stale projection). `Brain` gains an optional fifth constructor argument `spending?: () => ManagedSpendView`; `status()` overlays it when present and keeps the legacy `actual`/`reserved` aliases. `managedActivationGate(input)` returns `{ active: false, reason }` unless every gate is proven and policy configured; **`active` stays `false` for this batch**. `apps/server/app.ts` always reports `connected_processing_available: false` while the production feature is off and exposes only a plain `managed_paid_reason` string — no public account, policy, eligibility or capability field. The authenticated owner's own `spend.configured` is the only policy signal. `scripts/managed-policy.ts` (`configure-period`, `set-service`, `set-account`, `revoke-period`) is the only policy writer and prints no secrets.

- [x] **Step 1: Write the failing tests.** `managed-money-view.test.ts`: a configured control DB shows remaining/counts a hold; an overrun yields `blocked_reason "overrun"`; suspending the account throws. `managed-activation.test.ts` spawns the real server/worker over an isolated managed root and asserts `/api/v1/runtime.connected_processing_available === false` and the paid denial text are exact **both** with no policy and after `managed-policy` plus `BRAIN_MANAGED_ALLOW_PAID=1`. Do not add any test that claims availability or exposes account policy while the worker denies.
- [x] **Step 2: Observe RED** → Step 3 implement → **Step 4 GREEN**, then `npm run typecheck && npm run lint && npm run build`. Report the exact gate string; the parent owns Playwright; do not commit.

---

## Task 4: Control backup/restore barrier, cold/offline recovery and docs

> **Status: implemented locally (2026-10-16); review repairs applied.** Task 4 focused files green **16/16** (`managed-restore-policy.test.ts` 3, `managed-recovery.test.ts` 6, plus the parent's independent read-only `managed-restore-review.test.ts` 2 and `managed-recovery-review.test.ts` 5); typecheck, lint and build pass. Repairs after review: a missing/unreadable current tenant now rejects the restore instead of silently publishing older content; all existing ancestors of the output (and every tenant directory, marker, db, vault and quarantine entry) are validated as real non-link paths before any SQLite open; the `copyTree` WAL/SHM skip was removed; the manifest is a strict closed Zod schema (UUID accounts, ISO zone, enum state, unique paths/hashes/sizes) whose account inventory must match the bundle's own control database and whose top level admits no extra entries; each SQLite snapshot is consolidated to one file and checked with `integrity_check`/`foreign_key_check`; the incomplete marker stays in place through the rename and is removed only after a successful publish; and `ManagedRuntime` refuses a root whose marker exists as any link. A failed backup removes its sensitive staging; a failed restore leaves its marked staging for inspection.

Deliverable: a managed restore denies central paid spend by default and permanently invalidates restored opaque credentials while preserving account identities, policies and financial rows; a managed backup/restore pairs the control database, each tenant database/vault/quarantine and marker by schema, inventory and per-file hash.

**New files (chosen):** `packages/storage/managed-restore-policy.ts`, `packages/runtime/managed-recovery.ts`, `scripts/managed-backup.ts`, `scripts/managed-restore.ts`, `tests/integration/managed-restore-policy.test.ts`, `tests/integration/managed-recovery.test.ts`. **Modified:** `packages/runtime/managed.ts` (constructor rejects a mid-restore root), `package.json` (`managed:backup`, `managed:restore`), `docs/MANAGED_RUN.md`. Local `scripts/backup.ts` / `scripts/restore.ts` and the local restore-policy regression are untouched.

**Interfaces:**
- `applyControlRestoreBarrier(control, clock?)` (idempotent, one `BEGIN IMMEDIATE`): ensures the money namespace via the `ManagedSpendingStore` migrator, upserts `managed_money_blocks('restore','restored_backup')`, and `DELETE`s restored `managed_sessions`, `managed_agent_tokens` and `oidc_transactions` when present. It changes no account/period/policy/reservation row or existing overrun block. `controlRestoreRequired(control)` reports the block. `MANAGED_RESTORE_INCOMPLETE` is the mid-restore marker; `ManagedRuntime` throws `UNAVAILABLE` when it exists before opening the control store.
- `writeManagedBackup({ root, destination, offline, clock? })` and `restoreManagedBackup({ bundle, destination, currentRoot, offline, clock? })` (both async): require `--offline`; enforce absolute explicit paths, real non-link roots, disjoint source/destination/current, an absent destination, a strict `ManagedBundleManifest` (schema 1, account inventory, per-file SHA-256), tenant-marker identity, control schema/inventory, SQLite snapshots via the backup API (never copying WAL/SHM), recursive no-symlink copies of vault/quarantine, control barrier first then tenant barriers, current deletion replay, current restrictive account state preserved, and an atomic publish only after every check succeeds. A failed restore leaves its marker and staging for inspection; there is no safe shim that resumes a partial restore.

- [x] **Step 1: Write the failing test.** The barrier suite proves: financial reservations/account identities/policies/periods are byte-identical before and after the barrier applied twice; the restored session token, agent-token route and OIDC correlation are dead even after a test manually deletes the money block; a known charge still settles after the restored block; and empty restored history stays blocked. The recovery suite proves a real backup → delete-source-then-restore into a new root → paid blocked, restored credentials unresolved and the replayed deletion absent from active sources and full-text search, plus rejections for unsafe inputs, tampered hashes and a backed account missing from the current root.
- [x] **Step 2–4:** RED → implement the barrier, the cold/offline recovery module and the two scoped CLIs, plus docs → GREEN. Focused `managed-restore-policy`/`managed-recovery`/parent `managed-restore-review` **9/9**, `npm run lint` clean; typecheck/build deferred to the parent's clear window. Report remaining gates; do not touch `BUILD_STATE.md` or Playwright, and do not commit.

---

## Final parent verification — 2026-10-16

All four implementation tasks are accepted locally. After the five recovery
repairs, parent reran the four recovery files (16/16), then added and passed an
independent decoded-Git-history/export deletion case (recovery review 6/6).
Post-mark consent/source/goal/abort/cap revalidation was independently reproduced
and repaired before this settled run.

- `npm test -- --maxWorkers=1`: **396/396, 49 files**.
- `npm run typecheck`, `npm run lint`, `npm run build`: passed separately.
- `npm run brain-eval`: **4/4 synthetic offline cases**.
- `npm run test:e2e -- --workers=1 --output=test-results/final-managed-money-parent`:
  **17/17 Chromium journeys**.
- `npm audit --audit-level=high`: zero vulnerabilities.

Reference screenshots regenerated by the browser run were restored. No commit,
push, public deployment, live paid call or license change occurred. Managed paid
processing remains hard-off, including with configured policy and the environment
flag; the process-local fatal-write fuse does not close the durable restart or
multi-process activation gate. Cold backup requires stopped writers and the
current root for deletion replay; integrity hashes are not authenticated backup.

## Self-review notes

- Spec coverage: single authoritative store (Task 1), tenant projection and ordered two-store sequence with fresh-CAS-only execution (Task 2), central status/re-checked reads and off-by-default gate (Task 3), restore credential revocation and default-deny (Task 4). Billing, System One routing, native clients, hosted TLS and human gates stay out of scope.
- Task 1 creates only new files, so it is independently green without changing the worker's existing budget contract.
- Type consistency: `ManagedLimits` (no service field), `ManagedReservation`, `ManagedMoneyReceipt`, `ManagedSpendView` and `DispatchAccounting` are used identically across tasks; the `mark(callId, currentLimits)` signature is synchronized here, in Task 2 and in the tests.
- Remaining technical risk for the parent to judge: the `Math.min(stored, current, policy)` rule requires both the operator policy and the user caps to be positive; the coordinator intentionally leaves cross-database stranded holds rather than adding a distributed transaction; and the central store shares the control DB's single writer, so managed throughput is bounded by the control-plane write lock. The fatal-IO fuse is process-local and in-memory: a process restart, or a second worker process that never saw the poisoned handle, relies on managed paid processing defaulting to off rather than on a durable marker. Closing that restart/multi-process gate needs a real operator control-IO drill before any managed activation and is explicitly not claimed here.
