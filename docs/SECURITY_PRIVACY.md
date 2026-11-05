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
| Provider redirect/SSRF         | Backend adapter exposes fixed Dodo operations and origins only; redirects fail; portal and checkout URLs are validated against configured origins/paths         |
| Billing data leakage           | Persist only opaque provider IDs and normalized status; no raw webhook, email, card data, portal bearer URL, API key or webhook secret in exports/logs/frontend |
| Stale or refunded entitlement  | Fresh current-provider reads plus sealed authority checks; adverse events trigger recheck; paid failures never block knowledge access/export/deletion           |
| Agent-written content presented as the owner's | Agent-written originals carry `written_by` in recall, open and context results, are counted in the first-prompt digest, and are labelled in Your brain. Until the owner reviews that note (one per-note action; keeping a derived card is not one), they never appear in a `full` push, a pointer name or the digest's recent list, never raise a push above `pointer`, and are kept out of the Recall help judge. A restored export starts with every such note unreviewed again |
| Pre-authentication request floods | One limiter bucket per client address, never per unverified cookie or bearer. Behind the configured TLS proxy (only when `BRAIN_PUBLIC_ORIGIN` is set) exactly one hop is trusted for the client address; local mode is unchanged |
| API opened as a page           | Top-level navigations to `/api/v1/` are refused, except `health/live` and `health/ready`. Frame and content-security headers are sent in every mode             |
| Disguised request paths        | Paths with a malformed percent-escape, or an escape of an unreserved character or `/`, are refused, so the access checks and the router read the same path      |
| Oversized or unbounded retry keys | The Idempotency-Key is length-bounded on every route that takes one                                                                                             |
| Development origins in production | The Vite development origins are allowed only when `NODE_ENV` is not `production`                                                                               |
| Secrets inherited by the agent adapter | `bibrain connect` starts the adapter with an allow-listed environment only. Provider, billing, sign-in and owner secrets never reach it                         |
| Remote MCP endpoint (`POST /api/v1/agent/mcp`) | Agent keys only (a browser session is refused with 403), POST only, JSON only, one message per request, 256 KiB bodies, 120 requests a minute per client address (this limit replaces the global one on this route). It sits behind the same Host, Origin, path and navigation checks as every route, and each tool call goes through the same HTTP routes with the caller's key and address, so grants and logs are the routes' own. No sessions, no streams, no OAuth |
| Agent adapters (hooks, `bibrain recall` / `bibrain note`, the Hermes plugin) | One contract, `bibrain-agent/1`, one authorization. Each adapter sends at most 500 code points of prompt and only marker lines of a reply, drops secret-looking text, keeps hashes only, follows no redirects, calls HTTPS or loopback only, ends quietly inside its time budget, and never blocks a turn. The commands call loopback only; a remote harness uses HTTPS |

For `continue`-style prompts the server keeps a session topic: the lowercase content words of the last agent prompt that found something, keyed by connection and session hash, at most 12 words and 20 entries, dropped after two hours. These are words from an agent's prompt, kept for two hours whether or not Better search or any calibration is on; a word that looks like a key is never stored because such prompts are dropped before any search. It never holds the prompt, an id or a passage, is never logged or shown, and is deleted with the brain. The Better search probe contacts only Ollama on this computer, at start and every 10 minutes while nothing was found, and keeps nothing from its reply.

## Local assumptions

Single OS owner. A compromised local user account can access local data; do not claim encryption against that attacker.
App database does not automatically imply encryption at rest. Document the actual storage protection implemented.
Remote access is disabled by default. HTTPS reverse proxy configuration is required for supported remote self-hosting.
Self-host and managed deployments must sit behind exactly one trusted proxy, such as the shipped Caddy. The app trusts that one hop for the client address; with trust on, the request host and protocol follow the forwarded headers (the Host and Origin checks read the raw headers and do not).
On Windows, file modes are not enforced by the filesystem; keep `data/` under your own user profile on a shared machine.

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
