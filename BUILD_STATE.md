# Build state

Updated: 2026-10-27

This page holds the current, verified state of BiBrain. Each section below
records one shipped plan of the 2026 reframe, with the commands that ran and
their real counts. The full delivery log from before the reframe is preserved in
[docs/history/BUILD_LOG.md](docs/history/BUILD_LOG.md).

## At a glance

| Area | State |
| --- | --- |
| Local app (Today, Your brain, Connections, Settings) | Works end to end on one computer; verified by Vitest and Playwright on Windows |
| Agent connections (Codex, Claude Code, Cursor) | One-step Add writes the server entry and a prompt hook or rule file, verified locally against fake servers; native client runs are owner-run (`scripts/native-client-proof.ts`, `npm run proof:recall`) |
| Recall | FTS5 index, ranked recall, hook push; golden set gated in CI; live agent runs owner-run |
| Sorting help (System 1, Clef via Ollama or Cloudflare) | Built and tested against a fake server; no live call yet, owner runs `npm run proof:sorting` |
| Watch | Per-project switch, on by default |
| Licence | AGPL-3.0-only for the app, Apache-2.0 for the agent connector |
| Hosted edition and payments | Paused; managed code is kept but not deployed, and no real payment has been processed |
| Next plans | Embeddings as a second retrieval list (plan 5b), then cleanup of the paused hosted code |

## 2026-10-25 — Recall that agents use (branch reframe/recall)

What shipped:

- A derived recall index (migration 7: `recall_chunks` plus an FTS5 table with
  porter stemming) holds one row per fact and per chunk of up to 1,200 code points
  of every original. It is kept in step by every write path (capture, edit,
  review, undo, import, forget, vault rebuild) and rebuilt in batches of at most
  200 sources; the forget proof counts any orphan fact row. `source_fts` is kept.
- Recall is deterministic and ranked: fact and original candidates (60 per list)
  fuse by reciprocal rank (k = 60), with exact-name boosts, then authorization
  runs before the SQL and again per hit. A hit carries `freshness`: `current`,
  `stale` (older than 21 days), `replaced`, or `retired` (a non-current claim
  nobody superseded, or outside its validity window). Hypotheses without evidence
  never appear. `no_match` is a normal answer with near misses, not an error.
- A golden set of 46 cases gates CI through `npm run brain-eval` (recall at 5,
  MRR, no-match rate, positive push rate, p95 latency).
- The owner's Ask bar and Your brain search use the same recall core and never call
  a model; `Brain.agentSearch`, `agentGet` and `agentAsk` are internal with no HTTP
  route.
- The agent HTTP surface is v2: `GET /api/v1/agent/recall`, `GET /api/v1/agent/open`
  and `POST /api/v1/agent/recall-push`, plus `GET /api/v1/recall/log` for the owner
  and `GET`/`PATCH /api/v1/preferences/recall-help`. The v1 agent read routes are
  removed. An expired current claim is `NOT_FOUND` on an unversioned open.
- MCP surface v2: server `instructions`, seven underscore tools (`brain_recall`,
  `brain_open`, `brain_note`, `brain_propose`, `brain_intent`, `brain_link`,
  `brain_forget`), structured output with an `outputSchema`. The earlier
  eight-name dotted contract is gone with no aliases; existing connections pick
  up the new names on their next session.
- `bibrain hook <client>` (apps/cli) turns a prompt event into a loopback recall
  push in under 1,500 ms and never blocks a prompt; it keeps only id hashes
  (`data/hook-state/<connection>.json`).
- The push policy chooses `full` (at most 2,000 code points), `pointer` (under 200)
  or `none`; the first prompt of a session adds a digest under 600 (not on `none`);
  a repeated prompt re-injects nothing new; the footer and header are factual
  statements; and every push passes secret detection. A content-free recall log
  records level, counts and latency.
- Add to agent writes a second file once, with `wx` and never over an existing one:
  `.claude/settings.local.json` (a UserPromptSubmit hook plus `permissions.allow` of
  only `brain_recall` and `brain_open`), `.codex/hooks.json` (Codex format
  confirmed on the official hooks page; `CODEX_HOOKS_CONFIRMED = true`), or
  `.cursor/rules/bibrain.mdc`. Codex runs a project hook only after the person
  trusts it in `/hooks`, so its tile says "Recall on every prompt: on after Codex
  trusts the hook" until a push is recorded. An existing file shows a Copy snippet.
- Capture-time sorting help can also answer `durable` and `topic`; durable facts get
  a small recall boost and topics feed the prefix and the known-name list.
- The optional "Recall help" judge (Settings, off by default, needs sorting help on)
  sends the agent's question, matching passages and project and topic names to
  Clef, waits at most 900 ms and falls back to the deterministic result. It can
  reorder, demote to near misses, and lower or raise the push level, but only among
  candidates BiBrain already found and the agent may see; it never adds a hit,
  never changes which projects are searched and never hides an exact name match
  below a pointer. 2,000 judge calls per UTC day, plus the shared daily cap. A job the server
  gave up on is cancelled with its state deleted and never paid after its deadline.
- `scripts/recall-agent-proof.ts` (`npm run proof:recall`) is the owner-run native
  acceptance, with the hook on and off. CI and agents run only its refusal path.

Docs updated: AGENT_INTEGRATION (Recall push), NATIVE_CLIENT_SETUP (hooks, recall
proof), PROVIDERS (Recall help), UX, API, README.

Verified in this worktree on 2026-10-27 after the final whole-branch review and
its fix wave (Windows, Node 24.19.0):

- `npm ci`, `npm run typecheck`, `npm run lint`, `npm run build`: all exit 0.
- `npm audit --audit-level=high`: 0 vulnerabilities.
- `npm run brain-eval`: 20/20 passed; golden set 46 cases, recall at 5 = 1.00, MRR
  0.97, no-match rate 1.00, positive push rate 1.00, p95 about 60 ms.
- `npx vitest run --reporter=dot`: 181 files, 1866 passed, 8 skipped, 0 failed
  (1381 s). An earlier full run at the same head had one load timeout in
  `managed-activation-guard.test.ts`, which this branch does not touch; it passed
  alone and in this run.
- `npx playwright test --workers=1`: 105 passed, 0 failed, 6.6m. By project: main 69,
  today-v2 20, connections 7, today-v2-bar 4, system1 4, empty-brain 1. The run before
  it had two timeouts under machine load (`first-note-lifecycle-review.spec.ts:5` and
  the system1 Watch spec); both passed alone and in this run. One earlier run failed
  `managed.spec.ts` because its two synthetic account markers shared words and a
  timestamp, so ranked search showed account B its own note; the markers were made
  distinct, and the isolation assertions are unchanged. `docs/screenshots` was
  restored after each run.
- The plan's greps: no quoted dotted tool name remains, and no file under
  `apps/server`, `packages/domain`, `apps/mcp`, `apps/cli` or `apps/web` reads
  `BRAIN_DECISION_API_KEY` or `OLLAMA_API_KEY`.
- `node --import tsx scripts/recall-agent-proof.ts claude` without
  `BRAIN_RECALL_PROOF` prints the refusal and exits 1 (the only part of the proof
  that was run).
- Every task had its own spec and quality review with fix rounds. Fable reviewed the
  whole branch ("ready with fixes": 0 Critical, 4 Important, 10 Minor); the four
  Important findings and two one-line minors were fixed and re-reviewed.

Known limits:

- No live Clef judge call and no live sorting call has been made.
- The native recall proof (`npm run proof:recall` with and without
  `BRAIN_PROOF_NO_HOOK=1`, for Codex and Claude Code), `scripts/native-client-proof.ts`
  and `npm run proof:sorting` are owner-run and have not been executed. There is no
  native result for the hook, for Codex trusting the hook, or for the Windows
  quoting of the hook command under `cmd.exe /c`.
- Embeddings are deferred to plan 5b. Thresholds are initial bands and stay
  uncalibrated until the recall log has real data.
- `source_fts` is retained although the owner screens no longer read it.
- `rankAnswers` (`packages/domain/ask.ts`) and `Brain.agentAsk` are test-only.
- Wall-clock latency tests may flake under heavy machine load.
- This plan supersedes some spec text: the spec's section 3 "withheld" wording,
  section 5.1 "rows swept after an hour" (judge rows now stay and are cancelled
  past their deadline), section 9.8 "judge can only lower" (a judge may also lift a
  pointer to full when the candidates answer the prompt) and the `Freshness`
  contract (now also `retired`).
- Local V1 only; no real model run.

## 2026-10-25 — Sorting help with Clef (branch reframe/system1-clef)

- Each new note can get one small request to Clef (up to five questions: kind, which
  project, whether it changes a fact, whether to review, whether to show). The
  answers are advice only: a "File in Northstar?" card (moves only on Keep, as a new
  version), a quieter card, or a queued review for a project with an active
  preparation goal. Providers: Ollama (Ollama Cloud with a key, or a local Ollama on
  loopback) and Cloudflare; Ollama cost is an estimate at Clef's public price.
  The key lives only in the background worker; the worker publishes status and the
  consent switch works only while it is configured and running.
- Watch is a per-project switch, on by default. An unwatched project is quiet on
  Today, gets no sorting help and no scheduled reviews, and keeps everything in
  Your brain. Settings has a Sorting help card and a downloadable review log (the
  judged question per review, never `kind`, never note text).
- `scripts/system-one-live-proof.ts` (`npm run proof:sorting`) is the owner-run live
  check. Docs: PROVIDERS.md, UX.md, README "Optional sorting help".

Verified in this worktree at the branch head after the final review's fix wave
(Windows, Node 24.19.0):

- `npm ci`, `npm run typecheck`, `npm run lint` and `npm run build`: all exit 0.
  After `npm ci`, `apps/cli/bibrain.mjs` showed line-ending changes only and was
  restored.
- `npm audit --audit-level=high`: 0 vulnerabilities.
- `npm run brain-eval`: 4/4 passed.
- `npx vitest run --reporter=dot`: 168 files, 1757 passed, 8 skipped, 0 failed, in
  one run; no load-only timeouts.
- `npx playwright test --workers=1`: 104 passed, 0 failed, 4.2m. By project: main 69,
  today-v2 20, connections 6, today-v2-bar 4, system1 4, empty-brain 1. The e2e
  journey uses a loopback fake Ollama-format server, not a real service.
- Every task had its own spec and quality review; Fable reviewed the whole branch
  ("ready with fixes": 0 Critical, 1 Important, 6 Minor), and all seven were fixed
  and re-reviewed.
- This is local V1 verification with a fake server. The live proof script was not
  run.

Known limits:

- No live Clef or Ollama call has been made on this branch. The owner runs
  `npm run proof:sorting` after putting `BRAIN_SYSTEM1_LIVE=1` in `.env` (or `$env:BRAIN_SYSTEM1_LIVE=1;` first in PowerShell), then removing the line.
- The monthly cap is deferred; the daily and per-note limits apply.
- A call that fails after it was sent is not retried (Ruling 15): the note stays
  unsorted and its hold stays.
- System 2 wakes only for projects with an active preparation goal.
- Watch state lives in settings and is not part of exports.
- A Keep queues one more sorting call for the moved note's new version.
- Follow-ups: docs/superpowers/plans/2026-10-24-system1-clef-followups.md.

## 2026-10-23 — Plug-and-play Connections (branch reframe/connections-v2)

- `npx --no-install bibrain` (new private workspace `apps/cli`) starts BiBrain from the
  BiBrain folder and opens the browser already signed in through a single-use
  `#pair=` link (two-minute expiry, stripped from the address bar). `bibrain
  open` reopens it and `bibrain connect` is the connector an agent starts. The
  local server detects Codex, Claude Code and Cursor and, from a button, writes
  that client's project file in a chosen folder (never changing an existing
  file). The access key is created by BiBrain and rests in BiBrain's data
  folder (`data/agent-keys`, mode 0600), not in the project file or the
  browser; Revoke deletes the key file.
- Connections shows one tile per agent (Add, Waiting for its first call,
  Connected after a real authenticated call, Revoke, earlier connections) and
  an "Any other agent" tile for Preview handoff and Set up by hand; a grant
  with no named agent is listed there. The continuity workspace
  (`AgentContinuityWorkspace` and its CSS) is removed.
- Agents no longer accept their own proposals: every agent proposal queues for
  review on Today. A new `brain_note` session note turns decisions (each with a
  topic) and open questions into suggestions that wait for review; a note with
  a secret-looking line is quarantined. `scripts/native-client-proof.ts` now
  uses the one-step path and cleans up even if connecting fails.

Verified in this worktree at the final branch head, after the final review's fix
wave (Windows, Node 24.19.0):

- `npm ci`: succeeded with the new workspace. `npm run typecheck`: clean.
  `npm run lint`: clean. `npm run build`: clean.
- `npm run brain-eval`: 4/4 passed.
- `npx vitest run --reporter=dot`: 160 files, 1655 passed, 8 skipped, 0
  failed, in one run. An earlier full run on this branch had 7 load timeouts
  in three `managed-decision-*` files that this branch does not touch; they
  passed when run alone.
- `npx playwright test --workers=1` (after `npm run build`): 100 passed, 0
  failed, 5.5m. By project: main 69, today-v2 20, connections 6, today-v2-bar
  4, empty-brain 1. The run before it had 2 timing failures in specs this
  branch does not change (`app.spec.ts` delete dialog, `first-note-layout-review`
  320px); both passed alone (9/9) and in this full run. `docs/screenshots` was
  restored afterwards.
- The remaining minor findings are listed in
  `docs/superpowers/plans/2026-10-23-connections-v2-followups.md`.

Known limits:

- `bibrain` is not published to npm. Run `npx --no-install bibrain` from the
  BiBrain folder; `--no-install` makes npx refuse to fetch a registry package
  of that name when it is run from the wrong folder (checked on npm 11.17:
  it cancels instead of installing);
  generated agent files call `node` with absolute paths, never `npx`.
- One-step adding works only in the local app. The hosted edition uses "Set up
  by hand".
- Real Codex and Claude Code runs are the owner's
  `scripts/native-client-proof.ts` (`BRAIN_NATIVE_PROOF=1`), not CI. That script
  has not been run on this branch, so there is no native Codex, Claude Code or
  Cursor result for the one-step path yet. Automated tests drive the real stdio
  connector with the MCP SDK client against a real local server.
- The access key rests in BiBrain's data folder, as the installation code does.
  One-step connections last 90 days unless revoked.
- `npx --no-install bibrain start` (the build, the server start and the health wait) and the
  real browser opener have not been run on the owner's machine. That includes
  whether Windows `rundll32 url.dll,FileProtocolHandler` keeps the `#pair=`
  fragment. The `open` hand-off is covered by a test with a stubbed browser.
- Local V1 only; no real model run.

## 2026-10-23 — Your brain v2 (branch reframe/your-brain-v2)

- Your brain is a project list plus one page per project: header with Preview
  handoff and "{n} things to look at on Today.", True now (versioned edits,
  Undo, Still true), Open questions (Mark answered, Undo), Originals, Needs a
  decision here with Reviewed decision history, and Goals. Search covers facts
  and originals.
- Any fact opens on its original with the cited passage highlighted, its
  history and the facts taken from it. The source dialog no longer shows
  Current understanding, Edit understanding, Continue in another agent, Copy
  brief or Rebuild preview.
- New server pieces: pure modules facts, questions, project-view and
  brain-search; owner-only Brain methods brainProject, answerQuestion,
  reviseClaim, claimHistory, searchBrain (and briefInput shared with brief());
  five routes under /api/v1. Removed project-focus.tsx, CurrentKnowledge and
  their CSS. Local V1 only; no real model run.

Verified in this worktree at the branch head, after the final-review fixes
(cff4fd8):

- `npm run typecheck`: clean. `npm run lint`: clean. `npm run build`: clean.
- `npm run brain-eval`: 4/4 passed.
- `npx vitest run --reporter=dot`: 1606 tests passed, 8 skipped (1614),
  EXIT=0, 866s. No flaky test failed in this run.
- `npx playwright test --workers=1` (after `npm run build`): 93 passed across
  the four projects, 4.0m.

Final-review fixes: Today and Your brain now share one staleness rule (an
owner edit counts as a check), focus returns to the restored item after Undo,
question signatures no longer depend on the host locale, capped search results
say so, and an unknown saved project falls back to Inbox. Remaining minor
findings are listed in
`docs/superpowers/plans/2026-10-23-your-brain-v2-followups.md`.

Known limits:

- Goals remain until Watch in plan 4.
- Open questions are found by rule, not by a model.
- Search is substring only until plan 5.

## 2026-10-23 — Today v2 verified (branch reframe/today-v2, PR #20)

PR #20 CI repair: patched vite 8.3.4, vitest 5.0.5, fastify 5.12.7, hono 4.13.13
and ip-address 10.7.4 (`npm audit`: 0 vulnerabilities), then merged main after
PR #19 (Dodo). Counts below are from the run before that merge.

Today is one bar (save or ask), a Brief of at most three cards with Keep, Fix,
Dismiss and Undo, and project cards. Local V1 only; no real model run and no
native client check in this slice.

Final review fixes: a failed-preparation card goes when its note is purged or
withdrawn; Undo after Keep returns the card to the Brief; the Ask answer clears
when any cited note is purged; Fix starts from the proposed wording; an automatic
Ask goes back to Save when the "?" is deleted; a dismissal still waiting is
dropped, not sent, when the owner leaves Today. Old Today code and CSS removed.

Commands, in order (final run, nothing else running):
- `npm run typecheck`, `npm run lint` and `npm run build` passed.
- `npx playwright test --workers=1`: 78 passed, 0 failed (main, today-v2,
  today-v2-bar and empty-brain projects; extra projects on ports 4327-4329).
- `npx vitest run` (alone): 1540 passed, 1 failed, 8 skipped. The failure is
  `managed-process.test.ts`, which also failed on clean main and failed again when
  re-run alone. `managed-decision-advisory-process.test.ts` passed this time; it
  had failed only under load in earlier full runs and passed when re-run alone.
- Retired earlier: `first-session-journey` and `living-brain-review` specs, the
  saved-note preview test and the delayed pre-purge read test (those features were cut).
- Screenshots (synthetic, throwaway database): docs/screenshots/today-v2-*.png.

Limits: no System 1 routing yet (plan 4), no plug-and-play install yet (plan 3),
no project suggestion after save. today-v2.spec.ts is close to the server's
1000 requests a minute limit; add new Today journeys to today-v2-bar.spec.ts.

