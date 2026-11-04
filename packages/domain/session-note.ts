import { z } from "zod";

/** Code points of marker-line text the hook may send; the CLI cuts to this before posting. */
export const SESSION_NOTE_MAX = 4000;
/** Saved notes per session; a chatty session stops writing after this many. */
export const SESSION_NOTES_PER_SESSION = 12;
/** Content-free log rows kept; the per-connection counters live in their own keys and never fall off. */
export const SESSION_NOTE_LOG_MAX = 200;
/** The same cap as brain_note's lines: a longer line drops only itself. */
export const SESSION_LINE_MAX = 300;
const DECISIONS_MAX = 10;
const QUESTIONS_MAX = 10;
const TOPIC_MAX = 120;

/** The cheap client-side check, mirrored in apps/cli/lib.mjs (a test keeps them equal): does any line start with a marker? */
export const MARKER_LINE = /^\s*(?:[-*•]\s*)?(?:\*\*)?(?:decided|open question|still unclear|question|unclear|next step)\s*:/imu;

export const sessionNoteSchema = z
  .object({
    session_id: z.string().regex(/^[0-9a-f]{64}$/u),
    client: z.enum(["claude-code", "codex", "cursor", "other"]).default("other"),
    text: z.string().min(1).refine((v) => Array.from(v).length <= SESSION_NOTE_MAX, "The text is cut to 4,000 characters before it is sent."),
  })
  .strict();

export type ParsedSessionNote = { decisions: { topic: string; decision: string }[]; open_questions: string[]; next_step?: string };

const clean = (line: string) =>
  line
    .trim()
    .replace(/^[-*•]\s*/u, "")
    .replace(/\*\*/gu, "")
    .trim();
const fits = (s: string) => s.length > 0 && Array.from(s).length <= SESSION_LINE_MAX;

/**
 * Marker lines only: "Decided: <topic>: <decision>", "Open question: ..." (also Question, Unclear, Still unclear) and "Next step: ...".
 * The topic ends at the first colon followed by whitespace, so a URL in the decision stays whole. A Decided line without a topic is left out,
 * and so is any line over SESSION_LINE_MAX or inside a ``` fence. Free text is never copied. Null unless at least one decision or question qualifies: a next step
 * alone is ordinary prose in an agent reply.
 */
export function parseSessionNote(text: string): ParsedSessionNote | null {
  const out: ParsedSessionNote = { decisions: [], open_questions: [] };
  // Lines inside a ``` fence are quoted code or output, not the agent's own markers: they are skipped.
  let fenced = false;
  for (const raw of text.split(/\r?\n/u)) {
    if (/^\s*```/u.test(raw)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const line = clean(raw);
    const decided = /^decided\s*:\s*(.+)$/iu.exec(line);
    if (decided) {
      const m = /^([^:\r\n]{1,120}):\s+(.+)$/u.exec(decided[1].trim());
      if (m && Array.from(m[1].trim()).length <= TOPIC_MAX && fits(m[2].trim())) out.decisions.push({ topic: m[1].trim(), decision: m[2].trim() });
      continue;
    }
    const question = /^(?:open question|still unclear|question|unclear)\s*:\s*(.+)$/iu.exec(line);
    if (question) {
      if (fits(question[1].trim())) out.open_questions.push(question[1].trim());
      continue;
    }
    const next = /^next step\s*:\s*(.+)$/iu.exec(line);
    if (next && fits(next[1].trim())) out.next_step = next[1].trim();
  }
  // The latest lines win when a reply has more than the caps: the last decisions and questions, and the last next step.
  out.decisions = out.decisions.slice(-DECISIONS_MAX);
  out.open_questions = out.open_questions.slice(-QUESTIONS_MAX);
  if (!out.decisions.length && !out.open_questions.length) return null;
  return out;
}
