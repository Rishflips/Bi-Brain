# Build state

Updated: 2026-10-19

## Active delivery — consumer interface foundation

Work is in progress on `codex/memory-quality-agent-proof`, currently based on
commit `b27a4a8`. This checkpoint applies the approved
black, gold, ivory and white BiBrain identity to the real application rather
than adopting the separate prototype's fixture adapter or replacing the mature
service architecture.

Implemented in the working tree:

- The active logo and wordmark are transparent inline SVG geometry shared by
  `BrandLockup` and `BrainEmblem`; the former raster web copies were removed.
  The right-side first-use cognitive field no longer repeats the emblem.
- Inter was removed from the root typography stack. The interface now ships the
  self-hosted Manrope variable font, with platform fallbacks and no font CDN.
- First use, Today, Your brain, Connections, Settings and dialogs share the new
  design tokens, surfaces, focus treatment and responsive shell. The state-driven
  living field remains derived only from real saved-work, queue, freshness,
  worker and preparation state.
- First use now stands on its own without the signed-in application rail. After
  pairing, the real product shell appears with icon-supported Today, Your brain
  and Connections navigation. This follows the delivered prototype's information
  hierarchy without copying its browser-only controller.
- Local pairing explains that each custom/preview data folder has its own
  `owner-secret`; no secret is exposed in markup, a URL, a log, fixture data or
  a screenshot. Optional AI preparation is described truthfully as off until
  the owner enables it.
- Stable integration hooks now identify first use, primary navigation, capture,
  saved receipts, search, prepared review, source viewer, connections and
  permission preview without changing their behavior.
- A visual 320px review found an onboarding overflow and an inherited full-height
  mobile rail. Both were repaired; a permanent browser regression now checks the
  official first-use content, pairing help and absence of horizontal overflow.
- The tracked synthetic product screenshots were regenerated from real browser
  journeys using the production build. No owner knowledge is included.

Checks actually run on this working tree: `npm run typecheck`, `npm run lint`,
and `npm run build` passed after the vector-brand/font refinement; the focused
320px production-browser regression passed **1/1**, asserting an accessible SVG
wordmark, no raster images in first use, no hero emblem and no Inter family. The
main real-product browser journeys then passed **8/8**, including capture,
evidence, review, agent retrieval, imports, correction, deletion, reload,
keyboard and responsive layouts. The tracked synthetic product screenshots were
regenerated from that production run and visually inspected. The
earlier complete build produced `index-BJfUWT-l.css` and `index-Drwa1yY4.js`.
The runtime first-use contract passed **10/10** outside the
Windows temp-directory sandbox. The final complete browser suite passed
**45/45** against the rebuilt production bundle, including the new standalone
first-use boundary at 320px, real capture/reload, source lifecycle, managed
account isolation and honest runtime-discovery failure. A desktop first-use
capture was also inspected locally after the final layout change.

The supplied `BiBrain-HANDOFF_1.md`, standalone prototype HTML and complete ZIP
source were reviewed as design documentation, not proof of backend behavior.
The exact first-use, Today, Your brain, Connections and Settings compositions,
responsive screenshots, component states and token layer were compared with the
real app. The standalone first-use hierarchy, trust language, compact icon
navigation, responsive boundaries and official crop treatment were adopted.
The fixture controller was deliberately not transplanted: its permissive pairing,
browser-only saves, fake timers, synthetic connections, fake preparation and
prototype billing remain design-only. Those surfaces continue to use the real
HTTP, application-service, SQLite, authorization and evidence paths already in
this repository.

This remains a local UI delivery. It does not close live-provider quality/cost,
native two-client, Paddle Sandbox, target-host, legal/trademark, human-pilot or
public-release gates.

## Current merged baseline — PR #6

The owner merged [PR #6](https://github.com/Rishflips/Bi-Brain/pull/6), **Ship
the living BiBrain release candidate**, on 2026-10-19 local time. GitHub `main`
and the Desktop `main` branch now match merge commit
`7cc5bf2f656b282d5261069eccec707f4fd0ebc0`. The merge contains the living
first-use/Today interface, B0 operator lifecycle, and default-off B1 Paddle
boundary described below.

The corrected PR head was `a9c8523f40966b227734949f8ff053fbefdca0fa`.
Its predecessor CI run correctly rejected a managed heading copy regression; the
unchanged regression passed 10/10 after repair. The corrected GitHub workflow
[39172307962](https://github.com/Rishflips/Bi-Brain/actions/runs/39172307962)
completed successfully in 9m32s. It passed install, high-severity audit,
typecheck, lint, the full Vitest suite, production build, offline evaluation,
all Chromium journeys, Docker build, container restart/persistence smoke, Compose
validation, and Caddy validation. This is exact corrected-head Linux/container
evidence; it is not target-host, live-provider, or real-payment proof.

This documentation refresh starts from the clean merged tree on branch
`codex/bibrain-docs-refresh`. The untracked personal licensing note and concurrent
`design/logo-concepts/` work remain outside Git and untouched. The private GitHub
repository About description now reads: “A user-owned second brain that keeps
memory, context, and continuity across AI agents.” No homepage or public release
was created.

## Current delivery — living first-use and Today interface

The first-use and Today surfaces now meet the approved product framing visibly,
not only in copy or backend capability. The local entry screen opens with a
responsive cognitive field, a clear central-memory promise and one protected
pairing action. After pairing, Today uses a state-driven neural field whose label,
message and motion still derive only from real saved-work, job, worker, freshness
and review state. The primary capture surface is visually prominent without adding
invented activity, sample history or an endless suggestion feed. Today, Your brain
and Connections remain the primary navigation, and all existing actions keep their
real behavior.

This is a presentation layer over the already verified persistence, authorization,
evidence, recovery and default-off billing boundaries. It adds no provider call,
payment, account, external message or destructive connected-service action. Motion
uses transform/opacity and is disabled for reduced-motion preferences; a keyboard
skip link and the existing semantic controls remain available.

Fresh verification on this visual follow-up:

- `npm run typecheck`, `npm run lint`, `npm run build`: passed. Current production
  assets are `index-BbOi7aAm.css` and `index-CA2_ZJuA.js`.
- Focused production-build browser acceptance: **6/6 passed**. This includes the
  real capture/evidence/edit/correction/delete/reload journey, truthful living-state
  transition and search, oversized-draft retention, plus 320px light and dark layouts.
- The rebuilt isolated preview is live at `http://127.0.0.1:4318`; its health endpoint
  returned `{"live":true}`. Paid-provider variables were explicitly absent at launch.
- Both the protected first-use screen and paired Today screen were inspected from
  actual rendered production assets. The tracked synthetic documentation screenshots
  were regenerated by the browser journey.

The first complete browser run passed 43/44; the light 320px journey timed out only
after its saved receipt had fully rendered, and passed on its immediate isolated
rerun. Visual inspection then caught and removed mobile sticky-overlay behavior.
The fresh complete rerun on the exact final tree passed **44/44 in 2.7 minutes**.
Native clients, live Paddle Sandbox, live model, hosted identity/TLS and
public-release authority remain external gates.

The first PR #6 CI run on `ecd74e6` correctly failed during the full Vitest gate:
the managed sign-in heading's visual emphasis inserted markup inside an established
server-rendered text contract. No authorization, storage or browser assertion failed.
The heading was restored to one uninterrupted accessible string without weakening
the regression. The exact runtime-config file then passed **10/10** outside the
socket/filesystem-restricted sandbox; its first sandboxed attempt had 8 passing
assertions and two Windows temporary-directory cleanup `EPERM` failures. Final
typecheck, lint and production build also passed; the corrected head was merged in
PR #6 and its exact workflow is identified in the current baseline above.

## Merged release foundation — B0 operator lifecycle and default-off B1 boundary

The owner's instruction to ship the complete product without slice-by-slice
approval authorized the reversible implementation now merged through PR #6. No
real credential, account, catalog, payment, deployment, or provider request was
created. The managed
financial authority now has offline one-time enrollment, Windows ACL verification,
encrypted key archive/restore, backup key metadata, and Paddle-store restore
barriers. A new default-off Paddle boundary adds all-or-none boot configuration,
one account-bound checkout intent, owner-only status/portal actions, strict raw-body
webhook verification and durable replay-safe inbox, bounded worker leases,
server-owned correlation, current subscription/transaction/adjustment evidence,
an explicit charged-currency allowlist, hard provider timeout/byte bounds, durable
known-binding conflict attention, and B0-only allowance publication. Provider-create
uncertainty is persisted before network I/O: a timeout, 5xx, unreadable response, or
post-create validation failure cannot release the account into a duplicate checkout.
A later signed transaction event can recover the exact intent; a known transaction
can be reopened in Paddle.js, and only a definitive provider rejection or exact
cancellation releases a retry. A Settings plan card uses plain monthly/annual,
confirming, active, attention, and unavailable states. Local/self-hosted mode has
no subscription dependency.

Fresh focused evidence on this changed tree:

- `npm run typecheck`, `npm run lint`, and `npm run build`: passed on the final
  tree; production assets are `index-DM_mCEeB.css` and `index-Dy9kW0GF.js`.
- Final isolated Vitest regression: **1,488 passed / 8 platform skips,
  141 files, zero failed** in 1,074.26 s with serial file execution and the
  bounded 15-second Windows integration default. The ignored
  `data/vitest-final-green.json` is the prior 1,478-pass checkpoint and must not
  be cited as the latest run; the latest result is the retained command output.
- Final Chromium regression: **all 44 journeys passed**, including billing
  Settings, living Today/search, first-note durability/errors/mobile,
  account-switch privacy, managed identity/consent/money and the complete prior
  browser suite. The combined run passed 43; Windows transiently refused to open
  the documentation screenshot output for the remaining journey, which passed
  on its immediate focused rerun.
- Offline deterministic evaluation: **4/4 passed**; no provider call or live quality
  claim. Registry-backed `npm audit --audit-level=high`: **0 vulnerabilities**.
- Final Paddle-focused set: **32/32 passed across 8 files**, including exact
  checkout-to-authority flow, raw signatures/replay, hard timeout despite an
  abort-ignoring transport, currency rejection, refunds, conflict/orphan handling,
  current-provider evidence, ambiguous-create duplicate prevention and recovery,
  HTTP ownership and default-off configuration.
- Current encrypted-key/operator lifecycle checks: **6/6 passed**, including the
  hard-link and oversized-archive rejection cases. The earlier positive Windows
  workspace ACL probe printed `acl-ok`; combined operator/store backup checks
  passed **6/6**.
- Encrypted key restore now rejects oversized and multi-link archive inputs before
  parsing/decryption, rechecks the opened file identity, and clears owned key,
  passphrase, derived-key and plaintext buffers on every reachable exit.
- The focused managed billing journey passed as part of the complete 44-journey
  browser run. It uses mocked public Paddle.js with actual API-boundary integration
  covered separately; it is not a real Sandbox checkout.
- Vault Git subprocesses now have a 60-second production ceiling and a plain
  retryable storage error instead of being able to freeze indefinitely. The
  final suite re-proved all 13 vault cases plus the previously intermittent
  advisory withdrawal/revival path. Intentional >15-second worker-kill tests keep
  their own explicit deadlines; no assertion or product safety boundary was relaxed.

All Paddle tests use synthetic ids, keys, transports, and signed payloads. The
worker's provider source is production-shaped but has not contacted Paddle.
Customer prices, annual discount, allowance amounts, seller/KYC/tax decisions,
real sandbox credentials, verified sandbox portal origin, live-model budget,
public host/domain/TLS, two native clients, legal/license/privacy/support decisions,
and public-release authority remain external gates. Live billing additionally
requires `BRAIN_PADDLE_ALLOW_LIVE=1`; it is off by default.

The rebuilt isolated preview was subsequently restarted at `127.0.0.1:4318` with
paid-provider variables absent; its liveness response was `{"live":true}` and it
served the exact merged production assets. This local preview is not a public
deployment. The Playwright server used disposable test data and passed 44/44.

## Current checkpoint — PR #5 merged; Desktop main consolidated; next-agent handoff

**Latest verified state (2026-10-18):** owner reviewed/merged PR #5. Desktop and
GitHub `main` match **`a702a93124b6bcc7eba22268d6f00c9e48c80a86`**, whose file tree
matches verified PR head `99598a7be349641fd82d135c500d82f55c75eaba`.
Exact-head push CI [39069418518](https://github.com/Rishflips/Bi-Brain/actions/runs/39069418518)
and PR merge-candidate CI [39069422614](https://github.com/Rishflips/Bi-Brain/actions/runs/39069422614)
both passed: **1,458 Linux tests / 132 files, 41 Chromium journeys, 4 offline
evaluations**, static/build/audit and Docker/container/Compose/Caddy gates. Windows
settled evidence remains **1,450 passed / 8 platform skips** below. The separate
merged-main push run
[39071223934](https://github.com/Rishflips/Bi-Brain/actions/runs/39071223934) was
subsequently read to terminal completion: **success** at exact main SHA `a702a93`,
with install, audit, typecheck, lint, full tests, build, offline evaluations,
Chromium, Docker/container, Compose and Caddy steps all successful.

The owner authorized consolidation into **`C:\Users\Gowrishankar\Desktop\Bi Brain`**.
This is now the sole Git/OpenCode working copy and the current session directory.
Original Desktop brain and the personal licensing note are preserved; preview
data moved intact to Desktop `data/local-preview/`. Private worktree data/reports
are under `data/consolidation-archive/cosmic-island-20261018-024758/`; 10,258 copied
files were hash-checked. Preview SQLite integrity/logical equality passed, and
fresh Desktop install/typecheck/build plus **23/23 brain/restart tests** passed.
The old worktree is removed; only an empty Windows-locked directory may remain.
Preview **http://127.0.0.1:4318/#today** was rechecked live, local mode, paid and
decision processing unavailable. No provider, payment or public service is enabled.

**Resume from [`NEXT_AGENT_HANDOFF.md`](NEXT_AGENT_HANDOFF.md).** It records source
entry points, evidence locations, operator/data safety boundaries and the remaining
build line. At this earlier checkpoint the handoff-writing task changed documentation
only; the newer continuation at the top records the subsequently approved local B0/T4
and default-off B1 implementation. No commit/push was performed by either local task.

### Approved product charter / living Today slice — local, uncommitted

The owner approved the product direction: **BiBrain is the user-owned central
memory and continuity layer behind every verified connected agent**, presented as
“One brain. Every agent. Always caught up. A little ahead.” The experience should
feel calmly alive and require no second-brain method or technical vocabulary.
Self-improvement means versioned corrections, feedback, freshness and measured
usefulness; it never grants model output authority over permissions, budgets,
instructions, code or accepted truth.

The first local vertical slice is implemented on Today. A new state-driven brain
pulse derives only from real saved-work, ready-proposal, job, brief, preference and
worker state. It distinguishes ready, ready-for-review, organizing, refreshing,
waiting/offline, intentionally quiet and caught-up states. Motion appears only for
real active/attention states and is disabled under reduced-motion preferences. A
direct “Find something in your brain” form performs real scoped search by navigating
to Your brain; it is not presented as semantic answering. First-capture, context,
history, background-help and evidence copy now use plain product language while
preserving source/version inspection and existing behavior.

Fresh evidence on the changed tree:

- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm run build`: passed; final assets `index-D8zxG9MZ.css` and
  `index-DnH7ku2e.js`.
- Focused new browser acceptance: **2/2 passed**
  (`tests/e2e/living-brain-review.spec.ts`), covering truthful state transition,
  durable capture → direct find and 320px layout.
- Existing capture/layout regression: **6/6 passed** across
  `first-note.spec.ts` and `first-note-layout-review.spec.ts`, including real
  persistence, source-linked preview, failure draft retention, input bounds,
  keyboard capture and 320px light/dark layout.
- The first sandboxed Playwright attempts could not bind/complete and were stopped;
  the same focused commands passed outside the socket-restricted sandbox. They are
  not counted as application failures or passing evidence.

This slice does not claim a full 132-file/41-journey rerun, live semantic answering,
two native clients, provider quality, billing, hosted identity or public release.
No provider, payment, owner financial authority or deployment was enabled.

### Previous publication-time checkpoint — retained history, superseded above

The owner approved the bounded inline first-note composer → durable saved result →
find/reopen in Your brain flow, then prioritized calm functionality over visual
redesign. DeepSeek Flash implemented the source; controller/parent review and
independent browser tests reproduced and closed material defects. **The changed
frontend passed typecheck, lint, build and all 41 Chromium journeys**, including
17 added journeys and the 24 preexisting regressions. This improves the existing
capture/search services; those underlying capabilities are not newly implemented.

The source now confirms durable capture before follow-up reads, displays only the
retained safe original, filters preview items by every exact source/version citation,
supports Save another and find/reopen after reload, and fences stale reads across
correction/removal/account changes. Failure drafts remain editable; oversized input
is rejected explicitly before capture. 320px light/dark, long evidence, keyboard,
quarantine, committed-save read failure, delayed-purge read and committed-correction
refresh-failure paths have behavioral evidence. Synthetic stored model fixtures are
not live model output; the separate preview test runs the actual unpaid worker.

Final frontend command: `npm run test:e2e -- --workers=1 --output=test-results/visible-product-closure-parent --reporter=line`
→ **41/41 passed, 2.0 minutes**. Parent inspected the long-original dark mobile
screenshot and restored only the two baseline images overwritten by browser tests.
`git diff --check` passed (line-ending notices only). The authenticated local preview
opened at **http://127.0.0.1:4318/#today**, with no pairing/session secret printed.
The controller's subsequent HTTP check returned `previewLive:true` and
`servesCurrentBuild:true` by comparing the served index with `dist/web/index.html`.

**Final parent regression passed:** `npm test -- --maxWorkers=1 --fsModuleCache
--fsModuleCachePath=node_modules/.cache/product-release-parent --reporter=default
--reporter=json --outputFile=test-results/vitest/product-release-settled-parent.json`
reported **1,450 passed / 8 explicit platform skips, zero failed across 132 files**,
637.12 s, start 02:22:46. Parent read `success:true` and verified all 24 frozen
source/test/config hashes unchanged. Short process-local TEMP/TMP and the explicit
module cache avoid the observed temporary-transform loss; no assertions were disabled.

The reproduced readiness race is repaired in both capability readers and the direct
decision send guard: a trusted clock is sampled after reading the lease. Fixed-time
callers, future-heartbeat/expiry/TTL denial, actual job-lease checks and monetary
authority remain strict. Independent source review found no material regression;
parent separately verified 19 readiness/consent/process checks with one platform skip,
including the original long-call heartbeat assertion. Fresh whole-tree typecheck,
lint and build passed before the settled regression.

The failed earlier run is retained below, not counted as passing. Functional source
was committed/pushed as **`92a69b2684b6d852b16e7be6214f629f0245655c`** and Desktop
`review/latest-build` fast-forwarded to the same SHA. Parent checked the remote SHA
and the personal licensing note's unchanged SHA-256. At this historical checkpoint,
[PR #5](https://github.com/Rishflips/Bi-Brain/pull/5) was still open; it was merged
later. This documentation-only delivery checkpoint followed that source commit.

The exact final PR-head Linux/container result must be read from PR #5's checks;
the first source-revision run is [39069371589](https://github.com/Rishflips/Bi-Brain/actions/runs/39069371589).
An automated completion watcher is running; no CI success is claimed before its
terminal result. This documentation checkpoint does not change the verified source.
Payments, runtime providers and public deployment stay off; no merge of this
follow-up is authorized.

**Latest parent continuation:** the UI's **41/41** browser acceptance is retained.
Parent independently verified the readiness repair with **19 passed / 1 explicit
skip**, including the actual long-I/O process case. The final decision-clock
direct-caller closure is still active; the settled full regression must wait for
its source freeze. No commit or duplicate full test run is authorized yet.

The earlier preview supervisor became unavailable (`Shell.NotFoundError` and port
4318 unavailable). Parent restarted the **same existing**
`data/local-preview/brain.sqlite` dataset under supervisor
`sh_14ba0c897001t3r1pzOZiZqGhY`, without `.env`, with provider/billing variables
stripped and paid processing off. Parent owns the fresh health check; the earlier
`previewLive:true` check below is historical evidence, not proof this restart is
healthy. No preview data or pairing credential was replaced or printed here.

**Settled release gate now running — source frozen:** the decision-readiness
closure executor has stopped editing. Parent independently reran current-tree
`npm run typecheck`, `npm run lint`, and `npm run build`: **all passed**. The
assets remain `index-Dh_t__5W.js` and `index-CLNTm5Lr.css`. Parent confirmed the
restarted preview is healthy and serves the exact current index bytes (SHA-256
`74846533cbff6de9a7c49eab3c6193c51073e26376a1fa56387abffce45d915b`);
the earlier PowerShell string mismatch was encoding-only.

Parent launched the settled full suite with approved `TEMP`/`TMP` and persistent
filesystem module cache:
`npm test -- --maxWorkers=1 --fsModuleCache --fsModuleCachePath=node_modules/.cache/product-release-parent --reporter=default --reporter=json --outputFile=test-results/vitest/product-release-settled-parent.json`
(background `sh_14ba36ff7001jkcd4uTUXM3zL2`). **Its result is pending**, not green.
No source edits, builds, browser journeys or duplicate Vitest runs may occur during
this gate. Parent owns completion/result and final clock review. Publication remains
on hold; the explicit staging manifest includes README and excludes generated
screenshots, runtime data and tool artifacts.

### Verified handoff baseline (b5610f4)

**Remote reconciliation:** PR [#4](https://github.com/Rishflips/Bi-Brain/pull/4)
was externally merged on 2026-10-17 at 20:19:22Z. `origin/main` is now
`1fe33bd530e924deb4de81b470b8416ccfbb2fd8`; the content diff from baseline
`b5610f4` is empty (merge commits only). This session performed no merge, reset
or rebase. The visible follow-up remains uncommitted/unmerged pending verification;
the earlier not-merged descriptions below are historical, not current remote state.

Parent read `test-results/prepublication-full-parent.json`: **success true,
1,447 passed, 8 skipped, zero failed across 132 files**. This completed baseline
supersedes the old running-full-suite status below; it is not verification of
future UI edits. GitHub Actions [39065046637](https://github.com/Rishflips/Bi-Brain/actions/runs/39065046637)
at exact commit `b5610f411e02584842d2e655a49bf28a781f00f3` completed successfully,
including Ubuntu install/audit/static checks/full tests/build/offline evaluations,
24 Chromium journeys, Docker build/container smoke, Compose and Caddy validation.
This closes that revision's Linux/container gate, not target-host release.

Fresh parent checks during visible-slice implementation:

- The first consolidated browser run (`test-results/visible-product-final-parent`) finished **38 passed / 2 failed across 40 journeys**. The new long-unbroken-passage receipt overflow was a real CSS defect; source wrapping was fixed rather than hiding content. The existing context-correction journey hit the unchanged pairing throttle; its trace confirms **HTTP 429**. Added shared-server login cases were moved to isolated real managed fixtures, with actual unpaid `Worker.tick()` for extractive-preview verification. No production authentication/CSRF/rate limit was relaxed.
- A separate correction/read-failure test reproduced a known committed correction leaving the earlier receipt body after `/today` failed (`test-results/visible-correction-refresh-red`, **1 expected failure**). Receipt invalidation now occurs immediately after the edit response, before workspace refresh, and incomplete-erasure responses also clear retained receipt content. Explicit input-limit validation had its own missing-helper RED (`test-results/visible-limit-red`).
- Final frontend closure: fresh `npm run typecheck`, `npm run lint`, `npm run build` **passed**. Full Chromium run in `test-results/visible-product-closure-parent` completed **41/41 passed**. Source changes remain uncommitted pending parent review and the separate backend release-regression repair.
- The parent's new `npm test -- --maxWorkers=2 --reporter=default --reporter=json --outputFile=test-results/product-release-full-parent.json` **failed**: 123 failed files / 9 passed, with 122 import failures involving missing Vitest transform-cache files under a shared temporary `ssr` path, and one process-readiness assertion failure (`managed-activation-process.test.ts:729`). Parent owns cache-loss diagnosis and isolated readiness follow-up. This is not a passing release regression and is not being hidden by the historical baseline. No production guard/assertion is changed to force green.
- Following executor handoff and the local Unicode-aware 100,000-character / 1 MiB input-limit closure, parent ran `npm run typecheck`, `npm run lint`, and `npm run build`: **all passed** before the first consolidated browser result above. The parent's separate full Vitest result is reported above; no duplicate full suite was launched here.
- `npm run test:e2e -- tests/e2e/first-note-layout-review.spec.ts --workers=1 --output=test-results/visible-layout-first-parent --reporter=line`: **2/2 passed**, actual keyboard capture and retained Unicode/multiline originals at 320px in light and dark appearance. Parent inspected synthetic-only screenshots `test-results/visible-inline-light-320.png` and `visible-inline-dark-320.png`; no horizontal overflow. This is supplementary first-draft evidence, not lifecycle acceptance.
- First-draft `npm run test:e2e -- tests/e2e/capture-release-review.spec.ts tests/e2e/capture-boundaries-review.spec.ts --workers=1 --output=test-results/visible-capture-first-parent --reporter=line`: **4 passed / 3 failed**. Known durable save after read failure, quarantine no-echo, Unicode reload and account-switch fencing passed. Save another, stale receipt after purge, and returning-user composer failed; these require repair, not acceptance. Preview attribution/provider-copy review also remains open.
- `npm run test:e2e -- tests/e2e/capture-boundaries-review.spec.ts --workers=1 --output=test-results/visible-boundaries-red --reporter=line`: **2 failed as expected against baseline assets**, both at the missing inline `main textarea` visibility assertion. This witnesses the missing-composer RED; it does not yet exercise the later save/read/quarantine assertions.
- `npm run typecheck` and `npm run lint`: passed before UI source changes; final changed-tree gates remain required.
- `npx vitest run tests/integration/brain.test.ts tests/integration/safety.test.ts tests/integration/restart.test.ts tests/integration/managed-http-login.test.ts tests/integration/managed-review.test.ts tests/integration/runtime-config-review.test.ts --maxWorkers=1 --reporter=default --reporter=json --outputFile=test-results/visible-core-parent.json`: **38 passed, 6 files**.
- `npx vitest run tests/integration/deployment.test.ts tests/integration/operations.test.ts tests/integration/runtime-config.test.ts tests/integration/managed-login.test.ts --maxWorkers=1 --reporter=default --reporter=json --outputFile=test-results/visible-release-parent.json`: **30 passed, 4 files**.
- `npm run brain-eval`: **4/4 synthetic offline evaluations**.
- `npm audit --audit-level=high`: **zero vulnerabilities**.

The integration checks include real API/worker restart, retained original and preview,
managed synthetic-issuer login/session isolation, backup/restore and deployment
guards. They do not establish live-provider quality or public hosted identity.

## Retained checkpoint — B0 standalone writer / admission history

### Repository delivery / local preview — current owner request

The owner requested commit/push or a PR, syncing the Desktop project folder and a local
preview, plus an honest production score. Parent's fresh pre-commit run at **01:25:24**
passed **488 checks / 6 platform skips, 36 files**, including billing and both old
worker activation-guard suites (`test-results/billing-precommit-parent.json`). Separate
typecheck/lint/build passed; fresh browser run passed **24/24**; offline evaluations
**4/4**, audit zero vulnerabilities. All implementation executors are stopped and
the source was frozen. The fresh full regression subsequently completed:
`test-results/prepublication-full-parent.json` records **1,447 passed / 8 skipped,
132 files, zero failed, success true**. See the current checkpoint above.

The isolated local supervisor is running on **http://127.0.0.1:4318**, with
`data/local-preview/brain.sqlite` and its private `owner-secret`, no `.env` load and
provider/billing variables removed. Parent opened its actual UI and confirmed
`/api/v1/health/live` returned `{"live":true}`. The owner explicitly rejected the
visible experience: the old local pairing screen and largely unchanged GUI are
not delivery of the polished managed browser-first product. This is a product gap,
not excused by backend test counts. See `docs/PRODUCTION_READINESS_2026-10-18.md`:
**40/100 managed public readiness, blocked**, with concrete evidence and missing gates.

Remote fetch found `origin/main` at `658565b`; the current feature branch was not yet
pushed. The Desktop worktree was behind remote main and had one untracked personal
licensing document. Preserve that file; publish only the reviewed development work.
Do not merge a PR or claim main is updated merely because a feature branch is pushed.

**Latest independent gate (Windows / Node 24.19.0, 2026-10-18 00:06:57): 430 passed /
6 explicit platform skips across 20 files**, 14.54 s. Parent separately ran
`npm run typecheck`, `npm run lint` and `npm run build`: all passed. Machine report
`test-results/billing-authority-writer-final-parent.json` contains the final focused
result; parent read `success:true`, 430 passed, zero failed, six pending. The batch
covers **384 B0 checks plus 46 existing financial checks**, not a
new full-suite invocation. The separate existing-runtime regression passed **984 /
2 platform skips, 98 files**; browser **24/24**, offline evaluations **4/4**, dependency
audit **zero vulnerabilities**. Those completed results were preserved rather than
restarted during isolated writer repairs.

Accepted: T1 calendar/reference/seal contracts, T2K protected key helper, T2L complete-frame
journal verification/frozen-v4 fixture, T2P operator policy, and **T2W standalone writer**.
The writer loads the actual protected key/policy/root, validates server-owned subscription
correlation and authenticated retained evidence, privately appends grants/revocations,
and atomically materializes immutable original central periods. Default-null evidence
cannot use cached grants. Annual processing renews monthly, with no rollover or recharge.
Both parent actual-process cases passed: one grant under same-window contention, and a
separate process's adverse result fencing an older delayed active reply. All evidence
is **synthetic**, not provider payment verification.

Parent additionally reproduced and repaired a journal head whose singleton was
changed to `2` using real SQLite's `ignore_check_constraints`; its signed content
alone cannot excuse malformed row identity. The final gate includes this case,
the failed-COMMIT refusal and the future-version fixture-digest regression.

**T3 implemented in part but NOT yet accepted:** owned admission/provisioning
generation, explicit non-funding v5 installation, mandatory reserve/mark/pre-I/O
enforcement, audit split and lifecycle fencing are present. The final immutable
reservation binding and strict suffix-only verification are being completed.
Operational enrollment/key backup/restore remain T4, unimplemented. Genuine legacy
roots stay central money **4**; only explicit installation opts into **5**; tenant
schema remains **5**. Production evidence/correlation sources stay null. No actual owner key,
account, activation, payment, provider call or deployment was created. B1 remains
unapproved; positive configuration/MACs are not verified payment or permission.

**Next action — implementation underway:** parent reviewed the revised
`docs/superpowers/plans/2026-10-18-billing-admission-integration.md`, added the exact
execution closures and authorized DeepSeek to implement the complete admission/
generation + explicit money-5 installation + mandatory spending/audit integration
test-first. No isolated helper passing is acceptance of the integrated boundary.
No production caller or default evidence source was added by standalone acceptance.
Known limits: coherent whole-DB rollback, Windows key ACL verification, target-host
permission/drill proof and production incremental send-time verification remain open.
The current writer uses bounded boot/writer scans, not a production model-send cache.

**Latest T3 continuation:** the dedicated lifecycle executor finished its bounded
slice (six own lifecycle checks; 32 passed across six lifecycle/existing-recovery
files). Parent independently verified an actual cold v5 backup/restore: incarnation
and epoch advanced, marker matched, unknown money row stayed byte-identical, and
knowledge retrieval/new capture worked while the restore/accounting barrier stayed
active. The first parent test expectation was corrected to respect the existing
`awaiting_accounting` precedence; that assertion correction is not production RED.

Parent sent the remaining two requirements back to the primary executor as a
single finishing gate: `control_billing_reservation` authenticated immutable call →
admission/generation/term/window/period binding, and a process-owned contiguous
forward-suffix index. New parent binding tests reproduced **5/5 failures at 00:59:54**
(missing proof, ignored/denied proof inserts leaving holds, changed model/request
re-authorized). A new positive next-annual-window funding test also reproduced
an originating-term/current-window grant confusion at **01:00:25**; legitimate
monthly annual renewal must permit fresh funding once the previous usage is settled.
That test additionally observes actual SQL and rejects a full historical rescan on
forward-head refresh. Final full-suite/browser gates wait until this code is stable;
no T3 acceptance or production migration is claimed from partial executor reports.

The last binding fault test also exposed an actual ignored-COMMIT bug at **01:03:24**:
after priming the verifier, SQLite authorizer `SQLITE_IGNORE` on the funding TX's
COMMIT let `reserve()` return an undurable hold. The executor must verify the owned
transaction actually ended before returning success and roll it back on refusal.
The unprimed probe also exposed an owned read-TX cleanup leak; both require cleanup,
not just converting the final return into an error. No model was called or owner
funds touched: all fault tests use disposable synthetic control/tenant databases.

Parent's fresh v5 activation check also failed at **01:06:07**: the existing public
profile enrollment and read-guard path still required money version 4 even after
a valid v5 audit. The lifecycle executor is repairing only the five activation
reader/writer files to use the exact actual supported version (4 or 5), preserving
profile schema 1 and all existing root/audit/opt-in checks. It owns no reservation/
prefix source files, avoiding concurrent edits with the primary executor. The new
`billing-admission-activation-review.test.ts` enrolls synthetic metadata only;
it installs no provider/credentials/readiness and does not relax sandbox bootstrap.
Scoped ESLint passed for the final parent activation/binding/funding review files.

**Last-stage parent review, still NOT accepted:** at **01:08:28**, all **17/17**
binding/funding/actual-process cases passed, including a new two-Node v5 fresh-mark
race (one dispatched, one refused until known settlement; proofs retained). Parent
then reproduced **two real funding bypasses at 01:09:37**: deleting the v5 marker
alone downgraded the live ledger to legacy mode despite retained integrated state,
and deleting an already-observed signed refund plus its projection/counter while
keeping the same known head let the head-only cache forget the revocation. A known
head alone is not the required authenticated per-account prefix/revocation index.
These are not the acknowledged coherent whole-database rollback residual.

At **01:10:15**, a separate installer fault test showed ignored COMMIT still
reported success; at **01:11:10**, the installer healed a missing legacy immutable
trigger and a v5 reopen ignored a missing retained money table. Parent's new tests
require full retained money catalog validation as well as the added billing
namespace. The primary executor is repairing these exact cases; the parallel
activation executor remains confined to its five files. No full-suite run is
claimed while these material defects are unresolved.

**Activation version closure finished separately:** its executor reported 61/61
checks across eight files, including the new parent v5 metadata-enrollment check.
Parent then independently reproduced **5 failed / 20 passed** in the two existing
worker activation-guard suites at **01:13:30** (`billing-legacy-dispatch-parent.json`).
Root cause is concrete: the new coordinator pre-I/O call passed the **tenant call
id** to the central ledger, which requires the mapped **central call id**. The
executor is repairing that identity routing while preserving the original private
attempt/lease checks. No synthetic transport call may be counted as executed when
its durable central row is merely marked. This regression must pass before the
long full regression is started; the earlier 984-test result is not fresh evidence
for the currently changed integration tree.

**Admission integration contract review in progress:** parent rejected optional
caller guards, row-presence/manual fallback, supplied key/policy/tenant paths,
unsigned checkpoints, a dynamically changing frozen inventory and the missing
actual admission writer. Narrow Astra **Medium** advice confirmed the concrete
closures: positively sealed baseline membership, durable lifecycle fencing,
owned one-use preflight, verified prefix/revocation index and one non-funding
migration/enforcement boundary. DeepSeek is rewriting the same plan consistently.
Ordinary legacy construction will remain money-4; an explicit offline
`installBillingMoney5` operation will install v5 without creating keys/enrollment
or enabling paid processing. Genuine legacy manual behavior is not silently blocked
by a universal constructor upgrade.

Parent added `tests/integration/billing-admission-money5-review.test.ts` and witnessed
missing-installer RED at **00:13:52** (zero assertions ran because
`packages/storage/billing-install.ts` does not exist yet). This test file is new
work-in-progress, not part of the accepted 430-check writer batch; a whole-tree
typecheck is not claimed while its dependency is missing. Tests cover genuine frozen
v4 rows/FKs, repeated install, missing acknowledgements, denied COMMIT, ignored marker,
future schema and mandatory unenrolled-v5 denial with known settlement still allowed.
No money version or production source changed during this planning gate.

**T3 execution authorized after review:** the revised plan now preserves strict
journal/standalone-authority schema variants and introduces an explicit integrated
variant; signs the complete preflight record including expiry; supports a real
first admission on an empty journal; derives correlation/generation privately;
preserves v4 fingerprint bytes; and fences supported lifecycle mutations before
they start. Separate v4/v5 version contracts preserve genuine legacy behavior.
DeepSeek (`ses_eb4db8448ffeRnhsX14npdT9fe`) is the implementation executor, parent owns
independent tests/final verification, and narrow Astra **Medium** advice remains
advisory only. No final test result or actual v5 installation is claimed yet.
The parent migration review also covers caller-owned transactions and refusal to
auto-heal a lost v5 authority table. Owner data, activation, providers and B1 stay off.
Parent also added `billing-admission-knowledge-review.test.ts`: real HTTP/session
capture and retrieval must survive non-funding installation on an existing schema-1
tenant; a newly provisioned v5 tenant gets a single durable incarnation while retaining
knowledge access without a key or billing admission. Its behavior is not counted as
passing yet. Scoped ESLint passed for both new parent-owned integration review files.

**T3 first pass is NOT accepted:** DeepSeek returned partial generation/admission/
installation/enforcement modules and 18 new own checks, with audit integration,
restore fencing and true suffix verification still unimplemented. Its 473-pass
reported batch did not establish the complete approved gate. Parent independently
ran **394 passed / 3 failed / 6 skipped across 18 files** at 00:31:00:
`test-results/billing-admission-first-parent.json`. Genuine standalone writer
regressions remained green, but installation accepted an altered v4 reservation
schema, caller-owned transactions produced the wrong failure, and an existing
schema-1 user's real HTTP source read became 401 after installation (knowledge
availability regression).

Parent then reproduced a **critical funding bypass** at 00:32:20 in
`billing-admission-enforcement-review.test.ts`: forged SQL enrollment/manual-baseline
rows with no protected `billing-enrollment.json` let the actual `reserve()` create
a hold. Classification trusted row presence and returned manual before validating
the protected anchor/baseline. New send-time verifier also lacks several provenance
checks already enforced by the accepted standalone writer; no weaker duplicated
validator is acceptable for real spending. DeepSeek is completing the coherent
slice and repairing these issues, with parent-owned tests unchanged. These are
internal implementation failures, not unavailable credentials or business decisions.
No production v5 root, key, enrollment, provider or payment was enabled.

At **00:34:17**, parent independently reproduced **6/6 failing send-time provenance
checks** in `billing-admission-provenance-review.test.ts`: receipt body substitution,
observation/customer substitution, mismatched freshness revision, future evidence
after clock rollback, term epoch/origin substitution, and a signed refund hidden by
resetting a mutable counter. The new send-time verifier returned authorization in
each case. DeepSeek received these exact REDs and must restore parity with the
accepted writer while retaining bounded indexed send-time verification.

Parent has also prepared actual-ledger positive/negative tests in
`billing-admission-funding-review.test.ts` for valid reserve/mark/settle, post-refund
mark denial, known settlement after refund, annual-boundary no-rebind and retained
unknown usage. These require explicitly enrolled synthetic fixture composition;
blanket denial does not satisfy the positive gate. Behavior results are not counted
before the complete repaired run. Scoped ESLint passed for all five new parent
integration review files. No full-runtime/browser rerun is being duplicated while
the shared implementation is still changing.

Parent added `billing-admission-audit-review.test.ts` and witnessed **3/3 RED** at
00:36:36: the actual v5 audit currently refuses even valid synthetic enrolled setup.
The positive requirements are renewal and new unpaid capture without staling the
existing frozen audit; the paired negative requirement forbids hiding an unadmitted
account's raw financial period in that exemption. DeepSeek has all seven parent
integration-review files and is completing the missing audit/recovery/suffix work
and repaired validation together, not accepting a blanket-deny substitute.

**Second independent T3 checkpoint, 00:43:42:**
`npx vitest run billing-admission billing-authority billing-reserve-guard billing-money5-migration --maxWorkers=1 --reporter=default --reporter=json --outputFile=test-results/billing-admission-second-parent.json`
passed **430 / 6 platform skips across 26 files**, 38.91 s. This is a different
batch from T2W's 430/20 gate: **384 standalone B0 + 46 T3 checks**, not the earlier
384 + 46 legacy-financial batch. All earlier parent anchor-bypass, migration,
knowledge, funding, audit and provenance failures passed. It does not complete T3.

To finish the remaining work in parallel, parent assigned exclusive lifecycle
ownership (`packages/runtime/managed.ts` and `managed-recovery.ts`) to DeepSeek
`ses_eb4b61be3ffeiIs8oCP7QwYo0Z`. The original executor owns retained preflight evidence,
immutable reservation-generation binding, pre-send checks and bounded prefix/suffix
verification; it must not edit those two lifecycle files concurrently. Both remain
implementation executors; parent owns reviews and acceptance.

Parent's two new `assertFundingForExecution` tests first failed at 00:46:02 because
the method was missing, then passed at **00:47:50**: current marked calls authorize;
expiry or a changed generation refuses before transport, leaves the marked row
byte-identical, and permits known settlement. A warm real-SQL check also passed:
reserve/mark performed no non-point journal history query inside their money TX.
Parent added `billing-admission-preflight-review.test.ts`: its fifteen-minute expiry
case passed, but actual retained-baseline payload was missing (**1 failed / 1 passed**
at 00:48:32). This is being repaired; a retained digest alone is not retained evidence.
No new full-suite/browser claim, migration on owner data or live activation occurred.

### Writer execution and repair history — superseded by acceptance above

Following the owner's request to proceed
faster in safe order, parent resolved the contract at the top of
`docs/superpowers/plans/2026-10-17-billing-authority-writer.md` and authorized
DeepSeek to implement the complete standalone writer slice test-first, not another
plan-only pass. Parent is independently testing alongside it. Existing uncommitted
S1/S2 work and all accepted prerequisites remain preserved.

The earlier non-executable proposal below the resolved contract remains history,
not authority to skip checks. The executing slice consumes an already signed
admission, reloads actual protected policy/key and root binding, correlates all
provider references, privately persists authenticated receipts, and atomically
materializes a grant plus its original central period. Actual clean-baseline
admission/provisioning generation and low-level reserve/mark/audit integration
are the **next coherent gate**, not fabricated by standalone tests. No production
source/caller or global migration is authorized by this slice.

Parent independently witnessed missing-writer RED at 23:30:55. A separate
evidence-contract run at 23:31:40 reproduced **6 failed / 5 passed**: mutable
provider response aliasing, an unpaid observation converted to a paid receipt,
and four cross-binding receipt conversions. DeepSeek is repairing these within
the executing slice. It must report the complete writer gate before acceptance;
the current work-in-progress tree is not represented as passing. No owner key,
money history, app/worker activation, provider connection or payment is enabled.

To shorten safe verification, parent launched the **unchanged existing-runtime**
regression suite in parallel with isolated B0 development:
`npm test -- --maxWorkers=1 --exclude "tests/integration/billing-authority*.test.ts" --reporter=default --reporter=json --outputFile=test-results/billing-authority-existing-runtime-parent.json`
(background `sh_14b097a3a0012O5wnSPYVtylGV`). All work-in-progress B0 tests are
explicitly excluded; app/worker/current-money code is frozen during this run.
This is not a passing full-B0 result or a completed gate until the command's
completion notification and JSON are checked. Do not poll, restart or count an
interrupted run as passing. DeepSeek remains the sole implementation executor;
parent owns the independent tests and final gate.

**Existing-runtime rerun completed:** the background command above passed
**984 tests / 2 existing platform skips, 98 files**, 618.05 s (start 23:34:36).
Parent read its JSON: `success:true`, 984 passed, zero failed, two pending. All B0
tests were deliberately excluded; this is fresh S1/S2 runtime/recovery/financial
regression evidence, not a completed billing result. No cleanup warning appeared.

**Writer parent review is repairing real failures, not accepted:** first full
B0 batch at 23:44:32 had **358 passed / 1 failed / 6 platform skips, 15 files**.
Typecheck/lint/build passed separately after parent fixed its own test lint.
The new actual two-Node-process race passed: one central period, term and grant
under simultaneous paid-window publication. Parent then reproduced **11 failing
assertions / 34 passing** in the stronger writer review at 23:47:22: null-source
cached authority; expired annual evidence still writing a new month; revoked-term
revival/incorrect new-term generation; unchecked receipt/observation bodies;
period-ID substitution; cap changes hidden by a cached grant; changed control
identity; epoch changes during source I/O; and an unchecked key commitment.
DeepSeek is unifying those validations across read, renewal and publication paths.
Repeated adverse polls must also be idempotent, and denial evidence must be retained
and authenticated rather than just persisting an unresolvable digest. Any required
normalized denial table is test-installed only; no B1 inbox or global migration.

No further original-runtime edits or live actions occurred. The new writer remains
isolated and unaccepted until parent verifies the repaired invariants and final
focused batch. The raw passing-test count from its executor is not acceptance.

**Next independent writer rerun (23:57:35): 372 passed / 6 platform skips,
15 files**, 9.86 s; actual two-process race passed again. Machine report remains
`test-results/billing-authority-writer-parent.json`. Parent then reviewed the
new unified implementation and reproduced **7/7 new failing provenance tests**
at 23:58:39 in `billing-authority-provenance-review.test.ts`: deleting denial
projections plus resetting their counter erased a still-retained signed revocation;
a rehashed receipt plus missing freshness bypassed the original journal payment
reference; a receipt could point to an admission ordinal; foreign epochs were
filtered out rather than rejected; an existing-window refresh reported granted
against a revoked central period; a different transaction entered an annual term
through a later month; and clock rollback accepted future evidence. These are
verified failures, not hypothetical findings. DeepSeek is repairing the full
journal-to-projection correspondence and shared positive-path validation. The
372-pass run is **not acceptance of this writer**.

Parent launched a fresh browser regression separately:
`npm run test:e2e -- --output=test-results/billing-authority-browser-artifacts --reporter=line`
(background `sh_14b2010ad001enS1QjLH44alAZ`). Its explicit output directory preserves
the earlier machine reports. No browser result is claimed until completion.
The original-runtime 984/2 gate is finished and is not being restarted.

**Browser command completed: 24/24 passed**, 1.5 minutes, no provider configured
(`.env not found`). Parent separately ran `npm run brain-eval`: **4/4 synthetic
offline evaluations passed**; `npm audit --audit-level=high`: **zero vulnerabilities**.
These finish their own regression gates and do not override the seven reproduced
writer-provenance failures being repaired. Added one SQLite-authorizer failure
check for a silently ignored freshness-frame update and a second actual-process
adverse-versus-delayed-active race; neither is counted before the next completed run.

After the 321-pass parent gate, `npm run brain-eval` passed **4/4 synthetic offline
evaluations**, and `npm audit --audit-level=high` found **zero vulnerabilities**.
No full-suite/browser/native-client/Paddle/provider/hosted result is inferred.

### Retained B0 Task 1 and storage verification history

The owner approved the written B0 renewal-safe financial-authority design with
**"okay go ahead"**. DeepSeek implemented **only its pure-domain Task 1**;
parent independently reviewed and verified it. B1 Paddle integration remains
**DRAFT / UNAPPROVED**. B0 as a whole is not complete.

- New `packages/domain/billing-authority.ts`: strict canonical UTC/calendar
  windows, original-anchor annual month clamps, monthly provider-period windows,
  policy/transaction-independent identities, freshness/expiry helpers and closed
  structural paid-term lookup validation.
- New `packages/domain/billing-seal.ts`: bounded purpose-specific data records,
  canonical owned snapshots and fail-closed, length-safe HMAC verification. These
  are integrity primitives, **not payment verification or spending permission**.
- Parent reproduced and verified fixes for four invalid calendar-reference
  cases, invalid UUID acceptance, a changing object getter and a changing source
  iterator. Validation cannot serialize a different unvalidated source list.

**Fresh parent evidence (Windows / Node 24.19.0, 22:21:56):**

| Command                                                                                                                                                                                                                                                                                                                                                                                      | Actual result                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `npx vitest run tests/integration/billing-authority-domain.test.ts tests/integration/billing-authority-domain-review.test.ts tests/integration/spend.test.ts tests/integration/managed-spending.test.ts tests/integration/managed-decision-advisory-question-review.test.ts --maxWorkers=1 --reporter=default --reporter=json --outputFile=test-results/billing-authority-task1-parent.json` | **162 passed, 5 files**, 4.94 s; zero failures/skips |
| `npm run typecheck`                                                                                                                                                                                                                                                                                                                                                                          | passed                                               |
| `npm run lint`                                                                                                                                                                                                                                                                                                                                                                               | passed                                               |
| `npm run build`                                                                                                                                                                                                                                                                                                                                                                              | passed                                               |

Parent read the JSON report: `success:true`, 162 passed, zero failed/pending.
The batch contains **99 B0 tests** (32 executor + 67 parent) and 63 adjacent
accounting/advisory regressions. The full 984-test suite, browser suite, offline
evaluations and dependency audit were **not rerun** for this pure, unused slice;
their earlier S2 results below retain their original scope. One source-list RED
was witnessed before its repair; four supplemental array-shape assertions were
added afterward, not independently represented as witnessed RED cases.

**Next:** finish/review T2K, the standalone protected key-file helper, before
schema or grant-writer work. The broad storage proposal still lacked a complete
signed-frame representation and actual evidence-producer contracts, so it is
not approved for execution. B1 DDL is deferred to its separately reviewed initial
installation, requiring a fresh closed-schema digest/audit/enrollment. Task 3 runtime guards and Task 4 operational
recovery follow. No central schema/version, owner data, actual key, activation,
provider transport, payment, dependency or lockfile has changed in B0 Task 1.
Existing S1/S2 changes remain preserved and uncommitted.

**T2K in progress:** parent approved only `packages/storage/billing-key.ts` plus
synthetic disposable-root tests. There is no production caller or key enrollment
command. Parent reproduced the two-suite missing-module RED at 22:36:12 (exit 1,
zero assertions executed) before authorizing implementation. File reads must not
create/repair keys; explicit acknowledged enrollment must use exclusive creation,
exact 32-byte binary data, readback and no overwrite. Keys, directories, links,
hard links, malformed inputs and POSIX modes are tested independently. Parent
rejected early-return "skips" and a serial Promise test masquerading as concurrency;
unavailable link privileges must be actual reported skips. No cross-process race
proof or Windows ACL assurance is claimed by T2K. No schema/version change occurs.

**Continuation requested: "go ahead, fast".** Parent reproduced a final T2K
lost-key regression at 22:43:32: **46 passed / 1 failed / 6 skipped**. Existing
`.protected` with a missing enrolled key incorrectly allowed replacement; the
approved standalone helper must refuse this ambiguous state, not regenerate it.
DeepSeek is repairing only that helper. The next focused substage is T2L:
complete-frame signed journal schema plus a bounded read-only verifier, explicit
disposable SQLite fixtures, and a genuine frozen-v4 fixture. It adds no production
consumer or migration and keeps central money at 4 until the complete financial
storage contract is ready. B1 inbox/checkout DDL stays deferred. No safety guard,
unknown hold or owner data is changed to accelerate this work.

**T2K parent behavior gate passed (22:47:43):** independent focused run
`npx vitest run tests/integration/billing-authority-key.test.ts tests/integration/billing-authority-key-review.test.ts tests/integration/billing-authority-domain.test.ts tests/integration/billing-authority-domain-review.test.ts tests/integration/managed-spending.test.ts --maxWorkers=1 --reporter=default --reporter=json --outputFile=test-results/billing-authority-key-parent.json`
reported **169 passed / 6 explicit Windows-related skips, 5 files**, 5.49 s.
Parent inspected the lost-key refusal and pre/open/post file-identity checks.
The six skips are five POSIX mode checks and one actual Windows file-symlink
privilege failure; directory-junction and hard-link checks ran and passed.
Windows ACL and actual process-contention proof remain unverified. Final static
checks will be repeated once the journal slice exists; missing-module journal
RED tests are currently intentional, not a passing tree claim.

T2L is now delegated test-first to DeepSeek. Parent independently witnessed its
missing-module RED at 22:48:40 (exit 1, zero assertions). The complete canonical
frame is retained; the journal verifies exact schema, root/policy/epoch/MAC/chain,
head, row/byte bounds and transaction ownership. This is a read-only foundation
with no public append or grant method, not a completed renewal/payment flow.

**T2L parent review / repairs:** a fresh 8-file batch at 22:51:57 passed
**210 tests / 6 platform skips**, with separate parent typecheck/lint/build.
Parent then reproduced two real assertion failures at 22:53:08: a SQLite-denied
COMMIT was swallowed while returning a verified snapshot, and the frozen-v4
fixture digest excluded all future version markers instead of only additive v5
bookkeeping. Both repairs were independently verified at 22:58:25: **43/43**
journal/fixture checks. A failed owned COMMIT now refuses and rolls back without
touching caller-owned transactions; a version-6 marker changes the history digest.
The fixture's synthetic unknown hold and monetary block remain byte-identical
when only the unused journal namespace is added. This is **not v4→v5 migration
proof**. Parent's separate legacy financial-safety batch passed **25/25** at
22:50:48 (audit, frozen-v3 migration, decision guards and accounting invariants).

**T2P now in progress:** a closed pure operator-policy/catalog contract must
precede the private financial writer. Configured ceilings default to no authority;
provider facts cannot choose allowances or increase budgets. Parent witnessed its
missing-module RED at 22:58:25. A successful narrow **GPT-6 Astra Medium** advice
call confirmed the minimal seam: trusted source reads outside transactions,
rechecks and normalized evidence inside the control transaction; production
`EvidenceSource = null` until separately approved B1 exists. TypeScript privacy
and HMAC possession are not proof of provider contact. Admission also requires
rechecked provisioning/import generation, not a clean-baseline hash alone.

## Retained acceptance — S2 advisory worker

**All three approved S2 slices are now accepted locally:** bounded questions,
tenant-v5 advisory/attempt lifecycle, and the default-off managed decision worker.
DeepSeek implemented the bounded slices; parent tests and independent review
reproduced and verified repairs before acceptance. The pause, failed checks and
interrupted verification below are retained as history, not current blockers.

**Final parent evidence (Windows / Node 24.19.0):**

| Command                                                                                                                   | Actual result                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `npm test -- --maxWorkers=1 --reporter=default --reporter=json --outputFile=test-results/decision-advisory-s2-final.json` | **984 passed, 2 existing POSIX-only skips, 98 files**, 720.54 s; zero failed files/tests; no cleanup warning |
| `npm run test:e2e -- --workers=1 --output=test-results/decision-advisory-task3-parent`                                    | **24/24 Chromium journeys**                                                                                  |
| `npm run typecheck` / `npm run lint` / `npm run build`                                                                    | passed separately; repeated after the final test-only cleanup repair                                         |
| `npm run brain-eval`                                                                                                      | **4/4 synthetic offline evaluations**                                                                        |
| `npm audit --audit-level=high`                                                                                            | zero vulnerabilities                                                                                         |
| `git diff --check`                                                                                                        | passed; existing line-ending notices only                                                                    |

Parent read the final JSON report: `success:true`, 984 passed, 0 failed, 2 pending,
98 files. The real worker-process suite passed all five cases in this final run:
same-job D→R settlement/proposal, settled-D restart without resend, long-call
heartbeats plus real expired-lease re-acquisition/no resend and unpaid account B
continuity, decision-only bootstrap, and reasoning-only bootstrap. Parent's 19
worker regressions and two real-launcher checks also passed within the full run.
Known charges survive refusal; partial tenant settlement cannot publish; recovery
checks the original job and both financial projections before loading a current
advisory. No advisory choice grants permission or suppresses reasoning.

Reference screenshots are restored and the lockfile is unchanged. All changes
remain local and uncommitted. No agents or background verification commands are
left running. Windows graceful SIGTERM marker removal, current-branch Linux/
container CI, live-provider compatibility/quality/cost, native-client sessions,
billing, chosen-host recovery/monitoring and human/legal release gates remain
separate. The synthetic process proof is not a real provider call or deployment.

**Next dependency:** separately scope the billing/subscription slice and obtain
the remaining live/release inputs. A numeric live-test budget, host/domain,
secure identity/payment/provider setup and owner license/privacy decisions have
not been supplied. Do not activate an owner/provider, purchase infrastructure,
publish or choose the owner's license on the strength of this acceptance.

**Payment-provider preference:** the owner now prefers Paddle over Stripe if it
is suitable for an India-based global seller. Parent checked Paddle's official
country, pricing, payout/currency/fee, verification and acceptable-use pages:
India is eligible in principle, but seller/domain/product/payout approval remains
unverified. Paddle Billing is the next design target, **sandbox first**; this
does not approve a billing architecture or customer price. The evidence and
India-specific payout/tax caveats are recorded in `docs/BUSINESS.md`. No account,
checkout, product/price, banking setup or payment was created or enabled.

The owner specified **individual/sole proprietor** for Paddle onboarding. This
is a design input, not completed KYC, domain approval or tax/bank verification.
Billing remains a separate architectural design gate; no billing code or payment
provider action has begun.

In the subscription-model clarification, the owner selected **monthly and annual**
for the first managed release. Design both cadences; exact prices, annual
discount, allowance amounts and replenishment/lifecycle rules still require the
billing design/economic gates. This does not authorize live checkout or payments.

The owner has now explicitly approved the allowance rule: both monthly and annual
plans renew their included processing allowance **monthly, with no rollover**;
annual customers do not receive a year's usage upfront. Exact customer prices,
discount/allowance amounts and the written billing architecture remain unapproved.
Parent is researching Paddle Billing lifecycle/security and the existing monetary
authority seams before presenting that design. No implementation has started.

Design research identified a prerequisite: the existing activation audit binds
every configured allowance period and account inventory. Naively adding renewal
periods or subscribers would stale the global audit and stop paid processing.
DeepSeek mapped the exact code seams; a narrow **GPT-6 Astra Medium** advisory
call recommended a separately reviewed renewal-safe authority extension, not
automatic offline re-auditing or simply deleting dynamic fields from fingerprints.
Existing caps, held usage, legacy baselines, known settlement and restore blocks
must survive that change.

Two new documents are **DRAFT / UNAPPROVED**, under parent review:

- `docs/superpowers/specs/2026-10-17-renewal-safe-financial-authority-design.md`
- `docs/superpowers/specs/2026-10-17-paddle-billing-design.md`

Parent review requires complete cross-document grant/admission interfaces, unique
annual renewal windows, explicit authority-key/restore trust limits and correct
Paddle paid-term/PII/currency handling before owner review. The owner-approved
monthly no-rollover rule is recorded; proposed cancellation, failed-payment,
freshness and technical-authority choices are not yet approved. There is no
implementation plan, billing schema/code, dependency, payment account or live
action created by these drafts. S2's accepted code and test evidence are unchanged.

The two drafts have now been parent-refined: monthly provider-paid periods and
annual UTC-clamped monthly windows; policy-independent renewal identities with
non-overlap/no re-credit; explicit admission/paid-term lookup contracts; rare sealed
authority changes separate from bounded fresh-state updates; backup/key/rollback
limits; initial-checkout versus recurring-payment correlation; and localized
currency/PII/portal handling. The proposed customer lifecycle is term-end
cancellation and a pause on new paid model work when payment is uncertain, while
saved knowledge remains accessible. Sandbox payments must never fund real model
calls. Exact prices and monthly model budgets are still required before enabling.

**Next gate: owner review/approval of the B0 written financial-authority draft
first.** B1 is a separate draft consumer and needs its own approval after B0's
contract is accepted. No implementation plan/code or live/sandbox payment account
has been created; no test rerun is claimed for document-only changes. The current
S2 acceptance remains the unchanged 984-test / 24-browser checkpoint.

**B0 written-design approval:** after the parent asked to approve B0 before its
implementation plan, the owner replied **"okay go ahead"**. B0 is now approved
for planning and dependency-ordered implementation/synthetic verification. B1
remains **DRAFT / UNAPPROVED**. Begin with a reviewed implementation plan, then
test-first bounded slices and parent gates. No migration on owner data, key/account
enrollment, live spending, customer prices, payment or deployment is authorized by
this approval. Existing S1/S2 changes remain preserved and uncommitted.

After a server restart, parent confirmed that no B0 plan file had been created
and resumed **plan drafting only** with DeepSeek (`ses_eb5c94313ffejEKJcpSAbwC09l`).
The sole delegated output is
`docs/superpowers/plans/2026-10-17-renewal-safe-financial-authority.md`;
the executor must stop for parent review before source/tests/migration work.
Expected dependency order is pure contracts/calendar, sealed storage/migration,
runtime admission/send guards, then operator enrollment/recovery/process proofs.
No implementation, verification rerun or external payment action has begun.

**B0 plan review in progress:** DeepSeek produced the four-task plan above. Parent
found two material planning gaps: an unrestricted seal body contradicted the
approved closed-record design, and later storage writer inputs were unspecified.
DeepSeek is tightening the pure T1 schemas and writing/running its tests first;
it must stop at RED before production modules. T2–T4 cannot execute until their
typed storage/authority contracts and bounds are independently reviewed. No money
schema/version, owner database, activation, key enrollment or provider has changed.

**B0 T1 RED / parent gate:** parent reviewed the tightened contracts and corrected
a contradictory test that accepted and rejected the same `window_end`. Parent
reproduced the missing-module RED at 22:10:53 (exit 1, no assertions executed),
then authorized only the two pure domain modules. Independent parent tests at
22:14:29 reproduced four calendar-reference validation failures. A second run at
22:15:31 had **60 passed / 6 failed**: the same four plus malformed UUID acceptance
and a changing getter being validated at one value but serialized at another.
DeepSeek is repairing those observed failures; T1 is **not yet accepted**. No
schema/storage/runtime consumer or key enrollment has been implemented. T2–T4
remain paused for concrete storage-contract review, not a new owner design vote.

## Resume and verification history — superseded by acceptance above

The owner has now said **"continue exactly from where we left"**. The pause is
lifted for the approved remaining S2 Task 3 work, not live activation/deployment.
Parent inspected the saved edits and independently reproduced the two reported
parent-test issues: nullable piped-stream types and the daily receipt's wrong
generation path. Only those test issues were corrected. DeepSeek has resumed the
missing actual-worker process proof; parent owns independent review and acceptance.
The following pause handoff remains history, not an instruction to stop again.

**Resumed parent verification:** fresh typecheck reproduced the two nullable
pipe errors, and the unknown-R worker check reproduced the generation-path
`ENOENT`. After correcting those parent tests, the existing worker/launcher batch
passed **15/15** at 14:59:22. No implementation behavior was changed for those
test corrections.

Parent review then recorded **3 actual failing cases** at 15:03:37: a source set
changed before reserve still produced a dispatched hold, a source made private
before mark failed to release the still-undispatched reservation, and recovery
did not load a current published advisory using its original job's settled slot.
DeepSeek is repairing these alongside the missing real-process coverage. The
already-tested after-mark privacy case must still keep its hold; the early checks
do not promise atomicity across I/O.

Another real tenant-settlement SQL failure at 15:08:05 showed a known central
charge with an unsettled tenant projection could still publish a judgment.
Task 3 must verify both exact financial projections before publication/recovery;
the known charge and reconciliation block stay retained. An overrun test in that
same run was initially overstrict: an unavailable/null observation is allowed by
the approved malformed-output rule. Parent corrected it to require no active
judgment, rather than deleting valid unavailable history. The current parent
worker suite contains **18 cases**, not yet a settled acceptance run.

**Task 3 final gate in progress:** parent independently passed **21/21** across
the worker (now 19 cases, including a real settlement+safety-marker failure that
fail-stops `ManagedWorker`) and real-launcher environment suites at 15:27:57.
The remaining parent fixture type error was corrected by typing its actual SQL
entity row; fresh parent typecheck/lint/build passed. Parent Chromium regression
passed **24/24**; reference screenshots were restored. Fresh **4/4 offline
evaluations**, dependency audit (zero vulnerabilities) and whitespace checks also
passed (Git printed only the existing line-ending notices).

Independent source review confirmed the four execution/recovery repairs and
found no further material defect. The executor strengthened its five actual-main
process tests to require a non-seed/fresh restart boot identity, future readiness
expiry, advanced job attempts/fence after real lease expiry, retained no-resend
holds and account B's unpaid brief from the same actual worker. Decision-only and
reasoning-only bootstrap/key cases are also covered. The child environment uses
an explicit OS allowlist plus synthetic test values; tests do not load an operator
environment or contact a provider. These are synthetic runtime proofs, not live
semantic quality, pricing or a hosted release. Windows graceful signal cleanup
remains separately limited.

All executors/reviewers have stopped. Parent launched the settled full serial
suite (`npm test -- --maxWorkers=1`, background `sh_149524ae5001DKPYMOJ2h57Ngu`).
**Task 3/S2 remain unaccepted until its completion notification confirms the
result.** No production code should change underneath this gate. No provider,
owner account or target host has been activated.

**Settled full-suite result:** `npm test -- --maxWorkers=1` passed **984 tests /
2 existing POSIX-only skips, 98 files**, 554.20 s (start 15:34:54). Its output also
reported **one process-fixture cleanup warning**. This is not silently being
treated as a pristine gate: parent found the newest disposable hold-test root
still retained, while a read-only process check found no live `node.exe` running
`apps/worker/main.ts`. That check alone does not diagnose which file handle or
permission prevented deletion.

DeepSeek is investigating only the process-test cleanup/child-close lifecycle;
production code is unchanged. Any exhausted cleanup must be an actual test
failure, not a warning followed by a success claim. Parent will attach the
focused cleanup proof and any required final rerun before marking S2 accepted.
The complete browser/other-gate results above remain their recorded evidence;
no live activation or deployment has occurred.

Cleanup follow-up (test-only): the executor observed Windows `EPERM` on a retained
fixture root; deletion later succeeded after its transient handles were gone.
Vault Git grandchildren are a plausible holder, but the sole holder was not
proved. The fixture now captures the real child `close` promise at spawn, closes
provisioning resources in `finally`, yields during bounded cleanup retries and
**fails** instead of warning if cleanup cannot finish. It reported two consecutive
clean 5-process-test runs and no new leftovers. Parent inspected these changes;
production execution/guard code is unchanged.

Parent has launched a second settled full serial run with the stricter fixture
(`sh_14972949f001fdCFTFpQ83prCu`). All agents are stopped; do not mark S2 complete
or infer a cleanup-free full run before its completion result arrives. Earlier
984/2/98 and 24-browser results retain their exact stated scope.

The stricter-fixture rerun (`sh_14972949f001fdCFTFpQ83prCu`) was interrupted around
a harness/server restart: exit code **4**, with only the Vitest start banner and
no test summary. It is **not** passing evidence or a diagnosed application test
failure. Parent checked its saved output and found no remaining Vitest/worker
Node process. After the owner's explicit continuation, only the final gate was
restarted, preserving all code and earlier verified results:

`npm test -- --maxWorkers=1 --reporter=default --reporter=json --outputFile=test-results/decision-advisory-s2-final.json`

The current run is `sh_149d7ad1a001r1djbAoo0xzVni`; its machine-readable report is
to be read only after completion. All agents remain stopped. No source change,
activation, live call, commit, push or deployment accompanies this rerun.

### Saved owner pause and safe-stop handoff

The owner requested **"hang on at safe point, will continue later"** during S2
Task 3. Parent sent an immediate safe-stop instruction to the active DeepSeek
executor (`ses_eb8b3dc93ffenap9iGKPlyiXuT`): finish only an in-flight atomic edit
or test cleanup, preserve all work, record a partial handoff in the S2 plan and
stop. No further implementation, tests, commits, pushing, activation or deployment
should begin until the owner resumes. **The executor has now confirmed its safe
stop: all its commands completed and no executor-launched process remains
running.** This is the agent's handoff, not a new parent verification run.

Last accepted checkpoint: S2 Tasks 1–2, **948 passed / 2 existing POSIX-only skips,
94 files**, **24 Chromium journeys**, **4 offline evaluations**,
typecheck/lint/build and dependency audit passed. Task 3 is partial and unaccepted;
its current edits must be inspected against the executor's final plan handoff
before resuming. Parent-owned worker tests contain 13 cases with recorded REDs,
and the launcher probe has two recorded REDs; no final Task 3 verification exists.
All local changes remain preserved and uncommitted. No live provider call,
owner activation or deployment was performed by the parent.

**Final paused Task 3 handoff (executor-reported, not parent-accepted):**

- Partial worker/managed/bootstrap integration, goal-revision withdrawal,
  known/unknown receipt rendering and worker-only decision-key forwarding are
  implemented within the closed file list. See the S2 plan's partial execution
  notes for commands and details.
- Own worker suite **6/6**, parent worker suite **12/13**, launcher environment
  **2/2**, affected batch **164 passed / 12 files** were reported. The remaining
  worker test reportedly reads the wrong vault path: generated daily receipts
  live under `generations/<generation>/dreams`, not directly under `vault.root`.
  Verify that diagnosis before changing the parent test.
- Typecheck reportedly has two nullable stdout/stderr errors in the new
  parent-owned launcher test. These are new Task 3 test-file issues, not an
  accepted-baseline defect. No clean final typecheck/lint/build/full/browser gate
  is claimed for the partial integration.
- The actual `main.ts` / ManagedWorker process proof and official-endpoint
  injected transport fixture are still missing. Launcher environment probes are
  not substitutes for this proof.
- Resume only on the owner's request: inspect the saved edits and plan notes,
  verify/correct the parent test issues, rerun focused checks, complete real-process
  synthetic coverage, then run independent full/browser verification. Do not
  restart the executor or any test now.

## Owner direction — production delivery in safe order

The owner now requests **"ship it to production with all the things we planned,
continue back to where you were, make it in safe order"**. This extends the goal
from local acceptance to production delivery; it does not make unfinished gates
pass or authorize unbounded spending, infrastructure purchases, arbitrary host
access, invented credentials or an agent-chosen software license.

Resume the approved S1 Task 3 consent/status/UI checkpoint first, then complete
the remaining managed-suite worker/policy, real-provider quality, billing,
native-client and operational/release gates in dependency order. Keep synthetic,
provider-live, native-client, target-host and public release evidence distinct.
Use staging and disposable data before admitting owner/customer data. The chosen
host/domain, secure identity/payment/provider configuration, a numeric live-test
budget and owner license/privacy decisions remain required inputs. Never deploy
the old single-owner Compose defaults as a complete managed subscription suite.
No host, account or provider is activated by this status record.

## Current checkpoint — decision accounting S1 accepted locally

The owner approved the written stage-accounting design. DeepSeek implemented
Task 1 (schema 4, separate default-off decision profile/mirror, strict CLI,
coordinated global disable and recovery), then repaired the parent's reproduced
enrollment/CLI/audit defects. **All three S1 tasks are now accepted locally**:
profile/migration/recovery, stage-specific guarded accounting, and consent/status
HTTP/UI. Parent verification and independent review include the repaired job
principal/lease fences and blocked-consent wording. Earlier failures below are
retained as repair history, not the current acceptance state.

**Final S1 parent acceptance (Windows / Node 24.19.0):**

| Command                                                                                     | Actual result                                                                      |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `npm test -- --maxWorkers=1` (repeat after final UI repair)                                 | **829 passed, 2 existing POSIX-only skips, 88 files**, 302.88 s                    |
| `npm run test:e2e -- --workers=1 --output=test-results/decision-accounting-s1-final-parent` | **24/24 Chromium journeys**, including **5** independent decision-consent journeys |
| `npm run typecheck` / `npm run lint` / `npm run build`                                      | passed separately; typecheck/lint repeated after the final browser-test addition   |
| `npm run brain-eval`                                                                        | **4/4 synthetic offline evaluations**                                              |
| `npm audit --audit-level=high`                                                              | zero vulnerabilities                                                               |

Consent stays raw/withdrawable while unavailable, unrelated saves omit unchanged
consent, temporary usage accounting does not impersonate missing capability, and
an unsaved opt-in cannot cross an account switch. Reference screenshots match
their pre-run hashes; the lockfile is unchanged. This checkout remains local and
uncommitted: no new Linux/container CI, merge, provider activation, real runtime
call or public deployment is claimed. S1 contains no production decision worker.

**Next gate:** S2 implementation under the now-approved separate advisory-worker
design. The owner replied **"go ahead, proceed"** to its written-design approval
request. Begin with a reviewed implementation plan and failing tests, then pure
bounded questions, durable advisory lifecycle, and explicit worker coordinator
pair/bootstrap in dependency order. Approval does not supply a host/domain,
numeric live-test budget, live credentials, pricing verification or license.
No live provider or target host is activated by this record.

### S2 in progress — Tasks 1 and 2 accepted, worker integration next

The reviewed plan is `docs/superpowers/plans/2026-10-17-system-one-advisory-worker.md`.
Parent caught and corrected a plan defect before implementation: a question with
only source hashes could not support a real relevance judgment. The transient
question/adapter input now includes bounded selected source text; persisted
advisories retain only source references/hashes and explicitly labeled judgments.
Question identity, adapter request identity and financial configuration remain
distinct. Source ordering is canonical, body hashes are recomputed, and the full
canonical question is bounded to 16 KiB without trimming source bodies.

Parent wrote an independent question suite before implementation. Its first
`npm test -- tests/integration/managed-decision-advisory-question-review.test.ts --maxWorkers=1`
observed a missing-module RED at 04:44:09: **one failed suite, zero test bodies**,
not behavioral passing evidence. DeepSeek is implementing only the pure module
and its own test-first suite; no tenant migration, advisory persistence or worker
integration is authorized until its parent gate. A new plan-version-zero check
reflects actual newly created goals, whose initial `plan_version` is 0.

Read-only review of the upcoming persistence slice identified plan gaps before
its authorization: shared local/managed restore must also clean advisory attempt
references; goal edits need explicit withdrawal; the vault needs the observations
directory initialized as well as mapped; publication must atomically consume a
matching claimed attempt; and portable export must deliberately retain validated
advisories even though ordinary entity/context readers hide them. Imported
judgments remain unavailable/null and cannot recreate an execution claim. These
are pre-implementation requirements, not reported bugs in a shipped S2 feature.

The first pure-contract handoff passed parent/owned checks at **31/31**, but is
not accepted. Parent then observed **5 failed / 22 passed** behavioral checks at
04:49:51: direct validation/bridging accepted an oversized canonical question,
accepted an empty source set and repeated source IDs at different versions, and
the exported option objects were mutable. A real prepared adapter with injected
transport also accepted rounded probabilities (sum 0.9999) that the advisory
mapper incorrectly refused. DeepSeek is repairing the public validation seam and
matching the existing adapter's sum tolerance without normalizing raw values.

Parent also prepared the next migration gate before implementation: a frozen
tenant-v4 schema (not a downgraded new runtime) with reserved, dispatched-unknown,
settled and legacy money rows, original content and raw choices. Its initial
`managed-decision-advisory-migration-review.test.ts` run observed **2 failed /
1 passed** at 04:51:50: migration 5 and its failure-injection boundary are not
implemented; future-schema refusal already passes. This does not authorize Task
2 early or describe its full lifecycle/restore/claim proofs as complete.

**S2 Task 1 accepted at its focused gate:** the five validator/immutability/
rounding defects were repaired; parent independently ran **116/116** across six
question/adapter/guard suites at 04:54:48, including **40/40** owned+parent question
checks. Fresh parent typecheck/lint/build passed. The public validator and bridge
now enforce the 16 KiB bound, nonempty distinct source IDs and fixed options;
rounded probabilities retain their raw values under the existing adapter's 0.001
sum tolerance. This is not a full S2 suite, provider-quality result or runtime
consumer. The server restart did not change this checkpoint or start persistence.

Task 2 is authorized under the reviewed plan: tenant migration 5, claimed-attempt
publication and the complete withdrawal/purge/restore/export lifecycle. The plan
now uses an explicit injected clock and exact job/owner/fence binding, a typed
tombstone outcome with no fabricated attempt row, and hash-only tombstones that
prevent a deleted mapping from causing the same paid question to be sent again.
No Task 3 worker/bootstrap is authorized until the persistence gate passes.

After the server restart, the working tree still contained the accepted pure
module and no advisory storage implementation. Task 2 was handed to a fresh
DeepSeek executor with the reviewed clock/lease/claim/tombstone interfaces and
closed file ownership. Parent's independent persistence suite then recorded a
missing-storage-module RED at 05:00:11 (**one failed suite, zero test bodies**).
Its planned behaviors use actual accounts, audited configuration, synthetic
readiness, SQLite/vault and source operations—not ready-boolean permission stubs.

Read-only preparation for the later worker slice found implementation
prerequisites, not delivered S2 results: the engine's retry decision must
distinguish a settled decision from an existing reasoning slot without changing
legacy `hasUnresolved`; the existing launcher must not forward the new decision
key to its server (or dev frontend) child; boot readiness identity is distinct
from per-job lease identity; and the optional decision provider should be a
structural one-method interface so readiness fencing cannot be bypassed for test
convenience. These will be resolved in the Task 3 plan after Task 2 acceptance.

### S2 Task 2 review — repairs required, not accepted

The first persistence handoff independently passed **27/27** parent migration and
initial lifecycle checks at 05:23:18. Parent then exercised public mutation
seams and the round-trip/withdrawal boundaries. The expanded 40-case run at
05:30:12 had **16 failed / 24 passed**; one failure was a parent test error:
ordinary exports already retain historical source versions. The corrected
historical-version case passed alone at 05:33:33; no working full-version export
behavior is being removed.

The **15 confirmed failures** concern transactionless mutations, deriving a
principal from a UUID-shaped path, publication after immutable claim metadata is
changed, resuming a withdrawn judgment, and silently ignored tombstone/deletion
writes reporting successful forgetting. Three additional cases at 05:34:51
reproduced a real **scoped** historical export failure after a source moves out of
the exported project, plus accepted mismatched available body hashes/project
metadata. The current parent persistence suite therefore contains **43 cases**;
18 failed-case observations require repairs, not a claimed settled result.

DeepSeek is repairing these before any full/browser gate: explicit caller-owned
transactions; trusted bound principals instead of path inference; immutable
claim identity plus publish-time comparisons; active-only reads; checked purge
writes; unavailable/null historical imports without invented missing bodies; and
validation of available provenance. A narrow owner-checked claim method will
re-derive the question inside the write transaction. Parent also removed its
incorrect test expectation of a new vault `index_gone` field: file/Git erasure and
the actual SQLite FTS check are separate evidence. The executor is to remove the
unsupported production alias rather than fabricate a combined index proof.

An external review recommendation to drop project-wide attempt tombstones was
not adopted: existing source deletion conservatively purges all project-derived
entities, and the reviewed plan explicitly preserves no-resend keys before that
purge (including an excluded source). A previously claimed question was already
non-reclaimable; a hash-only tombstone preserves that rule rather than newly
withholding authority. Future worker changes remain unauthorized until Task 2
passes its parent gate. No live call, activation or deployment has occurred.

The repair handoff reports **119/119** focused checks (30 owned store, 3 owned
migration, 43 parent persistence, 3 parent migration, 40 question checks), plus a
**280-check / 22-file** affected batch. Parent inspected the repaired source;
independent read-only re-review confirmed all known fixes and found no additional
material difference. Principals now come from the trusted Brain, not a filename;
the new owner-checked claim wrapper rebuilds the current question under the
write lock; identity columns are immutable; active readers never revive archived
judgments; and forgetting requires both tombstone and delete proof. Imports
retain unavailable/null historical records without inventing missing sources and
reject contradictory available provenance. The unsupported vault index alias is
gone; the actual SQLite FTS proof is separate.

Fresh parent typecheck/lint/build, **4/4 offline evaluations** and dependency
audit (zero vulnerabilities) passed on the repaired checkpoint. Parent launched a
new full serial suite; browser regression follows. **Task 2 is still unaccepted
until those gates finish.** No Task 3 implementation is running. Its plan now
records the launcher key isolation, distinct boot/job identities, exact-stage
retry/receipt accounting and the goal-revision withdrawal hook needed by the real
worker; this is planning, not executed worker evidence.

**S2 Task 2 is now accepted locally.** Parent's settled
`npm test -- --maxWorkers=1` passed **948 tests / 2 existing POSIX-only skips,
94 files**, 672.60 s. Parent's
`npm run test:e2e -- --workers=1 --output=test-results/decision-advisory-task2-parent`
passed **24/24 Chromium journeys**. Browser tests used their own 4317 server;
integration process tests use ephemeral ports and disposable roots. Fresh
typecheck/lint/build, **4/4 offline evaluations** and dependency audit (zero
vulnerabilities) also passed. Independent re-review confirmed the repaired
transaction, identity, active-read, archive and erasure-write boundaries.

Tenant schema 5 and the full advisory lifecycle have local synthetic evidence;
central money schema 4 and all existing holds remain unchanged. No Linux/container
CI, real model run, native-client proof or hosted result is inferred. Reference
screenshots were restored from pre-run copies; the lockfile is unchanged.

Task 3 is authorized next under the approved S2 design and reviewed plan: explicit
decision/reasoning coordinator pair, default-off frozen bootstrap, independent
own-worker readiness, no-resend recovery and truthful per-stage/job accounting.
Parent will add independent launcher/worker checks and verify the full checkpoint.
There is still no authorized live test cap or target host/domain; do not activate
an owner/provider or deploy merely because implementation is authorized.

### S2 Task 3 underway — worker/launcher REDs, not accepted

DeepSeek is implementing the authorized explicit coordinator pair and frozen
bootstrap in the existing worker. Parent owns separate regression tests. The
real-launcher environment probe observed **2/2 failed behavioral checks** at
06:06:32: the worker received its synthetic decision key as intended, but the API
and dev frontend inherited it too. This test stops disposable children before
their application entrypoints and reports booleans only; it is environment-flow
evidence, not a real worker/bootstrap proof and contains no operator credential.

Parent's independent actual-Worker suite observed **7/7 failed behavioral checks**
at 06:12:12, with real audited profiles, account-bound central/tenant money,
readiness and prepared adapters using injected HTTP transport. The missing D
integration made **zero decision calls** while the baseline reasoning call still
ran. These are REDs for same-job D→R across all three choices, retained known
charges under consent withdrawal/malformed output, unknown-D shared pause and
unknown-R total-cost rendering. Later assertions are not counted as proven just
because the first call-count assertion failed. Additional parent cases now cover
source privacy immediately after mark and during I/O, and master-consent refusal.
No Task 3 gate, live provider call or hosted result is claimed.

The parent worker suite now has **13 cases**. A seven-case extension run at
06:14:47 had **5 failed / 2 passed**, with seven earlier cases filtered out;
three were expected integration REDs (post-mark privacy, known-cost privacy
withdrawal and cumulative cap). Two exposed parent fixture assumptions instead:
the preference getter does not itself equal the API readiness flag, and the vault
already rejects a scanner-matching goal before a worker can lease it. Parent
removed the unexercised scanner case and checks the actual separate capability
without imposing a new readiness policy on the unchanged legacy R coordinator.
The production readiness-wrapper proof remains the actual-main process gate.
These adjustments are test corrections, not production permission changes.

**Task 2 parent acceptance (Windows/Node 24.19.0):**

| Command                                                                                  | Actual result                                                   |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `npm test -- --maxWorkers=1`                                                             | **819 passed, 2 existing POSIX-only skips, 87 files**, 359.97 s |
| `npm run test:e2e -- --workers=1 --output=test-results/decision-accounting-task2-parent` | **19/19 Chromium journeys**                                     |
| `npm run typecheck` / `npm run lint` / `npm run build`                                   | passed separately on settled source                             |
| `npm run brain-eval`                                                                     | **4/4 synthetic offline evaluations**                           |
| `npm audit --audit-level=high`                                                           | zero vulnerabilities                                            |

Parent inspected and independently tested the repaired job/goal/principal and
post-I/O lease fences; read-only review found no additional material defect.
Both real prepared transports execute once on the same synthetic review job;
known cost settles in both ledgers before output refusal. Shared-cap tests prove
each stage alone fits but their combined charge/reservation does not. Cross-
account unknown usage, reopened-handle no-adoption and extractive continuity are
covered. These are coordinator/provider synthetic proofs, not scheduled worker
execution, live quality or invoice pricing. Reference screenshots were restored
with matching hashes; no dependency installation/lockfile change occurred.

At the Task 2 checkpoint, Task 3 was authorized to wire own-account decision capability/raw/effective
consent into HTTP/status and the existing Settings UI, with independent browser
coverage for unavailable withdrawal and unrelated-save omission. No production
decision bootstrap, paid call, owner activation, publish/deploy or S2 policy is
authorized. Existing implementation changes remain local and uncommitted.

Task 3 verification history: parent wrote three independent browser journeys over real
services/SQLite/HTTP and a synthetic managed origin, with explicitly synthetic
readiness (not a real decision worker). The first run against the prior built UI
observed **3 failed journeys** because the new checkbox did not exist. They cover
unavailable stored-true withdrawal, omission of both unchanged consent fields on
unrelated saves, truthful unavailable defaults, and readiness loss while shared
usage is pending. These are Task 3 REDs; they do not alter Task 2's accepted
19-journey checkpoint and are not passing evidence yet.

Task 3 executor handoff added the own-account decision status and deployment-only
runtime metadata, a managed-only optional consent control, and independent PATCH
omission/withdrawal state. Parent's first three browser journeys passed. A
read-only review then found misleading copy under a durable paid-processing
block: both consents could already be stored true, but the panel said master
consent was required. Parent added a fourth real-service browser test, observed
its failure before repair, and DeepSeek corrected only that message branch.
No permission or financial gate changed in the repair.

On the repaired UI, parent reran typecheck/lint/build successfully and the full
Chromium suite passed **23/23**, including the new durable-block regression and
withdrawal while blocked. The reference screenshots were restored from the
pre-run copies with matching hashes. Four offline evaluations and dependency
audit (zero vulnerabilities) passed. Full serial testing was launched before the
copy repair, so its result alone is not described as final settled-tree evidence;
final S1 acceptance still awaits the settled verification record.

The pre-copy-repair full run finished **829 passed / 2 existing POSIX skips,
88 files** (301.69 s). Parent launched a second full run after the copy repair.
Parent also added an independent account-switch consent regression: an unsaved
decision opt-in in A cannot survive the same SPA's switch to B or appear in B's
PATCH. It passed against the existing account-reset behavior; no new RED is
claimed for that added proof. The final browser command
`npm run test:e2e -- --workers=1 --output=test-results/decision-accounting-s1-final-parent`
passed **24/24**; the decision-specific suite passed **5/5**. Fresh typecheck and
lint passed after that test addition. Read-only re-review confirmed the misleading
copy was repaired without changing permission or monetary logic.

In parallel, DeepSeek drafted the **unapproved** S2 worker design at
`docs/superpowers/specs/2026-10-17-system-one-advisory-worker-design.md`.
Only that new document was changed for S2. No worker bootstrap, advisory
persistence/migration, real call or target-host action has been implemented by
the draft; it requires separate written-design review before implementation.

Parent independently ran 14 focused files: **165 passed, 1 existing POSIX-only
skip**. This includes all 60 independent profile/persistence tests, valid CLI
enrollment, configuration races, immutable/required event writes, atomic global
stop and restore tests. Parent then added **2 passing migration tests** that
actually start with frozen v3 DDL (not a freshly downgraded v4 runtime), preserving
reserved, dispatched-unknown and settled financial rows byte-for-byte, plus
transactional DDL rollback on a failed v4 marker write. Reopening is idempotent.

Fresh parent `npm run typecheck`, `npm run lint`, and `npm run build` passed,
including a repeat after the shutdown repairs. No full-suite, browser or final
S1 acceptance is inferred from the focused run.
An additional parent test reproduced one remaining absent-profile CAS defect:
`disable(9)` incorrectly reported success at version 0. Only `disable(0)` may be
an absent-profile no-op; a positive stale version must conflict. DeepSeek applied
that repair. The first full run predated it and is not settled-tree verification.
Another independent frozen-v3 test reproduced a backward-compatibility blocker:
the global stop tried to append a new-schema event before migration and rolled
back with `no such table: managed_decision_activation_events`, leaving legacy
reasoning enabled. The repair migrates v3 roots before the stop transaction so
both stages can be stopped atomically with event records. No subsequent task
has been authorized to start.
Independent read-only review also found two introduced defects, both reproduced
by parent tests: a malformed decision row could roll back a valid reasoning
global stop, and decision-only disable swallowed mirror failure while reporting
complete success. Repairs now commit safe off-state before reporting corrupt
configuration/mirror failures, without silently repairing bad profile data or
weakening ordinary transactional failure behavior. Parent full-suite results
from the pre-repair tree cannot establish acceptance of these changes.
The pre-repair serial run finished at **723 passed, 3 failed, 2 POSIX-only skips,
78 files** (256.89 s): the parent and executor absent-profile CAS tests and the
parent v3 global-stop test failed. The two later corruption/mirror regressions
were added after their file had run, so this full-run count does not include
those assertions.

Parent reran the settled profile/persistence/migration/CLI tests: **74/74 passed**,
including all repaired shutdown cases. Independent read-only re-review found
both of its defects resolved, ran **80/80** across five decision suites and
reported no remaining material new defect. The corruption fallback preserves
the bad configuration/fingerprint, flips raw decision `enabled` off, records
`decision_activation_invalid` in the same transaction, then reports operator
repair after the valid reasoning profile is safely off. This block has **no
automated clear path** in S1; do not imply an automatic recovery procedure.
Operator notes explicitly record the limitation.

A fresh settled-tree `npm test -- --maxWorkers=1` passed: **728 passed, 2 existing
POSIX-only skips, 78 files**, 243.94 s. Parent then ran
`npm run test:e2e -- --workers=1 --output=test-results/decision-profile-task1-parent`:
**19/19 Chromium journeys passed**. `npm run brain-eval` passed **4/4**; audit
found zero vulnerabilities. Reference screenshots were restored from pre-run
copies with matching hashes; the dependency lockfile and production worker/UI
remain unchanged. Whitespace and scoped credential-pattern checks passed.

Parent accepts Task 1's verified migration/profile/operator/recovery foundation,
including the documented corruption-repair limitation. Task 2 is authorized
under the already-approved S1 design: separate decision readiness, shared prepared
hash derivation, closed stage-specific guards/accounting and raw-consent
primitives, still without a production worker decision dispatcher. No decision
guards, readiness or consent/UI are verified yet; no S2 dispatcher is authorized.
No real key, runtime provider call, owner activation, new push or deployment.

Task 2 parent review began with a new independent binding suite. Its first run
observed **4 failed test bodies** because `expectedDecisionConfigHash` is not yet
exported (not a missing-module/zero-body result). The tests compare the expected
profile hash to actual prepared-adapter identities for both provider families,
bind accepted-model ordering and execution bounds, exclude credentials, and keep
enrollment metadata distinct. This is an in-progress RED, not an accepted result.

The first Task 2 handoff implements **only shared hash/capability helpers and
separate readiness**; the executor explicitly reports the guard/coordinator,
raw-consent and slot-reader work incomplete. Parent's binding tests and helper
suite passed **11/11**, but a new runtime review reproduced **4 failures**:
the partial loader ignored root containment and exact SQL/mirror agreement.
Missing/invalid mirrors could leave configured policy ready. These helpers have
no production decision caller, and are not accepted for authorization. The
executor is repairing them while completing the remaining approved Task 2 work.
Three additional parent checks passed for profile-bound readiness comparison,
finite/fresh timestamps, separate marker preservation and junction-root denial
(4 unrelated cases filtered, not claimed passing). Task 2 is still unaccepted;
no new full-suite/browser result applies to this partial code.

The helper repair was independently rerun at **21/21 passed** (binding 4,
runtime 7, executor helper 10). The original DeepSeek child then reported a
context/time limit and stopped without adding the remaining 2A guard code.
Parent preserved its tree and handed the bounded 2A task to a **fresh child using
the same requested DeepSeek model**, not a different implementation/advisory
model. No global configuration or user chat was changed.

The fresh child is implementing closed stage-specific guard types, raw consent
and the central stage-selected seam. A new independent raw-consent suite first
observed **2 failed, 2 passed**: default false was missing and withdrawal was
rejected as an unknown preference. Its historical-unavailability preservation
cases already passed before implementation, so they are not claimed as new
behavioral REDs. Coordinator/private-attempt lifecycle and shared-stage barrier
proofs are deferred to the following 2B checkpoint, still within approved S1.

An independent pure guard-schema suite also observed **2 failed, 4 passed**
before 2A implementation: the legacy schema permits OpenAI-shaped guards to be
labelled `decision` or `repair`. The existing storage seam still rejects those
stages, so this is the expected tightening RED, **not a proven existing I/O
bypass**. Valid reasoning shape compatibility and cross-provider rejection are
retained as regressions. The fresh executor is
`ses_eb98981f5ffezV1EULg0dCQT2y`; the old context-limited executor is stopped.

The fresh executor delivered 2A's closed guard union, installed decision policy,
stage-selected central seam and raw-consent primitives, reporting 19 owned stage
tests and a 246-test focused batch passing. Parent source review then reproduced
**2 failures / 4 passes**: substituting both guard hash fields plus the dispatch
spec hash could pass central reserve without independently matching the live
profile's expected prepared hash; and an optional `undefined` decision-consent
field cleared a stored true choice. These are internal integrity regressions,
not proof of a remotely reachable exploit. The executor is repairing both;
independent 2A code review is running. 2A/2B and complete S1 remain unaccepted.
The snapshot-only assertion helper must not be described as standalone I/O
authority; 2B still needs the actual job/goal/lease/private-attempt/consent checks.

Independent 2A review reports **54/54** across seven decision suites and no
remaining material 2A authority defect after the targeted repairs. Parent still
awaits the executor's settled handoff and rerun before accepting 2A. The review
also reproduced a Task 3 client integration requirement: when stored decision
consent is true but unavailable, echoing that true in a full preferences update
is an explicit re-enable and is refused. Unrelated HTTP/UI saves must omit the
unchanged field, just as for the existing master consent. This is not described
as an authorization bypass or silently waived; the Task 3 tests must cover it.

### 2A focused acceptance; 2B next

The executor repaired both 2A REDs. The central writer now derives
`expectedDecisionConfigHash` from the **live** decision profile under its write
lock, using the same pure provider helper as the adapter/runtime (no duplicate
formula or storage→runtime import). Both guard hash fields must match it.
Explicit `undefined` consent now counts as omission; explicit false still
withdraws and true still requires trusted capability/no durable block.

Parent independently reran **157/157 tests across 12 files**, including the new
central-substitution and consent regressions, all parent decision binding/runtime/
schema checks, legacy activation/accounting and prepared decision behavior.
Fresh parent typecheck/lint/build passed; whitespace check passed. **2A is
accepted at this focused intermediate gate.** No new full-suite/browser result
is inferred; the whole Task 2 and S1 remain incomplete.

2B is now authorized under the approved design: integrate the account-bound
coordinator with actual running job/goal/lease/consent checks, fresh own readiness,
private attempt IDs, exact stage slots, known-charge-first settlement and shared
barrier tests. Still no production dispatcher, S2 policy or Task 3 UI work.

Parent wrote the independent 2B coordinator suite against real scoped goals,
domain-generated review jobs, actual running lease rows, real profiles/readiness
and an injected prepared transport (one synthetic known micro-USD, not real
pricing). Its first four bodies **all failed** before implementation: the first
three hit the existing reasoning-only coordinator path, while an uninstalled
low-level coordinator still allowed a decision reservation. This is expected
2B RED, not evidence of a reachable paid decision API. Additional cases now cover
post-mark abort/no refund, raw-consent withdrawal, and actual lease re-reading;
they have not yet been claimed passing. No full Task 2 acceptance is inferred.

The first 2B implementation passed parent/owned coordinator tests at **27/27**,
but remains unaccepted. Parent then reproduced two further publication fences:
an actual lease expiring during I/O did not refuse output after settlement, and
changing the actual job payload to a foreign owner after mark did not stop
pre-I/O permission. Each added parent test failed before repair. The executor
is fixing those while adding the missing same-job prepared decision→reasoning
execution/cumulative-cap and cross-account unknown/reopen/extractive proofs.
Independent 2B code review is running. User's additional **"continue"** keeps
this approved S1 task active; it does not authorize live calls or publishing.

Independent 2B review subsequently found no additional material new defect
beyond those known repairs. Parent reran all **9/9 independent coordinator
checks successfully**, including lease expiry during I/O (known cost retained)
and actual job-principal mutation after mark (I/O denied). The executor still
owes the settled handoff and complete same-job decision→reasoning/cap and
cross-account unknown/reopen/extractive evidence before 2B acceptance. No full
Task 2 or S1 completion is inferred from nine focused checks.

The settled 2B handoff now includes both actual prepared provider calls on the
**same** review job, with separate coordinator/financial rows and one injected
fetch per stage. Parent read the fixtures and strengthened their proof: both
outputs must validate, and each individual reservation bound must fit the shared
cap while settled decision cost plus the reasoning bound exceeds it. This rules
out a false-positive denial caused by the reasoning reservation exceeding the
cap on its own. The strengthened tests passed against existing code; no new
behavioral RED is claimed. The cross-account fixture provisions both accounts
before auditing and records unknown-call denial separately from stale-audit
errors, reopened-handle no-adoption, and the unpaid extractive path.

Parent independently ran **43/43** coordinator/security/consent tests; the
executor then reran **37/37** owned+parent coordinator checks after the final
test strengthening. Parent's fresh typecheck/lint/build passed. A new full
serial suite on this settled checkpoint is running, followed by browser
regression; 2B remains unaccepted until those gates. Reopening a control handle
is not represented as a real worker subprocess restart or scheduled dispatcher.

## Current checkpoint — prepared System 1 adapter accepted locally

DeepSeek implemented the approved immutable one-shot decision contract in
`packages/providers/prepared-decision.ts`. Parent reviewed the source/diff,
added independent adversarial checks, reproduced and verified the cancellation
wording repair, and completed the settled verification on Windows / Node 24.19.0:

| Command                                                                                                                                                                                                                                                                                                     | Actual result                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `npm test -- --maxWorkers=1`                                                                                                                                                                                                                                                                                | **645 passed, 2 POSIX-only skips, 72 files**, 232.28 s |
| `npm test -- tests/integration/prepared-decision.test.ts tests/integration/prepared-decision-review.test.ts tests/integration/system-one.test.ts tests/integration/system-one-review.test.ts tests/integration/prepared-provider.test.ts tests/integration/prepared-provider-review.test.ts --maxWorkers=1` | **164 passed**, 6 files                                |
| `npm run typecheck`                                                                                                                                                                                                                                                                                         | passed                                                 |
| `npm run lint`                                                                                                                                                                                                                                                                                              | passed                                                 |
| `npm run build`                                                                                                                                                                                                                                                                                             | passed                                                 |
| `npm run test:e2e -- --workers=1 --output=test-results/prepared-decision-parent`                                                                                                                                                                                                                            | **19/19 Chromium journeys**, 60.0 s                    |
| `npm run brain-eval`                                                                                                                                                                                                                                                                                        | **4/4 synthetic offline evaluations**                  |
| `npm audit --audit-level=high`                                                                                                                                                                                                                                                                              | zero vulnerabilities                                   |

The two skips are the existing Windows-inapplicable POSIX filesystem checks.
Both tracked browser reference screenshots were restored from pre-run copies
and their SHA-256 hashes match. Dependencies/lockfile, runtime consumers,
workers, activation/profile, monetary storage, schemas and UI are unchanged.
The scoped provider/test credential-pattern scan found no high-confidence
secrets. Independent read-only review found no blocking defects.

**This is a verified adapter dependency, not completed G4 or an end-user model
feature.** It freezes request/config/pricing, bounds one attempt, retains known
charges independently of bad output and refuses forged accounting/no-send
errors. Durable no-resend still requires a future coordinator. Minor diagnostic
classification and duplicated response-parser maintenance limits are recorded
below and in the implementation plan. Model quality, live endpoint/pricing,
managed decision accounting/consent/activation and held-out evidence remain open.

At local acceptance, work was **uncommitted/unpushed** on `feat/system-one-shadow-policy`;
the superseded observation design and prior feature branch are preserved. No
background implementer remains active. No real key, runtime provider call,
account activation, new commit/push/PR, deployment or license change occurred.
The merged-main CI below verifies the earlier Phase 2 base, not this new tree.

### Repository delivery and next-slice authorization

The owner then requested **"go ahead do it in safe order make it fast"** after
the recommendation to commit/open a PR, add decision-stage accounting/consent,
and integrate advisory shadow judgments. This authorizes repository delivery of
the accepted adapter and synthetic-first continuation; it does **not** authorize
merging the PR, spending on a live runtime provider, enabling an owner account or
deployment. Parent will publish the verified checkpoint first and isolate the
next slice on a dependent branch. The next accounting/worker architecture is
being inspected read-only before its design review; no new runtime permission
or wider provider consent is inferred from the existing reasoning profile.

### Adapter published; next design isolated

**PR #3 merge verified:** the owner reported merge/closure; GitHub read-back
confirmed **MERGED** at `658565b364560fce65696b6d2edc6700f30aeff9`
(2026-10-16T19:41:51Z). Parent fetched `origin/main`; its tree exactly matches
published adapter commit `3e9d918`. Merged-main workflow **38956820008** subsequently
**passed** at that exact merge: **647/647 Ubuntu tests, 19 Chromium journeys,
4 offline evaluations**, install/typecheck/lint/build/audit, Docker build,
non-root auth/worker/restart-persistence/origin/backup smoke, Compose and Caddy
validation. Parent read back its completed status and logs, not just PR CI.
At merge verification, the dependent branch differed from main only in the committed
next-design document and its build record, so no redundant merge/rebase/reset
was performed. Both branches and the unapproved design remain preserved.

This merge acknowledgement is **not** written approval of the next schema,
activation or consent changes. Stage-accounting implementation remains paused
at its written-design gate; no live provider or account was activated.

The owner subsequently explicitly said **"Approved"** to the written S1 design.
This approves the synthetic-first schema 3→4 migration (including reasoning
audit staleness), separate decision manifest/readiness, coordinated global stop,
stage-bound accounting and default-false consent. Parent reviewed DeepSeek's
three-checkpoint plan and authorized **Task 1 only**: migration, closed decision
profile/mirror, audit/recovery and strict CLI/global-disable behavior. Plan
corrections include actual schema-version ownership, existing disable/restore
files, stage-guard/coordinator ownership and consent primitives before guarded
accounting tests. DeepSeek is implementing Task 1 under a required test-first RED gate;
no Task 1 completion or acceptance is claimed yet. Parent review precedes each
following checkpoint. No S2 worker dispatcher, real price/key, account activation, paid
runtime call, merge or deployment is included. The merge/approval record and
design status are local changes on `feat/system-one-stage-accounting`.

Task 1 parent tests were written independently before acceptance. The profile
suite first observed a missing-module RED (one failed suite, zero test bodies),
then exposed a canonical-endpoint digest convention mismatch after the module
appeared (40 passed, 1 failed). The persistence suite currently has 3 passed /
5 failed while global-disable and backup/restore integration are still being
implemented. These are in-progress checks, **not a completed Task 1 result**;
the executor has the exact expected atomic-stop and raw UTF-8 endpoint-hash
contracts. No failure is hidden or replaced with simulated success.

Task 1 executor handoff reported the first profile/store/migration/recovery
implementation and passing initial focused checks. Parent reviewed the source
and reproduced **8 failures / 49 passes** in the expanded independent suites:
valid CLI enable flags were rejected; CLI status missed valid-but-different
SQL/mirror profiles; enrollment checked account IDs but missed a configuration
change before its final write lock; event rows could be updated; accepted-model
reordering did not change the fingerprint; and whitespace-only model/price/
accepted-model identifiers were admitted. Repairs and a genuine schema-3 upgrade
test are required before acceptance. Task 2/3 have not begun.

Parent also reproduced the legacy future-schema fixture's unique-key failure
(1 failed, 5 passed): its hard-coded version 4 is now current. Only that fixture
was changed to version 5; this preserves its future-schema rejection purpose,
not a weakening of production validation. No historical v3 fixture was replaced.

Parent reran the pre-commit serial suite: **645 passed, 2 existing POSIX-only
skips, 72 files**, 230.49 s; fresh typecheck/lint/build and staged whitespace/
credential-pattern checks passed. Committed as
`3e9d91877cd70a576942b854dad2132a6ef66f9b`, pushed
`feat/system-one-shadow-policy`, and opened
[PR #3](https://github.com/Rishflips/Bi-Brain/pull/3) against `main`.
GitHub read-back confirmed the exact head and **OPEN** state. PR CI
**38955764822** and push CI **38955746452** were pending at delivery; no success
was inferred. Both subsequently **passed** at the exact published head. Parent
read back completed status and PR logs: **647/647 Ubuntu tests, 19 Chromium
journeys, 4 offline evaluations**, install/typecheck/lint/build/audit, Docker
build/non-root container auth/worker/restart/origin/backup smoke, Compose and
Caddy validation. The adapter branch was clean after publication and was not
merged. This remains synthetic CI/packaging evidence, not live provider quality.

Parent created `feat/system-one-stage-accounting` from that exact commit in the
same worktree, preserving the PR branch. DeepSeek is drafting only the next
stage-specific activation/accounting/consent design. Parent rejected a proposed
coordinator stage flag: the real guard lives in `ManagedSpendingStore`, and the
current provider/endpoint/hash vocabulary permits OpenAI reasoning only. The
next written design must explicitly bind a decision provider and separate
consent rather than reuse reasoning authority. No implementation of that next
design is accepted or underway; written design review precedes code.

The draft is now in
`docs/superpowers/specs/2026-10-17-system-one-stage-accounting-design.md`.
Parent corrected endpoint-digest-only storage (the protected canonical official
endpoint is needed to derive the exact prepared hash), separated decision and
reasoning readiness files, removed a redundant schema marker, and made audit
staleness truthful without rewriting stored enabled/consent values. The proposal
retains a global paid stop, adds separate default-false decision consent and
stage-bound financial guards, and uses no production decision dispatcher in S1.
Its **schema 3→4 migration makes existing reasoning audits stale until an operator
re-audits**; that operational change and the new consent/profile semantics await
written human approval. No next-stage implementation plan or code exists, no
background implementer remains active, and no new branch push or merge occurred.

## Phase 2 merged — repository checkpoint

The owner reported PR #2 merged; parent verified GitHub state **MERGED** at
`4a77894381339a1c2eb68d144b873ef483bc7a55` (2026-10-16T18:07:31Z).
Implementation commit: `f2d9f64022067115cf5d999da27a2f034cd31649`.
PR: https://github.com/Rishflips/Bi-Brain/pull/2

The PR workflow **38941959387 passed** on Ubuntu: **581/581 tests, 70 files,
19 Chromium journeys, 4 offline evaluations**, install/typecheck/lint/build/audit,
Docker build, non-root container auth/worker/restart-persistence/origin/backup
smoke, Compose and Caddy configuration validation. This is synthetic CI and
packaging evidence, not live-provider quality or a deployed host.

The earlier branch-push workflow **38941933259 failed** at
`tests/e2e/app.spec.ts:212`: the existing "Your understanding:" assertion did not
become visible within its 5-second deadline (18/19 browser journeys passed).
The separate PR workflow passed without a source change. A timing-sensitive
failure is consistent with that evidence; its root cause is not established and
no timeout was increased or failure silently reclassified as success.

Merged-main workflow **38944921896 subsequently passed** at the exact merge
commit: **581/581 tests, 19 Chromium journeys, 4 offline evaluations**, fresh
install/typecheck/lint/build/audit, Docker build, non-root container
auth/worker/restart-persistence/origin/backup smoke, Compose and Caddy validation.
Parent read back its completed jobs and logs rather than inferring the result
from the PR run. No live provider or target-host deployment is implied.

### Next milestone — G4 System 1 shadow-policy design

The owner said **"PR merged, continue"**. Parent fetched the merged base and
verified its tree matches the accepted feature commit, then created
`feat/system-one-shadow-policy` from `origin/main` at `4a77894` in the same
isolated worktree. The prior feature branch and the local merge record are
preserved; no stash, reset, deletion or automatic main merge was used.

DeepSeek is drafting only the next architectural design, starting with the
approved advisory/shadow System 1 requirement and the actual current provider,
policy, accounting and evidence/deletion contracts. The current activation
profile admits only OpenAI reasoning, not a new Typesafe/Cloudflare decision
stage. The draft must not silently widen provider consent or monetary authority,
pretend offline judgments are live inference, or let a classification control
capture/dispatch. A new implementation plan/code awaits review and approval of
this next design. No real key, paid call, owner activation, new push, billing,
license change or deployment is authorized by continuing.

### Prepared System 1 adapter — approved narrow continuation (2026-10-17)

Parent declined the proposed rules-only durable observation subsystem: it would
add lifecycle/telemetry work before a real model path exists, and synthetic
fixture comparisons cannot establish model value. The shadow-policy draft is
preserved but superseded. A narrow Astra Medium advisory request failed at the
account sharing usage limit; no advice was returned, credentials were not
changed and no other advisory model was substituted.

The owner then said **"continue"** after the prepared-decision implementation
approval request. Work is limited to a frozen one-shot adapter around the
existing System One transport and synthetic verification. Parent review
clarified the legacy interface mismatch, synchronous missing-price refusal,
actual fetch-boundary disposition and exact accepted-model identity on known
error paths. Parent reviewed the concrete two-task plan; DeepSeek implemented the
adapter and focused synthetic tests. Parent independently wrote the review suite
first and observed a missing-module RED (one failed suite, zero test bodies
executed), not a claimed set of behavioral failures. The executor's own 12 tests
were authored after implementation, so they have no separately observed RED;
this process deviation is recorded rather than described as full behavioral TDD.

Parent read the new adapter and legacy diff, independently reran **125 focused
tests**, then reproduced a cancellation wording defect (**1 failed, 15 passed**):
post-fetch abort retained unknown/attempted accounting but incorrectly said the
request had not been sent. DeepSeek replaced that with neutral cancellation
wording and reused the existing probability-sum tolerance constant. The expanded
parent review suite passed **54/54** across both provider response shapes,
malformed answers/usage, retained known charges, exact model aliases, oversized
response cancellation, ignored-abort deadlines and immutable identities.

The executor reported the repaired focused set at **164 passed**; parent later
independently reran the same six files at **164 passed**. Parent separately
ran `npm run typecheck`, `npm run lint` and `npm run build`; all passed. An
independent read-only reviewer found **no blocking defects**, ran 66 new and 75
legacy decision tests, and checked exact-byte/hash binding, alias accounting,
forged errors and special option IDs. Its non-blocking diagnostic finding is
retained: a response-byte overflow returns `PROVIDER_UNAVAILABLE` in the new
adapter rather than legacy `PROVIDER_INVALID`; both retain unknown/attempted
accounting. Response interpretation/bounded-read duplication remains a
maintenance risk; it is not presented as shared transport execution.

Parent's final serial full suite, browser journeys and offline evaluations
subsequently passed; see the current checkpoint above. The narrow adapter slice
is accepted locally, without granting any new production decision authority.
No worker, activation/profile, monetary ledger, schema, UI, policies, durable
observations or new runtime consumer is authorized in this slice. No live key,
provider request, push, commit or deployment is authorized. Full G4 quality,
accounting/activation and live-shadow gates remain open.

## Phase 2 accepted — final local synthetic checkpoint

Parent ran the settled runtime implementation serially on Windows/Node 24.19.0:

| Command                                                                     | Actual result                                                                       |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `npm test -- --maxWorkers=1`                                                | **579 passed, 2 skipped, 70 files**, 280.66 s after restart-assertion strengthening |
| `npm run typecheck`                                                         | passed                                                                              |
| `npm run lint`                                                              | passed                                                                              |
| `npm run build`                                                             | passed                                                                              |
| `npm run test:e2e -- --workers=1 --output=test-results/final-phase2-parent` | **19/19 Chromium journeys**                                                         |
| `npm run brain-eval`                                                        | **4/4 synthetic offline evaluations**                                               |
| `npm audit --audit-level=high`                                              | zero vulnerabilities                                                                |
| `git diff --check`                                                          | passed; line-ending warnings only                                                   |

The two skips are Windows-inapplicable POSIX case-sensitivity/file-symlink checks in
`managed-epoch.test.ts` and `worker-readiness.test.ts`; independent Windows
junction/readiness-root checks passed. The two tracked reference screenshots
were restored from pre-run copies. `package-lock.json` is unchanged.

These results include default-off operation, one real-adapter synthetic dispatch
settled at seven micro-USD, invalid/missing credential refusal, malformed-output
known accounting, heartbeat beyond the initial TTL during I/O, real CLI disable
with known-charge retention, and two-account unknown-usage/worker-restart
coverage. The strengthened restart test explicitly checks a new ready worker
identity, the original held central call id, retained tenant accounting, and
failed subsequent paid attempts without new holds. The exact new extractive
source is cited after the second account withdraws consent. Parent reran the
entire suite after this test-only strengthening and reran typecheck/lint; no
runtime/UI change followed the passing build and nineteen-journey browser run.

**Phase 2 Tasks 1–3 are accepted locally.** The implementation is default-off:
profile enrollment, deployment opt-in, valid worker installation/readiness,
account policy, consent and fresh financial admission are independent checks.
An unavailable intended paid attempt never becomes an extractive false-success;
marked unknown usage remains held and known cost settles before discarded
output. Supported restore disables activation and changes the epoch; raw
database-plus-marker rollback remains undetectable and unsupported.

The default-off implementation is not live activation: no real provider key,
owner account activation, runtime paid call, hosted TLS, billing or native-client
verification occurred. The current branch remains uncommitted/unpushed. New
Linux CI/container verification requires separately authorized repository
delivery; earlier merged-main CI is historical evidence, not this tree's result.
Windows forced child termination proves restart persistence, not graceful
target-host signal handling. Physical disk-full/power-loss resilience and human
usability remain unverified. Synthetic temporary-directory cleanup can leave
files behind when Windows retains a WAL lock; no deletion is falsely claimed.
No background implementer remains active.

### Repository delivery authorized

The owner explicitly requested **"Push and create a Pull Request"** after the
local acceptance checkpoint. This authorizes committing the Phase 2 work,
pushing `feat/managed-provider-activation` to `Rishflips/Bi-Brain` and opening a
PR against `main`; it does not authorize merging, live-provider activation or
deployment. A final serial suite rerun is the pre-commit gate. Repository/PR
delivery and fresh Linux CI status will be reported separately from local
verification; no passing CI result is inferred in advance.

## Resume history — superseded by the accepted checkpoint above

The owner said: **"hang on at safe point will continue for later"**. No new
implementation or verification runs are authorized until the owner continues.
DeepSeek has been instructed to stop at the next safe file-write/test-cleanup
boundary, preserve all changes and clean up any synthetic child processes.
DeepSeek subsequently confirmed **PAUSED**, with no running commands or synthetic
server/worker/heartbeat children of its own. No unrelated harness processes were
killed. The implementation plan contains its paused handoff.

Preserved branch: `feat/managed-provider-activation`; changes are uncommitted
and unpushed. Last independently accepted checkpoint: Phase 2 Tasks 1/2,
**545 passed, 1 POSIX-only skip, 66 files**, typecheck/lint/build passed.
Task 3 is partially implemented and **not accepted or fully verified**: server,
worker, runtime, consent contracts/UI and readiness files now have local edits.
Do not apply earlier hard-off-entry-point claims to this partial Task 3 tree;
activation is intended to remain default-off, but the current wiring still
needs review. No owner activation, real credential, paid call, push or deployment
was authorized or performed.

On resume: read the executor's pause handoff and the implementation plan; inspect
git status without discarding work; finish Task 3 real-process synthetic tests,
independent consent/readiness review and the two new browser journeys, then run
the settled combined verification. The browser journeys have not been run.

Executor-reported partial Task 3 checks (not independent acceptance): typecheck
and build passed; focused consent/readiness/activation/guard checks reported
56 passed / 1 POSIX skip, and status/consent checks reported 13 passed. Lint
reported `prefer-const` in the two new parent-owned consent review fixtures;
that remains for the parent on explicit resume. The provider preload and
real-process activation suite are not written, long-I/O heartbeat is unproven,
and the full suite/browser gate has not run on the partial Task 3 tree.

The owner subsequently said **"continue and pickup from exactly where we left"**.
Execution is resumed at that precise Task 3 checkpoint; the pause prohibition
above is historical, not the current instruction. DeepSeek is finishing the
synthetic provider preload and real-process activation/heartbeat tests. Parent
corrected the two fixture-only `prefer-const` declarations and owns independent
runtime/consent/readiness, browser and settled full-suite verification. No scope
expansion, real provider access, owner activation, commit, push or deployment is
authorized by resuming.

Resume checks: `npx eslint tests/integration/managed-consent-review.test.ts
tests/e2e/managed-consent-review.spec.ts` passed after the fixture declarations
were corrected. Parent then added a positive availability contract and ran it:
**1 behavior RED, 6 deliberately filtered skips**. The response had capability,
consent, configuration and headroom but still hard-coded `available:false`.
DeepSeek is correcting status/UI truthfulness and verifying readiness-fenced
production sends alongside the unfinished synthetic process tests. Task 3 is
still unaccepted; no combined green claim applies to the current tree.

The first new process test timed out before an extractive brief appeared.
Parent independently reproduced the startup defect without any network call:
`node --import tests/helpers/provider-preload.mjs -e ...` failed with
`ERR_MODULE_NOT_FOUND` (Node treated `tests` as a package), while the `./tests/...`
form loaded successfully. Consequently the initial zero-call missing/invalid-key
cases were not valid safety evidence: their worker could exit before the test's
assertion. DeepSeek is correcting preload resolution, requiring live worker/job
outcome evidence and finishing the first actual known-charge dispatch proof.
The incomplete process matrix remains unverified, not a passing checkpoint.

Parent independently verified the first runtime integration slice after the
preload repair: **44/44 tests in four suites passed**, including the actual
default-off/known-charge process path, consent, readiness and send-guard review.
`npm run test:e2e -- tests/e2e/managed-consent-review.spec.ts --workers=1
--output=test-results/phase2-consent-parent` passed **2/2 Chromium journeys**.
These prove stored-consent preservation/withdrawal and busy-versus-capability
behavior through real HTTP/storage/built UI with synthetic-origin interception;
they are not hosted TLS, live identity or real-provider quality proof.

The remaining runtime process slice is assigned: beyond-TTL heartbeat during
in-flight I/O, live disable with known-charge retention, two-account unknown
usage plus worker restart/no-resend, and malformed-output known accounting.
Parent also updated the older unavailable-spending browser copy assertion to
the truthful deployment-specific wording, preserving its disabled-toggle,
default-off metadata, refused-enable and no-model-name checks. Task 3 remains
unaccepted until the remaining process and final combined checks pass.

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

Baseline G0, local G1/G2, prepared-call accounting/recovery, central money authority, Phase 1 safeguards and Phase 2's default-off activation path are locally verified. Final Phase 2 parent evidence: **579 tests passed, 2 POSIX-only skips, 70 files; 19 Chromium journeys; 4 offline evaluations; typecheck/lint/build and zero-vulnerability audit passed**. The real server/worker process proofs use injected synthetic Responses transport, not a live model. No owner account or real provider is activated. System One transport is locally verified but not routed into processing. Semantic quality, native integrations, billing, live hosting and human release gates remain open. Only disposable synthetic identities were provisioned; no real external account was created, no runtime model was called and no public service was deployed. Phase 2 remains uncommitted/unpushed; the preceding foundation and Phase 1 were merged to main. Open-source licensing remains an owner release decision.

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

| Command                                                                       | Actual result                                            |
| ----------------------------------------------------------------------------- | -------------------------------------------------------- |
| `npm test`                                                                    | **303/303 passed, 36 files**, 149.42 seconds             |
| `npm run typecheck`                                                           | passed                                                   |
| `npm run lint`                                                                | passed                                                   |
| `npm run build`                                                               | passed, 18 modules                                       |
| `npm run brain-eval`                                                          | **4/4 synthetic offline cases**                          |
| `npm run test:e2e -- --workers=1 --output=test-results/final-dispatch-parent` | **16/16 Chromium journeys**                              |
| `npm audit --audit-level=high`                                                | zero vulnerabilities                                     |
| `git diff --check`, `git diff --cached --check`                               | passed; unstaged check reports line-ending warnings only |

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

| Command                                                                            | Actual result                                            |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `npm test -- --maxWorkers=1`                                                       | **396/396 passed, 49 files**, 136.20 seconds             |
| `npm run typecheck`                                                                | passed                                                   |
| `npm run lint`                                                                     | passed                                                   |
| `npm run build`                                                                    | passed, 18 modules                                       |
| `npm run brain-eval`                                                               | **4/4 synthetic offline cases**                          |
| `npm run test:e2e -- --workers=1 --output=test-results/final-managed-money-parent` | **17/17 Chromium journeys**, 59.8 seconds                |
| `npm audit --audit-level=high`                                                     | zero vulnerabilities                                     |
| `git diff --check`, `git diff --cached --check`                                    | passed; unstaged check reports line-ending warnings only |

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

| Command                                                                                | Actual result                                       |
| -------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `npm test -- --maxWorkers=1`                                                           | **478 passed, 1 skipped, 60 files**, 129.57 seconds |
| `npm run typecheck`                                                                    | passed                                              |
| `npm run lint`                                                                         | passed                                              |
| `npm run build`                                                                        | passed, 18 modules                                  |
| `npm run brain-eval`                                                                   | **4/4 synthetic offline cases**                     |
| `npm run test:e2e -- --workers=1 --output=test-results/final-activation-phase1-parent` | **17/17 Chromium journeys**, 59.0 seconds           |
| `npm audit --audit-level=high`                                                         | zero vulnerabilities                                |

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

### Repository delivery completed — PR #1

Phase 1 implementation was committed as **`b3f885b`** and the full
`feat/managed-suite-foundation` branch was pushed to the private official
repository using the authenticated `Rishflips` account. Remote readback confirmed
the implementation commit. Pull request **[#1](https://github.com/Rishflips/Bi-Brain/pull/1)**
is open against `main`, with the verification evidence, full-branch scope and
remaining release/trust gates in its description. No PR template existed and no
duplicate open branch PR was found.

GitHub's `Verify release candidate` checks were **in progress** when the PR was
created; no CI success is claimed here. The branch and OpenCode worktree are
preserved for review. This documentation-only delivery record follows the fresh
478-pass pre-commit run. No merge, production activation, deployment or paid
provider call was performed.

### Merged-main follow-up — controlled activation design started

The owner merged PR #1; GitHub readback confirmed `main` merge commit
**`5dd6ed0`**. The owner then requested **"proceed to next"** after the proposed
controlled-provider activation sequence. A new local branch,
`feat/managed-provider-activation`, starts from fetched `origin/main` at that
merge commit in the existing isolated OpenCode worktree. The earlier feature
branch and the separate Desktop checkout remain preserved; no reset, rebase or
cleanup was performed.

Merged-main CI run **38889855879** was still in progress at the initial check:
Ubuntu dependency install/audit, typecheck, lint, tests, build and offline
evaluations had succeeded; browser tests were running and container steps had
not started. A background `gh run watch --exit-status` is awaiting its result.
This is partial CI evidence, not a green Linux/container release claim.

DeepSeek is drafting a Phase 2 shared server/worker activation design in
`docs/superpowers/specs/2026-10-16-managed-provider-activation-design.md` for
parent and human review. No implementation plan or production code has changed.
The design must distinguish capability, user consent and per-call admission;
preserve unknown-use/restore blocks; avoid invalidating a call's own audit or
consent mid-dispatch; and prove the actual entry-point path with a synthetic
provider before any separately authorized capped live smoke test. Production
paid processing stays off; no deployment, provider call or external account is
authorized by this design task.

### Merged-main Linux/container CI — passed

The CI watcher completed successfully. GitHub readback confirms
[run 38889855879](https://github.com/Rishflips/Bi-Brain/actions/runs/38889855879)
at **`5dd6ed0`** passed on the fresh Ubuntu runner. Logs show **479/479 tests,
60 files, 72.09 seconds**, including the POSIX case skipped locally; **17/17
Chromium journeys** in 43.8 seconds; and **4/4 offline evaluations**. Install,
dependency audit, typecheck, lint and production build passed too.

The same run passed Docker build and `scripts/container-smoke.mjs`: non-root
startup, Git vault, owner authentication, worker preparation, retained
session/source after container restart, origin denial and SQLite backup.
Compose configuration and Caddy configuration validation passed. These are real
Linux/container packaging results, not live hosted DNS/TLS, managed provider
quality, target-host power-loss/graceful-shutdown or human-usability evidence.
No CI repair was needed and no live service was deployed. This supersedes the
initial pending-CI status above without changing its historical timing.

Parent review of the Phase 2 draft requested corrections before human approval:
separate worker bootstrap from readiness consumption; distinguish installed
provider capability from momentary one-inflight admission; always permit consent
withdrawal; and never describe a persistent environment flag as fresh per-boot
approval or a rollback detector. SQL and marker-file writes must use explicit
fail-closed mismatch handling rather than claim cross-store atomicity. Ordinary
restart, supported restore disablement, exact slot-aware ongoing audit validation
and readiness during long calls must have separate testable rules. The draft is
being refined; no Phase 2 implementation is approved or started by this review.

The [Phase 2 provider activation design](docs/superpowers/specs/2026-10-16-managed-provider-activation-design.md)
is now written and parent-reviewed, **awaiting human approval**. Recommendation:
one explicit operator profile and deployment opt-in, shared by server/worker;
worker bootstrap independent of its readiness lease; fixed provider endpoint;
financial audit at enrollment plus exact slot-aware send guards; consent always
withdrawable; and immediate operator disablement. A supported restore disables
activation and clears readiness; an ordinary restart can retain an explicitly
enabled profile. A persistent opt-in is not a fresh boot challenge, and a raw
whole-root clone is not detectable by this design. Parent review also clarified
that unavailable work creates no new financial hold before actual admission and
that enrollment binds provider configuration and financial audit evidence
separately. No implementation plan, runtime change, owner-account activation or
paid smoke test has begun. The green Linux/container CI evidence and corrected
operator/release documentation are being checkpointed locally with this draft;
no push or deployment is part of this design checkpoint.

The owner subsequently **approved** the written Phase 2 design. Implementation
planning is authorized on `feat/managed-provider-activation`, starting from local
design checkpoint `5b63e19` and merged-main `5dd6ed0`. DeepSeek will execute
reviewed vertical slices; parent owns independent verification. Existing owner
accounts remain inactive, only synthetic provider transport may be used during
verification, and no real key, paid call, push or deployment is authorized.

Planning review is checking two integration hazards explicitly: prepared-call
`config_hash` and activation `config_digest` have distinct canonical inputs and
must not be compared as if identical; and stored consent must remain revocable
without being silently rewritten by an effective disabled preference response
or an unrelated settings save. Fresh branch `npm run typecheck` and
`npm run lint` passed before any Phase 2 source edits. The runtime entry points
still enforce the Phase 1 default-off boundary while planning proceeds.

Parent added `managed-activation-profile-review.test.ts` from the approved pure
profile contract before implementation. Its first run is **RED at module import**
because `packages/domain/managed-activation.ts` does not exist yet (zero test
bodies executed); this is not a claim that nine behavior assertions failed.
The tests require recomputed, distinct provider-config/enrollment digests and
reject unbound price edits, secrets, arbitrary endpoints and invalid numerical
limits. The plan executor must preserve this parent-owned suite.

The Phase 2 implementation plan is written and parent-reviewed. **Task 1 only**
is assigned: closed profile validation, schema 3, exact SQL/mirror persistence,
read-only policy loading, offline activation CLI and supported-restore
disablement. Server/worker entry points remain hard-off in this task. Parent
review corrected a collision with the existing `managed-activation.test.ts`,
required fresh final-version fingerprints and exact audit digest binding,
removed caller-supplied profile overrides from authority, and separated future
worker credentials/readiness from server policy checks. Task 2 send guards and
Task 3 runtime/UI integration are not handed off. The parent's future-schema
audit fixture now uses version 4 so it remains newer than the planned schema 3;
its stale-schema assertion is unchanged.

Parent added `managed-activation-policy-review.test.ts` before Task 1
implementation. Its first run failed at the missing storage-module import
(zero test bodies executed). The six independent contracts cover opt-in-only
denial, exact offline enrollment/CAS, current configuration and mirror tampering,
historical caller-profile override after disablement, mirror publication failure
and cold restore forcing activation off while excluding ephemeral readiness.
These are pending implementation checks, not passing behavior claims.

Task 1 executor delivered schema 3, pure profiles, matched SQL/mirror storage,
read-only policy loading, activation CLI and restore disablement without changing
runtime paid wiring. Parent independently ran six suites: **43/43 passed**. Its
expanded policy review then reproduced **3 failures in 9 cases**: enrollment
accepted unknown legacy history added after a clean audit, the row reader
silently substituted schema 1 for an unsupported stored schema, and disabling
an absent profile recursively deleted an unrecognized marker directory. DeepSeek
is repairing all three plus the final-lock enrollment freshness check and
content-free CLI failures. Task 1 is not yet accepted; Tasks 2/3 are unassigned.

A tenth independent policy case reproduced the enrollment freshness race using
a second real SQLite connection: account policy changed between validation and
the final write-lock acquisition, but the enabled profile still committed.
The expanded review run observed **4 RED / 6 GREEN**. The executor is now
repairing this with an in-transaction authoritative recheck rather than relying
on the offline acknowledgement to stand in for freshness.

### Phase 2 Task 1 — independently accepted (local, synthetic only)

DeepSeek repaired all four review failures. Enrollment now performs the full
bounded terminal audit before taking the write lock, then rechecks the exact
epoch/root marker, schema, chosen audit digest and central configuration/history
inventory under that lock. Stored profile schema is validated as stored; unknown
marker directories are left intact. SQL commits before mirror publication and
any mismatch still denies capability.

Parent actually ran, serially:

- The six focused activation/audit review suites: **52/52 passed**.
- `npm test -- --maxWorkers=1`: **520 passed, 1 POSIX-only skip, 64 files**, 210.43 s.
- `npm run typecheck`, `npm run lint`, `npm run build`: passed.

Task 1 is accepted as the local policy/persistence/operator/recovery foundation,
not production activation. No server, worker, provider or UI paid entry point
changed. The cheap enrollment-baseline loader does not yet prove ongoing tenant
mapping; the next send-guard slice must supply that proof. Task 2 is being
expanded from planning notes into concrete TDD steps for parent review before
implementation. Task 3 is not assigned. Browser and live-provider verification
are not claimed by this Task 1 checkpoint; no real key, owner activation, paid
call, commit, push or deployment occurred.

### Phase 2 Task 2 — guarded dispatch in progress

Parent approved the refined Task 2 plan after requiring exact private attempt
IDs (null is never a wildcard), phase-specific nonterminal tolerance, a final
pre-I/O activation check, frozen-profile comparison, compared double scans and
both central/tenant baseline digests. Cycle-free read-only activation state is
shared by the money transaction and runtime helpers; no tenant scan may run in
the money transaction. Production main entry points remain hard-off.

Parent migrated its existing positive ambiguity review to real synthetic
enrollment and a real prepared identity with a dummy credential and denied
network transport; the unchanged six behavior assertions passed before Task 2.
Its new seven-case `managed-activation-guard-review.test.ts` covers missing
profiles, sequential known calls, cross-account legacy history, forged model
identity, post-mark mirror loss, disable during I/O, and tenant-only baseline
edits. Initial runs exposed planned guard gaps; runs while implementation is
changing are not a settled pass/fail checkpoint. DeepSeek is implementing Task 2
only; parent owns review fixtures and the final rerun. Task 3 remains unassigned.

The Task 2 executor delivered and parent independently reran seven suites:
**51/51 passed**. Further code review produced four additional **behavior REDs**
in the expanded eleven-case independent guard suite (**4 failed / 7 passed**):
an already-expired job lease still created a central hold; expiry inside the
tenant dispatch mark still permitted I/O; a fresh coordinator could mark an
older coordinator's reserved call by knowing its id; and a changed schema shape
was accepted while its integer version stayed 3. DeepSeek is repairing actual
lease checks before admission/after marking, original private attempt ownership,
and enrollment schema-shape binding. Parent also requires strict complete
account/spec/phase matching inside the money transaction. Task 2 is not accepted;
entry-point paid processing remains off and Task 3 is not assigned.

After those repairs, parent independently reran seven suites: **55/55 passed**.
Final reservation-boundary checks found two remaining omissions: the reserve
transaction matched scope/config but not every immutable identity field, and the
coordinator could insert a hold for job B before rejecting a lease for job A.
The expanded independent suite observed **6 RED / 11 GREEN** (five identity-field
substitutions plus the cross-job lease). DeepSeek is closing these two narrow
checks before a settled full-suite gate; prior repairs remain green.

### Phase 2 Task 2 — independently accepted (local, synthetic only)

DeepSeek closed full reservation identity matching and lease-to-job binding.
The send path now binds the frozen installed profile, exact per-coordinator
attempt IDs/spec/original lease owner/fence, current tenant lease and audited
schema shape. The money transaction rechecks the complete guard against live
SQL/mirror/root epoch and central inventory without opening tenant databases.
The final pre-I/O check retains marked holds on refusal; known settlement happens
before a changed activation policy can discard output.

Parent actually ran `npm test -- --maxWorkers=1`: **545 passed, 1 POSIX-only skip,
66 files**, 222.53 s; `npm run typecheck`, `npm run lint`, `npm run build` passed.
This includes the expanded seventeen-case independent guard suite and preceding
accounting, ambiguity, audit, recovery and local behavior. Task 2 is accepted.
Server/worker main entry points remain hard-off; there is no live-provider or
public-host proof. Task 3 runtime/readiness/consent planning is now assigned for
parent review before code. No real credential, paid call, owner activation,
commit, push or deployment occurred.

### Phase 2 Task 3 — runtime integration in progress

Parent approved the concrete runtime/readiness/consent plan with corrections:
normal future lease expiry remains valid within the 15-second TTL; the shared
runtime derives capability from the current profile plus an exact fresh worker
lease; no-ready bootstrap uses an explicit unavailable provider; omitted consent
keeps the raw stored value even during a durable block. Durable-block re-enable
denial is preserved, while explicit withdrawal is always allowed for an active
authorized account. Worker installation is frozen per boot; heartbeat and
shutdown are independent of provider completion. Only synthetic transport may
be used; real owner activation and paid verification are not authorized.

Parent added seventeen independent readiness contracts. Their first run observed
**16 GREEN / 1 behavior RED**: readiness reading followed a managed-root junction.
DeepSeek is repairing reader/writer/cleanup containment. Six new independent HTTP
consent cases were written; an intermediate run during source edits encountered
the not-yet-exported runtime capability helper and is not a settled behavior
checkpoint. Two new browser consent journeys are written but **not yet run**.
They exercise actual SQLite/HTTP/built UI using synthetic-origin interception
and explicitly synthetic liveness records, not real worker or hosted TLS proof.
The executor owns actual server/worker subprocess verification with injected
synthetic provider transport; parent owns the final browser/full-suite gates.

## Independent deployment and ship audit — 2026-10-07

The owner canceled ChatGPT Sites hosting. This supersedes the Sites migration plan below: no more Site publications, D1/R2 port or hybrid hosting work. The separate `sites-port/` probe checkout is preserved and ignored by parent Git/lint/Docker. On 2026-10-07 the owner explicitly requested and confirmed permanent deletion of the existing Bi Brain Site (`appgprj_6abc0b1d098c8191a74d673cec5862bc`). Deletion is verified: the owner Sites list shows “No sites yet,” `get_site` returns “Sites project not found,” and the former publication URL returns “404 Not found / No site here.” No new Site deployment occurred. Before deletion, `get_site` reported no linked automations. Local application data and official GitHub source are intact. Historical Sites evidence below is not the current deployment plan.

The full app now has a single-owner HTTPS deployment profile: one validated public origin, exact Host/Origin checks, Secure owner cookies, HSTS, unchanged shared grant authorization, and a local stdio adapter that can call trusted HTTPS without following redirects. Docker includes required Git/CA certificates, a private allowlisted build context, nonroot execution and liveness. The supervisor awaits child shutdown; persistent-volume HTTPS Compose/Caddy and a pinned-action Linux CI template are added. SDK/source-map advisory fixes are locked; final npm audit reports zero vulnerabilities. Owner data, permissions, licensing and monetization are unchanged.

| Ship gate                       | Status                                      | Evidence / remaining limit                                                                                                                                                                                             |
| ------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| HTTPS configuration/auth/grants | Verified locally                            | Four new deployment regressions: capture/auth/sign-out, Host/Origin/CSRF denial, private filtering/revocation, invalid setup and adapter URLs. This is transport-contract injection, not a deployed TLS server.        |
| Existing suite/truth/deletion   | Verified locally                            | 65/65 tests in 12 files, typecheck/lint/build, 4/4 offline evals, 8/8 real API/worker Chromium journeys. Paid calls: zero. Temporary Git permissions required approved outside-sandbox tests/eval/browser execution.   |
| Container/fresh Linux packaging | CI template delivered; installation pending | The supplied workflow template builds the image, requires Git history, owner auth, worker output, capture/session persistence after restart and SQLite backup, validates Compose/Caddy. Docker is absent locally.      |
| Operator handoff                | Delivered                                   | [SELF_HOSTING](docs/SELF_HOSTING.md), [ship audit](docs/SHIP_AUDIT_2026-10-07.md), [deployment-agent prompt](prompts/DEPLOY_OWN_SERVER.md). Database-only backup is distinguished from full Git/quarantine recovery.   |
| Live self-hosted release        | Open                                        | Owner supplies one always-on persistent host/domain. Prove trusted TLS, reboot persistence, private ports, restore/deletion barriers and actual native clients before owner data. Nothing deployed by this checkpoint. |
| Full harness/local V1           | Open                                        | Prior S1–S7 live model, native two-client, semantic/calibration, crash/disk-full and human gates remain open. Passing packaging does not close them.                                                                   |

Checks actually run: `npm run typecheck`, `npm run lint`, `npm test` (65/65), `npm run build`, `npm run brain-eval` (4/4 synthetic offline), `npm run test:e2e -- --workers=1` (8/8), `npm audit --audit-level=high` (zero vulnerabilities), `git diff --check`. Browser-generated screenshots were restored; no product UI change is included. Initial sandbox Git-write/DNS failures and the caught empty pairing-code fallback are documented in the audit. GitHub rejected Actions workflow creation because the saved credential lacks workflow scope. The pipeline is preserved as deploy/github-verify.yml for the operator to install; no CI run or Docker result is claimed. The application checkpoint is pushed separately from workflow installation.

Application/deployment checkpoint **`ad35584`** was committed and pushed to official `origin/main` on 2026-10-07 using the existing command-scoped Rishflips credential. This is a repository delivery, not a live-host release. The unrelated licensing memo remains untracked and unchanged. No app data, credential files, private backup or nested Site checkout is tracked in this checkpoint.

## Sites production handoff — 2026-09-30

P0 is verified in the local edition. Approved agent intentions now retain source lineage; permanent forgetting sanitizes their copied text in current goals and collapsed goal revisions while preserving later owner edits. Evidence-backed plans still clear when their evidence is forgotten. The managed proof now checks retained derived text and Git-history text as well as source IDs. A regression covers propose → approve → update → owner edit → forget → export → rebuild → restart and retained vault history. This is a local managed-store proof; previously transmitted copies and unmanaged backups remain outside its scope.

P0 checks actually run: `npm run typecheck` passed; `npm run lint` passed; `npm test` passed **61/61 in 11 files**; `npm run build` passed; `npm run brain-eval` passed **4/4 synthetic offline cases**; `npm run test:e2e -- --workers=1` passed **8/8 Chromium journeys**. The full test and browser runs needed the approved outside-sandbox execution because this Windows sandbox returned `ENOMEM` from Node `os.userInfo()` before `tsx` started; this was reproduced with a direct Node call. A final test-only assertion was added after those full runs and passed in the focused vault test.

P0 checkpoint `d8ca193` was pushed to the official `origin/main` after selecting the existing Rishflips Git Credential Manager account for that command. The local license memo and owner data remain untouched.

P1 has a separate portable Sites checkout at `sites-port/` and a registered owner-private Site, `appgprj_6abc0b1d098c8191a74d673cec5862bc`. Its current isolated source commit `11b5fc8f1193de7daf1883accf1a7eab43f0ffd0` was pushed to the Site source repository; private deployment `appgdep_6abcd7eb30d0819198fa80b179978da4` succeeded with environment revision 2 at `https://bi-brain-private-gowrishankar.saasage-in.chatgpt.site`. This publication is explicitly a **runtime compatibility probe**, not a migrated Bi Brain suite or a V1 production release. It has a synthetic-only D1/R2 round-trip UI and one read-only HTTP MCP probe tool; no owner knowledge was uploaded.

| P1 capability          | Actual evidence                                                                                                                                                                                                                                                                       | Gate                                                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner-private audience | `get_site` reports a custom allowlist with only `saasage.in@gmail.com`; signed-in `gowrishkar@gmail.com` received platform 403. A fresh Saasage login reached the app, and the app-level owner check now admits only the trusted dispatch email configured as `BI_BRAIN_OWNER_EMAIL`. | Owner login and different-account platform denial verified. App-level denial after the email fix is code-checked but was not re-run with a second signed-in session. |
| D1                     | Production `read_database_overview` lists `DB` and `capability_probe`. The owner browser created synthetic record `6c689103-23a0-4536-8076-e8bf083fd6b9`; `read_database_table_rows` returned the matching owner, object key, checksum and timestamp.                                 | Hosted D1 write/read verified.                                                                                                                                       |
| R2                     | The owner browser showed matching D1 and R2 readback for the same synthetic record, then repeated the read successfully after a page reload. The route checks the R2 object SHA-256 against the D1 checksum.                                                                          | Hosted private object put/get and reload readback verified for a small synthetic payload.                                                                            |
| HTTP MCP               | Private deployment reports `has_mcp: true`; `get_site` returned the Site-provisioned MCP URL and plugin ID. The Bi Brain plugin installation was suggested again after owner login.                                                                                                   | Native connected-client discovery/call remains unverified. Published tool is only a scoped probe, not the suite's eight tools.                                       |
| Unattended work        | Sites 0.1.75 instructions describe linked schedules, but the callable inventory still has no `create_schedule` action and `get_site` omits the linked automations list.                                                                                                               | Supported unattended caller and fresh writer receipt remain unproven. Do not claim background operation.                                                             |

The first Saasage browser session was admitted by the platform but denied by the app's user-ID equality check; the request's user ID was not measured. The app now checks the dispatch-provided owner email, behind the platform's owner-only allowlist; this passed the live owner session. Keep the Site owner-private. P1 is **partially proved**, not passed: native MCP use and unattended execution remain open. Under the handoff's P1 exit rule, P2–P6 remain open. The local Git-backed vault remains the reference for literal `git revert`; hosted revision semantics are undecided. The owner confirmed on 2026-09-30 that no always-on server with persistent disk and HTTPS is available for a hybrid backend, so literal hosted Git history and unattended jobs have no verified deployment path. Do not import owner data into the probe or widen access to work around this gate.

## Build review F1–F5 repairs — 2026-09-29

All five findings in `docs/BUILD_REVIEW_2026-09-29.md` are repaired in the local application. This supersedes the older 55-test/5-browser evidence below. No owner knowledge was migrated or deleted, and agent grant/project checks remain in the shared service.

| Finding                    | Verified behavior                                                                                                                                                                                                                                                                                                                                          | Remaining limit                                                                                                                                                        |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1 unsupported auto-commit | Auto-admission now requires an entire exact structured `entity status/count/deadline value` assertion. Negation, quotations, wrong entity, substring matches and other prose queue with raw retained. Numeric confidence is `0` (unrated), not a fabricated calibrated score.                                                                              | No evaluated semantic entailment or calibrated classifier. Owner review remains necessary for natural language.                                                        |
| F2 stale issued packs      | Pack hashes bind visible claim IDs/versions/validity, identity revisions, open-intent state, source versions and deleted-source state. Validation after retirement, conflicting acceptance, intent closure or validity change fails before continued use.                                                                                                  | Native client pre-action enforcement remains unverified; the tested local wrapper enforces this contract.                                                              |
| F3 validity                | Default current pages, search, answers and packs use accepted claims only while `valid_from <= now < valid_to`. Invalid intervals are rejected, queued review preserves the proposed interval, and explicit historical search labels out-of-window claims as history.                                                                                      | Validity describes accepted source assertions, not independent real-world verification.                                                                                |
| F4 agent intents           | Typed agent propose/update/close requests retain target and expected version. Owner approval creates a preparation-enabled goal or atomically updates/closes the targeted goal; stale versions fail. Private/quarantined proposals cannot become shared intentions. The GUI offers intention approval and a deterministic test checks scheduler admission. | A prepared next step still needs relevant evidence and, for live reasoning, configured provider credentials.                                                           |
| F5 capture/import          | Ordinary save and folder import queue source-linked candidates for exact status lines. An owner can select an exact passage from arbitrary prose and propose a status claim from the existing source. Review produces current pages, search/answer results and authorized agent packs.                                                                     | Automatic candidate extraction is intentionally narrow; arbitrary prose needs the owner's passage selection. Other claim aspects do not yet have this direct GUI form. |

Final checks actually run: `npm run typecheck` passed; `npm run lint` passed; `npm test` passed **60/60 in 11 files**; `npm run build` passed; `npm run brain-eval` passed **4/4 synthetic offline cases** and wrote `data/brain-eval-results.json`; `npm run test:e2e` passed **8/8 Chromium journeys** against the production build, including capture-to-current-truth, owner-selected prose promotion and intention approval. After a final private-intent guard, all 60 tests and build/eval passed again and the intention browser journey passed 1/1. The first expanded browser run hit the global local-UI polling limit; its guard was raised from 300 to 1000 requests/minute while the separate pairing limit remains 10/minute, then the full suite passed. A validity-pack test initially crossed the pack's 20-minute expiry and was corrected to test the boundary within that expiry; a Git vault test received a 20-second Windows allowance. These are local deterministic/browser results, not live-provider, native two-client, fresh-machine or human-pilot evidence. No deployment or new push is claimed for these repairs.

## Owner-directed harness build (SOL6_HARNESS_AND_SUITE_BUILD)

This section supersedes the older M0–M6 status below for the new suite/harness request. The older table records the prior local preview and is historical evidence, not proof that the new harness is complete. Current work is **not a completed harness V1**. The harness implementation commit `d2f3acb` was pushed to official `origin/main` on 2026-09-29; no hosted deployment has been made.

| Gate                              | Current status                               | Evidence and limit                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S0 Baseline/design                | Verified                                     | Existing `npm test` passed 29/29; three review regressions remained fixed. [Harness authority ADR](docs/HARNESS_AUTHORITY_ADR.md) inventories gaps, authority, threat boundary, eight-tool contract and dependency order.                                                                                                                                                                                                                                                                     |
| S1 Vault/evidence/deletion        | Core verified locally; full gate open        | Portable filesystem generations, immutable raw versions, protected quarantine, bounded scanner, journal recovery, managed local Git, writer lock, backup/migration/rebuild/rollback, tombstones and resumable managed-history purge. Tests cover capture/rebuild, injected publish failure, migration/rollback, secret fixtures, interrupted purge and restore barrier. Exhaustive crash points, disk-full and every credential format are unverified.                                        |
| S2 Claim ledger/gate              | First slice verified; gate open              | Typed claims, validity, literal offline admission, idempotent propose, queue for identity/decision/conflict, owner review, retirement and current-first retrieval pass integration/eval checks. Confidence is a deterministic syntax score, **not calibrated**. Semantic conflict/multi-source quality remain open.                                                                                                                                                                           |
| S3 Suite workspaces               | Browser verified; human gate open            | Your brain displays real claims, evidence, history and review; Connections previews project handoff/import. Hash navigation, local project/theme persistence and deletion-proof UI are implemented. Browser 5/5 passed on the current production build, including keyboard/responsive checks. Human first-use and broader accessibility review remain open.                                                                                                                                   |
| S4 Eight tools/binding/handoff    | SDK/local wrapper verified; native gate open | Exactly eight MCP tools are grant-filtered; SDK/HTTP test covers read-only discovery, direct write denial, full grant, correction and revocation. Bounded local wrapper demonstrates pack-only use and pre-action revocation. Project handoff and explicit identity-field disclosure are stored and previewed. No two-native-client or enforced client session adapter evidence; MCP remains cooperative/manual.                                                                              |
| S5 Dream reasoning/intent/revert  | Local behavior verified; live gate open      | Opt-in structured Responses goal preparation is wired into the budgeted worker with source validation, owner-activity cancellation before dispatch/publication, receipt metadata and daily vault Markdown. Fake-provider race, restart-safe one-ping-per-local-day, due/review timing, and guarded latest-commit `git revert` pass tests. Offline extractive fallback is labeled. No live key/pricing/quality evidence; non-head conflict resolution and richer intent semantics remain open. |
| S6 Forget proof/evals             | Managed scope verified; full gate open       | Purge replaces managed pre-migration backup, sanitizes managed Git history and returns/persists an operation ID plus read-after-delete file/index/embedding/edge checks. Interrupted purge can be finalized. `npm run brain-eval` passed 4/4 versioned offline fixtures and writes `data/brain-eval-results.json`. Unmanaged backups/transmitted copies and broader live/native adversarial coverage remain open.                                                                             |
| S7 Folder/chat adapters/packaging | Local adapters verified; pilot open          | Connections previews/imports selected or dropped text/Markdown folders and JSON conversation arrays through bounded path/size parser and checkpoint; browser chat journey passes. CLI skips symlinks and unsupported attachments with warnings. No installed-folder watcher, clean-machine or human pilot evidence.                                                                                                                                                                           |

Current combined verification: `npm run typecheck` and `npm run lint` passed; `npm test` passed 55/55 in ten files; `npm run build` passed; `npm run brain-eval` passed 4/4 offline fixtures; `npm run test:e2e` passed 5/5 against the current production build. A sandboxed test run failed because Node's `os.userInfo()` was denied with `ENOMEM`; the same suite passed outside the sandbox, where a standalone `os.userInfo()` diagnostic also succeeded. Focused vault tests passed 12/12 before the combined run. This is local synthetic/offline verification, not a real model, native two-client, clean-machine or human result.

The tracked screenshots in `docs/screenshots/` were regenerated by browser tests and restored before saving this change. The harness implementation is saved in Git and pushed to the official repository; no hosted deployment has been made.

## Current reality

Working single-owner local preview: React/Vite GUI, Fastify API, persistent Node 24 SQLite, separate durable worker, and official-SDK stdio MCP adapter. Real user capture is retained before derivation. No provider key is required for labeled extractive previews. Today, Your brain, Connections, and Save something are implemented.

This is the local V1 implementation with explicit verification gaps, not a fully verified Local V1 release or a public hosted service. No pricing page or commercial billing was implemented. The owner's screenshot of the older pricing page cannot be traced without its URL; no deployment or pricing update is claimed.

## Milestones

| ID  | Deliverable                     | Status                                           | Evidence / remaining gate                                                                                                                                                                                 |
| --- | ------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0  | Runnable foundation             | Verified locally                                 | Exact lockfile, offline npm ci, migrations, health, auth/session, build/typecheck/lint; Git initialized with official origin; lockfile and implementation saved in local Git commit                       |
| M1  | Persistent capture and Continue | Verified locally                                 | Arbitrary text/file capture, evidence, edited understanding, clipboard, Markdown download, restart persistence, error retention; isolated labeled demo                                                    |
| M2  | Knowledge lifecycle             | Verified locally                                 | Source versions, correction/stale context, scoped full-text search, withdrawal/purge including accepted plans/history, portable preview/import/export, conflicts and deduplication                        |
| M3  | Durable reasoning               | Deterministic gates passed; live gate unverified | Leases, recovery, cancellation/fencing, atomic reservations, accounting, schema/reference checks; real Responses adapter requires legitimate key and operator-verified prices                             |
| M4  | Goal preparation and review     | Verified extractive workflow                     | Opt-in, relevant-evidence hypothesis, edit/accept/compensating undo, later-edit conflict comparison, snooze/dismiss/history, pause/quiet hours/DST/catch-up; no live contradiction-quality claim          |
| M5  | Agent access                    | SDK transport verified; native gate unverified   | Five tools over real stdio/HTTP, fresh SDK sessions, scoped remember/recall/correction/private denial/revocation; SDK 1.30.1. Native Codex and second client not run                                      |
| M6  | Local operations                | Local checks passed; external gates unverified   | Supervised production processes, migration integrity, actual CLI backup/restore/tombstones/revoked restored credentials, browser/keyboard/responsive checks. Docker/fresh machine and human pilot not run |
| H1  | Managed private beta            | Deferred                                         | Hosted identity, connectors, billing, license and public launch are outside this local delivery                                                                                                           |

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

## Current verified checkpoint — consumer memory and native-client readiness (2026-10-19)

BiBrain now makes a narrow, deterministic review suggestion when a saved public
note contains exactly one clear statement shaped like “X is Y”, “X will be Y”,
or “X uses Y”. Plain decisions such as “We decided that beta pricing is paid”
remain pending until owner approval. The extractor preserves the full sentence
and Unicode code-point range, declines questions, conditionals, vague pronouns,
discourse-prefixed/comma subjects and ambiguous multi-statement notes, and never
changes current truth on its own. Accepted changed statements use the existing
cited correction/history/compensating-undo path.

From an open original, the owner can now teach a status, fact, decision, rule or
hypothesis from an exact passage. If an automatic suggestion exists for that
identical evidence, the owner-taught meaning replaces it as the only pending
card. Duplicate current meanings are refused. The review UI explains automatic
versus owner-supplied meaning in plain language; initial approval is not mislabeled
as a correction. Pending meaning remains invisible to agent answers until review.

Native connection readiness is documented without changing global client state.
`.codex/config.toml.example` is a token-free project template that forwards
`BRAIN_AGENT_TOKEN` and `BRAIN_API_URL` from the local environment. Claude Code
uses a project-local connection. `docs/NATIVE_CLIENT_SETUP.md` documents setup,
removal and the required synthetic fresh-session recall/correction/privacy/
revocation proof. Installed clients were inspected read-only: Codex CLI 0.156.1
and Claude Code 2.1.283. No native model session was started, no subscription or
API allowance was consumed, and configuration readiness does not close G6.

**Actual verification on this branch:** `npm run typecheck`, `npm run lint`,
`npm run build`, and `git diff --check` passed. Focused memory/correction/MCP
integration ran **17/17** before the overlap repair; the final affected
memory/correction integration ran **17/17**. The final complete Chromium run
passed **47/47** in 3.7 minutes. `npm run brain-eval` passed **4/4** deterministic
offline fixtures after the sandboxed attempt's disposable Git initialization was
denied by Windows temp permissions. The broad Vitest run exercised 1,501 cases:
**1,492 passed**, **8 platform-specific skips**, and one unrelated managed
advisory-worker case exceeded its 30-second timeout under full-suite load; the
complete file then passed **19/19**, including that exact case in 4.1 seconds.
The first sandboxed focused run was not counted because Windows transform/temp
access produced ENOENT/EPERM; the identical normal-local run passed. Browser RED
observations found and repaired the initial-approval label assertion and the
automatic/manual same-passage overlap; a later transient pairing failure passed
on immediate isolated rerun and the final 47-test run was clean.

**Remaining limits:** this is conservative grammar plus human review, not general
semantic understanding or calibrated intelligence. Goal-linked live reasoning,
held-out provider quality/cost, both native client runs, Paddle Sandbox evidence,
target-host operations, human usability, legal/license decisions and public
deployment remain open. No owner data, live provider, payment system, deployment,
global client configuration or external action was used in this checkpoint.
