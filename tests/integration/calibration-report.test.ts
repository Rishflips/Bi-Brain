import { describe, expect, it } from "vitest";
import { BINS, MIN_SAMPLE, THRESHOLDS, calibrationReport, histogram, renderCalibration, type CalibrationInput, type RecallLogRow, type S1AnswerRow } from "../../packages/domain/calibration.ts";
import { S1_THRESHOLDS } from "../../packages/domain/system-one.ts";
import { PUSH_THRESHOLDS } from "../../packages/domain/recall-push.ts";
import { JUDGE_THRESHOLDS } from "../../packages/domain/recall-judge.ts";
import { DENSE_FLOORS, DENSE_WEIGHT } from "../../packages/domain/better-search.ts";
import { DURABLE_LOW } from "../../packages/storage/recall-index.ts";

const value = (id: string) => THRESHOLDS.find((t) => t.id === id)?.value;
const answer = (over: { kind?: string; durable?: number; show?: number; review?: number }): S1AnswerRow => ({
  answers: [
    { id: "kind", type: "choice", choice: over.kind ?? "note", confidence: 0.8 },
    { id: "show", type: "noul", probability: over.show ?? 0.9 },
    { id: "review", type: "noul", probability: over.review ?? 0.1 },
    { id: "durable", type: "noul", probability: over.durable ?? 0.5 },
  ],
});
const row = (over: Partial<RecallLogRow>): RecallLogRow => ({ at: "2026-11-01T09:00:00.000Z", grant_id: "g", client: "codex", level: "none", candidates: 0, hits: 0, latency_ms: 3, judged: false, ...over });
const empty: CalibrationInput = { recall_log: [], s1_answers: [], s1_feedback: [], embedded: [] };

describe("the threshold registry", () => {
  it("reads every value from the module that owns it and has unique ids", () => {
    expect(value("recall.durable_low")).toBe(DURABLE_LOW);
    expect(value("recall.durable_low")).toBe(0.2);
    expect(value("sorting.quiet")).toBe(S1_THRESHOLDS.quiet);
    expect(value("sorting.file")).toBe(S1_THRESHOLDS.file);
    expect(value("sorting.review")).toBe(S1_THRESHOLDS.review);
    expect(value("push.owner_world_full")).toBe(PUSH_THRESHOLDS.owner_world_full);
    expect(value("judge.rel_keep")).toBe(JUDGE_THRESHOLDS.rel_keep);
    expect(value("search.dense_weight")).toBe(DENSE_WEIGHT);
    expect(value("search.dense_floor.bge-m3")).toBe(DENSE_FLOORS["bge-m3"]);
    expect(new Set(THRESHOLDS.map((t) => t.id)).size).toBe(THRESHOLDS.length);
    for (const t of THRESHOLDS) expect(t.where).toMatch(/^packages\//u);
  });
});

describe("histogram", () => {
  it("has ten bins over [0, 1], puts 1.0 in the last bin and skips non-numbers", () => {
    const h = histogram([0, 0.05, 0.1, 0.99, 1, Number.NaN, Number.POSITIVE_INFINITY]);
    expect(h.n).toBe(5);
    expect(h.bins).toHaveLength(BINS);
    expect(h.bins[0]).toBe(2);
    expect(h.bins[1]).toBe(1);
    expect(h.bins[9]).toBe(2);
  });
});

describe("the calibration report", () => {
  it("holds every suggestion while the sample is small, and says how much is missing", () => {
    const r = calibrationReport({ ...empty, s1_answers: [answer({ kind: "decision", durable: 0.23 })] });
    expect(r.sorting.answers).toBe(1);
    expect(r.sorting.decisions).toEqual({ n: 1, under_durable_low: 0, near_durable_low: 1 });
    const durable = r.suggestions.find((s) => s.threshold === "recall.durable_low")!;
    expect(durable.suggested).toBeNull();
    expect(durable.reason).toContain(`1 of ${MIN_SAMPLE}`);
    for (const s of r.suggestions) expect(s.suggested).toBeNull();
  });
  it("suggests a lower durable line only when a quarter or more of decisions fall under it", () => {
    const many = [...Array.from({ length: 8 }, () => answer({ kind: "decision", durable: 0.17 })), ...Array.from({ length: 16 }, () => answer({ kind: "decision", durable: 0.9 }))];
    const r = calibrationReport({ ...empty, s1_answers: many });
    const s = r.suggestions.find((x) => x.threshold === "recall.durable_low")!;
    expect(s.sample).toBe(24);
    expect(s.suggested).toBe(0.15);
    expect(s.reason).toContain("8 of 24");
    const few = [...Array.from({ length: 2 }, () => answer({ kind: "decision", durable: 0.17 })), ...Array.from({ length: 22 }, () => answer({ kind: "decision", durable: 0.9 }))];
    expect(calibrationReport({ ...empty, s1_answers: few }).suggestions.find((x) => x.threshold === "recall.durable_low")!.suggested).toBeNull();
  });
  it("reads kept and dropped show feedback by bucket and suggests raising the quiet line when the band above it is mostly dropped", () => {
    const fb = [
      ...Array.from({ length: 10 }, () => ({ question: "show", choice: 0.35, confidence: 0.35, action: "dismiss" })),
      ...Array.from({ length: 2 }, () => ({ question: "show", choice: 0.35, confidence: 0.35, action: "accept" })),
      ...Array.from({ length: 8 }, () => ({ question: "show", choice: 0.9, confidence: 0.9, action: "fix" })),
    ];
    const r = calibrationReport({ ...empty, s1_feedback: fb });
    expect(r.sorting.feedback.show.kept[3]).toBe(2);
    expect(r.sorting.feedback.show.dropped[3]).toBe(10);
    expect(r.sorting.feedback.show.kept[9]).toBe(8);
    const s = r.suggestions.find((x) => x.threshold === "sorting.quiet")!;
    expect(s.suggested).toBe(0.4);
    expect(s.reason).toContain("2 of 12");
  });
  it("never suggests lowering the file line, because cards under it are never shown", () => {
    const r = calibrationReport({ ...empty, s1_feedback: Array.from({ length: 25 }, () => ({ question: "project", choice: "p1", confidence: 0.9, action: "keep_file" })) });
    const s = r.suggestions.find((x) => x.threshold === "sorting.file")!;
    expect(s.suggested).toBeNull();
    expect(s.reason).toContain("never shown");
  });
  it("counts pushes by client and level, judged and dense shares, and names older rows as gaps instead of throwing", () => {
    const log: RecallLogRow[] = [
      row({ client: "claude-code", level: "full", candidates: 5, hits: 3 }),
      row({ client: "claude-code", level: "pointer", candidates: 2, hits: 1, judged: true, judge: { owner_world: 0.42, general: 0.5, answered: "partial" } }),
      row({ client: "codex", level: "none", candidates: 12, hits: 0, judged: true }),
      row({ client: "codex", level: "none", candidates: 1, hits: 0, dense: true, dense_top: 0.47 }),
      row({ client: "codex", level: "none", candidates: 0, hits: 0, dense: true }),
    ];
    const r = calibrationReport({ ...empty, recall_log: log, embedded: [{ model: "ollama:bge-m3:none", rows: 40 }] });
    expect(r.recall.pushes).toBe(5);
    expect(r.recall.by_client["claude-code"]).toEqual({ full: 1, pointer: 1, none: 0 });
    expect(r.recall.by_client.codex).toEqual({ full: 0, pointer: 0, none: 3 });
    expect(r.recall.candidates).toEqual({ "0": 1, "1-3": 2, "4-10": 1, "11+": 1 });
    expect(r.recall.judged).toBe(2);
    expect(r.recall.judge_answered).toEqual({ partial: 1 });
    expect(r.recall.judge_owner_world.n).toBe(1);
    expect(r.recall.dense).toBe(2);
    expect(r.recall.dense_top.n).toBe(1);
    expect(r.recall.dense_near_floor).toBe(1);
    expect(r.recall.embedded).toEqual([{ model: "ollama:bge-m3:none", rows: 40 }]);
    expect(r.gaps.some((g) => g.includes("1 judged push"))).toBe(true);
    expect(r.gaps.some((g) => g.includes("1 push") && g.includes("Better search"))).toBe(true);
  });
  it("skips malformed sorting rows instead of throwing, and never lets a stored key reach the prototype or the page", () => {
    const r = calibrationReport({
      ...empty,
      s1_answers: [
        { answers: [] },
        { answers: [{ id: "show", type: "noul", probability: "x" as unknown as number }] },
        { answers: undefined as unknown as never },
        { answers: [{ id: "kind", type: "choice", choice: "__proto__", confidence: 0.9 }] },
      ],
      s1_feedback: [{ question: "show", choice: 0.5, confidence: "0.5" as unknown as number, action: "accept" }],
    });
    expect(r.sorting.answers).toBe(4);
    expect(r.sorting.noul.show.n).toBe(0);
    expect(r.sorting.feedback.show).toBeUndefined();
    expect(({} as { n?: unknown }).n).toBeUndefined();
    expect(Object.getPrototypeOf(r.sorting.kind)).toBeNull();
    expect(renderCalibration(r)).not.toContain("__proto__");
  });
  it("renders plain text that states it does not change your data, lists every threshold, and ends every suggestion the same way", () => {
    const text = renderCalibration(calibrationReport(empty));
    expect(text).toContain("This report only reads your brain. It does not change your data or settings, and it sends nothing.");
    for (const t of THRESHOLDS) expect(text).toContain(`${t.id} = ${t.value}`);
    const suggestionLines = text.split("\n").filter((l) => l.startsWith("- recall.") || l.startsWith("- sorting."));
    expect(suggestionLines.length).toBeGreaterThan(0);
    for (const l of suggestionLines) expect(l.endsWith("Nothing changes unless you edit the code.")).toBe(true);
    expect(text).not.toMatch(/model|mcp|token/iu);
  });
});
