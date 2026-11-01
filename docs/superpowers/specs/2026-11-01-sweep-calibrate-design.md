# Plan 7: sweep and calibrate (design)

Date: 2026-11-01. Branch `reframe/sweep-calibrate`, built on `main` at `88e8756` (plan 6 merged).

## Scope

Two things, and nothing else:

1. **Sweep.** Every item parked in the six follow-ups files and in the "Known limits" sections of `BUILD_STATE.md` is classified as **do**, **keep parked** or **obsolete**, with evidence. The "do" items are small, safe and a clear gain for the owner, a developer or an agent. No features, no refactors.
2. **Calibrate, honestly.** Every threshold that is still a guess is listed with its definition, the tests that pin it, the evidence the repository holds, a decision and the risk. One value changes (a ruling below); the rest stay as they are and get an owner-run **calibration report** (`npm run calibrate`) that reads the owner's local brain, prints distributions beside the current thresholds, and suggests values with reasons. It changes nothing by itself.

Standing rules: `AGENTS.md`; the owner's rule that every decision improves user, developer and agent experience together without breaking anything.

## Frozen boundaries

Untouched, byte for byte: Dodo billing, the money ledger, hosted and managed code, every `dodo*`, `billing*`, `managed*` and `paddle*` file and test, `managedPreferencesPatchSchema`, every migration already applied, and these docs: `docs/DODO_PAYMENTS.md`, `docs/RELEASE.md`, `docs/IMPLEMENTATION_PLAN.md`, `docs/PRICING_PROPOSAL_2026-10-21.md`, `docs/BUSINESS.md`.

Never run: `scripts/native-client-proof.ts`, `scripts/system-one-live-proof.ts`, `scripts/recall-agent-proof.ts`, `scripts/better-search-proof.ts`. This plan edits the first one and adds a refusal test for it, like the one `recall-agent-proof.ts` already has.

Never read: the owner's `data/` folder, any `brain.sqlite` outside a test temp folder, any `.env`.

## Part A: sweep inventory

Verdicts: **do** (small, safe, clear gain; batched in plan Task 1 unless named otherwise), **keep parked** (with a reason), **obsolete** (with evidence). Line numbers are those of `main` at `88e8756`.

### `docs/superpowers/plans/2026-10-23-connections-v2-followups.md`

| Item | Verdict | Evidence or reason |
| --- | --- | --- |
| Repeated agent proposals: `propose()` has no dedupe for queued gates | keep parked | A behaviour change in `brief.ts`/`service.ts` that needs its own design (which duplicates count, what the agent is told). Not a sweep fix. |
| CLI orphan on unexpected errors | keep parked | Needs a run of the real CLI start path on the owner's machine to confirm the orphan; the fix touches process lifetime code that this plan cannot verify. |
| Windows process tree after SIGTERM | keep parked | Owner's machine only. |
| Key files for expired grants | keep parked | Touches `scripts/restore.ts` (sensitive restore path) and grant expiry; too big for a sweep. |
| Connect service: crash between `createGrant` and the key write | keep parked | The owner can revoke the live grant; a transactional fix spans storage and the file system. |
| Partial key file on a failed write | keep parked | Same as above. |
| `checkConfigDir` uses `INVALID_INPUT` with 409; swallowed revoke has no log line | keep parked | Code-and-copy polish without a shipped defect. |
| `..x` containment tests; "do not unlink a key file this call did not write" unpinned | keep parked | Test strengthening without a known defect. |
| `JSON.stringify` and U+007F / lone surrogates in TOML | keep parked | Needs a TOML escaping routine and tests; a path with those characters is refused today only for NUL. |
| Quote stripping in `detectAgents` on every platform | keep parked | Harmless; cosmetic. |
| Codex keys verified only by the owner-run proof; `startup_timeout_sec = 15` | keep parked | Needs a native run. |
| `createGrant` repeats the `AGENT_CLIENTS` enum; raw client string in `connections()` | keep parked | Refactor. |
| Managed-mode pair-link paths untested | keep parked | Managed code is frozen. |
| 5-link cap and 120 s boundary untested | keep parked | Test gap with no defect. |
| `findOpenQuestions` splits sentences inside a decision | keep parked | Product rule question (adds no capability); needs a ruling on open-question detection. |
| `agent_note` idempotency row outside the transaction | keep parked | Correctness nuance under a crash window; needs a design for idempotency rows in transactions. |
| Connections UI: empty status lines when `/agents` fails | keep parked | UI polish with no wrong data shown. |
| Windows-style folder placeholder on every OS | keep parked | Cosmetic. |
| Folder pre-fill from an ended grant | keep parked | Small UI logic change; needs a browser test. |
| "Enter the project folder" after a connect error; toggling the panel during `add()` | keep parked | UI edge cases; need browser tests. |
| No tests for aria, focus moves, focus-triggered refresh | keep parked | Test gap. |
| Managed BiBrain on the CLI's port says "Something else is using port" | keep parked | Managed path. |
| `agent-grants.test.ts:41,45` unescaped backslashes | **do** | `"C:\work\northstar"` is the string `C:worknorthstar`; `createGrant` validates `folder` only as `z.string().max(1000)` (service.ts:2485), so `"C:\\work\\northstar"` passes on Windows and on Ubuntu CI. |
| Migration-6 upgrade test seeds no grant; no single-marker assertion | keep parked | Test gap. |
| `briefInput` comment "Grants carry no display name…" is false | **do** | service.ts:4613; the next line names agents by `agentDisplayName(g.client)`. One comment line. |
| Managed-decision-advisory-migration test title says v5 while asserting 6 | keep parked | `managed-*` tests are frozen. |
| Reason code `exact_structured_assertion` for an agent's queued exact fact | keep parked | Reason codes are part of the gate contract; a rename needs its own change. |
| `agent-proposals.test.ts` does not assert the proposing agent is kept | keep parked | Test gap. |
| SIGTERM handlers never fire on win32 | keep parked | Platform note, stateless adapter. |
| `bibrain help` omits `--no-open` and the `connect` flags | obsolete | `apps/cli/bibrain.mjs:216` lists `start --no-open`; `connect` is agent-internal and the help says so (line 224). |
| `playwright.config.ts` creates `data/e2e-agent-home-<stamp>` and never cleans up | keep parked | Test infrastructure, git-ignored. |
| README quick-start sentence unwrapped | keep parked | Cosmetic. |
| Full Vitest runs time out under load | keep parked | Environment; `--maxWorkers=3` is the recorded mitigation. |

### `docs/superpowers/plans/2026-10-23-your-brain-v2-followups.md`

| Item | Verdict | Evidence or reason |
| --- | --- | --- |
| Task 1 (eight items): quarantine-placeholder test, offset and cap test gaps, `localeCompare` on timestamps, list markers not deduped, `evidenceOf` twice, mid-line marker, 300-code-point drop, leading-whitespace test | keep parked | Test gaps and polish in `questions.ts`/`brief.ts` without a shipped defect; `localeCompare` on ISO strings sorts correctly for same-offset timestamps. |
| Task 2 (twelve items): authorization tests with a non-existent grant, untested partitions, withdrawn-original gates, unbounded lists, forged signatures, timestamp sort, cross-project stale card count, `briefInput` cost, failed-jobs LIMIT, unsalted SHA-256, `briefInput` public | keep parked | Test gaps, performance notes and design questions (HMAC for question signatures) that need their own change. |
| Task 3 (five items): untested refusal branch, bare `toThrow()`, `claimHistory` refusals untested, un-awaited `app.close()`, uncapped history | keep parked | Test strengthening; no defect. |
| Task 4 (nine items): 20-per-kind cap untested, search-level withdrawal test, placeholder matches, evidence validation cost, locale fold, UTF-16 `min(2)`, Greek final sigma, newline snippet | keep parked | Test gaps and known limits of substring folding; plan 5 replaced the search core with recall, so several no longer describe the live path but are kept as notes. |
| Task 5: Today 320px dark test uses `emulateMedia` | keep parked | Test infra for Today (Your brain was fixed in Task 10). |
| Task 5 (eight items): project switch races, `loadError` not cleared, "Show 50 more" count, shared state reload, copy ("Prepare now", "Keep raw only"), 320px coverage, `friendlyError` import, `.yb-plist` styles | keep parked | UI polish and copy that need browser tests; none shows wrong data. |
| Task 6 (seven items): 409 recovery, unreachable 1,000-character check, test strength, DRY/a11y, focus restore windows, Safari/Firefox focus, untested busy states | keep parked | UI polish; the 409 recovery is a real UX gap but needs a design (show the newer text). |
| Task 7 (seven items): focus after Mark answered, duplicated wrapper, `useRef(new Map())`, stale view on failed read, untested branches, slow-read delay, 2.5 s poll cost | keep parked | UI polish and performance. |
| Task 8 (nine items): factId marking, Brief quote button, scroll-into-view, raw state label, duplicated labels, test gaps, indentation, duplicated-quote flash, stale-options test | keep parked | UI polish; test gaps. |
| Task 8: `docs/UX.md:46,163` still describe "Edit understanding" and "Continue in another agent" | obsolete | `grep` of `docs/UX.md` for either string finds nothing. |
| Task 9 (eight items): untested paths, Prettier churn, aria-live scope, "Searching…" reset, overflow-wrap, `query.trim()` twice, vacuous late-response assertion, alerts below results, no failed-Undo browser test | keep parked | UI polish; test gaps. |
| Task 10: promote test checks entity and "paused" separately; `getJson` dropped `.ok()`; duplicated helpers; untested origin tags; unasserted zero state; filename-only handoff assertion; commit message wording; post-reload check; "Replaces: free" substring; fixed sleeps | keep parked | Test polish. |
| Task 10: `README.md:134` still embeds `docs/screenshots/project-focus.png` | obsolete | README embeds only `today-v2-brief.png` (line 15) and `today-v2-ask.png` (line 52). The unreferenced `project-focus.png` file is harmless and left alone. |
| Task 11: correction card shows only the earlier value; `decision_history` has no integration test | keep parked | Test gap and a UI design question. |
| Task 11: `BUILD_STATE.md:19` says CurrentKnowledge's CSS was removed | keep parked | Now line 382 of a shipped plan's record ("Removed project-focus.tsx, CurrentKnowledge and their CSS"); the sentence is true of project-focus and the plan's history is not rewritten. |
| Task 11: `docs/IMPLEMENTATION_PLAN.md:162` and `:238` name removed features | keep parked | Frozen doc. |
| Task 11: `docs/UX.md:116` old no-result copy | **do** | Now line 146 reads "No matching notes. Try a different word or save something new."; the app says "No matches. Try a different word, or save something new." (`apps/web/brain/BrainSearch.tsx:120`). |
| Task 11: `docs/UX.md:46` says facts "appear" | **do** | Now line 46; facts appear once kept. One clause. |
| Task 11: `docs/UX.md:113` "Needs a decision here" listed as always present | keep parked | Now line 143 lists the project page's sections, which is accurate as a list. |
| Task 11: `docs/UX.md:135` "Preview agent handoff" | **do** | Now line 159; the button reads "Preview handoff" (`apps/web/brain/BrainView.tsx:170`). |
| Task 11: `docs/UX.md:43-47` and `90-98` describe a "first useful loop" and receipt preparation state | **do** (43–61 only) | Lines 43–61 still describe the "first useful loop" and "Keep this up to date only after the first useful result", which Today v2 removed (BUILD_STATE 2026-10-23). Lines 88–98 now describe the Brief and are current. |
| Final review (two groups, about twenty items): `done()` races, stale-evidence gates shown nowhere, `friendlyError` wording, `maxLength` truncation, duplicated types, `brainProject` cost, v1 history label, copy, fixed sleeps, `questions.ts` import of `detectSecrets`, focus flags, NFC/NFD literal bytes, `BrainSearch` limit copy, write-only `localStorage`, locale risks | keep parked | Each needs a design or a browser test; none puts wrong data in front of the owner. |

### `docs/superpowers/plans/2026-10-24-system1-clef-followups.md`

| Item | Verdict | Evidence or reason |
| --- | --- | --- |
| Owner-run live proof | obsolete as "owed" | Run on 2026-10-27 through Ollama Cloud, clef-flash, 3 of 3 validated (BUILD_STATE lines 229–234). Its calibration notes are Part B's evidence. |
| Monthly cap | keep parked | Ledger changes in billing-adjacent code (frozen). |
| Captures in unwatched projects still get `derive_brief` | keep parked | Product decision recorded as a known limit. |
| Transient outages not retried (Ruling 15) | keep parked | Ruling stands. |
| Ollama tests do not pin a nonzero output price, `http://ollama.com`, an empty key | keep parked | Test gap. |
| `PreparedAsk.provider` free string; `as unknown as` cast | keep parked | Typing polish. |
| `run.mjs` strips `BRAIN_DECISION_API_KEY`; one documented list of worker-only secrets | keep parked | Documentation refactor across run.mjs and docs. |
| Dismiss on proposal and stale cards is not logged | keep parked | No sorting answer causes them; correct as is. |
| No test that accept-with-edit logs `fix` | keep parked | Test gap. |
| No action judges `kind` | keep parked | By design; the calibration report shows the `kind` distribution and names this as a gap (Part B). |
| `entities()` scans for `s1_answer`/`s1_feedback` | keep parked | Fine at V1 scale. |
| A Keep queues one more sorting call | keep parked | Known limit. |
| `fileSuggestion` skips `editSource`'s zod re-parse | keep parked | Values come from the stored source. |
| A stray `{}` block in `editSourceTx` | obsolete | `editSourceTx` (service.ts:1105 onward) has no `{}` statement block on `88e8756`. |
| A rolled-back Keep may leave a vault file | keep parked | Existing `editSource` exposure. |
| Failed receipts in the exported dreams log | keep parked | Needs a product ruling. |
| `hasUnresolved` mis-key with both accountings | keep parked | Fails safe; never built. |
| Aborted signal reserves then releases | keep parked | One extra ledger write; ledger code is frozen. |
| Skip reason by `/secret/` match; too-large message untested | keep parked | Copy and test gap. |
| Web `BriefItem` lacks `quiet?` | **do** | `packages/domain/brief.ts:22` has `quiet?: true`; `apps/web/today/types.ts:17` lacks it. One type line. |
| Keep toast parses the card title | keep parked | UI polish. |
| Unavailable-status line and consent 409 path have no browser test | keep parked | Test gap. |
| "facts still listed" compares two empty lists | **do** | `tests/integration/watch.test.ts:35` compares `view.facts` with `before.facts` after a capture that creates no accepted fact. Seeding one accepted fact makes it a real check. |
| Settings reads worker liveness on load and after save | keep parked | A few seconds of lag; UI polish. |
| `brief_quiet` entries stay after a decision | keep parked | Bounded at 2,000; lookups use live ids. |

### `docs/superpowers/plans/2026-10-25-recall-followups.md`

| Item | Verdict | Evidence or reason |
| --- | --- | --- |
| Task 1: embedding proof shape lost "unverified" | keep parked | Plan 5b added the real embedded count. |
| Task 1: property test swallows errors; no success counter; missing ops | keep parked | Test strengthening. |
| Task 1: FTS injection test asserts only `not.toThrow` | keep parked | Test gap. |
| Task 1: 100k test timing | keep parked | Flake note. |
| Task 1: `SELECT c.*` returns the embedding BLOB | obsolete | `searchRecallChunks` selects explicit columns (`recall-index.ts:370`). |
| Task 1: `syncSource` query has no `ORDER BY` | obsolete | `recall-index.ts:292` orders by `id`. |
| Task 1: `fillRecallIndex` and `rebuildRecallIndex` duplicate logic; `fillRecallIndex` dead | obsolete | Plan 6 removed `fillRecallIndex` (BUILD_STATE 2026-10-28). |
| Task 1: post-commit refill throws after commit | keep parked | Self-heals on reopen. |
| Task 1: topic hints dead until task 9 | obsolete | Task 9 shipped; `recordSystemOneResult` stores `topic_options` (service.ts:4713). |
| Task 2 (thirteen items): `no_match` next step overclaims, fact text from the index row, test titles, duplicated term logic, early returns, unvalidated internal input, eval `afterAll`, history boost unpinned, expired claim open, live `current_version` on an older open, not-yet-valid label, scan costs, p95 flake | keep parked | Design notes, performance notes and test gaps without a shipped defect. |
| Task 3 (six items): facts from the 20 mixed hits, Ask tests on old code, literal fallback dropped once FTS returns, `answered:true` ignores partial, over-fetch coupling, fact and original of one note in Ask | keep parked | Product decisions and test notes. |
| Task 4 (four items): HTTP validation tests, historical-version rule, not-found message, vacuous e2e before check | keep parked | Test gaps; the e2e before check was covered by the owner-run proof. |
| Task 5: no stdio test for `no_match`; `factTexts` fails open on amber; capabilities untested through a client; `any` signatures | keep parked | Test gaps; the cobalt check keeps the proof safe. |
| Task 5: `BUILD_STATE.md:87` still says `brain.note` | obsolete | `grep brain\.note BUILD_STATE.md` finds nothing. |
| Task 6 (four items): hook-state write order, non-atomic write, loopback lookalikes, budget from `timeOrigin` | keep parked | Plan-mandated or bounded by the host timeout. |
| Task 7: digest text outside the data header; one JSON setting for the log; secret-scan drop logs as none; `hitIsStrong` after dedupe; old footer wording in plan docs | keep parked | Design notes; the log shape is what the calibration report reads (Part B). |
| Task 7: "Recently changed" digest; ZWJ/ZWNJ in `oneLine` | obsolete | Marked fixed in the final wave in the file itself. |
| Task 8 (four items): orphan second file, empty dirs, preview of an existing second file, shell metacharacters in the hook command | keep parked | Need a design for atomic multi-file writes and shell quoting; the hook command is covered by the owner-run proofs on both clients. |
| Task 9 (seven items): secret-shaped entity name refuses the whole request, length caps, whitespace, `systemOneContext` 3×, untested `tN` mapping, unvalidated `sentEntityNames`, uncapped `topic_options` | keep parked | Polish; the worker is the only caller. |
| Task 10 (eight items): `judgeRanked` catch-all, untested deviations, stale comment, all-0.0 judge, web refresh in managed mode, UTC day vs time zone, `releaseUndispatched` throw, late result discarded | keep parked | Ledger-adjacent or spec-sanctioned. |
| Task 11: `pass_cubed` name when `REPEATS != 3`; proof setup before `try`; refusal test misses `data/recall-*-proof.json`; `hook_fired` counts any status | keep parked | Owner-run script polish; the plan may not run it. |
| Task 11: whether `--restricted` loads project settings | obsolete | Answered 2026-10-27 (PR #29) in the file itself. |
| Task 11: stale comments service.ts:3461 and agents.ts:75 | obsolete | Marked fixed in the final wave. |
| Owner-run checks owed: `proof:recall` both clients, hook on and off | obsolete | All four runs passed on 2026-10-27 (BUILD_STATE table). |
| Owner-run checks owed: `scripts/native-client-proof.ts` | keep parked (harness fixed here) | Still not re-run; it has the Codex trust problem PR #30 fixed in the recall proof. **Plan Task 2 applies the same fix**; the run stays the owner's. |
| Owner-run checks owed: `proof:sorting` | obsolete | Ran 2026-10-27, 3 of 3. |
| Calibration notes (durable 0.23, `fact` 0.59, review 0.68) | **do** (Part B) | These are the evidence for the rulings below. |

### `docs/superpowers/plans/2026-10-27-better-search-followups.md`

| Item | Verdict | Evidence or reason |
| --- | --- | --- |
| Task 1: `LOOPBACK_HOSTS` and the model-name pattern duplicated | keep parked | A DRY move across two provider files; cosmetic. |
| Task 1: tests lack loopback-bypass names, non-finite element, error status, odd base64 | keep parked | Test gap. |
| Task 1: Cloudflare `truncate_inputs` unverified | keep parked | Owner-run `proof:search` decides. |
| Task 2 (five items): unit query assumption, `subarray` buffer, fingerprint index, fingerprint collisions, stale-scope pruning | keep parked | Performance and rare-collision notes; the write stamp covers production writes. |
| Task 3 (six items): holds on timeout, `EMBED_CALL_MS` race, paused queue, `retry_at` after a cap raise, missing reason after restart, daily-cap refusal recognised by message | keep parked | Ledger-adjacent or by design. |
| Task 4 (six items): `last_error` not cleared, unbounded query cache, dead `request_hash`, ledger retention, slow shutdown, weak crash-sweep test | keep parked | Worker lane polish; the query lane handles money. |
| Task 5: dense-only near misses say "matched 0 of N terms" | keep parked | Wording only; a test needs a dense-only near-miss fixture that the fake lexicon does not obviously provide. The right wording ("similar meaning, below the cut") is recorded here for the next pass. |
| Task 5: fuse tie-break with random ids; full push led by a meaning-only hit | keep parked | Spec-sanctioned (R2). |
| Task 6 (two groups): `any` helper, status line precedence, "N of M ready" refresh, selectable Cloudflare radio, leak regex, missing link, rendered-card test, Cloudflare in a rethrown message | keep parked | Settings polish. |
| Task 7: closing leak probe; `para-01` word overlap | keep parked | Test note. |
| Cache memory; incremental matrix; double embedding of a sorted note | keep parked | Known limits (R12, I-08, I-15). |
| Owner-run `proof:search` owed; Tamil quality unmeasured | keep parked | Owner-run. The report in Part B cannot replace it (see gaps). |
| Parked after the re-review: interrupted row-by-row pass; one bad passage reopening the breaker; local refusal blocks the all-refused rule | keep parked | Each is recorded with its follow-up; the worker batch path handles money and outages. |

### `docs/superpowers/plans/2026-10-28-cleanup-followups.md`

| Item | Verdict | Evidence or reason |
| --- | --- | --- |
| `docs/DODO_PAYMENTS.md:4-5` says Paddle config refuses startup | keep parked | Frozen doc (owner edits pending). |
| `docs/RELEASE.md:154` mentions `BRAIN_PADDLE_ALLOW_LIVE=1` | keep parked | Frozen doc. |
| `docs/IMPLEMENTATION_PLAN.md` Paddle B1 checklist | keep parked | Frozen doc. |
| Today default's unused `receipts: []` | keep parked | Not dead: the server still sends `receipts` in the Today payload (`apps/server/app.ts:803`) and `BriefCard.tsx:119` posts to `/receipts/:id/undo`. |
| `paddle.ts` comment misdescribes `paddle-store`'s import | keep parked | Frozen file. |

### `BUILD_STATE.md` "Known limits"

| Item | Verdict | Evidence or reason |
| --- | --- | --- |
| Plan 6: nothing in the hosted edition run live; frozen docs stale; `receipts: []`; `paddle.ts` comment | keep parked | Frozen or not dead (above). |
| Plan 5b: no live embedding call; `truncate_inputs`; Tamil quality; floor and weight initial | keep parked / Part B | Owner-run proof; thresholds handled in Part B (report-only). |
| Plan 5b: term-based push level; cold worker words-only; matrix reload; local app only; no hosted Ollama | keep parked | Design decisions. |
| Plan 5: no live judge call | keep parked / Part B | No evidence exists; the report logs judge signals once the owner turns Recall help on. |
| Plan 5: `scripts/native-client-proof.ts` not re-run, same Codex trust problem | **do** (harness) | Plan Task 2 fixes the harness; the run is the owner's. |
| Plan 5: Cursor not run natively; `cmd.exe` quoting unobserved | keep parked | Owner's machine. |
| Plan 5: thresholds uncalibrated until the recall log has data | **do** (Part B) | The report is how the log is read. |
| Plan 5: `source_fts` retained; wall-clock tests flake; spec text superseded | keep parked | A table drop is a migration (frozen); flake notes; recorded. |
| Plan 4: no live call (now made); monthly cap; no retry; System 2 wake rule; Watch not exported; Keep re-sorts | obsolete (first) / keep parked (rest) | The live call happened 2026-10-27; the rest are design limits. |
| Plan 3: `bibrain` not on npm; one-step only local; native proof not run; `npx --no-install bibrain start` not run on the owner's machine | keep parked | Owner's machine and release decisions. |
| Plan 2: Goals until Watch; questions by rule; search substring until plan 5 | obsolete | Plans 4 and 5 shipped Watch and ranked recall; the entries describe a past state in a dated section and are not rewritten. |
| Plan 1: no System 1 routing; no plug-and-play; `today-v2.spec.ts` near the rate limit | obsolete (first two) / keep parked | Plans 3 and 4 shipped; the rate-limit note stands. |

**Counts.** do: 10 (eight sweep edits in plan Task 1: four code or test lines and four `docs/UX.md` passages; the native proof harness in Task 2; the calibration notes consumed in Part B); obsolete: 18 rows with evidence above; keep parked: every remaining row, each with its reason.

## Part B: calibration

### Thresholds: definition, pins, evidence, decision, risk

| Threshold | Current value and location | Pinned by | Evidence in the repo | Decision | Risk |
| --- | --- | --- | --- | --- | --- |
| Clef `durable` demotion line | `DURABLE_LOW = 0.25`, `packages/storage/recall-index.ts:35`; `durableBoost` returns ×0.9 below it, ×1.15 at or above `DURABLE_HIGH = 0.6` | `tests/integration/recall-index.test.ts:101-104` (0.7 → 1.15, 0.1 → 0.9, 0.4 → 1, null → 1); `tests/integration/recall-capture-hints.test.ts:41-50` (0.9, 0.1, 0.4) | Owner run 2026-10-27 (`proof:sorting`, Ollama Cloud, clef-flash): the Inbox **decision** "We decided Northstar ships with one plan." scored durable **0.23**, under the line, though a decision should count as lasting (BUILD_STATE 233–234; recall follow-ups 165). No golden case carries a durable hint. | **Change 0.25 → 0.20** (Ruling R1). Pin: `durableBoost(0.23) === 1`, `durableBoost(0.19) === 0.9`, and the evidence sentence at 0.23 keeps boost 1 in the capture-hints test. | A note Clef rates between 0.20 and 0.25 loses a ×0.9 demotion and ranks slightly higher. The demotion never excludes anything, the golden set has no durable hints, and the sample is one owner run; the report tracks decisions under the line so the next move has more than one case. |
| Clef `show` quiet line | `S1_THRESHOLDS.quiet = 0.3`, `packages/domain/system-one.ts:16` | `tests/integration/system-one-questions.test.ts:83-86` | Same run: small talk scored show 0.23 and was quieted, as intended. | No change; report-only. | None. |
| Clef `review` wake line | `S1_THRESHOLDS.review = 0.7` | Same test | Same run: the open question scored 0.68, just under. One case; waking a review queues a paid System 2 job. | No change; report-only (the report counts answers in [0.6, 0.7)). | Lowering on one case would spend money on more reviews with no owner signal on whether they help; nothing records whether a wake was right (gap). |
| Clef `project` file line | `S1_THRESHOLDS.file = 0.7` | `system-one-questions.test.ts:62-72` | Same run: the decision was routed to Northstar at 0.96. | No change; report-only (keep vs dismiss by confidence bucket). | None. |
| Clef `changes_fact` line | `S1_THRESHOLDS.changes = 0.5` | none directly | No live answer recorded (the proof notes had no current facts). | No change; report-only. | None. |
| Clef `kind` | no threshold; `adviseFrom` passes the choice through | n/a | Same run: small talk was classed `fact` (0.59). Nothing acts on `kind` and no owner action judges it. | No change; the report shows the `kind` distribution with mean confidence and names the missing owner signal. | None. |
| Recall push bands (deterministic) | `deterministicLevel` and `matchNeeded` in `packages/domain/recall.ts` (full needs `strong`; pointer needs an exact entity or `matched >= min(2, terms)`) | `tests/integration/recall-push.test.ts:39-43`; golden gates in `tests/eval/recall.test.ts` (positive push rate, generic-level hard gates) | Four owner runs 2026-10-27 (Claude Code and Codex, hook on and off): five brain prompts pushed full, one pointer, all four generic prompts none; no canary leaked (BUILD_STATE table 209–218). | No change; report-only (level by client, candidates and hits distributions). | None. |
| Recall push bands (judged) | `PUSH_THRESHOLDS = { owner_world_full: 0.6, owner_world_pointer: 0.35, general_none: 0.6, rel_relevant: 0.5 }`, `packages/domain/recall-push.ts:29` | `recall-push.test.ts:44-49` | No live judge call has ever been made (BUILD_STATE 238). | No change; report-only. New: the log row records the judge's `owner_world`, `general` and `answered` when a push was judged, so the report can show them. | None now; the fields are omitted when nothing was judged, so the dense-off snapshot is unchanged. |
| Recall help judge gating | `JUDGE_THRESHOLDS = { rel_keep: 0.2, rel_relevant: 0.5, answered_margin: 0.2 }`, `packages/domain/recall-judge.ts:16`; `recallJudgeAllowed` (consent, worker, cap, 2,000 per day, 100 micro-USD floor) | `tests/integration/recall-judge.test.ts:56` and the judge tests | None (no live call). | No change; report-only (judged share, `answered` distribution). | None. |
| Better search cosine floor | `DENSE_FLOORS["bge-m3"] = 0.45`, `DENSE_FLOOR_DEFAULT = 0.45`, `packages/domain/better-search.ts:12-14` | `tests/integration/embed-provider.test.ts:20`; the dense golden gates run on a fake embedder | No live embedding call has been made (BUILD_STATE 103). `proof:search` prints the cosine room and is owner-run. | No change; report-only. New: the log row records `dense_top` (the highest cosine among dense candidates) when a vector was used. | The floor hides every cosine under it, so the report sees only what passed; the proof remains the evidence for moving the floor. |
| Better search dense weight | `DENSE_WEIGHT = 0.7`, `better-search.ts:11` | `tests/eval/recall.test.ts` dense gates (paraphrase and cross-language ≥ 0.8, lexical and names never worse) | None live. | No change; report-only. | None. |

### Rulings

- **R1. `DURABLE_LOW` moves from 0.25 to 0.20.** The one recorded live answer that fell under the line was a decision at 0.23; a decision should not be demoted. The change is small, the demotion is only ×0.9 and never an exclusion, no golden case is affected, and the new tests pin 0.23 → 1 and 0.19 → 0.9. Cost if wrong: notes Clef rates 0.20–0.25 rank a little higher than before. The report shows decisions under the line, so the next ruling can rest on more than one case.
- **R2. Every other threshold keeps its value.** `show` 0.3 and `project` 0.7 behaved as intended in the live run; `review` 0.7 missed by 0.02 on one case and wakes paid work; the judge and the embeddings have never been called live. Guessing a new number from zero or one case would be the overfitting the brief forbids.
- **R3. The calibration report opens the owner's database read-only through `node:sqlite` (`DatabaseSync(path, { readOnly: true })`), not through `Storage`.** `Storage`'s constructor runs `CREATE TABLE IF NOT EXISTS`, migration markers, `PRAGMA journal_mode=WAL` and may backfill the recall index: those are writes. A read-only handle makes "never writes to the database" a property SQLite enforces, not a promise. The report reuses the storage layer's row shapes (the `settings` JSON values, the `entities` JSON `data`, `recall_chunks` columns) through one pure module, and the tests build their fixture through the real `Storage`/`Brain` write paths so the shapes stay in step. Cost if wrong: a future schema change must be mirrored in the report's reader; the tests catch that.
- **R4. The report never prints note text, and has no flag to do so.** The brief allowed an explicit flag; nothing in the report needs words, so no text path exists. It prints counts, histograms, thresholds and suggestions only. The s1 rows are reduced to `answers` and `advice` before anything else runs; `source_versions` is never read.
- **R5. Suggestions need at least 20 answers (or 20 feedback rows) per question.** Below that the report says "Not enough data yet (n of 20)". Every suggestion line names the evidence and ends with "Nothing changes unless you edit the code." The rules are deterministic and listed in the module so a reader can check them.
- **R6. Two small, content-free fields join the recall log, each only when its feature was used:** `dense_top` (highest cosine among dense candidates, three decimals) when a vector was used, and `judge: { owner_world, general, answered }` when the push was judged. Rows with Better search off and Recall help off are byte-identical to before, so `tests/eval/recall-dense-off-snapshot.json` is not regenerated. Without these fields the floor and the judge bands could never be read from real use.
- **R7. No deterministic push signals (`terms`, `matched`, `strong`) are added to the log.** They would change every row and force a snapshot regeneration, and the bands already have owner-run evidence.
- **R8. Thresholds stay where they are defined; a registry points at them.** `packages/domain/calibration.ts` exports `THRESHOLDS`, a documented table whose values are imported from `system-one.ts`, `recall-index.ts`, `recall-push.ts`, `recall-judge.ts` and `better-search.ts`. The three private constants in `recall-index.ts` (`DURABLE_LOW`, `DURABLE_HIGH`, `TOPIC_MIN_CONFIDENCE`) become exports. No value is copied by hand, so the registry cannot drift.
- **R9. The native proof harness gets PR #30's Codex fix; the proof is not run.** A refusal test (no `BRAIN_NATIVE_PROOF=1`, wrong client) mirrors `recall-agent-proof.test.ts`, so CI pins the guard without ever spending quota.
- **R10. No Opus task.** Nothing in this plan touches worker leases, the dispatch ledger or concurrency; the recall log write sits in `recallPush` after the judge has returned.

### The calibration report

**Command.** `npm run calibrate` runs `node --env-file-if-exists=.env --import tsx scripts/calibrate.ts`. Options: `--db <path>` (default `BRAIN_DB` or `data/brain.sqlite`), `--json` (the report object instead of text). Exit 0 after a report, 2 when the database cannot be opened.

**What it reads.** `settings.recall_log` (the last 2,000 pushes: level, counts, latency, `judged`, `dense`, and the new `dense_top` and `judge` fields), `entities` of kind `s1_answer` (only `answers` and `advice`) and `s1_feedback` (`question`, `choice`, `confidence`, `action`), and `recall_chunks` counts of embedded rows per `embedding_model`. It refuses a database whose `migrations` version is above 7.

**What it prints.** A header stating that it only reads, changes nothing and sends nothing; the thresholds table (id, value, where); sorting help: answers, histograms (ten bins) of `show`, `review`, `changes_fact` and `durable`, the `kind` distribution with mean confidence, decisions under and near `DURABLE_LOW`, kept-versus-dropped by bucket for `show` (accept/fix vs dismiss/reject), `project` (keep_file vs dismiss_file) and `changes_fact`; recall: pushes by client and level, candidates and hits buckets, judged share, `answered` counts and an `owner_world` histogram over judged rows, dense share and a `dense_top` histogram with the count near the floor; embedded rows per model; suggestions; gaps.

**Suggestion rules** (all need `n >= 20`):

- `recall.durable_low`: if at least a quarter of decision-kind answers have `durable < DURABLE_LOW`, suggest the 10th percentile of decision durables rounded down to 0.05 (never below 0.1); else hold.
- `sorting.quiet`: if fewer than 25% of reviewed `show` answers in [quiet, quiet + 0.1) were kept, suggest `quiet + 0.1`; if at least half of those in [quiet − 0.1, quiet) were kept, suggest `quiet − 0.1`; else hold.
- `sorting.file`: if fewer than half of `project` answers in [file, file + 0.1) were kept, suggest `file + 0.1`; else hold. The report says cards under the line are never shown, so no evidence for lowering can appear.
- `sorting.review`, the judge bands and the dense floor: descriptive only (distributions and near-line counts), because no owner signal or ground truth exists for them.

**Gaps the report names when they apply.** No owner action records whether a `review` wake was right; `durable` and `kind` receive no feedback; rows written before this version carry no `judge` or `dense_top`; the floor hides every cosine below it (use `npm run proof:search` for the room around the floor); the log keeps only the last 2,000 pushes; owner searches (Ask, Your brain) are never logged, by design.

**Privacy rules.** Read-only handle; no network; no `source_versions` read; no text field in any output; the s1 rows are reduced to numbers and ids before the report runs; the test asserts that a canary word placed in a note never appears in the output and that the database file's bytes are unchanged after a run.

**CI.** `tests/integration/calibration-report.test.ts` runs the pure module on synthetic rows (including the 0.23 decision) and the script against a synthetic brain built in a temp folder with the real write paths. Real data is read only when the owner runs the command.

## Out of scope

Features, refactors, any change to frozen code or docs, running any owner-run proof, reading any real data, and tuning on the synthetic golden set.
