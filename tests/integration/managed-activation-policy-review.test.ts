import { expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ManagedRuntime } from "../../packages/runtime/managed.ts";
import { ManagedSpendingStore } from "../../packages/storage/managed-spending.ts";
import { ManagedReconciliationStore } from "../../packages/storage/managed-reconciliation.ts";
import { ManagedActivationStore } from "../../packages/storage/managed-activation.ts";
import { auditManagedHistory } from "../../packages/runtime/managed-audit.ts";
import { evaluateConfiguredPolicy, readActivation } from "../../packages/runtime/managed-activation.ts";
import { restoreManagedBackup, writeManagedBackup } from "../../packages/runtime/managed-recovery.ts";

const clock = () => new Date("2026-10-16T09:00:00Z");
const ACK = { offline: true as const, workers_terminated: true as const };
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "brain-activation-policy-parent-")), root = join(base, "managed");
  const runtime = new ManagedRuntime(root, { clock });
  const account = runtime.provision("https://synthetic.example.test", "synthetic-activation-policy");
  const money = new ManagedSpendingStore(runtime.control, clock);
  money.setServicePolicy({ daily_micro_usd: 1000 });
  money.setAccountPolicy({ account_id: account.id, per_job_micro_usd: 1000, user_daily_micro_usd: 1000 });
  money.configureAccountPeriod({ account_id: account.id, starts_at: "2026-10-16T00:00:00Z", ends_at: "2026-10-17T00:00:00Z", allowance_micro_usd: 1000 });
  new ManagedReconciliationStore(runtime.control, root, clock).initEpoch(ACK);
  const audit = auditManagedHistory({ runtime, root, ...ACK, clock });
  expect(audit.ok).toBe(true);
  const input = { provider: "openai" as const, model: "synthetic-model-v1", price_version: "synthetic-price-v1", input_micro_usd_per_million: 1_000_000, output_micro_usd_per_million: 1_000_000, accepted_response_models: ["synthetic-model-v1"], max_output_tokens: 100, endpoint_class: "openai_responses" as const, audit_id: audit.audit_id!, expected_version: 0 };
  const store = new ManagedActivationStore(runtime.control, root, clock);
  const context = { control: runtime.control, root, now: clock(), optIn: true, schemaOk: true };
  return { base, root, runtime, account, money, store, input, context, close() { runtime.close(); rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } };
}

it("env opt-in alone cannot initialize activation or grant capability", () => {
  const f = fixture();
  try {
    expect(readActivation(f.runtime.control, f.root)).toBeUndefined();
    expect(evaluateConfiguredPolicy(f.context).ready).toBe(false);
    expect(existsSync(join(f.root, "activation.json"))).toBe(false);
  } finally { f.close(); }
});

it("a valid exact profile is ready without its own worker lease; offline acknowledgements remain mandatory", () => {
  const f = fixture();
  try {
    expect(() => f.store.enable(f.input, { offline: true, workers_terminated: false })).toThrow();
    expect(readActivation(f.runtime.control, f.root)).toBeUndefined();
    const profile = f.store.enable(f.input, ACK);
    expect(profile).toMatchObject({ enabled: true, version: 1 });
    expect(evaluateConfiguredPolicy(f.context).ready).toBe(true);
    expect(existsSync(join(f.root, "worker-ready.json"))).toBe(false);
    expect(() => f.store.enable(f.input, ACK)).toThrow();
    expect(readActivation(f.runtime.control, f.root)).toEqual(profile);
  } finally { f.close(); }
});

it("current service configuration and exact marker content invalidate an old enrollment", () => {
  const f = fixture();
  try {
    f.store.enable(f.input, ACK);
    f.money.setServicePolicy({ daily_micro_usd: 2000 });
    expect(evaluateConfiguredPolicy(f.context).ready).toBe(false);
    const path = join(f.root, "activation.json");
    const value = JSON.parse(readFileSync(path, "utf8"));
    value.max_output_tokens = 101;
    writeFileSync(path, JSON.stringify(value));
    expect(readActivation(f.runtime.control, f.root)).toBeUndefined();
    expect(evaluateConfiguredPolicy(f.context).ready).toBe(false);
  } finally { f.close(); }
});

it("disable defeats a caller-supplied historical enabled profile and cannot be overwritten by a stale version", () => {
  const f = fixture();
  try {
    const enabled = f.store.enable(f.input, ACK);
    f.store.disable(enabled.version);
    const supplied = { ...f.context, profile: enabled };
    expect(evaluateConfiguredPolicy(supplied).ready).toBe(false);
    expect(() => f.store.enable({ ...f.input, expected_version: enabled.version }, ACK)).toThrow();
    expect(evaluateConfiguredPolicy(f.context).ready).toBe(false);
  } finally { f.close(); }
});

it("failure to publish the mirror never reports an enabled capability", () => {
  const f = fixture();
  try {
    // Inject a real filesystem failure at the SQL-to-file boundary without a
    // production fault flag: a SQLite callback occupies the marker path.
    f.runtime.control.db.function("synthetic_occupy_activation_marker", () => {
      mkdirSync(join(f.root, "activation.json"));
      return 1;
    });
    f.runtime.control.db.exec("CREATE TRIGGER synthetic_marker_publication_failure AFTER INSERT ON managed_activation BEGIN SELECT synthetic_occupy_activation_marker(); END");
    expect(() => f.store.enable(f.input, ACK)).toThrow();
    expect(readActivation(f.runtime.control, f.root)).toBeUndefined();
    expect(evaluateConfiguredPolicy(f.context).ready).toBe(false);
  } finally { f.close(); }
});

it("offline enrollment cannot reuse an old clean audit after unknown legacy history appears", () => {
  const f = fixture();
  try {
    const handle = f.runtime.acquire(f.account.id);
    try {
      const job = handle.brain.enqueue("inbox", "derive_brief", { principal: handle.brain.ownerPrincipal() });
      handle.brain.store.run("INSERT INTO reservations VALUES(?,?,?,?,?)", job.id, "2026-10-16", 10, 0, "held");
    } finally { handle.release(); }
    expect(() => f.store.enable(f.input, ACK)).toThrow();
    expect(evaluateConfiguredPolicy(f.context).ready).toBe(false);
  } finally { f.close(); }
});

it("an unsupported stored profile schema is rejected, not silently read as schema one", () => {
  const f = fixture();
  try {
    f.store.enable(f.input, ACK);
    f.runtime.control.db.exec("UPDATE managed_activation SET schema=2 WHERE singleton=1");
    expect(readActivation(f.runtime.control, f.root)).toBeUndefined();
    expect(evaluateConfiguredPolicy(f.context).ready).toBe(false);
  } finally { f.close(); }
});

it("disabling an absent profile never recursively deletes an unrecognized marker directory", () => {
  const f = fixture();
  try {
    const dir = join(f.root, "activation.json");
    mkdirSync(dir);
    const retained = join(dir, "retained.txt");
    writeFileSync(retained, "SYNTHETIC_UNKNOWN_CONTENT_MUST_NOT_BE_REMOVED");
    try { f.store.disable(0); } catch { /* Refusing a malformed marker is safe. */ }
    expect(readFileSync(retained, "utf8")).toBe("SYNTHETIC_UNKNOWN_CONTENT_MUST_NOT_BE_REMOVED");
    expect(evaluateConfiguredPolicy(f.context).ready).toBe(false);
  } finally { f.close(); }
});

it("a policy edit before the final enrollment write lock cannot commit a stale enabled profile", () => {
  const f = fixture();
  let begins = 0, changed = false;
  try {
    const db = f.runtime.control.db;
    const interleavedDb = new Proxy(db, {
      get(target, key) {
        if (key === "exec") return (sql: string) => {
          if (sql === "BEGIN IMMEDIATE" && ++begins === 2) {
            // First transaction migrates schema; the second grants enrollment.
            changed = true;
            const writer = new DatabaseSync(join(f.root, "control.sqlite"));
            try { writer.prepare("UPDATE managed_account_policy SET per_job_micro_usd=999 WHERE account_id=?").run(f.account.id); } finally { writer.close(); }
          }
          return target.exec(sql);
        };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const control = new Proxy(f.runtime.control, {
      get(target, key) {
        if (key === "db") return interleavedDb;
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const store = new ManagedActivationStore(control, f.root, clock);
    expect(() => store.enable(f.input, ACK)).toThrow();
    expect(changed).toBe(true);
    expect(db.prepare("SELECT count(*) AS n FROM managed_activation").get()?.n).toBe(0);
    expect(evaluateConfiguredPolicy(f.context).ready).toBe(false);
  } finally { f.close(); }
});

it("supported recovery never reactivates an enabled profile or copies its worker readiness", async () => {
  const f = fixture();
  let closed = false;
  try {
    const enabled = f.store.enable(f.input, ACK);
    writeFileSync(join(f.root, "worker-ready.json"), "SYNTHETIC_EPHEMERAL_WORKER_READINESS");
    f.runtime.close(); closed = true;
    const bundle = join(f.base, "bundle"), destination = join(f.base, "restored");
    await writeManagedBackup({ root: f.root, destination: bundle, offline: true, clock });
    expect(existsSync(join(bundle, "worker-ready.json"))).toBe(false);
    await restoreManagedBackup({ bundle, destination, currentRoot: f.root, offline: true, clock });
    const runtime = new ManagedRuntime(destination, { clock });
    try {
      const restored = readActivation(runtime.control, destination);
      expect(restored).toMatchObject({ enabled: false });
      expect(restored!.version).toBeGreaterThan(enabled.version);
      expect(restored!.epoch).toBeGreaterThan(enabled.epoch);
      expect(existsSync(join(destination, "worker-ready.json"))).toBe(false);
      expect(new ManagedSpendingStore(runtime.control, clock).accountStatus(f.account.id).blocked).toBe(true);
    } finally { runtime.close(); }
  } finally { if (!closed) f.runtime.close(); rmSync(f.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});
