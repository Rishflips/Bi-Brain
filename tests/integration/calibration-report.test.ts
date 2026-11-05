import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LATEST_MIGRATION, Storage } from "../../packages/storage/index.ts";
import { Brain } from "../../packages/domain/service.ts";
import type { Principal } from "../../packages/contracts/index.ts";
import type { AskResult } from "../../packages/providers/system-one-ask.ts";
import { BINS, MIN_SAMPLE, THRESHOLDS, calibrationReport, histogram, meaningLeadFromLog, renderCalibration, suggestMeaningLead, type CalibrationInput, type RecallLogRow, type S1AnswerRow } from "../../packages/domain/calibration.ts";
import { S1_THRESHOLDS } from "../../packages/domain/system-one.ts";
import { PUSH_THRESHOLDS } from "../../packages/domain/recall-push.ts";
import { JUDGE_THRESHOLDS } from "../../packages/domain/recall-judge.ts";
import { DENSE_FLOORS, DENSE_WEIGHT } from "../../packages/domain/better-search.ts";
import type { MeaningLead } from "../../packages/domain/better-search.ts";
import { buildFixture } from "../eval/recall-fixture.ts";
import { embedFixture } from "../eval/dense-fixture.ts";
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
  it("keeps an on-grid durable percentile on the grid, snaps an off-grid one down, and never suggests under 0.1", () => {
    const withLow = (v: number) => [...Array.from({ length: 8 }, () => answer({ kind: "decision", durable: v })), ...Array.from({ length: 16 }, () => answer({ kind: "decision", durable: 0.9 }))];
    const at = (v: number) => calibrationReport({ ...empty, s1_answers: withLow(v) }).suggestions.find((x) => x.threshold === "recall.durable_low")!.suggested;
    expect(at(0.15)).toBe(0.15);
    expect(at(0.17)).toBe(0.15);
    expect(at(0.12)).toBe(0.1);
    expect(at(0.05)).toBe(0.1);
  });
  it("suggests lowering the quiet line when the band under it was mostly kept, and holds when kept and dropped do not point one way", () => {
    const kept = (n: number, c: number) => Array.from({ length: n }, () => ({ question: "show", choice: c, confidence: c, action: "accept" }));
    const dropped = (n: number, c: number) => Array.from({ length: n }, () => ({ question: "show", choice: c, confidence: c, action: "dismiss" }));
    const lower = calibrationReport({ ...empty, s1_feedback: [...kept(8, 0.25), ...dropped(4, 0.25), ...kept(8, 0.9)] }).suggestions.find((x) => x.threshold === "sorting.quiet")!;
    expect(lower.suggested).toBe(0.2);
    expect(lower.reason).toContain("8 of 12");
    const hold = calibrationReport({ ...empty, s1_feedback: kept(20, 0.9) }).suggestions.find((x) => x.threshold === "sorting.quiet")!;
    expect(hold.suggested).toBeNull();
    expect(hold.reason).toContain("do not point one way");
  });
  it("suggests raising the file line only when most cards just above it were dropped, and counts review answers near its line", () => {
    const fb = [
      ...Array.from({ length: 4 }, () => ({ question: "project", choice: "p1", confidence: 0.75, action: "keep_file" })),
      ...Array.from({ length: 21 }, () => ({ question: "project", choice: "p1", confidence: 0.75, action: "dismiss_file" })),
    ];
    const r = calibrationReport({ ...empty, s1_feedback: fb, s1_answers: [answer({ review: 0.65 }), answer({ review: 0.3 })] });
    const s = r.suggestions.find((x) => x.threshold === "sorting.file")!;
    expect(s.suggested).toBe(0.8);
    expect(s.reason).toContain("4 of 25");
    expect(r.sorting.review_near_line).toBe(1);
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
  it("drops unsafe stored keys from the report object itself, so the JSON carries none of them", () => {
    const r = calibrationReport({
      recall_log: [
        row({ client: "__proto__", level: "full", hits: 1 }),
        row({ client: "bad key!", level: "none" }),
        row({ client: "codex", level: "none", judged: true, judge: { owner_world: 0.4, general: 0.5, answered: "weird answer" as unknown as "none" } }),
        row({ client: "codex", level: "none", judged: true, judge: { owner_world: 0.4, general: 0.5, answered: "partial" } }),
      ],
      s1_answers: [
        { answers: [{ id: "kind", type: "choice", choice: "__proto__", confidence: 0.9 }] },
        { answers: [{ id: "kind", type: "choice", choice: "has space", confidence: 0.9 }] },
      ],
      s1_feedback: [
        { question: "__proto__", choice: "x", confidence: 0.5, action: "accept" },
        { question: "bad/key", choice: "x", confidence: 0.5, action: "dismiss" },
        { question: "show", choice: 0.5, confidence: 0.5, action: "accept" },
      ],
      embedded: [],
    });
    const json = JSON.stringify(r);
    for (const bad of ["__proto__", "bad key", "bad/key", "has space", "weird answer", "undefined"]) {
      expect(json).not.toContain(bad);
      expect(renderCalibration(r)).not.toContain(bad);
    }
    expect(Object.keys(r.recall.by_client)).toEqual(["codex"]);
    expect(Object.keys(r.sorting.feedback)).toEqual(["show"]);
    expect(r.recall.judge_answered).toEqual({ partial: 1 });
    expect(r.recall.judge_owner_world.n).toBe(2);
  });
  it("holds the durable line when the snapped suggestion would equal it", () => {
    // Twenty decisions, six under 0.2 (so a quarter is met) and a 10th percentile of 0.1999: it rounds to 0.2, which is the line.
    const durables = [...Array.from({ length: 6 }, () => 0.1999), ...Array.from({ length: 14 }, () => 0.6)];
    const r = calibrationReport({ ...empty, s1_answers: durables.map((d) => answer({ kind: "decision", durable: d })) });
    const s = r.suggestions.find((x) => x.threshold === "recall.durable_low")!;
    expect(s.suggested).toBeNull();
    expect(s.reason).toContain("the line holds");
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

const owner: Principal = { kind: "owner" };
const CANARY = "ZIRCON_SENTINEL";
let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.reverse()) fn();
  cleanup = [];
});
const ask = (over: { kind?: string; durable?: number; show?: number; review?: number }): AskResult => ({
  model: "clef-flash", usage: { input_tokens: 300, output_tokens: 0 }, cost_micro_usd: 27, price_version: "cf-clef-flash-2026-10-01", policy_version: "system-one-ask-v1",
  answers: [
    { id: "kind", type: "choice", choice: over.kind ?? "note", confidence: 0.9, probabilities: { decision: 0.025, fact: 0.025, question: 0.025, task: 0.025, note: 0.9 } },
    { id: "review", type: "noul", probability: over.review ?? 0.1 },
    { id: "show", type: "noul", probability: over.show ?? 0.9 },
    { id: "durable", type: "noul", probability: over.durable ?? 0.5 },
  ],
});
/** A synthetic brain written through the real paths: three sorted notes (one a decision at durable 0.23, one quiet), one kept and one dismissed review, and six recall-log rows. */
function syntheticBrain(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "calibrate-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "brain.sqlite");
  const s = new Storage(path, { vault: join(dir, "vault") });
  try {
    const b = new Brain(s, () => new Date("2026-11-01T09:00:00Z"), undefined, undefined, undefined, undefined, () => ({ ready: true, reason: "test" }));
    b.prefs(owner, { ...b.prefs(owner), enabled: true, decision_provider_enabled: true, daily_cap_micro_usd: 50_000, per_job_cap_micro_usd: 5_000 });
    const p = b.createProject(owner, "Northstar");
    const note = (title: string, body: string) => b.capture(owner, { project_id: p.id, title, body, visibility: "project", separate: true }) as any;
    const decision = note("Plan", `We decided Northstar ships with one plan ${CANARY}.`);
    b.recordSystemOneResult({ id: "j1", project_id: p.id }, decision.source_id, 1, ask({ kind: "decision", durable: 0.23 }));
    // The status grammar needs the bare line "<name> status <state>" with no full stop (as scripts/recall-agent-proof.ts:34 writes it);
    // "Hydra status paused." would create no gate and the dismissal below would have nothing to log against.
    const hydra = note("Hydra", "Hydra status paused");
    b.recordSystemOneResult({ id: "j2", project_id: p.id }, hydra.source_id, 1, ask({ kind: "fact", show: 0.2, review: 0.68 }));
    const status = note("Status", "The launch color is amber.");
    b.recordSystemOneResult({ id: "j3", project_id: p.id }, status.source_id, 1, ask({ kind: "fact", show: 0.9 }));
    // One kept review and one dismissed card, so s1_feedback has a kept and a dropped row for `show`.
    const kept = b.entities(owner, "gate").find((g) => g.data.raw_id === status.source_id)!;
    b.reviewGate(owner, kept.id, { action: "accept", expected_version: kept.version });
    const quietGate = b.entities(owner, "gate").find((g) => g.data.raw_id === hydra.source_id)!;
    const quietCard = b.brief(owner).items.find((i) => i.target.id === quietGate.id)!;
    b.dismissBriefItem(owner, { signature: quietCard.signature });
    // Written straight into settings in the documented row shape: Task 5's own tests cover the writer; this fixture covers the reader.
    s.set("recall_log", [
      { at: "2026-11-01T08:00:00.000Z", grant_id: "g1", client: "codex", level: "full", candidates: 5, hits: 3, latency_ms: 2, judged: false },
      { at: "2026-11-01T08:01:00.000Z", grant_id: "g1", client: "codex", level: "none", candidates: 0, hits: 0, latency_ms: 2, judged: false },
      { at: "2026-11-01T08:02:00.000Z", grant_id: "g2", client: "claude-code", level: "pointer", candidates: 2, hits: 1, latency_ms: 3, judged: true, judge: { owner_world: 0.4, general: 0.5, answered: "partial" } },
      { at: "2026-11-01T08:03:00.000Z", grant_id: "g2", client: "claude-code", level: "none", candidates: 3, hits: 0, latency_ms: 3, judged: true },
      { at: "2026-11-01T08:04:00.000Z", grant_id: "g2", client: "claude-code", level: "none", candidates: 1, hits: 0, latency_ms: 4, judged: false, dense: true, dense_top: 0.47 },
      { at: "2026-11-01T08:05:00.000Z", grant_id: "g2", client: "claude-code", level: "none", candidates: 0, hits: 0, latency_ms: 4, judged: false, dense: true },
    ]);
  } finally {
    // Unconditional, so a failing fixture never leaves an open handle that stops rmSync on Windows.
    s.close();
  }
  return { dir, path };
}
const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
/** A read-only open of a WAL database may create empty `-wal` and `-shm` sidecars; nothing else may appear. */
const SIDECARS = new Set(["brain.sqlite-wal", "brain.sqlite-shm"]);
const newFiles = (dir: string, before: string[]) => readdirSync(dir).filter((n) => !before.includes(n));
const run = (args: string[], env: Record<string, string | undefined> = {}) => {
  const e = { ...process.env, ...env };
  delete e.BRAIN_DB;
  for (const [k, v] of Object.entries(env)) if (v !== undefined) e[k] = v;
  return spawnSync(process.execPath, ["--import", "tsx", "scripts/calibrate.ts", ...args], { encoding: "utf8", env: e, timeout: 60_000, windowsHide: true });
};

describe("npm run calibrate", () => {
  it("prints the report from a synthetic brain, never a word of a note, and leaves the file byte-identical", () => {
    const { path, dir } = syntheticBrain();
    const seeded = new Storage(path, { vault: join(dir, "vault") });
    try {
      seeded.set("meaning_lead", { threshold: 0.63, key: "ollama:bge-m3:none", sample: 54, source: "proof:search", measured_at: "2026-11-06", applied_at: "2026-11-07T09:12:00.000Z" } satisfies MeaningLead);
    } finally {
      seeded.close();
    }
    const before = sha(path);
    const files = readdirSync(dir);
    const r = run(["--db", path]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Meaning matches can lead: 0.63, applied 2026-11-07");
    expect(r.stdout).toContain("This report only reads your brain. It does not change your data or settings, and it sends nothing.");
    expect(r.stdout).toContain("Sorting help: 3 sorted notes");
    expect(r.stdout).toContain("decisions: 1; under recall.durable_low: 0; within 0.05 above it: 1");
    expect(r.stdout).toContain("review answers within 0.1 under sorting.review: 1");
    expect(r.stdout).toContain("show: kept / dropped by confidence (n = 2)");
    expect(r.stdout).toContain("Recall pushes: 6");
    expect(r.stdout).toContain("codex: full 1, pointer 0, none 1");
    expect(r.stdout).toContain("claude-code: full 0, pointer 1, none 3");
    expect(r.stdout).toContain("judged: 2; answered: partial 1");
    expect(r.stdout).toContain("with Better search: 2; near the floor (within 0.05 above it): 1");
    expect(r.stdout).toContain("recall.durable_low = 0.2");
    expect(r.stdout).toContain("Nothing changes unless you edit the code.");
    expect(r.stdout + r.stderr).not.toContain(CANARY);
    expect(r.stdout + r.stderr).not.toContain("Hydra status paused");
    expect(r.stdout + r.stderr).not.toContain("launch color");
    expect(r.stderr).toBe("");
    expect(sha(path)).toBe(before);
    // The main file is byte-identical; a read-only WAL open may leave the two empty sidecars and nothing else.
    for (const n of newFiles(dir, files)) expect(SIDECARS.has(n)).toBe(true);
    const json = run(["--db", path, "--json"]);
    expect(json.status).toBe(0);
    const parsed = JSON.parse(json.stdout);
    expect(parsed.sorting.answers).toBe(3);
    expect(parsed.suggestions.find((s: any) => s.threshold === "recall.durable_low").suggested).toBeNull();
    expect(json.stdout).not.toContain(CANARY);
    expect(json.stdout).not.toContain("__proto__");
    expect(sha(path)).toBe(before);
    for (const n of newFiles(dir, files)) expect(SIDECARS.has(n)).toBe(true);
  }, 60_000);
  it("keeps unsafe stored keys out of the --json output of the script as well", () => {
    const { path, dir } = syntheticBrain();
    const s = new Storage(path, { vault: join(dir, "vault") });
    try {
      s.set("recall_log", [
        { at: "2026-11-01T08:00:00.000Z", grant_id: "g1", client: "__proto__", level: "full", candidates: 1, hits: 1, latency_ms: 2, judged: false },
        { at: "2026-11-01T08:01:00.000Z", grant_id: "g1", client: "bad key!", level: "none", candidates: 0, hits: 0, latency_ms: 2, judged: false },
        { at: "2026-11-01T08:02:00.000Z", grant_id: "g1", client: "codex", level: "none", candidates: 0, hits: 0, latency_ms: 2, judged: false },
      ]);
    } finally {
      s.close();
    }
    const json = run(["--db", path, "--json"]);
    expect(json.status).toBe(0);
    expect(json.stdout).not.toContain("__proto__");
    expect(json.stdout).not.toContain("bad key");
    expect(Object.keys(JSON.parse(json.stdout).recall.by_client)).toEqual(["codex"]);
    const text = run(["--db", path]);
    expect(text.stdout).not.toContain("__proto__");
    expect(text.stdout).not.toContain("bad key");
  }, 60_000);
  it("reads the same report while another process holds the brain open in WAL mode, and honours BRAIN_DB", () => {
    const { path, dir } = syntheticBrain();
    const held = new Storage(path, { vault: join(dir, "vault") });
    cleanup.push(() => held.close());
    const r = run([], { BRAIN_DB: path });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Sorting help: 3 sorted notes");
    expect(r.stdout).toContain("Recall pushes: 6");
  }, 60_000);
  it("explains a missing brain and refuses one from a newer BiBrain, both with one sentence on stderr and exit 2", () => {
    const missing = run(["--db", join(tmpdir(), "no-such-folder-" + Date.now(), "brain.sqlite")]);
    expect(missing.status).toBe(2);
    expect(missing.stdout).toBe("");
    expect(missing.stderr).toContain("No brain found at");
    expect(missing.stderr).toContain("--db");
    const { path, dir } = syntheticBrain();
    const newer = join(dir, "newer.sqlite");
    copyFileSync(path, newer);
    const db = new DatabaseSync(newer);
    db.exec("INSERT INTO migrations VALUES(99,'2099-01-01T00:00:00.000Z')");
    db.close();
    const r = run(["--db", newer]);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("newer BiBrain");
    expect(r.stderr).not.toMatch(/^\s+at /mu);
    expect(existsSync(resolve("data/calibration.json"))).toBe(false);
  }, 60_000);
  it("refuses --db followed by another flag instead of treating the flag as a path", () => {
    const r = run(["--db", "--json"]);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("--db needs the path");
  }, 60_000);
  it("shares Storage's schema ceiling, so a brain at the latest migration is read, not refused", () => {
    const { path } = syntheticBrain();
    const db = new DatabaseSync(path, { readOnly: true });
    const top = Number((db.prepare("SELECT max(version) AS v FROM migrations").get() as { v: number }).v);
    db.close();
    expect(top).toBe(LATEST_MIGRATION);
  });
  it("refuses a file that is not a BiBrain database with one sentence, no stack trace and exit 2", () => {
    const dir = mkdtempSync(join(tmpdir(), "calibrate-junk-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    // A text file named like a database, and a valid SQLite file with none of BiBrain's tables.
    const junk = join(dir, "junk.sqlite");
    writeFileSync(junk, "this is not a database\n");
    const bare = join(dir, "bare.sqlite");
    const db = new DatabaseSync(bare);
    db.exec("CREATE TABLE unrelated(x)");
    db.close();
    for (const file of [junk, bare]) {
      const r = run(["--db", file]);
      expect(r.status).toBe(2);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("could not be read as a BiBrain database");
      expect(r.stderr).toContain("--db");
      expect(r.stderr).not.toMatch(/^\s+at /mu);
      expect(r.stderr).not.toContain("no such table");
      expect(r.stderr).not.toContain("not a database");
    }
  }, 60_000);
});

describe("meaning-lead suggestions", () => {
  it("from the proof: 0.05 above the loudest no-answer cosine, only with 20 negatives, only when every wanted hit still qualifies, never under the floor or over 0.99", () => {
    expect(suggestMeaningLead({ highestNegative: 0.58, lowestWanted: 0.71, floor: 0.45, negatives: 30, positives: 37 })).toMatchObject({ threshold: "search.meaning_lead", current: null, suggested: Number((0.58 + 0.05).toFixed(2)), sample: 30 });
    expect(suggestMeaningLead({ highestNegative: 0.3, lowestWanted: 0.71, floor: 0.45, negatives: 30, positives: 37 }).suggested).toBe(0.45);
    expect(suggestMeaningLead({ highestNegative: 0.97, lowestWanted: 1, floor: 0.45, negatives: 30, positives: 37 }).suggested).toBe(0.99);
    const overlap = suggestMeaningLead({ highestNegative: 0.7, lowestWanted: 0.71, floor: 0.45, negatives: 30, positives: 37 });
    expect(overlap.suggested).toBeNull();
    expect(overlap.reason).toMatch(/no safe value/u);
    // The safe side rests on the negatives alone: 19 negatives is not enough however many positives there are.
    expect(suggestMeaningLead({ highestNegative: 0.58, lowestWanted: 0.71, floor: 0.45, negatives: 19, positives: 100 })).toMatchObject({ suggested: null, sample: 19, reason: expect.stringMatching(/not enough evidence/u) });
    expect(suggestMeaningLead({ highestNegative: -1, lowestWanted: 1, floor: 0.45, negatives: 0, positives: 37 })).toMatchObject({ suggested: null, reason: expect.stringMatching(/not enough evidence/u) });
  });
  it("from the log: the 90th percentile of the leader's cosine on quiet pushes plus 0.05, from plain-prompt rows written while no line was in force", () => {
    const none = Array.from({ length: 25 }, (_, i) => row({ dense: true, dense_top: 0.9, lead_cos: 0.46 + (i % 10) * 0.01, level: "none" }));
    const full = Array.from({ length: 25 }, (_, i) => row({ dense: true, dense_top: 0.9, lead_cos: 0.7 + (i % 10) * 0.01, level: "full" }));
    // The expected value is computed from the rows, not rounded by eye.
    const sortedNone = none.map((r) => r.lead_cos!).sort((a, b) => a - b);
    const expected = Number((sortedNone[Math.floor(0.9 * sortedNone.length)] + 0.05).toFixed(2));
    const skipped = [
      row({ dense: true, lead_cos: 0.95, level: "none", lead_at: 0.6 }),
      row({ dense: true, lead_cos: 0.95, level: "full", lead: true, lead_at: 0.6 }),
      row({ dense: true, lead_cos: 0.95, level: "none", intent: "continuation", topic: "session" }),
      row({ level: "none", intent: "ack" }),
      row({ dense: true, dense_top: 0.95, level: "none" }),
      row({ level: "pointer" }),
    ];
    const s = meaningLeadFromLog([...none, ...full, ...skipped], 0.45, null);
    expect(s).toMatchObject({ threshold: "search.meaning_lead", current: null, suggested: expected, sample: 50 });
    expect(meaningLeadFromLog([...none.slice(0, 19), ...full], 0.45, null)).toMatchObject({ suggested: null, reason: expect.stringMatching(/Not enough data yet/u) });
    const overlapping = Array.from({ length: 25 }, (_, i) => row({ dense: true, lead_cos: 0.5 + (i % 10) * 0.01, level: "full" }));
    expect(meaningLeadFromLog([...none, ...overlapping], 0.45, 0.6)).toMatchObject({ current: 0.6, suggested: null, reason: expect.stringMatching(/overlap/u) });
  });
  it("keeps a separate file of no-answer queries for the proof, all quiet by words and under the fake embedder", () => {
    const file = JSON.parse(readFileSync("tests/eval/recall-no-answer-v1.json", "utf8")) as { queries: string[] };
    expect(new Set(file.queries).size).toBeGreaterThanOrEqual(20);
    const dir = mkdtempSync(join(tmpdir(), "no-answer-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const fx = buildFixture(join(dir, "brain.sqlite"));
    cleanup.push(() => fx.store.close());
    const { dense } = embedFixture(fx);
    for (const q of file.queries) {
      expect(fx.brain.recallCore(owner, { query: q }).status, q).toBe("no_match");
      expect(fx.brain.recallCore(owner, { query: q }, dense(q)).status, `${q} (dense)`).not.toBe("found");
    }
  });
  it("prints the applied line with its provenance, or not set, and lists the log suggestion as a suggestion only", () => {
    const lead: MeaningLead = { threshold: 0.63, key: "ollama:bge-m3:none", sample: 54, source: "proof:search", measured_at: "2026-11-06", applied_at: "2026-11-07T09:12:00.000Z" };
    const text = renderCalibration(calibrationReport({ ...empty, meaning_lead: lead }));
    expect(text).toContain("Meaning matches can lead: 0.63, applied 2026-11-07 from proof:search (54 queries measured 2026-11-06, model ollama:bge-m3:none).");
    expect(text).toMatch(/search\.meaning_lead = 0\.63: hold\. Not enough data yet/u);
    expect(text).toContain("Each is weaker evidence than npm run proof:search");
    const unset = renderCalibration(calibrationReport(empty));
    expect(unset).toContain("Meaning matches can lead: not set (a match found by meaning alone never leads a push).");
    expect(unset).toMatch(/search\.meaning_lead = unset: hold\./u);
    expect(calibrationReport(empty).recall.meaning_lead).toBeNull();
  });
});
