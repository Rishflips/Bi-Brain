# Build state

Updated: 2026-10-07

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

