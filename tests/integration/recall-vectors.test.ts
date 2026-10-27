import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../../packages/storage/index.ts";
import { Brain } from "../../packages/domain/service.ts";
import type { Principal } from "../../packages/contracts/index.ts";
import { purgeRef, recallCountsForSource } from "../../packages/storage/recall-index.ts";
import { VectorCache, clearEmbeddings, countEmbedRows, pendingEmbedRows, vectorGeneration, writeEmbeddings } from "../../packages/storage/recall-vectors.ts";
import { encodeVector, normalize } from "../../packages/domain/better-search.ts";

const owner: Principal = { kind: "owner" };
const KEY = "ollama:test:none";
const OTHER = "ollama:other:none";
let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.reverse()) fn();
  cleanup = [];
});
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "recall-vectors-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const s = new Storage(join(dir, "brain.sqlite"));
  cleanup.push(() => s.close());
  return { s, b: new Brain(s, () => new Date("2026-10-27T09:00:00Z")) };
}
let n = 0;
/** A reviewed status claim. Its capture is a third, project-visible source ("<entity> status N"), which the index also holds. */
function acceptStatus(b: Brain, project: string, entity: string, value: string) {
  n++;
  const saved = b.capture(owner, { project_id: project, title: `${entity} status ${n}`, body: `${entity} status ${value}`, visibility: "project", separate: true }) as any;
  const gate = b.entities(owner, "gate").find((g) => g.data.raw_id === saved.source_id)!;
  return { claim_id: b.reviewGate(owner, gate.id, { action: "accept", expected_version: gate.version }).claim_ids[0] as string, source_id: saved.source_id as string };
}
const vec = (...xs: number[]) => normalize(Float32Array.from(xs));

describe("pending rows and guarded writes", () => {
  it("lists only current rows the provider may see, writes under a (kind, ref, version, ordinal) guard, and marks withheld rows", () => {
    const { s, b } = setup();
    const pub = b.capture(owner, { title: "Public", body: "The launch colour is cobalt.", visibility: "project" }) as any;
    const priv = b.capture(owner, { title: "Journal", body: "PRIVATE_CANARY_TEXT not sure.", visibility: "private" }) as any;
    const { claim_id: claimId, source_id: statusSrc } = acceptStatus(b, "inbox", "Northstar", "active");
    const nameRow = s.run("INSERT INTO recall_chunks(kind,ref_id,ref_version,project_id,visibility,status,ordinal,start,end,text,prefix,recorded_at,boost) VALUES('fact','name-claim',1,'inbox','owner','current',0,0,5,'Owner: Ana','Inbox · Owner','2026-10-27T00:00:00.000Z',1)");
    const cloud = pendingEmbedRows(s, KEY, ["project"], 32);
    expect(cloud.map((r) => r.ref_id).sort()).toEqual([pub.source_id, statusSrc, claimId].sort());
    expect(cloud.every((r) => r.text && r.prefix)).toBe(true);
    const local = pendingEmbedRows(s, KEY, ["project", "private", "owner"], 32);
    expect(local.map((r) => r.ref_id).sort()).toEqual([pub.source_id, priv.source_id, statusSrc, claimId, "name-claim"].sort());
    expect(pendingEmbedRows(s, KEY, ["project"], 1)).toHaveLength(1);
    const before = vectorGeneration();
    const row = cloud.find((r) => r.ref_id === pub.source_id)!;
    const changed = s.transaction(() => writeEmbeddings(s, KEY, 2, [
      { ...row, vector: vec(1, 0) },
      { ...row, ref_version: 99, vector: vec(0, 1) },
      { ...cloud.find((r) => r.ref_id === claimId)!, vector: null, reason: "secret" },
    ]));
    expect(changed).toBe(2);
    expect(vectorGeneration()).toBeGreaterThan(before);
    const stored = s.get<any>("SELECT embedding, embedding_model, embedding_dim FROM recall_chunks WHERE id=?", row.id)!;
    expect(Buffer.from(stored.embedding).equals(encodeVector(vec(1, 0)))).toBe(true);
    expect(stored).toMatchObject({ embedding_model: KEY, embedding_dim: 2 });
    const withheld = s.get<any>("SELECT embedding, embedding_model, embedding_dim FROM recall_chunks WHERE kind='fact' AND ref_id=?", claimId)!;
    expect(withheld).toEqual({ embedding: null, embedding_model: KEY, embedding_dim: null });
    // The status source's row is still pending; the withheld fact and the written note are not.
    expect(pendingEmbedRows(s, KEY, ["project"], 32).map((r) => r.ref_id)).toEqual([statusSrc]);
    expect(countEmbedRows(s, KEY, ["project"])).toEqual({ total: 3, embedded: 1, pending: 1, withheld: 1 });
    expect(pendingEmbedRows(s, OTHER, ["project"], 32)).toHaveLength(3);
    expect(recallCountsForSource(s, pub.source_id, []).embedded).toBe(1);
    expect(Number(nameRow.lastInsertRowid)).toBeGreaterThan(0);
    // A rejected row is withheld with dim -1 and counted the same way; the settings table never gains a row for any of this.
    s.transaction(() => writeEmbeddings(s, KEY, 2, [{ ...cloud.find((r) => r.ref_id === statusSrc)!, vector: null, reason: "rejected" }]));
    expect(s.get<any>("SELECT embedding_dim FROM recall_chunks WHERE kind='original' AND ref_id=?", statusSrc)).toEqual({ embedding_dim: -1 });
    expect(countEmbedRows(s, KEY, ["project"])).toEqual({ total: 3, embedded: 1, pending: 0, withheld: 2 });
    expect(s.all("SELECT key FROM settings WHERE key LIKE '%vector%' OR key LIKE '%generation%'")).toEqual([]);
  });
  it("an edit replaces the rows, so a write for the old row lands nowhere, and clearing empties every vector", () => {
    const { s, b } = setup();
    const src = b.capture(owner, { title: "Note", body: "First body about cobalt.", visibility: "project" }) as any;
    const [old] = pendingEmbedRows(s, KEY, ["project"], 32);
    b.editSource(owner, src.source_id, { title: "Note", body: "Second body about amber.", expected_version: 1 });
    expect(s.transaction(() => writeEmbeddings(s, KEY, 2, [{ ...old, vector: vec(1, 0) }]))).toBe(0);
    expect(Number(s.get("SELECT count(*) AS n FROM recall_chunks WHERE ref_id=? AND embedding IS NOT NULL", src.source_id)!.n)).toBe(0);
    const [fresh] = pendingEmbedRows(s, KEY, ["project"], 32);
    expect(fresh.ref_version).toBe(2);
    s.transaction(() => writeEmbeddings(s, KEY, 2, [{ ...fresh, vector: vec(1, 0) }]));
    const g = vectorGeneration();
    expect(clearEmbeddings(s)).toBe(1);
    expect(vectorGeneration()).toBeGreaterThan(g);
    expect(s.get<any>("SELECT embedding, embedding_model, embedding_dim FROM recall_chunks WHERE id=?", fresh.id)).toEqual({ embedding: null, embedding_model: null, embedding_dim: null });
  });
});

describe("VectorCache.search", () => {
  function seeded() {
    const { s, b } = setup();
    const p = b.createProject(owner, "Northstar");
    const mk = (title: string, project: string, visibility: "project" | "private" = "project") => (b.capture(owner, { project_id: project, title, body: `${title} body.`, visibility, separate: true }) as any).source_id as string;
    const a = mk("A", "inbox"), bb = mk("B", "inbox"), c = mk("C", "inbox"), d = mk("D", p.id), e = mk("E", "inbox", "private");
    const rows = pendingEmbedRows(s, KEY, ["project", "private", "owner"], 32);
    const byRef = (id: string) => rows.find((r) => r.ref_id === id)!;
    s.transaction(() => writeEmbeddings(s, KEY, 4, [
      { ...byRef(a), vector: vec(1, 0, 0, 0) },
      { ...byRef(bb), vector: vec(0.6, 0.8, 0, 0) },
      { ...byRef(c), vector: vec(0.3, 0.9539, 0, 0) },
      { ...byRef(d), vector: vec(1, 0, 0, 0) },
      { ...byRef(e), vector: vec(0.99, 0.141, 0, 0) },
    ]));
    return { s, b, ids: { a, b: bb, c, d, e }, byRef };
  }
  const q = (over: Partial<Parameters<VectorCache["search"]>[1]> = {}) => ({ vector: vec(1, 0, 0, 0), key: KEY, dim: 4, projects: ["inbox"], visibilities: ["project" as const], status: "current" as const, floor: 0.45, limit: 60, ...over });
  it("returns scope-filtered rows at or above the floor by cosine, respecting projects, visibilities, key and dim", () => {
    const { s, ids } = seeded();
    const cache = new VectorCache();
    const hits = cache.search(s, q());
    expect(hits.map((h) => [h.ref_id, Number(h.score.toFixed(2))])).toEqual([[ids.a, 1], [ids.b, 0.6]]);
    expect(hits[0]).toMatchObject({ kind: "original", project_id: "inbox", visibility: "project", status: "current", ordinal: 0 });
    // Cosines: a = 1.00, e = 0.99, b = 0.60.
    expect(cache.search(s, q({ visibilities: ["project", "private"] })).map((h) => h.ref_id)).toEqual([ids.a, ids.e, ids.b]);
    expect(cache.search(s, q({ projects: ["inbox", s.get<any>("SELECT project_id FROM sources WHERE id=?", ids.d)!.project_id] })).map((h) => h.ref_id)).toEqual([ids.a, ids.d, ids.b]);
    expect(cache.search(s, q({ floor: 0.0, limit: 2 })).map((h) => h.ref_id)).toEqual([ids.a, ids.b]);
    expect(cache.search(s, q({ key: OTHER }))).toEqual([]);
    expect(cache.search(s, q({ dim: 3, vector: vec(1, 0, 0) }))).toEqual([]);
    expect(cache.search(s, q({ projects: [] }))).toEqual([]);
  });
  it("sees a write made after the matrix was cached: own writes through the in-process generation, another connection's through data_version, with no settings row", () => {
    const { s, ids, byRef } = seeded();
    const cache = new VectorCache();
    expect(cache.search(s, q()).map((h) => h.ref_id)).toEqual([ids.a, ids.b]);
    // Another process's write: a second Storage handle (its own SQLite connection) on the same file, so this process's counter never moves.
    const again = new Storage(s.path);
    cleanup.push(() => again.close());
    again.transaction(() => writeEmbeddings(again, KEY, 4, [{ ...byRef(ids.c), vector: vec(1, 0, 0, 0) }]));
    expect(cache.search(s, q()).map((h) => h.ref_id)).toEqual([ids.a, ids.c, ids.b]);
    s.transaction(() => purgeRef(s, "original", ids.a));
    expect(cache.search(s, q()).map((h) => h.ref_id)).toEqual([ids.c, ids.b]);
    again.transaction(() => clearEmbeddings(again));
    expect(cache.search(s, q())).toEqual([]);
    expect(s.all("SELECT key FROM settings WHERE key LIKE '%vector%' OR key LIKE '%generation%'")).toEqual([]);
  });
  it("scans 20,000 rows of 64 dims in under 150 ms once cached", () => {
    const { s } = setup();
    const dim = 64;
    s.transaction(() => {
      for (let i = 0; i < 20_000; i++) {
        const v = new Float32Array(dim);
        for (let d = 0; d < dim; d++) v[d] = Math.sin(i * 31 + d);
        s.run("INSERT INTO recall_chunks(kind,ref_id,ref_version,project_id,visibility,status,ordinal,start,end,text,prefix,recorded_at,boost,embedding,embedding_model,embedding_dim) VALUES('original',?,1,'inbox','project','current',0,0,4,'text','p','2026-10-27T00:00:00.000Z',1,?,?,?)", `s${i}`, encodeVector(normalize(v)), KEY, dim);
      }
    });
    const cache = new VectorCache();
    const query = new Float32Array(dim).fill(0.1);
    cache.search(s, q({ vector: normalize(query), dim, floor: 0.9 }));
    const t = performance.now();
    const hits = cache.search(s, q({ vector: normalize(query), dim, floor: -1, limit: 60 }));
    expect(performance.now() - t).toBeLessThan(150);
    expect(hits).toHaveLength(60);
    expect(hits[0].score).toBeGreaterThanOrEqual(hits[59].score);
  }, 60_000);
});

describe("non-finite vectors", () => {
  it("never writes or scores a NaN or infinite vector", () => {
    const { s, b } = setup();
    const src = b.capture(owner, { title: "Note", body: "Body about cobalt.", visibility: "project" }) as any;
    const [row] = pendingEmbedRows(s, KEY, ["project"], 32);
    // A huge finite provider value that overflows Float32 to Infinity and normalises to NaN.
    const huge = normalize(Float32Array.from([1e39, 1]));
    for (const bad of [Float32Array.from([Number.NaN, 1]), Float32Array.from([Number.POSITIVE_INFINITY, 1]), Float32Array.from([Number.NEGATIVE_INFINITY, 1]), huge]) {
      expect(() => s.transaction(() => writeEmbeddings(s, KEY, 2, [{ ...row, vector: bad }]))).toThrow(/finite/i);
    }
    expect(s.get<any>("SELECT embedding, embedding_model FROM recall_chunks WHERE ref_id=?", src.source_id)).toEqual({ embedding: null, embedding_model: null });
    // A row that already holds a non-finite blob (written by an older or foreign process) is never loaded into the matrix.
    const nan = Buffer.alloc(8);
    nan.writeFloatLE(Number.NaN, 0);
    nan.writeFloatLE(1, 4);
    s.run("UPDATE recall_chunks SET embedding=?, embedding_model=?, embedding_dim=2 WHERE id=?", nan, KEY, row.id);
    const good = b.capture(owner, { title: "Other", body: "Other body.", visibility: "project", separate: true }) as any;
    const goodRow = pendingEmbedRows(s, KEY, ["project"], 32).find((r) => r.ref_id === good.source_id)!;
    s.transaction(() => writeEmbeddings(s, KEY, 2, [{ ...goodRow, vector: vec(1, 0) }]));
    const hits = new VectorCache().search(s, { vector: vec(1, 0), key: KEY, dim: 2, projects: ["inbox"], visibilities: ["project"], status: "current", floor: -1, limit: 10 });
    expect(hits.map((h) => h.ref_id)).toEqual([good.source_id]);
    expect(hits.every((h) => Number.isFinite(h.score))).toBe(true);
  });
});
