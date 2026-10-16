# Managed Provider Activation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `writing-plans` → `executing-plans`. Steps use `- [ ]`. TDD is mandatory: write the failing test, RUN it, observe RED, then implement. Execute ONE task, then STOP for parent review — never auto-start the next task.
>
> **Harness rules:** focused tests run serially with `npx vitest run <files> --maxWorkers=1`; then `npm run typecheck`, `npm run lint`, `npm run build` as separate commands. Do NOT run the full `npm test` or Playwright (parent owns both). Never commit, push, deploy, load a real key, or call a live provider. Never edit any `*-review` test file. Parent owns `BUILD_STATE.md`, the spec, browser runs, commits and review-file migration.

**Goal:** Add a persisted, default-off shared activation policy so the real prepared OpenAI provider can run paid work only when every gate holds, while verification never contacts a live provider.

**Architecture:** One `managed_activation` SQL row (control DB, schema 3) plus a mirrored `<root>/activation.json`, read through one read-only loader shared by server and worker. Capability = configured policy + fresh worker readiness lease (Task 3); admission stays the existing central money barrier. Paid dispatch uses the existing `PreparedReasoningProvider` with an injected/base transport.

**Tech Stack:** Node 24.19, TypeScript (strict), Fastify, `node:sqlite`, Vitest, zod, React/Vite (Task 3 only).

**Spec:** `docs/superpowers/specs/2026-10-16-managed-provider-activation-design.md` (APPROVED).

## Global Constraints

- Production managed paid processing stays hard-off after Tasks 1 and 2. Only Task 3 wires capability, and it stays default-OFF. `BRAIN_MANAGED_ALLOW_PAID=1` is an explicit deployment OPT-IN, never a bypass.
- No new dependencies; `package-lock.json` unmodified. No `ALLOW_LOOPBACK`/`TESTKEY` bypass. No secret in SQL, marker, lease, logs, fixtures or profile.
- Provider fixed `openai` / `endpoint_class="openai_responses"` / official endpoint constant. Browser/HTTP cannot supply model/price/URL; the operator supplies exact bounded model/price via the closed CLI.
- `profileConfigDigest` hashes ONLY provider params; `activationFingerprint` hashes everything except `fingerprint`; neither trusts a supplied digest.
- Pure loaders take NO env and NO caller-granted authority. An `ActivationGuard` is derived only from an installed policy created by the trusted `ManagedWorker`; it is never an authorizer.
- Fail closed on any SQL↔marker, epoch, schema, audit, lease, config mismatch. Never refund or resend a marked call; a snapshot invoice never auto-clears a block.
- Baseline (Linux CI `38889855879` at `5dd6ed0`): 479 tests / 60 files, 17 browser, 4 evals, Docker/Compose green; managed paid off.

## File Ownership

| File | Task | Role |
|---|---|---|
| `packages/domain/managed-spend.ts` | 2 | add pure `managedMoneySchemaVersion = 3` (kills the constant cycle) |
| `packages/domain/managed-activation.ts` | 1 ✅, 2 | 1 profile/digests; 2 `SendGuardPhase`, `ActivationGuard`, pure `validateActivationGuard`, `guardMatchesLive` |
| `packages/storage/managed-activation-state.ts` | 2 | **NEW** read-only primitives: row/mirror/digests/snapshot (no store/runtime imports) |
| `packages/storage/managed-activation.ts` | 1 ✅, 2 | operator store; imports state.ts; `enable`/`disable` |
| `packages/storage/managed-spending.ts` | 1 ✅, 2 | re-export the const; schema 3; optional `guard` seam |
| `packages/runtime/managed-audit.ts` | 1 ✅, 2 | import state.ts; permit-aware `scanOnce`; `readSendGuardBaseline` |
| `packages/runtime/managed-activation.ts` | 1 ✅, 2 | loader; `expectedPreparedConfigHash`, `readActivationGuardContext` |
| `packages/runtime/managed-recovery.ts` | 1 ✅ | backup/restore activation handling |
| `scripts/managed-activation.ts`, `package.json` | 1 ✅ | offline CLI + script |
| `packages/providers/prepared.ts` | 2 | extract+export pure `preparedConfigHash` (identical output) |
| `apps/worker/accounting.ts` | 2 | add optional `assertCanExecute` |
| `apps/worker/dispatch.ts` | 2 | call `assertCanExecute` directly before `call.execute` |
| `apps/worker/managed-accounting.ts` | 2 | `InstalledActivationPolicy`, guard, private attempt IDs, `assertCanExecute` |
| `apps/worker/managed.ts` | 2 | remove `accountingFactory`; freeze installed policy; fail-closed paid |
| `tests/helpers/managed-activation.ts` | 2 | create: trusted enrol + hash-matched fake provider |
| `tests/integration/managed-activation-guard.test.ts` | 2 | create (executor-owned) |
| `tests/integration/managed-worker.test.ts`, `managed-ambiguity.test.ts` | 2 | migrate paid cases to enrol a synthetic profile |
| `tests/integration/managed-activation-policy.test.ts`, `managed-activation-cli.test.ts`, `managed-epoch.test.ts`, `managed-spending.test.ts` | 1 ✅ | executor-owned |

**Parent-owned (do NOT edit):** both `managed-activation-*-review.test.ts`, `managed-audit-review.test.ts`, `managed-ambiguity-review.test.ts`, `BUILD_STATE.md`, the spec. **Preserve** `tests/integration/managed-activation.test.ts`.

---

## Task 1 — VERIFIED (parent-accepted checkpoint)

Parent-focused **52/52 across six activation/CLI files**; full suite **520 passed, 1 POSIX-only skip, 64 files, 210.43 s**; `typecheck`/`lint`/`build` GREEN. No runtime paid wiring; production paid OFF. Delivered: domain profile/digests/validators; `ManagedActivationStore` (full `validateManagedAudit` before the TX, in-TX central recheck, SQL→mirror, strict CAS disable); read-only `readActivation`/`evaluateConfiguredPolicy` with fresh root binding; schema 2→3 + `managed_activation`; recovery backup/restore (never recursive-unlinks an unrecognized marker); offline CLI with full-audit requirement and a content-free error allowlist. Not separately asserted: concurrent enable/disable mirror readback (parent-owned).

---

## Task 2 — Exact frozen-policy send guard (mains OFF)

**Goal:** every managed paid `reserve`/`mark`/pre-IO step proves the SAME frozen installed profile is still the live one, and the production `ManagedWorker` refuses paid dispatch without a ready configured policy. `apps/server/main.ts` and `apps/worker/main.ts` are NOT changed.

### 1. Cycle-safe read-only state module (fixes the money→activation→money cycle)

`managed-spending.ts` (money) must not import `managed-activation.ts` (operator store) or `runtime/managed-audit.ts`. Extract the read-only primitives into **NEW `packages/storage/managed-activation-state.ts`**, shared by the money store, runtime audit, runtime activation and the operator store. It imports only `node:sqlite` types, `domain/managed-activation`, `domain/logic`, and the `runtime/managed-operator` path helper (which imports no storage → no back-edge). It exports:
```ts
export function activationMirrorPath(root: string): string;
export function readActivationRow(db: DatabaseSync): ActivationProfile | undefined;      // actual row.schema, strict
export function readActivationMirror(root: string): ActivationProfile | undefined;        // bounded, non-link
export function activationAuditDigest(db: DatabaseSync, auditId: string): string | undefined;  // whole chosen audit
export function managedControlSchemaVersion(db: DatabaseSync): number;                    // domain constant
export function managedControlInventoryDigest(db: DatabaseSync, maxAccounts?: number, maxRows?: number): string;  // pure central
export function readGuardSnapshot(control: { db: DatabaseSync; path: string }, root: string):
  { state: "absent" | "mismatch" | "active"; profile?: ActivationProfile;
    epoch?: { epoch: number; nonce: string }; audit_digest?: string; central_inventory_digest?: string };
```
`packages/domain/managed-spend.ts` gains `export const managedMoneySchemaVersion = 3;`; `storage/managed-spending.ts` re-exports it for compatibility. `storage/managed-activation.ts`, `runtime/managed-audit.ts` and `runtime/managed-activation.ts` switch to the state module (removing their local copies). `scanOnce` stays in `runtime/managed-audit.ts` (full scan) and may import the state module.

### 2. Guard phase vs dispatch stage; exact attempt IDs

```ts
export type SendGuardPhase = "before_reserve" | "after_reserve" | "before_mark" | "after_mark";
export interface ActivationGuard {
  phase: SendGuardPhase;
  account_id: string; job_id: string; dispatch_key: string; stage: DispatchStage;   // stage = "reasoning"
  lease_owner: string; lease_fence: number; lease_expires_at: string;
  provider: string; model: string; price_version: string; request_hash: string; config_hash: string;
  reserved_micro_usd: number;
  profile_version: number; fingerprint: string; config_digest: string; epoch: number; root_nonce: string;
  schema_version: number; audit_id: string; audit_digest: string;
  expected_prepared_config_hash: string; central_inventory_digest: string;
  central_call_id: string | null; tenant_call_id: string | null;   // exact attempt ids once known
}
```
`phase` is distinct from `stage`. `before_reserve` carries `central_call_id: null`, `tenant_call_id: null` and permits **NO** nonterminal tolerance (`call_id: null` must never wildcard). On a fresh `central.reserve` success for THIS invocation, the coordinator captures the actual `central.call_id` and the resulting `tenant.call_id` plus the full immutable spec and current lease owner/fence in a **private in-memory `attempts` map** keyed by `job_id|dispatch_key|stage`. `after_reserve`/`before_mark`/`after_mark` permits require BOTH exact ids. A new coordinator/tick/process cannot inherit an old nonterminal by job slot: the map is empty, `before_reserve` forbids tolerance, so a stranded `reserved`/`dispatched` hold fails closed to an operator; an already-marked central row is never resent. No new DDL; the map is per-coordinator-process.

### 3. Frozen installed policy is always compared to the live one

`readActivationGuardContext` takes `installed: InstalledActivationPolicy` (readonly `{ root, profile }`) and MUST require the current live profile to equal it on `fingerprint`, `version`, `config_digest`, `epoch`, `root_nonce`; it must throw (never silently swap policies mid-tick). Provider identity (`provider`/`model`/`price_version`/`expected config hash`) is computed FROM `installed.profile` for the concrete kind; the kind comes from the trusted tenant job row, and an **unknown job kind throws** (never falls back to `goal`). `optIn` is bound to the installed policy: the pure loader takes no env, and `InstalledActivationPolicy` is created only by `ManagedWorker` when `evaluateConfiguredPolicy` (which reads the env opt-in) is `ready`. `readActivationGuardContext` performs full live security checks: current profile epoch/nonce == **live** epoch/nonce (not merely marker==DB), exact schema version, and the stored audit at the same epoch + schema signature. The arbitrary caller `profile` field stays ignored (returns no authority).

### 4. Real double-scan comparison + tenant baseline + snapshot inside the scan

`readSendGuardBaseline(control, root, auditId, permit: SendGuardPermit | null)`:
- `permit === null` ⇒ no tolerance: any central or tenant row that is not `settled`/`released` denies.
- `permit` set ⇒ only rows exactly matching `account_id`/`job_id`/`dispatch_key`/`stage` **and** BOTH `central_call_id`/`tenant_call_id` (when known) may be nonterminal; else deny.
- It compares the stored known baseline for BOTH `central_digest` AND `tenant_digest` of every known `managed_audit_rows` row against the live rows (tenant-only fields such as `created_at` included), plus account/config/schema/epoch — not central-only.
- It runs `scanOnce` twice and COMPARES `inventory_digest`, `control_digest`, `baseline_digest`, `file_digest`, `schema_digest` (like `auditManagedHistory`); a mismatch denies. It measures `managedControlInventoryDigest(db)` BEFORE the first scan and AFTER the second and requires them equal, returning that value as the guard's `central_inventory_digest` — no third digest is computed after returning (no unvalidated new central row accepted). Legitimate new post-baseline known/terminal/mapped rows are allowed (a second paid call needs no re-audit).

### 5. In-TX storage seam reads the full current profile AND the current mirror

`reserve(spec, guard?)` / `mark(callId, limits, guard?)` add a private `assertActivationSeam(guard, specConfigHash?)` called immediately after `BEGIN IMMEDIATE`. It uses `readGuardSnapshot({ db: this.db, path: this.control.path }, dirname(this.control.path))` (bounded filesystem checks are acceptable under the TX) and requires: state `active`; live profile `enabled`, `version`/`fingerprint`/`config_digest`/`epoch`/`root_nonce` equal the guard; the SQL row AND the mirror AND the root marker all agree; live epoch/nonce == guard; `managedControlSchemaVersion` == guard; `activationAuditDigest` == guard; `managedControlInventoryDigest` == guard `central_inventory_digest`; `guard.account_id`/`job_id`/`dispatch_key`/`stage` match the row/spec; `config_hash === guard.expected_prepared_config_hash`; `guard.central_call_id`/`tenant_call_id` match the row and permit. No tenant read and no nested writer. Guard absent ⇒ today's behaviour (low-level compatibility).

### 6. Lease and identity verified against the real trusted rows

The coordinator verifies the lease against the REAL tenant `jobs` row (`status='running'`, `lease_owner`, `fence`, `lease_until` clock) inside the preflight AND as a FINAL check after the central wait; the tenant `markDispatched` still enforces its own fence. The guard binds the full immutable spec (`request_hash`, `reserved_micro_usd`, provider/model/price) and the lease owner/fence. A pure validator (`validateActivationGuard`) checks the profile/provider/model/price fields explicitly even when `config_hash` matches, so a fake provider that declares a real hash but a different model cannot pass pre-hold. A model mismatch in the provider OUTPUT is fine (unknown hold).

### 7. Before-IO guard and no production bypass

- Add optional `assertCanExecute?(callId: string, lease: JobLease): void` to `DispatchAccounting`. `ManagedDispatchAccounting` ALWAYS implements it (read-only `after_mark` exact own `reserved→dispatched` both-match + same frozen installed policy `fingerprint`/`version`/`config_digest`/`epoch`/`root_nonce`; no central writes). `LocalDispatchAccounting`/`TenantOnlyAccounting` implement a NOOP only for local/self-hosted. `apps/worker/dispatch.ts` calls `ledger.assertCanExecute?.(record.call_id, lease)` AFTER the existing post-mark `guard()`/prefs/caps checks and DIRECTLY before `call.execute`, OUTSIDE the release catch, keeping every consent/evidence/goal/lease/cap/abort guard.
- Known settlement is unconditional: a disable after IO still settles the central actual before publication, independent of policy. A disable inside `tenant.markDispatched` (via a real SQL callback) yields zero provider calls and retains the marked/unknown hold (never refunded). A disable after IO start yields the known charge and no proposal.
- REMOVE the unused `accountingFactory` production bypass (grep shows no test callers). `providerFactory` stays a trusted transport-only seam and cannot bypass the frozen-profile check. The low-level direct `new ManagedDispatchAccounting(central, brain, clock)` (no installed policy) stays an explicit, account-bound central-money test seam and is not an HTTP/main entry point.
- `ManagedWorker`: if `evaluateConfiguredPolicy` is `ready`, freeze `InstalledActivationPolicy` and construct the coordinator with it; otherwise wire `TenantOnlyAccounting` (fail-closed) with the supplied/default provider. `providerFor` must THROW unavailable on `prepareCall` when paid is intended (`prefs.provider_enabled`) but no ready policy exists — never substitute an extractive false-success. Real capture and extractive work remain when paid is not requested.

### 8. `assertSendGuardContext` lives in domain

The pure compare helper (`assertSendGuardContext` / `guardMatchesLive`) lives in `packages/domain/managed-activation.ts` with a closed zod `validateActivationGuard` (high-security, no generic callback returning true). `runtime/managed-activation.ts` may re-export it for consumers; the money store imports the domain helper only (no runtime import). A caller object never grants authority; only the derived guard plus live state does.

### Steps

- [ ] **Step 1 — RED.** Write `tests/helpers/managed-activation.ts` and `tests/integration/managed-activation-guard.test.ts`; run them + both parent review files. Record the exact failing count.
- [ ] **Step 2 — pure constant.** Add `managedMoneySchemaVersion = 3` to `packages/domain/managed-spend.ts`; re-export from `packages/storage/managed-spending.ts`. Typecheck.
- [ ] **Step 3 — state module.** Create `packages/storage/managed-activation-state.ts` with the exports in §1; move `readActivationRow`/`readActivationMirror`/`activationMirrorPath`/`activationAuditDigest`/`managedControlSchemaVersion`/`managedControlInventoryDigest` there and re-point `storage/managed-activation.ts`, `runtime/managed-audit.ts`, `runtime/managed-activation.ts`. Add a test asserting no import cycle via `npm run typecheck` + a direct import in every consumer.
- [ ] **Step 4 — provider helper.** Extract `preparedConfigHash(...)` in `packages/providers/prepared.ts`; `prepareCall` calls it; byte-identical output; `prepared-provider*.test.ts` green.
- [ ] **Step 5 — domain guard.** `SendGuardPhase`, refined `ActivationGuard`, `validateActivationGuard` (closed zod), `guardMatchesLive(guard, live)`; re-exported by runtime.
- [ ] **Step 6 — expected hash + guard context.** `expectedPreparedConfigHash(installed.profile, kind)` and `readActivationGuardContext({ installed, kind, jobId, dispatchKey, stage, lease, phase, centralCallId, tenantCallId })` per §3, using `readSendGuardBaseline`'s returned snapshot for `central_inventory_digest`.
- [ ] **Step 7 — permit-aware scan + baseline.** Refactor `scanOnce(..., permit?: SendGuardPermit | null)` and add `readSendGuardBaseline` per §4 (`permit === null` = no tolerance; compare both scan passes; validate stored central+tenant row digests; measure the central digest before/after).
- [ ] **Step 8 — storage seam.** Add the optional `guard` to `reserve`/`mark`; implement `assertActivationSeam` per §5 using `readGuardSnapshot`.
- [ ] **Step 9 — coordinator.** Add `InstalledActivationPolicy`, the private `attempts` map (capture actual ids on fresh reserve), guard derivation per phase, and `assertCanExecute` per §7. Keep `assertHistoryEligible`, central-first settlement and every existing guard.
- [ ] **Step 10 — dispatch + worker.** Add the `assertCanExecute` call before `call.execute` in `apps/worker/dispatch.ts`; remove `accountingFactory` and wire the frozen installed policy / fail-closed paid path in `apps/worker/managed.ts`.
- [ ] **Step 11 — tests.** `managed-activation-guard.test.ts` real cases: own-stage reserved-happy and marked-happy, then a next TERMINAL call with the SAME installed profile (no re-audit self-deny); stale installed profile denies; missing profile ⇒ no hold, 0 fake calls; other-account legacy/new unmapped/reserved/dispatched denies; tenant-only baseline field tamper after enrolment denies; wrong provider model/price/config pre-hold denies; marker/mirror/profile/account/epoch race before mark denies; readiness independence; disable inside `tenant.markDispatched` ⇒ 0 calls, held marked, not refunded; unknown restart ⇒ no resend, global hold persists; known settlement after off/revocation with source/goal/consent/cap guards intact; no fake-param/no-audit widening. All model/price DUMMY, no real keys/network. Migrate executor-owned `ManagedWorker` paid cases in `managed-worker.test.ts`/`managed-ambiguity.test.ts`.
- [ ] **Step 12 — focused GREEN.** Run the 18-file set (`managed-activation-guard|policy|cli`, `worker-dispatch(|-review)`, `managed-worker`, `managed-accounting(|-review)`, `managed-spending(|-review)`, `prepared-provider(|-review)`, `managed-audit(|-review)`, `managed-ambiguity(|-review)`, `managed-money-view(|-review)`) `--maxWorkers=1`; then `typecheck`, `lint`, `build`. **STOP for parent review.**

---

## Task 2 — post-review repairs (IMPLEMENTED)

Parent independently ran 51/51 green, then expanded the guard review and reproduced 4 behavior REDs. Repaired:

1. **Expired actual job lease before admission.** `ManagedDispatchAccounting.reserve` refreshes the trusted tenant `jobs` row (running, owner, fence, future `lease_until`, `job_id === spec.job_id`) and denies BEFORE `central.reserve` commits any hold. No tenant read inside the central TX; the in-TX seam also compares `Date.parse(guard.lease_expires_at) > this.clock()` sampled after `BEGIN IMMEDIATE`.
2. **Lease expiry during the tenant mark.** The coordinator's `assertCanExecute` (run directly before `execute`) re-reads the ACTUAL tenant job row (running, same owner/fence, future deadline). A heartbeat may extend the deadline, so the lease is refreshed bounded to the original owner/fence; an expired/stale one denies. The source/goal/consent/cap/abort checks are unchanged.
3. **Fresh coordinator cannot adopt an older reserved attempt.** The private `attempts` map now stores the FULL immutable spec + original owner/fence + both ids. `markDispatched` requires the map entry (exact central id, exact tenant id, same owner/fence) and throws BEFORE `central.mark`; the `central.projection_call_id` fallback is removed for guarded calls. Low-level no-installed coordinators keep the old compatibility path.
4. **Schema shape change invalidates enrollment.** A single `centralSchemaDigest` lives in `managed-activation-state.ts` and is reused by the audit. `readEnrollmentBaseline` compares the live digest to the chosen audit's stored `schema_digest`; `readGuardSnapshot` requires the exact schema version AND carries `schema_digest`; `ActivationGuard.schema_digest` binds it; the seam and `guardMatchesLive` compare it.

Adjacent gaps closed: the seam calls `validateActivationGuard`, checks `phase` (`before_reserve` for reserve, `before_mark` for mark with non-null exact ids and `row.state === "reserved"`), matches `account_id`/`job_id`/`dispatch_key`/`stage`/provider/model/price/`request_hash`/`config_hash`/`reserved_micro_usd`, forbids a null tenant wildcard, and `readGuardSnapshot` now asserts fresh root/control containment plus the profile ROW epoch == current epoch. `SendGuardPermit` gained an exact `state` (`reserved` for `after_reserve`/`before_mark`, `dispatched` for `after_mark`). `apps/server/main.ts`, `apps/worker/main.ts`, `package-lock.json`, the spec, `BUILD_STATE.md` and every `*-review` file were not touched.

## Task 3 — Shared bootstrap, readiness capability, consent UI (verified locally; see final checkpoint)

**Goal:** make the approved activation path reachable end-to-end while `apps/server`/`apps/worker` mains remain default-OFF, and prove it with real subprocesses over a synthetic fake transport. Capability (policy + fresh readiness) never equates to admission, consent or quality.

### Exact files / APIs

| File | Role |
|---|---|
| `packages/runtime/worker-readiness.ts` (new) | bounded readiness lease read/write/remove |
| `packages/runtime/managed-activation.ts` (mod) | add `serverCapability` |
| `apps/server/startup-gates.ts` (mod) | replace hard-false `managedPaidAvailable` with `managedCapability` |
| `apps/server/app.ts` (mod) | `/api/v1/runtime` capability + status/prefs consent |
| `apps/server/main.ts` (mod) | wire capability; local path unchanged |
| `apps/worker/main.ts` (mod) | bootstrap + heartbeat + shutdown |
| `apps/worker/managed.ts` (mod) | frozen boot snapshot; no per-tick rebind |
| `packages/domain/service.ts` (mod) | raw `backgroundConsent`, status consent/capability, managed prefs merge |
| `apps/web/src.tsx` (mod) | consent checkbox from stored consent |
| `tests/helpers/provider-preload.mjs` (new) | test-only official-endpoint fetch interceptor |
| `tests/integration/managed-activation-process.test.ts` (new) | real server+worker subprocess proof |
| `tests/integration/managed-activation.test.ts` (migrate) | baseline hard-off → default-OFF same assertions |

```ts
// packages/runtime/worker-readiness.ts
export interface WorkerReadiness { schema:1; worker_id:string; epoch:number; root_nonce:string;
  activation_fingerprint:string; config_digest:string; provider:"openai"; model:string; price_version:string;
  endpoint_class:"openai_responses"; booted_at:string; heartbeat_at:string; expires_at:string; }
export function writeWorkerReadiness(root:string, r:WorkerReadiness): void;      // 0600 tmp+rename, no links
export function readWorkerReadiness(root:string, now:Date): { state:"ready"|"stale"|"absent"; readiness?:WorkerReadiness };
export function removeWorkerReadiness(root:string, workerId:string): void;       // own worker_id only
// packages/runtime/managed-activation.ts
export function serverCapability(input: { configured:{ready:boolean;reason:ActivationReason};
  readiness:{state:"ready"|"stale"|"absent"; readiness?:WorkerReadiness}; profile?:ActivationProfile }):
  { ready:boolean; reason:ActivationReason };
// packages/domain/service.ts
backgroundConsent(p: Principal): boolean;                                          // RAW stored, own account
// apps/server/startup-gates.ts
export function managedCapability(input:{ control:AuditControl; root:string; now:Date; optIn:boolean }):
  { available:boolean; reason:ActivationReason };
// apps/worker/managed.ts
export type ManagedWorkerOptions = { providerFactory?:(brain:Brain)=>PreparedProvider;
  bootstrap?: InstalledActivationPolicy };                                         // frozen at boot, not per tick
```

### Steps

- [ ] **Step 1 — RED.** Write `tests/helpers/provider-preload.mjs` and `tests/integration/managed-activation-process.test.ts`; run them → module/export-absence RED (record the exact count).
- [ ] **Step 2 — readiness lease.** `worker-readiness.ts`: strict schema (the 12 fields; int `epoch`; 64-hex `root_nonce`/`activation_fingerprint`/`config_digest`; no version counter that leaks); `expires_at - heartbeat_at <= 15s`, `booted_at <= heartbeat_at <= expires_at`, future boot/heartbeat/expires deny; missing/malformed/symlinked → `absent`/`stale` (never throw on the read path). Read-only server never writes.
- [ ] **Step 3 — `serverCapability`.** Add to `runtime/managed-activation.ts`: `configured.ready` AND `readiness.state==="ready"` AND the readiness `epoch`/`root_nonce`/`activation_fingerprint`/`config_digest`/`provider`/`model`/`price_version`/`endpoint_class` equal the live profile's values AND the profile is the currently stored enabled one. Reason precedence: configured reason first, then `worker_absent`/`worker_stale`/`worker_config_mismatch`.
- [ ] **Step 4 — `managedCapability`.** `apps/server/startup-gates.ts`: `evaluateConfiguredPolicy(...)` (env opt-in) + `readWorkerReadiness(root, now)` → `serverCapability`. Delete the hard-false `managedPaidAvailable`; keep `managedActivationGate` (pure) if still referenced. `apps/server/main.ts` passes `capability: () => managedCapability(...)` to `createApp`; the local branch is untouched.
- [ ] **Step 5 — runtime route + status + PATCH.** `apps/server/app.ts`: `/api/v1/runtime` returns `connected_processing_available: managed ? cap.available : false` and `managed_paid_reason: managed ? plainStaticReason(cap.reason) : null` (static, content-free). Never flip it false for `usage_pending`. Authenticated `status` gains own-account `spend.capability_ready`, `spend.stored_consent_active` (raw bool) and `spend.consent_effective` (`stored && capability && configured && !durableBlock`, excluding `usage_pending`). Managed PATCH parses a `managedBackgroundPatchSchema` with optional `provider_enabled`; when omitted, merge the RAW stored value (never the effective getter). `true` requires `capability_ready` (else 503); `false` always succeeds on an ACTIVE account (suspended still 401). GET prefs keeps the legacy effective shape — no new read-only fields.
- [ ] **Step 6 — domain.** `packages/domain/service.ts`: `backgroundConsent(p)` returns the raw stored `provider_enabled` (own account only, no write). Keep the existing durable-block re-enable denial unchanged (monetary blocks are never cleared by consent — do NOT relax; flag to parent if the spec is read otherwise). `status` composes the new `spend` fields from a `capability` accessor supplied by `ManagedRuntime`.
- [ ] **Step 7 — UI.** `apps/web/src.tsx`: checkbox value from `today.status.spend?.stored_consent_active`; enabled to turn OFF whenever stored true (even unavailable/busy/blocked) and to turn ON only when `capability_ready`; keep a per-`authGeneration` controlled value and send `provider_enabled` ONLY when the user explicitly toggled it. `resetPersonalState`/invalidation must clear the new controlled field; late responses fenced by `authGeneration`.
- [ ] **Step 8 — worker bootstrap.** `apps/worker/main.ts`: `evaluateConfiguredPolicy` (no readiness input) → if ready, read the profile, require key presence (no network health lookup), instantiate `PreparedReasoningProvider` with the profile's model/prices/accepted order/max tokens and the fixed endpoint, build `installed = { root, profile }`, construct `ManagedWorker(runtime, { providerFactory: () => provider, bootstrap: installed })`, then write the lease and start an awaited 5 s `setInterval` heartbeat. The heartbeat re-reads the live profile and only refreshes while it equals the frozen install and key presence holds; otherwise it withdraws its OWN lease (by `worker_id`). Not ready → `ManagedWorker(runtime)` (extractive). Shutdown: clear the timer, `await worker.stop()`, `removeWorkerReadiness(ownId)`, `runtime.close()`.
- [ ] **Step 9 — frozen boot snapshot.** `apps/worker/managed.ts`: resolve `installed` ONCE (from `options.bootstrap` when present, else `installedPolicy()`), cache it on the instance, and never upgrade per tick; a live profile that differs makes the Task 2 seam deny. `providerFactory` stays transport-only. No env-flag bypass; key rotation is a restart (documented).
- [ ] **Step 10 — process tests.** `managed-activation-process.test.ts` spawns the real `apps/server/main.ts` + `apps/worker/main.ts` (pattern in `managed-process.test.ts`) with `NODE_OPTIONS=--import tests/helpers/provider-preload.mjs`, a scrubbed env (no inherited `OPENAI_API_KEY`/mode), a synthetic dummy key, and a signed synthetic OIDC issuer. Preload intercepts ONLY `https://api.openai.com/v1/responses`, returns schema-correct known usage, and throws for any other URL. Cases: default-OFF (env `=1` alone) → metadata false, prefs 503, capture persists, zero fake fetches; all-gates → exactly one known-7 dispatch; worker started BEFORE the server still ready (no own-lease bootstrap); two-account global unknown hold + restart no resend + capture persists; long provider await with an independent 5 s heartbeat (capability stays true, own `usage_pending` never invalid); missing key/price/mismatch/model-wrong/future-stale readiness → metadata false, no new hold; disable by CLI/consent while awaiting → 0 sends, hold retained; after IO start revoke → known 7 settles, no output.
- [ ] **Step 11 — migrate baseline.** Update the executor-owned `managed-activation.test.ts` hard-false assertions to the new default-OFF behaviour (same assertions, default-OFF); keep the positive cases separate. If a fixture needs adaptation, report to the parent rather than editing a `*-review` file.
- [ ] **Step 12 — focused GREEN.** Run the new process file + `managed-activation.test.ts` + all Task 1/2 activation, worker, accounting, spend, audit, ambiguity, money-view, restore/recovery files `--maxWorkers=1`; then `typecheck`, `lint`, `build`. Parent owns Playwright and the full suite. **STOP for parent review.**

### Risks / decisions

- **Durable re-enable:** preserved as today (a durable money block denies re-enable); consent never clears a monetary block. Raised as a contract to confirm, not silently relaxed.
- **Restart semantics:** a persistent opt-in + enabled profile survives an ordinary restart; a supported restore forces OFF and rotates the epoch (Task 1).
- **Key handling:** the server never reads or hashes the provider key; readiness only proves presence. The worker reads the key once at install; rotation is a restart, documented.

## Self-Review

- Task 1 and Task 2 are recorded as verified with the parent's real counts; the initial Task 2 module-absence RED (zero executable bodies) is stated as module absence, not behavior, and the later parent-reproduced behavior REDs are listed with their repairs.
- Task 3 keeps capability, admission and consent separate; the loader stays read-only and env-free; the frozen boot snapshot prevents a silent per-tick rebind.
- No placeholders; each step names exact files, signatures and RED/GREEN commands.

---

## PAUSED CHECKPOINT (Task 3, 2026-10-16) — user paused; do not auto-resume

The user paused Task 3 at a safe point. No source/build/test/model work resumes until the user explicitly continues.

**Completed (working tree, uncommitted):**
- `packages/runtime/worker-readiness.ts` (new): strict bounded lease; `readWorkerReadiness` now rejects a linked root/file chain (parent `managed-readiness-review.test.ts` 17/17 green).
- `packages/runtime/managed-activation.ts`: added pure `serverCapability(...)`.
- `packages/runtime/managed.ts`: added `managedCapability(...)` + injected the closed `capability` getter into `Brain`; `ManagedRuntimeOptions.capability` returns `{ready, reason}`.
- `apps/server/startup-gates.ts`: `managedCapability` re-export, `managedPaidReason`, `managedAllowPaidFlag`; removed the hard-false `managedPaidAvailable`.
- `apps/server/app.ts`: `/api/v1/runtime` uses the capability accessor (`{available, reason}`); PATCH gates explicit `provider_enabled:true` on capability (503) and otherwise delegates to the domain.
- `apps/server/main.ts`: wired the capability accessor.
- `packages/domain/service.ts`: `backgroundConsent` raw getter; managed PATCH via `managedPreferencesPatchSchema` (optional `provider_enabled`, merges RAW, skips the grant check when omitted, explicit false always allowed, explicit true refused under durable block/unconfigured policy); `status.spend` adds `capability_ready` / `stored_consent_active` (raw) / `consent_effective`.
- `packages/contracts/index.ts`: `managedPreferencesPatchSchema`.
- `apps/web/src.tsx`: consent checkbox reads raw `stored_consent_active`, per-`authGeneration` override, sends `provider_enabled` only when toggled; `resetPersonalState` clears it.
- `apps/worker/managed.ts`: `options.bootstrap` frozen snapshot resolved ONCE (never per-tick upgrade), explicit fail-closed `unavailableProvider` (no lazy env key), `accountingFactory` already removed.
- `apps/worker/main.ts`: bootstrap independent of own readiness, key-presence only (no network health), freeze installed profile, write lease + awaited 5 s heartbeat (TTL 15 s) that withdraws only its own lease, graceful shutdown removes its own lease.

**Verification actually observed (executor, Windows/Node 24.19):**
- `typecheck` GREEN; `build` GREEN.
- `lint` FAILED: 2 `prefer-const` errors in the PARENT-owned review files `tests/integration/managed-consent-review.test.ts` and `tests/e2e/managed-consent-review.spec.ts`. Not edited (parent-owned); parent adapt requested.
- Focused GREEN: `managed-consent-review` + `managed-readiness-review` + `worker-readiness` + `managed-activation` + both guard suites (56 passed / 1 POSIX skip); `status-spend` + `status-spend-review` + `managed-consent-review` (13 passed) after a one-line regression fix.

**Incomplete / unverified:**
- `tests/helpers/provider-preload.mjs` and `tests/integration/managed-activation-process.test.ts` NOT written.
- The long-IO heartbeat process proof and the parent's `tests/e2e/managed-consent-review.spec.ts` NOT run (parent owns Playwright).
- No full `npm test` run; the broad focused run before the regression fix showed 249 passed / 2 failed (both fixed); not re-run end-to-end after the fix.

**Remaining next step (on explicit user continue):** write the provider preload + process suite, then run the full Task 3 focused set serial and the quality gates.

**Known working-tree status:** UNVERIFIED as a whole (Task 3 implementation is partially complete; `lint` is blocked by parent-owned review fixtures). No children/servers/heartbeats were left running by the executor; no commit/push/deploy occurred.

---

## RESUMED — IN PROGRESS (Task 3), honest status (executor)

Resumed on explicit user request. Tasks 1/2 not redone. Work this session:

- Added `tests/helpers/provider-preload.mjs` (worker-only fake fetch; official Responses endpoint only, throws otherwise; bounded counter line with event+model only).
- Added `tests/integration/managed-activation-process.test.ts` (real server+worker subprocesses; 3 cases: default-OFF zero calls, configured all-gates one known call, missing key no hold) plus a fourth in-progress case (invalid dummy key). Added `BRAIN_MANAGED_ALLOW_PAID: "1"` to BOTH child envs.
- Earlier Task 3 source (worker bootstrap/heartbeat, readiness lease, `serverCapability`/`managedCapability`, server route + PATCH, domain `backgroundConsent`/status consent fields + managed prefs patch, UI consent checkbox) is present and `typecheck` GREEN.

**Observed this session (executor):**
- `typecheck` GREEN. Earlier `build` GREEN.
- `managed-activation-process.test.ts` is **RED / not settled**: the "boots real server+worker" case timed out waiting for the default-OFF extractive brief (worker did not produce a brief within the deadline) — cause not yet diagnosed (worker startup/output not yet inspected). The invalid-key case currently passes for the wrong reason (server opt-in env was previously missing) and needs re-check after the env fix.

**Newly required (parent, still to implement before Task 3 can be claimed):**
- Production readiness at send time: after bootstrap, the actual production provider must require a FRESH own-worker readiness lease (own `worker_id` + FP/epoch/config) at `prepare` and re-check it immediately before `execute`; a failed/tampered/expired lease ⇒ truthful unavailable with NO new hold, while already-running IO continues to a known charge. Must not require readiness during bootstrap or heartbeat (self-deadlock). A minimal closed wrapper in `apps/worker/main.ts` around the real provider is the suggested shape.
- `status.spend.available` must be a real derived admission usability (capability && raw consent && configured && !durable && service/allowance/remaining headroom), not always `false`; public capability stays independent of busy.
- UI: replace the hard-coded "not available/not enabled" copy with conditional readiness/consent/paused copy; managed provider label from readiness, not server env.

**Known working-tree status:** UNVERIFIED. Not claimed complete. No commit/push/deploy; no real key/network/owner activation. Next step on continue: diagnose the OFF-brief worker startup, add the production readiness wrapper, finish the status/UI availability, then run the focused set + gates.

---

## SLICE 3A — COMPLETED (executor, for parent review)

Root cause of the earlier process RED: `NODE_OPTIONS="--import tests/helpers/provider-preload.mjs"` used a bare specifier (`ERR_MODULE_NOT_FOUND: Cannot find package 'tests'`), so the worker crashed before main for every case. Fixed by passing a file URL — `pathToFileURL(resolve(PRELOAD)).href` — in the worker-only `--import`, and by asserting child liveness/exit and actual job status rather than a blind sleep.

Implemented this slice:
- `tests/helpers/provider-preload.mjs` (worker-only fake fetch, official Responses endpoint only, bounded counter).
- `tests/integration/managed-activation-process.test.ts` (3 cases, both child envs `BRAIN_MANAGED_ALLOW_PAID=1`): default-OFF runs a real extractive brief with 0 fake calls; all-gates (worker BEFORE server) publishes own readiness, capture → exactly one prepared Responses call → known 7 and an evidence brief with the job-id string asserted; missing key and invalid dummy key (`\n` control char) stay alive, publish no readiness, create no hold, and persist capture.
- `apps/worker/main.ts`: offline adapter-config validation via one no-I/O `prepareCall` before install; production send-time fencing — the real provider requires a FRESH OWN readiness lease (own `worker_id`) at `prepare` and again immediately before `execute`; `beat()` re-runs `evaluateConfiguredPolicy` (cheap baseline) + frozen FP before publishing, else withdraws only its own lease.
- `packages/domain/service.ts`: `status.spend.available` is now a real derived admission usability (capability && raw consent && configured && !durable && service/allowance/day/per-job headroom); public capability stays independent of busy.
- `apps/web/src.tsx`: conditional readiness/consent/busy copy, managed label from readiness (not server env), and false→on gated on capability+configured+non-durable while true→off is always enabled.

Verified (serial, Windows/Node 24.19): `typecheck`, `lint`, `build` GREEN. Focused **11 files, 82 passed, 1 POSIX skip** (process 3, consent 7, readiness 17, worker-readiness, activation, guard+guard-review 17, ambiguity+review, status-spend+review); regression **11 files, 114 passed** (worker, accounting, money-view, dispatch, prepared, activation policy/CLI). No full suite/Playwright (parent-owned); no commit/push/deploy; no real key/network/owner activation.

Remaining (Slice 3B, no human re-approval needed): long-IO heartbeat ≥16 s proof, restart/no-resend + two-account global-hold, unknown-model/malformed-output retention, and the parent's Playwright journeys.

---

## SLICE 3B — historical progress (superseded by final checkpoint)

Completed:
- **Honesty fix 1:** `apps/worker/main.ts` `ownReadinessFresh` now reuses pure `serverCapability(configured ready, readiness, installed.profile)` plus the own-`worker_id` check, so it compares EVERY frozen field (FP/epoch/root_nonce/config/provider/model/price/endpoint), not just the worker id on a tampered wrong-FP lease.
- **Honesty fix 2:** the invalid-key and missing-key process cases now assert the job id is a string, poll the REAL `/api/v1/jobs/:id` until a terminal state (`failed`), assert both children are alive, assert the original capture persists, and assert 0 counter lines and 0 central rows (no blind `delay`); the default-OFF branch asserts both children alive before stopping.
- **Honesty fix 3:** `tests/helpers/provider-preload.mjs` now requires the exact normalized `href === OFFICIAL` AND `POST` (rejecting credential/query/path drift), caps the counter at 32 lines, parses the body before recording the requested model, and supports TEST-ONLY `FAKE_PROVIDER_MODE` (`ok`/`wrongmodel`/`malformed`) and a bounded `FAKE_PROVIDER_RELEASE` hold.
- **Scenario C implemented and green:** a malformed provider payload (accepted model + known usage 500/200, `text="NOT_JSON_PAYLOAD"`) → exactly 1 fake call, central+tenant **settled 7**, job `failed`, no brief, capture persists.
- Test cleanup made tolerant of a Windows WAL file lock (best-effort `rmSync`) so passing assertions are not failed by teardown.

Verified (serial): `typecheck`, `lint`, `build` GREEN; focused **16 files, 144 passed, 1 POSIX skip** (process 4 cases, consent 7, readiness 17, guard 17, worker, accounting, spending, audit, recovery).

### Scenario B — IMPLEMENTED (unaccepted model UNKNOWN hold + worker restart no-resend + B extractive)

`tests/integration/managed-activation-process.test.ts` now has **6 cases** and is GREEN (**51.5 s serial**). Scenario B: two accounts (A and B) are provisioned with positive policies/periods and RAW consent BEFORE the enrollment audit (so the profile binds both). The worker uses `FAKE_PROVIDER_MODE=wrongmodel`, so the real adapter returns a valid response with reported usage but an UNACCEPTED returned model → accounting UNKNOWN. A's capture makes exactly one fake call, the job fails, and the central row stays `dispatched`/actual-null (never an invented known 0) with no brief; A's own status shows RAW consent retained, capability TRUE, `paused_reason: usage_pending`, `blocked: true`. B's paid capture adds NO new central row and NO new fetch. The real worker is then stopped and a FRESH worker spawned on the same root/profile (no re-enroll/re-audit): capability becomes ready with a new worker id, a real HTTP retry of A's job produces no resend and the same `call_id` stays `dispatched`/actual-null, a new B capture still adds no hold, and a fresh control-DB connection proves the carried global barrier. Then B's real HTTP PATCH (`provider_enabled:false`, full prefs body from GET) is accepted despite the global unknown, and a new B capture yields an actual **Extractive preview** brief citing its new source — while A's unknown hold is still retained and the counter stays exactly 1 across both worker instances. `typecheck`/`lint`/`build` GREEN; focused regression **19 files, 162 passed, 1 POSIX skip**.

At this executor checkpoint only the parent's final independent full-test/browser/eval/audit/docs verification remained; see the completed final checkpoint below. No new production defect was found in either scenario.

**Case B assertion strengthening (test-only):** the test now captures the ORIGINAL worker id + A's held row (`call_id` is a string, central AND tenant rows `dispatched`/actual-null) BEFORE restart; after restart it waits for a genuinely NEW worker id whose lease matches the frozen profile (not merely the old lease inside its TTL) with both children alive; the retry is asserted as HTTP 200 (or, if refused, a static error code + terminal job) then polls the real job to `failed` with a changed `attempts`/`fence`, and re-asserts the SAME central `call_id` held across restart; the new B2 capture is asserted to create no B hold (job terminal, 0 rows), persist its source, and leave the counter at 1; and the B3 extractive brief is matched by `source_versions` containing that exact new source id, not "any brief". `cleanup()` remains tolerant of a Windows WAL lock (synthetic temp only) — an explicit accepted limit.



### Scenario A — IMPLEMENTED (long-IO heartbeat + real CLI disable)

At its initial checkpoint the process file had **5 green cases** (**46.6 s serial**). Scenario A holds one synthetic Responses call for **≥16 s**, beyond the initial 15-second TTL. The real APIs/SQLite still report a running job, dispatched unknown hold, live capability and effective consent; the readiness heartbeat advances through **≥3 distinct values**. A real CLI disable immediately removes capability and the next heartbeat withdraws readiness while I/O remains held. Releasing the response settles **7 micro-USD** centrally and in the tenant journal, discards output, retains capture and never sends again.

## Final parent checkpoint — Tasks 1–3 accepted locally

- [x] Audited default-off profile, exact SQL/mirror persistence, strict operator CLI and restore disablement.
- [x] Frozen-policy current-attempt guards, lease fencing, all-account mapping and retained known/unknown accounting.
- [x] Production bootstrap, exact own-worker readiness, independent heartbeat and fail-closed pre-I/O checks.
- [x] Raw/effective consent separation, unrelated-save preservation, authorized withdrawal and truthful status/UI.
- [x] Six real server/worker synthetic-provider process scenarios, including long I/O and cross-account unknown-usage worker restart.
- [x] Parent full rerun after strengthened restart assertions: **579 passed, 2 POSIX-only skips, 70 files**, 280.66 s; typecheck/lint passed again.
- [x] Parent build; **19 Chromium journeys**; **4 offline evaluations**; dependency audit **0 vulnerabilities**. Runtime/UI unchanged after those checks; reference screenshots restored.
- [ ] New Linux/container CI for this branch, separately authorized capped live-provider smoke/quality, target-host storage/operations, billing, native-client and human/licensing release gates.

Detailed RED/repair steps above are historical implementation instructions; this checklist and BUILD_STATE.md record the final verified scope. No real provider key, owner activation, paid runtime call, commit, push or deployment occurred. The worktree remains preserved for the owner's integration decision.
