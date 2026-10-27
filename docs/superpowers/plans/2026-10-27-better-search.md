# Better Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add dense embeddings as one more ranked list under recall, off by default, so a question worded differently from the note, or in another language (English or Tamil), still finds it. BM25 stays the backbone and the fallback; the lexical and names/ids buckets never get worse; the key stays worker-only; spend is bounded; private text never reaches Cloudflare.

**Architecture:** The worker owns every model call. `packages/providers/embed.ts` is a plain-`fetch` client for Ollama `/api/embed` (loopback only) and Cloudflare Workers AI `@cf/baai/bge-m3`, configured by `packages/providers/embed-env.ts` from the worker's environment, publishing a key-free `better_search_status` the way `system_one_status` works. Vectors are Float32 little-endian, normalised at write time, in the existing `recall_chunks.embedding` column with `embedding_model = "<provider>:<model>:<prefix-scheme>"` and `embedding_dim`; `packages/storage/recall-vectors.ts` writes them with a (kind, ref_id, ref_version, ordinal) guard and scans the scope-filtered rows by dot product through an in-process matrix cache keyed by (scope, model key, generation). Indexing is a durable `embed_batch` job (32 rows per call, provider call outside any transaction, Cloudflare spend through the existing `DispatchLedger`); query embedding is a `recall_embed` fast lane that mirrors the judge (dedicated worker loop, 400 ms server wait, deterministic fallback to BM25). `packages/domain/recall.ts` fuses dense as a fourth RRF list with weight 0.7 under a cosine floor, and `Brain.recallInternal` passes every dense candidate through the same SQL scope filter and per-hit `source()` / `visibleClaim` re-check. The owner's Ask bar and Your brain search use dense when the owner chose it; the judge stays off the owner's screens.

**Tech Stack:** TypeScript strict, Node 24 `node:sqlite` (BLOB + FTS5), Fastify 5, React 19, Zod 4, Vitest 5, Playwright 1.63. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-27-better-search-design.md` (rulings B1–B12 bind). Plan 5's rulings in `docs/superpowers/plans/2026-10-25-recall-followups.md` still bind (own setting outside `prefs()`, judge fast lane shape, code-point budgets, key isolation).

## Global Constraints

- Providers: exactly two, `ollama` (endpoint must be loopback; default `http://127.0.0.1:11434/api/embed`; default model `bge-m3`) and `cloudflare` (`@cf/baai/bge-m3` only, through `https://api.cloudflare.com/client/v4/accounts/<BRAIN_CLOUDFLARE_ACCOUNT_ID>/ai/run/@cf/baai/bge-m3`). Both are plain `fetch` calls from the worker.
- Environment (worker only): `BRAIN_EMBED_PROVIDER` (`ollama` | `cloudflare`; unset means not set up), `BRAIN_EMBED_MODEL`, `BRAIN_EMBED_ENDPOINT` (loopback only; for Cloudflare it is a loopback test server only), plus the existing `BRAIN_CLOUDFLARE_ACCOUNT_ID` and `BRAIN_DECISION_API_KEY`. No file under `apps/server/**`, `packages/domain/**`, `apps/web/**`, `apps/mcp/**` or `apps/cli/**` reads any of these; `scripts/run.mjs` is unchanged and keeps stripping the key from the server child (`recall-key-isolation.test.ts` is extended to cover `BRAIN_EMBED_` and the account id).
- Setting: `better_search` is its own setting (`{ mode: "off" | "ollama" | "cloudflare", key: string | null, consented_at: string | null }`), never a preference field, with its own owner-only routes `GET`/`PATCH /api/v1/preferences/better-search`. Default `mode: "off"`. With it off, no model is called, no `embed_batch` or `recall_embed` row is ever written, and every result equals plan 5 byte for byte.
- Status: the worker publishes `better_search_status` (`configured`, `provider`, `model`, `key`, `label`, `reason`, `last_error`, `last_ok_at`, `updated_at`); never the key, the account id or any text.
- Model key format: `"<provider>:<model>:<prefix-scheme>"`, e.g. `ollama:bge-m3:none`, `cloudflare:@cf/baai/bge-m3:none`. A row whose key differs from the configured key is stale: ignored at query time, re-embedded in the background. A search runs against exactly one key and one dim; mixed-model reads are refused.
- Fusion: `DENSE_WEIGHT = 0.7`, `RRF_K = 60` (unchanged), `DENSE_FLOOR_DEFAULT = 0.45` with `DENSE_FLOORS["bge-m3"] = 0.45` kept per model, at most 60 dense candidates (`CANDIDATES_PER_LIST`), exact entity match pinned, same authorization as every other candidate, freshness, dedupe and every plan 5 invariant unchanged. The deterministic push rule is term-based and unchanged (a dense-only hit never makes `strong`).
- Indexing: `embed_batch` embeds at most 32 rows per call (`EMBED_BATCH_SIZE`), current original chunks and fact rows only, text = chunk prefix + newline + chunk text capped at 2,000 code points (`EMBED_TEXT_MAX`), provider call outside any transaction, writes fenced and guarded by (kind, ref_id, ref_version, ordinal). Cloudflare never receives a `private` source row, an `owner`-visibility fact row or a quarantined note (quarantine sets visibility `private`); those rows stay BM25-only under Cloudflare. Ollama on loopback embeds everything.
- Money: Cloudflare spend goes through `DispatchLedger` (`reserve` → `markDispatched` → `execute` → `settle`), shares the daily cap (`prefs.daily_cap_micro_usd`, `per_job_cap_micro_usd`, both must be above 0 for Cloudflare), dispatch keys `embed_batch` and `recall_embed`. Price: $0.012 per million tokens = `12_000` micro-USD per million tokens, version `cf-bge-m3-2026-10-27`; tokens are estimated as `ceil(utf8 bytes / 2)` per text (conservative for Tamil) and settled at the reported usage when Cloudflare reports one, else at the estimate. All money is integer micro-USD. Ollama costs 0 and writes no ledger row.
- Query lane: `recall_embed` job, dedicated worker loop polling every 25 ms, server wait 400 ms (`QUERY_EMBED_DEADLINE_MS`) polling every 10 ms, worker cache by `sha256(model key + "\n" + query)` for 10 minutes (`QUERY_CACHE_MS = 600_000`), deterministic fallback to BM25 only. With the judge on, the candidate list (BM25 plus dense) is built before the judge is enqueued; total hook budget stays 1,500 ms (400 + 900 plus local work).
- Storage: Float32 little-endian BLOBs, normalised at write time; one in-process matrix per (scope, model key, dim). Invalidation writes nothing: an in-process generation counter is bumped by every index write made through this process (`replaceRows`, `purgeRef`, `clearRecallIndex`, `writeEmbeddings`, `clearEmbeddings`) and `PRAGMA data_version` (which changes whenever another connection commits) catches the worker's writes from the server, so a database with Better search off is byte-identical to plan 5 (the managed migration tests that assert an untouched settings table stay green).
- Outage safety: an HTTP error response with no usage settles its hold at 0 (nothing was billed); a timeout after send keeps its hold. A failed or unknown batch backs off exponentially (60 s doubling to 15 min); three consecutive failures open a circuit breaker that pauses embedding for 15 minutes with the status line "Better search paused: the service is not answering."; the self-heal check never enqueues while the breaker is open or the back-off runs. A batch refused with a 4xx is retried once as single rows; a row refused alone is withheld (`embedding_model` set, `embedding` NULL, `embedding_dim = -1` meaning "rejected") and skipped until its text changes.
- Turning the setting on backfills in batches; turning it off, or changing provider or model, clears all vectors and cancels queued batches; `rebuild()` and any refill leave rows without vectors, which the worker's self-heal check re-queues within 5 s when enabled. Purging a source removes its vectors with its rows (already true); the forget proof counts embedded rows (already true).
- Off limits: `packages/**/billing*`, `dodo*`, `paddle*`, `managed*`, `apps/server/billing-routes.ts`, `apps/worker/managed*.ts`, `apps/worker/decision-advisory.ts`, `packages/domain/decision-advisory.ts`; `/api/v1/context` and `/api/v1/changes` unchanged; `managedPreferencesPatchSchema`, `preferencesSchema` and the `prefs()` object unchanged; the MCP `outputSchema` of `brain_recall` unchanged (`RecallResult` gains no field; dense shows only in `why` as `"similar meaning"` and in the content-free recall log as `dense: true`).
- No new runtime or dev dependency; `package-lock.json` is not edited; `package.json` gains only the `proof:search` script line (task 8).
- Owner-run proofs (`npm run proof:search`, `proof:sorting`, `proof:recall`, `scripts/native-client-proof.ts`) are never run by agents or CI; CI uses the deterministic fake embedder `tests/helpers/fake-embed.mjs` only.
- Primary-flow copy never says model, embedding, vector, token, queue or classifier; Settings names the service by its label ("Ollama on this computer", "Cloudflare").
- Line numbers below are anchors in base commit `5ecd3e1`; every task shifts `service.ts`, so find each spot by the name next to the number, never by the number alone.
- Git: never `git add .`, never bare `git stash`, never rebase or force-push; after Playwright runs, `git restore docs/screenshots`; after `npm ci`, `git restore apps/cli/bibrain.mjs` if it shows line-ending-only changes.
- Commits end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **An owner edits a note while its old chunks are at the provider.** The batch read rows (ids, versions) before the call; `editSource` replaced them during it (new row ids, new `ref_version`; SQLite may reuse a deleted rowid for a different source). The write must land nowhere: the guard is (id, kind, ref_id, ref_version, ordinal) plus the job fence, and the new rows stay pending. Pinned in task 3 (`embed-batch.test.ts` "a vector never lands on a row that changed while the provider call was out").
2. **The owner changes `BRAIN_EMBED_MODEL` after vectors exist.** The worker publishes a new key; the stored consent carries the old key; search must not fuse old vectors with the new query (mixed-model read refused), the card must say "choose again", and no batch runs until the owner chooses. Pinned in task 4 ("nothing is queued when Better search is off, not effective, the worker is stale, or the query looks like a secret") and task 5 ("a stale vector is ignored and a mixed read is refused").
3. **A private note under Cloudflare.** A `private` source, an `owner`-visibility fact (names, preferences, private evidence) and a quarantined note must never appear in a Cloudflare request body, must stay BM25-only, and must still be findable by the owner through words. Pinned in task 3 ("Cloudflare never receives private, owner-only or quarantined text").
4. **The worker is down or the provider is slow on the owner's first question.** The server answers from BM25 at 400 ms, the queued job is cancelled and its query text deleted, and with the judge also on the whole push stays under 1,500 ms; the late vector still lands in the worker cache for the next identical question. Pinned in task 4 ("falls back to words only at 400 ms", "a late answer is cached") and task 5 ("recall and the hook push embed the query before the judge, within budget").
5. **Dense dilutes an exact name or invents an answer.** "NS-4471", "Lumen Catering" and "Northstar status" must keep their BM25 top hit with Better search on; "Zephyr budget for Q3" and the generic prompts must stay `no_match` under the floor. Pinned in task 7 (names and no-answer buckets, pin check on `pos-09`).

---

### Task 1: Provider client, environment, status and the CI fake embedder

**Size:** M (Sonnet). Pure code plus one worker status helper; no service.ts changes.

**Files:**
- Create: `packages/domain/better-search.ts` (constants, keys, model key, floors, text cap, token estimate, vector codec, effectiveness rule)
- Create: `packages/providers/embed.ts` (client: `resolveEmbedConfig`, `prepareEmbed`, `EmbedError`)
- Create: `packages/providers/embed-env.ts` (`embedFromEnv`)
- Create: `apps/worker/embed.ts` (status publishing only in this task: `publishBetterSearchStatus`, `noteEmbedStatus`, `EmbedClient`; task 3 adds the batch runner here)
- Create: `tests/helpers/fake-embed.mjs` and `tests/helpers/fake-embed.d.mts` (deterministic concept embedder; loopback server when `BRAIN_FAKE_EMBED_PORT` is set)
- Modify: `tests/integration/recall-key-isolation.test.ts` (line 16: extend the regex; add the account id and `BRAIN_EMBED_` prefix)
- Test: `tests/integration/embed-provider.test.ts`

**Interfaces:**
- Consumes: `detectSecrets` (`packages/storage/secrets.ts`), `SystemOneError`-style error shape (new `EmbedError`), `workerRunning` (`packages/domain/system-one.ts`), `Brain.store.set/setting`, `Brain.now()`.
- Produces (`packages/domain/better-search.ts`):
  - `export type EmbedProvider = "ollama" | "cloudflare"; export type BetterSearchMode = "off" | EmbedProvider;`
  - `export const BETTER_SEARCH = "better_search"; export const BETTER_SEARCH_STATUS = "better_search_status"; export const BETTER_SEARCH_PAUSED = "Better search paused: the service is not answering.";`
  - `export const DENSE_WEIGHT = 0.7; export const DENSE_FLOOR_DEFAULT = 0.45; export const DENSE_FLOORS: Record<string, number> = { "bge-m3": 0.45 };`
  - `export const EMBED_BATCH_SIZE = 32; export const EMBED_TEXT_MAX = 2000; export const EMBED_DIM_MIN = 8; export const EMBED_DIM_MAX = 4096;`
  - `export const QUERY_EMBED_DEADLINE_MS = 400; export const QUERY_EMBED_POLL_MS = 10; export const EMBED_LOOP_MS = 25; export const QUERY_CACHE_MS = 600_000; export const EMBED_SWEEP_AFTER_MS = 3_600_000; export const EMBED_RETRY_AFTER_MS = 60_000; export const EMBED_BACKOFF_MAX_MS = 900_000; export const EMBED_BREAKER_FAILURES = 3; export const EMBED_PAUSE_MS = 900_000; export const EMBED_CALL_MS = 15_000;`
  - `export const EMBED_STATE_KEY = (id: string) => \`recall_embed:${id}\`; export const EMBED_RESULT_KEY = (id: string) => \`recall_embed_result:${id}\`;`
  - `export const CLOUDFLARE_EMBED_MODEL = "@cf/baai/bge-m3"; export const OLLAMA_EMBED_MODEL = "bge-m3"; export const OLLAMA_EMBED_ENDPOINT = "http://127.0.0.1:11434/api/embed"; export const CLOUDFLARE_EMBED_PRICE = { version: "cf-bge-m3-2026-10-27", input_micro_usd_per_million: 12_000 } as const;`
  - `export const PROVIDER_LABELS: Record<EmbedProvider, string> = { ollama: "Ollama on this computer", cloudflare: "Cloudflare" };`
  - `export type BetterSearchSetting = { mode: BetterSearchMode; key: string | null; consented_at: string | null }; export const BETTER_SEARCH_OFF: BetterSearchSetting = { mode: "off", key: null, consented_at: null };`
  - `export type BetterSearchStatus = { configured: boolean; provider?: EmbedProvider; model?: string; key?: string; label?: string; reason?: string; updated_at: string; last_ok_at?: string; last_error?: string; failures?: number; retry_at?: string; paused_until?: string };` (the last three are the worker's back-off and circuit-breaker state)
  - `export type QueryVector = { vector: Float32Array; key: string; dim: number };`
  - `export function modelKey(provider: EmbedProvider, model: string): string`
  - `export function denseFloor(key: string): number`
  - `export function embedText(prefix: string, text: string): string`
  - `export function estimateTokens(texts: string[]): number`
  - `export function estimateMicroUsd(tokens: number, inputMicroUsdPerMillion: number): number`
  - `export function normalize(v: Float32Array): Float32Array` (in place; a zero vector stays zero)
  - `export function encodeVector(v: Float32Array): Buffer` / `export function decodeVector(buf: Uint8Array, dim: number): Float32Array` (little-endian, explicit `DataView`)
  - `export function vectorToBase64(v: Float32Array): string` / `export function vectorFromBase64(s: string, dim: number): Float32Array | null`
  - `export function betterSearchEffective(setting: BetterSearchSetting, status: BetterSearchStatus | null, workerRunning: boolean): { on: boolean; reason: string }`
- Produces (`packages/providers/embed.ts`):
  - `export type EmbedConfig = { provider: EmbedProvider; endpoint: string; model: string; key?: string; timeout_ms?: number; max_response_bytes?: number; price: { version: string; input_micro_usd_per_million: number } };`
  - `export type ResolvedEmbedConfig = Required<Omit<EmbedConfig, "key">> & { key?: string; loopback: boolean; url: URL };`
  - `export class EmbedError extends Error { constructor(readonly code: "INVALID_INPUT" | "PROVIDER_UNAVAILABLE" | "PROVIDER_INVALID" | "PROVIDER_TIMEOUT" | "PROVIDER_ABORTED", message: string, readonly status: number, readonly dispatched: boolean, readonly actual_cost_micro_usd?: number, readonly upstream_status?: number) }` (an HTTP error response or a Cloudflare error envelope carries `actual_cost_micro_usd: 0`, nothing was billed; a 4xx carries `upstream_status` so a batch can be retried row by row)
  - `export type EmbedResult = { vectors: Float32Array[]; dim: number; key: string; estimated_tokens: number; reported_tokens: number | null; cost_micro_usd: number; model: string };`
  - `export type PreparedEmbed = { json: string; bytes: number; request_hash: string; config_hash: string; estimated_tokens: number; reserved_micro_usd: number; key: string; model: string; provider: EmbedProvider; price_version: string; execute(signal: AbortSignal): Promise<EmbedResult> };`
  - `export function resolveEmbedConfig(config: EmbedConfig): ResolvedEmbedConfig`
  - `export function prepareEmbed(config: EmbedConfig, texts: string[], fetcher?: typeof fetch): PreparedEmbed`
- Produces (`packages/providers/embed-env.ts`): `export function embedFromEnv(env: Record<string, string | undefined>): { config: EmbedConfig; label: string; key: string } | { config: null; reason: string }` (`key` here is the model key, never the credential).
- Produces (`apps/worker/embed.ts`): `export type EmbedClient = { config: EmbedConfig; fetcher?: typeof fetch }; export function publishBetterSearchStatus(brain: Brain, from: { configured: true; provider: EmbedProvider; model: string; key: string; label: string } | { configured: false; reason: string }): void; export function noteEmbedStatus(brain: Brain, patch: Partial<Pick<BetterSearchStatus, "last_ok_at" | "last_error" | "failures" | "retry_at" | "paused_until">>): void`
- Produces (`tests/helpers/fake-embed.mjs`): `export const FAKE_EMBED_DIM = 256; export const FAKE_EMBED_MODEL = "fake-concept-v1"; export const LEXICON: string[][]; export function fakeTokens(text): string[]; export function fakeEmbed(text: string): number[]; export function cosine(a: number[], b: number[]): number; export function ollamaBody(texts: string[]): { model: string; embeddings: number[][]; prompt_eval_count: number }; export function cloudflareBody(texts: string[]): { success: true; errors: []; messages: []; result: { shape: [number, number]; data: number[][] } }; export function fakeEmbedFetcher(options?: { shape?: "ollama" | "cloudflare"; delayMs?: number; status?: number; reject?: (texts: string[]) => boolean; before?: (texts: string[]) => void }): { fetcher: typeof fetch; calls: { n: number; bodies: unknown[]; texts: string[][]; headers: Record<string, string>[] } }` (options are read at call time, so a test can flip `status`, `delayMs` or `reject` between calls).

**Steps:**

- [ ] Write the failing test `tests/integration/embed-provider.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  BETTER_SEARCH_OFF, DENSE_FLOOR_DEFAULT, EMBED_TEXT_MAX, betterSearchEffective, decodeVector, denseFloor, embedText, encodeVector,
  estimateMicroUsd, estimateTokens, modelKey, normalize, vectorFromBase64, vectorToBase64,
} from "../../packages/domain/better-search.ts";
import { EmbedError, prepareEmbed, resolveEmbedConfig } from "../../packages/providers/embed.ts";
import { embedFromEnv } from "../../packages/providers/embed-env.ts";
import { FAKE_EMBED_DIM, cosine, fakeEmbed, fakeEmbedFetcher } from "../helpers/fake-embed.mjs";

const account = "0123456789abcdef0123456789abcdef";
const KEY = ["sk", "test", "never", "a", "real", "key", "0123456789abcdef"].join("-");
const signal = () => new AbortController().signal;

describe("better-search pure helpers", () => {
  it("builds the model key, keeps a floor per model, caps the embedded text at 2,000 code points and prices in whole micro-USD", () => {
    expect(modelKey("ollama", "bge-m3")).toBe("ollama:bge-m3:none");
    expect(modelKey("cloudflare", "@cf/baai/bge-m3")).toBe("cloudflare:@cf/baai/bge-m3:none");
    expect(denseFloor("cloudflare:@cf/baai/bge-m3:none")).toBe(0.45);
    expect(denseFloor("ollama:bge-m3:latest:none")).toBe(0.45);
    expect(denseFloor("ollama:embeddinggemma:none")).toBe(DENSE_FLOOR_DEFAULT);
    const text = embedText("Launch notes · Northstar · 2026-10-18", "🧠".repeat(3000));
    expect(text.startsWith("Launch notes · Northstar · 2026-10-18\n🧠")).toBe(true);
    expect(Array.from(text).length).toBe(EMBED_TEXT_MAX);
    expect(estimateTokens(["abcd", "தமிழ்"])).toBe(2 + Math.ceil(Buffer.byteLength("தமிழ்") / 2));
    expect(estimateMicroUsd(1_000_000, 12_000)).toBe(12_000);
    expect(estimateMicroUsd(1, 12_000)).toBe(1);
    expect(estimateMicroUsd(0, 12_000)).toBe(0);
  });
  it("encodes little-endian Float32, normalises in place and leaves a zero vector alone", () => {
    const v = normalize(Float32Array.from([3, 4]));
    expect([...v]).toEqual([0.6000000238418579, 0.800000011920929]);
    const buf = encodeVector(Float32Array.from([1]));
    expect([...buf]).toEqual([0, 0, 0x80, 0x3f]);
    expect([...decodeVector(buf, 1)]).toEqual([1]);
    expect([...normalize(Float32Array.from([0, 0]))]).toEqual([0, 0]);
    const back = vectorFromBase64(vectorToBase64(v), 2)!;
    expect([...back]).toEqual([...v]);
    expect(vectorFromBase64(vectorToBase64(v), 3)).toBeNull();
    expect(vectorFromBase64("not base64!!", 2)).toBeNull();
  });
  it("is effective only when the stored consent matches what the worker published and the worker runs", () => {
    const status = { configured: true as const, provider: "ollama" as const, model: "bge-m3", key: "ollama:bge-m3:none", label: "Ollama on this computer", updated_at: "x" };
    const on = { mode: "ollama" as const, key: "ollama:bge-m3:none", consented_at: "x" };
    expect(betterSearchEffective(BETTER_SEARCH_OFF, status, true)).toMatchObject({ on: false, reason: "Better search is off." });
    expect(betterSearchEffective(on, null, true).reason).toBe("Better search status appears once BiBrain's background worker starts.");
    expect(betterSearchEffective(on, { configured: false, reason: "Add your Cloudflare account id.", updated_at: "x" }, true).reason).toBe("Add your Cloudflare account id.");
    expect(betterSearchEffective({ ...on, mode: "cloudflare" }, status, true).reason).toBe("Cloudflare is not set up on this computer.");
    expect(betterSearchEffective({ ...on, key: "ollama:embeddinggemma:none" }, status, true).reason).toBe("The search model changed. Choose Better search again.");
    expect(betterSearchEffective(on, status, false).reason).toBe("BiBrain's background worker is not running.");
    expect(betterSearchEffective(on, status, true)).toEqual({ on: true, reason: "ready" });
  });
});

describe("embedFromEnv", () => {
  it("is off with a plain reason until a provider is chosen, and never names the key", () => {
    expect(embedFromEnv({})).toEqual({ config: null, reason: "Better search is not set up on this computer." });
    expect(embedFromEnv({ BRAIN_EMBED_PROVIDER: "openai" })).toEqual({ config: null, reason: "Better search supports Ollama or Cloudflare only." });
    const r = embedFromEnv({ BRAIN_EMBED_PROVIDER: "cloudflare", BRAIN_CLOUDFLARE_ACCOUNT_ID: account, BRAIN_DECISION_API_KEY: KEY });
    expect(r.config).toMatchObject({ provider: "cloudflare", model: "@cf/baai/bge-m3", endpoint: `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/@cf/baai/bge-m3`, key: KEY, price: { version: "cf-bge-m3-2026-10-27", input_micro_usd_per_million: 12_000 } });
    expect("label" in r && r.label).toBe("Cloudflare");
    expect("key" in r && r.key).toBe("cloudflare:@cf/baai/bge-m3:none");
    expect(JSON.stringify({ ...r, config: { ...(r.config ?? {}), key: undefined } })).not.toContain(KEY);
  });
  it.each([
    [{ BRAIN_EMBED_PROVIDER: "cloudflare" }, /account id/i],
    [{ BRAIN_EMBED_PROVIDER: "cloudflare", BRAIN_CLOUDFLARE_ACCOUNT_ID: account }, /token/i],
    [{ BRAIN_EMBED_PROVIDER: "cloudflare", BRAIN_CLOUDFLARE_ACCOUNT_ID: account, BRAIN_DECISION_API_KEY: KEY, BRAIN_EMBED_MODEL: "@cf/baai/bge-small-en-v1.5" }, /@cf\/baai\/bge-m3/],
    [{ BRAIN_EMBED_PROVIDER: "cloudflare", BRAIN_CLOUDFLARE_ACCOUNT_ID: account, BRAIN_DECISION_API_KEY: KEY, BRAIN_EMBED_ENDPOINT: "https://evil.example/x" }, /test server/i],
    [{ BRAIN_EMBED_PROVIDER: "ollama", BRAIN_EMBED_ENDPOINT: "https://ollama.com/api/embed" }, /this computer/i],
    [{ BRAIN_EMBED_PROVIDER: "ollama", BRAIN_EMBED_MODEL: "../x" }, /model name/i],
  ])("explains a bad setup plainly: %j", (env, reason) => {
    const r = embedFromEnv(env);
    expect(r.config).toBeNull();
    expect("reason" in r && r.reason).toMatch(reason);
  });
  it("defaults Ollama to loopback bge-m3 with no key, and accepts a loopback test server for Cloudflare without a token", () => {
    const o = embedFromEnv({ BRAIN_EMBED_PROVIDER: "ollama", BRAIN_DECISION_API_KEY: KEY });
    expect(o.config).toMatchObject({ provider: "ollama", model: "bge-m3", endpoint: "http://127.0.0.1:11434/api/embed", price: { input_micro_usd_per_million: 0 } });
    expect(o.config?.key).toBeUndefined();
    expect("label" in o && o.label).toBe("Ollama on this computer");
    expect(embedFromEnv({ BRAIN_EMBED_PROVIDER: "ollama", BRAIN_EMBED_MODEL: "embeddinggemma:300m", BRAIN_EMBED_ENDPOINT: "http://localhost:11434/api/embed" }).config).toMatchObject({ model: "embeddinggemma:300m" });
    const c = embedFromEnv({ BRAIN_EMBED_PROVIDER: "cloudflare", BRAIN_EMBED_ENDPOINT: "http://127.0.0.1:4999/client/v4/accounts/test/ai/run/@cf/baai/bge-m3" });
    expect(c.config).toMatchObject({ provider: "cloudflare", endpoint: "http://127.0.0.1:4999/client/v4/accounts/test/ai/run/@cf/baai/bge-m3" });
  });
});

describe("prepareEmbed", () => {
  const ollama = { provider: "ollama" as const, endpoint: "http://127.0.0.1:9/api/embed", model: "fake-concept-v1", price: { version: "zero", input_micro_usd_per_million: 0 } };
  const cloud = { provider: "cloudflare" as const, endpoint: `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/@cf/baai/bge-m3`, model: "@cf/baai/bge-m3", key: KEY, price: { version: "cf-bge-m3-2026-10-27", input_micro_usd_per_million: 12_000 } };
  it("embeds a batch through Ollama's shape: one request, normalised vectors in order, no credential to loopback, cost 0", async () => {
    const { fetcher, calls } = fakeEmbedFetcher();
    const texts = ["Launch color: cobalt", "The daily sync is at 9 in the morning."];
    const prepared = prepareEmbed({ ...ollama, key: KEY }, texts, fetcher);
    expect(prepared.key).toBe("ollama:fake-concept-v1:none");
    expect(prepared.reserved_micro_usd).toBe(0);
    const out = await prepared.execute(signal());
    expect(calls.n).toBe(1);
    expect(calls.texts[0]).toEqual(texts);
    expect(calls.headers[0].Authorization).toBeUndefined();
    expect((calls.bodies[0] as any).truncate).toBe(true);
    expect(out.vectors).toHaveLength(2);
    expect(out.dim).toBe(FAKE_EMBED_DIM);
    for (const v of out.vectors) expect(Math.abs(Math.hypot(...v) - 1)).toBeLessThan(1e-5);
    expect(out.cost_micro_usd).toBe(0);
    expect(cosine([...out.vectors[0]], fakeEmbed(texts[0]))).toBeGreaterThan(0.999);
  });
  it("embeds through Cloudflare's envelope with a bearer token, reserves the estimate and settles it when no usage is reported", async () => {
    const { fetcher, calls } = fakeEmbedFetcher({ shape: "cloudflare" });
    const prepared = prepareEmbed(cloud, ["a".repeat(1000)], fetcher);
    expect(prepared.estimated_tokens).toBe(500);
    expect(prepared.reserved_micro_usd).toBe(Math.ceil((500 * 12_000) / 1_000_000));
    const out = await prepared.execute(signal());
    expect(calls.headers[0].Authorization).toBe(`Bearer ${KEY}`);
    expect((calls.bodies[0] as any).truncate_inputs).toBe(true);
    expect(out.reported_tokens).toBeNull();
    expect(out.cost_micro_usd).toBe(prepared.reserved_micro_usd);
    expect(out.key).toBe("cloudflare:@cf/baai/bge-m3:none");
  });
  it("refuses secret-looking text before any request, and rejects bad answers after it", async () => {
    const { fetcher, calls } = fakeEmbedFetcher();
    expect(() => prepareEmbed(ollama, [`api_key = ${KEY}`], fetcher)).toThrow(EmbedError);
    try { prepareEmbed(ollama, [`api_key = ${KEY}`], fetcher); } catch (e) { expect((e as EmbedError).dispatched).toBe(false); }
    expect(calls.n).toBe(0);
    expect(() => prepareEmbed(ollama, [], fetcher)).toThrow(/between 1 and 32/);
    expect(() => prepareEmbed(ollama, Array.from({ length: 33 }, () => "x"), fetcher)).toThrow(/between 1 and 32/);
    const wrongCount = (async (_u: any, _i: any) => new Response(JSON.stringify({ embeddings: [[0.1, 0.2]] }), { status: 200 })) as unknown as typeof fetch;
    await expect(prepareEmbed(ollama, ["a", "b"], wrongCount).execute(signal())).rejects.toMatchObject({ code: "PROVIDER_INVALID", dispatched: true });
    const ragged = (async () => new Response(JSON.stringify({ embeddings: [Array(16).fill(0.1), Array(8).fill(0.1)] }), { status: 200 })) as unknown as typeof fetch;
    await expect(prepareEmbed(ollama, ["a", "b"], ragged).execute(signal())).rejects.toMatchObject({ code: "PROVIDER_INVALID" });
    const down = fakeEmbedFetcher({ status: 503 });
    await expect(prepareEmbed(ollama, ["a"], down.fetcher).execute(signal())).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", dispatched: true, actual_cost_micro_usd: 0, upstream_status: 503 });
    const refused = fakeEmbedFetcher({ reject: () => true });
    await expect(prepareEmbed(ollama, ["a"], refused.fetcher).execute(signal())).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", actual_cost_micro_usd: 0, upstream_status: 400 });
    const slow = fakeEmbedFetcher({ delayMs: 400 });
    await expect(prepareEmbed({ ...ollama, timeout_ms: 50 }, ["a"], slow.fetcher).execute(signal())).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT", dispatched: true });
    const huge = (async () => new Response(JSON.stringify({ embeddings: [Array(4096).fill(0.001)] }), { status: 200 })) as unknown as typeof fetch;
    await expect(prepareEmbed({ ...ollama, max_response_bytes: 1024 }, ["a"], huge).execute(signal())).rejects.toMatchObject({ code: "PROVIDER_INVALID" });
    const failed = (async () => new Response(JSON.stringify({ success: false, errors: [{ message: "nope" }] }), { status: 200 })) as unknown as typeof fetch;
    await expect(prepareEmbed(cloud, ["a"], failed).execute(signal())).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", actual_cost_micro_usd: 0 });
    const slowSend = fakeEmbedFetcher({ delayMs: 400 });
    const timeout = await prepareEmbed({ ...cloud, timeout_ms: 50 }, ["a"], slowSend.fetcher).execute(signal()).catch((e: EmbedError) => e);
    expect(timeout).toMatchObject({ code: "PROVIDER_TIMEOUT", dispatched: true });
    expect((timeout as EmbedError).actual_cost_micro_usd).toBeUndefined();
  });
  it("validates the endpoint rules: loopback-only Ollama, Cloudflare with a key or a loopback test server", () => {
    expect(() => resolveEmbedConfig({ ...ollama, endpoint: "https://ollama.com/api/embed" })).toThrow(/this computer/);
    expect(() => resolveEmbedConfig({ ...cloud, key: undefined })).toThrow(/credential/i);
    expect(resolveEmbedConfig({ ...cloud, endpoint: "http://127.0.0.1:4999/x", key: undefined }).loopback).toBe(true);
    expect(() => resolveEmbedConfig({ ...ollama, endpoint: "http://user:pw@127.0.0.1:11434/api/embed" })).toThrow();
    expect(() => resolveEmbedConfig({ ...ollama, timeout_ms: 0 })).toThrow();
  });
});

describe("the fake embedder", () => {
  it("puts paraphrases and English–Tamil pairs above the floor and unrelated text below it", () => {
    const above = [
      ["which hue was chosen for the release", "Northstar · Launch color\nLaunch color: cobalt"],
      ["வெளியீட்டு நிறம் என்ன", "Northstar · Launch color\nLaunch color: cobalt"],
      ["when does the stand-up happen", "Morning rhythm · Northstar · 2026-10-25\nThe crew sync is at 9 every morning."],
      ["குழு எப்போது சந்திக்கிறது", "Morning rhythm · Northstar · 2026-10-25\nThe crew sync is at 9 every morning."],
      ["where is the new office", "புதிய அலுவலகம் · Northstar · 2026-10-25\nபுதிய அலுவலகம் சென்னையில் திறக்கிறது. குழு ஜனவரியில் நகர்கிறது."],
    ];
    for (const [q, t] of above) expect(cosine(fakeEmbed(q), fakeEmbed(t)), q).toBeGreaterThanOrEqual(0.5);
    const below = [
      ["Zephyr budget for Q3", "Allowance · Northstar · 2026-10-25\nThe quarterly tooling allowance is two thousand dollars, approved by Ana."],
      ["Orion rollout checklist", "Northstar · Launch color\nLaunch color: cobalt"],
      ["fix the TypeScript error cannot find module", "Support · Northstar · 2026-10-25\nTicket NS-4471 tracks the login outage; the patch went out in release 2.3.1."],
      ["what is the office wifi password", "புதிய அலுவலகம் · Northstar · 2026-10-25\nபுதிய அலுவலகம் சென்னையில் திறக்கிறது. குழு ஜனவரியில் நகர்கிறது."],
    ];
    for (const [q, t] of below) expect(cosine(fakeEmbed(q), fakeEmbed(t)), q).toBeLessThan(0.45);
    expect(fakeEmbed("")).toEqual(Array(FAKE_EMBED_DIM).fill(0));
    expect(fakeEmbed("NS-4471")).toEqual(Array(FAKE_EMBED_DIM).fill(0));
    expect(fakeEmbed("Launch color")).toEqual(fakeEmbed("launch COLOR"));
  });
});
```

- [ ] Run: `npx vitest run tests/integration/embed-provider.test.ts` — expected failure: `Cannot find module '../../packages/domain/better-search.ts'`.

- [ ] Create `packages/domain/better-search.ts`:

```ts
import type { RecallVisibility } from "../storage/recall-index.ts";

export type EmbedProvider = "ollama" | "cloudflare";
export type BetterSearchMode = "off" | EmbedProvider;

export const BETTER_SEARCH = "better_search";
export const BETTER_SEARCH_STATUS = "better_search_status";
/** The status line while the worker's circuit breaker is open. Read by Settings and by every path that decides whether a model may be called. */
export const BETTER_SEARCH_PAUSED = "Better search paused: the service is not answering.";

export const DENSE_WEIGHT = 0.7;
export const DENSE_FLOOR_DEFAULT = 0.45;
/** Cosine floors by base model name (the part after the last "/" and before any ":tag"). */
export const DENSE_FLOORS: Record<string, number> = { "bge-m3": 0.45 };
export const EMBED_BATCH_SIZE = 32;
export const EMBED_TEXT_MAX = 2000;
export const EMBED_DIM_MIN = 8;
export const EMBED_DIM_MAX = 4096;
export const QUERY_EMBED_DEADLINE_MS = 400;
export const QUERY_EMBED_POLL_MS = 10;
export const EMBED_LOOP_MS = 25;
export const QUERY_CACHE_MS = 600_000;
export const EMBED_SWEEP_AFTER_MS = 3_600_000;
/** The first back-off after a failed batch; it doubles per consecutive failure up to EMBED_BACKOFF_MAX_MS. */
export const EMBED_RETRY_AFTER_MS = 60_000;
export const EMBED_BACKOFF_MAX_MS = 900_000;
/** Consecutive failed batches that open the circuit breaker, and how long it stays open. */
export const EMBED_BREAKER_FAILURES = 3;
export const EMBED_PAUSE_MS = 900_000;
/** Abort bound for one provider call in the worker (batch or query). */
export const EMBED_CALL_MS = 15_000;
export const EMBED_STATE_KEY = (id: string) => `recall_embed:${id}`;
export const EMBED_RESULT_KEY = (id: string) => `recall_embed_result:${id}`;

export const CLOUDFLARE_EMBED_MODEL = "@cf/baai/bge-m3";
export const OLLAMA_EMBED_MODEL = "bge-m3";
export const OLLAMA_EMBED_ENDPOINT = "http://127.0.0.1:11434/api/embed";
/** $0.012 per million tokens, as integer micro-USD per million tokens. */
export const CLOUDFLARE_EMBED_PRICE = { version: "cf-bge-m3-2026-10-27", input_micro_usd_per_million: 12_000 } as const;
export const PROVIDER_LABELS: Record<EmbedProvider, string> = { ollama: "Ollama on this computer", cloudflare: "Cloudflare" };
/** What each provider may embed. Cloudflare never receives private sources, owner-only facts or quarantined notes (visibility private). */
export const EMBED_VISIBILITIES: Record<EmbedProvider, RecallVisibility[]> = { ollama: ["project", "private", "owner"], cloudflare: ["project"] };

export type BetterSearchSetting = { mode: BetterSearchMode; key: string | null; consented_at: string | null };
export const BETTER_SEARCH_OFF: BetterSearchSetting = { mode: "off", key: null, consented_at: null };
export type BetterSearchStatus = {
  configured: boolean;
  provider?: EmbedProvider;
  model?: string;
  key?: string;
  label?: string;
  reason?: string;
  updated_at: string;
  last_ok_at?: string;
  last_error?: string;
  /** Consecutive failed or unknown batches; reset by a success. */
  failures?: number;
  /** No batch is queued before this time (60 s doubling to 15 min). */
  retry_at?: string;
  /** Set after three consecutive failures: nothing is embedded until it passes. */
  paused_until?: string;
};
export type QueryVector = { vector: Float32Array; key: string; dim: number };

/** The row key: provider, model and the prefix scheme (bge-m3 uses none). A changed scheme is a changed key. */
export function modelKey(provider: EmbedProvider, model: string): string {
  return `${provider}:${model}:none`;
}

export function denseFloor(key: string): number {
  const parts = key.split(":");
  const model = parts.slice(1, -1).join(":");
  const base = (model.split("/").at(-1) ?? model).split(":")[0];
  return DENSE_FLOORS[base] ?? DENSE_FLOOR_DEFAULT;
}

/** The text a row is embedded as: its prefix, a newline, its text; capped at 2,000 code points. */
export function embedText(prefix: string, text: string): string {
  return Array.from(`${prefix}\n${text}`).slice(0, EMBED_TEXT_MAX).join("");
}

/** A conservative token estimate (half the UTF-8 bytes); Tamil tokenises to many tokens per word, so bytes, not words. */
export function estimateTokens(texts: string[]): number {
  return texts.reduce((n, t) => n + Math.ceil(Buffer.byteLength(t, "utf8") / 2), 0);
}

export function estimateMicroUsd(tokens: number, inputMicroUsdPerMillion: number): number {
  const micro = Math.ceil((tokens * inputMicroUsdPerMillion) / 1_000_000);
  if (!Number.isSafeInteger(micro) || micro < 0) throw new RangeError("The cost estimate is out of range.");
  return micro;
}

export function normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  if (sum === 0) return v;
  const inv = 1 / Math.sqrt(sum);
  for (let i = 0; i < v.length; i++) v[i] *= inv;
  return v;
}

export function encodeVector(v: Float32Array): Buffer {
  const buf = Buffer.alloc(v.length * 4);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let i = 0; i < v.length; i++) view.setFloat32(i * 4, v[i], true);
  return buf;
}

export function decodeVector(buf: Uint8Array, dim: number): Float32Array {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out = new Float32Array(dim);
  for (let i = 0; i < dim; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

export function vectorToBase64(v: Float32Array): string {
  return encodeVector(v).toString("base64");
}

/** Null when the text is not base64 of exactly `dim` little-endian floats, or holds a non-finite value. */
export function vectorFromBase64(s: string, dim: number): Float32Array | null {
  if (typeof s !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/u.test(s)) return null;
  const buf = Buffer.from(s, "base64");
  if (buf.length !== dim * 4) return null;
  const v = decodeVector(buf, dim);
  for (let i = 0; i < dim; i++) if (!Number.isFinite(v[i])) return null;
  return v;
}

/** The one rule every reader applies: the stored consent must match what the worker published, and the worker must be running. */
export function betterSearchEffective(setting: BetterSearchSetting, status: BetterSearchStatus | null, workerRunning: boolean): { on: boolean; reason: string } {
  if (setting.mode === "off") return { on: false, reason: "Better search is off." };
  if (!status) return { on: false, reason: "Better search status appears once BiBrain's background worker starts." };
  if (!status.configured) return { on: false, reason: status.reason ?? "Better search is not set up on this computer." };
  if (status.provider !== setting.mode) return { on: false, reason: `${PROVIDER_LABELS[setting.mode]} is not set up on this computer.` };
  if (status.key !== setting.key) return { on: false, reason: "The search model changed. Choose Better search again." };
  if (!workerRunning) return { on: false, reason: "BiBrain's background worker is not running." };
  return { on: true, reason: "ready" };
}
```

- [ ] Create `packages/providers/embed.ts` (mirrors `system-one-ask.ts`: deadline race, bounded read, no key to loopback, `redirect: "error"`):

```ts
import { createHash } from "node:crypto";
import { detectSecrets } from "../storage/secrets.ts";
import { EMBED_BATCH_SIZE, EMBED_DIM_MAX, EMBED_DIM_MIN, estimateMicroUsd, estimateTokens, modelKey, normalize, type EmbedProvider } from "../domain/better-search.ts";

export type EmbedConfig = {
  provider: EmbedProvider;
  endpoint: string;
  model: string;
  key?: string;
  timeout_ms?: number;
  max_response_bytes?: number;
  price: { version: string; input_micro_usd_per_million: number };
};
export type ResolvedEmbedConfig = Required<Omit<EmbedConfig, "key">> & { key?: string; loopback: boolean; url: URL };
export type EmbedResult = { vectors: Float32Array[]; dim: number; key: string; estimated_tokens: number; reported_tokens: number | null; cost_micro_usd: number; model: string };
export type PreparedEmbed = {
  json: string;
  bytes: number;
  request_hash: string;
  config_hash: string;
  estimated_tokens: number;
  reserved_micro_usd: number;
  key: string;
  model: string;
  provider: EmbedProvider;
  price_version: string;
  execute(signal: AbortSignal): Promise<EmbedResult>;
};
export type EmbedErrorCode = "INVALID_INPUT" | "PROVIDER_UNAVAILABLE" | "PROVIDER_INVALID" | "PROVIDER_TIMEOUT" | "PROVIDER_ABORTED";

export class EmbedError extends Error {
  constructor(
    readonly code: EmbedErrorCode,
    message: string,
    readonly status: number,
    readonly dispatched: boolean,
    readonly actual_cost_micro_usd?: number,
    /** The provider's HTTP status when the request was answered with an error; 4xx means the input was refused. */
    readonly upstream_status?: number,
  ) {
    super(message);
  }
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const MODEL = /^[A-Za-z0-9@][A-Za-z0-9_.:/-]{0,79}$/u;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2_097_152;
const MAX_REQUEST_BYTES = 1_048_576;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const bad = (message: string): never => {
  throw new EmbedError("INVALID_INPUT", message, 400, false);
};
const refuse = (message: string): never => {
  throw new EmbedError("PROVIDER_UNAVAILABLE", message, 503, false);
};

/** Ollama: loopback http only. Cloudflare: api.cloudflare.com with a credential, or a loopback test server with none. */
export function resolveEmbedConfig(config: EmbedConfig): ResolvedEmbedConfig {
  let url: URL;
  try {
    url = new URL(config.endpoint);
  } catch {
    return refuse("The better-search endpoint is not a valid URL.");
  }
  if (url.username || url.password || url.search || url.hash) refuse("The better-search endpoint may not carry credentials or a query.");
  const loopback = url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  if (config.provider === "ollama" && !loopback) refuse("Better search with Ollama must point at an Ollama on this computer.");
  if (config.provider === "cloudflare") {
    const official = url.protocol === "https:" && url.hostname === "api.cloudflare.com" && url.port === "";
    if (!official && !loopback) refuse("Better search with Cloudflare must use api.cloudflare.com.");
    if (official && !config.key) refuse("A server-side credential is required for Cloudflare.");
  }
  if (typeof config.model !== "string" || !MODEL.test(config.model)) refuse("The better-search model name is not allowed.");
  const timeout = config.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > MAX_TIMEOUT_MS) refuse("The better-search timeout is out of range.");
  const maxResponse = config.max_response_bytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(maxResponse) || maxResponse < 64 || maxResponse > 33_554_432) refuse("The better-search response bound is out of range.");
  const price = config.price;
  if (!price || typeof price.version !== "string" || !price.version || !Number.isSafeInteger(price.input_micro_usd_per_million) || price.input_micro_usd_per_million < 0) refuse("The better-search price is invalid.");
  return { provider: config.provider, endpoint: config.endpoint, model: config.model, key: config.key, timeout_ms: timeout, max_response_bytes: maxResponse, price: { ...price }, loopback, url };
}

/** No I/O. Texts are refused when empty, more than one batch, or secret-looking. */
export function prepareEmbed(config: EmbedConfig, texts: string[], fetcher: typeof fetch = fetch): PreparedEmbed {
  const resolved = resolveEmbedConfig(config);
  if (!Array.isArray(texts) || texts.length < 1 || texts.length > EMBED_BATCH_SIZE) bad("Embed between 1 and 32 texts per call.");
  if (texts.some((t) => typeof t !== "string" || !t.trim())) bad("Every text must be non-empty.");
  if (detectSecrets(texts.join("\n")).length > 0) bad("This content looks like it may contain a secret, so it was not sent.");
  const json = JSON.stringify(resolved.provider === "ollama" ? { model: resolved.model, input: texts, truncate: true } : { text: texts, truncate_inputs: true });
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > MAX_REQUEST_BYTES) bad("The request is larger than the configured limit.");
  const estimated_tokens = estimateTokens(texts);
  const reserved = estimateMicroUsd(estimated_tokens, resolved.price.input_micro_usd_per_million);
  const key = modelKey(resolved.provider, resolved.model);
  return {
    json,
    bytes,
    request_hash: sha(json),
    config_hash: sha(JSON.stringify({ p: resolved.provider, e: resolved.endpoint, m: resolved.model, v: resolved.price.version, pi: resolved.price.input_micro_usd_per_million, t: resolved.timeout_ms, rs: resolved.max_response_bytes })),
    estimated_tokens,
    reserved_micro_usd: reserved,
    key,
    model: resolved.model,
    provider: resolved.provider,
    price_version: resolved.price.version,
    execute: (signal) => run(resolved, json, texts.length, key, estimated_tokens, reserved, fetcher, signal),
  };
}

/** The whole request runs under one deadline enforced by a race, so a fetcher that ignores its signal still cannot outlive `timeout_ms`. */
async function run(resolved: ResolvedEmbedConfig, json: string, count: number, key: string, estimated: number, reserved: number, fetcher: typeof fetch, signal: AbortSignal): Promise<EmbedResult> {
  if (signal.aborted) throw new EmbedError("PROVIDER_ABORTED", "Cancelled before it was sent.", 499, false);
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, resolved.timeout_ms);
  const work = Promise.resolve().then(() => perform(resolved, json, count, key, estimated, reserved, fetcher, controller.signal));
  work.catch(() => undefined);
  const expired = new Promise<never>((_, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => reject(timedOut ? new EmbedError("PROVIDER_TIMEOUT", "The search model did not answer in time.", 504, true) : new EmbedError("PROVIDER_ABORTED", "Cancelled while waiting for the search model.", 499, true)),
      { once: true },
    );
  });
  expired.catch(() => undefined);
  try {
    return await Promise.race([work, expired]);
  } catch (error) {
    if (error instanceof EmbedError) throw error;
    throw new EmbedError("PROVIDER_UNAVAILABLE", "The search model request failed.", 503, true);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

async function perform(resolved: ResolvedEmbedConfig, json: string, count: number, key: string, estimated: number, reserved: number, fetcher: typeof fetch, signal: AbortSignal): Promise<EmbedResult> {
  const fail = (code: EmbedErrorCode, message: string, status: number): never => {
    throw new EmbedError(code, message, status, true);
  };
  if (signal.aborted) throw new EmbedError("PROVIDER_ABORTED", "Cancelled before it was sent.", 499, false);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  // A local endpoint is never handed a credential, even when one is configured.
  if (resolved.key && !resolved.loopback) headers.Authorization = `Bearer ${resolved.key}`;
  const res = await fetcher(resolved.endpoint, { method: "POST", headers, body: json, signal, redirect: "error" });
  if (!res.ok) {
    res.body?.cancel().catch(() => undefined);
    // An error response is not billed: the known cost is 0, and the status lets a 4xx be retried row by row.
    throw new EmbedError("PROVIDER_UNAVAILABLE", `The search model answered ${res.status}.`, 503, true, 0, res.status);
  }
  const reader = res.body?.getReader();
  const cancelReader = () => {
    reader?.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancelReader, { once: true });
  let raw = "";
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    while (reader) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > resolved.max_response_bytes) {
        cancelReader();
        fail("PROVIDER_INVALID", "The answer was larger than the configured limit.", 502);
      }
      chunks.push(Buffer.from(value));
    }
    raw = Buffer.concat(chunks).toString("utf8");
  } finally {
    signal.removeEventListener("abort", cancelReader);
  }
  let payload: any;
  try {
    payload = JSON.parse(raw);
  } catch {
    fail("PROVIDER_INVALID", "The search model returned unreadable data.", 502);
  }
  // `any`, not `unknown`: `fail` is a const arrow, so a never-returning call does not narrow for the compiler (TS18046 otherwise).
  let rows: any;
  let reported: number | null = null;
  if (resolved.provider === "cloudflare") {
    if (payload?.success !== true) throw new EmbedError("PROVIDER_UNAVAILABLE", "The search model reported an error.", 503, true, 0);
    rows = payload?.result?.data;
    const usage = payload?.result?.usage?.total_tokens ?? payload?.result?.usage?.prompt_tokens;
    if (Number.isSafeInteger(usage) && usage >= 0) reported = usage;
  } else {
    rows = payload?.embeddings;
    if (Number.isSafeInteger(payload?.prompt_eval_count) && payload.prompt_eval_count >= 0) reported = payload.prompt_eval_count;
  }
  if (!Array.isArray(rows) || rows.length !== count) fail("PROVIDER_INVALID", "The answer did not match the texts sent.", 502);
  const dim = Array.isArray(rows[0]) ? rows[0].length : 0;
  if (dim < EMBED_DIM_MIN || dim > EMBED_DIM_MAX) fail("PROVIDER_INVALID", "The answer had an unusable vector size.", 502);
  const vectors: Float32Array[] = [];
  for (const row of rows as unknown[]) {
    if (!Array.isArray(row) || row.length !== dim || row.some((x) => typeof x !== "number" || !Number.isFinite(x))) fail("PROVIDER_INVALID", "The answer held an invalid vector.", 502);
    vectors.push(normalize(Float32Array.from(row as number[])));
  }
  const cost = reported === null ? reserved : estimateMicroUsd(reported, resolved.price.input_micro_usd_per_million);
  if (cost > reserved) throw new EmbedError("PROVIDER_UNAVAILABLE", "The search model used more than its estimate.", 503, true, cost);
  return { vectors, dim, key, estimated_tokens: estimated, reported_tokens: reported, cost_micro_usd: cost, model: resolved.model };
}
```

- [ ] Create `packages/providers/embed-env.ts`:

```ts
import { CLOUDFLARE_EMBED_MODEL, CLOUDFLARE_EMBED_PRICE, OLLAMA_EMBED_ENDPOINT, OLLAMA_EMBED_MODEL, PROVIDER_LABELS, modelKey } from "../domain/better-search.ts";
import { resolveEmbedConfig, type EmbedConfig } from "./embed.ts";

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"];
const MODEL = /^[A-Za-z0-9@][A-Za-z0-9_.:/-]{0,79}$/u;

/** The override URL, "" when unset, or null when it is not a loopback URL. */
function loopbackOverride(raw: string | undefined): string | null {
  const override = raw?.trim();
  if (!override) return "";
  try {
    const u = new URL(override);
    return u.protocol === "http:" && LOOPBACK_HOSTS.includes(u.hostname) ? override : null;
  } catch {
    return null;
  }
}

/**
 * The worker's better-search configuration, or one plain sentence saying why it is off.
 * The credential appears only in `config.key`; `key` on the success branch is the MODEL key.
 */
export function embedFromEnv(env: Record<string, string | undefined>): { config: EmbedConfig; label: string; key: string } | { config: null; reason: string } {
  const off = (reason: string) => ({ config: null, reason }) as const;
  const provider = (env.BRAIN_EMBED_PROVIDER ?? "").trim();
  if (!provider) return off("Better search is not set up on this computer.");
  if (provider !== "ollama" && provider !== "cloudflare") return off("Better search supports Ollama or Cloudflare only.");
  const model = (env.BRAIN_EMBED_MODEL ?? "").trim() || (provider === "ollama" ? OLLAMA_EMBED_MODEL : CLOUDFLARE_EMBED_MODEL);
  if (!MODEL.test(model)) return off("The better-search model name may only use letters, numbers, dots, dashes, colons and slashes.");
  const override = loopbackOverride(env.BRAIN_EMBED_ENDPOINT);
  let config: EmbedConfig;
  if (provider === "ollama") {
    if (override === null) return off("BRAIN_EMBED_ENDPOINT must point at an Ollama on this computer.");
    config = { provider, endpoint: override || OLLAMA_EMBED_ENDPOINT, model, price: { version: "ollama-free", input_micro_usd_per_million: 0 } };
  } else {
    if (model !== CLOUDFLARE_EMBED_MODEL) return off(`The Cloudflare search model must be ${CLOUDFLARE_EMBED_MODEL}.`);
    if (override === null) return off("BRAIN_EMBED_ENDPOINT is only for a local test server.");
    const key = (env.BRAIN_DECISION_API_KEY ?? "").trim() || undefined;
    if (override) config = { provider, endpoint: override, model, price: { ...CLOUDFLARE_EMBED_PRICE } };
    else {
      const account = (env.BRAIN_CLOUDFLARE_ACCOUNT_ID ?? "").trim();
      if (!/^[0-9a-f]{32}$/u.test(account)) return off("Add your Cloudflare account id (32 letters and numbers) to turn on better search with Cloudflare.");
      if (!key) return off("Add a Cloudflare API token with Workers AI access to turn on better search with Cloudflare.");
      config = { provider, endpoint: `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${model}`, model, key, price: { ...CLOUDFLARE_EMBED_PRICE } };
    }
  }
  try {
    resolveEmbedConfig(config);
  } catch (error) {
    return off(error instanceof Error ? error.message : "Better search is set up incorrectly.");
  }
  return { config, label: PROVIDER_LABELS[provider], key: modelKey(provider, model) };
}
```

- [ ] Create `apps/worker/embed.ts` (status part; task 3 appends the runner to this file):

```ts
import type { Brain } from "../../packages/domain/service.ts";
import { BETTER_SEARCH_STATUS, type BetterSearchStatus, type EmbedProvider } from "../../packages/domain/better-search.ts";
import type { EmbedConfig } from "../../packages/providers/embed.ts";

export type EmbedClient = { config: EmbedConfig; fetcher?: typeof fetch };

/** Writes the startup status. Carries the model key and a label, never the credential or the account id. */
export function publishBetterSearchStatus(
  brain: Brain,
  from: { configured: true; provider: EmbedProvider; model: string; key: string; label: string } | { configured: false; reason: string },
) {
  brain.store.set(BETTER_SEARCH_STATUS, { ...from, updated_at: brain.now() } satisfies BetterSearchStatus);
}

/** Records the latest outcome (and the back-off state) on the published status; does nothing before startup published one. */
export function noteEmbedStatus(brain: Brain, patch: Partial<Pick<BetterSearchStatus, "last_ok_at" | "last_error" | "failures" | "retry_at" | "paused_until">>) {
  try {
    const current = brain.store.setting<BetterSearchStatus | null>(BETTER_SEARCH_STATUS, null);
    if (current) brain.store.set(BETTER_SEARCH_STATUS, { ...current, ...patch });
  } catch {
    /* Status is informational; it must never fail the job. */
  }
}
```

- [ ] Create `tests/helpers/fake-embed.mjs` (concept lexicon; `fakeEmbed` = presence of each lexicon group (weight 1) plus each unknown token hashed into dims 128–255 (weight 0.3), normalised; a loopback server speaking Ollama's `/api/embed` shape and Cloudflare's `/client/v4/accounts/*/ai/run/*` envelope when `BRAIN_FAKE_EMBED_PORT` is set):

```js
// A deterministic stand-in for an embedding model, for CI only. It maps text to a
// 256-dimensional unit vector through a small fixed concept lexicon (synonym groups and
// English–Tamil pairs), so fusion, floors, pinning, authorization, staleness and fallback
// can be tested without a model. It keeps no state and never logs request bodies.
import { createHash } from "node:crypto";
import { createServer } from "node:http";

export const FAKE_EMBED_DIM = 256;
export const FAKE_EMBED_MODEL = "fake-concept-v1";
const CONCEPT_DIMS = 128;
const UNKNOWN_WEIGHT = 0.3;
const STOP = new Set("the and for with what when where who how does did are was were this that from each much can will there get got about into than then they them their its our your you".split(" "));

export const LEXICON = [
  ["colour", "color", "hue", "shade", "நிறம்"],
  ["launch", "release", "வெளியீடு", "வெளியீட்டு"],
  ["choose", "chosen", "pick", "picked", "settle", "settled", "decide", "decided"],
  ["price", "fee", "cost", "விலை"],
  ["month", "monthly", "மாத", "மாதம்"],
  ["design", "designer", "visual"],
  ["lead", "head", "chief", "தலைவர்"],
  ["work", "job", "வேலை"],
  ["beta", "trial", "preview"],
  ["open", "start", "begin", "திறக்கிறது", "தொடங்குகிறது"],
  ["invite", "invitation", "join", "rsvp"],
  ["waitlist", "signup", "queue"],
  ["cater", "caterer", "catering", "food", "meal"],
  ["party", "celebration"],
  ["vendor", "supplier"],
  ["spend", "spending", "allowance", "செலவு"],
  ["quarter", "quarterly", "காலாண்டு"],
  ["tooling", "software", "tool"],
  ["plan", "tier"],
  ["offer", "offered", "provide", "provided"],
  ["standup", "stand", "sync", "scrum", "huddle", "meet", "meeting", "சந்திக்கிறது", "சந்திப்பு"],
  ["team", "squad", "crew", "குழு", "அணி"],
  ["office", "அலுவலகம்"],
  ["new", "புதிய"],
  ["move", "relocate", "நகர்கிறது", "மாறுகிறது"],
  ["january", "ஜனவரி", "ஜனவரியில்"],
  // "statu" is "status" after fakeTokens strips the trailing s; both forms are listed so the raw and the stemmed word hit.
  ["status", "statu", "state", "standing", "நிலை"],
  ["active", "running", "live"],
  ["paused", "hold", "stopped"],
  ["deploy", "deployment"],
  ["thursday", "வியாழன்"],
  ["dollar", "டாலர்"],
  ["morning", "காலை"],
  ["daily", "everyday", "தினமும்"],
  ["ticket", "issue"],
  ["login", "signin"],
  ["outage", "downtime"],
  ["patch", "hotfix"],
];
const CONCEPT = new Map();
LEXICON.forEach((group, i) => group.forEach((w) => CONCEPT.set(w, i)));
if (LEXICON.length > CONCEPT_DIMS) throw new Error("fake-embed lexicon exceeds its concept dims");

/** Lowercased letter runs of 3+ code points, trailing "s" dropped (mirrors questionWords), minus a short stoplist. */
export function fakeTokens(text) {
  const words = String(text).toLocaleLowerCase().match(/[\p{L}\p{M}]+/gu) ?? [];
  return [...new Set(words.filter((w) => Array.from(w).length > 2 && !STOP.has(w)).map((w) => w.replace(/s$/u, "")))];
}

export function fakeEmbed(text) {
  const v = new Array(FAKE_EMBED_DIM).fill(0);
  for (const t of fakeTokens(text)) {
    const c = CONCEPT.get(t);
    if (c !== undefined) v[c] = 1;
    else {
      const h = createHash("sha256").update(t).digest();
      v[CONCEPT_DIMS + (h.readUInt16BE(0) % (FAKE_EMBED_DIM - CONCEPT_DIMS))] = UNKNOWN_WEIGHT;
    }
  }
  const norm = Math.hypot(...v);
  return norm === 0 ? v : v.map((x) => x / norm);
}

export function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export function ollamaBody(texts) {
  return { model: FAKE_EMBED_MODEL, embeddings: texts.map(fakeEmbed), prompt_eval_count: texts.reduce((n, t) => n + Math.ceil(Buffer.byteLength(t) / 4), 0) };
}

export function cloudflareBody(texts) {
  return { success: true, errors: [], messages: [], result: { shape: [texts.length, FAKE_EMBED_DIM], data: texts.map(fakeEmbed) } };
}

const textsOf = (body) => (Array.isArray(body?.input) ? body.input : Array.isArray(body?.text) ? body.text : typeof body?.input === "string" ? [body.input] : typeof body?.text === "string" ? [body.text] : []);

/** An in-process fetcher for Vitest: records every call, answers in the chosen shape, and can delay, fail or run a hook before answering. */
export function fakeEmbedFetcher(options = {}) {
  const calls = { n: 0, bodies: [], texts: [], headers: [] };
  const fetcher = async (_url, init) => {
    calls.n++;
    const body = JSON.parse(init.body);
    const texts = textsOf(body);
    calls.bodies.push(body);
    calls.texts.push(texts);
    calls.headers.push({ ...(init.headers ?? {}) });
    if (options.before) await options.before(texts);
    if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
    if (options.status && options.status !== 200) return new Response("", { status: options.status });
    // A provider that refuses an input: 400 for the whole request, so a batch holding one bad text fails as a batch.
    if (options.reject && options.reject(texts)) return new Response(JSON.stringify({ error: "input refused" }), { status: 400 });
    const payload = options.shape === "cloudflare" ? cloudflareBody(texts) : ollamaBody(texts);
    return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return { fetcher, calls };
}

const port = Number(process.env.BRAIN_FAKE_EMBED_PORT);
if (process.env.BRAIN_FAKE_EMBED_PORT) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error("BRAIN_FAKE_EMBED_PORT must be a port number.");
    process.exit(1);
  }
  const server = createServer((req, res) => {
    const ollama = req.method === "POST" && req.url === "/api/embed";
    const cloud = req.method === "POST" && /^\/client\/v4\/accounts\/[^/]+\/ai\/run\//u.test(req.url ?? "");
    if (!ollama && !cloud) {
      res.writeHead(404).end();
      return;
    }
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        res.writeHead(400).end();
        return;
      }
      const texts = textsOf(body);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(ollama ? ollamaBody(texts) : cloudflareBody(texts)));
    });
  });
  server.listen(port, "127.0.0.1");
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
}
```

- [ ] Create `tests/helpers/fake-embed.d.mts` so `tsc --noEmit` (strict, `tests` included) accepts the import:

```ts
export const FAKE_EMBED_DIM: number;
export const FAKE_EMBED_MODEL: string;
export const LEXICON: string[][];
export function fakeTokens(text: string): string[];
export function fakeEmbed(text: string): number[];
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number;
export function ollamaBody(texts: string[]): { model: string; embeddings: number[][]; prompt_eval_count: number };
export function cloudflareBody(texts: string[]): { success: true; errors: never[]; messages: never[]; result: { shape: [number, number]; data: number[][] } };
export function fakeEmbedFetcher(options?: { shape?: "ollama" | "cloudflare"; delayMs?: number; status?: number; reject?: (texts: string[]) => boolean; before?: (texts: string[]) => void | Promise<void> }): {
  fetcher: typeof fetch;
  calls: { n: number; bodies: unknown[]; texts: string[][]; headers: Record<string, string>[] };
};
```

- [ ] Extend `tests/integration/recall-key-isolation.test.ts` line 16 to `expect(text, file).not.toMatch(/BRAIN_DECISION_API_KEY|OLLAMA_API_KEY|BRAIN_CLOUDFLARE_ACCOUNT_ID|BRAIN_EMBED_/);` and rename the describe to "the Clef key and the better-search setup stay in the worker". (`packages/providers/**` is not scanned, which is where `embed-env.ts` lives.)

- [ ] Run: `npx vitest run tests/integration/embed-provider.test.ts tests/integration/recall-key-isolation.test.ts` — expected: all pass. If a fake-embedder geometry assertion fails, adjust `UNKNOWN_WEIGHT` or the lexicon, never the asserted floors (0.5 above, 0.45 below).
- [ ] Run: `npm run typecheck && npm run lint` — expected exit 0.
- [ ] Commit: `git add packages/domain/better-search.ts packages/providers/embed.ts packages/providers/embed-env.ts apps/worker/embed.ts tests/helpers/fake-embed.mjs tests/helpers/fake-embed.d.mts tests/integration/embed-provider.test.ts tests/integration/recall-key-isolation.test.ts` then commit with message:

```
feat(search): embedding provider client, worker env and CI fake embedder

Plain-fetch client for Ollama /api/embed (loopback only) and Cloudflare
@cf/baai/bge-m3, configured from the worker environment, with a key-free
better_search_status and a deterministic concept embedder for tests.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
```

---

### Task 2: Vector storage, scope-filtered search, matrix cache and staleness

**Size:** M (Sonnet). Storage only; no model, no worker.

**Files:**
- Create: `packages/storage/recall-vectors.ts`
- Modify: `packages/storage/recall-index.ts` (`RECALL_DDL` lines 37–55: add the `recall_chunks_embed` index; `purgeRef` line 237, `replaceRows` line 242, `clearRecallIndex` line 319: bump the in-process generation; `searchRecallChunks` line 376: select explicit columns instead of `c.*` so BM25 rows never carry their 4 KB vector)
- Test: `tests/integration/recall-vectors.test.ts`
- Existing tests to run: `recall-index.test.ts` (compares rows through `recallRowsInDb`, explicit columns), `tests/eval/recall.test.ts`, and the two managed migration tests that assert an untouched settings table, `tests/integration/managed-decision-advisory-migration.test.ts` and `tests/integration/managed-decision-advisory-migration-review.test.ts` (they must stay green without being edited: the generation never writes a settings row).

**Interfaces:**
- Consumes: `Storage.run/get/all/transaction` (`packages/storage/index.ts`), `RecallMatch`, `RecallKind`, `RecallVisibility`, `RecallRowStatus` (`recall-index.ts`), `encodeVector`, `decodeVector`, `normalize` (`packages/domain/better-search.ts`), SQLite's `PRAGMA data_version`.
- Produces (`packages/storage/recall-vectors.ts`):
  - `export type PendingRow = { id: number; kind: RecallKind; ref_id: string; ref_version: number; ordinal: number; text: string; prefix: string }`
  - `export function pendingEmbedRows(store: Storage, key: string, visibilities: RecallVisibility[], limit: number): PendingRow[]` (current rows whose `embedding_model` is NULL or differs from `key`, in the given visibilities, ordered by id)
  - `export function countEmbedRows(store: Storage, key: string, visibilities: RecallVisibility[]): { total: number; embedded: number; pending: number; withheld: number }` (`withheld` = model is `key` but embedding NULL)
  - `export type VectorWrite = { id: number; kind: RecallKind; ref_id: string; ref_version: number; ordinal: number; vector: Float32Array | null; reason?: "secret" | "rejected" }`
  - `export function writeEmbeddings(store: Storage, key: string, dim: number, rows: VectorWrite[]): number` (caller holds the transaction; a `null` vector marks the row withheld with `embedding_dim` NULL for `"secret"` and `-1` for `"rejected"`; the UPDATE is guarded by `id, kind, ref_id, ref_version, ordinal` and `status='current'`; bumps the generation when anything changed; returns rows changed)
  - `export function clearEmbeddings(store: Storage): number` (NULLs all three columns; bumps the generation)
  - `export function bumpVectorGeneration(): void` / `export function vectorGeneration(): number` (an in-process counter; no database write)
  - `export type VectorQuery = { vector: Float32Array; key: string; dim: number; projects: string[]; visibilities: RecallVisibility[]; status: RecallRowStatus | "any"; floor: number; limit: number }`
  - `export class VectorCache { constructor(maxScopes = 8); search(store: Storage, q: VectorQuery): RecallMatch[] }` (`score` is the cosine, higher is better; a scope's matrix is rebuilt when the in-process generation or SQLite's `data_version` moved; rows are re-read by id after the scan and dropped unless their `embedding_model` still equals `key`)
- Produces (`recall-index.ts`): `RECALL_DDL` gains `CREATE INDEX IF NOT EXISTS recall_chunks_embed ON recall_chunks(status, embedding_model);` (runs at every open under `IF NOT EXISTS`; no migration bump). `purgeRef` and `clearRecallIndex` call `bumpVectorGeneration()` (`replaceRows` bumps through `purgeRef`). `searchRecallChunks` selects `c.id,c.kind,c.ref_id,c.ref_version,c.project_id,c.visibility,c.status,c.ordinal,c.start,c.end,c.text,c.prefix,c.recorded_at,c.boost` instead of `c.*`.

**Steps:**

- [ ] Write the failing test `tests/integration/recall-vectors.test.ts`:

```ts
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
```

- [ ] Run: `npx vitest run tests/integration/recall-vectors.test.ts` — expected failure: `Cannot find module '../../packages/storage/recall-vectors.ts'`.

- [ ] Create `packages/storage/recall-vectors.ts`:

```ts
import type { Storage } from "./index.ts";
import type { RecallKind, RecallMatch, RecallRowStatus, RecallVisibility } from "./recall-index.ts";
import { decodeVector, encodeVector, normalize } from "../domain/better-search.ts";

export type PendingRow = { id: number; kind: RecallKind; ref_id: string; ref_version: number; ordinal: number; text: string; prefix: string };
/** A `null` vector withholds the row: `"secret"` (never sent) keeps `embedding_dim` NULL, `"rejected"` (the provider refused it alone) stores -1. */
export type VectorWrite = { id: number; kind: RecallKind; ref_id: string; ref_version: number; ordinal: number; vector: Float32Array | null; reason?: "secret" | "rejected" };
export type VectorQuery = { vector: Float32Array; key: string; dim: number; projects: string[]; visibilities: RecallVisibility[]; status: RecallRowStatus | "any"; floor: number; limit: number };

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
  let changed = 0;
  for (const r of rows) {
    if (r.vector && r.vector.length !== dim) throw new RangeError("Vector length does not match the batch dim.");
    const result = store.run(
      "UPDATE recall_chunks SET embedding=?,embedding_model=?,embedding_dim=? WHERE id=? AND kind=? AND ref_id=? AND ref_version=? AND ordinal=? AND status='current'",
      r.vector ? encodeVector(normalize(r.vector)) : null,
      key,
      r.vector ? dim : r.reason === "rejected" ? -1 : null,
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
    if (!q.projects.length || !q.visibilities.length || q.limit < 1 || q.vector.length !== q.dim) return [];
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
    rows.forEach((r, i) => {
      ids.push(r.id);
      matrix.set(decodeVector(r.embedding, q.dim), i * q.dim);
    });
    const entry = { generation, dataVersion: version, ids, matrix };
    if (!this.entries.has(scope) && this.entries.size >= this.maxScopes) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(scope, entry);
    return entry;
  }
}
```

- [ ] Modify `packages/storage/recall-index.ts`:
  - Add `import { bumpVectorGeneration } from "./recall-vectors.ts";` after line 3. (`recall-vectors.ts` imports only types from `recall-index.ts`, so there is no runtime cycle.)
  - In `RECALL_DDL` (line 37–55), after the `recall_chunks_scope` index line, add: `CREATE INDEX IF NOT EXISTS recall_chunks_embed ON recall_chunks(status, embedding_model);`
  - `purgeRef` (line 237): after the two DELETEs add `bumpVectorGeneration();`.
  - `replaceRows` (line 242): leave as is (it calls `purgeRef`, which bumps).
  - `clearRecallIndex` (line 319): after the two DELETEs add `bumpVectorGeneration();`.
  - `searchRecallChunks` (line 376): replace `SELECT c.*, bm25(...)` with `SELECT c.id,c.kind,c.ref_id,c.ref_version,c.project_id,c.visibility,c.status,c.ordinal,c.start,c.end,c.text,c.prefix,c.recorded_at,c.boost, bm25(recall_fts, 1.0, 0.5) AS score` so a BM25 candidate never carries its vector.

- [ ] Run: `npx vitest run tests/integration/recall-vectors.test.ts tests/integration/recall-index.test.ts tests/eval/recall.test.ts tests/integration/managed-decision-advisory-migration.test.ts tests/integration/managed-decision-advisory-migration-review.test.ts` — expected: all pass (no settings row is written by any index write; the eval latency gate stays under 300 ms).
- [ ] Run: `npm run typecheck && npm run lint` — expected exit 0.
- [ ] Commit: `git add packages/storage/recall-vectors.ts packages/storage/recall-index.ts tests/integration/recall-vectors.test.ts` with message:

```
feat(search): vector storage, guarded writes and a generation-keyed dense scan

Float32 LE vectors in recall_chunks.embedding, written under a
(kind, ref_id, ref_version, ordinal) guard; a per-scope matrix cache
invalidated by a settings generation every index write bumps.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
```

---

### Task 3: `embed_batch` worker job, ledger, the setting, backfill and enqueue hooks

**Size:** L (Sonnet; the riskiest task after task 5: fence, guard, money, privacy filter).

**Files:**
- Modify: `apps/worker/embed.ts` (append `EmbedDeps`, `EmbedJob`, `EmbedOutcome`, `EMBED_CHECK_MS`, `runEmbedBatch`, `maybeQueueEmbedBatch`)
- Modify: `apps/worker/engine.ts` (constructor: sixth parameter `embed`; `schedule()` line 157: self-heal check after the heartbeat; `tick()`: an `embed_batch` branch right after the `system_one_route` branch that ends at line 279)
- Modify: `apps/worker/main.ts` (local branch, after `publishSystemOneStatus` line 500: `embedFromEnv` + `publishBetterSearchStatus`; the `new Worker(` call at line 501 gains the sixth argument)
- Modify: `packages/domain/service.ts` (imports at lines 14 and 52; a `queueEmbedIfOn()` call after `syncClaim` in `createEntity` line 482 and `revise` line 507, after `syncSource` in `capture` line 643, after `syncClaimsCiting` in `editSourceTx` line 1123 and after the `syncSource` in `recordSystemOneResult` line 4567; new methods `betterSearchSetting`, `betterSearchAllowed`, `betterSearch`, `setBetterSearch`, `enqueueEmbedBatch`, `embedQueueOpen`, `queueEmbedIfOn` after `setRecallHelp` line 1899; the local Settings job list at line 5110 and `job()` line 5115–5117 hide `embed_batch` and `recall_embed`; the managed job list at line 5052 is not touched)
- Test: `tests/integration/embed-batch.test.ts`
- Existing tests to run (they read `status(owner).jobs` or construct `Worker`): `tests/integration/recall-judge.test.ts`, `tests/integration/system-one-worker.test.ts`, `tests/integration/brain.test.ts`, `tests/integration/operations.test.ts`.

**Interfaces:**
- Consumes: `pendingEmbedRows`, `writeEmbeddings`, `countEmbedRows`, `clearEmbeddings` (task 2); `prepareEmbed`, `EmbedError`, `PreparedEmbed`, `EmbedResult` (task 1); `DispatchAccounting` (`apps/worker/accounting.ts`); `DispatchSpec`, `JobLease`, `SpendLimits`, `DispatchRecord` (`packages/domain/spend.ts`); `detectSecrets`; `workerRunning`; `Brain.prefs/enqueue/ownerPrincipal/now/clock`.
- Produces (`packages/domain/service.ts`):
  - `betterSearchSetting(): BetterSearchSetting` (shape-guarded read of `better_search`, default `BETTER_SEARCH_OFF`)
  - `betterSearchAllowed(): { on: boolean; reason: string; setting: BetterSearchSetting; status: BetterSearchStatus | null }` (local brain only; `betterSearchEffective`, then the worker's circuit breaker (`status.paused_until` in the future gives `BETTER_SEARCH_PAUSED`), then for Cloudflare both caps above 0; the one rule the server's query lane and the worker's loops both read)
  - `betterSearch(p: Principal): { mode; key; consented_at; status: { configured; provider; label; reason; key; last_error; last_ok_at } | null; effective: boolean; reason: string; worker_running: boolean; caps_ok: boolean; counts: { total; embedded; pending; withheld }; failures: number; retry_at: string | null; paused_until: string | null }`
  - `setBetterSearch(p: Principal, input: unknown): BetterSearchSetting` (`{ mode }`; off always accepted and clears vectors and queued batches; a provider needs the published setup for exactly that provider, a running worker and, for Cloudflare, both caps; any change of mode or key clears vectors; queues the first batch)
  - `enqueueEmbedBatch(): string | null` (one batch at a time; `null` when one is queued, waiting or running)
  - `embedQueueOpen(): boolean` (`betterSearchAllowed().on` and the worker's `retry_at` has passed; the capture hooks, the self-heal check and `runEmbedBatch` all read it)
  - `private queueEmbedIfOn(): void`
- Produces (`apps/worker/embed.ts`):
  - `export const EMBED_CHECK_MS = 5_000;`
  - `export type EmbedDeps = { brain: Brain; ledger: DispatchAccounting; client: EmbedClient | null; owner: Principal; leaseOwner: string }; export type EmbedJob = { id: string; fence: number }; export type EmbedOutcome = { outcome: "embedded" | "nothing" | "cancelled" | "failed"; rows: number; more: boolean; error?: string }`
  - `export async function runEmbedBatch(deps: EmbedDeps, job: EmbedJob, signal: AbortSignal): Promise<EmbedOutcome>` (a failed or unknown call records a failure on the status: `failures + 1`, `retry_at = now + min(60 s × 2^(failures−1), 15 min)`, and `paused_until = now + 15 min` from the third failure; a success resets all three; a batch refused with a 4xx is retried row by row under dispatch keys `embed_batch:<row id>` and a row refused alone is withheld as `"rejected"`)
  - `export function maybeQueueEmbedBatch(brain: Brain): boolean` (false while `betterSearchAllowed()` is off, which includes the breaker, or `status.retry_at` is in the future)
- Produces (`apps/worker/engine.ts`): `constructor(..., systemOne: SystemOneClient | null = null, private readonly embed: EmbedClient | null = null)`.

**Steps:**

- [ ] Write the failing test `tests/integration/embed-batch.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../../packages/storage/index.ts";
import { Brain } from "../../packages/domain/service.ts";
import { Worker } from "../../apps/worker/engine.ts";
import { LocalDispatchAccounting } from "../../apps/worker/accounting.ts";
import { maybeQueueEmbedBatch, publishBetterSearchStatus, type EmbedClient } from "../../apps/worker/embed.ts";
import { embedFromEnv } from "../../packages/providers/embed-env.ts";
import { DispatchLedger } from "../../packages/storage/spend.ts";
import { EMBED_VISIBILITIES, modelKey, type EmbedProvider } from "../../packages/domain/better-search.ts";
import { countEmbedRows, vectorGeneration } from "../../packages/storage/recall-vectors.ts";
import { FAKE_EMBED_MODEL, fakeEmbedFetcher } from "../helpers/fake-embed.mjs";
import { buildFixture, owner, type Fixture } from "../eval/recall-fixture.ts";
import type { Principal } from "../../packages/contracts/index.ts";

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.reverse()) fn();
  cleanup = [];
});
const KEY = ["sk", "test", "never", "a", "real", "key", "0123456789abcdef"].join("-");
type Opts = { provider?: EmbedProvider; caps?: boolean; before?: (texts: string[]) => void | Promise<void> };
type Fake = { shape: EmbedProvider; status: number; delayMs?: number; reject?: (texts: string[]) => boolean; before?: Opts["before"] };
/** A fixture brain on a movable clock, the published setup for `provider`, a recording fake fetcher (its options are read at call time) and a worker that owns the batch job. */
function batched(opts: Opts = {}) {
  const provider = opts.provider ?? "ollama";
  const dir = mkdtempSync(join(tmpdir(), "embed-batch-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const fx: Fixture = buildFixture(join(dir, "fixture.sqlite"));
  cleanup.push(() => fx.store.close());
  const time = { now: new Date("2026-10-25T09:00:00.000Z") };
  const brain = new Brain(fx.store, () => time.now);
  const model = provider === "ollama" ? FAKE_EMBED_MODEL : "@cf/baai/bge-m3";
  const env = embedFromEnv({ BRAIN_EMBED_PROVIDER: provider, BRAIN_EMBED_MODEL: model, BRAIN_EMBED_ENDPOINT: provider === "ollama" ? "http://127.0.0.1:9/api/embed" : "http://127.0.0.1:9/client/v4/accounts/test/ai/run/@cf/baai/bge-m3" });
  if (!env.config) throw new Error(env.reason);
  const key = modelKey(provider, model);
  publishBetterSearchStatus(brain, { configured: true, provider, model, key, label: env.label });
  brain.store.set("worker_heartbeat", brain.now());
  if (opts.caps !== false) brain.prefs(owner, { ...brain.prefs(owner), daily_cap_micro_usd: 50_000, per_job_cap_micro_usd: 5_000 });
  const fake: Fake = { shape: provider, status: 200, before: opts.before };
  const { fetcher, calls } = fakeEmbedFetcher(fake);
  const client: EmbedClient = { config: env.config, fetcher };
  const worker = new Worker(brain, undefined, new LocalDispatchAccounting(fx.store, () => time.now), undefined, null, client);
  const drain = async () => {
    for (let i = 0; i < 200; i++) if (!(await worker.tick())) return;
    throw new Error("the worker never drained");
  };
  /** Moves the brain's clock and keeps the worker "running" (its heartbeat is fresh for 30 s only). */
  const advance = (ms: number) => {
    time.now = new Date(time.now.getTime() + ms);
    fx.store.set("worker_heartbeat", brain.now());
  };
  const counts = () => countEmbedRows(fx.store, key, EMBED_VISIBILITIES[provider]);
  const jobs = (status?: string) => fx.store.all<{ id: string; status: string }>(`SELECT id,status FROM jobs WHERE kind='embed_batch'${status ? " AND status=?" : ""} ORDER BY created_at`, ...(status ? [status] : []));
  return { fx, brain, store: fx.store, key, calls, fake, client, worker, drain, advance, counts, jobs, time, provider };
}
const note = (b: Brain, project: string, i: number) => b.capture(owner, { project_id: project, title: `Filler ${i}`, body: `Filler note number ${i} about routine matters.`, visibility: "project", separate: true });

describe("embed_batch", () => {
  it("turning Better search on backfills every eligible current row in batches of at most 32 and then stays idle", async () => {
    const t = batched();
    for (let i = 0; i < 40; i++) note(t.brain, t.fx.ids["project:northstar"], i);
    expect(t.jobs()).toEqual([]);
    expect(t.brain.setBetterSearch(owner, { mode: "ollama" })).toMatchObject({ mode: "ollama", key: t.key });
    expect(t.jobs("queued")).toHaveLength(1);
    const before = t.counts();
    expect(before.pending).toBeGreaterThan(32);
    await t.drain();
    expect(t.calls.n).toBeGreaterThanOrEqual(2);
    for (const texts of t.calls.texts) expect(texts.length).toBeLessThanOrEqual(32);
    expect(t.calls.texts.flat().some((x) => x.startsWith("Launch notes · Northstar · 2026-10-25\nWe met on Tuesday"))).toBe(true);
    const after = t.counts();
    expect(after).toMatchObject({ pending: 0, withheld: 0 });
    expect(after.embedded).toBe(before.total);
    expect(t.store.get<any>("SELECT embedding_dim AS d, length(embedding) AS n FROM recall_chunks WHERE embedding IS NOT NULL LIMIT 1")).toEqual({ d: 256, n: 1024 });
    expect(t.jobs().every((j) => j.status === "succeeded")).toBe(true);
    expect(t.store.all("SELECT 1 FROM provider_dispatches")).toEqual([]);
    const n = t.calls.n;
    await t.drain();
    expect(t.calls.n).toBe(n);
    expect(t.brain.betterSearch(owner)).toMatchObject({ mode: "ollama", effective: true, reason: "ready", counts: { pending: 0 } });
    // A new note queues one more batch and is embedded without touching the rest.
    const g = vectorGeneration();
    note(t.brain, t.fx.ids["project:northstar"], 99);
    expect(t.jobs("queued")).toHaveLength(1);
    await t.drain();
    expect(t.calls.texts.at(-1)!.length).toBe(1);
    expect(t.counts().pending).toBe(0);
    expect(vectorGeneration()).toBeGreaterThan(g);
    expect(t.store.all("SELECT key FROM settings WHERE key LIKE '%vector%' OR key LIKE '%generation%'")).toEqual([]);
  });
  it("Cloudflare never receives private, owner-only or quarantined text, pays through the ledger, and stops when the daily limit is gone", async () => {
    const t = batched({ provider: "cloudflare" });
    t.brain.setBetterSearch(owner, { mode: "cloudflare" });
    await t.drain();
    const sent = JSON.stringify(t.calls.bodies);
    for (const canary of ["PRIVATE_CANARY_TEXT", "Ana Costa", "short answers", "Owner preferences"]) expect(sent).not.toContain(canary);
    expect(t.calls.headers.every((h) => h.Authorization === undefined)).toBe(true);
    const privateRows = t.store.all<any>("SELECT embedding, embedding_model FROM recall_chunks WHERE visibility IN ('private','owner')");
    expect(privateRows.length).toBeGreaterThan(0);
    expect(privateRows.every((r) => r.embedding === null && r.embedding_model === null)).toBe(true);
    expect(t.counts()).toMatchObject({ pending: 0 });
    const dispatches = t.store.all<any>("SELECT dispatch_key,state,provider,actual_micro_usd FROM provider_dispatches");
    expect(dispatches.length).toBe(t.calls.n);
    for (const d of dispatches) expect(d).toMatchObject({ dispatch_key: "embed_batch", state: "settled", provider: "cloudflare" });
    expect(dispatches.every((d) => d.actual_micro_usd > 0)).toBe(true);
    // Quarantine sets visibility private, so the same filter covers it; the words stay searchable for the owner (task 5).
    t.brain.prefs(owner, { ...t.brain.prefs(owner), daily_cap_micro_usd: 0 });
    expect(() => t.brain.setBetterSearch(owner, { mode: "cloudflare" })).toThrow(/limit/);
    expect(t.brain.betterSearch(owner)).toMatchObject({ mode: "cloudflare", effective: false, caps_ok: false });
    // Nothing is queued while the limits are gone, neither by a capture nor by the self-heal check; the stored choice stays.
    note(t.brain, t.fx.ids["project:northstar"], 1);
    expect(t.jobs("queued")).toEqual([]);
    expect(maybeQueueEmbedBatch(t.brain)).toBe(false);
    const n = t.calls.n;
    await t.drain();
    expect(t.calls.n).toBe(n);
    expect(t.brain.betterSearch(owner).reason).toMatch(/limit/);
  });
  it("Cloudflare: an error response settles its hold at 0, a timeout after send keeps it, and an outage never eats the daily limit", async () => {
    const t = batched({ provider: "cloudflare" });
    t.brain.setBetterSearch(owner, { mode: "cloudflare" });
    t.fake.status = 503;
    await t.drain();
    expect(t.calls.n).toBe(1);
    expect(t.store.all<any>("SELECT state,actual_micro_usd FROM provider_dispatches")).toEqual([{ state: "settled", actual_micro_usd: 0 }]);
    expect(t.jobs().at(-1)!.status).toBe("failed");
    expect(t.brain.betterSearch(owner)).toMatchObject({ failures: 1, effective: true });
    // Nothing more is sent while the back-off runs, however often the check runs or notes are captured.
    for (let i = 0; i < 5; i++) {
      note(t.brain, t.fx.ids["project:northstar"], i);
      expect(maybeQueueEmbedBatch(t.brain)).toBe(false);
      await t.drain();
    }
    expect(t.calls.n).toBe(1);
    // A timeout after the request went out: the cost is unknown, the hold stays, and it counts toward the breaker.
    t.advance(61_000);
    t.fake.status = 200;
    t.fake.delayMs = 300;
    t.client.config.timeout_ms = 50;
    expect(maybeQueueEmbedBatch(t.brain)).toBe(true);
    await t.drain();
    expect(t.calls.n).toBe(2);
    expect(t.store.all<any>("SELECT state FROM provider_dispatches ORDER BY created_at").map((r) => r.state)).toEqual(["settled", "dispatched"]);
    expect(t.brain.betterSearch(owner)).toMatchObject({ failures: 2 });
    expect(t.brain.betterSearch(owner).status!.last_error).toMatch(/did not answer in time/);
    const prefs = t.brain.prefs(owner);
    const summary = new DispatchLedger(t.store, () => t.time.now).summary({ per_job_micro_usd: prefs.per_job_cap_micro_usd, daily_micro_usd: prefs.daily_cap_micro_usd, time_zone: prefs.time_zone });
    expect(summary.unresolved_micro_usd).toBeGreaterThan(0);
    expect(summary.unresolved_micro_usd).toBeLessThan(prefs.per_job_cap_micro_usd);
  });
  it("a passage the service refuses is retried alone, withheld as rejected, and never blocks the rest", async () => {
    const t = batched({ provider: "cloudflare" });
    const id = t.fx.ids["src:palette-review"];
    t.store.run("UPDATE recall_chunks SET text=? WHERE kind='original' AND ref_id=? AND ordinal=0", "POISON_ROW the palettes were reviewed", id);
    t.fake.reject = (texts) => texts.some((x) => x.includes("POISON_ROW"));
    t.brain.setBetterSearch(owner, { mode: "cloudflare" });
    await t.drain();
    const first = t.calls.texts[0].length;
    expect(first).toBeGreaterThan(1);
    // One refused batch, then that batch's rows one by one, then the remaining batches.
    expect(t.calls.n).toBeGreaterThanOrEqual(1 + first);
    expect(t.calls.texts.slice(1, 1 + first).every((x) => x.length === 1)).toBe(true);
    expect(t.store.get<any>("SELECT embedding, embedding_model, embedding_dim FROM recall_chunks WHERE kind='original' AND ref_id=? AND ordinal=0", id)).toEqual({ embedding: null, embedding_model: t.key, embedding_dim: -1 });
    expect(t.counts()).toMatchObject({ pending: 0, withheld: 1 });
    expect(t.jobs().every((j) => j.status === "succeeded")).toBe(true);
    expect(t.brain.betterSearch(owner)).toMatchObject({ failures: 0, effective: true });
    expect(t.brain.betterSearch(owner).status!.last_error).toMatch(/refused/);
    const rows = t.store.all<any>("SELECT dispatch_key,state,actual_micro_usd FROM provider_dispatches");
    expect(rows.filter((r) => r.dispatch_key === "embed_batch" && r.actual_micro_usd === 0).length).toBeGreaterThanOrEqual(1);
    expect(rows.filter((r) => r.dispatch_key.startsWith("embed_batch:")).length).toBe(first);
    expect(rows.every((r) => r.state === "settled")).toBe(true);
    // Its text changes with the next edit, so it is embedded then.
    t.brain.editSource(owner, id, { title: "Palette review", body: "Marco reviewed three palettes again.", expected_version: 1 });
    t.fake.reject = undefined;
    await t.drain();
    expect(t.counts()).toMatchObject({ pending: 0, withheld: 0 });
  });
  it("a vector never lands on a row that changed while the provider call was out, and a lost fence writes nothing", async () => {
    const t = batched({
      before: () => {
        const id = t.fx.ids["src:launch-notes"];
        const version = t.store.get<any>("SELECT version FROM sources WHERE id=?", id)!.version;
        if (version === 1) t.brain.editSource(owner, id, { title: "Launch notes", body: "Rewritten while the batch was out: the launch colour is amber now.", expected_version: 1 });
      },
    });
    t.brain.setBetterSearch(owner, { mode: "ollama" });
    // The fixture leaves derive_brief jobs ahead of the batch in the queue: tick until the provider has been called once.
    while (t.calls.n < 1) expect(await t.worker.tick()).toBe(true);
    const id = t.fx.ids["src:launch-notes"];
    expect(Number(t.store.get("SELECT count(*) AS n FROM recall_chunks WHERE ref_id=? AND embedding IS NOT NULL", id)!.n)).toBe(0);
    expect(t.store.all<any>("SELECT ref_version FROM recall_chunks WHERE ref_id=?", id).every((r) => r.ref_version === 2)).toBe(true);
    await t.drain();
    const rows = t.store.all<any>("SELECT ref_version, embedding FROM recall_chunks WHERE ref_id=?", id);
    expect(rows.every((r) => r.ref_version === 2 && r.embedding !== null)).toBe(true);
    expect(t.calls.texts.flat().some((x) => x.includes("amber now"))).toBe(true);
    // Fence: the attempt is superseded during the call; its vectors are discarded, nothing is written.
    const u = batched({ before: () => { u.store.run("UPDATE jobs SET fence=fence+1 WHERE kind='embed_batch' AND status='running'"); } });
    u.brain.setBetterSearch(owner, { mode: "ollama" });
    while (u.calls.n < 1) expect(await u.worker.tick()).toBe(true);
    expect(u.calls.n).toBe(1);
    expect(u.counts().embedded).toBe(0);
  });
  it("turning it off clears every vector and queued batch; choosing again queues a fresh backfill; a changed model is a fresh choice", async () => {
    const t = batched();
    t.brain.setBetterSearch(owner, { mode: "ollama" });
    await t.drain();
    expect(t.counts().embedded).toBeGreaterThan(0);
    note(t.brain, t.fx.ids["project:northstar"], 1);
    expect(t.jobs("queued")).toHaveLength(1);
    const g = vectorGeneration();
    expect(t.brain.setBetterSearch(owner, { mode: "off" })).toEqual({ mode: "off", key: null, consented_at: null });
    expect(t.counts().embedded).toBe(0);
    expect(t.jobs("queued")).toEqual([]);
    expect(vectorGeneration()).toBeGreaterThan(g);
    expect(t.brain.betterSearch(owner)).toMatchObject({ mode: "off", effective: false, reason: "Better search is off." });
    const n = t.calls.n;
    await t.drain();
    expect(t.calls.n).toBe(n);
    t.brain.setBetterSearch(owner, { mode: "ollama" });
    expect(t.jobs("queued")).toHaveLength(1);
    expect(t.brain.betterSearch(owner).counts.pending).toBeGreaterThan(0);
    await t.drain();
    // The worker now publishes another model: the stored choice no longer applies, and nothing is queued or run until the owner chooses again.
    publishBetterSearchStatus(t.brain, { configured: true, provider: "ollama", model: "other", key: modelKey("ollama", "other"), label: "Ollama on this computer" });
    expect(t.brain.betterSearch(owner)).toMatchObject({ effective: false, reason: "The search model changed. Choose Better search again." });
    note(t.brain, t.fx.ids["project:northstar"], 2);
    expect(t.jobs("queued")).toEqual([]);
    const m = t.calls.n;
    await t.drain();
    expect(t.calls.n).toBe(m);
    expect(maybeQueueEmbedBatch(t.brain)).toBe(false);
  });
  it("a secret-shaped passage is withheld, never sent, and never blocks the rest of the batch", async () => {
    const t = batched();
    const id = t.fx.ids["src:launch-notes"];
    t.store.run("UPDATE recall_chunks SET text=? WHERE kind='original' AND ref_id=? AND ordinal=0", `api_key = ${KEY} and the launch colour is cobalt`, id);
    t.brain.setBetterSearch(owner, { mode: "ollama" });
    await t.drain();
    expect(JSON.stringify(t.calls.bodies)).not.toContain(KEY);
    expect(t.store.get<any>("SELECT embedding, embedding_model FROM recall_chunks WHERE kind='original' AND ref_id=? AND ordinal=0", id)).toEqual({ embedding: null, embedding_model: t.key });
    expect(t.counts()).toMatchObject({ pending: 0, withheld: 1 });
    expect(t.counts().embedded).toBeGreaterThan(0);
  });
  it("the self-heal check queues a batch after a rebuild; failures back off 60 s then 120 s, the third pauses everything for 15 minutes, a success resets", async () => {
    const t = batched();
    t.brain.setBetterSearch(owner, { mode: "ollama" });
    await t.drain();
    t.store.rebuildRecallIndex();
    expect(t.counts().embedded).toBe(0);
    expect(t.jobs("queued")).toEqual([]);
    expect(maybeQueueEmbedBatch(t.brain)).toBe(true);
    expect(maybeQueueEmbedBatch(t.brain)).toBe(false);
    await t.drain();
    expect(t.counts().pending).toBe(0);
    // An outage: each failed batch ends at once (no attempt loop), the next waits for the back-off, the third opens the breaker.
    t.fake.status = 503;
    t.store.rebuildRecallIndex();
    expect(maybeQueueEmbedBatch(t.brain)).toBe(true);
    await t.drain();
    expect(t.jobs().at(-1)!.status).toBe("failed");
    expect(t.calls.n).toBeGreaterThan(0);
    const afterFirst = t.calls.n;
    expect(t.brain.betterSearch(owner)).toMatchObject({ failures: 1, effective: true, paused_until: null });
    expect(t.brain.betterSearch(owner).status!.last_error).toMatch(/503/);
    expect(maybeQueueEmbedBatch(t.brain)).toBe(false);
    t.advance(59_000);
    expect(maybeQueueEmbedBatch(t.brain)).toBe(false);
    t.advance(2_000);
    expect(maybeQueueEmbedBatch(t.brain)).toBe(true);
    await t.drain();
    expect(t.calls.n).toBe(afterFirst + 1);
    expect(t.brain.betterSearch(owner).failures).toBe(2);
    t.advance(61_000);
    expect(maybeQueueEmbedBatch(t.brain)).toBe(false);
    t.advance(60_000);
    expect(maybeQueueEmbedBatch(t.brain)).toBe(true);
    await t.drain();
    const paused = t.brain.betterSearch(owner);
    expect(paused).toMatchObject({ failures: 3, effective: false, reason: "Better search paused: the service is not answering." });
    expect(paused.paused_until).not.toBeNull();
    expect(await t.brain.queryVector(owner, "launch colour")).toBeNull();
    t.advance(5 * 60_000);
    expect(maybeQueueEmbedBatch(t.brain)).toBe(false);
    t.advance(11 * 60_000);
    t.fake.status = 200;
    expect(maybeQueueEmbedBatch(t.brain)).toBe(true);
    await t.drain();
    expect(t.counts().pending).toBe(0);
    expect(t.brain.betterSearch(owner)).toMatchObject({ failures: 0, effective: true, retry_at: null, paused_until: null });
  });
  it("the choice is owner-only, outside the preferences, refused without the worker's matching setup, and its jobs stay out of the Settings job list", () => {
    const dir = mkdtempSync(join(tmpdir(), "better-search-consent-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const s = new Storage(join(dir, "brain.sqlite"));
    cleanup.push(() => s.close());
    const b = new Brain(s, () => new Date("2026-10-25T09:00:00.000Z"));
    expect(b.betterSearch(owner)).toMatchObject({ mode: "off", status: null, effective: false, counts: { total: 0, embedded: 0, pending: 0, withheld: 0 } });
    expect(() => b.setBetterSearch(owner, { mode: "ollama" })).toThrow(/background worker starts/);
    publishBetterSearchStatus(b, { configured: true, provider: "cloudflare", model: "@cf/baai/bge-m3", key: modelKey("cloudflare", "@cf/baai/bge-m3"), label: "Cloudflare" });
    expect(() => b.setBetterSearch(owner, { mode: "ollama" })).toThrow(/Ollama on this computer is not set up/);
    expect(() => b.setBetterSearch(owner, { mode: "cloudflare" })).toThrow(/background worker is not running/);
    s.set("worker_heartbeat", b.now());
    expect(() => b.setBetterSearch(owner, { mode: "cloudflare" })).toThrow(/limit/);
    b.prefs(owner, { ...b.prefs(owner), daily_cap_micro_usd: 1000, per_job_cap_micro_usd: 100 });
    expect(b.setBetterSearch(owner, { mode: "cloudflare" })).toMatchObject({ mode: "cloudflare", key: "cloudflare:@cf/baai/bge-m3:none" });
    expect(s.all("SELECT id FROM jobs WHERE kind='embed_batch' AND status='queued'")).toHaveLength(1);
    expect("better_search" in b.prefs(owner)).toBe(false);
    expect(() => b.prefs(owner, { ...b.prefs(owner) })).not.toThrow();
    expect(() => b.setBetterSearch(owner, { mode: "sideways" })).toThrow();
    const agent: Principal = b.authenticateAgent(b.createGrant(owner, { projects: ["inbox"], operations: ["read"], expires_at: "2027-01-01T00:00:00.000Z" }).token);
    expect(() => b.betterSearch(agent)).toThrow(/Owner access required/);
    expect(() => b.setBetterSearch(agent, { mode: "off" })).toThrow(/Owner access required/);
    s.run("INSERT INTO jobs(id,project_id,kind,payload,status,next_at,created_at) VALUES('e1','inbox','recall_embed','{}','succeeded',?,?)", b.now(), b.now());
    expect(b.status(owner).jobs.some((j: any) => j.kind === "embed_batch" || j.kind === "recall_embed")).toBe(false);
    expect(() => b.job(owner, "e1")).toThrow(/unavailable/);
    expect(b.setBetterSearch(owner, { mode: "off" })).toEqual({ mode: "off", key: null, consented_at: null });
  });
});
```

- [ ] Run: `npx vitest run tests/integration/embed-batch.test.ts` — expected failure: `runEmbedBatch`/`maybeQueueEmbedBatch` are not exported and `Brain.setBetterSearch` does not exist.

- [ ] Append to `apps/worker/embed.ts` (add the imports at the top of the file):

```ts
import { detectSecrets } from "../../packages/storage/secrets.ts";
import { BrainError } from "../../packages/domain/logic.ts";
import { AccountingPersistenceError } from "../../packages/storage/managed-spending.ts";
import type { Principal } from "../../packages/contracts/index.ts";
import type { DispatchRecord, DispatchSpec, JobLease, SpendLimits } from "../../packages/domain/spend.ts";
import { BETTER_SEARCH_STATUS, EMBED_BACKOFF_MAX_MS, EMBED_BATCH_SIZE, EMBED_BREAKER_FAILURES, EMBED_CALL_MS, EMBED_PAUSE_MS, EMBED_RETRY_AFTER_MS, EMBED_VISIBILITIES, embedText, modelKey, type BetterSearchStatus } from "../../packages/domain/better-search.ts";
import { pendingEmbedRows, writeEmbeddings, type VectorWrite } from "../../packages/storage/recall-vectors.ts";
import { EmbedError, prepareEmbed, type EmbedResult, type PreparedEmbed } from "../../packages/providers/embed.ts";
import type { DispatchAccounting } from "./accounting.ts";

export const EMBED_CHECK_MS = 5_000;
export type EmbedDeps = { brain: Brain; ledger: DispatchAccounting; client: EmbedClient | null; owner: Principal; leaseOwner: string };
export type EmbedJob = { id: string; fence: number };
export type EmbedOutcome = { outcome: "embedded" | "nothing" | "cancelled" | "failed"; rows: number; more: boolean; error?: string };
/** One provider call and its money. `refused` is a ledger refusal (no call, nothing to back off from); `rejected` is a 4xx (the input was refused). */
type CallOutcome = { ok: true; result: EmbedResult } | { ok: false; error: Error; rejected: boolean; refused: boolean };

/** The persisted lease, never the in-memory row; null once this attempt is no longer current. */
function currentLease(brain: Brain, job: { id: string; fence: number }, owner: string): JobLease | null {
  const row = brain.store.get<{ status: string; lease_owner: string; lease_until: string | null; fence: number }>("SELECT status,lease_owner,lease_until,fence FROM jobs WHERE id=?", job.id);
  if (!row || row.status !== "running" || row.lease_owner !== owner || row.fence !== job.fence || !row.lease_until) return null;
  return { job_id: job.id, owner, fence: job.fence, expires_at: row.lease_until };
}

/**
 * ONE provider call outside any transaction. Ollama is free; Cloudflare goes reserve, mark, call, settle under `dispatchKey`.
 * An error response with no usage settles at 0 (nothing was billed); a timeout after send keeps its hold, so a request that may
 * have gone out is never refunded.
 */
async function callProvider(deps: EmbedDeps, job: EmbedJob, client: EmbedClient, texts: string[], dispatchKey: string, signal: AbortSignal): Promise<CallOutcome> {
  const { brain, ledger, owner } = deps;
  const { config } = client;
  const failed = (error: Error, rejected = false, refused = false): CallOutcome => ({ ok: false, error, rejected, refused });
  let prepared: PreparedEmbed;
  try {
    prepared = prepareEmbed(config, texts, client.fetcher);
  } catch (error) {
    return failed(error instanceof Error ? error : new Error("Better search could not prepare a batch."));
  }
  let record: DispatchRecord | undefined;
  if (config.provider === "cloudflare") {
    const prefs = brain.prefs(owner);
    const limits: SpendLimits = { per_job_micro_usd: prefs.per_job_cap_micro_usd, daily_micro_usd: prefs.daily_cap_micro_usd, time_zone: prefs.time_zone };
    const lease = currentLease(brain, job, deps.leaseOwner);
    if (!lease) return failed(new Error("This attempt is no longer current."), false, true);
    const spec: DispatchSpec = {
      job_id: job.id,
      dispatch_key: dispatchKey,
      stage: "decision",
      reserved_micro_usd: prepared.reserved_micro_usd,
      provider: "cloudflare",
      model: prepared.model,
      price_version: prepared.price_version,
      request_hash: prepared.request_hash,
      config_hash: prepared.config_hash,
    };
    let reserved: DispatchRecord;
    try {
      reserved = ledger.reserve(spec, lease, limits);
    } catch (error) {
      return failed(new Error(error instanceof BrainError ? `Better search with Cloudflare is paused: ${error.message}` : "Better search could not reserve its spending."), false, true);
    }
    if (reserved.state !== "reserved") return failed(new Error("This batch was already sent."), false, true);
    // Consent or caps may have changed while the reserve waited on the lock: refuse before the mark, so the hold is released.
    if (signal.aborted || !brain.betterSearchAllowed().on) {
      ledger.releaseUndispatched(reserved.call_id);
      return failed(new Error("Better search was changed while this batch was being prepared."), false, true);
    }
    try {
      ledger.markDispatched(reserved.call_id, lease);
    } catch (error) {
      try {
        ledger.releaseUndispatched(reserved.call_id);
      } catch {
        /* A concurrent state change owns the record. */
      }
      throw error;
    }
    record = reserved;
    ledger.assertCanExecute?.(record.call_id, lease);
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), EMBED_CALL_MS);
  try {
    const result = await prepared.execute(controller.signal);
    if (record) ledger.settle(record.call_id, result.cost_micro_usd);
    return { ok: true, result };
  } catch (error) {
    // A known cost (0 for an error response) is settled; an unknown one keeps its hold.
    if (record && error instanceof EmbedError && error.actual_cost_micro_usd !== undefined) ledger.settle(record.call_id, error.actual_cost_micro_usd);
    const rejected = error instanceof EmbedError && error.upstream_status !== undefined && error.upstream_status >= 400 && error.upstream_status < 500;
    return failed(error instanceof Error ? error : new Error("The search model request failed."), rejected);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

/** A failed or unknown batch: exponential back-off (60 s doubling to 15 min); the third in a row opens the breaker for 15 min. */
function recordFailure(brain: Brain, message: string) {
  const current = brain.store.setting<BetterSearchStatus | null>(BETTER_SEARCH_STATUS, null);
  const failures = (current?.failures ?? 0) + 1;
  const now = brain.clock().getTime();
  const wait = Math.min(EMBED_RETRY_AFTER_MS * 2 ** (failures - 1), EMBED_BACKOFF_MAX_MS);
  noteEmbedStatus(brain, {
    last_error: message,
    failures,
    retry_at: new Date(now + wait).toISOString(),
    paused_until: failures >= EMBED_BREAKER_FAILURES ? new Date(now + EMBED_PAUSE_MS).toISOString() : undefined,
  });
}

/**
 * One batch end to end: up to 32 pending rows the provider may see, secret-shaped rows withheld, one call (a batch the
 * service refuses with a 4xx is retried row by row, and a row refused alone is withheld as rejected), then a fenced,
 * guarded write. A failed or unknown call records a failure (back-off, breaker); the job itself is never retried, because a
 * Cloudflare job cannot be re-sent under the same dispatch key. Every refusal is a plain sentence on the published status.
 */
export async function runEmbedBatch(deps: EmbedDeps, job: EmbedJob, signal: AbortSignal): Promise<EmbedOutcome> {
  const { brain, client } = deps;
  const done = (outcome: EmbedOutcome["outcome"], rows = 0, more = false, error?: string): EmbedOutcome => ({ outcome, rows, more, ...(error ? { error } : {}) });
  const fail = (message: string): EmbedOutcome => {
    recordFailure(brain, message);
    return done("failed", 0, false, message);
  };
  if (!client) return done("cancelled", 0, false, "Better search is not set up on this computer.");
  const allowed = brain.betterSearchAllowed();
  if (!allowed.on) {
    noteEmbedStatus(brain, { last_error: allowed.reason });
    return done("cancelled", 0, false, allowed.reason);
  }
  // A batch queued before a failure still waits for the back-off: no call until retry_at has passed.
  if (!brain.embedQueueOpen()) return done("cancelled", 0, false, "Better search is waiting before it tries again.");
  const { config } = client;
  const key = modelKey(config.provider, config.model);
  if (key !== allowed.setting.key) return done("cancelled", 0, false, "The search model changed. Choose Better search again.");
  const visibilities = EMBED_VISIBILITIES[config.provider];
  const rows = pendingEmbedRows(brain.store, key, visibilities, EMBED_BATCH_SIZE);
  if (!rows.length) return done("nothing");
  const texts = rows.map((r) => embedText(r.prefix, r.text));
  const send = rows.map((_, i) => i).filter((i) => detectSecrets(texts[i]).length === 0);
  const more = () => pendingEmbedRows(brain.store, key, visibilities, 1).length > 0;
  const vectors: (Float32Array | null)[] = rows.map(() => null);
  const reasons: VectorWrite["reason"][] = rows.map((_, i) => (send.includes(i) ? undefined : "secret"));
  // Written only while this attempt still holds its lease and the owner still wants it; otherwise the vectors are dropped and recomputed later.
  const write = (dim: number) =>
    brain.store.transaction(() => {
      if (!currentLease(brain, job, deps.leaseOwner) || !brain.betterSearchAllowed().on) return 0;
      return writeEmbeddings(brain.store, key, dim, rows.map((r, i) => ({ ...r, vector: vectors[i], reason: reasons[i] })));
    });
  let dim = 0;
  let rejectedCount = 0;
  try {
    if (send.length) {
      const batch = await callProvider(deps, job, client, send.map((i) => texts[i]), "embed_batch", signal);
      if (batch.ok) {
        dim = batch.result.dim;
        send.forEach((rowIndex, k) => {
          vectors[rowIndex] = batch.result.vectors[k];
        });
      } else if (batch.refused) {
        noteEmbedStatus(brain, { last_error: batch.error.message });
        return done("cancelled", 0, false, batch.error.message);
      } else if (batch.rejected && send.length > 1) {
        // The service refused the batch: one text may be the cause. Each row goes alone under its own dispatch key; a row refused alone is withheld.
        for (const i of send) {
          const one = await callProvider(deps, job, client, [texts[i]], `embed_batch:${rows[i].id}`, signal);
          if (one.ok) {
            dim = one.result.dim;
            vectors[i] = one.result.vectors[0];
          } else if (one.rejected) {
            reasons[i] = "rejected";
            rejectedCount += 1;
          } else if (one.refused) {
            noteEmbedStatus(brain, { last_error: one.error.message });
            return done("cancelled", 0, false, one.error.message);
          } else return fail(one.error.message);
        }
      } else if (batch.rejected) {
        reasons[send[0]] = "rejected";
        rejectedCount += 1;
      } else return fail(batch.error.message);
    }
    const written = write(dim);
    if (!written) return done("cancelled", 0, more());
    noteEmbedStatus(brain, {
      last_ok_at: brain.now(),
      last_error: rejectedCount ? `${rejectedCount} ${rejectedCount === 1 ? "passage was" : "passages were"} refused by the search service and will be skipped until it changes.` : undefined,
      failures: 0,
      retry_at: undefined,
      paused_until: undefined,
    });
    return done("embedded", written, more());
  } catch (error) {
    // A ledger or storage fault is a failure like any other; a persistence fault of the money journal is fatal and surfaces to the engine.
    if (error instanceof AccountingPersistenceError) throw error;
    return fail(error instanceof Error ? error.message : "Better search failed.");
  }
}

/** The engine's 5-second self-heal: rows without a current vector (after a rebuild, an import or a crash) get a batch, unless one is active, the back-off is running or the breaker is open. */
export function maybeQueueEmbedBatch(brain: Brain): boolean {
  if (!brain.embedQueueOpen()) return false;
  const { setting } = brain.betterSearchAllowed();
  if (!setting.key || setting.mode === "off") return false;
  if (!pendingEmbedRows(brain.store, setting.key, EMBED_VISIBILITIES[setting.mode], 1).length) return false;
  return brain.enqueueEmbedBatch() !== null;
}
```
  Imports for this block (replace the import list given above the code): `detectSecrets`, `BrainError`, `AccountingPersistenceError` (`../../packages/storage/managed-spending.ts`, an import only, no managed source is edited), `Principal`, `DispatchRecord, DispatchSpec, JobLease, SpendLimits`, `BETTER_SEARCH_STATUS, EMBED_BACKOFF_MAX_MS, EMBED_BATCH_SIZE, EMBED_BREAKER_FAILURES, EMBED_CALL_MS, EMBED_PAUSE_MS, EMBED_RETRY_AFTER_MS, EMBED_VISIBILITIES, embedText, modelKey, type BetterSearchStatus` (from `better-search.ts`; `EMBED_BACKOFF_MAX_MS = 900_000`, `EMBED_BREAKER_FAILURES = 3` and `EMBED_PAUSE_MS = 900_000` are added to task 1's constants in the same task), `pendingEmbedRows, writeEmbeddings, type VectorWrite`, `EmbedError, prepareEmbed, type EmbedResult, type PreparedEmbed`, `DispatchAccounting`.

- [ ] Modify `apps/worker/engine.ts`:
  - Imports: `import { EMBED_CHECK_MS, maybeQueueEmbedBatch, runEmbedBatch, type EmbedClient } from "./embed.ts";`
  - Constructor (lines 66–68): after `private readonly systemOne: SystemOneClient | null = null,` add `/** Better search. Null (the default) means it is not configured on this computer. */ private readonly embed: EmbedClient | null = null,`. Add the field `private lastEmbedCheck = 0;` beside `private readonly decisionProvider?`.
  - `schedule()` (line 157, right after `b.store.set("worker_heartbeat", b.now());`): add
    ```ts
    // Better search self-heal: rows without a current vector get a batch; throttled so a quiet worker costs one small query every 5 s.
    if (this.embed && Date.now() - this.lastEmbedCheck > EMBED_CHECK_MS) {
      this.lastEmbedCheck = Date.now();
      try {
        maybeQueueEmbedBatch(b);
      } catch {
        /* The next tick retries; a failed check must not stop scheduling. */
      }
    }
    ```
  - `tick()` right after the `system_one_route` branch (`return true;` at line 278, closing brace at 279) and before `const prefs = b.prefs(this.owner);` add:
    ```ts
    // Better search indexing: its own outcome handling, no receipt. The job is never retried here: retries are the
    // worker's back-off plus the self-heal check, and a Cloudflare job cannot be re-sent under the same dispatch key.
    if (j.kind === "embed_batch") {
      const r = await runEmbedBatch({ brain: b, ledger: this.accounting, client: this.embed, owner: this.owner, leaseOwner: this.id }, j as { id: string; fence: number }, controller.signal);
      b.store.run(
        "UPDATE jobs SET status=?,error=?,lease_until=NULL WHERE id=? AND fence=?",
        r.outcome === "failed" ? "failed" : r.outcome === "cancelled" ? "cancelled" : "succeeded",
        r.error ?? null,
        j.id,
        j.fence,
      );
      if (r.more) b.enqueueEmbedBatch();
      return true;
    }
    ```
    `runEmbedBatch` catches its own faults (only `AccountingPersistenceError` escapes, which the engine's existing catch re-throws), so an indexing job never writes a failed receipt into Today. `tick()` reports work even when the batch was cancelled; the loop sleeps only on a false.

- [ ] Modify `apps/worker/main.ts` (local branch): add imports `import { embedFromEnv } from "../../packages/providers/embed-env.ts";` and `import { publishBetterSearchStatus } from "./embed.ts";`. After the `publishSystemOneStatus(...)` call (lines 495–500) add:
  ```ts
  // Better search is read from the worker's environment only; the published status carries the model key and a label, never a credential.
  const embed = embedFromEnv(process.env);
  publishBetterSearchStatus(
    brain,
    embed.config ? { configured: true, provider: embed.config.provider, model: embed.config.model, key: embed.key, label: embed.label } : { configured: false, reason: embed.reason },
  );
  ```
  and pass the sixth argument: `new Worker(brain, undefined, undefined, undefined, sorting.config ? { config: sorting.config } : null, embed.config ? { config: embed.config } : null)`.

- [ ] Modify `packages/domain/service.ts`:
  - After line 14 add `import { clearEmbeddings, countEmbedRows } from "../storage/recall-vectors.ts";` and after line 52 add `import { BETTER_SEARCH, BETTER_SEARCH_OFF, BETTER_SEARCH_PAUSED, BETTER_SEARCH_STATUS, EMBED_VISIBILITIES, betterSearchEffective, type BetterSearchSetting, type BetterSearchStatus } from "./better-search.ts";`.
  - `createEntity` (line 482): `if (kind === "claim") { syncClaim(this.store, id); this.queueEmbedIfOn(); }`. `revise` (line 507): the same shape with `e.id`.
  - `capture` (line 643): after `syncSource(this.store, id);` add `this.queueEmbedIfOn();`. `editSourceTx` (line 1123): after the `syncClaimsCiting` line add `this.queueEmbedIfOn();`.
  - After `setRecallHelp` (closing brace at line 1899) add:

```ts
  /** The stored better-search choice. Its own setting, never a preference field: managed code round-trips `prefs()` into a strict schema. */
  betterSearchSetting(): BetterSearchSetting {
    const raw = this.store.setting<Partial<BetterSearchSetting> | null>(BETTER_SEARCH, null);
    if (!raw || (raw.mode !== "ollama" && raw.mode !== "cloudflare") || typeof raw.key !== "string") return BETTER_SEARCH_OFF;
    return { mode: raw.mode, key: raw.key, consented_at: typeof raw.consented_at === "string" ? raw.consented_at : null };
  }
  /** The one effectiveness read the server's query lane and the worker's loops share: consent, the worker's published setup, its heartbeat, and for Cloudflare both limits. */
  betterSearchAllowed(): { on: boolean; reason: string; setting: BetterSearchSetting; status: BetterSearchStatus | null } {
    const setting = this.betterSearchSetting();
    const status = this.store.setting<BetterSearchStatus | null>(BETTER_SEARCH_STATUS, null);
    if (this.tenantId !== undefined) return { on: false, reason: "Better search runs on the local app only.", setting, status };
    const effective = betterSearchEffective(setting, status, workerRunning(this.store.setting<string | null>("worker_heartbeat", null), this.clock()));
    if (!effective.on) return { ...effective, setting, status };
    // The worker's circuit breaker: after three failed batches nothing is embedded or queried for 15 minutes.
    if (status?.paused_until && Date.parse(status.paused_until) > this.clock().getTime()) return { on: false, reason: BETTER_SEARCH_PAUSED, setting, status };
    if (setting.mode === "cloudflare") {
      const prefs = this.prefs(this.ownerPrincipal());
      if (!(prefs.daily_cap_micro_usd > 0) || !(prefs.per_job_cap_micro_usd > 0))
        return { on: false, reason: "Better search with Cloudflare needs a daily limit and a per-preparation limit above $0 in Background help & spending.", setting, status };
    }
    return { on: true, reason: "ready", setting, status };
  }
  /** What the Settings card reads: the choice, what the worker published (never a credential), whether it works right now, and how far the preparation is. */
  betterSearch(p: Principal) {
    this.owner(p);
    const allowed = this.betterSearchAllowed();
    const { setting, status } = allowed;
    const prefs = this.prefs(p);
    const caps_ok = prefs.daily_cap_micro_usd > 0 && prefs.per_job_cap_micro_usd > 0;
    const counts = setting.mode !== "off" && setting.key ? countEmbedRows(this.store, setting.key, EMBED_VISIBILITIES[setting.mode]) : { total: 0, embedded: 0, pending: 0, withheld: 0 };
    return {
      mode: setting.mode,
      key: setting.key,
      consented_at: setting.consented_at,
      status: status
        ? { configured: status.configured, provider: status.provider ?? null, label: status.label ?? null, reason: status.reason ?? null, key: status.key ?? null, last_error: status.last_error ?? null, last_ok_at: status.last_ok_at ?? null }
        : null,
      effective: allowed.on,
      reason: allowed.reason,
      worker_running: workerRunning(this.store.setting<string | null>("worker_heartbeat", null), this.clock()),
      caps_ok,
      counts,
      failures: status?.failures ?? 0,
      retry_at: status?.retry_at ?? null,
      paused_until: status?.paused_until && Date.parse(status.paused_until) > this.clock().getTime() ? status.paused_until : null,
    };
  }
  /** Off is always accepted and clears every vector. A provider needs the worker's published setup for exactly that provider and a running worker; Cloudflare also needs both limits. Any change of provider or model is a fresh choice. */
  setBetterSearch(p: Principal, input: unknown): BetterSearchSetting {
    this.owner(p);
    const v = z.object({ mode: z.enum(["off", "ollama", "cloudflare"]) }).strict().parse(input);
    const previous = this.betterSearchSetting();
    if (v.mode === "off")
      return this.store.transaction(() => {
        this.store.set(BETTER_SEARCH, BETTER_SEARCH_OFF);
        clearEmbeddings(this.store);
        this.store.run("UPDATE jobs SET status='cancelled',fence=fence+1,lease_until=NULL WHERE kind IN ('embed_batch','recall_embed') AND status IN ('queued','retry_wait')");
        return BETTER_SEARCH_OFF;
      });
    if (this.tenantId !== undefined) throw new BrainError("BUDGET_BLOCKED", "Better search runs on the local app only.", 409);
    const status = this.store.setting<BetterSearchStatus | null>(BETTER_SEARCH_STATUS, null);
    const probe = betterSearchEffective({ mode: v.mode, key: status?.key ?? null, consented_at: null }, status, workerRunning(this.store.setting<string | null>("worker_heartbeat", null), this.clock()));
    if (!probe.on || !status?.key) throw new BrainError("BUDGET_BLOCKED", probe.reason, 409);
    if (v.mode === "cloudflare") {
      const prefs = this.prefs(p);
      if (!(prefs.daily_cap_micro_usd > 0) || !(prefs.per_job_cap_micro_usd > 0))
        throw new BrainError("BUDGET_BLOCKED", "Better search with Cloudflare needs a daily limit and a per-preparation limit above $0 in Background help & spending.", 409);
    }
    const next: BetterSearchSetting = { mode: v.mode, key: status.key, consented_at: this.now() };
    return this.store.transaction(() => {
      if (previous.mode !== next.mode || previous.key !== next.key) clearEmbeddings(this.store);
      this.store.set(BETTER_SEARCH, next);
      this.enqueueEmbedBatch();
      return next;
    });
  }
  /** One batch at a time: a queued, waiting or running batch is enough, and a batch re-queues itself while rows remain. */
  enqueueEmbedBatch(): string | null {
    if (this.store.get("SELECT 1 FROM jobs WHERE kind='embed_batch' AND status IN ('queued','retry_wait','running') LIMIT 1")) return null;
    return this.enqueue("inbox", "embed_batch", { principal: this.ownerPrincipal() }).id;
  }
  /** Whether a batch may be queued or run now: better search can run (chosen, published, worker up, not paused, limits for Cloudflare) and the worker's back-off has passed. Read by the capture hooks, the self-heal check and the batch itself. */
  embedQueueOpen(): boolean {
    const allowed = this.betterSearchAllowed();
    if (!allowed.on) return false;
    const retryAt = allowed.status?.retry_at;
    return !(retryAt && Date.parse(retryAt) > this.clock().getTime());
  }
  /** Every index write path calls this: a batch is queued only while one may run; otherwise the self-heal check picks the rows up later. */
  private queueEmbedIfOn() {
    if (this.betterSearchSetting().mode !== "off" && this.embedQueueOpen()) this.enqueueEmbedBatch();
  }
```
  - Also call `this.queueEmbedIfOn();` after the `syncSource(this.store, sourceId);` in `recordSystemOneResult` (line 4567): sorting help re-syncs the note's rows, which drops their vectors.
  - The local Settings job list only (line 5110, in the non-managed branch): `WHERE kind NOT IN ('recall_judge','embed_batch','recall_embed')`; the managed branch at line 5052 is left untouched (a tenant brain never holds these rows). `job()` (line 5115–5117): `if (!j || j.kind === "recall_judge" || j.kind === "embed_batch" || j.kind === "recall_embed") throw ...` and reword its comment to "Judge and better-search rows belong to the worker alone".

- [ ] Run: `npx vitest run tests/integration/embed-batch.test.ts tests/integration/recall-judge.test.ts tests/integration/system-one-worker.test.ts tests/integration/brain.test.ts tests/integration/operations.test.ts` — expected: all pass. In the fence case the engine's `WHERE fence=?` update matches nothing and the row stays `running` until lease recovery; the assertion is `embedded === 0` after exactly one call. The outage test relies on `betterSearch().failures`, `retry_at` and `paused_until`, on `maybeQueueEmbedBatch` honouring both, and on the Cloudflare 503 hold being settled at 0.
- [ ] Run: `npm run typecheck && npm run lint` — expected exit 0.
- [ ] Commit: `git add apps/worker/embed.ts apps/worker/engine.ts apps/worker/main.ts packages/domain/service.ts tests/integration/embed-batch.test.ts` with message:

```
feat(search): embed_batch worker job, better_search setting and backfill

Batches of 32 rows embedded outside any transaction with a fenced,
guarded write; Cloudflare spend through the dispatch ledger; private,
owner-only and quarantined rows never leave the machine; the choice is
its own owner-only setting that clears vectors on any change.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
```

---

### Task 4: `recall_embed` query fast lane (worker loop, server wait, cache, sweep)

**Size:** M–L (Sonnet). Mirrors `apps/worker/recall-judge.ts` and `Brain.awaitRecallJudge`.

**Files:**
- Create: `apps/worker/recall-embed.ts`
- Modify: `apps/worker/engine.ts` (`lease()` line 116: `kind<>'recall_judge'` → `kind NOT IN ('recall_judge','recall_embed')`; `schedule()` lines 159 and 163: same replacement)
- Modify: `apps/worker/main.ts` (start the lane beside the judge after line 517; stop it after `await judge?.stop()` line 533)
- Modify: `packages/domain/service.ts` (imports; `queryVector` and `awaitQueryVector` after `awaitRecallJudge`, closing brace line 3623)
- Test: `tests/integration/recall-embed-lane.test.ts`
- Existing tests to run: `tests/integration/recall-judge.test.ts`, `tests/integration/worker-dispatch.test.ts` (the lease SQL change).

**Interfaces:**
- Consumes: `prepareEmbed`, `EmbedError` (task 1); `EmbedClient`, `noteEmbedStatus` (tasks 1/3); `Brain.betterSearchAllowed` (task 3); `DispatchAccounting`; `EMBED_STATE_KEY`, `EMBED_RESULT_KEY`, `QUERY_CACHE_MS`, `EMBED_LOOP_MS`, `EMBED_SWEEP_AFTER_MS`, `EMBED_CALL_MS`, `vectorToBase64`, `vectorFromBase64`, `modelKey`, `QueryVector` (task 1); `hash` (`packages/domain/logic.ts`, already imported in service.ts).
- Produces (`apps/worker/recall-embed.ts`):
  - `export type QueryEmbedDeps = { brain: Brain; ledger: DispatchAccounting; client: EmbedClient; owner: Principal; workerId: string }`
  - `export const QUERY_MIN_LEFT_MS = 50;`
  - `export async function runQueryEmbedOnce(deps: QueryEmbedDeps, cache: Map<string, { key: string; dim: number; vector: Float32Array; at: number }>): Promise<boolean>`
  - `export function sweepEmbedRows(brain: Brain): void` (past-deadline queued/running rows cancelled; finished `recall_embed` rows older than an hour that no `provider_dispatches` row references deleted; orphan state/result keys deleted)
  - `export function startEmbedLoop(deps: QueryEmbedDeps): { stop(): Promise<void> }`
- Produces (`packages/domain/service.ts`):
  - `async queryVector(p: Principal, query: string): Promise<QueryVector | null>` (null fast when off, not effective, secret-shaped or empty; otherwise one `recall_embed` job with a 400 ms deadline and the query under `recall_embed:<id>`; result validated against the consented key and dim bounds)
  - `private async awaitQueryVector(requestId: string, deadlineMs: number, key: string): Promise<QueryVector | null>`

**Steps:**

- [ ] Write the failing test `tests/integration/recall-embed-lane.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Brain } from "../../packages/domain/service.ts";
import { LocalDispatchAccounting } from "../../apps/worker/accounting.ts";
import { publishBetterSearchStatus } from "../../apps/worker/embed.ts";
import { runQueryEmbedOnce, sweepEmbedRows, type QueryEmbedDeps } from "../../apps/worker/recall-embed.ts";
import { embedFromEnv } from "../../packages/providers/embed-env.ts";
import { modelKey, type EmbedProvider } from "../../packages/domain/better-search.ts";
import { FAKE_EMBED_DIM, FAKE_EMBED_MODEL, cosine, fakeEmbed, fakeEmbedFetcher } from "../helpers/fake-embed.mjs";
import { buildFixture, owner, type Fixture } from "../eval/recall-fixture.ts";
import type { Principal } from "../../packages/contracts/index.ts";

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.reverse()) fn();
  cleanup = [];
});
const KEY = ["sk", "test", "never", "a", "real", "key", "0123456789abcdef"].join("-");
function lane(opts: { provider?: EmbedProvider; delayMs?: number; on?: boolean } = {}) {
  const provider = opts.provider ?? "ollama";
  const dir = mkdtempSync(join(tmpdir(), "recall-embed-lane-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const fx: Fixture = buildFixture(join(dir, "fixture.sqlite"));
  cleanup.push(() => fx.store.close());
  const time = { now: new Date("2026-10-25T09:00:00.000Z") };
  const brain = new Brain(fx.store, () => time.now);
  const model = provider === "ollama" ? FAKE_EMBED_MODEL : "@cf/baai/bge-m3";
  const env = embedFromEnv({ BRAIN_EMBED_PROVIDER: provider, BRAIN_EMBED_MODEL: model, BRAIN_EMBED_ENDPOINT: provider === "ollama" ? "http://127.0.0.1:9/api/embed" : "http://127.0.0.1:9/client/v4/accounts/test/ai/run/@cf/baai/bge-m3" });
  if (!env.config) throw new Error(env.reason);
  const key = modelKey(provider, model);
  publishBetterSearchStatus(brain, { configured: true, provider, model, key, label: env.label });
  brain.store.set("worker_heartbeat", brain.now());
  brain.prefs(owner, { ...brain.prefs(owner), daily_cap_micro_usd: 50_000, per_job_cap_micro_usd: 5_000 });
  if (opts.on !== false) brain.setBetterSearch(owner, { mode: provider });
  const fake = { shape: provider, delayMs: opts.delayMs, status: 200 as number };
  const { fetcher, calls } = fakeEmbedFetcher(fake);
  const deps: QueryEmbedDeps = { brain, ledger: new LocalDispatchAccounting(fx.store, () => time.now), client: { config: env.config, fetcher }, owner, workerId: "worker-test" };
  const cache = new Map();
  const agent: Principal = brain.authenticateAgent(fx.agentToken);
  /** The recall and, in parallel, worker passes every 20 ms until the work settles (the loop stand-in). */
  const withWorker = async <T>(work: () => Promise<T>) => {
    let running = true;
    const pump = (async () => {
      while (running) {
        await runQueryEmbedOnce(deps, cache);
        await new Promise((r) => setTimeout(r, 20));
      }
    })();
    try {
      return await work();
    } finally {
      running = false;
      await pump;
    }
  };
  const embedJobs = () => fx.store.all<{ id: string; status: string }>("SELECT id,status FROM jobs WHERE kind='recall_embed' ORDER BY created_at");
  const keys = () => fx.store.all<{ key: string; value: string }>("SELECT key,value FROM settings WHERE key LIKE 'recall_embed%'");
  return { fx, brain, store: fx.store, agent, deps, cache, calls, fake, key, time, withWorker, embedJobs, keys };
}

describe("the query embedding fast lane", () => {
  it("answers an agent's query vector through lease, one call and a published result, leaving no query text behind", async () => {
    const t = lane();
    const out = await t.withWorker(() => t.brain.queryVector(t.agent, "which hue was chosen for the release"));
    expect(out).not.toBeNull();
    expect(out!.key).toBe(t.key);
    expect(out!.dim).toBe(FAKE_EMBED_DIM);
    expect(cosine([...out!.vector], fakeEmbed("which hue was chosen for the release"))).toBeGreaterThan(0.999);
    expect(t.calls.n).toBe(1);
    expect(t.calls.texts[0]).toEqual(["which hue was chosen for the release"]);
    expect(t.embedJobs()).toEqual([{ id: expect.any(String), status: "succeeded" }]);
    expect(t.keys()).toEqual([]);
    expect(t.store.all("SELECT 1 FROM provider_dispatches")).toEqual([]);
  });
  it("falls back to words only at the 400 ms deadline when no worker answers, cancelling the job and deleting its query text", async () => {
    const t = lane();
    const started = Date.now();
    const out = await t.brain.queryVector(owner, "when does the stand-up happen");
    const elapsed = Date.now() - started;
    expect(out).toBeNull();
    expect(elapsed).toBeGreaterThanOrEqual(380);
    expect(elapsed).toBeLessThan(800);
    expect(t.embedJobs()).toEqual([{ id: expect.any(String), status: "cancelled" }]);
    expect(t.keys()).toEqual([]);
    expect(await runQueryEmbedOnce(t.deps, t.cache)).toBe(false);
    expect(t.calls.n).toBe(0);
  });
  it("serves a repeated question from the worker cache, and a late answer is cached for the next identical question", async () => {
    const t = lane();
    await t.withWorker(() => t.brain.queryVector(owner, "monthly fee"));
    await t.withWorker(() => t.brain.queryVector(owner, "monthly fee"));
    expect(t.calls.n).toBe(1);
    expect(t.embedJobs().map((j) => j.status)).toEqual(["succeeded", "succeeded"]);
    const slow = lane({ delayMs: 600 });
    const first = await slow.withWorker(() => slow.brain.queryVector(owner, "food supplier for the celebration"));
    expect(first).toBeNull();
    // The worker's call was still out when the server gave up; its answer feeds the cache. (On the test's fixed clock the worker still
    // sees the deadline ahead and publishes a result nobody reads; the real clock has passed it, and the sweeper deletes it either way.)
    expect(slow.store.all("SELECT key FROM settings WHERE key LIKE 'recall_embed:%'")).toEqual([]);
    expect(slow.cache.size).toBe(1);
    slow.fake.delayMs = 0;
    const second = await slow.withWorker(() => slow.brain.queryVector(owner, "food supplier for the celebration"));
    expect(second).not.toBeNull();
    expect(slow.calls.n).toBe(1);
  });
  it("queues nothing when Better search is off, not effective, the worker is stale, the query is empty or looks like a secret", async () => {
    for (const setup of [
      () => lane({ on: false }),
      () => {
        const t = lane();
        publishBetterSearchStatus(t.brain, { configured: true, provider: "ollama", model: "other", key: modelKey("ollama", "other"), label: "Ollama on this computer" });
        return t;
      },
      () => {
        const t = lane();
        t.store.set("worker_heartbeat", "2026-10-25T08:00:00.000Z");
        return t;
      },
    ]) {
      const t = setup();
      const started = Date.now();
      expect(await t.brain.queryVector(owner, "launch colour")).toBeNull();
      expect(Date.now() - started).toBeLessThan(100);
      expect(t.embedJobs()).toEqual([]);
      cleanup.reverse().forEach((fn) => fn());
      cleanup = [];
    }
    const t = lane();
    expect(await t.brain.queryVector(owner, "   ")).toBeNull();
    expect(await t.brain.queryVector(owner, `api_key = ${KEY} launch colour`)).toBeNull();
    expect(t.embedJobs()).toEqual([]);
    expect(t.calls.n).toBe(0);
  });
  it("Cloudflare query embedding goes through reserve, mark, call and settle under dispatch_key recall_embed, and never pays for a job about to expire", async () => {
    const t = lane({ provider: "cloudflare" });
    const out = await t.withWorker(() => t.brain.queryVector(t.agent, "மாத விலை எவ்வளவு"));
    expect(out).not.toBeNull();
    const [row] = t.store.all<any>("SELECT dispatch_key,state,provider,actual_micro_usd FROM provider_dispatches");
    expect(row).toMatchObject({ dispatch_key: "recall_embed", state: "settled", provider: "cloudflare" });
    expect(row.actual_micro_usd).toBeGreaterThan(0);
    expect(JSON.stringify(t.calls.bodies)).not.toContain(KEY);
    // A job with less than 50 ms left is cancelled without a call or a hold.
    const id = "late-job";
    t.store.run("INSERT INTO jobs(id,project_id,kind,payload,status,max_attempts,next_at,created_at,deadline_at) VALUES(?,?,?,?,?,?,?,?,?)", id, "inbox", "recall_embed", JSON.stringify({ request_id: id, request_hash: "h" }), "queued", 1, t.brain.now(), t.brain.now(), new Date(t.time.now.getTime() + 20).toISOString());
    t.store.set(`recall_embed:${id}`, { query: "late question", request_hash: "h", created_at: t.brain.now() });
    expect(await runQueryEmbedOnce(t.deps, t.cache)).toBe(true);
    expect(t.calls.n).toBe(1);
    expect(t.store.all("SELECT 1 FROM provider_dispatches")).toHaveLength(1);
    expect(t.store.get<any>("SELECT status FROM jobs WHERE id=?", id)!.status).toBe("cancelled");
    expect(t.keys()).toEqual([]);
  });
  it("the sweeper cancels stale rows, deletes orphan keys, and removes old unreferenced rows", () => {
    const t = lane();
    const mk = (id: string, status: string, createdAt: string, deadline: string) =>
      t.store.run("INSERT INTO jobs(id,project_id,kind,payload,status,max_attempts,next_at,created_at,deadline_at) VALUES(?,?,?,?,?,?,?,?,?)", id, "inbox", "recall_embed", "{}", status, 1, createdAt, createdAt, deadline);
    mk("stale", "queued", "2026-10-25T08:59:00.000Z", "2026-10-25T08:59:01.000Z");
    mk("old", "succeeded", "2026-10-25T07:00:00.000Z", "2026-10-25T07:00:01.000Z");
    mk("fresh", "queued", t.brain.now(), new Date(t.time.now.getTime() + 400).toISOString());
    t.store.set("recall_embed:stale", { query: "gone", request_hash: "x", created_at: "2026-10-25T08:59:00.000Z" });
    t.store.set("recall_embed_result:old", { key: t.key, dim: 1, vector: "AACAPw==", at: "2026-10-25T07:00:00.000Z" });
    t.store.set("recall_embed:fresh", { query: "kept", request_hash: "y", created_at: t.brain.now() });
    sweepEmbedRows(t.brain);
    expect(t.store.get<any>("SELECT status FROM jobs WHERE id='stale'")!.status).toBe("cancelled");
    expect(t.store.get("SELECT 1 FROM jobs WHERE id='old'")).toBeUndefined();
    expect(t.store.get<any>("SELECT status FROM jobs WHERE id='fresh'")!.status).toBe("queued");
    expect(t.keys().map((k) => k.key)).toEqual(["recall_embed:fresh"]);
  });
});
```

- [ ] Run: `npx vitest run tests/integration/recall-embed-lane.test.ts` — expected failure: `Cannot find module '../../apps/worker/recall-embed.ts'`.

- [ ] Create `apps/worker/recall-embed.ts`:

```ts
import type { Brain } from "../../packages/domain/service.ts";
import type { Principal } from "../../packages/contracts/index.ts";
import type { DispatchRecord, DispatchSpec, JobLease, SpendLimits } from "../../packages/domain/spend.ts";
import { EMBED_CALL_MS, EMBED_LOOP_MS, EMBED_RESULT_KEY, EMBED_STATE_KEY, EMBED_SWEEP_AFTER_MS, QUERY_CACHE_MS, modelKey, vectorToBase64 } from "../../packages/domain/better-search.ts";
import { EmbedError, prepareEmbed, type PreparedEmbed } from "../../packages/providers/embed.ts";
import type { DispatchAccounting } from "./accounting.ts";
import { noteEmbedStatus, type EmbedClient } from "./embed.ts";

/**
 * The query fast lane: a dedicated loop over `jobs` rows of kind `recall_embed`, the judge's shape.
 * Ollama answers free; Cloudflare goes through reserve, mark, one call outside any transaction, settle.
 * The result (model key, dim, base64 vector) goes to a settings key the server polls; the server
 * re-authorizes every dense hit itself. The cache holds vectors by request hash only, never text.
 */
export type QueryEmbedDeps = { brain: Brain; ledger: DispatchAccounting; client: EmbedClient; owner: Principal; workerId: string };
type EmbedJob = { id: string; fence: number; deadline_at: string; payload: { request_id: string; request_hash: string } };
type Entry = { key: string; dim: number; vector: Float32Array; at: number };
type Cache = Map<string, Entry>;
const QUERY_LEASE_MS = 10_000;
/** A Cloudflare job with less time than this before its deadline is never paid for; an Ollama job still runs, because its answer feeds the cache for free. */
export const QUERY_MIN_LEFT_MS = 50;
const SWEEP_EVERY_MS = Math.floor(EMBED_SWEEP_AFTER_MS / 4);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.floor(ms)));

function leaseQuery(brain: Brain, owner: string): EmbedJob | undefined {
  return brain.store.transaction(() => {
    const now = brain.now();
    const row = brain.store.get<{ id: string; fence: number; deadline_at: string; payload: string }>(
      "SELECT id,fence,deadline_at,payload FROM jobs WHERE kind='recall_embed' AND status='queued' AND deadline_at>? ORDER BY created_at LIMIT 1",
      now,
    );
    if (!row) return undefined;
    const fence = row.fence + 1;
    brain.store.run(
      "UPDATE jobs SET status='running',lease_owner=?,lease_until=?,attempts=attempts+1,fence=? WHERE id=? AND status='queued'",
      owner,
      new Date(brain.clock().getTime() + QUERY_LEASE_MS).toISOString(),
      fence,
      row.id,
    );
    return { id: row.id, fence, deadline_at: row.deadline_at, payload: JSON.parse(row.payload) };
  });
}

/** Ends the attempt (only while this lease's fence still holds) and always deletes the state, which holds the query text. */
function finishJob(brain: Brain, job: EmbedJob, status: "succeeded" | "cancelled" | "failed") {
  brain.store.run("UPDATE jobs SET status=?,lease_until=NULL WHERE id=? AND fence=?", status, job.id, job.fence);
  brain.store.run("DELETE FROM settings WHERE key=?", EMBED_STATE_KEY(job.payload.request_id));
}

export async function runQueryEmbedOnce(deps: QueryEmbedDeps, cache: Cache): Promise<boolean> {
  const { brain, ledger, client, owner } = deps;
  const leaseOwner = `${deps.workerId}:embed`;
  const job = leaseQuery(brain, leaseOwner);
  if (!job) return false;
  let record: DispatchRecord | undefined;
  try {
    const allowed = brain.betterSearchAllowed();
    if (!allowed.on) return finishJob(brain, job, "cancelled"), true;
    const key = modelKey(client.config.provider, client.config.model);
    if (key !== allowed.setting.key) return finishJob(brain, job, "cancelled"), true;
    const stored = brain.store.setting<{ query: string; request_hash: string } | null>(EMBED_STATE_KEY(job.payload.request_id), null);
    if (!stored || typeof stored.query !== "string" || !stored.query.trim()) return finishJob(brain, job, "cancelled"), true;
    // The result is written only while this attempt is still current and the server is still waiting; otherwise nothing is left behind.
    const publish = (entry: Entry) =>
      brain.store.transaction(() => {
        const done = brain.store.run("UPDATE jobs SET status='succeeded',lease_until=NULL WHERE id=? AND fence=? AND status='running'", job.id, job.fence).changes;
        if (done && Date.parse(job.deadline_at) > brain.clock().getTime()) brain.store.set(EMBED_RESULT_KEY(job.payload.request_id), { key: entry.key, dim: entry.dim, vector: vectorToBase64(entry.vector), at: brain.now() });
        else brain.store.run("DELETE FROM settings WHERE key=?", EMBED_RESULT_KEY(job.payload.request_id));
        brain.store.run("DELETE FROM settings WHERE key=?", EMBED_STATE_KEY(job.payload.request_id));
      });
    const timeLeft = () => Date.parse(job.deadline_at) - brain.clock().getTime() >= QUERY_MIN_LEFT_MS;
    const cached = cache.get(stored.request_hash);
    if (cached && Date.now() - cached.at < QUERY_CACHE_MS && cached.key === key) return publish(cached), true;
    if (cached) cache.delete(stored.request_hash);
    let prepared: PreparedEmbed;
    try {
      prepared = prepareEmbed(client.config, [stored.query], client.fetcher);
    } catch (error) {
      if (error instanceof EmbedError && !error.dispatched) return finishJob(brain, job, "cancelled"), true;
      throw error;
    }
    if (client.config.provider === "cloudflare") {
      if (!timeLeft()) return finishJob(brain, job, "cancelled"), true;
      const prefs = brain.prefs(owner);
      const limits: SpendLimits = { per_job_micro_usd: prefs.per_job_cap_micro_usd, daily_micro_usd: prefs.daily_cap_micro_usd, time_zone: prefs.time_zone };
      const row = brain.store.get<{ lease_until: string | null }>(
        "SELECT lease_until FROM jobs WHERE id=? AND status='running' AND lease_owner=? AND fence=? AND deadline_at>=?",
        job.id,
        leaseOwner,
        job.fence,
        new Date(brain.clock().getTime() + QUERY_MIN_LEFT_MS).toISOString(),
      );
      if (!row?.lease_until) return finishJob(brain, job, "cancelled"), true;
      const lease: JobLease = { job_id: job.id, owner: leaseOwner, fence: job.fence, expires_at: row.lease_until };
      const spec: DispatchSpec = {
        job_id: job.id,
        dispatch_key: "recall_embed",
        stage: "decision",
        reserved_micro_usd: prepared.reserved_micro_usd,
        provider: "cloudflare",
        model: prepared.model,
        price_version: prepared.price_version,
        request_hash: prepared.request_hash,
        config_hash: prepared.config_hash,
      };
      let reserved: DispatchRecord;
      try {
        reserved = ledger.reserve(spec, lease, limits);
      } catch {
        return finishJob(brain, job, "cancelled"), true;
      }
      if (reserved.state !== "reserved") return finishJob(brain, job, "cancelled"), true;
      if (!brain.betterSearchAllowed().on || !timeLeft()) {
        ledger.releaseUndispatched(reserved.call_id);
        return finishJob(brain, job, "cancelled"), true;
      }
      try {
        ledger.markDispatched(reserved.call_id, lease);
      } catch (error) {
        try {
          ledger.releaseUndispatched(reserved.call_id);
        } catch {
          /* A concurrent state change owns the record. */
        }
        throw error;
      }
      record = reserved;
      ledger.assertCanExecute?.(record.call_id, lease);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EMBED_CALL_MS);
    try {
      const result = await prepared.execute(controller.signal);
      if (record) ledger.settle(record.call_id, result.cost_micro_usd);
      const entry: Entry = { key, dim: result.dim, vector: result.vectors[0], at: Date.now() };
      cache.set(stored.request_hash, entry);
      publish(entry);
      noteEmbedStatus(brain, { last_ok_at: brain.now(), last_error: undefined });
    } catch (error) {
      if (record && error instanceof EmbedError && error.actual_cost_micro_usd !== undefined) ledger.settle(record.call_id, error.actual_cost_micro_usd);
      noteEmbedStatus(brain, { last_error: error instanceof Error ? error.message : "The search model request failed." });
      finishJob(brain, job, "failed");
    } finally {
      clearTimeout(timer);
    }
    return true;
  } catch {
    try {
      finishJob(brain, job, "failed");
    } catch {
      /* Storage is unavailable; the sweeper cancels the row later. */
    }
    return true;
  }
}

/** Past-deadline rows become cancelled; finished rows older than an hour that no ledger row references are deleted; orphan keys are deleted. */
export function sweepEmbedRows(brain: Brain) {
  const now = brain.now();
  const cutoff = new Date(brain.clock().getTime() - EMBED_SWEEP_AFTER_MS).toISOString();
  brain.store.run(
    "UPDATE jobs SET status='cancelled',fence=fence+1,lease_until=NULL WHERE kind='recall_embed' AND status IN ('queued','running') AND deadline_at<=? AND (status='queued' OR lease_until IS NULL OR lease_until<=?)",
    now,
    now,
  );
  brain.store.run("DELETE FROM jobs WHERE kind='recall_embed' AND created_at<=? AND status NOT IN ('queued','running') AND NOT EXISTS (SELECT 1 FROM provider_dispatches d WHERE d.job_id=jobs.id)", cutoff);
  const prefixes = [EMBED_STATE_KEY(""), EMBED_RESULT_KEY("")];
  const keys = brain.store.all<{ key: string }>("SELECT key FROM settings WHERE substr(key,1,?)=? OR substr(key,1,?)=?", prefixes[0].length, prefixes[0], prefixes[1].length, prefixes[1]);
  for (const { key } of keys) {
    const id = key.slice(key.startsWith(prefixes[1]) ? prefixes[1].length : prefixes[0].length);
    const job = brain.store.get<{ status: string; created_at: string }>("SELECT status,created_at FROM jobs WHERE id=? AND kind='recall_embed'", id);
    if (!job || job.created_at <= cutoff || job.status === "cancelled" || job.status === "failed") brain.store.run("DELETE FROM settings WHERE key=?", key);
  }
}

/** Polls every 25 ms only while better search is effective; otherwise re-reads once a second. Sweeps every 15 minutes. */
export function startEmbedLoop(deps: QueryEmbedDeps): { stop(): Promise<void> } {
  let running = true;
  const cache: Cache = new Map();
  let lastSweep = 0;
  const loop = (async () => {
    while (running) {
      try {
        if (Date.now() - lastSweep > SWEEP_EVERY_MS) {
          sweepEmbedRows(deps.brain);
          lastSweep = Date.now();
          for (const [key, entry] of cache) if (Date.now() - entry.at >= QUERY_CACHE_MS) cache.delete(key);
        }
        if (!deps.brain.betterSearchAllowed().on) {
          await sleep(1000);
          continue;
        }
        const worked = await runQueryEmbedOnce(deps, cache);
        if (!worked) await sleep(EMBED_LOOP_MS);
      } catch {
        await sleep(1000);
      }
    }
  })();
  return {
    async stop() {
      running = false;
      await loop;
    },
  };
}
```

Sweep trace for the test: `recall_embed:stale` belongs to a job the same sweep just cancelled, so the key goes; `recall_embed_result:old` belongs to a row older than the cutoff that the DELETE removed, so the lookup finds no job and the key goes; `fresh` stays.

- [ ] Modify `packages/domain/service.ts`:
  - Extend the `./better-search.ts` import with `EMBED_DIM_MAX, EMBED_DIM_MIN, EMBED_RESULT_KEY, EMBED_STATE_KEY, QUERY_EMBED_DEADLINE_MS, QUERY_EMBED_POLL_MS, vectorFromBase64, type QueryVector`.
  - After `awaitRecallJudge` (closing brace line 3623) add:

```ts
  /**
   * The query vector for dense recall, from the worker's fast lane within 400 ms, or null (words only).
   * This process never calls a model: the key and the endpoint live in the worker. The query text is stored only
   * under the job's state key and is deleted by whichever side finishes first.
   */
  async queryVector(p: Principal, query: string): Promise<QueryVector | null> {
    const allowed = this.betterSearchAllowed();
    if (!allowed.on || !allowed.setting.key) return null;
    const q = query.trim();
    if (!q || detectSecrets(q).length) return null;
    const key = allowed.setting.key;
    const id = randomUUID();
    const now = this.now();
    const deadline = new Date(this.clock().getTime() + QUERY_EMBED_DEADLINE_MS).toISOString();
    const requestHash = hash(`${key}\n${q}`);
    try {
      this.store.transaction(() => {
        this.store.run(
          "INSERT INTO jobs(id,project_id,kind,payload,status,max_attempts,next_at,created_at,deadline_at) VALUES(?,?,?,?,?,?,?,?,?)",
          id, "inbox", "recall_embed", JSON.stringify({ request_id: id, request_hash: requestHash }), "queued", 1, now, now, deadline,
        );
        this.store.set(EMBED_STATE_KEY(id), { query: q, request_hash: requestHash, created_at: now });
      });
      return await this.awaitQueryVector(id, QUERY_EMBED_DEADLINE_MS, key);
    } catch {
      // Dense recall is optional help: a storage fault means words only, never an error to the caller.
      return null;
    }
  }
  /** Polls for the worker's vector every 10 ms until the deadline; a job that ended without one ends the wait at once. Validates key and shape before use. */
  private async awaitQueryVector(requestId: string, deadlineMs: number, key: string): Promise<QueryVector | null> {
    const until = Date.now() + Math.floor(deadlineMs);
    const read = (): QueryVector | null | undefined => {
      const result = this.store.setting<{ key?: unknown; dim?: unknown; vector?: unknown } | null>(EMBED_RESULT_KEY(requestId), null);
      if (!result) return undefined;
      this.store.run("DELETE FROM settings WHERE key=?", EMBED_RESULT_KEY(requestId));
      const dim = result.dim;
      if (result.key !== key || typeof dim !== "number" || !Number.isInteger(dim) || dim < EMBED_DIM_MIN || dim > EMBED_DIM_MAX) return null;
      const vector = vectorFromBase64(String(result.vector ?? ""), dim);
      return vector ? { vector, key, dim } : null;
    };
    while (Date.now() < until) {
      const found = read();
      if (found !== undefined) return found;
      const job = this.store.get<{ status: string }>("SELECT status FROM jobs WHERE id=? AND kind='recall_embed'", requestId);
      if (!job || job.status === "failed" || job.status === "cancelled") return null;
      await new Promise((r) => setTimeout(r, QUERY_EMBED_POLL_MS));
    }
    // Given up: a job nobody took is fenced and its query text deleted now; a running job finishes in the worker and only feeds its cache.
    this.store.transaction(() => {
      const cancelled = this.store.run("UPDATE jobs SET status='cancelled',fence=fence+1 WHERE id=? AND kind='recall_embed' AND status='queued'", requestId).changes;
      if (cancelled) this.store.run("DELETE FROM settings WHERE key=?", EMBED_STATE_KEY(requestId));
      this.store.run("DELETE FROM settings WHERE key=?", EMBED_RESULT_KEY(requestId));
    });
    return null;
  }
```

- [ ] Modify `apps/worker/engine.ts`: lines 116, 159 and 163: replace `kind<>'recall_judge'` with `kind NOT IN ('recall_judge','recall_embed')` (three places; the judge and the query lane both own their rows).
- [ ] Modify `apps/worker/main.ts`: import `startEmbedLoop` from `./recall-embed.ts`; after the judge block (line 517) add
  ```ts
  // The query fast lane runs only here, beside the batch job, so the key and the endpoint never leave this process.
  const embedLane = embed.config
    ? startEmbedLoop({ brain, ledger: new LocalDispatchAccounting(storage, brain.clock), client: { config: embed.config }, owner: brain.ownerPrincipal(), workerId: worker.id })
    : null;
  ```
  and after `await judge?.stop();` add `await embedLane?.stop();`.

- [ ] Run: `npx vitest run tests/integration/recall-embed-lane.test.ts tests/integration/recall-judge.test.ts tests/integration/worker-dispatch.test.ts tests/integration/embed-batch.test.ts` — expected: all pass. The timing bands (≥ 380 ms, < 800 ms) mirror the judge test; if CI load trips the upper band, widen it to 1,000 ms, never the lower one.
- [ ] Run: `npm run typecheck && npm run lint` — expected exit 0.
- [ ] Commit: `git add apps/worker/recall-embed.ts apps/worker/engine.ts apps/worker/main.ts packages/domain/service.ts tests/integration/recall-embed-lane.test.ts` with message:

```
feat(search): recall_embed query fast lane with a 400 ms server wait

A dedicated worker loop embeds the query (Cloudflare through the ledger),
caches vectors by request hash for ten minutes, and publishes a key-free
result the server validates; the server falls back to words only.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
```

---

### Task 5: Fusion, pinning, authorization and the owner and agent paths

**Size:** L (Sonnet). The one task that touches `recallInternal`; every plan 5 invariant must hold byte for byte with dense off.

**Files:**
- Modify: `packages/domain/recall.ts` (`rrf` line 41 gains weights; `fuse` line 56 takes an optional `dense` list; `deterministicSignals` line 163 ignores dense-only candidates for the BM25 gap; new `DENSE_LIST`, `RecallLists`, `fromBm25`, `denseWhy`, `pinExact`)
- Modify: `packages/domain/service.ts` (imports; module-level `entityFromPrefix` next to `questionWordsOf` line 127; class field `vectors`; `recallCore` line 3456, `recall` line 3464, `recallPush` lines 3499 and 3494, `recallLog` line 3566, `recallInternal` lines 3683–3753; `searchBrain` line 4888 and `ask` line 4915 become `async`)
- Create: `tests/eval/dense-fixture.ts` (in-process embedding of a fixture with the fake model; used by tasks 5 and 7)
- Test: `tests/integration/recall-dense.test.ts`; additions to `tests/integration/recall-domain.test.ts`
- Modify (call sites of the now-async `ask`/`searchBrain`): `tests/integration/ask-recall.test.ts` (lines 23, 36, 40, 47–49, 56, 68, 74, 76, 80–82), `tests/integration/brain-search.test.ts` (lines 100–105), `tests/integration/brief-service.test.ts` (lines 112–131), `tests/integration/recall-judge.test.ts` (lines 185–186). Pattern: `f.brain.ask(...)` → `await f.brain.ask(...)`; `expect(() => b.ask(...)).toThrow(x)` → `await expect(b.ask(...)).rejects.toThrow(x)`; the enclosing `it` callbacks become `async`. The HTTP routes at `apps/server/app.ts` lines 797 and 799 already return the handler's value, so a promise is fine; `apps/mcp` does not call either.
- Existing tests to run: `tests/integration/recall-push.test.ts`, `tests/integration/bibrain-hook.test.ts`, `tests/integration/agent-recall-http.test.ts`, `tests/integration/mcp-surface.test.ts`, `tests/eval/recall.test.ts` (unchanged behaviour with dense off).

**Interfaces:**
- Consumes: `VectorCache` (task 2), `QueryVector`, `denseFloor`, `DENSE_WEIGHT` (task 1), `Brain.queryVector` (task 4), `questionWords` (`packages/domain/ask.ts`).
- Produces (`packages/domain/recall.ts`):
  - `export const DENSE_LIST = "dense";`
  - `export function rrf(lists: string[][], k = RRF_K, weights: number[] = []): Map<string, number>` (weight 1 by default; identical output for the old call shape)
  - `export type RecallLists = { facts: RecallMatch[]; originals: RecallMatch[]; phrase: RecallMatch[]; dense?: RecallMatch[] }`
  - `export function fuse(lists: RecallLists, now: Date): Candidate[]` (the dense list enters RRF with `DENSE_WEIGHT`; a key present in a BM25 list keeps its BM25 row, a dense-only key keeps its cosine as `row.score` and `lists: ["dense"]`)
  - `export const fromBm25 = (c: Candidate) => boolean` and `export const denseWhy = (c: Candidate) => string[]` (`["similar meaning"]` when the candidate came from the dense list)
  - `export function pinExact(ranked: Candidate[], entityOf: (c: Candidate) => string, names: string[]): Candidate[]` (current facts whose entity is an exact name match move to the front, order otherwise preserved)
- Produces (`packages/domain/service.ts`):
  - `recallCore(p: Principal, input: unknown, dense: QueryVector | null = null): RecallResult`
  - `recallInternal(p: Principal, v: {...}, dense: QueryVector | null = null)` whose return gains `dense: boolean` (a vector was used)
  - `async ask(p, input)` and `async searchBrain(p, input)` with the same return shapes as before
  - the recall log row gains `dense: boolean`

**Steps:**

- [ ] Create `tests/eval/dense-fixture.ts`:

```ts
import { FAKE_EMBED_DIM, FAKE_EMBED_MODEL, fakeEmbed } from "../helpers/fake-embed.mjs";
import { BETTER_SEARCH, BETTER_SEARCH_STATUS, EMBED_VISIBILITIES, embedText, modelKey, normalize, type EmbedProvider, type QueryVector } from "../../packages/domain/better-search.ts";
import { pendingEmbedRows, writeEmbeddings } from "../../packages/storage/recall-vectors.ts";
import type { Fixture } from "./recall-fixture.ts";

export const FAKE_KEY = modelKey("ollama", FAKE_EMBED_MODEL);
export const fakeVector = (text: string, key = FAKE_KEY): QueryVector => ({ vector: normalize(Float32Array.from(fakeEmbed(text))), key, dim: FAKE_EMBED_DIM });

/** Marks the fixture as having chosen Better search with the fake model and embeds every eligible current row in-process: no worker, no job, no clock. */
export function embedFixture(fx: Fixture, provider: EmbedProvider = "ollama") {
  const key = modelKey(provider, FAKE_EMBED_MODEL);
  fx.store.set(BETTER_SEARCH_STATUS, { configured: true, provider, model: FAKE_EMBED_MODEL, key, label: provider, updated_at: fx.brain.now() });
  fx.store.set(BETTER_SEARCH, { mode: provider, key, consented_at: fx.brain.now() });
  fx.store.set("worker_heartbeat", fx.brain.now());
  let embedded = 0;
  for (;;) {
    const rows = pendingEmbedRows(fx.store, key, EMBED_VISIBILITIES[provider], 32);
    if (!rows.length) break;
    const n = fx.store.transaction(() => writeEmbeddings(fx.store, key, FAKE_EMBED_DIM, rows.map((r) => ({ ...r, vector: Float32Array.from(fakeEmbed(embedText(r.prefix, r.text))) }))));
    if (!n) throw new Error("embedFixture made no progress");
    embedded += n;
  }
  return { key, embedded, dense: (q: string) => fakeVector(q, key) };
}
```

- [ ] Add to `tests/integration/recall-domain.test.ts` (new `describe` at the end; the `row` helper and `now` at the top of the file are reused):

```ts
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
  it("pinExact moves exact-name current facts to the front and keeps every other order", () => {
    const fact = (id: string, prefix: string, status: "current" | "history" = "current") => ({ key: `fact:${id}`, row: row({ kind: "fact", ref_id: id, prefix, status }), fused: 0.01, lists: ["facts"] });
    const ranked = [{ key: "original:x:0", row: row({ ref_id: "x" }), fused: 0.05, lists: ["dense"] }, fact("1", "Northstar · Marco"), fact("2", "Northstar · northstar"), fact("3", "Northstar · northstar", "history")];
    const out = pinExact(ranked, (c) => c.row.prefix.replace(/^Northstar · /u, ""), ["Northstar"]);
    expect(out.map((c) => c.key)).toEqual(["fact:2", "original:x:0", "fact:1", "fact:3"]);
    expect(pinExact(ranked, (c) => c.row.prefix, [])).toBe(ranked);
  });
});
```
  Add `fromBm25`, `denseWhy`, `pinExact` to the file's import list from `recall.ts`.

- [ ] Write the failing test `tests/integration/recall-dense.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildFixture, owner, type Fixture } from "../eval/recall-fixture.ts";
import { embedFixture, fakeVector } from "../eval/dense-fixture.ts";
import { FAKE_EMBED_DIM, FAKE_EMBED_MODEL, fakeEmbed, fakeEmbedFetcher } from "../helpers/fake-embed.mjs";
import { Brain } from "../../packages/domain/service.ts";
import { LocalDispatchAccounting } from "../../apps/worker/accounting.ts";
import { runQueryEmbedOnce, type QueryEmbedDeps } from "../../apps/worker/recall-embed.ts";
import { embedFromEnv } from "../../packages/providers/embed-env.ts";
import { BETTER_SEARCH, BETTER_SEARCH_OFF, encodeVector, normalize } from "../../packages/domain/better-search.ts";
import { pendingEmbedRows } from "../../packages/storage/recall-vectors.ts";
import type { RecallResult } from "../../packages/domain/recall.ts";

let cleanup: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const fn of cleanup.reverse()) fn();
  cleanup = [];
});
const everywhere = (r: RecallResult) => JSON.stringify({ ...r, searched: { ...r.searched, query: "" } });
function dense() {
  const dir = mkdtempSync(join(tmpdir(), "recall-dense-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const fx: Fixture = buildFixture(join(dir, "fixture.sqlite"));
  cleanup.push(() => fx.store.close());
  const e = embedFixture(fx);
  return { fx, ...e, ns: fx.ids["project:northstar"] };
}
/** A worker pump for the owner-screen cases: the lane answers from the same fake model the fixture was embedded with. */
function pump(fx: Fixture) {
  const env = embedFromEnv({ BRAIN_EMBED_PROVIDER: "ollama", BRAIN_EMBED_MODEL: FAKE_EMBED_MODEL, BRAIN_EMBED_ENDPOINT: "http://127.0.0.1:9/api/embed" });
  if (!env.config) throw new Error(env.reason);
  const { fetcher, calls } = fakeEmbedFetcher();
  const deps: QueryEmbedDeps = { brain: fx.brain, ledger: new LocalDispatchAccounting(fx.store, fx.brain.clock), client: { config: env.config, fetcher }, owner, workerId: "w" };
  const cache = new Map();
  const withWorker = async <T>(work: () => Promise<T>) => {
    let running = true;
    const loop = (async () => {
      while (running) {
        await runQueryEmbedOnce(deps, cache);
        await new Promise((r) => setTimeout(r, 15));
      }
    })();
    try {
      return await work();
    } finally {
      running = false;
      await loop;
    }
  };
  return { withWorker, calls };
}

describe("dense recall", () => {
  it("a paraphrased question finds the note with Better search on and not without it, for the owner and an agent", () => {
    const t = dense();
    const q = "which hue was chosen for the release";
    for (const p of [owner, t.fx.agent]) {
      const on = t.fx.brain.recallCore(p, { query: q }, t.dense(q));
      const ids = on.hits.slice(0, 5).map((h) => h.id);
      expect(ids).toContain(t.fx.ids["fact:launch-color"]);
      expect(on.hits.find((h) => h.id === t.fx.ids["fact:launch-color"])!.why).toContain("similar meaning");
      expect(on.status).toBe("partial");
      expect(on.near_misses.length).toBeLessThanOrEqual(3);
      const off = t.fx.brain.recallCore(p, { query: q });
      expect(off.hits.map((h) => h.id)).not.toContain(t.fx.ids["fact:launch-color"]);
      expect(JSON.stringify(off)).toBe(JSON.stringify(t.fx.brain.recallCore(p, { query: q }, null)));
    }
    expect(t.fx.brain.recallInternal(owner, { query: q, history: false, limit: 8 }).dense).toBe(false);
    expect(t.fx.brain.recallInternal(owner, { query: q, history: false, limit: 8 }, t.dense(q)).dense).toBe(true);
    expect(t.fx.store.all("SELECT 1 FROM jobs WHERE kind IN ('recall_embed','embed_batch')")).toEqual([]);
  });
  it("dense candidates pass the same authorization: the scope filter first, then the per-hit re-check", () => {
    const t = dense();
    const q = "was the launch colour the right call";
    const mine = t.fx.brain.recallCore(owner, { query: q }, t.dense(q));
    expect(mine.hits.map((h) => h.id)).toContain(t.fx.ids["src:private-journal"]);
    const theirs = t.fx.brain.recallCore(t.fx.agent, { query: q }, t.dense(q));
    expect(everywhere(theirs)).not.toContain("PRIVATE_CANARY");
    expect(everywhere(theirs)).not.toContain(t.fx.ids["src:private-journal"]);
    // A planted project-visible row whose source is private: the scan returns it, the per-hit source() check drops it from every field.
    t.fx.store.run(
      "INSERT INTO recall_chunks(kind,ref_id,ref_version,project_id,visibility,status,ordinal,start,end,text,prefix,recorded_at,boost,embedding,embedding_model,embedding_dim) VALUES('original',?,1,?,'project','current',7,0,10,'PRIVATE_CANARY_TEXT planted','Journal · Northstar · 2026-10-25','2026-10-25T00:00:00.000Z',1,?,?,?)",
      t.fx.ids["src:private-journal"], t.ns, encodeVector(normalize(Float32Array.from(fakeEmbed(q)))), t.key, FAKE_EMBED_DIM,
    );
    const again = t.fx.brain.recallCore(t.fx.agent, { query: q }, t.dense(q));
    expect(everywhere(again)).not.toContain("PRIVATE_CANARY");
    expect(again.searched.candidates).toBeGreaterThanOrEqual(again.hits.length + again.near_misses.length);
    // Another project never enters the matrix for this grant.
    const hydra = t.fx.brain.recallCore(t.fx.agent, { query: "what day does Hydra deploy" }, t.dense("what day does Hydra deploy"));
    for (const canary of ["HYDRA_CANARY", t.fx.ids["src:hydra-deploy"], t.fx.ids["fact:hydra-deploy"]]) expect(everywhere(hydra)).not.toContain(canary);
    // Owner-only facts stay owner-only.
    const name = t.fx.brain.recallCore(t.fx.agent, { query: "what is the owner called" }, t.dense("what is the owner called"));
    for (const canary of ["Ana Costa", t.fx.ids["fact:owner-name"], t.fx.ids["src:prefs"]]) expect(everywhere(name)).not.toContain(canary);
  });
  it("a stale vector (another model key) is ignored, a mixed-model read is refused, and the row is pending again", () => {
    const t = dense();
    const q = "what is the monthly fee";
    const price = t.fx.ids["fact:price"];
    expect(t.fx.brain.recallCore(owner, { query: q }, t.dense(q)).hits.map((h) => h.id)).toContain(price);
    t.fx.store.run("UPDATE recall_chunks SET embedding_model='ollama:other:none' WHERE kind='fact' AND ref_id=?", price);
    expect(t.fx.brain.recallCore(owner, { query: q }, t.dense(q)).hits.map((h) => h.id)).not.toContain(price);
    expect(pendingEmbedRows(t.fx.store, t.key, ["project", "private", "owner"], 32).map((r) => r.ref_id)).toEqual([price]);
    const other = t.fx.brain.recallCore(owner, { query: q }, fakeVector(q, "ollama:other:none"));
    expect(other.hits.map((h) => h.id)).toEqual([price]);
    expect(t.fx.brain.recallCore(owner, { query: q }, { ...t.dense(q), dim: 8, vector: new Float32Array(8).fill(0.35) }).hits).toEqual([]);
  });
  it("an exact entity match stays first when dense candidates are present", () => {
    const t = dense();
    const q = "Northstar status";
    const out = t.fx.brain.recallCore(owner, { query: q }, t.dense(q));
    expect(out.hits[0].id).toBe(t.fx.ids["fact:status-new"]);
    expect(out.hits.map((h) => h.id)).not.toContain(t.fx.ids["fact:status-old"]);
  });
  it("the Ask bar and Your brain search use dense when it is on, through the worker lane, and words only when it is off", async () => {
    const t = dense();
    const { withWorker, calls } = pump(t.fx);
    const asked = await withWorker(() => t.fx.brain.ask(owner, { q: "which hue was chosen for the release" }));
    expect(asked.answered).toBe(true);
    // Membership, not rank: the BM25 hit on "release" (the Hydra deploy note's "release branch") can outrank the fact in RRF.
    expect(asked.hits.map((h) => h.id)).toContain(t.fx.ids["fact:launch-color"]);
    // "is" has two letters: without a vector this query goes to the literal list; with Better search on, meaning finds the fact.
    const searched = await withWorker(() => t.fx.brain.searchBrain(owner, { q: "what is the monthly fee" }));
    expect(searched.facts.map((f) => f.id)).toContain(t.fx.ids["fact:price"]);
    expect(calls.n).toBe(2);
    // A query with no searchable words at all still falls back to the literal list (which finds nothing for this one).
    const literal = await withWorker(() => t.fx.brain.searchBrain(owner, { q: "zq xk" }));
    expect(literal).toEqual({ facts: [], originals: [] });
    expect(t.fx.store.all("SELECT 1 FROM jobs WHERE kind='recall_judge'")).toEqual([]);
    t.fx.store.set(BETTER_SEARCH, BETTER_SEARCH_OFF);
    const plain = await t.fx.brain.ask(owner, { q: "which hue was chosen for the release" });
    expect(plain.hits.map((h) => h.id)).not.toContain(t.fx.ids["fact:launch-color"]);
    expect(calls.n).toBe(2);
    await expect(t.fx.brain.ask(owner, { q: "the and of" })).rejects.toThrow(/Ask with a few words/);
  });
  it("recall and the hook push take the vector before the judge, log dense, and keep the push level term-based", async () => {
    const t = dense();
    const { withWorker } = pump(t.fx);
    const order: string[] = [];
    vi.spyOn(t.fx.brain, "queryVector").mockImplementation(async function (this: Brain, _p, q) {
      order.push("vector");
      return fakeVector(q);
    });
    vi.spyOn(t.fx.brain as any, "judgeRanked").mockImplementation(async function (this: Brain, _p, internal: any) {
      order.push("judge");
      return { signals: null, ranked: internal.ranked, demoted: [] };
    });
    const out = await withWorker(() => t.fx.brain.recall(t.fx.agent, { query: "which hue was chosen for the release" }));
    expect(order).toEqual(["vector", "judge"]);
    expect(out.hits.map((h) => h.id)).toContain(t.fx.ids["fact:launch-color"]);
    const started = Date.now();
    const push = await withWorker(() => t.fx.brain.recallPush(t.fx.agent, { prompt: "which hue was chosen for the release", session_id: "a".repeat(64), first_prompt: false, seen: [] }));
    expect(Date.now() - started).toBeLessThan(1500);
    expect(push.level).toBe("none");
    expect(t.fx.brain.recallLog(owner).rows.at(-1)).toMatchObject({ dense: true, judged: false, level: "none" });
    expect(t.fx.brain.recallLog(owner).rows.at(-1)!.candidates).toBeGreaterThan(0);
  });
});
```

- [ ] Run: `npx vitest run tests/integration/recall-dense.test.ts tests/integration/recall-domain.test.ts` — expected failure: `fromBm25`/`pinExact` are not exported; `recallCore` ignores its third argument.

- [ ] Modify `packages/domain/recall.ts`:
  - Add `import { DENSE_WEIGHT } from "./better-search.ts";` after line 4 and `export const DENSE_LIST = "dense";` after `NEAR_MISSES_MAX` (line 13).
  - Replace `rrf` (lines 41–45):

```ts
/** Reciprocal rank fusion with an optional weight per list (1 by default). */
export function rrf(lists: string[][], k = RRF_K, weights: number[] = []): Map<string, number> {
  const out = new Map<string, number>();
  lists.forEach((list, li) => {
    const w = weights[li] ?? 1;
    list.forEach((key, i) => out.set(key, (out.get(key) ?? 0) + w / (k + i + 1)));
  });
  return out;
}
```
  - Replace the signature and the first lines of `fuse` (lines 55–66) so it reads:

```ts
export type RecallLists = { facts: RecallMatch[]; originals: RecallMatch[]; phrase: RecallMatch[]; dense?: RecallMatch[] };
/**
 * RRF over the three BM25 lists plus the optional dense list (weight DENSE_WEIGHT), then the deterministic multipliers. Highest first.
 * A key seen in a BM25 list keeps that row (a BM25 score, lower is better); a dense-only key keeps its cosine. Without a dense list the output is plan 5's.
 */
export function fuse(lists: RecallLists, now: Date): Candidate[] {
  const rows = new Map<string, RecallMatch>();
  const members = new Map<string, string[]>();
  const keyed = (name: keyof RecallLists) =>
    (lists[name] ?? []).map((r) => {
      const key = candidateKey(r);
      if (!rows.has(key) || rows.get(key)!.score > r.score) rows.set(key, r);
      members.set(key, [...(members.get(key) ?? []), name]);
      return key;
    });
  const fused = rrf([keyed("facts"), keyed("originals"), keyed("phrase"), keyed(DENSE_LIST)], RRF_K, [1, 1, 1, DENSE_WEIGHT]);
```
    (the `return [...fused.entries()]...` block is unchanged). BM25 scores are negative and cosines positive, so the existing `score >` rule keeps the BM25 row for a shared key whatever the list order.
  - After `fuse` add:

```ts
/** Whether a candidate was retrieved by words at all (a dense-only candidate has no BM25 score to compare). */
export const fromBm25 = (c: Candidate) => c.lists.some((l) => l !== DENSE_LIST);
export const denseWhy = (c: Candidate) => (c.lists.includes(DENSE_LIST) ? ["similar meaning"] : []);

/** With dense candidates present, current facts whose entity the query names exactly move to the front, in their current order. Returns the input when nothing is pinned. */
export function pinExact(ranked: Candidate[], entityOf: (c: Candidate) => string, names: string[]): Candidate[] {
  if (!names.length) return ranked;
  const wanted = new Set(names.map((n) => questionWords(n).join(" ")));
  const pinned = ranked.filter((c) => c.row.kind === "fact" && c.row.status === "current" && wanted.has(questionWords(entityOf(c)).join(" ")));
  if (!pinned.length) return ranked;
  const set = new Set(pinned);
  return [...pinned, ...ranked.filter((c) => !set.has(c))];
}
```
  - In `deterministicSignals` (lines 174–177) require a words match on both branches (with no dense list `fromBm25` is always true, so plan 5 output is unchanged):

```ts
    if (top.row.kind === "fact" && top.row.status === "current" && n >= needed && fromBm25(top)) strong = true;
    else if (top.row.kind === "original" && n >= 2 && fromBm25(top)) {
      const next = ranked.find((c) => c.row.kind === "original" && c !== top && fromBm25(c));
      strong = !next || Math.abs(top.row.score) >= 1.3 * Math.abs(next.row.score);
    }
```

- [ ] Modify `packages/domain/service.ts`:
  - Add `VectorCache` to the `../storage/recall-vectors.ts` import (task 3 created the line); add `denseFloor` to the `./better-search.ts` import (`QueryVector` is already there from task 4); add `denseWhy, pinExact, type RecallLists` to the `./recall.ts` import (lines 58–77).
  - Next to `questionWordsOf` (line 127) add:

```ts
/** The entity name a fact row's prefix carries after its project title. */
const entityFromPrefix = (prefix: string, projectTitle: string) => {
  const lead = `${projectTitle} · `;
  return prefix.startsWith(lead) ? prefix.slice(lead.length) : "";
};
```
  - In the class body, right after the constructor's closing `) {}` (line 151): `/** The dense-scan matrix cache for this process; the stored generation keeps it honest across server and worker. */ private readonly vectors = new VectorCache();`
  - `recallCore` (line 3456): `recallCore(p: Principal, input: unknown, dense: QueryVector | null = null): RecallResult { return this.recallInternal(p, recallInputSchema.parse(input), dense).result; }`
  - `recall` (lines 3465–3466): after `const v = ...` insert `// The candidate list, words plus meaning, is complete before the judge sees it: at most 400 ms for the vector, then at most 900 ms for the judge.` and `const dense = await this.queryVector(p, v.query);`; change to `const internal = this.recallInternal(p, v, dense);`.
  - `recallPush`: line 3494 log row gains `dense: extra.dense` and the `finish` signature's `extra` gains `dense: boolean`; both `finish(quiet, ...)` calls before the recall pass `dense: false`; line 3499 becomes `const dense = await this.queryVector(p, v.prompt);` followed by `const internal = this.recallInternal(p, { query: v.prompt, history: false, limit: PUSH_HITS_MAX }, dense);`; the two later `finish(...)` calls pass `dense: internal.dense`.
  - `recallLog` (line 3566): add `dense?: boolean` to the row type.
  - `recallInternal` (line 3683): signature `recallInternal(p: Principal, v: { query: string; project_id?: string; history: boolean; limit: number }, dense: QueryVector | null = null)`. The early `no_match` return (line 3704) gains `dense: false`. Replace lines 3707–3712 (`const lists = {...}`) with:

```ts
    const lists: RecallLists = {
      facts: search(fts.match, "fact"),
      originals: search(fts.match, "original"),
      // One RRF list: the two kinds are interleaved by BM25 score (more negative is better), not concatenated.
      phrase: fts.phrase ? [...search(fts.phrase, "fact"), ...search(fts.phrase, "original")].sort((a, b) => a.score - b.score) : [],
      // The fourth list: dense candidates for the same scope and status, under the per-model floor. Empty unless the owner chose
      // better search and the worker answered in time; the per-hit checks below treat them exactly like every other candidate.
      dense: dense ? this.vectors.search(this.store, { vector: dense.vector, key: dense.key, dim: dense.dim, projects: ids, visibilities, status, floor: denseFloor(dense.key), limit: CANDIDATES_PER_LIST }) : [],
    };
```
    Replace `for (const candidate of fuse(lists, now)) {` (line 3718) with:

```ts
    // With dense candidates present, a fact whose entity the query names exactly stays first; plan 5 ordering is untouched otherwise.
    let fused = fuse(lists, now);
    if (lists.dense!.length) fused = pinExact(fused, (c) => entityFromPrefix(c.row.prefix, titles.get(c.row.project_id) ?? ""), entityNames);
    for (const candidate of fused) {
```
    In the two `authorized.push` lines (3727 and 3735) change `why: whyFor(...)` to `why: [...whyFor(...), ...denseWhy(candidate)]`. The final return (line 3753) gains `dense: dense !== null`.
  - `searchBrain` (line 4888): `async searchBrain(p: Principal, input: unknown) {`. The vector is requested first, and the short-word guard applies only without one, so Your brain search uses meaning whenever Better search is on (B9) while the dense-off path stays byte-identical to plan 5. Replace lines 4896–4898 with:

```ts
    // With a vector, meaning can find a note whatever the query's short words; without one, words under three characters never
    // become FTS terms and the literal search is the only one that can see them (unchanged from plan 5).
    const dense = await this.queryVector(p, v.q);
    if (!dense && v.q.split(/\s+/u).some((w) => Array.from(w).length < 3)) return literal();
    const internal = this.recallInternal(p, { query: v.q, history: false, limit: RECALL_LIMIT_MAX }, dense);
```
    The existing `if (facts.length === 0 && originals.length === 0) return literal();` stays: with a vector and no searchable words, `recallInternal` returns nothing and the literal list is the fallback.
  - `ask` (line 4915): `async ask(p: Principal, input: unknown) {`; after the `questionWords` guard add `const dense = await this.queryVector(p, v.q);` and `this.recallCore(p, { query: v.q, history: false, limit: 6 }, dense)`.

- [ ] Update the four call-site test files listed under Files (add `await`, `async` callbacks and `.rejects.toThrow`).

- [ ] Run: `npx vitest run tests/integration/recall-dense.test.ts tests/integration/recall-domain.test.ts tests/integration/ask-recall.test.ts tests/integration/brain-search.test.ts tests/integration/brief-service.test.ts tests/integration/recall-judge.test.ts tests/integration/recall-push.test.ts tests/integration/bibrain-hook.test.ts tests/integration/agent-recall-http.test.ts tests/integration/mcp-surface.test.ts tests/eval/recall.test.ts` — expected: all pass; the eval's metrics and latency gate are unchanged (dense is off there until task 7).
- [ ] Run: `npm run typecheck && npm run lint && npm run build` — expected exit 0.
- [ ] Commit: `git add packages/domain/recall.ts packages/domain/service.ts tests/eval/dense-fixture.ts tests/integration/recall-dense.test.ts tests/integration/recall-domain.test.ts tests/integration/ask-recall.test.ts tests/integration/brain-search.test.ts tests/integration/brief-service.test.ts tests/integration/recall-judge.test.ts` with message:

```
feat(search): dense candidates as a fourth RRF list under the same authorization

Weight 0.7, per-model cosine floor, exact-entity pin, dense-only hits
never strong; the Ask bar, Your brain search, brain_recall and the hook
push take the query vector before the judge and fall back to words only.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
```

---

### Task 6: Settings "Better search" card, consent copy, routes and the browser journey

**Size:** M (Sonnet).

**Files:**
- Modify: `apps/server/app.ts` (after the recall-help routes at lines 840–841)
- Modify: `apps/web/src.tsx` (type and status line near `SortingStatus` line 81; state near line 331; `refresh` lines 438–463; a new card before the Sorting help card at line 1426; the `<BrainView` call at line 1056 gains `searchNote`)
- Modify: `apps/web/brain/types.ts` (`BrainProps` gains `searchNote?: string | null`), `apps/web/brain/BrainView.tsx` (`note={props.searchNote ?? null}` on `<BrainSearch` at line 116) and `apps/web/brain/BrainSearch.tsx` (prop `note?: string | null` rendered under the field)
- Modify: `playwright.config.ts` (`embedPort = port + 16`; a `node tests/helpers/fake-embed.mjs` web server; the sorting server env gains `BRAIN_EMBED_PROVIDER`, `BRAIN_EMBED_MODEL`, `BRAIN_EMBED_ENDPOINT`; project `system1` `testMatch: /(system-one|better-search)\.spec\.ts/`; project `main` ignores `better-search` too)
- Create: `tests/e2e/better-search.spec.ts`
- Test: `tests/integration/better-search-http.test.ts`
- Existing tests to run: `tests/e2e/system-one.spec.ts` (shares the server; it must still start from "Needs a daily limit above $0 below."), `tests/integration/agent-recall-http.test.ts`.

**Interfaces:**
- Consumes: `Brain.betterSearch`, `Brain.setBetterSearch` (task 3); the web `api()` helper and `act()`; `BrainSearch` props.
- Produces: `GET /api/v1/preferences/better-search` → `Brain.betterSearch`; `PATCH /api/v1/preferences/better-search` `{ mode }` → `Brain.setBetterSearch` (owner session + CSRF like every other owner route; a managed brain gets the domain's 409).
- Produces (web): `type BetterSearch`, `function betterSearchLine(b: BetterSearch): string`, state `better`, `betterChoice`, `betterTouched`; the card copy below; `BrainSearch` renders `note` as `<p className="muted" role="status">`.

**Copy (binding, B1):**
- Card title: `Better search`. Lead: `Find notes by what they mean, not only by the words you used, in any language you write in.`
- Status line (`role="status"`): off → `Off. Search matches the words you used.`; paused by the worker's breaker (`paused_until` in the future) → `Better search paused: the service is not answering.`; on and working → `On · <label> · <embedded> of <total> passages ready` with `; preparing the rest in the background` while `pending > 0`; on but not working → `Words only right now: <reason>`.
- Radio `Off`: `Off. Search matches the words you used.`
- Radio Ollama: `On this computer (Ollama). Nothing leaves this computer.` plus ` Not set up on this computer.` (muted) and disabled when the worker published another provider or nothing.
- Radio Cloudflare: `Cloudflare. The text of your notes, your searches and the questions your connected agents ask is sent to Cloudflare Workers AI to be turned into numbers that stay on this computer. Private notes are never sent. About 1 cent for every 500,000 words, counted against your daily limit.` plus the same muted suffix when unavailable, and ` Needs a daily limit and a per-preparation limit above $0 below.` when `caps_ok` is false. (Agent prompts are embedded for dense recall under the hook push, so the consent names them; the cost line uses the ledger's own estimate, half the UTF-8 bytes per token.)
- Button: `Save better search` (disabled while the choice equals the saved mode). Notice: `Better search is off.` or `Better search saved. Your notes are being prepared in the background.` Footnote: `Changing this choice later clears what was prepared and starts again.`
- Your brain, under the search field, only while `mode !== "off" && !effective`: `Search is using words only right now.`

**Steps:**

- [ ] Write the failing test `tests/integration/better-search-http.test.ts` (the pairing flow is the one `brain-search.test.ts` lines 108–117 use):

```ts
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../../packages/storage/index.ts";
import { Brain } from "../../packages/domain/service.ts";
import { createApp } from "../../apps/server/app.ts";
import type { Principal } from "../../packages/contracts/index.ts";

const owner: Principal = { kind: "owner" };
let cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});
describe("better-search routes", () => {
  it("serve the paired owner, refuse everyone else, and carry the domain's refusals as plain 409s", async () => {
    const dir = mkdtempSync(join(tmpdir(), "better-search-http-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const store = new Storage(join(dir, "brain.sqlite"));
    cleanup.push(() => store.close());
    const brain = new Brain(store);
    const app = await createApp(brain, { pairSecret: "synthetic-better-search", static: false });
    cleanup.push(() => app.close());
    const req = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown, headers: Record<string, string> = {}) =>
      app.inject({ method, url, headers: { host: "127.0.0.1:4317", ...headers }, payload });
    expect((await req("GET", "/api/v1/preferences/better-search")).statusCode).toBe(401);
    const pairing = await req("POST", "/api/v1/session/pair", { secret: "synthetic-better-search" });
    const cookie = pairing.cookies[0];
    const headers = { cookie: `${cookie.name}=${cookie.value}`, "x-brain-csrf": pairing.json().csrf };
    const got = await req("GET", "/api/v1/preferences/better-search", undefined, headers);
    expect(got.statusCode).toBe(200);
    expect(got.json()).toMatchObject({ mode: "off", effective: false, status: null, paused_until: null, counts: { total: 0 } });
    const refused = await req("PATCH", "/api/v1/preferences/better-search", { mode: "ollama" }, headers);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.message).toMatch(/background worker starts/);
    expect(store.setting("better_search", null)).toBeNull();
    const off = await req("PATCH", "/api/v1/preferences/better-search", { mode: "off" }, headers);
    expect(off.statusCode).toBe(200);
    expect(off.json()).toEqual({ mode: "off", key: null, consented_at: null });
    expect((await req("PATCH", "/api/v1/preferences/better-search", { mode: "sideways" }, headers)).statusCode).toBe(400);
    const token = brain.createGrant(owner, { projects: ["inbox"], operations: ["read"], expires_at: "2027-01-01T00:00:00.000Z" }).token;
    const agent = await req("GET", "/api/v1/preferences/better-search", undefined, { authorization: `Bearer ${token}` });
    expect([401, 403]).toContain(agent.statusCode);
  });
});
```

- [ ] Run: `npx vitest run tests/integration/better-search-http.test.ts` — expected failure: the paired `GET` answers 404 (route missing).

- [ ] Modify `apps/server/app.ts` after line 841:

```ts
  // Better search is its own consent beside the preferences; the domain refuses a provider the worker has not published and clears vectors on any change.
  app.get("/api/v1/preferences/better-search", (req) => req.brain.betterSearch(req.principal));
  app.patch("/api/v1/preferences/better-search", (req) => req.brain.setBetterSearch(req.principal, req.body));
```

- [ ] Modify `apps/web/src.tsx`:
  - After `sortingLine` (line 102) add:

```tsx
type BetterSearch = {
  mode: "off" | "ollama" | "cloudflare";
  status: { configured: boolean; provider: "ollama" | "cloudflare" | null; label: string | null; reason: string | null; last_error: string | null } | null;
  effective: boolean;
  reason: string;
  worker_running: boolean;
  caps_ok: boolean;
  counts: { total: number; embedded: number; pending: number; withheld: number };
  failures: number;
  retry_at: string | null;
  paused_until: string | null;
};
const BETTER_LABELS = { ollama: "Ollama on this computer", cloudflare: "Cloudflare" } as const;
/** The one plain line Settings shows about better search. */
function betterSearchLine(b: BetterSearch): string {
  if (b.mode === "off") return "Off. Search matches the words you used.";
  if (b.paused_until) return "Better search paused: the service is not answering.";
  if (!b.effective) return `Words only right now: ${b.reason}`;
  const label = b.status?.label ?? BETTER_LABELS[b.mode];
  const ready = `${b.counts.embedded} of ${b.counts.total} passages ready`;
  return b.counts.pending > 0 ? `On · ${label} · ${ready}; preparing the rest in the background` : `On · ${label} · ${ready}`;
}
```
  - State (after line 333): `const [better, setBetter] = useState<BetterSearch | null>(null); const [betterChoice, setBetterChoice] = useState<BetterSearch["mode"]>("off"); const betterTouched = useRef(false);`
  - `refresh` (lines 438–463): add `api<BetterSearch>("/preferences/better-search").catch(() => null)` as the last member of the `Promise.all` (destructure as `betterStatus`), and after `setSavedRecallHelp(...)`: `setBetter(betterStatus); if (betterStatus && !betterTouched.current) setBetterChoice(betterStatus.mode);`. In `resetPersonalState` add `setBetter(null); setBetterChoice("off");`.
  - Card, inserted before the Sorting help card (line 1426), local mode only:

```tsx
              {better && runtime?.mode !== "managed" ? (
                <article>
                  <h2>Better search</h2>
                  <p>Find notes by what they mean, not only by the words you used, in any language you write in.</p>
                  <p className="status" role="status">{betterSearchLine(better)}</p>
                  {better.status?.last_error ? <p className="muted">Last problem: {better.status.last_error}</p> : null}
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void act(async () => {
                        try {
                          const saved = await api<{ mode: BetterSearch["mode"] }>("/preferences/better-search", { mode: betterChoice }, "PATCH");
                          const now = await api<BetterSearch>("/preferences/better-search");
                          setBetter(now);
                          setBetterChoice(saved.mode);
                          betterTouched.current = false;
                          setNotice(saved.mode === "off" ? "Better search is off." : "Better search saved. Your notes are being prepared in the background.");
                        } catch (error) {
                          // A refused choice says why and the choice goes back to what is saved.
                          setBetterChoice(better.mode);
                          betterTouched.current = false;
                          throw error;
                        }
                      });
                    }}
                  >
                    <fieldset>
                      <legend>Better search</legend>
                      {(["off", "ollama", "cloudflare"] as const).map((mode) => {
                        const available = mode === "off" || better.status?.provider === mode;
                        return (
                          <label key={mode}>
                            <input type="radio" name="better-search" value={mode} checked={betterChoice === mode} disabled={!available && betterChoice !== mode} onChange={() => { betterTouched.current = true; setBetterChoice(mode); }} />{" "}
                            {mode === "off"
                              ? "Off. Search matches the words you used."
                              : mode === "ollama"
                                ? "On this computer (Ollama). Nothing leaves this computer."
                                : "Cloudflare. The text of your notes, your searches and the questions your connected agents ask is sent to Cloudflare Workers AI to be turned into numbers that stay on this computer. Private notes are never sent. About 1 cent for every 500,000 words, counted against your daily limit."}
                            {!available ? <span className="muted"> Not set up on this computer.</span> : null}
                            {mode === "cloudflare" && available && !better.caps_ok ? <span className="muted"> Needs a daily limit and a per-preparation limit above $0 below.</span> : null}
                          </label>
                        );
                      })}
                    </fieldset>
                    <div className="actions">
                      <button type="submit" disabled={busy || betterChoice === better.mode}>Save better search</button>
                    </div>
                    <small className="muted">Changing this choice later clears what was prepared and starts again.</small>
                  </form>
                </article>
              ) : null}
```
  - `<BrainView` (line 1056): add `searchNote={better && better.mode !== "off" && !better.effective ? "Search is using words only right now." : null}`.
- [ ] Modify `apps/web/brain/types.ts`: add `searchNote?: string | null` to `BrainProps` (line 73 region). Modify `apps/web/brain/BrainView.tsx`: `note={props.searchNote ?? null}` on `<BrainSearch` (line 116). Modify `apps/web/brain/BrainSearch.tsx`: add `note?: string | null` to `Props`, destructure it, and render `{note ? <p className="muted" role="status">{note}</p> : null}` directly after the search `<input>`.

- [ ] Modify `playwright.config.ts`: after `clefPort` add `const embedPort = Number(process.env.BRAIN_E2E_EMBED_PORT ?? port + 16);`; `main` project `testIgnore: /(today-v2(-empty|-bar)?|connections-v2|system-one|better-search)\.spec\.ts/`; `system1` project `testMatch: /(system-one|better-search)\.spec\.ts/`; add a web server `{ command: "node tests/helpers/fake-embed.mjs", port: embedPort, reuseExistingServer: false, env: { BRAIN_FAKE_EMBED_PORT: String(embedPort) }, timeout: 30000 }` before the sorting server; the sorting server env gains `BRAIN_EMBED_PROVIDER: "ollama", BRAIN_EMBED_MODEL: "fake-concept-v1", BRAIN_EMBED_ENDPOINT: \`http://127.0.0.1:${embedPort}/api/embed\``.

- [ ] Create `tests/e2e/better-search.spec.ts` (runs before `system-one.spec.ts` on the same server; it touches no background preference):

```ts
import { expect, test, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });
test.setTimeout(90_000);

async function open(page: Page) {
  await page.goto("/");
  const code = page.getByLabel("Installation code");
  const bar = page.getByLabel("Save to your brain");
  await expect(code.or(bar)).toBeVisible();
  if (await code.isVisible()) {
    await code.fill("e2e-local-only");
    await page.getByRole("button", { name: "Open my brain" }).click();
  }
  await expect(bar).toBeVisible();
}
const card = (page: Page) => page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Better search" }) });
async function search(page: Page, q: string) {
  await page.getByRole("button", { name: "Your brain", exact: true }).click();
  const field = page.getByPlaceholder("Search facts and originals");
  await field.fill("");
  await field.fill(q);
}

test("Better search is chosen in Settings, finds a note by meaning, and goes back to words only", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Settings & privacy" }).click();
  await expect(card(page)).toBeVisible();
  await expect(card(page).getByRole("status")).toHaveText("Off. Search matches the words you used.");
  const cloud = card(page).getByRole("radio", { name: /^Cloudflare\./ });
  await expect(cloud).toBeDisabled();
  await expect(card(page).getByText("Not set up on this computer.")).toBeVisible();
  const local = card(page).getByRole("radio", { name: /^On this computer \(Ollama\)\. Nothing leaves this computer\./ });
  // The worker publishes its setup a moment after start; the choice enables once it has.
  await expect(local).toBeEnabled({ timeout: 20000 });
  await local.check();
  await card(page).getByRole("button", { name: "Save better search" }).click();
  await expect(page.getByText("Better search saved. Your notes are being prepared in the background.")).toBeVisible();
  await expect(card(page).getByRole("status")).toHaveText(/^On · Ollama on this computer · \d+ of \d+ passages ready/);

  await page.getByRole("button", { name: "Today", exact: true }).click();
  await page.getByLabel("Save to your brain").fill("The crew sync is at 9 every morning.");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText(/kept exactly as you wrote it/i)).toBeVisible();

  // No shared word with the note; only meaning finds it, once the worker has prepared it.
  await expect(async () => {
    await search(page, "when does the stand-up happen");
    await expect(page.getByText(/The crew sync is at 9 every morning/).first()).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 45_000, intervals: [1000, 2000] });
  await expect(page.getByText("Search is using words only right now.")).toHaveCount(0);

  await page.getByRole("button", { name: "Settings & privacy" }).click();
  await card(page).getByRole("radio", { name: /^Off\./ }).check();
  await card(page).getByRole("button", { name: "Save better search" }).click();
  await expect(page.getByText("Better search is off.")).toBeVisible();
  await expect(card(page).getByRole("status")).toHaveText("Off. Search matches the words you used.");
  await search(page, "when does the stand-up happen");
  await expect(page.getByText(/The crew sync is at 9 every morning/)).toHaveCount(0, { timeout: 5000 });
});

test("Better search fits a 320px dark screen", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.emulateMedia({ colorScheme: "dark" });
  await open(page);
  await page.getByRole("button", { name: "Settings & privacy" }).click();
  await expect(card(page)).toBeVisible();
  const fits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(fits).toBe(true);
  const cardFits = await card(page).evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
  expect(cardFits).toBe(true);
});
```
  Adapt the result locator to how `BrainSearch` renders an original (it shows the title and a snippet; the Save bar titles a note from its first words), keeping the `getByText(/The crew sync/)` intent.

- [ ] Run: `npx vitest run tests/integration/better-search-http.test.ts tests/integration/agent-recall-http.test.ts` — expected: pass. Run `npm run build` — expected exit 0. Run `npx playwright test --workers=1 --project=system1` then `git restore docs/screenshots` — expected: the two new tests and the four sorting tests pass.
- [ ] Run: `npm run typecheck && npm run lint` — expected exit 0.
- [ ] Commit: `git add apps/server/app.ts apps/web/src.tsx apps/web/brain/types.ts apps/web/brain/BrainView.tsx apps/web/brain/BrainSearch.tsx playwright.config.ts tests/e2e/better-search.spec.ts tests/integration/better-search-http.test.ts` with message:

```
feat(search): Better search card with named consent, routes and browser journey

Three choices (Off, On this computer (Ollama), Cloudflare) with the
privacy and cost copy per choice, a plain status line, and a words-only
notice in Your brain while the choice cannot work.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
```

---

### Task 7: Golden-set buckets, dense-mode evaluation and CI gates

**Size:** M (Sonnet).

**Files:**
- Modify: `tests/eval/recall-fixture.ts` (four notes after `const prefs = note(...)` line 60)
- Modify: `tests/eval/recall-golden-v1.json` (`"version": 2`; `names` tag on four existing cases; 16 new cases tagged `dense`)
- Modify: `tests/eval/recall.test.ts` (a dense fixture in `beforeAll`/`afterAll`; the BM25-mode "every case" check limited to non-dense cases; a new `describe` with the bucket gates; `golden_version: 2`)
- Modify: `scripts/brain-eval.mjs` (`recall_gates` line 62 names the new gates)
- Existing tests to run (the fixture gained notes): `tests/integration/recall-push.test.ts`, `tests/integration/bibrain-hook.test.ts`, `tests/integration/recall-judge.test.ts`, `tests/integration/agent-recall-http.test.ts`, `tests/integration/ask-recall.test.ts`, `tests/integration/recall-dense.test.ts`, `tests/integration/embed-batch.test.ts`, `tests/integration/recall-embed-lane.test.ts`. A digest assertion that counts originals literally (`"N originals"`) is updated to the new count in the same task.

**Interfaces:**
- Consumes: `embedFixture`, `fakeVector` (task 5), `recallCore(p, input, dense)` (task 5).
- Produces: fixture keys `src:standup`, `src:tamil-office`, `src:allowance`, `src:ticket`; golden tags `dense`, `paraphrase`, `cross-language`, `names`; metrics `dense_paraphrase_recall_at_5`, `dense_cross_language_recall_at_5`, `bm25_paraphrase_recall_at_5`, `bm25_cross_language_recall_at_5`, `bm25_lexical_recall_at_5`, `dense_lexical_recall_at_5`, `bm25_names_recall_at_5`, `dense_names_recall_at_5`, `dense_no_match_rate` in `data/recall-eval-metrics.json`.

**Steps:**

- [ ] Add to `tests/eval/recall-fixture.ts` after line 60:

```ts
  // Plan 5b targets: paraphrase, cross-language and names/ids. Wording chosen so no existing golden query matches these by words.
  note("src:standup", northstar.id, "Morning rhythm", "The crew sync is at 9 every morning.");
  note("src:tamil-office", northstar.id, "புதிய அலுவலகம்", "புதிய அலுவலகம் சென்னையில் திறக்கிறது. குழு ஜனவரியில் நகர்கிறது.");
  note("src:allowance", northstar.id, "Allowance", "The quarterly tooling allowance is two thousand dollars, approved by Ana.");
  note("src:ticket", northstar.id, "Support", "Ticket NS-4471 tracks the login outage; the patch went out in release 2.3.1.");
```

- [ ] Edit `tests/eval/recall-golden-v1.json`: `"version": 2`; add `"names"` to the tags of `pos-03`, `pos-09`, `chunk-01` and `stale-04`; remove the `"paraphrase"` tag from `pos-02` (it shares "launch" and "color" with its note, so it is a lexical case; the bucket must hold exactly the eight dense cases); append these cases (every dense case expects `["found", "partial"]`, `must_exclude: []`, `freshness: {}`):

```json
    { "id": "para-01", "tags": ["dense", "paraphrase"], "principal": "owner", "query": "which hue was chosen for the release", "expect": { "status": ["found", "partial"], "must_include": ["fact:launch-color"], "must_exclude": [], "freshness": {} } },
    { "id": "para-02", "tags": ["dense", "paraphrase"], "principal": "owner", "query": "what is the monthly fee", "expect": { "status": ["found", "partial"], "must_include": ["fact:price"], "must_exclude": [], "freshness": {} } },
    { "id": "para-03", "tags": ["dense", "paraphrase"], "principal": "agent", "query": "who heads up the visuals", "expect": { "status": ["found", "partial"], "must_include": ["fact:marco-role"], "must_exclude": [], "freshness": {} } },
    { "id": "para-04", "tags": ["dense", "paraphrase"], "principal": "owner", "query": "when do people get asked to join the trial", "expect": { "status": ["found", "partial"], "must_include": ["fact:beta-opens"], "must_exclude": [], "freshness": {} } },
    { "id": "para-05", "tags": ["dense", "paraphrase"], "principal": "agent", "query": "food supplier for the celebration", "expect": { "status": ["found", "partial"], "must_include": ["fact:caterer"], "must_exclude": [], "freshness": {} } },
    { "id": "para-06", "tags": ["dense", "paraphrase"], "principal": "owner", "query": "how much can we spend on software each quarter", "expect": { "status": ["found", "partial"], "must_include": ["src:allowance"], "must_exclude": [], "freshness": {} } },
    { "id": "para-07", "tags": ["dense", "paraphrase"], "principal": "owner", "query": "when does the stand-up happen", "expect": { "status": ["found", "partial"], "must_include": ["src:standup"], "must_exclude": [], "freshness": {} } },
    { "id": "para-08", "tags": ["dense", "paraphrase"], "principal": "owner", "query": "how many tiers are offered", "expect": { "status": ["found", "partial"], "must_include": ["fact:stale-pricing-note"], "must_exclude": [], "freshness": {} } },
    { "id": "xl-01", "tags": ["dense", "cross-language"], "principal": "owner", "query": "வெளியீட்டு நிறம் என்ன", "expect": { "status": ["found", "partial"], "must_include": ["fact:launch-color"], "must_exclude": [], "freshness": {} } },
    { "id": "xl-02", "tags": ["dense", "cross-language"], "principal": "agent", "query": "மாத விலை எவ்வளவு", "expect": { "status": ["found", "partial"], "must_include": ["fact:price"], "must_exclude": [], "freshness": {} } },
    { "id": "xl-03", "tags": ["dense", "cross-language"], "principal": "owner", "query": "குழு எப்போது சந்திக்கிறது", "expect": { "status": ["found", "partial"], "must_include": ["src:standup"], "must_exclude": [], "freshness": {} } },
    { "id": "xl-04", "tags": ["dense", "cross-language"], "principal": "owner", "query": "where is the new office", "expect": { "status": ["found", "partial"], "must_include": ["src:tamil-office"], "must_exclude": [], "freshness": {} } },
    { "id": "xl-05", "tags": ["dense", "cross-language"], "principal": "agent", "query": "when does the team move", "expect": { "status": ["found", "partial"], "must_include": ["src:tamil-office"], "must_exclude": [], "freshness": {} } },
    { "id": "xl-06", "tags": ["dense", "cross-language"], "principal": "owner", "query": "அணி எப்போது இடம் மாறுகிறது", "expect": { "status": ["found", "partial"], "must_include": ["src:tamil-office"], "must_exclude": [], "freshness": {} } },
    { "id": "names-01", "tags": ["dense", "names"], "principal": "owner", "query": "NS-4471", "expect": { "status": ["found", "partial"], "must_include": ["src:ticket"], "must_exclude": [], "freshness": {} } },
    { "id": "names-02", "tags": ["dense", "names"], "principal": "agent", "query": "release 2.3.1", "expect": { "status": ["found", "partial"], "must_include": ["src:ticket"], "must_exclude": [], "freshness": {} } }
```
  The names bucket is the six cases tagged `names` (four existing lexical ones plus the two above); it is measured in both modes. `para-04` expects the fact, not the note: the beta chunk is a dense hit too, but `dedupe` folds it into the current fact "Northstar beta opens November 14" that covers it, exactly as plan 5 does for a words hit.

- [ ] Modify `tests/eval/recall.test.ts`:
  - Imports: `import { embedFixture } from "./dense-fixture.ts";` and `import type { QueryVector } from "../../packages/domain/better-search.ts";`.
  - Module state: `let fxDense: Fixture; let denseFor: (q: string) => QueryVector; const denseResults = new Map<string, RecallResult>();`. A helper `const principalOf = (f: Fixture, c: { principal: string }) => (c.principal === "owner" ? owner : f.agent);`.
  - `beforeAll`: after the BM25 loop add `fxDense = buildFixture(join(dir, "dense.sqlite")); ({ dense: denseFor } = embedFixture(fxDense)); for (const c of golden.cases) denseResults.set(c.id, fxDense.brain.recallCore(principalOf(fxDense, c), { query: c.query, history: c.history ?? false, limit: 8 }, denseFor(c.query)));`. `afterAll`: `fxDense.store.close()` before the `rmSync`; `golden_version: 2`.
  - `const bm25Cases = () => golden.cases.filter((c) => !c.tags.includes("dense"));` and in "every case has the expected status and inclusions/exclusions" iterate `bm25Cases()` instead of `golden.cases` (the dense cases are expected to miss by words; that is the point).
  - Append:

```ts
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
```

- [ ] Modify `scripts/brain-eval.mjs` line 62: `recall_gates: "recall@5 ≥ 0.90, MRR ≥ 0.75, no_match ≥ 0.85, replaced/stale/authorization/generic-level hard gates, p95 < 300 ms; with the fake embedder on: paraphrase and cross-language recall@5 ≥ 0.8, lexical and names never worse than words alone, no_match ≥ 0.85, zero leaks; asserted in tests/eval/recall.test.ts",`.

- [ ] Run: `npm run brain-eval` — expected: all eval tests pass, `data/recall-eval-metrics.json` carries the nine new numbers. If `dense_paraphrase_recall_at_5` or `dense_cross_language_recall_at_5` lands under 0.8, adjust the fake lexicon (`tests/helpers/fake-embed.mjs`) or the golden wording, never the gate; if a BM25 sanity bound trips, the case shares a word with its note and must be reworded. Then run the eight integration files listed under Files.
- [ ] Run: `npm run typecheck && npm run lint` — expected exit 0.
- [ ] Commit: `git add tests/eval/recall-fixture.ts tests/eval/recall-golden-v1.json tests/eval/recall.test.ts scripts/brain-eval.mjs` plus any integration test whose count literal moved, with message:

```
test(search): golden buckets for paraphrase, cross-language and names with dense gates

Sixteen new cases (English and Tamil) run against the fake embedder;
paraphrase and cross-language recall@5 >= 0.8, lexical and names never
worse than words alone, negatives stay quiet, zero authorization leaks.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
```

---

### Task 8: Owner-run `scripts/better-search-proof.ts`, `proof:search`, docs, BUILD_STATE and follow-ups

**Size:** M (Sonnet). No behaviour change; the proof is never run by the implementer.

**Files:**
- Create: `scripts/better-search-proof.ts`
- Modify: `package.json` (one line: `"proof:search": "node --import tsx scripts/better-search-proof.ts",` after `proof:recall`)
- Modify: `docs/PROVIDERS.md` (new `### Better search (embeddings, local)` after the Recall help section, line 96; the variable table), `docs/UX.md` (new bullet after line 120 under "Watch and sorting help", and a line under "Your brain" about the words-only notice), `docs/AGENT_INTEGRATION.md` (Recall push section line 25–47: the 400 ms vector wait inside the 1,500 ms budget, `why: ["similar meaning"]`, the term-based level), `docs/API.md` (the two routes), `README.md` ("What you get" bullet; "Optional sorting help" gains a short "Optional better search" subsection with the three env lines; the Status table row), `BUILD_STATE.md` (at-a-glance rows, a new dated section, Next plans)
- Create: `docs/superpowers/plans/2026-10-27-better-search-followups.md` (rulings and deferred minors, the plan 5 follow-ups format)
- Test: `tests/integration/better-search-proof.test.ts` (refusal path only)

**Interfaces:**
- Consumes: `embedFromEnv`, `prepareEmbed`, `buildFixture`, `recall-golden-v1.json`, `pendingEmbedRows`, `writeEmbeddings`, `VectorCache`, `Brain.recallCore`.
- Produces: `npm run proof:search` (owner-run; `BRAIN_SEARCH_LIVE=1` required; exit 0 only when the paraphrase and cross-language buckets reach 0.8 and lexical/names do not regress against words alone; prints model key, calls, estimated tokens, cost in micro-USD, per-bucket recall@5, and the lowest cosine of a wanted hit and the highest cosine of a negative so the owner can judge the 0.45 floor; never the key or account id).

**Steps:**

- [ ] Write the failing test `tests/integration/better-search-proof.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("the better-search live proof", () => {
  it("refuses to run without BRAIN_SEARCH_LIVE=1, prints the owner's instructions, sends nothing and is wired as proof:search", () => {
    const env = { ...process.env };
    delete env.BRAIN_SEARCH_LIVE;
    env.BRAIN_EMBED_PROVIDER = "cloudflare";
    env.BRAIN_CLOUDFLARE_ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
    env.BRAIN_DECISION_API_KEY = "not-a-real-token";
    const run = spawnSync(process.execPath, ["--import", "tsx", "scripts/better-search-proof.ts"], { env, encoding: "utf8", windowsHide: true, timeout: 60_000 });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("BRAIN_SEARCH_LIVE=1");
    expect(run.stdout).toContain("npm run proof:search");
    expect(run.stdout + run.stderr).not.toContain("not-a-real-token");
    expect(existsSync(resolve("data/better-search-proof.json"))).toBe(false);
    const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
    expect(pkg.scripts["proof:search"]).toBe("node --import tsx scripts/better-search-proof.ts");
  });
});
```

- [ ] Run: `npx vitest run tests/integration/better-search-proof.test.ts` — expected failure: the script does not exist (non-zero status).

- [ ] Create `scripts/better-search-proof.ts`:

```ts
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
 * It never prints the key or the account id. Exit 0 only when paraphrase and cross-language reach 0.8 and lexical and names do not regress.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

async function run(): Promise<number> {
  if (process.env.BRAIN_SEARCH_LIVE !== "1") {
    console.log("This proof sends real embedding requests and, with Cloudflare, spends your Workers AI quota.");
    console.log("Run it yourself: put BRAIN_SEARCH_LIVE=1 on its own line in .env and run npm run proof:search,");
    console.log("or in PowerShell: $env:BRAIN_SEARCH_LIVE=1; npm run proof:search, then run Remove-Item Env:BRAIN_SEARCH_LIVE. Remove the line from .env afterwards.");
    return 0;
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
  const dir = mkdtempSync(join(tmpdir(), "better-search-proof-"));
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
        if (name === "negative") {
          const scan = cache.search(fx.store, { vector: v.vector, key, dim, projects: withDense.searched.projects.map((x) => x.id), visibilities: ["project", "private", "owner"], status: "current", floor: -1, limit: 1 });
          if (scan[0]) highestNegative = Math.max(highestNegative, scan[0].score);
          console.log(`  ${c.id}: ${withDense.status} (words: ${plain.status}; nearest cosine ${scan[0] ? scan[0].score.toFixed(2) : "none"})`);
          if (withDense.status === "no_match") dense += 1;
          if (plain.status === "no_match") words += 1;
          continue;
        }
        const scan = cache.search(fx.store, { vector: v.vector, key, dim, projects: withDense.searched.projects.map((x) => x.id), visibilities: ["project", "private", "owner"], status: "current", floor: -1, limit: CANDIDATES_PER_LIST });
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
    rmSync(dir, { recursive: true, force: true });
  }
}

// exitCode, not exit(): piped output is flushed before the process ends.
process.exitCode = await run();
```
  The proof writes no file (the test asserts `data/better-search-proof.json` is absent) and keeps the fixture in a temp folder it deletes.

- [ ] Add the `proof:search` script line to `package.json`.
- [ ] Docs:
  - `docs/PROVIDERS.md`, new section after line 96:

```markdown
### Better search (embeddings, local)

Better search adds meaning to recall: each current passage and fact is turned into a vector by an embedding model, and a question is matched by vector as well as by words. Words stay the backbone and the fallback; with Better search off nothing changes and no model is called.

**Setup.** Read by the background worker only; the key never reaches the server, the browser, a URL or a log. The owner then chooses in Settings ("Better search": Off, On this computer (Ollama), or Cloudflare); the choice names the service and, for Cloudflare, says what is sent and what it costs.

| Variable | Meaning |
| --- | --- |
| `BRAIN_EMBED_PROVIDER` | `ollama` or `cloudflare`. Unset means better search is not set up. |
| `BRAIN_EMBED_MODEL` | Ollama: any pulled embedding model, default `bge-m3`. Cloudflare: `@cf/baai/bge-m3` only. |
| `BRAIN_EMBED_ENDPOINT` | Ollama: a loopback `/api/embed` URL, default `http://127.0.0.1:11434/api/embed`. Cloudflare: local test servers only. |
| `BRAIN_CLOUDFLARE_ACCOUNT_ID`, `BRAIN_DECISION_API_KEY` | Cloudflare only, shared with sorting help. |

- **Ollama.** `POST /api/embed` on this computer; nothing leaves the machine, so private notes are embedded too. Pull the model first (`ollama pull bge-m3`, 1.2 GB).
- **Cloudflare.** Workers AI `@cf/baai/bge-m3` (1024 dimensions, 100+ languages). Private notes, owner-only facts (names, preferences, facts with private evidence) and quarantined notes are never sent and stay words-only. About $0.012 per million tokens, estimated as half the UTF-8 bytes of each text and counted in whole micro-USD against the daily and per-preparation limits through the same spend ledger as sorting help; both limits must be above $0.
- **Model key.** Each vector is stored with `<provider>:<model>:<prefix-scheme>`. A changed provider or model is a new choice in Settings; old vectors are cleared and the preparation starts again. Rows with another key are ignored at search time.
- **Indexing.** A background job embeds up to 32 passages per call outside any transaction; writes are fenced and guarded so an edited note never keeps a stale vector. Capture and edit queue a batch; a rebuild, import or crash is caught by a 5-second check. A failed call waits 60 seconds before the next, doubling to 15 minutes; after three failures in a row better search pauses for 15 minutes and Settings says so. An error response from the service costs nothing; a request that timed out after it was sent keeps its hold. A batch the service refuses is retried one passage at a time, and a passage refused on its own is skipped (words-only) until it changes.
- **Searching.** The query is embedded by the worker (a dedicated lane, at most 400 ms, cached ten minutes); the server scans the vectors the caller may see, keeps cosines of 0.45 or more, and fuses at most 60 of them as a fourth reciprocal-rank list with weight 0.7. Every dense candidate passes the same authorization as every other candidate. An exact name match stays first; the hook push level stays term-based.
- **Status.** The worker publishes whether better search is set up (never the key) and the last outcome; Settings reads it and says "Words only right now: …" when the choice cannot work.

**Live proof is the owner's.** No live embedding call has been made on this branch; tests use a deterministic fake embedder. After setting the variables above, put `BRAIN_SEARCH_LIVE=1` on its own line in `.env` and run `npm run proof:search` (or `$env:BRAIN_SEARCH_LIVE=1; npm run proof:search` in PowerShell, then `Remove-Item Env:BRAIN_SEARCH_LIVE`). It embeds the synthetic golden texts, prints recall at 5 per bucket and the cosine room around the floor, never the key or account id, refuses a loopback Cloudflare endpoint, and exits 0 only when paraphrase and cross-language reach 0.8 with no regression on lexical and names. With Cloudflare it makes about 50 small requests, roughly 3,000 tokens, inside the free daily allowance.
```
  - `docs/UX.md` after line 120: `- **Better search (Settings).** Its own card with three choices: Off (the default; search matches the words you used), "On this computer (Ollama)" (nothing leaves this computer), and "Cloudflare" (the text of notes, searches and the questions connected agents ask is sent to Cloudflare Workers AI to be turned into numbers that stay on this computer; private notes are never sent; about 1 cent per 500,000 words against the daily limit). A choice the computer is not set up for is disabled and says so. The status line reads "Off…", "On · <service> · N of M passages ready" (with "; preparing the rest in the background" while it works), "Words only right now: <reason>", or "Better search paused: the service is not answering." after three failed attempts in a row (it retries by itself after 15 minutes). Changing the choice clears what was prepared and starts again. Hidden in managed mode.` Under "Your brain": `- While Better search is chosen but cannot work, a muted line under the search field reads "Search is using words only right now."`
  - `docs/AGENT_INTEGRATION.md` (Recall push): after the budget sentence add: `When the owner has chosen Better search, the server first asks the worker for the prompt's vector (at most 400 ms, inside the same 1,500 ms budget) and fuses dense candidates before any judge call; a hit found by meaning carries "similar meaning" in its why. The push level stays term-based, so a hit found by meaning alone appears in brain_recall results but does not raise the level.`
  - `docs/API.md`: add `GET`/`PATCH /api/v1/preferences/better-search` (`{ mode: "off" | "ollama" | "cloudflare" }`; owner only; 409 with a plain reason when the worker has not published that provider, the worker is not running, or Cloudflare has no limits).
  - `README.md`: in "What you get" add `- **Better search (optional).** Finds notes by meaning, including across English and Tamil, with Ollama on your computer or Cloudflare. Off by default.`; after the sorting-help subsection add "### Optional better search" with the three env lines and "then choose it in Settings → Better search"; Status table row: `| Better search with embeddings | Built and gated against a fake embedder; a live run is owner-run (\`npm run proof:search\`) |`; update the roadmap line.
  - `BUILD_STATE.md`: at-a-glance rows `| Better search (embeddings via Ollama or Cloudflare) | Off by default; fake-embedder gates in CI; live run owner-run (\`npm run proof:search\`) |` and `Next plans` → cleanup of the paused hosted code (plan 6); a new section `## 2026-10-27 — Better search with embeddings (branch reframe/recall-embeddings)` listing what shipped (one bullet per task), the commands and real counts from the Verification run, and known limits: no live embedding call; the hook level is term-based; the first search of a new question may be words-only when the worker is cold (the vector is cached for the next one); the matrix reloads from SQLite after every index write (fine to about 100k passages, an incremental update is a follow-up); Tamil retrieval quality is unmeasured until the owner's proof; `DENSE_FLOOR` and `DENSE_WEIGHT` are initial values.
  - `docs/superpowers/plans/2026-10-27-better-search-followups.md`: copy the rulings from this plan's Pre-flight self-check and every deferred minor the task reviews produce, in the plan 5 follow-ups format (ruling, why, cost if wrong).

- [ ] Run: `npx vitest run tests/integration/better-search-proof.test.ts` — expected pass (refusal path only; the live proof is never run here).
- [ ] Run the Verification list below in full and paste the real counts into BUILD_STATE.
- [ ] Commit: `git add scripts/better-search-proof.ts package.json docs/PROVIDERS.md docs/UX.md docs/AGENT_INTEGRATION.md docs/API.md README.md BUILD_STATE.md docs/superpowers/plans/2026-10-27-better-search-followups.md docs/superpowers/plans/2026-10-27-better-search.md tests/integration/better-search-proof.test.ts` with message:

```
docs(search): owner-run proof:search, provider and UX docs, build state

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
```

---

## Verification

Run from the worktree root, in this order, and record the real counts in BUILD_STATE:

1. `npm ci` (then `git restore apps/cli/bibrain.mjs` if it shows line-ending-only changes)
2. `npm run typecheck`
3. `npm run lint`
4. `npm run build`
5. `npm audit --audit-level=high`
6. `npm run brain-eval` (expect every eval test green and the nine dense metrics in `data/recall-eval-metrics.json`)
7. `npx vitest run --reporter=dot`
8. `npx playwright test --workers=1` then `git restore docs/screenshots`
9. Key isolation greps (all must print nothing):
   - `grep -rn "BRAIN_DECISION_API_KEY\|OLLAMA_API_KEY\|BRAIN_CLOUDFLARE_ACCOUNT_ID\|BRAIN_EMBED_" apps/server packages/domain apps/web apps/mcp apps/cli`
   - `grep -rn "process.env" packages/storage/recall-vectors.ts packages/providers/embed.ts packages/domain/better-search.ts packages/domain/recall.ts` (the two pre-existing `OPENAI_API_KEY` reads in `service.ts` are not this plan's)
   - `grep -rn "Authorization" apps/web`
   - `grep -rn "recall_vectors_generation\|VECTOR_GENERATION" packages apps tests` (the cache writes no settings row)
10. Behaviour greps: `grep -n "kind NOT IN ('recall_judge','recall_embed')" apps/worker/engine.ts` prints three lines; `grep -c "better_search" apps/web/src.tsx` is 0 (the browser only ever sees `/preferences/better-search`); `grep -rn "proof:search" package.json README.md docs/PROVIDERS.md` prints a line each.
11. `node --import tsx scripts/better-search-proof.ts` without `BRAIN_SEARCH_LIVE` prints the refusal and exits 0 (the only part of the proof an agent runs).
12. `git status --short` shows nothing outside the task commits; `git diff main --stat` touches no `billing*`, `dodo*`, `paddle*`, `managed*` or `decision-advisory*` source file and no `package-lock.json`.

## Pre-flight self-check

Traced each test against the code it exercises, checked every name and anchor against commit `5ecd3e1`, and checked the cross-task contracts, the spec rulings and AGENTS.md. Fixes applied to the plan and rulings made on the owner's behalf:

- **Verified names and anchors.** `recall_chunks` already carries `embedding BLOB, embedding_model TEXT, embedding_dim INTEGER` and `recallCountsForSource` already counts `embedded` rows (no migration bump; the new index rides in `RECALL_DDL` under `IF NOT EXISTS`). `Storage.setting/set/transaction/run/get/all`, `Brain.enqueue(project, kind, payload)`, `Brain.prefs`, `recallHelp/setRecallHelp` (lines 1882–1899), `awaitRecallJudge` (3603–3623), `recallInternal` (3683–3754) with `lists` at 3707–3712 and the `fuse` loop at 3718, `searchBrain` 4888, `ask` 4915, the two job lists at 5052 and 5110 and `job()` at 5117, `Worker.lease()` 116, `schedule()` 157–163, the `system_one_route` branch 260–279, `main.ts` local branch 489–535, `app.ts` recall-help routes 840–841 and search/ask 797–799, `src.tsx` card at 1426 and `<BrainView` at 1056, `BrainView.tsx` 116, `playwright.config.ts` ports and the `system1` project: all present as named. `hash` (`packages/domain/logic.ts`) and `detectSecrets` are already imported in `service.ts`; `randomUUID` too.
- **Test traces.** Task 1: every `embedFromEnv` reason string in the table matches the regexes (`/account id/i`, `/token/i`, `/@cf\/baai\/bge-m3/`, `/test server/i`, `/this computer/i`, `/model name/i`); the Cloudflare reserve for 1,000 bytes is `ceil(500 × 12,000 / 1e6) = 6`; the LE bytes of `1.0f` are `00 00 80 3f`; Float32 of 0.6/0.8 round to the asserted doubles. Task 2: the guarded UPDATE with `ref_version: 99` changes nothing, so `changed === 2`; after `clearEmbeddings` the cache sees the bump through the stored generation even from a second `Storage` handle. Task 3: the fixture plus 40 fillers exceeds 32 rows; the launch-notes prefix is `Launch notes · Northstar · 2026-10-25`; the retry loop hits `failed` on the third attempt because `retry` needs `attempts < max_attempts`; `maybeQueueEmbedBatch` stays false for 60 s from the failed job's `created_at`. Task 4: the "late answer" case relies on the server's give-up leaving a `running` job alone (its cancel targets `queued` only), so the worker publishes to nothing and feeds the cache; the sweep case was traced line by line. Task 5: with the fake lexicon, "which hue was chosen for the release" scores 0.78 against the launch-color fact and the BM25 hit on "release" (the ticket note) can outrank it in RRF, so owner-screen assertions use membership, not `hits[0]`; `pos-09` keeps `fact:status-new` first through `pinExact`. Task 7: paraphrase and cross-language cosines computed by hand all exceed 0.5 (lowest: `para-07` at 0.53, `xl-06` at 0.55); every negative stays under 0.45 (highest: `neg-01` at 0.37); no new note shares a stemmed word with an existing negative query.
- **Fixes to Tasks 1–2 made during this check.** (1) The fake-embedder geometry test and the lexicon were aligned with the final fixture wording: `src:standup` is titled "Morning rhythm" with body "The crew sync is at 9 every morning." (the earlier "Team rhythm" title made `replaced-05` ("team on leave") see a third BM25 original and risked its `found` status; "crew" carries the team concept for the Tamil case without the word), and `src:allowance` is titled "Allowance" (a "Spending" title would have matched `para-06`'s "spend" by words). (2) "rollout" was removed from the launch concept group and "fix"/"budget" were kept out of the lexicon so `neg-04`, `neg-07` and `neg-02` stay under the floor. (3) `fakeEmbedFetcher` reads its options object at call time, so tests can flip `status`/`delayMs` mid-run (tasks 3 and 4 rely on it). (4) `recall-key-isolation` now also guards `BRAIN_CLOUDFLARE_ACCOUNT_ID` and `BRAIN_EMBED_`.
- **Cross-task contracts.** `EmbedClient`, `publishBetterSearchStatus`, `noteEmbedStatus` (task 1) are consumed unchanged by tasks 3, 4 and 5; `pendingEmbedRows/writeEmbeddings/countEmbedRows/clearEmbeddings/VectorCache` (task 2) by tasks 3, 5, 7 and 8; `betterSearchAllowed/betterSearchSetting/enqueueEmbedBatch` (task 3) by tasks 4 and 5; `queryVector` (task 4) by task 5; `recallCore(p, input, dense)` (task 5) by tasks 7 and 8; `embedFixture/fakeVector` (task 5) by task 7. The service imports are added incrementally (task 3: `clearEmbeddings, countEmbedRows` and the better-search constants; task 4: the lane keys and `QueryVector`; task 5: `VectorCache`, `denseFloor`, `pinExact`, `denseWhy`, `RecallLists`).
- **Spec rulings honoured.** B1 own setting, three choices, copy per choice, change requires choosing again (`setBetterSearch` clears on any mode/key change; the card says so). B2 two providers, plain fetch, loopback-only Ollama, Cloudflare reuses the two existing variables, worker-only key, key-free status. B3 key format, stale rows ignored and re-embedded, mixed reads refused (one key and dim per scan). B4 current rows only, Cloudflare visibility filter, 2,000 code points. B5 32 rows, call outside transactions, fenced + guarded writes, capture/edit enqueue, on backfills, off/change clears, ledger with the shared cap at $0.012/M tokens in micro-USD. B6 worker-only query embedding, `recall_embed` fast lane, 400 ms, 10-minute cache, candidates before the judge, 1,500 ms budget. B7 weight 0.7, floor 0.45 per model, 60 candidates, pin, same authorization, plan 5 invariants (`fuse` with no dense list is byte-identical; dense-only candidates never make `strong`). B8 Float32 LE normalised, dot-product scan, generation-keyed cache. B9 owner screens use dense, judge stays off them. B10 purge/forget proof already true, rebuild re-queued by the 5-second check. B11 three buckets with the stated sizes, fake embedder, the stated gates, owner-run proof. B12 no off-limits file touched, `/context` and `/changes` untouched, no dependency.
- **Rulings made (spec gaps).** (R1) Where the spec names the Cloudflare cap but not which limits: Cloudflare better search needs `daily_cap_micro_usd` and `per_job_cap_micro_usd` above 0 (the ledger's own limits) but not background help or sorting consent; Ollama needs nothing. (R2) The push level stays term-based: a dense-only hit reaches `brain_recall` and the owner's screens but does not raise the hook level (spec B7 "every plan 5 invariant unchanged"; revisit from the recall log). (R3) `BRAIN_EMBED_PROVIDER` selects exactly one provider, like `BRAIN_SYSTEM1_PROVIDER`; the Settings card shows all three choices and disables the one the computer is not set up for with "Not set up on this computer." (R4) Cloudflare query embedding also goes through the ledger (`recall_embed`) so every paid call is bounded; an Ollama query lane job near its deadline still runs because its answer is free and feeds the cache. (R5) Ollama and Cloudflare are called with `truncate`/`truncate_inputs: true` so an overlong passage never blocks a batch (the embedded text is already capped at 2,000 code points). (R6) A secret-shaped passage is "withheld": `embedding_model` set, `embedding` NULL, never sent, never searched, never retried until the key changes. (R7) Cloudflare settles at the reported token count when the response carries one, else at the estimate; a reported cost above the reserve settles the known cost and fails the batch. (R8) `recall_embed` rows older than an hour with no ledger reference are deleted by the sweeper (judge rows keep their plan 5 behaviour). (R9) The model/env change case is handled by consent, not by clearing: the stored key no longer matches the published key, the card says "The search model changed. Choose Better search again.", nothing runs, and choosing again clears and re-embeds. (R10) `RecallResult` gains no field (the MCP `outputSchema` is unchanged); dense shows as `why: "similar meaning"` and `dense: true` in the content-free recall log. (R11) `ask` and `searchBrain` become `async` so the owner's screens can wait for the vector; four test files are updated in the same task. (R12) The matrix reloads after every index write (spec B8 literally); the incremental update is a recorded follow-up.
- **AGENTS.md.** Authorization before retrieval (scope filter) and again per hit; model output validated (vector shape, count, finiteness, key, dim); no model call inside a transaction; short transactions; durable queue with lease recovery and idempotent, guarded writes; integer micro-USD; deterministic clocks in tests; no secrets in web, URLs, logs or fixtures (the test key is assembled at runtime); quiet is a product state (floor, negatives bucket); every visible control has real behaviour or a labelled unavailable state; failed and offline states surface in plain language (status line, "Words only right now", "Last problem"); no `package.json` change beyond one script; owner-run proofs are never run by agents.

## Pre-flight resolutions

The independent scan (`.superpowers/sdd/2026-10-27-better-search/preflight.md`) applied all eight tasks in a scratch copy; the controller's rulings are in `progress.md`. Every id below was fixed in place in the task texts above; where the self-check above says otherwise (the settings-key generation under R12 and "Cross-task contracts"), this section supersedes it.

- **B-01** `let rows: any` in `perform` (`fail` is a const arrow, so `unknown` is never narrowed). Task 1 code.
- **B-02** `acceptStatus` returns `{ claim_id, source_id }`; the T2 test expects the third project-visible source (cloud list 3, local list 5, counts `{ total: 3, embedded: 1, pending: 1, withheld: 1 }`, OTHER length 3) and gains the rejected-row and no-settings-row assertions.
- **B-03** Expected order `[a, e, b]` (cosines 1.00, 0.99, 0.60).
- **B-04** Both sub-cases tick until the provider has been called once (`while (t.calls.n < 1) …`), so the edit hook and the fence really run; the fence case also asserts exactly one call.
- **B-05** A `t.advance(ms)` helper moves the clock and refreshes the heartbeat (the worker is "running" for 30 s only); every clock move in the T3 tests goes through it.
- **B-06** The late-answer case asserts only that no query text remains (`recall_embed:%`) and that the cache holds the vector; the stale result row is the sweeper's (comment explains the fixed-clock artefact).
- **B-07** `"statu"` added to the status concept group. Re-checked in scratch with the plan's own `fake-embed.mjs`: "Northstar status" vs the status notes = 0.56 (dense list non-empty, `pinExact` runs; the status fact rows themselves score 0.08, so the pin is what keeps `fact:status-new` first).
- **B-08** Ask-bar assertion is membership (`hits.map(id)` contains the fact); the plan's own self-check already said so.
- **B-09 / I-04** `searchBrain` asks for the vector first; the short-word guard applies only without one, the literal list stays the fallback when the query has no searchable words or recall returns nothing (test: "what is the monthly fee" finds `fact:price` with dense on; "zq xk" still falls back to the literal list). The dense-off path is byte-identical to plan 5.
- **B-10** `{!available ? … : null}` (TS narrows `mode` through the alias).
- **B-11** `pos-02` loses its `paraphrase` tag (it is lexical); the paraphrase bucket is exactly the eight dense cases, in the test and in the proof script.
- **B-12** `para-04` expects `fact:beta-opens` (dedupe folds the beta chunk into the fact that covers it; scratch cosine of the fact row 0.46, the chunk 0.62 per the scan).
- **B-13** No settings write on any index write. `vectorGeneration()`/`bumpVectorGeneration()` are an in-process counter; `VectorCache.load` also reads `PRAGMA data_version` (checked in scratch on `node:sqlite`: own commits leave it unchanged, another connection's commit moves it), so the worker's vectors invalidate the server's cache with zero writes; `VECTOR_GENERATION` is gone; both managed migration tests are in T2's run list untouched; the T2 and T3 tests assert that no `%vector%`/`%generation%` settings key ever exists.
- **I-01** Outage safety as ruled: an HTTP error response or a Cloudflare error envelope throws `EmbedError` with `actual_cost_micro_usd: 0` and is settled at 0; a timeout after send keeps its hold; `recordFailure` backs off 60 s doubling to 15 min (`retry_at`) and opens the breaker after three consecutive failures (`paused_until`, 15 min, status line "Better search paused: the service is not answering." through `betterSearchAllowed`, which also stops the query lane); `embedQueueOpen()` gates the capture hooks, the self-heal check and the batch itself, so nothing is queued or sent while the back-off runs; the job is never retried (`failed` at once; a Cloudflare job cannot be re-sent under one dispatch key). Tests: T3 "the self-heal check queues a batch after a rebuild; failures back off 60 s then 120 s, the third pauses…" (Ollama) and "Cloudflare: an error response settles its hold at 0, a timeout after send keeps it…" (ledger states `["settled", "dispatched"]`, unresolved hold under the per-job cap, no second call during the back-off however many notes are captured).
- **I-02** A batch refused with a 4xx (`EmbedError.upstream_status`) is retried row by row under dispatch keys `embed_batch:<row id>`; a row refused alone is withheld with `embedding_dim = -1` ("rejected") and skipped until its text changes (new row); other rows embed; the status says how many passages were refused. Test: T3 "a passage the service refuses is retried alone, withheld as rejected, and never blocks the rest" (fake `reject` option; dispatch rows per single call; the edit re-embeds).
- **I-03 / C1** Cloudflare consent copy names "the questions your connected agents ask" (card, UX doc). Spec B1's copy is superseded by this plan's copy; the spec file itself is not edited by this plan.
- **I-04 / C4** see B-09.
- **I-05** The HTTP test pairs the owner (`/api/v1/session/pair`, cookie + CSRF as in `brain-search.test.ts`), asserts the paired `GET` shape, the domain's 409 on a provider the worker has not published, a 200 for off, 400 for a bad mode, and the agent-token refusal; its red step is a real 404.
- **I-06** `runEmbedBatch` catches its own faults (only `AccountingPersistenceError` escapes), so an indexing job never writes a failed receipt into Today; the engine branch has no retry arithmetic.
- **I-08** `queueEmbedIfOn()` is also called after the `syncSource` in `recordSystemOneResult` (line 4567). The double embedding of a note that sorting help re-syncs is accepted and recorded in the follow-ups (one extra batch row per sorted note under Cloudflare).
- **I-13** Proof header and PROVIDERS say about 50 requests, roughly 3,000 tokens.
- **I-15** Left: the cache is bounded by scope count, not bytes, and any commit from another connection reloads the matrix; recorded in the follow-ups (bound by bytes; incremental update).
- **I-18** `searchRecallChunks` selects explicit columns (T2), so BM25 rows never carry their vector.
- **I-19** `fromBm25(top)` on the fact branch too; with no dense list it is always true, so plan 5 output is unchanged (domain test covers both).
- **A6** T5 adds only `denseFloor` to the better-search import (`QueryVector` came with T4).
- **A11** `apps/web/brain/types.ts` is in T6's Files and commit; `BrainProps.searchNote`.
- **C3** Cost copy "about 1 cent for every 500,000 words" (card, UX doc).
- **C5** `queueEmbedIfOn` enqueues only when `embedQueueOpen()` (published setup matches the stored key, worker up, not paused, back-off passed); the T3 "changed model" case asserts no job is queued.
- **C6** Only the local job list (line 5110) and `job()` change; the managed branch SQL at 5052 is untouched.
- **C7** Verification grep 9 is restricted to this plan's files for `process.env` and gains a grep proving no `recall_vectors_generation`/`VECTOR_GENERATION` survives.
- **Scratch runs for this pass:** `PRAGMA data_version` semantics on `node:sqlite` with two connections; the plan's `fake-embed.mjs` extracted and run over the pinned pairs (above-floor: 0.77, 0.53, 0.77, 0.54, 0.64, 0.46, 0.56; below-floor: 0.00, 0.00, 0.00, 0.37, and "team on leave" vs the Tamil note 0.39). Everything else in this section was re-traced by hand against the code it names.
- **New rulings made here:** (R13) `embedQueueOpen()` is one Brain method the hooks, the self-heal check and the batch share, so a batch queued before a failure also waits for the back-off (otherwise a capture during an outage would send a call). (R14) A ledger refusal (limits gone, lease lost) is `cancelled` and does not count toward the breaker; only provider failures and unknown outcomes do. (R15) The breaker also stops the query lane (`betterSearchAllowed` is off while paused), so owners do not wait 400 ms per search against a dead service. (R16) The withheld reason is persisted as `embedding_dim = -1` for "rejected" (NULL for "secret") rather than a new column: no migration, and the search never reads withheld rows.
