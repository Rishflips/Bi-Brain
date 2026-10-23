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
4. Offer Edit understanding and Continue in another agent.
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
  never overwrites a later edit. A decision that replaces an earlier one shows
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

Searchable list of projects and saved material with familiar titles and dates.
Open a project to view Summary, Decisions, Open questions, and Sources.
Open a source to view the retained original and derived claims.
Search respects access scope and deletion before ranking and snippets.
No-result state: No matching notes. Try a different word or save something new.

The selected project opens as **Project Focus**, a compact command center built
only from authorized saved state:

- Current understanding prefers owner-reviewed claims, with the current
  source-linked brief as a labeled fallback.
- Open questions are copied from the current brief, never generated in the
  browser.
- Chosen direction reflects the real active or paused goal and its accepted plan
  state.
- Recent originals open the retained source directly.
- Preview agent handoff uses the existing server-built project handoff; it never
  claims to open or message an external agent.

When All projects is selected, show a small overview with real counts rather
than mixing project claims. While the owner searches, hide Project Focus so each
matching source appears only once and search remains the primary task. Inbox is
the no-setup default for real sessions.

Editing source content creates a new source version; it never rewrites a prior source version in place.
Editing derived understanding creates a user revision and invalidates dependent briefs.
Display pending rebuilds as updating, not current.

## Continue in another agent

Show a preview of the exact context being shared: goal, relevant decisions, open questions, selected evidence, and next step.
Default to the current project only.
Provide Copy brief and Download Markdown.
Native agent actions appear only after a verified connection. Otherwise explain manual transfer.
Never simulate opening an external agent or report clipboard success if copying failed.

## Connections

Open with one selected-project continuity workspace, not setup instructions. Show
only real counts for reviewed memory, retained originals, current open questions,
chosen direction, verified agents, and keys waiting for first use. A retained
original alone is not handoff-ready: direct the owner to review its meaning before
offering the reviewed handoff. Never treat a generated key as an active agent.

Present two plain-language paths side by side: copy a one-time reviewed handoff,
which creates no ongoing access, or keep an agent caught up with temporary scoped
access. Use the same selected project for handoff, connection defaults, identity
disclosure, and imports so the owner does not have to repeat scope choices.
Fence in-flight page and review reads when the selected project changes; never
render the previous project's counts under the new project name.

Separate Knowledge sources from current Agents. Keep revoked access in collapsed
history instead of presenting it as active; expired access may create a fresh
grant but does not silently reactivate the old key.
Status vocabulary: Not connected, Awaiting authorization, Checking, Connected, Needs attention, Revoked.
A configured token alone does not establish Connected; verify a round trip.

The primary agent flow asks where the user wants to continue, which projects the
agent may read, whether it may only read or also suggest, and how long access
lasts. Default to one selected project, read only, and one day. Generate the key
only after this review. Show it once, keep it out of generated commands, and give
client-specific project-local setup for Codex and Claude Code. Technical setup is
progressive detail, not the first screen.

After key creation, say that access is ready but not connected. Change to
Connected only after a real authenticated operation. Show expiry and last
verification, allow immediate revocation, and verify that an already-open client
is denied on its next operation. Existing project configuration must not be
silently overwritten.

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
