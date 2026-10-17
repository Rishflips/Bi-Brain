import { lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { BrainError } from "../domain/logic.ts";
import {
  assertNonLinkedPathChain,
  assertTrustedManagedRoot,
} from "./managed-operator.ts";

/**
 * Bounded worker readiness lease.
 *
 * It proves ONLY that at least one worker process currently has the exact installed
 * provider path for this root — never model quality, never that every worker is
 * configured, and never authority. The server reads it readonly; the worker (and
 * only its own worker_id) writes and removes it. No secret, key, prompt or hash of a
 * key is ever stored.
 */

export const WORKER_READY_FILE = "worker-ready.json";
export const WORKER_READY_TTL_MS = 15_000;
const MAX_BYTES = 256 * 1024;

const HEX = /^[0-9a-f]{64}$/;
const readinessSchema = z
  .object({
    schema: z.literal(1),
    worker_id: z.string().uuid(),
    epoch: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    root_nonce: z.string().regex(HEX),
    activation_fingerprint: z.string().regex(HEX),
    config_digest: z.string().regex(HEX),
    provider: z.literal("openai"),
    model: z.string().min(1).max(100),
    price_version: z.string().min(1).max(64),
    endpoint_class: z.literal("openai_responses"),
    booted_at: z.string().datetime({ offset: true }),
    heartbeat_at: z.string().datetime({ offset: true }),
    expires_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type WorkerReadiness = z.infer<typeof readinessSchema>;

export function validateWorkerReadiness(input: unknown): WorkerReadiness {
  const parsed = readinessSchema.safeParse(input);
  if (!parsed.success)
    throw new BrainError("INVALID_INPUT", "Invalid worker readiness record.", 400);
  return parsed.data;
}

export function workerReadinessPath(root: string): string {
  return resolve(root, WORKER_READY_FILE);
}

function lstatOptional(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

/** Atomically writes the lease (0600, tmp + rename). Never follows a link. */
export function writeWorkerReadiness(root: string, record: unknown): WorkerReadiness {
  const value = validateWorkerReadiness(record);
  const binding = assertTrustedManagedRoot(root);
  const path = workerReadinessPath(binding.root);
  const stat = lstatOptional(path);
  if (stat?.isSymbolicLink())
    throw new BrainError("UNAUTHORIZED", "The worker readiness marker is a link.", 401);
  const tmp = resolve(
    binding.root,
    `${WORKER_READY_FILE}.${randomBytes(6).toString("hex")}.tmp`,
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

/** A fixed instant (deterministic callers) or a trusted clock sampled at read time. */
export type ReadinessInstant = Date | (() => Date);

/**
 * Readonly. A missing/malformed/linked/oversized file is `absent`/`stale`, never a
 * throw, so the server metadata path stays available. A lease is `ready` only when
 * `booted_at <= heartbeat_at <= now < expires_at`, `0 < expires_at - heartbeat_at
 * <= 15s`, and `expires_at <= now + 15s` (a natural future TTL is required; a
 * far-future expiry is stale).
 *
 * `now` may be a trusted clock function. It is then invoked AFTER the lease has
 * been read, so a heartbeat an independent worker publishes during the same
 * request can never look like a future heartbeat. The strict `heartbeat <= now`
 * rule and the TTL bounds are unchanged; only the sampling instant moves.
 */
export function readWorkerReadiness(
  root: string,
  now: ReadinessInstant,
): { state: "ready" | "stale" | "absent"; readiness?: WorkerReadiness } {
  // Fresh trusted path chain on every read: a symlinked/junction alias of a real
  // root must never be followed to a live lease. No DDL, no root creation.
  try {
    assertNonLinkedPathChain(root);
  } catch {
    return { state: "stale" };
  }
  const stat = lstatOptional(workerReadinessPath(root));
  if (!stat) return { state: "absent" };
  if (stat.isSymbolicLink() || !stat.isFile()) return { state: "stale" };
  if (stat.size > MAX_BYTES) return { state: "stale" };
  let raw: string;
  try {
    raw = readFileSync(workerReadinessPath(root), "utf8");
  } catch {
    return { state: "stale" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: "stale" };
  }
  const result = readinessSchema.safeParse(parsed);
  if (!result.success) return { state: "stale" };
  const r = result.data;
  const booted = Date.parse(r.booted_at);
  const heartbeat = Date.parse(r.heartbeat_at);
  const expires = Date.parse(r.expires_at);
  // Sample the trusted clock only now, after the lease content was read.
  const t = (typeof now === "function" ? now() : now).getTime();
  const ttl = expires - heartbeat;
  const ok =
    booted <= heartbeat &&
    heartbeat <= t &&
    t < expires &&
    ttl > 0 &&
    ttl <= WORKER_READY_TTL_MS &&
    expires <= t + WORKER_READY_TTL_MS;
  return ok ? { state: "ready", readiness: r } : { state: "stale", readiness: r };
}

/**
 * Removes the lease ONLY when it is a recognized, bounded, valid regular file whose
 * worker_id matches. Never deletes another worker's record and never recursively
 * removes an unrecognized path.
 */
export function removeWorkerReadiness(root: string, workerId: string): void {
  if (!readinessSchema.shape.worker_id.safeParse(workerId).success) return;
  // Never follow a linked alias to a real lease it does not own.
  try {
    assertNonLinkedPathChain(root);
  } catch {
    return;
  }
  const stat = lstatOptional(workerReadinessPath(root));
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) return;
  if (stat.size > MAX_BYTES) return;
  let raw: string;
  try {
    raw = readFileSync(workerReadinessPath(root), "utf8");
  } catch {
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  const result = readinessSchema.safeParse(parsed);
  if (!result.success || result.data.worker_id !== workerId) return;
  rmSync(workerReadinessPath(root), { force: true });
}
