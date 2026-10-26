# Plan 5b design: better search with embeddings

Date: 2026-10-27. Branch: `reframe/recall-embeddings`. Status: approved by the owner's "plan 5b and 6 go ahead".

## Why

Plan 5 made agents retrieve, and owner-run proofs confirm it in Claude Code and Codex. Recall is still lexical: FTS5 BM25 over chunks and facts, fused with reciprocal rank fusion (RRF). As a result:

- A question worded differently from the note can miss it. "When does the stand-up happen?" will not find "daily sync is at 9".
- So can a question in another language. The owner may write in English or Tamil.

Plan 5b adds dense embeddings as one more ranked list. BM25 stays the backbone and the fallback.

Research is in the session scratchpad and summarised here:

- **In-process models are not viable.** transformers.js needs `onnxruntime-node`, which is about 300 MB unpacked with native binaries plus `sharp`. That is too heavy for a repo that has shipped with zero new runtime dependencies.
- **Ollama Cloud serves no embedding models.**
- **Cloudflare Workers AI `@cf/baai/bge-m3`** works:
  - 1024 dimensions, more than 100 languages, MIT licence;
  - about $0.012 per million tokens, with a free daily allowance;
  - no query or document prefixes.
- **Local Ollama `/api/embed`** works with `bge-m3` (1.2 GB) or `embeddinggemma` (622 MB). It returns L2-normalised vectors, and nothing leaves the machine.
- **Brute-force cosine in JavaScript is fast enough.** Measured on Node 24.19: 8 ms at 10k × 384 and about 196 ms at 100k × 1024. sqlite-vec is pre-v1 and needs extension loading, so skip it.
- **Dense retrieval is weak on rare names and ids.** Keep the BM25 exact-name precedence and add a cosine floor so weak matches stay quiet.

## What success looks like

1. With "Better search" off (the default), behaviour is exactly as plan 5 shipped, and no model is called.
2. With it on, recall also finds paraphrased and cross-language notes, measured by a golden set split into buckets: lexical, paraphrase, cross-language, names/ids, and no-answer. The lexical and names/ids buckets never get worse.
3. The key stays worker-only. Spending is bounded. Note text leaves the machine only with consent that names the service, and never for private notes sent to a cloud service.
4. Indexing never blocks search. Missing or stale embeddings fall back to BM25, which is always available.

## Rulings

- **B1. Off by default.** "Better search" is its own setting, `better_search`, stored the way `recall_help` is: outside the managed preferences schema, with an owner-only route. Its Settings card has three choices: Off, "On this computer (Ollama)", and "Cloudflare". Copy for each:
  - **Ollama:** says nothing leaves the computer.
  - **Cloudflare:** names Cloudflare, says the text of notes and searches is sent there to be turned into numbers, notes that private notes are never sent, and gives the cost.
  - **Any change** of source or model requires choosing again.
- **B2. Two sources, no new npm dependency.** Both are plain `fetch` calls from the worker.
  - **`ollama`:** the endpoint must be loopback; default `http://127.0.0.1:11434/api/embed`, default model `bge-m3`.
  - **`cloudflare`:** `@cf/baai/bge-m3`. It reuses `BRAIN_CLOUDFLARE_ACCOUNT_ID` and `BRAIN_DECISION_API_KEY`, which remain worker-only, so `scripts/run.mjs` keeps stripping the key from the server.
  - **Environment:** `BRAIN_EMBED_PROVIDER` (`ollama` | `cloudflare`), `BRAIN_EMBED_MODEL` and `BRAIN_EMBED_ENDPOINT` (loopback only, Ollama only).
  - **Status:** the worker publishes a key-free `better_search_status`, the way `system_one_status` works.
- **B3. Model key.** Each embedded row stores `embedding_model = "<provider>:<model>:<prefix-scheme>"` and `embedding_dim`.
  - A row whose key differs from the configured key is stale. It is ignored at query time and re-embedded in the background.
  - Mixed-model reads are refused.
- **B4. What gets embedded.**
  - Current original chunks and fact rows, the same rows the BM25 index holds.
  - Cloudflare never receives text from a `private` source, an `owner`-visibility fact, or a quarantined note. Those rows stay BM25-only under Cloudflare.
  - Ollama on loopback embeds everything, because nothing leaves the machine.
  - The text embedded is the chunk prefix plus the chunk text, capped at 2,000 code points.
- **B5. Background indexing.**
  - A worker job, `embed_batch`, embeds up to 32 rows per call.
  - The provider call happens outside any transaction.
  - Writes are fenced and check the row's `ref_version`, so an edited source never gets a stale vector.
  - Capture and edit enqueue the affected rows. Turning the setting on backfills in batches. Turning it off, or changing the source or model, clears all vectors.
  - Cloudflare spend goes through the existing `DispatchLedger`: reserve, mark, execute, settle. It shares the daily cap. Cost is estimated at $0.012 per million tokens, priced as integer micro-USD.
- **B6. Query embedding.**
  - Query embedding needs the worker, because the Cloudflare key lives there and the Ollama endpoint is configured there.
  - It reuses the judge's fast-lane pattern with a new job kind, `recall_embed`: a dedicated worker loop, a 400 ms server wait, and a deterministic fallback to BM25 only.
  - The worker caches query vectors by `sha256(model key + query)` for 10 minutes.
  - When the judge is also on, the server builds the candidate list (BM25 plus dense) before it enqueues the judge. Total hook budget stays at 1,500 ms.
- **B7. Fusion.**
  - Dense becomes a fourth RRF list with weight 0.7 (`DENSE_WEIGHT`, k = 60).
  - Only hits at or above a cosine floor (`DENSE_FLOOR`, 0.45 for bge-m3, kept per model) enter the list.
  - At most 60 dense candidates.
  - An exact entity or name match stays pinned as in plan 5.
  - Dense candidates go through exactly the same authorization: the SQL scope filter, then a per-hit `source()` and `visibleClaim` re-check.
  - Freshness, de-duplication and every plan 5 invariant are unchanged.
- **B8. Storage and search.**
  - Store Float32 little-endian vectors, normalised at write time, in the existing `embedding` column.
  - Search scans the scope-filtered rows with the current model key, comparing by dot product.
  - Cache an in-process vector matrix per (scope, model key, index generation). Any index write bumps the generation and invalidates the cache.
- **B9. Owner screens.** The Ask bar and Your brain search use dense candidates when Better search is on, because the owner chose it. The Clef judge stays off the owner's screens (plan 5 R1 is unchanged).
- **B10. Forget and rebuild.**
  - Purging a source removes its vectors along with its rows (already true).
  - The forget proof counts embedded rows (already true).
  - `rebuild()` drops vectors and re-queues them in the background when enabled.
- **B11. Evaluation.**
  - The golden set gains buckets: paraphrase (8 cases), cross-language (English and Tamil, 6 cases), and names/ids (6 cases, where dense must not hurt).
  - **CI fake embedder:** CI uses a deterministic fake embedder (`tests/helpers/fake-embed.mjs`). It maps text to vectors through a small fixed concept lexicon (synonym groups and English–Tamil pairs), so the mechanics are tested: fusion, floors, pinning, authorization, staleness, fallback.
  - **CI gates:** with dense on, recall at 5 on paraphrase and cross-language is at least 0.8. Lexical and names/ids buckets do not regress against BM25 only. Zero authorization leaks.
  - **Live quality** is measured by an owner-run `npm run proof:search` with the real provider on the same golden texts. It is guarded like the other proofs and never run by agents or CI.
- **B12. Boundaries.**
  - No change to billing, managed, Dodo, Paddle or decision-advisory code.
  - No change to `/api/v1/context` or `/api/v1/changes`.
  - No new runtime dependency.
  - Plan 6 (dead-code cleanup) runs after this plan.

## Out of scope

- In-process ONNX models.
- sqlite-vec or approximate nearest-neighbour search.
- Re-ranking with a cross-encoder.
- Embedding older source versions.
- Hosted-edition embeddings.
