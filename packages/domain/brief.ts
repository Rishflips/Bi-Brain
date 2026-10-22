import type { Entity } from "../contracts/index.ts";

export type BriefKind = "correction" | "proposal" | "failed_job" | "agent_memory" | "memory" | "stale";
export type BriefEvidence = { source_id: string; source_version: number; quote: string };
export type BriefTarget = { type: "gate" | "proposal" | "job" | "claim"; id: string; version: number };
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
};
export type BriefSourceRef = { id: string; project_id: string; body: string; captured_at: string };
export type BriefJob = { id: string; project_id: string; kind: string; attempts: number; created_at: string };
export type BriefInput = {
  gates: Entity[];
  proposals: Entity[];
  claims: Entity[];
  failedJobs: BriefJob[];
  sources: BriefSourceRef[];
  dismissed: string[];
  confirmations: Record<string, string>;
  agentNames: Record<string, string>;
};

export const BRIEF_LIMIT = 3;
export const STALE_DAYS = 21;
const MIN_STALE_MENTIONS = 2;
const RANK: Record<BriefKind, number> = { correction: 0, proposal: 1, failed_job: 2, agent_memory: 3, memory: 4, stale: 5 };

const evidenceOf = (list: unknown): BriefEvidence[] =>
  (Array.isArray(list) ? list : [])
    .filter((e) => e && typeof e.source_id === "string" && typeof e.quote === "string" && e.quote)
    .map((e) => ({ source_id: e.source_id, source_version: Number(e.source_version) || 1, quote: e.quote }));

function factText(entityName: string, aspect: string, value: unknown) {
  return aspect === "status" ? `${entityName} is ${String(value)}.` : `${entityName}: ${String(value)}`;
}

export function buildBrief(input: BriefInput, now: Date): { items: BriefItem[]; waiting: number } {
  const candidates: BriefItem[] = [];

  for (const g of input.gates) {
    if (g.data.status !== "queued") continue;
    const evidence = evidenceOf(g.data.evidence);
    if (!evidence.length || !g.data.field) continue;
    const actor = String(g.data.actor ?? "owner");
    const agent = actor.startsWith("agent:") ? input.agentNames[actor.slice(6)] ?? "A connected agent" : null;
    const correction = g.data.correction === true;
    const before = correction
      ? (g.data.conflicts ?? []).map((c: { value: unknown }) => String(c.value)).join("; ")
      : undefined;
    candidates.push({
      signature: `gate:${g.id}:${g.version}`,
      kind: correction ? "correction" : agent ? "agent_memory" : "memory",
      project_id: g.project_id,
      title: factText(String(g.data.entity), g.data.field.aspect, g.data.field.value),
      why: correction
        ? "A newer original disagrees with what you decided before."
        : agent
          ? `${agent} wrote this down while it worked.`
          : "BiBrain found this in something you saved.",
      ...(before ? { before } : {}),
      evidence,
      target: { type: "gate", id: g.id, version: g.version },
      created_at: g.created_at,
    });
  }

  for (const p of input.proposals) {
    if (p.data.status !== "ready") continue;
    const evidence = evidenceOf(p.data.evidence);
    if (!evidence.length) continue;
    candidates.push({
      signature: `proposal:${p.id}:${p.version}`,
      kind: "proposal",
      project_id: p.project_id,
      title: String(p.data.title),
      why: String(p.data.reason),
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
      why: "Your original is safe. Try again, or open the original.",
      evidence: [],
      target: { type: "job", id: j.id, version: j.attempts },
      created_at: j.created_at,
    });
  }

  const staleBefore = now.getTime() - STALE_DAYS * 86_400_000;
  for (const c of input.claims) {
    if (c.data.status !== "current") continue;
    const evidence = evidenceOf(c.data.evidence);
    const name = String(c.data.entity ?? "").trim().toLocaleLowerCase();
    if (!evidence.length || name.length < 3) continue;
    const checkedAt = Date.parse(input.confirmations[c.id] ?? c.data.recorded_at ?? c.created_at);
    if (!(checkedAt < staleBefore)) continue;
    const mentions = input.sources.filter(
      (s) => s.project_id === c.project_id && Date.parse(s.captured_at) > checkedAt && s.body.toLocaleLowerCase().includes(name),
    ).length;
    if (mentions < MIN_STALE_MENTIONS) continue;
    const day = new Date(checkedAt).toISOString().slice(0, 10);
    candidates.push({
      signature: `stale:${c.id}:${c.version}:${mentions}`,
      kind: "stale",
      project_id: c.project_id,
      title: factText(String(c.data.entity), String(c.data.aspect), c.data.value),
      why: `Last checked ${day}. ${mentions} originals saved since then mention ${String(c.data.entity)}.`,
      evidence,
      target: { type: "claim", id: c.id, version: c.version },
      created_at: c.created_at,
    });
  }

  const dismissed = new Set(input.dismissed);
  const open = candidates
    .filter((i) => !dismissed.has(i.signature))
    .sort((a, b) => RANK[a.kind] - RANK[b.kind] || b.created_at.localeCompare(a.created_at));
  return { items: open.slice(0, BRIEF_LIMIT), waiting: Math.max(0, open.length - BRIEF_LIMIT) };
}
