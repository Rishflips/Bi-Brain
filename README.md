# Bi Brain

**One brain for the agents you use. A little ahead of you.**

Bi Brain is a personal workspace for saving knowledge, continuing work across agents, and reviewing useful preparation tied to goals the user has chosen.

The user experience is **Save → Continue → Get ahead**. The intended harness contract is **Capture → Gate → Compile → Bind → Prepare → Review → Learn**; the later stages remain under construction.

## Current status

This repository contains a working single-owner local application with SQLite capture, source revisions, source-linked extractive previews, reviewed preparation, export/import, and scoped stdio agent access. The owner-directed harness migration is underway: a local portable vault and bounded secret quarantine are implemented, and the typed claim gate has its first service path. The eight-tool adapter, full suite and dream reasoning are not yet delivered. See [BUILD_STATE.md](BUILD_STATE.md) for verified results and limitations.

Run with Node 24.19+ in the 24 LTS line: `npm ci`, `npm run db:migrate`, `npm run build`, then `npm start`. Open http://127.0.0.1:4317 and pair using the installation code in `data/owner-secret`. No account or provider key is required. The API and separate worker run together; data lives in `data/brain.sqlite`. See [local operation instructions](docs/LOCAL_RUN.md) for development, optional provider setup, scoped agent configuration, and backup/restore.

The original build specification starts with [START_HERE.md](START_HERE.md). The implementation handoff is [prompts/BUILD_WITH_SOL.md](prompts/BUILD_WITH_SOL.md). Official repository: [Rishflips/Bi-Brain](https://github.com/Rishflips/Bi-Brain).

## Product contract

- A new user can paste one conversation and receive a useful, editable project brief before connecting accounts.
- The same selected knowledge can support multiple agents without exposing unrelated projects.
- Background work produces evidence-backed proposals and drafts, with visible provenance and reversible acceptance.
- The user controls what is saved, shared, retained, and spent.
- Missing evidence remains uncertainty. Generated hypotheses never silently become facts.

## Build documents

| File | Purpose |
|---|---|
| [AGENTS.md](AGENTS.md) | Instructions for coding agents |
| [docs/PRODUCT.md](docs/PRODUCT.md) | Audience, scope, requirements, and outcomes |
| [docs/UX.md](docs/UX.md) | Screens, onboarding, flows, and edge states |
| [docs/DESIGN_SYSTEM.md](docs/DESIGN_SYSTEM.md) | Visual language and accessible interaction |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Runtime, storage, boundaries, and deployment shape |
| [docs/DATA_MODEL.md](docs/DATA_MODEL.md) | Entities, provenance, correction, and deletion |
| [docs/API.md](docs/API.md) | HTTP contract and errors |
| [docs/AGENT_INTEGRATION.md](docs/AGENT_INTEGRATION.md) | MCP tools, access, and client verification |
| [docs/BACKGROUND_WORK.md](docs/BACKGROUND_WORK.md) | Triage, jobs, budgets, and dream receipts |
| [docs/PROVIDERS.md](docs/PROVIDERS.md) | Model adapters and truthful offline behavior |
| [docs/SECURITY_PRIVACY.md](docs/SECURITY_PRIVACY.md) | Threat boundaries and retention |
| [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) | Dependency-ordered, verifiable milestones |
| [docs/TESTING.md](docs/TESTING.md) | Test matrix, evals, and usability checks |
| [docs/RELEASE.md](docs/RELEASE.md) | Packaging, operations, and launch gates |
| [docs/BUSINESS.md](docs/BUSINESS.md) | Open-source and subscription decisions |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Accepted defaults and deferred choices |
| [docs/REFERENCES.md](docs/REFERENCES.md) | Primary references and research caveats |

Machine-readable starting points: [contracts/brain.schema.json](contracts/brain.schema.json), [fixtures/beta-launch.json](fixtures/beta-launch.json), and [evals/scenarios.json](evals/scenarios.json).

## Boundaries

The first release is a polished, single-owner local/self-hosted application. A public managed service is a subsequent release with its own identity, isolation, and billing gates. Native desktop packaging, a marketplace, autonomous external sending, and large connector catalogs are deferred.

The coding model requested by the owner is GPT-6 Sol. That choice does not require Bi Brain's runtime to use the same model.

Licensing is deliberately unresolved; no permissive license has been granted by this build pack. See the business decision document before public release.
# Current harness build

This checkout includes an in-progress local suite/harness build. See [BUILD_STATE.md](BUILD_STATE.md) for verified versus open gates. The portable vault is documented in [docs/bi-brain-vault.md](docs/bi-brain-vault.md). `npm run brain-eval` runs synthetic offline fixtures and writes a machine-readable report; live model and native-client gates are separate.
