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

- **Reviewed state.** An agent-written original is *unreviewed* until the owner explicitly reviews *that note* through one per-note action: "Mark as reviewed" on the original in Your brain, an edit by the owner that changes its body (a new version by the owner), or the owner saving the identical text themselves (the capture returns the existing note as a duplicate, and the owner's own text counts as their review). Keeping, fixing or dismissing a Brief card derived from the note never reviews the note: the card shows one quoted line, and Keep already creates an owner-reviewed fact, which is what gets pushed. Moving a note between projects ("File in …?") does not review it either. Until the note is reviewed, every path derived from it stays labelled and capped.
- **Storage.** The review time lives in the `settings` table under `source_reviewed:<source id>` (an ISO time). No migration, no change to the `sources` table, no change to the portable export format, no backfill and no write on opening a brain: every agent-written original that exists today starts unreviewed, and the owner marks the ones they have read. A brain restored from an export likewise has every agent-written original unreviewed again, which is the safe direction (the docs say so).
- **Where the origin is visible.**
  - `brain_recall` hits and `GET /api/v1/agent/recall`: an original hit carries `written_by: { agent, reviewed }` when, and only when, it is agent-written. Owner-captured hits have no such field, which keeps the plan-5 snapshot byte-identical. The plain-text rendering adds `written by <agent>, not yet reviewed` (or `reviewed`) to that line.
  - `brain_open` and `GET /api/v1/sources/:id`: the same `written_by` field beside the item.
  - The first-prompt digest: the count line adds ", N of them written by agents and not yet reviewed" when N > 0; the `Recent:` list leaves unreviewed agent-written originals out (their titles are agent-chosen text), and a reviewed one is listed like any other. Nothing changes when the brain holds no agent-written original.
  - The pointer line and the digest's topic names are built from the entity names of visible facts and from the hits that remain after unreviewed agent-written originals are removed, never from such an original's title.
  - `GET /api/v1/context` (the continuation brief an agent may read): for an agent principal, unreviewed agent-written sources are left out of the excerpts; for the owner they are labelled `epistemic_status: "agent_unreviewed"`.
  - Your brain: the Originals list and the original page say "From <agent> · not yet reviewed" or "From <agent> · reviewed" instead of "From an agent"; the original page offers "Mark as reviewed" while it is unreviewed.
  - The Brief card an agent note produces already reads "Written down by your agent / <agent> wrote this down while it worked." and is unchanged.
- **The push cap.** In the hook push, an unreviewed agent-written original never appears in a `full` push and never raises the level: the level is re-read on the hits that remain after those are removed, exactly as it is re-read today after already-seen hits are removed. They may still keep a `pointer` alive, whose names come from fact entities and the remaining hits, never from the note's title. After review, the original is pushed like any other. The push header "Evidence from the owner's brain" therefore stays true.
- **`brain_recall` is unchanged in what it returns**, only labelled: an agent that calls the tool sees the note with its origin and may use it. The server instructions tell agents that an unreviewed agent-written hit is another agent's note, not the owner's statement.

Owner-captured content (pasted, imported, or the files of Part B) is unchanged in every path.

### A2. Rate limiting behind a proxy

- When `BRAIN_PUBLIC_ORIGIN` is set (self-host behind Caddy, and the paused managed mode), the server trusts exactly one proxy hop for the client address (`trustProxy: 1`), so the limiter sees the real client, not the proxy. The Host and Origin checks keep reading the raw headers and are not affected by forwarded headers; a test pins that a forwarded Host is still refused.
- The limiter stays keyed on the client address in every mode (the plugin's default). It never keys on a cookie or a bearer: a value nobody has verified must not be able to open a fresh bucket. Limits keep their values (1,000 per minute globally, 10 per minute on the pairing routes). Tests pin that varying cookies or bearers never yield a fresh bucket, that self-host keys on the forwarded client address, and that local mode behaves exactly as before.
- Local mode keeps the loopback bind, no proxy trust, the same keys and the same limits: byte for byte unchanged.

### A3. Small hardening items

| Item | Behaviour after this plan | Pinned by |
| --- | --- | --- |
| L1 | A top-level browser navigation (`Sec-Fetch-Mode: navigate`) to any `/api/v1/` path other than the read-only health checks `/api/v1/health/live` and `/api/v1/health/ready` is refused with 403 and a plain sentence. Page fetches, agent calls and the Docker healthcheck send no such header and are unchanged. | HTTP test |
| L3 | `Content-Security-Policy` (unchanged value) and `X-Frame-Options: DENY` are sent on every response in every mode, not only under `NODE_ENV=production`. | HTTP test |
| L5 | `POST /api/v1/proposals/gate` bounds `Idempotency-Key` through the same helper as every other route, at 192 characters: the stored key carries the 8-character `propose:` prefix inside the shared 200-character bound. A longer key gets a plain 400 before anything is stored. | HTTP test |
| L6 | `bibrain connect` starts the agent adapter with an allowlisted environment (path, home, temp, locale and certificate variables, plus the two it needs). Provider, billing, sign-in and owner secrets never reach it, and neither do proxy variables, since the adapter only talks to loopback. | CLI test |
| L8 | The Add preview shows the exact `.gitignore` lines for the files BiBrain wrote that carry machine paths (the server file, and the hook file), with Copy, and says "Already in .gitignore" when the folder's `.gitignore` lists them. Cursor's rule file is left out of the list, since a team may want it committed. BiBrain still writes nothing but its own new files. | service and UI tests |
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
2. Ends silently when `stop_hook_active` is true (the turn was already continued by a stop hook), or when the message looks like a secret.
3. Keeps only the marker lines of the message (the same rule as the server, mirrored in the CLI and pinned equal by a test): at most 10 `Decided:` lines, 10 question lines and 1 `Next step:` line, each at most 300 characters, joined with newlines and cut to 4,000 code points. Marker lines sit at the end of a reply, so the whole reply is scanned and only those lines travel. Ends silently when there is no `Decided:` or question line (a `Next step:` alone is ordinary prose), or when the kept lines look like a secret. Free text never leaves the agent's process.
4. Idempotent per session: the hook state file (`data/hook-state/<connection>.json`, hashes only) records the hash of every text already sent for the session; a repeat sends nothing. At most 12 notes per session. The prompt hook's own state writes keep these hashes.
5. Posts the kept lines to `POST /api/v1/agent/session-note` on the loopback BiBrain with the connection's bearer, within a 2,500 ms budget; `redirect: "error"`; any failure ends silently.
6. Prints `{}` to stdout and exits 0 in every case. It never prints `decision`, `reason` or `continue`, never exits 2, so it can never keep an agent running or block it.

**What the server does** (`Brain.sessionNote`, shared by HTTP; agents only, grant operation `propose_memory`):

1. Refuses, with a plain message, a connection that reads more than one project: a session note needs exactly one project, and every connection Add creates has exactly one. Otherwise the project is the grant's only project.
2. Refuses text that looks like a secret (nothing stored; a content-free log row says `secret`).
3. Parses marker lines by rule (`packages/domain/session-note.ts`, pure): `Decided: <topic>: <decision>` (the topic ends at the first colon followed by a space, so a URL in the decision stays whole), `Open question: …` (also `Question:`, `Unclear:`, `Still unclear:`, the same markers Your brain already reads) and `Next step: …`, with or without a leading bullet or bold marks. Lines are capped at 300 characters, the same cap as `brain_note`, and a longer line drops only itself. A `Decided:` line without a topic is ignored. A note needs at least one decision or question; a `Next step:` alone, or no marker line, stores nothing (`nothing` in the log).
4. Hands the parsed note to the existing `agentNote` path with the idempotency key `session:<session hash>:<text hash>`, so the original is "Session note from <agent>", agent-written (A1), its decisions become "Written down by your agent" cards, its questions join Open questions, and a repeated post returns the first result. At most 12 saved notes per session; a text already in the brain (a duplicate) is not counted again.
5. Keeps one content-free counter per connection (`session_notes:<grant>` = `{ notes, last_at }`) and a bounded content-free log (`session_note_log`, at most 200 rows: time, connection, client, saved, reason, suggestion count, latency; never text or ids). `GET /api/v1/connections` adds `writeback: { notes, last_at }` from the counter.

**The agent's side.** The server instructions and the hook's Connections copy tell the agent, in one sentence, to end a substantive reply with those marker lines. The owner keeps, fixes or dismisses the result on Today as with any agent note. Nothing becomes a fact without Keep (A1 makes the note unreviewed until then).

**Add.** `secondFileContents` writes both hooks into `.claude/settings.local.json` (Claude Code) and `.codex/hooks.json` (Codex) in one file, written once and never changed; an existing file still yields the exact text to add, as today. Connections shows a second line under the recall line: "Session notes: on after your next session" (Codex: "on after Codex trusts the hook") until the first saved note, then "Session notes: 3 saved · last <date>". A connection added before this plan, whose hook file has no `Stop` entry, reads "Session notes: add the Stop entry yourself" with a Copy button holding the exact `Stop` block (built on the page from the connection's own prompt-hook command, so no file the owner may have edited is touched) and the same paste hint as today. Cursor reads "Session notes: by hand (Cursor has no end-of-turn hook)".

### B2. Bring in what you already have

- On the empty Today, the third card becomes **Bring in what you already have**: "Your `CLAUDE.md`, `AGENTS.md` and Cursor rules already describe your projects. Pick a project folder; BiBrain reads only those files and shows them before anything is saved." One control: a folder picker.
- The browser's folder picker lists the folder; the page drops the picked folder's own name from each path (so a project folder called `build` or `dist` still works, and titles read `CLAUDE.md`, not `repo/CLAUDE.md`) and keeps only agent instruction files by name and path (`packages/importers/context.ts`, shared by the page and the server): `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `GEMINI.md`, `MEMORY.md`, `.cursorrules`, `.windsurfrules`, `.github/copilot-instructions.md`, `.cursor/rules/*.mdc`; never anything under `node_modules`, `.git`, `dist`, `build`, `vendor`, `target` or `out`. Only the kept files are read. The same rule runs again on the server for import kind `context`, so a crafted request cannot widen it.
- Each file gets its own outcome, never the batch: a file over 1 MiB or over 100,000 characters (the capture limit) is skipped with a warning naming it, on the page and again on the server, and the rest import. The 4 MiB batch and 50 file limits stay, with one plain sentence. The preview dialog, the checkpoint, secret quarantine at capture, duplicates reported and the owner's Apply are the existing import path. No network beyond the loopback API.
- The originals are owner-imported (`origin: import`, shown as "Imported" in Your brain): the owner chose them, and they are the owner's evidence for the push, but a file from a cloned repository was written by someone else, so "Saved by you" would mislead. The dialog says "These files are saved exactly as written. Only bring in projects you trust." beside the existing evidence-not-instructions sentence.
- `~/.claude/projects/<repo>/MEMORY.md` is reached by picking that folder; the copy says so.
- **Parked: git log import.** The browser cannot run git and the server must not execute commands on an owner-supplied path from a page request; a `bibrain import-git` CLI command is a separate plan.
- **Parked: an "empty brain" pointer on the first prompt.** The push says only what is recorded; a pointer on an empty brain would be an imperative aimed at the agent, which the push never carries.

## Data flow of provenance (A1 + B1)

```
agent turn ends ──Stop hook──▶ bibrain hook-end (marker lines only) ──POST /agent/session-note──▶ Brain.sessionNote
                                                                                                  │ parse markers (rule), one project
                                                                                                  ▼
                                                                                        Brain.agentNote → capture(origin agent:<grant>)
                                                                                                  │              │
                                                                        gates (actor agent) ◀─────┘              └─▶ recall index (unchanged rows)
                                                                                                  │
   Today Brief card "Written down by your agent" ◀────────────────────────────────────────────────┘
      Keep / Fix ──▶ owner-reviewed fact (pushed as the owner's)      ✗ never reviews the note
   Your brain: "From Codex · not yet reviewed" ── Mark as reviewed / owner edit ──▶ settings source_reviewed:<id> = now
                                                                                                  │
   recall hit written_by{agent, reviewed} ◀── Brain.writtenBy(source) ◀───────────────────────────┘
      │ brain_recall / GET /agent/recall: labelled, returned
      │ recall-push: unreviewed ⇒ removed from full, level re-read, title never named; reviewed ⇒ ordinary
      │ digest: counted; listed in Recent only once reviewed
      └ GET /context: left out for agents until reviewed
```

## Rulings

- R1. Review state is local viewing-and-trust state in `settings`, like Watch; the portable format is unchanged; nothing is backfilled and nothing is written when a brain opens; restored brains fail safe to unreviewed (documented).
- R2. A `full` push never carries an unreviewed agent-written original, for any connection, including the one that wrote it, and never names its title. The writing agent reaches its own note through `brain_recall`, labelled.
- R3. `written_by` is present only on agent-written items. The plan-5 snapshot stays byte-identical.
- R4. The session-end hook uses `Stop`, not `SessionEnd`, for both clients; the rule for "something happened" is at least one `Decided:` or question line, which the agent is asked to write. Only marker lines leave the agent's process, and only marker lines are stored.
- R5. `trustProxy: 1` only when `BRAIN_PUBLIC_ORIGIN` is set; the Host/Origin policy reads raw headers and ignores forwarded ones, as before.
- R6. The limiter keys on the client address in every mode and never on an unverified cookie or bearer; local mode is byte for byte unchanged. (An earlier draft keyed on sessions and tokens; rejected in pre-flight.)
- R7. The navigation refusal covers every `/api/v1/` path except `/api/v1/health/live`.
- R8. The imported instruction files are owner-imported originals (`origin: import`, "Imported"), titled by their path below the picked folder.
- R9. Git log import and an empty-brain pointer are parked (reasons above).
- R10. No migration. The existing `sources.origin` column plus one settings key per reviewed source carry provenance.
- R11. "Reviewed" is one explicit per-note owner action (Mark as reviewed, an owner edit of the body, or the owner saving the same text). A Keep on a derived card never reviews the note.
- R12. A session note needs a connection that reads exactly one project; a wider grant is refused with a plain message.

## Verification (every task, then the whole branch)

`npx vitest run --reporter=dot --maxWorkers=3`; `npx playwright test --workers=1` then `git restore docs/screenshots`; `npm run typecheck`; `npm run lint`; `npm run build`; `npm audit --audit-level=high`; `npm run brain-eval`. The frozen billing tests need the folder `C:/Users/Gowrishankar/AppData/Local/Temp/opencode` to exist before the full Vitest run.
