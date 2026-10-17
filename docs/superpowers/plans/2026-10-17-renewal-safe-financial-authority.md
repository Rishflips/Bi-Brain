# Renewal-safe financial authority (B0) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `writing-plans` → `executing-plans`.
> Steps use `- [ ]`. TDD: write the failing test, RUN it, observe RED, then implement.
> Execute ONE task, then **STOP for parent review**. Parent owns every `*-review` file,
> browser/E2E runs, `BUILD_STATE.md`, indexes and all git operations. No commits here.
> **Nothing in this plan is implemented, accepted or verified because this file exists.**

**Goal:** Implement the approved B0 authority — schema 5, sealed authority log, immutable
grant→period projection, runtime admission/freshness/grants and offline enrollment — default
OFF, with synthetic injected tests only.

**Architecture:** A static frozen operator policy + a rare keyed authority log (HMAC-SHA256)
in the control DB, plus a separate signed per-account freshness projection. A verified grant
materializes exactly one immutable `managed_account_periods` row via a dedicated writer; the
existing `account_period_id` FK and all historical money bytes are unchanged.

**Tech Stack:** Node 24.19, TypeScript (strict), zod, `node:sqlite`, Vitest 5.0.2. No new deps.

**Spec:** `docs/superpowers/specs/2026-10-17-renewal-safe-financial-authority-design.md`
(APPROVED). B1 (`…-paddle-billing-design.md`) is context only — UNAPPROVED, out of scope.

## Parent review status (2026-10-17)

- **T1 — ACCEPTED LOCALLY.** Parent independently verified 162 focused checks across
  five files at 22:21:56, including 99 B0 checks (32 executor + 67 parent), and fresh
  typecheck/lint/build. Calendar-reference, UUID and validation/serialization snapshot
  defects were reproduced and repaired. Evidence: `BUILD_STATE.md` and
  `test-results/billing-authority-task1-parent.json`. No schema/runtime consumer exists.
- **T2, T3, T4 — NOT READY; PAUSED.** They must not be executed until a separate refinement.
  Known blockers, recorded so they are not lost:
  - T2 exposes a public `append(frame, expectedHead)` while T1 defines the writer as a
    **private validated writer**; a public arbitrary-body append contradicts the approved
    design. T2 needs typed, purpose-specific **inputs** (not a raw frame) and a private writer.
  - The T2 “complete closed B1 inbox/event DDL” is undefined here: we must not invent full B1
    tables. Either declare exact tables or defer them.
  - No T2–T4 schema/migration/storage implementation exists or is authorized by this
    incomplete planning section; the accepted T1 pure modules do exist.

**Parent storage review:** T2K, T2L and T2P are accepted locally. Parent's 23:00:25
gate passed 321 focused tests with six platform skips, plus typecheck/lint/build;
see `BUILD_STATE.md` and `test-results/billing-authority-prerequisites-parent.json`.
Money remains 4. Next writer planning is in
`2026-10-17-billing-authority-writer.md`; it is not executable before parent review. The broader
T2 plan remains unapproved: `body_json` alone cannot reconstruct T1's signed root/policy/
source fields; typed `Validated*Record` names alone cannot prove evidence provenance; and
an incomplete B1 inbox adds a future migration obligation without useful B0 behavior.
Defer B1 DDL until its separately approved initial installation (requiring another reviewed
schema digest/enrollment). Do not install a partial money-5 schema now. Keep money at 4
until the complete B0 financial storage contract is reviewed. These are implementation
ordering refinements, not permission to drop any authority check or silently alter B1.

## Global Constraints

- Business rules approved: India individual/sole-proprietor; monthly + annual; monthly
  allowance **no rollover**; **no automatic overages**. Prices/allowance numbers are NOT
  approved — every amount is required config with default `0`; no automatic key/profile/payment
  enable. “No network keys” means no provider credentials or secrets: **SYNTHETIC in-memory
  key bytes in tests are allowed**.
- Tenant v5 unchanged; central money **4 → 5** is one explicit offline migration for the
  operator’s own key enrollment. Historical money rows, providers, resolutions and the
  `account_period_id` FK stay byte-identical. No parallel money ledger. The app never touches
  the owner local DB.
- Preserve the verified baseline (984 tests, 2 POSIX skips, 98 files, 24 browser, 4 offline);
  do NOT rerun the full suite while writing/executing a focused task.
- Manual mode is explicit and preserves all legacy account/inventory/period audit semantics.
  Billing mode only under a root with an explicitly installed policy + verified key commitment
  + static catalog; a missing policy/key is deny, never an implicit manual fallback. No
  `signed-grant` mass endpoint, no `authorized: true`.
- New billing caps must equal the sealed admission + static catalog, never a raw unsealed SQL
  cap. No tenant DB open inside a control write TX: bounded read-only preflight, then a publish
  TX that rechecks central identity/root/epoch/policy/financial-absence.
- Unknown holds still subtract from a new period; the global unknown/cross-stage barriers stay
  untouched; the same four caps apply; `settleKnown` is allowed after expiry/revocation.
- Test fixtures are labelled `SYNTHETIC`; no credentials, network, ports or live calls.

## File Ownership (closed)

- **T1 new domain:** `packages/domain/billing-authority.ts`, `packages/domain/billing-seal.ts`;
  test `tests/integration/billing-authority-domain.test.ts`.
- **T2K approved next:** `packages/storage/billing-key.ts` and
  `tests/integration/billing-authority-key.test.ts` only. Parent owns
  `tests/integration/billing-authority-key-review.test.ts`.
- **T2 (otherwise paused) new storage:** `packages/storage/billing-authority.ts`,
  `packages/storage/billing-key.ts`; helper `tests/helpers/managed-v4-fixture.ts`; tests
  `tests/integration/billing-authority-storage.test.ts`,
  `tests/integration/billing-authority-log.test.ts`,
  `tests/integration/billing-authority-projection.test.ts`.
  **Modify:** `domain/managed-spend.ts` (version 5 only), `storage/managed-spending.ts`
  (append the inert `control_billing_*` DDL to `MONEY_DDL`).
- **T3 (paused) new:** `packages/domain/billing-admission.ts`,
  `packages/runtime/billing-authority.ts`; test
  `tests/integration/billing-authority-runtime.test.ts`. **Modify:**
  `storage/managed-spending.ts` (grant→period materialization inside the financial TX),
  `runtime/managed-activation.ts`, `storage/managed-activation-state.ts` and
  `runtime/managed-audit.ts` (the coherent duplicate split of `accountConfigHash`/
  `configDigest` plus `billingAuthoritySchemaDigest` integration — never a field dropped).
- **T4 (paused) new:** `scripts/managed-billing-enroll.ts`; tests
  `tests/integration/billing-authority-recovery.test.ts`,
  `tests/integration/billing-authority-process.test.ts`. **Modify:**
  `packages/runtime/managed-recovery.ts`, `apps/worker/main.ts`, `apps/server/main.ts`,
  `package.json` (one script line).
- **No** transport/webhook/checkout/UI/account code. No other files.

## Interfaces (Produced — exact names; every later task must reuse these)

```ts
// packages/domain/billing-authority.ts  (pure; no IO/provider/storage, no Date.now)
export const BILLING_FRESHNESS_MAX_MS: number;   // 15 * 60 * 1000
export const BILLING_MAX_FRAME_BYTES: number;    // 16 * 1024
export const BILLING_MAX_SOURCE_IDS: number;     // 16
export type Cadence = "monthly" | "annual";
export type UnavailableReason = "no_admission" | "no_grant" | "stale" | "past_due"
  | "canceled" | "refunded" | "conflict" | "suspended" | "policy_mismatch";
export type BillingEligibility =
  | { state: "granted"; window_id: string; window_start: string; window_end: string; grant_proof: string }
  | { state: "unavailable"; reason: UnavailableReason };
export interface BillingWindowInput {
  account_id: string; subscription_ref: string; cadence: Cadence;
  paid_term_start: string; paid_term_end: string; now: Date;
}
export interface BillingWindow { window_id: string; window_start: string; window_end: string; index: number }
export type BillingWindowResult =
  | { state: "window"; window: BillingWindow }
  | { state: "unavailable"; reason: UnavailableReason };
export function billingWindow(input: unknown): BillingWindowResult;
export function windowId(input: unknown): string;
export function clampAddMonths(anchorIso: string, months: number): string;
export function paidTermFreshUntil(verifiedAt: Date, paid_term_end: string): Date;
export function admissionExpiresAt(termFreshnessEnd: Date, current_window_end: string): Date;

// Pure lookup view carried from the approved B0 spec (owned here; consumed later in T3).
export interface StoredPaidTermReference {
  term_id: string; receipt_id: string; account_binding: string;
  subscription_ref: string; transaction_ref: string;
  term_start: string; term_end: string; cadence: Cadence;
  window_id: string; window_start: string; window_end: string;
  policy_id: string; root_epoch: number; provenance_mac: string;
}
export function validateStoredPaidTermReference(input: unknown): StoredPaidTermReference;

// packages/domain/billing-seal.ts  (pure; caller supplies 32 private bytes)
export type SealPurpose = "grant" | "admission" | "revocation" | "freshness";
export interface SealBase { schema: 1; purpose: SealPurpose; epoch: number; root_nonce: string;
  policy_id: string; source_ids: string[]; ordinal: number; prev_mac: string }
export interface AdmissionSealBody { account_id: string; identity_digest: string;
  tenant_incarnation: string; clean_baseline_proof: string }
export interface GrantSealBody { account_id: string; window_id: string; term_id: string;
  period_id: string; window_start: string; window_end: string; allowance_micro_usd: number }
export interface RevocationSealBody { account_id: string; term_id: string; adverse_generation: number;
  reason: "past_due" | "canceled" | "refunded" | "conflict" | "suspended" | "policy_mismatch" }
export interface FreshnessSealBody { account_id: string; term_id: string; verified_at: string;
  expires_at: string; revision: number; adverse_generation: number }
export type SealFrame =
  | (SealBase & { purpose: "grant"; body: GrantSealBody })
  | (SealBase & { purpose: "admission"; body: AdmissionSealBody })
  | (SealBase & { purpose: "revocation"; body: RevocationSealBody })
  | (SealBase & { purpose: "freshness"; body: FreshnessSealBody });
export function canonicalSealFrame(frame: unknown): string;       // invalid -> throws BrainError INVALID_INPUT
export function sealMac(frame: unknown, privateBytes: Uint8Array): string; // invalid -> throws
export function verifySealMac(frame: unknown, privateBytes: Uint8Array, mac: unknown): boolean; // fail-closed false
```

Exact field rules: frame `schema:1`; `purpose` one of the four; `epoch` safe integer `>=1`;
`root_nonce` hex64; `policy_id` token 1..200 `[A-Za-z0-9:_-]`; `source_ids` non-empty, unique,
`<= BILLING_MAX_SOURCE_IDS`, each token 1..200; `ordinal` safe integer `>=0`; `prev_mac` is
`""` iff `ordinal === 0` else hex64. Body fields: uuids as uuids; digests hex64; `window_start`/
`window_end`/`verified_at`/`expires_at` canonical UTC; `allowance_micro_usd` integer
`0..maxMicroUsd`; `expires_at` strictly later than `verified_at` and `<= 15 min`;
`revision integer >=1`; freshness `adverse_generation integer >=0`, revocation
`adverse_generation integer >=1`. Unknown keys anywhere, unsupported
purpose/schema, floats/NaN/Infinity, empty/dup/over-max sources, bad dates and non-canonical
normalization are rejected. Canonical UTF-8 must be `<= BILLING_MAX_FRAME_BYTES`. `sealMac`
takes only a 32-byte `Uint8Array`; `verifySealMac` returns `false` for any malformed frame,
key or MAC (never throws). Constant-time compare over 32 decoded bytes after hex-length
validation. No `Date.now`, randomness or authority claim in any pure method.

Calendar rules: strict `YYYY-MM-DDTHH:mm:ss.sssZ`, exactly 4-digit year `0001..9999`, finite
and `toISOString()`-equal (reject `Feb 30`, year `0000`, offsets, missing `Z`, short/spaced
forms, `now` as a string). `clampAddMonths` accepts integer `months` 0..12 only, preserves the
ORIGINAL UTC millisecond time, and uses `fullYear`/`setUTCFullYear` (not the JS 0..99 year
gotcha). Annual requires `start < end <= clampAddMonths(start, 12)` (max 12 windows; a shorter
term clips the final window). Monthly requires `0 < end-start <= 31*86400000` ms and uses the
provider period verbatim (no synthesized lifetime anchor; `Feb28 -> Mar31` is allowed). The
whole input is validated first, so a bad term never becomes `no_grant` merely because the clock
is outside. `unknown` keys on `billingWindow`/`windowId` inputs are rejected; `windowId`
validates `paid_term_start <= window_start < window_end` and canonical instants, and never
mutates its input. It has **no paid-term end input** and cannot prove provider-term bounds;
`billingWindow` and the stored-reference validator enforce those bounds from their full
inputs. `Date` inputs must be real, valid `Date` instances. The reference validator checks
closed shape, cadence/term duration and exact calendar window bounds, not just field types.
Its `window_id`/MAC fields are structural digests, never cryptographic proof or permission:
only the later authority-owned store can verify their actual ownership and provenance.

Parent T1 review corrected a contradictory test that both accepted and rejected the same
`window_end`. Window identity has no implicit monthly ceiling. Shared strict date/token
schemas may be exported from `billing-authority.ts` for use by `billing-seal.ts`; keep the
same validated canonical rules rather than duplicating incompatible parsers. The exported
helpers confer no authorization.

---

## Task 1 — pure domain gate (calendar, window identity, closed seal frame)

**Files:** Create `packages/domain/billing-authority.ts`, `packages/domain/billing-seal.ts`;
Test `tests/integration/billing-authority-domain.test.ts`.

**Interfaces:** Produces every type/function in the Interfaces block. Consumes only `canonical`
and `BrainError` (`packages/domain/logic.ts:5,18`), `maxMicroUsd` (`packages/domain/spend.ts:23`)
and `node:crypto`. No IO, provider, storage, public authority or HTTP operation.

- [x] **Step 1 — write the RED test** `tests/integration/billing-authority-domain.test.ts`
  (already written in this revision). Fixtures are `SYNTHETIC`.
- [x] **Step 2 — RED only.** `npx vitest run tests/integration/billing-authority-domain.test.ts --maxWorkers=1`
  (timeout 120 s). Expected RED: missing modules `packages/domain/billing-authority.ts` /
  `packages/domain/billing-seal.ts`. Parent reproduced exit 1 / zero assertions at
  22:10:53 before authorizing GREEN. Subsequent parent regressions had witnessed
  assertion failures, not merely missing imports.
- [x] **Step 3 — minimal implementation** (parent authorized GREEN after RED):
  `billing-authority.ts` = strict UTC parse/validate, `clampAddMonths`, `windowId =
  sha256(canonical({account_id, subscription_ref, paid_term_start, window_start, window_end}))`,
  `billingWindow` (monthly = exact provider period, index 0; annual = 12 half-open windows from
  the original anchor, only the one containing `now`, final clip), freshness helpers, and
  `validateStoredPaidTermReference`. `billing-seal.ts` = closed validation for the union,
  `canonicalSealFrame = canonical(validated)`, `sealMac = HMAC-SHA256` over the UTF-8 frame with
  a 32-byte key check, `verifySealMac` = fail-closed `false` with length-safe `timingSafeEqual`.
- [x] **Step 4 — GREEN + focused checks.**
  `npx vitest run tests/integration/billing-authority-domain.test.ts --maxWorkers=1`, then
  `npm run typecheck`. No full suite, no E2E (parent future gate).
  Parent's final focused command also ran 67 independent B0 checks and three
  adjacent accounting/advisory suites: 162 passed / 5 files. Fresh typecheck,
  lint and build passed separately. No full-suite/browser result is inferred.

---

## Task 2 — schema 5 storage integrity: inert namespace DDL, protected key, private MAC log/head, immutable projection (PAUSED; staged T2A/T2B/T2C)

### T2K — protected key-file helper (APPROVED standalone prerequisite)

This substage precedes global money migration. It creates **no control DB, schema, policy,
profile or activation**, and its production module has no caller yet. Only disposable
synthetic test roots may receive files during development. No provider key is involved.

**Files:** create `packages/storage/billing-key.ts` and
`tests/integration/billing-authority-key.test.ts`; no other production changes.

```ts
interface BillingKey { bytes: Uint8Array; commitment: string }
interface BillingKeyEnrollment {
  offline: true;
  workers_terminated: true;
  expected_commitment: string; // lowercase SHA-256 of the supplied 32 raw bytes
}
function billingKeyPath(root: string): string;
function billingKeyCommitment(bytes: Uint8Array): string;
function loadBillingKey(root: string): BillingKey;
function enrollBillingKeyOffline(
  root: string, bytes: Uint8Array, options: BillingKeyEnrollment,
): { commitment: string };
```

Root must be an explicit absolute **existing real directory**, with no link/junction in
its ancestor chain; do not create the root. The fixed path is
`<root>/.protected/billing-authority.key`. Pure path derivation does not probe/create files.
The key is a **regular single-link file**, exactly 32 raw binary bytes, never text/hex.
Read operations never mkdir/create/repair. Check `.protected` and its ancestors for links,
require a real directory, and use bounded `open`/`fstat`/read with a final size/identity
check; reject oversize/short bytes, key links/directories/hard links, and unreadable paths.
Do not claim filesystem atomicity against a hostile process with access to the trusted root.

Enrollment validates both literal acknowledgements, exact option keys, the 32-byte input
and expected commitment **before any mutation**. Create `.protected` only during this explicit
operation (`0700` on POSIX), then use exclusive `wx` for the key (`0600` on POSIX). Validate
and read back the actual file before returning. Existing identical bytes/commitment are an
idempotent no-op; a different, missing-after-creation, corrupt, linked or permissive key is
refused without overwriting, chmod-repair, re-signing or deletion. A concurrent loser may
read and accept the winner only if its validated bytes match exactly; a partially written
winner is a refusal, never permission. Close all descriptors in `finally`. Return owned byte
copies; never print the input, path contents or filesystem exception text. Validation/failure
uses content-safe `BrainError` messages. Do not add automatic randomness, key rotation,
activation, backend environment reads, public routes or a generic secret-store abstraction.

Without an installed-policy store this standalone helper cannot distinguish a pre-created
empty directory from an enrolled key that was deleted. Therefore **existing `.protected`
with a missing key refuses enrollment**. Only the invocation that exclusively created the
new private directory may create its first key; later calls may only accept an intact identical
key. A concurrent loser with an incomplete winner refuses. This conservative rule avoids a
lost-key reinitialization bypass without inventing a second mutable enrollment marker.

POSIX key files with group/other access or unexpected executable mode fail closed rather
than being repaired; Windows `chmod` is **not ACL verification**. Windows tests cover byte,
path and race behavior only; a separately verified deployment ACL remains a live gate.
The offline acknowledgements assert quiescence; they do not prove other workers are stopped.

- [x] Write synthetic tests first: no write on missing/invalid root, missing key, invalid
  bytes/options/commitment, linked ancestor, linked `.protected`, linked/directory/short/large
  key, hard link; valid binary load/owned copy; exact replay without file change; mismatch
  preservation; POSIX-only permission checks. Cleanup in `finally`, using the approved
  `C:/Users/Gowrishankar/AppData/Local/Temp/opencode` base on this Windows host.
- [x] Run RED: `npx vitest run tests/integration/billing-authority-key.test.ts --maxWorkers=1`
  (120 s). Stop before production implementation for parent review.
- [x] After parent authorization, implement only this helper and run GREEN; separate
  `npm run typecheck`, `npm run lint`, `npm run build`. Parent independently verifies
  adversarial file behavior and existing B0/accounting regressions before acceptance.

Parent reproduced lost-key reinitialization failure at 22:43:32 before its repair.
Focused independent behavior gate at 22:47:43: **169 passed / 6 platform skips, 5 files**
(key + pure-domain + central-spend tests). Static checks were reported by the executor;
parent repeats them after T2L, whose intentional RED test currently has a missing import.
No Windows ACL or actual multi-process key-enrollment race result is inferred.

### Remaining T2 proposal — not approved to execute

### T2L — signed-journal schema and read-only verification (approved next)

To avoid an incomplete global migration, implement the independently testable journal
first. Money remains **4** and tenant remains **5**. New code is not imported by the app,
spending store, activation loader or operator CLI yet. No production constructor installs
DDL. Test fixtures explicitly install it into their own disposable control databases.
This is a staged part of B0's approved storage design, **not completed money-5 migration**.

**Files:** create `packages/storage/billing-journal.ts` and
`tests/integration/billing-authority-journal.test.ts`; create a literal frozen fixture
`tests/helpers/managed-v4-fixture.ts` for later genuine migration proof. Parent owns
`tests/integration/billing-authority-journal-review.test.ts`. Do not edit T1/T2K or
current money version/DDL. Complete policy, paid-term, admission and financial projection
contracts are still required before integrating the namespace and version 5 globally.

**Exact journal schema (no B1 inbox, no invented checkout tables):**

- `control_billing_log`: `epoch INTEGER NOT NULL CHECK(epoch>=1)`,
  `ordinal INTEGER NOT NULL CHECK(ordinal>=0)`, `frame_json TEXT NOT NULL`,
  `mac TEXT NOT NULL`, primary key `(epoch,ordinal)`; immutable UPDATE/DELETE triggers.
  Persist **the complete T1 canonical frame**, including root nonce, policy, source IDs,
  previous MAC and purpose/body. No omitted signed metadata or reconstructed defaults.
- `control_billing_head`: `singleton INTEGER PRIMARY KEY CHECK(singleton=1)`,
  `epoch INTEGER NOT NULL CHECK(epoch>=1)`, `ordinal INTEGER NOT NULL CHECK(ordinal>=0)`,
  `mac TEXT NOT NULL`. Empty installation has no head or log entries. A head references
  the exact final log row by `(epoch,ordinal)` foreign key, and carries the same MAC.
- Trigger/index/table DDL names are closed constants; SQL comes only from the module.
  Shape checks reject missing, extra or changed namespace tables/indexes/triggers.
  They include triggers/indexes **attached to the known journal tables even if their
  names are outside the namespace**. Autoindexes are checked via SQLite metadata/uniqueness
  rather than expecting a non-null SQL definition. Do not canonicalize away quoted SQL
  string literal content; exact persisted SQLite SQL is a sufficient deterministic digest.

```ts
export const BILLING_JOURNAL_DDL: string;
export const BILLING_JOURNAL_MAX_ENTRIES: number; // 100_000, caller may only lower
export interface BillingJournalBinding {
  epoch: number; root_nonce: string; policy_id: string;
}
export type BillingJournalSnapshot =
  | { state: "empty" }
  | { state: "verified"; epoch: number; ordinal: number; mac: string; entries: number };
export function billingJournalSchemaDigest(db: DatabaseSync): string;
export function readBillingJournal(
  db: DatabaseSync, binding: BillingJournalBinding, key: Uint8Array,
  options?: { max_entries: number },
): BillingJournalSnapshot;
```

`billingJournalSchemaDigest` requires the exact journal DDL and returns its digest, or
throws content-safe `BrainError` when altered/absent. Expected definitions may be captured
from a private in-memory SQLite reference built from the constant DDL, then cached (not a
runtime authority database or a money migration). No supplied SQL/path/table is executed.

`readBillingJournal` is read-only. Validate the binding's exact keys, positive safe epoch,
hex64 nonce, bounded token policy, key length, and closed optional bound before querying.
Require exact schema. Bound row count/total serialized bytes before JSON parsing; each
frame must be at most 16 KiB (T1 limit), total at most 16 MiB per verification, and no
more than `max_entries` (default 100,000). Read rows in ordinal order with `LIMIT bound+1`
so exhaustion is a refusal, never a partial success. Require epoch/binding equality,
ordinal sequence starting at zero, `prev_mac` equality with the preceding verified row,
canonical serialization byte equality, valid purpose-specific T1 shape and MAC. Require
head to agree with the exact final row. No head plus any log row, or head plus no row,
is corruption. Empty means no spending authority, **not** permission to initialize a
replacement history. For this pre-restore implementation, a foreign epoch in either table
denies; retained historical epochs/checkpoint rotation require their later explicit contract.

Use one SQLite read snapshot (begin deferred/read transaction when called outside a
transaction; otherwise reuse the caller's snapshot without nesting, committing or rolling
back the caller's transaction). No key file loads, network, writes, activation, financial
projection or arbitrary append method. Closing its own read transaction must also happen
after a refusal. Incremental checkpoints/tail caching are **not implemented here** and may
not be claimed: this boot/read-only verifier is bounded and not installed on model sends.

MAC integrity is not payment evidence. The caller's binding/key come from later trusted
composition. A coherent older DB plus its matching head remains an acknowledged rollback
limit; this module detects visible truncation, modification, gaps and mismatches, not all
whole-database replays. No SQL fixture insertion is exported as a production grant writer.

- [x] Write tests, run witnessed RED, then implement the new module. Seed real SQLite
  rows using T1 `sealMac` in test utilities only; cover empty, valid admission/grant chain,
  wrong key/root/policy/epoch, noncanonical JSON, altered purpose/body, middle deletion,
  removed suffix with retained head, duplicate/gapped ordinals, head mismatch, hard bounds,
  changed trigger/index/table and unexpected attached trigger. All failures are actual
  refusals, never a truncated verified result. Verify caller transactions remain open and
  read paths leave no key/schema/rows or data changes.
- [x] Freeze the actual worktree v4 DDL literally before any version change. The helper
  must not import the live money DDL or downgrade a later-schema database. Capture all
  original financial/profile rows in a canonical digest excluding **only** future additive
  version-5 bookkeeping; label fixtures synthetic. This is preparation, not migration proof.
- [x] Run `npx vitest run tests/integration/billing-authority-journal.test.ts --maxWorkers=1`
  with a 120-second timeout, then separate typecheck/lint/build. Stop for parent review.

### Superseded broad T2 draft (reference only; do not implement)

### T2P — frozen operator policy contract (approved, pure prerequisite for the writer)

Create only `packages/domain/billing-policy.ts` and
`tests/integration/billing-authority-policy.test.ts`; parent owns the matching
`billing-authority-policy-review.test.ts`. No storage/migration/activation/route changes.
The later private writer must load this exact audited policy, never a provider-supplied
allowance. Model-provider token prices remain in their existing separate profiles.

```ts
type BillingMode = "sandbox" | "live";
interface BillingCatalogPlan {
  cadence: "monthly" | "annual";
  product_ref: string; price_ref: string;
  allowance_micro_usd: number;
  per_job_micro_usd: number; user_daily_micro_usd: number;
}
interface BillingOperatorPolicy {
  schema: 1; policy_id: string; version: number;
  mode: BillingMode; epoch: number; root_nonce: string; key_commitment: string;
  service_daily_micro_usd: number;
  catalog: BillingCatalogPlan[];
}
function validateBillingOperatorPolicy(input: unknown): BillingOperatorPolicy;
function billingOperatorPolicyDigest(input: unknown): string;
function resolveBillingCatalogPlan(
  policy: unknown, selection: unknown,
): BillingCatalogPlan | null;
// selection is exactly { mode, cadence, product_ref, price_ref }, no account/amount.
```

All objects are closed data-only records (reuse T1 validation), digests are hex64,
versions/epochs positive safe integers, refs bounded tokens, all monetary integers
required explicitly within `0..maxMicroUsd` (no defaults). Catalog is exactly two dense
data entries, one per cadence, distinct price IDs and the same product and monthly
allowance/caps in both. It cannot contain holes, accessor/symbol/extra properties or
duplicate cadences. Unknown fields/NaN/fractions/overflow/keys reject with a static
`BrainError`. Return owned copies, canonicalized to monthly then annual; ordering alone
does not change the digest. Digest includes **all** policy/catalog/root/key/mode fields.
Selection is exact and mode-bound; unknown mapping returns null, malformed selection
throws. Invalid policy is never hidden behind an unknown selection. Zero-valued policy
may be represented for default-off configuration but selection returns null if any
required service/account/period ceiling is zero. No price-ref prefix is payment proof;
future adapter pins real server-owned provider/catalog bindings. There is no automatic
conversion from customer payment currency/amount to the allowance. These functions return
structural configuration, **not entitlement or admission**.

- [x] Tests first and witnessed RED, then minimal implementation. Cover stable digest
  under catalog reordering, every meaningful field substitution, malformed/extra data,
  zero caps refusing selection, mode/price/product/cadence mismatch, cloned outputs and
  fractional/unsafe money. Run own + parent tests, then typecheck/lint/build separately.
- [x] Stop for parent review. Production composition for the later financial writer
  remains `EvidenceSource = null` until separately approved B1 exists; injected synthetic
  sources use the same validation contract in tests. MAC possession/type privacy is not
  proof that Paddle was contacted. There is no public arbitrary-frame/JSON grant method.

### Earlier T2 proposal below — superseded, not executable

**Not approved to execute.** Each substage stops for parent review. **Scope is storage
integrity only.** Runtime provenance, the installed static policy, paid-receipt producers,
admission and reserve/mark are T3; this is a *scope partition*, not a business-design change.
T2 must never expose a public raw `append(SealFrame)`; the seal writer is private and only a
closed validated operation may call it (see T2B/T2C).

### Closed namespace tables (additive, inert)

- `control_billing_log(epoch INTEGER NOT NULL, ordinal INTEGER NOT NULL, purpose TEXT NOT NULL, account_id TEXT NOT NULL, term_id TEXT, prev_mac TEXT NOT NULL, mac TEXT NOT NULL, body_json TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(epoch,ordinal))` with immutable triggers (no UPDATE, no DELETE).
- `control_billing_head(singleton INTEGER PRIMARY KEY CHECK(singleton=1), epoch INTEGER NOT NULL, ordinal INTEGER NOT NULL, mac TEXT NOT NULL, updated_at TEXT NOT NULL)`.
- `control_billing_period(period_id TEXT PRIMARY KEY, grant_id TEXT NOT NULL UNIQUE, account_id TEXT NOT NULL, window_id TEXT NOT NULL, window_start TEXT NOT NULL, window_end TEXT NOT NULL, allowance_micro_usd INTEGER NOT NULL CHECK(allowance_micro_usd>=0), root_epoch INTEGER NOT NULL, policy_id TEXT NOT NULL, ordinal INTEGER NOT NULL, created_at TEXT NOT NULL)` with immutable triggers.
- `control_billing_freshness(account_id TEXT PRIMARY KEY, term_id TEXT NOT NULL, verified_at TEXT NOT NULL, expires_at TEXT NOT NULL, revision INTEGER NOT NULL, adverse_generation INTEGER NOT NULL, root_epoch INTEGER NOT NULL, policy_id TEXT NOT NULL, mac TEXT NOT NULL, updated_at TEXT NOT NULL)`; updates are a `revision` CAS.
- `control_billing_inbox(mode TEXT NOT NULL, merchant_endpoint TEXT NOT NULL, event_id TEXT NOT NULL, endpoint_digest TEXT NOT NULL, binding TEXT, state TEXT NOT NULL, lease_owner TEXT, lease_fence INTEGER, lease_expires_at TEXT, received_at TEXT NOT NULL, PRIMARY KEY(mode,merchant_endpoint,event_id))` — **inert metadata only**; no transport, API, callback or checkout behavior.

No subscription/checkout/price/config/UI table is invented.

**Deviation needing parent approval (choose before T2A):** the approved spec says "the B1
event tables are declared in the initial billing DDL", but B1's consumer fields are
unapproved. Option (a) declares only the minimal inert `control_billing_inbox` above and
defers every B1 consumer table; option (b) defers the whole inbox and requires a reviewed
second offline enrollment before B1 installs. This must be resolved explicitly; do not
silently change the approved spec.

**Bounds (closed constants in `packages/storage/billing-authority.ts`):**
`BILLING_AUTHORITY_MAX_LOG_ENTRIES = 100_000`,
`BILLING_AUTHORITY_MAX_BOOT_VERIFY_ENTRIES = 100_000`,
`BILLING_AUTHORITY_MAX_TAIL_ENTRIES = 1_000`. Boot verification is bounded and incremental
from an immutable audited checkpoint; a tail over the bound denies; a missing, truncated or
tampered log denies (never a silent truncate); there is no full scan on every model call;
checkpoint/prune is an offline operator step, never automatic.

### Methods (exact names)

`packages/storage/billing-key.ts` (no IO beyond the key file):
`billingKeyPath(root: string): string`, `billingKeyCommitment(bytes: Uint8Array): string`,
`loadBillingKey(root: string): { bytes: Uint8Array; commitment: string }`,
`enrollBillingKeyOffline(root: string, bytes: Uint8Array): { commitment: string }`.

`packages/storage/billing-authority.ts` (reader + private writer + namespace digest):
`billingAuthoritySchemaDigest(db: DatabaseSync): string`,
`class BillingAuthorityStore` with `constructor(control: ControlStore, root: string, clock?: () => Date)`,
`readHead(): { epoch: number; ordinal: number; mac: string }`,
`readEntry(ordinal: number): BillingAuthorityEntry | undefined`,
`verifyChain(limit?: number): { verified_through_ordinal: number; truncated: boolean }`,
`readPeriod(grant_id: string): BillingPeriodProjection | undefined`,
`readFreshness(account_id: string): BillingFreshnessProjection | undefined`, and
`createAuthorityWriter(input: { store: BillingAuthorityStore; key: Uint8Array; root_epoch: number;
policy_id: string }): AuthorityWriter` (private composition seam).

`AuthorityWriter` — the only appender; typed closed inputs, never a caller `SealFrame` or a
`verified: true` boolean:
`grantWithinTx(record: ValidatedGrantRecord): { ordinal: number; mac: string; period_id: string }`,
`admissionWithinTx(record: ValidatedAdmissionRecord): { ordinal: number; mac: string }`,
`revocationWithinTx(record: ValidatedRevocationRecord): { ordinal: number; mac: string }`,
`freshnessWithinTx(record: ValidatedFreshnessRecord): { revision: number }`.

Record types are typed fields (mirroring the T1 bodies) with `root_epoch` and `policy_id`;
they carry no `unknown`, no resolution boolean and no raw frame. The writer seals, writes the
log entry, updates the head, and (for a grant) inserts the period projection in ONE control
transaction.

### T2A — frozen v4 fixture + schema 5 inert DDL + closed digest + migration

**Files:** `tests/helpers/managed-v4-fixture.ts`, `packages/storage/billing-authority.ts`
(digest), `packages/domain/managed-spend.ts`, `packages/storage/managed-spending.ts`; test
`tests/integration/billing-authority-storage.test.ts`.

- [ ] **Step 1 — RED.** Fixture helper: an independent **literal** DDL + seed of the actual
  CURRENT worktree money-4/S1 tables (never `git show HEAD` — HEAD is pre-S1 schema 3) with a
  `managed_money_schema` row `4`, plus `moneyBytesDigest(db)` over all money rows. Test:
  (a) applying version 5 preserves `moneyBytesDigest` byte-for-byte including every period,
  monetary block, stored profile and version-marker history; (b) `version > 5` is rejected and
  rolled back without zeroing money; (c) a dropped trigger or altered column changes
  `billingAuthoritySchemaDigest`; (d) an unknown object in the namespace denies; (e) `PRIMARY
  KEY(epoch,ordinal)` and the `singleton` head are enforced. Command:
  `npx vitest run tests/integration/billing-authority-storage.test.ts --maxWorkers=1` (120 s).
- [ ] **Step 2 — RED captured** (expect missing module/DDL). Then implement: bump
  `managedMoneySchemaVersion` 4 → 5 and append the namespace DDL to `MONEY_DDL`; add
  `billingAuthoritySchemaDigest` over the closed namespace shape (columns + named indexes +
  trigger bodies, normalized SQL). **Migration honesty:** the existing `ManagedSpendingStore`
  constructor keeps its `BEGIN IMMEDIATE` `migrate()` and its DDL is additive/inert, so a v4
  control DB gains the DDL at startup — this is **auto-DDL, not an offline migration**, and the
  version bump makes existing audits `schema_changed`. The *authority* is unusable until the
  operator runs the explicit offline audit + re-enroll. Global disable on a v3/v4 root still
  works; a brand-new root initializes at 5 with no key. Do not rewrite old tests 4 → 5.
- [ ] **Step 3 — GREEN.** `npx vitest run tests/integration/billing-authority-storage.test.ts --maxWorkers=1`
  then `npm run typecheck`.

### T2B — protected key + private MAC log/head

**Files:** `packages/storage/billing-key.ts`, `packages/storage/billing-authority.ts`; test
`tests/integration/billing-authority-log.test.ts`.

- [ ] **Step 1 — RED.** Assert: the constructor never creates a key; `enrollBillingKeyOffline`
  creates `billingKeyPath(root)` only on explicit offline enrollment, exclusive (`wx`), 32 raw
  **binary** bytes, reusing `assertNonLinkedPathChain` and a bounded binary read (not UTF-8);
  POSIX `0600`; the Windows ACL is a **distinct unverified gate** (no `0600`-secure claim);
  readback mismatch fails with no lost-key repair and no re-seal. Log: an entry + head commit
  in ONE transaction; a stale `expectedHead` CAS denies; `changes !== 1` or a `RAISE(IGNORE)`
  writer rolls back; a middle delete + tamper (bad MAC) denies; `ordinal`/`prev_mac` chain and
  `PRIMARY KEY(epoch,ordinal)` hold; a missing/truncated log denies; a tail over
  `BILLING_AUTHORITY_MAX_TAIL_ENTRIES` denies; stale CAS is tested **against the KNOWN head
  only** (no claim that all rollback is detected). Command:
  `npx vitest run tests/integration/billing-authority-log.test.ts --maxWorkers=1` (180 s).
- [ ] **Step 2 — implement** `billing-key.ts` and the private writer/reader in
  `billing-authority.ts`. The key is never in the DB, vault, frontend, URL, log or export.
- [ ] **Step 3 — GREEN** + `npm run typecheck`.

### T2C — immutable period projection + freshness (same DB TX)

**Files:** `packages/storage/billing-authority.ts`; test
`tests/integration/billing-authority-projection.test.ts`.

- [ ] **Step 1 — RED.** Assert: `grantWithinTx` inserts exactly one immutable
  `control_billing_period` row with a unique `grant_id → period_id` and the sealed entry/head in
  the same transaction; a duplicate `window_id`/`grant_id` denies; `revocationWithinTx` appends
  a deny record and never rewrites consumed money; `freshnessWithinTx` is a `revision` CAS
  bounded to 15 minutes that can never add budget or reset money; all inserts are proven with an
  **injected in-process evidence factory** (constructor composition, no `TEST_MODE`, no HTTP).
  Command: `npx vitest run tests/integration/billing-authority-projection.test.ts --maxWorkers=1` (180 s).
- [ ] **Step 2 — implement** the projection/freshness writers. They take typed validated
  records only. **Deferred to T3:** the installed static policy, the trusted paid-receipt
  producer, runtime admission, `activePeriod` via the grant mapping and reserve/mark. The MAC
  proves authenticity only; it never means "verified payment".
- [ ] **Step 3 — GREEN** + `npm run typecheck`. Full suite/browser is a parent coherent
  checkpoint only.

---

## Task 3 — runtime admission/freshness/grants in reserve+mark, static-vs-dynamic audit guard (PAUSED)

**Not approved to execute.** Depends on the T2 writer contract. Existing draft scope: implement
`BillingAuthority` over the owned store under TX (re-load sealed row, check MAC/purpose/root/
policy/provenance/freshness/adverse latch), admission preflight outside the control write +
publish TX recheck, `activePeriod` via the grant mapping, audit authorized projections, default
OFF. No `hasBillingGrants() => true` bypass; no Paddle API code.

---

## Task 4 — offline enrollment, key backup/restore, default off, production refuses sandbox transports (PAUSED)

**Not approved to execute.** Existing draft scope: `managed-billing-enroll` with `--offline
--workers-terminated`, manifest global key metadata/hash + path checks (encrypted storage is a
LIVE gate), old bundle no-key = legacy restore but PAID-BLOCKED, new root missing key = fail
closed (no auto-generate/re-sign), restore epoch rotation invalidates grants without
auto-clearing blocks, and production `main.ts` refuses paid transports on a sandbox-billing root.

---

## Self-review (against the approved spec)

- **Coverage:** windows/calendar + closed seal → T1 (accepted); schema 5 storage integrity
  (inert DDL, key, private MAC log/head, projection) → T2A/T2B/T2C (paused); runtime admission
  + audit split + reserve/mark → T3 (paused); enrollment/backup/offline/sandbox refusal → T4 (paused).
- **No placeholders:** T1 names real files, types, functions, constants and commands. T2–T4 are
  explicitly marked paused with their concrete blockers rather than pretending to be ready.
- **Type consistency:** `SealFrame` union, `GrantSealBody`/`AdmissionSealBody`/
  `RevocationSealBody`/`FreshnessSealBody`, `windowId`, `BillingWindow`,
  `StoredPaidTermReference` and module paths are identical across this section and the tests.
- **Honesty:** out-of-band coherent snapshot/prefix-head rollback and root/key compromise remain
  documented residual limits; schema 5 is a plan target, not an applied or verified migration.
