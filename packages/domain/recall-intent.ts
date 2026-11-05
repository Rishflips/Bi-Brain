import { questionWords } from "./ask.ts";
import { MAX_TERMS, type Candidate, type DeterministicSignals } from "./recall.ts";

export const RECALL_SESSION_TOPICS = "recall_session_topics";
export const SESSION_TOPIC_TTL_MS = 7_200_000;
export const SESSION_TOPICS_MAX = 20;
export type PromptIntent = { kind: "ack" | "continuation" | "decision" | "plain"; topicTerms: string[] };

/** Closed lists, compared after normalisation. The CLI keeps a copy of CONTINUATION_PROMPTS in apps/cli/lib.mjs; a test keeps them equal. */
export const CONTINUATION_PROMPTS: readonly string[] = [
  "continue", "go on", "keep going", "carry on", "proceed", "next", "resume", "pick up where we left off", "where were we", "where did we leave off",
  "what were we doing", "what did we decide", "what did we agree", "what did we pick", "what did we choose", "remind me where we are",
  "recap", "summarise where we are", "summarize where we are", "and then", "go ahead with that", "do that", "continue from there",
];
export const ACK_PROMPTS: readonly string[] = ["thanks", "thank you", "ok", "okay", "yes", "no", "sure", "great", "nice", "cool", "done", "lgtm", "good", "fine", "yep", "nope", "got it", "k", "ty", "thx", "perfect", "sounds good"];
/** The words a decision question is read without (after questionWords' trailing-s strip). */
export const DECISION_WORDS: ReadonlySet<string> = new Set([
  "decide", "decided", "decision", "pick", "picked", "choose", "chose", "chosen", "settle", "settled", "agree", "agreed", "been", "already",
  // Filler a decision question carries that names nothing, so never a topic word on its own.
  "yet", "finally", "actually", "ultimately", "eventually", "both", "two",
]);
/** A first-person subject: we, I, or "(the two|both) of us". A passive ("what was chosen…", "what was settled in court") has none and stays plain. */
const SUBJECT = String.raw`(?:we|i|(?:the\s+two|both)\s+of\s+us)`;
/** Not phrasal: "pick up", "pick it up", "pick the accent up", "pick off", "pick apart", "settle down" are not decisions. */
const NO_PARTICLE = String.raw`(?!(?:\s+\S+){0,2}?\s+(?:up|out|off|apart|down)\b)`;
/**
 * Two narrow shapes, both about what a first-person subject decided in the past: "did we (at most two words) decide/pick/choose/agree/
 * settle on/go with", and "have/had we|I, were we (already) decided/agreed/settled/picked/chosen". Never "do", "does", "should", "can",
 * "will", "you", "the team", a passive with no subject ("what was decided", "what has been chosen"), a phrasal verb, a transitive
 * "settle the invoice", or the noun phrase "the decision on": those are how-tos, plans, statements or other people's choices, and stay
 * plain. The unit test pins a list of ordinary prompts at zero false positives.
 */
const DECISION_INTENT = new RegExp(
  [
    String.raw`\bdid\s+${SUBJECT}\s+(?:\S+\s+){0,2}?(?:decide|pick|choose|agree|settle\s+(?:on|upon)|go\s+with)\b${NO_PARTICLE}`,
    String.raw`\b(?:(?:have|had)\s+(?:we|i)|were\s+we)\s+(?:already\s+)?(?:decided|agreed|settled|picked|chosen)\b${NO_PARTICLE}`,
  ].join("|"),
  "iu",
);

/** Lowercase, one space between words, no leading "ok," / "okay," / "please", no trailing punctuation. The same function lives in the CLI. */
export function normalizePrompt(prompt: string): string {
  return prompt.toLocaleLowerCase().replace(/\s+/gu, " ").trim().replace(/^(?:ok(?:ay)?,?\s+|please\s+)/u, "").replace(/[\s.!?…,:;]+$/u, "").trim();
}

export function promptIntent(prompt: string): PromptIntent {
  const n = normalizePrompt(prompt);
  if (ACK_PROMPTS.includes(n)) return { kind: "ack", topicTerms: [] };
  if (CONTINUATION_PROMPTS.includes(n)) return { kind: "continuation", topicTerms: [] };
  if (DECISION_INTENT.test(prompt)) {
    const topic = questionWords(prompt).filter((w) => !DECISION_WORDS.has(w)).slice(0, MAX_TERMS);
    return topic.length ? { kind: "decision", topicTerms: topic } : { kind: "continuation", topicTerms: [] };
  }
  return { kind: "plain", topicTerms: [] };
}

/**
 * The decision reading's evidence rule: it reaches `full` exactly as any prompt does, by covering two topic words, or when its single
 * topic word is in the name of the top fact's entity ("caterer" for "Launch party caterer"). One incidental shared word is at most a pointer.
 */
export function topicReadingEvidence(s: DeterministicSignals, top: Candidate | undefined): DeterministicSignals {
  if (!s.strong || s.terms.length >= 2) return s;
  const names = new Set(top?.row.kind === "fact" ? questionWords(top.row.prefix.split(" · ").at(-1) ?? "") : []);
  return s.terms.length === 1 && names.has(s.terms[0]) ? s : { ...s, strong: false };
}

/** Per session hash: the content words of the last prompt that found something, and when. Never the prompt, an id or a passage. */
export type SessionTopics = Record<string, { terms: string[]; at: string }>;
const live = (t: { at: string } | undefined, now: Date) => !!t && typeof t.at === "string" && Number.isFinite(Date.parse(t.at)) && now.getTime() - Date.parse(t.at) < SESSION_TOPIC_TTL_MS;
const wordsOf = (t: { terms: unknown }) => (Array.isArray(t.terms) ? t.terms.filter((w): w is string => typeof w === "string").slice(0, MAX_TERMS) : []);

/** Drops expired and malformed entries, replaces this session's, and keeps the 20 most recent. */
export function rememberTopic(topics: SessionTopics, session: string, terms: string[], now: Date): SessionTopics {
  const kept = Object.entries(topics ?? {}).filter(([k, t]) => k !== session && live(t, now) && wordsOf(t).length > 0);
  kept.push([session, { terms: terms.slice(0, MAX_TERMS), at: now.toISOString() }]);
  kept.sort((a, b) => Date.parse(b[1].at) - Date.parse(a[1].at));
  return Object.fromEntries(kept.slice(0, SESSION_TOPICS_MAX));
}

export function topicFor(topics: SessionTopics, session: string, now: Date): string[] | null {
  const t = topics?.[session];
  if (!live(t, now)) return null;
  const words = wordsOf(t!);
  return words.length ? words : null;
}

/** The store key: grant id and session hash, so one connection can never read or overwrite another's topic (both are validated ids, never free text). */
export function topicKey(grantId: string, sessionHash: string): string {
  return `${grantId}:${sessionHash}`;
}
