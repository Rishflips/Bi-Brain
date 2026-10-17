# System 1 stage-specific decision activation & accounting — Implementation Plan (S1)

> **For agentic workers:** REQUIRED SUB-SKILL: `writing-plans` → `executing-plans`. Steps use `- [ ]`.
> TDD: write the failing test, RUN it, observe RED, then implement. Execute ONE task, then STOP for
> parent review. Task 1 accepted locally after parent full-suite/browser verification;
> Task 2 accepted after 819 passing tests (2 skips), 19 browser journeys and
> 4 offline evaluations. **S1 including Task 3 is now accepted locally:** final
> settled repeat 829 passed / 2 existing POSIX skips, 88 files; 24 Chromium
> journeys; 4 offline evaluations; typecheck/lint/build/audit passed.
> No production decision worker or live-provider/hosted result is implied.

**Goal:** Add a separate, default-off decision activation profile + stage-scoped central guard +
dedicated consent, proven with a disposable synthetic root and an injected decision transport. No
production worker/timer/decision call.

**Architecture:** A second single-row decision manifest (`managed_decision_activation`) + mirror
`<root>/decision-activation.json` + `decision-worker-ready.json`, alongside the unchanged reasoning
profile. `assertActivationSeam` selects the profile/hash by the spec's `stage`; a new pure helper
derives the decision expected config hash from the published adapter. Schema 3→4 stales existing audits;
restore disables both. Consent = master `provider_enabled` AND new `decision_provider_enabled` AND
background AND active goal purpose.

**Tech Stack:** Node 24.19, TypeScript (strict), zod, `node:sqlite`, Vitest. No new deps.

**Spec:** `docs/superpowers/specs/2026-10-17-system-one-stage-accounting-design.md` (APPROVED).

## Global Constraints

- Production decision activation stays OFF; the reasoning `managed_activation` row/mirror/readiness
  file and its schema-1 shape are untouched (no auto-enable, no consent migration).
- No new deps/lockfile; no real key/network/live call; tests use disposable synthetic roots + an
  injected `fetch`/`SystemOneProvider` and an explicit dummy key only. No env `TEST_MODE` bypass.
- Forward-only atomic migration; never drop money tables or a down-migration that loses holds. A
  supported restore is the documented rollback path.
- Keep the smallest focused new modules; do not expand the central store unboundedly. Parent owns
  `BUILD_STATE.md`, specs, docs, browsers, commits and every `*-review` file.

## File Ownership (closed)

- **New domain:** `packages/domain/managed-decision-activation.ts`.
- **New storage:** `packages/storage/managed-decision-activation.ts`,
  `packages/storage/managed-decision-activation-state.ts`.
- **New runtime:** `packages/runtime/decision-worker-readiness.ts` (T2).
- **New scripts:** `scripts/managed-decision-activation.ts`; `package.json` one script line.
- **Modify (T1):** `packages/domain/managed-spend.ts` (`managedMoneySchemaVersion` → 4),
  `packages/storage/managed-spending.ts` (new tables in `MONEY_DDL`), `packages/storage/managed-activation.ts`
  (+ `scripts/managed-activation.ts`) for the atomic both-profile global disable,
  `packages/storage/managed-restore-policy.ts` (restore barrier), `packages/runtime/managed-audit.ts`
  (schema signature), `packages/runtime/managed-recovery.ts` (mirror/restore/backup),
  `packages/storage/managed-activation-state.ts` (shared schema digest includes the new table).
- **Modify (T2):** `packages/domain/managed-activation.ts` (closed stage-discriminated guard types),
  `packages/runtime/managed-activation.ts`, `providers/prepared-decision.ts`,
  `storage/managed-spending.ts` (stage-scoped seam), `runtime/managed.ts`, and the raw
  decision-consent contract/prefs primitives in `packages/contracts/index.ts` +
  `packages/domain/service.ts` + `apps/worker/managed-accounting.ts` (coordinator) — moved to T2 so the
  guard/coordinator tests can require both flags without `as any` or a mutable callback bypass.
- **Modify (T3):** `apps/server/app.ts`/`main.ts`/`startup-gates.ts` and `apps/web/src.tsx` only
  (HTTP/status/UI wiring).
- **New tests:** T1 `managed-decision-activation.test.ts`, `managed-decision-activation-cli.test.ts`;
  T2 `managed-decision-guard.test.ts`; T3 `managed-decision-consent.test.ts`. Parent owns `*-review`.
- **Closed file graph**, ~24–26 real files; no generic placeholder count. No speculative provider
  registry.

## Interfaces (Produced)

```ts
// packages/domain/managed-decision-activation.ts
export const DECISION_ACTIVATION_SCHEMA_VERSION = 1;
export interface DecisionActivationProfile { schema:1; version:number; enabled:boolean;
  provider:"typesafe"|"cloudflare"; model:string; accepted_response_models:string[];
  endpoint:string; endpoint_digest:string; price_version:string;
  input_micro_usd_per_million:number; output_micro_usd_per_million:number;
  timeout_ms:number; max_request_bytes:number; max_response_bytes:number; request_overhead_bytes:number;
  config_digest:string; audit_digest:string; audit_id:string; epoch:number; root_nonce:string;
  fingerprint:string; updated_at:string; }
export function validateDecisionActivationProfile(input: unknown): DecisionActivationProfile;
export function decisionProfileConfigDigest(p: DecisionActivationProfile): string;
export function decisionActivationFingerprint(p: DecisionActivationProfile): string;
export interface DecisionOperatorInput { provider:"typesafe"|"cloudflare"; model:string;
  accepted_response_models:string[]; endpoint:string; price_version:string;
  input_micro_usd_per_million:number; output_micro_usd_per_million:0; timeout_ms:number;
  max_request_bytes:number; max_response_bytes:number; audit_id:string; expected_version:number; }
export function validateDecisionOperatorInput(input: unknown): DecisionOperatorInput;
// packages/providers/prepared-decision.ts (exported, no behavior change)
export function decisionPreparedConfigHash(input: { provider:"typesafe"|"cloudflare"; model:string;
  accepted:string[]; price:{version:string; input_micro_usd_per_million:number; output_micro_usd_per_million:number};
  endpoint:string; timeout_ms:number; max_request_bytes:number; max_response_bytes:number;
  request_overhead_bytes:number }): string;
// packages/runtime/decision-worker-readiness.ts
export interface DecisionWorkerReadiness { schema:1; worker_id:string; stage_scope:"decision";
  provider_family:"typesafe"|"cloudflare"; endpoint_digest:string; epoch:number; root_nonce:string;
  activation_fingerprint:string; config_digest:string; model:string; price_version:string;
  booted_at:string; heartbeat_at:string; expires_at:string; }
export function readDecisionReadiness(root: string, now: Date):
  { state:"ready"|"stale"|"absent"; readiness?: DecisionWorkerReadiness };
export function writeDecisionReadiness(root: string, r: unknown, clock?: () => Date): DecisionWorkerReadiness;
export function removeDecisionReadiness(root: string, workerId: string): void;
// packages/runtime/managed-activation.ts (add)
export function expectedDecisionConfigHash(profile: DecisionActivationProfile): string;
export function readDecisionActivation(control: AuditControl, root: string): DecisionActivationProfile | undefined;
export function evaluateConfiguredDecisionPolicy(input:{ control:AuditControl; root:string; now:Date; optIn:boolean }):
  { ready:boolean; reason:ActivationReason };
export function decisionServerCapability(input:{ configured:{ready:boolean;reason:ActivationReason};
  readiness:{state:"ready"|"stale"|"absent"; readiness?:DecisionWorkerReadiness}; profile?:DecisionActivationProfile }):
  { ready:boolean; reason:ActivationReason };
```

## Task 1 — migration + decision profile/persistence/audit/recovery/CLI (closed unit)

**Files:** `domain/managed-decision-activation.ts`, `storage/managed-decision-activation.ts`,
`storage/managed-decision-activation-state.ts`, `storage/managed-spending.ts`,
`runtime/managed-recovery.ts`, `runtime/managed-audit.ts`, `scripts/managed-decision-activation.ts`,
`package.json`; tests `managed-decision-activation.test.ts`, `managed-decision-activation-cli.test.ts`.

- [x] **Step 1 — RED.** Parent observed missing-module RED before the new domain module existed,
  and behavioral REDs for enrollment/CLI/shutdown defects before their repairs. Original command:
  `npx vitest run tests/integration/managed-decision-activation.test.ts --maxWorkers=1`. Expected RED:
  module missing (zero bodies); record the count honestly.
- [x] **Step 2 — schema 4 + DDL.** In `domain/managed-spend.ts` set `managedMoneySchemaVersion = 4` and add
  the spec's `managed_decision_activation` table to `MONEY_DDL` (do NOT alter `managed_activation`). The
  migration stays `BEGIN IMMEDIATE` + future-version guard + `INSERT OR IGNORE` marker; forward-only.
  ```sql
  CREATE TABLE IF NOT EXISTS managed_decision_activation(
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    schema INTEGER NOT NULL, version INTEGER NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
    provider TEXT NOT NULL CHECK(provider IN ('typesafe','cloudflare')),
    model TEXT NOT NULL, accepted_response_models TEXT NOT NULL,
    endpoint TEXT NOT NULL, endpoint_digest TEXT NOT NULL,
    price_version TEXT NOT NULL, input_micro_usd_per_million INTEGER NOT NULL,
    output_micro_usd_per_million INTEGER NOT NULL CHECK(output_micro_usd_per_million=0),
    timeout_ms INTEGER NOT NULL, max_request_bytes INTEGER NOT NULL, max_response_bytes INTEGER NOT NULL,
    request_overhead_bytes INTEGER NOT NULL, config_digest TEXT NOT NULL, audit_digest TEXT NOT NULL,
    audit_id TEXT NOT NULL, epoch INTEGER NOT NULL, root_nonce TEXT NOT NULL, fingerprint TEXT NOT NULL,
    updated_at TEXT NOT NULL);
  ```
- [x] **Step 3 — domain module.** `validateDecisionActivationProfile` recomputes `config_digest` +
  `fingerprint` after final fields; `provider` closed, `output_micro_usd_per_million` must be `0`,
  endpoint is canonical official HTTPS (reject credentials/query/fragment/non-default port/loopback/
  non-allowlisted path); `endpoint_digest = sha256(canonicalUrl)`. `validateDecisionOperatorInput` is
  the strict operator input (no `enabled`/digests).
- [x] **Step 4 — store + mirror + audit digest.** `storage/managed-decision-activation.ts`: mirror
  primitives (256 KiB bounded, non-link), `readDecisionActivationRow`, `ManagedDecisionActivationStore`
  (`read`/`readState`/`enable(operatorInput, ack)`/`disable(expectedVersion)`/`disableForRestore(epoch)`),
  CAS, SQL-then-mirror, exact readback; `decisionActivationAuditDigest(db, auditId)`.
- [x] **Step 5 — audit/restore/backup.** The shared `centralSchemaDigest` used by `managed-audit.ts` gains the new table's
  columns; `readEnrollmentBaseline`/`readSendGuardBaseline` remain intact (reasoning); existing audits
  become stale but stored enabled/consent values are preserved (effective processing denied, never
  displayed as flipped false). `managed-recovery.ts`: copy `decision-activation.json` under the same
  manifest conditions when the table matches; supported restore disables BOTH profiles + rotates epoch;
  both readiness files excluded from backups.
- [x] **Step 6 — CLI.** `scripts/managed-decision-activation.ts` with strict arity
  (`status|show|enable <file> --offline --workers-terminated|disable --expected-version <n>`), no
  auto-widen, read-only `status` creates no DB. Extend the existing `managed:activation disable` to
  disable BOTH profiles in one transaction then write both complete mirrors (mismatch denies); a
  decision-only disable stops decision only. `status` truthfully reports effective availability.
- [x] **Step 7 — GREEN + legacy.** `npx vitest run tests/integration/managed-decision-activation.test.ts
  tests/integration/managed-decision-activation-cli.test.ts tests/integration/managed-activation.test.ts
  tests/integration/managed-epoch.test.ts tests/integration/managed-spending.test.ts
  tests/integration/managed-recovery.test.ts tests/integration/managed-recovery-review.test.ts
  tests/integration/managed-audit.test.ts --maxWorkers=1`; then `typecheck`/`lint`/`build`. Update
  future-schema fixtures that currently assert version 4 → version 5, but **retain** any genuine v3
  historical input fixtures as v3.
- [ ] Example assertions:
  ```ts
  expect(readDecisionActivation(control, root)).toBeUndefined();        // default ABSENT, no auto row
  expect(() => store.enable(operator, ack)).toThrow();                   // no fresh audit => deny
  expect(readActivationRow(control.db)).toMatchObject({ enabled: true }); // reasoning row untouched
  ```

## Task 2 — stage-scoped runtime/readiness guard + coordinator (synthetic)

### Task 2A (NARROW, current gate) — closed guard + raw consent + stage-selected seam

**Accepted at the parent focused gate:** 157/157 across 12 affected files; fresh
typecheck/lint/build and whitespace checks passed. Independent review found no
remaining material 2A authority defect after central live-hash recomputation and
optional-undefined consent repairs. Full Task 2/S1 are not complete.

**Files (2A only):** `packages/domain/managed-activation.ts` (closed stage-discriminated guard types),
`packages/domain/managed-decision-activation.ts` (shared closed purpose/guard types if cleaner here),
`packages/contracts/index.ts` + `packages/domain/service.ts` (RAW `decision_provider_enabled` primitive),
`packages/storage/managed-spending.ts` (`assertActivationSeam` stage-selected),
`packages/storage/managed-decision-activation-state.ts` (guard snapshot),
`packages/runtime/managed-activation.ts` (`InstalledDecisionPolicy`,
`readDecisionActivationGuardContext`, `assertDecisionSendGuardContext`),
`packages/runtime/managed-audit.ts` only if a bounded current-slot baseline needs a decision stage.
**New own test:** `tests/integration/managed-decision-stage.test.ts` (full TDD; RED first).

**Closed discriminants (2A):**
```ts
type DecisionGuard = { stage:"decision"; provider:"typesafe"|"cloudflare"; purpose:"goal_relevance";
  job_kind:"review_changed_assumption"; /* goal id/version/project accounted at 2B */ };
type InstalledDecisionPolicy = { readonly stage:"decision"; readonly purpose:"goal_relevance";
  readonly root:string; readonly profile:DecisionActivationProfile; readonly worker_id:string };
function readDecisionActivationGuardContext(input:{ control:AuditControl; installed:InstalledDecisionPolicy;
  accountId:string; jobId:string; dispatchKey:string; stage:DispatchStage; phase:SendGuardPhase;
  lease:JobLease; centralCallId:string|null; tenantCallId:string|null;
  spec:{ provider:string; model:string; request_hash:string; config_hash:string; reserved_micro_usd:number } }): ActivationGuard;
function assertDecisionSendGuardContext(guard:ActivationGuard, root:string, control:AuditControl): void;
// RAW consent (default false; omitted preserves raw; never derived from master)
// preferencesSchema.decision_provider_enabled = z.boolean().default(false)
// managedPreferencesPatchSchema.partial({ provider_enabled:true, decision_provider_enabled:true })
Brain.prototype.decisionBackgroundConsent(p: Principal): boolean;
```
`config_hash` must equal `expectedDecisionConfigHash(profile)` (never `config_digest`); a coincident
hash cannot cross stages; a declared stage cannot widen; the central writer re-reads the matching
STAGE row/mirror/schema/inventory under a short transaction (no tenant DB inside it).

**Verified 2A (executor, 2026-10-17; focused serial `--maxWorkers=1`):**

- RED (owned, not fabricated): the new `tests/integration/managed-decision-stage.test.ts` first observed
  **16 failed / 1 passed** (missing `installDecisionPolicy` / `readDecisionActivationGuardContext` /
  `assertDecisionSendGuardContext` / `managedDecisionCapability` / `DECISION_GUARD_*` and a rejected
  decision guard shape). The parent `managed-decision-consent-primitives-review.test.ts` was
  **2 failed / 2 passed**.
- Domain (`packages/domain/managed-activation.ts`): `ActivationGuard` is now a closed discriminated union
  of `ReasoningActivationGuard` (`stage:"reasoning"`, `provider:"openai"`) and `DecisionActivationGuard`
  (`stage:"decision"`, `provider:"typesafe"|"cloudflare"`, `purpose:"goal_relevance"`,
  `job_kind:"review_changed_assumption"`) over the shared `SendGuardCommon`. `DECISION_GUARD_PURPOSE` /
  `DECISION_GUARD_JOB_KIND` exported. `validateActivationGuard` plus the type-narrowing
  `validateReasoningActivationGuard` / `validateDecisionActivationGuard`. The provider stays a closed
  literal/enum (never `z.string()`); a repair stage, a loosened provider or a cross-stage relabel denies.
- Runtime (`packages/runtime/managed-activation.ts`): `InstalledDecisionPolicy` (`stage`, `purpose`,
  `root`, defensively frozen `profile`, `worker_id`, operator `optIn`), `installDecisionPolicy` (deep-freezes
  a copy incl. the ordered accepted array), `readDecisionActivationGuardContext` (same inputs as the
  reasoning loader plus `now`; requires the operator opt-in, the declared `decision` stage, the shared
  `expectedDecisionConfigHash` — never `config_digest` — a fresh OWN `decision-worker-ready.json` lease whose
  fields equal the live profile, and `readSendGuardBaseline` with the exact self permit), and
  `assertDecisionSendGuardContext` (pre-I/O live central recheck; no tenant DB/TX). `readActivationGuardContext`
  now returns `ReasoningActivationGuard` and denies a non-reasoning declared stage.
- Storage (`packages/storage/managed-spending.ts`): `assertActivationSeam` selects the reasoning or decision
  snapshot/manifest by the validated guard+spec stage under the acquired `BEGIN IMMEDIATE`; it compares the
  enabled profile version/fingerprint/`config_digest`/epoch/root_nonce/audit id, the live epoch, schema
  version+digest, whole-audit digest and central-inventory digest, `spec.config_hash === guard.config_hash
  === guard.expected_prepared_config_hash`, and the exact immutable identity + slot ids. No tenant DB and no
  terminal audit is opened in the central TX; the unguarded low-level path is unchanged.
- Raw consent: `preferencesSchema.decision_provider_enabled` (default false) and a
  `managedPreferencesPatchSchema` built WITHOUT a default so an omitted key stays absent; `Brain.prefs`
  preserves the RAW stored choice when omitted, always allows an explicit false, and refuses an explicit
  true unless the trusted `decisionCapability` is ready and no durable block applies.
  `Brain.decisionBackgroundConsent(p)` is the raw tenant-bound getter. `ManagedRuntime` gains an optional
  `decisionCapability`; `managedDecisionCapability` derives it from the real decision profile + fresh
  separate readiness.
- GREEN: own `managed-decision-stage.test.ts` **19 passed**; parent
  `managed-decision-guard-schema-review.test.ts` **6 passed**; parent
  `managed-decision-consent-primitives-review.test.ts` **4 passed**; the combined owned+parent
  binding/runtime/guard/accounting/T1/prepared batch **238 passed in 17 files**. `typecheck`, `lint`,
  `build` GREEN.
- Still NOT done (2B): the coordinator decision reserve/mark/pre-IO/settle lifecycle, the actual tenant
  job/goal/lease/raw-consent guard, the exact decision slot reader, settlement/revocation ordering and the
  shared global barrier. No production decision caller, readiness writer, dispatcher, or tenant query in
  the central seam.

**Repair round (parent 2A security review, 2026-10-17):**

- Parent RED (actual, before fix): `managed-decision-stage-security-review.test.ts` **1 failed**
  (a guard with BOTH `config_hash` and `expected_prepared_config_hash` substituted to the same value,
  plus the same `spec.config_hash`, still reserved) and `managed-decision-consent-primitives-review.test.ts`
  **1 failed** (a present `decision_provider_enabled: undefined` was treated as an implicit withdrawal of
  a stored raw true).
- Fix 1 (central expected-hash forge): moved the pure profile→hash derivation
  `expectedDecisionConfigHash` into `providers/prepared-decision.ts` (the same module as the ONE canonical
  `decisionPreparedConfigHash`), and made `runtime/managed-activation.ts` re-export it. No duplicated hash
  formula and no storage→runtime import cycle. `assertActivationSeam`'s decision branch now independently
  derives the live expected hash from the LIVE decision profile under the acquired `BEGIN IMMEDIATE` and
  adds `expectedOk` requiring BOTH `guard.expected_prepared_config_hash` and `guard.config_hash` to equal
  it, before any money write. The reasoning branch keeps its existing guard-field trust (`expectedOk:true`);
  the reasoning call kind is not serialized centrally, so no reasoning refactor.
- Fix 2 (optional undefined consent): `Brain.prefs` now treats a present-but-`undefined`
  `decision_provider_enabled` as OMISSION (presence taken from the RAW input, never the local schema's
  `.default(false)`), so the stored choice is preserved. Explicit `false` still withdraws; explicit `true`
  still requires the trusted capability.
- Comment: `assertDecisionSendGuardContext` is documented as a NARROW live-snapshot assertion, NOT a
  standalone pre-I/O authority; 2B must combine it with a fresh
  `readDecisionActivationGuardContext(..., phase:"after_mark")` plus the real tenant job/lease/goal and raw
  consent.
- Own regressions added (pre-fix RED): both-hash substitution on reserve denies and leaves no hold;
  `undefined` decision field preserves the stored raw true.
- GREEN (focused serial `--maxWorkers=1`): own `managed-decision-stage.test.ts` **21 passed**; parent
  `managed-decision-stage-security-review.test.ts` **1 passed**;
  `managed-decision-consent-primitives-review.test.ts` **5 passed**;
  `managed-decision-guard-schema-review.test.ts` **6 passed**; combined 19-file batch **250 passed**;
  adjacent seam/prefs batch **126 passed, 1 POSIX-only skip**. `typecheck`, `lint`, `build` GREEN.

### Task 2B (after parent 2A gate) — coordinator lifecycle + exact slot + shared global barrier

**Authorized next.** Parent full-suite/browser verification follows the coherent
2B checkpoint; no 2A-only focused run is described as full Task 2 acceptance.

**Files:** `apps/worker/managed-accounting.ts`, `packages/domain/service.ts` job/goal context,
private attempt maps, decision slot reader, settlement/revocation ordering, barrier tests.

**Task 1 parent gate passed:** 728 passed / 2 POSIX-only skips in 78 files; 19 Chromium journeys;
4 offline evals; typecheck/lint/build/audit passed. Independent re-review found the corruption-stop
and mirror-reporting defects resolved. The genuine frozen-v3 parent tests include reserved,
dispatched-unknown and settled rows plus transactional DDL rollback. Corrupt decision configuration
remains preserved/off with a durable repair block; no automated clear command is implemented.

**Files:** `runtime/decision-worker-readiness.ts`, `runtime/managed-activation.ts`,
`providers/prepared-decision.ts`, `storage/managed-spending.ts` (stage-scoped seam),
`runtime/managed.ts`; test `managed-decision-guard.test.ts`.

- [x] **Step 1 — RED.** `managed-decision-guard.test.ts` imports the new readiness/exports; `-t` RED.
  Observed 02:04:08: `Cannot find module '../../packages/runtime/decision-worker-readiness.ts'`,
  **0 tests executed** (suite failed to load).
- [x] **Step 2 — shared hash helper.** `decisionPreparedConfigHash(input)` exported from
  `prepared-decision.ts`; the adapter's `prepareDecision` now calls it (byte-identical `config_hash`).
  `expectedDecisionConfigHash(profile)` in `runtime/managed-activation.ts` reuses it with the accepted
  array IN PROFILE ORDER; it is never equated with `config_digest`. `DECISION_POLICY_VERSION`
  (`decision-choice-v1` → `system-one-choice-v1`) is asserted equal to `SYSTEM_ONE_POLICY_VERSION`.
- [x] **Step 3 — separate decision readiness.** `runtime/decision-worker-readiness.ts`: `DecisionWorkerReadiness`
  + `readDecisionReadiness`/`writeDecisionReadiness`/`removeDecisionReadiness`/`decisionWorkerReadinessPath`
  over `decision-worker-ready.json` only (never `worker-ready.json`), 15 s TTL, bounded/anti-junction,
  own-worker-id removal. S1 production has NO writer. `evaluateConfiguredDecisionPolicy` and
  `decisionServerCapability` added to `runtime/managed-activation.ts`; the latter compares only the
  matching decision record.
- [x] **Step 4 — stage-scoped seam (2A DONE).** `storage/managed-decision-activation-state.ts`
  (`readDecisionGuardSnapshot`/`readDecisionActivationState`, root containment, SQL+mirror exact canonical,
  live epoch + audit digest, read-only) is used by `readDecisionActivation`/`evaluateConfiguredDecisionPolicy`
  (parent runtime-review 4 FAIL at 02:07:37 fixed). The closed stage-discriminated guard union, the
  stage-selected `assertActivationSeam`, `InstalledDecisionPolicy`/`installDecisionPolicy`,
  `readDecisionActivationGuardContext`, `assertDecisionSendGuardContext` and the raw
  `decision_provider_enabled` consent primitives are implemented and green (see "Verified 2A").
- [x] **Step 5 — coordinator (2B DONE locally).** The account-bound `ManagedDispatchAccounting`
  now serves a CLOSED union of installed policies: legacy reasoning (`InstalledActivationPolicy`, no
  `stage`) OR `InstalledDecisionPolicy` (`stage:"decision"`), with no arbitrary `allowedStages`/boolean
  permit. A decision dispatch through a coordinator without a decision policy is denied. The decision
  path re-checks the ACTUAL running tenant review job + lease (kind `review_changed_assumption`, owner/
  fence/expiry refreshed), the closed job payload principal bound to this owner, the goal entity (same
  project, active, prepared) with entity+plan version bound at reserve and re-checked before mark and
  before I/O, and both RAW consents plus background help. Central reserve is guarded by a fresh
  `readDecisionActivationGuardContext`, then tenant reserve + strict projection link, with the private
  attempt (exact central+tenant ids + original owner/fence + goal binding). Mark re-derives a fresh
  `before_mark` guard; `assertCanExecute` derives a fresh `after_mark` guard and then the narrow
  `assertDecisionSendGuardContext`. Settlement is central-first then independent tenant, followed by a
  NARROW decision post-settlement permission (no new admission, no refund). Exact account-scoped
  `receiptForSlot(jobId, dispatchKey)` added to `DispatchAccounting`/Local/Tenant/Managed.
- [x] Example assertions (real SQLite): reserve returns `reserved`; a known synthetic call settles
  `cost_micro_usd` on BOTH central and tenant; after mark + pre-abort the `dispatched` hold is retained,
  never released/refunded, and a fresh coordinator cannot adopt it.
- [x] **Step 6 — GREEN.** Parent Task 2 gate: 819 passed / 2 skips, 19 Chromium journeys.
  Earlier focused serial `--maxWorkers=1`:
  own `managed-decision-accounting.test.ts` **20 passed**; parent
  `managed-decision-accounting-review.test.ts` **7 passed**; two combined related batches **299 + 271
  passed, 2 POSIX-only skips, 61 files**; `typecheck`, `lint`, `build` GREEN.

**Initial 2B handoff limits (superseded by the repair round below):** No production decision dispatcher, worker bootstrap, timer, readiness writer or
UI is added; the decision coordinator is exercised only by tests. The 2B RED was not separately captured
before implementation (the executor implemented the coordinator, then observed the test failures caused
by fixture-shape assumptions and repaired them); the final GREEN behavior above is the verified proof.
The reasoning coordinator's global one-inflight barrier and the per-job cap across stages are proven; a
full live reasoning provider execution against the reasoning installed profile is covered by the existing
legacy suites, not re-run with a decision call in the same process.

**2B repair round (parent 2B review, 2026-10-17):**

- Parent REDs reproduced and repaired: (8th) a decision lease that expires DURING the adapter call
  returned success from `settle`; and (9th) changing the actual tenant job payload/principal after mark
  still authorized I/O. The parent's updated `managed-decision-accounting-review.test.ts` now has **9
  cases, all passing**.
- Fixes in `apps/worker/managed-accounting.ts`:
  - `requireDecisionJobLease` now uses a STRICT future deadline (`!(Date.parse(lease_until) > now)`),
    so a malformed/NaN timestamp fails closed.
  - `assertDecisionPostSettlement` now re-checks the actual running owner/fence AND a future
    `lease_until` > clock, in addition to policy/consent/account. It runs AFTER central+tenant settlement,
    so a lease that expired during I/O discards the output while keeping both known charges settled; no
    refund and no re-send. It never re-runs the full `after_mark` financial guard (which needs a
    dispatched row).
  - Decision preflight (`decisionPreflight`) and post-settlement now re-resolve the ACTUAL job
    payload/principal/project and the referenced goal via `decisionGoalContext` on EVERY before-mark,
    pre-I/O and post-settlement phase, comparing goal id, entity version, plan version and project to the
    private snapshot. `DecisionGoalContext` gained `project_id`.
  - `reserve` surfaces the SPECIFIC shared `usage_pending` barrier ("paused while a previous call awaits
    settlement accounting") via a bounded central read before any guard derivation/hold, so a second
    account's valid reasoning admission denies for the unknown-call reason, not a stale-audit reason.
- New own tests in `managed-decision-accounting.test.ts` (**28 passed**): lease-expiry keeps both known
  charges; post-mark principal/goal-reference/kind mutation `it.each` denies with the hold retained; a real
  decision call then a real `PreparedReasoningProvider` goal call on the SAME review job (both settle
  distinct central+tenant rows, one fetch each, both envelopes asserted `ok:true` — decision `choice`, goal
  `kind:"goal", outcome:"proposal"` with the exact evidence quote); a strengthened cumulative per-job cap
  test that builds both calls first and sets `cap = max(decision bound, reasoning bound)` so BOTH individual
  bounds fit the frozen cap while the settled decision actual (7) plus the reasoning bound EXCEEDS it — only
  the aggregation denies, with the reasoning slot left undefined and the decision still settled in both
  ledgers; and a two-account unknown/global-barrier + control-reopen empty-map + B extractive proof.
- Focused serial `--maxWorkers=1`: own 28, parent review 9, a 18-file related batch **161 passed**, and a
  35-file batch **357 passed, 1 POSIX-only skip**. `typecheck`, `lint`, `build` GREEN.
- Honest limit: the 2B RED was not separately captured before the executor's first implementation (the
  parent review supplied the material REDs above and they are now fixed); no production decision
  dispatcher/worker/bootstrap/timer/readiness-writer/UI exists, and the full live reasoning-coordinator
  worker execution alongside a decision call is exercised at the coordinator/provider level, not through
  a real scheduled worker process.

## Task 3 — raw/effective consent + truthful HTTP/UI (after Task 2 types)

**Task 2 parent gate passed:** 819 passed / 2 existing POSIX-only skips, 87 files;
19/19 Chromium journeys; 4/4 offline evals; typecheck/lint/build/audit passed.
Final coordinator proof executes both prepared calls on the same job; cap testing
fits each stage individually while rejecting their combined cost. Parent and
independent review verified repaired lease/context fences. No production decision
dispatcher or scheduled-worker proof is implied.

**Files:** `contracts/index.ts`, `domain/service.ts`, `apps/server/app.ts`/`main.ts`/`startup-gates.ts`,
`apps/web/src.tsx`; test `managed-decision-consent.test.ts`.

- [x] **Step 1 — RED.** Executor reports the new `tests/integration/managed-decision-consent.test.ts` failed
  against the unimplemented surface (missing `decision_capability_ready` / `decision_stored_consent_active`
  / `decision_consent_effective` status fields, missing public `decision_processing_available` /
  `decision_paid_reason` metadata), then went GREEN after implementation. Parent independently observed
  three browser REDs for the missing checkbox and a later RED for misleading durable-block copy before
  their repairs. The integration test itself does not prove the UI control.
- [x] **Step 2 — preference (2A, already in place).** `decision_provider_enabled` (default `false`);
  `managedPreferencesPatchSchema` optional; `Brain.prefs` preserves the RAW value when omitted and refuses
  an explicit true without a ready decision capability. Task 3 additionally surfaces the RAW choice through
  the status reader.
- [x] **Step 3 — status/metadata (DONE).** `Brain.status().spend` now carries own-account
  `decision_capability_ready` (trusted decision capability), `decision_stored_consent_active` (RAW, never
  derived from the master flag) and `decision_consent_effective` (master RAW AND decision RAW AND decision
  capability AND a configured, unblocked account — never an admission claim; an own `usage_pending` never
  clears it). `capability_ready` is unchanged. Public `/api/v1/runtime` adds
  `decision_processing_available` and a content-free `decision_paid_reason`
  (`managedDecisionReason`), which is deployment configuration only — no account money/consent, model,
  endpoint, key, path or total.
- [x] **Step 4 — UI (DONE).** The existing "Background help & spending" form gains a plain managed-only
  checkbox labelled exactly `Additional background checks` with the note "Allow selected goal context to
  be sent to an additional configured service for background checks." It is disabled only when the stored
  RAW choice is false AND the decision capability is not ready/configured/unblocked, but a stored true
  always stays checked and enabled so it can be withdrawn (including under a durable block). A new
  independent `decisionConsentOverride` and a shared `backgroundPatchBody` helper strip BOTH RAW consent
  fields from every `/preferences/background` PATCH (unrelated save and quick pause) so the effective
  getter can never be echoed; the two overrides are independent, reset on success and on account switch.
- [x] **Step 5 — GREEN (executor focus).** `managed-decision-consent.test.ts` **10 passed**; the focused
  serial regression batch (own consent + parent consent-primitives + 2B accounting 28/9 + guard-schema +
  binding + runtime + stage + legacy consent/status/spend/runtime-config/money-view/activation-guard +
  prepared-decision) **245 passed in 21 files**. `typecheck`, `lint`, `build` GREEN. `createApp` gained the
  internal `decisionCapability?: () => { available: boolean; reason: string }` option; `main.ts` wires the
  trusted `managedDecisionCapability` read-only closure into both `ManagedRuntime` and `createApp`.
- [x] **Step 6 — parent final acceptance.** After the copy repair, full serial repeat:
  **829 passed / 2 existing POSIX-only skips, 88 files**, 302.88 s. Full Chromium:
  **24/24**, including five independent consent journeys for unavailable withdrawal,
  unchanged-field omission, usage pending/readiness loss, durable-block copy and
  unsaved account-switch isolation. Typecheck/lint/build, 4/4 offline evaluations and
  dependency audit passed. Independent re-review confirmed the copy-only repair.
  No new Linux/container CI, real provider call, worker dispatcher or hosted release.

## Commands

| Command | Purpose |
|---|---|
| `npx vitest run tests/integration/managed-decision-activation.test.ts --maxWorkers=1` | T1 RED/GREEN |
| `npx vitest run tests/integration/managed-decision-guard.test.ts --maxWorkers=1` | T2 RED/GREEN |
| `npx vitest run tests/integration/managed-decision-consent.test.ts --maxWorkers=1` | T3 RED/GREEN |
| `npm run typecheck` / `npm run lint` / `npm run build` | gates (each separate) |

Parent runs the full serial suite and Playwright only; the executor runs focused serial suites.

## Unresolved design gaps (resolved in-plan, no parent question needed)

- **Endpoint storage:** the spec stores the canonical official URL AND its digest (the digest alone
  cannot derive the adapter's expected hash); `endpoint_digest` is the non-secret projection.
- **Readiness filename:** a separate `decision-worker-ready.json` avoids overwriting the reasoning
  record; no readiness schema v2.
- **Legacy audit display:** schema 4 stales reasoning audits; stored `enabled`/consent are preserved and
  effective processing is denied — never flipped false in the row.
- **`hasUnresolved`:** left byte-identical; the decision stage uses a new exact slot/state reader.

## Task 1 — REPAIRED (executor; parent re-review)

Parent review round 1 reproduced **57 tests / 49 pass / 8 FAIL** (01:31:13) in the two
owned `*-review` files. All 8 are repaired and now green; the parent's later fix of
`managed-audit-review.test.ts` (version 4→5) is acknowledged and its case passes.

Repairs: CLI exclusive command branches (positive `enable` now works; duplicate/unknown/
misplaced flags rejected); genuine readonly SQL↔mirror comparison for `status`/`show`
(mismatch, never `present`; absent→`off`, present→`unavailable`); `ManagedDecisionActivationStore.enable`
now does the full central preflight and re-reads epoch/root-marker/schema/whole-audit-digest/
central-inventory digest under the lock; immutable UPDATE/DELETE triggers on
`managed_decision_activation_events` + its columns folded into the shared control schema
signature; row readback and `changes===1` event guards; reasoning `disabled` event recorded in
the SAME global-stop transaction; fingerprint now binds the FULL ORDERED `accepted_response_models`;
whitespace-only tokens rejected and operator endpoints normalized to the canonical allowlisted URL
while stored profiles must be exactly canonical; `DECISION_POLICY_VERSION` corrected to
`system-one-choice-v1`.

New tests: `managed-decision-activation-cli.test.ts` (8) and `managed-decision-migration.test.ts`
(2: a genuine 3→4 migration proving money/reasoning preservation + decision absence, validated
against the FROZEN v3 DDL captured from `658565b` in `tests/helpers/managed-v3-fixture.ts`; and a
stale-audit proof that an audit accepted before the decision security binding is refused after it
is re-established by the real migrator). Future-schema fixtures 4→5 in the two non-review
executor tests.

Verified (serial, 17 files): **182 passed, 1 POSIX skip**; `typecheck`, `lint`, `build` GREEN.

### Round 2 — reviewed defects repaired

RED observed by the parent (not fabricated here): absent-profile `disable(9)` returned a
successful no-op instead of a strict CAS deny (**CAS RED**, 01:47:17), and a true frozen-v3
root could not be globally stopped because the missing event table rolled the stop back
(**compat RED**, 01:48:24). The independent review then reproduced two further defects at
01:50:03: a corrupt decision row held the global reasoning stop hostage (TX rollback), and the
decision-only `disable` swallowed mirror-write failures.

Repairs (Task 1 only): absent `disable` now denies unless `expectedVersion === 0`; the global
stop performs a reversible schema-forward (`ManagedSpendingStore`) BEFORE its transaction, so a
v3 root migrates to 4 and the event table exists (the migrator still refuses unknown future
schemas); a decision row that fails only profile validation is stopped truthfully inside the
same global TX by flipping `enabled` to 0 on the EXISTING raw row (bytes preserved, no
synthesized fingerprint) with a durable `managed_money_blocks('decision_activation_invalid')`
repair hold, and the caller commits, mirrors the valid reasoning profile, then throws a static
repair error; generic SQLite errors still roll back; decision-only `disable` now reports mirror
failures strictly (assert-before-mirror, no swallow).

Own RED cases: `managed-decision-activation.test.ts` (absent CAS) and the parent migration-review
fixture. Verified serial: **131 passed, 1 POSIX skip** across the focused set; `typecheck`,
`lint`, `build` GREEN. Honest limit: the migration test title now claims only money/reasoning
preservation; the genuine frozen-v3 financial-preservation proof lives in
`managed-decision-migration-review.test.ts` (parent) using `tests/helpers/managed-v3-fixture.ts`.

Schema 3→4 + `managed_decision_activation`/`_events` DDL; `domain/managed-decision-activation.ts`
(closed profile/operator validators, canonical endpoint + raw-URL digest, recomputed
config/fingerprint digests); `storage/managed-decision-activation.ts` (mirror, `ManagedDecisionActivationStore`
read/enable/disable/disableForRestore, audit digest reused); `runtime/managed-audit.ts`
`schemaSignature` + `storage/managed-activation-state.ts` `centralSchemaDigest` both include the new
table (audits stale consistently); `runtime/managed-recovery.ts` copies/restores/disableForRestore the
decision mirror and excludes both readiness files; `scripts/managed-decision-activation.ts` + one
`package.json` script; global `ManagedActivationStore.disable` now disables BOTH profiles in one TX then
writes both mirrors (mirror failure throws with both SQL rows off).

Verified (serial): parent decision profile review **41/41**, persistence review **8/8**, own suite
**6/6**, legacy epoch/spending/activation/recovery/restore **44 passed, 1 POSIX skip**; `typecheck`,
`lint`, `build` GREEN. Future-schema fixtures updated 4→5 in the two executor-owned tests; genuine v3
fixtures retained.

**Blocked (parent-owned):** `tests/integration/managed-audit-review.test.ts:69` inserts
`managed_money_schema(version=4,…)`, which is now the current version ⇒ the "future schema invalidates
audit" case must use `5`. Narrow parent edit requested; not modified by the executor.



## Self-Review

- Three tasks cover every approved section: migration/audit/restore/CLI (T1), stage-scoped
  guard+readiness+coordinator (T2), raw/effective consent+HTTP/UI (T3). No S2 worker/timer/decision call,
  no persisted advisory results, no telemetry sink.
- Existing reasoning schema-1 profile/mirror/readiness and legacy retry/no-resend are preserved; only
  genuine "current version" fixtures move 4→5.
- No commits until the parent authorizes a checkpoint; the plan is not an implementation.
- Test-first: each task's suite must observe a real RED (module-absence count recorded honestly, or a
  behavior failure) before implementation; no fabricated RED.

## Approval note

The written owner approval covers S1 (schema 3→4, closed decision provider/endpoint, coordinated
restore/disable, stage-scoped guards, consent/UI semantics). It does not select real prices, authorize
an owner activation, a real key/paid call, a deploy or a merge. Task 2/3 begin only after the parent
reviews this plan and accepts Task 1.
