import { expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedRuntime } from "../../packages/runtime/managed.ts";
import { restoreManagedBackup, writeManagedBackup } from "../../packages/runtime/managed-recovery.ts";

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "brain-recovery-parent-"));
  const root = join(base, "managed"), bundle = join(base, "bundle"), destination = join(base, "restored");
  const runtime = new ManagedRuntime(root);
  const account = runtime.provision("https://synthetic.example.test", "synthetic-recovery-review");
  const handle = runtime.acquire(account.id);
  const saved = handle.brain.capture(handle.brain.ownerPrincipal(), { title: "Retained note", body: "SYNTHETIC_CURRENT_TOMBSTONES_REQUIRED" }) as { source_id: string };
  handle.release(); runtime.close();
  return { base, root, bundle, destination, account, sourceId: saved.source_id, close() { rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } };
}

it("missing current tenant storage cannot silently skip deletion reconciliation and publish older content", async () => {
  const f = fixture();
  try {
    await writeManagedBackup({ root: f.root, destination: f.bundle, offline: true });
    renameSync(join(f.root, f.account.id, "brain.sqlite"), join(f.base, "current-tenant-unavailable.sqlite"));
    await expect(restoreManagedBackup({ bundle: f.bundle, destination: f.destination, currentRoot: f.root, offline: true })).rejects.toThrow();
    expect(existsSync(f.destination)).toBe(false);
  } finally { f.close(); }
});

it("backup rejects a destination routed through an ancestor junction before writing outside it", async () => {
  const f = fixture();
  try {
    const outside = join(f.base, "outside"), link = join(f.base, "redirected");
    mkdirSync(outside);
    symlinkSync(outside, link, "junction");
    await expect(writeManagedBackup({ root: f.root, destination: join(link, "bundle"), offline: true })).rejects.toThrow();
    expect(existsSync(join(outside, "bundle"))).toBe(false);
  } finally { f.close(); }
});

it("backup rejects a tenant directory redirected through a junction", async () => {
  const f = fixture();
  try {
    const original = join(f.root, f.account.id), outside = join(f.base, "redirected-tenant");
    renameSync(original, outside);
    symlinkSync(outside, original, "junction");
    await expect(writeManagedBackup({ root: f.root, destination: f.bundle, offline: true })).rejects.toThrow();
    expect(existsSync(f.bundle)).toBe(false);
  } finally { f.close(); }
});

it("full quarantine backup does not discard ordinary files just because their names end in -wal", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, f.account.id, "vault-protected", "retained-source-wal"), "SYNTHETIC_QUARANTINE_CONTENT");
    await writeManagedBackup({ root: f.root, destination: f.bundle, offline: true });
    expect(existsSync(join(f.bundle, f.account.id, "vault-protected", "retained-source-wal"))).toBe(true);
  } finally { f.close(); }
});

it("manifest account inventory must exactly match its own hashed control database", async () => {
  const f = fixture();
  try {
    await writeManagedBackup({ root: f.root, destination: f.bundle, offline: true });
    const path = join(f.bundle, "manifest.json");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    manifest.accounts = [];
    writeFileSync(path, JSON.stringify(manifest));
    await expect(restoreManagedBackup({ bundle: f.bundle, destination: f.destination, currentRoot: f.root, offline: true })).rejects.toThrow();
    expect(existsSync(f.destination)).toBe(false);
  } finally { f.close(); }
});

it("recovery deletion replay removes the source from export and decoded Git history, not only search", async () => {
  const f = fixture();
  try {
    await writeManagedBackup({ root: f.root, destination: f.bundle, offline: true });
    const current = new ManagedRuntime(f.root);
    try {
      const handle = current.acquire(f.account.id);
      try {
        handle.brain.removeSource(handle.brain.ownerPrincipal(), f.sourceId, 1, true);
      } finally { handle.release(); }
    } finally { current.close(); }
    await restoreManagedBackup({ bundle: f.bundle, destination: f.destination, currentRoot: f.root, offline: true });
    const restored = new ManagedRuntime(f.destination);
    try {
      const handle = restored.acquire(f.account.id);
      try {
        expect(JSON.stringify(handle.brain.export(handle.brain.ownerPrincipal()))).not.toContain("SYNTHETIC_CURRENT_TOMBSTONES_REQUIRED");
        expect(handle.brain.store.vault!.verifyForget(f.sourceId).file_gone).toBe(true);
        const history = execFileSync("git", ["-C", join(f.destination, f.account.id, "vault"), "log", "--all", "-p"], { encoding: "utf8" });
        expect(history).not.toContain("SYNTHETIC_CURRENT_TOMBSTONES_REQUIRED");
      } finally { handle.release(); }
    } finally { restored.close(); }
  } finally { f.close(); }
}, 20000);
