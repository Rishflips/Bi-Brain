# Bi Brain build review — 2026-09-29

Reviewed commit: `8817856`, including harness implementation `d2f3acb`.

## Verdict

The build is a substantial local alpha, not a completed trustworthy harness or the full standalone second-brain suite. Existing automated checks pass. Four new correctness defects and one important integration gap were reproduced using isolated in-memory databases. Application code and owner knowledge were not changed. No live provider call or native-client session was performed.

## Commands actually run

| Check | Result |
| --- | --- |
| npm run typecheck | Passed |
| npm run lint | Passed |
| npm test | 55/55 across 10 files |
| npm run build | Passed |
| npm run brain-eval | 4/4 offline test cases |
| npm run test:e2e | 5/5 browser journeys |
| Additional behavioral probes | Findings F1–F5 below |

The eval suite is a tiny synthetic set, not population accuracy or native-agent reasoning evidence. Its four test cases cover several categories together. Its binding test reads a value from a supplied object in a callback; it does not demonstrate a real model obeying an injected pack. The simulated 24-hour scenario runs a fixed eligible clock, not a real 24-hour soak.

Browser coverage: import/drop, save/reload, evidence, editable understanding, download, source correction/deletion, goal preparation and acceptance, later-edit-safe undo, keyboard dialogs, responsive widths, dark mode, clipboard and long-text search. The generated Today screenshot was visually inspected. This is not a comprehensive accessibility or usability audit. Original tracked screenshots were restored after the run.

## Confirmed findings, in priority order

### F1 · P1 · The write gate can auto-commit a negated fact

Location: `packages/domain/claims.ts:60–69`, consumed by `packages/domain/service.ts:1284–1291`.

An agent with propose permission submits entity `beta`, aspect `status`, value `active`, and raw text `Beta is inactive. Do not describe it as active.` The result is `disposition: commit`, `confidence: 0.98`, and current truth contains `active`.

The classifier checks whether a value appears anywhere in text. That does not establish that the text asserts the proposed entity/aspect/value. Even substring matches inside another word count. This defeats the central protective purpose of the gate, not merely classifier sophistication.

Required repair: queue unrestricted natural-language facts until supported by a validated structured assertion or evaluated entailment path. Validate entity, aspect, polarity, speaker, and temporal scope; include negation, quoted examples, and wrong-entity controls. Do not present the hardcoded 0.98 as calibrated confidence.

### F2 · P1 · Retiring a claim does not invalidate an already issued pack

Location: `packages/domain/binding.ts:132–162`.

Create a current beta status claim, build a pack, then retire the claim without modifying its source. Current claims become empty, but `validatePack` returns `true` and the issued pack still contains `active`.

Validation checks source versions, identity disclosure and expiry, but not current status/version of ordinary page claims. A supported pre-action check can therefore approve retired context until pack expiry.

Required repair: bind and validate claim revisions/status/validity, relevant intent state, and deletion generation, in addition to source versions and authorization. Test retire/supersede/conflict/close between pack delivery and pre-action validation.

### F3 · P2 · Expired claims remain current

Location: `packages/domain/service.ts:1426–1436`.

With the clock at 2026-09-29, propose `beta status active` valid only from 2026-01-01 through 2026-01-02. It is returned by currentClaims and agentAsk answers `beta — status: active` without abstaining.

The current-truth filter checks status but not valid_from/valid_to. The schema also needs an ordered validity-interval constraint. Owner review currently creates a new valid_from of now and does not preserve supplied validity from the queued proposal.

Required repair: define current as accepted and valid at the selected time; enforce valid_from <= now < valid_to for default retrieval. Preserve validity through gate review and retain explicit historical access. Test expired, future, boundary, invalid interval, and review paths.

### F4 · P2 · Agent intent proposals cannot become actionable open loops

Locations: `packages/domain/service.ts:1941–1954` and `1378–1407`; `apps/web/components.tsx` review controls.

Call agentIntent(propose) with `Review the beta onboarding tomorrow`, then accept its gate through the owner service. Acceptance returns `{reviewed:true, claim_ids:[]}`, but there are zero goals and the open-intent list remains empty. The GUI does not offer acceptance for this fieldless proposal; only keeping raw is available.

Agent update/close also funnel through a generic text proposal without retaining the target/action/version needed to perform the requested transition.

Required repair: typed intent proposals with target, action, version and scheduling semantics; owner acceptance must create/update/close the intended entity atomically. Add corresponding GUI review and end-to-end tool → review → scheduler tests.

### F5 · P2 · Normal capture does not feed the current-truth workflow

Locations: capture/derive_brief flow versus `packages/domain/service.ts:1676–1716` and `1802`.

Capture the project-visible text `Beta status active` through the ordinary capture service and drain worker jobs. Result: one source and one brief, but zero pages; current search returns no items and ask abstains. Structured propose calls can create claims, but normal capture/import/brief generation does not generate reviewable ledger proposals.

This is a missing integration, not proof that all retrieval is broken: raw search and the older brief/Continue flow still work. It is nevertheless a central product gap for an independently useful suite.

Required repair: ordinary capture/import should produce source-backed candidate claims through the same gate, with owner review when uncertain. Provide a direct owner promotion/correction path. Test save → review → current page → search → pack using ordinary UI input, without hidden setup via propose.

## What genuinely improved

- The three earlier regression repairs remain covered by the passing suite.
- Portable generations, protected secret quarantine, local Git, migration/rebuild and managed deletion are implemented and tested within documented scope.
- Exactly eight public MCP tool names exist, filtered by grants; direct write denial and revocation have SDK tests.
- Claim review, retirement, typed conflicts, handoff, folder/chat import, and current-knowledge UI exist.
- Goal preparation now calls a structured provider adapter when configured. The earlier fixed-template-only limitation has been addressed in code; live usefulness remains unverified.
- Worker tests cover budgeted preparation, activity cancellation, receipts, notification limits, and guarded revert.

## Remaining product and release work

### Before a trustworthy local beta

Repair F1–F5. Add real native-client binding and verify two clients, including pack use without optional search. Evaluate live goal preparation and classifier behavior on held-out cases. Test vault crash recovery at additional points, disk-full handling, fresh-install/restore, and the actual operating-system protection of sensitive local files. Complete a human first-use pilot.

Managed deletion is tested, not universal recall: earlier provider/client deliveries and unmanaged backups remain outside the proof. Non-head Git revert is deliberately limited and requires comparison. Do not claim these cases solved by a green happy-path test.

### Before calling this the standalone suite we discussed

The current interface is a coherent small local app with three primary destinations and a current-knowledge panel. It is not yet the full daily workspace. Prioritize a first-class page-writing experience, source reading/annotation, a unified project home and actionable intent agenda. Rich attachments, a visual board and stronger cross-workspace navigation can follow. Current ingestion is focused on text/Markdown and supported JSON conversations, not a complete file/reading suite.

S8/S9 remain future work: session page leases, outcome-scored rule learning, paid/hard-call classifier routing, causal why-walk, compression, and calendar/mail expansion. Do not delay core correctness for those additions.

### Before an open-source launch

No root LICENSE, CONTRIBUTING, CODE_OF_CONDUCT, public SECURITY reporting file, or .github CI configuration was found. docs/SECURITY_PRIVACY.md describes architecture but is not a vulnerability-reporting process. Choose a license, audit third-party rights/notices, set contributor terms, add CI and a reproducible release, and clarify support expectations. README still says eight tools and dream reasoning are not delivered even though code/build state now show implementations; reconcile stale documents.

### Before paid managed hosting

No paid managed service was verified. The runtime is single-owner, loopback-first. Hosting needs an explicit isolation model (dedicated instances or tested multi-tenancy), remote identity, secrets/encryption design, resilient operations, recoverable backups, billing/entitlements, metering, quotas, cancellation/export/deletion behavior, and provider-processing disclosures. Do not expose the existing owner-secret server as a shared SaaS.

## Suggested next order

1. Gate correctness and stale/temporal truth.
2. Working intent acceptance and ordinary capture-to-current-truth flow.
3. Daily suite usability and two native agent clients.
4. Live reasoning/evals, install/recovery and human pilot.
5. Licensed alpha/release materials and contributor setup.
6. Paid hosted pilot after measured useful outcomes and operating costs.

Licensing and business options are in `LICENSING_AND_MONETIZATION_OPTIONS_2026-09-29.md`. No license was selected or applied by this review.
