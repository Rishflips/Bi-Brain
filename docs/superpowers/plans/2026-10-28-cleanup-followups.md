# Plan 6 (cut dead code): rulings and follow-ups

Recorded while executing `docs/superpowers/plans/2026-10-28-cleanup.md`, as `Ruling: <decision> — <why> — <cost if wrong>`.

- Ruling: F1 Task 1 also rewrites the three agentSearch calls in build-review-fixes.test.ts (246, 278, 304) to pages() — typecheck would fail otherwise — none if wrong.
- Ruling: F2 paddle-http.test.ts deletion moves into Task 3 and the Step 8 grep excludes the kept paddle-transport test and the Task 4 files — Task 3 must typecheck on its own — none.
- Ruling: F3/F4 remove the orphan imports (ask.ts line 1, src.tsx EvidenceList) — lint is an error — none.
- Ruling: F5 git add lists only modified/new files; git rm/mv already stage deletions — git add of a removed path is fatal — none.
- Ruling: F6 the 256 KiB webhook limit is pinned by a reviewer diff check, not a test; no new test (scope is cut-only) — if wrong, a future constant change goes unnoticed.
- Ruling: F7 grep expectation corrected to two hits; setComparison(null) is in the sign-out reset block — none.
- Ruling: F8 trailers Sonnet 5.5, Opus 5.5 for Tasks 3 and 4 — none.
- Ruling: F9 Task 3's commit message and BUILD_STATE say that stale BRAIN_PADDLE_* variables are now ignored instead of failing startup — honest reporting — none.
- Ruling: F10 ignored (alias naming in a kept file) — none.
- Ruling: parked — `today.receipts` may be vestigial after the modal cut; not verified dead, so kept (keep-when-unsure rule) — if wrong, a few unused bytes in the Today payload.
- Ruling: docs/DODO_PAYMENTS.md:4-5 (frozen, owner editing it) still says Paddle config refuses startup; not edited. Task 6 notes it in BUILD_STATE and the owner is told — if wrong, one stale sentence in a frozen doc.
- Ruling: parked — paddle.ts comment slightly misdescribes paddle-store's import (brief wording); PaddleStore.attachTransaction is test-only now but lives in a kept frozen file — keep — cosmetic.
- Ruling: Task 5 edits made SECURITY_PRIVACY.md and MANAGED_RUN.md fail prettier --check (they passed before; API.md already failed before). Task 6 runs prettier --write on those two only — restores prior state — none.
- Ruling: the Fable final review runs on Tasks 1-5 (ce6e9a0..4eea2a4) BEFORE Task 6, so Task 6's full gate runs once after any fix wave. Task 6 then gets a scoped review — if wrong, only the order changes.
- Ruling: controller runs Task 6's gate and writes the docs itself (as in 5b), then a scoped Sonnet review of the docs diff — avoids a subagent idling through a 25-minute run — none.

## Parked for the owner

- `docs/DODO_PAYMENTS.md` lines 4–5 says Paddle configuration refuses startup; it is now ignored.
- `docs/RELEASE.md` line 154 mentions `BRAIN_PADDLE_ALLOW_LIVE=1`, which nothing reads any more.
- `docs/IMPLEMENTATION_PLAN.md` still lists the Paddle B1 checklist.
- All three files are frozen because the owner has pending edits to them.
- Possible follow-up: the Today default's unused `receipts: []` (`apps/web/src.tsx` around lines 313 and 503).
