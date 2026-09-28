# Architecture

## Accepted starting stack

- TypeScript with strict checking.
- React + Vite for the web interface.
- Fastify for HTTP API and production static-asset serving.
- SQLite with foreign keys, FTS5, WAL on local disk, and explicit migrations.
- A separate Node worker using a durable SQLite job table.
- Official MCP SDK, pinned to a version verified against chosen clients.
- Vitest for domain/integration tests and Playwright for browser flows.
- npm workspaces and a committed lockfile. Use a compatible active Node LTS verified at scaffold time.

Do not claim a package version is current from this document. Resolve compatible versions from primary documentation and the registry at implementation time.

## Repository layout to implement

~~~text
apps/
  web/           React UI
  server/        HTTP, owner sessions, production static files
  worker/        Durable job polling, scheduling, cancellation
  mcp/           Stdio adapter forwarding authenticated operations to server
packages/
  domain/        Entities, policies, versioning, state transitions
  storage/       SQLite repositories, migrations, transaction helpers
  providers/     Model, triage, and connector adapters
  contracts/     Runtime schemas derived from contracts/
  ui/            Shared accessible components, only when reused
tests/
  integration/
  e2e/
data/            Ignored runtime data, never committed
~~~

Create packages as needed. Avoid empty layers whose only purpose is forwarding calls.

## Runtime boundaries

Browser → authenticated API → domain services → repositories.
Worker → the same domain services → provider adapters.
Agent → MCP adapter → API with a project-scoped principal.

Models never receive database credentials or owner sessions. MCP does not bypass API policy. Provider adapters cannot grant authority.

The API and worker run on the same host for local V1. SQLite WAL requires shared local storage and is not the basis for multi-host horizontal scaling. Keep model calls outside transactions, use a busy timeout and bounded retry, and handle one active writer transaction at a time.

## Canonical state

**Superseded by the owner-directed harness build:** see [HARNESS_AUTHORITY_ADR.md](HARNESS_AUTHORITY_ADR.md) and [bi-brain-vault.md](bi-brain-vault.md). The SQLite-only paragraph below describes the original design, not the new portable authority target. Current implementation is a transitional dual-write projection with an outbox; read-path migration is not yet complete.

SQLite is the authoritative store for source versions, derived revisions, project state, jobs, grants, and receipts. Original content is preserved in source versions. Large attachments can later use a content-addressed blob directory.

Markdown and JSON exports are portable representations. They do not create a second editable authority. An imported edited export becomes a new source version with provenance.

This intentionally avoids the early complexity of bidirectional file synchronization, distributed merge, and database/file dual writes.

## Capture transaction

Validate input and owner/project scope. Apply idempotency key. Insert source version and ingestion event. Queue derivation job in the same transaction. Return source and job identifiers. A worker failure cannot lose the captured note.

## Retrieval and context

Start with scoped keyword search and recent relevant project state. Add semantic retrieval only after evaluating the baseline.
Filter permissions and revoked/deleted material before ranking and before response assembly.
Context packages are bounded and include source IDs, source versions, freshness, omissions, and unknowns.

## Updates

Generated output is staged. Verify schema, references, access, source freshness, and budget accounting. Publish allowed maintenance revisions or reviewable proposals through transactional domain methods.

Use expected_version on user edits and accept/undo. Return a conflict when current state differs. Never apply last-write-wins to knowledge revisions silently.

## Local application security

Bind to loopback by default. Use an installation owner secret for initial pairing and an HttpOnly owner session thereafter. Enforce Host/Origin checks and anti-CSRF protection on browser mutations. Scoped agent tokens are separate and revocable.

Remote self-hosting requires HTTPS and authentication; do not expose a loopback-only development build as a public service.

## Production shape

Build UI assets, serve through the API, run worker as a supervised process, mount persistent local storage, and document backup/restore.
No serverless filesystem or short-lived request worker for scheduled reasoning.

The hosted expansion may replace storage and identity adapters, but is not an invisible deployment toggle. Tenant isolation, quotas, operations, and billing have separate release gates.

## Observability

Structured metadata logs: request_id, job_id, project_id, status, duration, provider, usage, failure code.
No source bodies, full prompts, credentials, or generated sensitive content in default logs.
Expose liveness and readiness separately. The UI shows provider and worker availability without revealing secrets.
