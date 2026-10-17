import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStore } from "../../packages/storage/control.ts";
import { ManagedReconciliationStore } from "../../packages/storage/managed-reconciliation.ts";
import { enrollBillingKeyOffline } from "../../packages/storage/billing-key.ts";
import { BILLING_AUTHORITY_DDL } from "../../packages/storage/billing-schema.ts";
import { BillingAuthority } from "../../packages/storage/billing-authority.ts";
import { canonical } from "../../packages/domain/logic.ts";
import { canonicalSealFrame, sealMac } from "../../packages/domain/billing-seal.ts";
import { validateBillingOperatorPolicy, type BillingOperatorPolicy } from "../../packages/domain/billing-policy.ts";
import {
  bindingDigest,
  identityDigest,
  type EvidenceSource,
  type ProviderFacts,
  type ServerOwnedBinding,
} from "../../packages/domain/billing-evidence.ts";
import { MANAGED_V4_MONEY_DDL } from "./managed-v4-fixture.ts";

/**
 * SYNTHETIC billing-authority fixture. Disposable temp root only; no owner data, no real
 * key, no provider, no network. It installs the full authority DDL and seeds a signed
 * admission as test history through the same trusted composition the writer uses — it is
 * NOT a public production enrollment or grant method.
 */

const APPROVED_BASE = "C:/Users/Gowrishankar/AppData/Local/Temp/opencode";
const ACK = { offline: true as const, workers_terminated: true as const };
const DEFAULT_NOW = "2027-01-31T12:00:00.000Z";
const INCARNATION = "c".repeat(64);
const CLEAN_BASELINE = "d".repeat(64);
const ISSUER = "https://synthetic.invalid";

function fixtureBase(): string {
  if (process.platform !== "win32") return tmpdir();
  if (!existsSync(APPROVED_BASE)) throw new Error("The approved Windows fixture base is missing.");
  return APPROVED_BASE;
}

export function syntheticPolicy(over: {
  mode?: "sandbox" | "live";
  epoch?: number;
  root_nonce?: string;
  product_ref?: string;
  monthly_price_ref?: string;
  annual_price_ref?: string;
  allowance_micro_usd?: number;
  per_job_micro_usd?: number;
  user_daily_micro_usd?: number;
  service_daily_micro_usd?: number;
  key_commitment?: string;
} = {}): BillingOperatorPolicy {
  return validateBillingOperatorPolicy({
    schema: 1,
    policy_id: "SYNTHETIC-policy",
    version: 1,
    mode: over.mode ?? "sandbox",
    epoch: over.epoch ?? 1,
    root_nonce: over.root_nonce ?? "a".repeat(64),
    key_commitment: over.key_commitment ?? "b".repeat(64),
    service_daily_micro_usd: over.service_daily_micro_usd ?? 10_000,
    catalog: [
      {
        cadence: "monthly",
        product_ref: over.product_ref ?? "SYNTHETIC-product",
        price_ref: over.monthly_price_ref ?? "SYNTHETIC-price-monthly",
        allowance_micro_usd: over.allowance_micro_usd ?? 1_000,
        per_job_micro_usd: over.per_job_micro_usd ?? 100,
        user_daily_micro_usd: over.user_daily_micro_usd ?? 500,
      },
      {
        cadence: "annual",
        product_ref: over.product_ref ?? "SYNTHETIC-product",
        price_ref: over.annual_price_ref ?? "SYNTHETIC-price-annual",
        allowance_micro_usd: over.allowance_micro_usd ?? 1_000,
        per_job_micro_usd: over.per_job_micro_usd ?? 100,
        user_daily_micro_usd: over.user_daily_micro_usd ?? 500,
      },
    ],
  });
}

export function syntheticProviderFacts(
  binding: ServerOwnedBinding,
  now: string,
  over: Partial<ProviderFacts> = {},
): ProviderFacts {
  return {
    transaction_ref: binding.initial_transaction_ref,
    subscription_ref: binding.subscription_ref,
    customer_ref: binding.customer_ref,
    product_ref: binding.product_ref,
    price_ref: binding.price_ref,
    cadence: binding.cadence,
    completed_payment: true,
    current_state: "active",
    paid_period_start: binding.cadence === "annual" ? "2027-01-31T00:00:00.000Z" : "2027-01-31T00:00:00.000Z",
    paid_period_end: binding.cadence === "annual" ? "2028-01-31T00:00:00.000Z" : "2027-02-28T00:00:00.000Z",
    verified_at: now,
    ...over,
  };
}

export interface BillingAuthorityFixture {
  root: string;
  control: ControlStore;
  authority: BillingAuthority;
  account_id: string;
  binding: ServerOwnedBinding;
  policy: BillingOperatorPolicy;
  key: Uint8Array;
  facts: ProviderFacts;
  setNow(iso: string): void;
  setFacts(facts: ProviderFacts): void;
  setSourceError(error: Error | null): void;
  close(): void;
}

export function createBillingAuthorityFixture(input: {
  cadence?: "monthly" | "annual";
  now?: string;
  source?: EvidenceSource | null;
} = {}): BillingAuthorityFixture {
  const now = input.now ?? DEFAULT_NOW;
  const cadence = input.cadence ?? "monthly";
  const dir = mkdtempSync(join(fixtureBase(), "billing-authority-"));
  const root = join(dir, "managed");
  mkdirSync(root, { mode: 0o700 });
  const protectedDir = join(root, ".protected");

  let clockIso = now;
  const clock = () => new Date(clockIso);

  const controlPath = join(root, "control.sqlite");
  const control = new ControlStore(controlPath, clock);
  control.db.exec(MANAGED_V4_MONEY_DDL);
  control.db.exec("CREATE TABLE IF NOT EXISTS managed_money_schema(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);");
  control.db.prepare("INSERT OR IGNORE INTO managed_money_schema(version,applied_at) VALUES(?,?)").run(3, now);
  control.db.prepare("INSERT OR IGNORE INTO managed_money_schema(version,applied_at) VALUES(?,?)").run(4, now);
  control.db.exec(BILLING_AUTHORITY_DDL);

  const reconciliation = new ManagedReconciliationStore(control, root, clock);
  const epoch = reconciliation.initEpoch(ACK);

  const key = Uint8Array.from({ length: 32 }, (_v, i) => (i * 7 + 1) % 256);
  const commitment = createHash("sha256").update(Buffer.from(key)).digest("hex");
  enrollBillingKeyOffline(root, key, { ...ACK, expected_commitment: commitment });

  const policy = syntheticPolicy({ root_nonce: epoch.nonce, epoch: epoch.epoch, key_commitment: commitment });
  control.db
    .prepare("INSERT INTO managed_service_policy(service,daily_micro_usd,version,updated_at) VALUES('managed-processing',?,1,?)")
    .run(policy.service_daily_micro_usd, now);
  control.db
    .prepare("INSERT INTO control_billing_policy(singleton,policy_json,policy_digest) VALUES(1,?,?)")
    .run(canonical(policy), createHash("sha256").update(canonical(policy)).digest("hex"));

  const policyFile = join(protectedDir, "billing-policy.json");
  writeFileSync(policyFile, canonical(policy), { mode: 0o600 });
  try {
    chmodSync(policyFile, 0o600);
  } catch {
    /* Windows modes are not ACL verification */
  }

  const account = control.provision(ISSUER, `SYNTHETIC-owner-${randomUUID()}`);
  control.db
    .prepare("INSERT INTO managed_account_policy(account_id,per_job_micro_usd,user_daily_micro_usd,accounting_tz,version,updated_at) VALUES(?,?,?,NULL,1,?)")
    .run(account.id, 100, 500, now);

  const identity = identityDigest({ account_id: account.id, issuer: account.issuer, subject: account.subject });
  const binding: ServerOwnedBinding = {
    schema: 1,
    account_id: account.id,
    identity_digest: identity,
    tenant_incarnation: INCARNATION,
    provisioning_generation: 1,
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
  const digest = bindingDigest(binding);

  const admission = {
    schema: 1,
    purpose: "admission" as const,
    epoch: epoch.epoch,
    root_nonce: epoch.nonce,
    policy_id: policy.policy_id,
    source_ids: [`binding:${digest}`, `baseline:${CLEAN_BASELINE}`],
    ordinal: 0,
    prev_mac: "",
    body: {
      account_id: account.id,
      identity_digest: identity,
      tenant_incarnation: INCARNATION,
      clean_baseline_proof: CLEAN_BASELINE,
    },
  };
  const admissionMac = sealMac(admission, key);
  control.db
    .prepare("INSERT INTO control_billing_log(epoch,ordinal,frame_json,mac) VALUES(?,?,?,?)")
    .run(epoch.epoch, 0, canonicalSealFrame(admission), admissionMac);
  control.db
    .prepare("INSERT INTO control_billing_head(singleton,epoch,ordinal,mac) VALUES(1,?,?,?)")
    .run(epoch.epoch, 0, admissionMac);
  control.db
    .prepare("INSERT INTO control_billing_account(account_id,binding_json,binding_digest,admission_ordinal,adverse_generation) VALUES(?,?,?,?,?)")
    .run(account.id, canonical(binding), digest, 0, 0);

  let facts = syntheticProviderFacts(binding, now);
  let sourceError: Error | null = null;
  const defaultSource: EvidenceSource = {
    read: async () => {
      if (sourceError) throw sourceError;
      return facts;
    },
  };
  const source = input.source === undefined ? defaultSource : input.source;

  const authority = new BillingAuthority({
    control,
    root,
    clock,
    source,
  });

  return {
    root,
    control,
    authority,
    account_id: account.id,
    binding,
    policy,
    key,
    get facts() {
      return facts;
    },
    setNow(iso: string) {
      clockIso = iso;
    },
    setFacts(next: ProviderFacts) {
      facts = next;
    },
    setSourceError(error: Error | null) {
      sourceError = error;
    },
    close() {
      try {
        control.close();
      } finally {
        rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
      }
    },
  } as BillingAuthorityFixture;
}
