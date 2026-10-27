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

type Fingerprint = { count: number; max: number; sum: number };
type Entry = { generation: number; dataVersion: number; fingerprint: Fingerprint; ids: number[]; matrix: Float32Array };
type Scope = { projects: string[]; visibilities: string[]; status: RecallRowStatus | "any"; key: string; dim: number };

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
/** A Float32 view of one stored vector: zero-copy when the host is little-endian and the blob is 4-aligned, one copy when not aligned, the DataView path on a big-endian host. */
function viewVector(blob: Uint8Array, dim: number): Float32Array {
  if (!LITTLE_ENDIAN) return decodeVector(blob, dim);
  if (blob.byteOffset % 4 === 0) return new Float32Array(blob.buffer, blob.byteOffset, dim);
  return new Float32Array(new Uint8Array(blob).buffer, 0, dim);
}

const scopeSql = (sc: Scope) => ({
  where: `project_id IN (${marks(sc.projects.length)}) AND visibility IN (${marks(sc.visibilities.length)}) ${sc.status === "any" ? "" : "AND status=?"} AND embedding_model=? AND embedding_dim=?`,
  args: [...sc.projects, ...sc.visibilities, ...(sc.status === "any" ? [] : [sc.status]), sc.key, sc.dim],
});
const sameFingerprint = (a: Fingerprint, b: Fingerprint) => a.count === b.count && a.max === b.max && a.sum === b.sum;

/**
 * One contiguous Float32 matrix per (projects, visibilities, status, key, dim). Two triggers:
 *  - this process's generation moved (its own index and vector writes): rebuild, always;
 *  - SQLite's data_version moved (any commit by another connection, including the worker's leases and ledger rows): rebuild only if the
 *    scope's (count, max id, sum of ids) of embedded rows changed, so an unrelated commit costs one aggregate query, not a full matrix read.
 * The fingerprint sees rows that join or leave a scope; it does not see a vector rewritten in place under the same key, which the
 * indexing path never does (a changed text is a new row id, and a re-embed only targets rows whose key differs).
 * The scan is a dot product (vectors are unit length); the top rows are then re-read by id and dropped unless still in scope under the key.
 */
export class VectorCache {
  private readonly entries = new Map<string, Entry>();
  /** How many matrices this cache has built; tests read it to prove an unrelated commit does not rebuild. */
  builds = 0;
  /** How many scopes are cached right now. */
  get scopes() {
    return this.entries.size;
  }
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
    const projects = new Set(q.projects);
    const visibilities = new Set<string>(q.visibilities);
    const out: RecallMatch[] = [];
    for (const t of top) {
      const r = byId.get(t.id);
      // Re-checked against the live row, so a row whose model, project, visibility or status changed since the matrix was built is never returned.
      if (!r || r.embedding_model !== q.key || !projects.has(r.project_id) || !visibilities.has(r.visibility) || (q.status !== "any" && r.status !== q.status)) continue;
      const { embedding_model: _model, ...rest } = r;
      out.push({ ...rest, boost: Number(rest.boost), score: t.score });
    }
    return out;
  }

  /**
   * Answered from the recall_chunks_embed index alone (status, model, dim, project, visibility and the rowid are all in it), so it never reads
   * a 4 KB vector or walks its overflow pages. A stored dim is only ever written together with its blob, so `embedding_dim=?` stands for "embedded".
   */
  private fingerprint(store: Storage, sc: Scope): Fingerprint {
    const { where, args } = scopeSql(sc);
    const row = store.get<{ n: number; m: number | null; s: number | null }>(`SELECT count(*) AS n, max(id) AS m, sum(id) AS s FROM recall_chunks WHERE ${where}`, ...args);
    return { count: Number(row?.n ?? 0), max: Number(row?.m ?? 0), sum: Number(row?.s ?? 0) };
  }

  /** Drops every entry other than `keep` that this process's writes outdated, or whose scope changed under another connection's commit. */
  private prune(store: Storage, version: number, keep: string) {
    for (const [name, e] of [...this.entries]) {
      if (name === keep) continue;
      if (e.generation !== generation) this.entries.delete(name);
      else if (e.dataVersion !== version) {
        if (sameFingerprint(e.fingerprint, this.fingerprint(store, JSON.parse(name) as Scope))) e.dataVersion = version;
        else this.entries.delete(name);
      }
    }
  }

  private load(store: Storage, q: VectorQuery): Entry {
    const sc: Scope = { projects: [...q.projects].sort(), visibilities: [...q.visibilities].sort(), status: q.status, key: q.key, dim: q.dim };
    const name = JSON.stringify(sc);
    const version = dataVersion(store);
    this.prune(store, version, name);
    const cached = this.entries.get(name);
    if (cached && cached.generation === generation) {
      if (cached.dataVersion === version) return cached;
      if (sameFingerprint(cached.fingerprint, this.fingerprint(store, sc))) {
        cached.dataVersion = version;
        return cached;
      }
    }
    const { where, args } = scopeSql(sc);
    const fingerprint = this.fingerprint(store, sc);
    const rows = store.all<{ id: number; embedding: Uint8Array | null }>(`SELECT id,embedding FROM recall_chunks WHERE ${where} AND embedding IS NOT NULL ORDER BY id`, ...args);
    this.builds += 1;
    const matrix = new Float32Array(rows.length * q.dim);
    const ids: number[] = [];
    // A blob of the wrong length or holding a non-finite value (never written by writeEmbeddings, but the file is shared) is left out of the matrix.
    for (const r of rows) {
      if (!r.embedding || r.embedding.byteLength !== q.dim * 4) continue;
      const v = viewVector(r.embedding, q.dim);
      if (!allFinite(v)) continue;
      matrix.set(v, ids.length * q.dim);
      ids.push(r.id);
    }
    const entry: Entry = { generation, dataVersion: version, fingerprint, ids, matrix: matrix.subarray(0, ids.length * q.dim) };
    if (!this.entries.has(name) && this.entries.size >= this.maxScopes) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(name, entry);
    return entry;
  }
}
