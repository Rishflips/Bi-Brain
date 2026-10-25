import { z } from "zod";
import type { RecallMatch } from "../storage/recall-index.ts";
import { questionWords } from "./ask.ts";
import { STALE_DAYS } from "./brief.ts";

export const RECALL_QUERY_MAX = 500;
export const RECALL_LIMIT_DEFAULT = 8;
export const RECALL_LIMIT_MAX = 20;
export const CANDIDATES_PER_LIST = 60;
export const RRF_K = 60;
export const MAX_TERMS = 12;
export const MAX_CHUNKS_PER_SOURCE = 2;
export const NEAR_MISSES_MAX = 3;
export const NO_MATCH_NEXT_STEP =
  "Nothing recorded matches. Tell the user this is not in the brain and do not infer it. Try brain_recall with the person, project or thing as the user named it, or brain_open with a known id.";
export const FOUND_NEXT_STEP = "Use these as evidence and cite the ids. brain_open returns a full item.";

export const recallInputSchema = z
  .object({
    query: z.string().trim().min(1).refine((v) => Array.from(v).length <= RECALL_QUERY_MAX, "Ask in up to 500 characters."),
    project_id: z.string().min(1).max(100).optional(),
    history: z.boolean().default(false),
    limit: z.number().int().min(1).max(RECALL_LIMIT_MAX).default(RECALL_LIMIT_DEFAULT),
  })
  .strict();

export type FtsQuery = { terms: string[]; match: string | null; phrase: string | null };
const quoted = (s: string) => '"' + s.replace(/"/g, '""') + '"';

/** Never passes user text as an FTS expression: quoted terms joined by OR, a prefix form of the last term, a phrase for 2–5 words. */
export function buildFtsQuery(query: string): FtsQuery {
  const terms = questionWords(query).slice(0, MAX_TERMS);
  if (!terms.length) return { terms: [], match: null, phrase: null };
  const parts = terms.map(quoted);
  parts.push(quoted(terms[terms.length - 1]) + "*");
  const words = query.trim().split(/\s+/u).filter(Boolean);
  const phrase = words.length >= 2 && words.length <= 5 ? quoted(query.trim()) : null;
  return { terms, match: parts.join(" OR "), phrase };
}

export function rrf(lists: string[][], k = RRF_K): Map<string, number> {
  const out = new Map<string, number>();
  for (const list of lists) list.forEach((key, i) => out.set(key, (out.get(key) ?? 0) + 1 / (k + i + 1)));
  return out;
}

export function recencyBoost(capturedAt: string, now: Date): number {
  const ageDays = Math.max(0, (now.getTime() - Date.parse(capturedAt)) / 86_400_000);
  return 1 + 0.15 * Math.exp(-ageDays / 90);
}

export type Candidate = { key: string; row: RecallMatch; fused: number; lists: string[] };
export const candidateKey = (r: RecallMatch) => (r.kind === "fact" ? `fact:${r.ref_id}` : `original:${r.ref_id}:${r.ordinal}`);

/** RRF over the three lists, then the deterministic multipliers. Highest first. */
export function fuse(lists: { facts: RecallMatch[]; originals: RecallMatch[]; phrase: RecallMatch[] }, now: Date): Candidate[] {
  const rows = new Map<string, RecallMatch>();
  const members = new Map<string, string[]>();
  const keyed = (name: keyof typeof lists) =>
    lists[name].map((r) => {
      const key = candidateKey(r);
      if (!rows.has(key) || rows.get(key)!.score > r.score) rows.set(key, r);
      members.set(key, [...(members.get(key) ?? []), name]);
      return key;
    });
  const fused = rrf([keyed("facts"), keyed("originals"), keyed("phrase")]);
  return [...fused.entries()]
    .map(([key, base]) => {
      const row = rows.get(key)!;
      let score = base;
      // A distilled fact outranks raw text. History rows only reach here when the caller asked for history, where they are equally wanted.
      if (row.kind === "fact") score *= 1.5;
      if (row.kind === "original") score *= recencyBoost(row.recorded_at, now) * row.boost;
      return { key, row, fused: score, lists: members.get(key) ?? [] };
    })
    .sort((a, b) => b.fused - a.fused || a.key.localeCompare(b.key));
}

export type Freshness = "current" | "stale" | "replaced" | "retired";
const validTime = (t: unknown): t is string => typeof t === "string" && !Number.isNaN(Date.parse(t));

/** `replaced` when a current claim supersedes it, `retired` for any other non-current claim (history mode only), else stale or current by age. */
export function factFreshness(claim: { id: string; created_at: string; data: any }, confirmations: Record<string, string>, replacedBy: string | null, now: Date) {
  const checked_at = [claim.data.recorded_at, claim.data.edited_at, confirmations[claim.id]].filter(validTime).sort().at(-1) ?? claim.created_at;
  const stale = Date.parse(checked_at) < now.getTime() - STALE_DAYS * 86_400_000;
  const retired = claim.data.status !== undefined && claim.data.status !== "current";
  return { checked_at, freshness: (replacedBy ? "replaced" : retired ? "retired" : stale ? "stale" : "current") as Freshness };
}

export type FactHit = {
  kind: "fact"; id: string; project: { id: string; title: string }; text: string; recorded_at: string; checked_at: string;
  freshness: Freshness; replaced_by: string | null; evidence: { source_id: string; source_version: number; quote: string }[]; why: string[]; score: number;
};
export type OriginalHit = {
  kind: "original"; id: string; version: number; project: { id: string; title: string }; title: string; quote: string; start: number; end: number;
  captured_at: string; freshness: "current"; why: string[]; score: number;
};
export type RecallHit = FactHit | OriginalHit;
export type NearMiss = { kind: "fact" | "original"; id: string; title: string; reason: string };
export type RecallStatus = "found" | "partial" | "no_match";
export type RecallResult = {
  status: RecallStatus;
  as_of: string;
  searched: { query: string; projects: { id: string; title: string }[]; history: boolean; candidates: number; index_complete: boolean };
  hits: RecallHit[];
  near_misses: NearMiss[];
  next_step: string;
};

/** A chunk overlapping a fact's evidence folds into the fact; at most `maxPerSource` chunks per source stay in hits. */
export function dedupe(hits: RecallHit[], maxPerSource = MAX_CHUNKS_PER_SOURCE): { kept: RecallHit[]; spill: RecallHit[] } {
  const facts = hits.filter((h): h is FactHit => h.kind === "fact");
  const kept: RecallHit[] = [];
  const spill: RecallHit[] = [];
  const perSource = new Map<string, number>();
  for (const h of hits) {
    if (h.kind === "fact") {
      kept.push(h);
      continue;
    }
    const covered = facts.some((f) => f.evidence.some((e) => e.source_id === h.id && e.source_version === h.version && evidenceOverlaps(e.quote, h)));
    if (covered) continue;
    const n = perSource.get(h.id) ?? 0;
    if (n >= maxPerSource) spill.push(h);
    else {
      perSource.set(h.id, n + 1);
      kept.push(h);
    }
  }
  return { kept, spill };
}
function evidenceOverlaps(quote: string, chunk: OriginalHit): boolean {
  return chunk.quote.includes(quote) || quote.includes(chunk.quote);
}

export type DeterministicSignals = {
  terms: string[];
  exactEntity: boolean;
  strong: boolean;
  /** The most query terms any of the top three candidates covers. */
  matched: number;
  candidates: number;
  topKind: "fact" | "original" | null;
  topNames: string[];
};
/** A candidate "matches" when it covers two query terms, or the single term of a one-word query. */
const matchNeeded = (terms: string[]) => Math.min(2, terms.length);

const coverage = (terms: string[], text: string) => {
  const own = new Set(questionWords(text));
  return terms.filter((t) => own.has(t)).length;
};
export function whyFor(terms: string[], text: string): string[] {
  const own = new Set(questionWords(text));
  const matched = terms.filter((t) => own.has(t));
  return matched.length ? [`matched: ${matched.join(", ")}`] : [];
}

/** The BM25-only reading of a ranked candidate list. This is the only path CI measures. */
export function deterministicSignals(terms: string[], ranked: Candidate[], entityNames: string[]): DeterministicSignals {
  const lowered = new Set(terms);
  const exactEntity = entityNames.some((n) => {
    const words = questionWords(n);
    return words.length > 0 && words.every((w) => lowered.has(w));
  });
  const top = ranked[0];
  const needed = matchNeeded(terms);
  let strong = false;
  if (top && terms.length > 0) {
    const n = coverage(terms, top.row.text);
    if (top.row.kind === "fact" && top.row.status === "current" && n >= needed) strong = true;
    else if (top.row.kind === "original" && n >= 2) {
      const next = ranked.find((c) => c.row.kind === "original" && c !== top);
      strong = !next || Math.abs(top.row.score) >= 1.3 * Math.abs(next.row.score);
    }
  }
  const matched = Math.max(0, ...ranked.slice(0, 3).map((c) => coverage(terms, c.row.text)));
  const topNames = [...new Set(ranked.slice(0, 3).map((c) => (c.row.kind === "fact" ? c.row.prefix.split(" · ").at(-1)! : c.row.prefix.split(" · ")[0])))];
  return { terms, exactEntity, strong, matched, candidates: ranked.length, topKind: top ? top.row.kind : null, topNames };
}

/** The tool status: any authorized candidate is at least `partial`. */
export function deterministicStatus(s: DeterministicSignals): RecallStatus {
  if (s.candidates === 0) return "no_match";
  return s.strong ? "found" : "partial";
}

/** The push level: quieter than the status. A single weak OR match is `none`; a matching candidate or an exact entity match is at least `pointer`. */
export function deterministicLevel(s: DeterministicSignals): "full" | "pointer" | "none" {
  if (s.strong) return "full";
  if (s.exactEntity || (s.candidates > 0 && s.terms.length > 0 && s.matched >= matchNeeded(s.terms))) return "pointer";
  return "none";
}

/** Compact plain text for clients that ignore structuredContent. */
export function renderRecallText(result: RecallResult): string {
  const lines = [`${result.status} · ${result.searched.candidates} candidates · ${result.searched.projects.map((p) => p.title).join(", ")}`];
  for (const h of result.hits)
    lines.push(
      h.kind === "fact"
        ? `fact ${h.id} · ${h.checked_at.slice(0, 10)} · ${h.freshness} · ${h.text}`
        : `original ${h.id} v${h.version} · ${h.captured_at.slice(0, 10)} · ${h.freshness} · ${h.title}: ${h.quote}`,
    );
  if (result.near_misses.length) lines.push(`near misses: ${result.near_misses.map((n) => `${n.kind} ${n.id} (${n.reason})`).join("; ")}`);
  lines.push(result.next_step);
  return lines.join("\n");
}
