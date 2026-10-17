import { expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedRuntime } from "../../packages/runtime/managed.ts";
import { ManagedSpendingStore } from "../../packages/storage/managed-spending.ts";
import { ManagedReconciliationStore } from "../../packages/storage/managed-reconciliation.ts";
import { ManagedDecisionActivationStore } from "../../packages/storage/managed-decision-activation.ts";
import { auditManagedHistory } from "../../packages/runtime/managed-audit.ts";
import { decisionServerCapability, evaluateConfiguredDecisionPolicy, readDecisionActivation } from "../../packages/runtime/managed-activation.ts";
import { readDecisionReadiness, removeDecisionReadiness, writeDecisionReadiness } from "../../packages/runtime/decision-worker-readiness.ts";

const clock = () => new Date("2026-10-17T12:00:00.000Z");
const ack = { offline: true as const, workers_terminated: true as const };
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "brain-decision-runtime-parent-")), root = join(base, "managed");
  const runtime = new ManagedRuntime(root, { clock });
  const account = runtime.provision("https://issuer.synthetic.test", "synthetic-decision-runtime");
  const money = new ManagedSpendingStore(runtime.control, clock);
  money.setServicePolicy({ daily_micro_usd: 1000 });
  money.setAccountPolicy({ account_id: account.id, per_job_micro_usd: 1000, user_daily_micro_usd: 1000 });
  money.configureAccountPeriod({ account_id: account.id, starts_at: "2026-10-17T00:00:00Z", ends_at: "2026-10-18T00:00:00Z", allowance_micro_usd: 1000 });
  new ManagedReconciliationStore(runtime.control, root, clock).initEpoch(ack);
  const audit = auditManagedHistory({ runtime, root, ...ack, clock });
  expect(audit.ok).toBe(true);
  const store = new ManagedDecisionActivationStore(runtime.control, root, clock);
  const profile = store.enable({ provider: "typesafe", endpoint: "https://api.typesafe.ai/v1/systemone", model: "jev-synthetic-v1",
    accepted_response_models: ["jev-synthetic-v1"], price_version: "synthetic-price-v1",
    input_micro_usd_per_million: 1000, output_micro_usd_per_million: 0, timeout_ms: 1000,
    max_request_bytes: 1_048_576, max_response_bytes: 262_144, audit_id: audit.audit_id!, expected_version: 0 }, ack);
  const context = { control: runtime.control, root, now: clock(), optIn: true };
  return { base, root, runtime, store, profile, context,
    close() { runtime.close(); rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } };
}

function readiness(p: ReturnType<typeof fixture>["profile"]) {
  return {
    schema: 1 as const, worker_id: randomUUID(), stage_scope: "decision" as const,
    provider_family: p.provider, endpoint_digest: p.endpoint_digest, epoch: p.epoch,
    root_nonce: p.root_nonce, activation_fingerprint: p.fingerprint, config_digest: p.config_digest,
    model: p.model, price_version: p.price_version,
    booted_at: "2026-10-17T11:59:50.000Z", heartbeat_at: clock().toISOString(), expires_at: "2026-10-17T12:00:15.000Z",
  };
}

it.each(["missing", "invalid", "old-valid"] as const)("decision configured policy denies a %s mirror even with valid enabled SQL and caller-supplied historical context", (kind) => {
  const f = fixture();
  try {
    expect(evaluateConfiguredDecisionPolicy(f.context).ready).toBe(true);
    const path = join(f.root, "decision-activation.json"), original = readFileSync(path);
    if (kind === "missing") rmSync(path);
    if (kind === "invalid") writeFileSync(path, '{"SYNTHETIC":"not an activation profile"}');
    if (kind === "old-valid") { f.store.disable(1); writeFileSync(path, original); }
    expect(evaluateConfiguredDecisionPolicy({ ...f.context, profile: f.profile }).ready).toBe(false);
    expect(readDecisionActivation(f.runtime.control, f.root)).toBeUndefined();
  } finally { f.close(); }
});

it("the decision loader cannot pair a control database with an unrelated root", () => {
  const f = fixture();
  try {
    const other = join(f.base, "unrelated");
    mkdirSync(other);
    expect(readDecisionActivation(f.runtime.control, other)).toBeUndefined();
  } finally { f.close(); }
});

it("a matching decision lease enables only its own profile comparison, without overwriting reasoning readiness", () => {
  const f = fixture();
  try {
    const reasoningPath = join(f.root, "worker-ready.json");
    writeFileSync(reasoningPath, "SYNTHETIC_REASONING_MARKER_MUST_STAY_UNTOUCHED");
    expect(readDecisionReadiness(f.root, clock()).state).toBe("absent");
    const r = writeDecisionReadiness(f.root, readiness(f.profile), clock);
    const configured = evaluateConfiguredDecisionPolicy(f.context);
    expect(decisionServerCapability({ configured, readiness: readDecisionReadiness(f.root, clock()), profile: f.profile })).toEqual({ ready: true, reason: "ready" });
    for (const change of [
      { epoch: r.epoch + 1 }, { root_nonce: "f".repeat(64) }, { activation_fingerprint: "f".repeat(64) },
      { config_digest: "f".repeat(64) }, { endpoint_digest: "f".repeat(64) },
      { model: "synthetic-other-model" }, { price_version: "synthetic-other-price" },
    ]) expect(decisionServerCapability({ configured, readiness: { state: "ready", readiness: { ...r, ...change } }, profile: f.profile }).ready).toBe(false);
    removeDecisionReadiness(f.root, randomUUID());
    expect(readDecisionReadiness(f.root, clock()).state).toBe("ready");
    removeDecisionReadiness(f.root, r.worker_id);
    expect(readDecisionReadiness(f.root, clock()).state).toBe("absent");
    expect(readFileSync(reasoningPath, "utf8")).toBe("SYNTHETIC_REASONING_MARKER_MUST_STAY_UNTOUCHED");
  } finally { f.close(); }
});

it("decision leases cannot be accepted with future heartbeats, excessive TTL, inverted boot time or expiry at now", () => {
  const f = fixture();
  try {
    for (const change of [
      { heartbeat_at: "2026-10-17T12:00:01.000Z" },
      { expires_at: "2026-10-17T12:00:16.000Z" },
      { booted_at: "2026-10-17T12:00:01.000Z" },
      { expires_at: clock().toISOString() },
    ]) {
      writeDecisionReadiness(f.root, { ...readiness(f.profile), ...change }, clock);
      expect(readDecisionReadiness(f.root, clock()).state).not.toBe("ready");
    }
  } finally { f.close(); }
});

it("a junction-routed decision readiness root cannot write, read as ready or remove the real lease", () => {
  const f = fixture();
  try {
    const r = writeDecisionReadiness(f.root, readiness(f.profile), clock);
    const link = join(f.base, "redirected-root");
    symlinkSync(f.root, link, "junction");
    expect(readDecisionReadiness(link, clock()).state).not.toBe("ready");
    expect(() => writeDecisionReadiness(link, r, clock)).toThrow();
    removeDecisionReadiness(link, r.worker_id);
    expect(readDecisionReadiness(f.root, clock()).state).toBe("ready");
  } finally { f.close(); }
});
