import type { Storage } from "./index.ts";
import type { PortableState } from "./vault.ts";
import { factText } from "../domain/facts.ts";
import { bumpVectorGeneration } from "./recall-vectors.ts";

export const RECALL_INDEX_VERSION = 1;
export const RECALL_INDEX_BUILT = "recall_index_built";
export type RecallKind = "original" | "fact";
export type RecallVisibility = "project" | "private" | "owner";
export type RecallRowStatus = "current" | "history";
export type RecallRow = {
  kind: RecallKind;
  ref_id: string;
  ref_version: number;
  project_id: string;
  visibility: RecallVisibility;
  status: RecallRowStatus;
  ordinal: number;
  start: number;
  end: number;
  text: string;
  prefix: string;
  recorded_at: string;
  boost: number;
};
export type RecallMatch = RecallRow & { id: number; score: number };
export type Chunk = { ordinal: number; start: number; end: number; text: string };
export type S1Hints = { durable: number | null; topic: string | null; answer_id: string | null };

const CHUNK_MIN = 600;
const CHUNK_TARGET = 900;
const CHUNK_HARD = 1200;
const OVERLAP_MAX = 120;
const DURABLE_HIGH = 0.6;
const DURABLE_LOW = 0.25;
const TOPIC_MIN_CONFIDENCE = 0.7;

export const RECALL_DDL = `CREATE TABLE IF NOT EXISTS recall_chunks(
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('original','fact')),
  ref_id TEXT NOT NULL,
  ref_version INTEGER NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id),
  visibility TEXT NOT NULL CHECK(visibility IN ('project','private','owner')),
  status TEXT NOT NULL CHECK(status IN ('current','history')),
  ordinal INTEGER NOT NULL,
  start INTEGER NOT NULL, end INTEGER NOT NULL,
  text TEXT NOT NULL, prefix TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  boost REAL NOT NULL DEFAULT 1.0,
  embedding BLOB, embedding_model TEXT, embedding_dim INTEGER,
  UNIQUE(kind, ref_id, ref_version, ordinal));
CREATE INDEX IF NOT EXISTS recall_chunks_ref ON recall_chunks(kind, ref_id);
CREATE INDEX IF NOT EXISTS recall_chunks_scope ON recall_chunks(project_id, visibility, status);
CREATE INDEX IF NOT EXISTS recall_chunks_embed ON recall_chunks(status, embedding_model, embedding_dim, project_id, visibility);
CREATE INDEX IF NOT EXISTS jobs_kind_created ON jobs(kind, created_at);
CREATE VIRTUAL TABLE IF NOT EXISTS recall_fts USING fts5(text, prefix, tokenize='porter unicode61 remove_diacritics 2');`;
// jobs_kind_created serves task 10's per-day count of recall_judge rows, which stay in the table (the spend ledger references job ids).

const isSpace = (ch: string) => /\s/u.test(ch);

/** Sentences as [start,end) code-point spans, trimmed, split at .?! + space or at a newline. */
function sentenceSpans(points: string[]): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  const push = (s: number, e: number) => {
    while (s < e && isSpace(points[s])) s++;
    while (e > s && isSpace(points[e - 1])) e--;
    if (e > s) spans.push({ start: s, end: e });
  };
  let start = 0;
  for (let i = 0; i < points.length; i++) {
    const ch = points[i];
    const boundary = ch === "\n" || (/[.?!]/u.test(ch) && i + 1 < points.length && isSpace(points[i + 1]));
    if (boundary) {
      push(start, i + 1);
      start = i + 1;
    }
  }
  push(start, points.length);
  return spans;
}

/** 600–900 code-point chunks (hard max 1,200) with a short last-sentence overlap. Offsets are code points. */
export function chunkBody(body: string): Chunk[] {
  const points = Array.from(body);
  const pieces: { start: number; end: number }[] = [];
  for (const span of sentenceSpans(points))
    for (let s = span.start; s < span.end; s += CHUNK_HARD) pieces.push({ start: s, end: Math.min(span.end, s + CHUNK_HARD) });
  const chunks: Chunk[] = [];
  let cur: { start: number; end: number } | null = null;
  let last: { start: number; end: number } | null = null;
  const emit = () => {
    if (!cur) return;
    chunks.push({ ordinal: chunks.length, start: cur.start, end: cur.end, text: points.slice(cur.start, cur.end).join("") });
  };
  for (const piece of pieces) {
    if (!cur) cur = { start: piece.start, end: piece.end };
    else {
      const grown = piece.end - cur.start;
      const have = cur.end - cur.start;
      if (grown <= CHUNK_TARGET || (have < CHUNK_MIN && grown <= CHUNK_HARD)) cur.end = piece.end;
      else {
        // The overlap is the previous chunk's last sentence. It is dropped when that sentence is the whole previous chunk
        // (it would only duplicate it) or when prepending it would push the new chunk past the hard cap.
        const overlapStart: number = last && last.end - last.start <= OVERLAP_MAX && last.start > cur.start ? last.start : piece.start;
        emit();
        cur = { start: piece.end - overlapStart <= CHUNK_HARD ? overlapStart : piece.start, end: piece.end };
      }
    }
    last = piece;
  }
  emit();
  return chunks;
}

export function chunkPrefix(title: string, projectTitle: string, capturedAt: string, topic: string | null): string {
  const date = capturedAt.slice(0, 10);
  return [title, projectTitle, date, ...(topic ? [topic] : [])].join(" · ");
}

export function durableBoost(probability: number | null): number {
  if (probability === null) return 1;
  if (probability >= DURABLE_HIGH) return 1.15;
  if (probability < DURABLE_LOW) return 0.9;
  return 1;
}

const parsed = (data: unknown): any => (typeof data === "string" ? JSON.parse(data) : data);

/** The capture-time Clef hints for one source version: durable probability and a confident topic name. */
export function s1HintsFor(entities: { kind: string; data: any }[], sourceId: string, version: number): S1Hints {
  for (const e of entities) {
    if (e.kind !== "s1_answer") continue;
    const d = parsed(e.data);
    if (d.source_id !== sourceId || Number(d.source_version) !== version) continue;
    const answers: any[] = Array.isArray(d.answers) ? d.answers : [];
    const durable = answers.find((a) => a.id === "durable" && a.type === "noul");
    const topic = answers.find((a) => a.id === "topic" && a.type === "choice");
    const options: string[] = Array.isArray(d.topic_options) ? d.topic_options : [];
    let topicName: string | null = null;
    if (topic && topic.choice !== "none" && topic.confidence >= TOPIC_MIN_CONFIDENCE) {
      const m = /^t(\d+)$/u.exec(String(topic.choice));
      if (m && options[Number(m[1]) - 1]) topicName = options[Number(m[1]) - 1];
    }
    return { durable: typeof durable?.probability === "number" ? durable.probability : null, topic: topicName, answer_id: (e as any).id ?? null };
  }
  return { durable: null, topic: null, answer_id: null };
}

export function originalRows(input: {
  source: { id: string; project_id: string; version: number; visibility: "private" | "project"; captured_at: string };
  version: { title: string; body: string };
  projectTitle: string;
  hints: S1Hints;
}): RecallRow[] {
  const prefix = chunkPrefix(input.version.title, input.projectTitle, input.source.captured_at, input.hints.topic);
  const boost = durableBoost(input.hints.durable);
  return chunkBody(input.version.body).map((c) => ({
    kind: "original",
    ref_id: input.source.id,
    ref_version: input.source.version,
    project_id: input.source.project_id,
    visibility: input.source.visibility,
    status: "current",
    ordinal: c.ordinal,
    start: c.start,
    end: c.end,
    text: c.text,
    prefix,
    recorded_at: input.source.captured_at,
    boost,
  }));
}

const validTime = (t: unknown): t is string => typeof t === "string" && !Number.isNaN(Date.parse(t));

/** A claim is owner-only when it is a name or preference, owner-private, or cites any private source (defense in depth). */
export function factRows(input: {
  claim: { id: string; project_id: string; version: number; created_at: string; data: any };
  projectTitle: string;
  privateSources?: ReadonlySet<string>;
}): RecallRow[] {
  const d = parsed(input.claim.data);
  if (!Array.isArray(d.evidence) || d.evidence.length === 0) return [];
  if (d.status !== "current" && d.status !== "retired") return [];
  const text = factText(String(d.entity), String(d.aspect), d.value);
  const citesPrivate = (d.evidence as any[]).some((e) => input.privateSources?.has(String(e?.source_id)));
  const ownerOnly = d.aspect === "name" || d.aspect === "preference" || d.authority === "owner_private" || citesPrivate;
  const recorded = [d.recorded_at, d.edited_at].filter(validTime).sort().at(-1) ?? input.claim.created_at;
  return [
    {
      kind: "fact",
      ref_id: input.claim.id,
      ref_version: input.claim.version,
      project_id: input.claim.project_id,
      visibility: ownerOnly ? "owner" : "project",
      status: d.status === "current" ? "current" : "history",
      ordinal: 0,
      start: 0,
      end: Array.from(text).length,
      text,
      prefix: `${input.projectTitle} · ${String(d.entity)}`,
      recorded_at: recorded,
      boost: 1,
    },
  ];
}

const rowOrder = (a: RecallRow, b: RecallRow) =>
  a.kind.localeCompare(b.kind) || a.ref_id.localeCompare(b.ref_id) || a.ref_version - b.ref_version || a.ordinal - b.ordinal;

/** Every row the index must hold for this portable state. Pure; the property test compares it with the table. */
export function recallRowsFor(state: PortableState): RecallRow[] {
  const titles = new Map<string, string>(state.projects.map((p: any) => [p.id, p.title]));
  const rows: RecallRow[] = [];
  const answersByProject = new Map<string, { kind: string; data: any }[]>();
  for (const e of state.entities) if (e.kind === "s1_answer") answersByProject.set(e.project_id, [...(answersByProject.get(e.project_id) ?? []), e]);
  const privateSources = new Set<string>(state.sources.filter((x: any) => x.visibility === "private").map((x: any) => x.id));
  for (const s of state.sources) {
    if (s.state !== "active") continue;
    const v = state.source_versions.find((x: any) => x.source_id === s.id && x.version === s.version);
    if (!v) continue;
    rows.push(...originalRows({ source: s, version: v, projectTitle: titles.get(s.project_id) ?? "Project", hints: s1HintsFor(answersByProject.get(s.project_id) ?? [], s.id, s.version) }));
  }
  for (const e of state.entities) {
    if (e.kind !== "claim") continue;
    rows.push(...factRows({ claim: e, projectTitle: titles.get(e.project_id) ?? "Project", privateSources }));
  }
  return rows.sort(rowOrder);
}

export function recallRowsInDb(store: Storage): RecallRow[] {
  return store
    .all<RecallRow>("SELECT kind,ref_id,ref_version,project_id,visibility,status,ordinal,start,end,text,prefix,recorded_at,boost FROM recall_chunks")
    .map((r) => ({ ...r, boost: Number(r.boost) }))
    .sort(rowOrder);
}

export function purgeRef(store: Storage, kind: RecallKind, refId: string) {
  store.run("DELETE FROM recall_fts WHERE rowid IN (SELECT id FROM recall_chunks WHERE kind=? AND ref_id=?)", kind, refId);
  store.run("DELETE FROM recall_chunks WHERE kind=? AND ref_id=?", kind, refId);
  bumpVectorGeneration();
}

export function replaceRows(store: Storage, kind: RecallKind, refId: string, rows: RecallRow[]) {
  purgeRef(store, kind, refId);
  for (const r of rows) {
    const inserted = store.run(
      "INSERT INTO recall_chunks(kind,ref_id,ref_version,project_id,visibility,status,ordinal,start,end,text,prefix,recorded_at,boost) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
      r.kind, r.ref_id, r.ref_version, r.project_id, r.visibility, r.status, r.ordinal, r.start, r.end, r.text, r.prefix, r.recorded_at, r.boost,
    );
    store.run("INSERT INTO recall_fts(rowid,text,prefix) VALUES(?,?,?)", Number(inserted.lastInsertRowid), r.text, r.prefix);
  }
}

function projectTitle(store: Storage, id: string): string {
  return store.get<{ title: string }>("SELECT title FROM projects WHERE id=?", id)?.title ?? "Project";
}

const NO_HINTS: S1Hints = { durable: null, topic: null, answer_id: null };
const hintKey = (projectId: string, sourceId: string, version: number) => JSON.stringify([projectId, sourceId, version]);
type HintMap = Map<string, S1Hints>;

/** Capture-time hints for many sources at once: one pass over the s1 answers (of the given projects, using the project/kind index), first answer per source version wins. */
function s1HintMap(store: Storage, projectIds?: string[]): HintMap {
  const map: HintMap = new Map();
  const rows = projectIds
    ? projectIds.length
      ? store.all<{ id: string; project_id: string; data: string }>(
          `SELECT id,project_id,data FROM entities WHERE kind='s1_answer' AND project_id IN (${projectIds.map(() => "?").join(",")}) ORDER BY id`,
          ...projectIds,
        )
      : []
    : store.all<{ id: string; project_id: string; data: string }>("SELECT id,project_id,data FROM entities WHERE kind='s1_answer' ORDER BY id");
  for (const r of rows) {
    const d = parsed(r.data);
    const key = hintKey(r.project_id, String(d.source_id), Number(d.source_version));
    if (!map.has(key)) map.set(key, s1HintsFor([{ kind: "s1_answer", data: d, id: r.id } as any], String(d.source_id), Number(d.source_version)));
  }
  return map;
}

/** Recomputes the rows for one source from the database. Withdrawn, deleted or missing sources end with no rows. Bulk callers pass a preloaded hint map. */
export function syncSource(store: Storage, sourceId: string, hints?: HintMap) {
  const s = store.get<any>("SELECT * FROM sources WHERE id=?", sourceId);
  if (!s || s.state !== "active") return purgeRef(store, "original", sourceId);
  const v = store.get<{ title: string; body: string }>("SELECT title,body FROM source_versions WHERE source_id=? AND version=?", sourceId, s.version);
  if (!v) return purgeRef(store, "original", sourceId);
  const found = hints
    ? (hints.get(hintKey(s.project_id, sourceId, s.version)) ?? NO_HINTS)
    : s1HintsFor(
        store.all<{ id: string; kind: string; data: string }>(
          "SELECT id,kind,data FROM entities WHERE project_id=? AND kind='s1_answer' AND json_extract(data,'$.source_id')=? AND json_extract(data,'$.source_version')=? ORDER BY id",
          s.project_id,
          sourceId,
          s.version,
        ),
        sourceId,
        s.version,
      );
  replaceRows(store, "original", sourceId, originalRows({ source: s, version: v, projectTitle: projectTitle(store, s.project_id), hints: found }));
}

export function syncClaim(store: Storage, claimId: string) {
  const c = store.get<any>("SELECT * FROM entities WHERE id=? AND kind='claim'", claimId);
  if (!c) return purgeRef(store, "fact", claimId);
  const d = parsed(c.data);
  const cited = [...new Set<string>((Array.isArray(d.evidence) ? d.evidence : []).map((e: any) => String(e?.source_id)))];
  const privateSources = new Set<string>(
    cited.length
      ? store.all<{ id: string }>(`SELECT id FROM sources WHERE visibility='private' AND id IN (${cited.map(() => "?").join(",")})`, ...cited).map((r) => r.id)
      : [],
  );
  replaceRows(store, "fact", claimId, factRows({ claim: c, projectTitle: projectTitle(store, c.project_id), privateSources }));
}

/** Re-syncs every claim that cites the source (its visibility may have changed). The LIKE only narrows; syncClaim decides. */
export function syncClaimsCiting(store: Storage, sourceId: string) {
  for (const c of store.all<{ id: string }>("SELECT id FROM entities WHERE kind='claim' AND data LIKE ?", `%"${sourceId}"%`)) syncClaim(store, c.id);
}

export function clearRecallIndex(store: Storage) {
  store.run("DELETE FROM recall_fts");
  store.run("DELETE FROM recall_chunks");
  bumpVectorGeneration();
}

/** Refills the whole index from the current tables in the caller's transaction. Small brains and tests only; production paths use rebuildRecallIndex. */
export function fillRecallIndex(store: Storage) {
  clearRecallIndex(store);
  const hints = s1HintMap(store);
  for (const s of store.all<{ id: string }>("SELECT id FROM sources WHERE state='active'")) syncSource(store, s.id, hints);
  for (const c of store.all<{ id: string }>("SELECT id FROM entities WHERE kind='claim'")) syncClaim(store, c.id);
  store.set(RECALL_INDEX_BUILT, RECALL_INDEX_VERSION);
}

/** Empties the index and marks it incomplete, so a caller can commit it with a base-table change and then rebuild in batches. */
export function invalidateRecallIndex(store: Storage) {
  clearRecallIndex(store);
  store.set(RECALL_INDEX_BUILT, 0);
}

/**
 * Backfill in short transactions: at most `batch` sources, then `batch` claims, per transaction. The built flag is cleared in the
 * first transaction and set in the last, so a crash in between is retried by the next open. Idempotent.
 */
export function rebuildRecallIndex(store: Storage, batch = 200) {
  store.transaction(() => invalidateRecallIndex(store));
  const sources = store.all<{ id: string; project_id: string }>("SELECT id,project_id FROM sources WHERE state='active' ORDER BY id");
  for (let i = 0; i < sources.length; i += batch) {
    const slice = sources.slice(i, i + batch);
    store.transaction(() => {
      const hints = s1HintMap(store, [...new Set(slice.map((x) => x.project_id))]);
      for (const x of slice) syncSource(store, x.id, hints);
    });
  }
  const claims = store.all<{ id: string }>("SELECT id FROM entities WHERE kind='claim' ORDER BY id");
  for (let i = 0; i < claims.length; i += batch) {
    const slice = claims.slice(i, i + batch);
    store.transaction(() => {
      for (const c of slice) syncClaim(store, c.id);
    });
  }
  store.transaction(() => store.set(RECALL_INDEX_BUILT, RECALL_INDEX_VERSION));
}

export function recallIndexComplete(store: Storage): boolean {
  return store.setting<number>(RECALL_INDEX_BUILT, 0) === RECALL_INDEX_VERSION;
}

/** BM25 candidates for one already-built MATCH expression. `match` is never raw user text. */
export function searchRecallChunks(
  store: Storage,
  q: { match: string; kind: RecallKind; projects: string[]; visibilities: RecallVisibility[]; status: RecallRowStatus | "any"; limit: number },
): RecallMatch[] {
  if (!q.projects.length || !q.visibilities.length || !q.match.trim()) return [];
  const marks = (n: number) => Array.from({ length: n }, () => "?").join(",");
  return store
    .all<RecallMatch>(
      `SELECT c.id,c.kind,c.ref_id,c.ref_version,c.project_id,c.visibility,c.status,c.ordinal,c.start,c.end,c.text,c.prefix,c.recorded_at,c.boost, bm25(recall_fts, 1.0, 0.5) AS score FROM recall_fts f JOIN recall_chunks c ON c.id = f.rowid
       WHERE recall_fts MATCH ? AND c.kind=? AND c.project_id IN (${marks(q.projects.length)}) AND c.visibility IN (${marks(q.visibilities.length)})
       ${q.status === "any" ? "" : "AND c.status=?"} ORDER BY score LIMIT ?`,
      q.match,
      q.kind,
      ...q.projects,
      ...q.visibilities,
      ...(q.status === "any" ? [] : [q.status]),
      q.limit,
    )
    .map((r) => ({ ...r, boost: Number(r.boost), score: Number(r.score) }));
}

/**
 * What the forget proof reads: rows left for the id, original chunks of the forgotten source that still match a retained body plus
 * original rows whose source is no longer active, fact rows whose claim is gone, embedded rows. Another live note that happens to share
 * a paragraph is not counted.
 */
export function recallCountsForSource(store: Storage, sourceId: string, bodies: string[]) {
  const rows = Number(store.get<{ n: number }>("SELECT count(*) AS n FROM recall_chunks WHERE ref_id=?", sourceId)?.n ?? 0);
  const retained = bodies.filter((b) => b.trim().length > 0);
  const own = retained.length
    ? store.all<{ text: string }>("SELECT text FROM recall_chunks WHERE kind='original' AND ref_id=?", sourceId).filter((r) => retained.some((b) => b.includes(r.text))).length
    : 0;
  const orphanOriginals = Number(
    store.get<{ n: number }>(
      "SELECT count(*) AS n FROM recall_chunks c LEFT JOIN sources s ON s.id=c.ref_id AND s.state='active' WHERE c.kind='original' AND s.id IS NULL",
    )?.n ?? 0,
  );
  const orphanFacts = Number(store.get<{ n: number }>("SELECT count(*) AS n FROM recall_chunks c LEFT JOIN entities e ON e.id=c.ref_id WHERE c.kind='fact' AND e.id IS NULL")?.n ?? 0);
  const embedded = Number(store.get<{ n: number }>("SELECT count(*) AS n FROM recall_chunks WHERE ref_id=? AND embedding IS NOT NULL", sourceId)?.n ?? 0);
  return { rows, text_matches: own + orphanOriginals, orphan_facts: orphanFacts, embedded };
}
