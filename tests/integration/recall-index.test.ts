import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Storage } from "../../packages/storage/index.ts";
import { purgeRetainedDeletedSource } from "../../packages/storage/restore-policy.ts";
import { Brain } from "../../packages/domain/service.ts";
import type { Principal } from "../../packages/contracts/index.ts";
import {
  chunkBody,
  chunkPrefix,
  durableBoost,
  factRows,
  rebuildRecallIndex,
  recallRowsFor,
  recallRowsInDb,
  recallIndexComplete,
  searchRecallChunks,
  syncSource,
} from "../../packages/storage/recall-index.ts";

const owner: Principal = { kind: "owner" };
let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.reverse()) fn();
  cleanup = [];
});
function setup(opts: { vault?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "recall-index-test-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const s = new Storage(join(dir, "brain.sqlite"), opts.vault ? { vault: join(dir, "vault") } : {});
  cleanup.push(() => {
    try {
      s.close();
    } catch {}
  });
  return { dir, s, b: new Brain(s, () => new Date("2026-10-25T09:00:00Z")) };
}
const s1Result = (durable: number): any => ({
  model: "clef-flash",
  usage: { input_tokens: 300, output_tokens: 0 },
  cost_micro_usd: 27,
  price_version: "cf-clef-flash-2026-10-01",
  policy_version: "system-one-ask-v1",
  answers: [
    { id: "durable", type: "noul", probability: durable },
    { id: "project", type: "choice", choice: "stay", confidence: 0.5, probabilities: {} },
    { id: "review", type: "noul", probability: 0.1 },
    { id: "show", type: "noul", probability: 0.9 },
  ],
});
/** A claim with exact code-point evidence, through the owner review path. `separate: true` and a unique title keep a repeated entity/value pair from being folded into an earlier, already-reviewed source. */
let acceptCount = 0;
function acceptStatus(b: Brain, project: string, entity: string, value: string) {
  acceptCount++;
  const saved = b.capture(owner, { project_id: project, title: `${entity} status ${acceptCount}`, body: `${entity} status ${value}`, visibility: "project", separate: true }) as any;
  const gate = b.entities(owner, "gate").find((g) => g.data.raw_id === saved.source_id)!;
  const out = b.reviewGate(owner, gate.id, { action: "accept", expected_version: gate.version });
  return { source_id: saved.source_id as string, claim_id: out.claim_ids[0] };
}

describe("chunkBody", () => {
  it("splits on blank lines and sentences, packs 600–900 code points, never exceeds 1,200, and keeps code-point offsets", () => {
    const sentence = "The launch colour is cobalt and the team agreed on it. ";
    const body = `${"🧠".repeat(10)} ${sentence.repeat(30)}\n\n${sentence.repeat(30)}`;
    const points = Array.from(body);
    const chunks = chunkBody(body);
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) {
      expect(points.slice(c.start, c.end).join("")).toBe(c.text);
      expect(Array.from(c.text).length).toBeLessThanOrEqual(1200);
    }
    for (const c of chunks.slice(0, -1)) expect(Array.from(c.text).length).toBeGreaterThanOrEqual(600);
    expect(chunks.map((c) => c.ordinal)).toEqual(chunks.map((_, i) => i));
  });
  it("overlaps the previous chunk's last sentence when it is short, and hard-splits a 5,000-character sentence", () => {
    const short = "Short tail. ";
    const long = "x".repeat(700) + ". ";
    const chunks = chunkBody(`${long}${short}${long}${short}${long}`);
    expect(chunks[1].text.startsWith("Short tail.")).toBe(true);
    const giant = chunkBody("y".repeat(5000));
    expect(giant.every((c) => Array.from(c.text).length <= 1200)).toBe(true);
    expect(giant.at(-1)!.end).toBe(5000);
    expect(chunkBody("   \n\n  ")).toEqual([]);
  });
  it("never exceeds 1,200 code points when a short last sentence would be prepended, and never duplicates a whole chunk", () => {
    const body = "Short tail. " + "x".repeat(1500) + ". " + "Another short one. " + "y".repeat(1100) + ".";
    const points = Array.from(body);
    const chunks = chunkBody(body);
    for (const c of chunks) {
      expect(Array.from(c.text).length).toBeLessThanOrEqual(1200);
      expect(points.slice(c.start, c.end).join("")).toBe(c.text);
    }
    expect(chunks[1].start).toBeGreaterThanOrEqual(chunks[0].end);
    expect(chunks.at(-1)!.end).toBe(points.length);
  });
  it("builds a deterministic prefix with the capture-time topic when present", () => {
    expect(chunkPrefix("Launch notes", "Northstar", "2026-10-18T10:00:00.000Z", null)).toBe("Launch notes · Northstar · 2026-10-18");
    expect(chunkPrefix("Launch notes", "Northstar", "2026-10-18T10:00:00.000Z", "Launch")).toBe("Launch notes · Northstar · 2026-10-18 · Launch");
    expect(durableBoost(0.7)).toBe(1.15);
    expect(durableBoost(0.1)).toBe(0.9);
    expect(durableBoost(0.4)).toBe(1);
    expect(durableBoost(null)).toBe(1);
  });
});

describe("factRows", () => {
  const claim = (over: Record<string, unknown>) => ({
    id: "c1",
    project_id: "p1",
    version: 2,
    created_at: "2026-10-01T00:00:00.000Z",
    data: { entity: "Northstar", aspect: "status", value: "active", status: "current", authority: "owner_reviewed", recorded_at: "2026-10-02T00:00:00.000Z", evidence: [{ source_id: "s", source_version: 1, start: 0, end: 4, quote: "Nort" }], ...over },
  });
  it("makes one current project row per evidenced claim and an owner-only row for names and preferences", () => {
    expect(factRows({ claim: claim({}), projectTitle: "Northstar" })).toEqual([
      { kind: "fact", ref_id: "c1", ref_version: 2, project_id: "p1", visibility: "project", status: "current", ordinal: 0, start: 0, end: 20, text: "Northstar is active.", prefix: "Northstar · Northstar", recorded_at: "2026-10-02T00:00:00.000Z", boost: 1 },
    ]);
    expect(factRows({ claim: claim({ aspect: "name", value: "Ana" }), projectTitle: "P" })[0].visibility).toBe("owner");
    expect(factRows({ claim: claim({ aspect: "statement", value: "x", authority: "owner_private" }), projectTitle: "P" })[0].visibility).toBe("owner");
    expect(factRows({ claim: claim({ status: "retired" }), projectTitle: "P" })[0].status).toBe("history");
    expect(factRows({ claim: claim({ evidence: [] }), projectTitle: "P" })).toEqual([]);
  });
  it("makes a fact owner-only when any of its evidence sources is private", () => {
    const two = { evidence: [{ source_id: "pub", source_version: 1, start: 0, end: 1, quote: "N" }, { source_id: "priv", source_version: 1, start: 0, end: 1, quote: "N" }] };
    expect(factRows({ claim: claim(two), projectTitle: "P", privateSources: new Set(["priv"]) })[0].visibility).toBe("owner");
    expect(factRows({ claim: claim(two), projectTitle: "P", privateSources: new Set(["other"]) })[0].visibility).toBe("project");
  });
});

describe("migration 7 and maintenance", () => {
  it("opens a v6 database, migrates, backfills and answers a search; refuses a v8 database", () => {
    const { dir, s, b } = setup();
    b.capture(owner, { title: "Palette", body: "The launch colour is cobalt.", visibility: "project" });
    s.close();
    const raw = new DatabaseSync(join(dir, "brain.sqlite"));
    raw.exec("DELETE FROM migrations WHERE version=7; DROP TABLE recall_fts; DROP TABLE recall_chunks; DELETE FROM settings WHERE key='recall_index_built'");
    raw.close();
    const again = new Storage(join(dir, "brain.sqlite"));
    cleanup.push(() => {
      try {
        again.close();
      } catch {}
    });
    expect(again.get("SELECT max(version) AS v FROM migrations")!.v).toBe(7);
    expect(recallIndexComplete(again)).toBe(true);
    const hits = searchRecallChunks(again, { match: '"cobalt"', kind: "original", projects: ["inbox"], visibilities: ["project"], status: "current", limit: 60 });
    expect(hits).toHaveLength(1);
    expect(hits[0].text).toContain("cobalt");
    expect(hits[0].score).toBeLessThan(0);
    again.run("INSERT INTO migrations VALUES(8,'2026-10-25T00:00:00.000Z')");
    again.close();
    expect(() => new Storage(join(dir, "brain.sqlite"))).toThrow(/newer Bi Brain version/);
  });

  it("keeps recall_chunks equal to recallRowsFor(portableState) through a seeded random write sequence", () => {
    const { s, b } = setup({ vault: true });
    let seed = 20261025;
    const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    const project = b.createProject(owner, "Northstar");
    const sources: { id: string; version: number }[] = [];
    const claims: { id: string; version: number }[] = [];
    const words = ["cobalt", "amber", "launch", "palette", "Northstar", "beta", "Ana", "Marco"];
    const sentence = () => Array.from({ length: 12 }, () => words[Math.floor(rnd() * words.length)]).join(" ") + ".";
    for (let step = 0; step < 60; step++) {
      const extra = rnd();
      if (extra < 0.12 && sources.length) {
        const src = sources[Math.floor(rnd() * sources.length)];
        try {
          b.recordSystemOneResult({ id: `job${step}`, project_id: "inbox" }, src.id, src.version, s1Result(rnd() < 0.5 ? 0.8 : 0.1));
        } catch {}
      } else if (extra < 0.2 && sources.length) {
        const src = sources[Math.floor(rnd() * sources.length)];
        try {
          const edited = b.editSource(owner, src.id, { title: `Flipped ${step}`, body: sentence(), visibility: rnd() < 0.5 ? "private" : "project", expected_version: src.version });
          src.version = edited.version;
        } catch {}
      }
      const roll = rnd();
      if (roll < 0.35 || sources.length === 0) {
        const r = b.capture(owner, { project_id: rnd() < 0.5 ? "inbox" : project.id, title: `Note ${step}`, body: Array.from({ length: 1 + Math.floor(rnd() * 40) }, sentence).join(rnd() < 0.3 ? "\n\n" : " "), visibility: rnd() < 0.2 ? "private" : "project", separate: true }) as any;
        sources.push({ id: r.source_id, version: 1 });
      } else if (roll < 0.5) {
        const sIdx = Math.floor(rnd() * sources.length);
        const src = sources[sIdx];
        try {
          const edited = b.editSource(owner, src.id, { title: `Edited ${step}`, body: sentence() + "\n\n" + sentence(), expected_version: src.version });
          src.version = edited.version;
        } catch {}
      } else if (roll < 0.6) {
        const src = sources[Math.floor(rnd() * sources.length)];
        try {
          b.removeSource(owner, src.id, src.version, rnd() < 0.5);
          sources.splice(sources.indexOf(src), 1);
        } catch {}
      } else if (roll < 0.8) {
        const entity = `e${Math.floor(rnd() * 5)}`;
        try {
          const { claim_id } = acceptStatus(b, "inbox", entity, rnd() < 0.5 ? "active" : "paused");
          const c = b.entity(owner, claim_id);
          claims.push({ id: c.id, version: c.version });
        } catch {}
        for (const other of claims) {
          try {
            other.version = b.entity(owner, other.id).version;
          } catch {}
        }
      } else if (roll < 0.9 && claims.length) {
        const c = claims[Math.floor(rnd() * claims.length)];
        try {
          const row = b.entity(owner, c.id);
          b.retireClaim(owner, c.id, row.version);
        } catch {}
      } else if (claims.length) {
        const c = claims[Math.floor(rnd() * claims.length)];
        try {
          b.confirmClaim(owner, c.id);
        } catch {}
      }
      expect(recallRowsInDb(s)).toEqual(recallRowsFor(s.portableState()));
    }
    expect(s.get<any>("SELECT count(*) AS n FROM entities WHERE kind='s1_answer'")!.n).toBeGreaterThan(0);
    s.rebuild();
    expect(recallIndexComplete(s)).toBe(true);
    expect(recallRowsInDb(s)).toEqual(recallRowsFor(s.portableState()));
    expect(JSON.stringify(s.portableState())).not.toContain("recall_chunks");
  }, 120_000);

  it("a 100k-character note indexes in one short transaction with exact offsets", () => {
    const { s, b } = setup();
    const paragraph = "Ordinary planning text that fills the page without saying much at all. ";
    const body = paragraph.repeat(1400) + "\n\nThe final answer is TOPAZ_SENTINEL and nothing else.";
    expect(Array.from(body).length).toBeGreaterThan(99_000);
    const saved = b.capture(owner, { title: "Long", body, visibility: "project" }) as any;
    // Whole-capture time is dominated by pre-existing work (about 600 ms here, indexing is about 13 ms), so the bound is on the index write itself.
    const started = performance.now();
    s.transaction(() => syncSource(s, saved.source_id));
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(400);
    const rows = s.all<any>("SELECT * FROM recall_chunks WHERE ref_id=? ORDER BY ordinal", saved.source_id);
    expect(rows.length).toBeGreaterThan(80);
    const points = Array.from(body);
    for (const r of rows) expect(points.slice(r.start, r.end).join("")).toBe(r.text);
    const [hit] = searchRecallChunks(s, { match: '"topaz_sentinel"', kind: "original", projects: ["inbox"], visibilities: ["project"], status: "current", limit: 60 });
    expect(hit.text).toContain("TOPAZ_SENTINEL");
  });

  it("purge removes every recall row and the forget proof counts them", () => {
    const { s, b } = setup({ vault: true });
    const saved = b.capture(owner, { title: "Gone", body: "The GRANITE_SENTINEL lives here.", visibility: "project" }) as any;
    expect(s.all("SELECT id FROM recall_chunks WHERE ref_id=?", saved.source_id)).toHaveLength(1);
    const result = b.removeSource(owner, saved.source_id, 1, true) as any;
    expect(s.all("SELECT id FROM recall_chunks WHERE ref_id=?", saved.source_id)).toHaveLength(0);
    expect(result.proof.index_gone).toBe(true);
    expect(result.proof.embedding_gone).toBe(true);
    expect(result.proof.per_store.sqlite_recall_rows).toBe(0);
    expect(result.proof.per_store.sqlite_recall_text_matches).toBe(0);
    expect(result.proof.per_store.sqlite_recall_orphan_facts).toBe(0);
    expect(result.proof.per_store.embeddings).toEqual({ configured: false, active_artifacts: 0 });
  });

  it("the restore-policy purge and the vault migration leave no fact row behind for an erased source", () => {
    const { s, b } = setup();
    const saved = b.capture(owner, { title: "Erased", body: "Erased status active", visibility: "project" }) as any;
    const gate = b.entities(owner, "gate").find((g) => g.data.raw_id === saved.source_id)!;
    b.reviewGate(owner, gate.id, { action: "accept", expected_version: gate.version });
    expect(s.all("SELECT id FROM recall_chunks WHERE kind='fact'").length).toBe(1);
    s.run("UPDATE sources SET state='deleted' WHERE id=?", saved.source_id);
    purgeRetainedDeletedSource(s, saved.source_id);
    expect(s.all("SELECT id FROM recall_chunks WHERE kind='fact'")).toEqual([]);
    expect(s.all("SELECT c.id FROM recall_chunks c LEFT JOIN entities e ON e.id=c.ref_id WHERE c.kind='fact' AND e.id IS NULL")).toEqual([]);
  });

  it("a sorting answer arriving after capture re-weights the note in the index", () => {
    const { s, b } = setup();
    const saved = b.capture(owner, { title: "Plan", body: "The launch colour is cobalt.", visibility: "project" }) as any;
    expect(s.get<any>("SELECT boost FROM recall_chunks WHERE ref_id=?", saved.source_id)!.boost).toBe(1);
    expect(b.recordSystemOneResult({ id: "j1", project_id: "inbox" }, saved.source_id, 1, s1Result(0.8)).recorded).toBe(true);
    expect(s.get<any>("SELECT boost FROM recall_chunks WHERE ref_id=?", saved.source_id)!.boost).toBe(1.15);
    expect(recallRowsInDb(s)).toEqual(recallRowsFor(s.portableState()));
  });

  it("a crash in the middle of a rebuild leaves the index flagged incomplete and the next open finishes it", () => {
    const { dir, s, b } = setup();
    for (let i = 0; i < 3; i++) b.capture(owner, { title: `N${i}`, body: `Note number ${i} about cobalt.`, visibility: "project", separate: true });
    const real = s.transaction.bind(s);
    let calls = 0;
    (s as any).transaction = (fn: () => unknown) => {
      if (++calls === 3) throw new Error("crash");
      return real(fn);
    };
    expect(() => rebuildRecallIndex(s, 1)).toThrow("crash");
    (s as any).transaction = real;
    expect(recallIndexComplete(s)).toBe(false);
    s.close();
    const again = new Storage(join(dir, "brain.sqlite"));
    cleanup.push(() => {
      try {
        again.close();
      } catch {}
    });
    expect(recallIndexComplete(again)).toBe(true);
    expect(recallRowsInDb(again).length).toBe(3);
    expect(recallRowsInDb(again)).toEqual(recallRowsFor(again.portableState()));
    rebuildRecallIndex(again, 1);
    expect(recallRowsInDb(again)).toEqual(recallRowsFor(again.portableState()));
  });

  it("forgetting a note is not blocked by another live note that shares its paragraph, and leaves that note indexed", () => {
    const { s, b } = setup({ vault: true });
    const body = "The shared GRANITE paragraph appears in two notes.";
    const a = b.capture(owner, { title: "First", body, visibility: "project", separate: true }) as any;
    const other = b.capture(owner, { title: "Second", body, visibility: "project", separate: true }) as any;
    const result = b.removeSource(owner, a.source_id, 1, true) as any;
    expect(result.proof.index_gone).toBe(true);
    expect(result.proof.per_store.sqlite_recall_text_matches).toBe(0);
    expect(s.all("SELECT id FROM recall_chunks WHERE ref_id=?", other.source_id)).toHaveLength(1);
  });

  it("the restore-policy purge removes only the erased source's rows and leaves other rows untouched", () => {
    const { s, b } = setup();
    const keep = b.capture(owner, { title: "Keep", body: "Keep this cobalt note.", visibility: "project", separate: true }) as any;
    const gone = b.capture(owner, { title: "Gone", body: "Gone status active", visibility: "project", separate: true }) as any;
    const gate = b.entities(owner, "gate").find((g) => g.data.raw_id === gone.source_id)!;
    b.reviewGate(owner, gate.id, { action: "accept", expected_version: gate.version });
    const keptIds = s.all<any>("SELECT id FROM recall_chunks WHERE ref_id=?", keep.source_id).map((r) => r.id);
    s.run("UPDATE sources SET state='deleted' WHERE id=?", gone.source_id);
    purgeRetainedDeletedSource(s, gone.source_id);
    expect(s.all<any>("SELECT id FROM recall_chunks WHERE ref_id=?", keep.source_id).map((r) => r.id)).toEqual(keptIds);
    expect(recallRowsInDb(s)).toEqual(recallRowsFor(s.portableState()));
  });

  it("a claim that cites a private source is owner-only, and follows the source when its visibility changes", () => {
    const { s, b } = setup();
    const secret = b.capture(owner, { title: "Secret", body: "Northstar status active", visibility: "private" }) as any;
    const claim = b.createEntity("inbox", "claim", {
      entity: "Northstar", aspect: "status", value: "active", status: "current", authority: "owner_reviewed", recorded_at: "2026-10-02T00:00:00.000Z",
      evidence: [{ source_id: secret.source_id, source_version: 1, start: 0, end: 9, quote: "Northstar" }],
    });
    expect(s.get<any>("SELECT visibility FROM recall_chunks WHERE ref_id=?", claim.id)!.visibility).toBe("owner");
    b.editSource(owner, secret.source_id, { title: "Secret", body: "Northstar status active", visibility: "project", expected_version: 1 });
    expect(s.get<any>("SELECT visibility FROM recall_chunks WHERE ref_id=?", claim.id)!.visibility).toBe("project");
    expect(recallRowsInDb(s)).toEqual(recallRowsFor(s.portableState()));
  });

  it("any query string yields rows or nothing, never a SQLite error, when passed through the match parameter as a quoted term", () => {
    const { s, b } = setup();
    b.capture(owner, { title: "T", body: "plain text", visibility: "project" });
    for (const raw of ['"', ":", "NOT", "*", "(", "^", "🧠", "தமிழ்", "a".repeat(10_000)]) {
      const term = '"' + raw.replace(/"/g, '""') + '"';
      expect(() => searchRecallChunks(s, { match: term, kind: "original", projects: ["inbox"], visibilities: ["project"], status: "current", limit: 60 })).not.toThrow();
    }
  });
});
