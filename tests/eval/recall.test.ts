import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Storage } from "../../packages/storage/index.ts";
import { Brain } from "../../packages/domain/service.ts";
import { buildFixture, claim, owner, type Fixture } from "./recall-fixture.ts";
import { deterministicLevel } from "../../packages/domain/recall.ts";
import { embedFixture } from "./dense-fixture.ts";
import type { QueryVector } from "../../packages/domain/better-search.ts";
import type { RecallResult } from "../../packages/domain/recall.ts";

const golden = JSON.parse(readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "recall-golden-v1.json"), "utf8")) as {
  cases: { id: string; tags: string[]; principal: "owner" | "agent"; query: string; history?: boolean; expect: { status: string | string[]; must_include: string[]; must_exclude: string[]; freshness: Record<string, string> } }[];
};
let fx: Fixture;
let fxDense: Fixture;
let denseFor: (q: string) => QueryVector;
let dir: string;
const results = new Map<string, RecallResult>();
const denseResults = new Map<string, RecallResult>();
const principalOf = (f: Fixture, c: { principal: string }) => (c.principal === "owner" ? owner : f.agent);
const metrics: Record<string, number> = {};
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "recall-eval-"));
  fx = buildFixture(join(dir, "brain.sqlite"));
  for (const c of golden.cases)
    results.set(c.id, fx.brain.recallCore(c.principal === "owner" ? owner : fx.agent, { query: c.query, history: c.history ?? false, limit: 8 }));
  fxDense = buildFixture(join(dir, "dense.sqlite"));
  ({ dense: denseFor } = embedFixture(fxDense));
  for (const c of golden.cases) denseResults.set(c.id, fxDense.brain.recallCore(principalOf(fxDense, c), { query: c.query, history: c.history ?? false, limit: 8 }, denseFor(c.query)));
});
afterAll(() => {
  fx.store.close();
  fxDense.store.close();
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(resolve("data"), { recursive: true });
  writeFileSync(resolve("data/recall-eval-metrics.json"), JSON.stringify({ golden_version: 2, cases: golden.cases.length, ...metrics }, null, 2));
});
const idsIn = (r: RecallResult) => [...r.hits.map((h) => h.id), ...r.near_misses.map((n) => n.id)];
// The caller's own query is echoed in `searched.query`; it is input, not retrieved data, so canary scans blank it.
const everywhere = (r: RecallResult) => JSON.stringify({ ...r, searched: { ...r.searched, query: "" } });
const positives = () => golden.cases.filter((c) => c.tags.includes("positive"));
const bm25Cases = () => golden.cases.filter((c) => !c.tags.includes("dense"));

/** A throwaway fixture for tests that mutate the brain. */
function scratch<T>(fn: (f: Fixture, northstar: string) => T): T {
  const d = mkdtempSync(join(tmpdir(), "recall-scratch-"));
  const f = buildFixture(join(d, "brain.sqlite"));
  try {
    return fn(f, f.ids["project:northstar"]);
  } finally {
    vi.restoreAllMocks();
    f.store.close();
    rmSync(d, { recursive: true, force: true });
  }
}
const note = (f: Fixture, project: string, title: string, body: string, visibility: "project" | "private" = "project") => {
  const r = f.brain.capture(owner, { project_id: project, title, body, visibility, separate: true }) as any;
  return { id: r.source_id as string, body, version: 1 };
};
const fact = (f: Fixture, key: string, project: string, source: { id: string; body: string; version: number }, c: Omit<Parameters<typeof claim>[5], "recorded_at"> & { recorded_at?: string }) =>
  claim(f.brain, key, f.ids, project, source, { recorded_at: "2026-10-24T10:00:00.000Z", ...c });

describe("recall fix round 1", () => {
  it("an expired fact is withheld from recall and from an unversioned open; with history it is marked retired, and a replaced fact opens marked replaced", () => {
    scratch((f, ns) => {
      const src = note(f, ns, "Offer note", "The early-bird offer code is MANGO7 for partners.");
      fact(f, "fact:expired", ns, src, { entity: "Early bird offer", aspect: "statement", value: "code MANGO7", quote: "The early-bird offer code is MANGO7", valid_to: "2026-10-24T00:00:00.000Z" });
      const id = f.ids["fact:expired"];
      for (const principal of [owner, f.agent]) {
        expect(f.brain.recallCore(principal, { query: "early bird offer code" }).hits.map((h) => h.id)).not.toContain(id);
        const past = f.brain.recallCore(principal, { query: "early bird offer code", history: true }).hits.find((h) => h.id === id);
        expect(past?.freshness).toBe("retired");
      }
      expect(() => f.brain.agentOpen(f.agent, { id })).toThrow(/unavailable/i);
      const opened = f.brain.agentOpen(f.agent, { id, version: 1 }) as any;
      expect(opened.item.freshness).toBe("retired");
      const old = f.brain.agentOpen(f.agent, { id: f.ids["fact:status-old"] }) as any;
      expect(old.item.freshness).toBe("replaced");
      expect(old.item.replaced_by).toBe(f.ids["fact:status-new"]);
      expect((f.brain.agentOpen(f.agent, { id: f.ids["fact:launch-color"] }) as any).item.freshness).toBe("current");
    });
  });
  it("an exact entity name never confirms a fact whose only evidence is private (existence oracle)", () => {
    scratch((f, ns) => {
      const priv = note(f, ns, "Private ledger", "Zorbex Initiative status is on hold pending the audit.", "private");
      fact(f, "fact:zorbex", ns, priv, { entity: "Zorbex Initiative", aspect: "status", value: "on hold", quote: "Zorbex Initiative status is on hold" });
      for (const history of [false, true]) {
        const { result, signals, entityNames } = f.brain.recallInternal(f.agent, { query: "Zorbex Initiative", history, limit: 8 });
        expect(result).toMatchObject({ status: "no_match", hits: [], near_misses: [] });
        expect(signals.exactEntity).toBe(false);
        expect(deterministicLevel(signals)).toBe("none");
        expect(entityNames).toEqual([]);
        expect(everywhere(result)).not.toContain("Zorbex");
      }
      const mine = f.brain.recallInternal(owner, { query: "Zorbex Initiative", history: false, limit: 8 });
      expect(mine.signals.exactEntity).toBe(true);
      expect(mine.result.hits.map((h) => h.id)).toContain(f.ids["fact:zorbex"]);
    });
  });
  it("an unevidenced claim (hypothesis) is excluded explicitly, and an unexpected fault is not swallowed", () => {
    scratch((f, ns) => {
      const id = randomUUID();
      f.brain.createEntity(ns, "claim", { entity: "Wibble plan", aspect: "statement", value: "unevidenced guess", status: "current", authority: "owner_reviewed", valid_from: "2026-10-24T10:00:00.000Z", recorded_at: "2026-10-24T10:00:00.000Z", evidence: [], supersedes: [], conflicts_with: [] }, id);
      // The index never holds such a claim; plant a row anyway to prove the service itself refuses to present it.
      const planted = f.store.run(
        "INSERT INTO recall_chunks(kind,ref_id,ref_version,project_id,visibility,status,ordinal,start,end,text,prefix,recorded_at,boost) VALUES('fact',?,1,?,'project','current',0,0,30,'Wibble plan: unevidenced guess','Northstar · Wibble plan','2026-10-24T00:00:00.000Z',1)",
        id,
        ns,
      );
      f.store.run("INSERT INTO recall_fts(rowid,text,prefix) VALUES(?,?,?)", Number(planted.lastInsertRowid), "Wibble plan: unevidenced guess", "Northstar · Wibble plan");
      for (const principal of [owner, f.agent]) {
        const r = f.brain.recallCore(principal, { query: "wibble unevidenced guess" });
        expect(everywhere(r)).not.toContain(id);
        expect(r.searched.candidates).toBe(0);
      }
      vi.spyOn(f.brain, "source").mockImplementation(() => {
        throw new TypeError("boom");
      });
      expect(() => f.brain.recallCore(owner, { query: "launch notes cobalt palette" })).toThrow("boom");
    });
  });
  it("a historical version never opens an owner-private or private-evidence fact for an agent", () => {
    scratch((f, ns) => {
      const open = note(f, ns, "Policy note", "The refund window is 30 days for annual plans.");
      const priv = note(f, ns, "Private policy", "The partner rebate is 12 percent for the largest accounts.", "private");
      fact(f, "fact:pub", ns, open, { entity: "Refund window", aspect: "statement", value: "30 days", quote: "The refund window is 30 days" });
      fact(f, "fact:ownerpriv", ns, open, { entity: "Annual plans", aspect: "statement", value: "owner only", quote: "for annual plans", authority: "owner_private" });
      fact(f, "fact:privev", ns, priv, { entity: "Partner rebate", aspect: "statement", value: "12 percent", quote: "The partner rebate is 12 percent" });
      for (const key of ["fact:pub", "fact:ownerpriv", "fact:privev"]) f.brain.reviseClaim(owner, f.ids[key], { expected_version: 1, value: "revised" });
      expect((f.brain.agentOpen(f.agent, { id: f.ids["fact:pub"], version: 1 }) as any).kind).toBe("claim");
      for (const key of ["fact:ownerpriv", "fact:privev"]) {
        expect(() => f.brain.agentOpen(f.agent, { id: f.ids[key], version: 1 }), `${key} version`).toThrow(/unavailable/i);
        expect(() => f.brain.agentOpen(f.agent, { id: f.ids[key], version: 2 }), `${key} current`).toThrow(/unavailable/i);
        expect(() => f.brain.agentOpen(f.agent, { id: f.ids[key], compare_version: 1 }), `${key} compare`).toThrow(/unavailable/i);
      }
    });
  });
  it("compare reports changed only when the stored item differs", () => {
    scratch((f, ns) => {
      const src = note(f, ns, "Menu", "Lunch is served at noon.");
      fact(f, "fact:menu", ns, src, { entity: "Lunch", aspect: "statement", value: "noon", quote: "Lunch is served at noon" });
      f.brain.reviseClaim(owner, f.ids["fact:menu"], { expected_version: 1, value: "one oclock" });
      const id = f.ids["fact:menu"];
      const changed = (input: Record<string, unknown>) => (f.brain.agentOpen(f.agent, input) as any).compare.changed;
      expect(changed({ id, compare_version: 1 })).toBe(true);
      expect(changed({ id, version: 1, compare_version: 2 })).toBe(true);
      expect(changed({ id, version: 2, compare_version: 2 })).toBe(false);
      expect(changed({ id, version: 1, compare_version: 1 })).toBe(false);
      expect(changed({ id, compare_version: 2 })).toBe(false);
      const plain = note(f, ns, "Shopping list", "Buy oat milk.");
      f.brain.editSource(owner, plain.id, { title: "Shopping list", body: "Buy oat milk and rice.", expected_version: 1 });
      expect(changed({ id: plain.id, compare_version: 1 })).toBe(true);
      expect(changed({ id: plain.id, version: 2, compare_version: 2 })).toBe(false);
    });
  });
});

describe("recall golden set v1", () => {
  it("recall@5 on positives is at least 0.90 and MRR at least 0.75", () => {
    let hits = 0;
    let rr = 0;
    for (const c of positives()) {
      const r = results.get(c.id)!;
      const want = c.expect.must_include.map((k) => fx.ids[k]);
      const top5 = r.hits.slice(0, 5).map((h) => h.id);
      if (want.every((id) => top5.includes(id))) hits++;
      const rank = r.hits.findIndex((h) => want.includes(h.id));
      if (rank >= 0) rr += 1 / (rank + 1);
    }
    metrics.recall_at_5 = hits / positives().length;
    metrics.mrr = rr / positives().length;
    expect(metrics.recall_at_5).toBeGreaterThanOrEqual(0.9);
    expect(metrics.mrr).toBeGreaterThanOrEqual(0.75);
  });
  it("no_match rate on negatives is at least 0.85 and no negative is found", () => {
    const negatives = golden.cases.filter((c) => c.tags.includes("negative"));
    const noMatch = negatives.filter((c) => results.get(c.id)!.status === "no_match").length;
    metrics.no_match_rate = noMatch / negatives.length;
    expect(metrics.no_match_rate).toBeGreaterThanOrEqual(0.85);
    for (const c of negatives) expect(results.get(c.id)!.status).not.toBe("found");
  });
  it("a replaced fact is never current, and with history it carries replaced_by (hard)", () => {
    for (const c of golden.cases.filter((x) => x.tags.includes("replaced"))) {
      const r = results.get(c.id)!;
      const old = r.hits.find((h) => h.id === fx.ids["fact:status-old"]);
      if (!c.history) expect(old).toBeUndefined();
      else if (old) expect(old.kind === "fact" && old.freshness === "replaced" && old.replaced_by === fx.ids["fact:status-new"]).toBe(true);
    }
  });
  it("every expected freshness mark is exact (hard)", () => {
    for (const c of golden.cases)
      for (const [key, mark] of Object.entries(c.expect.freshness)) {
        const hit = results.get(c.id)!.hits.find((h) => h.id === fx.ids[key]);
        expect(hit, `${c.id} ${key}`).toBeDefined();
        expect(hit!.freshness, `${c.id} ${key}`).toBe(mark);
      }
  });
  it("authorization traps leak nowhere: not in hits, near misses, counts or rendered text (hard)", () => {
    const canaries = ["PRIVATE_CANARY_TEXT", "HYDRA_CANARY_TOKEN_TEXT", "Ana Costa", "short answers", "Owner preferences", fx.ids["fact:owner-name"], fx.ids["fact:owner-pref"], fx.ids["src:prefs"], fx.ids["fact:hydra-deploy"], fx.ids["src:hydra-deploy"], fx.ids["src:private-journal"]];
    for (const c of golden.cases.filter((x) => x.principal === "agent")) {
      const text = everywhere(results.get(c.id)!);
      for (const canary of canaries) expect(text, `${c.id} leaks ${canary}`).not.toContain(canary);
    }
    const agentAuth = results.get("auth-02")!;
    expect(agentAuth.searched.candidates).toBe(0);
    expect(agentAuth.searched.projects.map((p) => p.id)).toEqual([fx.ids["project:northstar"]]);
  });
  it("every case has the expected status and inclusions/exclusions", () => {
    for (const c of bm25Cases()) {
      const r = results.get(c.id)!;
      expect([c.expect.status].flat(), c.id).toContain(r.status);
      for (const k of c.expect.must_include) expect(r.hits.map((h) => h.id), `${c.id} must include ${k}`).toContain(fx.ids[k]);
      for (const k of c.expect.must_exclude) expect(idsIn(r), `${c.id} must exclude ${k}`).not.toContain(fx.ids[k]);
      if (r.status === "no_match") expect(r.next_step).toBe("Nothing recorded matches. Tell the user this is not in the brain and do not infer it. Try brain_recall with the person, project or thing as the user named it, or brain_open with a known id.");
      if (r.status === "found") expect(r.near_misses).toEqual([]);
      expect(r.near_misses.length).toBeLessThanOrEqual(3);
    }
  });
  it("hook level is none for every generic prompt, keyword or sentence (hard), and full or pointer for all but two positives", () => {
    for (const c of golden.cases.filter((x) => x.tags.includes("generic"))) {
      const { signals } = fx.brain.recallInternal(fx.agent, { query: c.query, history: false, limit: 8 });
      expect(deterministicLevel(signals), c.id).toBe("none");
    }
    const levels = positives().map((c) => [c.id, deterministicLevel(fx.brain.recallInternal(c.principal === "owner" ? owner : fx.agent, { query: c.query, history: false, limit: 8 }).signals)] as const);
    const ok = levels.filter(([, level]) => level !== "none").length;
    metrics.positive_push_rate = ok / positives().length;
    expect(ok, JSON.stringify(levels)).toBeGreaterThanOrEqual(positives().length - 2);
    for (const id of ["long-01", "long-02", "long-03", "long-04"]) expect(levels.find(([k]) => k === id)![1], id).toBe("full");
  });
  it("a query with no searchable words is a quiet no_match, and any string up to 500 code points is a result or INVALID_INPUT, never a SQLite error", () => {
    const r = fx.brain.recallCore(owner, { query: "what is it?" });
    expect(r).toMatchObject({ status: "no_match", hits: [], near_misses: [] });
    expect(r.searched.candidates).toBe(0);
    expect(() => fx.brain.recallCore(owner, { query: "x".repeat(501) })).toThrow();
    expect(() => fx.brain.recallCore(owner, { query: "🧠".repeat(500) })).not.toThrow();
    for (const raw of ['"', ":", "NOT", "*", "(", "^", "🧠", "தமிழ்", 'say "hi" there', "cob* AND NOT (x) ^y", "a".repeat(500)])
      expect(() => fx.brain.recallCore(owner, { query: raw }), raw).not.toThrow();
  });
  it("an edited original removes its fact from every field until the fact is re-evidenced, and a stale index row never surfaces", () => {
    const d = mkdtempSync(join(tmpdir(), "recall-edit-"));
    const f = buildFixture(join(d, "brain.sqlite"));
    try {
      // editSource -> invalidate -> revise retires the claim and re-syncs its row, so the fact leaves every field.
      f.brain.editSource(owner, f.ids["src:launch-notes"], { title: "Launch notes", body: "Rewritten without the colour.", expected_version: 1 });
      const r = f.brain.recallCore(owner, { query: "launch color cobalt" });
      expect(everywhere(r)).not.toContain(f.ids["fact:launch-color"]);
      expect(r.searched.candidates).toBeGreaterThanOrEqual(r.hits.length + r.near_misses.length);
      // The per-hit defence: a fact row whose claim does not exist (or is at another version) is dropped from hits, near misses and the count.
      const northstar = f.ids["project:northstar"];
      const inserted = f.store.run(
        "INSERT INTO recall_chunks(kind,ref_id,ref_version,project_id,visibility,status,ordinal,start,end,text,prefix,recorded_at,boost) VALUES('fact','00000000-dead-4000-8000-000000000000',1,?,'project','current',0,0,34,'Launch color: STALE_ROW_CANARY_TEXT','Northstar · Launch color','2026-10-24T00:00:00.000Z',1)",
        northstar,
      );
      f.store.run("INSERT INTO recall_fts(rowid,text,prefix) VALUES(?,?,?)", Number(inserted.lastInsertRowid), "Launch color: STALE_ROW_CANARY_TEXT", "Northstar · Launch color");
      const marco = f.ids["fact:marco-role"];
      f.store.run("UPDATE recall_chunks SET ref_version=ref_version+1 WHERE kind='fact' AND ref_id=?", marco);
      for (const query of ["launch color stale", "Marco design lead Lisbon"]) {
        const again = f.brain.recallCore(owner, { query });
        expect(everywhere(again), query).not.toContain("STALE_ROW_CANARY_TEXT");
        expect(everywhere(again), query).not.toContain(marco);
        expect(again.searched.candidates, query).toBeGreaterThanOrEqual(again.hits.length + again.near_misses.length);
      }
    } finally {
      f.store.close();
      rmSync(d, { recursive: true, force: true });
    }
  });
  it("brain_open returns a full fact with its replacement links and refuses anything the grant cannot see", () => {
    const fact = fx.brain.agentOpen(fx.agent, { id: fx.ids["fact:status-old"] }) as any;
    expect(fact.kind).toBe("claim");
    expect(fact.item.replaced_by).toBe(fx.ids["fact:status-new"]);
    const next = fx.brain.agentOpen(fx.agent, { id: fx.ids["fact:status-new"] }) as any;
    expect(next.item.replaces).toEqual([fx.ids["fact:status-old"]]);
    expect((fx.brain.agentOpen(fx.agent, { id: fx.ids["src:launch-notes"] }) as any).kind).toBe("source");
    for (const key of ["src:private-journal", "src:hydra-deploy", "fact:hydra-deploy", "fact:owner-name", "src:prefs"])
      expect(() => fx.brain.agentOpen(fx.agent, { id: fx.ids[key] }), key).toThrow();
    expect(() => fx.brain.agentOpen(fx.agent, { id: "no-such-id" })).toThrow();
    expect(() => fx.brain.agentOpen(fx.agent, { id: fx.ids["project:northstar"] })).toThrow();
  });
  it("recall over a 6,000-chunk brain with 300 current and 60 retired facts stays under 300 ms at p95, in both modes", () => {
    const d = mkdtempSync(join(tmpdir(), "recall-latency-"));
    const s = new Storage(join(d, "brain.sqlite"));
    try {
      const b = new Brain(s, () => new Date("2026-10-25T09:00:00.000Z"));
      const filler = "The committee discussed timelines, hiring plans and vendor contracts in detail before adjourning for lunch. ";
      const claimIds: Record<string, string> = {};
      // No outer transaction: Brain.capture opens its own (BEGIN IMMEDIATE cannot nest). 1,000 notes × 6 paragraphs ≈ 6,000 chunks, a 20 percent margin over the bar.
      for (let i = 0; i < 1000; i++) {
        const body = Array.from({ length: 6 }, (_, j) => filler.repeat(8) + ` Marker ${i}-${j}.`).join("\n\n");
        const r = b.capture(owner, { title: `Note ${i}`, body, visibility: "project", separate: true }) as any;
        // Facts that the queries below hit: 300 current ones, then 60 retired ones, each with exact evidence in its note.
        if (i < 360) {
          const project = String(s.get<{ project_id: string }>("SELECT project_id FROM sources WHERE id=?", r.source_id)!.project_id);
          claim(b, `fact:${i}`, claimIds, project, { id: r.source_id, body, version: 1 }, {
            entity: `Vendor contract ${i}`, aspect: "statement", value: `vendor contracts marker ${i}-0`, quote: `Marker ${i}-0`, recorded_at: "2026-10-20T10:00:00.000Z", status: i < 300 ? "current" : "retired",
          });
        }
      }
      expect(Number(s.get("SELECT count(*) AS n FROM recall_chunks WHERE kind='original'")!.n)).toBeGreaterThanOrEqual(5000);
      expect(Number(s.get("SELECT count(*) AS n FROM recall_chunks WHERE kind='fact' AND status='current'")!.n)).toBe(300);
      expect(Number(s.get("SELECT count(*) AS n FROM recall_chunks WHERE kind='fact' AND status='history'")!.n)).toBe(60);
      const p95 = (history: boolean) => {
        const times: number[] = [];
        let factHits = 0;
        for (let i = 0; i < 40; i++) {
          const n = history ? 300 + (i % 60) : i * 7;
          const t = performance.now();
          const r = b.recallCore(owner, { query: `vendor contract ${n} marker ${n}`, history });
          times.push(performance.now() - t);
          factHits += r.hits.filter((h) => h.kind === "fact").length;
        }
        expect(factHits, `facts are exercised (history ${history})`).toBeGreaterThan(0);
        times.sort((x, y) => x - y);
        return times[Math.floor(times.length * 0.95)];
      };
      metrics.latency_p95_ms = p95(false);
      metrics.latency_history_p95_ms = p95(true);
      expect(metrics.latency_p95_ms).toBeLessThan(300);
      expect(metrics.latency_history_p95_ms).toBeLessThan(300);
    } finally {
      s.close();
      rmSync(d, { recursive: true, force: true });
    }
  }, 240_000);
});

describe("recall golden set v2: dense on (fake embedder)", () => {
  const bucket = (tag: string) => golden.cases.filter((c) => c.tags.includes(tag));
  const recallAt5 = (cases: typeof golden.cases, map: Map<string, RecallResult>, f: Fixture) => {
    if (!cases.length) throw new Error("empty bucket");
    const hit = cases.filter((c) => {
      const top5 = map.get(c.id)!.hits.slice(0, 5).map((h) => h.id);
      return c.expect.must_include.every((k) => top5.includes(f.ids[k]));
    }).length;
    return hit / cases.length;
  };
  it("recall at 5 on paraphrase and cross-language is at least 0.8 with dense on, and the same buckets miss by words alone (the test is not vacuous)", () => {
    metrics.dense_paraphrase_recall_at_5 = recallAt5(bucket("paraphrase"), denseResults, fxDense);
    metrics.bm25_paraphrase_recall_at_5 = recallAt5(bucket("paraphrase"), results, fx);
    metrics.dense_cross_language_recall_at_5 = recallAt5(bucket("cross-language"), denseResults, fxDense);
    metrics.bm25_cross_language_recall_at_5 = recallAt5(bucket("cross-language"), results, fx);
    expect(bucket("paraphrase")).toHaveLength(8);
    expect(bucket("cross-language")).toHaveLength(6);
    expect(metrics.dense_paraphrase_recall_at_5).toBeGreaterThanOrEqual(0.8);
    expect(metrics.dense_cross_language_recall_at_5).toBeGreaterThanOrEqual(0.8);
    expect(metrics.bm25_paraphrase_recall_at_5).toBeLessThanOrEqual(0.5);
    expect(metrics.bm25_cross_language_recall_at_5).toBeLessThanOrEqual(0.5);
  });
  it("lexical and names buckets never get worse with dense on, and the exact entity stays first", () => {
    metrics.bm25_lexical_recall_at_5 = recallAt5(positives(), results, fx);
    metrics.dense_lexical_recall_at_5 = recallAt5(positives(), denseResults, fxDense);
    metrics.bm25_names_recall_at_5 = recallAt5(bucket("names"), results, fx);
    metrics.dense_names_recall_at_5 = recallAt5(bucket("names"), denseResults, fxDense);
    expect(bucket("names")).toHaveLength(6);
    expect(metrics.dense_lexical_recall_at_5).toBeGreaterThanOrEqual(metrics.bm25_lexical_recall_at_5);
    expect(metrics.dense_names_recall_at_5).toBeGreaterThanOrEqual(metrics.bm25_names_recall_at_5);
    expect(denseResults.get("pos-09")!.hits[0].id).toBe(fxDense.ids["fact:status-new"]);
    expect(denseResults.get("names-01")!.hits[0].id).toBe(fxDense.ids["src:ticket"]);
  });
  it("no-answer queries stay quiet under the floor: no_match rate at least 0.85 and nothing found (hard)", () => {
    const negatives = golden.cases.filter((c) => c.tags.includes("negative"));
    metrics.dense_no_match_rate = negatives.filter((c) => denseResults.get(c.id)!.status === "no_match").length / negatives.length;
    expect(metrics.dense_no_match_rate).toBeGreaterThanOrEqual(0.85);
    for (const c of negatives) expect(denseResults.get(c.id)!.status, c.id).not.toBe("found");
    for (const c of golden.cases.filter((x) => x.tags.includes("generic"))) {
      const { signals } = fxDense.brain.recallInternal(fxDense.agent, { query: c.query, history: false, limit: 8 }, denseFor(c.query));
      expect(deterministicLevel(signals), c.id).toBe("none");
    }
  });
  it("every plan 5 case keeps its status, inclusions, exclusions and freshness with dense on (hard)", () => {
    for (const c of bm25Cases()) {
      const r = denseResults.get(c.id)!;
      expect([c.expect.status].flat(), c.id).toContain(r.status);
      for (const k of c.expect.must_include) expect(r.hits.map((h) => h.id), `${c.id} must include ${k}`).toContain(fxDense.ids[k]);
      for (const k of c.expect.must_exclude) expect(idsIn(r), `${c.id} must exclude ${k}`).not.toContain(fxDense.ids[k]);
      for (const [key, mark] of Object.entries(c.expect.freshness)) expect(r.hits.find((h) => h.id === fxDense.ids[key])?.freshness, `${c.id} ${key}`).toBe(mark);
      if (r.status === "found") expect(r.near_misses).toEqual([]);
      expect(r.near_misses.length).toBeLessThanOrEqual(3);
    }
    for (const c of golden.cases.filter((x) => x.tags.includes("dense"))) {
      const r = denseResults.get(c.id)!;
      expect([c.expect.status].flat(), c.id).toContain(r.status);
      for (const k of c.expect.must_include) expect(r.hits.map((h) => h.id), `${c.id} must include ${k}`).toContain(fxDense.ids[k]);
    }
  });
  it("authorization traps leak nowhere with dense on (hard)", () => {
    const canaries = ["PRIVATE_CANARY_TEXT", "HYDRA_CANARY_TOKEN_TEXT", "Ana Costa", "short answers", "Owner preferences", fxDense.ids["fact:owner-name"], fxDense.ids["fact:owner-pref"], fxDense.ids["src:prefs"], fxDense.ids["fact:hydra-deploy"], fxDense.ids["src:hydra-deploy"], fxDense.ids["src:private-journal"]];
    for (const c of golden.cases.filter((x) => x.principal === "agent")) {
      const text = everywhere(denseResults.get(c.id)!);
      for (const canary of canaries) expect(text, `${c.id} leaks ${canary}`).not.toContain(canary);
    }
    expect(denseResults.get("auth-02")!.searched.candidates).toBe(0);
    // Private rows are embedded under Ollama (nothing leaves the machine) and still never reach an agent.
    const leak = fxDense.brain.recallCore(fxDense.agent, { query: "was the launch colour the right call" }, denseFor("was the launch colour the right call"));
    expect(everywhere(leak)).not.toContain("PRIVATE_CANARY");
  });
});
