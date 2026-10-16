# Background work, System 1, and System 2

## Pipeline

Captured event → deterministic validation/deduplication → scoped relevance assessment → budget admission → durable job → bounded reasoning → output validation → proposal/maintenance revision → receipt.

A schedule is a trigger, not a reason to reread the whole corpus. Process changed sources and affected goals. No recursive self-generated event loop: provenance identifies generated changes, and a maximum causal depth prevents amplification.

## Triage

Rules handle exact duplicates, unsupported input, scope, explicit time conditions, and budget.
The permanent System 1 capability handles narrowly defined questions where a model is justified: candidate type, likely relevance to an existing goal, or need for deeper review. Its provider is replaceable; its judgments remain constrained and separately evaluated. Provider-disabled operation is an explicitly degraded mode, not a claim that deterministic rules ran a decision model.
Uncertain classifications remain queued or abstain. Explicitly saved material is never silently dropped.

Classifier output is not proof of contradiction. System 2 reviews the actual sources and temporal context. Provider confidence is not an authorization decision.

## Initial job kinds

derive_brief, refresh_project, review_changed_assumption, prepare_digest, purge_source, export_project.

Draft creation is bound to a selected active goal. Maintenance can refresh known derived pages, but changes to decisions and commitments require review.

## Job state machine

queued → running → succeeded
running → retry_wait → queued
queued/running/retry_wait → cancelled
running → failed

Use persisted next_attempt_at, attempt_count, max_attempts, lease_owner, lease_expires_at, and fencing_token.
Atomic lease acquisition; heartbeat while running; expired lease may be reclaimed. Every commit checks the current fencing token.
Retries use exponential backoff with jitter, honor provider retry hints, and have an overall deadline.
Validation and permission failures are not blindly retried.

Output writes use unique job+output keys. A worker crash after a provider response may cause another paid call on retry; do not claim exactly-once external execution. Use provider idempotency where supported, retain safe response checkpoints, and budget conservatively.

## Proposed starting limits

- One local worker; one concurrent model call.
- At most three attempts per job.
- Maximum two model calls per preparation job, including one repair attempt.
- Maximum 20 changed sources per batch; carry remainder forward.
- Context limit explicit per adapter; default continuation brief 3,000 tokens.
- One non-urgent daily digest by local date; quiet hours applied.
- Background provider spend disabled until configured by the owner.

These limits are initial settings, not permanent product promises.

## Budget accounting

Use integer micro-USD. Before dispatch, calculate a conservative upper bound from input estimate, maximum output tokens, provider price version, and retry allowance.
Reserve atomically against per-job and daily caps. Reject admission when the remaining budget is insufficient.
Reconcile actual usage after the call; release unused reservation. Retain an unresolved reservation after ambiguous failure until reconciled or conservatively charged.
If pricing or usage is unknown, prevent automatic paid execution rather than guessing.
Concurrent jobs must not each spend the same remaining budget.

User-visible spend distinguishes estimated, reserved, and actual amounts. A Codex subscription is not assumed to pay for Bi Brain's independent runtime calls.

Current local implementation uses one immutable, one-shot reasoning dispatch per job, not a decision/repair chain. It commits the dispatch marker before I/O, settles known cost even if output is rejected or cancelled, and never resends a marked/settled slot on retry or restart. Unknown holds survive day changes and are counted alongside legacy reservations. There is no automatic hold expiry or invented reconciliation. Goal/source versions, consent, authorization and lease fences are rechecked before dispatch/publication; a later human plan cannot inherit an older model proposal. Durable overrun and recovery blocks cannot be cleared through ordinary preferences, while labeled extractive work stays available. Managed account/service allowances remain a separate, unimplemented gate.

## Schedule and notifications

Use IANA time zones. Persist next eligible run and last successful digest local date.
When a host wakes after missed schedules, perform one bounded catch-up, not every missed run.
Background work requires the host/worker to be running.

Only create a notification candidate when there is a material new result for an explicit goal. Deduplicate by goal and evidence signature; dismissed suggestions need new evidence before resurfacing.
V1 delivery is the in-app Today view and an optional in-app daily digest. Email, SMS, push, and connected-service sending are deferred.

## Proposal lifecycle

ready → accepted / dismissed / snoozed / invalidated
snoozed → ready when due and still supported
accepted → reverted through a compensating revision

Before acceptance, revalidate evidence, access, and base version. A source deletion invalidates dependent suggestions immediately.

## Receipt requirements

Record job kind, trigger, evidence IDs/versions, result, changed object IDs, model/provider version where applicable, prompt version, spend, timestamps, and reason for no-change/failure.
Do not store hidden chain-of-thought. Store concise user-facing rationale and evidence.
No-change, abstention, budget exhaustion, and failed validation are legitimate outcomes.
