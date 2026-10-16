# BiBrain managed suite release design

## Authority and outcome

The owner's 2026-10-16 conversation approves execution, delegation and a browser-first managed personal suite with login and monetization, plus a useful open-source self-hosted edition sharing the core. This supersedes prior documents' local-only release boundary and optional System 1 direction. It does not authorize inventing live verification, public deployment, spending without limits, or choosing the owner's license rights.

The outcome is a complete, stable, approachable product, not an AI operating system or a collection of demonstrations. Retain the existing stack and working knowledge lifecycle. Ship sufficient reliable implementations; avoid speculative frameworks, microservices, graph databases, native applications and a connector marketplace.

## User experience

Primary navigation remains Today, Your brain, Connections; Save something is global. No compulsory folders, tagging, special assertion grammar, model selection or protocol setup in the managed first-use flow. Self-hosting necessarily has an operator setup step and must not be described as equally setup-free.

The complete journey is sign in (managed) or pair locally (self-hosted), save arbitrary supported notes/conversations/documents, inspect an editable source-linked brief, ask/find, continue in a verified supported agent, correct understanding, choose a goal, opt into preparation, review evidence, accept/edit/dismiss/snooze, and safely undo. Support is explicit per document format and per native agent version. Generic protocol support is not proof of integration.

Today offers resumption and a small amount of useful preparation, not an endless feed. Motion communicates actual state, respects reduced motion and never fabricates thinking, activity or completion. Every control works or clearly states unavailability. Unknown, stale, offline, failed and budget-limited states use plain language. Capture remains available when intelligence is unavailable.

## Core guarantees

- Keep original source versions immutable to models; human corrections create revisions.
- Retain valid explicit user captures before classification. Classification cannot silently discard them.
- Check authorization before retrieval and again before publishing or returning derived/cached context.
- Evidence and uncertainty remain distinct; a prediction never becomes permission or accepted truth.
- Accept and undo require current versions; undo cannot overwrite later edits.
- Deletion invalidates in-flight and retained derivatives and respects tombstone restore barriers. Previously transmitted copies and unmanaged backups are outside managed erasure.
- Providers receive only consented, bounded, scoped material; private/quarantined content is not silently sent.
- Integer monetary units, short transactions, durable leases, fenced/idempotent output writes, deterministic test clocks.
- No secrets in client bundles, URLs, logs, screenshots, exports or commits.
- No automatic external messaging, publishing, purchases or destructive connected-service actions.

## System 1 is a permanent capability

Use deterministic rules first, a fast typed decision model for bounded judgments where justified, and generative reasoning for synthesis or ambiguity. The capability is permanent; the provider is replaceable, and not every operation requires inference. Begin with one verified live adapter rather than a framework of speculative providers. Jev and Clef are candidates, not guaranteed winners or calibrated authorities on BiBrain traffic.

Inputs, allowed outputs, provider/model/policy versions, bounded context, timeout, usage and accounting are explicit. Validate every answer and its option/reference set. Thresholds are evaluated on held-out cases, including misses and abstentions. No decision model is the only authorization, secret-detection or safety barrier. Initially advisory/shadow decisions are explicitly labeled until an end-to-end quality/cost comparison justifies controlling dispatch. A decision failure does not discard the original or silently trigger a different external provider. Unknown paid usage remains conservatively reserved.

## Two delivery modes

Managed personal: browser login, account recovery through a maintained identity provider, isolated personal knowledge and jobs, included explicitly bounded processing allowance, hosted operation, subscription lifecycle, cancellation and continued export/deletion access.

Self-hosted: local owner access remains functional, no mandatory hosted account, operator-configured providers, private local data and the same core capture/inspect/correct/recall/control guarantees. Licensing is an explicit owner release decision, not implied by this design.

Do not put a login screen over a shared owner principal and call it multi-user. Trusted authenticated identity must select and bind the complete data boundary: SQLite, vault, queue, settings, derived results, sessions, agent credentials, backups and exports. Never accept a tenant identifier or filesystem path from a model, browser header or tool argument as authority. Preserve existing real local databases without automatic migration into managed accounts. Managed-storage design must be reviewed before implementing identity routing.

## Execution and review

GPT-6 Astra advises on architecture and consequential review findings. Ollama DeepSeek V4.1 Flash implements bounded tasks from written plans with failing-test evidence. The parent agent independently reviews the actual diff, runs verification and requests focused repairs. Repeated failed repairs trigger consultation and replanning, not an unbounded loop. Independent tasks may run concurrently with explicit nonoverlapping file ownership. An unavailable credential blocks its narrow live gate, not unrelated implementation.

## Release gates (not current claims)

1. Reproduce the existing local tests/evaluations/browser baseline with disposable data and preserve owner files.
2. Prove cross-account isolation for original and derived knowledge, search, grants, sessions, jobs, caches, exports, restore and revocation.
3. Prove standards-based login/logout/session expiry, replay rejection, account recovery configuration, CSRF/Host/Origin protection, rate limits and no secret-bearing redirects/logs.
4. Prove ordinary-prose understanding, correction, evidence validity and appropriate abstention using real providers and a held-out corpus; do not relabel literal extraction as semantic reasoning.
5. Prove at least two named native clients in fresh sessions, including correction, private denial and revocation. Publish exact support levels.
6. Prove real System 1 request/response and outage behavior, budget accounting, decision quality and total cost including gate overhead. Adapter fixtures are separate evidence.
7. Prove goal-bound opt-in preparation, no repeated nuisance suggestions, cancellation, restart recovery and safe accept/undo.
8. Prove payment-provider test-mode checkout, verified idempotent webhooks, subscription reconciliation, allowance limits, cancellation and export access independent of payment; prove live configuration separately.
9. Prove clean installation, supported OS/container execution, HTTPS, graceful restart, disk-full failure, encrypted operational backups, restore/deletion barriers, monitoring and recovery procedures on the chosen host.
10. Complete keyboard/responsive/accessibility checks and first-use human pilot, license/privacy/security/support decisions and explicit public-release approval.

No screenshot, successful build, synthetic result, SDK-only test or self-reported agent success closes a different gate. Production-ready is earned from the full journey and failure cases; production deployed is a separate state.
