# Build state

Updated: 2026-09-28

## Current reality

Working single-owner local preview: React/Vite GUI, Fastify API, persistent Node 24 SQLite, separate durable worker, and official-SDK stdio MCP adapter. Real user capture is retained before derivation. No provider key is required for labeled extractive previews. Today, Your brain, Connections, and Save something are implemented.

This is the local V1 implementation with explicit verification gaps, not a fully verified Local V1 release or a public hosted service. No pricing page or commercial billing was implemented. The owner's screenshot of the older pricing page cannot be traced without its URL; no deployment or pricing update is claimed.

## Milestones

| ID | Deliverable | Status | Evidence / remaining gate |
|---|---|---|---|
| M0 | Runnable foundation | Verified locally | Exact lockfile, offline npm ci, migrations, health, auth/session, build/typecheck/lint; Git initialized with official origin; lockfile and implementation saved in local Git commit |
| M1 | Persistent capture and Continue | Verified locally | Arbitrary text/file capture, evidence, edited understanding, clipboard, Markdown download, restart persistence, error retention; isolated labeled demo |
| M2 | Knowledge lifecycle | Verified locally | Source versions, correction/stale context, scoped full-text search, withdrawal/purge including accepted plans/history, portable preview/import/export, conflicts and deduplication |
| M3 | Durable reasoning | Deterministic gates passed; live gate unverified | Leases, recovery, cancellation/fencing, atomic reservations, accounting, schema/reference checks; real Responses adapter requires legitimate key and operator-verified prices |
| M4 | Goal preparation and review | Verified extractive workflow | Opt-in, relevant-evidence hypothesis, edit/accept/compensating undo, later-edit conflict comparison, snooze/dismiss/history, pause/quiet hours/DST/catch-up; no live contradiction-quality claim |
| M5 | Agent access | SDK transport verified; native gate unverified | Five tools over real stdio/HTTP, fresh SDK sessions, scoped remember/recall/correction/private denial/revocation; SDK 1.30.1. Native Codex and second client not run |
| M6 | Local operations | Local checks passed; external gates unverified | Supervised production processes, migration integrity, actual CLI backup/restore/tombstones/revoked restored credentials, browser/keyboard/responsive checks. Docker/fresh machine and human pilot not run |
| H1 | Managed private beta | Deferred | Hosted identity, connectors, billing, license and public launch are outside this local delivery |

## Evidence — 2026-09-28

Actual commands run:

- `npm ci --offline --cache .npm-cache`: installed from pinned lockfile; audit reported zero vulnerabilities. Same-host reinstall, not a fresh-machine claim.
- `npm run typecheck`, `npm run lint`, `npm run build`: passed. Production assets are served by the API.
- `npm test`: 26 tests passed in five files. Includes real database/HTTP, supervisor restart, official SDK stdio, source deletion during provider work, authorization, concurrent budget admission, exact Unicode evidence, prompt-injection boundaries, schedule behavior, imported reviewed knowledge, and actual backup/restore CLI.
- `npm run test:e2e`: four Chromium browser journeys passed: persistence/evidence/correction/purge/download; chosen-goal preparation/acceptance/later-edit-safe undo comparison; keyboard/Escape/focus/dark mode and widths 320/360/768/1280; input error retention/text-file capture/clipboard/full-text search.
- `npm run db:migrate`: migration versions 1–3 recorded, integrity check `ok`.
- `git ls-remote https://github.com/Rishflips/Bi-Brain.git`: successful with no refs returned. Local `main` initialized and origin set. Local implementation commit created and pushed to official origin/main on 2026-09-28; no hosted deployment.

Test fixtures and browser screenshots contain synthetic test content, clearly described in docs/screenshots/README.md. They are not historical owner data or live-model evidence. Tests use isolated databases under ignored data/ directories. Production owner data lives in data/brain.sqlite; pairing code lives in data/owner-secret and is never included here.

Material verification repairs: scoped a duplicate browser text locator; fixed controlled goal opt-in, Unicode evidence and canonical export hashing; protected accepted plan/history from retained deleted evidence; preserved user corrections through rebuild; prevented ambiguous paid retry and fixed over-bound accounting disable; separated polling preferences from unsaved edits. Early sandbox-only tsx/Node user-info and process-run failures were resolved by approved execution; no simulated passing results substituted.

## Remaining gates and limits

- No OpenAI key or verified provider pricing supplied: no paid call, live smoke/evaluation, real-provider outage/timeout drill, or inferred-reasoning quality claim. Unknown usage stays reserved; unsafe output is rejected.
- Installed Codex CLI reports 0.158.0-alpha.2.1, but native fresh-session verification was not performed. Claude Code was not available. SDK sessions do not replace the two-native-client gate. No global client settings were changed.
- Docker is unavailable; container files are provided but unverified. Fresh-machine install, disk-full drill, and human first-use pilot remain unverified.
- Extractive preparation uses lexical relevance and requires two passages; it offers a review hypothesis, not a detected contradiction. Portable imports are conservative recovery, not divergent-history merging. Storage is local and unencrypted.
- No hosted deployment, account integration, billing, external action, license decision, or public release.

## Next action

Run `npm start` and open http://127.0.0.1:4317. Pair with the local data/owner-secret file, save arbitrary content, and connect a selected project using the instructions in docs/LOCAL_RUN.md. Finish native-client and live-provider gates when their legitimate prerequisites are available, then run a human pilot before declaring Local V1 release complete.


## Push attempt — 2026-09-28

Owner authorized pushing to the official repository. git push -u origin main failed with HTTP 403: GitHub authenticated as saasagelabs, which lacks write permission to Rishflips/Bi-Brain. Implementation remains committed locally at 30dd7d6. Authenticate an account with repository write access, then retry; no remote content was changed.


## Push completed — 2026-09-28

Pushed main successfully to https://github.com/Rishflips/Bi-Brain using the existing Rishflips Git Credential Manager account. The default GitHub CLI helper had selected saasagelabs; command-local helper and username overrides resolved this without changing global account configuration. Implementation 30dd7d6 and prior failure record 3695247 are on origin/main. This publishes repository code, not a hosted application or pricing page.

