import { expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedRuntime } from "../../packages/runtime/managed.ts";
import { ManagedReconciliationStore } from "../../packages/storage/managed-reconciliation.ts";
import { restoreManagedBackup, writeManagedBackup } from "../../packages/runtime/managed-recovery.ts";

it("a bundle cannot hide its present epoch marker by declaring the marker absent", async () => {
  const base = mkdtempSync(join(tmpdir(), "brain-epoch-restore-parent-"));
  const root = join(base, "managed"), bundle = join(base, "bundle"), destination = join(base, "restored");
  try {
    const runtime = new ManagedRuntime(root);
    try {
      runtime.provision("https://synthetic.example.test", "synthetic-epoch-restore");
      new ManagedReconciliationStore(runtime.control, root).initEpoch({ offline: true, workers_terminated: true });
    } finally { runtime.close(); }
    await writeManagedBackup({ root, destination: bundle, offline: true });
    const manifestPath = join(bundle, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.root_marker = null;
    writeFileSync(manifestPath, JSON.stringify(manifest));
    await expect(restoreManagedBackup({ bundle, destination, currentRoot: root, offline: true })).rejects.toThrow();
    expect(existsSync(destination)).toBe(false);
  } finally { rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});
