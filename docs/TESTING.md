# Testing and evaluation

Passing deterministic fixtures does not prove live model quality or user demand. Tests must exercise meaningful behavior and trust boundaries.

## Test layers

| Layer | Required coverage |
|---|---|
| Domain | Version conflicts, evidence validity, visibility propagation, proposal lifecycle |
| Persistence | Migrations, constraints, rollback, restart, index invalidation |
| Jobs | Lease expiry, fencing, duplicate delivery, cancellation, retry exhaustion |
| Providers | Schema errors, timeouts, invalid evidence, bounded repair, usage accounting |
| HTTP/MCP | Authentication, grants, inaccessible IDs, revocation, input limits |
| Browser | Real capture, review/undo, search/delete, settings, keyboard use |
| Live evaluation | Citation support, temporal interpretation, usefulness, costs |
| Human pilot | First-use comprehension, trust, return behavior |

## Required browser journeys

1. Empty install → save arbitrary text → source visible → extractive preview → edit → copy/download → reload and restart.
2. Create project and goal → import two relevant sources → prepare → review evidence → accept → inspect change → undo.
3. Correct a source → old brief marked stale → regenerate → corrected context appears.
4. Delete source → search excludes content → cached brief invalidated → in-flight job cannot resurrect it.
5. Configure limited agent grant → verify round trip → revoke → read and cached access denied.
6. Pause background work → scheduled trigger does not dispatch; explicitly requested manual work follows its own controls.
7. Exhaust budget → capture still succeeds → paid preparation is paused with readable reason.
8. Keyboard-only capture, evidence view, dialog dismissal, correction, and deletion.

Check 320px, 360px, tablet, desktop, light/dark, reduced motion, and 200% zoom. No clipped controls or inaccessible content.

## Evaluation corpus

evals/scenarios.json defines expected behaviors, not proof of success. fixtures/beta-launch.json is synthetic and must remain labeled.
Build harnesses that execute these scenarios against actual services. Static string matching in fixture-only code does not satisfy a scenario.

## Must-pass invariants

- Every quoted span matches an extant accessible source version.
- Other-project or private data never leaks through retrieval, context, receipt, or error.
- Explicit capture survives provider failure.
- Duplicate job delivery produces one committed result.
- Undo cannot overwrite a subsequent edit.
- Deletion fences stale caches and in-flight work.
- Concurrent reservations cannot exceed the cap.
- Missing evidence does not become a negative factual assertion.
- Imported instructions cannot change authority.

## Live model assessment

Use a held-out set of at least 30 small scenarios before pilot deployment. Include supported claims, temporal changes, contradictions, unknowns, unrelated material, injected instructions, and multilingual text.
Report numerator/denominator for citation accuracy, unsupported claims, useful proposals, missed relevant events, and abstentions. Record provider/model/prompt versions and actual costs.
Human review checks semantic support. Exact quote validation is necessary but insufficient.

## Performance

Measure capture acknowledgment, search, time to brief, job latency, and cost on a documented corpus and machine. Separate model latency from local work. No production response-time claims from fake adapters.

## First-use pilot

Five participants unfamiliar with the design: save a conversation, find the original, correct a misunderstanding, continue elsewhere. Record completion, time, confusion, trust, and willingness to return. Initial target: 4/5 unaided completions.

## Check discipline

Focused tests during implementation; affected integration and browser checks at each milestone. Before release: build, typecheck, lint, full tests, migration, restore, and secret review. Record actual commands and outcomes in BUILD_STATE.md.
