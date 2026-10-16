import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ManagedRuntime } from "../../packages/runtime/managed.ts";
import { ManagedSpendingStore } from "../../packages/storage/managed-spending.ts";
import { ManagedReconciliationStore } from "../../packages/storage/managed-reconciliation.ts";
import { ManagedDispatchAccounting } from "../../apps/worker/managed-accounting.ts";
import { auditManagedHistory } from "../../packages/runtime/managed-audit.ts";

const clock = () => new Date("2026-10-16T09:00:00Z");
function command(root: string, args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", resolve("scripts/managed-reconcile.ts"), ...args], { env: { ...process.env, BRAIN_MANAGED_ROOT: root }, encoding: "utf8", timeout: 15000 });
}
const audit = (root: string) => command(root, ["audit-history", "--offline", "--workers-terminated"]);
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "brain-audit-parent-")), root = join(base, "managed");
  const runtime = new ManagedRuntime(root, { clock });
  const a = runtime.provision("https://synthetic.example.test", "synthetic-audit-a");
  const b = runtime.provision("https://synthetic.example.test", "synthetic-audit-b");
  const money = new ManagedSpendingStore(runtime.control, clock);
  money.setServicePolicy({ daily_micro_usd: 1000 });
  for (const account of [a, b]) {
    money.setAccountPolicy({ account_id: account.id, per_job_micro_usd: 1000, user_daily_micro_usd: 1000 });
    money.configureAccountPeriod({ account_id: account.id, starts_at: "2026-10-16T00:00:00Z", ends_at: "2026-10-17T00:00:00Z", allowance_micro_usd: 1000 });
    const handle = runtime.acquire(account.id);
    try { handle.brain.prefs(handle.brain.ownerPrincipal(), { ...handle.brain.prefs(handle.brain.ownerPrincipal()), time_zone: "UTC", daily_cap_micro_usd: 1000, per_job_cap_micro_usd: 1000 }); } finally { handle.release(); }
  }
  new ManagedReconciliationStore(runtime.control, root, clock).initEpoch({ offline: true, workers_terminated: true });
  runtime.close();
  return { base, root, a, b, close() { rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } };
}
function latest(root: string): string {
  const db = new DatabaseSync(join(root, "control.sqlite"), { readOnly: true });
  try { return String(db.prepare("SELECT audit_id FROM managed_audits ORDER BY rowid DESC LIMIT 1").get()?.audit_id); } finally { db.close(); }
}

it("a changed shared service policy invalidates the audit configuration fingerprint", () => {
  const f = fixture();
  try {
    expect(audit(f.root).status).toBe(0);
    const id = latest(f.root);
    const runtime = new ManagedRuntime(f.root, { clock });
    try { new ManagedSpendingStore(runtime.control, clock).setServicePolicy({ daily_micro_usd: 2000 }); } finally { runtime.close(); }
    expect(command(f.root, ["validate-audit", id]).status).not.toBe(0);
  } finally { f.close(); }
});

it("audit refuses an account whose provisioning marker no longer matches its trusted identity", () => {
  const f = fixture();
  try {
    const path = join(f.root, f.b.id, "provisioned.json");
    const marker = JSON.parse(readFileSync(path, "utf8"));
    marker.subject = "synthetic-wrong-subject";
    writeFileSync(path, JSON.stringify(marker));
    expect(audit(f.root).status).not.toBe(0);
  } finally { f.close(); }
});

it("a changed money schema invalidates an existing audit rather than inheriting its approval", () => {
  const f = fixture();
  try {
    expect(audit(f.root).status).toBe(0);
    const id = latest(f.root);
    const db = new DatabaseSync(join(f.root, "control.sqlite"));
    // Activation migrates to schema 3; this fixture must remain genuinely newer.
    try { db.prepare("INSERT INTO managed_money_schema(version,applied_at) VALUES(4,?)").run(clock().toISOString()); } finally { db.close(); }
    expect(command(f.root, ["validate-audit", id]).status).not.toBe(0);
  } finally { f.close(); }
});

it("an account policy change before the final write lock prevents committing a stale audit", () => {
  const f = fixture();
  const path = join(f.root, "control.sqlite");
  const db = new DatabaseSync(path);
  let changed = false;
  try {
    const interleaved = new Proxy(db, {
      get(target, key) {
        if (key === "exec") return (sql: string) => {
          if (!changed && sql === "BEGIN IMMEDIATE") {
            changed = true;
            const writer = new DatabaseSync(path);
            try { writer.prepare("UPDATE managed_account_policy SET per_job_micro_usd=999 WHERE account_id=?").run(f.a.id); } finally { writer.close(); }
          }
          return target.exec(sql);
        };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const result = auditManagedHistory({ control: { db: interleaved, path }, root: f.root, offline: true, workers_terminated: true, clock });
    expect(changed).toBe(true);
    expect(result.ok).toBe(false);
    expect(db.prepare("SELECT count(*) AS n FROM managed_audits").get()?.n).toBe(0);
  } finally { db.close(); f.close(); }
});

it("audit cannot ignore a suspended account's unknown legacy history", () => {
  const f = fixture();
  try {
    const runtime = new ManagedRuntime(f.root, { clock });
    try {
      const handle = runtime.acquire(f.b.id);
      try {
        const job = handle.brain.enqueue("inbox", "derive_brief", { principal: handle.brain.ownerPrincipal() });
        handle.brain.store.run("INSERT INTO reservations VALUES(?,?,?,?,?)", job.id, "2026-10-16", 10, 0, "held");
      } finally { handle.release(); }
      runtime.control.setAccountState(f.b.id, "suspended");
    } finally { runtime.close(); }
    expect(audit(f.root).status).not.toBe(0);
    const db = new DatabaseSync(join(f.root, "control.sqlite"), { readOnly: true });
    try {
      expect(db.prepare("SELECT count(*) AS n FROM managed_audits").get()?.n).toBe(0);
      expect(db.prepare("SELECT state FROM managed_accounts WHERE id=?").get(f.b.id)?.state).toBe("suspended");
    } finally { db.close(); }
  } finally { f.close(); }
});

it("a matched new settlement at the same clock keeps an audit valid, but editing an audited amount does not", () => {
  const f = fixture();
  try {
    expect(audit(f.root).status).toBe(0);
    const first = latest(f.root);
    let callId = "", projectionId = "";
    const runtime = new ManagedRuntime(f.root, { clock });
    try {
      const handle = runtime.acquire(f.a.id);
      try {
        const job = handle.brain.enqueue("inbox", "derive_brief", { principal: handle.brain.ownerPrincipal() });
        const until = "2026-10-16T10:00:00Z";
        handle.brain.store.run("UPDATE jobs SET status='running',lease_owner='synthetic-worker',lease_until=?,fence=1 WHERE id=?", until, job.id);
        const lease = { job_id: job.id, owner: "synthetic-worker", fence: 1, expires_at: until };
        const accounting = new ManagedDispatchAccounting(new ManagedSpendingStore(runtime.control, clock), handle.brain, clock);
        const record = accounting.reserve({ job_id: job.id, dispatch_key: "reasoning", stage: "reasoning", provider: "synthetic", model: "synthetic", price_version: "synthetic-v1", reserved_micro_usd: 10, request_hash: "a".repeat(64), config_hash: "b".repeat(64) }, lease, { per_job_micro_usd: 1000, daily_micro_usd: 1000, time_zone: "UTC" });
        accounting.markDispatched(record.call_id, lease);
        accounting.settle(record.call_id, 7);
        projectionId = record.call_id;
        callId = new ManagedSpendingStore(runtime.control, clock).latestForJob(f.a.id, job.id)!.call_id;
      } finally { handle.release(); }
    } finally { runtime.close(); }
    expect(command(f.root, ["validate-audit", first]).status).toBe(0);
    expect(audit(f.root).status).toBe(0);
    const second = latest(f.root);
    const binding = new DatabaseSync(join(f.root, "control.sqlite"));
    let originalIdentity = "";
    try {
      originalIdentity = String(binding.prepare("SELECT identity_hash FROM managed_reservations WHERE call_id=?").get(callId)?.identity_hash);
      binding.prepare("UPDATE managed_reservations SET identity_hash=? WHERE call_id=?").run("d".repeat(64), callId);
    } finally { binding.close(); }
    expect(command(f.root, ["validate-audit", second]).status).not.toBe(0);
    const resetBinding = new DatabaseSync(join(f.root, "control.sqlite"));
    try { resetBinding.prepare("UPDATE managed_reservations SET identity_hash=? WHERE call_id=?").run(originalIdentity, callId); } finally { resetBinding.close(); }
    const control = new DatabaseSync(join(f.root, "control.sqlite"));
    try { control.prepare("UPDATE managed_reservations SET actual_micro_usd=9 WHERE call_id=?").run(callId); } finally { control.close(); }
    const tenant = new DatabaseSync(join(f.root, f.a.id, "brain.sqlite"));
    try { tenant.prepare("UPDATE provider_dispatches SET actual_micro_usd=9 WHERE call_id=?").run(projectionId); } finally { tenant.close(); }
    expect(command(f.root, ["validate-audit", second]).status).not.toBe(0);
    const invalidControl = new DatabaseSync(join(f.root, "control.sqlite"));
    try { invalidControl.prepare("UPDATE managed_reservations SET actual_micro_usd=7.5 WHERE call_id=?").run(callId); } finally { invalidControl.close(); }
    const invalidTenant = new DatabaseSync(join(f.root, f.a.id, "brain.sqlite"));
    try { invalidTenant.prepare("UPDATE provider_dispatches SET actual_micro_usd=7.5 WHERE call_id=?").run(projectionId); } finally { invalidTenant.close(); }
    // SQLite affinity can retain fractional values even with a nonnegative
    // INTEGER column check; matching invalid amounts are not audited money.
    expect(audit(f.root).status).not.toBe(0);
  } finally { f.close(); }
}, 20000);
