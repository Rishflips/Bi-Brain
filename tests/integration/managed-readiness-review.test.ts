import { expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ManagedRuntime } from "../../packages/runtime/managed.ts";
import { activationFingerprint, profileConfigDigest, type ActivationProfile } from "../../packages/domain/managed-activation.ts";
import { serverCapability } from "../../packages/runtime/managed-activation.ts";
import { readWorkerReadiness, removeWorkerReadiness, writeWorkerReadiness, type WorkerReadiness } from "../../packages/runtime/worker-readiness.ts";

const now = new Date("2026-10-16T09:00:00.000Z");
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "brain-readiness-parent-")), root = join(base, "managed");
  const runtime = new ManagedRuntime(root, { clock: () => now });
  const profile: ActivationProfile = {
    schema: 1, version: 1, enabled: true, provider: "openai", model: "synthetic-model-v1", price_version: "synthetic-price-v1",
    input_micro_usd_per_million: 10_000, output_micro_usd_per_million: 10_000,
    accepted_response_models: ["synthetic-model-v1"], max_output_tokens: 100, endpoint_class: "openai_responses",
    config_digest: "0".repeat(64), audit_digest: "a".repeat(64), audit_id: randomUUID(), epoch: 1,
    root_nonce: "b".repeat(64), fingerprint: "0".repeat(64), updated_at: now.toISOString(),
  };
  profile.config_digest = profileConfigDigest(profile);
  profile.fingerprint = activationFingerprint(profile);
  const readiness: WorkerReadiness = {
    schema: 1, worker_id: randomUUID(), epoch: profile.epoch, root_nonce: profile.root_nonce,
    activation_fingerprint: profile.fingerprint, config_digest: profile.config_digest,
    provider: profile.provider, model: profile.model, price_version: profile.price_version, endpoint_class: profile.endpoint_class,
    booted_at: "2026-10-16T08:59:59.000Z", heartbeat_at: now.toISOString(), expires_at: "2026-10-16T09:00:15.000Z",
  };
  return { base, root, profile, readiness, path: join(root, "worker-ready.json"), close() { runtime.close(); rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } };
}

it("the normal fifteen-second future expiry is valid, but the exact expiry instant is stale", () => {
  const f = fixture();
  try {
    writeWorkerReadiness(f.root, f.readiness);
    const fresh = readWorkerReadiness(f.root, now);
    expect(fresh.state).toBe("ready");
    expect(serverCapability({ configured: { ready: true, reason: "ready" }, readiness: fresh, profile: f.profile })).toMatchObject({ ready: true });
    expect(readWorkerReadiness(f.root, new Date(f.readiness.expires_at)).state).not.toBe("ready");
  } finally { f.close(); }
});

it.each([
  { heartbeat_at: "2026-10-16T09:00:01.000Z", expires_at: "2026-10-16T09:00:16.000Z" },
  { booted_at: "2026-10-16T09:00:01.000Z" },
  { expires_at: "2026-10-16T09:00:16.000Z" },
  { expires_at: "2026-10-16T09:00:00.000Z" },
  { heartbeat_at: "not-an-instant" },
  { worker_id: "not-a-worker-id" },
  { key: "SYNTHETIC_KEY_MUST_NOT_BE_READINESS" },
])("an untrusted readiness file cannot claim liveness: %j", (change) => {
  const f = fixture();
  try {
    writeFileSync(f.path, JSON.stringify({ ...f.readiness, ...change }));
    expect(readWorkerReadiness(f.root, now).state).not.toBe("ready");
  } finally { f.close(); }
});

it.each([
  { epoch: 2 }, { root_nonce: "c".repeat(64) }, { activation_fingerprint: "d".repeat(64) },
  { config_digest: "e".repeat(64) }, { model: "synthetic-other-model" }, { price_version: "synthetic-other-price" },
])("even a fresh lease must match the exact installed policy: %j", (change) => {
  const f = fixture();
  try {
    writeWorkerReadiness(f.root, { ...f.readiness, ...change });
    const fresh = readWorkerReadiness(f.root, now);
    expect(fresh.state).toBe("ready");
    expect(serverCapability({ configured: { ready: true, reason: "ready" }, readiness: fresh, profile: f.profile }).ready).toBe(false);
  } finally { f.close(); }
});

it("cleanup never removes another worker's lease, but can withdraw its own expired lease", () => {
  const f = fixture();
  try {
    writeWorkerReadiness(f.root, f.readiness);
    const original = readFileSync(f.path, "utf8");
    removeWorkerReadiness(f.root, randomUUID());
    expect(readFileSync(f.path, "utf8")).toBe(original);
    writeFileSync(f.path, JSON.stringify({ ...f.readiness, heartbeat_at: "2026-10-15T09:00:00.000Z", expires_at: "2026-10-15T09:00:15.000Z", booted_at: "2026-10-15T08:00:00.000Z" }));
    removeWorkerReadiness(f.root, f.readiness.worker_id);
    expect(existsSync(f.path)).toBe(false);
  } finally { f.close(); }
});

it("an unknown readiness directory is never recursively deleted", () => {
  const f = fixture();
  try {
    mkdirSync(f.path);
    const retained = join(f.path, "retained.txt");
    writeFileSync(retained, "SYNTHETIC_RETAINED_CONTENT");
    try { removeWorkerReadiness(f.root, f.readiness.worker_id); } catch { /* refusal is safe */ }
    expect(readFileSync(retained, "utf8")).toBe("SYNTHETIC_RETAINED_CONTENT");
    expect(readWorkerReadiness(f.root, now).state).not.toBe("ready");
  } finally { f.close(); }
});

it("readiness reads, writes and cleanup never follow a linked managed root", () => {
  const f = fixture();
  try {
    writeWorkerReadiness(f.root, f.readiness);
    const alias = join(f.base, "linked-root");
    symlinkSync(f.root, alias, "junction");
    expect(readWorkerReadiness(alias, now).state).not.toBe("ready");
    expect(() => writeWorkerReadiness(alias, f.readiness)).toThrow();
    try { removeWorkerReadiness(alias, f.readiness.worker_id); } catch { /* refusal is safe */ }
    expect(existsSync(f.path)).toBe(true);
  } finally { f.close(); }
});
