import type { Entity, Source } from "../contracts/index.ts";
import { factText } from "./facts.ts";

export const SEARCH_LIMIT = 20;

export type FactHit = {
  id: string;
  project_id: string;
  text: string;
  evidence: { source_id: string; source_version: number; start: number; end: number; quote: string }[];
};
export type OriginalHit = {
  id: string;
  project_id: string;
  version: number;
  title: string;
  snippet: string;
};

const fold = (text: string) => text.toLocaleLowerCase();

/** The sentence or line that matched, cut to 240 code points. */
export function snippetFor(body: string, title: string, query: string): string {
  const q = fold(query);
  const parts = body.split(/(?<=[.?!])\s+|\n+/u).filter((part) => part.trim());
  const hit = parts.find((part) => fold(part).includes(q)) ?? parts[0] ?? title;
  const points = Array.from(hit.trim());
  return points.length > 240 ? points.slice(0, 237).join("") + "…" : points.join("");
}

export function findInBrain(
  query: string,
  claims: Entity[],
  sources: Source[],
  limit = SEARCH_LIMIT,
): { facts: FactHit[]; originals: OriginalHit[] } {
  const raw = query.trim();
  const q = fold(raw);
  if (!q) return { facts: [], originals: [] };
  const facts = claims
    .filter((c) => Array.isArray(c.data.evidence) && c.data.evidence.length > 0)
    .map((c) => ({ c, text: factText(String(c.data.entity), String(c.data.aspect), c.data.value) }))
    .filter(({ text }) => fold(text).includes(q))
    .slice(0, limit)
    .map(({ c, text }) => ({
      id: c.id,
      project_id: c.project_id,
      text,
      evidence: (c.data.evidence as FactHit["evidence"]).map((e) => ({
        source_id: e.source_id,
        source_version: e.source_version,
        start: e.start,
        end: e.end,
        quote: e.quote,
      })),
    }));
  const originals = sources
    .filter((s) => s.state === "active" && fold(`${s.title}\n${s.body}`).includes(q))
    .slice(0, limit)
    .map((s) => ({
      id: s.id,
      project_id: s.project_id,
      version: s.version,
      title: s.title,
      snippet: snippetFor(s.body, s.title, raw),
    }));
  return { facts, originals };
}
