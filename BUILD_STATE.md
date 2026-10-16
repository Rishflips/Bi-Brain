# Build state

Updated: 2026-10-16

## Managed suite execution — 2026-10-16 (in progress)

The owner authorized active implementation with parent-agent orchestration/review/verification, GPT-6 Astra consultation and Ollama DeepSeek V4.1 Flash execution. The release target is now a browser-first managed personal suite with login and subscriptions plus a useful self-hosted open-source line. System 1 is a permanent capability with replaceable providers and rules-first policy, not an optional future feature or an obligatory inference on every action. This supersedes earlier local-only/deferred-managed/optional-System1 product direction; historical verification below remains historical.

Latest model-use steering: make DeepSeek the primary executor and use **GPT-6 Astra Medium only for advice**; do not continue broad/high-effort Astra review loops. Parent verification remains independent. Earlier Astra invocations below are historical, not the current effort setting.

Approved scope and trust requirements are recorded in [the release design](docs/superpowers/specs/2026-10-16-managed-suite-design.md). [The foundation plan](docs/superpowers/plans/2026-10-16-managed-foundation.md) uses Astra's recommended isolated SQLite + explicit vault/protected directory per personal account, trusted control-plane routing and tenant-bound service authorization. OIDC follows isolation; per-dispatch budget accounting precedes multi-stage paid processing. No existing local data is automatically adopted into managed accounts.

### Reproduced baseline at `5598741`

This session synced both local checkouts to the official `origin/main` checkpoint `5598741`, then created isolated implementation branch `feat/managed-suite-foundation` in the OpenCode worktree. The Desktop repository's unrelated untracked licensing memo and ignored `sites-port/` are untouched. This worktree initially had no `.env`, `data/` or `node_modules/`; no real owner data or provider key was loaded.

Commands actually run on Windows with Node **v24.19.0**, npm **11.17.0**:

- `npm ci`: 292 packages installed; audit reported zero vulnerabilities. npm warned the esbuild lifecycle script was not approved; typecheck/tests/build nevertheless worked without changing global script settings.
- `npm run typecheck`, `npm run lint`, `npm run build`: passed.
- `npm test`: **76/76**, **13 files** passed in 33.07 seconds.
- `npm run brain-eval`: **4/4 synthetic offline cases** passed.
- `npm run test:e2e -- --workers=1`: **9/9 Chromium journeys** passed in 36.3 seconds against actual API/worker/build and disposable test data. This includes the explicit-decision browser journey missing from the last checkpoint's narrow verification record. These are not live-model/native-client/human results.
- Browser-generated changes to the two tracked reference screenshots were restored; no new UI is claimed by the baseline.
- `npm view openid-client version engines dependencies --json` confirmed **6.8.8**; `npm install --save-exact openid-client@6.8.8` pins the maintained OIDC client and its resolved dependencies. Installation audit reported zero vulnerabilities. Dependency installation alone is not login verification.

### Current gates

Baseline G0, the local G1/G2 managed foundation, prepared-call accounting/recovery, central managed spending authority and Phase 1 activation safeguards are verified; see the latest checkpoint for **478 tests passed, 1 POSIX-only skip, 17 Chromium journeys and 4 offline evaluations**. Central limits, durable one-inflight admission, guarded operator reconciliation, bounded all-account history audits and restore epoch rotation are implemented locally. Production managed paid processing remains unconditionally off: Phase 2 activation requires separate approval and live-provider/operational gates remain open. System One transport is locally verified but not routed into processing. Semantic quality, native integrations, billing, live hosting and human release gates remain open. Only disposable synthetic identities were provisioned; no real external account was created, no runtime model was called, no public service was deployed and no source was pushed by this checkpoint. Open-source licensing remains an owner release decision.

### Foundation review loop and restart checkpoint

Implementation continued after a harness/server restart without discarding the saved branch. A newly attached ChatGPT account was tested by an actual **GPT-6 Astra** read-only review; the invocation worked, but the selected account is not observable and this does not prove product-runtime API credentials.

Completed local building blocks remain distinct from an operational managed release:

- Real per-account SQLite/vault/protected stores, trusted cookie/token routing, service-bound principals, suspension checks, marker/path containment and bounded pinned handles. Parent-created tests first demonstrated suspension bypass on acquired handles, vault junction substitution and redirected root ancestors, then passed after repair.
- Real Jev/Clef-shaped typed transport with no hidden retries/fallback, bounded streams/deadlines, closed option validation, model-bound versioned prices and retained known or unknown accounting. Parent regressions demonstrated stalled-body hangs, unbounded stream consumption, special-key loss and pre-dispatch cancellation races before repair. Astra additionally identified lost usage on invalid decisions, unrelated-model pricing and unread failed response bodies; the repaired focused suites were independently rerun.
- Maintained OIDC client with real signed synthetic-issuer protocol tests, PKCE/state/nonce/issuer/audience/signature checks, bounded transport and cancellation before headers and during bodies. Parent cancellation regressions failed before repair; **22/22 tests in two files** passed on independent rerun after restart.
- Durable single-use login coordinator in the control database. Astra found that capacity admission evicted valid attempts and was not atomic; DeepSeek changed it to reject new admission rather than evict live records under an immediate transaction. Parent verification is pending for that latest repair.
- Migration 4 and per-dispatch accounting primitives preserve legacy reservations and count cumulative job spend plus unresolved holds. **These primitives do not yet replace worker accounting**. Parent review found an already-reserved call could dispatch after a separate overrun block; the new regression is pending repair.
- Tenant-bound Worker and fair single-concurrency managed scheduler preserve original agent scopes and pin runtime handles across asynchronous work. Main-process configuration/shutdown and browser login wiring are still being implemented, not claimed operational.

Independent command after restart: `npm test -- tests/integration/system-one.test.ts tests/integration/system-one-review.test.ts tests/integration/managed.test.ts tests/integration/managed-review.test.ts tests/integration/spend.test.ts tests/integration/managed-worker.test.ts` passed **108/108 tests across six files**. This precedes the added spend review regression and is not a final combined green claim. The next checkpoint must run the complete settled tree, browser journeys, typecheck/lint/build and whitespace checks, preserving reference screenshots.

Known external gates remain: no live OIDC/provider/decision-model/payment verification or hosted deployment, no native client round-trip proof, no human pilot, no license grant. Login and extractive per-account behavior can be completed independently of these gates; production billing/intelligence must not be silently simulated.

Additional independent checks during integration: managed login coordinator plus managed/local binding suites passed **13/13 tests in three files** after the non-evicting admission repair and bound context-pack fix. Astra then found stale lease time sampled before SQLite's write-lock wait; a parent regression using a separate real Node/SQLite lock-holding process reproduced dispatch after expiry. Clock sampling and authoritative expiry checks moved inside the acquired transaction; the spend suites passed **17/17 tests in two files** on independent rerun. `npm audit --audit-level=high` reported zero vulnerabilities. Installed native clients were queried only for version/help: Claude Code **2.1.283**, Codex CLI **0.156.1**; this does not establish authentication, model access or a native BiBrain round trip. No global native-client configuration was changed.

### Managed browser integration review (in progress)

Real sign-in/callback/logout routes, secure cookies, public mode metadata, explicit shared local/managed startup configuration and managed worker startup/shutdown wiring have been implemented. Managed HTTP and worker entry points explicitly prohibit paid model dispatch until central accounting exists. The managed first-use screen uses the real sign-in link, not local pairing. Operator instructions are in `docs/MANAGED_RUN.md`.

Parent independently ran `npm test` (**239/239, 26 files**), `npm run typecheck`, `npm run lint`, `npm run build`, and `npm run brain-eval` (**4/4 offline synthetic cases**) successfully. A first combined browser run collided with another browser run's artifacts/server lifecycle and failed; it is not counted green. After making the parent the sole browser runner, all **9 existing local Chromium journeys passed**. The new managed two-account sign-in/capture/logout/relogin journey separately passed **1/1** using the real HTTP app and signed disposable synthetic issuer. Its synthetic HTTPS interception replaces redirect chains with documented hop pages: it is not a real TLS or native browser redirect-chain proof; HTTP integration tests assert the real 302/303 responses.

Astra's integration review found two real UI defects: account changes left private inspectors visible, including late responses reopening them; failed runtime discovery could enter the workspace without known mode or fall back to local pairing. Parent browser regressions reproduced the already-open inspector leak, delayed-response leak and authenticated-unknown-mode failure before repair. Comprehensive account-state invalidation and explicit runtime-unavailable/retry behavior are now being repaired; do not mark the sign-in/UI gate complete until those tests and a settled combined suite pass. An additional parent regression reproduced malformed issuer URLs accepted by shared startup configuration (the worker does not instantiate the stricter OIDC adapter); the configuration repair awaits parent rerun.

### Resumed verification and executor-first handoff

Parent verified the issuer repair with `npm test -- tests/integration/runtime-config.test.ts tests/integration/runtime-config-review.test.ts`: **11/11, two files**. Ledger, real two-process contention and configuration regressions passed together: **20/20, four files**. The executor added real server/worker entry-point tests for capture → separate-worker extractive brief → forced restart persistence, isolated managed storage and invalid-config startup refusal; these use loopback HTTP with a synthetic Host, not TLS or live identity. Windows forced termination does not prove graceful signal handling.

After the account-state repairs, parent ran `npm run typecheck`, `npm run lint`, `npm run build` and the full browser command `npm run test:e2e -- --workers=1 --output=test-results/settled-parent`: **14/14 Chromium journeys passed**, including four independent UI regressions and the two-account signed synthetic-issuer journey. Generated reference screenshots were restored; `git diff --check` passed (line-ending warnings only).

A concurrent full-test/typecheck/lint/build run exceeded 180 seconds with test failures and is **not** counted green. DeepSeek subsequently reproduced **30/30** tests in the flagged files and **245/245 across 29 files** with `npx vitest run --maxWorkers=2` under settled conditions. No failure was reproduced and no production/test-timeout change was made; external CPU contention is consistent with the evidence, not conclusively established as the sole cause. Parent's final full-suite rerun must be serial with other heavy verification. A narrow deferred-folder/account-switch edge is being checked independently before the final browser checkpoint. The next paid-call worker integration is being planned by DeepSeek; it is not implemented or enabled by this checkpoint.

### Foundation checkpoint — independently verified

Parent reran plain `npm test` **serially**: **245/245 tests passed across 29 files in 71.37 seconds**. This includes the actual managed server/worker entry-point and restart tests, configuration repair, lease-lock regression and true process-contention tests; no timeout or test-runner configuration was changed.

DeepSeek proved one additional account-switch bug RED→GREEN: folder enumeration suspended under account A could resume under B's credentials before the nested preview function captured its generation. The traversal now captures its generation before awaiting directory/file callbacks and checks it before preview. A new browser regression verifies that A's file body is never posted into B's preview. Parent's first combined run then exposed a test teardown race (polling against an already-closed injected server); closing the test browser context before its server fixed the fixture lifecycle. Parent reran `npm run test:e2e -- --workers=1 --output=test-results/final-foundation-parent`: **15/15 Chromium journeys passed**. The 245-test full suite precedes this test-only teardown adjustment. These results establish the foundation checkpoint, not subsequent prepared-call task revisions.

Foundation status: isolated accounts, bound shared-service access, synthetic-issuer OIDC login/logout, account-safe browser first use, extractive managed worker processing and forced-restart persistence are verified locally. The worker/provider implementation gate is now the [prepared-call dispatch plan](docs/superpowers/plans/2026-10-16-worker-dispatch-integration.md). Parent reviewed and corrected the plan before handing **Task 1 only** to DeepSeek; the existing worker/provider remains active until a separately verified contract switch. Managed paid processing remains explicitly denied. No commit, push, deployment, live identity/model/payment request or license decision occurred.

### Prepared-call Task 1 — independent review in progress

DeepSeek added `packages/providers/prepared.ts` and its 17-test suite without switching the worker. It snapshots requests/configuration, returns separate accounting/output results and prevents duplicate execution. Executor-reported focused tests/typecheck/lint are not final parent approval. Parent independently added `tests/integration/prepared-provider-review.test.ts` and reproduced lost legacy evidence checks: supported claims without evidence, empty or unevidenced goal proposals and invalid references on abstentions were accepted while their known accounting correctly remained intact. Four regressions failed before repair. An additional generated `user_assertion` without evidence also failed independently after the first four were repaired; only explicitly labeled hypotheses may lack evidence. DeepSeek is finishing this narrow repair plus a truly ignored-signal late-response test. Task 2 has **not** been handed off; no prepared adapter is used by production jobs yet.

### Prepared-call Task 1 accepted; worker switch in progress

Parent reran `npm test -- tests/integration/prepared-provider.test.ts tests/integration/prepared-provider-review.test.ts`: **23/23 tests passed, two files** after the evidence repairs. The independent suite also verifies immutable credential/price/model/evidence snapshots across caller mutation. DeepSeek corrected the shared test-fixture mutation and added genuinely ignored-abort late-response disposal coverage. Task 1 is accepted as a locally tested adapter, not a live-provider result.

Parent handed **Task 2 only** to DeepSeek: switch worker dispatch/settlement/receipts and adapt existing fake providers atomically, keeping managed paid dispatch denied. Parent's new `tests/integration/worker-dispatch-review.test.ts` first failed **2/2** against the unswitched worker: known cost must survive cancellation without stale job/receipt publication, and unexpected post-dispatch failure must retain its hold and original accounting across retry. These are expected integration REDs pending implementation, not a completed green tree. Shared status/UI and restore barriers remain later Tasks 3/4; the worker switch must pass independent verification before either is claimed complete.

Task 2 executor switched the worker and staged deletion of the legacy provider after adapting its imports/fakes. Parent independently reran worker/dispatch/managed-worker tests: **20/20 passed**. Further actual-diff review exposed five material behavior failures, reproduced in the expanded seven-case independent worker suite: unknown-cost/ok-output published a zero-cost brief; a goal plan changed during preparation or execution still received a stale proposal stamped with its newer plan version; and legacy held/settled reservations were mislabeled as no-attempt receipts. The original cancellation/unknown-retry regressions remain green. DeepSeek is repairing these five REDs plus pre-dispatch cancellation checks before the next independent gate. The executor's earlier 281-test full run is historical and does not supersede these added failures. Tasks 3/4 are still not handed off.

### Worker switch accepted; authoritative status in progress

DeepSeek repaired all five worker review failures, added abort-before-admission/mark checks, and reported 288/288 tests in a serial full run. Parent independently ran `npm test -- tests/integration/worker-dispatch.test.ts tests/integration/worker-dispatch-review.test.ts tests/integration/brain.test.ts tests/integration/safety.test.ts tests/integration/managed-worker.test.ts`: **52/52 passed in five files**. Unknown accounting now cannot publish, goal versions are checked before dispatch and publication, known charges survive discarded results, and legacy receipts retain their real accounting state. This accepts Task 2 locally; no live provider verification is implied.

Task 3 only is now assigned to DeepSeek: use the authoritative ledger for shared status/UI, prevent preference-based re-enable of a durable block, and preserve useful explicitly labeled extractive work. Parent added two independent status regressions and observed RED before implementation: combined legacy/new costs in a frozen accounting zone were missing, and an old enabled preference ignored the durable block. Task 4 restore barrier is not yet assigned. Managed paid processing remains unavailable pending central account/service accounting.

### Shared spending accepted; recovery gate in progress

Parent independently reran status/worker and their review suites: **27/27 passed, four files**. Status now counts legacy/new settled costs and every unresolved hold, honors the frozen accounting zone, reports content-free overrun/recovery reasons, and refuses preference-based re-enablement. Effective paid consent is false under a durable block; labeled extractive work remains available. Parent reran all current browser journeys: **15/15 passed** after the worker/status switch. DeepSeek additionally wrote one spending-controls browser regression (small unknown hold, disabled consent, correct overrun explanation and actual HTTP re-enable refusal); it is not yet run by the parent and is not counted green.

Task 4 is assigned: protect SQLite restore, migration rollback copies, and reconstruction of a new operational database from an existing vault. Normal rebuild with intact accounting and ordinary fresh first use must retain their existing behavior. Recovery must persist the paid block before later replay can fail; lost accounting never implies a new free allowance. These operational entry points are still under implementation/review, not claimed safe from a successful in-memory test alone.

One narrow **GPT-6 Astra Medium** advisory invocation recommended a single authoritative control-plane ledger for all managed money, retaining tenant records as conservative dispatch journals/projections. DeepSeek is drafting that next design for human review only; there is no managed allowance implementation, activation or billing claim. The current local ledger remains authoritative for self-hosted operation.

### Final local dispatch/recovery checkpoint — 2026-10-16

Completed and independently verified locally: immutable one-shot prepared reasoning calls; per-dispatch reservation/mark/settlement with no resend of ambiguous calls; known charges retained through invalid output, cancellation and stale goals; legacy/new authoritative spend; durable blocked re-enable; and paid-recovery barriers for SQLite restore, migration rollback copies and reconstruction from an existing vault. Normal fresh first use and existing-database rebuild remain covered. Restored accounting rows are retained; empty older accounting does not grant a fresh allowance. Operator reconciliation is not implemented and there is no unsafe resume button.

Final parent commands (serial on Windows/Node 24.19.0):

| Command | Actual result |
| --- | --- |
| `npm test` | **303/303 passed, 36 files**, 149.42 seconds |
| `npm run typecheck` | passed |
| `npm run lint` | passed |
| `npm run build` | passed, 18 modules |
| `npm run brain-eval` | **4/4 synthetic offline cases** |
| `npm run test:e2e -- --workers=1 --output=test-results/final-dispatch-parent` | **16/16 Chromium journeys** |
| `npm audit --audit-level=high` | zero vulnerabilities |
| `git diff --check`, `git diff --cached --check` | passed; unstaged check reports line-ending warnings only |

Two final failures were not hidden: the spending browser regression exposed that valid $0.001 caps hit native `stepMismatch` and could not save unrelated preferences; both USD inputs now support integer-micro-USD precision. A subsequent **serial** full run timed out one real-Git deletion test at 5103 ms against its inherited 5000 ms deadline. Only that test received the same bounded 20-second allowance as neighboring Git-heavy tests; all assertions and production code were unchanged. The executor repeated it three times (~4.9 seconds each), all 13 vault tests passed, and the parent's complete final 303-test run passed. No global timeout increase was made.

The 16 browser journeys cover the nine original local journeys, signed synthetic-issuer managed login/isolation/logout/relogin, account-switch/open/late/folder privacy regressions, runtime-unavailable retry, and real blocked-spending display/save/HTTP refusal. Synthetic-origin interception is not native redirect-chain, hosted TLS, live identity or model evidence. Process tests prove real server/worker forced-restart persistence, not Windows graceful signal handling. Reference screenshots are restored; no commit/push/deployment occurred. The old provider deletion is staged, with the rest of the implementation still uncommitted on `feat/managed-suite-foundation`.

Next architectural gate: review the draft [managed spending authority design](docs/superpowers/specs/2026-10-16-managed-spending-design.md). It recommends central money authority with default-zero account/service allowances, conservative tenant journals and explicit crash/rollover/revocation tests. It is **not approved or implemented**. Billing, System One policy/quality, ordinary-prose quality, two native-client proofs, hosted operations and human/license/privacy release gates remain separate.

### Managed money authority — approved, implementation started

The owner approved the next design explicitly: **"approved, go ahead ship it!"**. This supersedes the pending-review status in the preceding checkpoint, not its verification results or release limits. The [managed spending plan](docs/superpowers/plans/2026-10-16-managed-spending.md) is being executed by DeepSeek, with parent review and no new Astra invocation required.

Parent review corrected material plan hazards before execution: pre-existing dispatch markers must never grant resend permission after a crash; all providers/stages share one service cap; identity and admission constraints remain immutable; status must never claim availability while the production worker denies it; and control-plane restore must not resurrect revoked session/token access. Task 1 only is assigned: pure central monetary types, control-database policy/reservation primitives and real multi-account/process contention tests. Existing worker/runtime/tenant-ledger behavior is not switched in this task. Default-zero allowances, no live calls, no push/deployment and no managed-paid activation remain explicit constraints.

Managed-money Task 1 executor delivered the pure domain types, `ManagedSpendingStore` and tests in four new files. Parent independently ran the initial store and true-contention suites: **19/19 passed, two files**. Parent then added `tests/integration/managed-spending-review.test.ts` and reproduced **five failures in six cases**: zero service policy did not deny a zero-bound reservation/mark, and date-only, zone-less or locale allowance timestamps were accepted. The global overrun block correctly denied a previously reserved call from a different account. DeepSeek is repairing the default-deny and explicit-ISO-zone checks before Task 2 is assigned; no worker or runtime has switched to central accounting yet.

After repair, parent independently reran the central store, review and real-contention suites: **29/29 passed, three files**. Admission and mark now explicitly require all four policy dimensions positive, including zero-cost estimates; allowance instants require explicit ISO time zones and canonical UTC storage. Task 1 is accepted locally. **Task 2 only** is now assigned to DeepSeek: account-bound coordination, worker accounting injection, central-authoritative receipts (including projection failure) and crash/no-resend/history-eligibility tests. Status/activation, operator CLI and control-plane recovery remain later tasks. Production paid activation remains off.

Managed-money Task 2 executor delivered the internal accounting seam, account-bound coordinator, managed worker injection and central receipt lookup. Parent independently reran coordinator/worker-review/managed-worker tests: **28/28 passed**. Parent then reproduced **3/3 failures** in `managed-accounting-review.test.ts`: eligibility inspected only the current job, allowing older unknown legacy/new tenant history on another job to be ignored; and a failed central settlement with successful tenant actual-cost persistence did not stop further service admission. DeepSeek is repairing account-wide eligibility plus durable service-wide settlement-failure reconciliation blocking, with a read-only central lookup extension already accepted and a narrowly authorized failure-marker extension. No Task 3/4 or activation handoff has occurred.

Parent independently verified the initial Task 2 repairs with **34/34 tests in four files**. A fourth fault-injection regression then reproduced a remaining failure when both central settlement and its global safety-marker write fail: after writes recover, a new store on the same control handle could admit more spend. A narrow **Astra Medium advice-only** consultation recommended a non-clearing shared-control-handle process latch and fail-stop managed scheduling, not a new transaction framework. DeepSeek is implementing that containment and propagating the fatal condition past ordinary job-error handling; capture must remain usable. This process-local protection must not be described as durable or multi-process recovery. Production paid activation remains unconditionally off pending enforceable restart reconciliation/control-storage failure gates. Task 3 is still not assigned.

Parent reran coordinator, independent review and managed-worker suites after fail-stop containment: **31/31 passed, three files**. Task 2 is accepted locally with its explicit process-local/restart limitation; the executor additionally reported a serial 356-test full run. Task 3 is now assigned: central-authoritative account money views, runtime/status injection, a trusted operator policy CLI and honest default-off activation metadata. An independent test-only executor owns `managed-money-view-review.test.ts` to exercise real two-account services/HTTP, stale-projection immunity, suspension, and omission of global service financial details. Parent owns its eventual verification. Task 4 control backup/restore is not assigned. No managed paid processing is enabled.

Task 3 parent initially verified **14/14 tests**, including four independent real two-account HTTP/service cases. Extended review caught one display error: positive configured service policy was reported as available capacity even when its cap was exhausted; that repair was executor-verified but not yet parent-rerun. User-lowered cap/remaining values already passed independent coverage. Parent also reproduced **2/2 failures** in `managed-policy-review.test.ts`: CLI accepted an unrelated existing directory and initialized a control plane, and silently accepted extra arguments while changing policy. DeepSeek is repairing trusted-root preflight and exact argument counts before Task 3 acceptance. A new independent browser journey is being written without running it; parent remains the only browser runner. Task 4 is not started.

Parent reran the complete Task 3 focused set after both repairs: **18/18 tests in four files passed**. Task 3 is accepted locally: account-specific central financial status, lower user caps, capacity-versus-configuration distinction, financial privacy, strict operator CLI targeting/arity and real-process default-off restart checks. Task 4 is assigned for a scoped **offline** managed snapshot/recovery path: matching control/tenant/vault inventory, financial barriers and restored-credential invalidation before later replay, current deletion replay and incomplete-root refusal. Existing local backup/restore stays separate. The parent has not yet run a managed-spending browser journey or final combined verification; the 372-test executor run predates the last CLI repairs.

Parent ran the new managed-spending Chromium journey: **1/1 passed**, proving central $0.005 actual versus stale tenant $0.010 and another account's $0.020 hold, truthful disabled processing, real fractional-cap persistence, a reconciliation explanation and capture during pause. These use synthetic-origin interception/opaque synthetic-account sessions, not hosted TLS or live identity/model calls. `npm audit --audit-level=high` reported zero vulnerabilities.

A narrow independent DeepSeek read-only review identified a material missing post-mark guard; parent separately reproduced consent disabled during marker acquisition still causing provider execution. The repaired final pre-I/O consent/source/goal/abort/cap check passed the parent's worker/worker-review/accounting-review run: **29/29**. Marked holds are deliberately retained on refusal; no retry/resend or refund is inferred. A review suggestion to add account policy to public runtime metadata was rejected: per-account `spend.configured` plus public default-off reason is the corrected privacy-safe contract.

Task 4 initially passed parent **9/9** barrier/recovery tests, but actual code review plus `managed-recovery-review.test.ts` reproduced **5/5 failures**: missing current tenant storage silently skipped deletion reconciliation, destination-ancestor and tenant-directory junctions were followed, ordinary quarantine files ending `-wal` were dropped, and manifest inventory could omit accounts still present in its hashed control DB. DeepSeek is repairing these boundaries and adding actual CLI, failed-replay/incomplete-root and retained-history evidence. These five regressions are not yet green; recovery is not accepted and no final combined green claim is made.

### Central managed money checkpoint — independently verified

The approved [managed spending plan](docs/superpowers/plans/2026-10-16-managed-spending.md) is implemented locally. DeepSeek executed the slice; parent review reproduced and verified the repairs above. A narrow Astra Medium consultation was advice-only. No background implementer remains active.

Delivered:

- One control-database monetary authority with default-zero account/service policy, immutable UTC allowance windows, one shared service UTC-day cap, cumulative-job/user-day limits and carried unresolved holds. Real two-account/process admission and expiry-under-lock are covered.
- Account-bound worker coordination, fresh-mark-only dispatch, account-wide legacy/history eligibility, central-first known settlement, authoritative receipts despite stale/failed tenant projections, durable reconciliation blocks and a process-local fatal-write fuse. A final post-mark check prevents dispatch after consent/source/goal/abort/cap changes observed while markers were acquired.
- Own-account central money views with lower user caps and no shared-service financial totals, truthful hard-off processing metadata and strict trusted operator policy tooling.
- Cold/offline managed backup and new-root restore, matching control/tenant/vault/quarantine inventory and hashes, current deletion replay, credential invalidation, preserved financial obligations and refusal to open incomplete restores. All five recovery review regressions are green. Parent additionally verified deletion absence from export, decoded `git log --all -p`, retained source files and reachable/unreachable Git history via `verifyForget`.

Final parent commands, run serially on Windows/Node 24.19.0 against the settled implementation:

| Command | Actual result |
| --- | --- |
| `npm test -- --maxWorkers=1` | **396/396 passed, 49 files**, 136.20 seconds |
| `npm run typecheck` | passed |
| `npm run lint` | passed |
| `npm run build` | passed, 18 modules |
| `npm run brain-eval` | **4/4 synthetic offline cases** |
| `npm run test:e2e -- --workers=1 --output=test-results/final-managed-money-parent` | **17/17 Chromium journeys**, 59.8 seconds |
| `npm audit --audit-level=high` | zero vulnerabilities |
| `git diff --check`, `git diff --cached --check` | passed; unstaged check reports line-ending warnings only |

The parent restored only the two reference screenshots regenerated by its browser run; their pre-run state matched HEAD, and `git diff --quiet -- docs/screenshots/first-use.png docs/screenshots/source-preview.png` confirms they match again. Documentation-only checkpoint updates follow the test/build commands; staged/unstaged whitespace checks passed afterward.

Limits remain explicit: managed paid dispatch is **off even with positive policies and `BRAIN_MANAGED_ALLOW_PAID=1`**. The shared-control-handle fuse is in-memory, not durable or cross-process; activation requires enforceable reconciliation/restart/control-storage failure checks. Offline backup assumes the operator stopped writers, hashes provide integrity rather than authentication, and deletion replay covers only the supplied current root. No automatic reconciliation/resume is supplied. Synthetic identity/browser interception is not live OIDC, native redirect-chain, DNS or TLS evidence. Billing, System One policy/quality, semantic quality, native clients, target-host graceful shutdown, hosted operations, human usability and licensing remain separate gates. Changes remain uncommitted/unpushed on `feat/managed-suite-foundation`; no paid call, public deployment or license change occurred.

### Next slice authorized — activation design and repository checkpoint

The owner said **"go ahead"** to the proposed next sequence: commit the verified
checkpoint, then close durable reconciliation, cross-process and restart/storage
failure safeguards before managed paid activation. This authorizes a local Git
checkpoint, not a push, deployment or paid provider call. DeepSeek is drafting
`docs/superpowers/specs/2026-10-16-managed-activation-design.md`; the new
architecture must receive human review before implementation. Current processing
remains off. The design draft is separate from the verified implementation
checkpoint and is not being included in that checkpoint commit.

Repository checkpoint created: **`07c93e6`**, `feat(managed): checkpoint isolated
accounts and spending controls` (104 files). It includes the locally verified
implementation and earlier foundation work, not the next activation design.
Fresh pre-commit typecheck/lint and staged whitespace checks passed. A staged
common-token/private-key pattern check flagged only the intentional invalid
`SYNTHETIC-TEST-ONLY` private-key fixture; the narrowly scoped rerun passed. This
is not a full secret-history audit. Nothing was pushed. `git status` immediately
after the commit showed only the new activation design draft as untracked.

DeepSeek drafted the [managed activation design](docs/superpowers/specs/2026-10-16-managed-activation-design.md),
then parent review narrowed unsafe marked-call refunds, clarified operator attestation
versus provider verification, and separated ordinary one-shot settlement from offline
operator reconciliation. Recommended next architecture: a durable service-wide
one-inflight barrier over the existing committed dispatch marker. An unknown call
pauses all managed paid admission across processes/restarts, while capture and
extractive work continue. This throughput/recovery tradeoff **awaits human approval**.
No implementation plan or production/test change has started. The draft explicitly
does not prove full rollback detection, provider authenticity or actual worker
quiescence; supported restore invalidation and acknowledged offline procedures are
distinct from those guarantees. Phase 1 would keep production paid processing off.

The owner subsequently **approved** the written activation architecture. Phase 1
is authorized: durable one-inflight admission, guarded operator-attested
reconciliation and bounded all-account history audits, with synthetic
cross-process/restart drills. DeepSeek is writing the concrete plan before code
changes. Phase 2 activation, paid calls, public deployment and pushing remain
unauthorized. The earlier draft/pending-review wording is historical.

Parent added `tests/integration/managed-ambiguity-review.test.ts` before
implementation and observed **4/4 RED** against the current ledger. The cases
exercise cross-account/stage admission and pre-existing reservations, unknown
usage across UTC days without a new marker write, normal known-settlement
release of the barrier, and a fresh control connection after restart. These are
expected missing-feature failures, not a green checkpoint. DeepSeek's plan is
still being drafted; no production code has changed for this slice.

The [activation implementation plan](docs/superpowers/plans/2026-10-16-managed-activation.md)
has been written and parent-reviewed. **Task 1 only** is assigned: durable
admission barrier, private pause status and true multi-process mark competition.
Parent expanded the independent suite to **6/6 observed RED**, adding a real
managed worker whose own marker must not revoke its consent and a two-account
private-status/capture case. Plan review also tightened atomic proof-plus-money
writes, epoch binding, explicit USD, offline acknowledgement and all-account audit
persistence before those later tasks are handed off. Task 2/3 code is not yet
authorized to the executor; production paid availability remains hard-off.

Task 1 executor delivered the durable barrier and cross-process/restart-focused
tests without changing the money schema. Parent independently reran the two
review files: **11/12 passed**, including all six new barrier/worker/privacy
cases. Parent tightened one historical service-availability assertion to reflect
the newly approved global pause: an account with headroom is not service-available
while another account has a dispatched unknown. That case reproduced RED; the
executor is removing a durable-block-only workaround rather than preserving the
old expectation. Actual stored consent still remains distinct from admission,
so a valid self-marked call must continue to execute once and settle normally.

Parent reran the settled Task 1 focused set independently: **39/39 tests in six
files passed**, including the two-child-process mark race and normal worker
settlement. Task 1 is accepted locally. **Task 2 only** is now assigned: immutable
operator attestations, atomic resolution-plus-money writes and explicit root/epoch
binding. The parent is updating its browser regression to require the new global
pause while preserving exact own-account money assertions. CLI/history audits
and restore epoch rotation remain Task 3, not yet assigned. Production paid
processing remains off.

The parent ran the updated managed-spending browser journey for Task 1:
**1/1 passed**. Another account's unknown usage now produces the global pause
without contaminating this owner's central amounts, allowance or fractional-cap
preferences; saving remains available. This is the focused synthetic-origin
browser proof, not final combined verification of the activation slice.

Task 2 executor delivered schema 2, immutable resolution records, strict offline
options, guarded settlement transactions and explicit root/epoch binding. Parent
independently ran **36/36 tests in four files**. Its new
`managed-reconciliation-review.test.ts` then reproduced **3 failures in 5 cases**:
free-form multiline actor text and blank request correlation were accepted, and
an ignored settlement UPDATE could still produce a committed resolution proof.
Overrun-plus-proof rollback and replacement of the marker by a junction already
passed. An initial parent directory-rename fixture hit Windows EPERM and was
corrected to the supported marker-junction case; it is not counted as a code bug.
DeepSeek is repairing those three findings. The executor did not record the
original Task 2 pre-implementation RED; parent did not authorize skipping it.
The newly reproduced behavior REDs are recorded separately, without inventing
earlier evidence. Task 3 remains unassigned.

After the Task 2 repairs, parent independently ran reconciliation, its review,
epoch, core spend and ambiguity review suites: **68 passed, 1 POSIX-only check
skipped on Windows, six files**. The parent reconciliation review now has six
passing cases, including refusal of an unrelated directory without a control DB.
Task 2 is accepted locally. A fresh DeepSeek executor owns **Task 3 only**:
strict offline CLI, persisted all-account history audits and supported restore
epoch rotation. A separate read-only DeepSeek review of Task 2 is pending; no
further Astra/model advice was requested.

Parent added `managed-reconcile-cli-review.test.ts` before Task 3 completion;
the first run observed **2 failed / 2 passed**. Positive read-only status and
valid exact-call settlement commands currently fail; negative-command results
are not counted as security proof until the CLI actually works. These review
tests remain parent-owned. Final combined tests/browser/evaluations have not yet
run for this activation slice, and production paid processing remains off.

Task 3 initial parent verification passed **24/24 tests in five files**, including
real CLI positive/negative cases and matched new paid rows beyond an old audit
baseline. Parent then expanded `managed-audit-review.test.ts` and reproduced
**4 failures in 5 cases**: service policy and future schema changes did not stale
an audit, provisioning-marker subject mismatch was ignored, and changing a
baseline central identity hash was missed. A separate read-only DeepSeek review
confirmed the config recheck gap and identified a manifest/marker mismatch;
parent reproduced it in `managed-epoch-restore-review.test.ts` (**1/1 RED**).
The executor is repairing these five findings, bounded row materialization and
the final control-transaction freshness recheck. Task 3 is not yet accepted;
production paid processing remains off. The Task 2 read-only review reported no
additional material findings; this is static review, not extra execution proof.

The parent also added a deterministic final-lock interleaving: a second real
SQLite connection lowers an account policy after both audit scans but before
the audit write transaction acquires its lock. The audit incorrectly committed
its stale snapshot (**1 RED in the now-six-case audit review suite**; the other
five cases passed after in-progress repairs). The executor is closing that final
transactional recheck before Task 3 acceptance. No final combined verification
has been started on this moving tree.

The final-lock race and original audit binding checks passed on a subsequent
parent rerun. One additional amount-invariant check then reproduced a failure:
SQLite can retain matching fractional `7.5` values in both nonnegative INTEGER
columns, and a fresh audit accepted them. The executor is adding explicit
safe-integer monetary validation before hashing or approving matched history.
This is a new observed behavior RED, not evidence of a live charge or user-data
corruption; the fixtures are synthetic.

### Activation safeguards Phase 1 — independently verified, 2026-10-16

All three tasks in the [approved activation plan](docs/superpowers/plans/2026-10-16-managed-activation.md)
are accepted locally. DeepSeek executed; parent review reproduced and verified
the repairs above. Task 3's final independent focused run passed **31/31 tests
in six files**, including all six audit review cases and the restore-marker
regression. All implementers stopped before the final serial run.

Delivered:

- A committed dispatched row is a durable global one-inflight barrier, checked
  inside reservation/mark transactions across accounts, stages, days and process
  restarts. No later marker write is needed to preserve an unknown-use pause.
  Reserved-only holds are distinct; ordinary known settlement unblocks the next
  admission. A call's own marker does not revoke its stored consent.
- Operator-attested resolutions require exact identity, currency, epoch and
  prior-state binding plus explicit offline/worker-termination acknowledgements.
  Immutable proof, known cost and any overrun/dispute block commit atomically.
  Ignored SQLite updates cannot fabricate proof. A dispatched unknown is never
  refunded; conflicting known amounts retain the original actual and add a dispute.
- `managed:reconcile` provides read-only status/inspection/validation and guarded
  offline mutation commands. All-account audits include suspended accounts and
  use bounded read-only tenant access. They reject legacy, unmapped, orphan,
  nonterminal, mismatched and invalid-money rows; recheck current control
  money/config/blocks after acquiring the write lock; and detect stale schema,
  config, identity and baseline bindings without rejecting legitimate new mapped
  terminal rows. Only ids, financial metadata and hashes are retained.
- Supported restore rotates an existing control epoch and root marker before
  publish, invalidating previous audits while preserving financial blocks and
  credential invalidation. Manifest declaration and actual marker presence must
  agree. Genuine older marker-less snapshots remain supported and blocked.

Final parent commands, serial on Windows/Node 24.19.0:

| Command | Actual result |
| --- | --- |
| `npm test -- --maxWorkers=1` | **478 passed, 1 skipped, 60 files**, 129.57 seconds |
| `npm run typecheck` | passed |
| `npm run lint` | passed |
| `npm run build` | passed, 18 modules |
| `npm run brain-eval` | **4/4 synthetic offline cases** |
| `npm run test:e2e -- --workers=1 --output=test-results/final-activation-phase1-parent` | **17/17 Chromium journeys**, 59.0 seconds |
| `npm audit --audit-level=high` | zero vulnerabilities |

The skipped test checks distinct case-sensitive POSIX root paths and is not
applicable on this Windows host; no Linux execution proof is implied. Reference
screenshots regenerated by the parent browser run were restored to their known
pre-run HEAD state. Documentation-only checkpoint updates follow the test/build
commands. `git diff --check` and `git diff --cached --check` passed afterward
(line-ending warnings only); `git diff --quiet` confirms both screenshots match
HEAD. A Node scan of all **34 changed/new text files** found no trailing
whitespace or common long-token/private-key patterns. This pattern check is not
a complete secret or Git-history audit.

Limits: production paid processing remains **hard-off**, including configured
policies and `BRAIN_MANAGED_ALLOW_PAID=1`. There is no automatic block clearing or
dispatched-call refund. Offline acknowledgements are operator preconditions, not
proof that paused workers cannot resume. Attestations are externally checked by
the trusted operator, not cryptographically provider-verified. Root epochs do not
detect simultaneous rollback of both DB and marker; backup hashes provide
integrity, not authenticity. Fault-injection/process tests are not physical
disk-full, power-loss or hosted-operation drills. Live identity/provider quality,
System One policy, native clients, billing, TLS, human usability and licensing
remain separate gates. Phase 2 activation is not implemented or authorized.

This slice remains uncommitted on `feat/managed-suite-foundation`, after the local
checkpoints `07c93e6` and `00611f3`. Nothing was pushed or deployed; no paid
provider call, real external account creation or license change occurred.

### Repository delivery authorized — push and pull request

The owner explicitly requested **"Push and create a Pull Request"** after Phase 1
verification. The delivery target is `Rishflips/Bi-Brain`, branch
`feat/managed-suite-foundation` against `main`; the repository remains private.
GitHub account `Rishflips` has repository and workflow push permission. Fetch
confirmed `origin/main` is still the implementation fork point `5598741`; no
upstream changes require a merge or rebase, and no existing open PR for this
branch or repository PR template was found.

Fresh pre-commit command: `npm test -- --maxWorkers=1` — **478 passed,
1 POSIX-only skip, 60 files**, 133.04 seconds. The earlier settled Phase 1
typecheck/lint/build, 17 Chromium journeys, 4 offline evaluations and zero-audit
checkpoint still applies; only documentation changed afterward. The PR includes
the earlier isolated-account/OIDC/central-money checkpoint as well as Phase 1,
not just the last safety changes. This authorizes source delivery, not merging,
production activation or deployment. Production paid processing remains off.

## Independent deployment and ship audit — 2026-10-07

The owner canceled ChatGPT Sites hosting. This supersedes the Sites migration plan below: no more Site publications, D1/R2 port or hybrid hosting work. The separate `sites-port/` probe checkout is preserved and ignored by parent Git/lint/Docker. On 2026-10-07 the owner explicitly requested and confirmed permanent deletion of the existing Bi Brain Site (`appgprj_6abc0b1d098c8191a74d673cec5862bc`). Deletion is verified: the owner Sites list shows “No sites yet,” `get_site` returns “Sites project not found,” and the former publication URL returns “404 Not found / No site here.” No new Site deployment occurred. Before deletion, `get_site` reported no linked automations. Local application data and official GitHub source are intact. Historical Sites evidence below is not the current deployment plan.

The full app now has a single-owner HTTPS deployment profile: one validated public origin, exact Host/Origin checks, Secure owner cookies, HSTS, unchanged shared grant authorization, and a local stdio adapter that can call trusted HTTPS without following redirects. Docker includes required Git/CA certificates, a private allowlisted build context, nonroot execution and liveness. The supervisor awaits child shutdown; persistent-volume HTTPS Compose/Caddy and a pinned-action Linux CI template are added. SDK/source-map advisory fixes are locked; final npm audit reports zero vulnerabilities. Owner data, permissions, licensing and monetization are unchanged.

| Ship gate | Status | Evidence / remaining limit |
| --- | --- | --- |
| HTTPS configuration/auth/grants | Verified locally | Four new deployment regressions: capture/auth/sign-out, Host/Origin/CSRF denial, private filtering/revocation, invalid setup and adapter URLs. This is transport-contract injection, not a deployed TLS server. |
| Existing suite/truth/deletion | Verified locally | 65/65 tests in 12 files, typecheck/lint/build, 4/4 offline evals, 8/8 real API/worker Chromium journeys. Paid calls: zero. Temporary Git permissions required approved outside-sandbox tests/eval/browser execution. |
| Container/fresh Linux packaging | CI template delivered; installation pending | The supplied workflow template builds the image, requires Git history, owner auth, worker output, capture/session persistence after restart and SQLite backup, validates Compose/Caddy. Docker is absent locally. |
| Operator handoff | Delivered | [SELF_HOSTING](docs/SELF_HOSTING.md), [ship audit](docs/SHIP_AUDIT_2026-10-07.md), [deployment-agent prompt](prompts/DEPLOY_OWN_SERVER.md). Database-only backup is distinguished from full Git/quarantine recovery. |
| Live self-hosted release | Open | Owner supplies one always-on persistent host/domain. Prove trusted TLS, reboot persistence, private ports, restore/deletion barriers and actual native clients before owner data. Nothing deployed by this checkpoint. |
| Full harness/local V1 | Open | Prior S1–S7 live model, native two-client, semantic/calibration, crash/disk-full and human gates remain open. Passing packaging does not close them. |

Checks actually run: `npm run typecheck`, `npm run lint`, `npm test` (65/65), `npm run build`, `npm run brain-eval` (4/4 synthetic offline), `npm run test:e2e -- --workers=1` (8/8), `npm audit --audit-level=high` (zero vulnerabilities), `git diff --check`. Browser-generated screenshots were restored; no product UI change is included. Initial sandbox Git-write/DNS failures and the caught empty pairing-code fallback are documented in the audit. GitHub rejected Actions workflow creation because the saved credential lacks workflow scope. The pipeline is preserved as deploy/github-verify.yml for the operator to install; no CI run or Docker result is claimed. The application checkpoint is pushed separately from workflow installation.

Application/deployment checkpoint **`ad35584`** was committed and pushed to official `origin/main` on 2026-10-07 using the existing command-scoped Rishflips credential. This is a repository delivery, not a live-host release. The unrelated licensing memo remains untracked and unchanged. No app data, credential files, private backup or nested Site checkout is tracked in this checkpoint.

## Sites production handoff — 2026-09-30

P0 is verified in the local edition. Approved agent intentions now retain source lineage; permanent forgetting sanitizes their copied text in current goals and collapsed goal revisions while preserving later owner edits. Evidence-backed plans still clear when their evidence is forgotten. The managed proof now checks retained derived text and Git-history text as well as source IDs. A regression covers propose → approve → update → owner edit → forget → export → rebuild → restart and retained vault history. This is a local managed-store proof; previously transmitted copies and unmanaged backups remain outside its scope.

P0 checks actually run: `npm run typecheck` passed; `npm run lint` passed; `npm test` passed **61/61 in 11 files**; `npm run build` passed; `npm run brain-eval` passed **4/4 synthetic offline cases**; `npm run test:e2e -- --workers=1` passed **8/8 Chromium journeys**. The full test and browser runs needed the approved outside-sandbox execution because this Windows sandbox returned `ENOMEM` from Node `os.userInfo()` before `tsx` started; this was reproduced with a direct Node call. A final test-only assertion was added after those full runs and passed in the focused vault test.

P0 checkpoint `d8ca193` was pushed to the official `origin/main` after selecting the existing Rishflips Git Credential Manager account for that command. The local license memo and owner data remain untouched.

P1 has a separate portable Sites checkout at `sites-port/` and a registered owner-private Site, `appgprj_6abc0b1d098c8191a74d673cec5862bc`. Its current isolated source commit `11b5fc8f1193de7daf1883accf1a7eab43f0ffd0` was pushed to the Site source repository; private deployment `appgdep_6abcd7eb30d0819198fa80b179978da4` succeeded with environment revision 2 at `https://bi-brain-private-gowrishankar.saasage-in.chatgpt.site`. This publication is explicitly a **runtime compatibility probe**, not a migrated Bi Brain suite or a V1 production release. It has a synthetic-only D1/R2 round-trip UI and one read-only HTTP MCP probe tool; no owner knowledge was uploaded.

| P1 capability | Actual evidence | Gate |
| --- | --- | --- |
| Owner-private audience | `get_site` reports a custom allowlist with only `saasage.in@gmail.com`; signed-in `gowrishkar@gmail.com` received platform 403. A fresh Saasage login reached the app, and the app-level owner check now admits only the trusted dispatch email configured as `BI_BRAIN_OWNER_EMAIL`. | Owner login and different-account platform denial verified. App-level denial after the email fix is code-checked but was not re-run with a second signed-in session. |
| D1 | Production `read_database_overview` lists `DB` and `capability_probe`. The owner browser created synthetic record `6c689103-23a0-4536-8076-e8bf083fd6b9`; `read_database_table_rows` returned the matching owner, object key, checksum and timestamp. | Hosted D1 write/read verified. |
| R2 | The owner browser showed matching D1 and R2 readback for the same synthetic record, then repeated the read successfully after a page reload. The route checks the R2 object SHA-256 against the D1 checksum. | Hosted private object put/get and reload readback verified for a small synthetic payload. |
| HTTP MCP | Private deployment reports `has_mcp: true`; `get_site` returned the Site-provisioned MCP URL and plugin ID. The Bi Brain plugin installation was suggested again after owner login. | Native connected-client discovery/call remains unverified. Published tool is only a scoped probe, not the suite's eight tools. |
| Unattended work | Sites 0.1.75 instructions describe linked schedules, but the callable inventory still has no `create_schedule` action and `get_site` omits the linked automations list. | Supported unattended caller and fresh writer receipt remain unproven. Do not claim background operation. |

The first Saasage browser session was admitted by the platform but denied by the app's user-ID equality check; the request's user ID was not measured. The app now checks the dispatch-provided owner email, behind the platform's owner-only allowlist; this passed the live owner session. Keep the Site owner-private. P1 is **partially proved**, not passed: native MCP use and unattended execution remain open. Under the handoff's P1 exit rule, P2–P6 remain open. The local Git-backed vault remains the reference for literal `git revert`; hosted revision semantics are undecided. The owner confirmed on 2026-09-30 that no always-on server with persistent disk and HTTPS is available for a hybrid backend, so literal hosted Git history and unattended jobs have no verified deployment path. Do not import owner data into the probe or widen access to work around this gate.

## Build review F1–F5 repairs — 2026-09-29

All five findings in `docs/BUILD_REVIEW_2026-09-29.md` are repaired in the local application. This supersedes the older 55-test/5-browser evidence below. No owner knowledge was migrated or deleted, and agent grant/project checks remain in the shared service.

| Finding | Verified behavior | Remaining limit |
| --- | --- | --- |
| F1 unsupported auto-commit | Auto-admission now requires an entire exact structured `entity status/count/deadline value` assertion. Negation, quotations, wrong entity, substring matches and other prose queue with raw retained. Numeric confidence is `0` (unrated), not a fabricated calibrated score. | No evaluated semantic entailment or calibrated classifier. Owner review remains necessary for natural language. |
| F2 stale issued packs | Pack hashes bind visible claim IDs/versions/validity, identity revisions, open-intent state, source versions and deleted-source state. Validation after retirement, conflicting acceptance, intent closure or validity change fails before continued use. | Native client pre-action enforcement remains unverified; the tested local wrapper enforces this contract. |
| F3 validity | Default current pages, search, answers and packs use accepted claims only while `valid_from <= now < valid_to`. Invalid intervals are rejected, queued review preserves the proposed interval, and explicit historical search labels out-of-window claims as history. | Validity describes accepted source assertions, not independent real-world verification. |
| F4 agent intents | Typed agent propose/update/close requests retain target and expected version. Owner approval creates a preparation-enabled goal or atomically updates/closes the targeted goal; stale versions fail. Private/quarantined proposals cannot become shared intentions. The GUI offers intention approval and a deterministic test checks scheduler admission. | A prepared next step still needs relevant evidence and, for live reasoning, configured provider credentials. |
| F5 capture/import | Ordinary save and folder import queue source-linked candidates for exact status lines. An owner can select an exact passage from arbitrary prose and propose a status claim from the existing source. Review produces current pages, search/answer results and authorized agent packs. | Automatic candidate extraction is intentionally narrow; arbitrary prose needs the owner's passage selection. Other claim aspects do not yet have this direct GUI form. |

Final checks actually run: `npm run typecheck` passed; `npm run lint` passed; `npm test` passed **60/60 in 11 files**; `npm run build` passed; `npm run brain-eval` passed **4/4 synthetic offline cases** and wrote `data/brain-eval-results.json`; `npm run test:e2e` passed **8/8 Chromium journeys** against the production build, including capture-to-current-truth, owner-selected prose promotion and intention approval. After a final private-intent guard, all 60 tests and build/eval passed again and the intention browser journey passed 1/1. The first expanded browser run hit the global local-UI polling limit; its guard was raised from 300 to 1000 requests/minute while the separate pairing limit remains 10/minute, then the full suite passed. A validity-pack test initially crossed the pack's 20-minute expiry and was corrected to test the boundary within that expiry; a Git vault test received a 20-second Windows allowance. These are local deterministic/browser results, not live-provider, native two-client, fresh-machine or human-pilot evidence. No deployment or new push is claimed for these repairs.

## Owner-directed harness build (SOL6_HARNESS_AND_SUITE_BUILD)

This section supersedes the older M0–M6 status below for the new suite/harness request. The older table records the prior local preview and is historical evidence, not proof that the new harness is complete. Current work is **not a completed harness V1**. The harness implementation commit `d2f3acb` was pushed to official `origin/main` on 2026-09-29; no hosted deployment has been made.

| Gate | Current status | Evidence and limit |
| --- | --- | --- |
| S0 Baseline/design | Verified | Existing `npm test` passed 29/29; three review regressions remained fixed. [Harness authority ADR](docs/HARNESS_AUTHORITY_ADR.md) inventories gaps, authority, threat boundary, eight-tool contract and dependency order. |
| S1 Vault/evidence/deletion | Core verified locally; full gate open | Portable filesystem generations, immutable raw versions, protected quarantine, bounded scanner, journal recovery, managed local Git, writer lock, backup/migration/rebuild/rollback, tombstones and resumable managed-history purge. Tests cover capture/rebuild, injected publish failure, migration/rollback, secret fixtures, interrupted purge and restore barrier. Exhaustive crash points, disk-full and every credential format are unverified. |
| S2 Claim ledger/gate | First slice verified; gate open | Typed claims, validity, literal offline admission, idempotent propose, queue for identity/decision/conflict, owner review, retirement and current-first retrieval pass integration/eval checks. Confidence is a deterministic syntax score, **not calibrated**. Semantic conflict/multi-source quality remain open. |
| S3 Suite workspaces | Browser verified; human gate open | Your brain displays real claims, evidence, history and review; Connections previews project handoff/import. Hash navigation, local project/theme persistence and deletion-proof UI are implemented. Browser 5/5 passed on the current production build, including keyboard/responsive checks. Human first-use and broader accessibility review remain open. |
| S4 Eight tools/binding/handoff | SDK/local wrapper verified; native gate open | Exactly eight MCP tools are grant-filtered; SDK/HTTP test covers read-only discovery, direct write denial, full grant, correction and revocation. Bounded local wrapper demonstrates pack-only use and pre-action revocation. Project handoff and explicit identity-field disclosure are stored and previewed. No two-native-client or enforced client session adapter evidence; MCP remains cooperative/manual. |
| S5 Dream reasoning/intent/revert | Local behavior verified; live gate open | Opt-in structured Responses goal preparation is wired into the budgeted worker with source validation, owner-activity cancellation before dispatch/publication, receipt metadata and daily vault Markdown. Fake-provider race, restart-safe one-ping-per-local-day, due/review timing, and guarded latest-commit `git revert` pass tests. Offline extractive fallback is labeled. No live key/pricing/quality evidence; non-head conflict resolution and richer intent semantics remain open. |
| S6 Forget proof/evals | Managed scope verified; full gate open | Purge replaces managed pre-migration backup, sanitizes managed Git history and returns/persists an operation ID plus read-after-delete file/index/embedding/edge checks. Interrupted purge can be finalized. `npm run brain-eval` passed 4/4 versioned offline fixtures and writes `data/brain-eval-results.json`. Unmanaged backups/transmitted copies and broader live/native adversarial coverage remain open. |
| S7 Folder/chat adapters/packaging | Local adapters verified; pilot open | Connections previews/imports selected or dropped text/Markdown folders and JSON conversation arrays through bounded path/size parser and checkpoint; browser chat journey passes. CLI skips symlinks and unsupported attachments with warnings. No installed-folder watcher, clean-machine or human pilot evidence. |

Current combined verification: `npm run typecheck` and `npm run lint` passed; `npm test` passed 55/55 in ten files; `npm run build` passed; `npm run brain-eval` passed 4/4 offline fixtures; `npm run test:e2e` passed 5/5 against the current production build. A sandboxed test run failed because Node's `os.userInfo()` was denied with `ENOMEM`; the same suite passed outside the sandbox, where a standalone `os.userInfo()` diagnostic also succeeded. Focused vault tests passed 12/12 before the combined run. This is local synthetic/offline verification, not a real model, native two-client, clean-machine or human result.

The tracked screenshots in `docs/screenshots/` were regenerated by browser tests and restored before saving this change. The harness implementation is saved in Git and pushed to the official repository; no hosted deployment has been made.

## Current reality

Working single-owner local preview: React/Vite GUI, Fastify API, persistent Node 24 SQLite, separate durable worker, and official-SDK stdio MCP adapter. Real user capture is retained before derivation. No provider key is required for labeled extractive previews. Today, Your brain, Connections, and Save something are implemented.

This is the local V1 implementation with explicit verification gaps, not a fully verified Local V1 release or a public hosted service. No pricing page or commercial billing was implemented. The owner's screenshot of the older pricing page cannot be traced without its URL; no deployment or pricing update is claimed.

## Milestones

| ID | Deliverable | Status | Evidence / remaining gate |
|---|---|---|---|
| M0 | Runnable foundation | Verified locally | Exact lockfile, offline npm ci, migrations, health, auth/session, build/typecheck/lint; Git initialized with official origin; lockfile and implementation saved in local Git commit |
| M1 | Persistent capture and Continue | Verified locally | Arbitrary text/file capture, evidence, edited understanding, clipboard, Markdown download, restart persistence, error retention; isolated labeled demo |
| M2 | Knowledge lifecycle | Verified locally | Source versions, correction/stale context, scoped full-text search, withdrawal/purge including accepted plans/history, portable preview/import/export, conflicts and deduplication |
| M3 | Durable reasoning | Deterministic gates passed; live gate unverified | Leases, recovery, cancellation/fencing, atomic reservations, accounting, schema/reference checks; real Responses adapter requires legitimate key and operator-verified prices |
| M4 | Goal preparation and review | Verified extractive workflow | Opt-in, relevant-evidence hypothesis, edit/accept/compensating undo, later-edit conflict comparison, snooze/dismiss/history, pause/quiet hours/DST/catch-up; no live contradiction-quality claim |
| M5 | Agent access | SDK transport verified; native gate unverified | Five tools over real stdio/HTTP, fresh SDK sessions, scoped remember/recall/correction/private denial/revocation; SDK 1.30.1. Native Codex and second client not run |
| M6 | Local operations | Local checks passed; external gates unverified | Supervised production processes, migration integrity, actual CLI backup/restore/tombstones/revoked restored credentials, browser/keyboard/responsive checks. Docker/fresh machine and human pilot not run |
| H1 | Managed private beta | Deferred | Hosted identity, connectors, billing, license and public launch are outside this local delivery |

## Evidence — 2026-09-28

Actual commands run:

- `npm ci --offline --cache .npm-cache`: installed from pinned lockfile; audit reported zero vulnerabilities. Same-host reinstall, not a fresh-machine claim.
- `npm run typecheck`, `npm run lint`, `npm run build`: passed. Production assets are served by the API.
- `npm test`: 26 tests passed in five files. Includes real database/HTTP, supervisor restart, official SDK stdio, source deletion during provider work, authorization, concurrent budget admission, exact Unicode evidence, prompt-injection boundaries, schedule behavior, imported reviewed knowledge, and actual backup/restore CLI.
- `npm run test:e2e`: four Chromium browser journeys passed: persistence/evidence/correction/purge/download; chosen-goal preparation/acceptance/later-edit-safe undo comparison; keyboard/Escape/focus/dark mode and widths 320/360/768/1280; input error retention/text-file capture/clipboard/full-text search.
- `npm run db:migrate`: migration versions 1–3 recorded, integrity check `ok`.
- `git ls-remote https://github.com/Rishflips/Bi-Brain.git`: successful with no refs returned. Local `main` initialized and origin set. Local implementation commit created and pushed to official origin/main on 2026-09-28; no hosted deployment.

Test fixtures and browser screenshots contain synthetic test content, clearly described in docs/screenshots/README.md. They are not historical owner data or live-model evidence. Tests use isolated databases under ignored data/ directories. Production owner data lives in data/brain.sqlite; pairing code lives in data/owner-secret and is never included here.

Material verification repairs: scoped a duplicate browser text locator; fixed controlled goal opt-in, Unicode evidence and canonical export hashing; protected accepted plan/history from retained deleted evidence; preserved user corrections through rebuild; prevented ambiguous paid retry and fixed over-bound accounting disable; separated polling preferences from unsaved edits. Early sandbox-only tsx/Node user-info and process-run failures were resolved by approved execution; no simulated passing results substituted.

## Remaining gates and limits

- No OpenAI key or verified provider pricing supplied: no paid call, live smoke/evaluation, real-provider outage/timeout drill, or inferred-reasoning quality claim. Unknown usage stays reserved; unsafe output is rejected.
- Installed Codex CLI reports 0.158.0-alpha.2.1, but native fresh-session verification was not performed. Claude Code was not available. SDK sessions do not replace the two-native-client gate. No global client settings were changed.
- Docker is unavailable; container files are provided but unverified. Fresh-machine install, disk-full drill, and human first-use pilot remain unverified.
- Extractive preparation uses lexical relevance and requires two passages; it offers a review hypothesis, not a detected contradiction. Portable imports are conservative recovery, not divergent-history merging. Storage is local and unencrypted.
- No hosted deployment, account integration, billing, external action, license decision, or public release.

## Next action

Run `npm start` and open http://127.0.0.1:4317. Pair with the local data/owner-secret file, save arbitrary content, and connect a selected project using the instructions in docs/LOCAL_RUN.md. Finish native-client and live-provider gates when their legitimate prerequisites are available, then run a human pilot before declaring Local V1 release complete.


## Push attempt — 2026-09-28

Owner authorized pushing to the official repository. git push -u origin main failed with HTTP 403: GitHub authenticated as saasagelabs, which lacks write permission to Rishflips/Bi-Brain. Implementation remains committed locally at 30dd7d6. Authenticate an account with repository write access, then retry; no remote content was changed.


## Push completed — 2026-09-28

Pushed main successfully to https://github.com/Rishflips/Bi-Brain using the existing Rishflips Git Credential Manager account. The default GitHub CLI helper had selected saasagelabs; command-local helper and username overrides resolved this without changing global account configuration. Implementation 30dd7d6 and prior failure record 3695247 are on origin/main. This publishes repository code, not a hosted application or pricing page.


## Verification review repairs — 2026-09-28

Read docs/VERIFICATION_REVIEW_2026-09-28.md and repaired its three confirmed defects:

- Permanent purge follows evidence references across all projects and retained derived revisions. Goal history is inspected across projects. Move → accept → purge → export regression verifies the deleted marker is absent from export and retained entity versions.
- Invalidation checks cited source state, project and version. Unrelated capture retains actionable ready and snoozed proposals; correction, move and withdrawal still invalidate affected evidence.
- Daily admission deduplicates pending jobs by goal ID rather than project, allowing both eligible goals in one project to complete without duplicate daily admission. Existing per-job budget reservation remains in force.

Commands: npm run typecheck, npm run lint, npm test (29 tests, five files), npm run build passed. npm run test:e2e: four browser journeys passed after adding an explicit wait for the asynchronous deletion dialog to close. The first run failed only at the search-entry timing assertion; no application result was replaced with simulated success. Three new behavioral regressions cover the exact reported failure sequences.

Scope clarification: provider credentials enable model-backed briefs only. Goal preparation is still the labeled extractive hypothesis template; genuine model-backed goal review is unfinished implementation, not merely a missing live credential. The review's product scope gap remains open, in addition to live-provider, native-client, clean-install, disk-full and human-pilot gates. No trusted public-release claim is made.

## Current verified checkpoint — explicit context corrections (session44)

On branch `ant/session44-context-conflicts`, based on `3e1d7f0`, the existing owner review gate now supports a narrow offline explicit-decision correction loop. Save and approve `Beta pricing: free`, then save `Beta pricing: paid`: full old/new assertion lines, source IDs/versions and exact character locations are retained in a non-applied comparison. The owner can keep the earlier decision or approve the exact replacement. Approval retires the earlier claim atomically; undo uses compensating revisions and refuses stale sources or later edits. Fresh scoped current search/answers/packs and a separately granted read-only agent retrieve only the approved value; pending corrections never become current truth. New handoffs include fixed agent instructions plus selected accepted context. The owner UI includes decision review/history and undo.

**Actual final checks:** existing isolated image `bibrain-test:3e1d7f0`, Node **v24.19.0**, `--network none`, nonroot, `HOME=/tmp`, `BRAIN_DB=/tmp/test/brain.sqlite`, only this checkout mounted at `/app`, no live data or provider keys. `npm run typecheck` and `npm run lint` exited 0. `npm test`: **13 test files passed, 76 tests passed**, including **11 context-conflict tests**. `npm run build`: **17 modules transformed; built in 257ms**. `npm run brain-eval`: **4/4 passed**, synthetic offline, report at ignored `data/brain-eval-results.json`. `git diff --check` passed. Six genuine vertical RED→GREEN observations and the reproducible isolated command are recorded in [CONTEXT_CONFLICTS.md](docs/CONTEXT_CONFLICTS.md).

Regressions exercise rejection and original retention; duplicate/ambiguous suppression; complete citations for an older typed decision; stale review versions and competing corrections; revisions, privacy, moves and withdrawal of old/new sources; safe undo; read-only approval denial; revoked/cross-project access; private pending proposals not suppressing public review; explicit active-goal opt-in scheduling; quarantine; approved-state vault rebuild/restart; managed forgetting of copied earlier passages and retained Git text. Source and claim history are preserved until managed deletion.

**Limits:** ASCII explicit-line syntax only; the full left key is a statement slot, not general semantic contradiction detection. Initial decisions require approval. Source editing does not extract a new decision; stale proposals require a fresh captured note. Existing status and arbitrary-prose passage workflows are unchanged. Capture-linked review is manual bookkeeping, not proactive preparation; background work remains opt-in to explicit active goals. This checkpoint verifies real SQLite/vault services, authenticated HTTP injection and server-rendered React; it does **not** verify browser interaction, native Claude/Codex, paid-provider reasoning, human usability, deployment or full harness release. No new dependency, permission scope, model, external fetch or background preference was introduced. No commit, push, remote change or deployment was performed. All historical checkpoints above remain historical.
