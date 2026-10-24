# Sorting help (System 1 with Clef): follow-ups

These are the minor findings left open after plan 4 (System 1 with Clef). None blocked merge. Each task review rated them minor. Items fixed later on the branch are not listed.

## Worth doing first

- **Owner-run live proof.** No live Clef or Ollama call was made on this branch. Run `BRAIN_SYSTEM1_LIVE=1 npm run proof:sorting` and adjust `BRAIN_SYSTEM1_MODEL` or `BRAIN_SYSTEM1_ENDPOINT` if `ollama.com` needs a tag or a different path.
- **Monthly cap.** Deferred (Ruling 10): it needs ledger changes in billing-adjacent code. Sorting help uses the daily and per-note limits.
- **Captures in unwatched projects.** `derive_brief` still runs on them (existing extractive preparation). Watch quiets Today, sorting help and scheduled reviews only.
- **Transient outages.** A call that fails after it was sent is not retried (Ruling 15), so a flaky provider leaves a few notes unsorted.

## Providers (`packages/providers/system-one-ask.ts`, `system-one-env.ts`)

- The Ollama tests do not pin a nonzero output price, `http://ollama.com` or an empty-string key (the code handles all three).
- `resolveAskConfig` uses an `as unknown as` provider cast.

## Run script (`scripts/run.mjs`)

- It strips `BRAIN_DECISION_API_KEY` from the server, which is why status is published by the worker (Rulings 12 and 13). Consider one documented list of worker-only secrets.

## Feedback and the review log

- Dismiss on proposal and stale cards is not logged (no sorting answer causes them).
- No test asserts that accept-with-edit logs `fix`.
- No action judges `kind`, so there is no owner signal for kind accuracy.
- `entities()` scans grow with the number of `s1_answer` and `s1_feedback` rows. Fine at V1 scale; move them to a table later.

## Keep on "File in" (`fileSuggestion`)

- A Keep queues one more sorting call for the moved note's new version.
- `fileSuggestion` skips `editSource`'s zod re-parse (the values come from the stored source).
- A stray `{}` block in `editSourceTx`.
- A rolled-back Keep may leave a vault file for version N+1 (an existing `editSource` exposure).

## Worker (`apps/worker/system-one.ts`)

- Failures write a "failed" receipt that appears in the exported dreams log. It is a useful audit trail, but decide on purpose.
- `hasUnresolved` would mis-key if one Worker ever had both `decisionAccounting` and `systemOne` (it fails safe; `main.ts` never builds that).
- An aborted signal reserves and then releases (one extra ledger write).
- The skip reason picks "secret" or "too large" by matching `/secret/` in the error message (both are `INVALID_INPUT`), and the too-large message has no test.

## Web (`apps/web`)

- The web `BriefItem` type lacks `quiet?`.
- The Keep toast parses the card title ("Moved to X.", falling back to "Moved.").
- The unavailable-status line and the consent 409-reason path have no browser test.

## Tests

- The "facts still listed" assertion in the watch tests compares two empty lists (the sample note creates no accepted facts).
