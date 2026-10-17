import { afterEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedRuntime } from "../../packages/runtime/managed.ts";
import {
  managedMoneySchemaVersion,
  ManagedSpendingStore,
} from "../../packages/storage/managed-spending.ts";
import { readActivationRow } from "../../packages/storage/managed-activation-state.ts";
import {
  decisionActivationMirrorPath,
  ManagedDecisionActivationStore,
  readDecisionActivationRow,
} from "../../packages/storage/managed-decision-activation.ts";
import {
  canonicalDecisionEndpoint,
  DECISION_ACTIVATION_SCHEMA_VERSION,
  decisionActivationFingerprint,
  decisionProfileConfigDigest,
  validateDecisionActivationProfile,
  validateDecisionOperatorInput,
} from "../../packages/domain/managed-decision-activation.ts";
import { ManagedReconciliationStore } from "../../packages/storage/managed-reconciliation.ts";
import { auditManagedHistory } from "../../packages/runtime/managed-audit.ts";

const ISSUER = "https://issuer.synthetic.test";
const ACK = { offline: true as const, workers_terminated: true as const };
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function operator(over: Record<string, unknown> = {}) {
  return {
    provider: "typesafe",
    model: "jev-synthetic-v1",
    accepted_response_models: ["jev-synthetic-return-v2", "jev-synthetic-v1"],
    endpoint: "https://api.typesafe.ai/v1/systemone",
    price_version: "synthetic-decision-price-v1",
    input_micro_usd_per_million: 1000,
    output_micro_usd_per_million: 0,
    timeout_ms: 1000,
    max_request_bytes: 1_048_576,
    max_response_bytes: 262_144,
    ...over,
  };
}

const AUDIT_ID = "00000000-0000-4000-8000-000000000000";
function operatorInput(over: Record<string, unknown> = {}) {
  return { ...operator(), audit_id: AUDIT_ID, expected_version: 0, ...over };
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bibrain-decision-activation-")));
  roots.push(root);
  const runtime = new ManagedRuntime(root);
  const account = runtime.provision(ISSUER, "decision-account");
  const money = new ManagedSpendingStore(runtime.control);
  money.setServicePolicy({ daily_micro_usd: 100_000 });
  money.setAccountPolicy({ account_id: account.id, per_job_micro_usd: 10_000, user_daily_micro_usd: 100_000 });
  money.configureAccountPeriod({
    account_id: account.id,
    starts_at: "2026-01-01T00:00:00Z",
    ends_at: "2030-01-01T00:00:00Z",
    allowance_micro_usd: 1_000_000,
  });
  new ManagedReconciliationStore(runtime.control, root).initEpoch(ACK);
  const audit = auditManagedHistory({ runtime, root, ...ACK });
  return {
    root,
    runtime,
    account,
    audit,
    store: new ManagedDecisionActivationStore(runtime.control, root),
    close() {
      runtime.close();
    },
  };
}

it("is on schema 4 and starts with an absent decision profile", () => {
  expect(managedMoneySchemaVersion).toBe(4);
  const f = fixture();
  try {
    expect(f.store.read()).toBeUndefined();
    expect(readDecisionActivationRow(f.runtime.control.db)).toBeUndefined();
    expect(readActivationRow(f.runtime.control.db)).toBeUndefined(); // reasoning absent too
  } finally {
    f.close();
  }
});

it("validates the closed decision profile and recomputes both digests", () => {
  const base = {
    schema: DECISION_ACTIVATION_SCHEMA_VERSION,
    version: 1,
    enabled: true,
    ...operator(),
    request_overhead_bytes: 1024,
    endpoint_digest: "",
    config_digest: "",
    audit_digest: "a".repeat(64),
    audit_id: "00000000-0000-4000-8000-000000000000",
    epoch: 1,
    root_nonce: "b".repeat(64),
    fingerprint: "",
    updated_at: "2026-10-17T09:00:00.000Z",
  } as never as Parameters<typeof decisionProfileConfigDigest>[0];
  (base as { endpoint_digest: string }).endpoint_digest = canonicalDecisionEndpoint(
    (base as { provider: "typesafe" }).provider,
    (base as { model: string }).model,
    (base as { endpoint: string }).endpoint,
  ).endpoint_digest;
  (base as { config_digest: string }).config_digest = decisionProfileConfigDigest(base);
  (base as { fingerprint: string }).fingerprint = decisionActivationFingerprint(base);
  const profile = validateDecisionActivationProfile(base);
  expect(profile.output_micro_usd_per_million).toBe(0);
  expect(() => validateDecisionActivationProfile({ ...profile, fingerprint: "c".repeat(64) })).toThrow();
  expect(() => validateDecisionActivationProfile({ ...profile, output_micro_usd_per_million: 1 })).toThrow();
  expect(() => validateDecisionActivationProfile({ ...profile, endpoint: "http://127.0.0.1/v1/systemone" })).toThrow();
  expect(() => validateDecisionActivationProfile({ ...profile, endpoint: "https://api.typesafe.ai/v1/systemone?x=1" })).toThrow();
  expect(() => validateDecisionActivationProfile({ ...profile, key: "SYNTHETIC" })).toThrow();
});

it("accepts a strict operator input and rejects widened fields or a bad Cloudflare selector", () => {
  expect(validateDecisionOperatorInput(operatorInput())).toMatchObject({ provider: "typesafe", output_micro_usd_per_million: 0 });
  expect(() => validateDecisionOperatorInput({ ...operatorInput(), enabled: true })).toThrow();
  expect(() => validateDecisionOperatorInput({ ...operatorInput(), config_digest: "c".repeat(64) })).toThrow();
  expect(() => validateDecisionOperatorInput({ ...operatorInput(), output_micro_usd_per_million: 1 })).toThrow();
  expect(() =>
    validateDecisionOperatorInput({
      ...operatorInput(),
      provider: "cloudflare",
      model: "clef",
      endpoint: "https://api.cloudflare.com/client/v4/accounts/synthetic/ai/run/@cf/cloudflare/clef-flash",
    }),
  ).toThrow();
});

it("enable requires a fresh valid schema-4 audit and a complete offline acknowledgement", () => {
  const f = fixture();
  try {
    expect(f.audit.ok).toBe(true);
    expect(() => f.store.enable({ ...operator(), audit_id: f.audit.audit_id, expected_version: 0 }, { offline: true, workers_terminated: false } as never)).toThrow();
    const profile = f.store.enable({ ...operator(), audit_id: f.audit.audit_id, expected_version: 0 }, ACK);
    expect(profile).toMatchObject({ enabled: true, version: 1, provider: "typesafe" });
    expect(readDecisionActivationRow(f.runtime.control.db)?.fingerprint).toBe(profile.fingerprint);
    expect(readFileSync(decisionActivationMirrorPath(f.root), "utf8")).toContain(profile.fingerprint);
    // The reasoning profile was never created/enabled by a decision enrollment.
    expect(readActivationRow(f.runtime.control.db)).toBeUndefined();
    // Create-once: a second enable with expected_version 0 fails.
    expect(() => f.store.enable({ ...operator(), audit_id: f.audit.audit_id, expected_version: 0 }, ACK)).toThrow();
  } finally {
    f.close();
  }
});

it("denies a tampered mirror and a stale expected version on disable, never re-enabling", () => {
  const f = fixture();
  try {
    const profile = f.store.enable({ ...operator(), audit_id: f.audit.audit_id, expected_version: 0 }, ACK);
    const mirror = readFileSync(decisionActivationMirrorPath(f.root), "utf8");
    const tampered = JSON.parse(mirror);
    tampered.model = "MUTATED";
    writeFileSync(decisionActivationMirrorPath(f.root), JSON.stringify(tampered));
    expect(f.store.readState().state).toBe("mismatch");
    writeFileSync(decisionActivationMirrorPath(f.root), mirror);
    expect(f.store.readState().state).toBe("active");
    expect(f.store.disable(profile.version)).toMatchObject({ disabled: true, version: 2 });
    expect(() => f.store.disable(profile.version)).toThrow();
    expect(f.store.read()?.enabled).toBe(false);
  } finally {
    f.close();
  }
});

function runCli(root: string, args: string[]) {
  try {
    const stdout = execFileSync(
      process.execPath,
      ["--import", "tsx", "scripts/managed-decision-activation.ts", ...args],
      { cwd: process.cwd(), env: { ...process.env, BRAIN_MANAGED_ROOT: root }, encoding: "utf8" },
    );
    return { status: 0, stdout, stderr: "" };
  } catch (error: any) {
    return { status: error.status ?? 1, stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? "") };
  }
}

it("the decision CLI status is read-only and enable requires --offline/--workers-terminated", () => {
  const f = fixture();
  try {
    const status = runCli(f.root, ["status"]);
    expect(status.status).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ profile: "absent" });
    expect(runCli(f.root, ["enable", "missing.json"]).status).not.toBe(0);
  } finally {
    f.close();
  }
});

it("rejects a positive disable on an absent profile without creating a row or mirror", () => {
  const f = fixture();
  try {
    expect(() => f.store.disable(9)).toThrow();
    expect(readDecisionActivationRow(f.runtime.control.db)).toBeUndefined();
    expect(existsSync(decisionActivationMirrorPath(f.root))).toBe(false);
    expect(f.store.disable(0)).toMatchObject({ disabled: true, version: 0 });
    expect(readDecisionActivationRow(f.runtime.control.db)).toBeUndefined();
  } finally {
    f.close();
  }
});
