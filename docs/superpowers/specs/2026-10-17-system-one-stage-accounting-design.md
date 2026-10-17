# System 1 stage-specific decision activation & accounting — design

**Status: APPROVED — the owner explicitly said "Approved" after written design review.**
Date: 2026-10-17. Branch: `feat/system-one-stage-accounting` (from published `3e9d918`). Scope: a bounded,
**stage-specific decision activation + consent + central accounting** foundation, synthetic-first.
No production decision dispatcher is added. The existing reasoning profile is preserved, but the
schema change invalidates its audit binding until an operator re-audits; no account is activated.

## Verified current state (actual symbols, not assumed)

- `assertActivationSeam` is ONLY in `packages/storage/managed-spending.ts` (L243); stage is hard-coded
  `!== "reasoning"` (L268) and it compares `spec.config_hash === expected_prepared_config_hash`
  (L271/L316). `apps/worker/managed-accounting.ts` has no seam and cannot override the central guard.
- `validateActivationGuard` (`packages/domain/managed-activation.ts`) pins `provider: z.literal("openai")`
  (L124/L280/L332) and `endpoint_class` literal `openai_responses`; `expectedPreparedConfigHash`
  (`packages/runtime/managed-activation.ts`) is Responses-specific. `managed_activation` is a single SQL
  row (columns, not JSON) at `managedMoneySchemaVersion = 3`; mirror is `<root>/activation.json`.
- `WorkerReadiness` (`packages/runtime/worker-readiness.ts`) pins `provider:"openai"` and
  `endpoint_class:"openai_responses"`. `apps/worker/main.ts` bootstraps the reasoning provider and
  writes `<root>/worker-ready.json`; `managed-recovery.ts` copies `activation.json` on backup and
  `disableForRestore` clears it on a supported restore.
- `packages/providers/prepared-decision.ts` (published) is the immutable one-shot decision adapter over
  the real `SystemOneProvider` (`typesafe`/`cloudflare`, official allowlist). No runtime consumer.
- Consent today: `Brain.prefs.provider_enabled` is the single master paid flag (reasoning UI wording);
  `Brain.status` exposes `capability_ready`/`stored_consent_active`/`consent_effective`.

## Approaches

- **A (recommended).** Keep the existing reasoning profile exactly (schema-1 legacy compat, no
  auto-enable, no consent migration). Add a **separate, default-off decision manifest** with its own
  enrollment, readiness and mirror binding. Least profile disruption; both share the control audit,
  money authority and recovery epoch, so audit staleness and restore are deliberately coordinated.
- **B (rejected for now).** A compound "profile v2" with a provider-family discriminator in one row.
  Smaller file count but forces a migration of the live reasoning profile and a shared mirror, risking
  the reasoning enrollment/restore path.
- **C (rejected).** A test-only coordinator "stage option" that bypasses the central guard — the parent
  already rejected the earlier mislocated version as an invisible bypass.

## A — data, storage and migration

- **Schema 3 → 4**: new closed table `managed_decision_activation(singleton=1, schema, version, enabled,
  provider CHECK(provider IN ('typesafe','cloudflare')), model, accepted_response_models JSON,
  endpoint, endpoint_digest, price_version, input/output_micro_usd_per_million,
  timeout_ms, max_request_bytes, max_response_bytes, request_overhead_bytes, config_digest,
  audit_digest, audit_id, epoch, root_nonce, fingerprint, updated_at)`. Store the canonical official
  HTTPS endpoint AND its digest in the protected SQL/mirror profile: a digest alone cannot derive the
  adapter's expected config hash. Reject credentials/query/fragment, non-default ports, loopback and
  non-allowlisted paths. Cloudflare's account path is server configuration, not a credential; omit it
  from public status. No key is stored in either profile.
- Validate the existing adapter's concrete model/accepted-set and finite timeout/byte bounds at
  enrollment; input pricing is positive integer micro-USD per million, output pricing must be zero.
  Reuse existing numeric limits. Operator prices remain unverified against real invoices.
- Separate mirror `<root>/decision-activation.json`; never overwrite the reasoning
  `activation.json`. The root marker format is unchanged (epoch rotates on supported restore).
- **Separate readiness**: retain `worker-ready.json` and its schema-1 OpenAI record unchanged. A
  closed decision record uses `decision-worker-ready.json`, never the same filename. Both use the
  existing 5-second refresh / 15-second TTL and frozen own-installation checks; a reasoning-only
  worker cannot publish decision readiness. S1 tests install the real decision adapter with an
  injected transport in disposable roots; production has no decision bootstrap or readiness writer.
- **Audit/enrollment**: decision enrollment reuses the `auditManagedHistory`/`validateManagedAudit`
  semantics and binds the new `audit_digest`/`config_digest`/`epoch`. Because schema 3→4 changes the
  schema digest, **existing reasoning audits go stale**; the legacy reasoning profile is preserved but
  must not quietly remain "current audited policy" — effective processing is unavailable until
  re-audited; do not falsely change/display its stored enabled value as false. No consent is granted.
- **Restore**: a supported restore rotates the epoch, disables **both** profiles and clears readiness
  (both readiness files excluded from backups); backup copies `decision-activation.json` only when the
  table matches, with the same manifest conditions as `activation.json`.
- **CLI**: existing reasoning `managed:activation` argument shapes stay compatible. Add a strict
  `managed:decision-activation` verb (`enable <file> --offline --workers-terminated`, `disable
  --expected-version <n>`, `status`, `show`) with exact arity and no auto-widen. Preserve SQL-first,
  complete-mirror persistence, version CAS, immutable audit bindings and mismatch-denies semantics.
- **Global stop**: preserve `BRAIN_MANAGED_ALLOW_PAID=0` as denial for both stages. The existing
  `managed:activation disable --expected-version <n>` remains a whole-installation paid stop: disable
  both SQL profiles in one transaction, then write complete mirrors (mismatches deny). The new
  decision-only disable stops only decision work. Enabling reasoning never enables decision.

## Stage-scoped guard and consent

- Generalize `assertActivationSeam` (storage) so the expected profile/hash is selected by the spec's
  `stage`: a `decision` spec uses the decision manifest + decision expected-hash; a `reasoning` spec
  uses the reasoning profile. A **declared stage option can never grant permission**; the seam still
  requires the frozen profile, epoch, account/job/slot, `spec.config_hash === expected` and the
  central-only snapshot under the acquired lock. `config_digest` (domain) stays distinct from the
  prepared `config_hash`.
- Derive decision expected config hashes through one shared pure helper extracted from the prepared
  adapter, covering its exact canonical inputs, defaults and accepted-model ordering; never duplicate
  the algorithm or equate it with `config_digest`. Missing decision profiles fail closed; old
  reasoning-only guards never authorize decision calls. Shared monetary blocks affect both stages.
- Use closed stage-discriminated installed-policy/guard types, not a general provider registry.
  Decision purpose is `goal_relevance` on a running `review_changed_assumption` job. Reject repair
  stages, cross-profile fields and wrong job purposes. Pre-reserve/mark/pre-I/O checks refresh the
  original owner/fence lease and current consent; central transactions never open tenant databases.
  Post-settlement checks select the same stage's profile; revocation never prevents known settlement.
- **Purpose-bound question**: the decision request is a bounded single goal-relevance question; its
  `request_hash` binds the goal entity version and ordered source versions, and its options/body
  authorize nothing (no capability/permission claim). Source authorization remains a domain snapshot
  prepared by the **future** policy — not a new storage authority in S1.
- **Consent (semantic)**: add a dedicated preference `decision_provider_enabled` (default **false**).
  The existing `provider_enabled` master keeps its exact current meaning/UI. A decision request is
  allowed only when `provider_enabled` **and** `decision_provider_enabled` and background help and an
  active goal purpose hold at the worker boundary. Unrelated saves preserve the new raw consent;
  stored `true` stays withdrawable while unavailable; a durable block denies re-enable; decision
  readiness is distinct from known accounting and from `usage_pending`. Public/status language stays
  plain (no model names, MCP/tokens, or graph terms).

## S1 scope (this subproject) vs S2 (later, separate written spec)

- **S1**: migration + stage-scoped guard + decision manifest/consent + central/tenant accounting
  proven with a **disposable synthetic root** and an **injected decision transport**, through the
  existing account-bound coordinator path. **No production worker bootstrap, no timer, no decision
  call from the real worker.** Capability must not claim "decision processing ready" when no decision
  adapter is installed (readiness cannot fabricate `ready`).
- **S2**: real worker advisory policy + derived evidence/receipt lifecycle + deletion/retention, gated
  by a separate written spec; live evaluation always needs explicit authorization.

## Accounting invariants to prove in S1 (real SQLite, synthetic)

Decision `reserved → dispatched → settled` under the central TX with the private attempt map +
lease fencing; **a `not_dispatched` outcome AFTER `mark` never releases/refunds** the dispatched hold
(global paid pause, `unknown`); before `mark`, a `reserved` hold may be released only by CAS. Known
malformed cost is retained with the exact accepted alias; consent revoked during IO discards output
while the charge persists. Unknown usage pauses all paid across accounts/stages/restart while capture,
search and extractive work continue. A **settled decision does not reuse the reasoning job slot**
(distinct dispatch keys), and `hasUnresolved` (which currently returns `true` even for `settled`) must
**not** be reinterpreted silently — use an exact slot/state reader for the new stage and preserve
legacy retry/no-resend. Known decision settles before an already-authorized reasoning call in the next
slice; the shared job cap and global one-inflight permit are both shown. Profile disable while a charge
is pending settles before publish.

## Closed record shapes (design intent)

```ts
// SQL row managed_decision_activation (schema 4), single row
type DecisionActivationProfile = {
  schema: 1; version: number; enabled: boolean;
  provider: "typesafe" | "cloudflare";            // closed; official allowlist transport
  model: string; accepted_response_models: string[];
  endpoint: string; endpoint_digest: string;      // protected canonical official URL + sha256; no key
  price_version: string; input_micro_usd_per_million: number; output_micro_usd_per_million: number;
  timeout_ms: number; max_request_bytes: number; max_response_bytes: number; request_overhead_bytes: number;
  config_digest: string;                          // provider-params-only (domain); != prepared config_hash
  audit_digest: string; audit_id: string; epoch: number; root_nonce: string;
  fingerprint: string; updated_at: string;
};
// decision-worker-ready.json only; existing reasoning record/file unchanged
type DecisionWorkerReadiness = { schema: 1; worker_id: string; stage_scope: "decision";
  provider_family: "typesafe" | "cloudflare"; endpoint_digest: string; epoch: number;
  root_nonce: string; activation_fingerprint: string; config_digest: string; model: string;
  price_version: string; booted_at: string; heartbeat_at: string; expires_at: string };
```
- Domain names: `decisionProfileConfigDigest`, `decisionActivationFingerprint`,
  `validateDecisionActivationProfile` (mirror the existing reasoning module's shape, OpenAI free).
- The decision question stays a bounded single goal-relevance question; `request_hash` binds the goal
  entity version + ordered source versions; nothing in the body is authority.

## Migration steps (schema 3 → 4, in one transaction, strict deny if not installed)

1. Add `managed_decision_activation` and advance the existing managed money schema marker/version
   to 4; no second competing schema marker. Do NOT alter `managed_activation` (reasoning) columns.
2. `schemaSignature` gains the new table's columns, so every existing audit's `schema_digest` changes
   ⇒ reasoning audits become stale; preserve stored profile/consent values while denying effective
   processing until re-audited (no silent "both current").
3. `decision-activation.json` mirror read/write/backup/restore beside `activation.json`; restore
   disables both and rotates the epoch.
4. CLI: add `managed:decision-activation {status|show|enable|disable}`; retain reasoning argument
   shapes, with the existing global disable stopping both stages. Record immutable stage audit events.
5. Readiness: each stage reads only its own closed schema/file; `serverCapability` exposes separate
   effective availability. A decision toggle is explicitly unavailable until its worker exists,
   while any stored true consent remains withdrawable. No new user needs to configure providers.

## Explicit decisions

| Decision | Choice |
|---|---|
| Profile shape | Separate default-off decision manifest (A), reasoning schema-1 preserved. |
| Provider | Existing `typesafe`/`cloudflare` official allowlist; protected canonical endpoint, never a key. |
| Consent | New `decision_provider_enabled` default false; required AND master `provider_enabled` AND background AND active goal. |
| Guard | Stage-scoped in `assertActivationSeam` (storage); declared stage cannot grant permission. |
| Audit/restore | New audit/enrollment; schema change stales reasoning audits; restore disables both + rotates epoch. |
| S1 boundary | Synthetic disposable root + injected transport; no production worker/timer/decision call. |
| `hasUnresolved` | Not reinterpreted; new exact slot/state reader for the decision stage. |

## S1 concrete test matrix (real SQLite, synthetic root, injected transport)

- decision `reserve → mark → settle` known-7; `not_dispatched` **after** `mark` leaves `dispatched`/null
  and a global paid pause; a `reserved` hold releases only via CAS.
- known malformed answer retains known cost + exact accepted alias; consent revoked mid-IO discards
  output, charge persists; profile disable with a pending charge settles before publish.
- unknown usage pauses all paid across accounts/stages/restart; capture/search/extractive continue.
- settled decision does not reuse the reasoning job slot; a new reasoning call after a settled
  decision is admitted only when its own slot/cap/one-inflight permit; no auto fallback/extra I/O.
- declared `decision` spec against an OpenAI-only profile denies; a reasoning spec against the
  decision manifest denies; a coincident hash cannot cross stages.
- suspension, expired/foreign job leases, stage/profile mismatch, withdrawn decision consent and
  stale/missing decision readiness deny before I/O. Scoped grant and source/goal freshness/privacy
  checks belong to S2's actual context-building/publication path; S1 does not claim those proofs.
- audit/enrollment: schema 4 staleness disables the legacy reasoning audit binding; restore disables
   both profiles, rotates the epoch; backup excludes both readiness files.

## Tests (TDD; a later plan, ≤3 vertical tasks)

1. Migration + closed decision manifest/mirror + audit/restore/backup/separate readiness + CLI.
2. Stage-scoped guard: decision vs reasoning selection, no cross-grant, declared stage cannot widen.
3. Coordinator accounting + consent: reserve/mark/pre-IO/settle, `not_dispatched` no-release, known
   malformed retention, unknown global pause, settled-slot separation.

Expected ~20 real files (helpers + integration), no speculative provider arrays.

## What this can and cannot demonstrate

**Can (S1, synthetic):** a second, independently audited, default-off decision profile beside the
untouched reasoning profile; a stage-scoped central guard that a declared stage cannot widen; and real
central+tenant accounting for the decision stage (reserve/mark/pre-IO/settle, no release/refund after a
`mark`, known-charge retention, unknown global pause, settled-slot separation, cap/one-inflight). **Cannot
(S1):** any real decision quality/cost, provider outage behavior, worker/timer execution, persisted
advisory results, or user-visible decision feature — those are S2 with a separate written spec, and live
evaluation always needs explicit authorization. Production decision activation stays OFF.

## Deferred / out of scope now

- S2 worker decision execution, timers, advisory result persistence, evidence/receipt lifecycle.
- Live provider evaluation, real per-decision cost/calibration, billing, native clients, hosting.
- Any production owner activation, real key/paid call, deploy or merge; any new telemetry sink.

## Approved implementation boundary

Written approval covers S1's schema 3→4 migration, closed provider/endpoint configuration, coordinated
restore/disable, stage-specific guards and consent/UI semantics. S2 worker execution remains separate.
Approval does not select real prices or authorize an owner activation, real key/paid call, deploy or merge.
