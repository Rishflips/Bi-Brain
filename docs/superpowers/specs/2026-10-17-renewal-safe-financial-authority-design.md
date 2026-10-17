# Renewal-safe financial authority (B0) — approved design

**Status: APPROVED.** The owner replied **"okay go ahead"** after being asked to review
and approve this written B0 design before its implementation plan. Approval covers B0's
plan and dependency-ordered, independently reviewed implementation with synthetic tests.
It does not approve B1, a Paddle account/checkout, customer prices, allowance amounts, live
model spending, activation or deployment. No migration is applied to owner data by this
record. B0 must be implemented and verified before B1 consumes its runtime contract.

**Owner-approved (business only):** Paddle; an individual/sole-proprietor seller; monthly and
annual subscriptions; a monthly processing allowance with **no rollover** and **no automatic
overages**; and knowledge/correction/export/deletion remaining available independently of
payment. The written B0 authority, calendar, key, schema-5 and fault-handling design below
is now approved for implementation, **not proven runtime behavior**. It refuses new paid
admission when upstream entitlement is uncertain. B1's customer cancellation/refund and
payment lifecycle remain **PROPOSED** in its separate unapproved draft.

## Scope

Define an authority under which a legitimate monthly/annual renewal and a new paying customer
need **no offline audit-and-re-enroll**, while S1 money safety, unknown-hold, cross-stage and
restore-epoch guarantees hold, and no parallel money ledger appears. Out of scope: provider
integration (B1), prices, refunds policy, hosted release.

## Repository constraints (inspected)

- `centralSchemaDigest` binds money version 4 (`packages/domain/managed-spend.ts:30`) plus the
  closed column list of nine tables (`packages/storage/managed-activation-state.ts:127-145`).
- `accountConfigHash` binds policy and **every** `managed_account_periods` row
  (`managed-activation-state.ts:220-251`; `packages/runtime/managed-audit.ts:542-574`);
  `managedControlInventoryDigest` iterates **all** account ids (`:300-329`).
- A new period or account flips `config_digest` → `config_changed` → `audit_stale`
  (`packages/runtime/managed-activation.ts:159-160`) → sends deny (`managed-audit.ts:1087-1094,1218`).
- `configureAccountPeriod` refuses overlaps and cannot mutate (`packages/storage/managed-spending.ts:96,487-505`);
  `activePeriod` takes the newest containing `now` (`:1276-1287`); `accountPeriodCommitted`
  adds account-wide unresolved holds (`:1227-1233`); reserve admits against four dimensions
  plus the `dispatched` barrier (`:624-680`); `settleKnown` ignores the period (`:856-859`).
- Restore copies the whole `control.sqlite` (`packages/runtime/managed-recovery.ts:751`) and
  rotates epoch/nonce/marker (`:304-336`). There is **no control billing queue**; the existing
  tenant durable job lease is the only queue.

## Approaches

**A — Static audited policy + rare keyed authority log (recommended).** Renewal and signup are
authorized appends, so the static fingerprint does not move. **B — Remove dynamic
periods/accounts from the fingerprint (rejected):** turns them into unaudited free action.
**C — Per-tenant billing ledger (rejected):** a second truth.

## Static vs dynamic

- **Static frozen:** authority schema shape, operator plan/price digest, admission rules, the
  four caps, root epoch and the key commitment. A change is a reviewed offline migration.
- **Dynamic, verified:** admissions, grants and revocations (rare) plus a signed per-account
  freshness projection (frequent). Included in **verification**, never blindly excluded.
- Unpaid accounts may authenticate and capture **without** moving the frozen
  financially-admitted inventory **iff** they have no original financial history. Existing
  accounts stay audited under their historical fingerprints. We never silently drop all
  account config/inventory to make signups “just work”.
- Manual accounts keep an explicit `manual` mode; no implicit adoption either way.

## Schema 5 design and freeze scope

The approved design specifies control money **4 → 5**; implementation/migration is still
pending. Freeze scope = the existing nine-table column list **plus** an explicit closed-DDL
digest (columns, named indexes, trigger bodies) for the `control_billing` namespace, including
the freshness-projection shape. `centralSchemaDigest` hashes a column list, not full SQL, so
the DDL digest is an explicit upgrade action. **Implementation-order clarification:**
B1's unapproved event/checkout tables are deferred to its separately reviewed initial
installation, rather than installing a guessed inert subset during B0. Their actual closed
shape must then enter the digest and require a fresh offline audit/enrollment **before use**.
No namespace is silently exempted. A later *new authority shape or key* likewise needs a
reviewed offline enrollment. We do not promise “exactly one migration forever”. The B0
money-5 migration itself stays pending until its complete financial storage contract is
reviewed; the standalone key helper may be implemented and tested without applying it.

## Period projection decision (managed_account_periods)

`managed_reservations.account_period_id` has a FK to `managed_account_periods`; the FK is
**unchanged**. A grant is materialized as an immutable `managed_account_periods` row that is
the **money projection of exactly one verified grant**, with a unique `grant_id → period_id`
mapping. The grant writer is a dedicated authority path that inserts only new rows validated
against static caps and current proof in the same control transaction — it is **not**
`configureAccountPeriod`. Old period rows are retained byte-identical (no drop, no re-key).
Revocation appends a separate deny history; it never rewrites funds already paid or consumed.
`activePeriod` resolves billing accounts **through the grant mapping**, never an arbitrary
“latest row” fallback. Audits verify authorized projections including all new rows against the
log, not a blind period-list exclusion; manual-mode fingerprints are unchanged.

## Windows and keys

Logical window identity is `hash(account_id, subscription_ref, paid_term_start, window_start,
window_end)` — canonical, and independent of policy version. Provider receipt/transaction ids
are stored as **provenance separate from identity**, so a duplicate completed payment for the
same term cannot reset the allowance merely because a transaction id changed. DB active
intervals are non-overlapping per account; the first grant’s ceiling is immutable; reissue,
revocation or resume can never reset a used balance or window; a conflicting amount or config
change in the same window denies and needs manual attention rather than minting a new key. A
new annual year starts a fresh key.

- **Monthly:** the grant window is the verified COMPLETED transaction’s `billing_period
  [start, end)` from Paddle; no synthesized lifetime monthly anchor.
- **Annual:** ≤12 monthly windows from the ORIGINAL UTC paid-term anchor with calendar clamps
  (`Jan31→Feb28→Mar31`, leap native), last clipped by `term_end`; only the current window
  receives the full allowance; no annual-upfront budget.
- `Get subscription.current_billing_period` is NULL on canceled/paused, so the original PAID
  TERM is retained independently and never re-derived.

Freshness of a paid term and expiry of a spending window are distinct. A still-fresh annual
term may authorize materializing **only the new current monthly window** at its boundary;
it need not invent another annual payment or reuse the expired window's balance. Each
admission expires at the minimum of current term-state freshness, paid-term end and its own
window end. A monthly renewal still requires the newly paid monthly transaction. No expired
reservation is silently rebound to a new grant; known settlement keeps its original binding.

## Interfaces (backend-only; never given a browser account id)

```ts
type UnavailableReason = "no_admission" | "no_grant" | "stale" | "past_due"
  | "canceled" | "refunded" | "conflict" | "suspended" | "policy_mismatch";
type Eligibility =
  | { state: "granted"; window_id: string; window_start: string; window_end: string; grant_proof: string }
  | { state: "unavailable"; reason: UnavailableReason };

// Defined by B0; B1 produces references to these records, not grant authority.
type Cadence = "monthly" | "annual";
type StoredPaidTermReference = {
  term_id: string; receipt_id: string; account_binding: string;
  subscription_ref: string; transaction_ref: string;
  term_start: string; term_end: string; cadence: Cadence;
  window_id: string; window_start: string; window_end: string;
  policy_id: string; root_epoch: number; provenance_mac: string;
};

type AdmissionRequest = {
  account_id: string;                    // trusted resolved UUID, never from HTTP
  identity_digest: string;               // bound issuer+subject digest
  tenant_incarnation: string;            // trusted tenant incarnation digest
  root_epoch: number; policy_id: string;
  clean_baseline_proof: string;          // ref, not a boolean
};
type AdmissionDecision = { outcome: "admitted" | "already" | "denied"; reason?: UnavailableReason };

interface BillingAuthority {
  billingEligibility(account: string, now: Date): Eligibility;   // clock injected
  ensureCurrentGrant(account: string, now: Date): Eligibility;   // idempotent append
  admitNewAccount(input: AdmissionRequest): AdmissionDecision;
}
```

No `authorized: true` boolean, no generic stage router, and no HTTP-supplied clock: production
and tests both use an injected clock. `StoredPaidTermReference` is a lookup view, not a
serialized permission. Its referenced record must already exist in the authority-owned
store. B0 **re-loads it under transaction**, checking MAC, purpose, root, policy, ownership,
paid-term provenance and the separate fresh-state projection. B1's internal reconciliation
module submits evidence through a closed validated-record writer: only its pinned provider
transport and server-owned correlation can produce evidence for that writer. No HTTP/model
input can select a signing purpose, submit an arbitrary body to be sealed, or self-assert
`verified: true`. B0 synthetic tests exercise this same writer with injected transport,
not a production route that accepts fixture grants. The normalized format belongs to B0;
B1 implements the provider protocol without becoming a dependency for B0's pure tests.

## Admission and new accounts

- A new paid account needs the record above (trusted identity + tenant incarnation + static
  policy version + strict clean-baseline proof). A hash alone is not proof.
- No tenant DB is opened inside a control money transaction: a bounded read-only **preflight**
  runs outside the control write; the admission **publish** transaction re-checks central
  account identity, root, epoch, policy and absence of financial history. An unadmitted paid
  writer is refused by the central guards.
- Trusted fresh provisioned tenant marker plus S1 projection verification detect history
  imports and races. A dirty baseline on an existing account requires offline admission; it is
  never auto-accepted.
- Stateful old workers must be terminated once, during the offline install; the operator’s
  acknowledgement is not programmatic proof of termination.
- Existing manual period mutations still invalidate the audit. Every new billing-mode
  policy-derived cap must equal the sealed admission + static plan; a raw unsealed SQL cap is
  never authority. Signups can neither trigger a global paid stop nor escalate any budget.

## MAC frame, key, and rollback honesty

The sealed entry is a canonical **closed structured object** — `{schema, purpose, epoch,
root_nonce, policy_id, source_ids, ordinal, prev_mac, body}` — serialized canonically as UTF-8
and MACed; comparison is length-safe constant-time. No generic raw-body sealing route exists;
only the private authority module seals records it has validated from its own owned rows under
the control transaction. Purpose separation is explicit (grant/admission/revocation/freshness).

Key: `<managed_root>/.protected/billing-authority.key`, a regular file with no link or
ancestor traversal; `0600` on POSIX, and **Windows ACL security requires separate
verification** — we do not claim `0600` is secure on Windows. The key commitment is frozen, no
hot rotation and no new keys from webhooks; one offline enrollment. The key is never in the
DB, vault, frontend, URL or logs.

**Rollback is stated honestly.** The MAC proves **authenticity, not freshness**: replaying a
coherent older DB plus a prefix head under the *same unchanged key* can pass after a restart —
that does not require key rollback. Out-of-band snapshot/prefix-head rollback is an explicit
residual limit. Within a running process, a stale CAS or a visible log break is rejected, and
a “prior-head replay” is rejected against the **current known head CAS** — it is not a claim
about any coherent DB rollback. No cross-process “crypto immutability” or paired-key
requirement is claimed; root/key compromise is out of scope; a supported restore’s epoch/marker
blocks old grants. Head and entry commit in the **same DB transaction**.

## Scalability: rare log + signed freshness projection

Authority-changing facts (admission/grant/revocation) are rare and append-only. Frequent
freshness is **not** a payment fact: it is a separate per-account **signed projection** updated
by CAS revision, valid at most 15 minutes, bound to purpose + root + policy + paid-term ref +
adverse generation, and it can never add budget or reset money. A snapshot replay cannot
outlast the signed expiry and cannot override the current adverse latch log ref (within the
known whole-snapshot limit above). Startup and incremental verification run bounded from an
immutable audited checkpoint to the MAC head and reject bound exhaustion; there is no full
scan on every model call. Log growth is bounded; checkpoint/prune is an offline operator step,
never a secret automatic prune.

## Atomicity and settlement

`reserve`/`mark` verify, inside the existing `BEGIN IMMEDIATE`: current grant (sealed,
matching window), current admission, frozen plan mapping, the four caps, global pause and all
S1 barriers. Stale/absent/suspended/past-due/refunded/conflicting only refuse **new**
paid-model admission. `settleKnown` still settles a known in-flight charge after expiry or
revocation.

## Restore and backup key

The whole-control bundle currently copies only the DB and tenants, so it is **extended** with
an explicit operational manifest carrying the global protected authority key’s metadata,
hash and path check. Encrypted operational key storage is a **LIVE gate**, never portable
export or Git. An old bundle with no key stays legacy-compatible but **PAID BLOCKED**; a new
key that is corrupt or missing refuses authority restore, with **no** automatic key
generation or re-seal. Supported restore verifies the key before staging and rotates the
epoch, invalidating all prior grants/freshness/admissions; original money and refs are
retained; a new Paddle read plus offline operator re-enroll is required, and the money-restore
block is not auto-cleared. Rotation is operator-only with an audit checkpoint; a new key never
“freshens” old facts.

## Fault and recovery matrix (closed)

| Fault | New paid model call | Settlement | Knowledge/auth |
|---|---|---|---|
| No admission | denied | allowed (known) | available |
| No/expired grant, stale term | denied | allowed | available |
| past_due / canceled / refunded / chargeback | denied | allowed | available |
| Key or head missing/corrupt | denied | allowed | available |
| Log modification/deletion or prior-head replay | denied | allowed | available |
| Out-of-band coherent snapshot/prefix rollback | residual limit | allowed | available |
| Amount/config change inside a window | denied + manual | allowed | available |
| Admission race / dirty baseline | denied until offline | allowed | available |
| Supported restore (epoch rotated) | denied until re-verify | allowed | available |
| Service ambiguity (`dispatched`) | denied | unchanged | available |

## Negative acceptance proofs

- Forged/unkeyed grant body, wrong purpose, wrong root/policy or bad MAC → deny.
- Ordinal skip, `window_id` reuse with a different body, prior-head replay vs current head → deny.
- Two annual renewals and two duplicate transactions for the same term grant once.
- Resubscribe that would overlap a live interval → deny + manual, no new key.
- Static policy-version change cannot credit the same window again.
- Distinct annual years may each grant their own monthly windows; duplicate transactions
  within either year may not create a second grant for the same interval.
- A canceled/paused subscription with NULL `current_billing_period` still resolves the retained
  term; re-deriving from null → deny.
- A monthly grant whose window differs from the verified transaction `billing_period` → deny.
- Unadmitted account cannot reserve but can still authenticate, capture, export and delete.
- Billing-mode account never reads a manual period; manual account never adopted.

## Test acceptance batches

1. **Frozen regression:** the 984 locally-accepted tests stay green; money bytes and unknown
   holds byte-identical across the migration.
2. **Calendar/keys:** anchor/clamp table (Jan31, Feb29), two annual renewals, duplicate-txn
   same period, resubscribe overlap, policy-version change.
3. **Adversarial financial:** key/head tamper, ordinal skip, replay, rollback, concurrent
   renewals/admissions, bound exhaustion.
4. **Process:** synthetic injected grants only, clearly labelled synthetic.

## Offline sequence

Once, after implementation: stop API and worker → apply money 4 → 5 → `managed:reconcile
audit-history --offline --workers-terminated` → re-enroll → restart. After it, renewal and
signup need no offline step. Version 5 is the reviewed design target, not an already-applied
or verified migration.

## Live gate (blocked inputs)

Owner-approved prices/allowances; independently verified B0 implementation; separately
approved B1 and verified B1 sandbox; runtime key storage with
its **ACL verified**. The HMAC scheme is approved for implementation, but written approval
is not proof of secure runtime storage. Separate B1 approval remains mandatory.

Sandbox/live is a frozen authority namespace, not a browser choice. A sandbox receipt can
never satisfy a live admission, even when an ID happens to match. Production `main.ts` must
not install paid model transports on a sandbox-billing root; Paddle's fake payments are not
funding for real model calls. Synthetic accounting tests use injected transports and
disposable roots. A separately budgeted real-model evaluation uses its own explicitly
authorized operator configuration, never a sandbox-payment bypass or implicit manual fallback.

## Official sources (listed explicitly)

Paddle Billing API/versioning, webhook signature, respond-to-webhooks, transactions/create,
list-adjustments, subscriptions/provision-access, transaction-completed: see the URL list in
B1 §Sources. Repo citations above are file/line references, unaffected by those docs.

**Cross-reference:** B1 consumes the interfaces above only; approval of either design implies
no other approval and no proven runtime path.
