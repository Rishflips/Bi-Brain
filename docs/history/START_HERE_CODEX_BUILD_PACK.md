# Start building Bi Brain

## 1. Select the requested coding model

In Codex, select **GPT-6 Sol** in the model control below the composer, when available. Use High reasoning for the initial architecture and implementation work; this is a recommendation, not a required setting. Model selection must be made in Codex; naming a model in a prompt does not switch the running model.

Official model guidance: https://learn.chatgpt.com/docs/models

CLI alternative, from this directory:

~~~powershell
codex --model gpt-6-sol
~~~

No global model settings were changed by this pack.

## 2. Give Sol the implementation handoff

Paste:

> Read AGENTS.md and prompts/BUILD_WITH_SOL.md. Implement Bi Brain in this project through the local V1 acceptance gates in docs/IMPLEMENTATION_PLAN.md. Start with the persistent Save → Continue flow, then background preparation and verified agent access. Make the application real, run the appropriate checks, and keep BUILD_STATE.md accurate. Do not stop at a mockup.

The full prompt contains context, checkpoints, and completion requirements.

## 3. Expected first runnable result

A local app that opens to a polished first-use screen, accepts a pasted note, persists the original, displays a brief with source references, survives a restart, and lets the user copy a reviewed brief into another agent.

Without a model key, use an explicitly labeled extractive preview and synthetic demo mode. Do not pretend that canned content was generated from the user's note.

## 4. Expected complete local V1

Today, Your brain, Connections; durable sources and page revisions; correction and deletion; project briefs; scoped agent read/contribution access; scheduled preparation with receipts; review, accept, undo, dismiss and snooze; spending limits; export/import; backup/restore; failure recovery.

The exact gates live in the implementation and release documents. Real-provider quality and two-client integration evidence must be reported separately from deterministic tests.

## 5. Decisions already made

- TypeScript throughout the application, React + Vite UI, Fastify API.
- SQLite on a local persistent disk for single-owner V1.
- Durable background worker; no long-running reasoning inside HTTP requests.
- Database is canonical; Markdown + JSON is a portable export, not a competing editable source of truth.
- Provider interfaces are replaceable. Rules precede classifiers; classifiers precede deeper reasoning where useful.
- No new services, model credentials, or paid deployments are needed for the first persistent UI slice.

These are implementation defaults, not claims that every alternative is inferior. Change one only with evidence and a recorded decision.

## Validate this build pack

With Python 3 available:

~~~powershell
python scripts/validate_build_pack.py
~~~

This checks local documentation links, JSON schemas/fixtures, and scenario consistency. It does not validate an application that has not yet been implemented.
