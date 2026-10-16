# Managed provider activation design — one shared, default-off runtime policy

**Status: DRAFT — awaiting human approval (parent review first). Implementation-only scope:
no default-on policy, no activation of any owner account, no real provider key loaded, no
paid call, no push or billing.** This designs the slice *after* Phase 1 and must be approved
before any implementation plan (`writing-plans`) is written.

## Goal
One **shared explicit policy** turns a real prepared provider on only when **all** hold: a
persisted operator activation profile is enabled; the deployment opt-in is present; the
control epoch/root marker and schema match; the account's operator policy/caps are configured;
the user's stored consent is active; and the financial barrier is clear. Without a paid request,
the worker runs extractive preparation; an intended paid attempt that cannot run is labeled
unavailable, never a fabricated paid success. Never an automatic cross-provider fallback. **Capability
(whether paid is possible) is separate from admission (whether this send is allowed now).**

## Verified current state (inspected, not assumed)
- `PreparedReasoningProvider` (`packages/providers/prepared.ts`) is the only real adapter: a
  byte-bound one-shot requiring a versioned `ReasoningPrice`, a concrete model + accepted
  response models + a server-side key; unknown model/usage keeps the hold. It already accepts
  an injected `fetcher` and defaults to `https://api.openai.com/v1/responses`.
- `ManagedSpendingStore` is the central money authority; `mark` is the sole permission;
  `serviceBarrier()` exposes the global one-inflight pause; `usage_pending` is an admission
  barrier, **not** consent revocation (`Brain.prefs` already excludes it).
- `main.ts` hard-codes `unavailableProvider` (503); `managedPaidAvailable` and public
  `connected_processing_available` are always false; managed preferences reject
  `provider_enabled: true`; `scripts/managed-policy.ts` is the only policy writer.
- `validateManagedAudit` binds epoch/schema/inventory and per-account baselines, but
  `scanOnce` **rejects any nonterminal central or tenant row**, so it can only run at
  enrollment — never per send.

## Approaches
- **A (recommended — least complex safe).** One **persisted activation profile** (control DB)
  with a mirrored root marker, a shared read-only loader used by both processes, and a tiny
  content-free readiness lease. No new service, registry or outbox. A full terminal audit runs
  **once** at enrollment; a targeted guard runs at sends.
- **B/C (rejected).** Two sources of truth via a server env flag plus a worker code constant drift
  and cannot be a per-deployment authority; an external activation service or sidecar cannot be
  *proven* consistent with the control DB and adds a trust surface for one boolean; scope creep.

## A — shared activation policy
**Pure types — `packages/domain/managed-activation.ts` (new). No secret is stored.**
```ts
export const ACTIVATION_SCHEMA_VERSION = 1;
export type ActivationProfile = { schema: 1; version: number; enabled: boolean; // default false
  provider: "openai"; model: string; price_version: string;                       // concrete id
  input_micro_usd_per_million: number; output_micro_usd_per_million: number;      // integers
  accepted_response_models: string[]; max_output_tokens: number;                  // concrete
  endpoint_class: "openai_responses";                                              // NOT a free URL
  config_digest: string; audit_digest: string;                                    // bound enrollment inputs
  audit_id: string; epoch: number; root_nonce: string; fingerprint: string;       // bound at enable
  updated_at: string };
export type ActivationReason = "ready" | "off" | "epoch_uninitialized" | "epoch_mismatch"
  | "profile_invalid" | "audit_stale" | "worker_absent" | "worker_stale"
  | "worker_config_mismatch" | "policy_unconfigured" | "key_missing" | "durable_block";
export function validateActivationProfile(input: unknown): ActivationProfile;    // strict
export function activationFingerprint(p: ActivationProfile): string;             // excludes itself
export function profileConfigDigest(p: ActivationProfile): string;               // secret-free
```
`activationFingerprint` is the sha256 of the canonical projection of every field **except
`fingerprint`** and any secret, so it never cycles. `config_digest` hashes only provider
parameters. `audit_digest` binds the selected audit's epoch, schema, configuration, account
inventory and immutable baseline evidence. The enrollment fingerprint joins both digests;
it does not pretend the existing financial audit already inspected provider parameters.
The endpoint is a **closed class**, not a caller URL.

**Configured policy vs server capability — `packages/runtime/managed-activation.ts` (new).**
Split so the worker never needs its own readiness to boot.
```ts
export function readActivation(control, root): ActivationProfile | undefined;    // read-only, no DDL
export type WorkerReadiness = { schema: 1; worker_id: string; epoch: number;
  activation_fingerprint: string; config_digest: string; provider: string; model: string;
  price_version: string; booted_at: string; heartbeat_at: string; expires_at: string };
export function evaluateConfiguredPolicy(input: { control; root; profile; now: Date;
  optIn: boolean; schemaOk: boolean }): { ready: boolean; reason: ActivationReason }; // no worker input
export function serverCapability(input: { configured: { ready; reason }; workerReady }):
  { ready: boolean; reason: ActivationReason };                                     // + fresh lease
```
`evaluateConfiguredPolicy` is what the **worker** uses to boot: profile enabled; `schemaOk`;
epoch row and root marker agree; the provider `config_digest` and financial `audit_digest`
match their enrollment bindings; provider params valid; `optIn` present. It does **not** require a readiness lease.
`serverCapability` adds a fresh lease and drives public metadata. A missing key makes the
worker **not** write a lease (server `ready:false`) with **no network lookup** — the key is read
to verify configuration, never hashed, persisted, or required "after ready".

**Persistence, ordering and version CAS.** Migrate to `managedMoneySchemaVersion = 3`
**before** any audit or enrollment (a schema-2 audit is stale the moment new tables are added).
Add inside the existing money DDL:
```sql
CREATE TABLE IF NOT EXISTS managed_activation(singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  schema INTEGER NOT NULL, version INTEGER NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  provider TEXT NOT NULL, model TEXT NOT NULL, price_version TEXT NOT NULL,
  input_micro_usd_per_million INTEGER NOT NULL, output_micro_usd_per_million INTEGER NOT NULL,
  accepted_response_models TEXT NOT NULL, max_output_tokens INTEGER NOT NULL,
  endpoint_class TEXT NOT NULL CHECK(endpoint_class='openai_responses'),
  config_digest TEXT NOT NULL, audit_digest TEXT NOT NULL, audit_id TEXT NOT NULL, epoch INTEGER NOT NULL,
  root_nonce TEXT NOT NULL, fingerprint TEXT NOT NULL, updated_at TEXT NOT NULL);
```
The mirror `<root>/activation.json` carries **all** profile fields. The SQL row commits in the
control TX **first**, then the tmp+rename marker. This is **not** one atomic write: an
interrupted write leaves a mismatch, and both processes then **deny** capability and sends
(fail closed) while the marked hold is retained and capture/extractive work continue. Every
mutation takes `expected_version` (CAS) so a stale operator cannot overwrite a concurrent
`disable`; the loader is read-only (no DDL, no authority).

**Readiness lease `<root>/worker-ready.json`** (mode `0600`, atomic; read-only on the server):
worker id, epoch, `activation_fingerprint`, `config_digest`, non-secret provider/model/
price_version/endpoint_class, `booted_at`, `heartbeat_at`, `expires_at` (TTL 15 s). A dedicated
**awaited 5 s lifecycle-independent heartbeat timer** refreshes it while a provider call is in
flight, independently of that call's completion and outside financial SQL transactions.
`worker.shutdown` cancels the timer and deletes the lease **only if
`worker_id` matches** (never a newer instance's). No key hash, prefix or content hash. A lease
proves **at least one** ready worker, not that all are configured, and is liveness only — **not**
"connected/verified quality". A stalled event loop or SQL lock can push past the TTL: the server
then reports `ready:false` — correct fail-closed (no new consent/dispatch, while an already-I/O
call continues; **no** arbitrary cancel or refund on expiry).

## Dimensions, consent and privacy
- **capability** (service-wide): `serverCapability().ready` = configured policy **and** a fresh
  lease. It is **independent of `serviceBlocked`/`usage_pending`**, so a call's own post-mark
  barrier never flips capability or consent.
- **consent** (per account): stored `provider_enabled` **and** a configured account policy;
  own-account only.
- **admission** (momentary): `serviceBarrier()` + caps headroom, re-checked inside
  `reserve`/`mark`. Durable blocks make a send unavailable but do not erase capability.

**Consent toggle (fixes an unrevokable-true bug):** when stored is **true** it is **always**
enabled to turn **off**, even if the profile/worker is unavailable. When **false** it is enabled
to turn **on** once the account capability/policy is ready, even if momentarily busy; capability
never requires consent. Stored consent is **never** rewritten by service busy or a durable block
— the effective `provider_enabled:false` is a separate, labeled derived state (as today).

Public `/api/v1/runtime` carries only `connected_processing_available` and a plain
`managed_paid_reason`; `true` means **capability is available** (policy configured + worker
provider path installed), **not** model quality or a live-connect success. Authenticated status
exposes only the owner's own `spend.configured`, `spend.consent_active`, `spend.capability_ready`,
`spend.paused_reason` and money — never audit records, other accounts or global totals. Capture,
search and extractive work need neither capability nor consent, and no model picker appears in
the primary flow.

## Worker bootstrap (no deadlock) and one supported worker
V1 supports **one worker process per root** (cross-process money protection is still tested).
Boot order: `evaluateConfiguredPolicy` (no lease input) → if ready, build the paid provider with
the injected/base transport and verify the key is present → install the account-bound accounting
coordinator → **then** write the lease and start its 5 s heartbeat timer. A worker whose freshly
reloaded profile/epoch/provider identity mismatches **denies its own sends** at every `reserve`,
`mark` and pre-I/O check regardless of any heartbeat, so a fresh good lease cannot hide a
misconfigured second worker. Profile-off takes effect **immediately** (both processes re-read the
current profile; no TTL wait), expired or future-dated stamps reject the lease (operator-controlled
clock in tests), key rotation does not change the fingerprint, and no hash grants authority.

## Send-time guard — targeted seam, no nested transaction
`validateManagedAudit` never runs per send. A bounded **read-only preflight runs outside** the
central transaction (schema/epoch/root, immutable-baseline digests, per-account mapping), then
the `.mark` transaction **rechecks only central state** (digest/version CAS) under its own
`BEGIN IMMEDIATE`. No tenant scan and no `assertHistoryEligible` run inside the central TX, and
no generic distributed snapshot is added. The baseline helper becomes **nonterminal-tolerant
only for the trusted current attempt slot** at its explicit stage; any other nonterminal row (an
unknown held `dispatched` elsewhere, a new unmapped row, an unsurveyed account, a changed
baseline) **denies**. The permitted set is derived, never supplied: no provider/browser/
`ignoreCallIDs` input can widen it. Unrelated `reserved` stranded holds may require operator
audit/resume and stay fail-closed. The owner's freshly marked row remains the expected
one-flight `usage_pending` state; a **new** send still needs a fresh exact owned chain.

## Enrollment audit (once, offline)
`managed:activation enable` migrates to schema 3 first, then requires a fresh
`auditManagedHistory`/`validateManagedAudit` whose baseline is fully terminal and exactly mapped,
binds `audit_id` + `audit_digest` + `epoch` + `root_nonce` + `config_digest`, computes the fingerprint,
and writes the row then the marker. A supported restore cannot reuse the approval because it rotates the
epoch.

## Restart, restore, rollback and disable (honest)
The profile persists across **ordinary restart**; `BRAIN_MANAGED_ALLOW_PAID=1` is a **deployment
opt-in**, necessary but **not** a fresh per-boot challenge. A supported restore rotates the epoch,
**disables** the profile and clears readiness, so a restored deployment needs a new explicit
offline `enable`. A raw whole-DB+marker clone with the same env is **indistinguishable and
unsupported**; the design claims **no** rollback detection and no unearned anchor. `disable` has
**no** offline precondition and may revoke policy immediately while workers run (no automatic
network abort; a known or unknown charge settles or stays held and is never refunded by asserting
"unknown"). `enable` requires `--offline` and an operator acknowledgement that all workers are
terminated (a precondition, not proof).

## Operator CLI (offline, no browser)
`scripts/managed-activation.ts` (new), one explicit absolute root, strict arity, no admin HTTP
route, no browser setter: `status`/`show` (read-only), `enable <profile-json-file>` (`--offline`,
terminating-workers ack, fresh audit, version CAS), `disable` (immediate, `expected_version`).
`managed-policy`/`managed-reconcile` stay the only money and reconciliation writers. Browser code
never writes profile, provider, tenant root or enrollment. The profile cannot choose an arbitrary
endpoint or model set: `provider` is `openai`, `endpoint_class` is fixed, and
`accepted_response_models` are concrete and exactly priced.

## Tests (design only — synthetic, no paid network)
Real `apps/server`/`apps/worker` subprocesses over an isolated managed root. Paid dispatch uses an
**injected fake transport** in the trusted test subprocess (or a guarded `NODE_OPTIONS` fetch
preload) — never a production flag unlocking loopback, a UI-injected mock, or the real key. Cases:
(1) default-off → extractive work or an explicitly unavailable paid attempt with `no_attempt`
accounting (no new hold before admission), and the
fake transport sees **zero** requests; (2) wrong model/price/malformed output each preserve the
exact known-or-unknown charge; (3) two-account one-flight race and restart → no resend; (4)
pre-consent config → not sent; (5) after enable + consent exactly **one** dispatch; (6) off/
revoked/suspended/goal/source/caps changed under lock → pre-I/O guard denies; (7) a snapshot
"invoice" never auto-clears a block; (8) the enrollment audit's own reserved-then-crash slot maps
and does not self-deny; (9) stale/mismatched readiness → no capability claim while capture/
extractive continue; (10) consent true stays revocable while unavailable; (11) new slots cannot be allowlisted by client input; deterministic clocks.

## Green packaging baseline (context, not this slice's proof)
Merged `main` CI **38889855879** (fresh Ubuntu) passed type/lint/build/audit, 479/479 tests over 60
files, 17 browser journeys, 4 offline evals, and nonroot Docker/Compose + Caddy with persisted
session/source after restart, origin denial and SQLite backup — packaging/synthetic safety only,
**not** host TLS, provider quality or a human pilot.

## Explicit decisions (no `TBD`)
| Decision | Choice |
|---|---|
| Source of truth | One persisted profile (control DB) + mirrored root marker; both processes share one read-only loader. |
| Capability vs admission | Capability = configured policy + fresh worker lease; admission = busy/budget/durable block; never coupled to `usage_pending`. |
| Consent | Stored consent independent of capacity; true always revocable; false enables when account capability/policy ready; never rewritten by busy. |
| Worker model | One supported worker per root V1; each rechecks its own profile/provider identity every reserve/mark/pre-I/O. |
| Enrollment audit | Full terminal audit **once** at enrollment; send-time guard is a targeted preflight + central CAS, never `validateManagedAudit`. |
| Persistence | SQL row commits first, marker tmp+rename second; mismatch fails closed; `expected_version` CAS prevents stale overwrite. |
| Endpoint | Fixed `openai_responses` class; tests use an injected fake transport, never a production URL/flag. |
| Restore/rollback | Supported restore rotates epoch + disables + clears readiness; raw clone unsupported/undetectable; no rollback-detection claim. |

## Non-goals and limits
Billing/payments, provider-outage fallback, automatic provider-health lookups, System 1 routing,
native clients, hosted TLS, queue/graph/MCP-model UI, and any provider/pricing choice driven by
the development executor. DeepSeek primary and Astra Medium advice do **not** select Bi Brain's
runtime provider; Ollama is **not** chosen as a production runtime. A live-provider **smoke**
needs separate explicit user authorization for a small budget **after** fake-transport activation
and CI pass. When paid is not requested the worker runs extractive directly (no repeated 503);
when paid is intended but capability is off it yields a truthful not-available receipt and
never an extractive false-success. A hold exists only after real admission; any already
marked unknown hold is preserved. Synthetic safety is separate from
**semantic live quality** (real output/cost/quality); operator acknowledgements are preconditions,
not proof; profile disabled by default.
