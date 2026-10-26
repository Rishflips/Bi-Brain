# HTTP API contract

**Harness transition:** Owner GUI source capture remains at `/api/v1/sources`; direct agent capture is denied. Agents use `/api/v1/agent/propose` through the shared gate. Scoped `/api/v1/agent/recall` returns ranked, cited hits (current facts first, originals next; `history=true` adds replaced and retired facts) and `/api/v1/agent/open` reads one hit by id, optionally comparing two versions. Capability-filtered MCP names and their HTTP backing routes are documented in [AGENT_INTEGRATION.md](AGENT_INTEGRATION.md). Earlier endpoint descriptions below are retained for the local preview and may describe pre-harness behavior; the new harness has not cleared S4 release verification.

Prefix: /api/v1. JSON request and response bodies except exports/import uploads and the
raw signed Paddle webhook. Validate with runtime schemas. This is the normative contract;
verified implementation status is recorded in `BUILD_STATE.md`.

## Common rules

- Authenticate the principal; derive owner and granted projects server-side.
- Use Idempotency-Key on capture, generation, acceptance, and retryable mutations.
- Scope idempotency records by principal, operation, and project; reject key reuse with a different body using 409.
- Use expected_version on edits, proposal acceptance, and undo.
- Return request_id in errors and receipts.
- Limit page size to 50 by default and 100 maximum; use opaque cursors.
- Explicit text capture: up to 100,000 Unicode code points and 1 MiB decoded UTF-8, both enforced. Reject larger inputs with 413 and no partial success.
- No raw remote URL fetching in V1.
- Distinguish capture succeeded from derivation succeeded.

Error shape:

```json
{
  "error": {
    "code": "VERSION_CONFLICT",
    "message": "This plan changed since you opened it.",
    "request_id": "request_example",
    "retryable": false
  }
}
```

Codes include: INVALID_INPUT, NOT_FOUND, UNAUTHORIZED, FORBIDDEN, CONFLICT,
VERSION_CONFLICT, IDEMPOTENCY_CONFLICT, BUDGET_EXHAUSTED, UNAVAILABLE,
PROVIDER_UNAVAILABLE, SOURCE_STALE, SOURCE_WITHDRAWN, JOB_CANCELLED, RATE_LIMITED.

Use 404 for inaccessible resource IDs where revealing existence would leak information. Never echo hidden resource titles in errors.

## Routes

| Method/path                       | Input                                         | Result and behavior                                                                                                                         |
| --------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| GET /health/live                  | None                                          | Process liveness; no private data                                                                                                           |
| GET /health/ready                 | Owner session                                 | Storage, worker heartbeat, provider readiness                                                                                               |
| POST /session/pair                | Installation secret                           | HttpOnly owner session; rate-limited                                                                                                        |
| DELETE /session                   | Owner session                                 | Revoke current session                                                                                                                      |
| GET /projects                     | Cursor                                        | Visible projects                                                                                                                            |
| POST /projects                    | title                                         | New owner project                                                                                                                           |
| POST /sources                     | project_id, title, body, visibility           | 201 source plus queued derivation job                                                                                                       |
| GET /sources/:id                  | version optional                              | Authorized retained original                                                                                                                |
| POST /sources/:id/versions        | body, expected_version                        | New source version; invalidate dependencies                                                                                                 |
| POST /sources/:id/withdraw        | expected_version                              | Hide immediately; invalidate derivatives                                                                                                    |
| DELETE /sources/:id               | expected_version, confirmation                | 202 purge job with immediate retrieval exclusion                                                                                            |
| GET /search                       | q, project_id, cursor                         | Authorized snippets, source refs, freshness                                                                                                 |
| GET /pages/:id                    | version optional                              | Derived page and provenance                                                                                                                 |
| PATCH /pages/:id                  | content, expected_version                     | User revision                                                                                                                               |
| POST /briefs                      | project_id, goal_id optional                  | 202 preparation job                                                                                                                         |
| GET /briefs/:id                   | None                                          | Brief or stale/withdrawn status                                                                                                             |
| PATCH /briefs/:id                 | items, unknowns, expected_version             | User-reviewed brief revision                                                                                                                |
| POST /goals                       | project_id, title, success_criteria           | Goal starts with preparation disabled                                                                                                       |
| PATCH /goals/:id                  | status, preparation_enabled, expected_version | Change explicit initiative scope                                                                                                            |
| GET /today                        | Owner time zone derived                       | Ranked ready items and continuation                                                                                                         |
| GET /proposals/:id                | None                                          | Proposal, evidence, prior state                                                                                                             |
| POST /proposals/:id/accept        | expected_version, edited_artifact optional    | Applied revision and receipt                                                                                                                |
| POST /proposals/:id/dismiss       | reason optional                               | Dismiss and record feedback                                                                                                                 |
| POST /proposals/:id/snooze        | until                                         | Snooze until an explicit future timestamp                                                                                                   |
| POST /receipts/:id/undo           | expected_version                              | Compensating revision or 409                                                                                                                |
| GET /jobs/:id                     | None                                          | Authorized status, retryability, result refs                                                                                                |
| POST /jobs/:id/cancel             | None                                          | Cancellation intent; late output fenced                                                                                                     |
| POST /jobs/:id/retry              | None                                          | New bounded attempt if permitted                                                                                                            |
| GET/PATCH /preferences/background | Time zone, digest, cap, enabled               | Validated owner preferences                                                                                                                 |
| GET /connections                  | None                                          | Redacted status and grants                                                                                                                  |
| POST /agent-grants                | projects, operations, expires_at              | Token shown once; stored as hash                                                                                                            |
| DELETE /agent-grants/:id          | None                                          | Immediate revocation and cache invalidation                                                                                                 |
| POST /exports                     | scope, format                                 | Authorized export job                                                                                                                       |
| POST /imports/preview             | File                                          | Validated manifest and conflicts                                                                                                            |
| POST /imports/:id/apply           | selected changes, preview_version             | Apply reviewed import                                                                                                                       |
| GET /billing/status               | None                                          | Owner-only managed subscription state plus a resumable public transaction id only when known; unavailable in local/self-hosted mode or when not configured |
| POST /billing/checkout-intent     | cadence (`monthly` or `annual`)               | Owner + CSRF; creates one account-bound server intent and a configured Paddle transaction; never grants allowance                           |
| POST /billing/portal-session      | `{}`                                          | Owner + CSRF; returns one validated short-lived customer portal URL for an existing binding                                                 |
| POST /billing/webhook             | Exact raw JSON bytes + `Paddle-Signature`     | Only session/CSRF exception; strict byte/signature bounds, PII-free durable projection, replay-safe acknowledgement; never grants allowance |

All route mutations must be available through domain services, not raw SQL in handlers.
Billing routes are never exposed through agent grants or MCP. A checkout return query is a
UI refresh hint only; current provider evidence and the sealed financial authority remain
the sole path to a paid-processing allowance.
An ambiguous provider create is durably locked before network I/O. Status reports
attention without exposing a guessed transaction; it never authorizes an automatic
second checkout. A known created transaction may be resumed through Paddle.js.

## Asynchronous job response

```json
{
  "source_id": "source_example",
  "job": {
    "id": "job_example",
    "status": "queued",
    "poll_url": "/api/v1/jobs/job_example"
  }
}
```

The frontend may poll with bounded exponential backoff. Pause polling when hidden; refresh on focus. SSE is optional and must not be necessary for correctness.

## Caching

Cache keys include principal/grant version, project, object versions, and provider configuration. Recheck access on each response. Revocation and deletion override TTL. Do not cache secrets or sensitive error content.

# Harness transition endpoints

An owner can `POST /api/v1/sources/:id/claim-proposals` with `{expected_version,entity,field:{aspect:"status",value},quote}` to queue a claim against an exact passage in the current source version. The owner then accepts or rejects it through the existing gate review endpoint. Agent `brain_intent` requests retain typed propose/update/close action, target ID and expected version, with optional success criteria and due/review times; owner approval applies the versioned goal transition.

The owner may call `POST /api/v1/import-adapters/preview` with `{kind:"folder"|"chat",project_id,entries:[{path,content}]}` and then `POST /api/v1/import-adapters/apply` with `{selection,checkpoint}`. The checkpoint is the preview SHA-256; a changed selection is rejected. The deletion response includes `proof` when a vault is configured; `GET /api/v1/forget-proofs/:id` retrieves the persisted owner-only result. Every false proof bit means managed deletion is incomplete. Embedding/graph `configured:false` means no such active store was found, not that an external service was inspected.

`GET /api/v1/identity-disclosure?project_id=...` lists accepted identity fields and the owner's selected claim IDs. The owner can `PATCH /api/v1/identity-disclosure` with `{project_id,selected:[claim_id]}`. All identity fields start private. A policy change invalidates earlier packs and current handoffs; agents cannot read the underlying private original even when the selected field is shared.

After an interrupted permanent deletion, the owner may call `POST /api/v1/sources/:id/finalize-forget`. It accepts only a tombstoned source, repeats managed history/backup sanitation, and returns a new proof. `FORGET_INCOMPLETE` means active retrieval was stopped but erasure has not been proven; clients must not display success.

`POST /api/v1/receipts/:id/git-revert` is an owner-only conservative vault revert for the most recent accepted plan commit. It checks the goal version, exact Git HEAD and current deletion tombstones, runs `git revert` with conflict abort, rebuilds the projection and writes an audit receipt. Later edits cause a version conflict and stay untouched; the normal review UI offers a compensating undo with a comparison instead. This endpoint does not yet support automatically resolving non-head historical changes.
