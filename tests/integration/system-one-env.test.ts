import { describe, expect, it } from "vitest";
import { systemOneFromEnv } from "../../packages/providers/system-one-env.ts";

const account = "0123456789abcdef0123456789abcdef";
describe("systemOneFromEnv", () => {
  it("is off with a plain reason until a provider is chosen", () => {
    expect(systemOneFromEnv({})).toEqual({ config: null, reason: "Sorting help is not set up on this computer." });
  });
  it("builds the official Clef endpoint and public price for the fast model", () => {
    const r = systemOneFromEnv({ BRAIN_SYSTEM1_PROVIDER: "cloudflare", BRAIN_CLOUDFLARE_ACCOUNT_ID: account, BRAIN_DECISION_API_KEY: "t".repeat(40) });
    expect(r.config).toMatchObject({
      provider: "cloudflare",
      model: "clef-flash",
      endpoint: `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/@cf/cloudflare/clef-flash`,
      price: { version: "cf-clef-flash-2026-10-01", input_micro_usd_per_million: 90_000, output_micro_usd_per_million: 0 },
    });
    expect("label" in r && r.label).toBe("Cloudflare (fast)");
    expect(JSON.stringify("label" in r ? r.label : r)).not.toContain("t".repeat(40));
  });
  it.each([
    [{ BRAIN_SYSTEM1_PROVIDER: "cloudflare" }, /account/i],
    [{ BRAIN_SYSTEM1_PROVIDER: "cloudflare", BRAIN_CLOUDFLARE_ACCOUNT_ID: account }, /token/i],
    [{ BRAIN_SYSTEM1_PROVIDER: "cloudflare", BRAIN_CLOUDFLARE_ACCOUNT_ID: "../x", BRAIN_DECISION_API_KEY: "k" }, /account/i],
    [{ BRAIN_SYSTEM1_PROVIDER: "cloudflare", BRAIN_CLOUDFLARE_ACCOUNT_ID: account, BRAIN_DECISION_API_KEY: "k", BRAIN_SYSTEM1_MODEL: "llama" }, /clef/i],
    [{ BRAIN_SYSTEM1_PROVIDER: "cloudflare", BRAIN_CLOUDFLARE_ACCOUNT_ID: account, BRAIN_DECISION_API_KEY: "k", BRAIN_SYSTEM1_MODEL: "clef-flash:cloud" }, /clef-flash or clef/i],
    [{ BRAIN_SYSTEM1_PROVIDER: "openai" }, /cloudflare/i],
    [{ BRAIN_SYSTEM1_PROVIDER: "cloudflare", BRAIN_SYSTEM1_ENDPOINT: "https://evil.example/x", BRAIN_CLOUDFLARE_ACCOUNT_ID: account, BRAIN_DECISION_API_KEY: "k" }, /test server/i],
  ])("explains a bad setup plainly: %j", (env, reason) => {
    const r = systemOneFromEnv(env);
    expect(r.config).toBeNull();
    expect("reason" in r && r.reason).toMatch(reason);
  });
  it("accepts a loopback test endpoint without a token", () => {
    const r = systemOneFromEnv({ BRAIN_SYSTEM1_PROVIDER: "cloudflare", BRAIN_SYSTEM1_ENDPOINT: "http://127.0.0.1:4999/client/v4/accounts/test/ai/run/@cf/cloudflare/clef-flash" });
    expect(r.config).toMatchObject({ endpoint: "http://127.0.0.1:4999/client/v4/accounts/test/ai/run/@cf/cloudflare/clef-flash", model: "clef-flash" });
  });

  describe("ollama", () => {
    it("builds the ollama.com endpoint with the estimated label from OLLAMA_API_KEY", () => {
      const r = systemOneFromEnv({ BRAIN_SYSTEM1_PROVIDER: "ollama", OLLAMA_API_KEY: "  ok-key  " });
      expect(r.config).toMatchObject({
        provider: "ollama",
        model: "clef-flash",
        endpoint: "https://ollama.com/v1/systemone",
        key: "ok-key",
        price: { version: "ollama-estimate-clef-flash-2026-10-01", input_micro_usd_per_million: 90_000, output_micro_usd_per_million: 0 },
      });
      expect("label" in r && r.label).toBe("Ollama Cloud (estimated cost)");
    });
    it("prefers BRAIN_DECISION_API_KEY over OLLAMA_API_KEY", () => {
      const r = systemOneFromEnv({ BRAIN_SYSTEM1_PROVIDER: "ollama", BRAIN_DECISION_API_KEY: "first", OLLAMA_API_KEY: "second" });
      expect(r.config).toMatchObject({ key: "first" });
    });
    it("asks for an Ollama key when ollama.com has none", () => {
      expect(systemOneFromEnv({ BRAIN_SYSTEM1_PROVIDER: "ollama" })).toEqual({ config: null, reason: "Add your Ollama API key to turn on sorting help." });
    });
    it("needs no key for a loopback Ollama", () => {
      const r = systemOneFromEnv({ BRAIN_SYSTEM1_PROVIDER: "ollama", BRAIN_SYSTEM1_ENDPOINT: "http://localhost:11434/v1/systemone" });
      expect(r.config).toMatchObject({ provider: "ollama", endpoint: "http://localhost:11434/v1/systemone" });
      expect("label" in r && r.label).toBe("Ollama on this computer (estimated cost)");
    });
    it("refuses a remote endpoint override", () => {
      const r = systemOneFromEnv({ BRAIN_SYSTEM1_PROVIDER: "ollama", OLLAMA_API_KEY: "k", BRAIN_SYSTEM1_ENDPOINT: "https://evil.example/v1/systemone" });
      expect(r).toEqual({ config: null, reason: "BRAIN_SYSTEM1_ENDPOINT is only for a local test server." });
    });
    it("accepts a tagged model and prices it by its base name", () => {
      const r = systemOneFromEnv({ BRAIN_SYSTEM1_PROVIDER: "ollama", OLLAMA_API_KEY: "k", BRAIN_SYSTEM1_MODEL: "clef:cloud" });
      expect(r.config).toMatchObject({ model: "clef:cloud", price: { version: "ollama-estimate-clef-2026-10-01", input_micro_usd_per_million: 240_000 } });
    });
    it("rejects other models and honours price overrides", () => {
      expect(systemOneFromEnv({ BRAIN_SYSTEM1_PROVIDER: "ollama", OLLAMA_API_KEY: "k", BRAIN_SYSTEM1_MODEL: "llama3" }).config).toBeNull();
      const r = systemOneFromEnv({ BRAIN_SYSTEM1_PROVIDER: "ollama", OLLAMA_API_KEY: "k", BRAIN_SYSTEM1_PRICE_VERSION: "v9", BRAIN_SYSTEM1_INPUT_MICRO_USD_PER_MILLION: "1234" });
      expect(r.config).toMatchObject({ price: { version: "v9", input_micro_usd_per_million: 1234, output_micro_usd_per_million: 0 } });
    });
  });

  it("puts the key only under config.key, never in label or reason", () => {
    const key = "SECRET-VALUE-9f8e7d6c5b4a";
    const cases = [
      systemOneFromEnv({ BRAIN_SYSTEM1_PROVIDER: "cloudflare", BRAIN_CLOUDFLARE_ACCOUNT_ID: account, BRAIN_DECISION_API_KEY: key }),
      systemOneFromEnv({ BRAIN_SYSTEM1_PROVIDER: "ollama", BRAIN_DECISION_API_KEY: key }),
      systemOneFromEnv({ BRAIN_SYSTEM1_PROVIDER: "ollama", BRAIN_DECISION_API_KEY: key, BRAIN_SYSTEM1_ENDPOINT: "https://evil.example/v1/systemone" }),
      systemOneFromEnv({ BRAIN_SYSTEM1_PROVIDER: "ollama", BRAIN_DECISION_API_KEY: key, BRAIN_SYSTEM1_MODEL: "nope" }),
      systemOneFromEnv({ BRAIN_SYSTEM1_PROVIDER: "cloudflare", BRAIN_CLOUDFLARE_ACCOUNT_ID: account, BRAIN_DECISION_API_KEY: key, BRAIN_SYSTEM1_MODEL: "nope" }),
      systemOneFromEnv({ BRAIN_SYSTEM1_PROVIDER: "ollama", BRAIN_DECISION_API_KEY: key, BRAIN_SYSTEM1_INPUT_MICRO_USD_PER_MILLION: "abc" }),
    ];
    for (const r of cases) {
      const stripped = r.config ? { ...r, config: { ...r.config, key: undefined } } : r;
      expect(JSON.stringify(stripped)).not.toContain(key);
      if (r.config) expect(r.config.key).toBe(key);
    }
  });
});
