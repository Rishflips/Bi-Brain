import { createHash } from "node:crypto";
import { detectSecrets } from "../storage/secrets.ts";

export const QUESTION_LIMIT = 20;
/** An original with more unmarked questions than this is probably a pasted chat. */
const MAX_UNMARKED_PER_SOURCE = 3;
const MARKED = /^(?:open question|still unclear|question|unclear)\s*:\s*/iu;

export type QuestionSource = {
  id: string;
  version: number;
  title: string;
  body: string;
  captured_at: string;
  state: string;
};
export type QuestionEvidence = {
  source_id: string;
  source_version: number;
  start: number;
  end: number;
  quote: string;
};
export type OpenQuestion = {
  signature: string;
  text: string;
  source_title: string;
  captured_at: string;
  evidence: QuestionEvidence;
};

type Part = { quote: string; start: number; marked: boolean };

/** Sentences with code-point offsets into the body. A line break always ends one. */
function sentences(body: string, offset = 0): { quote: string; start: number }[] {
  const chars = Array.from(body);
  const out: { quote: string; start: number }[] = [];
  let start = 0;
  const flush = (end: number) => {
    const raw = chars.slice(start, end).join("");
    const quote = raw.trim();
    if (!quote) return;
    const lead = Array.from(raw).length - Array.from(raw.trimStart()).length;
    out.push({ quote, start: offset + start + lead });
  };
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (c === "\n" || c === "\r") {
      flush(i);
      start = i + 1;
    } else if (
      (c === "?" || c === "." || c === "!") &&
      (i + 1 === chars.length || /\s/u.test(chars[i + 1]))
    ) {
      flush(i + 1);
      start = i + 1;
    }
  }
  flush(chars.length);
  return out;
}

/** A marked line is one question, taken whole. Other lines are split into sentences. */
function parts(body: string): Part[] {
  const out: Part[] = [];
  let offset = 0;
  const pieces = body.split(/(\r\n|\n|\r)/u);
  for (let i = 0; i < pieces.length; i += 2) {
    const line = pieces[i];
    const trimmed = line.trim();
    if (MARKED.test(trimmed)) {
      const lead = Array.from(line).length - Array.from(line.trimStart()).length;
      out.push({ quote: trimmed, start: offset + lead, marked: true });
    } else {
      for (const p of sentences(line, offset)) out.push({ ...p, marked: false });
    }
    offset += Array.from(line).length + Array.from(pieces[i + 1] ?? "").length;
  }
  return out;
}

/** The same question written twice, or with different spacing, gets one signature. Hashed so stored answers keep none of its words. */
export function questionSignature(text: string): string {
  const normal = text
    .normalize("NFC")
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .replace(/[\s?.!]+$/u, "")
    .trim();
  return normal ? createHash("sha256").update(normal).digest("hex") : "";
}

export function findOpenQuestions(
  sources: QuestionSource[],
  answered: ReadonlySet<string>,
  limit = QUESTION_LIMIT,
): { items: OpenQuestion[]; total: number } {
  const seen = new Set<string>();
  const items: OpenQuestion[] = [];
  const newestFirst = sources
    .filter((s) => s.state === "active")
    .sort((a, b) => b.captured_at.localeCompare(a.captured_at));
  for (const s of newestFirst) {
    const found = parts(s.body);
    const unmarked = found.filter((p) => !p.marked && p.quote.endsWith("?"));
    const allowUnmarked = unmarked.length <= MAX_UNMARKED_PER_SOURCE;
    for (const part of found) {
      if (!part.marked && !(allowUnmarked && part.quote.endsWith("?"))) continue;
      const text = part.quote.replace(MARKED, "").trim();
      const length = Array.from(text).length;
      if (length < 6 || length > 300) continue;
      if (detectSecrets(part.quote).length) continue;
      const signature = questionSignature(text);
      if (!signature || seen.has(signature) || answered.has(signature)) continue;
      seen.add(signature);
      items.push({
        signature,
        text,
        source_title: s.title,
        captured_at: s.captured_at,
        evidence: {
          source_id: s.id,
          source_version: s.version,
          start: part.start,
          end: part.start + Array.from(part.quote).length,
          quote: part.quote,
        },
      });
    }
  }
  return { items: items.slice(0, limit), total: items.length };
}
