import { expect, it } from "vitest";
import { mkdtempSync, mkdirSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ManagedRuntime } from "../../packages/runtime/managed.ts";

it("account suspension invalidates an already acquired service principal", () => {
  const root = mkdtempSync(join(tmpdir(), "brain-review-suspend-"));
  const runtime = new ManagedRuntime(root);
  const account = runtime.provision("https://issuer.example.test", "synthetic-subject");
  const handle = runtime.acquire(account.id);
  try {
    const principal = handle.brain.ownerPrincipal();
    runtime.control.setAccountState(account.id, "suspended");
    expect(() => handle.brain.capture(principal, {
      title: "Suspended write", body: "SYNTHETIC_REJECT_AFTER_SUSPENSION",
    })).toThrow();
  } finally {
    handle.release();
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("runtime refuses a substituted tenant vault before opening a different account's files", () => {
  const root = mkdtempSync(join(tmpdir(), "brain-review-vault-"));
  const runtime = new ManagedRuntime(root);
  let acquired: ReturnType<ManagedRuntime["acquire"]> | undefined;
  try {
    const a = runtime.provision("https://issuer.example.test", "synthetic-a");
    const b = runtime.provision("https://issuer.example.test", "synthetic-b");
    renameSync(join(root, a.id, "vault"), join(root, a.id, "original-vault"));
    symlinkSync(join(root, b.id, "vault"), join(root, a.id, "vault"), "junction");
    expect(() => { acquired = runtime.acquire(a.id); }).toThrow();
  } finally {
    acquired?.release();
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("managed root cannot be created underneath a symlink or junction ancestor", () => {
  const root = mkdtempSync(join(tmpdir(), "brain-review-root-"));
  let runtime: ManagedRuntime | undefined;
  try {
    mkdirSync(join(root, "real"));
    symlinkSync(join(root, "real"), join(root, "linked"), "junction");
    expect(() => { runtime = new ManagedRuntime(join(root, "linked", "managed")); }).toThrow();
  } finally {
    runtime?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
