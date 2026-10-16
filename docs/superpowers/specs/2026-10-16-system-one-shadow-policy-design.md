> **NOT APPROVED — superseded for the next-slice recommendation by the
> [prepared-call design](2026-10-17-system-one-prepared-call-design.md).**
> This draft is retained unchanged below as historical record only.

# System 1 shadow-policy design — advisory goal-relevance foundation (DRAFT, rev 2)

**Status: DRAFT for human review. Not approved. No plan or code is authorized by this document.**
Narrowed to the first unblocked G4 slice: a **rules-first, advisory shadow-policy foundation**. It is
not a live decision-model integration and does not close G4.

## Verified current state (inspected, not assumed)

- `packages/providers/system-one.ts` is a real bounded transport (`SystemOneProvider`,
  `typesafe`/`cloudflare`) with `upperBound`/`decide`, strict option/probability validation, a secret
  scan, bounded streaming and `dispatched`/known-usage errors. It is **not** a `prepareCall` one-shot
  and is **not** reachable from the managed worker.
- The managed profile is fixed `openai`/`openai_responses`; the Task-2 send guard requires
  `stage === "reasoning"` and denies any other stage. No prepared decision contract, decision
  accounting or decision enrollment exists, so a paid decision call cannot be authorized today.
- Worker dispatch is one-shot `prepareCall` → reserve → tenant projection → mark → pre-I/O guard →
  settle. `ManagedSpendingStore` is the only money authority. `Brain` guarantees
  capture-before-derivation, evidence-reference validity and scoped export.
- **Actual lifecycle kind lists (why "existing lifecycle is free" is FALSE):**
  `Brain.invalidate` (service.ts ~L701) rewrites only `brief`/`proposal` (claims/goals separately);
  permanent purge (~L906) selects
  `'brief','proposal','receipt','claim','gate','intent','handoff','link','ping'`; the portable import
  entity enum (~L2738) is `["brief","goal","proposal","receipt"]`; `storage/vault.ts` (~L211) maps
  `receipt` → the `dreams` folder; daily goal-acceptance receipts are created as `kind:"receipt"`
  (~L1245) and imported receipts are retained but never acted on (~L2982).

## Approaches

- **A (recommended).** Pure rules-first policy produces a bounded goal-relevance **question** and a
  deterministic advisory **prediction** (`relevant`/`not_relevant`/`abstain`), persisted as an
  internal `receipt` **subtype**. The model judgment exists only in an offline, synthetic replay
  harness with an injected closed fixture selector. No production decision I/O.
- **B (rejected now).** Live shadow over `SystemOneProvider`: requires a prepared decision contract, a
  permitted `decision` stage, decision reservation/mark/settle and a new activation/pricing
  enrollment. Deferred to an explicit, separately approved **G4b**; calling `SystemOneProvider`
  directly would bypass the Task-2 guard.
- **C (rejected).** A standalone classifier unit with no runtime path is not a feature.

### Recommended persistence: `receipt` subtype (least touch), with targeted owned changes

Use existing `kind:"receipt"` with a strict internal `receipt_type:"goal_relevance_shadow"` and
`epistemic_status:"hypothesis"`. This reuses the **purge** list (already includes `receipt`), the
**export** path and the **import** enum. It requires explicit, owned, tested changes:
1. **Primary reads exclude the subtype**: Today/status receipt reads, the daily dream/acceptance-receipt
   view, and reader/agent context packs must filter it out; only a new **scoped owner-only** internal
   reader exposes it. No invented activity in the primary flow.
2. **`Brain.invalidate`**: extend the post-capture invalidation to shadow receipts (source moved /
   version changed / made private / tombstoned / goal disabled / opt-in withdrawn ⇒ set
   `status:"withdrawn"`, never auto-execute).
3. **Vault mapping**: route the subtype to a dedicated `observations` folder rather than `dreams`, so
   it is not presented as a dream receipt while still rebuilds/roundtrips.
4. **Import**: retain the subtype as `status:"unavailable"`, `decision_source:"rules"`, and **never
   trust the producer's judgment/choice/probabilities**; import derives unavailable, mirroring the
   existing "historical receipt cannot undo local work" rule.
5. **Portable format**: the entity enum already accepts `receipt`, so no new kind is needed; the
   versioned payload gains no new top-level field. If strict subtype validation cannot be guaranteed,
   the fallback is a new `observation` kind **plus** extending the four closed lists (invalidate,
   purge, import enum, vault) — more touch, chosen only if the subtype proves unsafe.

## A — advisory goal-relevance shadow policy

**Real trigger and outcome (not always pending/unavailable).** On an existing
`review_changed_assumption` job, after capture and deterministic authorization and independent of the
existing extractive branch, the rules policy computes an advisory prediction. If no active explicit
goal, background help off, or no authorized shareable source, it records **no** observation (static
skip), not a pending row. Rules results are `decision_source:"rules"`, completed, `0` remote calls; the
model path is offline-only, so no "unavailable/pending" rows exist for an unconfigured task.

**Dedupe:** at most one observation per `(goal entity version, ordered changed source
versions, policy version, question schema version)`, keyed off the existing job/entity idempotency —
no new global job sweep, no infinite background work, no repeats, quiet by default. Rules observations
must never change an already-admitted job, capture, schedule, public Today item or claim.

**Pure domain module (no provider import).** New
`packages/domain/system-one-shadow.ts` defines the closed question/answer types itself:
```ts
export const SHADOW_POLICY_VERSION = "shadow-goal-relevance-v1";
export const SHADOW_SCHEMA_VERSION = "shadow-question-v1";
export type ShadowChoice = "relevant" | "not_relevant" | "abstain";
export type ShadowSkipReason = "no_active_goal" | "background_off" | "no_authorized_scope"
  | "private_only" | "tombstoned_only" | "context_limit" | "no_changed_source" | "not_opted_in";
export type GoalSnapshot = { goal_id: string; goal_entity_version: number; plan_version: number;
  title: string; success_criteria: string; status: "active" | "paused" | "done";
  preparation_enabled: boolean };                                  // service-validated, never caller "authorized:true"
export type AuthorizedSource = { source_id: string; source_version: number; project_id: string;
  body_hash: string; term_signature: readonly string[] };          // hash/signature, not plaintext in the record
export type ShadowQuestion = { schema_version: string; policy_version: string; purpose: string;
  question_hash: string; goal: GoalSnapshot; options: readonly {id: ShadowChoice; description: string}[];
  sources: readonly {source_id: string; source_version: number; body_hash: string}[] };
export function buildShadowQuestion(input: { goal: GoalSnapshot; sources: readonly AuthorizedSource[];
  now: Date; max_sources?: number; max_bytes?: number }): ShadowQuestion | { skip: ShadowSkipReason };
export function predictRules(question: ShadowQuestion): { choice: ShadowChoice; decision_source: "rules" };
```
- Bounds picked for usefulness: **1 goal, up to 10 sources, 16 KiB**; deterministic ordering
  (`source_id`, `version`); `now` is used only for `now <= goal due dates` with a **frozen UTC clock**,
  and is hashed only if it is a decision input (no elapsed real timestamps in the hash).
- **Rules** use bounded, normalized **exact domain-term overlap** between the goal's
  title/success-criteria terms and each source's term signature; no default semantic inference,
  no adaptive thresholds. `not_relevant` is optional; uncertain cases return `abstain`.
- The **question hash** binds the full canonical serialized question: `schema_version`,
  `policy_version`, `purpose`, the **goal entity version** (not just `plan_version`), goal
  title/success-criteria/status, every option id+description, and the ordered
  `(source_id, version, body_hash)` list — so any security-relevant change is detectable.

**Service boundary.** The service authorizes **before** building and again **before persisting**, with
a CAS that captures the goal entity version, the current source list and deletion/fence state. The
caller never asserts authorization. A later source move/private/goal-disable invalidates existing
observations; opt-in withdrawal stops future work (existing records stay advisory/withdrawn, never
auto-executed). The model adapter is a thin bridge **outside** the domain (no domain→provider import,
no runtime provider constants, no public injected `DecisionProvider` in `Brain`/HTTP — so no caller can
trigger network without budget).

**Stored record (hypothesis, not fact).** `receipt_type:"goal_relevance_shadow"`,
`epistemic_status:"hypothesis"`, `status:"advisory"|"withdrawn"|"unavailable"`, `decision_source`,
`question_hash`, goal id + entity version + plan version, and `evidence:[{source_id, source_version}]`.
No raw note bodies, provider prompts or hidden reasoning anywhere. No monetary fields: a rules result
records **no** cost; the report may carry a clearly-labeled **simulated** usage, never central money
rows. A `context_limit` skip means no eligible context — it is **not** a monetary-budget or held-cost
claim. Model-only `confidence_raw` is retained uncalibrated and is never a threshold.

## Offline synthetic evaluation (operator; no runtime provider call)

- Extend the existing eval **additively** (`brain-eval` keeps its 4 fixtures). Compare **rules-only**
  vs an injected **closed fixture selector** on the same versioned inputs over disjoint **test-scenario
  IDs/case families** (a synthetic development set and a deterministic, disjoint held-out set — never
  random permutations of shared bodies, which would leak).
- Metrics are a deterministic synthetic function: confusion matrix, abstentions/errors/misses, stage
  timing, and clearly separated cost classes: `no_remote_call` (exactly zero) vs `simulated` usage.
  Reports keep synthetic identifiers and stage/policy versions only; no exact source text, tokens or
  reasoning, and **no calibration or real-USD claim**.
- Honest limit: fixtures cannot evaluate an unseen real model. A's synthetic comparison is a
  foundation, **not** a value bar that gates G4b; a later G4b needs its own design/activation/accounting
  approval and real held-out evidence (a possible human value judgment).

## Data retention (explicit)

- **Withdraw/opt-out** ⇒ invalidate/hide from queries; the record remains advisory and is not executed.
- **Permanent delete** ⇒ PURGE all current + retained entity versions and vault-reachable content for
  the dependent observation, per the existing deletion proof. Unmanaged operational backups are outside
  this guarantee; a supported restore replays current deletions. Corpus is **SYNTHETIC only** in this
  slice (no real private exports).

## Proposed TDD slices (planned only after approval)

1. Pure `system-one-shadow.ts`: `buildShadowQuestion` + skip reasons + full question hash + bounds +
   `predictRules` (single bounded outcome). TDD.
2. Durable `receipt`-subtype record via the existing lifecycle, with trigger/dedupe on
   `review_changed_assumption`, primary-read exclusion, `Brain.invalidate`/purge/export/import/vault
   coverage; import derives unavailable. TDD; no provider.
3. Additive offline policy-eval on the disjoint synthetic split; synthetic-identifier report and cost
   classes; no runtime provider call.

## What this can and cannot demonstrate

**Can:** a deterministic, bounded, versioned question builder; a bounded rules outcome; durable
advisory records with purge/export/rebuild/restore coverage and dedupe; an offline rules-vs-fixture
comparison. **Cannot:** real decision quality, outage behavior, real per-decision cost or calibration,
or a live shadow — those require the separately approved G4b adapter, accounting and activation.

## Explicit non-claims and boundaries

- No production decision I/O; no decision stage/activation/accounting added.
- Not completed G4; release gate 6 stays open.
- No cross-provider/fallback on error; `abstain`/`unavailable`, never a false 0.
- A decision/hypothesis is never authorization, secret detection or a safety barrier; it cannot create
  goals/claims/proposals, drop a capture, or change consent, budgets, schedules or instructions.
- No graph/model/classifier names or new technology toggles in the primary UI; operator/internal only.
