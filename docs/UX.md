# UX and interaction specification

## Navigation

Primary: Today, Your brain, Connections.
Global action: Save something.
Settings: appearance, background help, privacy/export, provider setup, and spending.

Projects are scopes inside Your brain, not a required setup ceremony. An unassigned Inbox accepts the first capture. Users may move an item into a project later.

## First visit

Headline: What do you want to pick up later?
Primary input: Paste something you are working on.
Actions: Save to my brain; Try an example.

After save:

1. Confirm durable capture immediately.
2. Display source with a preparation state.
3. Show the resulting brief, or an extractive preview when no provider is configured.
4. Offer Edit understanding and Continue in another agent.
5. Offer Keep this up to date only after the first useful result.

Do not force sign-up in the local application. Hosted identity and guest-to-account migration require a separate specification before hosted launch. Do not quietly upload a first-use note to a model provider without indicating that processing choice.

## Today

Header: Welcome back, followed by a preferred name only if provided.
Main content:

- One highest-value ready item, with up to two additional items collapsed under More prepared work.
- Pick up where you left off: selected project and latest usable brief.
- Background help status: paused/active/unavailable, next eligible run, and a control to pause.

Empty state: Nothing needs your attention. Your saved work is ready when you are.
New-user state: invitation to save something, not fictional prior activity.
Stale state: Last checked on [date]. Connected sources may have changed since then.
Failed state: Your note is saved. I couldn't prepare the brief. Retry or view original.

Never show success while a job is only queued.

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

Separate Knowledge sources from Agents.
Status vocabulary: Not connected, Awaiting authorization, Checking, Connected, Needs attention, Revoked.
A configured token alone does not establish Connected; verify a round trip.

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
