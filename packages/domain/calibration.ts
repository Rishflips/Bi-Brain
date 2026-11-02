/**
 * The calibration registry and report. Pure: rows in, counts and suggestions out. Nothing here opens a database,
 * prints, sends, or changes a threshold. The values are imported from the modules that own them, so the table cannot
 * drift. `scripts/calibrate.ts` feeds it the owner's rows from a read-only handle; the tests feed it synthetic rows.
 * It never sees note text: callers pass answers, feedback numbers and log rows only.
 */
import { S1_THRESHOLDS } from "./system-one.ts";
import { PUSH_THRESHOLDS, RECALL_LOG_MAX, type PushLevel } from "./recall-push.ts";
import { JUDGE_THRESHOLDS } from "./recall-judge.ts";
import { DENSE_FLOORS, DENSE_WEIGHT } from "./better-search.ts";
import { DURABLE_HIGH, DURABLE_LOW, TOPIC_MIN_CONFIDENCE } from "../storage/recall-index.ts";

export type Threshold = { id: string; value: number; where: string; meaning: string };
/** Every tunable line, read from the module that owns it. Ids are stable: the report, its docs and its tests name them. */
export const THRESHOLDS: readonly Threshold[] = [
  { id: "sorting.file", value: S1_THRESHOLDS.file, where: "packages/domain/system-one.ts S1_THRESHOLDS.file", meaning: 'A "File in …?" card needs at least this project confidence.' },
  { id: "sorting.review", value: S1_THRESHOLDS.review, where: "packages/domain/system-one.ts S1_THRESHOLDS.review", meaning: "A review is queued for a project with an active goal at or above this." },
  { id: "sorting.quiet", value: S1_THRESHOLDS.quiet, where: "packages/domain/system-one.ts S1_THRESHOLDS.quiet", meaning: "A card is quiet (ranks last, never hidden) below this show probability." },
  { id: "sorting.changes", value: S1_THRESHOLDS.changes, where: "packages/domain/system-one.ts S1_THRESHOLDS.changes", meaning: "A note counts as changing a recorded fact at or above this." },
  { id: "recall.durable_low", value: DURABLE_LOW, where: "packages/storage/recall-index.ts DURABLE_LOW", meaning: "An original's passages rank ×0.9 in recall below this durable probability." },
  { id: "recall.durable_high", value: DURABLE_HIGH, where: "packages/storage/recall-index.ts DURABLE_HIGH", meaning: "An original's passages rank ×1.15 at or above this durable probability." },
  { id: "recall.topic_min_confidence", value: TOPIC_MIN_CONFIDENCE, where: "packages/storage/recall-index.ts TOPIC_MIN_CONFIDENCE", meaning: "A topic name joins a passage's prefix at or above this confidence." },
  { id: "push.owner_world_full", value: PUSH_THRESHOLDS.owner_world_full, where: "packages/domain/recall-push.ts PUSH_THRESHOLDS.owner_world_full", meaning: "A judged push is full at or above this owner-world probability, when answered and one candidate is relevant." },
  { id: "push.owner_world_pointer", value: PUSH_THRESHOLDS.owner_world_pointer, where: "packages/domain/recall-push.ts PUSH_THRESHOLDS.owner_world_pointer", meaning: "A judged push is at least a pointer at or above this owner-world probability." },
  { id: "push.general_none", value: PUSH_THRESHOLDS.general_none, where: "packages/domain/recall-push.ts PUSH_THRESHOLDS.general_none", meaning: "A judged push is none at or above this general probability, unless an exact name matched." },
  { id: "push.rel_relevant", value: PUSH_THRESHOLDS.rel_relevant, where: "packages/domain/recall-push.ts PUSH_THRESHOLDS.rel_relevant", meaning: "A candidate counts as relevant for a full push at or above this." },
  { id: "judge.rel_keep", value: JUDGE_THRESHOLDS.rel_keep, where: "packages/domain/recall-judge.ts JUDGE_THRESHOLDS.rel_keep", meaning: "A judged candidate below this moves to near misses (exact names stay)." },
  { id: "judge.rel_relevant", value: JUDGE_THRESHOLDS.rel_relevant, where: "packages/domain/recall-judge.ts JUDGE_THRESHOLDS.rel_relevant", meaning: "A judged candidate at or above this counts as relevant." },
  { id: "judge.answered_margin", value: JUDGE_THRESHOLDS.answered_margin, where: "packages/domain/recall-judge.ts JUDGE_THRESHOLDS.answered_margin", meaning: "A judged result is found only when answered leads the next choice by this margin." },
  { id: "search.dense_weight", value: DENSE_WEIGHT, where: "packages/domain/better-search.ts DENSE_WEIGHT", meaning: "The weight of the meaning list in reciprocal-rank fusion (the word lists weigh 1)." },
  { id: "search.dense_floor.bge-m3", value: DENSE_FLOORS["bge-m3"], where: "packages/domain/better-search.ts DENSE_FLOORS", meaning: "A passage needs at least this cosine to be a meaning candidate for bge-m3." },
];

/** Suggestions need at least this many answers or feedback rows per question (ruling R5). */
export const MIN_SAMPLE = 20;
export const BINS = 10;
const HOLD = "Nothing changes unless you edit the code.";
const LOG_MAX_TEXT = RECALL_LOG_MAX.toLocaleString("en-US");

export type RecallLogRow = {
  at: string;
  grant_id: string;
  client: string;
  level: PushLevel;
  candidates: number;
  hits: number;
  latency_ms: number;
  judged: boolean;
  dense?: boolean;
  dense_top?: number;
  judge?: { owner_world: number; general: number; answered: "answered" | "partial" | "none" };
};
export type S1Answer = { id: string; type: "choice"; choice: string; confidence: number } | { id: string; type: "noul"; probability: number };
export type S1AnswerRow = { answers: S1Answer[] };
export type S1FeedbackRow = { question: string; choice: string | number; confidence: number; action: string };
export type CalibrationInput = { recall_log: RecallLogRow[]; s1_answers: S1AnswerRow[]; s1_feedback: S1FeedbackRow[]; embedded: { model: string; rows: number }[] };

export type Histogram = { n: number; bins: number[] };
export type KeptBuckets = { kept: number[]; dropped: number[] };
export type Suggestion = { threshold: string; current: number; suggested: number | null; sample: number; reason: string };
export type CalibrationReport = {
  thresholds: Threshold[];
  sorting: {
    answers: number;
    noul: Record<string, Histogram>;
    kind: Record<string, { n: number; mean_confidence: number }>;
    decisions: { n: number; under_durable_low: number; near_durable_low: number };
    review_near_line: number;
    feedback: Record<string, KeptBuckets>;
  };
  recall: {
    pushes: number;
    by_client: Record<string, Record<PushLevel, number>>;
    candidates: Record<"0" | "1-3" | "4-10" | "11+", number>;
    hits: Record<string, number>;
    judged: number;
    judge_answered: Record<string, number>;
    judge_owner_world: Histogram;
    dense: number;
    dense_top: Histogram;
    dense_near_floor: number;
    embedded: { model: string; rows: number }[];
  };
  suggestions: Suggestion[];
  gaps: string[];
};

/** Grouping keys come from stored rows: they live in prototype-free objects and are printed only when they look like plain ids. */
const bag = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/u;
const safeEntries = <T>(o: Record<string, T>): [string, T][] => Object.entries(o).filter(([k]) => SAFE_KEY.test(k));
/** A copy of a stored-key bag with only the plain-id keys, so the report object itself (text and --json alike) never carries an unsafe key. */
const safeBag = <T>(o: Record<string, T>): Record<string, T> => {
  const out = bag<T>();
  for (const [k, v] of safeEntries(o)) out[k] = v;
  return out;
};
const zeros = () => Array.from({ length: BINS }, () => 0);
/** Bin i holds [i/10, (i+1)/10); 1.0 falls in the last bin. */
const binOf = (v: number) => Math.min(BINS - 1, Math.max(0, Math.floor(v * BINS)));
/** The bin whose lower edge is a threshold (0.3 → 3), robust to 0.3 × 10 = 2.9999. */
const bandAbove = (line: number) => Math.min(BINS - 1, Math.max(0, Math.round(line * BINS)));
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const value = (id: string) => THRESHOLDS.find((t) => t.id === id)!.value;
const KEPT = new Set(["accept", "fix", "keep_file"]);
const DROPPED = new Set(["dismiss", "reject", "dismiss_file"]);

/** Ten bins over [0, 1]; non-finite values are skipped and not counted. */
export function histogram(values: number[]): Histogram {
  const bins = zeros();
  let n = 0;
  for (const v of values) {
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    bins[binOf(v)]++;
    n++;
  }
  return { n, bins };
}

const answersOf = (r: S1AnswerRow): S1Answer[] => (Array.isArray(r?.answers) ? r.answers : []);
const noul = (a: S1Answer[], id: string): number | null => {
  const x = a.find((q) => q?.id === id);
  return x?.type === "noul" && typeof x.probability === "number" && Number.isFinite(x.probability) ? x.probability : null;
};
const choice = (a: S1Answer[], id: string) => {
  const x = a.find((q) => q?.id === id);
  return x?.type === "choice" && typeof x.choice === "string" ? x : null;
};

function durableSuggestion(decisionDurables: number[], low: number): Suggestion {
  const threshold = "recall.durable_low";
  const sample = decisionDurables.length;
  if (sample < MIN_SAMPLE) return { threshold, current: low, suggested: null, sample, reason: `Not enough data yet (${sample} of ${MIN_SAMPLE} decisions with a durable answer).` };
  const under = decisionDurables.filter((d) => d < low).length;
  if (under * 4 < sample) return { threshold, current: low, suggested: null, sample, reason: `${under} of ${sample} decisions scored under ${low}; fewer than a quarter, so the line holds.` };
  const sorted = [...decisionDurables].sort((a, b) => a - b);
  const p10 = sorted[Math.min(sorted.length - 1, Math.floor(0.1 * sorted.length))];
  // Snap in integer hundredths so an on-grid value (0.15) stays on the grid; 0.15 / 0.05 is 2.9999999999999996.
  const suggested = Math.max(10, Math.floor(Math.round(p10 * 100) / 5) * 5) / 100;
  if (suggested >= low) return { threshold, current: low, suggested: null, sample, reason: `${under} of ${sample} decisions scored under ${low}, but the 10th percentile of decision durables rounds to ${suggested}, which is not below the line, so the line holds.` };
  return { threshold, current: low, suggested, sample, reason: `${under} of ${sample} decisions scored under ${low}, and a decision should count as lasting. The 10th percentile of decision durables, rounded down to 0.05, is ${suggested}.` };
}

function quietSuggestion(fb: KeptBuckets | undefined, quiet: number): Suggestion {
  const threshold = "sorting.quiet";
  const sample = fb ? sum(fb.kept) + sum(fb.dropped) : 0;
  if (!fb || sample < MIN_SAMPLE) return { threshold, current: quiet, suggested: null, sample, reason: `Not enough data yet (${sample} of ${MIN_SAMPLE} reviewed show answers).` };
  const above = bandAbove(quiet);
  const aboveN = fb.kept[above] + fb.dropped[above];
  const hi = Number((quiet + 0.1).toFixed(2));
  const lo = Number((quiet - 0.1).toFixed(2));
  if (aboveN >= 5 && fb.kept[above] * 4 < aboveN) return { threshold, current: quiet, suggested: hi, sample, reason: `Only ${fb.kept[above]} of ${aboveN} cards with show in [${quiet}, ${hi}) were kept; raising the quiet line to ${hi} would rank them last too.` };
  const below = above - 1;
  const belowN = below >= 0 ? fb.kept[below] + fb.dropped[below] : 0;
  if (below >= 0 && belowN >= 5 && fb.kept[below] * 2 >= belowN) return { threshold, current: quiet, suggested: lo, sample, reason: `${fb.kept[below]} of ${belowN} quiet cards with show in [${lo}, ${quiet}) were kept; lowering the line to ${lo} would show them in order.` };
  return { threshold, current: quiet, suggested: null, sample, reason: `Kept and dropped cards around ${quiet} do not point one way, so the line holds.` };
}

function fileSuggestion(fb: KeptBuckets | undefined, file: number): Suggestion {
  const threshold = "sorting.file";
  const sample = fb ? sum(fb.kept) + sum(fb.dropped) : 0;
  const note = `Cards under ${file} are never shown, so no evidence for lowering the line can appear here.`;
  if (!fb || sample < MIN_SAMPLE) return { threshold, current: file, suggested: null, sample, reason: `Not enough data yet (${sample} of ${MIN_SAMPLE} answered File in cards). ${note}` };
  const above = bandAbove(file);
  const aboveN = fb.kept[above] + fb.dropped[above];
  const hi = Number((file + 0.1).toFixed(2));
  if (aboveN >= 5 && fb.kept[above] * 2 < aboveN) return { threshold, current: file, suggested: hi, sample, reason: `Only ${fb.kept[above]} of ${aboveN} File in cards with confidence in [${file}, ${hi}) were kept; raising the line to ${hi} would skip most of them. ${note}` };
  return { threshold, current: file, suggested: null, sample, reason: `${sum(fb.kept)} of ${sample} File in cards were kept; the line holds. ${note}` };
}

export function calibrationReport(input: CalibrationInput): CalibrationReport {
  const gaps: string[] = [];
  // Sorting help: one answer per sorted note version; every number is a probability or a confidence, never a word.
  const answers = input.s1_answers.map(answersOf);
  const nouls = bag<Histogram>();
  for (const q of ["show", "review", "changes_fact", "durable"]) nouls[q] = histogram(answers.map((a) => noul(a, q)).filter((v): v is number => v !== null));
  const kind = bag<{ n: number; mean_confidence: number }>();
  const decisionDurables: number[] = [];
  for (const a of answers) {
    const k = choice(a, "kind");
    if (!k) continue;
    const slot = (kind[k.choice] ??= { n: 0, mean_confidence: 0 });
    const c = typeof k.confidence === "number" && Number.isFinite(k.confidence) ? k.confidence : 0;
    slot.mean_confidence = (slot.mean_confidence * slot.n + c) / (slot.n + 1);
    slot.n++;
    const d = noul(a, "durable");
    if (k.choice === "decision" && d !== null) decisionDurables.push(d);
  }
  for (const k of Object.values(kind)) k.mean_confidence = Number(k.mean_confidence.toFixed(3));
  const low = value("recall.durable_low");
  const decisions = {
    n: decisionDurables.length,
    under_durable_low: decisionDurables.filter((d) => d < low).length,
    near_durable_low: decisionDurables.filter((d) => d >= low && d < low + 0.05).length,
  };
  const reviewLine = value("sorting.review");
  const review_near_line = answers.map((a) => noul(a, "review")).filter((v): v is number => v !== null && v >= reviewLine - 0.1 && v < reviewLine).length;
  const feedback = bag<KeptBuckets>();
  for (const f of input.s1_feedback) {
    if (typeof f?.question !== "string" || typeof f.confidence !== "number" || !Number.isFinite(f.confidence)) continue;
    if (!KEPT.has(f.action) && !DROPPED.has(f.action)) continue;
    const slot = (feedback[f.question] ??= { kept: zeros(), dropped: zeros() });
    (KEPT.has(f.action) ? slot.kept : slot.dropped)[binOf(f.confidence)]++;
  }
  const suggestions = [durableSuggestion(decisionDurables, low), quietSuggestion(feedback.show, value("sorting.quiet")), fileSuggestion(feedback.project, value("sorting.file"))];
  gaps.push("No owner action records whether a review wake (sorting.review) was right, so that line has only a distribution.");
  gaps.push("durable and kind answers receive no owner feedback; the report shows their distributions only.");

  // Recall pushes: the content-free log (level, counts, latency, and the judge and meaning fields when those ran).
  const by_client = bag<Record<PushLevel, number>>();
  const candidates = { "0": 0, "1-3": 0, "4-10": 0, "11+": 0 };
  const hits = bag<number>();
  const ownerWorld: number[] = [];
  const denseTop: number[] = [];
  const judge_answered = bag<number>();
  let judged = 0;
  let dense = 0;
  let judgedWithout = 0;
  let denseWithout = 0;
  for (const r of input.recall_log) {
    if (!r || typeof r.client !== "string") continue;
    const c = (by_client[r.client] ??= { full: 0, pointer: 0, none: 0 });
    if (r.level === "full" || r.level === "pointer" || r.level === "none") c[r.level]++;
    const n = typeof r.candidates === "number" ? r.candidates : 0;
    candidates[n <= 0 ? "0" : n <= 3 ? "1-3" : n <= 10 ? "4-10" : "11+"]++;
    hits[String(typeof r.hits === "number" ? r.hits : 0)] = (hits[String(typeof r.hits === "number" ? r.hits : 0)] ?? 0) + 1;
    if (r.judged) {
      judged++;
      if (r.judge && typeof r.judge.owner_world === "number") {
        ownerWorld.push(r.judge.owner_world);
        // An older or malformed judge object without a known `answered` still counts for its probability, not for an answer.
        const answered = r.judge.answered;
        if (answered === "answered" || answered === "partial" || answered === "none") judge_answered[answered] = (judge_answered[answered] ?? 0) + 1;
      } else judgedWithout++;
    }
    if (r.dense) {
      dense++;
      if (typeof r.dense_top === "number") denseTop.push(r.dense_top);
      else denseWithout++;
    }
  }
  const floor = value("search.dense_floor.bge-m3");
  const dense_near_floor = denseTop.filter((v) => v >= floor && v < floor + 0.05).length;
  if (judgedWithout) gaps.push(`${judgedWithout} judged push${judgedWithout === 1 ? "" : "es"} carr${judgedWithout === 1 ? "ies" : "y"} no judge answers (recorded before this version); counted under judged only.`);
  if (denseWithout) gaps.push(`${denseWithout} push${denseWithout === 1 ? "" : "es"} used Better search with no passage over the floor, or before the top cosine was recorded; counted under dense only.`);
  gaps.push("The cosine floor hides every passage under it, so this report sees only what passed. npm run proof:search prints the room around the floor.");
  gaps.push(`The recall log keeps the last ${LOG_MAX_TEXT} pushes. Your own searches (Ask, Your brain) are never logged.`);

  return {
    thresholds: [...THRESHOLDS],
    sorting: { answers: input.s1_answers.length, noul: nouls, kind: safeBag(kind), decisions, review_near_line, feedback: safeBag(feedback) },
    recall: { pushes: input.recall_log.length, by_client: safeBag(by_client), candidates, hits: safeBag(hits), judged, judge_answered: safeBag(judge_answered), judge_owner_world: histogram(ownerWorld), dense, dense_top: histogram(denseTop), dense_near_floor, embedded: input.embedded },
    suggestions,
    gaps,
  };
}

const bar = (n: number, max: number) => "#".repeat(max > 0 ? Math.round((n / max) * 30) : 0);
function renderHistogram(label: string, h: Histogram): string[] {
  if (h.n === 0) return [`${label}: no data yet`];
  const max = Math.max(...h.bins);
  return [`${label} (n = ${h.n})`, ...h.bins.map((n, i) => `  ${(i / BINS).toFixed(1)}–${((i + 1) / BINS).toFixed(1)} | ${bar(n, max).padEnd(30)} ${n}`)];
}
function renderBuckets(label: string, b: KeptBuckets): string[] {
  const n = sum(b.kept) + sum(b.dropped);
  if (n === 0) return [`${label}: no reviewed cards yet`];
  return [`${label}: kept / dropped by confidence (n = ${n})`, ...b.kept.map((k, i) => `  ${(i / BINS).toFixed(1)}–${((i + 1) / BINS).toFixed(1)} | kept ${k}, dropped ${b.dropped[i]}`)];
}

/** Plain text for the terminal. Counts and numbers only; no note text can reach this function. */
export function renderCalibration(r: CalibrationReport): string {
  const lines: string[] = [];
  lines.push("BiBrain calibration report");
  lines.push("This report only reads your brain. It does not change your data or settings, and it sends nothing.");
  lines.push("");
  lines.push("Current thresholds");
  for (const t of r.thresholds) lines.push(`  ${t.id} = ${t.value}  (${t.where})`, `      ${t.meaning}`);
  lines.push("", `Sorting help: ${r.sorting.answers} sorted notes`);
  for (const [q, h] of safeEntries(r.sorting.noul)) lines.push(...renderHistogram(`  ${q === "changes_fact" ? "changes_fact (the sorting.changes line)" : q}`, h));
  const kinds = safeEntries(r.sorting.kind);
  lines.push(kinds.length ? `  kind: ${kinds.map(([k, v]) => `${k} ${v.n} (mean confidence ${v.mean_confidence})`).join(", ")}` : "  kind: no data yet");
  lines.push(`  decisions: ${r.sorting.decisions.n}; under recall.durable_low: ${r.sorting.decisions.under_durable_low}; within 0.05 above it: ${r.sorting.decisions.near_durable_low}`);
  lines.push(`  review answers within 0.1 under sorting.review: ${r.sorting.review_near_line}`);
  for (const [q, b] of safeEntries(r.sorting.feedback)) lines.push(...renderBuckets(`  ${q}`, b));
  lines.push("", `Recall pushes: ${r.recall.pushes} (the last ${LOG_MAX_TEXT} at most)`);
  for (const [client, levels] of safeEntries(r.recall.by_client)) lines.push(`  ${client}: full ${levels.full}, pointer ${levels.pointer}, none ${levels.none}`);
  lines.push(`  candidates: 0 → ${r.recall.candidates["0"]}, 1–3 → ${r.recall.candidates["1-3"]}, 4–10 → ${r.recall.candidates["4-10"]}, 11+ → ${r.recall.candidates["11+"]}`);
  lines.push(`  hits: ${safeEntries(r.recall.hits).sort(([a], [b]) => Number(a) - Number(b)).map(([k, v]) => `${k} → ${v}`).join(", ") || "no data yet"}`);
  lines.push(`  judged: ${r.recall.judged}; answered: ${safeEntries(r.recall.judge_answered).map(([k, v]) => `${k} ${v}`).join(", ") || "no data yet"}`);
  lines.push(...renderHistogram("  judge owner-world probability", r.recall.judge_owner_world));
  lines.push(`  with Better search: ${r.recall.dense}; near the floor (within 0.05 above it): ${r.recall.dense_near_floor}`);
  lines.push(...renderHistogram("  top cosine per push", r.recall.dense_top));
  lines.push(r.recall.embedded.length ? `  embedded passages: ${r.recall.embedded.map((e) => `${e.rows} (${e.model})`).join(", ")}` : "  embedded passages: none");
  lines.push("", "Suggestions (each is a suggestion only)");
  for (const s of r.suggestions) lines.push(`- ${s.threshold} = ${s.current}: ${s.suggested === null ? "hold." : `consider ${s.suggested}.`} ${s.reason} ${HOLD}`);
  lines.push("", "What this report cannot see");
  for (const g of r.gaps) lines.push(`- ${g}`);
  return lines.join("\n");
}
