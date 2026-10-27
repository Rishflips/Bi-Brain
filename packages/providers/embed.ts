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
