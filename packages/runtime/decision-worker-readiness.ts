import { lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { BrainError } from "../domain/logic.ts";
import { assertNonLinkedPathChain, assertTrustedManagedRoot } from "./managed-operator.ts";

/**
 * Bounded DECISION-stage worker readiness lease.
 *
 * It proves ONLY that at least one worker currently has the exact installed decision
 * provider path for this root. It is a physically separate file from the reasoning
 * `worker-ready.json` and is never interchangeable with it. The server reads it
 * readonly; in S1 production there is intentionally NO writer.
 */

export const DECISION_WORKER_READY_FILE = "decision-worker-ready.json";
export const DECISION_WORKER_READY_TTL_MS = 15_000;
const MAX_BYTES = 256 * 1024;

const HEX = /^[0-9a-f]{64}$/;
const decisionReadinessSchema = z
  .object({
    schema: z.literal(1),
    worker_id: z.string().uuid(),
    stage_scope: z.literal("decision"),
    provider_family: z.enum(["typesafe", "cloudflare"]),
    endpoint_digest: z.string().regex(HEX),
    epoch: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    root_nonce: z.string().regex(HEX),
    activation_fingerprint: z.string().regex(HEX),
    config_digest: z.string().regex(HEX),
    model: z.string().min(1).max(100),
    price_version: z.string().min(1).max(64),
    booted_at: z.string().datetime({ offset: true }),
    heartbeat_at: z.string().datetime({ offset: true }),
    expires_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type DecisionWorkerReadiness = z.infer<typeof decisionReadinessSchema>;

export function validateDecisionReadiness(input: unknown): DecisionWorkerReadiness {
  const parsed = decisionReadinessSchema.safeParse(input);
  if (!parsed.success)
    throw new BrainError("INVALID_INPUT", "Invalid decision worker readiness record.", 400);
  return parsed.data;
}

export function decisionWorkerReadinessPath(root: string): string {
  return resolve(root, DECISION_WORKER_READY_FILE);
}

function lstatOptional(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

/**
 * Atomically writes the decision lease (0600, tmp + rename). Never follows a link.
 * It is exercised only by tests / a future installed decision worker; S1 production has
 * no caller.
 */
export function writeDecisionReadiness(
  root: string,
  record: unknown,
  clock: () => Date = () => new Date(),
): DecisionWorkerReadiness {
  const value = validateDecisionReadiness(record);
  const binding = assertTrustedManagedRoot(root);
  const path = decisionWorkerReadinessPath(binding.root);
  const stat = lstatOptional(path);
  if (stat?.isSymbolicLink())
    throw new BrainError("UNAUTHORIZED", "The decision readiness marker is a link.", 401);
  void clock;
  const tmp = resolve(
    binding.root,
    `${DECISION_WORKER_READY_FILE}.${randomBytes(6).toString("hex")}.tmp`,
  );
  rmSync(tmp, { force: true });
  writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  try {
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  return value;
}

/**
 * Readonly. A missing/malformed/linked/oversized file is `absent`/`stale`, never a
 * throw. A lease is `ready` only when `booted_at <= heartbeat_at <= now < expires_at`,
 * `0 < expires_at - heartbeat_at <= 15s`, and `expires_at <= now + 15s`.
 */
export function readDecisionReadiness(
  root: string,
  now: Date,
): { state: "ready" | "stale" | "absent"; readiness?: DecisionWorkerReadiness } {
  try {
    assertNonLinkedPathChain(root);
  } catch {
    return { state: "stale" };
  }
  const stat = lstatOptional(decisionWorkerReadinessPath(root));
  if (!stat) return { state: "absent" };
  if (stat.isSymbolicLink() || !stat.isFile()) return { state: "stale" };
  if (stat.size > MAX_BYTES) return { state: "stale" };
  let raw: string;
  try {
    raw = readFileSync(decisionWorkerReadinessPath(root), "utf8");
  } catch {
    return { state: "stale" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: "stale" };
  }
  const result = decisionReadinessSchema.safeParse(parsed);
  if (!result.success) return { state: "stale" };
  const r = result.data;
  const booted = Date.parse(r.booted_at);
  const heartbeat = Date.parse(r.heartbeat_at);
  const expires = Date.parse(r.expires_at);
  const t = now.getTime();
  const ttl = expires - heartbeat;
  const ok =
    booted <= heartbeat &&
    heartbeat <= t &&
    t < expires &&
    ttl > 0 &&
    ttl <= DECISION_WORKER_READY_TTL_MS &&
    expires <= t + DECISION_WORKER_READY_TTL_MS;
  return ok ? { state: "ready", readiness: r } : { state: "stale", readiness: r };
}

/**
 * Removes the lease ONLY when it is a recognized, bounded, valid regular file whose
 * worker_id matches. Never deletes another worker's record and never recursively
 * removes an unrecognized path.
 */
export function removeDecisionReadiness(root: string, workerId: string): void {
  if (!decisionReadinessSchema.shape.worker_id.safeParse(workerId).success) return;
  try {
    assertNonLinkedPathChain(root);
  } catch {
    return;
  }
  const stat = lstatOptional(decisionWorkerReadinessPath(root));
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) return;
  if (stat.size > MAX_BYTES) return;
  let raw: string;
  try {
    raw = readFileSync(decisionWorkerReadinessPath(root), "utf8");
  } catch {
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  const result = decisionReadinessSchema.safeParse(parsed);
  if (!result.success || result.data.worker_id !== workerId) return;
  rmSync(decisionWorkerReadinessPath(root), { force: true });
}
