# Connections v2: follow-ups

These are the minor findings left open after plan 3 ([2026-10-23-connections-v2.md](2026-10-23-connections-v2.md)). None of them blocked merge. Each task review and the final whole-branch review rated them Minor. Items that were fixed later on the branch are not listed.

## Worth doing first

- **Repeated agent proposals.** `brain.propose` from an agent always queues (Ruling 7). `brief.ts` has no dedupe for queued gates, so an agent that proposes the same exact fact twice makes two Today cards. Session notes do not have this problem: `queueMemoryGate` treats an identical queued gate, a current claim or a rejected/dismissed agent decision as a duplicate. Give `propose()` the same rule.
- **CLI orphan on unexpected errors.** `apps/cli/bibrain.mjs` kills the server it started on every planned failure. It does not kill it on an unexpected error after the spawn, such as a `fetch` or `res.json()` failure in `openSignedIn`, or a missing browser opener's spawn `error`. Kill the child in the top-level catch, and handle `error` on the browser spawn.
- **Windows process tree.** On Windows, `child.kill("SIGTERM")` terminates `scripts/run.mjs`, but its server and worker grandchildren may keep running after a failed start or Ctrl+C. Confirm this on the owner's machine. If it happens, stop the tree (`taskkill /T`) or have `run.mjs` watch its parent.
- **Key files for expired grants.** Revoke deletes the key file. Expiry does not, and `scripts/restore.ts` revokes every grant without deleting any key files. Add cleanup on expiry and in restore.

## Connect service (`apps/server/agent-connect.ts`)

- A crash between `createGrant` and the key write leaves a live "Not connected" grant that no one holds a key for. The owner can revoke it.
- A key write that opens and then fails (disk full) leaves a partial key file for a revoked grant.
- `checkConfigDir` uses code `INVALID_INPUT` with status 409. A swallowed `revoke` failure during rollback has no log line.
- Tests:
  - The `..x` containment tests do not fail on the old condition; `join(dataDir, "..x")` would discriminate.
  - Nothing pins "do not unlink a key file this call did not write".

## Project files and detection (`packages/domain/agents.ts`)

- `JSON.stringify` leaves U+007F raw and writes lone surrogates as `\udXXX`. Both are invalid in TOML basic strings, so a folder path containing them would write a broken `.codex/config.toml`. `checkFolderShape` refuses only NUL.
- Quote stripping in `detectAgents` runs on every platform, not only win32.
- Codex keys (`default_tools_approval_mode`, `required`, timeouts) are verified only by the owner-run native proof. `startup_timeout_sec = 15` may be too short on a slow first start.
- `createGrant` repeats the `AGENT_CLIENTS` enum by hand, and `connections()` returns the raw stored client string.

## Sign-in link

- No managed-mode test for the two pair-link paths. The secure self-host refusal is tested.
- No test for the 5-link cap or the exact 120 s boundary. `issuePairLink` is not in a transaction (single process, negligible).

## Session notes (`agentNote`)

- `findOpenQuestions` splits sentences, so `"ships. Open question: x?"` inside a decision, or a summary that starts with a marker, can add an open question beyond `open_questions`. The response count then understates what the owner sees. This adds no new capability, because agents can already add questions.
- The `agent_note` idempotency row is written outside the note's transaction, so a crash in that window lets a retry re-queue gates.

## Connections UI (`apps/web/connections`)

- If `/agents` fails to load, each tile shows an empty status line under the top alert.
- The Windows-style folder placeholder shows on every OS.
- The folder pre-fill may come from an ended grant rather than a live one.
- After a connect error, the open "See the file" panel says "Enter the project folder" while a folder is entered. Toggling the panel during `add()`'s own preview makes `add()` exit silently.
- No tests for the aria attributes, the focus moves or the focus-triggered refresh of detection.
- A managed BiBrain answering on the CLI's port gets "Something else is using port".

## Tests and housekeeping

- `agent-grants.test.ts:41,45` uses `"C:\work\northstar"` with unescaped backslashes, so no real Windows path is tested.
- The migration-6 upgrade test does not seed a grant before dropping the columns, and does not assert a single version marker after a second reopen.
- The `briefInput` comment "Grants carry no display name…" is now false.
- The managed-decision-advisory-migration test title and comment still say v5 while asserting 6.
- An agent's queued exact fact carries reason code `exact_structured_assertion`, not one saying agents wait for the owner.
- `agent-proposals.test.ts` does not assert that the accepted claim still names the proposing agent.
- On win32, SIGTERM handlers in the CLI never fire and `kill()` terminates outright. The adapter is stateless.
- `bibrain help` omits `--no-open` and the `connect` flags.
- `playwright.config.ts` creates `data/e2e-agent-home-<stamp>` on every load and never cleans it up (it is git-ignored).
- The README quick-start sentence is one unwrapped line.
- Full Vitest runs on this machine sometimes time out in the `managed-decision-*` files and `vault.test.ts` under load. Those files pass when run alone.
