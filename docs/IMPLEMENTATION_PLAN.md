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
- [ ] Clean-machine/reproducible setup verification. (Offline lockfile reinstall passed on this host; fresh machine and container unverified.)
- [x] Run first-use pilot or mark human usability gate unverified.
- [x] Document actual capabilities, limitations, screenshots, and license status.

Gate: complete local end-to-end flow passes; release checklist in docs/RELEASE.md has evidence. A public launch still needs a license decision.

## H1 — Managed private beta, later

Identity, tenant isolation, managed connector OAuth, hosted scheduler, metering, billing, support, deletion/retention operations, monitoring, and restore drills. Select hosting and identity providers after local workflow validation.

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
