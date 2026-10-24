import { resolveAskConfig, type AskConfig } from "./system-one-ask.ts";

const PRICES = {
  cloudflare: {
    "clef-flash": { version: "cf-clef-flash-2026-10-01", input: 90_000, label: "Cloudflare (fast)" },
    clef: { version: "cf-clef-2026-10-01", input: 240_000, label: "Cloudflare" },
  },
  ollama: {
    "clef-flash": { version: "ollama-estimate-clef-flash-2026-10-01", input: 90_000 },
    clef: { version: "ollama-estimate-clef-2026-10-01", input: 240_000 },
  },
} as const;

const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"];
const OLLAMA_URL = "https://ollama.com/v1/systemone";
const TEST_SERVER_ONLY = "BRAIN_SYSTEM1_ENDPOINT is only for a local test server.";

/** The loopback override URL, "" when unset, or null when it is not an allowed local test server. */
function loopbackOverride(raw: string | undefined): string | null {
  const override = raw?.trim();
  if (!override) return "";
  try {
    return LOOPBACK_HOSTS.includes(new URL(override).hostname) ? override : null;
  } catch {
    return null;
  }
}

/**
 * The local System 1 configuration, or one plain sentence saying why it is off.
 * The key appears only in `config.key`; it is never part of `label` or `reason`.
 */
export function systemOneFromEnv(env: Record<string, string | undefined>): { config: AskConfig; label: string } | { config: null; reason: string } {
  const off = (reason: string) => ({ config: null, reason }) as const;
  const provider = (env.BRAIN_SYSTEM1_PROVIDER ?? "").trim();
  if (!provider) return off("Sorting help is not set up on this computer.");
  if (provider !== "cloudflare" && provider !== "ollama") return off("Sorting help supports Cloudflare or Ollama only.");
  const model = (env.BRAIN_SYSTEM1_MODEL ?? "").trim() || "clef-flash";
  const base = model.split(":")[0];
  const modelOk = provider === "ollama" ? (base === "clef" || base === "clef-flash") : (model === "clef" || model === "clef-flash");
  if (!modelOk) return off("The sorting model must be clef-flash or clef.");
  const tier = base as "clef" | "clef-flash";
  const override = loopbackOverride(env.BRAIN_SYSTEM1_ENDPOINT);
  if (override === null) return off(TEST_SERVER_ONLY);
  const key = (env.BRAIN_DECISION_API_KEY ?? "").trim() || (env.OLLAMA_API_KEY ?? "").trim() || undefined;
  const inputRaw = env.BRAIN_SYSTEM1_INPUT_MICRO_USD_PER_MILLION?.trim();
  if (inputRaw && !/^[1-9][0-9]{0,15}$/u.test(inputRaw)) return off("BRAIN_SYSTEM1_INPUT_MICRO_USD_PER_MILLION must be a positive whole number.");

  let endpoint: string;
  let label: string;
  let price: { version: string; input: number };
  if (provider === "ollama") {
    price = PRICES.ollama[tier];
    endpoint = override || OLLAMA_URL;
    label = override ? "Ollama on this computer (estimated cost)" : "Ollama Cloud (estimated cost)";
    if (!override && !key) return off("Add your Ollama API key to turn on sorting help.");
  } else {
    price = PRICES.cloudflare[tier];
    label = PRICES.cloudflare[tier].label;
    if (override) endpoint = override;
    else {
      const account = (env.BRAIN_CLOUDFLARE_ACCOUNT_ID ?? "").trim();
      if (!/^[0-9a-f]{32}$/u.test(account)) return off("Add your Cloudflare account id (32 letters and numbers) to turn on sorting help.");
      if (!key) return off("Add a Cloudflare API token with Workers AI access to turn on sorting help.");
      endpoint = `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/@cf/cloudflare/${model}`;
    }
  }
  const config: AskConfig = {
    provider,
    endpoint,
    model,
    key,
    price: {
      version: env.BRAIN_SYSTEM1_PRICE_VERSION?.trim() || price.version,
      input_micro_usd_per_million: inputRaw ? Number(inputRaw) : price.input,
      output_micro_usd_per_million: 0,
    },
  };
  try {
    resolveAskConfig(config);
  } catch (error) {
    return off(error instanceof Error ? error.message : "Sorting help is set up incorrectly.");
  }
  return { config, label };
}
