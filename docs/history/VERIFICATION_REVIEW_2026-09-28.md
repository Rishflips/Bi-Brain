# Bi Brain verification review

Reviewed 2026-09-28 against commit `ec4cec7` (Record successful official repository push).

## Verdict

Bi Brain is a working local foundation with a coherent GUI, persistent capture, evidence-linked briefs, goal review, and agent transport. It is not ready for a trusted public release. Three independently reproduced defects affect deletion and proactive preparation. The background reasoning loop also remains an extractive prototype.

This review changed no application code. Additional reproductions used isolated, in-memory SQLite databases and synthetic content, without external model calls or the owner's application database.

## Confirmed findings

### P1 — Permanent deletion retains derived content after a project move

Location: `packages/domain/service.ts:511–517`; related goal-history cleanup at lines 474–485.

The purge restricts derived-entity deletion to the source's current project. Moving a source first leaves derived content in its former project, so permanent deletion does not remove all retained text.

Reproduction:

1. Capture a private source in Inbox with a unique synthetic marker.
2. Process the brief job.
3. Move the source to a different project and process jobs.
4. Permanently delete the source and process jobs.
5. Inspect retained entities and the owner export.

Observed: the original source is unavailable, but an Inbox brief and receipt still contain the marker. The export contains the deleted text. This is a deletion guarantee failure; it does not establish unauthorized agent access.

Required fix: follow source dependencies across all projects, derived entities, and retained histories when purging. A source's current project must not determine the entire deletion scope. Add a move → purge → export regression test, including derived goal history.

### P2 — An unrelated capture permanently invalidates a pending suggestion

Location: `packages/domain/service.ts:391–400`; interacting deduplication at `apps/worker/engine.ts:369–402`.

Every capture invalidates all ready or snoozed proposals in the project. The worker records previously processed relevant-evidence signatures and does not recreate the proposal when that relevant evidence is unchanged.

Reproduction:

1. Save two passages about beta onboarding.
2. Create a beta-onboarding goal, enable preparation, and prepare it.
3. Confirm a ready proposal exists.
4. Save an unrelated gardening note in the same project.
5. Process jobs and manually prepare the goal again.

Observed: proposal status changes from `ready` to `invalidated`; no replacement becomes ready. A useful pending suggestion disappears even though its cited evidence has not changed. Another manual preparation does not recover it.

Required fix: invalidate by actual evidence and goal-plan dependencies, or permit replacement after invalidation while retaining intentional dismissal/snooze behavior. Test actionability after unrelated capture, not just the total proposal count.

### P2 — Daily scheduling skips additional goals in the same project

Location: `apps/worker/engine.ts:159–168`.

The scheduler checks pending review jobs by project rather than goal. After it queues the first goal, every other goal in that project sees a pending job and is skipped. The scheduler then records the whole day as processed.

Reproduction:

1. Create two active goals in Inbox and enable preparation on both.
2. Enable proactive preparation and set the clock after the digest hour.
3. Run the scheduler with no existing jobs.

Observed: two eligible goals produce only one review job. The skipped goal is not admitted by another scheduling pass that day. With stable ordering and no other trigger, the same goal can keep being skipped on subsequent days.

Required fix: deduplicate by goal and scheduling window, with explicit budget handling. Test multiple eligible goals in one project and verify each is eventually processed.

## Product scope gap: background System 2 reasoning

Connected-model preparation is gated on `j.kind === "derive_brief"` in `apps/worker/engine.ts:227–230`. The `review_changed_assumption` branch at lines 357–403 selects relevant passages and builds a fixed hypothesis/experiment template; it never invokes that model adapter.

Adding credentials therefore enables generated briefs, but does not enable model reasoning in proactive goal reviews. The implementation labels this behavior honestly. It still falls short of the intended proactive Bi Brain experience of interpreting evidence and preparing a specific, useful next step. Treat this as unfinished product work, separate from the three defects above.

## Verification completed

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed |
| `npm run lint` | Passed |
| `npm run build` | Passed |
| `npm test` | 26 tests passed across 5 files |
| `npm run test:e2e` | 4 Playwright tests passed |
| Additional in-memory reproductions | Three defects confirmed |
| Control: owner-authored plan after unrelated source deletion | Passed; plan preserved |

Browser coverage exercised capture, persistence/reload, evidence preview, source correction/deletion, brief editing/download, goal preparation and accept/undo protection, keyboard dialog behavior, dark mode, responsive widths, oversized-input recovery, file import, clipboard, and full-text search. The first-use screenshot was visually inspected. Passing these tests does not establish coverage of every workflow.

Browser tests regenerated screenshot artifacts; the original tracked screenshots were restored after review.

## Still unverified

- Live model execution, cost accounting against a real response, and output usefulness with real user material.
- Native Codex and Claude client setup and use; SDK transport tests alone are insufficient.
- Docker execution, fresh-machine installation, disk-full recovery, and a human pilot.
- Hosted multi-user operation, managed connectors, billing, and public licensing are not delivered or validated by this local build.

The repository's BUILD_STATE already discloses several of these limits. No evidence from this review supports calling the current version a completed hosted platform or a validated proactive reasoning system.

## Recommended order

1. Repair cross-project deletion and add the regression test before trusting permanent deletion.
2. Repair proposal invalidation and per-goal scheduling, then rerun the existing suite plus the new behavioral regressions.
3. Implement and evaluate genuine model-backed goal preparation with source validation, abstention, and budget controls.
4. Complete live-provider, native-client, clean-install, and human-pilot verification before a public V1 claim.
