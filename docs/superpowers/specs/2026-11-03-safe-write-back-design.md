# Plan 8: security hardening, then a safe write-back loop (design)

Date: 2026-11-03. Branch `reframe/safe-write-back`, built on `main` at `a7e3ffc` (v0.1.0 release prep merged).

## Scope

Two parts, in this order, and nothing else:

1. **Part A, security.** Agent-written originals carry their origin everywhere an agent or the owner can meet them, and cannot be presented to another agent as the owner's evidence until the owner has reviewed them. The pre-authentication rate limiter behind a reverse proxy keys on the real client and on the session, so one stranger cannot exhaust the owner's bucket. Five small hardening items with a test each. The rest is parked below with a reason.
2. **Part B, the loop.** A hook that runs when an agent finishes a turn and proposes a session note through the existing write-back path, so the brain fills itself without the owner pasting; and "Bring in what you already have" on the empty Today, which imports the instruction files a developer already keeps (`CLAUDE.md`, `AGENTS.md`, Cursor rules and the like) as the owner's own originals. Part B rests on Part A: every note the hook writes is an agent-written original and is treated as one.

Standing rules: `AGENTS.md` (agents only suggest; all model output is untrusted; explicit user capture is always retained; never invent results); the owner's rule that every decision improves user, developer and agent experience together without breaking anything.

Out of scope, by the owner's instruction: hosted and payments, npm publishing, lifting the words-only push cap (needs `proof:search` evidence first), Settings redesign, docs trimming.

## Frozen boundaries

Untouched, byte for byte: every `dodo*`, `billing*`, `managed*` and `paddle*` file and test, `managedPreferencesPatchSchema`, every migration already applied (this plan adds none), and `docs/DODO_PAYMENTS.md`, `docs/RELEASE.md`, `docs/IMPLEMENTATION_PLAN.md`, `docs/PRICING_PROPOSAL_2026-10-21.md`, `docs/BUSINESS.md`.

Never run: the owner-only proof scripts, `npm run calibrate`. Never read: the owner's `data/`, any `.env`.

`tests/eval/recall-dense-off-snapshot.json` is not regenerated. The fixture behind it (`tests/eval/recall-fixture.ts`) holds only owner-captured originals and a read-only grant, so every change in this plan must leave its output byte-identical. If the snapshot test fails, the change is wrong, not the snapshot.

## Part A: security invariants

Each invariant is stated in neutral terms. The plan pins each one with a test that exercises the behaviour, not the implementation.

### A1. Provenance of agent-written originals

An original written by a connected agent (through `brain_note`, `brain_propose`, `brain_intent`, or the session-end hook of Part B) is stored, as today, with `sources.origin = agent:<grant id>`. From this plan on:

- **Reviewed state.** An agent-written original is *unreviewed* until the owner reviews it. The owner reviews it by keeping or fixing any Brief card whose evidence cites it, by editing it (a new version by the owner), or by pressing "Mark as reviewed" on the original in Your brain. Dismissing a card does not review the original. Undo of a kept card does not un-review it (the owner did look at it).
- **Storage.** The review time lives in the `settings` table under `source_reviewed:<source id>` (an ISO time). No migration, no change to the `sources` table, no change to the portable export format. A brain restored from an export therefore has every agent-written original unreviewed again, which is the safe direction.
- **Backfill.** On the first start after this plan, every agent-written original that an *accepted* review gate cites is marked reviewed at that gate's review time; all other agent-written rows stay unreviewed. The backfill runs once per database and is recorded under `provenance_backfill`.
- **Where the origin is visible.**
  - `brain_recall` hits and `GET /api/v1/agent/recall`: an original hit carries `written_by: { agent, reviewed }` when, and only when, it is agent-written. Owner-captured hits have no such field, which keeps the plan-5 snapshot byte-identical. The plain-text rendering adds `written by <agent>, not yet reviewed` (or `reviewed`) to that line.
  - `brain_open` and `GET /api/v1/sources/:id`: the same `written_by` field beside the item.
  - The first-prompt digest: the count line adds ", N of them written by agents and not yet reviewed" when N > 0, and a `Recent:` title from an agent carries "from <agent>, not yet reviewed". Nothing changes when the brain holds no agent-written original.
  - Your brain: the Originals list and the original page say "From <agent> · not yet reviewed" or "From <agent> · reviewed" instead of "From an agent"; the original page offers "Mark as reviewed" while it is unreviewed.
  - The Brief card an agent note produces already reads "Written down by your agent / <agent> wrote this down while it worked." and is unchanged.
- **The push cap.** In the hook push, an unreviewed agent-written original never appears in a `full` push and never raises the level: the level is re-read on the hits that remain after those are removed, exactly as it is re-read today after already-seen hits are removed. They may still count towards a `pointer` (the pointer names projects and topics, not evidence). After review, the original is pushed like any other. The push header "Evidence from the owner's brain" therefore stays true.
- **`brain_recall` is unchanged in what it returns**, only labelled: an agent that calls the tool sees the note with its origin and may use it. The server instructions tell agents that an unreviewed agent-written hit is another agent's note, not the owner's statement.

Owner-captured content (pasted, imported, or the files of Part B) is unchanged in every path.

### A2. Rate limiting behind a proxy

- When `BRAIN_PUBLIC_ORIGIN` is set (self-host behind Caddy, and the paused managed mode), the server trusts exactly one proxy hop for the client address (`trustProxy: 1`), so the limiter sees the real client, not the proxy. The Host and Origin checks keep reading the raw headers and are not affected by forwarded headers; a test pins that a forwarded Host is still refused.
- In every mode the limiter keys an authenticated request on a hash of its session cookie or bearer token, and an unauthenticated request on the client address. The owner's browser, each connected agent and each stranger have separate buckets. Limits keep their values (1,000 per minute globally, 10 per minute on the pairing routes).
- Local mode keeps the loopback bind, no proxy trust, and the same limits. The only local change is that the owner's browser and each agent now count separately, which can only let through requests that were refused before.

### A3. Small hardening items

| Item | Behaviour after this plan | Pinned by |
| --- | --- | --- |
| L1 | A top-level browser navigation (`Sec-Fetch-Mode: navigate`) to any `/api/v1/` path other than `/api/v1/health/live` is refused with 403 and a plain sentence. Page fetches, agent calls and the Docker healthcheck send no such header and are unchanged. | HTTP test |
| L3 | `Content-Security-Policy` (unchanged value) and `X-Frame-Options: DENY` are sent on every response in every mode, not only under `NODE_ENV=production`. | HTTP test |
| L5 | `POST /api/v1/proposals/gate` bounds `Idempotency-Key` to 200 characters like every other route. | HTTP test |
| L6 | `bibrain connect` starts the agent adapter with an allowlisted environment (path, home, temp, locale and certificate variables, plus the two it needs). Provider, billing, sign-in and owner secrets never reach it. | CLI test |
| L8 | The Add preview and the connection show the exact `.gitignore` lines for the files BiBrain wrote, with Copy, and say "Already in .gitignore" when the folder's `.gitignore` lists them. BiBrain still writes nothing but its own new files. | service and UI tests |
| I1 | Expired owner sessions are deleted when a new session is issued. | service test |
| I2 | The Vite dev origins (`:5173`) are allowed only when `NODE_ENV` is not `production`. | policy test |

### A4. Parked, with the reason

- **L2, dependency advisories.** Checked on 2026-11-03 in this worktree: `@fastify/static@10.1.8` (latest) still depends on `glob@^13`, and the fix for `glob` is `>=14.0.2`; `npm audit` offers only a breaking downgrade. `minimatch <11.0.1` reaches the tree through ESLint and typescript-eslint, which have not moved. An `overrides` entry forcing `glob@14` under `@fastify/static` is untested upstream and would ship the static file server on a dependency its author has not validated. All advisories are moderate, CI gates at `high`, and `@hono/node-server` was already fixed (`6cfc0df`). Revisit when `@fastify/static` or ESLint publish a release on the fixed versions.
- **L4, secret scanner breadth.** Its own plan: the server list and the CLI mirror must move together, every new pattern needs false-positive evidence from real notes, and a wrong rule quarantines a real note.
- **L7, Windows file modes.** The ACL helper lives in a frozen `billing*` file. Documented instead: keep `data/` under the user profile on a shared Windows machine.
- **I3, "prompts leave the computer" copy.** A wording change in the Recall help label pinned by UX copy and tests; not security code. Noted for the Settings plan.
- **I4, I5.** Hosted internals and the stale `OPENAI_API_KEY` wiring belong to the hosted plan.

## Part B: the loop

### B1. Session-end write-back hook

**Which event, and why.** Verified on the official documentation on 2026-11-03:

- Claude Code: `Stop` "runs when the main Claude Code agent has finished responding" and its input carries `stop_hook_active` ("true when Claude Code is already continuing as a result of a stop hook") and `last_assistant_message` ("the text content of Claude's final response ... use this field rather than reading `transcript_path`"). `SessionEnd` carries no message, has a 1.5-second default budget and no decision control. Source: https://code.claude.com/docs/en/hooks (sections "Stop", "Stop input", "SessionEnd").
- Codex: the hooks page lists 14 events including `Stop` and `SessionEnd`. `Stop` carries `stop_hook_active` ("Whether this turn was already continued by `Stop`") and `last_assistant_message` ("Latest assistant message text, if available"), and "expects JSON on `stdout` when it exits `0`. Plain text output is invalid for this event." `SessionEnd` runs when Codex closes or a conversation is archived or idle 30 minutes, carries no message, and uses a 1-second default budget (3 seconds at most). Source: https://learn.chatgpt.com/codex/hooks (the English page; `https://developers.openai.com/codex/hooks` redirects there).
- Cursor has no hooks. Its rule file already asks the agent to call `brain_note` when it finishes; that stays the Cursor path, and the Connections tile says so.

Ruling: both clients get a `Stop` hook, in the same file as the existing `UserPromptSubmit` hook. `SessionEnd` is not used: it has no message and too small a budget to post anything.

**What the hook does** (`bibrain hook-end <client>`, in `apps/cli/bibrain.mjs`):

1. Reads the `Stop` event from stdin (200 ms cap, as today). Anything that is not JSON with a string `last_assistant_message` ends silently.
2. Ends silently when `stop_hook_active` is true (the turn was already continued by a stop hook), when the message has no marker line (see below), or when it looks like a secret.
3. Idempotent per session: the hook state file (`data/hook-state/<connection>.json`, hashes only) records the hash of every message already sent for the session; a repeat sends nothing. At most 12 notes per session.
4. Posts the first 4,000 code points of the message to `POST /api/v1/agent/session-note` on the loopback BiBrain with the connection's bearer, within a 2,500 ms budget; `redirect: "error"`; any failure ends silently.
5. Prints `{}` to stdout and exits 0 in every case. It never prints `decision`, `reason` or `continue`, never exits 2, so it can never keep an agent running or block it.

**What the server does** (`Brain.sessionNote`, shared by HTTP; agents only, grant operation `propose_memory`, project = the grant's first project):

1. Refuses text that looks like a secret (nothing stored; a content-free log row says `secret`).
2. Parses marker lines by rule (`packages/domain/session-note.ts`, pure): `Decided: <topic>: <decision>`, `Open question: …` (also `Question:`, `Unclear:`, `Still unclear:`, the same markers Your brain already reads) and `Next step: …`, with or without a leading bullet or bold marks. A `Decided:` line without a topic before the second colon is ignored. When no marker line is found, nothing is stored (`nothing` in the log). Free text outside marker lines is never copied: the note holds only what the agent marked.
3. Hands the parsed note to the existing `agentNote` path with the idempotency key `session:<session hash>:<text hash>`, so the original is "Session note from <agent>", agent-written (A1), its decisions become "Written down by your agent" cards, its questions join Open questions, and a repeated post returns the first result. At most 12 saved notes per session.
4. Appends a content-free row to `session_note_log` (time, connection, client, saved, reason, suggestion count, latency; never text or ids). `GET /api/v1/connections` adds `writeback: { notes, last_at }` from it.

**The agent's side.** The server instructions and the hook's Connections copy tell the agent, in one sentence, to end a substantive reply with those marker lines. The owner keeps, fixes or dismisses the result on Today as with any agent note. Nothing becomes a fact without Keep (A1 makes the note unreviewed until then).

**Add.** `secondFileContents` writes both hooks into `.claude/settings.local.json` (Claude Code) and `.codex/hooks.json` (Codex) in one file, written once and never changed; an existing file still yields the exact text to add, as today. Connections shows a second line under the recall line: "Session notes: on after your next session" (Codex: "on after Codex trusts the hook") until the first saved note, then "Session notes: 3 saved · last 2026-11-03". A connection added before this plan, whose hook file has no `Stop` entry, reads "Session notes: not set up for this connection. Add the agent again to get them." Cursor reads "Session notes: by hand (Cursor has no end-of-turn hook)".

### B2. Bring in what you already have

- On the empty Today, the third card becomes **Bring in what you already have**: "Your `CLAUDE.md`, `AGENTS.md` and Cursor rules already describe your projects. Pick a project folder; BiBrain reads only those files and shows them before anything is saved." One control: a folder picker.
- The browser's folder picker lists the folder; the page keeps only agent instruction files by name and path (`packages/importers/context.ts`, shared by the page and the server): `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `GEMINI.md`, `MEMORY.md`, `.cursorrules`, `.windsurfrules`, `.github/copilot-instructions.md`, `.cursor/rules/*.mdc`; never anything under `node_modules`, `.git`, `dist`, `build` or `vendor`. Only the kept files are read. The same rule runs again on the server for import kind `context`, so a crafted request cannot widen it.
- The existing import path does the rest: preview dialog with the file list and warnings, a checkpoint, the 1 MiB per file, 4 MiB per batch and 50 file limits, secret quarantine at capture, duplicates reported, and the owner's Apply. The originals are owner-captured (`origin: manual`), because the owner chose them; their title is the relative path. No network beyond the loopback API.
- `~/.claude/projects/<repo>/MEMORY.md` is reached by picking that folder; the copy says so.
- **Parked: git log import.** The browser cannot run git and the server must not execute commands on an owner-supplied path from a page request; a `bibrain import-git` CLI command is a separate plan.
- **Parked: an "empty brain" pointer on the first prompt.** The push says only what is recorded; a pointer on an empty brain would be an imperative aimed at the agent, which the push never carries.

## Data flow of provenance (A1 + B1)

```
agent turn ends ──Stop hook──▶ bibrain hook-end ──POST /agent/session-note──▶ Brain.sessionNote
                                                                                │ parse markers (rule)
                                                                                ▼
                                                                      Brain.agentNote → capture(origin agent:<grant>)
                                                                                │              │
                                                      gates (actor agent) ◀─────┘              └─▶ recall index (unchanged rows)
                                                                                │
   Today Brief card "Written down by your agent" ◀──────────────────────────────┘
      Keep / Fix ──▶ reviewGate accept ──▶ settings source_reviewed:<id> = now
                                                                                │
   recall hit written_by{agent, reviewed} ◀── Brain.writtenBy(source) ◀─────────┘
      │ brain_recall / GET /agent/recall: labelled, returned
      │ recall-push: unreviewed ⇒ removed from full, level re-read; reviewed ⇒ ordinary
      │ digest: counted and labelled
      └ Your brain: "From Codex · not yet reviewed" + Mark as reviewed
```

## Rulings

- R1. Review state is local viewing-and-trust state in `settings`, like Watch; the portable format is unchanged; restored brains fail safe to unreviewed.
- R2. A `full` push never carries an unreviewed agent-written original, for any connection, including the one that wrote it. The writing agent reaches its own note through `brain_recall`, labelled.
- R3. `written_by` is present only on agent-written items. The plan-5 snapshot stays byte-identical.
- R4. The session-end hook uses `Stop`, not `SessionEnd`, for both clients; the rule for "something happened" is the presence of marker lines, which the agent is asked to write. No free text is stored from a turn.
- R5. `trustProxy: 1` only when `BRAIN_PUBLIC_ORIGIN` is set; the Host/Origin policy reads raw headers and ignores forwarded ones, as before.
- R6. Per-session and per-token limiter keys in every mode; limits unchanged.
- R7. The navigation refusal covers every `/api/v1/` path except `/api/v1/health/live`.
- R8. The imported instruction files are owner-captured originals (`origin: manual`), titled by relative path.
- R9. Git log import and an empty-brain pointer are parked (reasons above).
- R10. No migration. The existing `sources.origin` column plus one settings key per reviewed source carry provenance.

## Verification (every task, then the whole branch)

`npx vitest run --reporter=dot --maxWorkers=3`; `npx playwright test --workers=1` then `git restore docs/screenshots`; `npm run typecheck`; `npm run lint`; `npm run build`; `npm audit --audit-level=high`; `npm run brain-eval`. The frozen billing tests need the folder `C:/Users/Gowrishankar/AppData/Local/Temp/opencode` to exist before the full Vitest run.
