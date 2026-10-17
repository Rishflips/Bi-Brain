# System 1 advisory decision worker — S2 implementation plan

> **Current status: all three tasks accepted locally by the parent.** Final
> evidence: 984 passed / 2 existing POSIX-only skips, 98 files; 24 Chromium
> journeys; 4 offline evaluations; typecheck/lint/build/audit passed. Historical
> pause/handoff states below are superseded by the final acceptance section.

> **For agentic workers:** REQUIRED SUB-SKILL `writing-plans` → `executing-plans` (TDD, RED first).
> Spec: `docs/superpowers/specs/2026-10-17-system-one-advisory-worker-design.md` (**APPROVED**, owner
> "go ahead, proceed"). S1 is the accepted foundation; this plan is **unexecuted** and does not claim any
> task accepted. Execute ONE task, run the exact RED/GREEN commands, then STOP for parent review.
> Task 2 does not start until Task 1's pure module is reviewed; Task 3 does not start until Task 2's
> migration/lifecycle is reviewed.

**Goal.** Run ONE real, default-off, operator-opted-in advisory goal-relevance decision pass on an
existing `review_changed_assumption` job under the S1 guard/consent/accounting, persist an internal
`advisory` record, and never change capture, goals, claims, consent, budgets or the reasoning path.

**Hard constraints (all tasks).** No new dependencies or lockfile/LOCK changes. Pure domain has no I/O,
no provider import, no central money, no global storage. `question_hash` (domain canonical question) is
NEVER equated with the adapter `request_hash`/`config_hash`. Network I/O never inside a tenant/central TX.
The reasoning path is byte-unchanged when decision config is absent. No generic stage router, no provider
registry, no retries, no cross-provider fallback. No source/test changes outside the closed lists below.

## Closed file lists

**Task 1 (pure, small review gate):** `packages/domain/decision-advisory.ts` (new);
`tests/integration/managed-decision-advisory-question.test.ts` (new). Nothing else.

**Task 2 (persistence + service + lifecycles):** `packages/storage/decision-advisory.ts` (new);
`packages/storage/index.ts` (tenant migration 5 only); `packages/domain/service.ts` (narrow methods +
lifecycle lists); `packages/storage/vault.ts` (`observations` folder); `packages/runtime/managed-recovery.ts`
(restore barrier if needed); `packages/storage/restore-policy.ts` (shared local/managed hooks).
New tests `managed-decision-advisory-store.test.ts`,
`managed-decision-advisory-migration.test.ts`, helper `tests/helpers/tenant-v4-fixture.ts`.

**Task 3 (worker pair + bootstrap + process proof):** `apps/worker/decision-advisory.ts` (new);
`apps/worker/engine.ts`; `apps/worker/managed.ts`; `apps/worker/main.ts`;
`scripts/run.mjs` (strip the decision key from every non-worker child);
`packages/domain/service.ts` (only the goal-revision withdrawal hook needed for worker bookkeeping);
`packages/storage/vault.ts` (only truthful known/unknown job-receipt cost rendering);
`tests/integration/managed-decision-advisory-worker.test.ts` (new), helper
`tests/helpers/decision-provider-fixture.ts`. Touch `apps/worker/accounting.ts` only if a type is needed.
Do NOT touch `apps/worker/managed-accounting.ts` (S1 coordinator already supports the decision stage) and
no `apps/server`/web changes (status already omits the advisory kind). Parent owns every `*-review`,
spec, `BUILD_STATE.md`, docs index, `MANAGED_RUN.md`, `IMPLEMENTATION_PLAN.md` and browsers.

## Interfaces (Task 1, produced and consumed later)

`packages/domain/decision-advisory.ts` (pure; imports only `./logic.ts`, `node:crypto` and `zod` for the
closed validators — no provider, no storage, no I/O):

```ts
import { createHash } from "node:crypto";
import { z } from "zod";
import { BrainError, canonical } from "./logic.ts";

export const ADVISORY_SCHEMA_VERSION = 1;
export const ADVISORY_POLICY_VERSION = "advisory-goal-relevance-v1";
export const ADVISORY_MAX_SOURCES = 10;
export const ADVISORY_MAX_QUESTION_BYTES = 16 * 1024;
export const advisoryChoices = ["related", "unrelated", "abstain"] as const;
export type AdvisoryChoice = (typeof advisoryChoices)[number];
export type AdvisoryStatus = "advisory" | "withdrawn" | "unavailable";
export type AdvisorySkipReason =
  | "no_active_goal" | "not_opted_in" | "background_off" | "no_authorized_scope"
  | "private_only" | "tombstoned_only" | "no_changed_source" | "context_limit";

/** Service-derived snapshot; there is NO `authorized:true` caller boolean. */
export interface AdvisoryGoalSnapshot {
  goal_id: string; goal_entity_version: number; plan_version: number;
  project_id: string; title: string; success_criteria: string;
  status: "active" | "paused" | "done"; preparation_enabled: boolean;
}
export interface AdvisorySourceSnapshot {
  source_id: string; source_version: number; project_id: string; body: string;
}
export interface AdvisorySourceRef { source_id: string; source_version: number; body_hash: string; }
/**
 * Transient build-time source: the validated ref PLUS the in-memory body. The body
 * is NEVER persisted; `AdvisoryRecord.sources` is stripped to `AdvisorySourceRef`.
 */
export interface AdvisoryQuestionSource extends AdvisorySourceRef { body: string; }
export interface AdvisoryQuestionOption { id: AdvisoryChoice; description: string; }
export interface AdvisoryQuestion {
  schema_version: 1; policy_version: string; purpose: "goal_relevance";
  question_hash: string;
  goal: { goal_id: string; goal_entity_version: number; plan_version: number; project_id: string;
    title: string; success_criteria: string; status: "active" | "paused" | "done" };
  options: readonly AdvisoryQuestionOption[];
  sources: readonly AdvisoryQuestionSource[];
  instruction: string;
}
export interface AdvisoryJudgment {
  choice: AdvisoryChoice; confidence_raw: number;
  probabilities: Readonly<Record<AdvisoryChoice, number>>;
}
export interface AdvisoryRecord {
  goal_id: string; goal_entity_version: number; plan_version: number; project_id: string;
  question_hash: string; sources: readonly AdvisorySourceRef[]; policy_version: string;
  epistemic_status: "hypothesis"; judgment: AdvisoryJudgment | null;
  status: AdvisoryStatus; decision_source: "prepared-decision";
}

/** Raw UTF-8 sha256 of the body; recomputed, never trusted from a caller field. */
export function advisorySourceBodyHash(body: string): string;
/** Deterministic byte-lex sort, duplicate-id reject, positive-int versions. */
export function buildAdvisoryQuestion(input: {
  goal: AdvisoryGoalSnapshot; sources: readonly AdvisorySourceSnapshot[];
}): { ok: true; question: AdvisoryQuestion } | { ok: false; skip: AdvisorySkipReason };
/**
 * The exact adapter input; only T3 passes this to PreparedDecisionProvider.
 * `state = canonical({schema_version, policy_version, purpose, question_hash, goal, sources})`
 * (every selected source BODY included), `instruction` is the fixed constant untrusted-data text, and
 * `options` are fresh fixed clones of the three choices so the adapter cannot mutate the question.
 */
export function expectedDecisionInput(question: AdvisoryQuestion): {
  state: string; instruction: string;
  options: { id: string; description: string }[];
};
/** Closed structural envelope (no provider import): map a settled call to a record. */
export function advisoryRecord(input: {
  question: AdvisoryQuestion;
  envelope: {
    accounting: { state: "known" | "unknown" };
    output: { ok: true; choice: string; confidence: number; probabilities: Record<string, number> }
      | { ok: false; code: string };
    disposition: "not_dispatched" | "attempted";
  };
}): { record: AdvisoryRecord } | { skip: "unknown" | "not_dispatched" };
export function validateAdvisoryQuestion(input: unknown): AdvisoryQuestion;
export function validateAdvisoryJudgment(input: unknown): AdvisoryJudgment;
export function validateAdvisoryRecord(input: unknown): AdvisoryRecord;
```

Rules encoded: goal must be `active` + `preparation_enabled` (else `no_active_goal`); every source must be
the goal's project, non-empty and valid BEFORE selection — a cross-project source, a duplicate
`source_id`, a malformed/private/unscoped entry (including the 11th) is invalid, never silently dropped.
Sort ALL eligible sources by `source_id` byte-lex then `source_version` asc (no `localeCompare`), then
choose the first `ADVISORY_MAX_SOURCES` (`10`) — the rest are discarded as a whole (a source body is never
trimmed). The goal snapshot carries NO plan field: only `title`+`success_criteria` enter the question, but
the full hash binds the goal entity+plan versions, so a plan change is still detected; the persisted record
contains no plan text even when the plan is public (Task 3's full-goal secret scan still reads
`title`/`success_criteria`/`plan`/`plan_evidence`). `question_hash = sha256(canonical(questionWithoutHash))`;
the 16 KiB cap is `Buffer.byteLength(canonical(fullQuestion))` where `fullQuestion` is the final question
INCLUDING its fixed-width 64-hex `question_hash`; over-cap returns `context_limit` with bodies intact. The
adapter's wire-overhead bound is separate and independently enforced. `validateAdvisoryQuestion`
recomputes every `body_hash` from its body and the full `question_hash`, so a plaintext swap under an old
hash fails; it also rejects any schema/policy/purpose/instruction or option id/description/order other than
the fixed constants (a caller cannot replace the instruction or options). `validateAdvisoryJudgment` is
strict: exactly `related`,`unrelated`,`abstain` keys, finite `[0,1]`, `|sum-1| <= 1e-9`,
`|confidence - probabilities[choice]| <= 1e-9` and `probabilities[choice] >= every other` within `1e-9`.
`unavailable` carries `judgment:null` only; `withdrawn` may carry a previously valid judgment. `advisoryRecord`
maps `known + attempted + ok:true` → judgment; `known + attempted + ok:false` → `status:"unavailable"` +
`judgment:null`; `unknown` or `not_dispatched` → skip WITHOUT fabricating missing metadata; a structurally
positive but invalid judgment THROWS (never becomes a valid record). The record is a closed schema with the
project taken from the question; it strips all bodies, the instruction, title/criteria strings, prompts and
amounts, and rejects extra/unknown fields (a record `source` carrying a `body` is rejected, not stripped).
No permission is ever read from the model.

**Constants are pinned independently** of `SYSTEM_ONE_POLICY_VERSION` and the adapter defaults; Task 3
bridges the domain question to the adapter and never reuses `request_hash` as `question_hash`.

## Task 1 — pure advisory question + closed record types (small review gate)

**Files:** `packages/domain/decision-advisory.ts`, `tests/integration/managed-decision-advisory-question.test.ts`.

- [x] **Step 1 — RED (actual).** Own `managed-decision-advisory-question.test.ts` written first; the module
  did not exist: `npx vitest run tests/integration/managed-decision-advisory-question.test.ts
  --maxWorkers=1` → `Cannot find module '../../packages/domain/decision-advisory.ts'`, **0 tests executed**.
  The parent's `managed-decision-advisory-question-review.test.ts` independently recorded the same
  missing-module load failure (0 executed) at 04:44:09.
- [x] **Step 2 — constants/types/hash (DONE).** `packages/domain/decision-advisory.ts` implemented with the
  fixed constants/types, `advisorySourceBodyHash` raw UTF-8 sha256, and a deep module (one builder, one
  bridge, three validators). Comparator is raw UTF-8 `Buffer.compare` (never `localeCompare`/UTF-16), as the
  parent review requires.
- [x] **Step 3 — build + bounds (DONE).** Deterministic byte-lex sort + first-10 selection; every input
  source validated before selection (duplicate/cross-project/blank/unsafe-version throw, including an
  excluded 11th); whole-question canonical hash; 16 KiB UTF-8 cap returns `context_limit` without trimming a
  body.
- [x] **Step 4 — record mapping (DONE).** `expectedDecisionInput` (fresh option clones, tamper re-validates),
  `advisoryRecord` (known+ok → judgment; known+!ok → `unavailable`/null; unknown/not_dispatched → skip;
  invalid positive throws), and the closed `validateAdvisoryQuestion`/`validateAdvisoryJudgment`/
  `validateAdvisoryRecord`.
- [x] **Step 5 — GREEN (DONE; parent gate pending).** Own **13** + parent **27** = **40 passed**; adjacent
  focused batch (adapter prepared-decision + guard/schema/binding/stage/migration) **153 passed in 11
  files**; `typecheck`, `lint`, `build` GREEN. The parent's 5 material repros (04:49:51) are repaired: the
  whole-question 16 KiB cap is re-checked in `validateAdvisoryQuestion`/`expectedDecisionInput`; the
  question/record arrays require `.min(1)`; duplicate `source_id` is forbidden in BOTH validators; the
  exported `advisoryOptions` (and `advisoryChoices`) are deep-frozen so a consumer cannot replace a fixed
  description; and the judgment sum tolerance is `ADVISORY_SUM_TOLERANCE=0.001` (the actual S1
  `PreparedDecisionProvider` rounds to `0.3333×3`), while confidence/choice stay at `1e-9`. STOP for parent
  review; Task 2 not started.

Test matrix (all synthetic, no network): a unique `SOURCE_BODY` marker appears in the question body and in
`expectedDecisionInput.state` but is ABSENT from the persisted record; `question_hash` is 64-hex, stable,
and IDENTICAL under an input source-array permutation (canonical sort) while changing with the selected
ordered set, a selected version, a selected body, or the goal entity/plan version; a re-ordered caller
array is not a hash change (the plan's earlier “changes with source order” is corrected here); >10 eligible
sorts then chooses the first 10, and a malformed/private/cross-project 11th throws before selection (never
silently dropped), while changing only the excluded 11th leaves the hash unchanged; duplicate `source_id`
throws; version `0`/fractional/`NaN` rejected; swapping a body under an old hash fails validator; an
alternate option description/instruction fails validation even if the question is rehashed; a Unicode body
whose UTF-8 byte length exceeds 16 KiB but fits a character-count shortcut returns `context_limit` with
bodies intact; record validation rejects unknown fields and a `body` on a source; judgment validation rejects
unknown keys, non-finite/out-of-range values, a bad sum, a `confidence`/`choice` mismatch and a non-max
`choice`; `known+ok` → judgment, `known+!ok` → `unavailable`/null, `unknown`/`not_dispatched` → skip (no
fabricated metadata), and a structurally positive but invalid judgment throws.

## Task 2 — tenant migration 5 + attempt CAS + scoped service + lifecycles

**Files:** `packages/storage/decision-advisory.ts`, `packages/storage/index.ts`,
`packages/domain/service.ts`, `packages/storage/vault.ts`, `packages/runtime/managed-recovery.ts`,
`packages/storage/restore-policy.ts` (existing shared local+managed restore/purge hooks).

**Parent Task 1 acceptance:** after all five review repairs, parent independently ran
**116/116** across six question/adapter/guard suites, including **40/40** owned+parent
question checks; fresh typecheck/lint/build passed. This is the pure focused gate,
not full S2 acceptance. Task 2 is authorized next; Task 3 remains gated.

**T2 revision — independent review findings (plan-level, no code yet):**

- **A. Shared restore/purge barrier.** Extend existing `packages/storage/restore-policy.ts` at
  `purgeRetainedDeletedSource` / `applyRestoreSafetyBarrier`: on an actual source purge also scrub the new
  `advisory_attempts`/tombstone refs (the existing `purgeRetainedDeletedSource` removes entities only). On a
  supported restore, keep S1 semantics (both paid profiles off, raw decisions preserved) and mark stored
  advisories `withdrawn`; do NOT silently reset the raw decision choice. Master off remains authoritative
  for D I/O. Money rows stay immutable.
  Rebuilding knowledge from an existing vault into a missing operational DB must
  also leave restored advisories withdrawn, even though the initial restore block
  is written before vault entities are rebuilt. Do not clear or recreate holds.
- **B. Explicit goal-edit + privacy hooks.** `Brain.editGoal` (service.ts L1152) revises without calling
  `invalidate`; add a narrow advisory withdrawal after the revision. Turning either global prefs flag off
  immediately marks dependent advisories `withdrawn` (no other primary-kind rewrites). `evidenceCurrent`
  does NOT check source visibility; add a strict, separate current-advisory-refs check (re-resolve the
  selected source ids/versions and require `state='active'` AND `visibility='project'`), not only the
  version helper.
  Cover goal-plan revisions through accept/undo as well as `editGoal`; no stale
  judgment may remain actively readable after any bound goal entity revision.
- **C. Vault folder.** Add `observations` to the vault `mkdir` folder list (~L162) AND the mapping (~L210)
  or the first advisory write raises ENOENT.
- **D. Concrete store + service interfaces (for T3/parent tests).** Define exactly:
  ```ts
  // packages/storage/decision-advisory.ts
  interface AdvisoryAttemptRow {
    idempotency_key: string; job_id: string; dispatch_key: "decision";
    project_id: string; goal_id: string; goal_entity_version: number; plan_version: number;
    source_refs_json: string; request_hash: string; config_hash: string; question_hash: string;
    owner: string; fence: number; state: "claimed" | "published" | "unavailable";
    advisory_id: string | null; claimed_at: string; updated_at: string;
  }
  type AdvisoryClaimResult =
    | { claimed: true; row: AdvisoryAttemptRow }
    | { claimed: false; reason: "exists"; row: AdvisoryAttemptRow }
    | { claimed: false; reason: "tombstoned" };
  function decisionAdvisoryKey(question: AdvisoryQuestion): string;
  function claimDecisionAttempt(store: Storage, input: {
    question: AdvisoryQuestion; principal: Principal;
    job_id: string; owner: string; fence: number;
    request_hash: string; config_hash: string;
  }, clock: () => Date): AdvisoryClaimResult;
  function publishDecisionAttempt(store: Storage, key: string, advisoryId: string,
    clock: () => Date): void;
  function markDecisionAttemptUnavailable(store: Storage, key: string, clock: () => Date): void;
  function readDecisionAttempt(store: Storage, key: string): AdvisoryAttemptRow | undefined;
  function purgeDecisionAttempts(store: Storage, match: (row: AdvisoryAttemptRow) => boolean,
    clock: () => Date): number;

  // packages/domain/service.ts (owner-checked, internal)
  decisionAdvisoryContext(p: Principal, goalId: string): AdvisoryQuestionResult;
  claimDecisionAdvisory(p: Principal, input: {
    goal_id: string; question_hash: string;
    lease: { job_id: string; owner: string; fence: number };
    request_hash: string; config_hash: string;
  }): AdvisoryClaimResult;
  saveDecisionAdvisory(p: Principal, input: {
    idempotency_key: string; record: AdvisoryRecord;
    lease: { job_id: string; owner: string; fence: number };
  }): Entity;
  decisionAdvisory(p: Principal, id: string): AdvisoryRecord | undefined;
  decisionAdvisoriesForGoal(p: Principal, goalId: string): AdvisoryRecord[];
  ```
  Every repository mutator asserts a real caller-owned `Storage.transaction` (`BEGIN IMMEDIATE`,
  `store.db.isTransaction`) BEFORE any read/write, and the job's owner principal must be bound to the trusted
  `input.principal` (a browser/agent field never authorizes). `saveDecisionAdvisory` REQUIRES a matching
  CLAIMED attempt whose FULL stored identity (question hash, goal entity/plan/project, ordered source refs,
  64-hex transport hashes) equals the CURRENT question + record, plus an actual still-running future
  owner/fence lease, and creates the entity + CAS `claimed→published` in the SAME tenant TX. An
  `advisory_attempts` immutable-identity trigger rejects any update to those fields. The owner-checked
  `claimDecisionAdvisory` wrapper (T3's entry point) derives the CURRENT question under one TX, compares the
  caller's prepared `question_hash` and claims with `this.ownerPrincipal()`. T3 alone owns the known-settled
  money check; T2 can never create an unclaimed advisory.
  Claim and mutation helpers require an owned tenant transaction; `clock` comes
  from `Brain.clock`, not model/browser input or an implicit `Date.now()` in tests.
  Re-read actual job kind, owner-bound payload, project, goal, running lease and
  strict future expiry (`Date.parse(until) > clock().getTime()`) before a claim and
  publication. `lease.job_id` must equal the immutable attempt's original job.
  Existing claims never transfer to a new owner/fence. A tombstone result carries
  no invented row; the caller simply cannot claim that work again.
- **E. Generic readers + export.** `Brain.entity`/`entities` must NOT return `advisory` by id for owner or
  agent (no new public API); `decisionAdvisory` does its own store load + current access; status/Today/pack
  use kind-filtered reads. Owner EXPORT explicitly collects+validates advisories independently of the hidden
  generic list and retains the closed record; import enum + sanitize derive `unavailable`/`judgment:null`
  (no attempt claim) with digest dedup over the full round-trip.
- **F. Tombstone choice (concrete).** A conservative source purge can delete the attempt row while the
  question's first-10 selected sources are unchanged, which could re-pay the SAME question. Chosen smallest
  typed approach: a dedicated hash-only `advisory_tombstones(idempotency_key TEXT PRIMARY KEY, question_hash
  TEXT NOT NULL, created_at TEXT NOT NULL)` — no source id, no goal text, no advisory ref. On purge, in one
  tenant TX, `INSERT OR IGNORE ... SELECT idempotency_key, question_hash, claimed_at FROM advisory_attempts`
  for affected goal, then delete the attempt/advisory rows. `claimDecisionAttempt` checks the tombstone and
  refuses to re-claim an identical `idempotency_key`. A new capture with new source ids/versions yields a
  different key and is allowed.


- [x] **Step 1 — RED (actual, executor).** Own `managed-decision-advisory-store.test.ts` (21 tests) and
  `managed-decision-advisory-migration.test.ts` (3 tests) were written first. The first focused run at
  05:02:53 recorded the store suite as a **missing-module load failure (0 test bodies)** — `Cannot find
  module '../../packages/storage/decision-advisory.ts'` — and the migration file as **2 failed / 1 passed**
  (v4→5 not implemented; the marker-failure rollback had no trigger to fire; the future-schema refusal
  already passed). These are the honest pre-implementation REDs, not simulated failures.
- [x] **Step 2 — tenant migration 5 (DONE).** `packages/storage/index.ts` adds the `advisory_attempts` +
  `advisory_tombstones` DDL and the `INSERT OR IGNORE migrations VALUES(5)`, DDL and marker in ONE
  transaction, and advances the forward guard to `>5`. A failed v5 marker rolls the whole new schema back;
  a genuine v4 database migrates with money/legacy/original bytes untouched and reopens idempotently.
- [x] **Step 3 — attempt CAS (DONE).** `packages/storage/decision-advisory.ts` (new, typed; every write to the
  new tables goes through it) implements `decisionAdvisoryKey`, `claimDecisionAttempt`,
  `publishDecisionAttempt`, `markDecisionAttemptUnavailable`, `readDecisionAttempt` plus the shared
  `purgeDecisionAttempts` tombstone/delete helper. It re-reads the actual running `review_changed_assumption`
  job, strictly binds the owner principal (kind + account tenant), payload goal, project and the live
  owner/fence with a strict future `Date.parse` (NaN fails closed). No reclaim/adoption under a new lease.
- [x] **Step 4 — scoped Brain service (DONE).** `decisionAdvisoryContext`, `saveDecisionAdvisory`,
  `decisionAdvisory`, `decisionAdvisoriesForGoal`; generic `entity`/`entities` hide the kind; invalidate,
  goal edits, plan accept/undo/revert and consent/background-off withdraw dependent ACTIVE advisories with
  real version history; owner export retains validated advisories while import derives `unavailable`/null
  and imports no attempt.
- [x] **Step 5 — vault + restore (DONE).** `vault.ts` adds the `observations` folder + mapping (and
  `verifyForget` now reports `index_gone`); `restore-policy.ts` withdraws stored advisories and scrubs the
  attempt ledger on the shared local+managed purge/restore barrier; the `Storage` constructor withdraws
  advisories after a vault rebuilds a missing operational database. No `managed-recovery.ts` change was
  required (its `applyTenantRestoreBarrier` + replayed `purgeRetainedDeletedSource` already route through
  the shared hooks).
- [x] **Step 6 — GREEN (executor, not accepted).** See the executor results block below.

**T2 executor results (2026-10-17, Windows / Node 24.19.0) — NOT accepted; parent full/browser gate owns acceptance.**

Repair round after parent review (parent persistence-review 43 tests, 16→18 material REDs; parent corrected one
false-assumption case itself, which the executor left byte-unchanged). Each material branch had an owned
RED confirmed before its fix (transaction guard: mutators no longer wrote outside a TX; stale-question
wrapper; withdrawn revival; purge safety; scoped-move/provenance import).

| Command | Actual result |
| --- | --- |
| `npx vitest run` store + own-migration + parent persistence-review + parent migration-review + T1 question + question-review `--maxWorkers=1` | **119 passed / 6 files** (store 30, own migration 3, parent persistence-review 43, parent migration-review 3, T1 question 13, parent question-review 27) |
| focus + adjacent set (recovery, profile-review, importer, gate, context-conflicts, spending, spend, decision migration/persistence/binding, vault, restore-barrier, epoch-restore) `--maxWorkers=1` | **280 passed / 22 files** |
| `npx tsc --noEmit` / `npx eslint .` / `npm run build` | passed separately on settled source |

Repairs: (1) every repo mutator asserts a real caller-owned `BEGIN IMMEDIATE` (`store.db.isTransaction`)
before any read/write; (2) the UUID-dir tenant heuristic is removed and `AdvisoryClaimInput` now carries a
required `principal`, bound to the actual job payload principal, with a new owner-checked
`Brain.claimDecisionAdvisory(p,{goal_id,question_hash,lease,request_hash,config_hash})` wrapper that derives
the CURRENT question and claims inside ONE tenant TX; (3) an `advisory_attempts` immutable-identity UPDATE
trigger plus a full stored-claim-vs-current comparison in `saveDecisionAdvisory`; (4) readers share one
`activeAdvisory` re-check that returns only live `advisory` records (withdrawn/unavailable archives never
revive); (5) `purgeDecisionAttempts` reads back the exact tombstone and requires the delete to change one
row, else the whole tenant TX rolls back; (6) advisory import derives `unavailable`/null, rejects available
`body_hash`/project contradictions, and retains opaque historical refs without inventing source history;
(7) the unsupported `verifyForget.index_gone` alias was removed. No provider/money/central-TX crossing.

Deviations: extra exports `purgeDecisionAttempts`/`attemptReferencesSource`; new `Brain.claimDecisionAdvisory`
(`packages/runtime/managed-recovery.ts` needed no change). No new dependency, no lockfile change, no
`provider_dispatches`/`reservations` or central money-schema change, no worker/server/UI edit, no Task 3 start.

Test matrix: a genuine tenant **v4** DB (frozen schema helper) migrates 4→5 with reserved / dispatched-
unknown / settled `provider_dispatches` rows byte-identical; a failed version marker rolls the whole TX
back; a DB `>5` is refused with data retained; claim CAS is exactly-once under contention; an orphan
`claimed` attempt with a settled central slot and no result becomes `unavailable` with no fake output;
records are hidden from Today/status/search/agent/handoff; source-to-private/consent-off/goal-edit marks
`withdrawn` and reads recheck authorization; import derives `unavailable`/null and imports no attempt.

## Task 3 — worker pair + opt-in bootstrap + synthetic process proof

**Task 2 parent gate accepted:** settled full suite **948 passed / 2 existing
POSIX-only skips, 94 files**, 672.60 s; **24/24 Chromium journeys**, **4/4 offline
evaluations**, typecheck/lint/build/audit passed. Independent read-only re-review
confirmed the known repairs. Task 3 is authorized; S2 overall remains incomplete.

**Files:** `apps/worker/decision-advisory.ts`, `apps/worker/engine.ts`, `apps/worker/managed.ts`,
`apps/worker/main.ts`, `scripts/run.mjs`, `packages/domain/service.ts` (goal-revision hook only),
`packages/storage/vault.ts` (job-receipt cost rendering only),
`tests/integration/managed-decision-advisory-worker.test.ts`.

**Task 3 pre-implementation review (not authorization before the Task 2 full/browser gate):**

- Use `Pick<PreparedDecisionProvider, "prepareDecision">` for the optional provider,
  not a nominal class instance requirement that tempts bypassing the readiness
  wrapper. Keep two explicit accounting instances, not a generic stage router.
- The installed decision policy/readiness `worker_id` is the process boot ID;
  the actual job lease owner remains the per-job `Worker.id`. Revalidate both
  through their own existing checks; never equate them or adopt another attempt.
- Insert the decision pass only on the existing owner goal-review path after
  cancellation/access/goal/secret eligibility checks and before the independently
  authorized reasoning dispatch. Absent/skipped decision config leaves baseline
  reasoning behavior unchanged. No advisory choice determines dispatch.
- Prepare the immutable adapter call outside a transaction, then use the new
  `Brain.claimDecisionAdvisory` wrapper with its prepared `question_hash` and exact
  request/config identity. It re-derives the current authorized question under the
  tenant write lock. Commit the claim before central reserve; do not hold a tenant
  transaction while entering the money coordinator or calling the provider.
- On retry/restart, use the original attempt mapping and exact financial slots.
  A settled decision is not an already-attempted reasoning call. The engine's
  existing catch/retry gate (`engine.ts:619`) must distinguish those stages only
  for this new path: no reasoning slot permits its normal pre-send retry; a
  dispatched/settled reasoning slot must never resend. Unknown decision usage
  remains blocked by the shared monetary barrier. Preserve `hasUnresolved` itself
  and reasoning-only retry behavior byte-for-byte.
- When both stages exist, existing job receipts must not report only the latest
  row as the whole job cost. Read both own-account exact slots; keep known stage
  costs separately and aggregate them with checked integer addition. If any
  marked usage is unknown, total cost stays unknown, not zero or merely the known
  subtotal. No monetary amount goes into the advisory entity. Add direct-worker
  assertions for D+R known total and known-D/unknown-R accounting.
  Exercise the actual vault dream-receipt rendering too: its current
  `cost_micro_usd ?? 0` fallback must never turn unknown/null usage into a printed
  zero. Render unknown explicitly; retain legitimate known zero/extractive costs.
- The reasoning completion path revises a goal for signature/notification
  bookkeeping. A decision bound to the previous goal entity version must become
  withdrawn, not be retagged as if the model judged the new version. Add the
  minimal goal-specific withdrawal hook to `Brain.revise` (including history),
  preserving behavior when no advisory exists; do not let stale advisory CAS
  failure cancel an otherwise authorized reasoning result.
- `scripts/run.mjs` currently forwards the parent's entire environment to the API,
  worker and dev Vite child. Remove **only** `BRAIN_DECISION_API_KEY` from all
  non-worker children; the worker keeps it. Do not change legacy OpenAI or identity
  configuration. Test the real launcher with disposable preloads/boolean reports,
  never a source-text grep or dumped environment. Direct operators must still
  supply per-process environments; this is not a sandbox against the OS owner.
- Decision and reasoning readiness refresh independently on the existing 5 s
  interval/15 s TTL, even if one profile/key is absent or corrupt. A decision-only
  install must not require a reasoning bootstrap to start its heartbeat. Shutdown
  removes only own markers. A real-process injected-transport test must run the
  actual bootstrap, not mistake the launcher environment probe for worker proof.

- [x] **Step 1 — RED (actual).** Parent independently observed 7/7 behavioral worker REDs before core wiring and four later repair REDs; own initial worker tests were authored after implementation (deviation retained below, not relabeled TDD).
- [x] **Step 2 — pair on `Worker` (`apps/worker/engine.ts`, `apps/worker/managed.ts`).** Add optional
  `decisionAccounting?: DispatchAccounting` and `decisionProvider?: Pick<PreparedDecisionProvider, "prepareDecision">` to the
  `Worker` constructor; existing `accounting` (reasoning) is byte-unchanged and the reasoning branch runs
  exactly as S1 whether or not `decisionAccounting` is present. `ManagedWorker.accountingFor` builds the
  decision coordinator ONLY when its installed policy is ready and passes it plus a
  `decisionProviderFactory?` through. No stage router: the decision pass is an explicit, separate call.
- [x] **Step 3 — decision pass (`apps/worker/decision-advisory.ts`).** `runDecisionAdvisory(deps, job,
  leaseOwner, signal)` (new file, no scheduler): derive context via the service (already a bounded question);
  if skip, return the static reason; prepare the adapter outside TX, then call
  `Brain.claimDecisionAdvisory` to atomically recheck the prepared question and claim;
  use the real installed decision coordinator's reserve,
  `before_mark`, `after_mark` + `assertDecisionSendGuardContext`, execute the adapter outside any TX;
  settle known (or treat unknown as a retained hold); persist the advisory in ONE tenant TX. It runs on the
  SAME review job with `dispatch_key:"decision"`; the reasoning pass keeps `dispatch_key:"reasoning"` and
  its own authorization. D failure never gates R beyond the existing shared monetary barrier. Decision
  run condition uses the RAW master + RAW decision + `prefs.enabled` + per-goal opt-in + fresh OWN
  readiness — never `prefs.provider_enabled` (the effective getter).
- [x] **Step 4 — opt-in bootstrap (`apps/worker/main.ts`).** Read worker-only `BRAIN_DECISION_API_KEY`
  (never forwarded/logged); with `BRAIN_MANAGED_ALLOW_PAID=1` and the enrolled decision profile, construct
  the adapter once, validate a synthetic `prepareDecision` with no I/O, and publish the worker's OWN
  `decision-worker-ready.json` (existing 5 s beat / 15 s TTL) only while the live profile is identical;
  shutdown removes only that marker. Wire `ManagedRuntime` `capability`/`decisionCapability` like the
  server so the worker brain's `prefs`/`status` see the real callbacks. Reasoning install/readiness is
  untouched when decision config is absent. No `TEST_MODE`; tests use injected fetch.
- [x] **Step 5 — GREEN + process proof.** `npx vitest run tests/integration/managed-decision-advisory-worker.test.ts
  tests/integration/managed-worker.test.ts tests/integration/managed-activation-process.test.ts
  tests/integration/managed-accounting.test.ts tests/integration/managed-accounting-review.test.ts
  tests/integration/worker-dispatch.test.ts --maxWorkers=1`, then gates. STOP for parent review.

Test matrix: direct `Worker` two-stage D→R on one review job (D settles a `decision` slot + advisory, R
sends once on `reasoning`); before-mark CAS release vs after-mark `not_dispatched` treated unknown;
unknown usage global barrier blocks paid R while B extractive capture/search still works (B master consent
false explicitly); known malformed → advisory `unavailable` + retained charge; source-to-private/goal-edit/
consent-revoke during I/O discards the advisory with the charge settled in both ledgers; a real
`ManagedWorker` PROCESS with two disposable accounts (provisioned before audit) that is killed after a
decision mark and reopened cannot adopt the held slot; duplicate key across jobs never resends; S1
reasoning-only tests (19/24 browser) remain unchanged.

**Task 3 executor results (2026-10-17, Windows / Node 24.19.0) — PAUSED / NOT accepted; owner called "hang on at safe point".**

The owner instructed a safe-point pause mid-Task-3. No revert/reset/commit/push/
provider/network/deployment occurred. All files below are preserved uncommitted.

Implemented (executor, closed list only): `apps/worker/decision-advisory.ts` (new),
`apps/worker/engine.ts`, `apps/worker/managed.ts`, `apps/worker/main.ts`,
`scripts/run.mjs`, `packages/domain/service.ts` (goal-revision withdrawal hook in
`revise` only), `packages/storage/vault.ts` (cost render only),
`tests/integration/managed-decision-advisory-worker.test.ts` (new). No
`managed-accounting.ts`/provider/server/UI/central-money change; no new dependency.

Honest process note: the parent independently observed **7/7 behavioral RED at
06:12:12** against the pre-implementation baseline (the decision stage did not run;
its fixture recorded `decision:0, reasoning:1`), i.e. the new stage genuinely failed
before this code. After the implementation the same 13-case suite reported
**12 passed / 1 failed**, where the single remaining failure is a **parent-test
defect**: it reads `vault.root/dreams/2026-10-17.md`, but the vault publishes
`generations/<gen>/dreams/<day>.md` (confirmed by the existing store test); cost
rendering itself is correct. The parent owns that file. Separately, the executor's
own `managed-decision-advisory-worker.test.ts` was authored AFTER the core
implementation (context-limited), so it has **no separately observed RED** — this
is retained as an explicit no-TDD-at-authoring admission, not an invented RED. The
parent's real launcher test was independently RED 2/2 before the `scripts/run.mjs`
fix.

| Command | Actual result |
| --- | --- |
| own `managed-decision-advisory-worker.test.ts` | **10 passed / 10** (6 core + 3 new negative/recovery regressions + 1 genuine-SQL dual-journal regression) |
| parent `managed-decision-advisory-worker-review.test.ts` | **18 passed / 18** (13 + 5; the parent's three new post-implementation RED cases and the dual-journal negative are green) |
| parent `managed-decision-launcher-env-review.test.ts` | **2 passed / 2** |
| own `managed-decision-advisory-process.test.ts` (real `apps/worker/main.ts`) | **5 passed / 5**: (a) boots both readiness leases and one D→R on one job, settled 7 + 1, proposal with source refs; (b) D settled → reasoning pre-send failure → retry/restart, zero D resend; (c) a held decision call keeps BOTH heartbeats fresh beyond 15 s, then a kill after mark is followed by a **real re-lease proof** (fresh boot id, job `attempts`/`fence` advanced ≥ 2 read-only, original dispatched/null hold intact, one decision call, zero R, no advisory) plus account B's real unpaid extractive brief produced by the ACTUAL main worker; (d) decision-ONLY boot with the reasoning key absent (no reasoning lease ever published, decision heartbeat advances); (e) reasoning-ONLY boot with the decision key absent (no decision lease/row, reasoning settles 1 + proposal) |
| focused serial batch (12 files: own worker, own process, launcher, `managed-activation-process`, `managed-decision-accounting`(+review), `managed-worker`, `managed-accounting`(+review), advisory-store, vault, importer) | **135 passed / 12 files** |
| earlier affected batch (worker-dispatch(+review), managed-worker, accounting(+review), decision-accounting(+review), runtime-review, persistence-review, advisory-store, vault, importer) | **164 passed / 12 files** |
| `npx eslint .` / `npm run build` | clean / passed |
| `npx tsc --noEmit` | **clean** (the parent repaired its own `worker-review.test.ts:271`) |

Repairs added after the process work (all in `apps/worker/decision-advisory.ts`; no
`managed-accounting.ts`/S1-coordinator change, no new table/API/dependency, no
cross-database transaction): (1) a full-context + job-current guard immediately
BEFORE reserve, so a change observable before any hold creates **no financial row**;
(2) the same guard immediately BEFORE the mark, INSIDE the existing pre-mark release
catch, so a reserved hold is RELEASED by the S1 CAS (no I/O); the post-mark privacy
case still leaves a dispatched/unknown hold; (3) recovery reads the ORIGINAL
`claim.row.job_id` slot, requires both the exact central `receiptForSlot` record and
the exact settled TENANT projection (`call_id`/job/stage/key/request/config/amount)
matching the current question before loading the owner-internal record; (4) a
central-settled-but-tenant-projection-failed settle now publishes **no** advisory
(both-journal check), leaving the known charge and reconciliation block.

Fixture hygiene (test-only): the child env is now an EXPLICIT OS/runtime allowlist
(PATH/Path/SystemRoot/SYSTEMROOT/TEMP/TMP/USERPROFILE/HOME/PATHEXT/ComSpec) plus the
synthetic extras and the fixture `NODE_OPTIONS`; the operator `.env` is never read.
`stopWorker` now captures the REAL `close` promise at spawn time (rejecting on
`error`), so it always awaits OS handle release rather than the `exit`/`exitCode`
approximation. `provision` closes its own runtime in a `finally` even on setup
failure. `cleanup` is an async bounded escalation (~10 s, yielding the event loop)
that FAILS the test with a data-free `code`/relative-entry diagnosis; a retained
root is never a passing warning. Observed root cause of the parent's warning:
`EPERM` on the fixture base — the killed worker could briefly outlive a synchronous
vault `git` grandchild whose CWD sits inside the root, so the tree was not removable
for a short window. The retained `bibrain-decision-hold-wdgoA5` root was verified to
delete cleanly with no live handle, and the executor's own `bibrain-decision-*`
fixtures were removed by prefix only; no unrelated temp directory was touched.

Gaps (not claimed): graceful SIGTERM marker removal is **not observable on Windows**
under `child.kill()` (libuv terminates without running the handler); it is covered by
`remove{Worker,Decision}Readiness` unit tests, not here. The kill-after-mark restart
case waits real lease expiry (read-only; no manual lease SQL/time adoption). Fatal
`AccountingPersistenceError` propagation and a direct `before-mark CAS release vs
after-mark not_dispatched` case are asserted by the parent/direct suites, not
separately re-added here. The executor ran only focused serial suites; the parent
owns the full suite, browser/E2E, offline evaluations and dependency audit.

**Executor handoff state (historical): Task 3 was NOT accepted.** The executor's focused gates were green,
but final acceptance requires the parent's full/browser/eval/audit gate (and the
parent's separate fatal integration test).

## Final parent acceptance — supersedes the partial handoffs

All three tasks are accepted **locally**, not deployed. Parent independently
reproduced four execution/recovery defects and verified their repairs. The final
full run with strict cleanup passed **984 tests / 2 existing POSIX-only skips,
98 files**, 720.54 s, without a cleanup warning. Its JSON report
`test-results/decision-advisory-s2-final.json` records success, 0 failed tests and
0 failed files. Parent Chromium: **24/24**; offline evaluations: **4/4**;
typecheck/lint/build/audit and whitespace checks passed. The parent worker suite
contains 19 cases, including real fatal accounting failure propagation; the real
launcher suite has two cases. All five actual-main process cases passed.

The prior 984-pass run's cleanup warning prompted a test-only repair; a subsequent
run exited 4 without a summary around a server restart and is not passing
evidence. The final run above completed after both. No production behavior was
altered to silence that fixture warning. No live model, actual pricing, current-
branch Linux CI, native client or public-host claim follows from this acceptance.
No commit, push, owner/provider activation or deployment was performed.

## Commands

| Command | Purpose |
|---|---|
| `npx vitest run tests/integration/managed-decision-advisory-question.test.ts --maxWorkers=1` | T1 RED/GREEN |
| `npx vitest run tests/integration/managed-decision-advisory-store.test.ts tests/integration/managed-decision-advisory-migration.test.ts --maxWorkers=1` | T2 RED/GREEN |
| `npx vitest run tests/integration/managed-decision-advisory-worker.test.ts --maxWorkers=1` | T3 RED/GREEN |
| `npm run typecheck` / `npm run lint` / `npm run build` | gates, each separate |

Parent runs the full suite and browsers only at a coherent checkpoint (Task 1 pure focused; Task 2 full +
browser before Task 3 is critical). The executor runs only focused serial suites.
