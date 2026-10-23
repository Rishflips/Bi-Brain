import type { Entity, Source } from "../contracts/index.ts";
import type { BriefEvidence } from "./brief.ts";

export type AskHit =
  | { type: "fact"; id: string; project_id: string; text: string; evidence: BriefEvidence[] }
  | { type: "original"; id: string; project_id: string; title: string; snippet: string; source_version: number };

const STOP = new Set(
  "the a an and or of to in on for is are was were be do does did what when which who how we our you your it this that with about from at by not have has had any before after out into then than also more just one can will would should there their them they its get got".split(" "),
);

export function questionWords(question: string): string[] {
  const words = question.toLocaleLowerCase().match(/[\p{L}\p{M}\p{N}$]+/gu) ?? [];
  return [...new Set(words.filter((w) => (w.length > 2 || /\p{N}/u.test(w)) && !STOP.has(w)).map((w) => w.replace(/s$/u, "")))];
}

function overlap(words: string[], text: string) {
  const own = new Set(questionWords(text));
  return words.reduce((n, w) => n + (own.has(w) ? 1 : 0), 0);
}

function bestSentence(body: string, title: string, words: string[]) {
  const parts = body.split(/(?<=[.?!])\s+|\n+/u).filter(Boolean);
  let best = parts[0] ?? body;
  let score = -1;
  for (const part of parts) {
    const n = overlap(words, part);
    if (n > score) { score = n; best = part; }
  }
  if (!best.trim()) best = title;
  return Array.from(best).length > 240 ? Array.from(best).slice(0, 237).join("") + "…" : best;
}

export function rankAnswers(question: string, claims: Entity[], sources: Source[], limit = 3): AskHit[] {
  const words = questionWords(question);
  if (!words.length) return [];
  const facts = claims
    .map((c) => {
      const text = c.data.aspect === "status" ? `${c.data.entity} is ${c.data.value}.` : `${c.data.entity}: ${c.data.value}`;
      return { c, text, n: overlap(words, text) };
    })
    .filter((x) => x.n > 0 && (x.c.data.evidence ?? []).length > 0)
    .sort((a, b) => b.n - a.n);
  const covered = new Set(facts.flatMap((x) => (x.c.data.evidence ?? []).map((e: { source_id: string }) => e.source_id)));
  const originals = sources
    .filter((s) => s.state === "active" && !covered.has(s.id))
    .map((s) => ({ s, n: overlap(words, `${s.title} ${s.body}`) }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n);
  const hits: AskHit[] = [
    ...facts.map(({ c, text }) => ({
      type: "fact" as const, id: c.id, project_id: c.project_id, text,
      evidence: (c.data.evidence ?? []).map((e: BriefEvidence) => ({ source_id: e.source_id, source_version: e.source_version, quote: e.quote })),
    })),
    ...originals.map(({ s }) => ({
      type: "original" as const, id: s.id, project_id: s.project_id, title: s.title,
      snippet: bestSentence(s.body, s.title, words), source_version: s.version,
    })),
  ];
  return hits.slice(0, limit);
}
