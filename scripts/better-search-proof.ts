/**
 * OWNER-RUN live proof of better search against the real embedding provider. With Cloudflare it SPENDS QUOTA
 * (about 50 small requests over the synthetic golden texts, roughly 3,000 tokens, well inside the free daily allowance);
 * with Ollama it runs the local model.
 * Agents and CI never run it; they use the fake embedder.
 *
 * Put BRAIN_SEARCH_LIVE=1 on its own line in .env and run `npm run proof:search`, or in PowerShell:
 * $env:BRAIN_SEARCH_LIVE=1; npm run proof:search, then Remove-Item Env:BRAIN_SEARCH_LIVE. Remove the line afterwards.
 *
 * Configure it like the app does (docs/PROVIDERS.md): BRAIN_EMBED_PROVIDER and, for Cloudflare, the account id and key.
 * It prints the model key, calls, estimated tokens, cost, per-bucket recall at 5, and the cosine room around the 0.45 floor.
 * It never prints or writes the key or the account id; its fixture lives in a temporary folder outside this repository and is deleted.
 * Without BRAIN_SEARCH_LIVE=1 it prints how to run it and exits 1 (nothing was proven).
 * Exit 0 only when paraphrase and cross-language reach 0.8, lexical and names do not regress against words alone, and no-answer queries stay quiet.
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { embedFromEnv } from "../packages/providers/embed-env.ts";
import { prepareEmbed } from "../packages/providers/embed.ts";
import { BETTER_SEARCH, BETTER_SEARCH_STATUS, EMBED_VISIBILITIES, denseFloor, embedText, type QueryVector } from "../packages/domain/better-search.ts";
import { CANDIDATES_PER_LIST } from "../packages/domain/recall.ts";
import { VectorCache, pendingEmbedRows, writeEmbeddings } from "../packages/storage/recall-vectors.ts";
import { buildFixture, owner } from "../tests/eval/recall-fixture.ts";

try {
  process.loadEnvFile(".env");
} catch (error) {
  if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") console.log("Could not read .env; continuing with the environment as is.");
}

type Case = { id: string; tags: string[]; principal: "owner" | "agent"; query: string; expect: { must_include: string[] } };

/** Any message that reaches the terminal passes through here so a credential or account id can never be echoed. */
function redact(text: string): string {
  let out = text;
  for (const secret of [process.env.BRAIN_DECISION_API_KEY, process.env.BRAIN_CLOUDFLARE_ACCOUNT_ID]) {
    const s = secret?.trim();
    if (s && s.length >= 6) out = out.split(s).join("[hidden]");
  }
  return out;
}

async function run(): Promise<number> {
  if (process.env.BRAIN_SEARCH_LIVE !== "1") {
    console.log("This proof sends real embedding requests and, with Cloudflare, spends your Workers AI quota.");
    console.log("Run it yourself: put BRAIN_SEARCH_LIVE=1 on its own line in .env and run npm run proof:search,");
    console.log("or in PowerShell: $env:BRAIN_SEARCH_LIVE=1; npm run proof:search, then run Remove-Item Env:BRAIN_SEARCH_LIVE. Remove the line from .env afterwards.");
    console.log("Nothing was sent and nothing was proven.");
    return 1;
  }
  const setup = embedFromEnv(process.env);
  if (!setup.config) {
    console.error(`Not ready: ${setup.reason}`);
    return 2;
  }
  const { config, label, key } = setup;
  if (config.provider === "cloudflare" && /^(127\.0\.0\.1|localhost|\[::1\])$/u.test(new URL(config.endpoint).hostname)) {
    console.error("Not a live proof: the Cloudflare endpoint is this computer. Remove BRAIN_EMBED_ENDPOINT to test the real service.");
    return 2;
  }
  console.log(`Service: ${label}  model key: ${key}  floor: ${denseFloor(key)}`);
  const base = realpathSync.native(tmpdir());
  const prefix = join(base, "better-search-proof-");
  const dir = realpathSync.native(mkdtempSync(prefix));
  const fx = buildFixture(join(dir, "brain.sqlite"));
  let calls = 0;
  let tokens = 0;
  let cost = 0;
  const abort = () => new AbortController().signal;
  try {
    fx.store.set(BETTER_SEARCH_STATUS, { configured: true, provider: config.provider, model: config.model, key, label, updated_at: fx.brain.now() });
    fx.store.set(BETTER_SEARCH, { mode: config.provider, key, consented_at: fx.brain.now() });
    let dim = 0;
    for (;;) {
      const rows = pendingEmbedRows(fx.store, key, EMBED_VISIBILITIES[config.provider], 32);
      if (!rows.length) break;
      const prepared = prepareEmbed(config, rows.map((r) => embedText(r.prefix, r.text)));
      const result = await prepared.execute(abort());
      calls += 1;
      tokens += result.reported_tokens ?? result.estimated_tokens;
      cost += result.cost_micro_usd;
      dim = result.dim;
      const written = fx.store.transaction(() => writeEmbeddings(fx.store, key, result.dim, rows.map((r, i) => ({ ...r, vector: result.vectors[i] }))));
      if (!written) throw new Error("no rows written; the index changed under the proof");
    }
    const golden = JSON.parse(readFileSync(join(process.cwd(), "tests/eval/recall-golden-v1.json"), "utf8")) as { cases: Case[] };
    const buckets: Record<string, Case[]> = {
      lexical: golden.cases.filter((c) => c.tags.includes("positive")),
      paraphrase: golden.cases.filter((c) => c.tags.includes("paraphrase")),
      "cross-language": golden.cases.filter((c) => c.tags.includes("cross-language")),
      names: golden.cases.filter((c) => c.tags.includes("names")),
      negative: golden.cases.filter((c) => c.tags.includes("negative")),
    };
    const cache = new VectorCache();
    const vectors = new Map<string, QueryVector>();
    const embedQuery = async (q: string): Promise<QueryVector> => {
      const cached = vectors.get(q);
      if (cached) return cached;
      const result = await prepareEmbed(config, [q]).execute(abort());
      calls += 1;
      tokens += result.reported_tokens ?? result.estimated_tokens;
      cost += result.cost_micro_usd;
      const v = { vector: result.vectors[0], key, dim: result.dim };
      vectors.set(q, v);
      return v;
    };
    const scores: Record<string, { words: number; dense: number }> = {};
    let lowestWanted = 1;
    let highestNegative = -1;
    for (const [name, cases] of Object.entries(buckets)) {
      let words = 0;
      let dense = 0;
      for (const c of cases) {
        const p = c.principal === "owner" ? owner : fx.agent;
        const want = c.expect.must_include.map((k) => fx.ids[k]);
        const plain = fx.brain.recallCore(p, { query: c.query, history: false, limit: 8 });
        const v = await embedQuery(c.query);
        const withDense = fx.brain.recallCore(p, { query: c.query, history: false, limit: 8 }, v);
        const top5 = (r: typeof plain) => r.hits.slice(0, 5).map((h) => h.id);
        const okWords = want.every((id) => top5(plain).includes(id));
        const okDense = want.every((id) => top5(withDense).includes(id));
        const scope = { vector: v.vector, key, dim, projects: withDense.searched.projects.map((x) => x.id), visibilities: EMBED_VISIBILITIES[config.provider], status: "current" as const, floor: -1 };
        if (name === "negative") {
          const scan = cache.search(fx.store, { ...scope, limit: 1 });
          if (scan[0]) highestNegative = Math.max(highestNegative, scan[0].score);
          console.log(`  ${c.id}: ${withDense.status} (words: ${plain.status}; nearest cosine ${scan[0] ? scan[0].score.toFixed(2) : "none"})`);
          if (withDense.status === "no_match") dense += 1;
          if (plain.status === "no_match") words += 1;
          continue;
        }
        const scan = cache.search(fx.store, { ...scope, limit: CANDIDATES_PER_LIST });
        const wantedScore = scan.find((m) => want.includes(m.ref_id))?.score;
        if (wantedScore !== undefined) lowestWanted = Math.min(lowestWanted, wantedScore);
        console.log(`  ${c.id}: words ${okWords ? "hit" : "miss"}, dense ${okDense ? "hit" : "miss"} (wanted cosine ${wantedScore === undefined ? "none" : wantedScore.toFixed(2)})`);
        if (okWords) words += 1;
        if (okDense) dense += 1;
      }
      scores[name] = { words: words / cases.length, dense: dense / cases.length };
      console.log(`${name}: words ${scores[name].words.toFixed(2)}, dense ${scores[name].dense.toFixed(2)}`);
    }
    console.log(`\ncalls ${calls}, tokens ${tokens}${config.provider === "cloudflare" ? " (estimated unless reported)" : ""}, cost ${cost} micro-USD`);
    console.log(`lowest cosine of a wanted hit ${lowestWanted.toFixed(2)}; highest cosine of a no-answer query ${highestNegative.toFixed(2)}; floor ${denseFloor(key)}`);
    const pass = scores.paraphrase.dense >= 0.8 && scores["cross-language"].dense >= 0.8 && scores.lexical.dense >= scores.lexical.words && scores.names.dense >= scores.names.words && scores.negative.dense >= 0.85;
    console.log(pass ? "\nPASS" : "\nFAIL");
    return pass ? 0 : 1;
  } finally {
    fx.store.close();
    // Only the folder this run created, only inside the system temp folder, never a path outside it.
    if (dir.startsWith(prefix) && dir.startsWith(base + sep)) rmSync(dir, { recursive: true, force: true });
  }
}

// exitCode, not exit(): piped output is flushed before the process ends.
try {
  process.exitCode = await run();
} catch (error) {
  console.error(`The proof stopped: ${redact(error instanceof Error ? error.message : "unknown problem")}`);
  process.exitCode = 1;
}
