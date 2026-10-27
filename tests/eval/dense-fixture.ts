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
