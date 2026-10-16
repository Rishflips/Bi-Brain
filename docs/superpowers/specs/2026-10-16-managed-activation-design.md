# Managed activation design — durable ambiguity gate and operator-attested reconciliation

**Status: PHASE 1 IMPLEMENTED AND VERIFIED LOCALLY — owner approval on 2026-10-16
("approved").** Parent verification: 478 passed, 1 POSIX-only skip, 17 Chromium
journeys and 4 offline evaluations; typecheck/lint/build/audit passed. Production
paid processing remains off; Phase 2 activation still requires separate approval.

Scope: the **next financial safety slice**. It is not the only open gate: live provider
quality, real identity, hosted TLS/operations and human release gates all remain open and
separate. No billing, System One routing, native client or checkout.

## Verified current state (inspected, not assumed)
- `ManagedSpendingStore` is the central money authority over the control DB: `reserve`,
  `mark` (fresh `reserved→dispatched` CAS is the sole permission), `settleKnown`,
  `releaseUndispatched`, `managed_money_blocks`/`managed_service_blocks`. Defaults 0
  (deny); one global service id.
- `ManagedDispatchAccounting`: central reserve → tenant reserve → central mark → tenant
  mark → execute; central settles first, tenant projection independent; a central settle
  failure calls `flagSettlementFailure` (durable service-wide block).
- Fuse: if that block write itself fails, a `WeakSet` poisons the shared `ControlStore`
  and `ManagedWorker.stopped = true`. **Process-local, in-memory, never cleared**; another
  process or restart cannot see it.
- `apps/worker/main.ts` always injects `unavailableProvider` (HTTP 503);
  `apps/server/startup-gates.ts` hard-codes `managedPaidAvailable = false` independent of
  `BRAIN_MANAGED_ALLOW_PAID`. `scripts/managed-policy.ts` is the only policy writer.
  Restore sets `managed_money_blocks('restore','restored_backup')`.

## The real problem
A committed `.mark` means the call **may have been sent**. The residual gap is that the
process-local fuse is invisible to a second worker process or a restart. A boot toggle,
external marker or sidecar cannot be *proven* writable when the control DB itself is
unwritable, and "only a fuse" is not durable.

## Approaches
- **A (recommended). Durable service-wide inflight ambiguity barrier over existing
  state.** Treat any unresolved `dispatched` row as a durable, cross-process ambiguity
  barrier. No new store, outbox or 2PC: SQLite commit durability *is* the durable marker.
- **B (rejected). External marker/outbox/sidecar + fencing.** Must guarantee writes when
  control is unwritable and that a second process observes them; disk-full/dual-target
  failure leaves it unproven and adds a fencing framework we do not need.
- **C (rejected). Process fuse + reboot toggle / only-fuse.** Not durable or
  cross-process, and cannot resolve a live ambiguity where money may have moved.

## A — durable ambiguity barrier
- Enforce **inside the `.mark` TX**: `mark` refuses (`BUDGET_BLOCKED`) when any other row
  is `dispatched` (any account/stage); the barrier check and CAS share one `BEGIN
  IMMEDIATE`, so two processes can never both mark.
- `.reserve` also denies while any `dispatched` row exists, so holds cannot stack
  unbounded. `mark` re-checks the row state.
- **Distinguish `reserved` from `dispatched`.** A `reserved` row was never marked and
  provably sent nothing: classify/release it (CAS `reserved→released` only), **not** a
  global stop. Only a possibly-sent `dispatched` row is ambiguous.
- Normal one-shot settlement keeps its existing validated prepared-call accounting
  contract and can clear financial ambiguity without stopping the worker. **Operator
  settlement after an interrupted call** additionally requires an exact call/immutable
  pricing/request/config binding and the stopped-worker precondition below. A projection's
  `reconciliation_required` record may persist independently at account level.
- **No release or refund of any `dispatched` row in this slice.** No CLI command may
  rewrite a dispatched row to `released` on assertion. An "unknown final resolution" is a
  **diagnostic**, not a terminal clear. If the provider cannot supply a reliable exact
  call mapping, the row **remains blocked**.
- A known overrun with a conflicting receipt pauses the service; immutable money is never
  silently rewritten; a late overrun is appended as a dispute (below).
- The in-memory fuse is retained only for a control DB that cannot be written at all and
  stays labeled non-durable; the dispatched-row barrier is primary.
- **Tradeoff:** one ambiguity pauses **all** managed paid (single global paid
  concurrency). V1 volume is low and the scheduler is one job per process, so this is
  acceptable, but only by explicit owner decision.
- Operator stopping all workers and confirming quiescence is a **precondition**, not a
  programmatic claim (like offline backup). No automatic provider or billing lookup call
  occurs in this batch.

## Reconciliation — trusted local CLI, operator-attested
- Provider receipts are **not inherently authentic**; no signed receipt verifier or
  universal billing lookup exists. The minimal concrete trust is a **local operator
  attestation**: a trusted actor reports an externally checked amount + currency +
  provider call/request correlation + identity hash + `evidence_digest` + `method` +
  timestamp. This is audit provenance, **not** cryptographic verification, and is labeled
  **attested, not live-verified**.
- Permitted methods (closed enum), minimal safe examples: (a) an existing provider
  response's usage checked against **pinned prices** and the immutable request/config
  hash — never fake HTTP bodies or browser operation; (b) an external account statement
  bound to the **exact call**, never a coarse period invoice. No automatic model or
  network verification.
- **No money transition** unless the binding is proven and the stopped-worker/quiescence
  precondition is met. Unknown, unmatched or coarse invoices, and any manual free
  checkbox, must **deny**.
- Attestation mutations require `--offline`, an explicit acknowledgement that all old
  managed worker processes are terminated, not merely paused. The CLI validates the
  declared identity/epoch/prior-state binding and structured evidence, not external
  provider authenticity or actual process quiescence. A missing acknowledgement denies.
- CLI (local, one explicit absolute managed root): `status`, `inspect`, `attest-settled`,
  `attest-zero`, `audit-history`, `suspend`. No admin HTTP, no browser setter, no
  "clear all blocks". `status`/`inspect`/`attest-*` may record attestations but cannot
  enable the batch when no deterministic financial-transition proof exists.
- Immutable `managed_resolutions` (subject key, kind, method, `evidence_digest`, actor,
  decided_at). Closed schema: enum kinds/methods, hex hashes, integer micro-USD sums. A
  resolution may settle **only** a `dispatched` row whose original `actual` is `null`, or
  a `settled` row with the **same** known actual (idempotent). A conflicting amount or
  late overrun **appends a dispute plus a global block and retains the old financial
  row** until a separately approved adjustment — never a vague supersede that rewrites an
  immutable amount.
- A known zero is terminal **only** from explicit operator-attested usage bound to the
  exact call; a missing receipt is **never**
  treated as 0. A known charge persists even after account revocation. Existing
  `settleKnown` is used for a valid known actual after suspension.
- The audit/settlement write and its resolution record must commit in the **same control
  TX**, so no inconsistent proof survives; nested-`BEGIN` handling is deferred to the
  implementation plan.
- `audit-history` audits **all accounts**, bounded and serial (one handle at a time),
  never unbounded open DBs. Baseline eligibility: every tenant paid row fully mapped and
  validated against its immutable central identity; a new account starts **unsurveyed** and cannot activate
  until audited; ongoing typed central/local writes keep a mapping history as an account
  gate. **Pre-existing unmapped history stays blocked** pending a separate import design —
  it is never magically marked zero. An empty-history result requires both central and
  tenant legacy/new paid journals to be empty; matched nonempty history is labeled separately.

## Activation gate — shared, explicit, hard-off in this slice
- **Phase 1 keeps `main.ts` on `unavailableProvider` (HTTP 503) and metadata
  `connected_processing_available: false` ALWAYS.** No helper or unit test proves
  availability; a stale helper must never be read as "available".
- Future activation needs a **separate approval**: one explicit shared config consumed by
  both server and worker (same policy object), not a public "eligible" flag or per-account
  field. The public build/runtime capability constant stays separate from the
  authenticated owner's read-only `spend.configured`.
- `active` may become true only when a real worker paid policy is wired and fake-contract
  tests run; never while `main.ts` uses `unavailableProvider`. Server and worker must
  agree. The live provider quality gate is separate, default off, needs explicit consent
  plus cap/schema/pricing/provider-ready checks; tests use a fake contract provider and
  make **no paid call**.
- Runtime unknown provider statuses are never auto-looked-up. Financial status exposes
  only own-account money; the internal global pause is a boolean plus plain reason, never
  a raw global total.

## Root generation and audit binding (new design, not an existing API)
- No control epoch or root-generation API exists today. This slice designs a **new control
  epoch + root marker hash**: a supported restore **rotates the epoch**, invalidating
  prior audits while **keeping blocks**.
- A mirrored nonce detects mismatched supported copies, **not** full rollback of both DB
  and marker. Without an outside anchor there is **no full-rollback detection**; this is
  stated explicitly, and a future runtime-activation gate must not depend solely on
  self-restored approval.
- Per-root audit binds config/schema version, epoch, account inventory and a canonical
  digest of the audited baseline. Its baseline must contain no unresolved paid calls;
  every retained paid record must be terminal and exactly mapped. Later legitimate typed
  writes are checked by the ongoing mapping gate, not mistaken for baseline tampering.
  A changed baseline, new unsurveyed account or supported restore requires a new audit.

## Crash, competition and drill matrix (local synthetic, never paid)
reserve-only · reserve+tenant reserved · central marked / tenant not · marked + send ·
settle-failure (marker ok) · settle-failure **plus marker failure** → restart with a
durably visible `dispatched` row retains the global pause · post-mark source/consent/cap
revocation (already fixed) · real **2-process** mark competition (exactly one) · known late
cost + projection failure · restore empty history: control + tenant still deny ·
stale/conflicting/duplicate attestations · offline acknowledgement missing → operator
mutation denied · same-period rollover and cost carry. A falsely acknowledged offline
condition is outside the guarantee; a paused process is not safe to reconcile.

## Implementation phasing
1. Durable barrier + resolution store/CLI + drills. Read-only inspection never changes
   money; operator-attested settlement requires the guarded offline mutation above.
   Unsupported evidence leaves the hold intact. `main.ts` and metadata stay hard-off.
2. A **separately approved** shared activation config + fake-contract test path; the live
   provider remains a separate, off gate.

## Explicit non-goals
Billing/checkout, System One policy/quality, native clients, hosted TLS/operations,
runtime model/provider selection, and any generic recovery framework. Development stays
DeepSeek primary with Astra Medium advice only; no global configuration change.

## Accepted decision
The owner approved the global one-inflight barrier: any unknown ambiguity pauses
**all** managed paid processing. Saving, search and extractive work continue.
