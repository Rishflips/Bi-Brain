// tests/eval/recall-short.test.ts
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFixture, owner, type Fixture } from "./recall-fixture.ts";
import { embedFixture } from "./dense-fixture.ts";
import { MEANING_LEAD } from "../../packages/domain/better-search.ts";
import { hashId } from "../../packages/domain/recall-push.ts";

type Step = { prompt: string; first_prompt: boolean; seen_previous?: boolean; expect: { level?: string; level_in?: string[]; digest?: boolean; text?: string; text_includes?: string; hit_ids?: string[]; hit_includes?: string[]; hit_excludes?: string[]; log?: Record<string, string> } };
type Case = { id: string; tags: string[]; session: string; mode?: "dense"; lead_threshold?: number; steps: Step[] };
const golden = JSON.parse(readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "recall-short-golden-v1.json"), "utf8")) as { cases: Case[] };
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
let dir: string;
const fixtures: Record<"off" | "dense", Fixture> = {} as never;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "recall-short-"));
  fixtures.off = buildFixture(join(dir, "off.sqlite"));
  fixtures.dense = buildFixture(join(dir, "dense.sqlite"));
  const { dense } = embedFixture(fixtures.dense);
  vi.spyOn(fixtures.dense.brain, "queryVector").mockImplementation(async (_p, q) => dense(q));
});
afterAll(() => {
  vi.restoreAllMocks();
  fixtures.off.store.close();
  fixtures.dense.store.close();
  rmSync(dir, { recursive: true, force: true });
});

for (const mode of ["off", "dense"] as const) {
  describe(`short and paraphrase golden set (Better search ${mode})`, () => {
    it("has the four buckets", () => {
      const tagged = (t: string) => golden.cases.filter((c) => c.tags.includes(t)).length;
      expect(tagged("continuation")).toBeGreaterThanOrEqual(4);
      expect(tagged("ack")).toBe(1);
      expect(tagged("decision")).toBeGreaterThanOrEqual(6);
      expect(tagged("paraphrase")).toBe(3);
    });
    for (const c of golden.cases.filter((x) => !x.mode || x.mode === mode)) {
      it(`${c.id}: ${c.steps.map((s) => JSON.stringify(s.prompt)).join(" → ")}`, async () => {
        const fx = fixtures[mode];
        if (c.lead_threshold !== undefined) {
          // A literal line, chosen between the dense floor (0.45) and the fake embedder's cosine for this paraphrase (about 0.468); cleared after the case.
          fx.brain.setMeaningLead(owner, { threshold: c.lead_threshold, sample: 54, source: "proof:search", measured_at: "2026-10-25" });
        }
        try {
          const session = sha(`${mode}:${c.session}`);
          let previous: string[] = [];
          for (const step of c.steps) {
            const out = await fx.brain.recallPush(fx.agent, { prompt: step.prompt, session_id: session, first_prompt: step.first_prompt, seen: step.seen_previous ? previous.map(hashId) : [] });
            const e = step.expect;
            const label = `${c.id} ${JSON.stringify(step.prompt)}`;
            if (e.level) expect(out.level, label).toBe(e.level);
            if (e.level_in) expect(e.level_in, label).toContain(out.level);
            if (e.digest !== undefined) expect(out.digest, label).toBe(e.digest);
            if (e.text !== undefined) expect(out.text, label).toBe(e.text);
            if (e.text_includes) expect(out.text, label).toContain(e.text_includes);
            if (e.hit_ids) expect(out.hit_ids, label).toEqual(e.hit_ids);
            for (const k of e.hit_includes ?? []) expect(out.hit_ids, `${label} includes ${k}`).toContain(fx.ids[k]);
            for (const k of e.hit_excludes ?? []) expect(out.hit_ids, `${label} excludes ${k}`).not.toContain(fx.ids[k]);
            const row = fx.brain.recallLog(owner).rows.at(-1)!;
            for (const [k, v] of Object.entries(e.log ?? {})) expect((row as Record<string, unknown>)[k], `${label} log.${k}`).toBe(v);
            if (!e.log?.intent) expect(row, label).not.toHaveProperty("intent");
            // Nothing in a push is ever a prompt echo: the row holds counts and fixed words only.
            expect(JSON.stringify(row), label).not.toContain(step.prompt);
            previous = out.hit_ids;
          }
        } finally {
          if (c.lead_threshold !== undefined) fx.store.set(MEANING_LEAD, null);
        }
      });
    }
  });
}
