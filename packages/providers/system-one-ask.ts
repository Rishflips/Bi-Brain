import { createHash } from "node:crypto";
import { detectSecrets } from "../storage/secrets.ts";
import {
  PROBABILITY_SUM_TOLERANCE,
  REQUEST_OVERHEAD_BYTES,
  SystemOneError,
  resolveSystemOneConfig,
  type ResolvedSystemOneConfig,
  type SystemOneConfig,
} from "./system-one.ts";

/**
 * Several typed questions about one bounded state, in ONE Clef/Jev request.
 * Answers are validated against exactly the offered questions and options; any
 * deviation rejects the whole result. Passing validation proves shape only, not
 * correctness, so every caller keeps the answers advisory.
 */
export const ASK_POLICY_VERSION = "system-one-ask-v1" as const;
const ID = /^[A-Za-z0-9_.-]{1,64}$/u;
const MAX_QUESTIONS = 16;
const MAX_OPTIONS = 32;
const MAX_STATE = 60_000;
const EPSILON = 1e-9;

export type AskQuestion =
  | { id: string; type: "choice"; instructions: string; options: { id: string; description: string }[] }
  | { id: string; type: "noul"; instructions: string };
export type AskAnswer =
  | { id: string; type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { id: string; type: "noul"; probability: number };
export type AskResult = {
  answers: AskAnswer[];
  model: string;
  usage: { input_tokens: number; output_tokens: number };
  cost_micro_usd: number;
  price_version: string;
  policy_version: typeof ASK_POLICY_VERSION;
};
export type PreparedAsk = {
  json: string;
  bytes: number;
  request_hash: string;
  config_hash: string;
  reserved_micro_usd: number;
  model: string;
  provider: string;
  price_version: string;
  execute(signal: AbortSignal): Promise<AskResult>;
};

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const bad = (message: string): never => {
  throw new SystemOneError("INVALID_INPUT", message, 400, false);
};

function checkQuestions(questions: AskQuestion[]) {
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > MAX_QUESTIONS) bad("Ask between 1 and 16 questions.");
  const ids = new Set<string>();
  for (const q of questions) {
    if (!ID.test(q.id) || ids.has(q.id)) bad("Question ids must be short and distinct.");
    ids.add(q.id);
    if (typeof q.instructions !== "string" || !q.instructions.trim() || q.instructions.length > 4000) bad("Each question needs short instructions.");
    if (q.type === "choice") {
      if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > MAX_OPTIONS) bad("A choice needs 2 to 32 options.");
      const seen = new Set<string>();
      for (const o of q.options) {
        if (!ID.test(o.id) || seen.has(o.id)) bad("Option ids must be short and distinct.");
        if (typeof o.description !== "string" || !o.description.trim() || o.description.length > 1000) bad("Each option needs a short description.");
        seen.add(o.id);
      }
    } else if (q.type !== "noul") bad("Only choice and yes/no questions are supported.");
  }
}

export type AskConfig = SystemOneConfig | (Omit<SystemOneConfig, "provider"> & { provider: "ollama" });

const OLLAMA_MODEL = /^(clef|clef-flash)(:[A-Za-z0-9_.-]{1,40})?$/u;
const OLLAMA_LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Resolves a config for the ask transport. Non-Ollama providers use the
 * existing resolver unchanged. Ollama serves the plain Jev format (no
 * Cloudflare envelope) at /v1/systemone, either on ollama.com (key required)
 * or a loopback Ollama. The shared price, key, timeout, byte-bound and
 * accepted-model checks are reused by resolving a loopback surrogate with
 * `resolveSystemOneConfig`, then restoring the real endpoint.
 */
export function resolveAskConfig(config: AskConfig): ResolvedSystemOneConfig {
  if (config.provider !== "ollama") return resolveSystemOneConfig(config);
  const refuse = (message: string): never => {
    throw new SystemOneError("PROVIDER_UNAVAILABLE", message, 503, false);
  };
  const endpointMessage = "The Ollama endpoint must be https://ollama.com/v1/systemone or a local Ollama.";
  let url: URL | undefined;
  try {
    url = new URL(config.endpoint);
  } catch {
    refuse(endpointMessage);
  }
  const u = url as URL;
  const loopback = u.protocol === "http:" && OLLAMA_LOOPBACK_HOSTS.has(u.hostname);
  const official = u.protocol === "https:" && u.hostname === "ollama.com" && u.port === "";
  if (u.username || u.password || u.search || u.hash || u.pathname !== "/v1/systemone" || !(loopback || official)) refuse(endpointMessage);
  if (typeof config.model !== "string" || !OLLAMA_MODEL.test(config.model)) refuse("The Ollama model must be clef or clef-flash.");
  if (official && (config.key === undefined || config.key === null)) refuse("A server-side credential is required for remote dispatch.");
  if (config.price?.output_micro_usd_per_million !== 0) refuse("The Ollama output price must be exactly 0.");
  const accepted = config.accepted_response_models ?? [...new Set([config.model, config.model.split(":")[0]])];
  const base = resolveSystemOneConfig({
    ...config,
    provider: "typesafe",
    endpoint: "http://127.0.0.1/v1/systemone",
    accepted_response_models: accepted,
  });
  // The real provider is "ollama"; ResolvedSystemOneConfig only names the older kinds.
  return { ...base, provider: "ollama" as unknown as ResolvedSystemOneConfig["provider"], endpoint: config.endpoint, url: u, loopback };
}

export function prepareAsk(config: AskConfig, state: string, questions: AskQuestion[], fetcher: typeof fetch = fetch): PreparedAsk {
  const resolved = resolveAskConfig(config);
  if (typeof state !== "string" || !state.trim() || state.length > MAX_STATE) bad("The state is empty or too long.");
  checkQuestions(questions);
  const checked = [state, ...questions.flatMap((q) => [q.instructions, ...(q.type === "choice" ? q.options.map((o) => o.description) : [])])].join("\n");
  if (detectSecrets(checked).length > 0) bad("This content looks like it may contain a secret, so it was not sent.");
  const json = JSON.stringify({
    model: resolved.model,
    state,
    questions: Object.fromEntries(
      questions.map((q) => [
        q.id,
        q.type === "choice"
          ? { type: "choice", instructions: q.instructions, criteria: Object.fromEntries(q.options.map((o) => [o.id, o.description])) }
          : { type: "noul", instructions: q.instructions },
      ]),
    ),
  });
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > resolved.max_request_bytes) bad("The request is larger than the configured limit.");
  const micro = (bytes + REQUEST_OVERHEAD_BYTES) * resolved.price.input_micro_usd_per_million + resolved.max_response_bytes * resolved.price.output_micro_usd_per_million;
  if (!Number.isSafeInteger(micro)) bad("The cost bound is out of range.");
  const reserved = Math.ceil(micro / 1_000_000);
  return {
    json,
    bytes,
    request_hash: sha(json),
    config_hash: sha(JSON.stringify({
      p: resolved.provider,
      e: resolved.endpoint,
      m: resolved.model,
      v: resolved.price.version,
      pi: resolved.price.input_micro_usd_per_million,
      po: resolved.price.output_micro_usd_per_million,
      t: resolved.timeout_ms,
      rq: resolved.max_request_bytes,
      rs: resolved.max_response_bytes,
    })),
    reserved_micro_usd: reserved,
    model: resolved.model,
    provider: resolved.provider,
    price_version: resolved.price.version,
    execute: (signal) => run(resolved, json, questions, reserved, fetcher, signal),
  };
}

/**
 * The whole request (fetch, bounded read, validation) runs under one deadline
 * enforced by a race, so a fetcher or stream that ignores its abort signal
 * still cannot outlive `timeout_ms`.
 */
async function run(resolved: ResolvedSystemOneConfig, json: string, questions: AskQuestion[], bound: number, fetcher: typeof fetch, signal: AbortSignal): Promise<AskResult> {
  if (signal.aborted) throw new SystemOneError("PROVIDER_ABORTED", "Cancelled before it was sent.", 499, false);
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, resolved.timeout_ms);
  const work = Promise.resolve().then(() => perform(resolved, json, questions, bound, fetcher, controller.signal));
  work.catch(() => undefined);
  const expired = new Promise<never>((_, reject) => {
    controller.signal.addEventListener(
      "abort",
      () =>
        reject(
          timedOut
            ? new SystemOneError("PROVIDER_TIMEOUT", "The sorting service did not answer in time.", 504, true)
            : new SystemOneError("PROVIDER_ABORTED", "Cancelled while waiting for the sorting service.", 499, true),
        ),
      { once: true },
    );
  });
  expired.catch(() => undefined);
  try {
    return await Promise.race([work, expired]);
  } catch (error) {
    if (error instanceof SystemOneError) throw error;
    throw new SystemOneError("PROVIDER_UNAVAILABLE", "The sorting service request failed.", 503, true);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

async function perform(resolved: ResolvedSystemOneConfig, json: string, questions: AskQuestion[], bound: number, fetcher: typeof fetch, signal: AbortSignal): Promise<AskResult> {
  const fail = (code: string, message: string, status: number, known?: { usage?: AskResult["usage"]; cost?: number; model?: string }): never => {
    throw new SystemOneError(code, message, status, true, known?.usage, known?.cost, known?.model);
  };
  if (signal.aborted) throw new SystemOneError("PROVIDER_ABORTED", "Cancelled before it was sent.", 499, false);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  // A local endpoint is never handed a credential, even when one is configured.
  const local = OLLAMA_LOOPBACK_HOSTS.has(new URL(resolved.endpoint).hostname);
  if (resolved.key && !local) headers.Authorization = `Bearer ${resolved.key}`;
  const res = await fetcher(resolved.endpoint, { method: "POST", headers, body: json, signal, redirect: "error" });
  if (!res.ok) {
    res.body?.cancel().catch(() => undefined);
    fail("PROVIDER_UNAVAILABLE", `The sorting service answered ${res.status}.`, 503);
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
    fail("PROVIDER_INVALID", "The sorting service returned unreadable data.", 502);
  }
  const node = resolved.provider === "cloudflare" ? payload?.result : payload;
  if (resolved.provider === "cloudflare" && payload?.success !== true) fail("PROVIDER_UNAVAILABLE", "The sorting service reported an error.", 503);
  const usage = node?.usage;
  if (!usage || !Number.isSafeInteger(usage.input_tokens) || usage.input_tokens < 0 || !Number.isSafeInteger(usage.output_tokens) || usage.output_tokens < 0)
    fail("PROVIDER_INVALID", "The answer did not report usage.", 502);
  const known: { usage: AskResult["usage"]; cost?: number; model?: string } = { usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens } };
  if (typeof node.model !== "string" || !resolved.accepted_response_models.includes(node.model)) fail("PROVIDER_INVALID", "The answer came from an unexpected model.", 502, known);
  known.model = node.model;
  const micro = known.usage.input_tokens * resolved.price.input_micro_usd_per_million + known.usage.output_tokens * resolved.price.output_micro_usd_per_million;
  const cost = Math.ceil(micro / 1_000_000);
  if (!Number.isSafeInteger(cost)) fail("PROVIDER_UNAVAILABLE", "The reported usage is out of range.", 503, known);
  known.cost = cost;
  const answers = node.answers;
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) fail("PROVIDER_INVALID", "The answer is missing.", 502, known);
  const keys = Object.keys(answers);
  if (keys.length !== questions.length || questions.some((q) => !Object.hasOwn(answers, q.id))) fail("PROVIDER_INVALID", "The answer did not match the questions asked.", 502, known);
  const out: AskAnswer[] = [];
  for (const q of questions) {
    const a = answers[q.id];
    if (!a || a.type !== q.type) fail("PROVIDER_INVALID", "An answer had the wrong type.", 502, known);
    if (q.type === "noul") {
      if (typeof a.noul !== "number" || !Number.isFinite(a.noul) || a.noul < 0 || a.noul > 1) fail("PROVIDER_INVALID", "A yes/no answer was out of range.", 502, known);
      out.push({ id: q.id, type: "noul", probability: a.noul });
      continue;
    }
    const ids = q.options.map((o) => o.id);
    const p = a.probabilities;
    if (!p || typeof p !== "object" || Object.keys(p).length !== ids.length || ids.some((id) => !Object.hasOwn(p, id))) fail("PROVIDER_INVALID", "An answer used options that were not offered.", 502, known);
    let sum = 0;
    for (const id of ids) {
      const v = p[id];
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) fail("PROVIDER_INVALID", "An answer had an invalid probability.", 502, known);
      sum += v;
    }
    if (Math.abs(sum - 1) > PROBABILITY_SUM_TOLERANCE) fail("PROVIDER_INVALID", "An answer's probabilities did not add up.", 502, known);
    if (typeof a.choice !== "string" || !ids.includes(a.choice)) fail("PROVIDER_INVALID", "An answer chose an option that was not offered.", 502, known);
    if (p[a.choice] < Math.max(...ids.map((id) => p[id])) - EPSILON) fail("PROVIDER_INVALID", "An answer's choice was not its most likely option.", 502, known);
    if (typeof a.confidence !== "number" || !Number.isFinite(a.confidence) || a.confidence < 0 || a.confidence > 1) fail("PROVIDER_INVALID", "An answer had an invalid confidence.", 502, known);
    out.push({ id: q.id, type: "choice", choice: a.choice, confidence: a.confidence, probabilities: Object.fromEntries(ids.map((id) => [id, p[id]])) });
  }
  if (cost > bound) fail("PROVIDER_UNAVAILABLE", "The reported cost was above the reserved amount.", 503, known);
  return { answers: out, model: node.model, usage: known.usage, cost_micro_usd: cost, price_version: resolved.price.version, policy_version: ASK_POLICY_VERSION };
}
