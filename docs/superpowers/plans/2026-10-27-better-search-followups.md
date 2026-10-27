# Better search (plan 5b) follow-ups

This file keeps two records from the subagent-driven build of
`docs/superpowers/plans/2026-10-27-better-search.md` (branch `reframe/recall-embeddings`):

- every ruling the controller made on the owner's behalf;
- every minor review finding that was deferred rather than fixed.

The items below ship as known limits or later polish. The spec
(`docs/superpowers/specs/2026-10-27-better-search-design.md`) is not edited; where a ruling supersedes its text, this file and BUILD_STATE record the change.

## Rulings

Each ruling reads: what was decided, why, and what it costs if wrong.

### Plan pre-flight self-check (R1 to R12, made while writing the plan)

- R1 Cloudflare better search needs `daily_cap_micro_usd` and `per_job_cap_micro_usd` above 0 (the ledger's own limits) but not background help or sorting consent; Ollama needs nothing — the spec names the cap but not which limits — cost if wrong: one extra Settings step for some owners.
- R2 The push level stays term-based: a dense-only hit reaches `brain_recall` and the owner's screens but does not raise the hook level — spec B7 keeps every plan 5 invariant, and the recall log is the place to revisit it — cost if wrong: a meaning-only prompt gets a quieter push than it deserves.
- R3 `BRAIN_EMBED_PROVIDER` selects exactly one provider, like `BRAIN_SYSTEM1_PROVIDER`; the Settings card shows all three choices and disables the one the computer is not set up for with "Not set up on this computer." — simple setup, no both-at-once state — cost if wrong: an owner who wants to switch edits `.env` and restarts.
- R4 Cloudflare query embedding also goes through the ledger (`recall_embed`), so every paid call is bounded; an Ollama query-lane job near its deadline still runs because its answer is free and feeds the cache — money must stay bounded — cost if wrong: a few Cloudflare queries refused near the cap.
- R5 Ollama and Cloudflare are called with `truncate`/`truncate_inputs: true` so an overlong passage never blocks a batch (the embedded text is already capped at 2,000 code points) — one poison passage must not stall indexing — cost if wrong: Cloudflare may reject the field for `bge-m3` (unverified offline, the owner's proof decides), which would fall into the one-by-one retry path.
- R6 A secret-shaped passage is "withheld": `embedding_model` set, `embedding` NULL, never sent, never searched, never retried until the key changes — a secret must never leave the computer — cost if wrong: one note words-only.
- R7 Cloudflare settles at the reported token count when the response carries one, else at the estimate; a reported cost above the reserve settles the known cost and fails the batch — never settle below what was billed — cost if wrong: a rare failed batch.
- R8 `recall_embed` rows older than an hour with no ledger reference are deleted by the sweeper (judge rows keep their plan 5 behaviour) — query text must not linger — cost if wrong: none.
- R9 The model or env change case is handled by consent, not by clearing: the stored key no longer matches the published key, the card says "The search model changed. Choose Better search again.", nothing runs, and choosing again clears and re-embeds — a changed service must be consented to again — cost if wrong: one extra click.
- R10 `RecallResult` gains no field (the MCP `outputSchema` is unchanged); dense shows as `why: "similar meaning"` and as `dense: true` in the content-free recall log — no agent contract change — cost if wrong: agents cannot tell a meaning match from a word match except by the `why` text.
- R11 `ask` and `searchBrain` become `async` so the owner's screens can wait for the vector; four test files are updated in the same task — the 400 ms wait cannot be synchronous — cost if wrong: none.
- R12 The matrix reloads after every index write (spec B8 literally); the incremental update is a recorded follow-up (below) — simplest correct cache — cost if wrong: slower first search after a large import above about 100,000 passages.

### Plan pre-flight resolutions (independent scan, then one Fable fix pass)

- Run an independent Sonnet pre-flight scan despite Fable's self-check — plan 5's scan found 35 blockers or importants a self-check missed — cost if wrong: one scan pass.
- Revise the plan before Task 1 with one Fable fix pass over every blocker and important (and cheap minors) — same as plan 5 — cost if wrong: one planning pass.
- B-01 to B-12 fixed as the scan's scratch edits showed (typing, fixture counts, order, clocks, fake lexicon "statu", membership asserts, bucket counts, dedupe-folded expectations) — cost if wrong: none.
- B-13 no settings write on index writes: vector-cache invalidation uses an in-process generation counter plus `PRAGMA data_version`, so a worker-written vector invalidates the server cache with zero writes when Better search is off and the managed migration tests stay untouched — cost if wrong: a cache reload slightly more often.
- I-01 outage safety: an HTTP error response with no usage settles at 0 (nothing was billed) and the batch backs off exponentially (60 s doubling to 15 min); after three consecutive failed batches a circuit breaker pauses embedding for 15 minutes and the status says "Better search paused: the service is not answering."; an unknown outcome (timeout after send) keeps its hold but counts toward the breaker; self-heal never enqueues while the breaker is open — cost if wrong: slower recovery after an outage.
- I-02 poison rows: a batch rejected with a 4xx is retried one row at a time; a row that fails alone is withheld (model key set, embedding NULL, reason "rejected") and skipped until its text changes — cost if wrong: one note words-only.
- I-03 Cloudflare consent copy also names "the questions your connected agents ask" (agent prompts are embedded for dense recall) — consent must name everything sent — cost if wrong: copy only.
- I-04 Your brain search runs dense whenever Better search is on; the literal fallback applies only when the query has no searchable words or both lists are empty — spec B9 binds — cost if wrong: owner search shows meaning matches for short-word queries.
- I-08 sorting help's `syncSource` after a sorted note re-queues an embed batch, so a note that sorting help re-syncs is embedded twice (one extra batch row per sorted note under Cloudflare) — accepted, bounded by the ledger — cost if wrong: a few extra micro-USD.
- I-15 the vector cache is bounded by scope count, not bytes, and any commit from another connection reloads the matrix only when its scope fingerprint moved — left as is — cost if wrong: memory on a very large brain.
- Minors: fix the vacuous better-search-http test, list `apps/web/brain/types.ts`, correct the cost copy, keep the `status()` managed-branch SQL untouched, make the key-isolation verification grep print only real hits; the rest are left with a note in the plan — cost if wrong: none.
- The 8 billing, dodo and paddle failures in the scratch run are attributed to the scratch path (long paths, EPERM); the final verification on the real worktree decides — cost if wrong: caught at final verification.
- R13 `Brain.embedQueueOpen()` gates the capture hooks, the self-heal check and the batch itself — a batch queued before a failure must also wait out the back-off — cost if wrong: a queued batch waits out the breaker.
- R14 ledger refusals (limits gone, lease lost) are cancelled and do not count toward the breaker — only provider failures and unknown outcomes do — cost if wrong: none.
- R15 the breaker also stops the query lane (words only while paused) — owners should not wait 400 ms per search against a dead service — cost if wrong: no dense during an outage, which is correct.
- R16 withheld rows persist as `embedding_dim = -1` ("rejected"; NULL for "secret"), no new column and no migration — cost if wrong: a sentinel value to document.
- Spec B1's consent copy is superseded by the plan's (adds the agent questions and the cost line); the spec file is not edited — cost if wrong: a reader of the spec alone sees the older copy.

### Task rulings (made while building)

- Task 2 I-1 (the `data_version` test was vacuous) and I-2 (`data_version` is database-wide, so any worker commit forced a rebuild of about 350 ms at 20,000 by 1,024 against the 400 ms query budget) were fixed now, because the query budget binds: a per-scope fingerprint (count, max id, sum of ids of embedded rows in scope) is checked when `data_version` moves, rebuilding only when it changes, plus a typed-array fast decode (rebuild after an unrelated worker commit went from 306 to 658 ms down to 71 to 73 ms) — cost if wrong: a stale cache entry only if an update changed vectors without changing ids (own writes are covered by the in-process generation).
- Task 2 minors 1 (drop stale cache entries on load) and 3 (the re-read also checks project, visibility and status) were promoted — cheap memory and defence in depth — cost if wrong: none.
- Task 3 implementer ran on Opus — money, concurrency and outage handling (ledger holds, breaker, leases) are the risk class of plan 5 Task 10 — cost if wrong: higher spend for one task.
- Task 3 fix round covers C-1 (ledger-refusal hot loop), I-1 (a refusal set `retry_at` without counting failures) and I-2 (re-check visibility and version per row before each Cloudflare send), and promotes minors 1 (keep breaker fields across a worker restart when the key is unchanged), 2 (re-queue only through `maybeQueueEmbedBatch` after "embedded") and 3 (text hash in the write guard) — money safety, privacy and correctness — cost if wrong: none.
- Task 4 and Task 5 implementers ran on Opus (judge-lane risk class; authorization-critical) — cost if wrong: higher spend.
- The Cloudflare query reserve floor is 150 ms (`QUERY_MIN_LEFT_MS` for Cloudflare) and Ollama keeps none — a Cloudflare call started with 50 ms left almost never answers in time, so it only spends money — cost if wrong: a few more queries fall back to words.
- Task 4 minors M1 (in-process back-off after three consecutive query failures: skip calls for 60 s, cancel jobs at once), M2 (cancel-and-key cleanup once a minute so crash-left query text is gone within a minute) and M3 (query call abort at 2 s, below the 10 s lease) were promoted into one fix round — money, privacy and head-of-line blocking — cost if wrong: none.
- Task 5 important finding (the judge could raise the hook push level for dense-only candidates and was called on prompts plan 5 left silent) is fixed: R2 binds the judge path too, so the judge is skipped when no candidate was found by words and the level is capped at the term level when the top surviving hit is dense-only — cost if wrong: fewer judged pushes on meaning-only prompts.
- Task 5 minors 1 (replace the tautological byte-identity check with a committed dense-off snapshot captured at b1b05c1 semantics), 2 (omit `dense` from recall-log rows when false, so Better search off is byte-identical), 3 (deterministic signals computed over word candidates in unpinned fused order, so Better search on never pushes louder than off) and 4 (reuse one entity helper) were promoted — the "off is plan 5" and "never louder" rules bind — cost if wrong: none.
- Task 6 I1: Save is enabled when the saved choice needs re-consent (the status key differs from the stored key), so "Choose Better search again" has a working control — cost if wrong: none.
- Cost copy became "about 1 cent for every 250,000 words" — the ledger estimates about 3 tokens per English word (half the UTF-8 bytes per token), so 500,000 understated the counted cost about 1.8 times; the copy must not promise less than BiBrain counts — cost if wrong: copy overstates the cost slightly for English. It then gained "of English text; other languages can cost more", because the ledger counts bytes and a script such as Tamil costs several times more per word. This supersedes the earlier "500,000 words" copy in the plan and the spec.
- Task 6 minors M1 (PATCH without CSRF returns 403 and an agent bearer PATCH returns exactly 403, nothing persisted) and M4 (the last problem is mapped to plain language, with no HTTP codes or provider or model names on the card) were promoted — security test coverage and the AGENTS.md copy rule — cost if wrong: none.
- Accepted the regenerated `tests/eval/recall-dense-off-snapshot.json` — produced with Better search off from current code; all 41 unaffected cases are identical after normalising digest and candidate counts; the 5 changed cases come from new-note word overlap and still meet their expectations — cost if wrong: a hidden regression, mitigated by the plan 5 gates passing unchanged.
- Task 8 proof script exits 1 when run without `BRAIN_SEARCH_LIVE=1` (like `recall-agent-proof.ts`; the plan text said 0) because nothing was proven; its refusal test sets the variable to an empty string rather than deleting it, so a `.env` line can never switch the live proof on under test — cost if wrong: a caller that expects 0 sees 1.

### Final-review rulings

- I-1 error statuses: only 400, 413 and 422 mean "the input was refused" and isolate a batch row by row. 401 and 403 are a refused credential: an ordinary failure (back-off, breaker) with the status line "Better search could not sign in to the search service. Check its key.", mapped on the card. 408, 429 and every other status are ordinary failures. None of them ever withholds a row, and each costs one call per batch. Before this, every 4xx withheld the whole index under a bad key or a rate limit, at 33 calls per 32 rows with no back-off. The query lane already counted every error as a failure — cost if wrong: a passage the service refuses with an unlisted status is retried with back-off instead of being withheld.
- Request-shape refusals: when the service refuses every row it was sent alone in a row-by-row pass (or refuses a lone pending row), the likely cause is the request (for example the unverified `truncate_inputs` field on Cloudflare), not a text. Nothing is withheld, the rows stay pending, the attempt counts toward the back-off and the breaker, and the status says "The search service refused every passage. Better search will try again later.", mapped on the card. A pass where only some rows are refused still withholds just those. Local input checks (nothing sent) still withhold — cost if wrong: a truly poison passage that is the only pending one is retried with back-off (each refusal settles at 0) until a new passage joins its batch, which then isolates it.
- I-2 fingerprint: every `writeEmbeddings` call stamps its rows (`recall_chunks.embedded_seq`) from a one-row counter (`recall_vector_stamp`) that only grows. The scope fingerprint adds `max(embedded_seq)` and stays answerable from `recall_chunks_embed` alone. The migration 7 block adds the column, rebuilds the older index and seeds the counter on open. There is still no settings write (B-13 holds), and with Better search off nothing is written — cost if wrong: one extra single-row update per batch write.

## Deferred minors

- Task 1: `LOOPBACK_HOSTS` and the model-name pattern are duplicated in `embed-env.ts` and `embed.ts`.
- Task 1: tests lack loopback-bypass hostnames, a non-finite element, a Cloudflare error status and odd-length base64.
- Task 1 (unverified, the owner's proof decides): Cloudflare accepts `truncate_inputs` for `@cf/baai/bge-m3`.
- Task 2: `VectorCache.search` assumes a unit query vector (not enforced).
- Task 2: a `subarray` keeps the whole buffer alive; no `maxScopes` eviction test; a rollback inside a transaction can leave a cache entry (speculative).
- Task 2: the "any"-status (history) fingerprint uses a non-covering index (about 75 ms at 20,000); use `status IN ('current','history')`.
- Task 2: the fingerprint was not only a theoretical collision: `recall_chunks.id` has no AUTOINCREMENT, so replacing the newest rows (sorting help's re-sync, or any replace from another process) reused their ids and a rewritten vector kept the same (count, max id, sum of ids). Fixed in the final review by the `embedded_seq` write stamp (see the final-review rulings). Still open: a raw SQL vector write that skips the stamp is invisible to another process's cache while ids and count are unchanged (production writes go through `writeEmbeddings`); a set swap that keeps count, max and sum equal between two searches can still collide; prune fingerprints for up to 8 stale scopes per version bump.
- Task 3: holds left dispatched on timeout, abort or a settle that throws are bounded by the breaker and the daily cap (by design).
- Task 3: `EMBED_CALL_MS` equals the default `timeout_ms` (a cosmetic message race).
- Task 3: `setBetterSearch` queues a batch while paused (the batch cancels at start).
- Task 3: raising the daily cap after a refusal does not clear `retry_at` (it waits until the next accounting day).
- Task 3: after a restart following a daily-cap refusal the card shows the wait without its reason (`last_error` is only carried when failures are above 0).
- Task 3: a daily-cap refusal is recognised by the "Today's" message (no structured kind on `BUDGET_EXHAUSTED`); it fails safe to 15 minutes.
- Task 4: M4 a query failure sets the shared `last_error`, which a query success does not clear.
- Task 4: M5 the worker's query cache has no size bound (cap about 512, evict oldest).
- Task 4: M6 dead `request_hash` in the query job payload (plan-mandated).
- Task 4: M7 Cloudflare `recall_embed` ledger rows are kept forever (ledger retention).
- Task 4: M8 slow shutdown (lanes stop sequentially, the in-flight call is not aborted).
- Task 4: the crash-sweep test's "lease still live" check is weak (the deadline is also ahead); no test of a Cloudflare abort keeping its hold; a settle that throws counts as a provider failure.
- Task 5: dense-only near misses say "matched 0 of N terms".
- Task 5: the fuse tie-break uses `key.localeCompare` with random ref ids, so a future exact score tie could make the snapshot order flaky.
- Task 5: a deterministic full push can lead with a meaning-only hit (the level stays term-based).
- Task 6: M2 the test helper is typed `any`; M3 the paused line wins over "worker not running"; M5 "N of M ready" updates only on refresh; M6 the Cloudflare radio is selectable without limits (the domain answers 409).
- Task 6: a non-`BrainError` reserve failure is shown as "went over its spending limit"; the leak regex misses "Workers AI", 4- to 5-digit ports, "@cf" and "http"; "See Providers in the docs." has no link; the cost test greps source instead of the rendered card; a refused PATCH rethrows a server message that names Cloudflare.
- Task 7 (final review check): the closing dense leak probe only asserts the absence of `PRIVATE_CANARY` without proving the owner query reaches `src:private-journal`.
- Task 7: the `para-01` query still contains "release" (it word-matches `src:ticket`); a fixture comment about "dollars" and "Ana" word overlap.
- Cache memory: the vector cache is bounded by scope count, not bytes (I-15 above).
- Incremental matrix update: the matrix reloads from SQLite after every index write, fine to about 100,000 passages (R12 above).
- Double embedding of a sorted note under Cloudflare (I-08 above).

## Owner-run checks still owed

- `npm run proof:search` with Ollama (`bge-m3` pulled) and with Cloudflare. No live embedding call has been made. It also settles whether Cloudflare accepts `truncate_inputs` for `bge-m3`, and whether 0.45 is the right floor and 0.7 the right weight (the proof prints the lowest cosine of a wanted hit and the highest of a no-answer query).
- Tamil retrieval quality on real notes is unmeasured; CI uses a fake embedder with a hand-built lexicon.
- Everything under "Owner-run checks still owed" in `docs/superpowers/plans/2026-10-25-recall-followups.md` is still owed (`npm run proof:recall`, `scripts/native-client-proof.ts`, `npm run proof:sorting`).
