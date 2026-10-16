import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedRuntime } from "../../packages/runtime/managed.ts";
import {
  readWorkerReadiness,
  removeWorkerReadiness,
  workerReadinessPath,
  writeWorkerReadiness,
} from "../../packages/runtime/worker-readiness.ts";

const clock = () => new Date("2026-10-16T09:00:00Z");
const NOW = new Date("2026-10-16T09:00:00Z");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
function managedRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "brain-ready-"));
  roots.push(root);
  const runtime = new ManagedRuntime(root, { clock });
  runtime.provision("https://synthetic.example.test", "ready-a");
  runtime.close();
  return root;
}
function record(over: Record<string, unknown> = {}) {
  return {
    schema: 1,
    worker_id: "11111111-1111-4111-8111-111111111111",
    epoch: 1,
    root_nonce: "a".repeat(64),
    activation_fingerprint: "b".repeat(64),
    config_digest: "c".repeat(64),
    provider: "openai",
    model: "synthetic-model-v1",
    price_version: "synthetic-price-v1",
    endpoint_class: "openai_responses",
    booted_at: "2026-10-16T08:59:50.000Z",
    heartbeat_at: "2026-10-16T08:59:55.000Z",
    expires_at: "2026-10-16T09:00:05.000Z",
    ...over,
  };
}

describe("worker readiness lease", () => {
  it("accepts a natural fresh lease and rejects missing/malformed/oversized content", () => {
    const root = managedRoot();
    writeWorkerReadiness(root, record());
    expect(readWorkerReadiness(root, NOW).state).toBe("ready");

    writeFileSync(workerReadinessPath(root), "{ not json");
    expect(readWorkerReadiness(root, NOW).state).toBe("stale");

    writeFileSync(workerReadinessPath(root), JSON.stringify({ ...record(), extra: 1 }));
    expect(readWorkerReadiness(root, NOW).state).toBe("stale");

    writeFileSync(workerReadinessPath(root), "x".repeat(256 * 1024 + 1));
    expect(readWorkerReadiness(root, NOW).state).toBe("stale");

    rmSync(workerReadinessPath(root), { force: true });
    expect(readWorkerReadiness(root, NOW).state).toBe("absent");
  });

  it("denies a 16s TTL, an exact-expired lease, and a future boot/heartbeat", () => {
    const root = managedRoot();
    expect(() =>
      writeWorkerReadiness(root, record({ heartbeat_at: NOW.toISOString(), expires_at: "2026-10-16T09:00:16.000Z" })),
    ).not.toThrow();
    expect(readWorkerReadiness(root, NOW).state).toBe("stale");

    writeWorkerReadiness(root, record({ heartbeat_at: "2026-10-16T08:59:45.000Z", expires_at: NOW.toISOString() }));
    expect(readWorkerReadiness(root, NOW).state).toBe("stale");

    writeWorkerReadiness(root, record({ booted_at: "2026-10-16T09:00:10.000Z" }));
    expect(readWorkerReadiness(root, NOW).state).toBe("stale");

    writeWorkerReadiness(root, record({ heartbeat_at: "2026-10-16T09:00:10.000Z", expires_at: "2026-10-16T09:00:20.000Z" }));
    expect(readWorkerReadiness(root, NOW).state).toBe("stale");
  });

  it("rejects an invalid worker id or a non-ISO timestamp on write", () => {
    const root = managedRoot();
    expect(() => writeWorkerReadiness(root, record({ worker_id: "not-a-uuid" }))).toThrow();
    expect(() => writeWorkerReadiness(root, record({ expires_at: "tomorrow" }))).toThrow();
  });

  it("removes only its own valid record and never recursively deletes an unrecognized path", () => {
    const root = managedRoot();
    writeWorkerReadiness(root, record());
    removeWorkerReadiness(root, "22222222-2222-4222-8222-222222222222");
    expect(existsSync(workerReadinessPath(root))).toBe(true);
    removeWorkerReadiness(root, "11111111-1111-4111-8111-111111111111");
    expect(existsSync(workerReadinessPath(root))).toBe(false);

    // A directory occupying the marker path is left intact.
    mkdirSync(workerReadinessPath(root));
    const retained = join(workerReadinessPath(root), "retained.txt");
    writeFileSync(retained, "RETAINED");
    removeWorkerReadiness(root, "11111111-1111-4111-8111-111111111111");
    expect(readFileSync(retained, "utf8")).toBe("RETAINED");
  });

  it.skipIf(process.platform === "win32")(
    "refuses a symlinked readiness file and a symlinked root ancestor",
    () => {
      const root = managedRoot();
      const target = join(root, "elsewhere.json");
      writeFileSync(target, JSON.stringify(record()));
      symlinkSync(target, workerReadinessPath(root));
      expect(readWorkerReadiness(root, NOW).state).toBe("stale");
      expect(() => writeWorkerReadiness(root, record())).toThrow();
    },
  );
});
