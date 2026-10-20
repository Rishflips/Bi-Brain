# Release and operations

This page records what BiBrain can ship today, what each verification result proves, and which external decisions still block a hosted release.

## Current release candidate, 2026-10-21

Merged [PR #17](https://github.com/Rishflips/Bi-Brain/pull/17) is synchronized
on desktop and GitHub `main` at
`e492e34d41a3c573d1e6280ff2686118bf815de6`. The current branch adds a
project-centered Connections workspace: real continuity counts, a clear choice
between reviewed manual handoff and temporary live access, review-first handling
for raw originals, default-bounded connection setup, real verification state,
immediate revocation, collapsed revoked history and fenced project-scope reads.

`npm run typecheck`, `npm run lint`, `npm run build`, and whitespace checks pass.
The focused journey and corrected affected set pass, and the complete production
browser regression passes **54/54 in 2.8 minutes**. The 320px dark screenshot was
visually inspected. GitHub/Linux/container evidence for this branch is not
claimed until its pull-request workflow completes.

This candidate does not prove fresh native Codex/Claude use, a human pilot,
live-model quality, payment, target-host operations or public hosting.

## Latest merged product checkpoint, 2026-10-20

[PR #16](https://github.com/Rishflips/Bi-Brain/pull/16) was merged into `main`
at `3719f23b3bc74ad4d0ba1bbf43002842357fef98`. Project Focus turns one selected
project into a real-state workspace for understanding, open questions,
direction, originals and exact handoff preview. Its focused
real-storage browser journey, 320px dark regression, typecheck, lint and build
pass locally. After the first full run exposed and drove removal of duplicate
summary control names, the exact finalized production build passed all **53/53
Chromium journeys in 3.7 minutes**. Exact PR-head workflow
[39421708664](https://github.com/Rishflips/Bi-Brain/actions/runs/39421708664)
passed in 9m17s: clean install, high-severity audit, full tests, build, 4/4
offline evaluation, 53/53 Chromium, Docker build and container smoke, Compose
validation and Caddy/TLS validation.

This implementation does not prove a human pilot, native-client compatibility,
live-model quality, payment or public hosting.

## Prior merged product checkpoint, 2026-10-20

[PR #13](https://github.com/Rishflips/Bi-Brain/pull/13), **Guide the first useful
BiBrain session**, was merged into `main` at
`9be79fc6c078570bcb83ce88434f5c3456f63519`. It adds the real-state first useful
loop from durable original to reviewed meaning/search and optional verified
same-project agent continuity. The loop leaves Today after the second saved item.

The exact branch passed typecheck, lint, production build, 33/33 relevant
integration checks and 51/51 Chromium journeys locally. The current follow-up
branch adds the next consumer step: a restrained Today path from reusable
understanding to one chosen goal, one evidence-linked review and a separate
explicit Stay-ahead choice. Its isolated lifecycle and full 52/52 browser suite
pass locally. [PR #14](https://github.com/Rishflips/Bi-Brain/pull/14) was merged
into `main` at `ed8a42c4083d164d53ea0248796e2b427dc8948b`; its clean Linux workflow
[39413228202](https://github.com/Rishflips/Bi-Brain/actions/runs/39413228202)
passed the full tests, build, offline evaluation, Chromium and container/configuration
gates.

None of this is a human pilot, native-client certification, live-model quality
evidence, a payment or a public deployment.

## Prior merged product checkpoint, 2026-10-20

[PR #12](https://github.com/Rishflips/Bi-Brain/pull/12), **Guide safe Codex and
Claude connections**, was merged into `main` at
`77785dcf317eb6a68bf3aec86fb6a725ccaa9af4`. It adds least-access connection
review, one-time secret handling, secret-free project-local setup, real-use
verification, expiry and immediate revocation without changing the shared
authorization boundary.

The exact PR head passed typecheck, lint, production build, 22/22 focused agent
authorization checks and all 49 Chromium journeys locally. GitHub's complete
release-candidate workflow then passed in 7m24s, including dependency audit,
full tests, offline evaluation, Chromium, Docker/container smoke, Compose and
Caddy validation. These results do not certify a fresh native Codex or Claude
Code session, live model quality, a payment, a human pilot, or a public host.

The following first-session branch was merged through PR #13 above.

## Prior merged release candidate checkpoint, 2026-10-19

[PR #6](https://github.com/Rishflips/Bi-Brain/pull/6), **Ship the living
BiBrain release candidate**, was merged into `main` at
`7cc5bf2f656b282d5261069eccec707f4fd0ebc0`. The merged tree contains the living
first-use/Today interface, complete offline B0 operator-safety lifecycle, and the
default-off B1 Paddle boundary. It did not create a Paddle account, credential,
product catalog, payment, public deployment, or live-provider request.

The local product now includes:

- **B0 operations**: one-time offline enrollment, verified Windows access control lists, encrypted key archive and restore, coordinated backup and guarded restore
- **B1 billing boundary**: closed-by-default configuration, account-bound checkout intent, owner-only status and portal actions, signed replay-safe webhooks, durable provider evidence, bounded leases, currency controls, and one billing-authority grant path
- **Failure behavior**: hard provider response limits, a crash-safe ambiguous-checkout lock, resumable known transactions, a 60s Git subprocess ceiling, visible attention states, and plain-language unavailable states
- **Local mode**: no subscription dependency and no live billing requirement
- **Living interface**: atmospheric first-use, a neural Today surface driven by
  real state, direct durable capture, responsive phone layout, and reduced-motion
  behavior without invented memories or activity

The exact local tree passed:

| Evidence                     | Result                                                        |
| ---------------------------- | ------------------------------------------------------------- |
| Vitest                       | **1,488 passed, 8 platform skips, 0 failed across 141 files** |
| Chromium                     | **All 44 journeys passed**                                    |
| Offline evaluation           | **4 of 4 cases passed** with no provider call                 |
| Static and production checks | Typecheck, lint, and build passed                             |
| Dependency audit             | **0 vulnerabilities** at `high` severity or above             |

The final isolated Vitest console run took 1,074.26 seconds. The ignored
`data/vitest-final-green.json` records the earlier 1,478-pass checkpoint, not this
latest run. After the final living-interface and mobile overlay repair, the exact
tree passed all **44/44** browser journeys in one fresh run. The browser suite used
disposable test data. An isolated local preview was rechecked healthy at
`127.0.0.1:4318`; it is not a hosted service or real payment environment.

The first PR #6 CI attempt found one managed server-rendering copy regression in
the redesigned sign-in heading. The assertion was retained, the heading was
repaired, and its exact integration file passed 10/10 locally before the corrected
head was merged. The corrected exact-head GitHub workflow
[39172307962](https://github.com/Rishflips/Bi-Brain/actions/runs/39172307962)
passed in 9m32s: install, audit, typecheck, lint, full tests, build, offline
evaluation, Chromium, Docker build, container smoke, Compose and Caddy validation
all succeeded.

The following gates require owner authority, credentials, spending, or external infrastructure:

1. Choose customer prices, annual discount, allowances, seller, tax, legal, privacy, support, and licensing terms.
2. Supply Paddle Sandbox credentials and approved catalog identifiers, then verify checkout, portal, webhook, cancellation, refund, and reconciliation behavior.
3. Supply a capped live-model budget and credential, then run held-out quality, cost, outage, and timeout checks.
4. Choose a production host and domain, then verify Transport Layer Security (TLS), reboot recovery, durable storage, monitoring, backups, and deletion barriers.
5. Verify two named native agent clients in fresh sessions and complete a human first-use pilot.

Do not enable `BRAIN_PADDLE_ALLOW_LIVE=1` until the Sandbox checks and commercial decisions pass. See [BUILD_STATE.md](../BUILD_STATE.md) for the detailed evidence and [PRODUCTION_READINESS_2026-10-18.md](PRODUCTION_READINESS_2026-10-18.md) for the operator gates.

## Independent deployment checkpoint — 2026-10-07

ChatGPT Sites is canceled as a deployment path. Use [SELF_HOSTING.md](SELF_HOSTING.md) and [SHIP_AUDIT_2026-10-07.md](SHIP_AUDIT_2026-10-07.md) for the current one-owner HTTPS package. The checklist below records specification/history; it is not proof of a completed harness V1.

- [x] Preserve real capture, shared authorization, durable queue and Git vault.
- [x] Add explicit HTTPS origin/host security and Secure cookies with regression evidence.
- [x] Include required Git, nonroot persistence, bounded shutdown and private build context.
- [x] Provide independent Compose/TLS and a deployment-agent handoff; no deploy action in CI.
- [x] Pass local 65-test suite, 8 browser journeys, 4 offline evals, typecheck/lint/build and dependency audit.
- [x] Record Linux/Docker CI evidence after workflow installation with an authorized credential. (Follow-up 2026-10-16: merged-main run 38889855879 at `5dd6ed0` passed; see BUILD_STATE.)
- [ ] Prove chosen host DNS/TLS, reboot, disk/monitoring and encrypted full-volume recovery/deletion barriers.
- [ ] Complete live-model, two-native-client, broader failure drills and human pilot gates.

No owner host has been deployed. The previous private Sites probe was permanently deleted following the owner's explicit request and final confirmation on 2026-10-07. The owner list, connector project lookup and former URL verify removal/offline status. GitHub and local application data remain intact.

## Historical PR #5 baseline checkpoint, 2026-10-18

This section preserves the verified PR #5 state before the later B0, B1 and
living-interface work now merged through PR #6.

Baseline commit **`b5610f411e02584842d2e655a49bf28a781f00f3`** on branch
`feat/system-one-stage-accounting` was verified clean and **pushed** before the
current UI work began. A subsequent remote check found
[PR #4](https://github.com/Rishflips/Bi-Brain/pull/4) already merged externally at
`2026-10-17T20:19:22Z`; `origin/main` is now
`1fe33bd530e924deb4de81b470b8416ccfbb2fd8`, with the same tree as `b5610f4`.
The agent performed no merge. Desktop was verified at `b5610f4` before the current
UI work. Two independent passes at that baseline SHA:

| Evidence                                                                                         | Result                                                                    |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| Windows full regression `test-results/prepublication-full-parent.json`                           | `success:true` — **1,447 passed / 8 skipped / 0 failed across 132 files** |
| GitHub Actions [run 39065046637](https://github.com/Rishflips/Bi-Brain/actions/runs/39065046637) | **success** at `headSha b5610f411e02584842d2e655a49bf28a781f00f3`         |

The Linux job (Ubuntu, Node 24.19) ran `npm ci`, audit, typecheck, lint, the full
132-file suite, build, 4 offline evaluations, 24 Chromium journeys, Docker build,
non-root container restart/persistence/auth/worker/Git-backup smoke, and Compose and
Caddy configuration validation. The Docker CLI is absent on the local Windows host,
so this packaging proof is Linux-CI only.

**This closes the baseline "current-branch Linux/container CI missing" gap. It does
not verify** the in-progress UI revision in this worktree, chosen target-host
TLS/DNS/reboot/monitoring/recovery, live model quality, real identity/payment, or a
hosted release. The functional follow-up now has **41/41 local Chromium journeys**,
typecheck/lint/build evidence, covering inline capture through real persistence,
truthful source-linked receipt, error recovery, deletion, account switching and
find/reopen. These are improvements to existing services, not live intelligence or
a commercial launch. The later PR #6 follow-up supplied the living redesign while
retaining these reliability gates.

Final local whole-tree verification passed after the reproduced readiness timing repair.
Parent independently passed **19 readiness/consent/process checks / 1 platform skip**,
including the unchanged real long-call heartbeat assertion. The decision send-time
callsite is also repaired, with strict lease/monetary checks unchanged and independent
source review finding no material security regression. Fresh whole-tree typecheck,
lint and build passed. The settled full run used one worker and Vitest's persistent
module cache: **1,450 passed / 8 platform skips / zero failed, 132 files**, 637.12 s;
parent read `success:true` and verified the frozen source/test/config hashes unchanged.
Report: `test-results/vitest/product-release-settled-parent.json`. Functional source
was pushed as `92a69b2684b6d852b16e7be6214f629f0245655c`, Desktop safely fast-forwarded
with its personal note unchanged, and [draft PR #5](https://github.com/Rishflips/Bi-Brain/pull/5)
opened. This documentation-only checkpoint follows that source commit. Exact final
PR-head Linux/container CI is pending, not inferred from this local result; its
terminal evidence belongs to PR #5's checks. Nothing was merged or publicly deployed.
The earlier full release run
failed (missing Vitest temporary transform files plus the actual readiness failure)
and remains retained, not counted as passing. See BUILD_STATE for the exact reports.
At this historical checkpoint, payments and paid providers stayed off, B1 (Paddle)
was a draft, and B0 operational enrollment, key recovery, and Windows access control
list verification remained open. The latest local checkpoint above supersedes that
implementation status. See
[PRODUCTION_READINESS_2026-10-18.md](PRODUCTION_READINESS_2026-10-18.md) for the
still-blocked launch gates.

Historical sections below retain their original scope and dates; where an older
section says the branch was uncommitted, the pushed baseline above supersedes it.

## Release levels

The 2026-10-16 merged-main Linux/container checkpoint passed 479 tests, 17
Chromium journeys, 4 offline evaluations, Docker build/container restart and
persistence smoke, Compose and Caddy configuration validation. This closes the
synthetic CI packaging gate, not live managed identity/provider quality,
target-host HTTPS/operations, native-client or human pilot gates. No owner host
was deployed. Historical verification records below retain their original scope.

1. Build pack: documentation and contracts.
2. Runnable local preview: durable capture and truthful extractive mode.
3. Local V1: complete knowledge, preparation, review, and verified agent access.
4. Managed private beta: hosted identity, isolation, operations, metering.
5. Public service: validated reliability, support, and commercial terms.

Never use one level's evidence to claim another.

### Managed provider activation — local verification, not a release

The default-off activation implementation has a local Windows verification
checkpoint of 579 passed / 2 POSIX-only skips, 19 Chromium journeys and 4 offline
evaluations; typecheck, lint, build and dependency audit passed. The full suite
passed again after restart-proof assertions were strengthened; see BUILD_STATE.
Real server and
worker processes use an explicitly injected synthetic provider transport in
these tests. No real model credential, paid runtime call, owner activation or
public deployment is implied. Current-branch Linux/container CI, capped live
provider quality/cost, target-host operations, native clients, billing, human
usability and licensing remain separate gates. An integration decision is also
required before merging. The owner has requested committing, pushing and opening
a PR for the verified branch; that is repository delivery, not live activation.

### Decision accounting and consent S1 — locally accepted, not deployed

The 2026-10-17 settled parent checkpoint passed **829 tests / 2 existing
POSIX-only skips**, **24 Chromium journeys** and **4 synthetic offline
evaluations**, plus typecheck/lint/build and dependency audit. Separate default-off
decision configuration, guarded accounting and withdrawable account consent are
implemented. No production decision consumer or readiness writer is installed by
S1. The separate S2 worker is now locally accepted with synthetic transport as
recorded below, not live-provider quality evidence. _(Superseded 2026-10-18: this
branch is now committed and pushed at `b5610f4` with the Linux/container CI run
recorded in the current baseline checkpoint above; it is still not a public
deployment. PR #4's later external merge is recorded above. Billing, capped live quality/cost, native
clients, target-host drills and owner release/legal decisions remain gates.)_

### Advisory worker S2 — all three tasks accepted locally, not deployed

The repaired tenant-v5 lifecycle passed the settled parent checkpoint:
**948 tests / 2 existing POSIX-only skips, 94 files**, **24 Chromium journeys**,
**4 offline evaluations**, typecheck/lint/build and zero audit vulnerabilities.
Independent review covers actual claim/lease binding, rollback of ignored writes,
withdrawal, unavailable imported history and retained no-resend tombstones.
The final worker checkpoint passed **984 tests / 2 existing POSIX-only skips,
98 files**, **24 Chromium journeys**, **4 offline evaluations**, typecheck/lint/
build/audit and whitespace checks. Five actual worker-process cases exercise both
stages on one job, settled/unknown restart without resend, long-call heartbeats,
unpaid account continuity and independent stage bootstraps. The stricter cleanup
fixture passed without warnings. The consumer is real code with injected provider
transport in verification, not a held-out quality or live-pricing result. No new
runtime dependency, lockfile change, hosted release or current-branch Linux CI
result is implied. Licensing, billing, native/live-provider and target-host gates
remain open; defaults remain off and no owner/provider was activated.

## Local packaging

Document exact Node/package-manager versions, clean installation, migrations, development, production build, API start, worker start, data directory, and stop/restart.
Provide a reproducible container path where practical, with separate API/worker processes and shared local persistent volume.
Development binds loopback. Supported remote self-hosting requires authenticated HTTPS.
Secrets come from environment or protected local config, never tracked files.

## Operational checks

- Liveness separate from readiness; worker heartbeat visible.
- Failed/retryable/abstained jobs inspectable.
- Database migration version recorded.
- Graceful termination releases or expires leases.
- Provider timeout, cancellation, and rate limits handled.
- Disk-full errors never produce false save success.
- Time zone, daylight-saving boundaries, and host sleep catch-up verified.

## Backup and restore

Use SQLite's supported backup mechanism or a coordinated consistent snapshot. Do not copy a live database while ignoring WAL state.
Include blobs and a versioned manifest. Portable exports exclude credentials; operational backups need secure handling.
Restore to a clean directory; run integrity/foreign-key checks; verify capture, search, jobs, and grants.
Document retention and deletion implications.

## Local V1 gates

- [x] M0–M6 have evidence or explicit narrow limitations.
- [x] Live-provider results are distinct from deterministic tests.
- [x] Two native clients verified or transparently listed as unverified.
- [x] Capture, correction, deletion, export/import, restore work.
- [x] Permission and budget adversarial cases pass.
- [x] UI never pretends external actions happened.
- [x] Demo content cannot be mistaken for user data.
- [x] Keyboard/responsive checks pass.
- [x] Supported environments and limitations documented.
- [ ] License decision completed before public distribution.

## Hosted additions

Identity/recovery, tenant-aware authorization and storage, adversarial isolation tests, HTTPS, managed secrets, per-user budgets, idempotent billing, backups, alerts, incident ownership, retention, and privacy disclosures.
Add one managed connector only after authorization, refresh, revocation, deletion, and incremental sync are tested.

## Launch demonstration

Use arbitrary captured content, source-backed continuation in another agent, new evidence triggering a proposal, accept/undo, and access revocation. Include one failure/recovery example. Label synthetic data. Never publish the owner's private material.

## Verification record — 2026-09-28

See BUILD_STATE.md for commands and evidence. This is a runnable local preview with the local V1 implementation, not a fully verified Local V1 release. Native Codex/second-client sessions, a live provider evaluation, Docker/fresh-machine installation, and human pilot remain unverified. The checked native-client item above records this transparent limitation, not successful client verification. Disk-full and live provider outage drills are also unverified.
