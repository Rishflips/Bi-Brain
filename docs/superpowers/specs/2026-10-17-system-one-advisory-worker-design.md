> **APPROVED — the owner replied "go ahead, proceed" to the written-design approval gate.**
> S1 remains a separately accepted foundation. Approval authorizes dependency-ordered
> S2 implementation and synthetic verification, with parent review between tasks.
> It does not provide a live-test spending cap, activate an owner/provider account,
> select real prices or a software license, or establish target-host readiness.

# System 1 advisory decision worker — S2 design (approved)

## 1. What S2 is (and is not)

**S2 is** a real, **opt-in, default OFF** production consumer of the S1 prepared decision adapter: an
operator bootstraps ONE decision profile and its OWN readiness record, the existing worker (no new
scheduler) runs a bounded advisory decision pass on an existing owner review job, and the settled result
is persisted only as an internal advisory record.

**It is not** a new scheduler or timer loop (it reuses the existing worker heartbeat: 5 s beat, 15 s
readiness TTL), and it does not itself perform any automatic external action, billing, hosted activation,
owner activation, real price selection or live/held-out quality evaluation — those remain a separate gate.
The design must stay honest that **live paid calls only occur when the operator opts in, installs the
profiles and supplies a key**; until then every decision capability is false.

**Never.** An advisory result MUST NEVER: skip/delay a capture; authorize a user goal; create/accept a
claim, proposal, receipt or plan; change consent, budgets, schedules, instructions or accepted memory; call any
provider other than the single enrolled one; retry or send twice; or gate existing reasoning dispatch.
The reasoning path stays **semantically unchanged** when decision config is absent.

## 2. Verified current state (inspected, not assumed)

- Adapter: `packages/providers/prepared-decision.ts` — `PreparedDecisionProvider.prepareDecision` (no-I/O),
  `execute(signal)` one-shot, `decisionPreparedConfigHash` (single canonical `config_hash`), envelope
  `{accounting:{state:"known"|"unknown"}, output:{ok:true,choice,confidence,probabilities}|{ok:false,code},
  disposition:"not_dispatched"|"attempted"}`.
- Guard/config: `packages/runtime/managed-activation.ts` — `InstalledDecisionPolicy`,
  `installDecisionPolicy`, `readDecisionActivationGuardContext` (opt-in, declared `decision` stage, live
  profile/epoch/audit, fresh OWN readiness, bounded self permit), `assertDecisionSendGuardContext`
  (narrow central snapshot only — not standalone I/O authority). `expectedDecisionConfigHash` is a pure
  re-export from `providers/prepared-decision.ts`.
- Coordinator: `apps/worker/managed-accounting.ts` `ManagedDispatchAccounting` binds ONE installed policy
  (`InstalledActivationPolicy` reasoning OR `InstalledDecisionPolicy` decision); `decisionGoalContext`,
  `requireBoundGoalCurrent`, `assertDecisionPostSettlement`, `requireNoOutstandingPaidCall`,
  `receiptForSlot(jobId, dispatchKey)`.
- Money authority: `packages/storage/managed-spending.ts` `reserve`/`mark`/`settleKnown`/`releaseUndispatched`/
  `reservationForSlot`/`anyDispatchedRow`; the decision seam is inside `reserve`/`mark`.
- Reasoning worker: `apps/worker/engine.ts` `Worker.tick` (L186) leases one job; review branch reads
  `sources(...).slice(0,20)` + `evidenceSignature` (L241-243), builds `goalInput = {title, success_criteria,
  plan}` inline (L357-361; private plan already omitted), then `dispatchPrepared`
   (`apps/worker/dispatch.ts` L74) reserve→tenant reserve→link→mark→pre-I/O guard→execute→settle, followed
   by publication in one tenant TX (engine L406). Network I/O is never inside that TX.
   `Worker` takes one `accounting` (`DispatchAccounting`).
- Runtime worker: `apps/worker/managed.ts` `ManagedWorker.accountingFor` (L143) builds ONE
  `ManagedDispatchAccounting`. `ManagedRuntime` exposes `capability`/`decisionCapability`.
- Readiness: `packages/runtime/decision-worker-readiness.ts` `readDecisionReadiness`
  (`decision-worker-ready.json`, 15 s TTL), separate from `worker-ready.json`.
- Tenant storage: `packages/storage/index.ts` — forward-only tenant `migrations` table, **current max
  version is 4** (L108); a newer-than-known version refuses (L32-38). `portableState()` exports
  `source_versions`/`entity_versions` only; operational tables (e.g. `provider_dispatches` L86) are local.
- Entity lifecycles: `Brain.invalidate` (`service.ts` L672) rewrites only claim/goal/brief/proposal; purge
  select list (`:913`) is `'brief','proposal','receipt','claim','gate','intent','handoff','link','ping'`;
  portable import enum (`:2792`) is `["brief","goal","proposal","receipt"]`; `storage/vault.ts` maps
  `receipt`→`dreams` (L210-216) and renders daily `dreams/<day>.md` (L237-263).

## 3. Approaches

- **A (recommended). Explicit coordinator PAIR.** `Worker` gains an OPTIONAL `decisionAccounting?` plus
  `decisionProvider?`; the existing `accounting` (reasoning) is byte-unchanged. When a decision pass runs
  it uses the decision coordinator explicitly; there is no generic "route every other stage" router.
  Missing decision config ⇒ only the decision capability is false; reasoning works exactly as S1.
- **B (rejected). One generic stage router over one `ManagedDispatchAccounting`.** A single bound policy
  routed by arbitrary stage was already rejected in S1; it couples the proven reasoning path to a
  decision failure and implies a permissive stage switch.
- **C (rejected). Rules-only shadow** (`2026-10-16-system-one-shadow-policy-design.md`, NOT APPROVED): a
  deterministic rules result is tautological bookkeeping, not a real advisory judgment.

**Same job, ordered stages.** D and R are two stages of ONE existing `review_changed_assumption` job, not
two jobs: the decision pass uses `dispatch_key:"decision"` and the reasoning pass keeps
`dispatch_key:"reasoning"`. The advisory result is never a prerequisite or a permission for R.

**Bootstrap boundary.** Reuse `BRAIN_MANAGED_ALLOW_PAID=1` plus the separately
enrolled decision profile. One worker-only `BRAIN_DECISION_API_KEY` supplies the
key for that profile's closed provider family; never infer a provider from the
key or forward it to the server. Load/freeze the profile and construct the adapter
once, validate a synthetic `prepareDecision` without I/O, then publish own matching
readiness only while the live profile remains identical. Check own readiness at
prepare and directly before execute; shutdown removes only that worker's marker.
No decision config/key leaves reasoning installation/readiness untouched. A
failure to refresh readiness cannot bypass its expiration. Provider/profile/key
rotation requires a worker restart; no automatic reload or provider failover.

## 4. Privacy and authorization re-validation

- **Bounded question.** One goal, the first ten eligible shareable sources ordered by
  `(source_id, version)`, and at most **16 KiB of canonical UTF-8 question content**. Include
  the goal version, plan version, policy/schema versions and exact source-version/body-hash
  manifest; use the closed choices `related`, `unrelated`, `abstain`. Oversized context is a
  no-call skip, not silent truncation. The adapter independently enforces its full wire-size
  bound including overhead. No model is used to choose permissions or detect secrets.
- **Before I/O** the exact authorized source set, goal entity version, plan version and project are
  re-resolved from domain services and matched to the question snapshot; sources that are private,
  quarantined, tombstoned, cross-project or not in the goal's project are excluded.
- A deterministic secret/quarantine scan runs on the FULL goal (`title`, `success_criteria`,
  `plan`/`plan_evidence`) before send; the question itself omits the private plan exactly as the engine's
  `goalInput` does (L357-361) — the scan is not loosened to match that omission. Rules-only advisory can
  never override the scan.
- **After settle, before publish** the same authorized set/version/project are re-checked; a move, purge,
  goal edit or private transition discards the output (known charge retained). Honest boundary: a source
  that becomes private **after** the bytes were sent cannot be unsent — this is disclosed as the provider
  retention boundary, not claimed as prevention.
- No cross-account, private/quarantined, other-project or service-total data is ever sent or published.

## 5. Outcome / admission table

| D situation | Advisory | Shared paid admission | Reasoning | Extractive |
|---|---|---|---|---|
| `not_dispatched` BEFORE mark | none | hold released by CAS (`releaseUndispatched`) | allowed on its own state | yes |
| after-mark adapter `disposition:"not_dispatched"` | none | treated as UNKNOWN hold (dispatched) | denied by the existing barrier | yes |
| known valid, settled | `advisory` persisted | unchanged | allowed only if raw master + reason readiness + financial caps + background/per-goal are CURRENT | yes |
| known malformed | `unavailable` (charge retained) | unchanged | allowed on its OWN state, never an automatic fallback choice | yes |
| attempted unknown usage | none (hold retained) | global `usage_pending` | denied by the existing barrier | yes |
| partial known (tenant settle fails) | none | existing shared safety block / fail-stop (S1) | blocked per S1 | yes |
| D skipped (no consent/goal/readiness or cap) | none (static reason) | unchanged; a baseline R may run | existing background flow decides; explicit consent OFF cancels background, not overridden | yes |

A settled D never refunds. An unknown D never becomes a new reasoning gate; it only triggers the S1 shared
monetary barrier.

## 6. Persisted attempt record and idempotency (concrete)

New internal **tenant** operational table, tenant migration **version 5** (max is 4 today,
`packages/storage/index.ts:108`; add `CREATE TABLE IF NOT EXISTS advisory_attempts(...)` +
`INSERT OR IGNORE INTO migrations VALUES(5,…)`; the existing forward-only guard stays). It is NOT in
`portableState()`; old tenant money tables (`reservations`, `provider_dispatches`) are untouched.

```ts
type AdvisoryAttemptState = "claimed" | "published" | "unavailable";
interface AdvisoryAttemptRow {
  idempotency_key: string;   // PRIMARY KEY
  job_id: string; dispatch_key: "decision";
  project_id: string; goal_id: string; goal_entity_version: number;
  source_refs_json: string; // bounded source ids/versions/hashes for purge; no bodies
  request_hash: string; config_hash: string; question_hash: string;
  owner: string; fence: number;                 // bound to the actual tenant job lease
  state: AdvisoryAttemptState; advisory_id: string | null;
  claimed_at: string; updated_at: string;       // no source body, no amount
}
```

`idempotency_key = hash(account implicit, goal_id, goal entity version, plan_version,
ordered(source_id, version, body_hash), policy_version, question_hash)`.

Claim protocol: in a short tenant TX bound to the actual job id/owner/fence (no model I/O in the TX),
`INSERT … ON CONFLICT(idempotency_key) DO NOTHING`; `changes===1` claims BEFORE the central reserve.
Any existing row is never reclaimed or resent even if no financial row exists: the conservative outcome
is an unavailable attempt, with **no claimed charge or financial hold if none exists**, never a fabricated
executed output. A pre-mark `reserved` slot
may be released by the explicit CAS exactly as S1; a `marked`/`settled` slot is never resent.

Recovery: after auth re-validates the current source/goal, verify the financial slot
using the ORIGINAL `job_id` via `receiptForSlot`, compare its request/config identity,
and require known settlement before loading the referenced `advisory_id` from the
tenant entity store. The slot reader returns a financial record, not an advisory.
Never use legacy `hasUnresolved(jobId)` (which intentionally reports true for a
settled job and must stay byte-identical). A `claimed` attempt whose
central row is settled but has no result becomes `unavailable` (no fake output). The private coordinator
attempt map is never adopted across restarts.

## 7. Advisory record shape and lifecycle

New internal entity kind **`advisory`** (not a `receipt` subtype): it avoids the acceptance-receipt
semantics (`service.ts:1252`, `:3036`) and the `dreams` daily view (`vault.ts:237-263`). Closed lists to
extend explicitly: invalidate (`:672`), purge (`:913`), import enum (`:2792`), vault mapping
(`vault.ts:210`), plus Today/status/search/rebuild/reader exclusions. Only a minimal service-internal
owner reader exposes it; there is no new public API, and status omits it so it never leaks into primary
retrieval, claims or handoff readers.

```ts
interface AdvisoryRecord {                 // entities.data (kind:"advisory")
  goal_id: string; goal_entity_version: number; plan_version: number;
  question_hash: string;                   // binds the full canonical question
  sources: { source_id: string; source_version: number; body_hash: string }[];
  policy_version: string;
  epistemic_status: "hypothesis";
  judgment: null | { // null for unavailable/imported records; never invent an answer
    choice: "related" | "unrelated" | "abstain";
    confidence_raw: number;                // uncalibrated, never a threshold
    probabilities: Record<"related" | "unrelated" | "abstain", number>;
  };
  status: "advisory" | "withdrawn" | "unavailable";
  decision_source: "prepared-decision";
}
```

The `question_hash` binds the FULL canonical question including option phrasing, the versioned body
hashes and the goal entity+plan versions; no raw body, prompt, model reasoning or monetary content is
stored. A persisted choice is `hypothesis`, never a fact. Money rows stay immutable and non-content.

Withdraw, source move/private transition, goal disable, background pause or either
consent withdrawal makes dependent advisory records `withdrawn`; reads recheck
current authorization before returning even a cached record. Import validates the
closed shape, derives `status:"unavailable"` with `judgment:null`, and never
imports an attempt claim or grants permission to execute. Portable vault/rebuild
uses a dedicated `observations` folder, excluded from dreams and primary context.

Deleting a goal/source purges every `advisory` version and its `advisory_attempts` mapping (content refs
removed; a non-content tombstone may remain). A deleted source id is gone; a re-captured source gets new
ids/versions and a different `question_hash`, so an explicit new capture is allowed without resending old
paid work. Supported restore reapplies deletion barriers and disables both paid
profiles; unmanaged backups and already transmitted provider copies remain outside
application erasure. The new kind is the selected approach, not a runtime subtype option.

## 8. Test ownership and matrix (real SQLite; injected transports; no real key/price)

Own (executor) tests: `managed-decision-advisory.test.ts` (domain question/hash/bounds; attempt claim CAS;
advisory lifecycle) and `managed-decision-advisory-worker.test.ts` (direct `Worker` two-stage D→R on one
review job; real `ManagedWorker` PROCESS with two disposable accounts provisioned before audit; unknown-D
barrier leaves B extractive working). Parent owns all `*-review`/e2e/browser files.

Cases: known D settle→advisory→independent R; before-mark CAS release vs after-mark `not_dispatched`
unknown; unknown usage global barrier; known malformed → `unavailable` + charge; source-to-private /
goal-edit / consent-revoke during I/O discards output with charge; account switch and storage failure;
crash-after-settle recover vs tombstone; duplicate key no-resend across jobs; migration 4→5 forward-safe
with money untouched; S1 profile/readiness compatibility checked BEFORE S2 enablement.

## 9. Closed implementation slices (the detailed plan may order prerequisites first)

1. Tenant migration 5 + `advisory_attempts` CAS claim/recovery, and the `advisory` kind with the four
   lifecycle-list extensions and primary-read exclusion.
2. Domain advisory question/hash/bounds module (no provider import) + owner-only internal reader.
3. Explicit decision `accounting`/`provider` pair on `Worker` and the opt-in bootstrap/readiness
   (reusing the existing heartbeat), with the synthetic process and adversarial matrix above.

Billing, native clients, hosting, cross-provider fallback and any actual live/held-out evaluation remain
out of scope until separately specified and approved.
