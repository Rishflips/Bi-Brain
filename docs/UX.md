# UX and interaction specification

## Experience promise

BiBrain should feel calmly alive: the user's work has continuity, visible state,
and momentum without becoming a noisy feed or a technical dashboard. A new user
should understand the product by using it, not by learning a “second brain” method.

The first five-minute journey is: sign in or pair locally, drop in something
meaningful, see the durable original and what BiBrain remembers, find it again,
and use it with a supported agent. Projects, organization, preparation, and
advanced controls appear progressively after that first value.

A small state-driven pulse may communicate one of a bounded set of real states:
ready, organizing, keeping current, ready for review, caught up, paused, or
offline. Motion is allowed only when it represents a real state, respects reduced
motion, and never implies that queued or unavailable work completed.

## Navigation

Primary: Today, Your brain, Connections.
Global action: Save something.
Settings: appearance, background help, privacy/export, provider setup, and spending.

Projects are scopes inside Your brain, not a required setup ceremony. An unassigned Inbox accepts the first capture. Users may move an item into a project later.

## First visit

Before private content is available, the local edition presents the BiBrain
promise beside one protected pairing card: **Your thinking, still alive.** The
installation code remains a security boundary, but the screen should feel like
the product—not an operator console. The managed edition uses the same product
story with a real sign-in action. Neither branch invents prior activity.

After pairing or sign-in:

Headline: What do you want to pick up later?
Primary input: Paste something you are working on.
Actions: Save to my brain; Try an example.

After save:

1. Confirm durable capture immediately.
2. Display source with a preparation state.
3. Show the resulting brief, or an extractive preview when no provider is configured.
4. Offer Open it, which shows the saved original. Facts found in it appear in Your brain, and the project page has Preview handoff.
5. Offer Keep this up to date only after the first useful result.

While exactly one active item exists, Today may show a restrained **first useful
loop** beneath the saved receipt. Its three rows are derived only from real
state: the durable original, a pending or owner-approved memory (or ordinary
search when no clear memory exists), and a verified project connection. Each
unfinished row has one direct action. It must not use percentages, streaks,
confetti, fictional completion, or an infinite suggestion feed. It disappears
after a second item is saved, so normal product use replaces onboarding rather
than requiring a dismissal ceremony.

Private material must never receive an agent action in this loop. “Available
where you work” requires a real verified grant for the same project; a generated
key is not completion.

Do not force sign-up in the local application. Hosted identity and guest-to-account migration require a separate specification before hosted launch. Do not quietly upload a first-use note to a model provider without indicating that processing choice.

## Today

Today is for a glance and a decision. It does one job: let the owner save or ask
from one bar, then look at what changed.

Header: "Good to see you." A small status beside it says what the brain is doing
in plain words (for example "Caught up", "2 to look at", "Background help off",
or that the Brief could not be checked).

Main content, top to bottom:

- **One bar.** A single box that saves or asks. Enter sends it; Shift+Enter adds a
  new line. A short single line that ends in a question mark switches the bar to
  Ask. A pasted note is never turned into a question. The owner can switch modes
  by hand and pick the project to save to.
  - Saving keeps the original exactly as written and shows a receipt that says
    so, with an "Open it" button. A failed save says "Not saved." and keeps the
    text in the box.
  - Asking answers only from saved material. Reviewed facts show their quote;
    unreviewed originals are labelled "Original, not reviewed yet". When nothing
    answers, it says so.
  - Limits are explained in plain words: 100,000 characters to save, 500 to ask.
- **The Brief.** At most three things that changed, never a feed. Each card shows
  why it is here, the evidence quote, and a link to the original. Each card has
  Keep, Fix and Dismiss. Keep and Dismiss can be undone for a few seconds; Undo
  never overwrites a later edit. "Still true" and "Try again" have no Undo. A decision that replaces an earlier one shows
  the earlier wording.
- **Quiet is normal.** When nothing needs a decision the Brief says "You are
  caught up." If background help is off, it says that instead of pretending to
  watch.
- **Project cards.** One card per project with a fact count and which agents are
  connected. A card opens that project in Your brain. If the count cannot be read
  it says "Facts unavailable right now" rather than guessing.

New brain: a welcome with three ways to start (plug in an agent, paste something,
import a folder). No fictional activity is shown.

Failed state: the note is saved and the Brief says it could not be checked, with a
way to try again. Never show success while a job is only queued.

On a phone the header and navigation stay in document flow so they cannot cover
the bar or the receipt. Reduced-motion preference removes all animation.

### Goals now live in Your brain

The guided goal flow is no longer on Today. The owner chooses a goal, asks for a
first review and turns "Keep this up to date" on from Your brain. Once a plan is
ready it appears on Today as a card in the Brief ("Prepared for your goal"), where
the owner keeps it, fixes the wording, or dismisses it. No external action is ever
taken.

### Watch and sorting help

- **Watch.** Each project card on Today, and each project header in Your brain except Inbox, has a Watch switch. It is on by default. An unwatched project says "Quiet: not on Today": it adds nothing to the Brief, gets no sorting help and no scheduled reviews, and everything stays in Your brain. Inbox is always watched. The state lives in settings and is not part of exports.
- **File in card.** When sorting help is on and fairly sure an Inbox note belongs in a project, the Brief shows "File in Northstar?" with Keep and Dismiss. Keep moves the note as a new version and says "Moved to Northstar."; if the note changed meanwhile it fails with a plain version-conflict message and moves nothing. Nothing is filed without Keep.
- **Sorting help card (Settings).** Says in plain words whether sorting help is on, off, waiting for the background worker or missing setup, shows the last problem if any, and downloads the review log (what was suggested and what the owner did, never note text). Hidden in managed mode. To turn it on: Settings, "Background help & spending", tick "Turn on background help (sorting new notes and preparing reviews)", set the daily and per-preparation caps above 0, tick "Let BiBrain sort new notes with <service>", then Save preferences. Each "Needs …" or "Waiting …" line names the one control still missing.

## Prepared item

Collapsed content: project, specific title, why it matters now, evidence count, and Prepared—not applied.
Actions: Review; Later; Not useful.

Review detail:

- Earlier understanding and suggested change.
- Original source excerpts, dates, and direct links.
- Unknowns and speculative connections clearly labeled.
- Prepared artifact, editable before acceptance.
- Keep this plan, Edit, Later, Not useful.

Accept persists a new version and receipt in one transaction.
Undo creates a compensating revision. If a newer edit exists, offer a comparison rather than destructive overwrite.
Later requires a visible snooze choice; never hide an unconfigured real reminder behind a success toast.
Not useful removes the item from the active queue and optionally records a reason without requiring one.

## Your brain

The project list sits on the left. Open a project to see True now, Open questions, Originals, Needs a decision here and Goals.
Open a fact or an original to view the retained original with the cited passage highlighted, the fact's history and the facts taken from it.
Search covers facts and originals. It respects access scope and deletion before matching and snippets.
No-result state: No matching notes. Try a different word or save something new.

The selected project opens as a compact page built only from authorized saved
state:

- True now lists only current facts that have evidence. A fact is edited as a
  new version, with Undo, and Still true confirms a stale one.
- Open questions are found by rule in the originals: lines that start with
  "Open question:", "Question:", "Unclear:" or "Still unclear:", and questions
  in an original that has at most three of them. Mark answered hides one, and
  Undo brings it back.
- Goals shows the real goal for the project and its plan state.
- Recent originals open the retained source directly.
- Preview agent handoff uses the existing server-built project handoff; it never
  claims to open or message an external agent.

Your brain always shows one project, and Inbox is the no-setup default for real
sessions. The counts for every project live on Today's project cards. While the
owner searches, hide the project page so each match appears once and search
remains the primary task.

Editing source content creates a new source version; it never rewrites a prior source version in place.
Editing a fact in True now creates a new version of that fact; the original passage and earlier versions stay in its history.
Display pending rebuilds as updating, not current.

## Preview handoff

Show a preview of the exact context being shared: goal, relevant decisions, open questions, selected evidence, and next step.
Default to the current project only.
Provide Copy handoff and Download Markdown in the Project handoff dialog, opened by the project's Preview handoff.
Native agent actions appear only after a verified connection. Otherwise explain manual transfer.
Never simulate opening an external agent or report clipboard success if copying failed.

## Connections

Open with one tile for each agent BiBrain can add: Codex, Claude Code and Cursor.
Each tile says plainly whether the agent was found on this computer, and shows
its current connections. Do not show setup instructions first.

**Add.** A tile offers "Add to {agent}" only in the local app. Elsewhere (a
managed or remotely served BiBrain, or when this computer cannot be checked) the
tile says why and points to "Set up by hand". Add asks for the project, the
project folder where the agent is opened, and what it may do: "Read and suggest
(recommended)" or "Read only". "See the file BiBrain will add" shows the exact
file before anything is written. BiBrain writes only that file in the folder and
never changes an existing one; if the file exists it writes nothing and shows the
lines to add by hand. The access key stays in BiBrain's data folder on this
computer and is never shown in the page. Focus returns to the Add button on
cancel.

**Waiting.** After Add, the connection reads "Waiting for its first call", with
the project, the access level and the folder. A key that exists is never treated
as an active agent, and a hint tells the person to open the agent in that folder
and approve BiBrain once.

**Connected.** The status becomes "Connected · last used {date}" only after the
agent's first real authenticated call.

**Revoke.** Every current connection has a Revoke button that ends access at once,
including in an agent that is already open. Ended and expired connections move
into a collapsed "Earlier connections" list; an expired one does not reactivate.

**Any other agent.** The last tile holds "Preview handoff", a one-time reviewed
copy of one project that creates no ongoing access, and "Set up by hand", the
guided key flow for hosted use and other clients. Connections whose client has no
tile of its own are listed here so no live access is hidden.

**Imports.** Below the tiles, "Choose identity details an agent may receive" and
"Bring more context in" let the person import files, a folder or a chat export
for the selected project, review what was detected, and then apply it.

Agents write back to a project only as suggestions that wait on Today. Revoked
access never counts as active. Fence in-flight reads when the selected project
changes; never render the previous project's data under the new project name.

Status words on a connection, as the screen shows them: "Waiting for its first
call" (server status Not connected), "Connected · last used …" (Connected), "this
access expired" (Needs attention) and "access ended" (Revoked). Expired and ended
connections sit under "Earlier connections".
A configured key alone does not establish Connected; verify a round trip.

Set up by hand keeps the original flow for hosted use and other clients: choose
where to continue, which project the agent may read, whether it may only read or
also suggest, and how long access lasts (default one selected project, read only,
one day). Generate the key only after this review, show it once, and keep it out
of generated commands. Existing project configuration must not be silently
overwritten.

Agent grants: readable projects, ability to propose memories, expiration, last verified access, revoke.
Source grants: selected folders/files, sync direction, freshness, disconnect, remove retained imports.
Disconnect stops future access; deletion of already imported data is a distinct user choice.

## Save dialog

Paste text or import supported text/Markdown files. Show accepted formats and size limits.
Default title is editable; default scope is Inbox.
Explicit capture cannot disappear because a classifier calls it low value.
Duplicate capture returns the original reference with an option to retain a separately dated occurrence.

## Background preferences

Remember: organize and recall selected information.
Prepare: prepare drafts around chosen goals.
Act: future capability; do not display a working toggle in V1.

Set local time zone, quiet hours, digest time, monetary cap, and per-goal enablement.
No notification permission request before an actual user-facing benefit.

## Accessibility and behavior

Native keyboard navigation, visible focus, labeled controls, focus return after dialogs, live status announcements only for meaningful changes, and reduced-motion support.
All actionable content is available without hover.
At 320px, navigation and actions wrap; no horizontal page scrolling.
No full-screen onboarding tour, required tagging, model picker in the primary flow, or graph-first homepage.
