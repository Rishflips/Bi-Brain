/** Where the owner's review of an agent-written original is recorded: one settings key per source, an ISO time. Local state like Watch; never exported, never backfilled. */
export const REVIEWED_KEY = (sourceId: string) => `source_reviewed:${sourceId}`;
/** Present only on agent-written items. Owner-captured items never carry it. */
export type WrittenBy = { agent: string; reviewed: boolean };

export const isAgentOrigin = (origin: string) => origin.startsWith("agent:");
export const grantOfOrigin = (origin: string) => (isAgentOrigin(origin) ? origin.slice("agent:".length) : null);

export function writtenByLabel(w: WrittenBy): string {
  return `From ${w.agent} · ${w.reviewed ? "reviewed" : "not yet reviewed"}`;
}

/** An original hit another agent wrote that the owner has not reviewed: never the owner's evidence. */
export function isUnreviewedAgent(h: { kind: string; written_by?: WrittenBy }): boolean {
  return h.kind === "original" && h.written_by !== undefined && !h.written_by.reviewed;
}
