import type { Storage } from "./index.ts";
import type { RecallKind, RecallMatch, RecallRowStatus, RecallVisibility } from "./recall-index.ts";
import { decodeVector, encodeVector, normalize } from "../domain/better-search.ts";

export type PendingRow = { id: number; kind: RecallKind; ref_id: string; ref_version: number; ordinal: number; text: string; prefix: string };
/**
 * A `null` vector withholds the row: `"secret"` (never sent) keeps `embedding_dim` NULL, `"rejected"` (the provider refused it alone) stores -1.
 * `text` and `prefix`, when given, are the exact strings the vector was computed from: the write also requires them to be unchanged.
 */
export type VectorWrite = { id: number; kind: RecallKind; ref_id: string; ref_version: number; ordinal: number; vector: Float32Array | null; reason?: "secret" | "rejected"; text?: string; prefix?: string };
export type VectorQuery = { vector: Float32Array; key: string; dim: number; projects: string[]; visibilities: RecallVisibility[]; status: RecallRowStatus | "any"; floor: number; limit: number };

const allFinite = (v: Float32Array) => {
  for (let i = 0; i < v.length; i++) if (!Number.isFinite(v[i])) return false;
  return true;
};
const marks = (n: number) => Array.from({ length: n }, () => "?").join(",");
const ROW_COLUMNS = "id,kind,ref_id,ref_version,project_id,visibility,status,ordinal,start,end,text,prefix,recorded_at,boost,embedding_model";

/**
 * Cache invalidation has no write of its own (never a settings row). Writes made through this process bump an in-process counter; writes
 * made by another connection (the worker's vectors, seen from the server) move SQLite's `data_version`, which the cache reads before every
 * scan, and each vector write carries a stamp the scope fingerprint reads. With Better search off no vector is ever written, so nothing moves.
 */
let generation = 0;
export function vectorGeneration(): number {
  return generation;
}
export function bumpVectorGeneration() {
  generation += 1;
}
/**
 * The vector schema, run with migration 7 on every open (idempotent). `embedded_seq` is a write stamp: every `writeEmbeddings` call takes
 * the next value of the one-row counter `recall_vector_stamp`, which only ever grows (deleting or replacing rows never lowers it, unlike
 * a max over the rows). A table made before the column existed gets it, and an older `recall_chunks_embed` without it is rebuilt, so the
 * scope fingerprint stays answerable from the index alone.
 */
export function ensureVectorSchema(store: Storage) {
  const columns = store.all<{ name: string }>("PRAGMA table_info(recall_chunks)").map((c) => c.name);
  if (!columns.includes("embedded_seq")) store.db.exec("ALTER TABLE recall_chunks ADD COLUMN embedded_seq INTEGER");
  const indexed = store.all<{ name: string }>("PRAGMA index_info(recall_chunks_embed)").map((c) => c.name);
  if (indexed.length && !indexed.includes("embedded_seq")) store.db.exec("DROP INDEX recall_chunks_embed");
  store.db.exec(`CREATE INDEX IF NOT EXISTS recall_chunks_embed ON recall_chunks(status, embedding_model, embedding_dim, project_id, visibility, embedded_seq);
CREATE TABLE IF NOT EXISTS recall_vector_stamp(id INTEGER PRIMARY KEY CHECK(id=1), n INTEGER NOT NULL);
INSERT OR IGNORE INTO recall_vector_stamp(id,n) VALUES(1,0);`);
}
/** The next write stamp. The caller holds the write transaction, so no other connection can take the same one. */
function nextStamp(store: Storage): number {
  return Number(store.get<{ n: number }>("UPDATE recall_vector_stamp SET n=n+1 WHERE id=1 RETURNING n")?.n ?? 0);
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
  // One stamp for this write, above every stamp any connection has ever written.
  const seq = rows.length ? nextStamp(store) : 0;
  for (const { r, blob } of prepared) {
    const sameText = r.text !== undefined && r.prefix !== undefined;
    const result = store.run(
      `UPDATE recall_chunks SET embedding=?,embedding_model=?,embedding_dim=?,embedded_seq=? WHERE id=? AND kind=? AND ref_id=? AND ref_version=? AND ordinal=? AND status='current'${sameText ? " AND text=? AND prefix=?" : ""}`,
      blob,
      key,
      blob ? dim : r.reason === "rejected" ? -1 : null,
      seq,
      r.id,
      r.kind,
      r.ref_id,
      r.ref_version,
      r.ordinal,
      ...(sameText ? [r.text, r.prefix] : []),
    );
    changed += Number(result.changes);
  }
  if (changed) bumpVectorGeneration();
  return changed;
}

export function clearEmbeddings(store: Storage): number {
  const changed = Number(store.run("UPDATE recall_chunks SET embedding=NULL,embedding_model=NULL,embedding_dim=NULL,embedded_seq=NULL WHERE embedding IS NOT NULL OR embedding_model IS NOT NULL").changes);
  bumpVectorGeneration();
  return changed;
}

type Fingerprint = { count: number; max: number; sum: number; seq: number };
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
const sameFingerprint = (a: Fingerprint, b: Fingerprint) => a.count === b.count && a.max === b.max && a.sum === b.sum && a.seq === b.seq;

/**
 * One contiguous Float32 matrix per (projects, visibilities, status, key, dim). Two triggers:
 *  - this process's generation moved (its own index and vector writes): rebuild, always;
 *  - SQLite's data_version moved (any commit by another connection, including the worker's leases and ledger rows): rebuild only if the
 *    scope's (count, max id, sum of ids, max write stamp) of embedded rows changed, so an unrelated commit costs one index-only aggregate
 *    query, not a full matrix read.
 * Row ids are reused (`recall_chunks.id` has no AUTOINCREMENT, so replacing or purging the newest rows hands their ids to the next insert),
 * so the id terms alone cannot see a vector rewritten under a reused id. The write stamp can: every `writeEmbeddings` call stamps its rows
 * above every stamp ever written, so a vector written into the scope by any connection raises the scope's max stamp, and a vector that
 * leaves it changes the count. A raw SQL write that skips the stamp is seen only when rows join or leave the scope.
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
   * Answered from the recall_chunks_embed index alone (status, model, dim, project, visibility, the write stamp and the rowid are all in it), so it
   * never reads a 4 KB vector or walks its overflow pages. A stored dim is only ever written together with its blob, so `embedding_dim=?` stands for "embedded".
   */
  private fingerprint(store: Storage, sc: Scope): Fingerprint {
    const { where, args } = scopeSql(sc);
    const row = store.get<{ n: number; m: number | null; s: number | null; q: number | null }>(
      `SELECT count(*) AS n, max(id) AS m, sum(id) AS s, max(embedded_seq) AS q FROM recall_chunks WHERE ${where}`,
      ...args,
    );
    return { count: Number(row?.n ?? 0), max: Number(row?.m ?? 0), sum: Number(row?.s ?? 0), seq: Number(row?.q ?? 0) };
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
