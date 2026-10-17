# Billing admission integration (T3) — Implementation Plan

> **STATUS: PARENT-REVIEWED EXECUTION CONTRACT — IMPLEMENTATION AUTHORIZED BELOW.**
>
> Internal technical review under the approved B0 design
> (`docs/superpowers/specs/2026-10-17-renewal-safe-financial-authority-design.md`). This is
> **not** a new business-policy question and not an approval. Do not run tests, migration or
> source edits beyond the execution contract below. Parent owns `BUILD_STATE.md`, the
> checklist and every `*-review` test.
>
> **For agentic workers (after authorization only):** REQUIRED SUB-SKILL: `writing-plans` →
> `executing-plans`. TDD: failing test → RUN → observe RED → implement → GREEN. Execute ONE
> task, then STOP for parent review. Nothing here is implemented, accepted or verified
> because this plan exists.

**Goal:** Add the real admission writer, provisioning generation + durable fencing, the
mandatory low-level reserve/mark enforcement, bounded verification, and the explicit
non-funding money-5 install operation — so an enrolled root cannot fund a raw-SQL or stale
caller, while genuine v4 legacy behavior is unchanged and a legitimate renewal or new paying
customer needs no offline re-audit.

## Parent review corrections — authoritative over the body below

T2W is accepted: parent 430 passed / six explicit platform skips, including 384 B0 checks
and two actual-process races; typecheck/lint/build passed. Its authority DDL includes
retained denials as a real closed contract, not a test-only extra. The earlier draft is
**not executable** until these integration closures replace its contradictory proposed
interfaces and algorithms. This is internal technical review under the approved B0 design,
not another business-policy approval request.

### Execution authorization — 2026-10-18

The owner requested continuation; parent reviewed the revised plan and authorizes the
**whole coherent T3 slice**, test-first, followed by one independent parent gate. Do not
stop after isolated generation/preflight helpers and claim admission safety. These exact
technical closures supersede contradictory pseudocode later in this document:

- **Preserve accepted schema variants:** retain the existing strict journal and standalone
  eight-table `authority` variants unchanged. Add an explicitly named `integrated` variant
  composing the eight-table DDL with the six integration tables below; no silent widening
  of `BILLING_AUTHORITY_DDL` or old digest behavior. Extend the journal reader's explicit
  variant union only through that closed seam. The writer/readonly verifier deliberately
  select `integrated` only on genuine v5, otherwise their existing authority variant.
- **Owned correlation contract:** add `correlation?: BillingCorrelationSource|null` to
  `BillingAuthorityOptions`, default null, with
  `resolve({account_id,identity_digest}): Promise<ServerBillingCorrelation>`. Its closed
  result is `{schema:1,mode,product_ref,price_ref,cadence,customer_ref,subscription_ref,
  initial_transaction_ref,correlation_ref,version}`; the authority, not the source, fills
  account identity/incarnation/generation and validates the frozen tuple. Resolve all tenant
  paths privately from the already trusted root + control UUID and verify actual marker,
  generation and path containment before read-only opening. No caller tenant path, key,
  proof object, parsed policy or allow boolean. No production correlation source or route.
- **Authenticate the complete preflight record:** retain canonical closed proof JSON
  including account/identity, incarnation/generation, binding, actual baseline snapshot,
  policy/key/root/epoch, request UUID, created/expires. Its purpose-specific admission
  frame authenticates `request:<SHA256(canonical_complete_record)>` in `source_ids`, as
  well as binding/baseline/preflight references. Reload/re-hash every stored column and
  body before consumption. Expiry is exactly 15 minutes after creation; future creation,
  expired proof, mutable expiry substitution or any changed generation/fence denies.
- **Support empty-journal admission:** the private append creates the first head with an
  exclusive INSERT when the verified journal is empty, otherwise updates it by exact CAS;
  no fixture-seeded admission or head is required for a real first admission. Critical
  rows/readbacks and head commit together; replay returns the original admitted outcome
  only if all stored proof/admission bindings still match, never another append.
- **No v4 fingerprint drift:** include new schema keys only in the v5 signature branch;
  adding even an empty field to canonical v4 signatures would change accepted audits.
  Every positive billing cap equals the sealed policy, not merely `<=` a mutable SQL cap.
  Baseline-manual means no additional billing entitlement, not exemption from sealed
  historical hash, current activation, global hold barriers or the four original caps.
- **Boundary completeness:** lifecycle fence acquisition must happen before constructing
  a rebuilding `Storage`, not inside a hook after it mutates history. Existing v5 schema-1
  tenants without backfilled generation remain knowledge-readable but non-funding until
  offline enrollment; don't make installing v5 itself erase ordinary account access.
  Cached runtime handles recheck generation/fence before funding and cannot revive a
  pre-rebuild admission. Supported restore/rebuild/replacement paths must be enumerated
  and actually wired; unsupported replacement remains denied, never auto-adopted.

Implement installer + exact DDL + mandatory funding gates + real owned admission +
generation/fencing + bounded verifier + audit integration together. T4 operational CLI,
real protected enrollment/key backup and live activation remain out of scope. Synthetic
fixtures explicitly create a protected enrollment anchor using the production validation
contract; no exported production fixture/enroll bypass. Parent owns all `*-review` tests,
including the currently RED missing-installer test. No owner data, dependencies, lockfile,
real keys, paid model calls, checkout, B1 transport, git commit/push or deployment actions.

1. **No optional enforcement or row-presence mode fallback.** Money-5 reserve/mark must
   discover and enforce the root's actual enrollment state without a caller choosing a
   guard. An account is manual only through positively verified membership in the sealed
   offline baseline; deletion of `control_billing_account`, a key, a policy file or an
   enrollment row cannot classify an enrolled root/account as legacy. Missing/inconsistent
   enrolled dependencies deny new funding. Genuine unchanged money-4 legacy operation
   remains compatible; known settlements never depend on a currently usable grant. Define
   a durable enrollment anchor and recovery states.
2. **Frozen baseline plus authenticated additions.** Keep every original audited account
   (including empty accounts) under its historical, period-inclusive manual fingerprint.
   New no-history capture accounts do not alter that frozen digest; authenticate their
   server-controlled provisioning/incarnation classification. Dynamic financial
   admissions/grants are checked as signed additions, not appended to a supposedly stable
   inventory hash. Raw SQL history cannot hide in the excluded set, and existing manual
   accounts are never silently adopted into billing.
3. **Owned preflight, not public key/policy/path injection.** The service loads its
   root/control/path/identity from trusted runtime composition. Public prepare/admit
   receives only owned account/reference identifiers; provider/browser fields, proof
   bodies, keys and parsed policies are not authority. A retained preflight contains closed
   canonical proof JSON plus authenticated scope, request UUID, generation, expiry and
   consumption state. The initial billing tuple comes only from a trusted server
   correlation dependency (production null until B1), never an HTTP assertion.
4. **Durable fencing closes the cross-database race.** Provision starts non-funding. Every
   supported restore/rebuild/replacement or financial-history-changing path first fences
   the account and advances generation in the control store, then mutates tenant storage; a
   partial operation remains fenced. Preflight reads one consistent read-only tenant
   snapshot outside any control transaction. Admission and fence acquisition serialize on
   the same central generation; publish rechecks signature, expiry, identity, policy,
   incarnation, absence of central history and no active fence, then consumes the proof and
   appends admission atomically. List exact supported path hooks. A monotonic trigger or
   short expiry alone is not race protection.
5. **Bounded verification has a precise trust scope.** Verify the complete bounded chain at
   startup into a process-owned prefix/revocation index. New heads require a contiguous
   bounded suffix verification outside model-send money transactions. Reserve/mark checks
   the verified-head CAS plus actual authenticated account/term/receipt/grant/freshness/
   period/caps/generation. A changed or backward head refuses funding until refreshed; no
   full-journal/account-history scan on every send. Do not claim per-call detection of
   unrelated historical edits. Startup/suffix exhaustion denies; no silent pruning. Defer
   persistent checkpoints to authenticated offline enrollment rather than trusting the
   draft's unsigned SQL checkpoint row.
6. **One migration/enforcement activation boundary.** Money-5 migration, exact closed DDL,
   mandatory low-level guards and audit integration are one coherent gate, proven against a
   genuine frozen-v4 database. It stays non-funding until reviewed offline enrollment
   exists. Constructor migration must not silently mint admission, enroll keys or enable
   profiles. Preserve old rows/FKs/unknown holds byte-identical; failed COMMIT or ignored
   writes roll back. Restore/key backup and operational enrollment remain T4 live-readiness
   gates, never an optional bypass.
7. **Money-5 is an explicit non-funding install, never an auto-promotion.** A genuine
   legacy v4 database and its manual behavior are unchanged; the normal `ManagedSpendingStore`
   constructor on v4 stays v4 and must not promote every root to v5 (that would block the 984
   accepted tests and auto-enable an unreviewed boundary). The *only* path to v5 is the new
   explicit application operation `installBillingMoney5({control, root, offline,
   workers_terminated})` in `packages/storage/billing-install.ts`: the two acknowledgements
   are required `true` attestations (**necessary, not proof** that old workers ended); it
   checks a contained root and the exact actual v4 schema; it atomically installs the full
   reviewed v5 DDL plus a **non-funding install record**; it mints **no** key, policy,
   admission, enrollment or generation. On reopen at v5 the same constructor verifies the
   strict schema and does **not** auto-heal a missing authority table; a version greater than
   5 fails before any DDL. Separate legacy-v4 and billing-v5 contracts are exported, and
   activation/audit read the actual stored version; the existing v3→v4 test still asserts v4
   remains correct. A v5 unenrolled `new ManagedSpendingStore(control)` denies reserve/mark
   even with positive SQL caps, while known settlement is unchanged and knowledge/auth stay
   usable. This keeps "legacy/manual behavior unchanged" literally true and defers the CLI
   wrapper to T4.

Parent explicitly rejected the draft's optional `billingGuard`, derived-manual fallback,
caller-supplied key/policy/tenant path, unsigned checkpoint, dynamically changing frozen
inventory, missing actual admission writer, guessed migration tests/API names and a global
auto money-5 version bump. Ordinary technical choices may proceed inside these closures; no
live actions, model calls, owner data or B1 transport authorized.

---

### Final reservation/prefix closure — required before T3 acceptance

An authenticated grant is not permission to re-authorize an older reservation. The
integrated schema additionally owns immutable `control_billing_reservation` records:
`call_id` (PK/FK to the actual central reservation), `account_id`, `epoch`,
`admission_ordinal`, `tenant_incarnation`, `provisioning_generation`, `term_id`,
`window_id`, `period_id`, `grant_ordinal`, `grant_mac`, `proof_json`, `proof_mac`,
`created_at` (all NOT NULL). Canonical closed proof JSON authenticates all these
authority fields plus the complete immutable call identity, root/policy/binding
scope, under a private `billing-reservation/v1` purpose. It adds no parallel balance.
Reserve inserts hold + proof + time-zone freeze in one short transaction; mark and
pre-I/O require that same original binding and call identity. Missing/corrupted proof
never selects legacy mode. Denied or ignored proof insertion rolls back every write.
Known settlement remains available independently of current grant/key validity.

Enforcement owns a verified prefix index: one bounded full startup verification outside
the money write transaction, then **only contiguous forward suffixes** on a changed
head, plus bounded point reauthentication of current dependencies. It retains signed
admission/grant/revocation identities and adverse generations; SQL counters cannot erase
revocation. A backward head, same-ordinal changed MAC, gap, exhaustion or stale in-lock
head refuses funding. Do not replace the suffix walk with repeated bounded full scans.
Original term provenance and a later annual month's grant have distinct ordinals; both
must authenticate the same immutable paid receipt without being required to be the same
grant. Positive fresh funding after a legitimate monthly annual renewal is required.
Parent's proof-write fault, call substitution, no-rebind, pre-I/O and real SQL scope tests
are part of the gate, together with lifecycle fencing and the original financial barriers.

Parent review additionally reproduced downgrade and cache-corruption bypasses after
the first suffix implementation. The running prefix must retain authenticated
per-account adverse generations and revoked term identities, not just a head MAC.
Deleting an already-observed revocation cannot restore permission while its known
head remains. A missing v5 marker in the presence of integrated storage or the
protected enrollment artifact is corrupt/non-funding, never genuine legacy v4.
Installer success likewise requires COMMIT to actually end its owned transaction;
retained legacy money tables, foreign keys, indexes and immutable triggers belong
to the exact catalog validation, not only the added billing namespace. Fresh v5
activation/audit readers and enrollment must use the actual supported version,
while preserving profile schema 1 and the separate sandbox transport prohibition.

## 0. Accepted writer contract this slice builds on (exact, frozen)

`packages/storage/billing-authority.ts` (T2W, accepted 430/6):

```ts
export interface BillingAuthorityOptions {
  control: ControlStore; root: string; source?: EvidenceSource | null; clock?: () => Date;
}
export class BillingAuthority {
  constructor(options: BillingAuthorityOptions);
  reconcile(account_id: string): Promise<ReconciliationDecision>; // requires source; async
  billingEligibility(account_id: string): BillingEligibility;
  ensureCurrentGrant(account_id: string): BillingEligibility;
}
```

It already loads the frozen trusted context (protected `.protected/billing-policy.json`,
`loadBillingKey(root)`, the `control_billing_policy` cache row, the `managed_control_epoch`
row and root marker), verifies the whole bounded `control_billing_log` chain, and publishes
grant/revocation frames plus `managed_account_periods`. `snapshot()` requires an existing
`control_billing_account` row and a signed `admission` frame at `admission_ordinal`; it
checks `admission.body.tenant_incarnation === binding.tenant_incarnation`,
`source_ids.includes('binding:'+digest)` and `includes('baseline:'+clean_baseline_proof)`.
**It has no admission writer** — this slice adds it. `ServerOwnedBinding` already carries
`tenant_incarnation` and `provisioning_generation` (`packages/domain/billing-evidence.ts`),
so the generation layer plugs straight in.

Frozen exports reused unchanged: `BILLING_JOURNAL_DDL`, `BILLING_AUTHORITY_DDL`,
`billingSchemaVariant`, `billingAuthoritySchemaDigest`,
`readBillingJournal(db, binding, key, {max_entries, variant:'authority'})`,
`canonicalSealFrame`, `sealMac`, `verifySealMac`, `loadBillingKey`, `billingKeyCommitment`,
`validateBillingOperatorPolicy`, `billingOperatorPolicyDigest`, `resolveBillingCatalogPlan`,
`identityDigest`, `bindingDigest`, `validateServerOwnedBinding`, `validateProviderFacts`,
`receiptFromFacts`, `receiptDigest`, `receiptTermId`, `observationDigest`,
`validateBillingObservation`.

## 1. Closed decisions (rewritten to the seven corrections)

1. **Enforcement is discovered, never injected.** `ManagedSpendingStore` always builds one
   `BillingEnforcement` from its own `control`/`control.path` root. There is no optional
   guard argument and no `ManagedSpendingStore(control)` bypass. Enforcement is a closed
   union:
   - `legacy` — genuine money-4 schema (no `control_billing_` namespace): unchanged today.
   - `unenrolled` — v5 installed, no durable enrollment anchor: **non-funding** for every
     account (knowledge/capture/export still work), known settlements allowed.
   - `enrolled` — anchor present: each account is `manual` only if in the sealed
     `control_billing_manual_baseline`; `billing` only if it has a `control_billing_account`
     row with a valid signed admission; otherwise `unadmitted` → non-funding.
   A missing key/policy/enrollment artifact/row/epoch on an enrolled root returns deny,
   never `manual`/`legacy`.
2. **Root enrollment lives durably in protected pin + DB row + schema.** Enrollment is the
   conjunction of: protected `<root>/.protected/billing-enrollment.json` (regular,
   non-linked, `0600` POSIX, bounded, canonical JSON), the `control_billing_enrollment`
   cache row whose `enrollment_digest` equals that artifact, the `control_billing_policy`
   row, the `managed_control_epoch` row, and the v5 schema. Any missing/inconsistent member
   → `unenrolled` deny, never fallback.
3. **Owned preflight with a local purpose-tagged MAC.** Public admission receives only
   `{account_id}` (prepare) and `{account_id, preflight_id}` (admit). `beginAdmission` loads
   root/control/path/identity from composition, derives the binding from an injected trusted
   `BillingCorrelationSource` (production `null`), reads one read-only tenant snapshot
   outside any control transaction, and retains a `control_billing_preflight` row whose
   `proof_json` is the canonical admission-purpose seal frame (ordinal `0`, `prev_mac ""`,
   `source_ids ["binding:<digest>","baseline:<proof>","preflight:<id>"]`) and whose
   `proof_mac = sealMac(proof_json, key)`. A caller can supply neither key, policy, path,
   proof body, digest nor `verified`. `admitAccount` re-derives and seals the real journal
   frame at the live head ordinal.
4. **Durable fencing.** `managed_account_fence(account_id, generation, reason, fenced_at,
   cleared_at)` is written and the generation advanced in the control store **before** any
   tenant mutation, and cleared only after it completes; a crash leaves the fence active
   (deny). Admission and fence acquisition serialize on the same `provisioning_generation`.
   Exact hooks: `ManagedRuntime.provision` (fresh: no fence), tenant rebuild
   `new Storage(db,{vault})` when `recoveringFromExistingVault` (`packages/storage/index.ts`),
   `applyRestoreSafetyBarrier`/`applyControlRestoreBarrier`, `restoreManagedBackup` +
   `rotateStagedEpoch` (`packages/runtime/managed-recovery.ts`), and account replacement. The
   knowledge import path (`preview`/`applyImport`) never writes financial tables and is
   asserted, not fenced.
5. **Bounded verification, precise scope.** A process-owned `BillingPrefixIndex` is built at
   startup by a single bounded full-chain verification (`max_entries = 100_000`, 16 MiB
   frame bound) into a verified prefix + revocation index. A changed/forward head triggers a
   contiguous bounded **suffix** verification (`lastVerifiedOrdinal+1 … head`) **outside** the
   money transaction; a backward or gapped head refuses funding until refreshed. `reserve`/
   `mark` never scan the journal: they check the verified-head CAS plus the actual
   authenticated account/term/receipt/grant/freshness/period/caps/generation. No persistent
   checkpoint table is created; checkpoints are deferred to T4 authenticated offline
   enrollment. We do not claim per-call detection of unrelated historical edits.
6. **One boundary, explicitly installed.** The v5 DDL, mandatory guards, audit integration
   and the frozen-v4 proof are one gate, but v5 is reached only through
   `installBillingMoney5`. The normal constructor installs/accepts v4 only. The install writes
   no admission, key, policy, enrollment anchor or generation; it writes a non-funding
   install record. Existing rows/FKs/unknown holds stay byte-identical; failed COMMIT or SQL
   `RAISE(IGNORE)` rolls back. Until the reviewed offline enrollment exists the installed root
   is non-funding.

## 2. File map

```
packages/domain/billing-admission.ts        NEW  pure proof/incarnation/fence/decision shapes
packages/domain/managed-spend.ts            MOD  legacy v4 + billing v5 version contracts
packages/storage/billing-schema.ts          MOD  extend AUTHORITY_TABLES + BILLING_AUTHORITY_DDL
packages/storage/billing-install.ts         NEW  installBillingMoney5 + v5 DDL + strict verify
                                                       (parent-owned review test targets this path)
packages/storage/billing-verify.ts          NEW  read-only verify helpers shared by writer+guard
packages/storage/billing-authority.ts       MOD  add beginAdmission/admitAccount; delegate reads
packages/storage/billing-enforcement.ts     NEW  enforcement state + prefix index + in-tx guard
packages/storage/managed-incarnation.ts     NEW  mint/rotate/read generation + fence rows
packages/storage/managed-spending.ts        MOD  version-branch migrate(); mandatory guard
packages/storage/managed-activation-state.ts MOD controlSchemaSignature v5; unified config hash
packages/runtime/managed.ts                 MOD  marker schema 2; provision mint; fence on rebuild
packages/runtime/managed-recovery.ts        MOD  restore/rotate fences + advances generation
packages/runtime/managed-audit.ts            MOD  enrollment-aware baseline + signed additions
```

Not touched: `billing-key.ts`, `billing-journal.ts`, `billing-policy.ts`,
`domain/billing-authority.ts`, `domain/billing-seal.ts` (frozen). `billing-schema.ts` and
`billing-authority.ts` change only through the deliberate seams below; the 430 baseline and
the existing v3→v4 test must stay green.

## 3. Version contracts and exact new DDL

```ts
// packages/domain/managed-spend.ts  (separate legacy/billing contracts, actual version read)
export const managedMoneySchemaVersion = 4 as const;      // legacy constructor target, unchanged
export const managedMoneyBillingVersion = 5 as const;     // explicit billing install only
export const managedMoneySupportedVersions = [4, 5] as const;
```

`ManagedSpendingStore.migrate()` (version-branching, no auto-promotion):

```ts
this.db.exec("BEGIN IMMEDIATE");
try {
  const version = tableExists("managed_money_schema")
    ? Number(max(version)) : 0;
  if (version > managedMoneyBillingVersion)
    throw new BrainError("UNAVAILABLE", "Managed spending schema is from a newer version.", 503);
  if (version === managedMoneyBillingVersion) {
    verifyBillingMoney5Schema(this.db);           // strict; no CREATE, no auto-heal
  } else {
    this.db.exec("CREATE TABLE IF NOT EXISTS managed_money_schema(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);");
    this.db.exec(MONEY_LEGACY_DDL);                // current v4 tables, verbatim
    this.db.prepare("INSERT OR IGNORE INTO managed_money_schema VALUES(?,?)")
      .run(managedMoneySchemaVersion, this.clock().toISOString());
  }
  this.db.exec("COMMIT");
} catch (error) { this.db.exec("ROLLBACK"); throw error; }
```

New DDL (added to `BILLING_AUTHORITY_DDL` / the v5 install; the incarnation + fence tables
are control-plane and join `controlSchemaSignature`):

```sql
CREATE TABLE IF NOT EXISTS managed_account_incarnation(
  account_id TEXT PRIMARY KEY REFERENCES managed_accounts(id),
  incarnation TEXT NOT NULL CHECK(length(incarnation)=64),
  provisioning_generation INTEGER NOT NULL CHECK(provisioning_generation>=1),
  source TEXT NOT NULL CHECK(source IN ('provision','restore','rebuild','enroll')),
  minted_at TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS managed_account_incarnation_monotonic
  BEFORE UPDATE ON managed_account_incarnation
  WHEN NEW.account_id<>OLD.account_id OR NEW.provisioning_generation<=OLD.provisioning_generation
    OR length(NEW.incarnation)<>64
  BEGIN SELECT RAISE(ABORT,'account incarnation must advance monotonically'); END;
CREATE TABLE IF NOT EXISTS managed_account_fence(
  account_id TEXT PRIMARY KEY REFERENCES managed_accounts(id),
  generation INTEGER NOT NULL CHECK(generation>=1),
  reason TEXT NOT NULL CHECK(reason IN ('rebuild','restore','replace')),
  fenced_at TEXT NOT NULL, cleared_at TEXT);

CREATE TABLE IF NOT EXISTS control_billing_install(
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  schema INTEGER NOT NULL CHECK(schema=1), version INTEGER NOT NULL CHECK(version=5),
  nonfunding INTEGER NOT NULL CHECK(nonfunding=1),
  offline INTEGER NOT NULL CHECK(offline=1), workers_terminated INTEGER NOT NULL CHECK(workers_terminated=1),
  installed_at TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS control_billing_install_immutable
  BEFORE UPDATE ON control_billing_install BEGIN SELECT RAISE(ABORT,'billing install is immutable'); END;
CREATE TABLE IF NOT EXISTS control_billing_enrollment(
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  schema INTEGER NOT NULL, version INTEGER NOT NULL,
  epoch INTEGER NOT NULL CHECK(epoch>=1), root_nonce TEXT NOT NULL CHECK(length(root_nonce)=64),
  policy_digest TEXT NOT NULL CHECK(length(policy_digest)=64),
  key_commitment TEXT NOT NULL CHECK(length(key_commitment)=64),
  mode TEXT NOT NULL CHECK(mode IN ('sandbox','live')),
  baseline_digest TEXT NOT NULL CHECK(length(baseline_digest)=64),
  roster_digest TEXT NOT NULL CHECK(length(roster_digest)=64),
  enrollment_digest TEXT NOT NULL CHECK(length(enrollment_digest)=64),
  enrolled_at TEXT NOT NULL);
CREATE TRIGGER IF NOT EXISTS control_billing_enrollment_immutable
  BEFORE UPDATE ON control_billing_enrollment BEGIN SELECT RAISE(ABORT,'billing enrollment is immutable'); END;
CREATE TABLE IF NOT EXISTS control_billing_manual_baseline(
  account_id TEXT PRIMARY KEY REFERENCES managed_accounts(id),
  config_digest TEXT NOT NULL CHECK(length(config_digest)=64),
  baseline_digest TEXT NOT NULL CHECK(length(baseline_digest)=64),
  captured_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS control_billing_preflight(
  preflight_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES managed_accounts(id),
  incarnation TEXT NOT NULL CHECK(length(incarnation)=64),
  provisioning_generation INTEGER NOT NULL CHECK(provisioning_generation>=1),
  identity_digest TEXT NOT NULL CHECK(length(identity_digest)=64),
  binding_digest TEXT NOT NULL CHECK(length(binding_digest)=64),
  binding_json TEXT NOT NULL,
  policy_id TEXT NOT NULL, policy_digest TEXT NOT NULL CHECK(length(policy_digest)=64),
  root_epoch INTEGER NOT NULL CHECK(root_epoch>=1), root_nonce TEXT NOT NULL CHECK(length(root_nonce)=64),
  proof_json TEXT NOT NULL, proof_mac TEXT NOT NULL CHECK(length(proof_mac)=64),
  mode TEXT NOT NULL CHECK(mode IN ('sandbox','live')),
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  consumed_at TEXT, admission_ordinal INTEGER,
  UNIQUE(account_id, incarnation, provisioning_generation));
CREATE TRIGGER IF NOT EXISTS control_billing_preflight_frozen
  BEFORE UPDATE ON control_billing_preflight
  WHEN NEW.preflight_id<>OLD.preflight_id OR NEW.account_id<>OLD.account_id
    OR NEW.incarnation<>OLD.incarnation OR NEW.provisioning_generation<>OLD.provisioning_generation
    OR NEW.binding_digest<>OLD.binding_digest OR NEW.binding_json<>OLD.binding_json
    OR NEW.proof_json<>OLD.proof_json OR NEW.proof_mac<>OLD.proof_mac OR NEW.created_at<>OLD.created_at
    OR (OLD.consumed_at IS NOT NULL AND NEW.consumed_at<>OLD.consumed_at)
  BEGIN SELECT RAISE(ABORT,'billing preflight is immutable'); END;
```

The four new `control_billing_*` tables join `AUTHORITY_TABLES` and `BILLING_AUTHORITY_DDL`;
the two `managed_account_*` tables join `controlSchemaSignature`. `billingSchemaVariant`
therefore still requires the *deliberate* full variant; a `control_billing_` object outside
the closed set keeps the DB `unknown` and both digests refuse.

## 4. Task 1 — Generation, fence, admission shapes

**Files:** create `packages/domain/billing-admission.ts`, `packages/storage/managed-incarnation.ts`,
`tests/helpers/billing-admission-ddl.ts`; modify `packages/storage/managed-activation-state.ts`,
`packages/runtime/managed.ts`, `packages/runtime/managed-recovery.ts`.
**Tests:** `tests/integration/billing-admission-generation.test.ts`,
`tests/integration/billing-admission-generation-review.test.ts` (parent).

**Produces (pure):**
```ts
export type IncarnationSource = "provision"|"restore"|"rebuild"|"enroll";
export interface Incarnation { incarnation: string; provisioning_generation: number;
  source: IncarnationSource; minted_at: string; }
export function mintIncarnation(input: { account_id: string; issuer: string; subject: string;
  provisioning_generation: number; minted_at: string; nonce: string }): Incarnation;
export interface CleanBaselineProof { schema: 1; account_id: string; incarnation: string;
  provisioning_generation: number; tenant_schema_version: number;
  provider_dispatches: 0; legacy_reservations: 0; paid_processing_blocked: false; }
export function cleanBaselineDigest(input: CleanBaselineProof): string;
export interface EnrollmentAnchor { schema: 1; policy_digest: string; key_commitment: string;
  mode: "sandbox"|"live"; epoch: number; root_nonce: string; baseline_digest: string;
  roster_digest: string;
  accounts: Array<{ account_id: string; config_digest: string; baseline_digest: string }>; }
export function validateEnrollmentAnchor(input: unknown): EnrollmentAnchor;
```
**Produces (storage, `DatabaseSync` only):** `readAccountIncarnation`, `mintAccountIncarnation`
(INSERT-only), `rotateAccountIncarnation`, `activeFence`, `fenceAccount` (writes fence +
advances generation), `clearFence` (sets `cleared_at` only).

`mintIncarnation` is deterministic: `sha256(canonical({schema:1,account_id,issuer,subject,
provisioning_generation,minted_at,nonce}))`. `ManagedRuntime.provision` order: control
account → tenant store/vault/protected → **if `managed_account_incarnation` exists** mint
central row (schema-2 marker) → `assertTenant` cross-checks `marker.schema===2`,
`marker.incarnation===row.incarnation`, `marker.provisioning_generation===row.generation`.
On genuine money-4 the table is absent → today's schema-1 marker, unchanged. `assertTenant`
refuses an active fence. `rotateStagedEpoch` (recovery) fences each account (`restore`),
rotates its incarnation, rewrites the tenant marker, then clears the fence; a partial run
leaves an active fence. **The install (Task 5) writes no generation; existing accounts are
backfilled only by the deferred T4 offline enrollment.** New provisions after install mint
generation 1.

**Steps:** 1) failing test: fresh v5 provision mints gen 1 + schema-2 marker; repeated
provision never resets; marker/central mismatch refuses `acquire`; active fence blocks
`acquire`; raw-SQL generation decrease aborts. 2) `npx vitest run
tests/integration/billing-admission-generation.test.ts --maxWorkers=1` → RED. 3) implement.
4) GREEN + `npm run typecheck`. STOP.

## 5. Task 2 — Real admission writer (owned preflight + admit)

**Files:** modify `packages/storage/billing-authority.ts` (add methods; delegate reads to
`billing-verify.ts`), `packages/storage/billing-schema.ts` (DDL/catalog seam); create
`packages/storage/billing-verify.ts`.
**Tests:** `tests/integration/billing-admission-writer.test.ts`,
`tests/integration/billing-admission-writer-review.test.ts` (parent).

**Produces:**
```ts
export type AdmissionReason = "no_source"|"dirty_baseline"|"generation_mismatch"|"fenced"
  |"policy_mismatch"|"root_mismatch"|"already"|"expired"|"conflict";
export type AdmissionDecision = { state: "prepared"; preflight_id: string }
  | { state: "admitted" } | { state: "denied"; reason: AdmissionReason };
// on BillingAuthority:
beginAdmission(account_id: string): Promise<AdmissionDecision>;
admitAccount(input: { account_id: string; preflight_id: string }): AdmissionDecision;
```

`beginAdmission`: load context; read account + incarnation (`generation_mismatch` deny if
absent); active fence → `fenced`; `correlation.resolve(account_id)` (production `null` →
`no_source`) → validated `ServerOwnedBinding` using the *central* incarnation/generation; open
the tenant DB read-only (trusted path) and require `provider_dispatches=0`, `reservations=0`,
`paid_processing_blocked` absent — all **outside** any control tx; then `BEGIN IMMEDIATE`
re-checking account/incarnation/epoch/policy/key/no-fence/not-already-admitted and inserting
the preflight row (`expires_at = now+15min`, `proof_mac = sealMac(proof frame, key)`); COMMIT.
`admitAccount`: `BEGIN IMMEDIATE`; re-read preflight; require unconsumed, unexpired, live
account/incarnation/generation, no fence, matching epoch/policy/key and
`verifySealMac(proof_json,key,proof_mac)`; re-scan bounded central absence of history; build
the journal `admission` frame at `head.ordinal+1` with
`source_ids ["binding:<digest>","baseline:<proof>","preflight:<id>"]`, seal, `insertLog`
(log + head CAS + readback); insert `control_billing_account(admission_ordinal=head+1,
adverse_generation=0)`; mark the preflight consumed; readback; COMMIT. `source` stays `null`
in production; the correlation source is injected only in tests.

**Steps:** 1) failing test: prepare→admit yields one admission frame + account row; replayed
preflight denied; expired preflight denied; generation/fence change between prepare and admit
denied; a forged `proof_mac` denied; `source=null` → `no_source` with no write. 2) run → RED.
3) implement + extract `billing-verify.ts` read helpers shared with Task 3. 4) GREEN,
`npm run typecheck`, and re-run the full `billing-authority-*` suite to confirm the 430
baseline. STOP.

## 6. Task 3 — Mandatory low-level enforcement + bounded verification

**Files:** create `packages/storage/billing-enforcement.ts`; modify
`packages/storage/managed-spending.ts`.
**Tests:** `tests/integration/billing-reserve-guard.test.ts`,
`tests/integration/billing-reserve-guard-review.test.ts` (parent).

**Produces:**
```ts
export type EnforcementState = "legacy"|"unenrolled"|"enrolled";
export class BillingEnforcement {
  static forControl(control: ControlStore, clock: () => Date): BillingEnforcement;
  state(): EnforcementState;
  classify(db: DatabaseSync, accountId: string): "manual"|"billing"|"unadmitted"|"legacy";
  prepareForSend(db: DatabaseSync): void;   // OUTSIDE the money tx: startup/suffix verify
  assertNewFundingWithinTx(db: DatabaseSync, a: { account_id: string; period_id: string;
    now: Date; stage: string }): void;
}
```

`ManagedSpendingStore` builds one in its constructor (lazily; `legacy` on money-4, so the
existing v3→v4 test, the 430 baseline and money-4 behavior are byte-unchanged).
`reserve`/`mark` call `prepareForSend` before `this.tx(...)` and `assertNewFundingWithinTx`
inside the existing `BEGIN IMMEDIATE` after `assertActivationSeam`. Semantics:
- `legacy`/`manual` → no new restriction (today's behavior; unknown-hold global pause and
  known settlement unchanged).
- `unenrolled`/`unadmitted`/missing key/policy/enrollment → deny new funding for every stage,
  even when the SQL caps are positive.
- `billing` → require the verified-head CAS, a valid signed admission, exact grant-mapped
  `period_id = control_billing_period.period_id` for the `managed_account_periods` row,
  `window_start <= now < window_end`, an unexpired authenticated freshness MAC whose
  `expires_at > now`, catalog caps `<= resolveBillingCatalogPlan(...)`, and no active fence.
  `activePeriod` for an admitted account resolves only through the grant mapping; a manual
  period on an admitted account denies.
`BillingPrefixIndex` (inside the enforcement): startup `readBillingJournal(db,
{epoch,root_nonce,policy_id},key,{max_entries:100_000,variant:'authority'})`; forward head →
bounded suffix verify outside the tx; backward/gapped/exhausted → refuse funding until
refreshed. No checkpoint table.

**Steps:** 1) failing test: admitted account + exact grant period allowed; raw-SQL period on
an admitted account denied; raw-SQL `control_billing_account` without a journal admission
denied; v5 unenrolled store denies reserve/mark with positive caps; reserve before
`window_end`/mark after denied with no rebind; restore (changed generation) denied;
two-process admission/mark race → one grant; unknown hold on A blocks B and every stage;
known settlement after expiry still settles. 2) run → RED. 3) implement. 4) GREEN,
`npm run typecheck`, `npm run lint`. STOP.

## 7. Task 4 — Audit integration (frozen baseline + signed additions)

**Files:** modify `packages/runtime/managed-audit.ts`, `packages/storage/managed-activation-state.ts`.
**Tests:** `tests/integration/billing-audit-split.test.ts`,
`tests/integration/billing-audit-split-review.test.ts` (parent). Preserve every existing
`managed-audit-*` test.

`accountConfigHash` is unified in `managed-activation-state.ts` (single source).
`controlSchemaSignature` includes the two new control tables only when present (deterministic
`[]` otherwise), so the v4 digest is unchanged. Activation and audit read the **actual**
stored version via `managedMoneySupportedVersions`: v4 → today's checks; v5 → authority
namespace + enforcement state. `scanOnce` becomes enrollment-aware: `legacy` → today's digest;
`unenrolled` → `unsupported_schema` deny; `enrolled` → static policy/caps/catalog/key/epoch/
schema must equal the enrollment anchor; each account is classified `manual` (must equal its
sealed `control_billing_manual_baseline` period-inclusive `config_digest`) / `billing`
(admission + terms + grants + periods + denials + freshness verified against the journal) /
`unadmitted` (proven no financial history). A new no-history account is authenticated by its
incarnation/provisioning classification + the current-history predicate and does not alter
the frozen baseline; an account with history that is neither baseline-manual nor validly
admitted denies. `readEnrollmentBaseline`/`readSendGuardBaseline` compare against the
enrollment anchor and the prefix index—never a growing inventory hash and never a full tenant
scan on the send path.

**Steps:** 1) failing test: original empty/manual accounts stay frozen; authorized grant on an
admitted account does not stale a fresh enrol-audit; raw-SQL period on a manual account
stales/denies; raw-SQL `control_billing_account` without admission denies. 2) run → RED.
3) implement. 4) GREEN, `npm run typecheck`. STOP.

## 8. Task 5 — Explicit non-funding money-5 install

**Files:** create `packages/storage/billing-install.ts`; modify
`packages/domain/managed-spend.ts` (version contracts), `packages/storage/managed-spending.ts`
(version branch; export `MONEY_LEGACY_DDL`). Parent owns
`tests/integration/billing-admission-money5-review.test.ts`.

**Produces (`packages/storage/billing-install.ts`):**
```ts
export const BILLING_MONEY_V5_DDL: string;                 // full reviewed v5 install text
export interface InstallBillingMoney5Input {
  control: ControlStore; root: string; offline: boolean; workers_terminated: boolean;
}
export function installBillingMoney5(input: InstallBillingMoney5Input):
  { version: 5; installed_at: string; nonfunding: true };
export function verifyBillingMoney5Schema(db: DatabaseSync): void;  // strict, no CREATE
```

`installBillingMoney5` algorithm: (1) require a plain object with exactly those four keys and
`offline === true && workers_terminated === true`, else `INVALID_INPUT` — the acknowledgements
are attestations, not proof that old workers ended; (2) `assertTrustedManagedRoot(root,
control.path)`; (3) `BEGIN IMMEDIATE`; (4) require the DB is the **exact actual v4 schema**
(version `=== 4`, closed v4 money catalog present, no authority namespace) — v5 already
installed returns the existing record idempotently, version `<4` or `>5` refuses;
(5) `exec(BILLING_MONEY_V5_DDL)`; (6) insert `control_billing_install(singleton=1, schema=1,
version=5, nonfunding=1, offline=1, workers_terminated=1, installed_at)` — the non-funding
install record; (7) insert `managed_money_schema(5, now)`; (8) read back version `=== 5` and
the install row (a silently ignored write throws); (9) `COMMIT`. Any error `ROLLBACK` clears
the whole install. It writes **no** key, policy, admission, enrollment anchor or generation
row. `verifyBillingMoney5Schema` requires every v4 money table plus the authority tables and
throws `UNAVAILABLE` if any is missing (no auto-heal).

After install the root is `unenrolled`: `new ManagedSpendingStore(control)` denies reserve/mark
even with positive caps, while known settlement, capture and auth remain usable. Activation
and audit read version 5 and report stale/unenrolled until the deferred T4 offline enrollment
writes the anchor + a fresh v5 audit; a later authorized grant/admission does not invalidate
that fresh audit.

**Steps:** 1) failing test against a genuine `createMoneyV4Control` fixture with real unknown
holds and unsettled call ids: the normal constructor leaves v4 at v4; `installBillingMoney5`
requires both acknowledgements; it installs v5 atomically, `moneyBytesDigest` unchanged and all
rows/FKs byte-identical; an injected failure between DDL and the install record → full rollback
to v4; a v5 reopen with a dropped authority table refuses (no auto-heal); version 6 → fail
before DDL; `new ManagedSpendingStore(control)` on v5/unenrolled denies reserve/mark while
`settleKnown` still settles. 2) run → RED. 3) implement. 4) GREEN + `npm run typecheck`,
`npm run lint`, `npm run build`. STOP.

## 9. Test matrix (positive / negative / actual-process)

| Task | Positive | Negative | Process |
|---|---|---|---|
| 1 | fresh v5 mint; idempotent re-provision | marker≠central refuses; raw-SQL generation lower aborts; active fence refuses | two-handle concurrent provision → one incarnation |
| 2 | prepare→admit one frame; `source=null` no write | replay/expired/forged-MAC/gen-or-fence-change denied | prepare on A, admit after generation change denied |
| 3 | admitted+exact grant allowed; manual unchanged; known settle after expiry | raw-SQL period/account, cap raise, manual fallback, unenrolled positive caps denied | admission/mark race; unknown hold blocks all; tenant read outside control tx |
| 4 | frozen manual + empty accounts; fresh enrol-audit survives grant | unsurveyed/raw-SQL history denies | none (control-only) |
| 5 | v4 constructor stays v4; explicit install → v5 byte-identical | missing ack, wrong version, dropped authority table, future version denied/rolled back | v5 unenrolled reserve denies while settle succeeds |

## 10. Commands (synthetic, no network)

```powershell
npx vitest run tests/integration/billing-admission-generation.test.ts tests/integration/billing-admission-writer.test.ts tests/integration/billing-reserve-guard.test.ts tests/integration/billing-audit-split.test.ts tests/integration/billing-money5-migration.test.ts --maxWorkers=1 --reporter=default --reporter=json --outputFile=test-results/billing-admission-integration.json
npm run typecheck
npm run lint
npm run build
npm run brain-eval
npm audit --audit-level=high
npm test -- --maxWorkers=1 --reporter=default --reporter=json --outputFile=test-results/billing-admission-full.json
npm run test:e2e -- --workers=1 --output=test-results/billing-admission-browser
git diff --check
```

Parent re-runs every `*-review` test (including `billing-admission-money5-review.test.ts`
against `packages/storage/billing-install.ts`) and reads the JSON reports. No result is
claimed until its command completes.

## 11. Risks and honest limits

- Cross-DB atomicity is handled by fencing + fail-closed ordering, not a distributed commit.
- Raw-SQL immutability triggers are integrity, not provenance; only the sealed anchor + MACs
  are provenance. Source SDK facts are not payment truth (B1 later).
- The prefix index is a bounded startup+suffix scope; per-call detection of unrelated
  historical edits is explicitly not claimed.
- The install acknowledgements are attestations, not proof old workers ended.
- Restore/key-backup manifest, Windows ACL verification and the offline enrollment CLI are T4
  live-readiness gates; this slice installs non-funding state and proves it synthetically.
- Owner data is never touched by these tests; legacy v4 manual behavior stays byte-unchanged.

## 12. Self-review

- Every correction 1–7 maps to a task: 1→§4/§6, 2→§7, 3→§5, 4→§4/§6, 5→§6, 6→§5/§8,
  7→§3/§8.
- Names/DDL match the accepted writer (`BillingAuthority`, `ServerOwnedBinding`,
  `control_billing_account.admission_ordinal`, `BILLING_AUTHORITY_DDL`); the install API lives
  at the parent-chosen `packages/storage/billing-install.ts`; no guessed test-helper names;
  the 430 baseline and the existing v3→v4 test are standing constraints.
- No placeholders: each task lists exact files, signatures, DDL and commands.
