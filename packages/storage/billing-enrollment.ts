import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { BrainError, canonical } from "../domain/logic.ts";
import {
  enrollmentAnchorDigest,
  validateEnrollmentAnchor,
  type EnrollmentAnchor,
} from "../domain/billing-admission.ts";
import {
  billingOperatorPolicyDigest,
  validateBillingOperatorPolicy,
  type BillingOperatorPolicy,
} from "../domain/billing-policy.ts";
import {
  readManagedAudit,
  validateManagedAudit,
} from "../runtime/managed-audit.ts";
import { assertTrustedManagedRoot } from "../runtime/managed-operator.ts";
import type { ControlStore } from "./control.ts";
import {
  billingKeyCommitment,
  enrollBillingKeyOffline,
} from "./billing-key.ts";
import { verifyBillingMoney5Schema } from "./billing-install.ts";
import { loadBillingContext, loadEnrollmentAnchor } from "./billing-verify.ts";
import { hardenBillingWindowsAcl } from "./billing-windows-acl.ts";
import { enrollAccountIncarnation } from "./managed-incarnation.ts";

/** One-time, offline billing authority enrollment. Never used by server startup. */

const unavailable = (message: string) =>
  new BrainError("UNAVAILABLE", message, 503);
const invalid = (message: string) =>
  new BrainError("INVALID_INPUT", message, 400);

export interface EnrollBillingAuthorityInput {
  control: ControlStore;
  root: string;
  key: Uint8Array;
  policy: unknown;
  audit_id: string;
  offline: true;
  workers_terminated: true;
  clock?: () => Date;
}

export interface BillingEnrollmentResult {
  state: "enrolled" | "already_enrolled";
  mode: "sandbox" | "live";
  policy_digest: string;
  key_commitment: string;
  enrollment_digest: string;
  accounts: number;
  enrolled_at: string;
}

function sha(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function writeProtectedJson(path: string, value: unknown): void {
  const text = canonical(value);
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1)
      throw unavailable(
        "A protected billing artifact is not a regular single-link file.",
      );
    if (readFileSync(path, "utf8") !== text)
      throw unavailable(
        "A different protected billing artifact already exists.",
      );
    return;
  }
  const temp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, text, { flag: "wx", mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

function replaceLegacyMarker(path: string, value: unknown): void {
  const temp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, canonical(value), { flag: "wx", mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

function assertPolicyContext(
  control: ControlStore,
  policy: BillingOperatorPolicy,
  commitment: string,
): void {
  const epoch = control.db
    .prepare("SELECT epoch,nonce FROM managed_control_epoch WHERE singleton=1")
    .get() as { epoch: number; nonce: string } | undefined;
  if (!epoch)
    throw unavailable("The managed control epoch is not initialized.");
  if (
    policy.epoch !== Number(epoch.epoch) ||
    policy.root_nonce !== String(epoch.nonce) ||
    policy.key_commitment !== commitment
  )
    throw invalid(
      "The billing policy does not match the managed root and key.",
    );
  const service = control.db
    .prepare(
      "SELECT daily_micro_usd FROM managed_service_policy WHERE service='managed-processing'",
    )
    .get() as { daily_micro_usd: number } | undefined;
  if (
    !service ||
    Number(service.daily_micro_usd) !== policy.service_daily_micro_usd
  )
    throw invalid(
      "The billing policy service cap does not match the installed control policy.",
    );
}

function currentEnrollmentResult(
  control: ControlStore,
  root: string,
): BillingEnrollmentResult | undefined {
  const view = loadEnrollmentAnchor(control, root);
  if (!view) return undefined;
  const row = control.db
    .prepare(
      "SELECT enrolled_at FROM control_billing_enrollment WHERE singleton=1",
    )
    .get() as { enrolled_at: string } | undefined;
  if (!row) return undefined;
  return {
    state: "already_enrolled",
    mode: view.anchor.mode,
    policy_digest: view.anchor.policy_digest,
    key_commitment: view.anchor.key_commitment,
    enrollment_digest: view.enrollment_digest,
    accounts: view.anchor.accounts.length,
    enrolled_at: row.enrolled_at,
  };
}

function backfillIncarnations(
  control: ControlStore,
  root: string,
  now: string,
): void {
  const accounts = control.db
    .prepare("SELECT id,issuer,subject FROM managed_accounts ORDER BY id")
    .all() as { id: string; issuer: string; subject: string }[];
  for (const account of accounts) {
    const markerPath = join(root, account.id, "provisioned.json");
    const stat = lstatSync(markerPath);
    if (stat.isSymbolicLink() || !stat.isFile())
      throw unavailable("A managed tenant marker is not a regular file.");
    let marker: Record<string, unknown>;
    try {
      marker = JSON.parse(readFileSync(markerPath, "utf8")) as Record<
        string,
        unknown
      >;
    } catch {
      throw unavailable("A managed tenant marker is unreadable.");
    }
    if (
      marker.account_id !== account.id ||
      marker.issuer !== account.issuer ||
      (marker.schema !== 1 && marker.schema !== 2)
    )
      throw unavailable("A managed tenant marker does not match its account.");

    control.db.exec("BEGIN IMMEDIATE");
    let incarnation;
    try {
      incarnation = enrollAccountIncarnation(control.db, {
        account_id: account.id,
        issuer: account.issuer,
        subject: account.subject,
        now,
        nonce: randomBytes(32).toString("hex"),
      });
      control.db.exec("COMMIT");
    } catch (error) {
      if (control.db.isTransaction) control.db.exec("ROLLBACK");
      throw error;
    }
    if (marker.schema === 2) {
      if (
        marker.subject !== account.subject ||
        marker.incarnation !== incarnation.incarnation ||
        Number(marker.provisioning_generation) !==
          incarnation.provisioning_generation
      )
        throw unavailable(
          "A managed tenant marker conflicts with its enrollment generation.",
        );
      continue;
    }
    replaceLegacyMarker(markerPath, {
      schema: 2,
      account_id: account.id,
      issuer: account.issuer,
      subject: account.subject,
      incarnation: incarnation.incarnation,
      provisioning_generation: incarnation.provisioning_generation,
    });
  }
}

export function enrollBillingAuthorityOffline(
  input: EnrollBillingAuthorityInput,
): BillingEnrollmentResult {
  if (input.offline !== true || input.workers_terminated !== true)
    throw invalid(
      "Billing enrollment requires offline and workers-terminated acknowledgements.",
    );
  if (!(input.key instanceof Uint8Array) || input.key.length !== 32)
    throw invalid("Billing enrollment requires exactly 32 key bytes.");
  if (!input.control?.db || input.control.db.isTransaction)
    throw invalid("Billing enrollment requires an idle control store.");
  assertTrustedManagedRoot(input.root, input.control.path);
  verifyBillingMoney5Schema(input.control.db);

  try {
    const existing = currentEnrollmentResult(input.control, input.root);
    if (existing) return existing;
  } catch {
    // A partial/mismatched enrollment must never be treated as an idempotent replay.
    const row = input.control.db
      .prepare(
        "SELECT 1 AS present FROM control_billing_enrollment WHERE singleton=1",
      )
      .get();
    if (row)
      throw unavailable("The existing billing enrollment is inconsistent.");
  }

  const key = Uint8Array.from(input.key);
  const commitment = billingKeyCommitment(key);
  const policy = validateBillingOperatorPolicy(input.policy);
  const policyDigest = billingOperatorPolicyDigest(policy);
  assertPolicyContext(input.control, policy, commitment);

  enrollBillingKeyOffline(input.root, key, {
    offline: true,
    workers_terminated: true,
    expected_commitment: commitment,
  });
  const protectedDir = join(input.root, ".protected");
  writeProtectedJson(join(protectedDir, "billing-policy.json"), policy);

  const backfillAt = (input.clock ?? (() => new Date()))().toISOString();
  backfillIncarnations(input.control, input.root, backfillAt);

  const validation = validateManagedAudit({
    control: input.control,
    root: input.root,
    auditId: input.audit_id,
  });
  if (!validation.valid)
    throw unavailable(
      `The enrollment audit is not current (${validation.reason ?? "denied"}).`,
    );
  const audit = readManagedAudit(input.control, input.audit_id);
  if (!audit) throw unavailable("The enrollment audit is unavailable.");
  const accounts = audit.accounts
    .map((account) => ({
      account_id: account.account_id,
      config_digest: account.config_digest,
      baseline_digest: account.baseline_digest,
    }))
    .sort((a, b) => a.account_id.localeCompare(b.account_id));
  const anchor: EnrollmentAnchor = validateEnrollmentAnchor({
    schema: 1,
    policy_digest: policyDigest,
    key_commitment: commitment,
    mode: policy.mode,
    epoch: audit.epoch,
    root_nonce: audit.root_nonce,
    baseline_digest: audit.baseline_digest,
    roster_digest: sha(accounts),
    accounts,
  });
  const enrollmentDigest = enrollmentAnchorDigest(anchor);
  writeProtectedJson(join(protectedDir, "billing-enrollment.json"), anchor);
  if (process.platform === "win32") {
    hardenBillingWindowsAcl(input.root);
  }

  // Revalidate immediately before the one short publishing transaction. The
  // explicit offline contract is required, but never treated as proof by itself.
  const finalValidation = validateManagedAudit({
    control: input.control,
    root: input.root,
    auditId: input.audit_id,
  });
  if (!finalValidation.valid)
    throw unavailable("The enrollment baseline changed before publication.");

  const enrolledAt = (input.clock ?? (() => new Date()))().toISOString();
  input.control.db.exec("BEGIN IMMEDIATE");
  try {
    const existingPolicy = input.control.db
      .prepare(
        "SELECT policy_json,policy_digest FROM control_billing_policy WHERE singleton=1",
      )
      .get() as { policy_json: string; policy_digest: string } | undefined;
    if (
      existingPolicy &&
      (existingPolicy.policy_json !== canonical(policy) ||
        existingPolicy.policy_digest !== policyDigest)
    )
      throw unavailable("A different billing policy is already installed.");
    if (!existingPolicy)
      input.control.db
        .prepare(
          "INSERT INTO control_billing_policy(singleton,policy_json,policy_digest) VALUES(1,?,?)",
        )
        .run(canonical(policy), policyDigest);

    for (const account of accounts)
      input.control.db
        .prepare(
          "INSERT INTO control_billing_manual_baseline(account_id,config_digest,baseline_digest,captured_at) VALUES(?,?,?,?)",
        )
        .run(
          account.account_id,
          account.config_digest,
          account.baseline_digest,
          enrolledAt,
        );
    input.control.db
      .prepare(
        `INSERT INTO control_billing_enrollment(
          singleton,schema,version,epoch,root_nonce,policy_digest,key_commitment,mode,
          baseline_digest,roster_digest,enrollment_digest,enrolled_at)
         VALUES(1,1,1,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        anchor.epoch,
        anchor.root_nonce,
        anchor.policy_digest,
        anchor.key_commitment,
        anchor.mode,
        anchor.baseline_digest,
        anchor.roster_digest,
        enrollmentDigest,
        enrolledAt,
      );
    input.control.db.exec("COMMIT");
  } catch (error) {
    if (input.control.db.isTransaction) input.control.db.exec("ROLLBACK");
    throw error;
  } finally {
    key.fill(0);
  }

  const verified = loadEnrollmentAnchor(input.control, input.root);
  if (!verified || verified.enrollment_digest !== enrollmentDigest)
    throw unavailable(
      "The billing enrollment could not be verified after publication.",
    );
  loadBillingContext(input.control, input.root);
  return {
    state: "enrolled",
    mode: anchor.mode,
    policy_digest: policyDigest,
    key_commitment: commitment,
    enrollment_digest: enrollmentDigest,
    accounts: accounts.length,
    enrolled_at: enrolledAt,
  };
}
