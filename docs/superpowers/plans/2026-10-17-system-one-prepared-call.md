# System 1 prepared-decision call — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `writing-plans` → `executing-plans`. Steps use `- [ ]`.
> TDD: write the failing test, RUN it, observe RED, then implement. Execute ONE task, then STOP for
> parent review. **Status: ACCEPTED LOCALLY after independent parent verification. The original
> executor-specific RED steps remain unchecked: they were not followed as written. The parent's
> missing-module RED preceded implementation; the cancellation repair has an observed behavioral
> RED → GREEN. No broader TDD claim is made.**

**Goal:** Add an immutable one-shot prepared-decision adapter around the existing real
`SystemOneProvider`, with no live wiring and production paid decision OFF.

**Architecture:** A new `PreparedDecisionProvider` composes a frozen snapshot of the existing transport
(resolved config + canonical request bytes + bound) and runs exactly one fetch through an injected
`fetcher`, returning a `{accounting, output, disposition}` envelope. A few pure helpers are extracted
from `system-one.ts` so the body/bound/defaults are shared, never duplicated. No consumer switch.

**Tech Stack:** Node 24.19, TypeScript (strict), zod, `node:crypto`, Vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-17-system-one-prepared-call-design.md` (APPROVED, narrow).

## Global Constraints

- **No new decision production I/O** in this slice. The existing reasoning activation path is
  unchanged and default-off (owner inactive); the new module is not imported by any worker/HTTP/UI
  consumer here, so it adds no reachable runtime network path.
- `PreparedDecisionProvider` does **not** implement the legacy `DecisionProvider`: `.decide` is
  deliberately absent. `SystemOneProvider` and its tests remain unchanged (no consumer switch).
- No new deps/lockfile change; no real key/network/env secret; tests use an injected synthetic `fetch`
  and an explicit dummy key only. No global fetch monkeypatch. No domain/storage/worker/server/UI/
  config/caps/database edits. Parent owns `BUILD_STATE.md`, specs, docs, browsers and every `*-review`.

## File Ownership (closed)

- Create `packages/providers/prepared-decision.ts` — the adapter and its types.
- Modify `packages/providers/system-one.ts` — extract pure shared helpers and add narrow, compatible
  returned-model metadata on the error path only.
- Create `tests/integration/prepared-decision.test.ts` (executor). Optional
  `tests/helpers/prepared-decision.ts` only if a fixture is reused.
- Parent will add `tests/integration/prepared-decision-review.test.ts` (off-limits).

## Shared helpers (in `system-one.ts`, extracted — not duplicated)

- `resolveSystemOneConfig(config)` — the existing `resolveConfig` made reusable, returning a defensive
  frozen snapshot (copy `accepted_response_models` and `price`).
- `prepareSystemOneRequest(input, resolved)` — the existing `prepare` (secret scan + exact JSON body)
  made reusable; returns `{input, json, bytes}`.
- `costBound(prepared, resolved)` — the existing bound math made reusable.
- Keep the **helpers exported internal** (provider package only) so the new adapter reuses them; the
  banned thing is exporting/serializing the **key VALUE** (never in identity/log/persist/JSON), not the
  pure helper returning a private DTO inside the package. No `as any` private access, no monkeypatch,
  no duplicated serializer/bound/pricing framework.

## Critical bits

**Snapshot & digest.** At `prepareDecision(input)` (sync, no I/O) snapshot `{resolved, preparedJson,
bytes, bound}` into a frozen closure; `execute` reads ONLY that snapshot, never `this.config`. Compute
`request_hash = sha256(utf8(preparedJson))` and `options_hash = sha256(canonical(ordered [id,description]
pairs))`. `config_hash` covers provider, endpoint, model, price version+rates, accepted models,
`SYSTEM_ONE_POLICY_VERSION`, `DECISION_QUESTION_SCHEMA_VERSION`, `timeout_ms`, `max_request_bytes`,
`max_response_bytes`, `request_overhead_bytes` (all security bounds) — **key excluded**. `identity` never
contains the key. A wrapped `fetcher` may recompute the frozen body deterministically; assert
`sha256(wireBody) === identity.request_hash`.

**Known-model metadata / error trust.** Extend `SystemOneError` with an optional LAST field
`reported_model?: string`, set ONLY after the returned model exactly matches an accepted id on a
known-cost path (malformed answer, over-bound). Never substitute the requested model for an accepted
alias. Known accounting always carries the exact reported `model`; if model metadata is unavailable,
remain conservative `unknown`.

**Accounting precedence.** Validate usage + accepted returned model (with operator pricing) BEFORE the
answer. Known charge survives a malformed/rejected choice; `cost_micro_usd > reserved_micro_usd` stays
**known** while output is refused with a static `cost_exceeded`. Missing/invalid pricing throws
synchronously at preparation (zero I/O). Unaccepted model / invalid usage after an attempt ⇒ `unknown`,
output cannot publish. Remote `typesafe`/`clef` output price MUST be 0 (no new loopback prod paths).

**Fetch boundary (untrusted IO).** Latch a one-shot `used` flag BEFORE the abort guard, so a pre-send
abort **consumes** the instance (no later retry) with `disposition:"not_dispatched"` and no fetch call.
An internal `attempted` flag is set immediately before calling `fetcher`; once set, the disposition is
`attempted` **even if** an injected `fetcher` throws (including one claiming `dispatched:false`). Chosen
strategy: the new adapter performs its **own** fetch + bounded read + JSON interpret and **never calls
`decide`**, so it never trusts a thrown error at all — foreign `fetcher`/body/stream errors are caught at
the source and converted to a static unknown envelope (no `instanceof`-only acceptance, no prototype
hacks, no raw `error.message`/`code` propagation; only whitelisted static `code`/`reason`). Known
accounting comes ONLY from a validated JSON response with accepted model + safe-integer usage/cost;
invalid JSON ⇒ `unknown`. The optional `reported_model` field is set by the legacy `interpret` path
only; the new adapter does not rely on it.

**Cancellation & late bodies.** The whole fetch + bounded read is under one deadline; even a
fetcher/stream that ignores `AbortSignal` must not publish late or leak unhandled promises — cancel/
dispose bodies and ignore any late `interpret`. Non-OK responses cancel the body with no echo.

**Freeze.** Deep-freeze the snapshot and the returned output by own values (including a
`probabilities` map that may contain `__proto__`/`constructor` option ids as own properties); do not
rely on TypeScript `Readonly` alone (no prototype pollution).

## Task 1 — core adapter + tests (parent gate)

**Files:** `packages/providers/prepared-decision.ts` (create), `packages/providers/system-one.ts`
(modify: helpers + narrow `reported_model`), `tests/integration/prepared-decision.test.ts` (create).

**Produced interface** (same names as the spec):
```ts
export const DECISION_QUESTION_SCHEMA_VERSION = "decision-question-v1";
export interface PreparedDecisionCall { readonly identity: PreparedDecisionIdentity;
  readonly request_bytes: number; execute(signal: AbortSignal): Promise<PreparedDecisionEnvelope>; }
export class PreparedDecisionProvider {
  constructor(config: SystemOneConfig, fetcher?: typeof fetch);
  prepareDecision(input: DecisionInput): PreparedDecisionCall;   // sync, no I/O
  upperBound(input: DecisionInput): number;                      // no-I/O; no .decide
}
```

- [ ] **Step 1 — RED (module shape).** Write `prepared-decision.test.ts` importing the new module and
  run `npx vitest run tests/integration/prepared-decision.test.ts --maxWorkers=1`. Expected RED:
  module missing (zero test bodies executed) — record the exact count honestly.
- [x] **Step 2 — extract helpers** in `system-one.ts` (`resolveSystemOneConfig`,
  `prepareSystemOneRequest`, `costBound`) and refactor `SystemOneProvider` to call them; assert the
  existing `system-one.test.ts` / `system-one-review.test.ts` stay GREEN. Add the optional
  `reported_model?: string` last field to `SystemOneError`, set only on accepted-model known paths.
- [x] **Step 3 — implement** `prepared-decision.ts`: snapshot + hashes + freeze; one-shot `execute`;
  attempt/disposition boundary; sanitized unknown envelopes; known/unknown precedence; static errors.
- [ ] **Step 4 — behavior RED→GREEN**, `prepared-decision.test.ts`:
  - mutated constructor config and post-prepare caller mutation never change `identity`/`request_bytes`/
    wire body/bound; the dummy key never appears in identity, the recorded wire metadata or stderr.
  - duplicate/concurrent `execute` throws with **0** extra fetch calls; pre-abort returns
    `not_dispatched` and consumes the instance; a fetcher that ignores abort is deadline-bounded.
  - accepted usage + malformed choice ⇒ **known** charge with the exact reported model; unaccepted
    model or missing/invalid usage ⇒ **unknown**; a forged `SystemOneError` (claimed `dispatched:false`,
    actual 999) after a fetch attempt ⇒ **unknown** `attempted` (never a free zero).
  - missing/invalid price throws synchronously at prepare with zero fetch; known cost above the bound
    ⇒ known with a static `cost_exceeded` and refused output.
  - unsupported provider/endpoint fails early; both `typesafe` and `cloudflare` (root `success` wrapper)
    request/alias shapes are exercised; option ids with `__proto__` survive frozen, ordered, validated.
- [x] **Step 5 — focused GREEN.** `npx vitest run tests/integration/prepared-decision.test.ts
  tests/integration/system-one.test.ts tests/integration/system-one-review.test.ts
  tests/integration/prepared-provider.test.ts tests/integration/prepared-provider-review.test.ts
  --maxWorkers=1`; then `npm run typecheck`, `npm run lint`, `npm run build`. **STOP for parent review.**

## Task 2 — parent-reported repair (ACCEPTED LOCALLY)

Parent independent review of the focused set passed **125**, then its expanded
`prepared-decision-review.test.ts` observed exactly **1 RED / 15 pass** at 00:18:20: a post-fetch abort
returned `disposition:"attempted"`/unknown correctly, but the static reason falsely said "cancelled
before it was sent". Repair: `STATIC_REASONS.PROVIDER_ABORTED` → neutral "The decision request was
cancelled." (no invented no-send certainty for the after-fetch case). Also imported the shared
`PROBABILITY_SUM_TOLERANCE` from `system-one.ts` instead of a duplicated const (no behavior change).

Post-repair focused run (serial): 6 files **164 passed** (own 12 + the parent's expanded review,
which now includes the cross-provider malformed matrix). `typecheck` GREEN.

Honest TDD record: the parent recorded the original module-absence RED (zero test bodies); my own
suite (`prepared-decision.test.ts`, 12 tests) was authored **after** the implementation, so no separate
own RED was observed. The adapter intentionally copies a bounded read + interpret from the legacy
transport (the plan allows own IO); a known maintenance limitation to record, not rewrite now.

## Commands

| Command | Purpose |
|---|---|
| `npx vitest run tests/integration/prepared-decision.test.ts --maxWorkers=1` | new focused suite |
| `npx vitest run ...five files above... --maxWorkers=1` | focused regression |
| `npm run typecheck` / `npm run lint` / `npm run build` | gates (each separate) |

The parent runs the full serial suite and Playwright only.

## Task 1 — IMPLEMENTED (executor, for parent review)

- `packages/providers/system-one.ts`: extracted exported internal pure helpers
  (`resolveSystemOneConfig`, `prepareSystemOneRequest`, `systemOneCostBound`) reused by the adapter;
  added an optional LAST `reported_model?: string` on `SystemOneError`, set only after accepted-model
  validation on known-cost paths. Legacy behavior/tests unchanged.
- `packages/providers/prepared-decision.ts` (new): `PreparedDecisionProvider` (no `.decide`),
  `DECISION_QUESTION_SCHEMA_VERSION`, frozen `identity`/`request_bytes`/`execute`; config defensively
  copied at construction; own fetch + bounded read + interpret (never trusts a thrown error); one-shot
  `execute`; `not_dispatched` vs `attempted`; known-charge-survives-bad-output; over-bound known with
  refused output; key excluded from identity/config_hash.
- `tests/integration/prepared-decision.test.ts` (new, executor): 12 independent invariants.

Verified (serial, Windows/Node 24.19): parent review **15/15**, own suite **12/12**, focused 6 files
**125 passed**; `typecheck`, `lint`, `build` GREEN. No runtime consumer imports the new module; no
deps/lock/schema/domain/storage/worker/server/UI change.



## Self-Review

- Every parent clarification is encoded: no `.decide`; shared pure helpers (no duplicated body);
  narrow `reported_model` metadata; sync price refusal; internal attempt flag + untrusted-IO sanitizing;
  full-bound `config_hash` (key excluded) + separate `DECISION_QUESTION_SCHEMA_VERSION`; deep-freeze;
  bounded cancellation; two-provider compatibility; closed file ownership; test-first RED.
- No placeholders; each step names exact files, signatures and commands.

## Final parent acceptance — 2026-10-17

- [x] Source/diff review and independent read-only code review: no blocking defects.
- [x] Parent focused six-file run: **164 passed**, including 54 parent review checks.
- [x] Parent full serial suite: **645 passed, 2 existing POSIX-only skips, 72 files**.
- [x] Parent typecheck/lint/build; **19/19 Chromium journeys**; **4/4 offline evaluations**;
  dependency audit (zero vulnerabilities). Reference screenshots restored with matching hashes.
- [x] No new runtime consumer, worker/profile/activation/storage/UI/dependency change; no paid
  call, real key, commit, push or deployment. Full G4 remains open.

Non-blocking review notes: response-byte overflow is classified `PROVIDER_UNAVAILABLE` rather than
legacy `PROVIDER_INVALID`; both retain unknown/attempted accounting. The new adapter's bounded read
and response parser duplicate legacy logic; equivalence is verified now, but future changes must
keep both paths aligned. This is not a claim of live endpoint compatibility or decision quality.
