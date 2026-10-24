import type { Entity } from "../contracts/index.ts";
import { factText, valueText as text } from "./facts.ts";

export type BriefKind = "correction" | "proposal" | "failed_job" | "file" | "agent_memory" | "memory" | "stale";
export type BriefEvidence = { source_id: string; source_version: number; quote: string };
export type BriefTarget = { type: "gate" | "proposal" | "job" | "claim" | "file"; id: string; version: number };
export type BriefItem = {
  signature: string;
  kind: BriefKind;
  project_id: string;
  title: string;
  why: string;
  before?: string;
  evidence: BriefEvidence[];
  target: BriefTarget;
  created_at: string;
  source_id?: string;
  aspect?: string;
  /** The proposed wording for a memory, so Fix can start from it. */
  value?: string;
  /** Sorting help judged this not worth showing first. It ranks after others of its kind and is never hidden. */
  quiet?: true;
};
export type BriefSourceRef = { id: string; project_id: string; body: string; captured_at: string };
export type BriefJob = { id: string; project_id: string; kind: string; attempts: number; created_at: string; source_id?: string };
export type BriefInput = {
  gates: Entity[];
  proposals: Entity[];
  claims: Entity[];
  failedJobs: BriefJob[];
  sources: BriefSourceRef[];
  dismissed: string[];
  confirmations: Record<string, string>;
  agentNames: Record<string, string>;
  /** Queued "file this note" suggestions whose source is still the version that was sorted. */
  fileSuggestions: Entity[];
  projectTitles: Record<string, string>;
};

export const BRIEF_LIMIT = 3;
export const STALE_DAYS = 21;
const MIN_STALE_MENTIONS = 2;
const RANK: Record<BriefKind, number> = { correction: 0, proposal: 1, failed_job: 2, file: 3, agent_memory: 4, memory: 5, stale: 6 };

const evidenceOf = (list: unknown): BriefEvidence[] =>
  (Array.isArray(list) ? list : [])
    .filter((e) => e && typeof e.source_id === "string" && typeof e.quote === "string" && e.quote)
    .map((e) => ({ source_id: e.source_id, source_version: Number(e.source_version) || 1, quote: e.quote }));

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const time = (v: unknown) => {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isNaN(t) ? 0 : t;
};
const escapeRegExp = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const factKey = (name: unknown, aspect: unknown) => `${String(name).trim().toLocaleLowerCase()}\u0000${String(aspect)}`;

/** Whether a queued review can be a Brief card: it needs evidence, a named fact and a value. */
export function gateFitsBrief(g: Entity): boolean {
  const field = g.data.field;
  return (
    evidenceOf(g.data.evidence).length > 0 &&
    !!field &&
    nonEmpty(g.data.entity) &&
    nonEmpty(field.aspect) &&
    field.value !== undefined &&
    field.value !== null &&
    text(field.value).trim().length > 0
  );
}

export function buildBrief(input: BriefInput, now: Date): { items: BriefItem[]; waiting: number } {
  const candidates: BriefItem[] = [];
  const corrected = new Set<string>();

  for (const g of input.gates) {
    if (g.data.status !== "queued") continue;
    if (!gateFitsBrief(g)) continue;
    const evidence = evidenceOf(g.data.evidence);
    const field = g.data.field;
    const actor = String(g.data.actor ?? "owner");
    const agentKey = actor.startsWith("agent:") ? actor.slice(6) : null;
    const agent = agentKey === null ? null : Object.hasOwn(input.agentNames, agentKey) ? input.agentNames[agentKey] : "A connected agent";
    const correction = g.data.correction === true;
    if (correction) corrected.add(factKey(g.data.entity, field.aspect));
    const before = correction && Array.isArray(g.data.conflicts)
      ? g.data.conflicts
          .filter((c: unknown): c is { value: unknown } => typeof c === "object" && c !== null)
          .map((c: { value: unknown }) => text(c.value))
          .filter(Boolean)
          .join("; ")
      : undefined;
    candidates.push({
      signature: `gate:${g.id}:${g.version}`,
      kind: correction ? "correction" : agent ? "agent_memory" : "memory",
      project_id: g.project_id,
      title: factText(g.data.entity, field.aspect, field.value),
      why: correction
        ? "A newer original disagrees with what you decided before."
        : agent
          ? `${agent} wrote this down while it worked.`
          : "BiBrain found this in something you saved.",
      ...(before ? { before } : {}),
      evidence,
      target: { type: "gate", id: g.id, version: g.version },
      created_at: g.created_at,
      aspect: field.aspect,
      value: text(field.value),
      ...(g.data.s1_quiet === true ? { quiet: true as const } : {}),
    });
  }

  for (const p of input.proposals) {
    if (p.data.status !== "ready" || !nonEmpty(p.data.title)) continue;
    const evidence = evidenceOf(p.data.evidence);
    if (!evidence.length) continue;
    candidates.push({
      signature: `proposal:${p.id}:${p.version}`,
      kind: "proposal",
      project_id: p.project_id,
      title: p.data.title,
      why: nonEmpty(p.data.reason) ? p.data.reason : "New saved material may affect this goal.",
      evidence,
      target: { type: "proposal", id: p.id, version: p.version },
      created_at: p.created_at,
    });
  }

  for (const j of input.failedJobs) {
    candidates.push({
      signature: `job:${j.id}:${j.attempts}`,
      kind: "failed_job",
      project_id: j.project_id,
      title: "A saved note could not be prepared.",
      why: j.source_id ? "Your original is safe. Try again, or open the original." : "Your original is safe. Try again.",
      evidence: [],
      target: { type: "job", id: j.id, version: j.attempts },
      created_at: j.created_at,
      ...(j.source_id ? { source_id: j.source_id } : {}),
    });
  }

  for (const f of input.fileSuggestions) {
    if (f.data.status !== "queued") continue;
    const source = input.sources.find((s) => s.id === f.data.source_id);
    if (!source) continue;
    const target = typeof f.data.to_project_id === "string" ? input.projectTitles[f.data.to_project_id] : undefined;
    candidates.push({
      signature: `file:${f.id}:${f.version}`,
      kind: "file",
      project_id: f.project_id,
      title: `File in ${target ?? "another project"}?`,
      why: "BiBrain suggests this note belongs there. Keep moves it; Dismiss leaves it in the Inbox.",
      evidence: [{ source_id: source.id, source_version: Number(f.data.source_version) || 1, quote: Array.from(source.body).slice(0, 140).join("") }],
      target: { type: "file", id: f.id, version: f.version },
      created_at: f.created_at,
      source_id: source.id,
    });
  }

  const staleBefore = now.getTime() - STALE_DAYS * 86_400_000;
  for (const c of input.claims) {
    if (c.data.status !== "current" || !nonEmpty(c.data.aspect)) continue;
    const evidence = evidenceOf(c.data.evidence);
    const name = typeof c.data.entity === "string" ? c.data.entity.trim() : "";
    if (!evidence.length || name.length < 3) continue;
    if (corrected.has(factKey(name, c.data.aspect))) continue;
    // The latest valid time, as on Your brain, so an owner edit counts as a check. The creation time is the fallback.
    const times = [input.confirmations[c.id], c.data.recorded_at, c.data.edited_at]
      .map((v) => (typeof v === "string" ? Date.parse(v) : NaN))
      .filter((t) => !Number.isNaN(t));
    const checkedAt = times.length ? Math.max(...times) : Date.parse(c.created_at);
    if (Number.isNaN(checkedAt) || !(checkedAt < staleBefore)) continue;
    const word = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, "iu");
    const mentions = input.sources.filter(
      (s) => s.project_id === c.project_id && Date.parse(s.captured_at) > checkedAt && word.test(s.body),
    ).length;
    if (mentions < MIN_STALE_MENTIONS) continue;
    const day = new Date(checkedAt).toISOString().slice(0, 10);
    candidates.push({
      signature: `stale:${c.id}:${c.version}:${mentions}`,
      kind: "stale",
      project_id: c.project_id,
      title: factText(name, c.data.aspect, c.data.value),
      why: `Last checked ${day}. ${mentions} originals saved since then mention ${name}.`,
      evidence,
      target: { type: "claim", id: c.id, version: c.version },
      created_at: c.created_at,
      aspect: c.data.aspect,
    });
  }

  const dismissed = new Set(input.dismissed);
  const open = candidates
    .filter((i) => !dismissed.has(i.signature))
    .sort((a, b) => RANK[a.kind] - RANK[b.kind] || (a.quiet ? 1 : 0) - (b.quiet ? 1 : 0) || time(b.created_at) - time(a.created_at) || a.signature.localeCompare(b.signature));
  return { items: open.slice(0, BRIEF_LIMIT), waiting: Math.max(0, open.length - BRIEF_LIMIT) };
}
