# Release and operations

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

## Current baseline checkpoint — 2026-10-18 (read this before the historical sections)

Baseline commit **`b5610f411e02584842d2e655a49bf28a781f00f3`** on branch
`feat/system-one-stage-accounting` was verified clean and **pushed** before the
current UI work began. A subsequent remote check found
[PR #4](https://github.com/Rishflips/Bi-Brain/pull/4) already merged externally at
`2026-10-17T20:19:22Z`; `origin/main` is now
`1fe33bd530e924deb4de81b470b8416ccfbb2fd8`, with the same tree as `b5610f4`.
The agent performed no merge. Desktop was verified at `b5610f4` before the current
UI work. Two independent passes at that baseline SHA:

| Evidence | Result |
| --- | --- |
| Windows full regression `test-results/prepublication-full-parent.json` | `success:true` — **1,447 passed / 8 skipped / 0 failed across 132 files** |
| GitHub Actions [run 39065046637](https://github.com/Rishflips/Bi-Brain/actions/runs/39065046637) | **success** at `headSha b5610f411e02584842d2e655a49bf28a781f00f3` |

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
a commercial launch. The owner prioritized reliability over a flashy redesign.

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
Payments and paid providers stay off; B1 (Paddle) is DRAFT/UNAPPROVED; B0 operational
enrollment, key recovery and Windows ACL verification remain open. See
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
recorded below, not live-provider quality evidence. *(Superseded 2026-10-18: this
branch is now committed and pushed at `b5610f4` with the Linux/container CI run
recorded in the current baseline checkpoint above; it is still not a public
deployment. PR #4's later external merge is recorded above. Billing, capped live quality/cost, native
clients, target-host drills and owner release/legal decisions remain gates.)*

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

