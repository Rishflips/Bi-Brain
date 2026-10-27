# Recall (plan 5) follow-ups

This file keeps two records from the subagent-driven build of
`docs/superpowers/plans/2026-10-25-recall.md` (branch `reframe/recall`):

- every ruling the controller made on the owner's behalf;
- every minor review finding that was deferred rather than fixed.

The final whole-branch review (Fable) triaged the deferred minors. Six were fixed
before merge: the four Important findings plus two one-line fixes. The items below
ship as known limits or later polish.

## Rulings

Each ruling reads: what was decided, why, and what it costs if wrong.

- Global constraint said package.json is never edited but task 11 adds a proof:recall script line; amended the constraint to allow only that line — the spec says no new dependencies, not no script — cost if wrong: one extra script line to remove.
- Pre-flight conflict scan delegated to a Sonnet scanner that writes the table to preflight.md; controller rules on each finding — keeps 4,220 plan lines out of controller context — cost if wrong: a missed conflict surfaces in task review instead.
- Revise the plan before Task 1 (one Fable plan-fix pass over every blocker and important, then a scoped re-scan) — fixing them inside per-task loops would cost dozens of rounds — cost if wrong: one extra planning pass.
- A23 recall_help_enabled must not enter the prefs() object that managed code spreads into managedPreferencesPatchSchema; store it as its own setting with its own owner read/write path (Settings UI saves it alongside) — managed code and schema are off-limits (R5) and managed save must keep working — cost if wrong: a slightly separate save path.
- A24 golden/push fixtures put identity text (names, preferences) only in private sources, so canaries never sit in a project-visible original — project-visible originals are legitimately readable by agents today — cost if wrong: none, fixture only.
- C4 capture-time topic options come only from agent-visible current claims (project visibility, not name/preference, not owner_private) — keeps owner-only facts off the wire under the sorting consent — cost if wrong: fewer topic options.
- D7 fix agentGet's historical branch to apply the owner_private/name/preference exclusion for agents, with a test, in the task that introduces brain_open — brain_open must not widen exposure — cost if wrong: none.
- A14 native-proof before-review check asserts the first recall has no fact hit (an original may legitimately give found) — matches the shifted semantics the spec names — cost if wrong: weaker check.
- B33 no first-prompt digest when the prompt level is none; digest rides only on pointer/full — quiet is a product state; server instructions already introduce the brain — cost if wrong: agents learn of the brain one prompt later.
- A7 Your brain search keeps a literal-substring fallback when the FTS path yields nothing or the query has words under 3 characters — no owner-visible regression — cost if wrong: a little extra code.
- B18 deterministic push rule must be re-tuned so natural multi-word prompts can reach full and a single weak OR match does not give pointer; the golden-set gates decide — the spec's numbers were initial bands — cost if wrong: retune later from the recall log.
- A26 judge jobs stay (ledger FK) but the daily count uses an index added in migration 7; the sweeper marks them cancelled — cost if wrong: index size.
- A3/A10/A22 and every other test or call site broken by renames, version bump or new required fields are updated in the same task that breaks them, listed in that task's Files and run list — cost if wrong: none.
- B18 deterministic rule — "matched" = terms covered by the best of the top 3 candidates; strong fact needs min(2, terms) covered; pointer needs that or an exact entity match; golden set gains 4 proof sentences (full) and 2 generic (none); positive push gate "all but two" — cost if wrong: retune from recall log.
- B16 new freshness value `retired` for a non-current claim nobody superseded — cost if wrong: one more enum value for agents.
- B42 judge refused when today's remaining cap < 100 micro-USD (JUDGE_MIN_REMAINING_MICRO_USD) — cost if wrong: judge skipped near the cap.
- B35 rollback test uses `.cursor/rules` as a file — cost if wrong: none.
- A7 literal fallback only in searchBrain via findInBrain; ask keeps its stopword guard — cost if wrong: none.
- B19 entity names and digest from direct agent-filtered SQL; claims verified lazily per project — cost if wrong: perf only.
- B13 per-hit claim.version === ref_version check plus a stale-row test — cost if wrong: none.
- Spec text superseded by these rulings (spec §3 "withheld", §5.1 sweep, §9.8 "judge can only lower", Freshness contract) stays in the spec; the plan and BUILD_STATE record the change — cost if wrong: a reader of the spec alone sees older text.
- Skip the second full re-scan; the per-task review loop is the net — Fable traced each fix by hand and in scratch — cost if wrong: extra fix rounds.
- Task 1 concern 2 — accept filtering recall_index_built out of the two managed-decision-advisory migration test comparisons (test files only; migration 7 legitimately adds that settings key; no managed source touched) — cost if wrong: revert two test lines.
- Task 1 plan-mandated findings 2 (chunk hard cap), 4 (forget text_matches), 5 (rebuild flag), 6 (single-transaction whole fills) are fixed, not kept — the spec binds: hard max 1,200; forget proof honest; transactions short — cost if wrong: small extra code.
- Task 1 ⚠️ private-evidence facts — fact rows get visibility 'owner' when any evidence source is private (defense in depth; task 2's per-hit check still applies) — cost if wrong: an owner-only fact hidden from agents that might have been agent-visible.
- Task 2 plan-mandated findings 2 (exactEntity existence oracle over hidden evidence) and 3 (latency gate without facts) are fixed — spec invariant: authorization traps appear in no field or level; latency gate must reflect real brains — cost if wrong: small code.
- Task 2 minor "historical agentGet skips owner_private" promoted to the fix loop — it is the pre-flight D7 ruling, owed by the task that introduces brain_open (this one) — cost if wrong: none.
- Task 2 minors "catch {} swallows every error (hypotheses silently dropped)" and "agentOpen compare changed always true" promoted — swallowed errors and wrong output are correctness, not polish — cost if wrong: none.
- Task 4 leaves mcp.test.ts and bibrain-cli.test.ts failing until Task 5 (planned back-to-back; MCP adapter still calls removed v1 routes) — no push or PR before Task 5 lands; native-client-proof.ts /agent/ask belongs to Task 5, docs/API.md and BUILD_STATE to Task 11 — cost if wrong: two red tests for one task's span.
- Task 5 brain_note description reworded to 'Each note waits for the owner's review and never becomes an accepted fact on its own' to reconcile the brief's description with its own test — cost if wrong: one sentence.
- Task 7 important 2 (weak leftover hit pushed as full after dedupe) is fixed though the brief specified it — quiet is a product state and the owner flagged it — cost if wrong: fewer full pushes on repeated prompts.
- Task 7 minor "PUSH_FOOTER 'cite ids you use' is an imperative" promoted and reworded to a factual line — global constraint "factual statements, never imperatives" binds over plan copy — cost if wrong: one string.
- Task 7 minor "code-point vs UTF-16 truncation mismatch" promoted — budgets are hard limits — cost if wrong: none.
- Task 8 R2 outcome CODEX_HOOKS_CONFIRMED = true (implementer read learn.chatgpt.com/docs/hooks: project .codex/hooks.json, UserPromptSubmit command hooks, additionalContext added as developer context); reviewer re-verifies the page — cost if wrong: a Codex hook file Codex ignores.
- Task 8 rollback test asserts the existing behaviour (grant revoked, one Revoked row) instead of the brief's connections() == [] — "rolls back exactly as today" binds; the brief's expectation contradicted current behaviour — cost if wrong: a Revoked row shown after a failed add.
- Task 8 plan-mandated vacuous Cursor rollback assertion and untrue per-client preview copy are fixed — a test that asserts nothing and copy that states something false are defects whatever the plan says — cost if wrong: none.
- Task 8 minor "Codex tile says on before /hooks trust" promoted — product rule: surface uncertainty, never claim live behaviour that is not yet true — cost if wrong: one copy string.
- Task 9 plan-mandated record-time recomputation of topic_options is fixed: the worker passes the entityNames it actually sent into recordSystemOneResult — a topic id must resolve against the list Clef saw — cost if wrong: one extra parameter.
- Task 10 implementer on Opus 5.5 instead of Sonnet — it is the riskiest task (new worker loop, ledger reserve/settle, lease/fence, key isolation, consent) and a shipped mistake costs money or leaks prompts — cost if wrong: higher spend for one task.
- Task 10 important (server timeout neither fences nor deletes the job state; worker never re-checks deadline before reserve) is fixed even though the brief's test asserted 'queued' — data minimization and no spend after the agent has its answer bind — cost if wrong: a judged answer occasionally discarded.
- Task 10 minors promoted into the same round: re-check allowed() before markDispatched and release on refusal; delete leftover result keys when the job is already cancelled; all-0.0 test must assert a demotion happened — money safety, data minimization, a test asserting too little — cost if wrong: none.
- The judge may raise a push level within already-retrieved, already-authorized candidates (pushLevel thresholds per spec §5.1); docs must say so plainly instead of "only lowers noise" — the spec's thresholds intend it, it never adds hits or scope — cost if wrong: a judged push slightly louder than deterministic.
- Task 11 minor "README step 3 names only Claude Code" promoted (Codex hooks confirmed) — docs accuracy — cost if wrong: none. README test counts left to the controller's final verification.
- Final Important 4 is fixed in code, not only docs — the hook command's first token is written unquoted (process.execPath when it has no whitespace, else bare `node` resolved from PATH) and only the arguments are double-quoted, so Git Bash, PowerShell and cmd.exe all run it; docs/comment claims hedged — PowerShell treats a leading quoted string as an expression and cmd /c strips outer quotes, which would silently break the hook for a Windows Codex user — cost if wrong: on a machine whose PATH node differs from the launching node, the hook runs a different Node 24.
- Final Important 3 copy — Claude Code tile shows "Recall on every prompt: on after your next prompt" until recall.pushes > 0, then "on" — never claim live behaviour not yet true — cost if wrong: one copy string.
- Fix the managed e2e test data only — markers become token-distinct (different words and different random numbers); every isolation assertion unchanged — fits the label-only allowance for managed test files; ranked partial matches in owner search are intended — cost if wrong: owner search shows related notes for distinctive strings that have no exact match.

## Deferred minors

- Task 1: embedding proof shape lost "unverified" signal for a future embedding table (plan-mandated).
- Task 1: property test swallows errors with empty catch and has no per-op success counter; no project move/import/restore/s1_answer ops.
- Task 1: FTS injection test only asserts not.toThrow with its own quoting; real injection test belongs to task 2's buildFtsQuery.
- Task 1: 100k test times a re-sync, not the capture-time write; 400 ms timer may flake.
- Task 1: SELECT c.* returns the embedding BLOB; select explicit columns.
- Task 1: syncSource s1_answer query has no ORDER BY vs recallRowsFor entity order.
- Task 1: fillRecallIndex and rebuildRecallIndex duplicate clear/sync/flag logic.
- Task 1: post-commit recall refill in applyImport/rebuild throws to caller after commit (self-heals on reopen via flag 0).
- Task 1: fillRecallIndex is dead code with no test.
- Task 1: topic hints in s1HintsFor/chunkPrefix dead until task 9 stores topic_options.
- Task 2: no_match next_step overclaims when index_complete is false (text mandated verbatim).
- Task 2: fact text from index row, not recomputed from verified claim.
- Task 2: auth test title says rendered text but never calls renderRecallText; no owner_private-only fact in fixture.
- Task 2: whyFor/coverage/questionWordsOf duplicate term logic; questionWordsOf belongs in recall.ts; recallInternal long lines; service.ts +125.
- Task 2: entity-name SQL runs before stopword early return.
- Task 2: recallInternal takes unvalidated input (only recallCore validates).
- Task 2: eval writes metrics in afterAll even on failure; no pass/fail flag.
- Task 2: no unit test pins the history fact-boost deviation.
- Task 2: history hit for an expired-but-status-current claim shows retired but bare agentOpen({id}) is NOT_FOUND (fallback to own version when outside validity window would fix).
- Task 2: agentOpen exposes live current_version/checked_at when an older version is opened.
- Task 2: not-yet-valid claim opened by version labelled retired.
- Task 2: visibleEntityNames scans all current fact rows per recall; supersessions json_each scan per recall — fine now, index later.
- Task 2: wall-clock p95 test may flake on loaded CI (observed up to 216 ms vs 300).
- Task 3: searchBrain facts taken from the 20 mixed hits, not authorized list (fewer facts possible).
- Task 3: Ask tests mostly pass on old code; `if (original)` guard can skip shape assertion; facts no longer strictly first (×1.5 boost only).
- Task 3: once FTS returns anything, literal substring matches are dropped (per A7 as written).
- Task 3: ask answered:true ignores result.status partial (parity with old code).
- Task 3: Ask over-fetch limit 6 implicitly coupled to MAX_CHUNKS_PER_SOURCE = 2 (uncommented).
- Task 3: a fact and an original of the same note can both appear in Ask (product decision).
- Task 4: HTTP tests lack history=maybe, limit=abc, open validation errors, positive project_id filter.
- Task 4: historical-version rule checks only that row's aspect/authority; if a fact can later be revised to owner_private, older public versions stay openable by agents.
- Task 4: "no longer serves" test asserts Fastify's default not-found message (static:false only).
- Task 4: e2e "before" check hits.every(kind !== fact) passes on zero hits; needs real e2e run.
- Task 5: no stdio test that a no_match brain_recall returns isError unset and structuredContent.status no_match.
- Task 5: native-client-proof factTexts fails open on the amber negation (cobalt check keeps it safe).
- Task 5: brain://capabilities and delivered descriptions untested through the client.
- Task 5: BUILD_STATE.md:87 still says brain.note (Task 11).
- Task 5: execute signatures use any.
- Task 6: writeHookState runs before stdout write; a failed state write discards valid evidence (plan-mandated).
- Task 6: non-atomic hook-state write can race (falls back to empty state).
- Task 6: loopbackApi test omits lookalike cases ([::1] refused by allow-list); empty session_id shares one dedupe bucket.
- Task 6: budget counts from timeOrigin; host hook timeout needs headroom (spec writes timeout 5 s — fine).
- Task 7: digest text outside the data header (titles collapsed/capped by the fix).
- Task 7: recall_log one JSON setting, shared eviction across grants; pushes count is "within last 2,000".
- Task 7: digest says "Recently changed" but sorts on captured_at. **Fixed in the final wave ("Recent:").**
- Task 7: secret-scan drop logs as none, indistinguishable from nothing relevant (no redacted flag).
- Task 7: oneLine turns ZWJ/ZWNJ (U+200C/U+200D) and soft hyphen into spaces, splitting Indic/Persian words; keep ZWJ/ZWNJ, delete other Cf. **Fixed in the final wave.**
- Task 7: hitIsStrong for an original after dedupe needs covered >= 2, not min(2, terms).
- Task 7: plan/spec docs still show the old footer wording (Task 11 docs).
- Task 8: orphan second file if agent_files setting write throws after the second wx write.
- Task 8: empty dirs left after a failed add.
- Task 8: preview does not show the second file already exists.
- Task 8: shell metacharacters ($, backtick) in paths not escaped in the hook command.
- Task 9: a secret-shaped entity name makes prepareAsk refuse the whole sorting request with a misleading "note held a secret" message.
- Task 9: topic_options/prefix use full entity name while wire description capped at 200 code points.
- Task 9: entity names in criteria text not whitespace-collapsed.
- Task 9: systemOneContext runs 3x per job, one inside the transaction.
- Task 9: no test ties t{i+1} descriptions to topic_options[i].
- Task 9: recordSystemOneResult's new sentEntityNames argument is trusted unvalidated (only the worker calls it, with filtered names); validate or re-derive later.
- Task 9: stored topic_options entries not length-capped.
- Task 10: judgeRanked catch-all hides programming faults (no content-free counter).
- Task 10: untested deviation 6 (recall help withdrawn when deps off), deviation 3, early-exit timing, managed refusal copy, HTTP GET/PATCH routes incl CSRF.
- Task 10: comment at service.ts:3461 says judge only lowers found->partial; judgedStatus can raise partial->found (spec-sanctioned).
- Task 10: all-0.0 judge with no exact entity can turn 8 hits into 0 hits + 3 near misses (spec §304 vs "never hide evidence").
- Task 10: web refresh fetches recall-help in managed mode; muted vs tv-faint; "Recall help: on" shows stored consent not runnability.
- Task 10: count cap UTC day vs ledger owner time zone (as specified).
- Task 10: if releaseUndispatched throws in the refusal block the hold stays reserved (matches existing handling).
- Task 10: server timeout always deletes the result key; a result landing in the last ms is discarded (call settled and cached).
- Task 11: pass_cubed name wrong when REPEATS != 3; console median_hook_ms vs report median_hook_latency_ms.
- Task 11: proof setup before try leaks temp dir on early failure (same as native-client-proof).
- Task 11: refusal test does not check data/recall-*-proof.json absence.
- Task 11: whether --restricted Claude Code loads project settings.local.json hooks; recallLog grant_id === connection id. **Answered 2026-10-27 by the first owner run: it does not (`--restricted` ignores project and local settings), so the proof now passes the written file with `--settings`.**
- Task 11: hook_fired counts any authenticated recall-push request regardless of status/parsed level.
- Task 11: stale code comments service.ts:3461 (judge only lowers) and agents.ts:75 (states shell parsing as fact). **Fixed in the final wave.**

## Owner-run checks still owed

- `npm run proof:recall` for Claude Code and Codex, with and without `BRAIN_PROOF_NO_HOOK=1`.
- `scripts/native-client-proof.ts`.
- `npm run proof:sorting`. The live Clef sorting call and the judge call have not been made.

## Owner-run proof results

- 2026-10-27, Claude Code 2.1.283, hook on: **passed**.
  - Six retrieval prompts answered with a citation in all 3 repeats; tool-call rate 1.0.
  - The hook fired on 30 of 30 prompts, with a median of 3 ms at the server.
  - Levels: full for five prompts, pointer for one, none for all four generic prompts. No canary leaked.
  - It needed PR #29 first, because `--restricted` ignores project and local settings.
- 2026-10-27, Codex 0.156.1, hook on: **failed on setup**. BiBrain received no requests at all.
  - Cause: Codex loads a project's `.codex/` layer only for trusted projects, and the proof's `--ignore-user-config` hides that trust. The workspace also sat inside this repository, so Codex took the BiBrain repo as the project.
  - Fix: the workspace now lives in the system temp folder, and the run adds `-c projects.<folder>.trust_level="trusted"`. When the hook is on, it also adds `--dangerously-bypass-hook-trust`, which stands in for the one-time `/hooks` review a person does.
  - The `-c` override was confirmed with `codex mcp list` at no quota cost.
  - Same issue still open: `scripts/native-client-proof.ts` has the same Codex workspace and trust problem.
- 2026-10-27, Codex 0.156.1, after PR #30: **passed**.
  - Hook on: 30/30 pushes, median 2 ms, tool-call rate 0.5, six of six answered with a citation in all 3 repeats. Half the answers came from the pushed evidence without a tool call.
  - Hook off: 6/6 with a citation, tool-call rate 1.0.
- 2026-10-27, Claude Code 2.1.283, hook off: **passed**. 6/6 with a citation, tool-call rate 1.0.
- 2026-10-27, live sorting (`npm run proof:sorting`, Ollama Cloud, clef-flash): **3 of 3 validated**, at an estimated 46-56 micro-USD each.
  - Calibration: the Inbox decision scored durable 0.23, under the 0.25 demotion line, though a decision should count as lasting.
  - Calibration: small talk was classed `fact` (0.59).
  - Near miss: the open question's review score was 0.68, just under the 0.7 wake line.
