import type { Entity, Source } from "../contracts/index.ts";
import { STALE_DAYS } from "./brief.ts";
import { factText, valueText } from "./facts.ts";
import { findOpenQuestions, type OpenQuestion } from "./questions.ts";

export const ORIGINALS_LIMIT = 200;

export type FactEvidence = {
  source_id: string;
  source_version: number;
  start: number;
  end: number;
  quote: string;
  source_title: string;
};
export type FactView = {
  id: string;
  version: number;
  text: string;
  aspect: string;
  value: string;
  editable: boolean;
  edited_by_owner: boolean;
  checked_at: string;
  stale: boolean;
  evidence: FactEvidence[];
};
export type OriginalView = {
  id: string;
  version: number;
  title: string;
  captured_at: string;
  from: "you" | "agent" | "import";
  private: boolean;
};
export type ProjectView = {
  project: { id: string; title: string };
  facts: FactView[];
  questions: OpenQuestion[];
  questions_total: number;
  originals: OriginalView[];
  originals_total: number;
  waiting_for_review: number;
  needs_decision: Entity[];
  decision_history: Entity[];
};
export type ProjectViewInput = {
  project: { id: string; title: string };
  claims: Entity[];
  confirmations: Record<string, string>;
  sources: Source[];
  answered: ReadonlySet<string>;
  waiting: number;
  needsDecision: Entity[];
  decisionHistory: Entity[];
};

export function originFrom(origin: string): OriginalView["from"] {
  if (origin === "manual") return "you";
  return origin.startsWith("agent:") ? "agent" : "import";
}

const validTime = (t: unknown): t is string =>
  typeof t === "string" && !Number.isNaN(Date.parse(t));

export function buildProjectView(input: ProjectViewInput, now: Date): ProjectView {
  const staleBefore = now.getTime() - STALE_DAYS * 86_400_000;
  const titles = new Map(input.sources.map((s) => [s.id, s.title]));
  const facts = input.claims
    .filter((c) => Array.isArray(c.data.evidence) && c.data.evidence.length > 0)
    .map((c): FactView => {
      const times = [c.data.recorded_at, c.data.edited_at, input.confirmations[c.id]].filter(validTime);
      const checked_at = times.sort().at(-1) ?? c.created_at;
      return {
        id: c.id,
        version: c.version,
        text: factText(String(c.data.entity), String(c.data.aspect), c.data.value),
        aspect: String(c.data.aspect),
        value: valueText(c.data.value),
        editable: c.data.aspect === "statement",
        edited_by_owner: c.data.edited_by_owner === true,
        checked_at,
        stale: Date.parse(checked_at) < staleBefore,
        evidence: (c.data.evidence as Omit<FactEvidence, "source_title">[]).map((e) => ({
          source_id: e.source_id,
          source_version: e.source_version,
          start: e.start,
          end: e.end,
          quote: e.quote,
          source_title: titles.get(e.source_id) ?? "Original",
        })),
      };
    })
    .sort((a, b) => b.checked_at.localeCompare(a.checked_at));
  const questions = findOpenQuestions(input.sources, input.answered);
  const originals = input.sources
    .filter((s) => s.state === "active")
    .sort((a, b) => b.captured_at.localeCompare(a.captured_at))
    .map((s): OriginalView => ({
      id: s.id,
      version: s.version,
      title: s.title,
      captured_at: s.captured_at,
      from: originFrom(s.origin),
      private: s.visibility === "private",
    }));
  return {
    project: input.project,
    facts,
    questions: questions.items,
    questions_total: questions.total,
    originals: originals.slice(0, ORIGINALS_LIMIT),
    originals_total: originals.length,
    waiting_for_review: input.waiting,
    needs_decision: input.needsDecision,
    decision_history: input.decisionHistory,
  };
}
