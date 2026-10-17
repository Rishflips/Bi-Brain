import { expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ManagedRuntime } from "../../packages/runtime/managed.ts";
import { ManagedSpendingStore } from "../../packages/storage/managed-spending.ts";
import { ManagedReconciliationStore } from "../../packages/storage/managed-reconciliation.ts";
import { auditManagedHistory } from "../../packages/runtime/managed-audit.ts";
import { ManagedActivationStore, readActivationRow } from "../../packages/storage/managed-activation.ts";
import { ManagedDecisionActivationStore, readDecisionActivationRow } from "../../packages/storage/managed-decision-activation.ts";
import { restoreManagedBackup, writeManagedBackup } from "../../packages/runtime/managed-recovery.ts";
import { spawnSync } from "node:child_process";

const clock = () => new Date("2026-10-17T12:00:00.000Z");
const ack = { offline: true as const, workers_terminated: true as const };
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "brain-decision-persistence-parent-"));
  const root = join(base, "managed"), runtime = new ManagedRuntime(root, { clock });
  const account = runtime.provision("https://issuer.synthetic.test", "synthetic-decision-profile-review");
  const money = new ManagedSpendingStore(runtime.control, clock);
  money.setServicePolicy({ daily_micro_usd: 1000 });
  money.setAccountPolicy({ account_id: account.id, per_job_micro_usd: 1000, user_daily_micro_usd: 1000 });
  money.configureAccountPeriod({ account_id: account.id, starts_at: "2026-10-17T00:00:00Z", ends_at: "2026-10-18T00:00:00Z", allowance_micro_usd: 1000 });
  new ManagedReconciliationStore(runtime.control, root, clock).initEpoch(ack);
  const audit = auditManagedHistory({ runtime, root, ...ack, clock });
  expect(audit.ok).toBe(true);
  const reasoning = new ManagedActivationStore(runtime.control, root, clock);
  const decision = new ManagedDecisionActivationStore(runtime.control, root, clock);
  const reasoningInput = {
    provider: "openai" as const, model: "synthetic-reasoning-v1", accepted_response_models: ["synthetic-reasoning-v1"],
    price_version: "synthetic-price-v1", input_micro_usd_per_million: 1000, output_micro_usd_per_million: 1000,
    max_output_tokens: 100, endpoint_class: "openai_responses" as const, audit_id: audit.audit_id!, expected_version: 0,
  };
  const decisionInput = {
    provider: "typesafe" as const, endpoint: "https://api.typesafe.ai/v1/systemone",
    model: "jev-synthetic-v1", accepted_response_models: ["jev-synthetic-v1"],
    price_version: "synthetic-price-v1", input_micro_usd_per_million: 1000, output_micro_usd_per_million: 0 as const,
    timeout_ms: 1000, max_request_bytes: 1_048_576, max_response_bytes: 262_144,
    audit_id: audit.audit_id!, expected_version: 0,
  };
  return { base, root, runtime, reasoning, decision, reasoningInput, decisionInput,
    close() { runtime.close(); rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } };
}

it("decision activation defaults absent and cannot reuse stale operator versions", () => {
  const f = fixture();
  try {
    expect(readDecisionActivationRow(f.runtime.control.db)).toBeUndefined();
    expect(existsSync(join(f.root, "decision-activation.json"))).toBe(false);
    const initial = f.decision.enable(f.decisionInput, ack);
    expect(initial).toMatchObject({ enabled: true, version: 1 });
    f.decision.disable(1);
    expect(readDecisionActivationRow(f.runtime.control.db)).toMatchObject({ enabled: false, version: 2 });
    expect(() => f.decision.enable({ ...f.decisionInput, expected_version: 1 }, ack)).toThrow();
    expect(() => f.decision.disable(1)).toThrow();
  } finally { f.close(); }
});

it("an absent decision profile still enforces expected-version CAS", () => {
  const f = fixture();
  try {
    expect(() => f.decision.disable(9)).toThrow();
    expect(f.decision.disable(0)).toMatchObject({ disabled: true, version: 0 });
    expect(readDecisionActivationRow(f.runtime.control.db)).toBeUndefined();
  } finally { f.close(); }
});

it("decision-only disable never disables or rewrites the reasoning profile", () => {
  const f = fixture();
  try {
    const reasoning = f.reasoning.enable(f.reasoningInput, ack);
    f.decision.enable(f.decisionInput, ack);
    f.decision.disable(1);
    expect(readActivationRow(f.runtime.control.db)).toEqual(reasoning);
    expect(JSON.parse(readFileSync(join(f.root, "activation.json"), "utf8"))).toEqual(reasoning);
    expect(readDecisionActivationRow(f.runtime.control.db)).toMatchObject({ enabled: false });
  } finally { f.close(); }
});

it("the existing global disable stops both profiles before writing either mirror", () => {
  const f = fixture();
  try {
    f.reasoning.enable(f.reasoningInput, ack);
    f.decision.enable(f.decisionInput, ack);
    f.reasoning.disable(1);
    expect(readActivationRow(f.runtime.control.db)).toMatchObject({ enabled: false, version: 2 });
    expect(readDecisionActivationRow(f.runtime.control.db)).toMatchObject({ enabled: false, version: 2 });
    expect(JSON.parse(readFileSync(join(f.root, "decision-activation.json"), "utf8"))).toEqual(readDecisionActivationRow(f.runtime.control.db));
  } finally { f.close(); }
});

it("failure of the second profile SQL update rolls back the entire global stop transaction", () => {
  const f = fixture();
  try {
    f.reasoning.enable(f.reasoningInput, ack);
    f.decision.enable(f.decisionInput, ack);
    f.runtime.control.db.exec("CREATE TRIGGER synthetic_stop_failure BEFORE UPDATE ON managed_decision_activation BEGIN SELECT RAISE(ABORT,'SYNTHETIC_WRITE_FAILURE'); END");
    expect(() => f.reasoning.disable(1)).toThrow();
    expect(readActivationRow(f.runtime.control.db)).toMatchObject({ enabled: true, version: 1 });
    expect(readDecisionActivationRow(f.runtime.control.db)).toMatchObject({ enabled: true, version: 1 });
    expect(JSON.parse(readFileSync(join(f.root, "activation.json"), "utf8"))).toMatchObject({ enabled: true, version: 1 });
  } finally { f.close(); }
});

it("mirror failure cannot leave either SQL profile enabled after the global stop commits", () => {
  const f = fixture();
  try {
    f.reasoning.enable(f.reasoningInput, ack);
    f.decision.enable(f.decisionInput, ack);
    const path = join(f.root, "decision-activation.json");
    rmSync(path);
    mkdirSync(path);
    expect(() => f.reasoning.disable(1)).toThrow();
    expect(readActivationRow(f.runtime.control.db)).toMatchObject({ enabled: false });
    expect(readDecisionActivationRow(f.runtime.control.db)).toMatchObject({ enabled: false });
  } finally { f.close(); }
});

it("a malformed decision profile cannot roll back a valid reasoning global stop", () => {
  const f = fixture();
  try {
    f.reasoning.enable(f.reasoningInput, ack);
    const original = f.decision.enable(f.decisionInput, ack);
    f.runtime.control.db.exec("UPDATE managed_decision_activation SET model='SYNTHETIC_CORRUPT_CONFIG'");
    // A refusal to publish the corrupt mirror may be reported, but the global
    // stop must already have durably turned off both SQL stages, not rolled back.
    try { f.reasoning.disable(1); } catch { /* Readback remains the authority. */ }
    expect(readActivationRow(f.runtime.control.db)).toMatchObject({ enabled: false });
    expect(f.runtime.control.db.prepare("SELECT enabled,model,fingerprint FROM managed_decision_activation WHERE singleton=1").get())
      .toMatchObject({ enabled: 0, model: "SYNTHETIC_CORRUPT_CONFIG", fingerprint: original.fingerprint });
    expect(f.decision.readState().state).toBe("mismatch");
  } finally { f.close(); }
});

it("decision-only mirror failure is reported after SQL is safely disabled", () => {
  const f = fixture();
  try {
    f.decision.enable(f.decisionInput, ack);
    const path = join(f.root, "decision-activation.json");
    rmSync(path);
    mkdirSync(path);
    expect(() => f.decision.disable(1)).toThrow();
    expect(readDecisionActivationRow(f.runtime.control.db)).toMatchObject({ enabled: false });
    expect(f.decision.readState().state).toBe("mismatch");
  } finally { f.close(); }
});

it("the global stop still disables a decision-only installation with no reasoning row", () => {
  const f = fixture();
  try {
    f.decision.enable(f.decisionInput, ack);
    expect(readActivationRow(f.runtime.control.db)).toBeUndefined();
    f.reasoning.disable(0);
    expect(readDecisionActivationRow(f.runtime.control.db)).toMatchObject({ enabled: false });
    expect(readActivationRow(f.runtime.control.db)).toBeUndefined();
  } finally { f.close(); }
});

it("SQL commits before a failed decision mirror write, and that failure cannot be silently re-enrolled", () => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, "decision-activation.json"));
    expect(() => f.decision.enable(f.decisionInput, ack)).toThrow();
    expect(readDecisionActivationRow(f.runtime.control.db)).toMatchObject({ enabled: true, version: 1 });
    expect(() => f.decision.enable(f.decisionInput, ack)).toThrow();
    expect(readActivationRow(f.runtime.control.db)).toBeUndefined();
  } finally { f.close(); }
});

it("backup excludes both readiness files and supported restore disables both profiles at a new epoch", async () => {
  const f = fixture();
  try {
    const original = f.reasoning.enable(f.reasoningInput, ack);
    f.decision.enable(f.decisionInput, ack);
    writeFileSync(join(f.root, "worker-ready.json"), "SYNTHETIC_READINESS_NOT_BACKUP_CONTENT");
    writeFileSync(join(f.root, "decision-worker-ready.json"), "SYNTHETIC_DECISION_READINESS_NOT_BACKUP_CONTENT");
    f.runtime.close();
    const bundle = join(f.base, "bundle"), restoredRoot = join(f.base, "restored");
    await writeManagedBackup({ root: f.root, destination: bundle, offline: true });
    expect(existsSync(join(bundle, "worker-ready.json"))).toBe(false);
    expect(existsSync(join(bundle, "decision-worker-ready.json"))).toBe(false);
    expect(existsSync(join(bundle, "decision-activation.json"))).toBe(true);
    await restoreManagedBackup({ bundle, destination: restoredRoot, currentRoot: f.root, offline: true });
    const restored = new ManagedRuntime(restoredRoot, { clock });
    try {
      const r = readActivationRow(restored.control.db), d = readDecisionActivationRow(restored.control.db);
      expect(r).toMatchObject({ enabled: false });
      expect(d).toMatchObject({ enabled: false });
      expect(r!.epoch).toBeGreaterThan(original.epoch);
      expect(d!.epoch).toBe(r!.epoch);
      expect(existsSync(join(restoredRoot, "worker-ready.json"))).toBe(false);
      expect(existsSync(join(restoredRoot, "decision-worker-ready.json"))).toBe(false);
    } finally { restored.close(); }
  } finally { f.close(); }
}, 30_000);

it("decision enrollment rechecks configuration under its final write lock, not only account ids", () => {
  const f = fixture();
  let begins = 0, changed = false;
  try {
    const db = f.runtime.control.db;
    const interleaved = new Proxy(db, { get(target, key) {
      if (key === "exec") return (sql: string) => {
        if (sql === "BEGIN IMMEDIATE" && ++begins === 2) {
          const writer = new DatabaseSync(join(f.root, "control.sqlite"));
          try { writer.exec("UPDATE managed_account_policy SET per_job_micro_usd=999"); changed = true; }
          finally { writer.close(); }
        }
        return target.exec(sql);
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const control = new Proxy(f.runtime.control, { get(target, key) {
      if (key === "db") return interleaved;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    expect(() => new ManagedDecisionActivationStore(control, f.root, clock).enable(f.decisionInput, ack)).toThrow();
    expect(changed).toBe(true);
    expect(readDecisionActivationRow(db)).toBeUndefined();
  } finally { f.close(); }
});

it("activation audit events cannot be rewritten or erased", () => {
  const f = fixture();
  try {
    f.decision.enable(f.decisionInput, ack);
    expect(() => f.runtime.control.db.exec("UPDATE managed_decision_activation_events SET action='disabled'")).toThrow();
    expect(() => f.runtime.control.db.exec("DELETE FROM managed_decision_activation_events")).toThrow();
  } finally { f.close(); }
});

it("a global stop records both changed stages in the same durable event history", () => {
  const f = fixture();
  try {
    f.reasoning.enable(f.reasoningInput, ack);
    f.decision.enable(f.decisionInput, ack);
    f.reasoning.disable(1);
    const events = f.runtime.control.db.prepare("SELECT stage,action,version FROM managed_decision_activation_events WHERE action='disabled' ORDER BY stage").all();
    expect(events).toEqual([
      { stage: "decision", action: "disabled", version: 2 },
      { stage: "reasoning", action: "disabled", version: 2 },
    ]);
  } finally { f.close(); }
});

it("an ignored audit-event insert cannot commit an enabled profile without its audit event", () => {
  const f = fixture();
  try {
    f.runtime.control.db.exec("CREATE TRIGGER synthetic_ignore_event BEFORE INSERT ON managed_decision_activation_events BEGIN SELECT RAISE(IGNORE); END");
    expect(() => f.decision.enable(f.decisionInput, ack)).toThrow();
    expect(readDecisionActivationRow(f.runtime.control.db)).toBeUndefined();
    expect(existsSync(join(f.root, "decision-activation.json"))).toBe(false);
  } finally { f.close(); }
});

it("future schema rejection happens before any decision DDL or marker change", () => {
  const f = fixture();
  try {
    f.runtime.control.db.exec("DROP TABLE managed_decision_activation; DROP TABLE managed_decision_activation_events");
    f.runtime.control.db.prepare("INSERT INTO managed_money_schema(version,applied_at) VALUES(5,?)").run(clock().toISOString());
    expect(() => new ManagedSpendingStore(f.runtime.control, clock)).toThrow();
    expect(f.runtime.control.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'managed_decision_activation%'").all()).toEqual([]);
    expect(f.runtime.control.db.prepare("SELECT MAX(version) AS version FROM managed_money_schema").get()).toMatchObject({ version: 5 });
  } finally { f.close(); }
});

it("the decision CLI accepts the required enable flags and refuses duplicate version flags", () => {
  const f = fixture();
  try {
    const file = join(f.base, "synthetic-profile.json");
    writeFileSync(file, JSON.stringify(f.decisionInput));
    f.runtime.close();
    const run = (args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "scripts/managed-decision-activation.ts", ...args], {
      encoding: "utf8", cwd: process.cwd(), env: { ...process.env, BRAIN_MANAGED_ROOT: f.root }, timeout: 15_000,
    });
    const enabled = run(["enable", file, "--offline", "--workers-terminated"]);
    expect({ status: enabled.status, stderr: enabled.stderr }).toEqual({ status: 0, stderr: "" });
    expect(JSON.parse(enabled.stdout)).toMatchObject({ enabled: true, version: 1 });
    const duplicated = run(["disable", "--expected-version", "0", "--expected-version", "1"]);
    expect(duplicated.status).not.toBe(0);
    const status = run(["status"]);
    expect(status.status).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ enabled: true, version: 1 });
  } finally { f.close(); }
});

it("CLI status distinguishes two individually valid but mismatched SQL/mirror profiles", () => {
  const f = fixture();
  try {
    f.decision.enable(f.decisionInput, ack);
    const path = join(f.root, "decision-activation.json"), historical = readFileSync(path);
    f.decision.disable(1);
    writeFileSync(path, historical);
    f.runtime.close();
    const status = spawnSync(process.execPath, ["--import", "tsx", "scripts/managed-decision-activation.ts", "status"], {
      encoding: "utf8", cwd: process.cwd(), env: { ...process.env, BRAIN_MANAGED_ROOT: f.root }, timeout: 15_000,
    });
    expect(status.status).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ profile: "mismatch" });
  } finally { f.close(); }
});
