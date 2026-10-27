import type { Storage } from "./index.ts";
import type { RecallKind, RecallMatch, RecallRowStatus, RecallVisibility } from "./recall-index.ts";
import { decodeVector, encodeVector, normalize } from "../domain/better-search.ts";

export type PendingRow = { id: number; kind: RecallKind; ref_id: string; ref_version: number; ordinal: number; text: string; prefix: string };
/** A `null` vector withholds the row: `"secret"` (never sent) keeps `embedding_dim` NULL, `"rejected"` (the provider refused it alone) stores -1. */
export type VectorWrite = { id: number; kind: RecallKind; ref_id: string; ref_version: number; ordinal: number; vector: Float32Array | null; reason?: "secret" | "rejected" };
export type VectorQuery = { vector: Float32Array; key: string; dim: number; projects: string[]; visibilities: RecallVisibility[]; status: RecallRowStatus | "any"; floor: number; limit: number };

const allFinite = (v: Float32Array) => {
  for (let i = 0; i < v.length; i++) if (!Number.isFinite(v[i])) return false;
  return true;
};
const marks = (n: number) => Array.from({ length: n }, () => "?").join(",");
const ROW_COLUMNS = "id,kind,ref_id,ref_version,project_id,visibility,status,ordinal,start,end,text,prefix,recorded_at,boost,embedding_model";

/**
 * Cache invalidation writes nothing. Writes made through this process bump an in-process counter; writes made by another
 * connection (the worker's vectors, seen from the server) move SQLite's `data_version`, which the cache reads before every scan.
 * A database with Better search off therefore stays byte-identical to plan 5.
 */
let generation = 0;
export function vectorGeneration(): number {
  return generation;
}
export function bumpVectorGeneration() {
  generation += 1;
}
const dataVersion = (store: Storage) => Number(store.get<{ data_version: number }>("PRAGMA data_version")?.data_version ?? 0);

/** Current rows the provider may see whose key is missing or differs. Withheld rows (model set, embedding NULL) are not pending. */
export function pendingEmbedRows(store: Storage, key: string, visibilities: RecallVisibility[], limit: number): PendingRow[] {
  if (!visibilities.length || limit < 1) return [];
  return store.all<PendingRow>(
    `SELECT id,kind,ref_id,ref_version,ordinal,text,prefix FROM recall_chunks WHERE status='current' AND visibility IN (${marks(visibilities.length)})
     AND (embedding_model IS NULL OR embedding_model<>?) ORDER BY id LIMIT ?`,
    ...visibilities,
    key,
    limit,
  );
}

export function countEmbedRows(store: Storage, key: string, visibilities: RecallVisibility[]) {
  if (!visibilities.length) return { total: 0, embedded: 0, pending: 0, withheld: 0 };
  const row = store.get<{ total: number; embedded: number; withheld: number }>(
    `SELECT count(*) AS total,
       sum(CASE WHEN embedding_model=? AND embedding IS NOT NULL THEN 1 ELSE 0 END) AS embedded,
       sum(CASE WHEN embedding_model=? AND embedding IS NULL THEN 1 ELSE 0 END) AS withheld
     FROM recall_chunks WHERE status='current' AND visibility IN (${marks(visibilities.length)})`,
    key,
    key,
    ...visibilities,
  );
  const total = Number(row?.total ?? 0);
  const embedded = Number(row?.embedded ?? 0);
  const withheld = Number(row?.withheld ?? 0);
  return { total, embedded, pending: total - embedded - withheld, withheld };
}

/** Caller holds the transaction. The guard makes a row that was replaced (new id, version or ordinal) or purged a no-op. */
export function writeEmbeddings(store: Storage, key: string, dim: number, rows: VectorWrite[]): number {
  // Validate the whole batch before the first UPDATE. A vector that is not finite (a NaN or Infinity from the provider, or a huge finite value that
  // overflowed Float32 and became NaN once normalised) is refused here, so no such blob is ever stored and none can reach a scan.
  const prepared = rows.map((r) => {
    if (!r.vector) return { r, blob: null as Buffer | null };
    if (r.vector.length !== dim) throw new RangeError("Vector length does not match the batch dim.");
    if (!allFinite(r.vector)) throw new RangeError("Vector holds a value that is not finite.");
    const unit = normalize(Float32Array.from(r.vector));
    if (!allFinite(unit)) throw new RangeError("Vector holds a value that is not finite.");
    return { r, blob: encodeVector(unit) };
  });
  let changed = 0;
  for (const { r, blob } of prepared) {
    const result = store.run(
      "UPDATE recall_chunks SET embedding=?,embedding_model=?,embedding_dim=? WHERE id=? AND kind=? AND ref_id=? AND ref_version=? AND ordinal=? AND status='current'",
      blob,
      key,
      blob ? dim : r.reason === "rejected" ? -1 : null,
      r.id,
      r.kind,
      r.ref_id,
      r.ref_version,
      r.ordinal,
    );
    changed += Number(result.changes);
  }
  if (changed) bumpVectorGeneration();
  return changed;
}

export function clearEmbeddings(store: Storage): number {
  const changed = Number(store.run("UPDATE recall_chunks SET embedding=NULL,embedding_model=NULL,embedding_dim=NULL WHERE embedding IS NOT NULL OR embedding_model IS NOT NULL").changes);
  bumpVectorGeneration();
  return changed;
}

type Entry = { generation: number; dataVersion: number; ids: number[]; matrix: Float32Array };

/**
 * One contiguous Float32 matrix per (projects, visibilities, status, key, dim), rebuilt when this process's generation
 * or SQLite's data_version moved. The scan is a dot product (vectors are unit length), then the top rows are re-read by id
 * so a row that changed since the matrix was built is dropped rather than served.
 */
export class VectorCache {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly maxScopes = 8) {}

  search(store: Storage, q: VectorQuery): RecallMatch[] {
    if (!q.projects.length || !q.visibilities.length || q.limit < 1 || q.vector.length !== q.dim || !allFinite(q.vector)) return [];
    const entry = this.load(store, q);
    const { ids, matrix } = entry;
    const dim = q.dim;
    const scored: { id: number; score: number }[] = [];
    for (let r = 0; r < ids.length; r++) {
      let s = 0;
      const base = r * dim;
      for (let d = 0; d < dim; d++) s += matrix[base + d] * q.vector[d];
      if (s >= q.floor) scored.push({ id: ids[r], score: s });
    }
    if (!scored.length) return [];
    scored.sort((a, b) => b.score - a.score || a.id - b.id);
    const top = scored.slice(0, q.limit);
    const rows = store.all<RecallMatch & { embedding_model: string | null }>(
      `SELECT ${ROW_COLUMNS} FROM recall_chunks WHERE id IN (${marks(top.length)})`,
      ...top.map((t) => t.id),
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    const out: RecallMatch[] = [];
    for (const t of top) {
      const r = byId.get(t.id);
      if (!r || r.embedding_model !== q.key) continue;
      const { embedding_model: _model, ...rest } = r;
      out.push({ ...rest, boost: Number(rest.boost), score: t.score });
    }
    return out;
  }

  private load(store: Storage, q: VectorQuery): Entry {
    const projects = [...q.projects].sort();
    const visibilities = [...q.visibilities].sort();
    const scope = JSON.stringify([projects, visibilities, q.status, q.key, q.dim]);
    const version = dataVersion(store);
    const cached = this.entries.get(scope);
    if (cached && cached.generation === generation && cached.dataVersion === version) return cached;
    const rows = store.all<{ id: number; embedding: Uint8Array }>(
      `SELECT id,embedding FROM recall_chunks WHERE project_id IN (${marks(projects.length)}) AND visibility IN (${marks(visibilities.length)})
       ${q.status === "any" ? "" : "AND status=?"} AND embedding_model=? AND embedding_dim=? AND embedding IS NOT NULL ORDER BY id`,
      ...projects,
      ...visibilities,
      ...(q.status === "any" ? [] : [q.status]),
      q.key,
      q.dim,
    );
    const matrix = new Float32Array(rows.length * q.dim);
    const ids: number[] = [];
    // A blob of the wrong length or holding a non-finite value (never written by writeEmbeddings, but the file is shared) is left out of the matrix.
    for (const r of rows) {
      if (r.embedding.byteLength !== q.dim * 4) continue;
      const v = decodeVector(r.embedding, q.dim);
      if (!allFinite(v)) continue;
      matrix.set(v, ids.length * q.dim);
      ids.push(r.id);
    }
    const entry = { generation, dataVersion: version, ids, matrix: matrix.subarray(0, ids.length * q.dim) };
    if (!this.entries.has(scope) && this.entries.size >= this.maxScopes) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(scope, entry);
    return entry;
  }
}
