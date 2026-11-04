/** Where the owner's review of an agent-written original is recorded: one settings key per source, an ISO time. Local state like Watch; never exported, never backfilled. */
export const REVIEWED_KEY = (sourceId: string) => `source_reviewed:${sourceId}`;
/** Present only on agent-written items. Owner-captured items never carry it. */
export type WrittenBy = { agent: string; reviewed: boolean };

export const isAgentOrigin = (origin: string) => origin.startsWith("agent:");
export const grantOfOrigin = (origin: string) => (isAgentOrigin(origin) ? origin.slice("agent:".length) : null);
/** The origin an agent-written original keeps when it is restored from an export: still agent-written, tied to no local grant. */
export const RESTORED_AGENT_ORIGIN = "agent:";

const IMPORT_NAME_MAX = 120;
/** The origin of an original brought in from an instruction file: `import:` plus the relative name, middle-truncated so it stays well inside the 200-character origin limit. */
export function importOrigin(path: string): string {
  const clean = Array.from(path.replace(/\p{Cc}/gu, "")).join("");
  const chars = Array.from(clean);
  const name = chars.length <= IMPORT_NAME_MAX ? clean : `${chars.slice(0, 60).join("")}…${chars.slice(-59).join("")}`;
  return name ? `import:${name}` : "import";
}
/** An origin read back from an export: a valid `import:<name>` is kept, anything else owner-side becomes plain `import`. Agent origins never pass through here. */
export function restoredImportOrigin(origin: string): string {
  if (!origin.startsWith("import:")) return "import";
  const name = origin.slice(7);
  return name && Array.from(name).length <= IMPORT_NAME_MAX && !/\p{Cc}/u.test(name) ? origin : "import";
}

export function writtenByLabel(w: WrittenBy): string {
  return `From ${w.agent} · ${w.reviewed ? "reviewed" : "not yet reviewed"}`;
}

/** An original hit another agent wrote that the owner has not reviewed: never the owner's evidence. */
export function isUnreviewedAgent(h: { kind: string; written_by?: WrittenBy }): boolean {
  return h.kind === "original" && h.written_by !== undefined && !h.written_by.reviewed;
}
