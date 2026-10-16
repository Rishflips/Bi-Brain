# Per-dispatch Accounting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Ollama DeepSeek V4.1 Flash executes; parent independently reviews/tests; GPT-6 Astra supplied the design.

**Goal:** Make a decision call and a reasoning call share a durable cumulative monetary cap without releasing unknown expenditure or allowing duplicate paid dispatch.

**Architecture:** Add explicit knowledge-database migration 4 with a provider-dispatch table while preserving legacy reservations unchanged. Pure accounting validation/calculation lives in the domain module, SQLite state transitions in storage. This batch implements and tests primitives; it does not yet activate new paid calls or switch the existing worker.

**Tech Stack:** Node 24.19, existing SQLite Storage and Vitest; no dependency or service added.

**Spec:** `docs/superpowers/specs/2026-10-16-managed-suite-design.md`

## Global Constraints

- Integer monetary units, short transactions, durable leases, fenced/idempotent output writes, deterministic test clocks.
- No secrets in client bundles, URLs, logs, screenshots, exports or commits.
- Unknown paid usage remains conservatively reserved.
- Do not change the active managed runtime/control/server or provider adapters, owner data, legacy records or worker accounting in this batch.
- No real provider calls, commits, pushes or public deployment by the implementer.

## Task 1: Migration and local dispatch admission

**Files:** modify `packages/storage/index.ts` migration/version guard only; create `packages/domain/spend.ts`, `packages/storage/spend.ts`, `tests/integration/spend.test.ts`.

**Interfaces:**

- Domain exports bounded `DispatchSpec`, `JobLease`, `SpendLimits`, `DispatchRecord` and cost/count validation. Stages are `decision | reasoning | repair`. States are `reserved | dispatched | settled | released`. `actual_micro_usd` is null until settled. Metadata includes server-created call ID, job ID, stable logical dispatch slot, SHA-256 request/config hash, provider/model/price version, immutable budget day/timezone and dispatch/settlement timestamps. Never persist prompt/evidence bodies or keys.
- `DispatchLedger(store, clock)` exposes `reserve(spec, lease, limits)`, `markDispatched(callId, lease)`, `settle(callId, actualMicroUsd)`, `releaseUndispatched(callId)`, `jobSpend(jobId)` and `summary(limits)`; add cohesive result types as needed. It is an internal persistence boundary, not a transport or authorization endpoint. Managed identity and job authorization remain separately required before its use.
- Add schema version 4 explicitly; reject future versions greater than 4. New table `provider_dispatches` references jobs, unique `(job_id, dispatch_key)` and indexes for job/budget lookups. Preserve old `reservations` layout and values. Do not write shadow legacy reservations for new dispatches.
- `reserve` validates a current running job with matching lease owner/fence and future lease deadline before creating a record in a short immediate transaction. Same slot and identical immutable fields returns the existing record, not permission to send twice; changed slot content fails. Any legacy reservation on that job prevents new dispatch.
- Reserve against cumulative lifetime job spend and daily settled expenditure plus all unresolved holds, including older days. Include legacy settled/held expenditure without double counting. Freeze the accounting timezone at first admission, independent of changing schedule preferences; reject attempts to change it until an explicit future migration policy exists. Validate sums for safe-integer overflow, not merely each row.
- `markDispatched` compare-and-set requires a current lease and `reserved` state; a second call fails. Commit before network I/O. `releaseUndispatched` compare-and-set can release only `reserved`, never `dispatched`; it must not race dispatch successfully.
- `settle` records validated actual cost even after job cancellation/lease loss. Same settlement is idempotent, conflicting settlement fails. Over-reservation actual is retained and blocks future admission via a durable paid-processing-blocked setting; do not discard real expenditure. No automatic timeout/expiry of holds.

- [x] Write failing tests before implementation. Essential independent expectations:

```ts
// Real SQLite, disposable jobs, fixed clock, real running lease.
const first = ledger.reserve(decisionSpec, lease, {per_job_micro_usd: 10, daily_micro_usd: 20, time_zone: 'UTC'});
ledger.markDispatched(first.call_id, lease);
ledger.settle(first.call_id, 6);
expect(() => ledger.reserve({...reasoningSpec, reserved_micro_usd: 5}, lease, limits)).toThrow();
expect(ledger.jobSpend(jobId)).toBe(6);
```

- [x] Observe RED with `npm test -- tests/integration/spend.test.ts`, then implement minimum schema/pure logic/transitions.
- [x] Prove schema-3-equivalent upgrade once and legacy values unchanged; concurrent SQLite connections cannot overspend; duplicate slot never grants duplicate dispatch; changed hash rejected; unresolved holds survive restart/midnight/cancellation; frozen timezone cannot reset allowance; settlement idempotence/conflict and post-cancellation settlement; over-bound expenditure blocks; release/dispatch race; overflowing aggregate rejected; SQLite backup/reopen preserves records. Parent additionally verified real child-process admission and release/dispatch contention, plus expiry while waiting on an actual separate SQLite writer lock. Backup/reopen is not proof that rolling back to an older backup is safe for paid processing.
- [x] Run focused tests, typecheck, lint and existing full test suite. Parent independently reviewed Astra's two material findings, reproduced both with failing tests and reran the repaired suites: 17 ledger tests, then 2 real contention tests; full 239-test run and typecheck/lint preceded the test-only contention addition. No worker activation occurs in this batch.

## Integration boundary after review

The following is required before live multi-stage processing and is deliberately not claimed by this primitives batch: switch worker reserve/retry/settle/failure receipts together; show unknown usage as unknown rather than zero; count both legacy/new tables in UI summaries; preserve reservations on errors; disable paid work on operational restore until reconciliation. Managed processing additionally reserves against the control-plane service cap before tenant admission, marks both dispatch intents before network I/O and reconciles tenant then service settlement conservatively. No new provider call is activated by installing migration 4.
