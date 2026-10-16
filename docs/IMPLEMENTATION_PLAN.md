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
- [ ] G5: Ordinary-prose understanding/recall/correction and goal-linked preparation with live evidence.
- [ ] G6: Two named native integrations with fresh-session correction/privacy/revocation evidence.
- [ ] G7: Subscription/webhook reconciliation, allowances, cancellation and payment-independent export/deletion.
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
