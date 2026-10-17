import type { DatabaseSync } from "node:sqlite";
import { createHmac, timingSafeEqual } from "node:crypto";
import { canonical } from "../domain/logic.ts";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { BrainError } from "../domain/logic.ts";
import {
  enrollmentAnchorDigest,
  validateEnrollmentAnchor,
  type EnrollmentAnchor,
} from "../domain/billing-admission.ts";
import {
  billingOperatorPolicyDigest,
  resolveBillingCatalogPlan,
  validateBillingOperatorPolicy,
  type BillingOperatorPolicy,
} from "../domain/billing-policy.ts";
import { canonicalSealFrame, verifySealMac } from "../domain/billing-seal.ts";
import {
  bindingDigest,
  denialDigest,
  identityDigest,
  observationDigest,
  receiptDigest,
  receiptFromFacts,
  validateBillingDenialObservation,
  validateBillingObservation,
  validateBillingReceipt,
  validateServerOwnedBinding,
  type ServerOwnedBinding,
} from "../domain/billing-evidence.ts";
import { loadBillingKey } from "./billing-key.ts";
import {
  assertTrustedManagedRoot,
  readBoundedRegularFile,
  readRootMarker,
  rootEpochMatches,
} from "../runtime/managed-operator.ts";
import { readAccountIncarnation, activeFence } from "./managed-incarnation.ts";

/**
 * Shared read-only billing verification for the mandatory low-level guard.
 *
 * This is the SAME complete closed validation the accepted standalone writer runs:
 * binding/admission, term receipts, grants, central periods, freshness observation
 * projection, revision, exact expiry and signed revocation counters. It never opens a
 * tenant database, a writer or a nested transaction. MAC integrity is not payment
 * truth; the production evidence source is null until separately approved B1.
 */

export interface BillingContext {
  epoch: number;
  root_nonce: string;
  policy: BillingOperatorPolicy;
  policy_digest: string;
  key: Uint8Array;
}

const PROTECTED_DIR = ".protected";
const POLICY_ARTIFACT = "billing-policy.json";
const ENROLLMENT_ARTIFACT = "billing-enrollment.json";
const POLICY_MAX_BYTES = 16 * 1024;
const ENROLLMENT_MAX_BYTES = 256 * 1024;
const FRESHNESS_MAX_MS = 15 * 60 * 1000;
const unavailable = (message: string) => new BrainError("UNAVAILABLE", message, 503);
const blocked = (message = "Managed paid funding is not authorized for this account.") =>
  new BrainError("BUDGET_BLOCKED", message, 409);

export function loadBillingContext(
  control: { db: DatabaseSync; path: string },
  root: string,
): BillingContext {
  assertTrustedManagedRoot(root, control.path);
  const epochRows = control.db
    .prepare("SELECT epoch,nonce FROM managed_control_epoch WHERE singleton=1")
    .all() as unknown as { epoch: number; nonce: string }[];
  if (epochRows.length !== 1) throw unavailable("The billing epoch is not initialized.");
  const epoch = epochRows[0]!;
  let marker;
  try {
    marker = readRootMarker(root);
  } catch {
    throw unavailable("The billing root marker is unreadable.");
  }
  if (!marker || !rootEpochMatches(marker, { epoch: epoch.epoch, nonce: epoch.nonce, rotated_at: "" }))
    throw unavailable("The billing root marker does not match its epoch.");

  const key = loadBillingKey(root);
  const policyPath = join(root, PROTECTED_DIR, POLICY_ARTIFACT);
  const artifact = readBoundedRegularFile(policyPath, POLICY_MAX_BYTES);
  let parsed: unknown;
  try {
    parsed = JSON.parse(artifact);
  } catch {
    throw unavailable("The billing policy artifact is unreadable.");
  }
  const policy = validateBillingOperatorPolicy(parsed);
  if (policy.epoch !== epoch.epoch || policy.root_nonce !== epoch.nonce)
    throw unavailable("The billing policy does not match the root epoch.");
  if (policy.key_commitment !== key.commitment)
    throw unavailable("The billing policy key commitment does not match the protected key.");
  return {
    epoch: epoch.epoch,
    root_nonce: epoch.nonce,
    policy,
    policy_digest: billingOperatorPolicyDigest(policy),
    key: key.bytes,
  };
}

function assertPrivateArtifact(path: string, maxBytes: number): void {
  const dir = join(path, "..");
  let dirStat;
  let fileStat;
  try {
    dirStat = lstatSync(dir);
    fileStat = lstatSync(path);
  } catch {
    throw unavailable("The protected billing artifact is missing.");
  }
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory())
    throw unavailable("The protected billing directory is not usable.");
  if (fileStat.isSymbolicLink() || !fileStat.isFile() || fileStat.nlink !== 1)
    throw unavailable("The protected billing artifact is not a regular single-link file.");
  if (fileStat.size > maxBytes) throw unavailable("The protected billing artifact is too large.");
  if (process.platform !== "win32") {
    if ((dirStat.mode & 0o7777) !== 0o700) throw unavailable("The protected billing directory is not private.");
    if ((fileStat.mode & 0o7777) !== 0o600) throw unavailable("The protected billing artifact is not private.");
  }
}

export interface EnrollmentView {
  anchor: EnrollmentAnchor;
  enrollment_digest: string;
}

const RESERVATION_DOMAIN = "billing-reservation/v1";

/** The closed immutable call -> admission binding record (MAC-protected). */
export interface ReservationBindingRecord {
  schema: 1;
  call_id: string;
  account_id: string;
  epoch: number;
  admission_ordinal: number;
  tenant_incarnation: string;
  provisioning_generation: number;
  term_id: string;
  window_id: string;
  period_id: string;
  grant_ordinal: number;
  grant_mac: string;
  root_nonce: string;
  policy_digest: string;
  binding_digest: string;
  identity_hash: string;
  job_id: string;
  dispatch_key: string;
  stage: string;
  provider: string;
  model: string;
  price_version: string;
  request_hash: string;
  config_hash: string;
  reserved_micro_usd: number;
  created_at: string;
}

/**
 * Purpose-specific HMAC over the closed canonical reservation binding. The domain
 * separator is `billing-reservation/v1`; there is no generic public seal, and the key
 * is the private authority key loaded from the trusted root.
 */
export function reservationProofMac(record: ReservationBindingRecord, key: Uint8Array): string {
  const text = `${RESERVATION_DOMAIN}\n${canonical(record)}`;
  return createHmac("sha256", Buffer.from(key)).update(text, "utf8").digest("hex");
}

export function verifyReservationProofMac(
  record: ReservationBindingRecord,
  key: Uint8Array,
  mac: unknown,
): boolean {
  try {
    if (typeof mac !== "string" || !/^[0-9a-f]{64}$/.test(mac)) return false;
    const expected = Buffer.from(reservationProofMac(record, key), "hex");
    const given = Buffer.from(mac, "hex");
    return expected.length === 32 && timingSafeEqual(expected, given);
  } catch {
    return false;
  }
}

/**
 * Builds the closed binding from the CURRENT authenticated grant/admission/incarnation
 * and the actual base reservation identity row. Nothing is caller-supplied.
 */
export function buildReservationBinding(
  db: DatabaseSync,
  context: BillingContext,
  args: { call_id: string; account_id: string; period_id: string; created_at: string },
): ReservationBindingRecord {
  const account = db
    .prepare("SELECT binding_digest,admission_ordinal FROM control_billing_account WHERE account_id=?")
    .get(args.account_id) as { binding_digest: string; admission_ordinal: number } | undefined;
  if (!account) throw blocked("This account has no trusted billing admission.");
  const incarnation = readAccountIncarnation(db, args.account_id);
  if (!incarnation) throw blocked("This account has no provisioning incarnation.");
  const mapping = db
    .prepare("SELECT window_id,term_id,epoch,journal_ordinal FROM control_billing_period WHERE period_id=? AND account_id=?")
    .get(args.period_id, args.account_id) as
    | { window_id: string; term_id: string; epoch: number; journal_ordinal: number }
    | undefined;
  if (!mapping || Number(mapping.epoch) !== context.epoch)
    throw blocked("The reservation period is not an authenticated billing grant.");
  const grant = frameAt(db, context.epoch, Number(mapping.journal_ordinal));
  if (!grant || grant.frame.purpose !== "grant")
    throw blocked("The billing grant frame is missing.");
  if (!verifySealMac(grant.frame, context.key, grant.mac))
    throw blocked("The billing grant MAC is invalid.");
  const base = db
    .prepare("SELECT identity_hash,job_id,dispatch_key,stage,provider,model,price_version,request_hash,config_hash,reserved_micro_usd FROM managed_reservations WHERE call_id=?")
    .get(args.call_id) as
    | { identity_hash: string; job_id: string; dispatch_key: string; stage: string; provider: string; model: string; price_version: string; request_hash: string; config_hash: string; reserved_micro_usd: number }
    | undefined;
  if (!base) throw blocked("The reservation base row is missing.");
  return {
    schema: 1,
    call_id: args.call_id,
    account_id: args.account_id,
    epoch: context.epoch,
    admission_ordinal: Number(account.admission_ordinal),
    tenant_incarnation: incarnation.incarnation,
    provisioning_generation: incarnation.provisioning_generation,
    term_id: mapping.term_id,
    window_id: mapping.window_id,
    period_id: args.period_id,
    grant_ordinal: Number(mapping.journal_ordinal),
    grant_mac: grant.mac,
    root_nonce: context.root_nonce,
    policy_digest: context.policy_digest,
    binding_digest: account.binding_digest,
    identity_hash: base.identity_hash,
    job_id: base.job_id,
    dispatch_key: base.dispatch_key,
    stage: base.stage,
    provider: base.provider,
    model: base.model,
    price_version: base.price_version,
    request_hash: base.request_hash,
    config_hash: base.config_hash,
    reserved_micro_usd: Number(base.reserved_micro_usd),
    created_at: args.created_at,
  };
}

export function parseReservationBinding(input: unknown): ReservationBindingRecord {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw blocked("The billing reservation proof is malformed.");
  return input as ReservationBindingRecord;
}

/**
 * The ACTUAL enrolled billing mode of a root, or null when the root is not enrolled
 * (legacy/unenrolled). Production bootstrap uses this to keep sandbox billing roots
 * from installing real paid model transports.
 */
export function enrolledBillingMode(
  control: { db: DatabaseSync; path: string },
  root: string,
): "sandbox" | "live" | null {
  try {
    const view = loadEnrollmentAnchor(control, root);
    return view ? view.anchor.mode : null;
  } catch {
    return null;
  }
}

/** True only when real paid transports may be installed (not an enrolled sandbox root). */
export function paidTransportsAllowed(
  control: { db: DatabaseSync; path: string },
  root: string,
): boolean {
  return enrolledBillingMode(control, root) !== "sandbox";
}

/**
 * The single trusted enrollment validator. An account is enrolled ONLY when the
 * protected `<root>/.protected/billing-enrollment.json` artifact exists as a bounded,
 * private, single-link file, parses as the closed anchor, and its canonical digest
 * equals every cached `control_billing_enrollment` column. Raw SQL rows alone are not
 * enrollment.
 */
export function loadEnrollmentAnchor(
  control: { db: DatabaseSync; path: string },
  root: string,
): EnrollmentView | undefined {
  const path = join(root, PROTECTED_DIR, ENROLLMENT_ARTIFACT);
  assertPrivateArtifact(path, ENROLLMENT_MAX_BYTES);
  let artifact: unknown;
  try {
    artifact = JSON.parse(readBoundedRegularFile(path, ENROLLMENT_MAX_BYTES));
  } catch {
    throw unavailable("The protected billing enrollment artifact is unreadable.");
  }
  const anchor = validateEnrollmentAnchor(artifact);
  const digest = enrollmentAnchorDigest(anchor);
  const row = control.db
    .prepare(
      "SELECT schema,version,epoch,root_nonce,policy_digest,key_commitment,mode,baseline_digest,roster_digest,enrollment_digest FROM control_billing_enrollment WHERE singleton=1",
    )
    .get() as
    | { schema: number; version: number; epoch: number; root_nonce: string; policy_digest: string; key_commitment: string; mode: string; baseline_digest: string; roster_digest: string; enrollment_digest: string }
    | undefined;
  if (!row) return undefined;
  if (
    Number(row.epoch) !== anchor.epoch ||
    row.root_nonce !== anchor.root_nonce ||
    row.policy_digest !== anchor.policy_digest ||
    row.key_commitment !== anchor.key_commitment ||
    row.mode !== anchor.mode ||
    row.baseline_digest !== anchor.baseline_digest ||
    row.roster_digest !== anchor.roster_digest ||
    row.enrollment_digest !== digest
  )
    return undefined;
  return { anchor, enrollment_digest: digest };
}

interface FrameRow {
  frame: Record<string, unknown>;
  mac: string;
}

function frameAt(db: DatabaseSync, epoch: number, ordinal: number): FrameRow | undefined {
  const row = db
    .prepare("SELECT frame_json,mac FROM control_billing_log WHERE epoch=? AND ordinal=?")
    .get(epoch, ordinal) as { frame_json: string; mac: string } | undefined;
  if (!row) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.frame_json);
  } catch {
    throw unavailable("A billing journal frame is unreadable.");
  }
  if (canonicalSealFrame(parsed) !== row.frame_json) throw unavailable("A billing journal frame is not canonical.");
  return { frame: parsed as Record<string, unknown>, mac: row.mac };
}

export interface AccountGrantView {
  binding: ServerOwnedBinding;
  binding_digest: string;
  window_id: string;
  window_start: string;
  window_end: string;
}

/**
 * Re-verifies the complete authenticated account view for one admitted account and
 * period inside the caller's transaction. It mirrors the accepted writer's closed
 * graph validation: admission, term receipt, grant, central period, freshness
 * observation projection, revision, exact expiry and signed revocation counter. Any
 * missing/inconsistent row, a future clock, a foreign epoch/ordinal or a reset
 * revocation counter denies new funding.
 */
export function verifyBillingAccountGrant(
  db: DatabaseSync,
  context: BillingContext,
  accountId: string,
  periodId: string,
  now: Date,
): AccountGrantView {
  const row = db
    .prepare("SELECT account_id,binding_json,binding_digest,admission_ordinal,adverse_generation FROM control_billing_account WHERE account_id=?")
    .get(accountId) as
    | { account_id: string; binding_json: string; binding_digest: string; admission_ordinal: number; adverse_generation: number }
    | undefined;
  if (!row) throw blocked("This account has no trusted billing admission.");
  const account = db
    .prepare("SELECT id,issuer,subject,state FROM managed_accounts WHERE id=?")
    .get(accountId) as { id: string; issuer: string; subject: string; state: string } | undefined;
  if (!account || account.state !== "active") throw blocked("This account is not active for billing.");

  let binding: ServerOwnedBinding;
  try {
    binding = validateServerOwnedBinding(JSON.parse(row.binding_json));
  } catch {
    throw blocked("The billing binding is malformed.");
  }
  if (binding.account_id !== accountId || bindingDigest(binding) !== row.binding_digest)
    throw blocked("The billing binding does not match its signed admission.");
  if (identityDigest({ account_id: account.id, issuer: account.issuer, subject: account.subject }) !== binding.identity_digest)
    throw blocked("The billing binding does not match the current control identity.");

  const plan = resolveBillingCatalogPlan(context.policy, {
    mode: binding.mode,
    cadence: binding.cadence,
    product_ref: binding.product_ref,
    price_ref: binding.price_ref,
  });
  if (!plan) throw blocked("The billing binding does not match the frozen operator catalog.");

  const incarnation = readAccountIncarnation(db, accountId);
  if (
    !incarnation ||
    incarnation.incarnation !== binding.tenant_incarnation ||
    incarnation.provisioning_generation !== binding.provisioning_generation
  )
    throw blocked("The billing generation does not match the signed admission.");
  if (activeFence(db, accountId)) throw blocked("This account is fenced for a history-changing operation.");

  const admission = frameAt(db, context.epoch, Number(row.admission_ordinal));
  if (!admission || admission.frame.purpose !== "admission")
    throw blocked("The signed billing admission is missing.");
  const admissionBody = admission.frame.body as { account_id?: string; identity_digest?: string; tenant_incarnation?: string; clean_baseline_proof?: string };
  const admissionSources = admission.frame.source_ids as unknown;
  if (
    admission.frame.epoch !== context.epoch ||
    admission.frame.root_nonce !== context.root_nonce ||
    admission.frame.policy_id !== context.policy.policy_id ||
    !verifySealMac(admission.frame, context.key, admission.mac) ||
    admissionBody.account_id !== accountId ||
    admissionBody.identity_digest !== binding.identity_digest ||
    admissionBody.tenant_incarnation !== binding.tenant_incarnation ||
    !Array.isArray(admissionSources) ||
    !admissionSources.includes(`binding:${row.binding_digest}`) ||
    typeof admissionBody.clean_baseline_proof !== "string" ||
    !admissionSources.includes(`baseline:${admissionBody.clean_baseline_proof}`)
  )
    throw blocked("The signed billing admission does not bind this account.");

  // Exact grant mapping for the central period being funded.
  const mapping = db
    .prepare("SELECT window_id,period_id,account_id,term_id,epoch,journal_ordinal,window_start,window_end,allowance_micro_usd FROM control_billing_period WHERE period_id=? AND account_id=?")
    .get(periodId, accountId) as
    | { window_id: string; period_id: string; account_id: string; term_id: string; epoch: number; journal_ordinal: number; window_start: string; window_end: string; allowance_micro_usd: number }
    | undefined;
  if (!mapping || Number(mapping.epoch) !== context.epoch)
    throw blocked("The requested period is not an authenticated billing grant.");
  const grant = frameAt(db, context.epoch, Number(mapping.journal_ordinal));
  if (!grant || grant.frame.purpose !== "grant")
    throw blocked("The billing grant frame is missing.");
  const grantBody = grant.frame.body as { account_id?: string; period_id?: string; term_id?: string; window_id?: string; window_start?: string; window_end?: string; allowance_micro_usd?: number };
  const grantSources = grant.frame.source_ids as unknown;
  if (
    grant.frame.epoch !== context.epoch ||
    grant.frame.root_nonce !== context.root_nonce ||
    grant.frame.policy_id !== context.policy.policy_id ||
    Number(grant.frame.ordinal) !== Number(mapping.journal_ordinal) ||
    !verifySealMac(grant.frame, context.key, grant.mac) ||
    grantBody.account_id !== accountId ||
    grantBody.period_id !== periodId ||
    grantBody.term_id !== mapping.term_id ||
    grantBody.window_id !== mapping.window_id ||
    grantBody.window_start !== mapping.window_start ||
    grantBody.window_end !== mapping.window_end ||
    Number(grantBody.allowance_micro_usd) !== Number(mapping.allowance_micro_usd) ||
    Number(mapping.allowance_micro_usd) !== plan.allowance_micro_usd
  )
    throw blocked("The billing grant does not match its mapping or the sealed cap.");

  // Term receipt: closed shape, digest, binding, epoch and originating grant ordinal.
  const term = db
    .prepare("SELECT term_id,account_id,receipt_json,receipt_digest,epoch,journal_ordinal FROM control_billing_terms WHERE term_id=?")
    .get(mapping.term_id) as
    | { term_id: string; account_id: string; receipt_json: string; receipt_digest: string; epoch: number; journal_ordinal: number }
    | undefined;
  if (
    !term ||
    term.account_id !== accountId ||
    Number(term.epoch) !== context.epoch
  )
    throw blocked("The billing term does not match its originating grant.");
  let receipt;
  try {
    receipt = validateBillingReceipt(JSON.parse(term.receipt_json));
  } catch {
    throw blocked("The billing receipt is malformed.");
  }
  if (
    receiptDigest(receipt) !== term.receipt_digest ||
    receipt.account_id !== accountId ||
    receipt.binding_digest !== row.binding_digest
  )
    throw blocked("The billing receipt does not match its signed term.");
  if (
    !Array.isArray(grantSources) ||
    !grantSources.includes(`receipt:${term.receipt_digest}`) ||
    !grantSources.includes(`binding:${row.binding_digest}`)
  )
    throw blocked("The billing grant references do not match its retained receipt.");
  // The ORIGIN grant (at the term's own ordinal) must authenticate the term. Later
  // monthly windows share the term but carry their own later grant, so the origin and
  // current-window ordinals are intentionally different.
  const originGrant = frameAt(db, context.epoch, Number(term.journal_ordinal));
  if (!originGrant || originGrant.frame.purpose !== "grant")
    throw blocked("The billing term has no authenticating origin grant.");
  const originBody = originGrant.frame.body as { account_id?: string; term_id?: string };
  const originSources = originGrant.frame.source_ids as unknown;
  if (
    !verifySealMac(originGrant.frame, context.key, originGrant.mac) ||
    originBody.account_id !== accountId ||
    originBody.term_id !== mapping.term_id ||
    !Array.isArray(originSources) ||
    !originSources.includes(`receipt:${term.receipt_digest}`) ||
    !originSources.includes(`binding:${row.binding_digest}`)
  )
    throw blocked("The billing origin grant does not authenticate its term.");

  const central = db
    .prepare("SELECT account_id,starts_at,ends_at,allowance_micro_usd,state FROM managed_account_periods WHERE period_id=?")
    .get(periodId) as
    | { account_id: string; starts_at: string; ends_at: string; allowance_micro_usd: number; state: string }
    | undefined;
  if (
    !central ||
    central.account_id !== accountId ||
    central.starts_at !== mapping.window_start ||
    central.ends_at !== mapping.window_end ||
    Number(central.allowance_micro_usd) !== Number(mapping.allowance_micro_usd) ||
    central.state !== "active"
  )
    throw blocked("The central billing period does not match its grant.");

  const policy = db
    .prepare("SELECT per_job_micro_usd,user_daily_micro_usd FROM managed_account_policy WHERE account_id=?")
    .get(accountId) as { per_job_micro_usd: number; user_daily_micro_usd: number } | undefined;
  const service = db
    .prepare("SELECT daily_micro_usd FROM managed_service_policy WHERE service='managed-processing'")
    .get() as { daily_micro_usd: number } | undefined;
  if (
    !policy ||
    !service ||
    Number(policy.per_job_micro_usd) !== plan.per_job_micro_usd ||
    Number(policy.user_daily_micro_usd) !== plan.user_daily_micro_usd ||
    Number(service.daily_micro_usd) !== context.policy.service_daily_micro_usd
  )
    throw blocked("The configured billing caps do not match the frozen operator policy.");

  // Authenticated freshness projection bound to the term's receipt and observation.
  const freshness = db
    .prepare("SELECT term_id,observation_json,frame_json,mac,revision,adverse_generation FROM control_billing_freshness WHERE account_id=?")
    .get(accountId) as
    | { term_id: string; observation_json: string; frame_json: string; mac: string; revision: number; adverse_generation: number }
    | undefined;
  if (!freshness || freshness.term_id !== mapping.term_id)
    throw blocked("This account has no authenticated billing freshness for this term.");
  let freshnessFrame: unknown;
  try {
    freshnessFrame = JSON.parse(freshness.frame_json);
  } catch {
    throw blocked("The billing freshness frame is unreadable.");
  }
  if (canonicalSealFrame(freshnessFrame) !== freshness.frame_json || !verifySealMac(freshnessFrame, context.key, freshness.mac))
    throw blocked("The billing freshness MAC is invalid.");
  const outer = freshnessFrame as { purpose?: string; epoch?: number; root_nonce?: string; policy_id?: string; ordinal?: number; prev_mac?: string; source_ids?: unknown; body?: Record<string, unknown> };
  if (
    outer.purpose !== "freshness" ||
    outer.epoch !== context.epoch ||
    outer.root_nonce !== context.root_nonce ||
    outer.policy_id !== context.policy.policy_id ||
    outer.ordinal !== 0 ||
    outer.prev_mac !== ""
  )
    throw blocked("The billing freshness is out of context.");
  const fbody = outer.body ?? {};
  if (typeof fbody.verified_at !== "string" || typeof fbody.expires_at !== "string")
    throw blocked("The billing freshness window is invalid.");
  if (
    fbody.account_id !== accountId ||
    fbody.term_id !== mapping.term_id ||
    Number(fbody.revision) !== Number(freshness.revision) ||
    Number(fbody.adverse_generation) !== Number(freshness.adverse_generation)
  )
    throw blocked("The billing freshness body does not match its stored columns.");

  let observation;
  try {
    observation = validateBillingObservation(JSON.parse(freshness.observation_json));
  } catch {
    throw blocked("The billing freshness observation is unreadable.");
  }
  if (observation.account_id !== accountId || observation.binding_digest !== row.binding_digest)
    throw blocked("The billing freshness observation is out of context.");
  if (observation.current_state !== "active" || !observation.completed_payment)
    throw blocked("The billing freshness is not an active payment for this binding.");
  if (
    observation.customer_ref !== binding.customer_ref ||
    observation.subscription_ref !== binding.subscription_ref ||
    observation.product_ref !== binding.product_ref ||
    observation.price_ref !== binding.price_ref ||
    observation.cadence !== binding.cadence
  )
    throw blocked("The billing freshness observation does not match the bound subscription.");
  if (fbody.verified_at !== observation.verified_at)
    throw blocked("The billing freshness frame and observation disagree on the verification time.");

  const projection = observationDigest(observation);
  const sources = outer.source_ids as unknown;
  if (
    !Array.isArray(sources) ||
    sources.length !== 3 ||
    !sources.includes(`projection:${projection}`) ||
    !sources.includes(`receipt:${term.receipt_digest}`) ||
    !sources.includes(`binding:${row.binding_digest}`)
  )
    throw blocked("The billing freshness references do not match its retained evidence.");
  const reconstructed = receiptFromFacts(
    {
      transaction_ref: observation.transaction_ref,
      subscription_ref: observation.subscription_ref,
      customer_ref: observation.customer_ref,
      product_ref: observation.product_ref,
      price_ref: observation.price_ref,
      cadence: observation.cadence,
      completed_payment: observation.completed_payment,
      current_state: observation.current_state,
      paid_period_start: observation.paid_period_start,
      paid_period_end: observation.paid_period_end,
      verified_at: observation.verified_at,
    },
    binding,
  );
  if (receiptDigest(reconstructed) !== term.receipt_digest)
    throw blocked("The billing freshness observation does not reconstruct its receipt.");

  // Exact freshness window: a future or expired proof is denied, and the expiry must
  // be the signed minimum, never a mutable substituted value.
  const verified = Date.parse(fbody.verified_at);
  const expires = Date.parse(fbody.expires_at);
  if (!Number.isFinite(verified) || !Number.isFinite(expires)) throw blocked("The billing freshness window is invalid.");
  if (verified > now.getTime()) throw blocked("The billing freshness is from the future.");
  if (expires - verified > FRESHNESS_MAX_MS || expires <= verified)
    throw blocked("The billing freshness window is invalid.");
  const expectedExpires = Math.min(
    verified + FRESHNESS_MAX_MS,
    Date.parse(observation.paid_period_end),
  );
  if (expires !== expectedExpires) throw blocked("The billing freshness expiry is not the signed minimum.");
  if (now.getTime() >= expires) throw blocked("The billing freshness has expired.");

  // Signed revocation counter: the account row must equal the retained signed
  // revocations, so a raw SQL reset of the counter cannot re-authorize funding.
  const denials = db
    .prepare("SELECT observation_digest,observation_json,epoch,journal_ordinal FROM control_billing_denials WHERE account_id=?")
    .all(accountId) as { observation_digest: string; observation_json: string; epoch: number; journal_ordinal: number }[];
  if (denials.length !== Number(row.adverse_generation) || denials.length !== Number(freshness.adverse_generation))
    throw blocked("The billing adverse generation does not match its signed revocations.");
  let previousGeneration = 0;
  for (const denial of denials.sort((a, b) => Number(a.journal_ordinal) - Number(b.journal_ordinal))) {
    const revocation = frameAt(db, Number(denial.epoch), Number(denial.journal_ordinal));
    if (!revocation || revocation.frame.purpose !== "revocation")
      throw blocked("A signed billing revocation has no retained frame.");
    const rbody = revocation.frame.body as { account_id?: string; adverse_generation?: number };
    if (
      Number(denial.epoch) !== context.epoch ||
      !verifySealMac(revocation.frame, context.key, revocation.mac) ||
      rbody.account_id !== accountId ||
      Number(rbody.adverse_generation) !== previousGeneration + 1
    )
      throw blocked("The billing revocation sequence is not monotonic.");
    previousGeneration = Number(rbody.adverse_generation);
    let denialObservation;
    try {
      denialObservation = validateBillingDenialObservation(JSON.parse(denial.observation_json));
    } catch {
      throw blocked("A retained billing denial is malformed.");
    }
    if (
      denialObservation.account_id !== accountId ||
      denialObservation.binding_digest !== row.binding_digest ||
      denialDigest(denialObservation) !== denial.observation_digest
    )
      throw blocked("A retained billing denial does not match its signed revocation.");
  }
  if (previousGeneration !== Number(row.adverse_generation))
    throw blocked("The billing revocation counter does not match its signed sequence.");

  if (now.getTime() < Date.parse(mapping.window_start) || now.getTime() >= Date.parse(mapping.window_end))
    throw blocked("The billing grant window is not current.");

  return {
    binding,
    binding_digest: row.binding_digest,
    window_id: mapping.window_id,
    window_start: mapping.window_start,
    window_end: mapping.window_end,
  };
}
