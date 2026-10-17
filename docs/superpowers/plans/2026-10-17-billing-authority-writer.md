# Billing authority writer (T2W) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: `writing-plans` → `executing-plans`. TDD:
> failing test, RUN it, observe RED, implement, GREEN. Execute ONE step, then **STOP for
> parent review**. Parent owns `BUILD_STATE.md`, checklists and every `*-review` test.
> **Nothing here is implemented, accepted or verified because this plan exists.**

**Goal:** Add B0's standalone, default-off financial-authority writer and its full closed
schema as a test-installable unit — without a global money-5 migration, without any HTTP,
checkout, webhook or UI, and with **no** production evidence source until B1 is approved.

**Status:** B0 approved; **B1 UNAPPROVED**. Production `EvidenceSource = null`. Money
stays 4 and the tenant schema stays 5 in this slice.

**T2W accepted locally — 2026-10-18:** parent independently ran **430 passed / 6 explicit
platform skips across 20 files** (384 B0 + 46 existing financial checks), 14.54 s,
and separate typecheck/lint/build passed. Report:
`test-results/billing-authority-writer-final-parent.json`. The full runtime regression
separately passed 984/2; browser 24/24; offline evaluations 4/4; audit zero vulnerabilities.
Both actual two-process publication/fencing cases passed. Parent's final two RED→GREEN
repairs enforce retained grant↔period correspondence and exact term epoch, with duplicate
window and every-grant receipt/binding verification. Historical non-executable/failed
checkpoints below are superseded. This is standalone **synthetic** acceptance, not real
admission, money-5 migration, production incremental verification or payment evidence.
Next: `2026-10-18-billing-admission-integration.md` (draft pending parent review).

## Approved execution contract — one standalone writer slice

The owner requested continuation in safe order, without repeated planning stops. Parent
has resolved the implementation choices below. This section **supersedes the earlier
proposal** later in the file. Implement schema + trusted evidence validation + private
grant/freshness/revocation writes together, test-first; stop only for the complete parent
verification gate. No production wiring or global money migration belongs to this slice.

### Resolved scope and trust

- Public writer methods are **only** `reconcile(account_id)`, `ensureCurrentGrant(account_id)`
  and `billingEligibility(account_id)`. Actual clean-baseline admission/provisioning generation
  must be implemented with the later real reserve/mark guards; **do not expose unfinished
  preflight/admit methods or fake their proof**. This writer consumes an already signed
  admission, seeded by trusted test utilities only until that integration exists.
- Constructor: `new BillingAuthority({ control, root, source?: EvidenceSource | null,
  clock?: () => Date })`. Source defaults to null; without it, reconciliation returns
  `{state:'denied',reason:'no_source'}` and eligibility is unavailable, without writes.
  There is no public raw append, supplied key/policy/digest, or accept-record operation.
- A non-null trusted-code source is dependency injection, not proof of Paddle contact.
  It receives an owned server binding and returns closed `ProviderFacts`. Production has
  **no source or caller** until separately approved B1. No environment test bypass.
- The writer loads the fixed `.protected/billing-policy.json` (bounded 16 KiB, regular,
  nonlinked, private on POSIX) and the T2K key from its actual managed root. Validate T2P
  policy, key commitment, trusted root/control path, root epoch SQL row and marker. Freeze
  their digest at construction; re-read/match on every operation and under mutation lock.
  A policy cache row must match this real protected artifact, never its own self-hash alone.

### Closed shapes

`ServerOwnedBinding` is exactly `{schema:1,account_id,identity_digest,tenant_incarnation,
provisioning_generation,mode,product_ref,price_ref,cadence,customer_ref,subscription_ref,
initial_transaction_ref,correlation_ref,version}`. UUID/digest/token/integer/date rules reuse
T1. Identity digest is SHA-256 of canonical `{account_id,issuer,subject}` from ControlStore.
Binding digest is SHA-256 of the complete canonical binding. Signed admission must contain
the same account/identity/incarnation and `source_ids` including `binding:<binding_digest>`
and `baseline:<clean_baseline_proof>`. It references a real admitted account row and current
control identity; mutable unsealed binding rows alone never establish ownership.

`ProviderFacts` is exactly `{transaction_ref,subscription_ref,customer_ref,product_ref,
price_ref,cadence,completed_payment,current_state,paid_period_start,paid_period_end,verified_at}`.
State is `active|past_due|canceled|refunded|paused|unknown`. Reject account IDs, allowances,
authority flags, mode selectors and provider-chosen adverse generations. Initial payment
requires the binding's exact initial transaction ID; later terms require the same sealed
customer/subscription/catalog. Verify canonical periods/current clock, no future observations
and no observations older than 15 minutes. Budget comes only from T2P catalog. A fake source
cannot select a different account/product/customer/subscription or alter limits.

Persist immutable receipt JSON exactly `{schema:1,account_id,binding_digest,transaction_ref,
subscription_ref,customer_ref,product_ref,price_ref,cadence,completed_payment:true,
paid_period_start,paid_period_end}`. Its SHA-256 is `receipt_digest`. Term identity is
SHA-256 of canonical `{account_id,subscription_ref,paid_period_start,paid_period_end}`;
it excludes payment transaction/policy IDs, preventing a second payment from re-crediting
the same interval. A conflicting receipt for an existing term denies without changing money.

Freshness persists the canonical **full** observation, plus its account and binding digest;
its digest is authenticated in `source_ids`. Signed freshness projection uses T1 purpose
`freshness`, ordinal 0 / empty previous MAC, body revision incremented by CAS, and sources
`projection:<observation_digest>`, `receipt:<receipt_digest>`, `binding:<binding_digest>`.
This domain-separated projection is not appended each poll. Rare grant/revocation entries
use actual journal ordinal/previous MAC and authenticate the same receipt/binding/observation
references. Reload and hash all referenced rows before accepting a projection or receipt.

### Complete standalone schema

`packages/storage/billing-schema.ts` owns both constant DDL variants and catalog checks.
Move existing journal DDL/catalog checks there, re-export existing journal names to preserve
callers, with no circular import. Journal reads gain only an explicit optional
`variant:'authority'` alongside the existing required `max_entries`; default stays strict
journal-only. The authority variant contains journal/head plus exactly:

- `control_billing_policy(singleton PK CHECK=1,policy_json,policy_digest)`;
- `control_billing_account(account_id PK FK managed_accounts,binding_json,binding_digest,
  admission_ordinal,adverse_generation INTEGER>=0)`;
- `control_billing_terms(term_id PK,account_id FK managed_accounts,receipt_json,
  receipt_digest UNIQUE,epoch,journal_ordinal,created_at)`;
- `control_billing_period(grant_id PK,window_id UNIQUE,period_id UNIQUE FK managed_account_periods,
  account_id FK managed_accounts,term_id FK terms,epoch,journal_ordinal,window_start,
  window_end,allowance_micro_usd INTEGER>=0)`;
- `control_billing_freshness(account_id PK FK managed_accounts,term_id FK terms,
  observation_json,frame_json,mac,revision INTEGER>=1,adverse_generation INTEGER>=0)`.

All listed fields are NOT NULL; deterministic literal DDL contains exact named immutable
triggers for terms/periods. Admission ordinal references the admission in the current journal;
foreign keys to journal use epoch/ordinal where applicable. No B1 inbox/checkout tables.
No constructor executes DDL. Fixtures alone explicitly install `BILLING_AUTHORITY_DDL`.
Full shape checks include attached nonnamespace triggers/indexes. Existing journal tests
must remain strict; full authority verification must deliberately select its closed variant.

### Atomic operations and fencing

Read source outside any transaction. Before await, capture verified journal head, binding
digest and signed freshness revision. In `BEGIN IMMEDIATE`, reload root/policy/key, actual
account identity/state, signed admission, exact binding, journal, current freshness and
adverse state; require the captured head/binding/revision unchanged. A later adverse event
or competing writer prevents stale response publication. Local adverse generation is
derived from authenticated revocation entries and checked against its projection, never
chosen by provider facts. Persist adverse observations as signed revocation entries even
when new paid grants are denied. A revoked term stays revoked; a later **new paid term**
may qualify, but cached active data cannot resurrect a revoked term.

For active/completed validated evidence, privately append grant, update head, insert term
if new, insert immutable grant mapping and exactly one NEW `managed_account_periods` row
in the **same** transaction. Existing same-window/grant/period identity returns the same
period without resetting allowance/usage. Reject overlaps against **all** retained central
periods, including revoked ones; do not edit old periods or their foreign keys. Actual service
and account policy caps must match the frozen configured caps; do not raise them. Grant
identity is the T1 window ID; period UUID is server-created once. Annual month transitions
reuse only a still-fresh authenticated paid term; missed windows are never banked.

Every critical INSERT/UPDATE needs affected-row and stored-value readback checks; SQL
RAISE(IGNORE), COMMIT failure, mismatched CAS/head or projection failure rolls back all
new state. Unknown dispatch holds and known settlements are untouched. Eligibility means
an intact current grant, **not successful monetary admission**: existing four-dimensional
reserve/mark integration, service ambiguity and tenant-generation guards remain next.

### Implementation files and gate

New `packages/domain/billing-evidence.ts`, `packages/storage/billing-schema.ts`,
`packages/storage/billing-authority.ts`; modify only the schema-variant seam in
`packages/storage/billing-journal.ts`. New focused tests and one synthetic fixture helper
under `tests/helpers/billing-authority-fixture.ts`; parent owns all `*-review` tests.
Use the same trusted composition in fixtures; seed signed admission/policy/binding explicitly
as synthetic history, not a public production enrollment/grant method. Witness RED first,
then implement the whole writer slice and run focused tests + typecheck/lint/build. Parent
independently tests cross-account correlation, overlap/replay, month rollover, unknown-hold
preservation, freshness/adverse fencing and atomic rollback. Do not change money version,
activation fingerprints, application wiring, dependencies, owner data or enable providers.

## Earlier proposal / superseded review history

### Parent implementation-review gate (in progress)

The first implementation is **not accepted**. Parent's 23:47:22 run reproduced
11 failures across cached/source-disabled permission, stale annual materialization,
revocation/new-term state, full receipt/observation authentication, exact period identity,
cached-cap checks, actual control identity, in-flight root changes and key commitment.
All positive paths must use a shared authenticated snapshot and repeat its checks inside
the write lock. Denied materialization must write **nothing**, not mint a period and then
return unavailable. Current/future grant views must match the exact central period UUID.

Private schema may include one additional immutable normalized denial-observation table
(`control_billing_denials`) so revocation source digests resolve to retained evidence.
It is part of the closed authority variant only, not a webhook inbox. Repeated equivalent
adverse polls must not append new authority entries indefinitely. Initial transaction
correlation is per-account, never based on whether any other account already has a term.
These are completeness repairs within the approved writer contract, not production
schema installation. Actual two-process same-window publication already passed parent
testing; it must be repeated after the repair. No application or global migration changes.

Parent's next 23:57:35 batch passed 372 checks, but the 23:58:39 provenance review then
reproduced seven positive-authority failures. Acceptance also requires **bidirectional**
journal/projection correspondence: every signed revocation resolves to exactly one retained
denial observation; terms authenticate their actual originating grant ordinal and receipt
digest; every grant authenticates its term/binding; foreign epochs are rejected, never
filtered away. Deleting a mutable projection cannot erase a still-retained signed denial.
Annual month changes apply the same immutable receipt check as ordinary replay, and a
future observation is unavailable after clock rollback. Existing-window reconciliation
cannot report granted against a revoked central period. Full intended-row readbacks (or
equivalent revalidation before commit) must also detect silently ignored individual column
updates, not just successful SQL row counts. These repairs remain part of this gate.

The following identified gaps motivated the resolved execution contract above:

- `ServerOwnedBinding` lacks customer/subscription/correlation identity and ownership
  version. A matching product/price is not proof that a transaction belongs to this account.
- `PreflightRef` has no authority-owned stored proof reference or generation recheck
  contract. A caller's incarnation/policy fields cannot replace that proof.
- `adverse_generation` is local concurrency authority, not a Paddle response fact. Derive
  it from current control state, fence the read request before network I/O, and recheck it
  inside publication; provider output must not choose or overwrite it.
- Constructor-provided `policyArtifactDigest`/policy/key are not evidence of protected
  enrollment by themselves. Specify the exact owned artifact/key/root loader and the frozen
  lifetime/revalidation checks before exposing any financial mutation.
- Define the canonical normalized term/receipt body and the exact MAC-authenticated
  journal references that bind **all** persisted evidence fields; "content-derived" alone
  does not specify what is protected or prevent mutable-reference substitution.
- Admission/generation and low-level reserve/mark enforcement belong in the same coherent
  integration gate. Step 4 cannot claim "an unadmitted writer cannot reserve" while all
  actual spending-guard edits are explicitly out of scope.

The closed schema variant seam may reuse one chain implementation, but it cannot be
installed globally or selected by a browser/provider. No broad writer/fingerprint change
is approved by this planning record. Existing accepted prerequisites remain untouched.

**Spec:** `docs/superpowers/specs/2026-10-17-renewal-safe-financial-authority-design.md`
(APPROVED). T1 (`billing-authority.ts`/`billing-seal.ts`), T2K (`billing-key.ts`), T2L
(`billing-journal.ts`) and T2P (`billing-policy.ts`) are frozen foundations — **do not
edit** them beyond the one explicit journal-variant seam below.

## Scope

The writer module and its full financial schema, testable on a disposable root without
Paddle. It materializes an immutable `managed_account_periods` projection from verified
grant evidence, records admission and revokes, and exposes the read-only eligibility seam.

Out of scope: money 4 → 5 global migration, production DDL installation, HTTP routes,
Paddle integration, provider keys, real economic numbers, tenant incarnation generation,
the audit `accountConfigHash` split. Those stay T3/T4.

## Critical unresolved choices (parent must decide before code)

1. **Journal variant seam.** T2L's reader is closed to exactly two tables; unknown
   namespace objects deny. A full financial schema needs a closed *full* variant. Proposed:
   `packages/storage/billing-schema.ts` holds both closed reference catalogs, and
   `readBillingJournal` gains an explicit `options.variant?: "journal" | "authority"`
   (default `"journal"`) so strictness is **never silently widened**. This edits T2L.
   Alternative: a separate full-schema reader, duplicating chain logic. Choose one.
2. **Admission generation.** `ManagedRuntime.provision` writes a marker with only
   `{schema, account_id, issuer, subject}`; there is no tenant incarnation/generation.
   A safe clean-baseline admission needs one. Proposed T4 hook: a central generation bound
   at trusted provision and rotated by offline restore. W may only *require* it; W must not
   infer safety from a hash.
3. **Policy pin source.** The frozen policy pin must be an external protected operator
   artifact (e.g. `<root>/.protected/billing-policy.json`, T4 enrollment), not a
   self-hashed row. W reads an injected synthetic artifact in tests.
4. **Rebuild/import paths.** Before code, enumerate the actual vault rebuild/recovery and
   `Brain.preview`/`applyImport` paths to prove ordinary knowledge import cannot insert
   financial history; only then can "clean baseline" mean anything.

## Seam (advisor-recommended; exact)

```ts
// packages/domain/billing-evidence.ts  (pure; no IO)
export interface ServerOwnedBinding {
  account_id: string; mode: BillingMode;
  product_ref: string; price_ref: string; cadence: "monthly" | "annual";
}
export interface ProviderFacts {              // NEVER account UUID/allowance/verified flag
  transaction_ref: string; subscription_ref: string; customer_ref: string;
  product_ref: string; price_ref: string; cadence: "monthly" | "annual";
  completed_payment: boolean;
  current_state: "active" | "past_due" | "canceled" | "refunded" | "paused" | "unknown";
  paid_period_start: string; paid_period_end: string; verified_at: string;
  adverse_generation: number;
}
export interface EvidenceSource { read(binding: ServerOwnedBinding): Promise<ProviderFacts>; }

// packages/storage/billing-authority.ts  (trusted composition; no public raw append/seal)
export type BillingReason = "no_source" | "no_admission" | "no_grant" | "stale" | "past_due"
  | "canceled" | "refunded" | "conflict" | "suspended" | "policy_mismatch" | "untrusted_evidence";
export interface PreflightRef {
  readonly account_id: string; readonly incarnation: string;
  readonly policy_digest: string; readonly root_epoch: number;
}
export type ReconciliationDecision =
  | { state: "none" } | { state: "denied"; reason: BillingReason }
  | { state: "granted"; window_id: string; window_start: string; window_end: string };
export type AdmissionDecision = { outcome: "admitted" | "already" | "denied"; reason?: BillingReason };

export class BillingAuthority {
  constructor(deps: { control: ControlStore; root: string; clock: () => Date;
    key: Uint8Array; policy: BillingOperatorPolicy;
    source: EvidenceSource | null; policyArtifactDigest: string }): void;
  reconcile(account_id: string): Promise<ReconciliationDecision>;
  preflightAdmission(account_id: string): Promise<PreflightRef | null>;
  admitNewAccount(ref: PreflightRef): AdmissionDecision;
  ensureCurrentGrant(account_id: string): BillingEligibility;
  billingEligibility(account_id: string): BillingEligibility;
}
```

No `authorized`/`verified: true` boolean, no arbitrary body-record factory, no public
`append`/`seal`. The writer builds each T1 frame privately from its own validated evidence
inside the control transaction; the four T1 purposes are reused unchanged (no fifth).

## Schema (version-5 target; test-installed only)

Additions to the T2L journal, closed and exact, in `billing-schema.ts`:

- `control_billing_policy(singleton INTEGER PRIMARY KEY CHECK(singleton=1), policy_json TEXT NOT NULL, policy_digest TEXT NOT NULL, key_commitment TEXT NOT NULL, mode TEXT NOT NULL, root_nonce TEXT NOT NULL, epoch INTEGER NOT NULL, applied_at TEXT NOT NULL)` — an audited cache whose `policy_digest` must equal the external protected artifact.
- `control_billing_account(account_id TEXT PRIMARY KEY, mode TEXT NOT NULL CHECK(mode IN ('sandbox','live')), incarnation TEXT NOT NULL, admission_state TEXT NOT NULL CHECK(admission_state IN ('manual','admitted')), admission_proof_ref TEXT, generation INTEGER NOT NULL, admitted_at TEXT)`.
- `control_billing_terms(term_id TEXT PRIMARY KEY, receipt_digest TEXT NOT NULL, account_id TEXT NOT NULL, transaction_ref TEXT NOT NULL, subscription_ref TEXT NOT NULL, customer_ref TEXT NOT NULL, product_ref TEXT NOT NULL, price_ref TEXT NOT NULL, cadence TEXT NOT NULL, term_start TEXT NOT NULL, term_end TEXT NOT NULL, verified_at TEXT NOT NULL, adverse_generation INTEGER NOT NULL, journal_ordinal INTEGER NOT NULL)`; immutable triggers.
- `control_billing_period(grant_id TEXT PRIMARY KEY, period_id TEXT NOT NULL UNIQUE, account_id TEXT NOT NULL, window_id TEXT NOT NULL, window_start TEXT NOT NULL, window_end TEXT NOT NULL, allowance_micro_usd INTEGER NOT NULL CHECK(allowance_micro_usd>=0), root_epoch INTEGER NOT NULL, policy_id TEXT NOT NULL, journal_ordinal INTEGER NOT NULL)`; immutable triggers.
- `control_billing_freshness(account_id TEXT PRIMARY KEY, term_id TEXT NOT NULL, verified_at TEXT NOT NULL, expires_at TEXT NOT NULL, revision INTEGER NOT NULL, adverse_generation INTEGER NOT NULL, root_epoch INTEGER NOT NULL, policy_id TEXT NOT NULL, mac TEXT NOT NULL, updated_at TEXT NOT NULL)`.

`term_id`/`receipt_digest` are content-derived. There is **no** `control_billing_inbox`.

## Step 1 — evidence/authority closed types + schema variants

**Files:** create `packages/domain/billing-evidence.ts`, `packages/storage/billing-schema.ts`;
modify `packages/storage/billing-journal.ts` (variant seam only); test
`tests/integration/billing-authority-schema.test.ts`.
**Interfaces:** produces the evidence types above plus
`billingAuthoritySchemaDigest(db): string`, `BILLING_AUTHORITY_DDL: string`,
`billingSchemaVariant(db): "journal" | "authority" | "unknown"`.

- [ ] **Step 1 RED.** Tests: the full variant digest matches its closed catalog and denies an
  added table/trigger/view; the journal variant still denies a full-schema object; an
  unknown-shaped DB returns `unknown` and both digests refuse; `readBillingJournal` default
  stays journal-strict. Command:
  `npx vitest run tests/integration/billing-authority-schema.test.ts --maxWorkers=1` (120 s).
  Expect missing-module RED.
- [ ] **Step 2 implement** the two closed reference catalogs (private `:memory:` reference,
  cache once) and the explicit variant seam. **Do not** weaken the journal strictness.
- [ ] **Step 3 GREEN** + `npm run typecheck`. STOP for parent review.

## Step 2 — policy pin, null source, and provenance refs

**Files:** create `packages/storage/billing-authority.ts` (types + `constructor` +
`billingEligibility`/`reconcile` with a `null` source only); test
`tests/integration/billing-authority-source.test.ts`.
**Interfaces:** produces `BillingReason`, `PreflightRef`, `ReconciliationDecision`,
`BillingAuthority` with `source = null`, and
`readPinnedPolicy(artifact: unknown, policy: unknown): { digest: string }`.

- [ ] **Step 1 RED.** Tests: `source === null` makes `reconcile` return
  `{state:"denied", reason:"no_source"}` and `billingEligibility` `unavailable`, without any
  write; a pinned policy artifact whose digest ≠ injected policy denies
  (`policy_mismatch`); a synthetic source implementing `EvidenceSource` is exercised through
  the same contract (no JSON/HTTP grant path, no `TEST_MODE`); `ProviderFacts` validation
  rejects an account UUID, an allowance or a `verified` flag. Command:
  `npx vitest run tests/integration/billing-authority-source.test.ts --maxWorkers=1`.
- [ ] **Step 2 implement** the composition and the pinned-policy check (external artifact
  digest, never the row's self-hash).
- [ ] **Step 3 GREEN** + `npm run typecheck`. STOP for parent review.

## Step 3 — atomic grant/admission/freshness writer

**Files:** modify `packages/storage/billing-authority.ts`; test
`tests/integration/billing-authority-writer.test.ts`.
**Interfaces:** produces `admitNewAccount`, `ensureCurrentGrant`, `reconcile` (real path),
and the private `grantWithinTx` / `admissionWithinTx` / `revocationWithinTx` /
`freshnessWithinTx`.

- [ ] **Step 1 RED.** Tests on a disposable root with a synthetic `EvidenceSource`: an
  op-aware read happens **outside** the transaction; the grant frame + head + immutable
  `control_billing_period` row + the `managed_account_periods` projection commit in one
  control transaction; a duplicate window/ordinal/term does not double-credit; a policy/ref
  mismatch denies; freshness is a `revision` CAS bounded to 15 minutes; a revocation appends
  a new head and rejects a stale GET; no tenant DB IO occurs inside the control transaction.
  Command: `npx vitest run tests/integration/billing-authority-writer.test.ts --maxWorkers=1`.
- [ ] **Step 2 implement** the writer: validate policy (T2P), root/epoch/nonce, key
  commitment and pinned digest under the write lock; seal privately; write log+head+projection
  atomically; never accept a caller assertion of "already verified".
- [ ] **Step 3 GREEN** + `npm run typecheck`. STOP for parent review.

## Step 4 — adversarial and process proof

**Files:** modify `packages/storage/billing-authority.ts`; test
`tests/integration/billing-authority-writer-adversarial.test.ts`.

- [ ] **Step 1 RED.** Tests: tampered/replayed frames and a stale head deny; a coherent older
  snapshot + matching head remains an **explicit residual limit** (assert only the known-head
  CAS); bound exhaustion denies with no partial success; an unadmitted writer cannot reserve;
  the writer is unreachable from HTTP/local composition (module imported only by tests); a
  default-off root leaves all existing money-4 bytes and legacy audits unchanged. Command:
  `npx vitest run tests/integration/billing-authority-writer-adversarial.test.ts --maxWorkers=1`.
- [ ] **Step 2 implement** the remaining guards/bounds and the adversarial fixtures.
- [ ] **Step 3 GREEN** + separate `npm run typecheck`, `npm run lint`, `npm run build`.
  Re-run the focused B0 suites serially. STOP for parent review.

## Global constraints

- Default off; no external payment or model call; `EvidenceSource` absent in production.
- MAC authenticity is not payment truth; B0 cannot prove Paddle was contacted without the
  approved B1 adapter. Tests assert structural grant integrity, not provider truth.
- Operator `4 → 5` remains an explicit offline migration; the current constructor auto-DDL is
  described honestly as auto-DDL (old audits stale), never as offline.
- No toggle changes global money. Existing financial schema-4/tenant-5 tests stay the baseline.

## Not in this plan (T3/T4)

Audit `accountConfigHash`/inventory split (`storage/managed-activation-state.ts:196,220,300`,
`runtime/managed-audit.ts:542,1155,1160`, `storage/managed-activation.ts:~303`,
`runtime/managed-activation.ts` baseline guards); global version 5 migration and restore
hooks; tenant incarnation/generation; policy enrollment CLI; backup key manifest.
