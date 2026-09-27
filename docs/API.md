# HTTP API contract

Prefix: /api/v1. JSON request and response bodies except exports/import uploads. Validate with runtime schemas. This is a build contract, not an implemented endpoint catalog.

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

~~~json
{
  "error": {
    "code": "VERSION_CONFLICT",
    "message": "This plan changed since you opened it.",
    "request_id": "request_example",
    "retryable": false
  }
}
~~~

Codes: INVALID_INPUT, NOT_FOUND, UNAUTHORIZED, FORBIDDEN, VERSION_CONFLICT, IDEMPOTENCY_CONFLICT, BUDGET_EXHAUSTED, PROVIDER_UNAVAILABLE, SOURCE_STALE, SOURCE_WITHDRAWN, JOB_CANCELLED, RATE_LIMITED.

Use 404 for inaccessible resource IDs where revealing existence would leak information. Never echo hidden resource titles in errors.

## Routes

| Method/path | Input | Result and behavior |
|---|---|---|
| GET /health/live | None | Process liveness; no private data |
| GET /health/ready | Owner session | Storage, worker heartbeat, provider readiness |
| POST /session/pair | Installation secret | HttpOnly owner session; rate-limited |
| DELETE /session | Owner session | Revoke current session |
| GET /projects | Cursor | Visible projects |
| POST /projects | title | New owner project |
| POST /sources | project_id, title, body, visibility | 201 source plus queued derivation job |
| GET /sources/:id | version optional | Authorized retained original |
| POST /sources/:id/versions | body, expected_version | New source version; invalidate dependencies |
| POST /sources/:id/withdraw | expected_version | Hide immediately; invalidate derivatives |
| DELETE /sources/:id | expected_version, confirmation | 202 purge job with immediate retrieval exclusion |
| GET /search | q, project_id, cursor | Authorized snippets, source refs, freshness |
| GET /pages/:id | version optional | Derived page and provenance |
| PATCH /pages/:id | content, expected_version | User revision |
| POST /briefs | project_id, goal_id optional | 202 preparation job |
| GET /briefs/:id | None | Brief or stale/withdrawn status |
| PATCH /briefs/:id | items, unknowns, expected_version | User-reviewed brief revision |
| POST /goals | project_id, title, success_criteria | Goal starts with preparation disabled |
| PATCH /goals/:id | status, preparation_enabled, expected_version | Change explicit initiative scope |
| GET /today | Owner time zone derived | Ranked ready items and continuation |
| GET /proposals/:id | None | Proposal, evidence, prior state |
| POST /proposals/:id/accept | expected_version, edited_artifact optional | Applied revision and receipt |
| POST /proposals/:id/dismiss | reason optional | Dismiss and record feedback |
| POST /proposals/:id/snooze | until | Snooze until an explicit future timestamp |
| POST /receipts/:id/undo | expected_version | Compensating revision or 409 |
| GET /jobs/:id | None | Authorized status, retryability, result refs |
| POST /jobs/:id/cancel | None | Cancellation intent; late output fenced |
| POST /jobs/:id/retry | None | New bounded attempt if permitted |
| GET/PATCH /preferences/background | Time zone, digest, cap, enabled | Validated owner preferences |
| GET /connections | None | Redacted status and grants |
| POST /agent-grants | projects, operations, expires_at | Token shown once; stored as hash |
| DELETE /agent-grants/:id | None | Immediate revocation and cache invalidation |
| POST /exports | scope, format | Authorized export job |
| POST /imports/preview | File | Validated manifest and conflicts |
| POST /imports/:id/apply | selected changes, preview_version | Apply reviewed import |

All route mutations must be available through domain services, not raw SQL in handlers.

## Asynchronous job response

~~~json
{
  "source_id": "source_example",
  "job": {
    "id": "job_example",
    "status": "queued",
    "poll_url": "/api/v1/jobs/job_example"
  }
}
~~~

The frontend may poll with bounded exponential backoff. Pause polling when hidden; refresh on focus. SSE is optional and must not be necessary for correctness.

## Caching

Cache keys include principal/grant version, project, object versions, and provider configuration. Recheck access on each response. Revocation and deletion override TTL. Do not cache secrets or sensitive error content.
