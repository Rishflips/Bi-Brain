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
