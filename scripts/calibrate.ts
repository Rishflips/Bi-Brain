/**
 * OWNER-RUN calibration report: `npm run calibrate [-- --db <path>] [--json]`.
 *
 * Reads your local brain through a READ-ONLY handle and prints counts, histograms, the current thresholds and
 * suggestions. It does not change your data or settings and sends nothing (a read-only open of a WAL database may
 * leave empty -wal and -shm sidecar files, which hold no data). It never reads or prints note text: the sorting
 * answers are reduced to their numbers before the report runs, and source_versions is never opened. The database is
 * opened with node:sqlite directly (not through Storage, whose constructor applies migrations), so SQLite enforces
 * read-only. Exit 0 after a report; 2 with one plain sentence on stderr (never a stack trace, SQLite's own error text or a row;
 * the path shown is the one you gave) when the brain is missing, cannot be opened or read, or is from a newer BiBrain.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { MeaningLead } from "../packages/domain/better-search.ts";
import { LATEST_MIGRATION } from "../packages/storage/index.ts";
import { calibrationReport, effectiveSearchModelKey, renderCalibration, type CalibrationInput, type RecallLogRow, type S1AnswerRow, type S1FeedbackRow } from "../packages/domain/calibration.ts";

const args = process.argv.slice(2);
const dbFlag = args.indexOf("--db");
const dbArg = dbFlag >= 0 ? args[dbFlag + 1] : undefined;
const badDbArg = dbFlag >= 0 && dbArg !== undefined && dbArg.startsWith("--");
const path = resolve(dbFlag >= 0 && dbArg && !badDbArg ? dbArg : (process.env.BRAIN_DB ?? "data/brain.sqlite"));
const asJson = args.includes("--json");
/** Every refusal is one sentence on stderr, so `--json` output on stdout stays parseable and no error text is echoed. */
const refuse = (sentence: string): number => {
  console.error(sentence);
  return 2;
};

function main(): number {
  if (badDbArg) return refuse("--db needs the path to brain.sqlite after it: --db <path to brain.sqlite>.");
  if (!existsSync(path)) return refuse(`No brain found at ${path}. Start BiBrain once, or pass --db <path to brain.sqlite>.`);
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch {
    return refuse(`Could not open ${path} read-only. If BiBrain is not running, start it once, or copy brain.sqlite elsewhere and pass --db.`);
  }
  try {
    const version = Number((db.prepare("SELECT max(version) AS v FROM migrations").get() as { v?: number } | undefined)?.v ?? 0);
    if (version > LATEST_MIGRATION) return refuse("This brain is from a newer BiBrain. Run the calibration report from that version.");
    const table = (name: string) => !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
    const setting = <T>(key: string, fallback: T): T => {
      const row = db.prepare("SELECT value FROM settings WHERE key=?").get(key) as { value: string } | undefined;
      return row ? (JSON.parse(row.value) as T) : fallback;
    };
    const entities = (kind: string): any[] => (db.prepare("SELECT data FROM entities WHERE kind=? ORDER BY created_at, rowid").all(kind) as { data: string }[]).map((r) => JSON.parse(r.data));
    // Only numbers and ids leave this block: no source id, no job id, no words.
    const s1_answers: S1AnswerRow[] = entities("s1_answer").map((a) => ({ answers: Array.isArray(a?.answers) ? a.answers : [] }));
    const s1_feedback: S1FeedbackRow[] = entities("s1_feedback").map((f) => ({ question: f?.question, choice: f?.choice, confidence: f?.confidence, action: f?.action }));
    const recall_log = setting<RecallLogRow[]>("recall_log", []);
    const meaning_lead = setting<MeaningLead | null>("meaning_lead", null);
    const searchSetting = setting<{ mode?: string; key?: string } | null>("better_search", null);
    // A stored choice wins (Off names no model); with none, the key the worker published when it found Ollama (Better search on by itself).
    const model_key = effectiveSearchModelKey(searchSetting, setting<{ configured?: boolean; provider?: string; detected?: boolean; key?: string } | null>("better_search_status", null));
    const embedded = table("recall_chunks")
      ? (db.prepare("SELECT embedding_model AS model, count(*) AS rows FROM recall_chunks WHERE embedding IS NOT NULL GROUP BY embedding_model").all() as { model: string | null; rows: number }[]).map((e) => ({ model: String(e.model ?? "unknown"), rows: Number(e.rows) }))
      : [];
    const input: CalibrationInput = { recall_log: Array.isArray(recall_log) ? recall_log : [], s1_answers, s1_feedback, embedded, meaning_lead, today: new Date().toISOString().slice(0, 10), model_key };
    const report = calibrationReport(input);
    console.log(asJson ? JSON.stringify(report, null, 2) : renderCalibration(report));
    return 0;
  } catch {
    // A text file named .sqlite, a SQLite file without BiBrain's tables, or a WAL database in a folder that cannot take
    // its -shm file all fail on the first query. The reason is never printed: it could carry a path or a row.
    return refuse(`${path} could not be read as a BiBrain database. Pass --db <path to brain.sqlite>, or copy the file elsewhere first.`);
  } finally {
    db.close();
  }
}

// exitCode, not exit(): piped output is flushed before the process ends.
process.exitCode = main();
