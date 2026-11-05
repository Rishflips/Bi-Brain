import { OLLAMA_EMBED_ENDPOINT, type ProbeOutcome } from "../domain/better-search.ts";

export type OllamaProbe = { found: true; outcome: "found" } | { found: false; outcome: Exclude<ProbeOutcome, "found" | "skipped"> };
/** One request, inside this budget, at most this many bytes. */
export const OLLAMA_PROBE_MS = 1500;
export const OLLAMA_PROBE_MAX_BYTES = 1_048_576;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** The tags URL for an embed endpoint, or null unless the endpoint is plain http on loopback with no credentials. Nothing else is ever probed. */
export function ollamaTagsUrl(endpoint: string): string | null {
  try {
    const u = new URL(endpoint);
    if (u.protocol !== "http:" || !LOOPBACK.has(u.hostname) || u.username || u.password) return null;
    return `${u.origin}/api/tags`;
  } catch {
    return null;
  }
}

/** Whether a tags listing names the model: the exact name, or `<model>:<tag>` when the configured name carries no tag (Ollama lists `bge-m3:latest` after `ollama pull bge-m3`). */
export function modelListed(body: unknown, model: string): boolean {
  const models = body && typeof body === "object" && !Array.isArray(body) ? (body as { models?: unknown }).models : undefined;
  if (!Array.isArray(models)) return false;
  const tagged = model.includes(":");
  return models.some((m) => {
    const name = m && typeof m === "object" ? (m as { name?: unknown }).name : undefined;
    return typeof name === "string" && (name === model || (!tagged && name.startsWith(`${model}:`)));
  });
}

/** Reads at most `max` bytes of a body and cancels the stream past that; null when the body is over the bound or missing. */
async function boundedText(res: Response, max: number): Promise<string | null> {
  if (Number(res.headers.get("content-length") ?? 0) > max) return null;
  if (!res.body) return null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * One loopback GET inside the budget. The deadline is the probe's own timer, raced against the call and the body read, so a
 * fetcher that ignores its signal cannot hold the worker. Never throws, never retries; nothing from the body is kept beyond the answer.
 */
export async function detectOllamaModel(opts: { endpoint?: string; model: string; fetcher?: typeof fetch; timeoutMs?: number }): Promise<OllamaProbe> {
  const url = ollamaTagsUrl(opts.endpoint ?? OLLAMA_EMBED_ENDPOINT);
  if (!url) return { found: false, outcome: "no_ollama" };
  const fetcher = opts.fetcher ?? fetch;
  const ms = opts.timeoutMs ?? OLLAMA_PROBE_MS;
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("probe timeout"));
    }, ms);
    timer.unref?.();
  });
  const call = (async (): Promise<OllamaProbe> => {
    const res = await fetcher(url, { method: "GET", signal: controller.signal, redirect: "error" });
    if (!res.ok) return { found: false, outcome: "no_ollama" };
    const text = await boundedText(res, OLLAMA_PROBE_MAX_BYTES);
    if (text === null) return { found: false, outcome: "no_ollama" };
    return modelListed(JSON.parse(text), opts.model) ? { found: true, outcome: "found" } : { found: false, outcome: "no_model" };
  })();
  try {
    return await Promise.race([call, deadline]);
  } catch {
    return { found: false, outcome: "no_ollama" };
  } finally {
    clearTimeout(timer);
    // A late rejection from the call after the deadline won must not become an unhandled rejection.
    call.catch(() => {});
  }
}
