# Security and privacy boundaries

## Assets

Original personal sources, generated understanding, goals, model credentials, agent grants, connector credentials, exports, backups, and execution history.

## Trust boundaries

Browser sessions, agent clients, imported content, model responses, provider networks, local filesystem, and future remote tenants are separate boundaries.

## Required controls

| Threat                         | Required behavior                                                                                                                                               |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Imported prompt injection      | Source text remains data; it cannot grant tools or override policy                                                                                              |
| Cross-project recall           | Filter before retrieval and at response assembly; scope evidence and caches                                                                                     |
| Revoked access                 | Recheck grants on every operation and before job result delivery                                                                                                |
| Private-derived leakage        | Derived visibility is at least as restrictive as all dependencies                                                                                               |
| Deleted material returns       | Tombstone, invalidate caches, fence in-flight jobs, purge derivatives                                                                                           |
| Duplicate execution            | Idempotency plus fenced commits; explicitly acknowledge external-call ambiguity                                                                                 |
| Unbounded model spend          | Atomic reservations, bounded outputs/calls, cancellation, hard caps                                                                                             |
| Malicious file/import          | Size/type limits, traversal protection, no arbitrary archive extraction                                                                                         |
| Cross-origin local API access  | Loopback bind, Host/Origin validation, session auth, CSRF protection                                                                                            |
| Credential leakage             | Backend-only secrets, redacted logs, hashed agent tokens                                                                                                        |
| Unsafe rendered content        | Sanitize Markdown/HTML; no script execution or dangerous URL schemes                                                                                            |
| Forged/replayed payment signal | Verify exact raw bytes and bounded timestamp/HMAC; deduplicate by environment + endpoint + event; webhook and return URL never grant allowance                  |
| Provider redirect/SSRF         | Backend adapter exposes fixed Dodo operations and origins only; redirects fail; portal and checkout URLs are validated against configured origins/paths       |
| Billing data leakage           | Persist only opaque provider IDs and normalized status; no raw webhook, email, card data, portal bearer URL, API key or webhook secret in exports/logs/frontend |
| Stale or refunded entitlement  | Fresh current-provider reads plus sealed authority checks; adverse events trigger recheck; paid failures never block knowledge access/export/deletion           |

## Local assumptions

Single OS owner. A compromised local user account can access local data; do not claim encryption against that attacker.
App database does not automatically imply encryption at rest. Document the actual storage protection implemented.
Remote access is disabled by default. HTTPS reverse proxy configuration is required for supported remote self-hosting.

## Data sent to providers

Show which configured provider receives selected content before first live use. Only send the evidence needed for the job.
Allow provider-disabled operation. Do not silently fallback to a different external provider.

## Deletion and retention

Withdrawal: immediate exclusion from retrieval and initiative.
Permanent deletion: purge retained bodies, chunks, caches, unsupported derived content, and sensitive receipts.
Deletion UI explains its effect on derived briefs and restored backups.
Backups have explicit retention and are sensitive. Restoring a backup must apply later deletion tombstones when available; never claim deletion from inaccessible external copies.
Do not use append-only audit history as an excuse to retain all deleted personal content.
Portable brain exports intentionally exclude merchant billing records. A managed operator
backup may retain legally or operationally required opaque billing history; the product must
not describe a knowledge export as a complete merchant-data or statutory-erasure export.

## Logs and telemetry

Content-free operational telemetry by default. Any optional product analytics must be opt-in for local V1.
No raw note text, emails, project titles, exact source quotes, credentials, or full prompts in external analytics.
Record request and job IDs for diagnosis. Debug content logging is an explicit advanced option with retention and redaction.

## Before any hosted release

Authenticated identity and recovery, tenant-aware storage/policy, cross-tenant adversarial tests, quotas, secrets management, rate limits, backup restore drills, deletion workflows, data-processing disclosures, abuse controls, and operational alerting.
Local single-owner tests do not establish tenant safety.

## Public release hygiene

Dependency review, secret scanning, documented support/security contact, licensing decision, and supported runtime versions. No arbitrary third-party plugin execution until an isolation model is implemented.
