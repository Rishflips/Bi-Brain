# Implementation plan

Complete milestones in dependency order. A polished mockup is not a substitute for a persistent vertical slice. Check boxes only after attaching evidence in BUILD_STATE.md.

## M0 — Runnable foundation

- [x] Inspect project and preserve existing work.
- [x] Create npm workspaces for web, server, domain, storage, and contracts as needed.
- [x] Resolve compatible stable dependencies; commit lockfile when Git is initialized by the implementation workflow.
- [x] Add scripts: dev, build, typecheck, lint, test, test:integration, test:e2e, db:migrate.
- [x] Establish health endpoints, loopback defaults, owner pairing/session design, migrations, and structured redacted logging.
- [x] Build accessible shell with Today, Your brain, Connections, and Save something.

Gate: a clean checkout installs and starts using documented commands; production build succeeds; health and a database round trip work.

## M1 — Save → Continue

### Approved visible delivery follow-up — 2026-10-18

- [x] Read completed baseline full regression: 1,447 passed / 8 skipped / zero failed,
  132 files at b5610f4. Exact baseline Ubuntu/container CI run 39065046637 succeeded;
  this is not target-host or future UI-revision evidence.
- [x] Reconcile remote baseline: externally merged PR #4 placed equivalent baseline
  content on main at 1fe33bd5. This session performed no merge/reset/rebase; the
  upcoming UI follow-up remains subject to separate review and no merge authority.
- [x] Deliver calm inline first-note composer using real capture persistence.
- [x] Separate known durable save from follow-up read/preparation failures; show only
  returned retained content, truthful duplicate/quarantine/offline states.
- [x] Verify find/reopen after reload, failure draft retention, account-switch fencing,
  keyboard and 320px layout with independent browser checks.
- [x] Run changed-frontend typecheck/lint/build and browser regression: **41/41 Chromium
  journeys**, including source-attribution and delayed-removal/correction regressions.
- [ ] Publish reviewed feature branch and safely sync Desktop while retaining the
  owner's personal note. User authorized this after the green final gate; publication
  is proceeding, not yet verified here.
- [x] Verify the final source-frozen serial full regression using explicit filesystem
  module cache: **1,450 passed / 8 platform skips, zero failed, 132 files**, 637.12 s;
  source hashes unchanged. Whole-tree typecheck/lint/build passed separately.
- [x] Repair reproduced reasoning/decision readiness clock sampling without relaxing
  future-heartbeat/TTL rules, actual job-lease checks or monetary authority. Deterministic
  regressions and original actual-process heartbeat assertions passed in the full gate.
- [ ] Verify the exact published follow-up commit in Linux/container CI and record its
  run URL; local green and historical baseline CI are not that result.

See BUILD_STATE.md for actual commands and results. This slice improves the existing
capture/search experience; it does not newly implement those underlying services or
close managed subscriptions, live-provider, hosted operations or legal gates.

- [x] Paste text and import text/Markdown within limits.
- [x] Save original source and enqueue derivation transactionally.
- [x] Implement truthful extractive preview without provider credentials.
- [x] Source viewer, editable brief, Copy brief, Download Markdown.
- [x] Preserve entered text and saved sources after errors.
- [x] Clearly separated sample mode using fixtures.

Gate: capture → source → brief → copy/download works with real storage; restart server and recover the same content; no canned output for arbitrary input.

## M2 — Knowledge lifecycle

- [x] Project creation/move, goal capture, scoped search, page/source revisions.
- [x] Evidence references and exact quote validation.
- [x] Correction invalidation and current/stale indicators.
- [x] Withdrawal and permanent deletion across search, briefs, caches, receipts.
- [x] Portable export/import with preview, deduplication, and conflict behavior.
- [x] User edits use version checks.

Gate: a changed fact replaces current context without erasing historical provenance; deleted text cannot be recovered through active retrieval; export/import preserves expected IDs and state without credentials.

## M3 — Durable reasoning

- [x] Separate worker, queue leases, fencing, retry, cancellation, crash recovery.
- [x] Rules-first triage and adapter interfaces.
- [x] Atomic budget reservations and usage reconciliation.
- [x] One real reasoning provider with output schema and evidence checks.
- [ ] Provider outage, malformed output, timeout, and missing-credential states. (Implemented; malformed output and missing metadata tested. Real-provider outage/timeout drill unverified.)
- [ ] Model-free deterministic integration tests plus separate live smoke test. (Deterministic suite passes; live gate awaits credentials and verified prices.)

Gate: interrupted jobs recover without duplicate committed proposals; budgets cannot be overspent by concurrent admission; malformed/cross-project evidence never publishes.
If credentials are missing, finish adapter and fake-provider checks and report live verification as blocked.

## M4 — Get ahead

- [x] User-selected active goals with preparation opt-in.
- [x] New source triggers changed-assumption review for affected goals.
- [x] Today prepared item, review evidence, edit, accept, undo, dismiss, snooze.
- [x] Receipts for changed/no-change/abstained/failed outcomes.
- [x] Incremental maintenance, local-time digest, quiet hours, catch-up, pause.
- [x] UI distinguishes prepared, applied, stale, invalidated, and failed.

Gate: synthetic beta-launch scenario produces a reviewable proposal with correct evidence; user can accept and undo; no new evidence means no repeated nuisance item.

## M5 — Agent access

- [x] Scoped principals, grants, expiration, revocation.
- [x] Five-tool stdio MCP adapter through shared API policy.
- [x] Context budget and omissions.
- [x] Inspector contract tests and private/cross-project denial tests.
- [ ] Codex fresh-session remember/recall/correction/revocation evidence.
- [ ] Second supported client repeats the workflow.
- [x] Connection UI reflects real verification state.

Gate: same authorized project knowledge is available in two clients; unrelated/private data and revoked access remain unavailable. Record exact client/SDK versions. Do not replace unavailable-client evidence with a green badge.

## M6 — Local release

- [x] Production assets served by API; supervised worker and persistent storage instructions.
- [x] Docker/local installation path with pinned runtime requirements.
- [x] Backup/restore and migration recovery tested.
- [x] Browser E2E suite, keyboard flows, responsive checks, error recovery.
- [x] Owner settings, spending, worker status, export, and deletion accessible.
- [x] Clean Ubuntu CI install and container setup verification. (Merged-main run 38889855879 at `5dd6ed0`: `npm ci`, 479 tests, Docker build and non-root/container restart-persistence/auth/worker/backup smoke passed. Other target-host operations remain separate.)
- [x] Run first-use pilot or mark human usability gate unverified.
- [x] Document actual capabilities, limitations, screenshots, and license status.

Gate: complete local end-to-end flow passes; release checklist in docs/RELEASE.md has evidence. A public launch still needs a license decision.

## H1 — Managed personal suite

The 2026-10-16 owner direction brings managed personal delivery into the primary product target. Historical local milestones above are not completion of managed requirements. Follow [the approved release design](superpowers/specs/2026-10-16-managed-suite-design.md) and [foundation plan](superpowers/plans/2026-10-16-managed-foundation.md).

- [x] G0: Reproduce the current local deterministic, offline and browser baseline. (2026-10-16: 76 tests, 9 Chromium journeys, 4 offline evals, typecheck/lint/build; see BUILD_STATE.)
- [x] G1: Trusted account isolation, bound principals and request-scoped capture/retrieval with restart proof. (Locally verified 2026-10-16: real storage/HTTP/process tests and account-switch browser regressions; not hosted release.)
- [x] G2: Standards-based login/logout/recovery configuration and approachable managed first-use UI. (Locally verified against a signed disposable synthetic issuer; real identity-provider recovery/login and hosted TLS remain external release gates. See BUILD_STATE.)
- [ ] G3: Fair per-account workers and per-dispatch/job/account/service monetary reservations.
  - [x] Locally verified central default-zero monetary authority, four-dimensional admission and real cross-account/process contention.
  - [x] Account-bound worker accounting, fresh-mark-only execution, retained unknown holds and central-first known settlement with independently tested failure containment.
  - [x] Central own-account status, lower user limits, private service totals and strict trusted operator policy tooling. (Parent Task 3 focused run: 18/18.)
  - [x] Managed cold snapshot/restore and final combined browser/recovery verification. (2026-10-16 parent: 396 tests, 17 Chromium journeys, 4 offline evaluations; typecheck/lint/build/audit passed. See BUILD_STATE for offline/recovery limits.)
  - [x] Durable one-inflight barrier, guarded operator reconciliation, bounded all-account history audits and restore epoch invalidation. (Phase 1 parent checkpoint: 478 passed, 1 POSIX-only skip; 17 Chromium journeys and 4 offline evaluations. See BUILD_STATE for test/trust limits.)
  - [ ] Approved shared activation path plus live-provider/quality and target-host storage/restart drills. Activation is implemented default-off; no real account/provider is enabled.
    - [x] Phase 2 approval and local profile/persistence/operator/recovery foundation. (Parent: 520 passed, 1 POSIX-only skip in 64 files; typecheck/lint/build passed. SQL/mirror mismatch denies; restore disables at a new epoch. Synthetic fixtures only.)
    - [x] Exact current-slot send guards and independent synthetic verification. (Task 2 parent checkpoint: 545 passed, 1 POSIX-only skip, 66 files; typecheck/lint/build passed.)
    - [x] Shared server/worker activation, readiness and revocable consent with real-process synthetic verification. (Final parent: 579 passed, 2 POSIX-only skips, 70 files; 19 Chromium journeys; 4 offline evaluations; typecheck/lint/build/audit passed. Long-call heartbeat, CLI disable and unknown-usage worker restart/no-resend covered.)
    - [ ] Separately authorized capped live-provider quality/cost smoke and target-host storage/operations drills.
- [ ] G4: Real System 1 adapter, tested policy integration, consent, failure fallback and held-out quality/cost evidence.
  - [x] Immutable one-shot prepared-decision contract with synthetic transport and independent accounting/cancellation review. (2026-10-17 parent: 645 passed, 2 POSIX-only skips, 72 files; 19 Chromium journeys; 4 offline evaluations; typecheck/lint/build/audit passed. No worker consumer or managed decision activation; see BUILD_STATE and the [prepared-call plan](superpowers/plans/2026-10-17-system-one-prepared-call.md).)
  - [x] S1 Task 1: schema-4 default-off decision profile, audited enrollment, atomic global stop and supported recovery. (2026-10-17 parent: 728 passed, 2 POSIX-only skips, 78 files; 19 Chromium journeys; 4 offline evaluations; typecheck/lint/build/audit passed. Frozen-v3 hold preservation, migration rollback and corruption-safe stop verified; no decision dispatcher. See the [stage-accounting plan](superpowers/plans/2026-10-17-system-one-stage-accounting.md) and BUILD_STATE.)
  - [x] S1 Task 2: separate decision readiness, closed live-hash/stage guards, raw consent and account-bound coordinator lifecycle. (2026-10-17 parent: 819 passed, 2 POSIX-only skips, 87 files; 19 Chromium journeys; 4 offline evaluations; typecheck/lint/build/audit passed. Same-job prepared decision→reasoning accounting, cumulative caps and unknown-use preservation verified synthetically; no production decision dispatcher.)
  - [x] S1 Task 3 / final local acceptance: separate raw/effective consent, account-safe HTTP/status and Settings control. (2026-10-17 parent settled repeat: 829 passed, 2 POSIX-only skips, 88 files; 24 Chromium journeys, including five independent decision-consent checks; 4 offline evaluations; typecheck/lint/build/audit passed. No production decision worker or live-provider result. See BUILD_STATE.)
  - [x] S2 written-design review: [advisory worker design](superpowers/specs/2026-10-17-system-one-advisory-worker-design.md), approved by the owner's "go ahead, proceed". Local implementation/synthetic verification accepted below; no live/hosted result is implied.
  - [x] S2 bounded question, durable advisory lifecycle and explicit worker integration, with task-by-task parent verification.
    - [x] Task 1 pure bounded question/record contract: parent 116/116 focused checks, including 40/40 question checks; typecheck/lint/build passed after validator, immutability and rounded-probability repairs. No runtime consumer or full S2 acceptance.
    - [x] Task 2 tenant-v5 attempt/advisory persistence and privacy/portable lifecycle: parent settled 948 passed / 2 existing POSIX-only skips, 94 files; 24 Chromium journeys; 4 offline evaluations; typecheck/lint/build/audit passed. No production decision consumer or live model result.
    - [x] Task 3 explicit worker coordinator pair/bootstrap and synthetic process verification: final parent 984 passed / 2 existing POSIX-only skips, 98 files, 720.54 s; 24 Chromium journeys; 4 offline evaluations; typecheck/lint/build/audit passed. Five actual-main process cases include restart/no-resend, long-call heartbeats, unpaid account continuity and independent stage bootstraps. Strict fixture cleanup passed without warning. See BUILD_STATE for retained-charge/source/privacy repairs and limits.
  - [ ] Explicitly authorized real held-out decision/reasoning quality, compatibility and total-cost evidence. S1 accounting/consent/activation and S2 advisory worker are locally accepted; synthetic fixtures do not complete G4.
- [ ] G5: Ordinary-prose understanding/recall/correction and goal-linked preparation with live evidence.
- [ ] G6: Two named native integrations with fresh-session correction/privacy/revocation evidence.
- [ ] G7: Subscription/webhook reconciliation, allowances, cancellation and payment-independent export/deletion.
  - [x] Owner selected Paddle Billing for an India-based individual/sole proprietor, monthly+annual plans and monthly no-rollover allowance without automatic overages. No customer price or allowance amount selected.
  - [x] B0 renewal-safe financial-authority written design approved by the owner's "okay go ahead"; no implementation/live proof implied.
  - [ ] B0 implementation plan, pure contracts/calendar, sealed storage/migration, guarded admission and recovery, with independent gates.
    - [x] Task 1 pure calendar/window/reference/seal contracts: parent 162/162 focused checks across 5 files, including 99 B0 checks; typecheck/lint/build passed. No storage consumer, schema migration, key enrollment or payment enabled.
    - [ ] Task 2 exact storage-plan review, frozen-v4 preservation, schema/key/log and immutable grant projections.
      - [x] T2K standalone protected key helper: lost-key replacement regression repaired; covered in final 321-pass / 6-platform-skip parent gate. No production caller, actual key enrollment or Windows ACL assurance.
      - [x] T2L complete-frame journal schema/read-only verification and frozen-v4 fixture: failed COMMIT, head corruption and future-version digest regressions verified. No global migration applied.
      - [x] T2P closed frozen operator-policy/catalog contract: both cadences share monthly caps, zero caps deny selection, sandbox/live binding and canonical policy digest verified.
      - [x] T2W standalone private writer/paid-evidence persistence: parent **430 passed / 6 platform skips, 20 files**, including 384 B0 and 46 existing financial checks; typecheck/lint/build passed. Both actual-process races passed. Default-null source, no app consumer, synthetic sealed admission fixtures only; real admission and money-5 remain below. See BUILD_STATE.
      - [ ] Owned clean-baseline admission/generation, full storage contract and money-5 migration with genuine frozen-v4 preservation proof. [Integration plan](superpowers/plans/2026-10-18-billing-admission-integration.md) is draft pending parent review, not migration authorization.
    - [ ] Task 3 financial admission/freshness and reserve/mark/audit integration.
    - [ ] Task 4 offline enrollment, key backup/restore and actual-process synthetic verification, followed by full parent regression gates.
  - [ ] Separate B1 Paddle integration design approval, implementation and actual Sandbox proof. B1 remains a draft; no live checkout/payment enabled.
- [ ] G8: Supported packaging, hosted TLS/operations/recovery and human usability/license/privacy/security release gates.

Keep each checkbox synchronized with actual evidence in BUILD_STATE.md. Finish independent implementation when a live credential or external service blocks its narrow gate; never substitute synthetic evidence for a live result.

No request to create accounts, spend money, or publish is implied by this build pack.

## First implementation session

Prioritize M0 and M1. Once verified, continue the next unblocked milestone under the user's build request. Update state at coherent checkpoints and after context compaction. Do not repeatedly redesign the product or stop solely because one milestone passed.




## Review follow-up — 2026-09-28

Cross-project purge, dependency-based suggestion invalidation, and per-goal daily scheduling are repaired with regressions. M4 remains an extractive workflow; model-backed goal reasoning is unfinished product work and is not completed by configuring the brief provider. See BUILD_STATE.md and VERIFICATION_REVIEW_2026-09-28.md.

## Current checkpoint — explicit decision correction slice (session44)

- [x] Existing capture/review/claim/pack services carry a source-cited explicit decision comparison from save through owner rejection or approval, immutable history, guarded undo and fresh scoped agent retrieval.
- [x] Regression checks cover stale/private/moved/withdrawn evidence, version conflicts, duplicate suppression, read-only/revoked/cross-project grants, opted-in scheduling and vault rebuild/restart/managed forgetting.
- [x] Typecheck/lint/build, 76/76 tests (13 files), 4/4 synthetic offline evals and diff whitespace check passed in the existing isolated Node 24 image.
- [ ] Browser interaction and native Claude/Codex verification for this slice. No deployment or live-provider claim.

This does not close the broader historical M4 semantic-reasoning, native-client or full-harness gates. See [CONTEXT_CONFLICTS](CONTEXT_CONFLICTS.md) and the appended current BUILD_STATE checkpoint for exact syntax, recorded RED→GREEN evidence and limitations.
