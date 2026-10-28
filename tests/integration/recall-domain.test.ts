import { describe, expect, it } from "vitest";
import {
  buildFtsQuery,
  dedupe,
  denseWhy,
  deterministicLevel,
  deterministicSignals,
  deterministicStatus,
  factFreshness,
  fromBm25,
  fuse,
  pinExact,
  recencyBoost,
  renderRecallText,
  rrf,
  type Candidate,
  type RecallHit,
  type RecallResult,
} from "../../packages/domain/recall.ts";
import type { RecallMatch } from "../../packages/storage/recall-index.ts";

const row = (over: Partial<RecallMatch>): RecallMatch => ({
  id: 1, kind: "original", ref_id: "s1", ref_version: 1, project_id: "inbox", visibility: "project", status: "current",
  ordinal: 0, start: 0, end: 10, text: "The launch colour is cobalt.", prefix: "Launch · Inbox · 2026-10-18",
  recorded_at: "2026-10-18T10:00:00.000Z", boost: 1, score: -3, ...over,
});
const now = new Date("2026-10-25T09:00:00Z");

describe("buildFtsQuery", () => {
  it("quotes every term, drops stopwords, caps at 12 terms, adds a phrase for 2–5 words and a prefix on the last term", () => {
    const q = buildFtsQuery('what colour did we pick for the launch?');
    expect(q.terms).toEqual(["colour", "pick", "launch"]);
    expect(q.match).toBe('"colour" OR "pick" OR "launch" OR "launch"*');
    expect(q.phrase).toBeNull();
    expect(buildFtsQuery("launch colour is cobalt").phrase).toBe('"launch colour is cobalt"');
    expect(buildFtsQuery("?!")).toEqual({ terms: [], match: null, phrase: null });
    expect(buildFtsQuery("northstar").match).toBe('"northstar" OR "northstar"*');
    expect(buildFtsQuery("northstar").phrase).toBeNull();
    const many = buildFtsQuery(Array.from({ length: 20 }, (_, i) => `word${i}`).join(" "));
    expect(many.terms).toHaveLength(12);
    expect(many.phrase).toBeNull();
  });
  it("never emits an unquoted operator and doubles quotes inside a phrase", () => {
    for (const raw of ['"', "a:b", "NOT cobalt", "cob*", "(x)", "^y", "🧠 brain", "தமிழ் குறிப்பு"]) {
      const q = buildFtsQuery(raw);
      if (q.match) for (const part of q.match.split(" OR ")) expect(part, raw).toMatch(/^"[^"]*(""[^"]*)*"\*?$/u);
      if (q.phrase) expect(q.phrase.slice(1, -1).replace(/""/g, "")).not.toContain('"');
    }
    expect(buildFtsQuery("a:b").match).toBeNull();
    expect(buildFtsQuery("NOT cobalt").match).toBe('"cobalt" OR "cobalt"*');
    expect(buildFtsQuery('say "hi" there').phrase).toBe('"say ""hi"" there"');
  });
});

describe("rrf and fuse", () => {
  it("fuses rank lists with k=60 and never needs score normalisation", () => {
    const fused = rrf([["a", "b", "c"], ["b", "a"]], 60);
    expect(fused.get("a")).toBeCloseTo(1 / 61 + 1 / 62);
    expect(fused.get("b")).toBeCloseTo(1 / 62 + 1 / 61);
    expect(fused.get("c")).toBeCloseTo(1 / 63);
    expect([...rrf([[], ["z"]]).keys()]).toEqual(["z"]);
  });
  it("puts a current fact above its own evidence chunk, applies recency and durable boosts, and fuses a history row like any other (the service decides whether history rows are searched)", () => {
    const fact = row({ id: 2, kind: "fact", ref_id: "c1", text: "Northstar is active.", prefix: "Inbox · Northstar", score: -2 });
    const chunk = row({ id: 3, ref_id: "s2", text: "Northstar status active was agreed.", score: -4, boost: 1.15 });
    const old = row({ id: 4, ref_id: "s3", recorded_at: "2025-01-01T00:00:00.000Z", score: -4 });
    const ranked = fuse({ facts: [fact], originals: [chunk, old], phrase: [] }, now);
    expect(ranked.map((c) => c.key)).toEqual(["fact:c1", "original:s2:0", "original:s3:0"]);
    expect(recencyBoost("2026-10-25T09:00:00.000Z", now)).toBeCloseTo(1.15);
    expect(recencyBoost("2025-01-01T00:00:00.000Z", now)).toBeLessThan(1.01);
    const history = row({ id: 5, kind: "fact", ref_id: "c9", status: "history" });
    expect(fuse({ facts: [history], originals: [], phrase: [] }, now).map((c) => c.key)).toEqual(["fact:c9"]);
  });
});

describe("freshness and dedupe", () => {
  const claim = { id: "c1", created_at: "2026-09-01T00:00:00.000Z", data: { recorded_at: "2026-09-10T00:00:00.000Z" } };
  it("marks a fact stale after 21 days, current when confirmed, replaced when a current claim supersedes it, retired when nothing does", () => {
    expect(factFreshness(claim, {}, null, now)).toEqual({ checked_at: "2026-09-10T00:00:00.000Z", freshness: "stale" });
    expect(factFreshness(claim, { c1: "2026-10-20T00:00:00.000Z" }, null, now).freshness).toBe("current");
    expect(factFreshness(claim, {}, "c2", now).freshness).toBe("replaced");
    expect(factFreshness({ ...claim, data: { ...claim.data, status: "retired" } }, { c1: "2026-10-20T00:00:00.000Z" }, null, now).freshness).toBe("retired");
    expect(factFreshness({ ...claim, data: { ...claim.data, status: "retired" } }, {}, "c2", now).freshness).toBe("replaced");
    expect(factFreshness({ ...claim, data: { recorded_at: "2026-10-20T00:00:00.000Z", edited_at: "2026-10-24T00:00:00.000Z" } }, {}, null, now).checked_at).toBe("2026-10-24T00:00:00.000Z");
  });
  it("collapses a chunk overlapping a fact's evidence into the fact and keeps at most two chunks per source", () => {
    const fact: RecallHit = { kind: "fact", id: "c1", project: { id: "inbox", title: "Inbox" }, text: "Northstar is active.", recorded_at: "x", checked_at: "x", freshness: "current", replaced_by: null, evidence: [{ source_id: "s1", source_version: 1, quote: "Northstar status active" }], why: [], score: 1 };
    const chunkOf = (id: string, ordinal: number, score: number): RecallHit => ({ kind: "original", id, version: 1, project: { id: "inbox", title: "Inbox" }, title: "T", quote: `q${ordinal}`, start: ordinal * 10, end: ordinal * 10 + 5, captured_at: "x", freshness: "current", why: [], score });
    // dedupe compares quote text (hits carry no evidence offsets), so the overlapping chunk's quote contains the fact's evidence quote.
    const overlapping: RecallHit = { ...(chunkOf("s1", 0, 0.9) as any), quote: "Northstar status active was agreed on Tuesday.", start: 0, end: 46 };
    const out = dedupe([fact, overlapping, chunkOf("s2", 0, 0.8), chunkOf("s2", 1, 0.7), chunkOf("s2", 2, 0.6)], 2);
    expect(out.kept.map((h) => `${h.kind}:${h.id}:${h.kind === "original" ? h.start : ""}`)).toEqual(["fact:c1:", "original:s2:0", "original:s2:10"]);
    expect(out.spill.map((h) => h.kind === "original" && h.start)).toEqual([20]);
    expect((out.kept[0] as any).evidence).toHaveLength(1);
  });
});

describe("deterministic status and level", () => {
  const cand = (over: Partial<RecallMatch>, fused: number): Candidate => ({ key: `${over.kind ?? "original"}:${over.ref_id ?? "s"}:0`, row: row(over), fused, lists: ["originals"] });
  it("is strong for a fact covering two terms (or the one term of a one-word query) or a chunk with two terms and a 30 percent bm25 gap; one weak OR match is quiet", () => {
    const terms = ["launch", "colour"];
    const strongFact = deterministicSignals(terms, [cand({ kind: "fact", ref_id: "c1", text: "Launch colour: cobalt", score: -3 }, 0.03)], ["Launch colour"]);
    expect(strongFact).toMatchObject({ strong: true, exactEntity: true, matched: 2, candidates: 1, topKind: "fact" });
    expect(deterministicStatus(strongFact)).toBe("found");
    expect(deterministicLevel(strongFact)).toBe("full");
    const oneWord = deterministicSignals(["marco"], [cand({ kind: "fact", ref_id: "c2", text: "Marco: design lead", score: -3 }, 0.03)], []);
    expect(oneWord).toMatchObject({ strong: true, matched: 1 });
    expect(deterministicLevel(oneWord)).toBe("full");
    const weak = deterministicSignals(terms, [cand({ text: "the launch is soon", score: -2 }, 0.02), cand({ ref_id: "s2", text: "launch again", score: -1.9 }, 0.019)], []);
    expect(weak).toMatchObject({ strong: false, matched: 1 });
    expect(deterministicStatus(weak)).toBe("partial");
    expect(deterministicLevel(weak)).toBe("none");
    expect(deterministicLevel({ ...weak, exactEntity: true })).toBe("pointer");
    const tie = deterministicSignals(terms, [cand({ text: "launch colour soon", score: -3 }, 0.03), cand({ ref_id: "s2", text: "launch colour again", score: -2.9 }, 0.029)], []);
    expect(tie).toMatchObject({ strong: false, matched: 2 });
    expect(deterministicStatus(tie)).toBe("partial");
    expect(deterministicLevel(tie)).toBe("pointer");
    const gap = deterministicSignals(terms, [cand({ text: "launch colour cobalt", score: -4 }, 0.03), cand({ ref_id: "s2", text: "launch", score: -2 }, 0.02)], []);
    expect(gap.strong).toBe(true);
    const none = deterministicSignals(["cobalt"], [], []);
    expect(none.matched).toBe(0);
    expect(deterministicStatus(none)).toBe("no_match");
    expect(deterministicLevel(none)).toBe("none");
  });
  it("renders one line per hit with kind, id, date, freshness and text", () => {
    const result: RecallResult = {
      status: "found", as_of: "2026-10-25T09:00:00.000Z",
      searched: { query: "launch colour", projects: [{ id: "inbox", title: "Inbox" }], history: false, candidates: 2, index_complete: true },
      hits: [
        { kind: "fact", id: "c1", project: { id: "inbox", title: "Inbox" }, text: "Launch colour: cobalt", recorded_at: "2026-10-20T00:00:00.000Z", checked_at: "2026-10-20T00:00:00.000Z", freshness: "current", replaced_by: null, evidence: [], why: ["matched: launch, colour"], score: 1 },
        { kind: "original", id: "s1", version: 2, project: { id: "inbox", title: "Inbox" }, title: "Launch notes", quote: "The launch colour is cobalt.", start: 0, end: 28, captured_at: "2026-10-18T00:00:00.000Z", freshness: "current", why: [], score: 0.5 },
      ],
      near_misses: [], next_step: "Use these as evidence and cite the ids. brain_open returns a full item.",
    };
    const text = renderRecallText(result);
    expect(text.split("\n")).toEqual([
      "found · 2 candidates · Inbox",
      "fact c1 · 2026-10-20 · current · Launch colour: cobalt",
      "original s1 v2 · 2026-10-18 · current · Launch notes: The launch colour is cobalt.",
      "Use these as evidence and cite the ids. brain_open returns a full item.",
    ]);
    expect(renderRecallText({ ...result, status: "no_match", hits: [], searched: { ...result.searched, candidates: 0 }, next_step: "x" })).toBe("no_match · 0 candidates · Inbox\nx");
  });
});

describe("dense as a fourth list", () => {
  it("weights the dense list 0.7, keeps the BM25 row for a shared key and the cosine for a dense-only key", () => {
    expect(rrf([["a"], ["b"]], 60, [1, 0.7]).get("b")).toBeCloseTo(0.7 / 61);
    expect(rrf([["a"], ["b"]], 60).get("b")).toBeCloseTo(1 / 61);
    const shared = row({ ref_id: "s1", score: -4 });
    const denseOnly = row({ ref_id: "s2", id: 2, score: 0.71 });
    const out = fuse({ facts: [], originals: [shared], phrase: [], dense: [row({ ref_id: "s1", score: 0.9 }), denseOnly] }, now);
    const s1 = out.find((c) => c.key === "original:s1:0")!;
    const s2 = out.find((c) => c.key === "original:s2:0")!;
    expect(s1.row.score).toBe(-4);
    expect(s1.lists).toEqual(["originals", "dense"]);
    expect(s2.row.score).toBe(0.71);
    expect(s2.lists).toEqual(["dense"]);
    expect(fromBm25(s1)).toBe(true);
    expect(fromBm25(s2)).toBe(false);
    expect(denseWhy(s2)).toEqual(["similar meaning"]);
    expect(denseWhy(s1)).toEqual(["similar meaning"]);
    expect(s1.fused).toBeGreaterThan(s2.fused);
    // Without a dense list the output is the plan 5 output.
    const plain = fuse({ facts: [], originals: [shared], phrase: [] }, now);
    expect(plain.map((c) => [c.key, c.fused, c.lists])).toEqual([["original:s1:0", fuse({ facts: [], originals: [shared], phrase: [], dense: [] }, now)[0].fused, ["originals"]]]);
  });
  it("a dense-only candidate is never strong and never dilutes the BM25 gap", () => {
    const top = { key: "original:a:0", row: row({ ref_id: "a", text: "launch colour cobalt debate", score: -5 }), fused: 0.03, lists: ["originals"] };
    const denseNext = { key: "original:b:0", row: row({ ref_id: "b", id: 2, text: "launch colour amber", score: 0.6 }), fused: 0.02, lists: ["dense"] };
    const bm25Next = { key: "original:c:0", row: row({ ref_id: "c", id: 3, text: "launch colour amber", score: -4.5 }), fused: 0.015, lists: ["originals"] };
    expect(deterministicSignals(["launch", "colour"], [top, denseNext], []).strong).toBe(true);
    expect(deterministicSignals(["launch", "colour"], [top, denseNext, bm25Next], []).strong).toBe(false);
    expect(deterministicSignals(["launch", "colour"], [{ ...denseNext, row: row({ ref_id: "b", text: "launch colour cobalt", score: 0.9 }) }], []).strong).toBe(false);
    const denseFact = { key: "fact:f", row: row({ kind: "fact", ref_id: "f", text: "Launch colour: cobalt", prefix: "Inbox · Launch colour", score: 0.9 }), fused: 0.04, lists: ["dense"] };
    expect(deterministicSignals(["launch", "colour"], [denseFact], []).strong).toBe(false);
    expect(deterministicSignals(["launch", "colour"], [{ ...denseFact, lists: ["facts"] }], []).strong).toBe(true);
  });
  it("a dense-only candidate that happens to share the words never raises the push level", () => {
    const denseOnly = { key: "original:d:0", row: row({ ref_id: "d", text: "launch colour amber", score: 0.8 }), fused: 0.03, lists: ["dense"] };
    const weak = { key: "original:w:0", row: row({ ref_id: "w", id: 2, text: "the launch went well", score: -2 }), fused: 0.02, lists: ["originals"] };
    const signals = deterministicSignals(["launch", "colour"], [denseOnly, weak], []);
    expect(signals).toMatchObject({ strong: false, matched: 1, candidates: 2 });
    expect(deterministicLevel(signals)).toBe("none");
    expect(deterministicStatus(signals)).toBe("partial");
    expect(deterministicLevel(deterministicSignals(["launch", "colour"], [{ ...denseOnly, lists: ["originals", "dense"] }, weak], []))).not.toBe("none");
  });
  it("pinExact moves exact-name current facts to the front and keeps every other order", () => {
    const fact = (id: string, prefix: string, status: "current" | "history" = "current") => ({ key: `fact:${id}`, row: row({ kind: "fact", ref_id: id, prefix, status }), fused: 0.01, lists: ["facts"] });
    const ranked = [{ key: "original:x:0", row: row({ ref_id: "x" }), fused: 0.05, lists: ["dense"] }, fact("1", "Northstar · Marco"), fact("2", "Northstar · northstar"), fact("3", "Northstar · northstar", "history")];
    const out = pinExact(ranked, (c) => c.row.prefix.replace(/^Northstar · /u, ""), ["Northstar"]);
    expect(out.map((c) => c.key)).toEqual(["fact:2", "original:x:0", "fact:1", "fact:3"]);
    expect(pinExact(ranked, (c) => c.row.prefix, [])).toBe(ranked);
  });
});
