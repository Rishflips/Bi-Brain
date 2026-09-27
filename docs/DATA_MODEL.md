# Data model and invariants

The JSON schema in contracts/brain.schema.json describes portable core objects. Persistence may use normalized tables, but must preserve these semantics.

## Core entities

| Entity | Key fields | Meaning |
|---|---|---|
| Owner | id, time_zone, preferences | Single local owner in V1 |
| Project | id, title, created_at | Explicit boundary for context and grants |
| Source version | id, project_id, version, title, body, observed_at, captured_at, visibility, state | Retained evidence |
| Claim | id, project_id, text, epistemic_status, evidence, validity interval | Supported statement, user assertion, or hypothesis |
| Page revision | page_id, version, content, evidence, author, supersedes | Readable derived understanding |
| Goal | id, project_id, title, success_criteria, status, preparation_enabled | User-authorized initiative |
| Decision | id, goal_id, statement, rationale, evidence, state | Choice and its assumptions |
| Commitment | id, responsible_party, due_at, state, evidence | Explicitly supported intended work |
| Brief | id, project_id, version, title, items, unknowns, source_versions | Reviewable context |
| Proposal | id, project_id, goal_id, title, reason, evidence, base_version, status | Suggested change awaiting review |
| Job | id, kind, project_id, payload_ref, lease, attempts, deadline, status | Durable execution |
| Receipt | id, job_id, outcome, changed_ids, evidence, usage, reason | Auditable result |
| Grant | id, principal_id, project_ids, operations, expires_at, revoked_at | Agent capability |
| Connector cursor | connector_id, scope, cursor, last_success_at | Incremental ingestion |
| Budget reservation | id, job_id, reserved_micro_usd, actual_micro_usd, status | Bounded provider spend |
| Feedback | proposal_id, action, optional_reason, created_at | Explicit utility signal |

## Evidence reference

Use source_id, source_version, start, end, and quote. Offsets are zero-based Unicode code-point offsets into the retained source body; end is exclusive. JavaScript implementations must not assume UTF-16 code-unit indices. The quote must equal the referenced substring.

The runtime may omit offsets in a user-authored citation, but model-generated factual claims require exact quote validation before publication. A correct quote is necessary, not sufficient: semantic support also requires evaluation.

## Identity and versioning

Production IDs are generated server-side. Fixture IDs are readable synthetic identifiers.
Store timestamps as UTC ISO-8601; retain the owner's IANA time zone for schedules.
All child rows belong to a project. Enforce project consistency in storage and domain methods.
Use integer versions incremented atomically. Source identity plus version is unique.

User correction creates a new version and a supersedes relationship. Model claims referring to old evidence become stale and must be rebuilt or explicitly retained as historical.

## Epistemic status

- Supported: evidence is present and validated.
- User assertion: attributed to the user, not independently verified.
- Hypothesis: an interpretation or possible connection, never silently promoted.
- Disputed: evidence conflicts; preserve both views and temporal context.

Temporal differences do not automatically imply contradiction. A policy may have changed between two dates. The resolver must inspect validity periods and keep unknown dates visible.

## Visibility

private: owner only; unavailable to agent grants.
project: eligible for principals with that project's grant.

A project grant never overrides private visibility. Derived output inherits the most restrictive visibility of its dependencies. Splitting a private detail into a public-looking summary does not remove the restriction.

## Data lifecycle

1. Explicit capture is stored as evidence.
2. Derived claims and pages link to evidence.
3. Context packages record dependency versions.
4. Corrections invalidate dependent caches and queue bounded updates.
5. Withdrawal removes active retrieval immediately and marks derivatives stale.
6. Permanent deletion purges source bodies, chunks, cached contexts, sensitive receipts, and derivatives that cannot remain supported.

For V1, invalidating and regenerating an entire affected brief is preferable to keeping partially unsafe text. Regeneration must use remaining permitted evidence.

Keep a tombstone with opaque ID and deletion timestamp where needed for synchronization; do not preserve deleted text in audit logs.
In-flight jobs must recheck dependency state before committing, so they cannot recreate deleted content.

## Export and restore

Portable export: source versions, accepted knowledge, current goals, decisions, proposals selected by the owner, and a manifest containing format version and checksums.
Never export tokens, provider keys, owner sessions, or connector credentials.
Export IDs remain stable; import deduplicates by identity and content hash, detects conflicts, and offers a preview before applying.
Full operational backup is separate and includes database state and any blob directory. Document that it is sensitive.

## Storage constraints to test

Reject cross-project evidence, non-existent source versions, unsupported enum values, invalid offset ranges, dangling grants, and non-monotonic revision writes. Prevent duplicate application of one job result. Apply deletion and search-index changes transactionally or make the index fail closed until refreshed.
