import { createHash, randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "node:path";
import { BrainError, canonical } from "../domain/logic.ts";
import {
  BILLING_FRESHNESS_MAX_MS,
  billingWindow,
  invalid,
  isUuid,
  parseCanonicalUtc,
  type BillingEligibility,
  type UnavailableReason,
} from "../domain/billing-authority.ts";
import { canonicalSealFrame, sealMac, verifySealMac } from "../domain/billing-seal.ts";
import {
  validateBillingOperatorPolicy,
  type BillingCatalogPlan,
  type BillingOperatorPolicy,
} from "../domain/billing-policy.ts";
import {
  bindingDigest,
  denialDigest,
  denialFromFacts,
  identityDigest,
  observationDigest,
  observationFromFacts,
  receiptDigest,
  receiptFromFacts,
  receiptTermId,
  termId,
  validateBillingDenialObservation,
  validateBillingObservation,
  validateBillingReceipt,
  validateProviderFacts,
  validateServerOwnedBinding,
  type BillingObservation,
  type BillingReceipt,
  type EvidenceSource,
  type ProviderFacts,
  type ServerOwnedBinding,
} from "../domain/billing-evidence.ts";
import { ControlStore } from "./control.ts";
import { loadBillingKey } from "./billing-key.ts";
import { billingAuthoritySchemaDigest, billingIntegratedSchemaDigest, billingSchemaVariant } from "./billing-schema.ts";
import { activeFence, readAccountIncarnation } from "./managed-incarnation.ts";
import {
  cleanBaselineDigest,
  preflightRequestDigest,
  validateCleanBaselineProof,
  validateServerBillingCorrelation,
  type AdmissionDecision,
  type AdmissionPreflightColumns,
  type BillingCorrelationSource,
  type CleanBaselineProof,
} from "../domain/billing-admission.ts";
import { readBoundedRegularFile, readRootMarker, rootEpochMatches, assertTrustedManagedRoot } from "../runtime/managed-operator.ts";

/**
 * B0 billing-authority writer.
 *
 * One coherent pipeline: load the frozen trusted context (root/policy/key/epoch), load
 * one bounded authenticated view of the account (admission, terms, grants, periods,
 * denials, freshness), read trusted evidence outside any transaction, then publish at
 * most one grant or revocation inside a single control transaction. No HTTP surface, no
 * production caller, no Paddle adapter and no public raw append/seal. A `null` source —
 * the production default — grants nothing, even when sealed rows already exist.
 *
 * MAC integrity is not payment truth: B0 cannot prove Paddle was contacted without the
 * separately approved B1 adapter. Real admission/generation and the four-dimensional
 * reserve/mark guards remain a later coherent integration.
 */

const POLICY_ARTIFACT = "billing-policy.json";
const POLICY_MAX_BYTES = 16 * 1024;
const MAX_TERM_MS = 31 * 86400000;
const PROTECTED_DIR = ".protected";

export type ReconciliationReason = UnavailableReason | "no_source";

export type RevocationReason = "past_due" | "canceled" | "refunded" | "conflict" | "suspended" | "policy_mismatch";

export type ReconciliationDecision =
  | { state: "none" }
  | { state: "denied"; reason: ReconciliationReason }
  | { state: "granted"; window_id: string; window_start: string; window_end: string };

export interface BillingAuthorityOptions {
  control: ControlStore;
  root: string;
  source?: EvidenceSource | null;
  correlation?: BillingCorrelationSource | null;
  clock?: () => Date;
}

type Action =
  | { state: "granted"; window_id: string; window_start: string; window_end: string }
  | { state: "revocation"; reason: RevocationReason };

type Evaluation = Action | { state: "denied"; reason: ReconciliationReason };

const sha = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");
const unavailable = (message = "Billing authority is unavailable.") => new BrainError("UNAVAILABLE", message, 503);

function revocationReason(state: ProviderFacts["current_state"]): RevocationReason {
  if (state === "past_due" || state === "canceled" || state === "refunded") return state;
  return "conflict";
}

interface Context {
  epoch: number;
  root_nonce: string;
  policy: BillingOperatorPolicy;
  policy_digest: string;
  key: Uint8Array;
}

interface AccountRow {
  account_id: string;
  binding_json: string;
  binding_digest: string;
  admission_ordinal: number;
  adverse_generation: number;
}

interface PreflightRow {
  preflight_id: string;
  account_id: string;
  incarnation: string;
  provisioning_generation: number;
  identity_digest: string;
  binding_digest: string;
  binding_json: string;
  baseline_json: string;
  policy_id: string;
  policy_digest: string;
  root_epoch: number;
  root_nonce: string;
  proof_json: string;
  proof_mac: string;
  mode: "sandbox" | "live";
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
  admission_ordinal: number | null;
}

interface Frame {
  ordinal: number;
  frame: Record<string, unknown>;
  mac: string;
}

interface TermView {
  term_id: string;
  receipt: BillingReceipt;
  receipt_digest: string;
  journal_ordinal: number;
}

interface GrantView {
  ordinal: number;
  body: GrantBody;
}

interface PeriodRow {
  window_id: string;
  period_id: string;
  term_id: string;
  window_start: string;
  window_end: string;
  allowance_micro_usd: number;
  epoch: number;
  journal_ordinal: number;
}

interface FreshnessView {
  term_id: string;
  observation: BillingObservation;
  receipt_digest: string;
  binding_digest: string;
  expires_at: string;
  revision: number;
  adverse_generation: number;
  mac: string;
}

interface GrantBody {
  account_id: string;
  window_id: string;
  term_id: string;
  period_id: string;
  window_start: string;
  window_end: string;
  allowance_micro_usd: number;
  source_ids: string[];
}

interface Snapshot {
  context: Context;
  account_id: string;
  binding: ServerOwnedBinding;
  binding_digest: string;
  plan: BillingCatalogPlan;
  admission_ordinal: number;
  head: { ordinal: number; mac: string };
  frames: Frame[];
  terms: Map<string, TermView>;
  grants: Map<string, GrantView>;
  periods: Map<string, PeriodRow>;
  denials: { term_id: string; reason: RevocationReason; observation_digest: string; ordinal: number }[];
  revokedTermIds: Set<string>;
  adverse: number;
  freshness?: FreshnessView;
}

export class BillingAuthority {
  private readonly control: ControlStore;
  private readonly root: string;
  private readonly source: EvidenceSource | null;
  private readonly correlation: BillingCorrelationSource | null;
  private readonly clock: () => Date;
  private readonly frozen: Context;

  constructor(options: BillingAuthorityOptions) {
    if (!options || typeof options !== "object") invalid("Billing authority options are required.");
    this.control = options.control;
    this.root = options.root;
    this.source = options.source ?? null;
    this.correlation = options.correlation ?? null;
    this.clock = options.clock ?? options.control.clock;
    this.frozen = this.loadContext();
  }

  private db() {
    return this.control.db;
  }

  // ------------------------------------------------------------- trusted context

  private context(): Context {
    const live = this.loadContext();
    if (
      live.epoch !== this.frozen.epoch ||
      live.root_nonce !== this.frozen.root_nonce ||
      live.policy_digest !== this.frozen.policy_digest
    )
      throw unavailable("The billing policy or epoch changed since enrollment.");
    if (Buffer.compare(Buffer.from(live.key), Buffer.from(this.frozen.key)) !== 0)
      throw unavailable("The billing key changed since enrollment.");
    return live;
  }

  private loadContext(): Context {
    const controlPath = resolve(this.control.path);
    const expected = resolve(join(this.root, "control.sqlite"));
    const same =
      process.platform === "win32"
        ? controlPath.toLowerCase() === expected.toLowerCase()
        : controlPath === expected;
    if (!same) throw unavailable("The billing authority control path is not trusted.");
    assertTrustedManagedRoot(this.root, this.control.path);
    // Select the deliberate schema variant: a genuine v5 root uses the integrated
    // catalog; a standalone writer fixture keeps the frozen authority variant.
    if (billingSchemaVariant(this.db()) === "integrated") billingIntegratedSchemaDigest(this.db());
    else billingAuthoritySchemaDigest(this.db());

    const epochRows = this.db()
      .prepare("SELECT epoch,nonce FROM managed_control_epoch WHERE singleton=1")
      .all() as unknown as { epoch: number; nonce: string }[];
    if (epochRows.length !== 1) throw unavailable("The billing authority epoch is not initialized.");
    const epoch = epochRows[0]!;
    let marker;
    try {
      marker = readRootMarker(this.root);
    } catch {
      throw unavailable("The billing authority root marker is unreadable.");
    }
    if (!marker || !rootEpochMatches(marker, { epoch: epoch.epoch, nonce: epoch.nonce, rotated_at: "" }))
      throw unavailable("The billing authority root marker does not match its epoch.");

    const key = loadBillingKey(this.root);
    const policyPath = join(this.root, PROTECTED_DIR, POLICY_ARTIFACT);
    this.assertProtectedPolicyFile(policyPath);
    const artifact = readBoundedRegularFile(policyPath, POLICY_MAX_BYTES);
    let parsedPolicy: unknown;
    try {
      parsedPolicy = JSON.parse(artifact);
    } catch {
      throw unavailable("The billing policy artifact is unreadable.");
    }
    const policy = validateBillingOperatorPolicy(parsedPolicy);
    if (policy.epoch !== epoch.epoch || policy.root_nonce !== epoch.nonce)
      throw unavailable("The billing policy does not match the root epoch.");
    if (policy.key_commitment !== key.commitment)
      throw unavailable("The billing policy key commitment does not match the protected key.");

    const policyDigest = sha(policy);
    const cached = this.db()
      .prepare("SELECT policy_json,policy_digest FROM control_billing_policy WHERE singleton=1")
      .get() as unknown as { policy_json: string; policy_digest: string } | undefined;
    if (!cached) throw unavailable("The billing policy cache row is missing.");
    if (cached.policy_digest !== policyDigest || canonical(validateBillingOperatorPolicy(JSON.parse(cached.policy_json))) !== canonical(policy))
      throw unavailable("The cached billing policy does not match its protected artifact.");

    return { epoch: epoch.epoch, root_nonce: epoch.nonce, policy, policy_digest: policyDigest, key: key.bytes };
  }

  /** POSIX-private protected policy file, mirroring the T2K key rules. */
  private assertProtectedPolicyFile(path: string): void {
    const dir = join(this.root, PROTECTED_DIR);
    let dirStat;
    let fileStat;
    try {
      dirStat = lstatSync(dir);
      fileStat = lstatSync(path);
    } catch {
      throw unavailable("The billing policy artifact is missing.");
    }
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) throw unavailable("The billing policy directory is not usable.");
    if (fileStat.isSymbolicLink() || !fileStat.isFile() || fileStat.nlink !== 1)
      throw unavailable("The billing policy artifact is not a regular single-link file.");
    if (fileStat.size > POLICY_MAX_BYTES) throw unavailable("The billing policy artifact is too large.");
    if (process.platform !== "win32") {
      if ((dirStat.mode & 0o7777) !== 0o700) throw unavailable("The billing policy directory is not private.");
      if ((fileStat.mode & 0o7777) !== 0o600) throw unavailable("The billing policy artifact is not private.");
    }
  }

  // ------------------------------------------------------------- authenticated view

  private loadLog(context: Context): { head: { ordinal: number; mac: string }; frames: Frame[] } {
    const totals = this.db()
      .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(CAST(frame_json AS BLOB))),0) AS bytes FROM control_billing_log")
      .get() as unknown as { n: number; bytes: number };
    const total = Number(totals.n);
    if (total > 100_000) throw unavailable("The billing journal exceeds the entries bound.");
    if (Number(totals.bytes) > 16 * 1024 * 1024) throw unavailable("The billing journal exceeds the byte bound.");
    const rows = this.db()
      .prepare("SELECT epoch,ordinal,frame_json,mac FROM control_billing_log WHERE epoch=? ORDER BY ordinal LIMIT ?")
      .all(context.epoch, 100_001) as unknown as { epoch: number; ordinal: number; frame_json: string; mac: string }[];
    // ANY row outside the current epoch is a refusal, never filtered away.
    if (rows.length !== total) throw unavailable("The billing journal contains rows outside the bound epoch.");
    const heads = this.db()
      .prepare("SELECT singleton,epoch,ordinal,mac FROM control_billing_head")
      .all() as unknown as { singleton: number; epoch: number; ordinal: number; mac: string }[];
    if (heads.length > 1) throw unavailable("The billing journal has more than one head.");
    const head = heads[0];
    if (head && (head.singleton !== 1 || head.epoch !== context.epoch))
      throw unavailable("The billing journal head is malformed or in a foreign epoch.");

    const frames: Frame[] = [];
    let previousMac = "";
    let countedBytes = 0;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]!;
      if (row.ordinal !== index) throw unavailable("The billing journal ordinals are not contiguous from zero.");
      const bytes = Buffer.byteLength(row.frame_json, "utf8");
      if (bytes > 16 * 1024) throw unavailable("A billing journal frame exceeds the maximum size.");
      countedBytes += bytes;
      if (countedBytes > 16 * 1024 * 1024) throw unavailable("The billing journal exceeds the byte bound.");
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.frame_json);
      } catch {
        throw unavailable("A billing journal frame is unreadable.");
      }
      if (canonicalSealFrame(parsed) !== row.frame_json) throw unavailable("A billing journal frame is not canonical.");
      const frame = parsed as Record<string, unknown>;
      if (frame.epoch !== context.epoch || frame.ordinal !== index) throw unavailable("A billing journal frame is out of context.");
      if (frame.root_nonce !== context.root_nonce || frame.policy_id !== context.policy.policy_id)
        throw unavailable("A billing journal frame is out of context.");
      if (frame.prev_mac !== previousMac) throw unavailable("The billing journal chain link does not match.");
      if (!verifySealMac(frame, context.key, row.mac)) throw unavailable("A billing journal frame MAC is invalid.");
      previousMac = row.mac;
      frames.push({ ordinal: index, frame, mac: row.mac });
    }

    if (rows.length === 0) {
      if (head) throw unavailable("A billing journal head exists with no records.");
      return { head: { ordinal: -1, mac: "" }, frames };
    }
    if (!head) throw unavailable("Billing journal records exist without a head.");
    if (head.epoch !== context.epoch || head.ordinal !== rows.length - 1 || head.mac !== previousMac)
      throw unavailable("The billing journal head does not match the final record.");
    return { head: { ordinal: head.ordinal, mac: head.mac }, frames };
  }

  private accountRow(accountId: string): AccountRow | undefined {
    return this.db()
      .prepare("SELECT account_id,binding_json,binding_digest,admission_ordinal,adverse_generation FROM control_billing_account WHERE account_id=?")
      .get(accountId) as unknown as AccountRow | undefined;
  }

  private planFor(context: Context, binding: ServerOwnedBinding): BillingCatalogPlan | undefined {
    const plan = context.policy.catalog.find((entry) => entry.cadence === binding.cadence);
    if (!plan) return undefined;
    if (plan.product_ref !== binding.product_ref || plan.price_ref !== binding.price_ref) return undefined;
    if (context.policy.mode !== binding.mode) return undefined;
    return plan;
  }

  private capsMatch(context: Context, plan: BillingCatalogPlan, accountId: string): boolean {
    if (
      context.policy.service_daily_micro_usd === 0 ||
      plan.allowance_micro_usd === 0 ||
      plan.per_job_micro_usd === 0 ||
      plan.user_daily_micro_usd === 0
    )
      return false;
    const service = this.db()
      .prepare("SELECT daily_micro_usd FROM managed_service_policy WHERE service='managed-processing'")
      .get() as unknown as { daily_micro_usd: number } | undefined;
    if (!service || Number(service.daily_micro_usd) !== context.policy.service_daily_micro_usd) return false;
    const account = this.db()
      .prepare("SELECT per_job_micro_usd,user_daily_micro_usd FROM managed_account_policy WHERE account_id=?")
      .get(accountId) as unknown as { per_job_micro_usd: number; user_daily_micro_usd: number } | undefined;
    if (
      !account ||
      Number(account.per_job_micro_usd) !== plan.per_job_micro_usd ||
      Number(account.user_daily_micro_usd) !== plan.user_daily_micro_usd
    )
      return false;
    return true;
  }

  private termsFor(
    context: Context,
    accountId: string,
    binding: ServerOwnedBinding,
    frames: Frame[],
  ): Map<string, TermView> {
    const rows = this.db()
      .prepare("SELECT term_id,receipt_json,receipt_digest,epoch,journal_ordinal FROM control_billing_terms WHERE account_id=? ORDER BY journal_ordinal LIMIT ?")
      .all(accountId, 100_001) as unknown as { term_id: string; receipt_json: string; receipt_digest: string; epoch: number; journal_ordinal: number }[];
    if (rows.length > 100_000) throw unavailable("The billing terms exceed the entries bound.");
    const byOrdinal = new Map<number, Frame>(frames.map((entry) => [entry.ordinal, entry]));
    const bindingValue = bindingDigest(binding);
    const terms = new Map<string, TermView>();
    for (const row of rows) {
      if (row.epoch !== context.epoch) throw unavailable("A billing term is out of epoch.");
      if (Buffer.byteLength(row.receipt_json, "utf8") > 16 * 1024) throw unavailable("A billing receipt exceeds the maximum size.");
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.receipt_json);
      } catch {
        throw unavailable("A billing receipt is unreadable.");
      }
      const receipt = validateBillingReceipt(parsed);
      if (receiptDigest(receipt) !== row.receipt_digest) throw unavailable("A billing receipt digest does not match its data.");
      if (receipt.account_id !== accountId || receipt.binding_digest !== bindingValue)
        throw unavailable("A billing receipt does not belong to this account binding.");
      if (
        receipt.product_ref !== binding.product_ref ||
        receipt.price_ref !== binding.price_ref ||
        receipt.cadence !== binding.cadence ||
        receipt.customer_ref !== binding.customer_ref ||
        receipt.subscription_ref !== binding.subscription_ref
      )
        throw unavailable("A billing receipt does not match the bound subscription.");
      const expected = receiptTermId(accountId, receipt);
      if (expected !== row.term_id) throw unavailable("A billing term identity does not match its receipt.");
      // The term must be authenticated by the exact GRANT frame at its own ordinal.
      const entry = byOrdinal.get(Number(row.journal_ordinal));
      if (!entry || entry.frame.purpose !== "grant") throw unavailable("A billing term has no authenticating grant.");
      const body = entry.frame.body as GrantBody | undefined;
      if (!body || body.account_id !== accountId || body.term_id !== row.term_id)
        throw unavailable("A billing term is not bound by its grant frame.");
      const sources = entry.frame.source_ids as unknown;
      if (
        !Array.isArray(sources) ||
        !sources.includes(`receipt:${row.receipt_digest}`) ||
        !sources.includes(`binding:${bindingValue}`)
      )
        throw unavailable("A billing grant does not reference its retained receipt.");
      terms.set(row.term_id, { term_id: row.term_id, receipt, receipt_digest: row.receipt_digest, journal_ordinal: Number(row.journal_ordinal) });
    }
    void context;
    return terms;
  }

  private grantsFor(context: Context, accountId: string, terms: Map<string, TermView>, frames: Frame[]): Map<string, GrantView> {
    const grants = new Map<string, GrantView>();
    void context;
    for (const entry of frames) {
      if (entry.frame.purpose !== "grant") continue;
      const body = entry.frame.body as GrantBody | undefined;
      if (!body || body.account_id !== accountId) continue;
      if (typeof body.window_id !== "string" || typeof body.term_id !== "string") throw unavailable("A billing grant is malformed.");
      const term = terms.get(body.term_id);
      if (!term) throw unavailable("A billing grant references an unknown term.");
      if (grants.has(body.window_id)) throw unavailable("A billing window has more than one authenticated grant.");
      const sources = entry.frame.source_ids as unknown;
      if (!Array.isArray(sources) || sources.length !== 2 ||
          !sources.includes(`receipt:${term.receipt_digest}`) ||
          !sources.includes(`binding:${term.receipt.binding_digest}`))
        throw unavailable("A billing grant does not match its retained term provenance.");
      grants.set(body.window_id, { ordinal: entry.ordinal, body });
    }
    return grants;
  }

  private periodsFor(context: Context, accountId: string, grants: Map<string, GrantView>): Map<string, PeriodRow> {
    const rows = this.db()
      .prepare(
        "SELECT window_id,period_id,term_id,window_start,window_end,allowance_micro_usd,epoch,journal_ordinal FROM control_billing_period WHERE account_id=? LIMIT ?",
      )
      .all(accountId, 100_001) as unknown as PeriodRow[];
    if (rows.length > 100_000) throw unavailable("The billing grant mappings exceed the entries bound.");
    const periods = new Map<string, PeriodRow>();
    for (const row of rows) {
      const grant = grants.get(row.window_id);
      if (!grant) throw unavailable("A billing grant mapping has no authenticated grant.");
      if (
        row.period_id !== grant.body.period_id ||
        row.term_id !== grant.body.term_id ||
        row.window_start !== grant.body.window_start ||
        row.window_end !== grant.body.window_end ||
        Number(row.allowance_micro_usd) !== grant.body.allowance_micro_usd ||
        Number(row.epoch) !== context.epoch ||
        Number(row.journal_ordinal) !== grant.ordinal
      )
        throw unavailable("A billing grant mapping does not match its authenticated grant.");
      // The exact central projection must exist, belong to this account and still be active.
      const central = this.db()
        .prepare("SELECT account_id,starts_at,ends_at,allowance_micro_usd,state FROM managed_account_periods WHERE period_id=?")
        .get(row.period_id) as unknown as
        | { account_id: string; starts_at: string; ends_at: string; allowance_micro_usd: number; state: string }
        | undefined;
      if (
        !central ||
        central.account_id !== accountId ||
        central.starts_at !== row.window_start ||
        central.ends_at !== row.window_end ||
        Number(central.allowance_micro_usd) !== Number(row.allowance_micro_usd) ||
        central.state !== "active"
      )
        throw unavailable("A billing grant mapping does not match its central period.");
      periods.set(row.window_id, row);
    }
    if (periods.size !== grants.size)
      throw unavailable("An authenticated billing grant has no retained period projection.");
    return periods;
  }

  /**
   * Adverse generation is derived from the SIGNED revocation frames, and each signed
   * revocation must have exactly one matching retained denial projection. A missing (or
   * extra) projection is corruption, never an inference of "no revocation".
   */
  private denialsFor(
    context: Context,
    accountId: string,
    frames: Frame[],
    bindingValue: string,
  ): { term_id: string; reason: RevocationReason; observation_digest: string; ordinal: number }[] {
    const rows = this.db()
      .prepare("SELECT observation_digest,account_id,observation_json,epoch,journal_ordinal FROM control_billing_denials WHERE account_id=? ORDER BY journal_ordinal LIMIT ?")
      .all(accountId, 100_001) as unknown as { observation_digest: string; account_id: string; observation_json: string; epoch: number; journal_ordinal: number }[];
    if (rows.length > 100_000) throw unavailable("The billing denials exceed the entries bound.");
    const byOrdinal = new Map<number, Frame>(frames.map((entry) => [entry.ordinal, entry]));
    const revocations = frames.filter((entry) => {
      const body = entry.frame.body as { account_id?: string } | undefined;
      return entry.frame.purpose === "revocation" && body?.account_id === accountId;
    });
    const rowByOrdinal = new Map<number, (typeof rows)[number]>();
    for (const row of rows) {
      if (Number(row.epoch) !== context.epoch) throw unavailable("A billing denial is out of epoch.");
      if (rowByOrdinal.has(Number(row.journal_ordinal))) throw unavailable("A billing denial ordinal is duplicated.");
      rowByOrdinal.set(Number(row.journal_ordinal), row);
    }
    if (revocations.length !== rows.length)
      throw unavailable("A signed billing revocation has no retained denial projection.");

    const denials: { term_id: string; reason: RevocationReason; observation_digest: string; ordinal: number }[] = [];
    let previousGeneration = 0;
    for (const entry of revocations) {
      const body = entry.frame.body as { account_id?: string; term_id?: string; adverse_generation?: number; reason?: string };
      const row = rowByOrdinal.get(entry.ordinal);
      if (!row) throw unavailable("A signed billing revocation has no retained denial projection.");
      if (body.adverse_generation !== previousGeneration + 1) throw unavailable("The billing denial sequence is not monotonic.");
      previousGeneration = body.adverse_generation;
      if (row.account_id !== accountId) throw unavailable("A billing denial belongs to another account.");
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.observation_json);
      } catch {
        throw unavailable("A billing denial observation is unreadable.");
      }
      const observation = validateBillingDenialObservation(parsed);
      if (denialDigest(observation) !== row.observation_digest)
        throw unavailable("A billing denial observation digest does not match its data.");
      if (observation.account_id !== accountId || observation.binding_digest !== bindingValue)
        throw unavailable("A billing denial observation is out of context.");
      if (
        sha({
          account_id: accountId,
          subscription_ref: observation.subscription_ref,
          paid_period_start: observation.paid_period_start,
          paid_period_end: observation.paid_period_end,
        }) !== body.term_id
      )
        throw unavailable("A billing denial term does not match its signed revocation.");
      if (observation.current_state !== body.reason && revocationReason(observation.current_state) !== body.reason)
        throw unavailable("A billing denial reason does not match its signed revocation.");
      const sources = entry.frame.source_ids as unknown;
      if (!Array.isArray(sources) || !sources.includes(`observation:${row.observation_digest}`))
        throw unavailable("A billing revocation does not reference its retained observation.");
      if (!sources.includes(`binding:${bindingValue}`))
        throw unavailable("A billing revocation does not reference its account binding.");
      denials.push({
        term_id: body.term_id as string,
        reason: body.reason as RevocationReason,
        observation_digest: row.observation_digest,
        ordinal: entry.ordinal,
      });
    }
    void byOrdinal;
    return denials;
  }

  private snapshot(accountId: string): Snapshot {
    const context = this.context();
    const account = this.control.account(accountId);
    if (!account || account.state !== "active") throw unavailable("This account is not active for billing.");
    const row = this.accountRow(accountId);
    if (!row) throw unavailable("This account has no trusted billing admission.");
    const binding = validateServerOwnedBinding(JSON.parse(row.binding_json));
    const digest = bindingDigest(binding);
    if (binding.account_id !== row.account_id || digest !== row.binding_digest)
      throw unavailable("The billing binding does not match its signed admission.");
    const identity = identityDigest({ account_id: account.id, issuer: account.issuer, subject: account.subject });
    if (identity !== binding.identity_digest)
      throw unavailable("The billing binding does not match the current control identity.");
    const plan = this.planFor(context, binding);
    if (!plan) throw unavailable("The billing binding does not match the frozen operator catalog.");
    if (!this.capsMatch(context, plan, accountId))
      throw unavailable("The configured billing caps do not match the frozen operator policy.");

    const { head, frames } = this.loadLog(context);
    const admission = frames.find((entry) => entry.ordinal === row.admission_ordinal);
    if (!admission || admission.frame.purpose !== "admission")
      throw unavailable("The signed billing admission is missing.");
    const admissionBody = admission.frame.body as { account_id?: string; identity_digest?: string; tenant_incarnation?: string };
    const admissionSources = admission.frame.source_ids as unknown;
    if (
      admissionBody.account_id !== row.account_id ||
      admissionBody.identity_digest !== binding.identity_digest ||
      admissionBody.tenant_incarnation !== binding.tenant_incarnation ||
      !Array.isArray(admissionSources) ||
      !admissionSources.includes(`binding:${digest}`) ||
      !admissionSources.includes(`baseline:${(admission.frame.body as { clean_baseline_proof?: string }).clean_baseline_proof}`)
    )
      throw unavailable("The signed billing admission does not bind this account.");

    const terms = this.termsFor(context, accountId, binding, frames);
    const grants = this.grantsFor(context, accountId, terms, frames);
    const periods = this.periodsFor(context, accountId, grants);
    const denials = this.denialsFor(context, accountId, frames, digest);
    if (denials.length !== row.adverse_generation)
      throw unavailable("The billing adverse generation does not match its signed denials.");

    const snapshot: Snapshot = {
      context,
      account_id: accountId,
      binding,
      binding_digest: digest,
      plan,
      admission_ordinal: row.admission_ordinal,
      head,
      frames,
      terms,
      grants,
      periods,
      denials,
      revokedTermIds: new Set(denials.map((denial) => denial.term_id)),
      adverse: denials.length,
    };
    const freshness = this.freshnessRow(accountId);
    if (freshness) snapshot.freshness = this.authenticatedFreshness(snapshot, freshness);
    return snapshot;
  }

  private freshnessRow(accountId: string):
    | { term_id: string; observation_json: string; frame_json: string; mac: string; revision: number; adverse_generation: number }
    | undefined {
    return this.db()
      .prepare("SELECT term_id,observation_json,frame_json,mac,revision,adverse_generation FROM control_billing_freshness WHERE account_id=?")
      .get(accountId) as unknown as
      | { term_id: string; observation_json: string; frame_json: string; mac: string; revision: number; adverse_generation: number }
      | undefined;
  }

  private authenticatedFreshness(
    snapshot: Snapshot,
    row: { term_id: string; observation_json: string; frame_json: string; mac: string; revision: number; adverse_generation: number },
  ): FreshnessView | undefined {
    const context = snapshot.context;
    let frame: unknown;
    try {
      frame = JSON.parse(row.frame_json);
    } catch {
      throw unavailable("The billing freshness frame is unreadable.");
    }
    if (canonicalSealFrame(frame) !== row.frame_json) throw unavailable("The billing freshness frame is not canonical.");
    if (!verifySealMac(frame, context.key, row.mac)) throw unavailable("The billing freshness MAC is invalid.");
    const outer = frame as { purpose?: string; epoch?: number; root_nonce?: string; policy_id?: string; ordinal?: number; prev_mac?: string; source_ids?: unknown; body?: Record<string, unknown> };
    if (
      outer.purpose !== "freshness" ||
      outer.epoch !== context.epoch ||
      outer.root_nonce !== context.root_nonce ||
      outer.policy_id !== context.policy.policy_id ||
      outer.ordinal !== 0 ||
      outer.prev_mac !== ""
    )
      throw unavailable("The billing freshness frame is out of context.");
    const body = outer.body ?? {};
    if (body.account_id !== snapshot.account_id || body.term_id !== row.term_id)
      throw unavailable("The billing freshness belongs to another account or term.");
    if (body.revision !== row.revision || body.adverse_generation !== row.adverse_generation)
      throw unavailable("The billing freshness body does not match its stored columns.");
    if (typeof body.verified_at !== "string" || typeof body.expires_at !== "string")
      throw unavailable("The billing freshness window is invalid.");
    const verified = parseCanonicalUtc(body.verified_at);
    const expires = parseCanonicalUtc(body.expires_at);
    if (expires.getTime() <= verified.getTime() || expires.getTime() - verified.getTime() > BILLING_FRESHNESS_MAX_MS)
      throw unavailable("The billing freshness window is invalid.");

    let observationRaw: unknown;
    try {
      observationRaw = JSON.parse(row.observation_json);
    } catch {
      throw unavailable("The billing freshness observation is unreadable.");
    }
    const observation = validateBillingObservation(observationRaw);
    if (observation.account_id !== snapshot.account_id || observation.binding_digest !== snapshot.binding_digest)
      throw unavailable("The billing freshness observation is out of context.");
    if (observation.current_state !== "active" || !observation.completed_payment)
      throw unavailable("The billing freshness observation is not an active payment.");
    if (observation.customer_ref !== snapshot.binding.customer_ref ||
        observation.subscription_ref !== snapshot.binding.subscription_ref ||
        observation.product_ref !== snapshot.binding.product_ref ||
        observation.price_ref !== snapshot.binding.price_ref ||
        observation.cadence !== snapshot.binding.cadence)
      throw unavailable("The billing freshness observation does not match the bound subscription.");
    if (body.verified_at !== observation.verified_at)
      throw unavailable("The billing freshness frame and observation disagree on the verification time.");
    const projection = observationDigest(observation);
    const sources = outer.source_ids as unknown;
    const termView = snapshot.terms.get(row.term_id);
    if (!termView) throw unavailable("The billing freshness references an unknown term.");
    const receipt = termView.receipt_digest;
    if (
      !Array.isArray(sources) ||
      sources.length !== 3 ||
      !sources.includes(`projection:${projection}`) ||
      !sources.includes(`receipt:${receipt}`) ||
      !sources.includes(`binding:${snapshot.binding_digest}`)
    )
      throw unavailable("The billing freshness references do not match its retained evidence.");
    // The observation must reconstruct the bound receipt's full identity and bounds.
    const observationReceipt = receiptFromFacts(
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
      snapshot.binding,
    );
    if (receiptDigest(observationReceipt) !== receipt) throw unavailable("The billing freshness observation does not reconstruct its receipt.");
    const expectedExpires = new Date(
      Math.min(verified.getTime() + BILLING_FRESHNESS_MAX_MS, parseCanonicalUtc(observation.paid_period_end).getTime()),
    ).toISOString();
    if (expires.toISOString() !== expectedExpires) throw unavailable("The billing freshness expiry is not the signed minimum.");
    if (row.adverse_generation !== snapshot.adverse) return undefined;
    return {
      term_id: row.term_id,
      observation,
      receipt_digest: receipt,
      binding_digest: snapshot.binding_digest,
      expires_at: expires.toISOString(),
      revision: row.revision,
      adverse_generation: row.adverse_generation,
      mac: row.mac,
    };
  }

  // ------------------------------------------------------------------ evaluation

  private windowFor(binding: ServerOwnedBinding, paidStart: string, paidEnd: string, now: Date) {
    return billingWindow({
      account_id: binding.account_id,
      subscription_ref: binding.subscription_ref,
      cadence: binding.cadence,
      paid_term_start: paidStart,
      paid_term_end: paidEnd,
      now,
    });
  }

  private evaluate(snapshot: Snapshot, facts: ProviderFacts, now: Date): Evaluation {
    const { binding } = snapshot;
    if (
      facts.product_ref !== binding.product_ref ||
      facts.price_ref !== binding.price_ref ||
      facts.cadence !== binding.cadence ||
      facts.customer_ref !== binding.customer_ref ||
      facts.subscription_ref !== binding.subscription_ref
    )
      return { state: "denied", reason: "conflict" };

    // Initial versus renewal chronology is scoped to THIS account.
    const accountTerms = [...snapshot.terms.values()];
    if (accountTerms.length === 0 && facts.transaction_ref !== binding.initial_transaction_ref)
      return { state: "denied", reason: "conflict" };

    const verified = parseCanonicalUtc(facts.verified_at);
    const age = now.getTime() - verified.getTime();
    if (age < 0 || age >= BILLING_FRESHNESS_MAX_MS) return { state: "denied", reason: "stale" };

    const term = termId(snapshot.account_id, facts);
    if (snapshot.revokedTermIds.has(term)) return { state: "denied", reason: "conflict" };
    if (facts.current_state !== "active") return { state: "revocation", reason: revocationReason(facts.current_state) };
    if (!facts.completed_payment) return { state: "denied", reason: "no_grant" };

    let window;
    try {
      window = this.windowFor(binding, facts.paid_period_start, facts.paid_period_end, now);
    } catch {
      return { state: "denied", reason: "no_grant" };
    }
    if (window.state !== "window") return { state: "denied", reason: "no_grant" };
    if (binding.cadence === "monthly") {
      const span = parseCanonicalUtc(facts.paid_period_end).getTime() - parseCanonicalUtc(facts.paid_period_start).getTime();
      if (span > MAX_TERM_MS) return { state: "denied", reason: "no_grant" };
    }
    return {
      state: "granted",
      window_id: window.window.window_id,
      window_start: window.window.window_start,
      window_end: window.window.window_end,
    };
  }

  // ------------------------------------------------------------------ public

  async reconcile(accountId: string): Promise<ReconciliationDecision> {
    if (!this.source) return { state: "denied", reason: "no_source" };
    if (this.db().isTransaction)
      throw unavailable("A billing write cannot run inside an existing transaction.");
    if (!isUuid(accountId)) invalid("The billing account is invalid.");

    const before = this.snapshot(accountId);
    const capturedHead = before.head;
    const capturedRevision = before.freshness?.revision ?? 0;

    let raw: ProviderFacts;
    try {
      raw = await this.source.read(before.binding);
    } catch (error) {
      if (error instanceof BrainError) throw error;
      throw unavailable("The billing evidence source failed.");
    }
    let facts: ProviderFacts;
    try {
      facts = validateProviderFacts(raw);
    } catch {
      return { state: "denied", reason: "no_grant" };
    }

    this.db().exec("BEGIN IMMEDIATE");
    let settled = false;
    try {
      const live = this.snapshot(accountId);
      if (live.head.ordinal !== capturedHead.ordinal || live.head.mac !== capturedHead.mac)
        throw unavailable("The billing journal changed during reconciliation.");
      if (live.binding_digest !== before.binding_digest || live.adverse !== before.adverse)
        throw unavailable("The billing account changed during reconciliation.");
      if ((live.freshness?.revision ?? 0) !== capturedRevision)
        throw unavailable("The billing freshness changed during reconciliation.");

      const evaluation = this.evaluate(live, facts, this.clock());
      if (evaluation.state === "denied") {
        this.db().exec("ROLLBACK");
        settled = true;
        return evaluation;
      }
      const decision = this.publish(live, facts, evaluation);
      try {
        this.db().exec("COMMIT");
      } catch {
        throw unavailable("The billing write could not commit.");
      }
      if (this.db().isTransaction)
        throw unavailable("The billing write commit was not applied.");
      settled = true;
      return decision;
    } catch (error) {
      if (!settled && this.db().isTransaction) {
        try {
          this.db().exec("ROLLBACK");
        } catch {
          /* a denied rollback cannot turn a refusal into success */
        }
      }
      if (error instanceof BrainError) throw error;
      throw unavailable();
    }
  }

  billingEligibility(accountId: string): BillingEligibility {
    if (!this.source) return { state: "unavailable", reason: "no_grant" };
    return this.eligibility(accountId);
  }

  ensureCurrentGrant(accountId: string): BillingEligibility {
    if (!this.source) return { state: "unavailable", reason: "no_grant" };
    if (this.db().isTransaction)
      throw unavailable("A billing write cannot run inside an existing transaction.");
    const current = this.eligibility(accountId);
    if (current.state === "granted") return current;

    const snapshot = this.snapshot(accountId);
    const freshness = snapshot.freshness;
    if (!freshness) return { state: "unavailable", reason: "no_grant" };
    const now = this.clock();
    if (now.getTime() >= parseCanonicalUtc(freshness.expires_at).getTime())
      return { state: "unavailable", reason: "stale" };
    if (now.getTime() < parseCanonicalUtc(freshness.observation.verified_at).getTime())
      return { state: "unavailable", reason: "stale" };
    if (freshness.observation.current_state !== "active" || !freshness.observation.completed_payment)
      return { state: "unavailable", reason: "no_grant" };

    const term = snapshot.terms.get(freshness.term_id);
    if (!term) return { state: "unavailable", reason: "no_grant" };
    let window;
    try {
      window = this.windowFor(
        snapshot.binding,
        term.receipt.paid_period_start,
        term.receipt.paid_period_end,
        now,
      );
    } catch {
      return { state: "unavailable", reason: "no_grant" };
    }
    if (window.state !== "window") return { state: "unavailable", reason: "no_grant" };
    if (snapshot.periods.has(window.window.window_id)) return this.eligibility(accountId);

    this.db().exec("BEGIN IMMEDIATE");
    let settled = false;
    try {
      const live = this.snapshot(accountId);
      if (live.head.ordinal !== snapshot.head.ordinal || live.head.mac !== snapshot.head.mac)
        throw unavailable("The billing journal changed during materialization.");
      if (live.adverse !== snapshot.adverse || live.binding_digest !== snapshot.binding_digest)
        throw unavailable("The billing account changed during materialization.");
      if ((live.freshness?.revision ?? 0) !== freshness.revision)
        throw unavailable("The billing freshness changed during materialization.");
      const liveFreshness = live.freshness;
      if (!liveFreshness || this.clock().getTime() >= parseCanonicalUtc(liveFreshness.expires_at).getTime()) {
        this.db().exec("ROLLBACK");
        settled = true;
        return { state: "unavailable", reason: "stale" };
      }
      const { schema: _schema, account_id: _account, binding_digest: _binding, ...liveFacts } = liveFreshness.observation;
      this.publish(live, liveFacts as ProviderFacts, {
        state: "granted",
        window_id: window.window.window_id,
        window_start: window.window.window_start,
        window_end: window.window.window_end,
      });
      try {
        this.db().exec("COMMIT");
      } catch {
        throw unavailable("The billing write could not commit.");
      }
      if (this.db().isTransaction)
        throw unavailable("The billing write commit was not applied.");
      settled = true;
    } catch (error) {
      if (!settled && this.db().isTransaction) {
        try {
          this.db().exec("ROLLBACK");
        } catch {
          /* refuse */
        }
      }
      if (error instanceof BrainError) throw error;
      throw unavailable();
    }
    return this.eligibility(accountId);
  }

  // ------------------------------------------------------- owned admission

  /**
   * Owned, two-phase admission. `beginAdmission` retains a durable preflight proof
   * after a read-only tenant snapshot OUTSIDE any control transaction; `admitAccount`
   * re-checks every stored column and appends the first/next admission frame plus the
   * account binding inside one control transaction. The caller supplies only owned
   * ids; root/policy/key/identity/tenant paths are trusted composition, and the
   * correlation dependency (production null) is separate from the evidence source.
   */
  async beginAdmission(accountId: string): Promise<AdmissionDecision> {
    if (!this.correlation) return { state: "denied", reason: "no_source" };
    if (!isUuid(accountId)) invalid("The billing account is invalid.");
    const context = this.context();
    const account = this.control.account(accountId);
    if (!account || account.state !== "active") return { state: "denied", reason: "conflict" };
    if (this.accountRow(accountId)) return { state: "denied", reason: "already" };
    const incarnation = readAccountIncarnation(this.db(), accountId);
    if (!incarnation) return { state: "denied", reason: "generation_mismatch" };
    if (activeFence(this.db(), accountId)) return { state: "denied", reason: "fenced" };
    const identity = identityDigest({
      account_id: account.id,
      issuer: account.issuer,
      subject: account.subject,
    });
    let raw: unknown;
    try {
      raw = await this.correlation.resolve({ account_id: accountId, identity_digest: identity });
    } catch {
      return { state: "denied", reason: "conflict" };
    }
    let correlation;
    try {
      correlation = validateServerBillingCorrelation(raw);
    } catch {
      return { state: "denied", reason: "conflict" };
    }
    const binding = validateServerOwnedBinding({
      schema: 1,
      account_id: accountId,
      identity_digest: identity,
      tenant_incarnation: incarnation.incarnation,
      provisioning_generation: incarnation.provisioning_generation,
      mode: correlation.mode,
      product_ref: correlation.product_ref,
      price_ref: correlation.price_ref,
      cadence: correlation.cadence,
      customer_ref: correlation.customer_ref,
      subscription_ref: correlation.subscription_ref,
      initial_transaction_ref: correlation.initial_transaction_ref,
      correlation_ref: correlation.correlation_ref,
      version: correlation.version,
    });
    const digest = bindingDigest(binding);
    const proof = this.readTenantBaseline(
      accountId,
      incarnation.incarnation,
      incarnation.provisioning_generation,
    );
    if (!proof) return { state: "denied", reason: "dirty_baseline" };
    const cleanBaselineProof = cleanBaselineDigest(proof);

    this.db().exec("BEGIN IMMEDIATE");
    try {
      const live = this.context();
      if (
        live.epoch !== context.epoch ||
        live.policy_digest !== context.policy_digest ||
        Buffer.compare(Buffer.from(live.key), Buffer.from(context.key)) !== 0
      ) {
        this.db().exec("ROLLBACK");
        return { state: "denied", reason: "policy_mismatch" };
      }
      const account2 = this.control.account(accountId);
      if (!account2 || account2.state !== "active") {
        this.db().exec("ROLLBACK");
        return { state: "denied", reason: "conflict" };
      }
      if (this.accountRow(accountId)) {
        this.db().exec("ROLLBACK");
        return { state: "denied", reason: "already" };
      }
      const inc2 = readAccountIncarnation(this.db(), accountId);
      if (
        !inc2 ||
        inc2.incarnation !== binding.tenant_incarnation ||
        inc2.provisioning_generation !== binding.provisioning_generation
      ) {
        this.db().exec("ROLLBACK");
        return { state: "denied", reason: "generation_mismatch" };
      }
      if (activeFence(this.db(), accountId)) {
        this.db().exec("ROLLBACK");
        return { state: "denied", reason: "fenced" };
      }
      const now = this.clock();
      const createdAt = now.toISOString();
      const expiresAt = new Date(now.getTime() + BILLING_FRESHNESS_MAX_MS).toISOString();
      const preflightId = randomUUID();
      const columns: AdmissionPreflightColumns = {
        preflight_id: preflightId,
        account_id: accountId,
        incarnation: inc2.incarnation,
        provisioning_generation: inc2.provisioning_generation,
        identity_digest: identity,
        binding_digest: digest,
        binding_json: canonical(binding),
        baseline_json: canonical(proof),
        policy_id: live.policy.policy_id,
        policy_digest: live.policy_digest,
        root_epoch: live.epoch,
        root_nonce: live.root_nonce,
        mode: correlation.mode,
        created_at: createdAt,
        expires_at: expiresAt,
      };
      const requestDigest = preflightRequestDigest(columns, cleanBaselineProof);
      const proofFrame = {
        schema: 1,
        purpose: "admission",
        epoch: live.epoch,
        root_nonce: live.root_nonce,
        policy_id: live.policy.policy_id,
        source_ids: [
          `binding:${digest}`,
          `baseline:${cleanBaselineProof}`,
          `request:${requestDigest}`,
        ],
        ordinal: 0,
        prev_mac: "",
        body: {
          account_id: accountId,
          identity_digest: identity,
          tenant_incarnation: inc2.incarnation,
          clean_baseline_proof: cleanBaselineProof,
        },
      };
      const proofJson = canonicalSealFrame(proofFrame);
      const proofMac = sealMac(proofFrame, live.key);
      const inserted = this.db()
        .prepare(
          `INSERT INTO control_billing_preflight(
             preflight_id,account_id,incarnation,provisioning_generation,identity_digest,
             binding_digest,binding_json,baseline_json,policy_id,policy_digest,root_epoch,root_nonce,
             proof_json,proof_mac,mode,created_at,expires_at,consumed_at,admission_ordinal)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL)`,
        )
        .run(
          preflightId,
          accountId,
          inc2.incarnation,
          inc2.provisioning_generation,
          identity,
          digest,
          canonical(binding),
          canonical(proof),
          live.policy.policy_id,
          live.policy_digest,
          live.epoch,
          live.root_nonce,
          proofJson,
          proofMac,
          correlation.mode,
          createdAt,
          expiresAt,
        );
      if (Number(inserted.changes) !== 1)
        throw unavailable("The billing preflight was not retained.");
      this.db().exec("COMMIT");
      if (this.db().isTransaction)
        throw unavailable("The billing preflight commit was not applied.");
      return { state: "prepared", preflight_id: preflightId };
    } catch (error) {
      if (this.db().isTransaction) this.db().exec("ROLLBACK");
      if (error instanceof BrainError) throw error;
      throw unavailable();
    }
  }

  admitAccount(input: { account_id: string; preflight_id: string }): AdmissionDecision {
    if (!input || typeof input !== "object") invalid("An admission request is required.");
    const accountId = input.account_id;
    const preflightId = input.preflight_id;
    if (!isUuid(accountId)) invalid("The billing account is invalid.");
    if (typeof preflightId !== "string" || preflightId.length === 0)
      invalid("The billing preflight id is invalid.");

    this.db().exec("BEGIN IMMEDIATE");
    try {
      const row = this.db()
        .prepare("SELECT * FROM control_billing_preflight WHERE preflight_id=?")
        .get(preflightId) as unknown as PreflightRow | undefined;
      if (!row || row.account_id !== accountId) {
        this.db().exec("ROLLBACK");
        return { state: "denied", reason: "conflict" };
      }
      if (row.consumed_at !== null && row.consumed_at !== undefined) {
        const existing = this.accountRow(accountId);
        const consumed =
          !!existing && existing.admission_ordinal === Number(row.admission_ordinal);
        this.db().exec("ROLLBACK");
        return consumed ? { state: "admitted" } : { state: "denied", reason: "conflict" };
      }
      const now = this.clock();
      const created = parseCanonicalUtc(row.created_at);
      const expires = parseCanonicalUtc(row.expires_at);
      if (now.getTime() < created.getTime() || now.getTime() >= expires.getTime()) {
        this.db().exec("ROLLBACK");
        return { state: "denied", reason: "expired" };
      }
      const live = this.context();
      let proofFrame: { body?: unknown; source_ids?: unknown } & Record<string, unknown>;
      try {
        proofFrame = JSON.parse(row.proof_json);
      } catch {
        this.db().exec("ROLLBACK");
        return { state: "denied", reason: "conflict" };
      }
      if (
        canonicalSealFrame(proofFrame) !== row.proof_json ||
        !verifySealMac(proofFrame, live.key, row.proof_mac)
      ) {
        this.db().exec("ROLLBACK");
        return { state: "denied", reason: "conflict" };
      }
      if (
        row.root_epoch !== live.epoch ||
        row.root_nonce !== live.root_nonce ||
        row.policy_digest !== live.policy_digest ||
        row.policy_id !== live.policy.policy_id
      ) {
        this.db().exec("ROLLBACK");
        return { state: "denied", reason: "root_mismatch" };
      }
      const body = proofFrame.body as
        | { account_id?: string; clean_baseline_proof?: string }
        | undefined;
      if (!body || body.account_id !== accountId || typeof body.clean_baseline_proof !== "string") {
        this.db().exec("ROLLBACK");
        return { state: "denied", reason: "conflict" };
      }
      // The retained clean-baseline payload must resolve and authenticate the frame's
      // baseline digest; the full canonical record, not only its hash, is retained.
      let baseline;
      try {
        baseline = validateCleanBaselineProof(JSON.parse(row.baseline_json));
      } catch {
        this.db().exec("ROLLBACK");
        return { state: "denied", reason: "conflict" };
      }
      if (
        baseline.account_id !== accountId ||
        baseline.incarnation !== row.incarnation ||
        baseline.provisioning_generation !== Number(row.provisioning_generation) ||
        cleanBaselineDigest(baseline) !== body.clean_baseline_proof
      ) {
        this.db().exec("ROLLBACK");
        return { state: "denied", reason: "conflict" };
      }
      const columns: AdmissionPreflightColumns = {
        preflight_id: row.preflight_id,
        account_id: row.account_id,
        incarnation: row.incarnation,
        provisioning_generation: Number(row.provisioning_generation),
        identity_digest: row.identity_digest,
        binding_digest: row.binding_digest,
        binding_json: row.binding_json,
        baseline_json: row.baseline_json,
        policy_id: row.policy_id,
        policy_digest: row.policy_digest,
        root_epoch: Number(row.root_epoch),
        root_nonce: row.root_nonce,
        mode: row.mode,
        created_at: row.created_at,
        expires_at: row.expires_at,
      };
      const requestDigest = preflightRequestDigest(columns, body.clean_baseline_proof);
      const sources = proofFrame.source_ids as unknown;
      if (
        !Array.isArray(sources) ||
        !sources.includes(`request:${requestDigest}`) ||
        !sources.includes(`binding:${row.binding_digest}`) ||
        !sources.includes(`baseline:${body.clean_baseline_proof}`)
      ) {
        this.db().exec("ROLLBACK");
        return { state: "denied", reason: "conflict" };
      }
      const account = this.control.account(accountId);
      if (!account || account.state !== "active") {
        this.db().exec("ROLLBACK");
        return { state: "denied", reason: "conflict" };
      }
      if (this.accountRow(accountId)) {
        this.db().exec("ROLLBACK");
        return { state: "denied", reason: "already" };
      }
      const inc = readAccountIncarnation(this.db(), accountId);
      if (
        !inc ||
        inc.incarnation !== row.incarnation ||
        inc.provisioning_generation !== Number(row.provisioning_generation)
      ) {
        this.db().exec("ROLLBACK");
        return { state: "denied", reason: "generation_mismatch" };
      }
      if (activeFence(this.db(), accountId)) {
        this.db().exec("ROLLBACK");
        return { state: "denied", reason: "fenced" };
      }
      if (this.hasCentralHistory(accountId)) {
        this.db().exec("ROLLBACK");
        return { state: "denied", reason: "conflict" };
      }
      const { head } = this.loadLog(live);
      const ordinal = head.ordinal + 1;
      const frame = {
        schema: 1,
        purpose: "admission",
        epoch: live.epoch,
        root_nonce: live.root_nonce,
        policy_id: live.policy.policy_id,
        source_ids: sources,
        ordinal,
        prev_mac: head.mac,
        body: proofFrame.body,
      };
      const sealed = this.sealFrame(live, frame);
      const logInsert = this.db()
        .prepare("INSERT INTO control_billing_log(epoch,ordinal,frame_json,mac) VALUES(?,?,?,?)")
        .run(live.epoch, ordinal, sealed.frame_json, sealed.mac);
      if (Number(logInsert.changes) !== 1)
        throw unavailable("The billing admission frame was not written.");
      if (head.ordinal < 0) {
        const headInsert = this.db()
          .prepare("INSERT INTO control_billing_head(singleton,epoch,ordinal,mac) VALUES(1,?,?,?)")
          .run(live.epoch, ordinal, sealed.mac);
        if (Number(headInsert.changes) !== 1)
          throw unavailable("The billing admission head was not created.");
      } else {
        const headUpdate = this.db()
          .prepare(
            "UPDATE control_billing_head SET epoch=?,ordinal=?,mac=? WHERE singleton=1 AND ordinal=? AND mac=?",
          )
          .run(live.epoch, ordinal, sealed.mac, head.ordinal, head.mac);
        if (Number(headUpdate.changes) !== 1)
          throw unavailable("The billing admission head CAS failed.");
      }
      const accountInsert = this.db()
        .prepare(
          "INSERT INTO control_billing_account(account_id,binding_json,binding_digest,admission_ordinal,adverse_generation) VALUES(?,?,?,?,0)",
        )
        .run(accountId, row.binding_json, row.binding_digest, ordinal);
      if (Number(accountInsert.changes) !== 1)
        throw unavailable("The billing account was not admitted.");
      const consumed = this.db()
        .prepare(
          "UPDATE control_billing_preflight SET consumed_at=?,admission_ordinal=? WHERE preflight_id=? AND consumed_at IS NULL",
        )
        .run(now.toISOString(), ordinal, preflightId);
      if (Number(consumed.changes) !== 1)
        throw unavailable("The billing preflight was not consumed.");
      const readback = this.db()
        .prepare("SELECT epoch,ordinal,mac FROM control_billing_head WHERE singleton=1")
        .get() as unknown as { epoch: number; ordinal: number; mac: string } | undefined;
      if (!readback || readback.epoch !== live.epoch || Number(readback.ordinal) !== ordinal || readback.mac !== sealed.mac)
        throw unavailable("The billing admission head read-back failed.");
      this.db().exec("COMMIT");
      if (this.db().isTransaction)
        throw unavailable("The billing admission commit was not applied.");
      return { state: "admitted" };
    } catch (error) {
      if (this.db().isTransaction) this.db().exec("ROLLBACK");
      if (error instanceof BrainError) throw error;
      throw unavailable();
    }
  }

  private hasCentralHistory(accountId: string): boolean {
    const probe = (sql: string) =>
      !!this.db().prepare(sql).get(accountId);
    if (probe("SELECT 1 AS present FROM managed_reservations WHERE account_id=? LIMIT 1")) return true;
    if (probe("SELECT 1 AS present FROM managed_account_periods WHERE account_id=? LIMIT 1")) return true;
    if (probe("SELECT 1 AS present FROM control_billing_terms WHERE account_id=? LIMIT 1")) return true;
    if (probe("SELECT 1 AS present FROM control_billing_period WHERE account_id=? LIMIT 1")) return true;
    return probe("SELECT 1 AS present FROM control_billing_denials WHERE account_id=? LIMIT 1");
  }

  private readTenantBaseline(
    accountId: string,
    incarnation: string,
    generation: number,
  ): CleanBaselineProof | null {
    const dir = resolve(this.root, accountId);
    if (dirname(dir) !== resolve(this.root))
      throw unavailable("The tenant path escapes the managed root.");
    let dirStat;
    try {
      dirStat = lstatSync(dir);
    } catch {
      return null;
    }
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory())
      throw unavailable("The tenant directory is not trusted.");
    const dbPath = resolve(dir, "brain.sqlite");
    let fileStat;
    try {
      fileStat = lstatSync(dbPath);
    } catch {
      return null;
    }
    if (fileStat.isSymbolicLink() || !fileStat.isFile())
      throw unavailable("The tenant database is not trusted.");
    const realDir = realpathSync(dir);
    if (dirname(realpathSync(dbPath)) !== realDir)
      throw unavailable("The tenant database escapes its directory.");
    let tenant: DatabaseSync;
    try {
      tenant = new DatabaseSync(dbPath, { readOnly: true });
    } catch {
      return null;
    }
    try {
      const dispatches = tenant
        .prepare("SELECT COUNT(*) AS n FROM provider_dispatches")
        .get() as { n: number };
      const legacy = tenant
        .prepare("SELECT COUNT(*) AS n FROM reservations")
        .get() as { n: number };
      const blocked = tenant
        .prepare("SELECT 1 AS present FROM settings WHERE key='paid_processing_blocked' LIMIT 1")
        .get();
      const migrations = tenant
        .prepare("SELECT max(version) AS version FROM migrations")
        .get() as { version: number | null };
      if (Number(dispatches.n) !== 0 || Number(legacy.n) !== 0 || blocked) return null;
      return {
        schema: 1,
        account_id: accountId,
        incarnation,
        provisioning_generation: generation,
        tenant_schema_version: Number(migrations?.version ?? 0),
        provider_dispatches: 0,
        legacy_reservations: 0,
        paid_processing_blocked: false,
      };
    } catch {
      return null;
    } finally {
      tenant.close();
    }
  }

  /**
   * Read-only, source-independent funding check used by the mandatory low-level guard.
   * It runs the SAME complete closed validation as `billingEligibility` (admission,
   * terms/receipts, grants, periods, denials, freshness), then requires the exact
   * central period being funded to be the authenticated grant mapping. It is not a
   * new permission for a stale worker: the caller must already hold the matching,
   * generation-bound reservation. No `source` is required.
   */
  fundingGrant(accountId: string, periodId: string): BillingEligibility {
    if (!isUuid(accountId)) throw invalid("The billing account is invalid.");
    if (typeof periodId !== "string" || periodId.length === 0)
      throw invalid("The billing period is invalid.");
    const snapshot = this.snapshot(accountId);
    const freshness = snapshot.freshness;
    if (!freshness) return { state: "unavailable", reason: "no_grant" };
    if (freshness.adverse_generation !== snapshot.adverse)
      return { state: "unavailable", reason: "conflict" };
    if (freshness.observation.current_state !== "active" || !freshness.observation.completed_payment)
      return { state: "unavailable", reason: "no_grant" };
    const now = this.clock();
    if (now.getTime() >= parseCanonicalUtc(freshness.expires_at).getTime())
      return { state: "unavailable", reason: "stale" };
    if (now.getTime() < parseCanonicalUtc(freshness.observation.verified_at).getTime())
      return { state: "unavailable", reason: "stale" };
    const mapping = this.db()
      .prepare("SELECT window_id FROM control_billing_period WHERE period_id=? AND account_id=?")
      .get(periodId, accountId) as unknown as { window_id: string } | undefined;
    if (!mapping) return { state: "unavailable", reason: "no_grant" };
    const grant = snapshot.grants.get(mapping.window_id);
    if (!grant || !snapshot.periods.has(mapping.window_id))
      return { state: "unavailable", reason: "no_grant" };
    if (grant.body.term_id !== freshness.term_id)
      return { state: "unavailable", reason: "conflict" };
    const central = this.db()
      .prepare("SELECT account_id,starts_at,ends_at,allowance_micro_usd,state FROM managed_account_periods WHERE period_id=?")
      .get(grant.body.period_id) as unknown as
      | { account_id: string; starts_at: string; ends_at: string; allowance_micro_usd: number; state: string }
      | undefined;
    if (
      !central ||
      central.account_id !== accountId ||
      central.starts_at !== grant.body.window_start ||
      central.ends_at !== grant.body.window_end ||
      Number(central.allowance_micro_usd) !== grant.body.allowance_micro_usd ||
      central.state !== "active"
    )
      return { state: "unavailable", reason: "conflict" };
    if (
      now.getTime() < parseCanonicalUtc(grant.body.window_start).getTime() ||
      now.getTime() >= parseCanonicalUtc(grant.body.window_end).getTime()
    )
      return { state: "unavailable", reason: "stale" };
    return {
      state: "granted",
      window_id: grant.body.window_id,
      window_start: grant.body.window_start,
      window_end: grant.body.window_end,
      grant_proof: freshness.mac,
    };
  }

  private eligibility(accountId: string): BillingEligibility {
    const snapshot = this.snapshot(accountId);
    const freshness = snapshot.freshness;
    if (!freshness) return { state: "unavailable", reason: "no_grant" };
    if (freshness.adverse_generation !== snapshot.adverse) return { state: "unavailable", reason: "conflict" };
    if (freshness.observation.current_state !== "active" || !freshness.observation.completed_payment)
      return { state: "unavailable", reason: "no_grant" };
    const now = this.clock();
    if (now.getTime() >= parseCanonicalUtc(freshness.expires_at).getTime())
      return { state: "unavailable", reason: "stale" };
    if (now.getTime() < parseCanonicalUtc(freshness.observation.verified_at).getTime())
      return { state: "unavailable", reason: "stale" };
    const mapped = this.db()
      .prepare("SELECT window_id FROM control_billing_period WHERE term_id=? ORDER BY journal_ordinal DESC LIMIT 1")
      .get(freshness.term_id) as unknown as { window_id: string } | undefined;
    if (!mapped) return { state: "unavailable", reason: "no_grant" };
    const grant = snapshot.grants.get(mapped.window_id);
    if (!grant || !snapshot.periods.has(mapped.window_id)) return { state: "unavailable", reason: "no_grant" };
    if (grant.body.term_id !== freshness.term_id) return { state: "unavailable", reason: "conflict" };
    const central = this.db()
      .prepare("SELECT account_id,starts_at,ends_at,allowance_micro_usd,state FROM managed_account_periods WHERE period_id=?")
      .get(grant.body.period_id) as unknown as
      | { account_id: string; starts_at: string; ends_at: string; allowance_micro_usd: number; state: string }
      | undefined;
    if (
      !central ||
      central.account_id !== accountId ||
      central.starts_at !== grant.body.window_start ||
      central.ends_at !== grant.body.window_end ||
      Number(central.allowance_micro_usd) !== grant.body.allowance_micro_usd ||
      central.state !== "active"
    )
      return { state: "unavailable", reason: "conflict" };
    if (now.getTime() < parseCanonicalUtc(grant.body.window_start).getTime() || now.getTime() >= parseCanonicalUtc(grant.body.window_end).getTime())
      return { state: "unavailable", reason: "stale" };
    return {
      state: "granted",
      window_id: grant.body.window_id,
      window_start: grant.body.window_start,
      window_end: grant.body.window_end,
      grant_proof: freshness.mac,
    };
  }

  // ------------------------------------------------------------------ publication

  private publish(snapshot: Snapshot, facts: ProviderFacts, evaluation: Action): ReconciliationDecision {
    const context = snapshot.context;
    const db = this.db();
    const head = this.journalHead(snapshot);
    if (evaluation.state === "revocation") {
      const denial = denialFromFacts(facts, snapshot.account_id, snapshot.binding_digest);
      const digest = denialDigest(denial);
      const latest = snapshot.denials[snapshot.denials.length - 1];
      if (latest && latest.term_id === termId(snapshot.account_id, facts) && latest.reason === evaluation.reason && latest.observation_digest === digest)
        return { state: "denied", reason: evaluation.reason };
      const next = snapshot.adverse + 1;
      const ordinal = head.ordinal + 1;
      const frame = this.buildFrame(context, "revocation", [`observation:${digest}`, `binding:${snapshot.binding_digest}`], ordinal, head.mac, {
        account_id: snapshot.account_id,
        term_id: termId(snapshot.account_id, facts),
        adverse_generation: next,
        reason: evaluation.reason,
      });
      const sealed = this.sealFrame(context, frame.frame);
      this.insertLog(context, ordinal, sealed, head, snapshot);
      this.insertDenial(digest, snapshot.account_id, canonical(denial), context.epoch, ordinal);
      const updated = db
        .prepare("UPDATE control_billing_account SET adverse_generation=? WHERE account_id=? AND adverse_generation=?")
        .run(next, snapshot.account_id, snapshot.adverse);
      if (Number(updated.changes) !== 1) throw unavailable("The billing adverse generation update was not applied.");
      this.readBackAdverse(snapshot.account_id, next);
      if (this.snapshot(snapshot.account_id).adverse !== next)
        throw unavailable("The billing revocation did not verify before commit.");
      return { state: "denied", reason: evaluation.reason };
    }

    const window = { window_id: evaluation.window_id, window_start: evaluation.window_start, window_end: evaluation.window_end };
    const plan = snapshot.plan;
    const termValue = termId(snapshot.account_id, facts);
    const term = snapshot.terms.get(termValue);
    const receipt = term?.receipt ?? receiptFromFacts(facts, snapshot.binding);
    const digest = term?.receipt_digest ?? receiptDigest(receipt);

    const factsDigest = receiptDigest(receiptFromFacts(facts, snapshot.binding));
    // A stored term for this exact interval must always derive the identical receipt.
    if (term && term.receipt_digest !== factsDigest) return { state: "denied", reason: "conflict" };

    // A term that already maps this exact window refreshes only signed freshness.
    if (snapshot.periods.has(window.window_id)) {
      if (!term) throw unavailable("The billing grant mapping has no authenticated term.");
      this.writeFreshness(context, snapshot, termValue, term.receipt_digest, facts, head.ordinal, head);
      this.reverify(snapshot.account_id, window.window_id);
      return { state: "granted", window_id: window.window_id, window_start: window.window_start, window_end: window.window_end };
    }

    for (const other of this.db()
      .prepare("SELECT starts_at,ends_at FROM managed_account_periods WHERE account_id=?")
      .all(snapshot.account_id) as unknown as { starts_at: string; ends_at: string }[]) {
      if (other.starts_at < window.window_end && other.ends_at > window.window_start)
        return { state: "denied", reason: "conflict" };
    }

    const ordinal = head.ordinal + 1;
    const frame = this.buildFrame(context, "grant", [`receipt:${digest}`, `binding:${snapshot.binding_digest}`], ordinal, head.mac, {
      account_id: snapshot.account_id,
      window_id: window.window_id,
      term_id: termValue,
      period_id: "00000000-0000-4000-8000-000000000000",
      window_start: window.window_start,
      window_end: window.window_end,
      allowance_micro_usd: plan.allowance_micro_usd,
    });
    const periodId = randomUUID();
    (frame.frame.body as { period_id: string }).period_id = periodId;
    const sealed = this.sealFrame(context, frame.frame);
    this.insertLog(context, ordinal, sealed, head, snapshot);
    if (!term)
      this.insertTerm(termValue, snapshot.account_id, canonical(receipt), digest, context.epoch, ordinal, snapshot);
    const created = this.clock().toISOString();
    const inserted = db
      .prepare(
        "INSERT INTO managed_account_periods(period_id,account_id,starts_at,ends_at,allowance_micro_usd,state,granted_at,revoked_at) VALUES(?,?,?,?,?,?,?,NULL)",
      )
      .run(periodId, snapshot.account_id, window.window_start, window.window_end, plan.allowance_micro_usd, "active", created);
    if (Number(inserted.changes) !== 1) throw unavailable("The central billing period was not created.");
    const central = this.readBackCentral(periodId);
    if (
      central.account_id !== snapshot.account_id ||
      central.starts_at !== window.window_start ||
      central.ends_at !== window.window_end ||
      Number(central.allowance_micro_usd) !== plan.allowance_micro_usd ||
      central.state !== "active"
    )
      throw unavailable("The central billing period read-back failed.");

    const mapping = db
      .prepare(
        "INSERT INTO control_billing_period(grant_id,window_id,period_id,account_id,term_id,epoch,journal_ordinal,window_start,window_end,allowance_micro_usd) VALUES(?,?,?,?,?,?,?,?,?,?)",
      )
      .run(randomUUID(), window.window_id, periodId, snapshot.account_id, termValue, context.epoch, ordinal, window.window_start, window.window_end, plan.allowance_micro_usd);
    if (Number(mapping.changes) !== 1) throw unavailable("The billing grant mapping was not created.");
    this.readBackMapping(window.window_id, periodId, termValue, ordinal);

    this.writeFreshness(context, snapshot, termValue, digest, facts, ordinal, head);
    this.reverify(snapshot.account_id, window.window_id);
    return { state: "granted", window_id: window.window_id, window_start: window.window_start, window_end: window.window_end };
  }

  /** Re-derive the whole authenticated view inside the open write transaction. */
  private reverify(accountId: string, windowId: string): void {
    const post = this.snapshot(accountId);
    if (!post.freshness || !post.periods.has(windowId))
      throw unavailable("The billing grant did not verify before commit.");
  }

  private journalHead(snapshot: Snapshot): { ordinal: number; mac: string } {
    const head = snapshot.frames[snapshot.frames.length - 1];
    return { ordinal: head ? head.ordinal : -1, mac: head ? head.mac : "" };
  }

  private buildFrame(
    context: Context,
    purpose: "grant" | "revocation",
    sourceIds: string[],
    ordinal: number,
    prevMac: string,
    body: unknown,
  ): { frame: Record<string, unknown> } {
    return {
      frame: {
        schema: 1,
        purpose,
        epoch: context.epoch,
        root_nonce: context.root_nonce,
        policy_id: context.policy.policy_id,
        source_ids: sourceIds,
        ordinal,
        prev_mac: prevMac,
        body,
      },
    };
  }

  private sealFrame(context: Context, frame: Record<string, unknown>): { frame_json: string; mac: string } {
    const frameJson = canonicalSealFrame(frame);
    return { frame_json: frameJson, mac: sealMac(frame, context.key) };
  }

  private insertLog(
    context: Context,
    ordinal: number,
    sealed: { frame_json: string; mac: string },
    head: { ordinal: number; mac: string },
    snapshot: Snapshot,
  ): void {
    const db = this.db();
    const inserted = db
      .prepare("INSERT INTO control_billing_log(epoch,ordinal,frame_json,mac) VALUES(?,?,?,?)")
      .run(context.epoch, ordinal, sealed.frame_json, sealed.mac);
    if (Number(inserted.changes) !== 1) throw unavailable("The billing journal entry was not created.");
    const updated = db
      .prepare("UPDATE control_billing_head SET epoch=?,ordinal=?,mac=? WHERE singleton=1 AND ordinal=? AND mac=?")
      .run(context.epoch, ordinal, sealed.mac, head.ordinal, head.mac);
    if (Number(updated.changes) !== 1) throw unavailable("The billing head update was not applied.");
    const readback = db.prepare("SELECT epoch,ordinal,mac FROM control_billing_head").get() as unknown as { epoch: number; ordinal: number; mac: string } | undefined;
    if (!readback || readback.epoch !== context.epoch || readback.ordinal !== ordinal || readback.mac !== sealed.mac)
      throw unavailable("The billing head read-back failed.");
    const logRow = db.prepare("SELECT frame_json,mac FROM control_billing_log WHERE epoch=? AND ordinal=?").get(context.epoch, ordinal) as unknown as { frame_json: string; mac: string } | undefined;
    if (!logRow || logRow.frame_json !== sealed.frame_json || logRow.mac !== sealed.mac)
      throw unavailable("The billing journal entry read-back failed.");
    snapshot.head = { ordinal, mac: sealed.mac };
    snapshot.frames.push({ ordinal, frame: JSON.parse(sealed.frame_json), mac: sealed.mac });
  }

  private insertTerm(term: string, accountId: string, receiptJson: string, digest: string, epoch: number, ordinal: number, snapshot: Snapshot): void {
    const created = this.clock().toISOString();
    const inserted = this.db()
      .prepare("INSERT INTO control_billing_terms(term_id,account_id,receipt_json,receipt_digest,epoch,journal_ordinal,created_at) VALUES(?,?,?,?,?,?,?)")
      .run(term, accountId, receiptJson, digest, epoch, ordinal, created);
    if (Number(inserted.changes) !== 1) throw unavailable("The billing term was not created.");
    const readback = this.db()
      .prepare("SELECT account_id,receipt_json,receipt_digest,epoch,journal_ordinal,created_at FROM control_billing_terms WHERE term_id=?")
      .get(term) as unknown as { account_id: string; receipt_json: string; receipt_digest: string; epoch: number; journal_ordinal: number; created_at: string } | undefined;
    if (
      !readback ||
      readback.account_id !== accountId ||
      readback.receipt_json !== receiptJson ||
      readback.receipt_digest !== digest ||
      Number(readback.epoch) !== epoch ||
      Number(readback.journal_ordinal) !== ordinal ||
      readback.created_at !== created
    )
      throw unavailable("The billing term read-back failed.");
    void snapshot;
  }

  private insertDenial(digest: string, accountId: string, observationJson: string, epoch: number, ordinal: number): void {
    const inserted = this.db()
      .prepare("INSERT INTO control_billing_denials(observation_digest,account_id,observation_json,epoch,journal_ordinal) VALUES(?,?,?,?,?)")
      .run(digest, accountId, observationJson, epoch, ordinal);
    if (Number(inserted.changes) !== 1) throw unavailable("The billing denial was not recorded.");
    const readback = this.db()
      .prepare("SELECT account_id,observation_json,epoch,journal_ordinal FROM control_billing_denials WHERE observation_digest=?")
      .get(digest) as unknown as { account_id: string; observation_json: string; epoch: number; journal_ordinal: number } | undefined;
    if (!readback || readback.account_id !== accountId || readback.observation_json !== observationJson || Number(readback.epoch) !== epoch || Number(readback.journal_ordinal) !== ordinal)
      throw unavailable("The billing denial read-back failed.");
  }

  private readBackAdverse(accountId: string, expected: number): void {
    const row = this.db().prepare("SELECT adverse_generation FROM control_billing_account WHERE account_id=?").get(accountId) as unknown as { adverse_generation: number } | undefined;
    if (!row || Number(row.adverse_generation) !== expected) throw unavailable("The billing adverse generation read-back failed.");
  }

  private readBackCentral(periodId: string) {
    const row = this.db()
      .prepare("SELECT account_id,starts_at,ends_at,allowance_micro_usd,state FROM managed_account_periods WHERE period_id=?")
      .get(periodId) as unknown as { account_id: string; starts_at: string; ends_at: string; allowance_micro_usd: number; state: string } | undefined;
    if (!row) throw unavailable("The central billing period read-back failed.");
    return row;
  }

  private readBackMapping(windowId: string, periodId: string, term: string, ordinal: number): void {
    const row = this.db()
      .prepare("SELECT period_id,term_id,epoch,journal_ordinal FROM control_billing_period WHERE window_id=?")
      .get(windowId) as unknown as { period_id: string; term_id: string; epoch: number; journal_ordinal: number } | undefined;
    if (!row || row.period_id !== periodId || row.term_id !== term || Number(row.journal_ordinal) !== ordinal)
      throw unavailable("The billing grant mapping read-back failed.");
  }

  private writeFreshness(
    context: Context,
    snapshot: Snapshot,
    term: string,
    receiptDigestValue: string,
    facts: ProviderFacts,
    ordinal: number,
    head: { ordinal: number; mac: string },
  ): void {
    const observation = observationFromFacts(facts, snapshot.account_id, snapshot.binding_digest);
    const projection = observationDigest(observation);
    const revision = (snapshot.freshness?.revision ?? 0) + 1;
    const verified = parseCanonicalUtc(facts.verified_at);
    const termEnd = parseCanonicalUtc(facts.paid_period_end);
    const expires = new Date(Math.min(verified.getTime() + BILLING_FRESHNESS_MAX_MS, termEnd.getTime())).toISOString();
    const frame = {
      schema: 1,
      purpose: "freshness",
      epoch: context.epoch,
      root_nonce: context.root_nonce,
      policy_id: context.policy.policy_id,
      source_ids: [`projection:${projection}`, `receipt:${receiptDigestValue}`, `binding:${snapshot.binding_digest}`],
      ordinal: 0,
      prev_mac: "",
      body: {
        account_id: snapshot.account_id,
        term_id: term,
        verified_at: facts.verified_at,
        expires_at: expires,
        revision,
        adverse_generation: snapshot.adverse,
      },
    };
    const sealed = this.sealFrame(context, frame);
    const upserted = this.db()
      .prepare(
        "INSERT INTO control_billing_freshness(account_id,term_id,observation_json,frame_json,mac,revision,adverse_generation) VALUES(?,?,?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET term_id=excluded.term_id,observation_json=excluded.observation_json,frame_json=excluded.frame_json,mac=excluded.mac,revision=excluded.revision,adverse_generation=excluded.adverse_generation",
      )
      .run(snapshot.account_id, term, canonical(observation), sealed.frame_json, sealed.mac, revision, snapshot.adverse);
    if (Number(upserted.changes) !== 1) throw unavailable("The billing freshness was not written.");
    const readback = this.db()
      .prepare("SELECT term_id,observation_json,frame_json,mac,revision,adverse_generation FROM control_billing_freshness WHERE account_id=?")
      .get(snapshot.account_id) as unknown as { term_id: string; observation_json: string; frame_json: string; mac: string; revision: number; adverse_generation: number } | undefined;
    if (
      !readback ||
      readback.term_id !== term ||
      readback.observation_json !== canonical(observation) ||
      readback.frame_json !== sealed.frame_json ||
      readback.mac !== sealed.mac ||
      Number(readback.revision) !== revision ||
      Number(readback.adverse_generation) !== snapshot.adverse
    )
      throw unavailable("The billing freshness read-back failed.");
    void ordinal;
    void head;
  }
}
