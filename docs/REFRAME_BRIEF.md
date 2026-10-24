# BiBrain reframe brief

**Status:** Proposal for owner review, 2026-10-23. Nothing here is implemented yet.
The clickable prototype is `design/reframe/bibrain-reframe-prototype.html` and uses
synthetic sample data only.

## Why reframe

The current build has a careful trust model, but almost all of its effort went
into billing and spending control. About half the source code and three quarters
of the tests guard money. Recall is keyword search plus a regex classifier, and
the decision layer (System 1) has never made a live call. Proactivity sits behind
five manual steps. The interface explains its own safety rules on every screen,
so it reads like a form you have to study instead of a brain that helps you.

## The product in one line

**Your agents keep BiBrain current. BiBrain keeps your agents caught up. You
glance, keep or fix, and get back to work.**

## Three moves

### 1. Agents feed the brain (plug-and-play)

- Install with one command: `npx bibrain`. It starts the local app and opens it
  in the browser already paired, using a one-time link the installer creates.
  Nobody copies a pairing code by hand.
- Connections finds the agents you already have (Claude Code, Codex, Cursor) and
  offers one button each: **Add to Codex**. BiBrain shows the exact project file
  it will write and asks once. The agent is "Connected" only after its first real
  call.
- Connected agents do two things: **recall** what is true for this project, and
  **write back** a short session note (decisions, open questions, next step) at
  the end of their work. Write-backs land as suggestions, never as accepted fact.
- Capture becomes mostly passive. Pasting stays available for everything else.

### 2. One calm surface

Primary navigation stays **Today, Your brain, Connections**, but each screen
does one job.

| Screen | Job | What is on it |
| --- | --- | --- |
| Today | Glance and decide | One bar that saves or asks. A Brief of at most three things that changed, each with Keep, Fix or Dismiss. Project cards with one status line. An empty Brief is the normal quiet state. |
| Your brain | Look things up | Projects on the left. Each project shows what is true now, open questions and a timeline of originals. Any fact opens its original with the exact passage highlighted and its history. |
| Connections | Plug agents in | One tile per agent with live status, last use and Revoke. Imports sit below. |
| Settings | Set limits once | Background help on or off, monthly spending cap, plan, export and delete, and one page that explains how you stay in control. |

Rules for the interface:

- The safety rules live on one "How you stay in control" page instead of in
  microcopy on every card.
- No goal ceremony. Watching a project is one switch on its card.
- Every suggestion carries its evidence inline and can be undone.
- The bar answers questions with cited facts from your brain. When nothing
  answers, it says so.

### 3. A real cognitive harness

Three layers, each cheaper and more frequent than the next.

| Layer | Runs | Does | Cost |
| --- | --- | --- | --- |
| Rules | Every event | Validation, duplicates, scope, limits, privacy vetoes | Free |
| System 1 | Every capture and agent write-back | Answers a fixed set of typed questions: what kind of item is this, which project, does it change a current fact, should System 2 look, is it worth showing in the Brief | Cents per thousand calls (Jev, Clef or a local small model) |
| System 2 | Only when System 1 wakes it | Reads the sources and writes a proposal with evidence | Bounded per job and per month |

- Every Keep, Fix and Dismiss is logged against the System 1 answer that caused
  it. That log is the evaluation set and the self-improvement loop.
- System 1 answers are advisory. They never discard a capture, grant access or
  accept a fact.
- Memory upgrades: keyword plus embedding search (sqlite-vec, with a local
  embedding model for self-hosters), facts with valid-from and replaced-by dates,
  freshness so stale facts get asked about, and a retrieval quality test set.
- Spending: one monthly cap per account and one cap per job, in integer cents.
  The four-limit sealed ledger is frozen until there are paying users.

## Editions

| Edition | Price | Who runs it | Models |
| --- | --- | --- | --- |
| Self-hosted | Free, open source (AGPL-3.0; connector Apache-2.0) | You, on your machine or server | Your key, or Ollama |
| Hosted | $12/month or $120/year (approved 2026-10-21) | BiBrain, always on, multiple devices | Included, within the monthly cap |

Ship the local loop first. Hosted follows once the local loop is good.

## Keep, cut, defer

- **Keep:** immutable originals, versioned corrections, evidence-linked facts,
  scoped and revocable agent access, SQLite plus the Git vault, the durable queue,
  the agent connection server already verified in Codex and Claude Code.
- **Cut:** the Paddle code, the five-step proactive setup, hand-copied pairing
  codes, safety microcopy on every screen, the 283 KB build log (replace
  it with a one-page status file).
- **Defer:** the sealed money ledger, managed activation profiles, restore epochs
  and other hosted-only machinery until hosted launch is next.

## What the prototype shows

All content is synthetic and marked as a sample. Agent connections, System 1
routing and answers are simulated in the page. Covered flows:

1. Today with a three-item Brief: an agent decision, a changed assumption with two
   cited notes, and a stale fact. Keep, Fix, Dismiss and Undo all work.
2. The quiet state once the Brief is empty.
3. Saving a note, then a System 1 style suggestion to file it in a project.
4. Asking a question and getting cited facts, or a plain "nothing yet".
5. A project page with facts, open questions, a timeline and the source drawer.
6. Adding an agent in one step, waiting for its first call, then revoking it.
7. Settings with the cap, plan and the control page. Light and dark, phone width.

## Owner decisions

| Decision | Status (2026-10-23) |
| --- | --- |
| Direction | Approved. Build starts with Today v2: `docs/superpowers/plans/2026-10-23-today-v2.md` |
| System 1 for the first live test | **Clef** |
| Billing | Paused after PR #19 is parked, until the local loop ships |
| Open-source license | **Decided:** AGPL-3.0-only for the app, Apache-2.0 for the agent connector (`apps/mcp`, `apps/cli`). Added 2026-10-24 |
