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

// Fold one code point at a time so folded positions map back to original code points.
const fold = (text: string) => Array.from(text, (ch) => ch.toLocaleLowerCase()).join("");

const SNIPPET_MAX = 240;

/** Code-point range of the first case-insensitive match, or null. */
function locate(text: string, folded: string): { start: number; length: number } | null {
  const points = Array.from(text);
  const lowered = points.map((ch) => ch.toLocaleLowerCase());
  const index = lowered.join("").indexOf(folded);
  if (index < 0) return null;
  let offset = 0;
  let start = 0;
  while (start < points.length && offset < index) offset += lowered[start++].length;
  let length = 0;
  for (let end = offset; end < index + folded.length && start + length < points.length; length++)
    end += lowered[start + length].length;
  return { start, length };
}

function windowAround(text: string, folded: string): string | null {
  const found = locate(text, folded);
  if (!found) return null;
  const points = Array.from(text);
  const back = Math.max(0, Math.min(80, SNIPPET_MAX - 2 - found.length));
  const from = Math.max(0, found.start - back);
  const lead = from > 0 ? 1 : 0;
  let to = from + SNIPPET_MAX - lead;
  const trail = to < points.length;
  if (trail) to -= 1;
  return (lead ? "…" : "") + points.slice(from, Math.min(to, points.length)).join("") + (trail ? "…" : "");
}

/** The sentence or line that matched, or a window of up to 240 code points around the match. */
export function snippetFor(body: string, title: string, query: string): string {
  const q = fold(query.trim());
  const parts = body.split(/(?<=[.?!])\s+|\n+/u).filter((part) => part.trim());
  const part = parts.find((candidate) => fold(candidate).includes(q));
  if (part) {
    const text = part.trim();
    return Array.from(text).length <= SNIPPET_MAX ? text : (windowAround(text, q) ?? text);
  }
  const spanning = windowAround(body.replace(/\s*\n+\s*/g, " ").trim(), q);
  if (spanning) return spanning;
  const first = Array.from((parts[0] ?? title).trim());
  return first.length > SNIPPET_MAX ? first.slice(0, SNIPPET_MAX - 1).join("") + "…" : first.join("");
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
