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
