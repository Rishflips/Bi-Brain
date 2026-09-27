# Product specification

## Product statement

Bi Brain helps a person save what matters, resume work with their chosen agent, and review useful preparation tied to explicit goals. It is a standalone product with a GUI, durable state, and agent interfaces.

Public language: One brain for the agents you use. A little ahead of you.

## Who starts here

The first validation cohort is individual builders and researchers who use more than one agent over an ongoing project. The entry experience must also make sense to a student or creator. The first release does not attempt specialized workflows for every profession.

Core problem: useful context, decisions, and unfinished work are scattered across conversations and documents. Users repeatedly reconstruct context and fail to revisit information when it becomes relevant.

## Core loop

1. Save a note, conversation, or document.
2. Inspect the original and a derived brief.
3. Correct the understanding if necessary.
4. Continue work using a scoped context package.
5. Choose a goal and opt into background preparation.
6. Review a useful proposal with evidence.
7. Accept, revise, defer, dismiss, or undo.

## Required V1 capabilities

| ID | Requirement | Observable acceptance |
|---|---|---|
| P01 | Useful entry without integrations | Paste a note and receive a source-linked result without OAuth |
| P02 | Durable capture | Original content survives application and worker restarts |
| P03 | Inspectable understanding | Every factual brief item can open supporting source text |
| P04 | User corrections | Corrected knowledge is used in subsequent briefs |
| P05 | Cross-agent continuation | Export a scoped brief; verify native access separately |
| P06 | Goals chosen by the user | Background initiative requires an active, explicit goal |
| P07 | Evidence-backed preparation | A changed assumption produces a reviewable proposal |
| P08 | Reversible review | Accept creates a revision; undo preserves intervening edits |
| P09 | User control | Pause, revoke, delete, export, and cap spending are functional |
| P10 | Honest empty/failure states | No fabricated activity, sources, or integration success |
| P11 | Affordable maintenance | Process changed material; bound each run and total spending |
| P12 | Accessible, responsive GUI | Keyboard-complete at 360px and desktop; usable at 320px |

## First workflow to prove

Goal: Ship a private beta.
Prior decision: Require an agent connection before first value.
New evidence: Two supplied interview notes favor trying one conversation first.
Output: A proposed first-run experiment, with the two notes cited and the original decision preserved.

The product must not infer that the user already adopted this suggestion. It remains a proposal until reviewed.

## Success measurements

These are proposed pilot targets, not measured performance or marketing claims.

- At least 4 of 5 first-time participants save, find, and reuse a brief without instruction.
- Median time to first useful result below 3 minutes on the defined pilot corpus.
- Track the fraction of prepared items users accept or materially use; initially target 50% or better.
- Track unhelpful interruptions separately; begin with at most one non-urgent digest per local day.
- Track missed relevant events through sampled evaluation, not just accepted suggestions.
- Report model cost per reviewed useful artifact and per active user week.
- Zero observed cross-project disclosure in adversarial integration tests.

## Non-goals for local V1

No team collaboration, public social feed, marketplace, email sending, financial actions, custom classifier training, general autonomous browsing, native mobile client, or promise of deep support for every agent.

## Release boundary

Local V1 is single-owner and runs while its host runs. Always-on hosted service is a later delivery mode. A sleeping laptop cannot perform nightly work; missed work resumes under the scheduler's catch-up policy.

## Product principles

Do useful work before asking for integration effort. Show evidence before confidence language. Make correction cheaper than arguing with a chatbot. Prefer a quiet empty state to invented activity. Preserve user ownership through full export and clear deletion. Optimize for returning to useful work, not time spent managing the brain.
