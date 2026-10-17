import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStore } from "../../packages/storage/control.ts";
import { ManagedReconciliationStore } from "../../packages/storage/managed-reconciliation.ts";
import { enrollBillingKeyOffline } from "../../packages/storage/billing-key.ts";
import { ManagedRuntime } from "../../packages/runtime/managed.ts";
import { installBillingMoney5 } from "../../packages/storage/billing-install.ts";
import { ManagedSpendingStore } from "../../packages/storage/managed-spending.ts";
import { BillingAuthority } from "../../packages/storage/billing-authority.ts";
import { canonical } from "../../packages/domain/logic.ts";
import {
  validateBillingOperatorPolicy,
  type BillingOperatorPolicy,
} from "../../packages/domain/billing-policy.ts";
import {
  identityDigest,
  type ProviderFacts,
  type ServerOwnedBinding,
} from "../../packages/domain/billing-evidence.ts";
import type {
  AdmissionDecision,
  BillingCorrelationSource,
  EnrollmentAnchor,
  ServerBillingCorrelation,
} from "../../packages/domain/billing-admission.ts";
import {
  enrollmentAnchorDigest,
  validateEnrollmentAnchor,
} from "../../packages/domain/billing-admission.ts";
import type { EvidenceSource } from "../../packages/domain/billing-evidence.ts";
import {
  MANAGED_V4_MONEY_DDL,
  moneyBytesDigest,
} from "./managed-v4-fixture.ts";

/**
 * SYNTHETIC billing-admission fixture (test-only). Disposable temp root; no owner
 * data, real key, provider or network. It builds a genuine v4 database, installs the
 * explicit non-funding v5 schema, initializes the epoch, enrolls a synthetic key and
 * policy artifact, provisions one tenant and builds the writer with a synthetic
 * correlation source. It exposes only owned ids and the fixture's own prepare/admit
 * helpers — there is no public grant sealer and no production enrollment bypass.
 */

const APPROVED_BASE = "C:/Users/Gowrishankar/AppData/Local/Temp/opencode";
const ACK = { offline: true as const, workers_terminated: true as const };
const DEFAULT_NOW = "2027-01-31T12:00:00.000Z";
const ISSUER = "https://synthetic.invalid";

function fixtureBase(): string {
  if (process.platform !== "win32") return tmpdir();
  if (!existsSync(APPROVED_BASE)) throw new Error("The approved Windows fixture base is missing.");
  return APPROVED_BASE;
}

export function syntheticPolicy(over: { epoch: number; root_nonce: string; key_commitment: string; mode?: "sandbox" | "live"; }): BillingOperatorPolicy {
  return validateBillingOperatorPolicy({
    schema: 1,
    policy_id: "SYNTHETIC-policy",
    version: 1,
    mode: over.mode ?? "sandbox",
    epoch: over.epoch,
    root_nonce: over.root_nonce,
    key_commitment: over.key_commitment,
    service_daily_micro_usd: 10_000,
    catalog: [
      { cadence: "monthly", product_ref: "SYNTHETIC-product", price_ref: "SYNTHETIC-price-monthly", allowance_micro_usd: 1_000, per_job_micro_usd: 100, user_daily_micro_usd: 500 },
      { cadence: "annual", product_ref: "SYNTHETIC-product", price_ref: "SYNTHETIC-price-annual", allowance_micro_usd: 1_000, per_job_micro_usd: 100, user_daily_micro_usd: 500 },
    ],
  });
}

export function syntheticFacts(binding: ServerOwnedBinding, now: string, over: Partial<ProviderFacts> = {}): ProviderFacts {
  return {
    transaction_ref: binding.initial_transaction_ref,
    subscription_ref: binding.subscription_ref,
    customer_ref: binding.customer_ref,
    product_ref: binding.product_ref,
    price_ref: binding.price_ref,
    cadence: binding.cadence,
    completed_payment: true,
    current_state: "active",
    paid_period_start: "2027-01-31T00:00:00.000Z",
    paid_period_end: binding.cadence === "annual" ? "2028-01-31T00:00:00.000Z" : "2027-02-28T00:00:00.000Z",
    verified_at: now,
    ...over,
  };
}

export interface BillingAdmissionFixture {
  root: string;
  dir: string;
  runtime: ManagedRuntime;
  control: ControlStore;
  authority: BillingAuthority;
  spending: ManagedSpendingStore;
  account_id: string;
  binding: ServerOwnedBinding;
  correlation: ServerBillingCorrelation;
  key: Uint8Array;
  policy: BillingOperatorPolicy;
  facts: ProviderFacts;
  setNow(iso: string): void;
  setFacts(facts: ProviderFacts): void;
  prepare(): Promise<AdmissionDecision>;
  admit(preflightId: string): AdmissionDecision;
  moneyDigest(): string;
  close(): void;
}

export function createBillingAdmissionFixture(input: {
  cadence?: "monthly" | "annual";
  now?: string;
  correlation?: BillingCorrelationSource | null;
  source?: EvidenceSource | null;
  enrolled?: boolean;
} = {}): BillingAdmissionFixture {
  const now = input.now ?? DEFAULT_NOW;
  const cadence = input.cadence ?? "monthly";
  const dir = mkdtempSync(join(fixtureBase(), "billing-admission-"));
  const root = join(dir, "managed");
  mkdirSync(root, { mode: 0o700 });

  let clockIso = now;
  const clock = () => new Date(clockIso);

  const runtime = new ManagedRuntime(root, { clock });
  const control = runtime.control;
  control.db.exec("CREATE TABLE IF NOT EXISTS managed_money_schema(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);");
  control.db.exec(MANAGED_V4_MONEY_DDL);
  control.db.prepare("INSERT INTO managed_money_schema VALUES(4,?)").run(now);
  installBillingMoney5({ control, root, ...ACK });

  const reconciliation = new ManagedReconciliationStore(control, root, clock);
  const epoch = reconciliation.initEpoch(ACK);

  const key = Uint8Array.from({ length: 32 }, (_v, i) => (i * 7 + 1) % 256);
  const commitment = createHash("sha256").update(Buffer.from(key)).digest("hex");
  enrollBillingKeyOffline(root, key, { ...ACK, expected_commitment: commitment });

  const policy = syntheticPolicy({ epoch: epoch.epoch, root_nonce: epoch.nonce, key_commitment: commitment });
  control.db.prepare("INSERT INTO managed_service_policy(service,daily_micro_usd,version,updated_at) VALUES('managed-processing',?,1,?)").run(policy.service_daily_micro_usd, now);
  control.db.prepare("INSERT INTO control_billing_policy(singleton,policy_json,policy_digest) VALUES(1,?,?)").run(canonical(policy), createHash("sha256").update(canonical(policy)).digest("hex"));
  const policyFile = join(root, ".protected", "billing-policy.json");
  writeFileSync(policyFile, canonical(policy), { mode: 0o600 });
  try {
    chmodSync(policyFile, 0o600);
  } catch {
    /* Windows modes are not ACL verification */
  }

  if (input.enrolled) {
    const policyDigest = createHash("sha256").update(canonical(policy)).digest("hex");
    const accounts: Array<{ account_id: string; config_digest: string; baseline_digest: string }> = [];
    const anchor: EnrollmentAnchor = validateEnrollmentAnchor({
      schema: 1,
      policy_digest: policyDigest,
      key_commitment: commitment,
      mode: policy.mode,
      epoch: epoch.epoch,
      root_nonce: epoch.nonce,
      baseline_digest: createHash("sha256").update(canonical(accounts.map((a) => a.baseline_digest))).digest("hex"),
      roster_digest: createHash("sha256").update(canonical(accounts)).digest("hex"),
      accounts,
    });
    const enrollmentFile = join(root, ".protected", "billing-enrollment.json");
    writeFileSync(enrollmentFile, canonical(anchor), { mode: 0o600 });
    try {
      chmodSync(enrollmentFile, 0o600);
    } catch {
      /* Windows modes are not ACL verification */
    }
    control.db
      .prepare(
        "INSERT INTO control_billing_enrollment(singleton,schema,version,epoch,root_nonce,policy_digest,key_commitment,mode,baseline_digest,roster_digest,enrollment_digest,enrolled_at) VALUES(1,1,1,?,?,?,?,?,?,?,?,?)",
      )
      .run(epoch.epoch, epoch.nonce, policyDigest, commitment, policy.mode, anchor.baseline_digest, anchor.roster_digest, enrollmentAnchorDigest(anchor), now);
  }

  const account = runtime.provision(ISSUER, `SYNTHETIC-owner-${randomUUID()}`);
  control.db.prepare("INSERT INTO managed_account_policy(account_id,per_job_micro_usd,user_daily_micro_usd,accounting_tz,version,updated_at) VALUES(?,?,?,NULL,1,?)").run(account.id, 100, 500, now);

  const incarnation = control.db
    .prepare("SELECT incarnation,provisioning_generation FROM managed_account_incarnation WHERE account_id=?")
    .get(account.id) as { incarnation: string; provisioning_generation: number };
  const identity = identityDigest({ account_id: account.id, issuer: account.issuer, subject: account.subject });
  const binding: ServerOwnedBinding = {
    schema: 1,
    account_id: account.id,
    identity_digest: identity,
    tenant_incarnation: incarnation.incarnation,
    provisioning_generation: incarnation.provisioning_generation,
    mode: policy.mode,
    product_ref: "SYNTHETIC-product",
    price_ref: cadence === "annual" ? "SYNTHETIC-price-annual" : "SYNTHETIC-price-monthly",
    cadence,
    customer_ref: `SYNTHETIC-customer-${randomUUID()}`,
    subscription_ref: `SYNTHETIC-subscription-${randomUUID()}`,
    initial_transaction_ref: `SYNTHETIC-transaction-${randomUUID()}`,
    correlation_ref: `SYNTHETIC-correlation-${randomUUID()}`,
    version: 1,
  };
  const correlation: ServerBillingCorrelation = {
    schema: 1,
    mode: binding.mode,
    product_ref: binding.product_ref,
    price_ref: binding.price_ref,
    cadence: binding.cadence,
    customer_ref: binding.customer_ref,
    subscription_ref: binding.subscription_ref,
    initial_transaction_ref: binding.initial_transaction_ref,
    correlation_ref: binding.correlation_ref,
    version: binding.version,
  };
  const defaultCorrelation: BillingCorrelationSource = { resolve: async () => correlation };
  const correlationSource = input.correlation === undefined ? defaultCorrelation : input.correlation;

  let facts = syntheticFacts(binding, now);
  const defaultSource: EvidenceSource = { read: async () => facts };
  const source = input.source === undefined ? defaultSource : input.source;
  const authority = new BillingAuthority({ control, root, clock, source, correlation: correlationSource });
  const spending = new ManagedSpendingStore(control, clock);

  return {
    root,
    dir,
    runtime,
    control,
    authority,
    spending,
    account_id: account.id,
    binding,
    correlation,
    key,
    policy,
    get facts() {
      return facts;
    },
    setNow(iso: string) {
      clockIso = iso;
    },
    setFacts(next: ProviderFacts) {
      facts = next;
    },
    prepare() {
      return authority.beginAdmission(account.id);
    },
    admit(preflightId: string) {
      return authority.admitAccount({ account_id: account.id, preflight_id: preflightId });
    },
    moneyDigest() {
      return moneyBytesDigest(control.db);
    },
    close() {
      try {
        runtime.close();
      } catch {
        /* the runtime may already be closed */
      } finally {
        rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
      }
    },
  };
}
