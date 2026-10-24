# Production readiness — 2026-10-18

**Managed public product: BLOCKED for launch.** No numeric readiness score is
offered here. A passing CI packaging run cannot be converted into a readiness
percentage; the areas still gated are product, live quality, billing, hosted
operations and legal/support work that no baseline test run can measure.

**Superseding status, 2026-10-19:** [PR #6](https://github.com/Rishflips/Bi-Brain/pull/6)
merged the living first-use/Today interface, B0 operator lifecycle, and default-off
B1 Paddle boundary into `main` at `7cc5bf2`. Local evidence reached 1,488 passing
Vitest checks with 8 platform skips across 141 files, 44/44 Chromium journeys,
4/4 offline evaluations, passing typecheck/lint/build, and zero high-severity audit
findings. Public launch remains blocked by real Paddle Sandbox acceptance, capped
live-model evaluation, chosen-host operations, native-client and human verification,
and commercial/legal/support decisions. Corrected PR-head workflow
[39172307962](https://github.com/Rishflips/Bi-Brain/actions/runs/39172307962)
also passed the full Linux/container packaging gate. [RELEASE.md](RELEASE.md) and
[BUILD_STATE.md](../BUILD_STATE.md) are the current records; the remainder of this
dated document preserves the PR #4/#5 readiness assessment as history.

The **40/100** figure preserved in the table below is a **historical engineering
judgment recorded earlier on 2026-10-18, before the baseline verification in this
document**. It is not an updated score and this document does not re-score the
product from CI results.

The current local preview is a functional single-owner knowledge application, not
the complete managed subscription service the owner requested. The owner has since
prioritized reliable product behavior over a flashy redesign. The follow-up below
improves the actual capture-to-reopen path without changing authentication or
claiming to deliver hosted identity, live intelligence or payments.

## Baseline verification — commit `b5610f4` (packaging only)

The exact commit **`b5610f411e02584842d2e655a49bf28a781f00f3`** on branch
`feat/system-one-stage-accounting` was verified clean and pushed to `origin` before
the current UI work began. A subsequent remote check found that
[PR #4](https://github.com/Rishflips/Bi-Brain/pull/4) had already been merged externally
at `2026-10-17T20:19:22Z`; `origin/main` is now
`1fe33bd530e924deb4de81b470b8416ccfbb2fd8`, with the same tree as `b5610f4`.
The agent did not perform that merge. The owner-facing Desktop review/latest build
was verified at `b5610f4` before the current UI work.

| Evidence (independent, at `b5610f4`) | Result |
| --- | --- |
| Windows full regression, parent-owned `test-results/prepublication-full-parent.json` | `success:true` — **1,447 passed / 8 skipped / 0 failed across 132 files** |
| GitHub Actions run [39065046637](https://github.com/Rishflips/Bi-Brain/actions/runs/39065046637) | completed **success** at `headSha b5610f411e02584842d2e655a49bf28a781f00f3` |

The Linux job ran on Ubuntu with Node 24.19: `npm ci`, audit, typecheck, lint, the
full 132-file suite, build, 4 offline evaluations, 24 Chromium journeys, Docker
build, non-root container restart/persistence/auth/worker/Git-backup smoke, and
Compose and Caddy configuration validation. The Docker CLI is absent on the local
Windows host, so this packaging proof is Linux-CI only.

**Scope limits — this baseline evidence does not verify:** the follow-up UI revision in
this worktree, chosen target-host TLS/DNS/reboot/monitoring/recovery, live model
quality, real identity/payment, or a hosted release. It closes the baseline
"current-branch Linux/container CI missing" gap only.

## Historical PR #5 product status

The functional capture follow-up has **local browser verification**, not public
launch acceptance. The controller's settled Chromium command
`npm run test:e2e -- --workers=1 --output=test-results/visible-product-closure-parent --reporter=line`
passed **41/41 journeys**, with typecheck, lint and production build also passing.
The actual unpaid worker is used for extractive-preview verification. Controlled
stored model-output fixtures are explicitly synthetic, not live-provider evidence.

New behavior: inline capture on Today; acknowledgement from the durable capture
response before later reads; recoverable saved-view failures; exact-source/version
preview attribution; functional Save another and find/reopen; receipt invalidation
on correction/removal/account changes; explicit deterministic input limits. The
checks include arbitrary Unicode/multiline originals, quarantine no-echo,
late-response fencing, purge and correction recovery, keyboard capture, and saved
receipts/evidence at 320px in both appearances. These improve pre-existing capture,
retrieval and storage services rather than inventing new backend capabilities.

**Final local release regression passed.** A prior broader run exposed missing Vitest
temporary transform files and an independent reproducible managed-readiness timing
race. The readiness repair preserves strict future-heartbeat/expiry rules; parent
independently passed **19 checks / 1 platform skip** across three readiness/consent/
actual-process files, including the unchanged long-call heartbeat assertion. A
decision send-time callsite has the same clock-after-read repair, with the job-lease
timestamp and all monetary checks unchanged. Independent source review found no
material security regression. Fresh whole-tree typecheck, lint and build passed.
The settled full run used short process-local `TEMP`/`TMP` and
Vitest's persistent module cache (`--maxWorkers=1 --fsModuleCache
--fsModuleCachePath=node_modules/.cache/product-release-parent`), with no assertions
disabled. Parent read `success:true`, **1,450 passed / 8 platform skips / zero failed
across 132 files**, 637.12 s, and verified unchanged frozen source/test/config hashes.
Its report is `test-results/vitest/product-release-settled-parent.json`.
Functional source was published as `92a69b2684b6d852b16e7be6214f629f0245655c`,
then merged through [PR #5](https://github.com/Rishflips/Bi-Brain/pull/5). The later
PR #6 checkpoint above supersedes this section. Neither merge closes the public
launch gates.
The failed report is retained as `test-results/product-release-full-parent.json`;
it is not being represented as passing.

The historical scored table that follows was written against the pre-`b5610f4`
preview. At that time, payments and paid providers were **off**, B1 (Paddle) was
**DRAFT / UNAPPROVED**, and B0 operational protected enrollment, key recovery,
and Windows access-control verification were unresolved. The superseding status
above records their later default-off implementation without claiming live proof.

| Release area (historical) | Score | Evidence / gap |
| --- | ---: | --- |
| User experience and complete product flows | 15/30 | Real capture/review/search/export; 24 browser journeys. Managed first-use, sign-in polish and an owner-accepted walkthrough are not delivered. |
| Persistence, isolation and financial safeguards | 21/25 | Extensive synthetic domain/SQLite/worker/recovery/process tests. B0 operational enrollment/key recovery and host verification remain open. |
| Live AI quality and integrations | 0/15 | No authorized capped held-out live-provider run; two named native-client workflows unverified. |
| Subscriptions | 0/10 | Paddle B1 is unapproved/unimplemented; no checkout, verified payment, final prices or allowances. |
| Hosted operations and release verification | 4/15 | Packaging and historical main CI exist; this revision's Linux/container CI and target-host TLS/monitoring/recovery are not yet proven. |
| Legal/support readiness | 0/5 | Licensing, privacy/commercial terms, seller obligations and support gates unresolved. |

## Verification at publication preparation — historical

These were the pre-publication spot checks recorded before the full baseline run
above; they are retained as history, not the current top-level status.

- Parent pre-commit run: **488 passed / 6 explicit platform skips, 36 files**
  (`test-results/billing-precommit-parent.json`). Includes billing and both existing
  worker activation-guard suites, not the complete test suite.
- Separate `npm run typecheck`, `npm run lint`, `npm run build`: passed.
- Fresh Chromium browser run: **24/24 passed**.
- Offline evaluations: **4/4 synthetic**; dependency audit: **zero vulnerabilities**.
- That separately-running complete regression has since finished: **1,447 passed /
  8 skipped / 0 failed across 132 files** at `b5610f4`
  (`test-results/prepublication-full-parent.json`), confirmed by the Linux CI run
  above. This is baseline-commit evidence, not verification of the in-progress UI
  revision.

## Local preview

Loopback only: `http://127.0.0.1:4318`, using the ignored, separate
`data/local-preview/brain.sqlite`. The pairing code is in
`data/local-preview/owner-secret` in the running worktree; never commit or publish it.
The supervisor was launched without loading `.env` and with provider/billing variables
removed from its process environment. No existing owner database was adopted.

This preview is not managed sign-in, live model intelligence, a subscription service
or a public hosted release. Functional browser improvements are recorded above;
neither that local result nor backend safety tests complete the managed product.

## Before public launch

1. Deliver and validate the managed sign-in → first capture → useful result → continue
   workflow, including actual UI polish and an owner-accepted walkthrough. The
   local follow-up has 41 passing browser journeys and a green whole-tree regression;
   exact-revision CI and the hosted identity/operations checks remain separate.
2. Complete B0 operational work: protected enrollment, key backup/restore, Windows ACL
   and target-host permission/drill proof (`docs/superpowers/plans/2026-10-18-billing-admission-integration.md`).
3. Obtain separate B1 approval (Paddle is **DRAFT / UNAPPROVED**); implement and verify
   sandbox billing before any live use.
4. Obtain a numeric live-test budget and run the authorized live quality/cost
   evaluation; produce named native-client workflow evidence.
5. Verify a chosen target host and domain — TLS, DNS, reboot, monitoring and
   encrypted backup/recovery — then close licensing/privacy/commercial/support gates.

Missing owner/external inputs (unchanged): real identity, provider, payment and
checkout credentials; product prices, allowances and a numeric live-test budget;
named native-client proof; target-host/domain credentials; legal and support
decisions. Until these arrive, the public managed product stays launch-blocked and
paid processing stays off.

Repository publication is a review checkpoint. It does not enable paid processing,
approve B1, authorize model spending or publish a production service.
