# Running the managed runtime (operator notes)

Managed mode serves an isolated personal brain per signed-in account from a
standards-based OIDC login. It is **not a public release**. One central
account/service spending authority is implemented and locally verified, but
production paid-model dispatch stays OFF pending restore/control-IO/restart
activation, a live provider, TLS and billing. Do not advertise or open the
managed service to the public. Local self-hosting is unchanged and remains the
supported path.

## Configuration

Managed startup is explicit and fails closed. `BRAIN_MODE=managed` requires
every value below; a missing or malformed field stops the process **before** any
runtime, tenant store or local database is created.

| Variable | Required | Notes |
| --- | --- | --- |
| `BRAIN_MODE` | managed mode | `local` (default) or `managed`. |
| `BRAIN_MANAGED_ROOT` | yes | One absolute directory outside the repo for managed data only. |
| `BRAIN_PUBLIC_ORIGIN` | yes | The exact HTTPS origin served, one bare origin, no path. |
| `BRAIN_OIDC_ISSUER` | yes | HTTPS issuer identifier, no credentials, query or fragment. |
| `BRAIN_OIDC_CLIENT_ID` | yes | Registered client id. |
| `BRAIN_OIDC_CLIENT_SECRET` | yes | Server-side only. Never printed, logged or bundled. |
| `BRAIN_OIDC_CALLBACK_PATH` | no | Fixed absolute path; defaults to `/auth/callback`. |

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

Managed accounts run **extractive preparation only** in this build. One central
control-plane ledger governs managed money (account allowance windows, a single
global service cap, cumulative job and frozen user-day limits), and the
per-tenant ledger is a conservative journal/projection, but paid activation stays
OFF:

- `PATCH /api/v1/preferences/background` with `provider_enabled: true` still fails
  with `PROVIDER_UNAVAILABLE` (503) even with a valid session, CSRF and a positive
  operator policy; `connected_processing_available` is false regardless of
  `BRAIN_MANAGED_ALLOW_PAID=1`. Capture and extractive preparation remain
  available.
- The managed worker injects an explicit provider that refuses every dispatch,
  independent of any persisted preference, so a legacy `provider_enabled` row
  produces an explicit "unavailable" receipt — never a silent connected result.
- A failed central safety-marker write pauses managed paid scheduling for the
  process (an in-memory fuse, not a durable or multi-process guarantee) while
  capture stays available.

Do not attach a shared provider key to managed tenants, and do not enable paid
processing until restore/control-IO/restart activation, a live provider and TLS
are wired and reviewed. Paid activation is off by default and no environment flag
flips it on in this build.

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

Not implemented or verified as a release: public hosting, billing, entitlements,
live paid-model dispatch, TLS and graceful signal handling on the target host.
Central account/service spending control, restore barriers and the own-account
money view are implemented and locally verified; paid production activation
remains open pending a restore/control-IO/restart drill and a live provider. Managed login has HTTP integration and Chromium
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

Managed paid processing remains **OFF in this build**. `connected_processing_available`
is false and enabling it through preferences returns HTTP 503 regardless of the
operator policy or `BRAIN_MANAGED_ALLOW_PAID=1`; the managed worker still denies
paid providers. A positive policy only marks the account "configured", not
available. Paid activation is a separate, later gate that needs an operator
reconciliation/restart/control-IO drill first.

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
protected quarantine and marker. A swapped tenant, control, marker or altered
file is rejected before anything is published. The hashes are an integrity check,
not an adversarial signature.

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
