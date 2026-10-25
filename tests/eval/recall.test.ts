import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Storage } from "../../packages/storage/index.ts";
import { Brain } from "../../packages/domain/service.ts";
import { buildFixture, owner, type Fixture } from "./recall-fixture.ts";
import { deterministicLevel } from "../../packages/domain/recall.ts";
import type { RecallResult } from "../../packages/domain/recall.ts";

const golden = JSON.parse(readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "recall-golden-v1.json"), "utf8")) as {
  cases: { id: string; tags: string[]; principal: "owner" | "agent"; query: string; history?: boolean; expect: { status: string | string[]; must_include: string[]; must_exclude: string[]; freshness: Record<string, string> } }[];
};
let fx: Fixture;
let dir: string;
const results = new Map<string, RecallResult>();
const metrics: Record<string, number> = {};
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "recall-eval-"));
  fx = buildFixture(join(dir, "brain.sqlite"));
  for (const c of golden.cases)
    results.set(c.id, fx.brain.recallCore(c.principal === "owner" ? owner : fx.agent, { query: c.query, history: c.history ?? false, limit: 8 }));
});
afterAll(() => {
  fx.store.close();
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(resolve("data"), { recursive: true });
  writeFileSync(resolve("data/recall-eval-metrics.json"), JSON.stringify({ golden_version: 1, cases: golden.cases.length, ...metrics }, null, 2));
});
const idsIn = (r: RecallResult) => [...r.hits.map((h) => h.id), ...r.near_misses.map((n) => n.id)];
// The caller's own query is echoed in `searched.query`; it is input, not retrieved data, so canary scans blank it.
const everywhere = (r: RecallResult) => JSON.stringify({ ...r, searched: { ...r.searched, query: "" } });
const positives = () => golden.cases.filter((c) => c.tags.includes("positive"));

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
    for (const c of golden.cases) {
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
  it("recall over a 5,000-chunk brain stays under 300 ms at p95", () => {
    const d = mkdtempSync(join(tmpdir(), "recall-latency-"));
    const s = new Storage(join(d, "brain.sqlite"));
    try {
      const b = new Brain(s, () => new Date("2026-10-25T09:00:00.000Z"));
      const filler = "The committee discussed timelines, hiring plans and vendor contracts in detail before adjourning for lunch. ";
      // No outer transaction: Brain.capture opens its own (BEGIN IMMEDIATE cannot nest). 1,000 notes × 6 paragraphs ≈ 6,000 chunks, a 20 percent margin over the bar.
      for (let i = 0; i < 1000; i++)
        b.capture(owner, { title: `Note ${i}`, body: Array.from({ length: 6 }, (_, j) => filler.repeat(8) + ` Marker ${i}-${j}.`).join("\n\n"), visibility: "project", separate: true });
      expect(Number(s.get("SELECT count(*) AS n FROM recall_chunks")!.n)).toBeGreaterThanOrEqual(5000);
      const times: number[] = [];
      for (let i = 0; i < 40; i++) {
        const t = performance.now();
        b.recallCore(owner, { query: `vendor contracts marker ${i * 20}` });
        times.push(performance.now() - t);
      }
      times.sort((a, b) => a - b);
      metrics.latency_p95_ms = times[Math.floor(times.length * 0.95)];
      expect(metrics.latency_p95_ms).toBeLessThan(300);
    } finally {
      s.close();
      rmSync(d, { recursive: true, force: true });
    }
  }, 60_000);
});
