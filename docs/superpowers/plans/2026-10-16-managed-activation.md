# Managed Activation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.
> Ollama DeepSeek V4.1 Flash executes. The parent agent independently reviews/tests/verifies, owns `BUILD_STATE.md`, every Playwright run, and every `*-review.test.ts` (including `tests/integration/managed-ambiguity-review.test.ts`, `managed-spending-review.test.ts`, `managed-accounting-review.test.ts`, `managed-money-view-review.test.ts`, `managed-policy-review.test.ts`). GPT-6 Astra Medium is advice-only. No commit/push/deploy happens from a task.

**Goal:** Make an unresolved `dispatched` hold a durable, cross-process ambiguity barrier and add guarded operator-attested reconciliation plus bounded all-account history audits, while managed paid processing stays hard-off.

**Architecture:** Enforce the barrier inside the existing `ManagedSpendingStore` `BEGIN IMMEDIATE` transactions (no new store, outbox, DB or registry). Add an immutable `managed_resolutions` proof store sharing one control-DB transaction with the money mutation, bound to a new control epoch and root marker. Phase 1 keeps `apps/worker/main.ts` on `unavailableProvider` (HTTP 503) and server metadata `connected_processing_available: false` always.

**Tech Stack:** Existing strict TypeScript, Node 24.19 LTS, `node:sqlite`, Zod, Fastify, React, Vitest. No new service, dependency, queue or graph store.

**Spec:** `docs/superpowers/specs/2026-10-16-managed-activation-design.md` (APPROVED Phase 1, 2026-10-16). Supporting: `docs/superpowers/plans/2026-10-16-managed-spending.md`.

## Global Constraints

- Integer micro-USD only; sums via `safeAdd`/`checkedSum`. Every authoritative clock read stays inside the acquired write transaction. Financial money **writes** must commit inside the transaction; only network/model calls stay outside a transaction.
- Default deny: no allowance is implied; a missing receipt is never a zero charge.
- One global service bucket `MANAGED_SERVICE_ID = "managed-processing"`; the barrier and service cap span every account, stage and provider.
- Never persist a prompt, source body, key, evidence text or private user text in control money/resolution/audit tables — only opaque ids, hashes and integer amounts.
- `main.ts` keeps `unavailableProvider`; `managedPaidAvailable = false`; server metadata stays `connected_processing_available: false`; `BRAIN_MANAGED_ALLOW_PAID=1` has no effect.
- No admin HTTP route, no browser config setter, no per-account "eligible" flag, no "clear all blocks". `status`/`inspect` never mutate. No bypass index, magic flag, or zero-dollar escape around the barrier; the only release is a real known settlement or a state-correct CAS.
- Each task owns its listed files exclusively. Do not edit any `*-review.test.ts`, `BUILD_STATE.md`, the spec, or Playwright specs. Run tasks in order; if a consumed interface differs, stop and report rather than rewriting a neighbour.
- Heavy commands run **serially** on Windows: focused `npm test -- <files>` first, then `npm run typecheck && npm run lint`. Run the full `npm test` only at a parent gate. Never raise the ~20s Git/vault fixture deadline.
- Deterministic clocks in tests. Real multi-process drills use `--import tsx` Node children and IPC, never in-process fakes.
- Baseline for reconciliation: `07c93e6` (396 tests / 49 files / 17 browser / 4 offline). Parent owns the final count.

## Dependency order and test budget

Task 1 is a prerequisite for Tasks 2–3 (the barrier, `serviceBarrier`, `blocked_reason:"usage_pending"` and `paused_reason` are consumed unchanged). Task 2 owns epoch bootstrap so attestations bind the epoch; Task 3 must not be a prerequisite of Task 2. No task adds a distributed outbox, a second database, an OS registry or a generic recovery framework.

Baseline `07c93e6`: **396 tests / 49 files**. Parent-owned `managed-ambiguity-review.test.ts` adds 6 (currently RED 6/6, must go green in Task 1 unchanged). Executor-authored targets: Task 1 `managed-ambiguity.test.ts` **9** + 1 contention case; Task 2 `managed-reconciliation.test.ts` **9** + `managed-epoch.test.ts` **5**; Task 3 `managed-reconcile-cli.test.ts` **6** + `managed-audit.test.ts` **6** + `managed-epoch-restore.test.ts` **3**. The parent records the exact final full-suite count and browser count; no executor counts as final.

## File structure

| File | Task | Responsibility |
|---|---|---|
| `packages/domain/managed-spend.ts` | 1 (modify) | Add `ManagedPauseReason`; extend `blocked_reason`/view unions. |
| `packages/storage/managed-spending.ts` | 1 (modify) | Barrier guard in `reserve`/`mark`; read-only `serviceBarrier()`; `accountStatus` reason. |
| `packages/runtime/managed-money.ts` | 1 (modify) | Own-account `paused`/`paused_reason`; no global detail. |
| `packages/domain/service.ts` | 1 (modify) | `managedBlockedMessage` branch + pass `paused_reason`. |
| `tests/integration/managed-ambiguity.test.ts` | 1 (new) | Barrier, own-view privacy, 2-process race, poisoned-fuse restart. |
| `tests/integration/managed-spending-contention.test.ts` | 1 (modify) | Add two-process `mark` race (exactly one). |
| `packages/domain/managed-reconciliation.ts` | 2 (new) | Pure attestation/epoch types, closed enums, digests. |
| `packages/storage/managed-reconciliation.ts` | 2 (new) | Immutable resolution store, epoch/root-marker preflight, atomic proof+money seam. |
| `packages/storage/managed-spending.ts` | 2 (modify) | Schema v2 DDL; `transaction`/`settleKnownWithinTx`; dispute+block write. |
| `tests/integration/managed-spending.test.ts` | 2 (modify) | Future-schema fixture 2 -> 3. |
| `tests/integration/managed-reconciliation.test.ts` | 2 (new) | Attestation idempotence/dispute/zero/revoked/no-release. |
| `tests/integration/managed-epoch.test.ts` | 2 (new) | Epoch bootstrap, marker mismatch deny, capture preserved. |
| `scripts/managed-reconcile.ts` | 3 (new) | Trusted offline CLI: status/inspect/attest-*/audit-history/suspend/init-epoch. |
| `packages/runtime/managed-audit.ts` | 3 (new) | Serial read-only all-account history audit + inventory fingerprint. |
| `packages/runtime/managed-recovery.ts`, `scripts/managed-restore.ts` | 3 (modify) | Rotate epoch + invalidate audit before publish. |
| `scripts/managed-backup.ts` | 3 (modify) | Manifest allowlists the root marker; old bundles default-blocked. |
| `tests/integration/managed-reconcile-cli.test.ts` | 3 (new) | Real CLI denial/attestation/offline ack. |
| `tests/integration/managed-audit.test.ts` | 3 (new) | All-account serial audit, refusal, staleness. |
| `tests/integration/managed-epoch-restore.test.ts` | 3 (new) | Restore rotates epoch and invalidates prior audit. |
| `docs/MANAGED_RUN.md` | 3 (modify) | Operator procedures + explicit non-guarantees. |

---

## Task 1: Durable service-wide ambiguity barrier (independently green, no schema change)

> **Parent gate:** `tests/integration/managed-ambiguity-review.test.ts` is **RED 6/6** today and must pass **unchanged**. It asserts: (1) one committed mark denies another account's new reserve and an already-reserved different-stage mark; (2) a previous-UTC-day dispatched row still pauses with `managed_money_blocks` count `0`; (3) reserved-only holds do not pause and an ordinary known settle unblocks the next mark; (4) a fresh `ControlStore` after restart still sees the durable pause without the process fuse; (5) a valid managed call keeps consent through its own marker (`consentAtSend === true`, `spend.blocked === true` at send) and settles once (`settled 7`, job succeeded, `accountStatus.blocked === false`) without stopping workers; (6) another account's ambiguity yields a content-free pause (`actual:0, reserved:0, blocked:true, available:false`) with no A id, call id, private job id or global `service_day_micro_usd` in the own view, and B capture still retains its original.

**Files:** Modify `packages/domain/managed-spend.ts`, `packages/storage/managed-spending.ts`, `packages/runtime/managed-money.ts`, `packages/domain/service.ts`; create `tests/integration/managed-ambiguity.test.ts`; modify `tests/integration/managed-spending-contention.test.ts`. Do not edit any `*-review.test.ts`.

**Interfaces (adds only):**
```ts
// packages/domain/managed-spend.ts
export const managedPauseReasons = ["usage_pending", "awaiting_accounting"] as const;
export type ManagedPauseReason = (typeof managedPauseReasons)[number];
// ManagedAccountStatus.blocked_reason: add "usage_pending" (union becomes
//   "overrun" | "restored_backup" | "reconciliation_required" | "usage_pending" | null)
// ManagedSpendView: add `paused_reason: ManagedPauseReason | null`.
// packages/storage/managed-spending.ts
serviceBarrier(): { paused: boolean; reason: ManagedPauseReason | null }; // read-only, no ids/dollars
```
`serviceBarrier()` includes the process fuse with the same precedence as `.status`: `{paused:true, reason:"awaiting_accounting"}` when `isManagedControlPaused(control)` (fuse) or a `managed_money_blocks` row exists; else `{paused:true, reason:"awaiting_accounting"}` when a `managed_service_blocks` row exists; else `{paused:true, reason:"usage_pending"}` when any `managed_reservations.state='dispatched'` exists; else `{paused:false, reason:null}`. Reasons are exactly `"usage_pending" | "awaiting_accounting"`; the return carries no call id, account id or dollar.

**Guard (inside the existing `BEGIN IMMEDIATE` of each method):**
- `reserve`: keep the slot-duplicate immutable lookup and early return first (a pre-existing same slot may return its historical row, but only a fresh `mark` CAS can ever permit I/O). For a **new** slot, after the `isBlocked()` check, deny with `BUDGET_BLOCKED` when `SELECT 1 FROM managed_reservations WHERE state='dispatched' LIMIT 1` returns a row. Never insert a block row.
- `mark`: keep the own-row checks (`dispatched` -> `ALREADY_DISPATCHED`; else non-`reserved` -> `INVALID_STATE`) first, then deny `BUDGET_BLOCKED` when a **different** row is dispatched (`state='dispatched' AND call_id<>?`); keep the existing `isBlocked()` check, period/day/tz/cap re-checks and the `WHERE call_id=? AND state='reserved'` CAS unchanged.
- `settleKnown` (ordinary known settle) releases the barrier by moving the row to `settled`; an overrun still upserts `managed_service_blocks`; a reconciliation/money block stays. `releaseUndispatched` still refuses a `dispatched` row.
- `accountStatus`: `blocked = isBlocked() || anyDispatchedRow`; `blocked_reason` precedence: money block (`reconciliation_required`, else `restored_backup`) -> service block (`overrun`) -> dispatched barrier (`usage_pending`) -> `null`. Existing `overrun`/`restored_backup`/`reconciliation_required` assertions stay.
- The in-memory `poisonedControls` fuse is retained and still maps to `blocked`, `blocked_reason: "reconciliation_required"`.

**Own-view privacy:** `managedMoneyView` sets `paused = barrier.paused` (the barrier already folds in the fuse) and `paused_reason = barrier.reason`; `blocked` stays `status.blocked || paused`. `service_available` keeps its original semantics `serviceConfigured && !status.blocked && !paused && headroom`: because `paused` now includes the one-inflight barrier, a configured account with spare policy headroom reports `service_available:false` while any call's usage is unknown. Do not special-case the barrier out of `service_available` to preserve an older expectation; the owner-corrected view test requires `false` plus `{paused:true, paused_reason:"usage_pending"}`. It must expose **no** call id, account id, other-account figure, global service total or raw dollar beyond the owner's own money. `service.ts` `managedBlockedMessage` gains a `usage_pending` branch, exact text: "Paid processing is waiting for an earlier call to finish accounting. Saved work and extractive preparation remain available. If it does not finish, an operator must review it." No digits, no other ids or costs.

**CRITICAL self-marker interaction — `usage_pending` is an admission barrier, NOT consent revocation.** `Brain.prefs` computes `centrallyUnusable`; if it included `usage_pending`, a fresh valid call that just marked itself would flip the effective stored consent to `provider_enabled:false`, and the post-mark guard (`engine.ts` `guard()` -> `prefs().provider_enabled`) would cancel every managed call before I/O. So `centrallyUnusable = !!central && (!central.configured || central.blocked_reason === "overrun" || central.blocked_reason === "restored_backup" || central.blocked_reason === "reconciliation_required")`. `blocked_reason "usage_pending"` never revokes consent; the stored preference is returned unchanged while only `usage_pending` is active, and a write that raises consent while only `usage_pending` is active is allowed (still no money/IO authority). Tenant-local `paid_processing_blocked` and the fuse (which `accountStatus` reports as `reconciliation_required`) still force false. No new public bypass parameter, no "ignore all blocks". The coordinator still always enforces the global barrier on `reserve`/`mark`, so HTTP stays 503 and the feature stays off even with `provider_enabled:true` stored. An unknown-mode global pause must never rewrite the stored preference.

> **Status: Task 1 accepted locally (2026-10-16).** Own `managed-ambiguity.test.ts` 9/9, parent `managed-ambiguity-review.test.ts` 6/6 unchanged, contention 3/3, focused combined **39/39**; the parent independently reran the exact same command and accepted. `service_available` keeps the approved global-pause semantics (the parent's view test requires `false` + `paused:true`/`usage_pending`).

- [x] **Step 1: Write the failing own suite.** `tests/integration/managed-ambiguity.test.ts` (temp real-file `ControlStore`, two accounts, policies `1000`, request `10`) — 9 tests: (a) `mark(a)` then new-slot `reserve(b)` throws and `mark(b_pre_reserved)` throws while `readReceipt(b)` stays `reserved`; (b) previous-UTC-day dispatched row pauses a new reserve with `managed_money_blocks` count `0`; (c) reserved-only leaves `accountStatus(b).blocked === false`; (d) `settleKnown(a,7)` unblocks `mark(b)`; (e) `accountStatus(b).blocked_reason === "usage_pending"`, `serviceBarrier()` gives `{paused:true,reason:"usage_pending"}`, and JSON of the own view contains no `b.id`, no call id, no service total; (f) capture succeeds while the barrier is active; (g) poisoned-fuse restart: force central settle + marker failure so `AccountingPersistenceError` is thrown, close, reopen a fresh `ControlStore`+`ManagedSpendingStore` on the same file, and assert the pre-existing reserved `b` is still denied (durable dispatched row, lost `WeakSet`) while capture works; (h) **self-marker**: `Brain.prefs(owner).provider_enabled` stays `true` while only `usage_pending` is active, `prefs` never rewrites the stored preference, and a manual consent-off edit still lets the coordinator guard deny marked I/O; (i) an ACTUAL `ManagedWorker` with positive policies/prefs `1000` and a `fakePreparedProvider` executes the fake `derive_brief` **exactly once** and settles central `cost_micro_usd === 10`, and the valid post-mark guard does not cancel the call.
- [x] **Step 2: Observe RED.** The parent separately observed all six review cases fail before implementation; the executor reported 13 failing cases in its initial 15-case combined run. Not every pre-existing behavior needed to fail.
- [x] **Step 3: Implement** the domain constant, the guard, `serviceBarrier()`, `accountStatus` reason and the own-view wiring exactly as specified.
- [x] **Step 4: Extend the contention suite.** Add one case to `tests/integration/managed-spending-contention.test.ts`: pre-reserve two accounts (both `reserved`, valid reserve-before-mark), then two real `--import tsx` children race `mark`; assert exactly one `ok`, the loser code `BUDGET_BLOCKED`, the loser row still `reserved`, and one dispatched row total.
- [x] **Step 5: Observe GREEN + adapt fixtures (never weaken).** Run `npm test -- tests/integration/managed-ambiguity.test.ts tests/integration/managed-ambiguity-review.test.ts tests/integration/managed-spending.test.ts tests/integration/managed-spending-review.test.ts tests/integration/managed-spending-contention.test.ts tests/integration/managed-accounting.test.ts tests/integration/managed-money-view.test.ts tests/integration/managed-money-view-review.test.ts tests/integration/managed-restore-policy.test.ts tests/integration/managed-restore-review.test.ts`. Where a fixture holds two rows dispatched at once, adapt it to a valid reserve-before-mark / settle-before-another-mark sequence; keep every assertion (including the two-account shared-service-cap cases) meaningful. Then `npm run typecheck && npm run lint`. Do not commit.
- [x] **Step 6: Report** RED/GREEN counts, the exact `blocked_reason`/`paused_reason` strings, that schema is unchanged, and that no other module changed. The parent re-runs the full suite and Playwright.

---

## Task 2: Immutable operator attestation store, epoch binding, atomic proof+money

**Parent gate: accepted locally.** Independent six-file run: **68 passed,
1 POSIX-only skip**. Original pre-implementation RED was not recorded; the later
behavior REDs and their repairs are real and separately documented below. The
following executor status report predates parent acceptance.

**Files:** Create `packages/domain/managed-reconciliation.ts`, `packages/storage/managed-reconciliation.ts`, `tests/integration/managed-reconciliation.test.ts`, `tests/integration/managed-epoch.test.ts`; modify `packages/storage/managed-spending.ts` (schema v2 + shared transaction seam); modify the future-schema fixture in `tests/integration/managed-spending.test.ts`.

> **Status: implemented locally, awaiting independent parent gate (2026-10-16).** Evidence, recorded honestly: the **original pre-implementation RED was not observed or recorded** (only the browser window was deferred; no consent to skip RED was given, and none is claimed). The original implementation ran GREEN `managed-reconciliation.test.ts` **16/16** and `managed-epoch.test.ts` **8/8**. Independent parent behavior review then found **3/5 RED** in `tests/integration/managed-reconciliation-review.test.ts`: (1) free-form/multiline `actor` accepted and persisted, (2) blank `provider_request_id` accepted as correlation, (3) a `RAISE(IGNORE)` money update returned success and wrote a resolution proof while the call stayed `dispatched`. Repairs, each with a new own failing test observed RED first: `actor` bounded to `^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,119}$`, `provider_request_id` bounded to a non-whitespace identifier `^[A-Za-z0-9][A-Za-z0-9._:/+=-]{0,199}$`, and `settleDispatched` now asserts `changes === 1` and re-reads the persisted row before any proof. Two adjacent root-helper boundaries also fixed: `assertTrustedManagedRoot` now **requires an existing real `control.sqlite`** (no control creation) and folds path case **only on `win32`** (POSIX compares case-exactly); `assertFreshRoot()` re-runs containment on every `init`/`attest`/`assertRootEpoch`. After repair: new own **19/19** (+ `managed-epoch` **10/10**, 1 POSIX-skip), parent review **5/5**, focused combined **128 passed / 1 skipped across 15 files** (serial `--maxWorkers=1`); `typecheck`/`lint`/`build` pass. The overrun+proof rollback and junction cases passed unchanged. No CLI/audit-writer/runtime-backup-restore/UI change; no push or commit.

**Pure interfaces (`packages/domain/managed-reconciliation.ts`):**
```ts
export const managedAttestMethods = ["usage_response", "call_statement"] as const;
export type ManagedAttestMethod = (typeof managedAttestMethods)[number];
export const managedResolutionKinds = ["settled", "zero", "dispute"] as const;
export type ManagedResolutionKind = (typeof managedResolutionKinds)[number];
export interface AttestationInput {           // strict closed schema; extra keys reject
  resolution_id: string;                      // UUID idempotency key
  kind: "settled" | "zero";
  account_id: string; call_id: string;
  identity_hash: string; provider: string; model: string; price_version: string;
  request_hash: string; config_hash: string;   // sha256 hex
  expected_state: "dispatched" | "settled"; expected_actual_micro_usd: number | null; // strict CAS on the CURRENT row
  cost_micro_usd: number;                      // integer micro-USD >= 0
  currency: "USD";                             // strict literal; non-USD denied before any write
  provider_request_id: string;                 // exact call correlation
  evidence_digest: string;                      // sha256 hex of operator evidence
  method: ManagedAttestMethod; actor: string; checked_at: string; epoch: number;
}
// checked_at: strict ISO 8601 with an explicit `Z`/offset, canonicalized to UTC.
// actor: bounded opaque metadata only (no free-form proof body).
export interface ManagedResolution {           // immutable persisted mirror
  resolution_id: string; kind: ManagedResolutionKind; account_id: string; call_id: string;
  method: ManagedAttestMethod; evidence_digest: string; binding_digest: string;
  cost_micro_usd: number; currency: "USD"; provider_request_id: string; actor: string;
  checked_at: string; epoch: number; decided_at: string;
}
export interface ManagedAttestOptions { offline: true; workers_terminated: true; } // strict; no defaults
export interface ControlEpoch { epoch: number; nonce: string; rotated_at: string; }
export function validateAttestation(input: unknown): AttestationInput;
export function attestationBindingDigest(a: AttestationInput): string; // canonical sha256
```

**Persistence interfaces (`packages/storage/managed-reconciliation.ts`), as implemented:**
```ts
export class ManagedReconciliationStore {
  constructor(control: ControlStore, root: string, clock?: () => Date); // read-only; no DDL, no epoch
  attestSettled(input: unknown, options: unknown): ManagedResolution;   // strict options; dispatched+null first
  attestZero(input: unknown, options: unknown): ManagedResolution;      // strict options; explicit cost 0 only
  readResolution(resolution_id: string): ManagedResolution | undefined; // read-only, table-guarded
  initEpoch(options: unknown): ControlEpoch;   // explicit offline ACK; no rotate/re-mint; idempotent
  readEpoch(): ControlEpoch | undefined;       // read-only; undefined when unitialized
  assertRootEpoch(): ControlEpoch;             // EPOCH_UNINITIALIZED | EPOCH_MISMATCH
}
```
`options` is the strict `ManagedAttestOptions { offline: true; workers_terminated: true }`, required at the store boundary and the CLI. `settleKnownWithinTx` is the transaction-owned seam on `ManagedSpendingStore`; `transaction<T>(fn)` refuses nesting/`async` callbacks.

**Schema v2** (added by the `ManagedSpendingStore` migrator; bump `managedMoneySchemaVersion` to `2`; future-version guard still runs **before** any DDL):
```sql
CREATE TABLE IF NOT EXISTS managed_resolutions(
  resolution_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('settled','zero','dispute')),
  account_id TEXT NOT NULL REFERENCES managed_accounts(id),
  call_id TEXT NOT NULL REFERENCES managed_reservations(call_id),
  method TEXT NOT NULL CHECK(method IN ('usage_response','call_statement')),
  evidence_digest TEXT NOT NULL, binding_digest TEXT NOT NULL,
  cost_micro_usd INTEGER NOT NULL CHECK(cost_micro_usd>=0),
  provider_request_id TEXT NOT NULL, actor TEXT NOT NULL, checked_at TEXT NOT NULL,
  epoch INTEGER NOT NULL, decided_at TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS managed_resolutions_no_update BEFORE UPDATE ON managed_resolutions
  BEGIN SELECT RAISE(ABORT,'managed resolutions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS managed_resolutions_no_delete BEFORE DELETE ON managed_resolutions
  BEGIN SELECT RAISE(ABORT,'managed resolutions are immutable'); END;
CREATE TABLE IF NOT EXISTS managed_control_epoch(
  singleton INTEGER PRIMARY KEY CHECK(singleton=1), epoch INTEGER NOT NULL,
  nonce TEXT NOT NULL, rotated_at TEXT NOT NULL);
```
`ManagedSpendingStore` additions: `transaction<T>(fn: () => T): T` (public wrapper over the existing private `tx`, no nested `BEGIN`) and `settleKnownWithinTx(callId: string, actualMicroUsd: number): ManagedReservation` (the money mutation only). `settleKnown` is refactored to `tx(() => this.settleKnownWithinTx(...))` so behavior is identical, and the reconciliation store writes the resolution row and the money mutation inside **one** `spending.transaction(...)` — the proof and the money never split.

**Attestation semantics (all inside one `BEGIN IMMEDIATE`):**
- Require a matching control epoch and root marker (`assertRootEpoch`), else `BrainError("EPOCH_UNINITIALIZED" | "EPOCH_MISMATCH")`. Require `--offline` acknowledgement at the CLI layer (Task 3); the store assumes it.
- Idempotency: `resolution_id` unique. Same id + identical `attestationBindingDigest` returns the stored resolution with no resettle; same id + changed binding throws `RESOLUTION_CONFLICT` **before** any money change. Identical settled actual is idempotent; a changed amount on a settled row appends a `dispute` resolution and a `managed_money_blocks('dispute','amount_conflict')` global block in the same TX, retaining the old `actual_micro_usd`.
- `attestSettled` only settles a `dispatched` row whose `actual_micro_usd IS NULL`; a `reserved` row (never sent) or any other state is rejected — an attestation never sets `released` and never grants I/O. Revoked/suspended accounts may settle (`settleKnownWithinTx` has no active check).
- `attestZero` requires `kind="zero"` and `cost_micro_usd === 0` with an explicit `method`; a non-zero cost or absent evidence is rejected. No double money; TTL/human release of an unknown remains unsupported.
- Cost over `reserved_micro_usd` still upserts the singleton `managed_service_blocks` in the same TX. The central receipt stays authoritative over any tenant projection; the operator can flag `reconciliation_required` but cannot silently clear a local block. No "clear all blocks"; a reconciled known row may still block on the central reason until a targeted resolution; Phase 1 advertises no resume.
- A known row can be settled while a restore/global block remains (matching the existing restore behavior).

**Epoch + root marker:** `initializeControlEpoch` writes the control row inside a TX, then writes `<root>/control-epoch.json` (`{ schema:1, epoch, nonce }`, mode `0600`) via tmp+rename with a strict no-symlink preflight over the root and every ancestor. A crash between the two leaves a mismatch: `assertRootEpoch` denies attest/audit; `ManagedRuntime` and capture remain available (no new global runtime unavailability for a missing marker). Initialization is explicit-operator only; default is read-only and never mutates. Supported restore (Task 3) must rotate and invalidate.

- [x] **Step 1: Update the future-schema fixture.** The seed is now version `3`; the guard remains enforced for schema `2`.
- [x] **Step 2: Write the reconciliation suite.** It now covers acknowledgements, exact binding/CAS, currency/kind, idempotence/disputes, revoked settlement, immutable proof, ignored UPDATE and atomic proof/overrun rollback. The original pre-implementation RED was not recorded.
- [x] **Step 3: Write the epoch suite.** Explicit init, mismatch/crash denial, root binding, no auto-heal and capture preservation are covered; the case-sensitive POSIX check is skipped on Windows. The original pre-implementation RED was not recorded.
- [ ] **Step 4: Original pre-implementation RED for both new files — NOT OBSERVED.** This process gap is not retroactively marked complete. Later independent behavior REDs and executor repair REDs were observed and repaired; see the status evidence above.
- [x] **Step 5: Implement** the pure module, schema v2 + shared transaction seam, resolution store and root/epoch preflight.
- [x] **Step 6: GREEN + focused build.** Parent independently verified the focused suites; final typecheck/lint/build and full settled run are recorded below.

---

## Task 3: Trusted offline CLI, root-epoch rotation on restore, all-account history audits, docs

**Parent gate: accepted locally.** Final independent own/review operations run:
**31/31 tests, six files**. All reproduced audit and marker findings passed. The
following executor status report predates this acceptance and the full checkpoint.

**Files:** Create `scripts/managed-reconcile.ts`, `packages/runtime/managed-audit.ts`, `tests/integration/managed-reconcile-cli.test.ts`, `tests/integration/managed-audit.test.ts`, `tests/integration/managed-epoch-restore.test.ts`; modify `package.json`, `packages/runtime/managed-recovery.ts`, `packages/runtime/managed-operator.ts` (additive containment helpers), `packages/storage/managed-spending.ts` (one additive schema-2 audit table), `docs/MANAGED_RUN.md`. The backup/restore arg scripts are unchanged: the marker field and epoch rotation live in `managed-recovery`.

> **Status: implemented locally, awaiting independent parent gate (2026-10-16).** Evidence, recorded honestly: own `managed-reconcile-cli.test.ts` 10/10, `managed-audit.test.ts` 7/7, `managed-epoch-restore.test.ts` 3/3. Red observed first (audit 6/6 failed with `unmapped_tenant_row` before the projection-key fix; the CLI test failed 4/6 while the CLI did not exist; a later money regression failed before the `invalid_money` guard). Parent reviews: `managed-reconcile-cli-review.test.ts` 4/4, `managed-audit-review.test.ts` **6/6**, `managed-epoch-restore-review.test.ts` **1/1**. A first parent pass was RED 4/5 (service-policy change, altered provisioning marker, future schema 3, edited central identity/amount all still "valid"), then a 6th race case and a fractional-amount case were RED; repairs: validate now compares the money-schema version + schema digest + service/account config digest; audit creation rejects an unsupported schema (`managedMoneySchemaVersion`); the tenant provisioning marker binds the trusted account identity before any read; central/tenant baseline digests bind every retained field (identity/content/period/service/frozen-day/request/price); every reserved/actual (and frozen stored cap) must be a nonnegative safe integer, a released row keeps `actual:null`, and fractional amounts are refused (`invalid_money`); all reads are bounded `LIMIT remaining+1` with a global `maxRows`; the write transaction re-reads the bounded central money/config/blocks before insert; restore enforces actual marker presence equals the manifest declaration. Focused serial run of the 3 own files + 3 parent reviews + 10 core review files: **100 passed / 1 skipped (POSIX-only) across 16 files**; `typecheck`/`lint`/`build` pass. No production paid activation, no new store/framework, no HTTP/UI change, no push/commit.

### Actual Task 3 interfaces (implemented)

`packages/runtime/managed-audit.ts`:
```ts
interface AuditControl { readonly db: DatabaseSync; readonly path: string } // ControlStore is structurally compatible; a read-only DatabaseSync is used for validate/status
interface AuditInput { root: string; offline: boolean; workers_terminated: boolean;
  control?: AuditControl; runtime?: { control: AuditControl };
  maxAccounts?: number; maxRows?: number; clock?: () => Date; }
interface AuditInventory { root_epoch: number; control_schema_version: number;
  accounts: { account_id: string; config_hash: string; baseline_digest: string }[] }
type AuditEvidence = "empty" | "matched";
interface AuditResult { ok: boolean; reason: string | null; audit_id: string | null;
  evidence: AuditEvidence; inventory: AuditInventory }
function auditManagedHistory(input: AuditInput): AuditResult;      // write path; two agreeing scans + short TX
function readManagedAudit(control: AuditControl, auditId: string): AuditRecord | undefined;
function validateManagedAudit(input: { root: string; auditId: string; control?: AuditControl;
  runtime?: { control: AuditControl }; maxAccounts?: number; maxRows?: number; clock?: () => Date }): { valid: boolean; reason: string | null };
```
`latestValidAudit(epoch)` is deliberately **not** implemented (no dead API); a caller reads a specific `audit_id` and validates it. Deny reasons are closed static codes (`epoch_uninitialized`, `epoch_mismatch`, `tenant_unavailable`, `legacy_history`, `orphan_projection`, `unmapped_tenant_row`, `nonterminal_call`, `row_mismatch`, `account_limit`, `row_limit`, `inventory_changed`, `uninitialized`).

`packages/storage/managed-spending.ts` — additive schema-2 table inside the existing money DDL (no version bump; the future-schema fixture stays 3):
```sql
CREATE TABLE IF NOT EXISTS managed_audit_rows(
  audit_id TEXT NOT NULL REFERENCES managed_audits(audit_id),
  account_id TEXT NOT NULL, call_id TEXT NOT NULL,
  central_digest TEXT NOT NULL, tenant_digest TEXT NOT NULL,
  PRIMARY KEY(audit_id, account_id, call_id));
```
Serial, one validated **read-only** tenant DB at a time (same non-link/containment helpers as `ManagedRuntime`, no reactivation, suspended accounts allowed). It reads only paid-journal tables (`reservations`, `provider_dispatches`) and central id/hash/amount rows — never knowledge content. Refuse the whole audit (including when the current account is clean) on any legacy `reservations` row, any unmapped new `provider_dispatches` row, any central projection orphan, or any non-terminal paid row. Record a closed inventory of root epoch + control schema + per-account config/baseline fingerprints of retained terminal rows; new legitimately typed mapped rows beyond baseline do not force a per-job audit, but a changed baseline, an unmapped new, an unsurveyed account, or an audit taken after a restore is stale. Recheck inventory + central version/hash + tenant data-version + file identity **after** scanning and **before** committing the audit record; `--offline` is the precondition that all operator writes (including audit) are stopped. Store only ids, hashes and money.

**Root epoch on restore (implemented):** `applyControlRestoreBarrier` keeps its exact financial/credential contract; the rotation lives in `managed-recovery`'s staging context so the standalone barrier function and its parent tests are unchanged. `writeManagedBackup` refuses to capture a root whose marker does not bind its control generation, and lists the optional, hashed `control-epoch.json` (`root_marker`) in the manifest (allowlisted at the bundle top level). `restoreManagedBackup` rejects a bundle marker whose generation is missing/different, then at staging rotates the control epoch (safe increment + fresh nonce) and writes a new root marker **before** publish whenever the snapshot has a generation; a snapshot with no generation is left uninitialized for an explicit `init-epoch`. A previous-format bundle without the `root_marker` field is still openable (blocked for paid activation, not mass-rejected) and derives a fresh generation from its known control row, never copying an approval. Prior audits are invalidated by the epoch change; every financial block and the restored-credential deletion are preserved.

- [x] **Step 1: Write the CLI suite.** Actual child processes cover positive commands, strict arguments, offline acknowledgements, read-only status/inspection, bounded non-link JSON input and content-free errors.
- [x] **Step 2: Write audit/restore suites.** All-account/suspended history, mapping and money invariants, stale identity/config/schema/baseline, same-clock valid new rows, row bounds, final-lock freshness, restore rotation and marker consistency are covered.
- [x] **Step 3: Record actual RED evidence.** CLI absence, audit mapping and later independent audit/restore behavior regressions failed before their fixes. Do not infer a separately observed RED for every individual new test.
- [x] **Step 4: Implement** CLI, bounded audits, epoch-aware backup/restore and operator documentation with explicit offline/trust limits.
- [x] **Step 5: GREEN + focused build.** Parent final operations run: 31/31. Full settled verification follows below.

---

## Parent review amendments (Task 2 / Task 3 — NOT implemented until the Task 1 gate)

These supersede the corresponding Task 2/3 wording above; implement exactly these when the task is handed off.

**Task 2 — attestation and transaction seam**
- `expected_state` is the closed union `"dispatched" | "settled"` with a strict `expected_actual_micro_usd` CAS against the CURRENT row. Idempotency: an exact `resolution_id` repeat first checks the stored `binding_digest` and returns the original resolution even if the row is already `settled` (no resettle); the same `resolution_id` with a changed binding throws `RESOLUTION_CONFLICT` before any money change. A **different** `resolution_id` may settle the same known cost only when the exact row identity, epoch and current `expected_state`/`expected_actual` all match.
- `attestSettled` requires `kind==="settled"` and `cost_micro_usd > 0`; `attestZero` requires `kind==="zero"`, an explicit `cost_micro_usd === 0`, `method`, `evidence_digest` and `provider_request_id` external correlation acknowledgement — a missing receipt is never an implicit 0. `currency` must be the strict literal `"USD"` in the input, the persisted resolution and `attestationBindingDigest`; a non-USD or missing `currency` is denied before any write (no implicit USD). `checked_at` must be strict ISO with an explicit offset canonicalized to UTC; `actor` is bounded opaque metadata with no free-form proof body.
- The control/root epoch is validated **before** the idempotent-resolution early return, so an attestation made under an old backup can never be reported as approved under a new generation.
- The store API itself must require `ManagedAttestOptions { offline: true; workers_terminated: true }` (strict, no defaults, no caller-supplied truth assumption) as well as the CLI `--offline` + termination acknowledgement.
- `settleKnownWithinTx` must assert it is already inside an owned `BEGIN IMMEDIATE` financial transaction and refuse to run standalone; `transaction<T>(fn)` refuses callbacks when a transaction is already open and refuses `async` callbacks. `settleKnown` keeps its normal external contract. The clock is read inside the acquired TX.
- Fault-injection test: a forced failure of either the money `UPDATE` or the resolution `INSERT` rolls back both; a dispute proof + global block are likewise atomic. Changed amount appends a `dispute` resolution and a global block retaining the original `actual_micro_usd`.

**Task 2 — epoch/root binding**
- The root marker must bind the EXACT `control.path` dirname and the current trusted real managed root + `control.sqlite`: a marker from root A never authorizes control DB B. `initializeControlEpoch` requires explicit root strictness and an acknowledgement; a repeat init never rotates/clears and never re-mints when the DB row exists but the marker is missing. Crash/mismatch DENIES (no new recovery backdoor); only a separate SUPPORTED restore rotates at staging before publish, and owner capture is unaffected. A missing epoch on the constructor is READ-ONLY — no auto-creation.
- `status`/`inspect` must use a real read-only DB open, not a new `ManagedSpendingStore` migrator that creates DDL or a runtime that creates tables/files. The control epoch number increments with a max-safe-integer check.

**Task 2 — audit persistence (consume this actual v2 schema, still schema version 2 so Task 3 needs no new version bump; the future fixture is 3)**
```sql
CREATE TABLE IF NOT EXISTS managed_audits(
  audit_id TEXT PRIMARY KEY, epoch INTEGER NOT NULL, control_schema_version INTEGER NOT NULL,
  config_digest TEXT NOT NULL, schema_digest TEXT NOT NULL, inventory_digest TEXT NOT NULL,
  baseline_digest TEXT NOT NULL, root_nonce TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS managed_audit_accounts(
  audit_id TEXT NOT NULL REFERENCES managed_audits(audit_id), account_id TEXT NOT NULL,
  config_digest TEXT NOT NULL, baseline_digest TEXT NOT NULL, financial_digest TEXT NOT NULL,
  PRIMARY KEY(audit_id, account_id));
```
- Full validate/read API: `writeAudit(result)` only inside the offline transaction; `readAudit(audit_id)`; `latestValidAudit(epoch)`; `validateAudit(audit_id): boolean` that actually re-derives and compares (not a stored-never-used flag / dead button). Baseline UNKNOWN/legacy/new-unmapped/central-orphan/nonterminal rows deny across ALL active and suspended accounts. Explicit limits `maxAccounts`/`maxRows`; deterministic exhaustion DENIES rather than skipping records.

**Task 3 — operator/CLI placement and status**
- Factor the trusted-root preflight into a cohesive `packages/runtime/managed-operator.ts` (or a bounded helper module) — do not import executing scripts and do not add a generic file framework. Strict arity and closed JSON for the operator attest input; a regular non-link bounded-size file with required metadata; no source body or leaking tokens; static content-free CLI errors.
- `status`/`inspect` read-only, no epoch/schema/file auto-creation, no leaks. The root-marker format and the backup manifest field live in the runtime/`managed-recovery` module, not in the arg-parsing script. Restore invalidates ALL prior audits and retains financial blocks in every case; an old bundle without the marker is still supported but blocked. No public eligible flag or runtime activation.


After each task's gate, the parent reruns the focused files serially, then, only when all three are accepted, the full settled tree in one clear window: `npm test -- --maxWorkers=1`, `npm run typecheck`, `npm run lint`, `npm run build`, `npm run brain-eval` (4/4 synthetic offline), `npm run test:e2e -- --workers=1` (17 existing + any new journey), `npm audit --audit-level=high`, and `git diff --check`; restore the two reference screenshots. No commit, push, deployment, live paid call or license change. Managed paid processing stays hard-off including with configured policy and `BRAIN_MANAGED_ALLOW_PAID=1`.

## Final parent verification — 2026-10-16

All three implementation tasks are accepted locally, with the original Task 2
pre-implementation RED process gap explicitly retained above. Implementation was
frozen before the following serial commands:

| Command | Actual result |
| --- | --- |
| `npm test -- --maxWorkers=1` | **478 passed, 1 skipped, 60 files**, 129.57 seconds |
| `npm run typecheck` | passed |
| `npm run lint` | passed |
| `npm run build` | passed, 18 modules |
| `npm run brain-eval` | **4/4 synthetic offline cases** |
| `npm run test:e2e -- --workers=1 --output=test-results/final-activation-phase1-parent` | **17/17 Chromium journeys**, 59.0 seconds |
| `npm audit --audit-level=high` | zero vulnerabilities |

The skipped POSIX case-sensitive-root test is inapplicable on this Windows host;
Linux verification is not implied. Browser-generated reference screenshots were
restored. Documentation-only checkpoint updates follow the test/build commands.
Staged/unstaged `git diff --check` passed (line-ending warnings only); an additional
scan of all 34 changed/new text files passed trailing-whitespace and common
credential-pattern checks, not a full secret-history audit.
No commit/push/deployment, paid call, real external account or license change was
performed for this slice. Paid processing remains hard-off. Phase 2 needs separate
approval; offline acknowledgement, provider attestation and root epoch limitations
remain explicit rather than being treated as live verification.

## Self-review notes

- Spec coverage: durable barrier + `reserved` vs `dispatched` distinction + no-refund (Task 1); operator-attested immutable resolutions, closed schema, epoch binding, dispute/overrun atomicity, no free unknown (Task 2); trusted offline CLI, root-epoch rotation on supported restore, bounded all-account audits, activation hard-off, docs (Task 3). Phase 2 shared activation config, billing, System One, native clients and hosted operations stay out of scope.
- Task 1 changes no schema and no other module, so it is independently green and the parent's 6 RED review tests pass unchanged.
- Type consistency: `ManagedPauseReason`, `managedPauseReasons`, `AttestationInput`, `ManagedResolution`, `ControlEpoch`, `serviceBarrier`, `transaction`, `settleKnownWithinTx`, `ManagedReconciliationStore` and `auditManagedHistory` are used identically across tasks; `mark(callId, limits)` and `settleKnown(callId, actual)` signatures are unchanged.
- Remaining risk the parent must judge: a single ambiguity deliberately pauses all managed paid (low V1 volume, one job per process); a falsely acknowledged offline condition is outside the guarantee; without an external anchor both-control-and-marker rollback is undetectable; the barrier adds a `dispatched` existence lookup to every `reserve`/`mark` on the control-DB writer.
