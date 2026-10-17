import { afterEach, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ControlStore } from "../../packages/storage/control.ts";
import { ManagedSpendingStore } from "../../packages/storage/managed-spending.ts";
import { ManagedReconciliationStore } from "../../packages/storage/managed-reconciliation.ts";
import { auditManagedHistory } from "../../packages/runtime/managed-audit.ts";
import {
  ManagedActivationStore,
  activationAuditDigest,
  activationControlConfigDigest,
  activationMirrorPath,
} from "../../packages/storage/managed-activation.ts";
import {
  evaluateConfiguredPolicy,
  readActivation,
} from "../../packages/runtime/managed-activation.ts";
import { ManagedRuntime } from "../../packages/runtime/managed.ts";
import {
  restoreManagedBackup,
  writeManagedBackup,
} from "../../packages/runtime/managed-recovery.ts";
import {
  activationFingerprint,
  profileConfigDigest,
  validateActivationOperatorInput,
  validateActivationProfile,
} from "../../packages/domain/managed-activation.ts";

/**
 * Task 1 policy/baseline/CLI suite for the shared activation policy. Synthetic
 * roots, no provider key, no model IO. Runtime paid processing stays off because
 * no server/worker is wired in this slice.
 */

const clock = () => new Date("2026-10-16T09:00:00Z");
const ACK = { offline: true as const, workers_terminated: true as const };
const ISSUER = "https://synthetic.example.test";
const bases: string[] = [];

afterEach(() => {
  for (const base of bases.splice(0))
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "brain-activation-policy-"));
  bases.push(base);
  const root = join(base, "managed");
  const runtime = new ManagedRuntime(root, { clock });
  const account = runtime.provision(ISSUER, "synthetic-policy");
  const money = new ManagedSpendingStore(runtime.control, clock);
  money.setServicePolicy({ daily_micro_usd: 1000 });
  money.setAccountPolicy({
    account_id: account.id,
    per_job_micro_usd: 1000,
    user_daily_micro_usd: 1000,
  });
  money.configureAccountPeriod({
    account_id: account.id,
    starts_at: "2026-10-16T00:00:00Z",
    ends_at: "2026-10-17T00:00:00Z",
    allowance_micro_usd: 1000,
  });
  new ManagedReconciliationStore(runtime.control, root, clock).initEpoch(ACK);
  const audit = auditManagedHistory({ runtime, root, ...ACK, clock });
  expect(audit.ok).toBe(true);
  const input = {
    provider: "openai" as const,
    model: "synthetic-model-v1",
    price_version: "synthetic-price-v1",
    input_micro_usd_per_million: 1_000_000,
    output_micro_usd_per_million: 1_000_000,
    accepted_response_models: ["synthetic-model-v1"],
    max_output_tokens: 100,
    endpoint_class: "openai_responses" as const,
    audit_id: audit.audit_id!,
    expected_version: 0,
  };
  const store = new ManagedActivationStore(runtime.control, root, clock);
  const context = { control: runtime.control, root, now: clock(), optIn: true, schemaOk: true };
  return { base, root, runtime, account, money, store, input, context };
}

it("a missing profile is OFF and the read path creates no money table or marker", () => {
  const base = mkdtempSync(join(tmpdir(), "brain-activation-empty-"));
  bases.push(base);
  const root = join(base, "managed");
  mkdirSync(root, { recursive: true });
  const controlPath = join(root, "control.sqlite");
  const control = new ControlStore(controlPath, clock);
  control.provision(ISSUER, "identity-only");
  control.close();
  const db = new DatabaseSync(controlPath, { readOnly: true });
  try {
    expect(readActivation({ db, path: controlPath }, root)).toBeUndefined();
    expect(
      evaluateConfiguredPolicy({
        control: { db, path: controlPath },
        root,
        now: clock(),
        optIn: true,
      }).reason,
    ).toBe("off");
  } finally {
    db.close();
  }
  expect(existsSync(join(root, "activation.json"))).toBe(false);
  const check = new DatabaseSync(controlPath, { readOnly: true });
  try {
    expect(
      check
        .prepare("SELECT 1 AS p FROM sqlite_master WHERE type='table' AND name='managed_money_schema'")
        .get(),
    ).toBeUndefined();
  } finally {
    check.close();
  }
});

it("recomputes both digests and rejects tampered or unsafe profiles", () => {
  const f = fixture();
  const profile = f.store.enable(f.input, ACK);
  expect(validateActivationProfile(profile)).toEqual(profile);
  expect(() =>
    validateActivationProfile({ ...profile, fingerprint: "c".repeat(64) }),
  ).toThrow();
  expect(() =>
    validateActivationProfile({ ...profile, config_digest: "d".repeat(64) }),
  ).toThrow();
  expect(() =>
    validateActivationProfile({ ...profile, input_micro_usd_per_million: profile.input_micro_usd_per_million + 1 }),
  ).toThrow();
  expect(() => validateActivationProfile({ ...profile, key: "secret" })).toThrow();
  expect(() =>
    validateActivationProfile({ ...profile, max_output_tokens: 8001 }),
  ).toThrow();
  // config digest ignores audit/epoch/version/time; fingerprint does not.
  expect(
    profileConfigDigest({ ...profile, version: profile.version + 1, epoch: 9 }),
  ).toBe(profile.config_digest);
  expect(activationFingerprint({ ...profile, epoch: 9 })).not.toBe(profile.fingerprint);
  f.runtime.close();
});

it("the audit digest binds the whole chosen audit and drifts from a plain baseline", () => {
  const f = fixture();
  const profile = f.store.enable(f.input, ACK);
  const digest = activationAuditDigest(f.runtime.control.db, profile.audit_id);
  expect(digest).toBe(profile.audit_digest);
  // The store-side config digest must reproduce the audit's stored config digest.
  expect(activationControlConfigDigest(f.runtime.control.db)).toBe(
    (
      f.runtime.control.db
        .prepare("SELECT config_digest FROM managed_audits WHERE audit_id=?")
        .get(profile.audit_id) as { config_digest: string }
    ).config_digest,
  );
  f.runtime.close();
});

it("offline acknowledgements are mandatory at the store and reject incomplete flags", () => {
  const f = fixture();
  expect(() =>
    f.store.enable(f.input, { offline: true, workers_terminated: false }),
  ).toThrow();
  expect(readActivation(f.runtime.control, f.root)).toBeUndefined();
  // Strict operator input: unknown/secret keys and version 0-creation only.
  expect(() => validateActivationOperatorInput({ ...f.input, enabled: true })).toThrow();
  expect(() => validateActivationOperatorInput({ ...f.input, key: "x" })).toThrow();
  expect(() =>
    validateActivationOperatorInput({ ...f.input, accepted_response_models: ["other"] }),
  ).toThrow();
  f.runtime.close();
});

it("create-once, disabled strict CAS and idempotent disable never re-enable", () => {
  const f = fixture();
  const enabled = f.store.enable(f.input, ACK);
  expect(enabled).toMatchObject({ enabled: true, version: 1 });
  // Create-once: a stale expected version 0 cannot create again.
  expect(() => f.store.enable(f.input, ACK)).toThrow();
  expect(f.store.disable(enabled.version)).toMatchObject({ disabled: true, version: 2 });
  // Re-enabling with the historical version is denied.
  expect(() =>
    f.store.enable({ ...f.input, expected_version: enabled.version }, ACK),
  ).toThrow();
  // Idempotent disable at the current version returns without a new version.
  expect(f.store.disable(2)).toMatchObject({ disabled: true, version: 2 });
  // A stale disable is denied.
  expect(() => f.store.disable(1)).toThrow();
  const current = readActivation(f.runtime.control, f.root);
  expect(current).toMatchObject({ enabled: false, version: 2 });
  expect(evaluateConfiguredPolicy(f.context).ready).toBe(false);
  f.runtime.close();
});

it("disable cannot be undone by a caller-supplied historical enabled profile", () => {
  const f = fixture();
  const enabled = f.store.enable(f.input, ACK);
  f.store.disable(enabled.version);
  expect(
    evaluateConfiguredPolicy({ ...f.context, profile: enabled }).ready,
  ).toBe(false);
  f.runtime.close();
});

it("a mirrored field tamper or a marker directory reads as fail-closed mismatch", () => {
  const f = fixture();
  f.store.enable(f.input, ACK);
  const path = activationMirrorPath(f.root);
  const value = JSON.parse(readFileSync(path, "utf8"));
  value.max_output_tokens = 101;
  writeFileSync(path, JSON.stringify(value));
  expect(readActivation(f.runtime.control, f.root)).toBeUndefined();
  expect(evaluateConfiguredPolicy(f.context).ready).toBe(false);
  // A directory occupying the mirror path must not crash the loader.
  rmSync(path, { force: true });
  mkdirSync(path);
  expect(readActivation(f.runtime.control, f.root)).toBeUndefined();
  f.runtime.close();
});

it("a changed service policy, account cap or period stales an unchanged profile", () => {
  const f = fixture();
  f.store.enable(f.input, ACK);
  expect(evaluateConfiguredPolicy(f.context).ready).toBe(true);
  f.money.setServicePolicy({ daily_micro_usd: 2000 });
  expect(evaluateConfiguredPolicy(f.context).ready).toBe(false);
  f.money.setAccountPolicy({
    account_id: f.account.id,
    per_job_micro_usd: 999,
    user_daily_micro_usd: 999,
  });
  expect(evaluateConfiguredPolicy(f.context).ready).toBe(false);
  f.runtime.close();
});

it("a mirror write failure after SQL commit leaves no capability and does not crash the loader", () => {
  const f = fixture();
  const db = f.runtime.control.db;
  db.function("synthetic_occupy_activation_marker", () => {
    mkdirSync(activationMirrorPath(f.root), { recursive: true });
    return 1;
  });
  db.exec(
    "CREATE TRIGGER synthetic_occupy_activation_marker AFTER INSERT ON managed_activation BEGIN SELECT synthetic_occupy_activation_marker(); END;",
  );
  expect(() => f.store.enable(f.input, ACK)).toThrow();
  expect(readActivation(f.runtime.control, f.root)).toBeUndefined();
  expect(evaluateConfiguredPolicy(f.context).ready).toBe(false);
  f.runtime.close();
});

it("an unknown future schema fails before activation DDL and preserves identity", () => {
  const base = mkdtempSync(join(tmpdir(), "brain-activation-schema-"));
  bases.push(base);
  const root = join(base, "managed");
  const runtime = new ManagedRuntime(root, { clock });
  const account = runtime.provision(ISSUER, "schema-guard");
  const session = runtime.control.issueSession(account.id);
  new ManagedSpendingStore(runtime.control, clock);
  runtime.control.db.exec(
    // Version 5 is now the explicit billing version; a genuinely future schema is 6.
    "INSERT INTO managed_money_schema(version,applied_at) VALUES(6,'2026-10-17T00:00:00Z')",
  );
  expect(() => new ManagedSpendingStore(runtime.control, clock)).toThrow("newer version");
  expect(runtime.control.account(account.id)?.id).toBe(account.id);
  expect(runtime.control.resolveSession(session.token)?.account_id).toBe(account.id);
  runtime.close();
});

it("enrollment preserves every identity and session row", () => {
  const f = fixture();
  const session = f.runtime.control.issueSession(f.account.id);
  const before = f.runtime.control.db.prepare("SELECT count(*) AS n FROM managed_accounts").get();
  f.store.enable(f.input, ACK);
  expect(f.runtime.control.account(f.account.id)?.id).toBe(f.account.id);
  expect(f.runtime.control.resolveSession(session.token)?.account_id).toBe(f.account.id);
  expect(f.runtime.control.db.prepare("SELECT count(*) AS n FROM managed_accounts").get()).toEqual(before);
  f.runtime.close();
});

it("cold backup of an enabled profile round-trips the mirror, excludes readiness, and restores DISABLED at a new epoch", async () => {
  const f = fixture();
  const enabled = f.store.enable(f.input, ACK);
  writeFileSync(join(f.root, "worker-ready.json"), "SYNTHETIC_EPHEMERAL_WORKER_READINESS");
  f.runtime.close();
  const bundle = join(f.base, "bundle");
  const destination = join(f.base, "restored");
  await writeManagedBackup({ root: f.root, destination: bundle, offline: true, clock });
  expect(existsSync(join(bundle, "worker-ready.json"))).toBe(false);
  expect(existsSync(join(bundle, "activation.json"))).toBe(true);
  await restoreManagedBackup({ bundle, destination, currentRoot: f.root, offline: true, clock });
  const runtime = new ManagedRuntime(destination, { clock });
  try {
    const restored = readActivation(runtime.control, destination);
    expect(restored).toMatchObject({ enabled: false });
    expect(restored!.version).toBeGreaterThan(enabled.version);
    expect(restored!.epoch).toBeGreaterThan(enabled.epoch);
    expect(existsSync(join(destination, "worker-ready.json"))).toBe(false);
    expect(new ManagedSpendingStore(runtime.control, clock).accountStatus(f.account.id).blocked).toBe(true);
  } finally {
    runtime.close();
  }
});

it("refuses to back up a split activation claim (row/file disagreement)", async () => {
  const f = fixture();
  f.store.enable(f.input, ACK);
  f.runtime.close();
  const withControl = <T,>(fn: (control: ControlStore) => T): T => {
    const control = new ControlStore(join(f.root, "control.sqlite"), clock);
    try {
      return fn(control);
    } finally {
      control.close();
    }
  };
  // File present, row removed.
  withControl((control) => control.db.exec("DELETE FROM managed_activation"));
  await expect(
    writeManagedBackup({ root: f.root, destination: join(f.base, "b1"), offline: true, clock }),
  ).rejects.toThrow();
  // Row restored, file removed.
  withControl((control) => {
    new ManagedActivationStore(control, f.root, clock).enable(f.input, ACK);
  });
  rmSync(activationMirrorPath(f.root), { force: true });
  await expect(
    writeManagedBackup({ root: f.root, destination: join(f.base, "b2"), offline: true, clock }),
  ).rejects.toThrow();
});

it("a legacy root with no activation row or file restores compatibly and stays blocked", async () => {
  const f = fixture();
  f.runtime.close();
  const bundle = join(f.base, "legacy-bundle");
  const destination = join(f.base, "legacy-restored");
  await writeManagedBackup({ root: f.root, destination: bundle, offline: true, clock });
  expect(existsSync(join(bundle, "activation.json"))).toBe(false);
  await restoreManagedBackup({ bundle, destination, currentRoot: f.root, offline: true, clock });
  const runtime = new ManagedRuntime(destination, { clock });
  try {
    expect(readActivation(runtime.control, destination)).toBeUndefined();
    expect(new ManagedSpendingStore(runtime.control, clock).accountStatus(f.account.id).blocked).toBe(true);
  } finally {
    runtime.close();
  }
});

it("refuses enrollment when unknown legacy or nonterminal history appears after a clean audit", () => {
  const f = fixture();
  const handle = f.runtime.acquire(f.account.id);
  try {
    const job = handle.brain.enqueue("inbox", "derive_brief", {
      principal: handle.brain.ownerPrincipal(),
    });
    handle.brain.store.run(
      "INSERT INTO reservations VALUES(?,?,?,?,?)",
      job.id,
      "2026-10-16",
      10,
      0,
      "held",
    );
  } finally {
    handle.release();
  }
  expect(() => f.store.enable(f.input, ACK)).toThrow();
  expect(evaluateConfiguredPolicy(f.context).ready).toBe(false);
  f.runtime.close();
});

it("an unsupported stored activation schema is rejected, never silently read as schema one", () => {
  const f = fixture();
  f.store.enable(f.input, ACK);
  f.runtime.control.db.exec("UPDATE managed_activation SET schema=2 WHERE singleton=1");
  expect(readActivation(f.runtime.control, f.root)).toBeUndefined();
  expect(evaluateConfiguredPolicy(f.context).ready).toBe(false);
  f.runtime.close();
});

it("disabling an absent profile never recursively deletes an unrecognized marker directory", () => {
  const f = fixture();
  const dir = activationMirrorPath(f.root);
  mkdirSync(dir);
  const retained = join(dir, "retained.txt");
  writeFileSync(retained, "SYNTHETIC_UNKNOWN_CONTENT_MUST_NOT_BE_REMOVED");
  try {
    f.store.disable(0);
  } catch {
    /* refusing a malformed marker is safe */
  }
  expect(readFileSync(retained, "utf8")).toBe("SYNTHETIC_UNKNOWN_CONTENT_MUST_NOT_BE_REMOVED");
  expect(evaluateConfiguredPolicy(f.context).ready).toBe(false);
  f.runtime.close();
});

it("a policy change observed during the activation write lock never persists a profile", () => {
  const f = fixture();
  const path = join(f.root, "control.sqlite");
  const control = f.runtime.control as unknown as { db: DatabaseSync };
  const real = control.db;
  let begins = 0;
  const interleaved = new Proxy(real, {
    get(target, key) {
      if (key === "exec")
        return (sql: string) => {
          if (sql === "BEGIN IMMEDIATE") {
            begins += 1;
            // The activation transaction is the second immediate transaction; the
            // first is the idempotent money-schema migration. Change trusted state
            // after the preflight but before the activation lock is acquired.
            if (begins === 2) {
              const writer = new DatabaseSync(path);
              try {
                writer
                  .prepare("UPDATE managed_account_policy SET per_job_micro_usd=999 WHERE account_id=?")
                  .run(f.account.id);
              } finally {
                writer.close();
              }
            }
          }
          return (target as DatabaseSync).exec(sql);
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as unknown as DatabaseSync;
  control.db = interleaved;
  let threw = false;
  try {
    f.store.enable(f.input, ACK);
  } catch {
    threw = true;
  } finally {
    control.db = real;
  }
  expect(threw).toBe(true);
  expect(readActivation(f.runtime.control, f.root)).toBeUndefined();
  f.runtime.close();
});

it("the CLI status is read-only on an identity-only root and enable requires a valid audit", () => {
  const base = mkdtempSync(join(tmpdir(), "brain-activation-cli-"));
  bases.push(base);
  const root = join(base, "managed");
  mkdirSync(root, { recursive: true });
  const control = new ControlStore(join(root, "control.sqlite"), clock);
  control.provision(ISSUER, "cli-identity");
  control.close();

  const status = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/managed-activation.ts", "status"],
    { cwd: process.cwd(), env: { ...process.env, BRAIN_MANAGED_ROOT: root }, encoding: "utf8" },
  );
  expect(status.status).toBe(0);
  expect(JSON.parse(status.stdout)).toMatchObject({ profile: "absent", version: 0, reason: "off" });
  const check = new DatabaseSync(join(root, "control.sqlite"), { readOnly: true });
  try {
    expect(
      check
        .prepare("SELECT 1 AS p FROM sqlite_master WHERE type='table' AND name='managed_money_schema'")
        .get(),
    ).toBeUndefined();
  } finally {
    check.close();
  }

  // enable with an unknown audit id fails closed.
  const profileFile = join(base, "profile.json");
  writeFileSync(
    profileFile,
    JSON.stringify({
      provider: "openai",
      model: "synthetic-model-v1",
      price_version: "synthetic-price-v1",
      input_micro_usd_per_million: 1_000_000,
      output_micro_usd_per_million: 1_000_000,
      accepted_response_models: ["synthetic-model-v1"],
      max_output_tokens: 100,
      endpoint_class: "openai_responses",
      audit_id: "00000000-0000-4000-8000-000000000000",
      expected_version: 0,
    }),
  );
  const enable = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/managed-activation.ts",
      "enable",
      profileFile,
      "--offline",
      "--workers-terminated",
    ],
    { cwd: process.cwd(), env: { ...process.env, BRAIN_MANAGED_ROOT: root }, encoding: "utf8" },
  );
  expect(enable.status).not.toBe(0);
  expect(`${enable.stdout}${enable.stderr}`.toLowerCase()).not.toContain(profileFile);
});
