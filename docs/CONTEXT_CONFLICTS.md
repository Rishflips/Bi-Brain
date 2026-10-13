# Explicit decision correction loop

This is a narrow offline workflow, not general contradiction detection or a semantic model.

1. Save `Beta pricing: free` in a selected project. In **Your brain → Decision review and history**, approve the initial exact decision. Capture itself never promotes this decision to current understanding.
2. Save `Beta pricing: paid`. The review compares the approved earlier decision with the new proposal. Both full assertion lines are quoted with original-source links, immutable source versions and zero-based Unicode character ranges (end-exclusive). It suggests the exact replacement, without applying it.
3. **Keep earlier decision** rejects the proposal and retains both originals. **Approve exact correction** atomically retires the earlier claim and creates the new current claim. Reviewed decision history preserves approval and offers **Undo correction**.
4. Undo writes compensating revisions. It refuses later edits, later decisions, changed evidence, private/moved/withdrawn/deleted originals, or mismatched review versions rather than overwriting them.
5. In **Connections**, preview a new project handoff. It includes fixed agent-use instructions plus accepted current context, not pending corrections. Use the scoped current search/answer/pack surfaces for the next agent; raw search is explicitly original material, not approved truth. Previously issued packs fail validation after correction or undo. Manual copied context cannot be recalled: request a fresh handoff.

## Supported syntax and boundaries

- One recognized `Entity aspect: value` assertion line per newly captured note. The entire left-hand key (for example `beta pricing`) is a lowercased decision slot; the existing claim ledger stores its value as the `statement` aspect. This is not a new unconstrained aspect schema.
- A key has two to eight ASCII identifier words; value is bounded to 300 ASCII letters/digits/spaces/underscore/hyphen/period characters and begins with a letter or digit. Case in values is preserved. A single-word key, quoted/question syntax, multiple recognized decision lines and owner/identity-like keys do not trigger this extractor. Arbitrary prose stays saved; no semantic meaning or calibrated confidence is inferred.
- Existing exact status extraction and owner-selected status passages still use their existing review path. No new model, dependency, provider request, external page fetch or scope permission is introduced.
- The initial decision needs owner review. If its approval or another edit changes context after a later proposal was captured, that later review is refused; save a fresh decision note for a new comparison. Editing an original does not automatically extract replacement decision candidates.
- Already-current exact values and equivalent live pending candidates do not create repeated decision candidates. Normal capture deduplication remains in force. This is exact-value comparison, not semantic equivalence.
- Private and quarantined captures do not create these shared candidates. Matching is per project. Review is owner-only and rechecks the target claim versions and evidence before changing state. Agent read permissions and revocation are unchanged.
- Capture-linked decision review is manual bookkeeping, not a proactive notification or a background goal. Existing scheduled preparation remains limited to explicit, opted-in, active goals and existing background preferences. No background setting is enabled by saving a decision.
- Portable vault/rebuild/restart, immutable originals and managed forgetting use the existing storage services. Copied earlier passages carry source lineage for deletion. Existing deletion behavior is unchanged; previously delivered copies and unmanaged backups remain outside managed erasure.

## Independent Session 44 verification

Re-ran typecheck, lint, all 76 tests, production build and all 4 offline evaluations in the isolated Node 24.19.0 image. Built the actual production Docker image and ran it with fresh disposable data on a separate loopback port. Chrome exercised all 8 existing journeys and one additional save/approve/compare/approve/undo/reject decision journey: 9/9 passed. The added browser regression is `tests/e2e/context-conflicts.spec.ts`. Paid calls: zero. This verifies the explicit-line workflow, not general prose reasoning or native Claude/Codex support.

## Genuine test-first evidence

Focused command, always inside the isolated existing Node 24 image (no network, no live data, no provider keys):

```sh
sudo -n docker run --rm --network none --user $(id -u):$(id -g) \
  -e HOME=/tmp -e BRAIN_DB=/tmp/test/brain.sqlite \
  -v /home/artificialunboxed/work/bi-brain-session44:/app -w /app \
  --entrypoint sh bibrain-test:3e1d7f0 \
  -c 'npm test -- tests/integration/context-conflicts.test.ts'
```

Observed vertical RED → GREEN cycles before the corresponding production edits:

| Slice | Genuine RED output | GREEN output |
| --- | --- | --- |
| Capture → cited correction → approved current retrieval | `expected undefined to match object { type: 'decision', … }`; `1 failed (1)` | `1 passed (1)` |
| Version-safe owner undo | Zod rejected `action: undo`, allowed only `accept` and `reject`; `1 failed / 1 passed (2)` | `2 passed (2)` |
| Review UI + authenticated approval/history/undo | Rendered review lacked `Beta pricing: free`; `1 failed / 2 passed (3)` | `3 passed (3)` |
| Scoped handoff with agent instructions | Handoff lacked `## Agent instructions`; `1 failed / 3 passed (4)` | `4 passed (4)` |
| Existing typed decision gets full earlier passage citation | Earlier quote was only `free`, range `14–18`, rather than `Beta pricing: free`, range `0–18`; `1 failed / 4 passed (5)` | `5 passed (5)` |
| Private pending proposal cannot suppress public review | Public candidate was absent (`Cannot read properties of undefined (reading 'data')`) after an identity-like private pending proposal with the same slot/value; `1 failed / 10 passed (11)` | `11 passed (11)` after duplicate matching also checks project visibility |

Subsequent real-service invariant tests exercise rejection, duplicate/ambiguous suppression, competing/stale reviews, old/new source revisions/privacy/moves/withdrawal, undo safety, separate fresh read-only grants, revocation, cross-project isolation, opted-in scheduling, quarantine, vault rebuild/restart and managed history forgetting. Their initial harness errors were corrected after inspecting the real interfaces: goal opt-in belongs to `editGoal`, not goal creation; a literal redaction placeholder is not secret-like syntax, so the quarantine test uses an explicitly synthetic, invalid private-key-shaped string. No real credential is present.

This evidence is local deterministic service/HTTP-injection and server-rendered React testing. It does not claim a native Claude/Codex run, live-provider semantic quality, browser interaction, deployment or human usability verification. Final suite/check counts are recorded in the appended current checkpoint in BUILD_STATE.md.
