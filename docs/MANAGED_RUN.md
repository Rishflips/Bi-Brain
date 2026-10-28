# Running the managed runtime (operator notes)

Managed mode serves an isolated personal brain per signed-in account from a
standards-based OIDC login. It is **not a public release**. One central
account/service spending authority is implemented and locally verified. The
default-off activation path is locally verified with synthetic provider transport;
no real owner account or live provider has been activated. Live-provider quality,
target-host recovery, TLS and real Dodo test-mode/live acceptance remain separate gates. Do not advertise or open the
managed service to the public. Local self-hosting is unchanged and remains the
supported path.

## Configuration

Managed startup is explicit and fails closed. `BRAIN_MODE=managed` requires
every value below; a missing or malformed field stops the process **before** any
runtime, tenant store or local database is created.

| Variable                   | Required                                | Notes                                                                                                                                      |
| -------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `BRAIN_MODE`               | managed mode                            | `local` (default) or `managed`.                                                                                                            |
| `BRAIN_MANAGED_ROOT`       | yes                                     | One absolute directory outside the repo for managed data only.                                                                             |
| `BRAIN_PUBLIC_ORIGIN`      | yes                                     | The exact HTTPS origin served, one bare origin, no path.                                                                                   |
| `BRAIN_OIDC_ISSUER`        | yes                                     | HTTPS issuer identifier, no credentials, query or fragment.                                                                                |
| `BRAIN_OIDC_CLIENT_ID`     | yes                                     | Registered client id.                                                                                                                      |
| `BRAIN_OIDC_CLIENT_SECRET` | yes                                     | Server-side only. Never printed, logged or bundled.                                                                                        |
| `BRAIN_OIDC_CALLBACK_PATH` | no                                      | Fixed absolute path; defaults to `/auth/callback`.                                                                                         |
| `BRAIN_MANAGED_ALLOW_PAID` | no                                      | Default off. `1` is a deployment opt-in, never sufficient by itself.                                                                       |
| `OPENAI_API_KEY`           | worker only, when separately authorized | Loaded once at worker startup; never needed by the server or written to a profile/readiness file. Rotation requires restarting the worker. |

Managed subscriptions are optional and all-or-none. With every `BRAIN_DODO_*`
field absent, billing reports a plain unavailable state and the rest of BiBrain is
unchanged. A partial set stops startup. The variables, the checkout flow and the
remaining acceptance gates are in [DODO_PAYMENTS.md](DODO_PAYMENTS.md).

## Managed subscription boundary (default off)

The Dodo adapter is the only billing integration. Its checkout, webhook,
reconciliation and portal behaviour, the proof it still needs, and what the
browser never receives are documented in [DODO_PAYMENTS.md](DODO_PAYMENTS.md).
Cancellation or billing failure never blocks sign-in, capture, correction,
search, agent revocation, export, or deletion. The Paddle adapter this section
used to describe was removed in plan 6 (2026-10-28); its design is kept in
[PADDLE_BILLING_DESIGN_2026-10-17.md](history/PADDLE_BILLING_DESIGN_2026-10-17.md).

The server and worker read the same validated configuration. No secret is
printed at startup; only the mode, origin and issuer are reported.

## Start

```
npm run server   # HTTP, routes, sign-in
npm run worker   # per-tenant background preparation
```

The server builds `ManagedRuntime` → `OidcClient` → `ManagedLogin`, then serves
the app. The worker builds `ManagedRuntime` → `ManagedWorker`. Both use the
control database beside `BRAIN_MANAGED_ROOT`.

## Sign-in flow (server)

- `GET /auth/login` starts a login with PKCE S256, state and nonce, stores the
  short-lived transaction in the control database, sets a five-minute
  `brain_login` cookie (Secure, HttpOnly, SameSite=Lax, `Path=/auth/callback`)
  and redirects to the provider. No token or CSRF value appears in any URL.
- `GET /auth/callback` consumes the correlation, exchanges the code, then
  provisions the tenant, issues an opaque session and sets `brain_session`
  (Secure, HttpOnly, SameSite=Strict, `Path=/`, lifetime from the session
  expiry) before redirecting to the fixed `/`. There is no arbitrary return URL.
  The callback URL is rebuilt from `BRAIN_PUBLIC_ORIGIN` and the raw request URL;
  forwarded host/origin headers are ignored.
- The correlation cookie is cleared on every callback outcome. A replay,
  tampered state, expired attempt or foreign origin receives a static, safe page
  with no provider body, code or secret.
- `GET /api/v1/runtime` is public metadata: `mode`, `sign_in_url`,
  `sign_in_available`, `pairing_available`. It carries no identity or secrets,
  and an unconfigured managed server reports sign-in as unavailable rather than
  showing a button that cannot work.

Both sign-in endpoints are rate limited to ten requests per minute, well below
the general poll limit.

## Provider and spending gate

Managed accounts run **extractive preparation by default**. One central
control-plane ledger governs managed money (account allowance windows, a single
global service cap, cumulative job and frozen user-day limits), and the
per-tenant ledger is a conservative journal/projection. Paid work requires all
independent gates:

- An enabled, audited SQL profile and its exact `activation.json` mirror, the
  deployment opt-in, a matching root epoch/schema and configured account limits.
- A worker with the frozen profile and locally valid provider configuration
  installed. Its independent 5-second heartbeat publishes a 15-second readiness
  lease. The server needs no provider key; missing/stale/mismatched readiness
  reports capability unavailable. A production send also checks its own lease.
- Explicit stored account consent and fresh monetary admission. Capability is
  separate from temporary `usage_pending`; a call never revokes its own consent.
  Unknown marked usage pauses new paid sends across every account without losing
  capture, search or extractive work. No marked call is resent or refunded.
- Without capability, an explicit consent-on request returns HTTP 503. Stored
  true consent remains withdrawable by an active authorized account. Omitting
  consent from an unrelated settings save preserves its raw stored value.
  Durable monetary blocks still deny re-enable and are never cleared by consent.
- When paid work is not requested, the worker runs extractive directly. A paid
  intent without an available path gets a truthful unavailable receipt, not a
  fabricated connected result or an unlabelled extractive success.
- A failed central safety-marker write pauses managed paid scheduling for the
  process (an in-memory fuse, not a durable or multi-process guarantee) while
  capture stays available.

Do not load a real provider key or activate owner accounts without separate
authorization and the live-provider/operational gates. Synthetic fixtures use a
dummy key and an intercepted transport, not a live connection or quality proof.
An environment flag alone never activates paid processing.

## Data and isolation

`BRAIN_MANAGED_ROOT` holds `control.sqlite` plus one server-created UUID
directory per account. Each account has its own SQLite database, Git vault and
protected quarantine; provisioning is idempotent and keyed by `(issuer,
subject)`, never by email. A managed request resolves its tenant only from the
control store (opaque session or hash-indexed agent token); tenant headers,
query parameters and payload claims are ignored. The local single-owner database
is never read or adopted.

## Shutdown

- Server: `SIGINT`/`SIGTERM` closes the Fastify app (which closes the local
  database only when the app created it) and then the managed runtime.
- Worker: `SIGINT`/`SIGTERM` stops starting new work, awaits the in-flight job
  via `ManagedWorker.stop()`, then closes the runtime.

## Remaining gates

Not implemented or verified as a release: public hosting, real Dodo test-mode/live
payments, live entitlements, live paid-model dispatch, TLS and graceful signal
handling on the target host. The default-off billing boundary and sealed
entitlement path are locally implemented and synthetically verified; that is not
a provider acceptance result.
Central account/service spending control, restore barriers and the own-account
money view and default-off activation path are locally verified; this is not a
live-provider or production-host claim. Managed login has HTTP integration and Chromium
journey coverage against a signed disposable synthetic issuer, including two
accounts, logout/relogin and account-switch privacy regressions. The browser
fixture replaces redirect chains with documented hop pages; it is not native
redirect-chain or TLS proof. Real entry-point tests cover loopback HTTP capture,
separate-worker extractive output and forced-restart persistence. A live provider
login and production-host verification remain separate gates.

## Managed spending policy and activation (Task 3 slice)

The operator writes managed allowance/service/account policy only with the
trusted CLI, never from the browser. It runs on the server filesystem against one
explicit existing absolute root (`BRAIN_MANAGED_ROOT`); it validates every
argument, never creates an account and never contacts a model:

- `npm run managed:policy -- set-service <daily_micro_usd>`
- `npm run managed:policy -- configure-period <account_id> <start ISO Z> <end ISO Z> <allowance_micro_usd>`
- `npm run managed:policy -- set-account <account_id> <per_job_micro_usd> <user_daily_micro_usd>`
- `npm run managed:policy -- revoke-period <period_id>`

Amounts are nonnegative integer micro-USD. Defaults are zero, so an unconfigured
account is denied rather than given a free allowance.

The authenticated owner sees their **own** central money view: known settled
actual for their current accounting day, every unresolved hold across all days,
their own allowance window and their own user-day remaining. It never reads the
stale tenant projection and never exposes the shared-service cap or any service
total or another account's data.

Managed paid processing remains **OFF by default**. A positive monetary policy
marks an account "configured", not activated. Public
`connected_processing_available` means the current operator profile and a fresh
matching worker lease permit connected processing; it is not a provider-health,
quality or affordability guarantee. Authenticated status separately reports
stored/effective consent, capability, pause reason and own-account spending.

### Phase 2 profile foundation (runtime integration in progress)

The approved activation implementation adds an operator-only profile CLI:

- `npm run managed:activation -- status`
- `npm run managed:activation -- show`
- `npm run managed:activation -- enable <absolute_profile_json> --offline --workers-terminated`
- `npm run managed:activation -- disable --expected-version <n>`

All commands require one explicit existing `BRAIN_MANAGED_ROOT`. Status/show are
read-only; they never initialize money tables or create activation. Enable
requires an existing current-schema terminal history audit (schema 3 for the
merged Phase 2 release; schema 4 in the decision-profile continuation), explicit offline
acknowledgements and a version CAS (`expected_version: 0` creates the first
profile). The JSON contains only the operator's exact provider/model/versioned
integer prices, accepted returned models, output bound, fixed
`endpoint_class: "openai_responses"`, audit id and expected version. Credentials,
arbitrary URLs and browser-supplied activation are not accepted. No command makes
a provider request. The acknowledgements are preconditions, not proof that
workers are stopped.

The control-database profile commits before its complete `activation.json`
mirror. These writes are **not atomic together**: a missing, invalid or mismatched
mirror denies use. Never repair authority by hand-editing either representation.
Disable needs no offline acknowledgement and cannot erase a marked charge or
hold. Supported cold restore disables an enabled profile at a new version/epoch
and excludes ephemeral worker readiness; re-enrollment requires a fresh audit.
A raw database-plus-marker rollback is undetectable and unsupported.

**This is not a live production activation:** main entry points now share the
default-off policy and guarded provider path. Real-process synthetic dispatch,
long-call heartbeat, CLI disable, unknown-usage worker restart/no-resend and
consent browser checks passed; full evidence is recorded in BUILD_STATE.md.
Nothing here authorizes enabling an owner's
account, loading a real provider key or making a paid smoke call.

### Decision-profile continuation — default-off S1 foundation

The approved S1 continuation adds a **separate, default-off** decision profile in
schema 4, not a working decision dispatcher. Its operator commands are:

- `npm run managed:decision-activation -- status` (or `show`)
- `npm run managed:decision-activation -- enable <absolute_profile_json> --offline --workers-terminated`
- `npm run managed:decision-activation -- disable --expected-version <n>`

These commands make no provider request. Enrollment requires a fresh terminal
schema-4 history audit and closed operator configuration: the official TypeSafe
or Cloudflare endpoint, concrete models/accepted IDs, integer input price, zero
output price, timeout/byte bounds, audit ID and expected version. No credential
is accepted or retained in the profile. The protected canonical endpoint and its
digest are persisted beside provider configuration; public status must not
expose the endpoint's account path.

Opening the new control schema migrates **3 → 4** atomically. Financial rows and
the stored reasoning profile/consent are preserved, but old reasoning audits
become stale: effective paid processing pauses until explicitly re-audited and
re-enrolled. An unchanged stored `enabled:true` is not a claim of availability.
This is a forward migration; do not drop financial tables to downgrade.

The decision SQL row commits before the complete `decision-activation.json`
mirror. Mismatch denies use. Decision-only disable leaves reasoning untouched;
the existing `managed:activation disable` is the global paid stop and switches
both SQL stages off in one transaction before publishing mirrors. A stop on a
v3 root first performs the forward migration. Mirror failure is reported after
SQL is safely off, not silently labelled complete success.

A malformed decision profile cannot roll back a valid reasoning stop: it is
turned off without rewriting its corrupt configuration or fabricating a valid
fingerprint. A durable `decision_activation_invalid` monetary block is recorded
and a static repair error is reported after commit. **No automated repair or
block-clear path is supplied in this slice**; operator recovery remains a
separate gate. Never bypass it with a hand-edited profile or a new allowance.

Supported backup requires each present profile and mirror to agree; restore
disables both at a new epoch. Both `worker-ready.json` and the separate
`decision-worker-ready.json` are ephemeral and excluded. S1 alone had no decision
worker; S2 now supplies its separately reviewed default-off bootstrap and consumer.
See BUILD_STATE.md for current acceptance; these instructions do not authorize
owner activation, real keys, live model calls or deployment.

The account-bound coordinator and worker now implement the separate decision
stage, verified locally with synthetic transport and actual worker processes,
not a live provider call. The Settings control **Additional background checks** expresses a
separate default-false choice. Sending requires both stored model consent and
stored decision consent, background help, an opted-in active goal, fresh matching
decision readiness, current authorization and fresh monetary admission. A
configured profile alone never makes the capability available.

Own-account status distinguishes `decision_stored_consent_active` (raw choice),
`decision_capability_ready` (installation capability), and
`decision_consent_effective` (configured, unblocked consent—not dispatch
admission). Temporary `usage_pending` does not erase consent. A stored true stays
checked and withdrawable while unavailable or blocked; unrelated settings saves
omit both unchanged consent fields. Public runtime metadata
`decision_processing_available` / `decision_paid_reason` is deployment-only,
not account consent, money, provider identity or proof of a running worker.

### Advisory persistence and worker (S2 accepted locally)

Opening a tenant database now migrates **4 → 5** atomically. This is separate
from the control database's monetary schema 4; original source versions, raw
consent, reservations and dispatched/settled money rows are preserved. Do not
drop tables or reset migration markers to downgrade. Marker failure rolls back
the new advisory DDL as well as the marker.

The internal advisory is a labeled hypothesis with exact goal/source versions
and hashes, never accepted knowledge or spending authority. Source text is only
transient in its bounded question; saved advisories contain references and a
validated judgment (or null when unavailable), not prompts/source bodies. They
are excluded from ordinary entity lists, Today, search and agent context. The
portable vault stores them under `observations`, not daily dream receipts.

Privacy changes, background/consent withdrawal and bound goal revisions withdraw
the judgment. Resuming consent does not reactivate an archived judgment. Deletion
purges every affected advisory version and its operational attempt mapping; a
hash-only tombstone may remain to prevent resending the same claimed question.
Source deletion remains conservatively project-wide for derived entities, as in
the existing service. A newly captured source has a distinct identity. Actual
forgetting verifies retained file/Git erasure and SQLite indexes separately.

Owner export retains historical observations. Import always makes their
judgments **unavailable/null**, never imports execution claims and never invents
missing source bodies. Available provenance that contradicts a declared source
hash or project is rejected. Supported restore withdraws retained observations,
preserves monetary ambiguity and keeps paid processing blocked.

The final S2 gate passed **984 tests, two existing POSIX-only skips, 98 files**;
**24 Chromium journeys**, **4 offline evaluations**, typecheck/lint/build and
dependency audit. The actual-main process proofs cover independent stage
bootstraps, long-call readiness, settled/unknown restart without resend and
continued unpaid work. Windows graceful SIGTERM cleanup and target-host/Linux
verification remain separate; no real-provider quality/pricing result is implied.

The managed worker requires the existing explicit deployment opt-in plus the
separately enrolled decision profile and **worker-only** `BRAIN_DECISION_API_KEY`.
The profile chooses its closed provider family; the key does not. The adapter,
profile and key are frozen at startup, and synthetic preparation validates local
configuration without sending a request before own readiness is published. The
existing heartbeat refreshes each installed stage independently every 5 seconds
with a 15-second TTL. Prepare and execution require that process's own fresh
matching readiness. Missing decision setup leaves reasoning unchanged. Rotation
requires restart. No code here automatically enrolls a provider or grants consent.

`npm start` / `npm run dev` strip the decision key from API and Vite children;
the worker retains it. Operators launching processes directly must likewise use
separate environments. This is not an OS-owner sandbox. Never place credentials
in profile JSON, CLI arguments, logs or frontend configuration.

The decision stage uses at most one goal, ten eligible sources and a 16 KiB
canonical question; oversized context skips the call without trimming source
bodies. Decision and reasoning share the same job cap, so decision overhead can
leave insufficient budget for reasoning even though the judgment cannot gate
it. Known stage costs aggregate in receipts; unknown usage is never shown as
zero or only the known subtotal. These operator notes do **not** authorize a live
test, owner activation or deployment; a capped live run and release inputs remain
separately required.

## Cold/offline managed backup and restore (Task 4 slice)

This is a conservative cold/offline backup, not a hot distributed snapshot. The
operator must stop the API and worker and pass `--offline`; the tool cannot prove
the filesystem is quiesced. Every path is explicit and absolute, nothing is
overwritten in place, and no account, credential or paid call is created.

Backup (`BRAIN_MANAGED_ROOT` must point at an existing, initialized managed root;
the destination must be an absent absolute path that does not overlap the root):

- `npm run managed:backup -- --offline <destination_abs>`

Restore (writes one new, absent destination root; requires the CURRENT trusted
root so deletions can be replayed):

- `npm run managed:restore -- --offline <bundle_abs> <new_destination_abs> --current-root <current_abs>`

A bundle records a strict manifest (schema/version, account inventory and a
SHA-256 per file) that binds the control database, each tenant database, vault,
protected quarantine and marker. When a billing authority key exists, the
manifest also records its fixed path, size and commitment, while explicitly
recording that the key is not in the portable bundle. Restore verifies the
current operator still possesses that exact key before staging financial history.
A swapped tenant, control, marker or altered file is rejected before anything is
published. The hashes are an integrity check, not an adversarial signature.

Restore applies the control restore barrier first (a durable service-wide money
deny and deletion of restored sessions, agent-token routes and pending OIDC
correlations) and then each tenant barrier and credential revocation, before
replaying the current root's deleted/withdrawn source tombstones. A restored
financial block stays even when its history is empty. A mid-restore root carries
`MANAGED_RESTORE_INCOMPLETE` and `ManagedRuntime` refuses to open or
re-provision it until recovery completes; a failed restore leaves its marker and
staging for inspection. There is deliberately no safe shim that resumes a partial
restore.

This tool is not a hot-snapshot tool: it cannot prove writers were quiesced, it
covers only the deletions visible in the supplied current root, and it does not
claim to be an adversarial or authenticated backup.

## Billing authority enrollment and key recovery (B0 Task 4)

The billing authority remains default-off after the explicit money-5 install.
Enrollment is an offline, one-time operator action; normal API/worker startup,
webhooks and browser routes cannot create a key, policy, baseline or enrollment.
Set `BRAIN_MANAGED_ROOT`, stop every API/worker, and use this sequence:

```
npm run managed:reconcile -- audit-history --offline --workers-terminated
npm run managed:billing -- enroll <audit_uuid> <policy_json_abs> <32_byte_key_abs> --offline --workers-terminated
npm run managed:billing -- status
```

The policy must already contain the exact current epoch/root nonce, the SHA-256
commitment of the supplied key, the selected sandbox/live namespace, and explicit
integer micro-USD ceilings. Enrollment does not select those values. It verifies
the strict money-5 schema and current audit, backfills generation-1 tenant
incarnations where required, writes the protected key/policy/enrollment artifacts,
records the immutable manual baseline, and then verifies the complete result.
Replaying the identical enrollment is safe; a changed key, policy, root, audit or
artifact is denied.

On Windows the enrollment command replaces inherited ACLs on `.protected` and its
billing artifacts with an explicit DACL for the current owner, SYSTEM and local
Administrators, then reads the DACL back. `managed:billing verify-acl` performs the
same positive read-only check; `harden-acl` is an explicit offline repair command.
On POSIX the existing 0700/0600 checks remain authoritative.

Key backup is separate from the portable managed bundle. It is an authenticated,
encrypted AES-256-GCM envelope derived with scrypt from a 16–4096 byte passphrase
file. The passphrase is supplied by absolute regular-file path and never through
argv, environment, logs or archive output:

```
npm run managed:billing -- key-backup <archive_abs> <passphrase_file_abs> --offline --workers-terminated
npm run managed:billing -- key-restore <archive_abs> <passphrase_file_abs> <expected_commitment> --offline --workers-terminated
```

Restore never overwrites or rotates an existing key. A restored managed bundle
still has no key and remains paid-blocked until the encrypted key is restored and
a fresh audit/enrollment is completed under the restore's rotated epoch. Losing
both the protected key and its encrypted archive is deliberately unrecoverable by
software; no webhook or model may mint a replacement or re-sign history.

## Operator reconciliation CLI and all-account audit (Task 3 slice)

The trusted offline reconciliation CLI runs only on the server filesystem
against one explicit existing absolute managed root; there is no local default
and no admin HTTP route, browser setter or "clear all blocks".

Set `BRAIN_MANAGED_ROOT` to the managed root, then:

```
npm run managed:reconcile -- status
npm run managed:reconcile -- inspect <call_id>
npm run managed:reconcile -- validate-audit <audit_id>
npm run managed:reconcile -- init-epoch --offline --workers-terminated
npm run managed:reconcile -- attest-settled <attestation.json> --offline --workers-terminated
npm run managed:reconcile -- attest-zero <attestation.json> --offline --workers-terminated
npm run managed:reconcile -- audit-history --offline --workers-terminated
npm run managed:reconcile -- suspend <account_id> --offline --workers-terminated
```

- `status`, `inspect` and `validate-audit` are **read-only**. They open the
  control database through a genuine read-only handle and never create a money
  table, a control epoch, a credential or a file; an uninitialized money
  namespace is reported rather than created. `status` prints every managed
  account's opaque id and state to the trusted operator — it never prints
  knowledge, a session token, a CSRF value or any credential. The authenticated
  owner's HTTP money view (own-account only) is a separate surface.
- `inspect <call_id>` prints the curated immutable financial identity of one
  dispatch — account/call id, state, reserved/actual micro-USD, the identity,
  content, request and config hashes, the account-period id, provider/model/price
  version, the frozen service/user day and accounting zone, and the current control
  epoch — so a trusted operator can construct one exact typed attestation. It never
  prints a request body, actor, key, evidence or source text; the exact external
  provider correlation (`provider_request_id`) must still be obtained from a
  verified receipt.
- Mutating commands require **both** `--offline` and `--workers-terminated`.
  Those flags are an operator precondition that every managed writer was
  stopped, not a programmatic quiescence proof. A missing acknowledgement denies
  before any write. Each command accepts its exact documented arity
  (`status`/`init-epoch`/`audit-history` take no positional argument;
  `inspect`/`validate-audit`/`attest-settled`/`attest-zero`/`suspend` take exactly
  one), unknown or duplicated flags are rejected, and the CLI prints static,
  content-free errors without a stack, input path or proof body.
- `attest-settled` / `attest-zero` read one **absolute, regular, non-linked**
  operator JSON file of at most 256 KiB. The file must be a closed, strictly
  validated attestation (a UUID idempotency key, kind, exact call identity and
  pricing/request/config hashes, expected state/actual CAS, integer micro-USD
  `USD` cost, evidence digest, method, bounded actor metadata, ISO instant and
  the current control epoch). Unknown fields, a non-USD currency, a blank
  correlation id or an undispatched `reserved` row are denied. The command
  reports only the resolution UUID, kind, integer cost, currency and epoch — never
  the correlation id, actor or evidence body. A repeat of the same resolution id
  is idempotent; a changed binding conflicts.
- `audit-history` scans **every** account (including suspended ones) one
  read-only tenant database at a time, after validating the tenant's provisioning
  marker against the trusted control identity, and refuses the whole audit on any
  legacy reservation row, orphan or unmapped projection, non-terminal row, a
  state/amount/price/request/config mismatch, a non-integer/negative amount (or a
  released row carrying a non-null actual), or an unsupported money schema. Every
  read is bounded (`LIMIT remaining+1` on the account inventory, the central
  journal and the tenant journal) and the global `maxRows` budget (default 100000;
  the central and tenant journals are each counted) spans all accounts, so
  exhaustion denies rather than partially auditing. It records only ids, hashes and
  integer money. A record is written only after two complete scans agree and a
  short write transaction re-checks the epoch and the bounded central
  money/config/blocks. `validate-audit` re-derives the live baseline and confirms
  the epoch, money-schema version/digest, service + per-account config and prior
  baseline rows; a changed schema or config, a new unsurveyed account or a supported
  restore makes the audit invalid. Legitimate new terminal mapped rows beyond the
  baseline stay valid.

## Root generation on restore

`managed:backup` records an optional, hashed `control-epoch.json` root marker and
refuses to capture a root whose marker does not bind its control generation. A
supported `managed:restore` rotates the control epoch (a safe increment with a
fresh nonce) and rewrites the root marker at staging **before** publish, so every
prior audit becomes invalid while each financial block and the deletion of
restored sessions, agent-token routes and pending OIDC correlations is preserved.
A marker whose bundled generation is missing or different is rejected before
anything is published. A previous-format bundle without the marker field is still
supported — it restores with the paid block and derives a fresh generation from
its known control row (never copying an approval); a bundle with no generation at
all stays uninitialized until an explicit `init-epoch`. Any rotation or marker
write failure leaves the `MANAGED_RESTORE_INCOMPLETE` root unavailable.

Explicit non-guarantees: this does not provide full rollback detection (a mirrored
nonce detects a mismatched copy, not a simultaneous rollback of both the control
database and the marker), does not verify provider authenticity, does not prove
writer quiescence, and treats hashes as integrity rather than an adversarial
signature. Managed paid processing remains **default-off**. The opt-in flag alone
does not enable it: an audited installed profile, matching fresh worker readiness,
current owner consent and monetary admission are also required. Restored roots
remain blocked regardless of that flag until their separate guarded recovery
requirements are satisfied; do not erase a block or invent a new allowance.
