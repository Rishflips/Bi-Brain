# Production readiness — 2026-10-18

**Managed public product: 40/100 — blocked for launch.** This is an engineering
judgment, not a certification or a percentage of code completed.

The current local preview is a functional single-owner knowledge application, not
the polished browser-first managed suite the owner requested. Its installation-code
pairing screen, largely unchanged presentation and first-value friction are product
delivery gaps. Backend safety work does not close those gaps.

| Release area | Score | Evidence / gap |
| --- | ---: | --- |
| User experience and complete product flows | 15/30 | Real capture/review/search/export; 24 browser journeys. Managed first-use, sign-in polish and an owner-accepted walkthrough are not delivered. |
| Persistence, isolation and financial safeguards | 21/25 | Extensive synthetic domain/SQLite/worker/recovery/process tests. B0 operational enrollment/key recovery and host verification remain open. |
| Live AI quality and integrations | 0/15 | No authorized capped held-out live-provider run; two named native-client workflows unverified. |
| Subscriptions | 0/10 | Paddle B1 is unapproved/unimplemented; no checkout, verified payment, final prices or allowances. |
| Hosted operations and release verification | 4/15 | Packaging and historical main CI exist; this revision's Linux/container CI and target-host TLS/monitoring/recovery are not yet proven. |
| Legal/support readiness | 0/5 | Licensing, privacy/commercial terms, seller obligations and support gates unresolved. |

## Verification at publication preparation

- Parent pre-commit run: **488 passed / 6 explicit platform skips, 36 files**
  (`test-results/billing-precommit-parent.json`). Includes billing and both existing
  worker activation-guard suites, not the complete test suite.
- Separate `npm run typecheck`, `npm run lint`, `npm run build`: passed.
- Fresh Chromium browser run: **24/24 passed**.
- Offline evaluations: **4/4 synthetic**; dependency audit: **zero vulnerabilities**.
- Complete current-tree regression is running separately; its completed result belongs
  in `BUILD_STATE.md`. Historical green main CI is not current-branch CI.

## Local preview

Loopback only: `http://127.0.0.1:4318`, using the ignored, separate
`data/local-preview/brain.sqlite`. The pairing code is in
`data/local-preview/owner-secret` in the running worktree; never commit or publish it.
The supervisor was launched without loading `.env` and with provider/billing variables
removed from its process environment. No existing owner database was adopted.

This preview is not managed sign-in, live model intelligence, a subscription service
or a public hosted release. The owner rejected the visible first-use experience;
the next product priority is an approved, genuinely useful browser-first experience,
not more backend milestones presented as visual/product completion.

## Before public launch

1. Deliver and validate the managed sign-in → first capture → useful result → continue
   workflow, including actual UI polish and an owner-accepted walkthrough.
2. Complete B0 offline enrollment, protected key backup/restore, ACL and target-host drills.
3. Obtain separate B1 approval; implement and verify sandbox billing before any live use.
4. Run authorized live quality/cost evaluation and the named native-client workflows.
5. Verify this exact revision in CI and on the target host; close legal/support gates.

Repository publication is a review checkpoint. It does not enable paid processing,
approve B1, authorize model spending or publish a production service.
