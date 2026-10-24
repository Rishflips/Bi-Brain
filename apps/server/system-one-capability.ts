import type { Storage } from "../../packages/storage/index.ts";

/** The worker must have beaten its heart this recently for sorting help to be offered. */
export const WORKER_FRESH_MS = 30_000;
const WORKER_REASON = "Sorting help needs BiBrain's background worker to be running.";

/**
 * Whether the local server may accept the sorting-help consent.
 *
 * The server never sees the credential (`scripts/run.mjs` strips it), so it asks
 * the worker: ready only when the worker published `system_one_status` as
 * configured AND its heartbeat is fresh by this brain's clock. It returns a
 * boolean and a plain sentence; it never grants authority on its own.
 */
export function systemOneCapability(store: Storage, clock: () => Date) {
  return (): { ready: boolean; reason: string } => {
    try {
      const status = store.setting<{ configured?: boolean; reason?: string } | null>("system_one_status", null);
      const beat = store.setting<string | null>("worker_heartbeat", null);
      const age = beat ? clock().getTime() - Date.parse(beat) : Number.POSITIVE_INFINITY;
      if (status?.configured === true && age >= 0 && age < WORKER_FRESH_MS) return { ready: true, reason: "ready" };
      if (status && status.configured !== true && status.reason) return { ready: false, reason: status.reason };
    } catch {
      /* An unreadable setting is "not ready", never "ready". */
    }
    return { ready: false, reason: WORKER_REASON };
  };
}
