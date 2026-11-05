import { CLOUDFLARE_EMBED_MODEL, CLOUDFLARE_EMBED_PRICE, OLLAMA_EMBED_ENDPOINT, OLLAMA_EMBED_MODEL, PROVIDER_LABELS, EMBED_OFF_BY_SETUP, PROBE_REASONS, modelKey, type ProbeOutcome } from "../domain/better-search.ts";
import { resolveEmbedConfig, type EmbedConfig } from "./embed.ts";
import { detectOllamaModel } from "./ollama-detect.ts";

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

export type EmbedSetup = { config: EmbedConfig; label: string; key: string; detected: boolean; probe: ProbeOutcome } | { config: null; reason: string; probe: ProbeOutcome };

/**
 * The worker's startup setup. `off` skips everything. Nothing set means: look for Ollama with the search model on loopback and,
 * if it is there, set up exactly as `BRAIN_EMBED_PROVIDER=ollama` would. An explicit Ollama setup is kept whatever the probe finds,
 * marked `detected` only when the model is listed; Cloudflare is never probed and never detected.
 */
export async function embedSetup(env: Record<string, string | undefined>, probe: typeof detectOllamaModel = detectOllamaModel): Promise<EmbedSetup> {
  const provider = (env.BRAIN_EMBED_PROVIDER ?? "").trim();
  if (provider === "off") return { config: null, reason: EMBED_OFF_BY_SETUP, probe: "skipped" };
  const base = embedFromEnv(provider ? env : { ...env, BRAIN_EMBED_PROVIDER: "ollama" });
  if (!base.config) return { ...base, probe: "skipped" };
  if (base.config.provider !== "ollama") return { ...base, detected: false, probe: "skipped" };
  const result = await probe({ endpoint: base.config.endpoint, model: base.config.model });
  if (result.found) return { ...base, detected: true, probe: "found" };
  if (provider) return { ...base, detected: false, probe: result.outcome };
  return { config: null, reason: PROBE_REASONS[result.outcome], probe: result.outcome };
}

/** Whether the worker should look again later: only with nothing set and a probe that found no Ollama or no model. Never for off, an explicit provider, an invalid setup, or found. */
export function shouldReprobe(env: Record<string, string | undefined>, setup: EmbedSetup): boolean {
  if ((env.BRAIN_EMBED_PROVIDER ?? "").trim()) return false;
  return setup.config === null && (setup.probe === "no_ollama" || setup.probe === "no_model");
}
