import { managedCapability, managedDecisionCapability } from "../../packages/runtime/managed.ts";

/**
 * Thin server-facing surface over the runtime capability helper.
 *
 * `managedCapability` derives the CURRENT shared-loader configured policy plus the
 * fresh worker readiness lease for the trusted root/control and returns a boolean
 * and a static, content-free reason. It never reads a caller field, an audit row,
 * another account or a global total, and it never grants admission.
 *
 * The pure `managedActivationGate` remains for unit-level policy reasoning.
 */
export { managedCapability };

/**
 * The separate DECISION-stage deployment capability (a live decision profile plus a
 * fresh `decision-worker-ready.json` lease). It is a distinct accessor from the
 * reasoning capability and is never interchangeable with it.
 */
export { managedDecisionCapability };

export type ManagedActivation = {
  /** The policy inputs alone would permit paid work; not an availability claim. */
  policy_ready: boolean;
  reason: "blocked" | "policy_unconfigured" | "off" | "policy_ready";
};

export function managedActivationGate(input: {
  allowPaid: boolean;
  hasPeriod: boolean;
  hasServicePolicy: boolean;
  hasAccountPolicy: boolean;
  blocked: boolean;
}): ManagedActivation {
  if (input.blocked) return { policy_ready: false, reason: "blocked" };
  if (!input.hasPeriod || !input.hasServicePolicy || !input.hasAccountPolicy)
    return { policy_ready: false, reason: "policy_unconfigured" };
  if (!input.allowPaid) return { policy_ready: false, reason: "off" };
  return { policy_ready: true, reason: "policy_ready" };
}

export const managedPaidNotEnabledMessage =
  "Managed paid processing is not enabled; saved work stays available.";

/** Static, content-free public reason. Never a path, id, model, key or amount. */
export function managedPaidReason(reason: string): string {
  switch (reason) {
    case "ready":
      return "Connected model processing is available for this deployment.";
    case "key_missing":
      return "Managed paid processing is not configured by the operator; saved work stays available.";
    case "worker_absent":
    case "worker_stale":
      return "Connected model processing is starting; saved work stays available.";
    case "worker_config_mismatch":
    case "profile_invalid":
    case "audit_stale":
    case "epoch_mismatch":
    case "epoch_uninitialized":
      return "Connected model processing is unavailable; saved work stays available.";
    default:
      return managedPaidNotEnabledMessage;
  }
}

/**
 * Static, content-free public reason for the separate DECISION-stage deployment
 * availability. It never names a model, endpoint, key, path, queue, token or
 * classifier, and it never reads another account or a global total.
 */
export function managedDecisionReason(reason: string): string {
  switch (reason) {
    case "ready":
      return "Additional background checks are available for this deployment.";
    default:
      // S1 ships no production decision worker/readiness writer, so an absent or
      // stale lease is reported as plain unavailability, never "starting".
      return "Additional background checks are not available on this installation.";
  }
}

/** Reads the operator activation flag; only the operator process controls it. */
export function managedAllowPaidFlag(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.BRAIN_MANAGED_ALLOW_PAID ?? "").trim() === "1";
}
