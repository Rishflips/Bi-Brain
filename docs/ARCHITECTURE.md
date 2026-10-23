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

```text
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
```

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

**Managed expansion approved 2026-10-16:** begin with one isolated SQLite database, explicit portable vault and protected sibling per personal account on bounded single-host storage. A separate control database owns trusted identity/session/token routing. Request-bound runtime handles and tenant-bound shared-service principals enforce account isolation; no client-supplied tenant path or identifier grants authority. Standards-based OIDC follows isolation. Local pairing and owner data remain separate; no automatic adoption of a local brain into an account. This is the reviewed architecture target, not proof that managed operation is delivered. See [the release design](superpowers/specs/2026-10-16-managed-suite-design.md) and [foundation plan](superpowers/plans/2026-10-16-managed-foundation.md).

Build UI assets, serve through the API, run worker as a supervised process, mount persistent local storage, and document backup/restore.
No serverless filesystem or short-lived request worker for scheduled reasoning.

The hosted expansion may replace storage and identity adapters, but is not an invisible deployment toggle. Tenant isolation, quotas, operations, and billing have separate release gates.

### Managed money authority (locally verified, paid activation off)

The control database now contains the authoritative managed monetary ledger. One
short immediate transaction admits a call against four integer-micro-USD limits:
its account's explicit UTC allowance window, one shared service UTC day, cumulative
job spend and the user's frozen accounting day. Operator policies default to zero;
user caps can lower, never grant, authority. Every unresolved hold carries across
periods. Pricing/request identities and admitted periods are immutable.

`ManagedWorker` injects an account-bound accounting coordinator. Central reserve
precedes the tenant's conservative journal; fresh central and lease-fenced tenant
marks must both succeed for that invocation before provider I/O. Existing markers
never authorize a resend. Known settlement commits centrally first, independently
attempts the tenant projection, and retains charges even when publication fails.
Unknown or unmapped tenant history requires reconciliation rather than a new
allowance. Managed status reads central own-account figures and strips all shared
service financial totals before returning them to a user.

A dispatched central row now also acts as a durable **service-wide one-inflight
barrier**. Reserve and fresh-mark admission check it inside their immediate
transactions, across all accounts and stages. Unknown usage survives restart as
a global paid pause without depending on a later marker write; ordinary known
settlement clears that ambiguity. A reserved-only hold is not a global pause.
Admission is distinct from user consent: a call's own marker must not cancel
its post-mark consent check.

A failed central settlement writes a service-wide reconciliation block. If that
safety write also fails, the committed dispatched row retains the durable pause;
the shared-control-handle process fuse is additional fail-stop protection, not
the durable or cross-process mechanism. Guarded local operator attestations bind
the exact call identity, current epoch and expected state; immutable proof and
cost commit together. They are operator-attested, not cryptographic provider
verification, and require all old workers terminated as an offline precondition.
No dispatched row is refunded or released by this workflow.

Managed paid processing is default-off. The approved follow-on path requires an
audited SQL/mirror activation profile, deployment opt-in, locally configured
worker provider, fresh matching readiness, account consent and exact send-time
financial guards. Ordinary restart can preserve an explicitly enabled profile;
supported restore disables it and rotates the epoch. The integration is locally
verified with synthetic transport; no local test implies live-provider quality
or a hosted release. See the [safeguards design](superpowers/specs/2026-10-16-managed-activation-design.md)
and [provider activation design](superpowers/specs/2026-10-16-managed-provider-activation-design.md).

### Managed subscription boundary (locally implemented, provider proof pending)

**Current provider decision, 2026-10-21:** Dodo Payments replaces Paddle after
the rejected application. Production startup uses the Dodo adapter and refuses
old Paddle configuration. Hosted checkout needs no browser SDK. Standard Webhooks
deliveries establish correlation; independent current Dodo subscription/payment
reads feed the existing sealed authority. Monthly and annual Dodo products map
to one logical authority plan family with separate price references. Both stores
remain isolated; recovery includes `dodo.sqlite` and preserves historical Paddle
backups. See [Dodo setup](DODO_PAYMENTS.md). The following Paddle paragraphs
describe the historical implementation, retained for audit and recovery context.

Paddle Billing is an optional managed-only adapter. Configuration is all-or-none and
environment-bound; local/self-hosted operation has no subscription dependency. The API owns
one expiring checkout intent per account and a separate `paddle.sqlite` coordination store.
The store records provider-create uncertainty before network I/O. Ambiguous failures
remain locked against duplicate checkout until the exact signed transaction event
recovers them; known created transactions are resumed rather than recreated.
The signed webhook retains only bounded identifiers, status, timestamps and a body digest;
raw provider payloads and customer PII are not persisted. Event leases are fenced and
recovered, exact replays are idempotent, changed-content event-id reuse places a known
binding into attention, and early completion events back off until the server transaction is
attached.

The worker treats events only as correlation or refresh signals. It reads the current
quantity-one subscription, completed transaction and adjustments through a fixed-origin,
fixed-operation, three-second/one-MiB transport, checks the configured price/product/cadence
and charged-currency allowlist, then submits facts to `BillingAuthority`. The Paddle store has
no authority tables and cannot create allowance. Knowledge, correction, export and deletion
remain available when billing is absent, stale, canceled or unavailable. Cold backups include
the coordination database and key commitment metadata, never the billing authority key.

## Observability

Structured metadata logs: request_id, job_id, project_id, status, duration, provider, usage, failure code.
No source bodies, full prompts, credentials, or generated sensitive content in default logs.
Expose liveness and readiness separately. The UI shows provider and worker availability without revealing secrets.
