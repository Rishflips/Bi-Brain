# Build state

Updated: 2026-11-05

This page holds the current, verified state of BiBrain. Each section below
records one shipped plan of the 2026 reframe, with the commands that ran and
their real counts. The full delivery log from before the reframe is preserved in
[docs/history/BUILD_LOG.md](docs/history/BUILD_LOG.md).

## At a glance

| Area | State |
| --- | --- |
| Local app (Today, Your brain, Connections, Settings) | Works end to end on one computer; verified by Vitest and Playwright on Windows |
| Agent connections (Codex, Claude Code, Cursor) | One-step Add writes the server entry and a prompt hook or rule file. Native recall runs passed in Claude Code 2.1.283 and Codex 0.156.1 on Windows (2026-10-27); Cursor not yet run natively. Any other agent connects through `bibrain-agent/1` (Hermes plugin, HTTP MCP endpoint, `bibrain recall` and `bibrain note`), tested with fakes and not run natively |
| Recall | FTS5 index, ranked recall, hook push; golden set gated in CI; short and decision-shaped prompts pinned by a second golden bucket; owner-run native proof passed for both agents, hook on and off |
| Better search (embeddings via Ollama or Cloudflare) | On by itself with a local Ollama (plan 10); fake-embedder gates in CI; the meaning-lead score is unset until the owner applies a measured one; live run owner-run (`npm run proof:search`) |
| Sorting help (System 1, Clef via Ollama or Cloudflare) | Live call through Ollama Cloud with clef-flash validated 3 of 3 answers (2026-10-27). The durable demotion line moved to 0.20 on that run's evidence (2026-11-01); every other line keeps its first value and is read from `npm run calibrate` |
| Watch | Per-project switch, on by default |
| Licence | AGPL-3.0-only for the app, Apache-2.0 for the agent connector |
| Hosted edition and payments | Paused; the Dodo adapter, the money ledger and the managed runtime are kept but not deployed, and no real payment has been processed. The Paddle code was removed in plan 6 (2026-10-28) |
| Next plans | Owner-run: `npm run calibrate` once the brain has real answers and pushes, `npm run proof:search`, `scripts/native-client-proof.ts`; a native Hermes run (owner); the next reframe plan is the owner's choice |

## 2026-11-06 — Plan 10: recall by meaning by default (branch reframe/recall-by-meaning)

Spec: `docs/superpowers/specs/2026-11-06-recall-by-meaning-design.md`. Plan: `docs/superpowers/plans/2026-11-06-recall-by-meaning.md`.

What changed:
- **Better search turns itself on.** At worker start, one loopback request to `http://127.0.0.1:11434/api/tags` (inside 1.5 s, at most 1 MiB, no redirects) looks for Ollama with `bge-m3`; it repeats every 10 minutes while nothing was found. Found means on, with a notice in Settings. A stored Off wins; Cloudflare is never automatic; with it off nothing is called and recall is byte-identical (`tests/eval/recall-dense-off-snapshot.json`).
- **Meaning matches can lead.** An owner-applied score, unset by default, set in Settings or by `PATCH /api/v1/preferences/meaning-lead` (GET and DELETE too) from `proof:search` or `calibrate` output. It is bound to the search model key; a changed model needs a new measurement. Applied last, so an unreviewed agent note never leads, and a promoted push shows only the leader, hits found by words, and meaning matches at or above the score.
- **Short and decision-shaped prompts.** Acknowledgements never push. `continue` and its list read the session's topic (at most 12 content words, 20 sessions, two hours) or answer the first prompt with the digest. A decision question needs `we` or `I`; the passive `what was decided` stays plain. It reaches `full` only by the usual two-term rule or an exact entity name. A second golden bucket (`tests/eval/recall-short-golden-v1.json`) pins these.
- **The tools' suggestions.** `proof:search` suggests 0.05 above the loudest no-answer cosine and says "not enough evidence" below 20 no-answer queries. `calibrate` suggests from the log using only rows written before any score was applied, labels it weaker evidence, and prints the fields Settings needs.

Verified in this worktree on 2026-11-06 (Windows, Node 24.19.0). The second sequential run passed in full:

- `npm run typecheck`, `npm run lint`, `npm run build`: all exit 0. `npm audit --audit-level=high`: exit 0. The two moderate advisories are unchanged.
- `CI=true npx vitest run --reporter=dot --maxWorkers=2`: 199 files, 2,121 passed, 8 skipped, 0 failed (1,502 s).
- `npm run brain-eval`: 57/57 passed, including the new short-and-paraphrase bucket. The plan-5 dense-off snapshot is byte-identical.
- `npx playwright test --workers=1`: 111 passed, 0 failed (6.2m). By project: main 69, today-v2 20, connections 9, system1 6, today-v2-bar 4, empty-brain 3.
- Code and tests: 32 files changed, 1,942 lines added and 78 removed.
- The first full run found two real problems, both fixed and committed:
  1. The page's 2.5-second refresh gained one request. That pushed the shared test address over the per-minute limit, and four open tabs could do the same for an owner. The "meaning matches can lead" line is now read only when Settings opens.
  2. The Hermes plugin was checked out with Windows line endings. It is now pinned to LF, because it is copied to Linux servers.
- Reviews:
  - The pre-flight scan and its two re-checks caught 8 Blocker and 5 Important plan defects before any code was written.
  - Every task had its own review; Opus reviewed the push-level, settings-authorisation and intent tasks.
  - Fable's final review: with fixes, 2 Important. Both were fixed and re-reviewed.

Known limits:

- Nothing is calibrated on real data, and `proof:search` has not been run. Until the owner applies a measured threshold, a meaning match never leads a push.
- Automatic Better search has been tested only against the fake embedder, never a real local Ollama.
- The new reference cases use the fake embedder; real-model behaviour is measured only by `proof:search`.

Known limits:
- Nothing has been calibrated on real data and `npm run proof:search` has not been run, so no meaning-lead score is set and a meaning match still never leads a push. The suggestion code has not been tried against a real model.
- The probe runs at worker start and every 10 minutes until it finds the model; it then stops until the next start.
- The golden buckets are synthetic and tested with a fake embedder.
- Older plan sections below say Better search is off by default; that was true when they were written.

## 2026-11-05 — Plan 9: works with any agent, Hermes first (branch reframe/any-agent)

Spec: `docs/superpowers/specs/2026-11-05-any-agent-design.md`. Plan: `docs/superpowers/plans/2026-11-05-any-agent.md`. Guide: `docs/CONNECT_ANY_AGENT.md`.

What changed:
- **Contract and generic commands.** One documented contract, `bibrain-agent/1`, served as `contract` by `GET /api/v1/agent/capabilities`. `bibrain recall` and `bibrain note` speak it on stdin and stdout, always valid JSON, always exit 0. The Claude Code and Codex hooks are adapters over the same two functions, with their output unchanged.
- **HTTP MCP endpoint.** `POST /api/v1/agent/mcp` serves the same seven tools: stateless, JSON replies, agent keys only, POST only, one message per request, 256 KiB bodies, 120 requests a minute per client address (in place of the global limit on this route). No OAuth.
- **Hermes plugin and Connections.** `integrations/hermes/bibrain` (Python, standard library only) recalls on `pre_llm_call` and leaves a note on `post_llm_call`. Connections gains Hermes Agent and Another agent under Set up by hand. `client` accepts `hermes`.
- **Copy and docs.** Copy that named one harness where any agent would do now says "your coding agents". The Connect any agent guide holds the contract, per-harness snippets and an honest compatibility matrix.

Verified in this worktree on 2026-11-05 (Windows, Node 24.19.0), all in one sequential run:

- `npm run typecheck`, `npm run lint`, `npm run build`: all exit 0.
- `npm audit --audit-level=high`: exit 0. The two moderate advisories are unchanged (`glob` and `minimatch`, which need a breaking change).
- `CI=true npx vitest run --reporter=dot --maxWorkers=2`: 194 files, 2,040 passed, 8 skipped, 0 failed (1,067 s). The Hermes plugin tests ran under Python and were not skipped.
- `npm run brain-eval`: 25/25 passed. The plan-5 dense-off snapshot is byte-identical.
- `npx playwright test --workers=1`: 111 passed, 0 failed (4.6 minutes). By project: main 69, today-v2 20, connections 9, system1 6, today-v2-bar 4, empty-brain 3.
- Code and tests: 28 files changed, 1,611 lines added and 245 removed.
- Reviews:
  - The pre-flight scan and its re-check found and fixed 3 Blocker and 6 Important problems before any code was written.
  - Every task had its own review; Opus reviewed the HTTP and transport tasks.
  - Fable's final review: ready, with 0 Critical and 0 Important findings.

Known limits:

- The Hermes plugin has been tested only against a fake Hermes context, never a running Hermes. The HTTP MCP endpoint has been tested only in-process, never with a real remote client. Both need an owner run.
- Whether Hermes expands `${BRAIN_AGENT_TOKEN}` inside `headers` is not verified. The guide gives a fallback.
- Recall and note log rows record the client name the agent sends; the labels the owner sees use the grant's stored client. Parked, because changing it would touch rows the recall snapshot pins.

Known limits:
- No native Hermes run. The plugin was tested against a fake Hermes context and a fake server only.
- The `Stop` hooks and the HTTP MCP endpoint have not been run in a real agent session.
- The Hermes plugin tests need Python 3.10 or later. Without it they are skipped with a message (and fail under `CI=true`).

## 2026-11-04 — Plan 8: security hardening and the safe write-back loop (branch reframe/safe-write-back)

Spec: `docs/superpowers/specs/2026-11-03-safe-write-back-design.md`. Plan: `docs/superpowers/plans/2026-11-03-safe-write-back.md`. Parked items: `docs/superpowers/plans/2026-11-03-safe-write-back-followups.md`.

**Part A: security.** This part follows an independent audit, which found nothing critical or high.
- **What agents write is labelled.** Anything a connected agent writes (proposals, session notes) is stored as agent-written. Until the owner marks that note as reviewed (one explicit action, owner-only):
  - it is labelled on every owner screen (Today, Your brain, search, Ask, the source view);
  - it cannot raise a recall push above `pointer`;
  - it is kept out of the Recall help judge and the agents' brief;
  - its titles never reach another agent unlabelled.

  Restore brings it back unreviewed.
- **Self-host rate limiting.** It is keyed on the client IP behind exactly one trusted proxy hop, and only when `BRAIN_PUBLIC_ORIGIN` is set. Local mode is unchanged.
- **HTTP rules.**
  - Side-effecting `/api` navigations are refused.
  - Paths with escapes that could disguise a route are refused.
  - Security headers are sent in every mode.
  - The Idempotency-Key is bounded.
  - Development origins are allowed outside production only.
- **`bibrain connect`** passes the agent adapter an allow-listed environment only.
- **After Add,** Connections shows the `.gitignore` lines for the new agent files, with a negation-aware "already listed" check.

**Part B: the safe write-back loop.**
- **End-of-turn hook.** Add now also writes a Stop hook (`bibrain hook-end`, 5-second timeout) for Claude Code and Codex. When an agent finishes, the hook:
  - sends only the reply's marker lines (Decided, Open question, Next step; the last 10 of each kind);
  - skips code blocks and anything secret-looking;
  - never blocks the agent's turn.

  The server stores the note as an unreviewed agent-written suggestion. Codex asks the owner to approve the hook in `/hooks`.
- **"Bring in what you already have."** On an empty Today, the owner can pick a folder. BiBrain then:
  - previews only `CLAUDE.md`, `AGENTS.md` and Cursor rules files;
  - imports them only after Confirm;
  - shows them as "Imported from <file>".

Verified in this worktree on 2026-11-04 (Windows, Node 24.19.0), all in one sequential run:

- `npm run typecheck`, `npm run lint`, `npm run build`: all exit 0.
- `npm audit --audit-level=high`: exit 0. Two moderate advisories remain (`glob` and `minimatch` via `@fastify/static` and ESLint), and both need a breaking change.
- `npx vitest run --reporter=dot --maxWorkers=2`: 190 files, 2,007 passed, 8 skipped, 0 failed (1,169 s).
- `npm run brain-eval`: 25/25 passed. The plan-5 dense-off snapshot is byte-identical.
- `npx playwright test --workers=1`: 110 passed, 0 failed (5.0m). By project: main 69, today-v2 20, connections 8, system1 6, today-v2-bar 4, empty-brain 3.
- Code and tests: 50 files changed, 2,275 lines added and 150 removed.
- Reviews:
  - A pre-flight scan found and fixed 2 Blockers and 13 Important defects in the plan, and a re-check fixed 3 more.
  - Every task was reviewed, on Opus for the security tasks.
  - Fable's final review found 0 Critical and 2 Important issues (agent brief items in `/api/v1/context`). Both were fixed and re-reviewed.

Known limits:

- The end-of-turn hook has not been run in a real Claude Code or Codex session; it is tested against the documented hook contract only. That needs an owner run.
- The paid model-brief path must exclude unreviewed agent notes from its inputs before it is turned back on (see the follow-ups).
- Git log import and a wider secret scanner are separate plans.

## 2026-11-01 — Plan 7: sweep and calibrate (branch reframe/sweep-calibrate)

Spec: `docs/superpowers/specs/2026-11-01-sweep-calibrate-design.md`. Plan: `docs/superpowers/plans/2026-11-01-sweep-calibrate.md`.

- **Sweep.** Every parked item in the six follow-ups files and the Known limits above was classified (10 do, 18 obsolete, the rest kept parked with a reason). Applied: the grants test's Windows path is escaped; the `briefInput` comment is true again; the web `BriefItem` type carries `quiet?`; the watch test compares a real kept fact; `docs/UX.md` describes Today v2's after-save flow, the real no-result copy and "Preview handoff"; `scripts/native-client-proof.ts` runs Codex in a trusted temp workspace outside the repo (the fix PR #30 gave the recall proof) and has a refusal test. The proof was not run.
- **Calibrate.** One ruling on evidence: the durable demotion line (`DURABLE_LOW`) moved from 0.25 to 0.20, because the one live decision recorded under it scored 0.23 (2026-10-27). Tests pin 0.23 → no demotion and 0.19 → ×0.9; the golden set is unchanged. Every other threshold keeps its value: the push bands behaved as intended in four owner runs, and the judge and the embeddings have never been called live.
- **Calibration report.** `npm run calibrate` opens the owner's brain read-only (through `node:sqlite`, never `Storage`), prints every threshold from one registry (`packages/domain/calibration.ts`), histograms of the sorting answers and of kept-versus-dropped cards by confidence, pushes by agent and level, judged and Better search shares, suggestions that need at least 20 samples, and the signals it cannot see. It never prints note text and has no option to. The recall log now also records the top cosine and the judge's answers per push, only when those ran; rows with both off are byte-identical to plan 5 (the committed dense-off snapshot still matches).
- **Gaps the report names.** No owner action records whether a review wake was right; `durable` and `kind` get no feedback; older rows carry no judge or cosine fields; the floor hides what it cuts (use `proof:search`); owner searches are never logged.
- **Historical mentions of 0.25.** The recall plan and spec of 2026-10-25 and the sorting-run notes above (2026-10-27) name the durable line as 0.25; that is the value at the time. The current value is 0.20 (`packages/storage/recall-index.ts`), and the registry in `packages/domain/calibration.ts` is the one place to read every current line.

Verified in this worktree on 2026-11-02 (Windows, Node 24.19.0):

- `npm run typecheck`, `npm run lint`, `npm run build`: all exit 0.
- `npm audit --audit-level=high`: exit 0, no high or critical findings. Moderate advisories published since plan 6 remain: `@hono/node-server` (a non-breaking fix exists), and `glob`/`minimatch` through `@fastify/static` and ESLint (fixable only by a breaking downgrade). Dependency updates are outside this plan.
- `npx vitest run --reporter=dot --maxWorkers=3`: 186 files, 1,953 passed, 8 skipped, 0 failed (1,070 s).
- `npm run brain-eval`: 25/25 passed. The golden set is unchanged.
- `npx playwright test --workers=1`: 107 passed, 0 failed (5.2m). By project: main 69, today-v2 20, connections 7, system1 6, today-v2-bar 4, empty-brain 1. `docs/screenshots` was restored afterwards.
- These are the counts from the third full run. The first was cut off by a session restart. In the second, 75 tests in three frozen billing files failed because their Windows fixture folder (`AppData/Local/Temp/opencode`) was missing at the time; those three files passed 76 of 76 (4 skipped) once it existed. One Playwright test (`proactive-goal`, a checkbox) failed under load in that run and passed 3 of 3 on its own; this branch changes no web code apart from a type comment.
- Every task had its own review. Fable reviewed the whole branch: with fixes, 0 Critical, 1 Important (the `--json` output skipped the stored-key filter), fixed and re-reviewed.

Known limits:

- `npm run calibrate` has been run only against the synthetic test brain. The owner runs it against real data; until the brain holds 20 answers per question every suggestion reads "Not enough data yet".
- The owner-run proofs still owed: `scripts/native-client-proof.ts` (harness fixed here) and `npm run proof:search`.
- Local V1 only; no real model run in this plan.

## 2026-10-28 — Plan 6: cut dead code (branch reframe/cleanup)

Only the items below were removed. Spec: `docs/superpowers/specs/2026-10-28-cleanup-design.md`. Plan: `docs/superpowers/plans/2026-10-28-cleanup.md`.

- **Paddle remnants.** Removed in full:
  - `packages/runtime/paddle-billing.ts`, `packages/providers/paddle-evidence.ts`, `packages/domain/paddle-signature.ts`;
  - the Paddle client in `packages/providers/paddle.ts` and the Paddle normaliser in `packages/domain/paddle-event.ts`;
  - `paddleConfig` and `RuntimePaddleConfig` in `apps/server/config.ts`;
  - the "Paddle is retired" startup guards, the Paddle webhook branch and the Paddle CSP branch;
  - the `BRAIN_PADDLE_*` scrub in `scripts/run.mjs`;
  - five Paddle-only test files.

  The frozen Dodo adapter runs on some Paddle-named code, so these stay under their current names: `PaddleStore` (the base of `DodoStore`), `PaddleBillingWorker` / `ProviderBillingWorker`, `PaddleTransport`, `PaddleMode`, `PaddleEventProjection`, the `paddle_*` tables, and the `paddle.sqlite` handling in `managed-recovery`. No migration or table changed.

  A managed deployment that still sets `BRAIN_PADDLE_*` variables now starts and ignores them. Before, it refused to start.
- **Retired UI flows.** Three modals in `apps/web/src.tsx` that nothing could open: the plan review, "Review later" and "Your plan changed after acceptance".
- **Test-only and dead code.** `rankAnswers` (`packages/domain/ask.ts`), `Brain.agentAsk`, `Brain.agentSearch`, `Brain.activeEvidence` and `fillRecallIndex`. Tests that used these as probes now check the same facts through `currentClaims`, `pages` and `sources`.
- **Stale docs.**
  - The Paddle design moved to `docs/history/PADDLE_BILLING_DESIGN_2026-10-17.md`.
  - `MANAGED_RUN`, `API`, `ARCHITECTURE` and `SECURITY_PRIVACY` now point at `DODO_PAYMENTS.md`.
  - These were left alone on purpose: `IMPLEMENTATION_PLAN.md`, `DODO_PAYMENTS.md` and `RELEASE.md`, which have owner edits pending, and `BUSINESS.md`, a dated business record.

Frozen code ran unmodified and passed: `dodo-authority`, `dodo-billing`, every `billing-*` and `managed-*` test, `paddle-store`, `paddle-authority-flow`, `paddle-transport` and `billing-ui.spec.ts`. No dodo* file, migration or `managedPreferencesPatchSchema` changed.

Verified in this worktree on 2026-10-28 (Windows, Node 24.19.0):

- `npm run typecheck`, `npm run lint`, `npm run build`: all exit 0.
- `npm audit --audit-level=high`: 0 vulnerabilities.
- `npx vitest run --reporter=dot --maxWorkers=3`: 184 files, 1,930 passed, 8 skipped, 0 failed (1,210 s). That is 5 files and 25 tests fewer than plan 5b, all of them Paddle-only or `rankAnswers` tests.
- `npm run brain-eval`: 25/25 passed. The golden set is unchanged.
- `npx playwright test --workers=1`: 107 passed, 0 failed (4.4m). By project: main 69, today-v2 20, connections 7, system1 6, today-v2-bar 4, empty-brain 1. `docs/screenshots` was restored afterwards.
  - The first full run, started straight after the 20-minute Vitest run, had 3 failures in `today-v2`: two 30-second test timeouts and one 5-second wait for a project card.
  - The `today-v2` project alone then passed 20/20, and a second full run passed 107/107.
- Lines removed from code and tests (`apps packages scripts tests`): 2,338, against 43 added. 26 files changed.
- Every task was reviewed; the Paddle tasks were implemented and reviewed on Opus. Fable reviewed the whole branch: ready, with 0 Critical and 0 Important findings.

Known limits:

- Nothing in the hosted edition was run live. This plan only removed code that production could not reach.
- `docs/DODO_PAYMENTS.md` (lines 4–5) still says Paddle configuration refuses startup; it is now ignored instead. `docs/RELEASE.md` (line 154) still tells operators not to set `BRAIN_PADDLE_ALLOW_LIVE=1`, a variable that nothing reads any more. Both files are the owner's to update once their pending edits land.
- `docs/IMPLEMENTATION_PLAN.md` still lists the Paddle B1 checklist, for the same reason.
- Parked minors:
  - the Today default still carries an unused `receipts: []`;
  - a comment in `paddle.ts` slightly misdescribes what `paddle-store.ts` imports.

## 2026-10-27 — Better search with embeddings (branch reframe/recall-embeddings)

What shipped (one line per task; everything is off by default and tested against a deterministic fake embedder, never a real model):

- **Task 1: provider client.** `packages/providers/embed.ts` and `embed-env.ts` call Ollama (`/api/embed`, loopback only, default `bge-m3`) or Cloudflare Workers AI (`@cf/baai/bge-m3`) with plain `fetch`, validate the vector count, size and finiteness, normalise at the edge and price Cloudflare in whole micro-USD. `BRAIN_EMBED_PROVIDER`, `BRAIN_EMBED_MODEL`, `BRAIN_EMBED_ENDPOINT` are read by the worker only; `tests/helpers/fake-embed.mjs` is the CI embedder.
- **Task 2: vector storage.** Float32 little-endian vectors beside `recall_chunks` (no migration), guarded writes (kind, ref id, version, ordinal, text hash), and a dot-product scan over one contiguous matrix per scope, key and size. The cache invalidates through an in-process generation counter and `PRAGMA data_version` plus a per-scope fingerprint, so the worker's writes reach the server with no settings row and a database with Better search off is unchanged.
- **Task 3: indexing.** `embed_batch` embeds up to 32 passages per call outside any transaction; the `better_search` setting and a key-free `better_search_status` are published by the worker; capture, edit and a 5-second self-heal check queue batches; Cloudflare spend goes through the dispatch ledger; a 60 s to 15 min back-off, a three-failure 15-minute breaker, a one-by-one retry for a refused batch, withheld secret and rejected passages, and fresh privacy checks before each Cloudflare send.
- **Task 4: query lane.** A `recall_embed` fast lane embeds the question: the server waits at most 400 ms, the call is bounded at 2 s, Cloudflare keeps a 150 ms reserve floor, answers are cached for ten minutes, query failures back off in process, and crash-left query text is swept within a minute.
- **Task 5: fusion.** Dense candidates are a fourth reciprocal-rank list (weight 0.7, per-model cosine floor 0.45 for `bge-m3`, at most 60) under the same authorization as every other candidate; exact names stay pinned; the hook push level stays term-based, also when the judge is on; Better search off equals plan 5 byte for byte (a committed snapshot, `tests/eval/recall-dense-off-snapshot.json`).
- **Task 6: Settings card.** A Better search card with Off, On this computer (Ollama) and Cloudflare, its own owner-only `GET`/`PATCH /api/v1/preferences/better-search`, named consent (notes, searches and the questions connected agents ask; private notes never sent; "About 1 cent for every 250,000 words of English text; other languages can cost more, counted against your daily limit."), a plain status line ("Words only right now: …", "Better search paused: the service is not answering."), a words-only note under Your brain search, and a browser journey.
- **Task 7: golden set v2.** 62 synthetic cases with paraphrase (8), cross-language English and Tamil (6), names and no-answer buckets and dense gates in `npm run brain-eval`. With the fake embedder: paraphrase recall at 5 goes 0.125 to 1.0, cross-language 0 to 1.0, lexical 1.0 to 1.0, names 1.0 to 1.0, no-match rate 1.0 (nine dense metrics in `data/recall-eval-metrics.json`).
- **Task 8: owner-run proof and docs.** `scripts/better-search-proof.ts` (`npm run proof:search`, needs `BRAIN_SEARCH_LIVE=1`; without it prints how to run it and exits 1; temp folder outside the repo; never prints or writes a key or account id; a refusal test is the only part CI and agents run). PROVIDERS, UX, AGENT_INTEGRATION, API, README and `docs/superpowers/plans/2026-10-27-better-search-followups.md` (every ruling and deferred minor) updated.

Verified in this worktree on 2026-10-28 (Windows, Node 24.19.0). These are the final counts from the controller's run at the branch head, after the whole-branch review and its fix wave:

- `npm ci`, `npm run typecheck`, `npm run lint`, `npm run build`: all exit 0.
- `npm audit --audit-level=high`: 0 vulnerabilities.
- `npx vitest run --reporter=dot --maxWorkers=3`: 189 files, 1,955 passed, 8 skipped, 0 failed (1,182 s).
- `npx playwright test --workers=1`: 107 passed, 0 failed, 7.1m. By project: main 69, today-v2 20, connections 7, system1 6, today-v2-bar 4, empty-brain 1. `docs/screenshots` was restored afterwards.
- The final review's fix wave was re-reviewed. It made these changes:
  - Only 400, 413 and 422 count as a refused passage. A bad key or a rate limit backs off instead.
  - When every passage is refused, nothing is withheld.
  - A write stamp keeps the vector cache correct when row ids are reused.

The task-level runs below are kept for the record:
- `npm run brain-eval`: 25/25 passed; golden set 62 cases, recall at 5 = 1.00, MRR 0.97, no-match rate 1.00, positive push rate 1.00, p95 about 54 ms; the nine dense metrics are in `data/recall-eval-metrics.json` (fake embedder: paraphrase 0.125 to 1.0, cross-language 0 to 1.0, lexical 1.0 to 1.0, names 1.0 to 1.0, dense no-match rate 1.0).
- `npx vitest run tests/integration/better-search-proof.test.ts`: 1 passed (the refusal path: no `BRAIN_SEARCH_LIVE=1` prints the instructions, exits 1, shows no key or account id and writes no file; `proof:search` is wired in `package.json`).
- `npx vitest run --reporter=dot`: the machine was out of memory during this task (about 44 MB free of 16 GB, other applications), so the first run lost its workers (exit code 3221226091) and the second, at `--maxWorkers=2`, took 2,816 s: 189 files, 1,899 passed, 46 failed, 8 skipped. All 46 failures were load timeouts in six files this branch does not touch (`managed-decision-advisory-persistence-review`, `managed-decision-advisory-process`, `managed-decision-advisory-worker-review`, `operations`, `paddle-http`, `paddle-store`). Re-run alone, five of the six passed (85 tests) and `paddle-store` passed on its own (7 of 7) after one load-dependent failure, so per file nothing fails; a single clean full run is still owed (the controller's final re-run decides).
- Markdown link check over README, PROVIDERS, UX, AGENT_INTEGRATION, API and the follow-ups file: 50 relative links, 0 broken.
- Key-isolation and behaviour greps: no `BRAIN_DECISION_API_KEY`, `OLLAMA_API_KEY`, `BRAIN_CLOUDFLARE_ACCOUNT_ID` or `BRAIN_EMBED_` under `apps/server`, `packages/domain`, `apps/web`, `apps/mcp` or `apps/cli`; no `process.env` in the four plan files; no `Authorization` in `apps/web`; no `VECTOR_GENERATION`; the engine exclusion prints three lines; `better_search` appears 0 times in `apps/web/src.tsx`; `proof:search` appears in `package.json`, `README.md` and `docs/PROVIDERS.md`.
- The proof script itself was never run, with or without its flag, by this task (only the test's child process, which stops at the refusal).

Known limits:

- **No live embedding call has been made**: not with Ollama, not with Cloudflare. The results above come from a fake embedder, so they prove the plumbing, fusion and gates, not model quality. `npm run proof:search` is owner-run and has not been executed.
- Whether Cloudflare accepts `truncate_inputs` for `@cf/baai/bge-m3` is unverified offline; if it does not, a refused batch falls into the one-by-one retry path.
- Tamil retrieval quality is unmeasured until the owner's proof.
- `DENSE_FLOOR` (0.45) and `DENSE_WEIGHT` (0.7) are initial values; the proof prints the cosine room to judge the floor.
- The hook push level is term-based: a hit found only by meaning reaches `brain_recall` and the owner's screens but never makes a push louder, so a meaning-only prompt can get a quieter push than it deserves.
- The first search of a new question may be words-only when the worker is cold or slow (the vector is cached for the next one).
- The matrix reloads from SQLite after every index write; fine to about 100,000 passages, an incremental update is a follow-up. The cache is bounded by scope count, not bytes.
- Better search runs on the local app only (the managed hosted mode answers 409 and hides the card).
- Ollama Cloud does not serve embeddings, so there is no hosted Ollama choice.
- Plan 5's owner-run checks are still owed (`npm run proof:recall`, `scripts/native-client-proof.ts`, `npm run proof:sorting`).
- Rulings and deferred minors: [the follow-ups file](docs/superpowers/plans/2026-10-27-better-search-followups.md).
- Local V1 only; no real model run.

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
  a model; `Brain.agentGet` is internal with no HTTP route (plan 6 removed the
  test-only `agentSearch` and `agentAsk`).
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

Owner-run native results (2026-10-27, Windows, the owner's own subscriptions;
`npm run proof:recall`, ten prompts: six about the brain, four generic; three
repeats each):

| Client | Hook | Pushes | Median hook time | Tool-call rate | Answered with a citation | Result |
| --- | --- | --- | --- | --- | --- | --- |
| Claude Code 2.1.283 | on | 30/30 | 3 ms | 1.0 | 6/6, every repeat | passed |
| Codex 0.156.1 | on | 30/30 | 2 ms | 0.5 | 6/6, every repeat | passed |
| Claude Code 2.1.283 | off | 0 | n/a | 1.0 | 6/6, every repeat | passed |
| Codex 0.156.1 | off | 0 | n/a | 1.0 | 6/6, every repeat | passed |

- **Push levels.** With the hook on, it pushed full context on five of the brain
  prompts and a pointer on the sixth. It pushed nothing on all four generic prompts.
  No canary leaked in any run.
- **The hook answers without a search.** With the hook on, Codex answered half the
  brain prompts correctly from the pushed evidence without calling `brain_recall`.
  Codex then needs no decision to search.
- **Proof harness fixes the runs needed:**
  - The Claude run needed PR #29: `--restricted` ignores project and local settings,
    so the proof passes the written file with `--settings`.
  - The Codex run needed PR #30: Codex loads a project's `.codex/` layer only for
    trusted projects, so the proof uses a temp workspace outside the repo, a `-c`
    trust override and `--dangerously-bypass-hook-trust`.
  - In normal use a person trusts the project and approves the hook once in `/hooks`.
- **Live sorting check.** `npm run proof:sorting` ran through Ollama Cloud with
  clef-flash and validated 3 of 3 answers, at an estimated 46-56 micro-USD each.
  - The Inbox decision was routed to Northstar (0.96).
  - Small talk was quieted (show 0.23).
  - Calibration notes for later: the decision scored durable 0.23, under the 0.25
    demotion line, and small talk was classed `fact` (0.59).

Known limits:

- No live Clef judge ("Recall help") call has been made.
- `scripts/native-client-proof.ts` was not re-run, and has the same Codex
  project-trust problem the recall proof had.
- Cursor has not been run natively.
- The Windows quoting of the hook command under `cmd.exe /c` has not been observed.
  Both native hook runs went through each client's own shell.
- Embeddings are deferred to plan 5b. Thresholds are initial bands and stay
  uncalibrated until the recall log has real data.
- `source_fts` is retained although the owner screens no longer read it.
- `rankAnswers` (`packages/domain/ask.ts`) and `Brain.agentAsk` were test-only; plan 6 removed them.
- Wall-clock latency tests may flake under heavy machine load.
- This plan supersedes some spec text: the spec's section 3 "withheld" wording,
  section 5.1 "rows swept after an hour" (judge rows now stay and are cancelled
  past their deadline), section 9.8 "judge can only lower" (a judge may also lift a
  pointer to full when the candidates answer the prompt) and the `Freshness`
  contract (now also `retired`).
- This is a local V1. Native client runs and one live sorting call are recorded
  above. There is no hosted release.

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

