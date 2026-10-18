# Bi Brain

**One brain. Every agent. Always caught up. A little ahead.**

BiBrain is the user-owned memory and continuity layer behind the agents a person
chooses. Save something once, keep its meaning current, carry the right context
between agents, and review useful preparation tied to goals the user has chosen.
Agents can change; the user's brain stays theirs.

The user experience is **Save → Continue → Get ahead**. The intended harness contract is **Capture → Gate → Compile → Bind → Prepare → Review → Learn**; the later stages remain under construction.

## Current status

This repository contains a working single-owner local application with persistent capture, source revisions, source-linked previews, reviewed preparation, export/import, and scoped stdio agent access. An in-progress managed foundation adds isolated accounts, standards-based sign-in, extractive workers, a default-off subscription boundary, and sealed spending authority; it is not a public hosted release. The subscription code has local synthetic coverage only: no Paddle account, price, credential, payment, or real allowance is configured. See [managed operator notes](docs/MANAGED_RUN.md). Live model quality, native-client binding, Paddle Sandbox proof, and human release gates remain open. See [BUILD_STATE.md](BUILD_STATE.md) for verified results and limitations.

The latest local product improvement puts capture directly on Today: save a note,
see its actual retained original and source-linked preview, then find and reopen it
in Your brain. Save acknowledgement is independent of preparation; failed reads
remain recoverable, failed writes retain the draft, and corrections/removal/account
changes invalidate the saved receipt. This is functional refinement of the existing
storage/retrieval workflow, not a new live AI or subscription release.

Run with Node 24.19+ in the 24 LTS line: `npm ci`, `npm run db:migrate`, `npm run build`, then `npm start`. Open http://127.0.0.1:4317 and pair using the installation code in `data/owner-secret`. No account or provider key is required. The API and separate worker run together; data lives in `data/brain.sqlite`. See [local operation instructions](docs/LOCAL_RUN.md) for development, optional provider setup, scoped agent configuration, and backup/restore.

The original build specification starts with [START_HERE.md](START_HERE.md). The implementation handoff is [prompts/BUILD_WITH_SOL.md](prompts/BUILD_WITH_SOL.md). Official repository: [Rishflips/Bi-Brain](https://github.com/Rishflips/Bi-Brain).

For your own always-on server, use [SELF_HOSTING.md](docs/SELF_HOSTING.md), [the deployment-agent handoff](prompts/DEPLOY_OWN_SERVER.md), and `deploy/compose.yaml`. This runs the complete API, worker, SQLite and Git vault behind HTTPS with persistent volumes. ChatGPT Sites is no longer a deployment target. Check the [ship audit](docs/SHIP_AUDIT_2026-10-07.md) and BUILD_STATE for actual verification; live-server, native-client and live-provider gates remain separate.

## Product contract

- A new user can paste one conversation and receive a useful, editable project brief before connecting accounts.
- The same selected knowledge can support multiple agents without exposing unrelated projects.
- Background work produces evidence-backed proposals and drafts, with visible provenance and reversible acceptance.
- The user controls what is saved, shared, retained, and spent.
- Missing evidence remains uncertainty. Generated hypotheses never silently become facts.

## Build documents

| File                                                       | Purpose                                            |
| ---------------------------------------------------------- | -------------------------------------------------- |
| [AGENTS.md](AGENTS.md)                                     | Instructions for coding agents                     |
| [docs/PRODUCT.md](docs/PRODUCT.md)                         | Audience, scope, requirements, and outcomes        |
| [docs/UX.md](docs/UX.md)                                   | Screens, onboarding, flows, and edge states        |
| [docs/DESIGN_SYSTEM.md](docs/DESIGN_SYSTEM.md)             | Visual language and accessible interaction         |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)               | Runtime, storage, boundaries, and deployment shape |
| [docs/DATA_MODEL.md](docs/DATA_MODEL.md)                   | Entities, provenance, correction, and deletion     |
| [docs/API.md](docs/API.md)                                 | HTTP contract and errors                           |
| [docs/AGENT_INTEGRATION.md](docs/AGENT_INTEGRATION.md)     | MCP tools, access, and client verification         |
| [docs/BACKGROUND_WORK.md](docs/BACKGROUND_WORK.md)         | Triage, jobs, budgets, and dream receipts          |
| [docs/PROVIDERS.md](docs/PROVIDERS.md)                     | Model adapters and truthful offline behavior       |
| [docs/SECURITY_PRIVACY.md](docs/SECURITY_PRIVACY.md)       | Threat boundaries and retention                    |
| [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) | Dependency-ordered, verifiable milestones          |
| [docs/TESTING.md](docs/TESTING.md)                         | Test matrix, evals, and usability checks           |
| [docs/RELEASE.md](docs/RELEASE.md)                         | Packaging, operations, and launch gates            |
| [docs/BUSINESS.md](docs/BUSINESS.md)                       | Open-source and subscription decisions             |
| [docs/DECISIONS.md](docs/DECISIONS.md)                     | Accepted defaults and deferred choices             |
| [docs/REFERENCES.md](docs/REFERENCES.md)                   | Primary references and research caveats            |

Machine-readable starting points: [contracts/brain.schema.json](contracts/brain.schema.json), [fixtures/beta-launch.json](fixtures/beta-launch.json), and [evals/scenarios.json](evals/scenarios.json).

## Boundaries

The owner-approved release target is a browser-first managed personal suite with sign-in and subscriptions, alongside a useful open-source self-hosted edition sharing the core. Managed identity, account isolation, central spending controls, durable one-inflight safeguards, offline reconciliation/recovery, and the default-off Paddle checkout/webhook/reconciliation boundary now have local synthetic verification. Managed paid processing is still default-off: a browser return or signed event cannot grant allowance, and no owner account or real provider is activated. Paddle Sandbox, live-provider quality, and hosted operations remain separate gates. The permanent System 1 decision capability uses bounded typed judgments where useful, with rules first and deeper reasoning when needed; no prediction grants authority. Native desktop packaging, teams, a marketplace, autonomous external sending, and large connector catalogs are deferred. See the [approved release design](docs/superpowers/specs/2026-10-16-managed-suite-design.md), [activation safeguards plan](docs/superpowers/plans/2026-10-16-managed-activation.md) and [provider activation design](docs/superpowers/specs/2026-10-16-managed-provider-activation-design.md).

Historical implementation used separately authorized agent roles with parent-owned
review. That is not standing authorization for future delegation and never selects
BiBrain's runtime providers; current coding agents must follow `AGENTS.md`.

The default-off managed advisory and Paddle workers are locally verified with
injected transports, including actual-process readiness, restart/no-resend,
checkout correlation and current-evidence checks. Current uncommitted Windows
evidence is **1,488 tests passed, 8 platform skips, 141 files; all 44 Chromium
journeys; 4/4 offline evaluations**. Internal judgments and webhooks never grant
authority. Ambiguous checkout creation remains locked against a second charge and
can be recovered only from an exact signed transaction event or inspected manually.
This is not live-provider quality, real payment or hosted-release evidence; see
BUILD_STATE for the remaining gates.

Licensing is deliberately unresolved; no permissive license has been granted by this build pack. See the business decision document before public release.

# Current harness build

This checkout includes an in-progress local suite/harness build. See [BUILD_STATE.md](BUILD_STATE.md) for verified versus open gates. The portable vault is documented in [docs/bi-brain-vault.md](docs/bi-brain-vault.md). `npm run brain-eval` runs synthetic offline fixtures and writes a machine-readable report; live model and native-client gates are separate.

## Current explicit-decision review slice

Newly saved explicit decisions such as `Beta pricing: free` can be reviewed into current understanding. A later `Beta pricing: paid` note proposes a source-cited exact correction, never silently applies it, and supports owner rejection or guarded approval/undo. Fresh project handoffs include agent instructions and approved context. See [the correction workflow and limitations](docs/CONTEXT_CONFLICTS.md) and the appended current checkpoint in BUILD_STATE.md. This is narrow offline extraction, not general semantic contradiction detection or verified native-client integration.
