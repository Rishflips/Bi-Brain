/**
 * Managed paid-activation gate.
 *
 * This batch keeps managed paid processing OFF in every case, including a
 * positive operator policy and an explicit `BRAIN_MANAGED_ALLOW_PAID=1` flag.
 * The pure gate can report that a policy is *ready*, but the public runtime
 * metadata must never advertise functional connected processing while the
 * managed worker still denies it, so `managedPaidAvailable` is hard-false and
 * `main.ts` keeps its unavailable provider.
 */
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

/** Managed paid processing is not enabled in this batch, regardless of policy. */
export const managedPaidAvailable = false;

export const managedPaidNotEnabledMessage =
  "Managed paid processing is not enabled; saved work stays available.";

/** Reads the operator activation flag; only the operator process controls it. */
export function managedAllowPaidFlag(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.BRAIN_MANAGED_ALLOW_PAID ?? "").trim() === "1";
}
