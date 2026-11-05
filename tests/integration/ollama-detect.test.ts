import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../../packages/storage/index.ts";
import { Brain } from "../../packages/domain/service.ts";
import { BETTER_SEARCH_STATUS, EMBED_OFF_BY_SETUP, OLLAMA_EMBED_ENDPOINT, PROBE_REASONS, modelKey, type BetterSearchStatus } from "../../packages/domain/better-search.ts";
import { OLLAMA_PROBE_MAX_BYTES, detectOllamaModel, modelListed, ollamaTagsUrl } from "../../packages/providers/ollama-detect.ts";
import { embedSetup, shouldReprobe } from "../../packages/providers/embed-env.ts";
import { publishBetterSearchStatus } from "../../apps/worker/embed.ts";
import { REPROBE_MS, startReprobe } from "../../apps/worker/embed-reprobe.ts";
import { readFileSync, readdirSync } from "node:fs";
import { vi } from "vitest";

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.reverse()) fn();
  cleanup = [];
});
const tags = (names: string[]) => JSON.stringify({ models: names.map((name) => ({ name, model: name, size: 1 })) });
/** A fetcher that records the URL it was given and answers as told. */
function answering(body: string | (() => Promise<Response>), status = 200) {
  const urls: string[] = [];
  const fetcher = (async (url: string | URL) => {
    urls.push(String(url));
    if (typeof body === "function") return body();
    return new Response(body, { status, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetcher, urls };
}

describe("the loopback Ollama probe", () => {
  it("derives the tags URL only for plain http on loopback", () => {
    expect(ollamaTagsUrl(OLLAMA_EMBED_ENDPOINT)).toBe("http://127.0.0.1:11434/api/tags");
    expect(ollamaTagsUrl("http://localhost:5555/api/embed")).toBe("http://localhost:5555/api/tags");
    expect(ollamaTagsUrl("https://127.0.0.1:11434/api/embed")).toBeNull();
    expect(ollamaTagsUrl("http://ollama.example.com/api/embed")).toBeNull();
    expect(ollamaTagsUrl("http://user:pw@127.0.0.1:11434/api/embed")).toBeNull();
    expect(ollamaTagsUrl("not a url")).toBeNull();
  });
  it("matches a listed model exactly, or by base name when the configured name carries no tag", () => {
    expect(modelListed(JSON.parse(tags(["bge-m3:latest"])), "bge-m3")).toBe(true);
    expect(modelListed(JSON.parse(tags(["bge-m3:567m"])), "bge-m3")).toBe(true);
    expect(modelListed(JSON.parse(tags(["bge-m3:latest"])), "bge-m3:567m")).toBe(false);
    expect(modelListed(JSON.parse(tags(["bge-m3-large:latest"])), "bge-m3")).toBe(false);
    expect(modelListed(JSON.parse(tags(["embeddinggemma:latest"])), "bge-m3")).toBe(false);
    expect(modelListed({ models: "nope" }, "bge-m3")).toBe(false);
    expect(modelListed([{ name: "bge-m3" }], "bge-m3")).toBe(false);
    expect(modelListed(null, "bge-m3")).toBe(false);
  });
  it("finds the model, reports a missing model, and reports no Ollama on an error, a refusal, garbage, an oversized body or silence, inside the budget", async () => {
    const found = answering(tags(["bge-m3:latest", "clef-flash:cloud"]));
    expect(await detectOllamaModel({ model: "bge-m3", fetcher: found.fetcher })).toEqual({ found: true, outcome: "found" });
    expect(found.urls).toEqual(["http://127.0.0.1:11434/api/tags"]);
    expect(await detectOllamaModel({ model: "bge-m3", fetcher: answering(tags(["embeddinggemma:latest"])).fetcher })).toEqual({ found: false, outcome: "no_model" });
    expect(await detectOllamaModel({ model: "bge-m3", fetcher: answering("", 404).fetcher })).toEqual({ found: false, outcome: "no_ollama" });
    expect(await detectOllamaModel({ model: "bge-m3", fetcher: answering("{not json").fetcher })).toEqual({ found: false, outcome: "no_ollama" });
    const refused = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    expect(await detectOllamaModel({ model: "bge-m3", fetcher: refused })).toEqual({ found: false, outcome: "no_ollama" });
    const huge = answering(`{"models":[{"name":"${"x".repeat(OLLAMA_PROBE_MAX_BYTES)}"}]}`);
    expect(await detectOllamaModel({ model: "bge-m3", fetcher: huge.fetcher })).toEqual({ found: false, outcome: "no_ollama" });
    const silent = answering(() => new Promise<Response>(() => {}));
    const t = Date.now();
    expect(await detectOllamaModel({ model: "bge-m3", fetcher: silent.fetcher, timeoutMs: 80 })).toEqual({ found: false, outcome: "no_ollama" });
    expect(Date.now() - t).toBeLessThan(1000);
    expect(await detectOllamaModel({ endpoint: "http://ollama.example.com/api/embed", model: "bge-m3", fetcher: found.fetcher })).toEqual({ found: false, outcome: "no_ollama" });
    expect(found.urls).toHaveLength(1);
  });
});

describe("embedSetup", () => {
  const probeFound = async () => ({ found: true as const, outcome: "found" as const });
  const probeNoModel = async () => ({ found: false as const, outcome: "no_model" as const });
  const probeNoOllama = async () => ({ found: false as const, outcome: "no_ollama" as const });
  it("skips the probe when the setup says off, and when the provider is Cloudflare", async () => {
    let probed = 0;
    const probe = (async () => { probed++; return { found: true as const, outcome: "found" as const }; }) as typeof detectOllamaModel;
    expect(await embedSetup({ BRAIN_EMBED_PROVIDER: "off" }, probe)).toEqual({ config: null, reason: EMBED_OFF_BY_SETUP, probe: "skipped" });
    const cloud = await embedSetup({ BRAIN_EMBED_PROVIDER: "cloudflare", BRAIN_CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef", BRAIN_DECISION_API_KEY: ["sk", "test", "never", "a", "real", "key", "0123456789abcdef"].join("-") }, probe);
    expect(cloud.config?.provider).toBe("cloudflare");
    expect(cloud).toMatchObject({ detected: false, probe: "skipped" });
    expect(probed).toBe(0);
  });
  it("with nothing set, configures Ollama on the default endpoint when the model is found, and says why when it is not", async () => {
    const on = await embedSetup({}, probeFound as typeof detectOllamaModel);
    expect(on.config).toMatchObject({ provider: "ollama", endpoint: OLLAMA_EMBED_ENDPOINT, model: "bge-m3" });
    expect(on).toMatchObject({ key: modelKey("ollama", "bge-m3"), label: "Ollama on this computer", detected: true, probe: "found" });
    expect(await embedSetup({}, probeNoModel as typeof detectOllamaModel)).toEqual({ config: null, reason: PROBE_REASONS.no_model, probe: "no_model" });
    expect(await embedSetup({}, probeNoOllama as typeof detectOllamaModel)).toEqual({ config: null, reason: PROBE_REASONS.no_ollama, probe: "no_ollama" });
    const custom = await embedSetup({ BRAIN_EMBED_MODEL: "embeddinggemma", BRAIN_EMBED_ENDPOINT: "http://127.0.0.1:5555/api/embed" }, probeFound as typeof detectOllamaModel);
    expect(custom.config).toMatchObject({ provider: "ollama", endpoint: "http://127.0.0.1:5555/api/embed", model: "embeddinggemma" });
    // A non-loopback override is refused before any probe, exactly as an explicit ollama setup is.
    let probed = 0;
    const counting = (async () => { probed++; return { found: true as const, outcome: "found" as const }; }) as typeof detectOllamaModel;
    const remote = await embedSetup({ BRAIN_EMBED_ENDPOINT: "http://ollama.example.com/api/embed" }, counting);
    expect(remote.config).toBeNull();
    expect(remote.probe).toBe("skipped");
    expect(probed).toBe(0);
  });
  it("keeps an explicit Ollama setup when the probe fails, marked not detected", async () => {
    const kept = await embedSetup({ BRAIN_EMBED_PROVIDER: "ollama" }, probeNoOllama as typeof detectOllamaModel);
    expect(kept.config?.provider).toBe("ollama");
    expect(kept).toMatchObject({ detected: false, probe: "no_ollama" });
    const on = await embedSetup({ BRAIN_EMBED_PROVIDER: "ollama", BRAIN_EMBED_MODEL: "fake-concept-v1" }, probeFound as typeof detectOllamaModel);
    expect(on).toMatchObject({ detected: true, probe: "found", key: modelKey("ollama", "fake-concept-v1") });
  });
  it("is published on the status, key-free, and carried across a restart with the same key", () => {
    const dir = mkdtempSync(join(tmpdir(), "probe-status-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const store = new Storage(join(dir, "brain.sqlite"));
    cleanup.push(() => store.close());
    const brain = new Brain(store);
    publishBetterSearchStatus(brain, { configured: true, provider: "ollama", model: "bge-m3", key: modelKey("ollama", "bge-m3"), label: "Ollama on this computer", detected: true, probe: "found" });
    const status = store.setting<BetterSearchStatus>(BETTER_SEARCH_STATUS, null as never);
    expect(status).toMatchObject({ configured: true, detected: true, probe: "found" });
    expect(JSON.stringify(status)).not.toMatch(/latest|size/u);
    publishBetterSearchStatus(brain, { configured: false, reason: PROBE_REASONS.no_ollama, probe: "no_ollama" });
    expect(store.setting<BetterSearchStatus>(BETTER_SEARCH_STATUS, null as never)).toMatchObject({ configured: false, probe: "no_ollama" });
  });
});

describe("the 10-minute re-probe", () => {
  const notFound = { config: null, reason: PROBE_REASONS.no_ollama, probe: "no_ollama" as const };
  it("is due only while the provider is unset and nothing was found", async () => {
    expect(shouldReprobe({}, notFound)).toBe(true);
    expect(shouldReprobe({}, { ...notFound, probe: "no_model" })).toBe(true);
    expect(shouldReprobe({ BRAIN_EMBED_PROVIDER: "off" }, { config: null, reason: EMBED_OFF_BY_SETUP, probe: "skipped" })).toBe(false);
    expect(shouldReprobe({ BRAIN_EMBED_PROVIDER: "ollama" }, { ...notFound })).toBe(false);
    expect(shouldReprobe({ BRAIN_EMBED_ENDPOINT: "http://ollama.example.com/api/embed" }, { config: null, reason: "x", probe: "skipped" })).toBe(false);
    const found = await embedSetup({}, (async () => ({ found: true as const, outcome: "found" as const })) as typeof detectOllamaModel);
    expect(shouldReprobe({}, found)).toBe(false);
  });
  it("probes every 10 minutes on its own timer, calls back once on found, then stops; never for off", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const probe = (async () => ({ found: ++calls >= 2, outcome: calls >= 2 ? ("found" as const) : ("no_ollama" as const) })) as unknown as typeof detectOllamaModel;
      const found: unknown[] = [];
      const loop = startReprobe({ env: {}, probe, onFound: (setup) => found.push(setup) });
      await vi.advanceTimersByTimeAsync(REPROBE_MS - 1);
      expect(calls).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toBe(1);
      expect(found).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(REPROBE_MS);
      expect(calls).toBe(2);
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ detected: true, probe: "found", key: modelKey("ollama", "bge-m3") });
      await vi.advanceTimersByTimeAsync(REPROBE_MS * 3);
      expect(calls).toBe(2);
      loop.stop();
      let offCalls = 0;
      const off = startReprobe({ env: { BRAIN_EMBED_PROVIDER: "off" }, probe: (async () => { offCalls++; return { found: false as const, outcome: "no_ollama" as const }; }) as unknown as typeof detectOllamaModel, onFound: () => {} });
      await vi.advanceTimersByTimeAsync(REPROBE_MS * 2);
      expect(offCalls).toBe(0);
      off.stop();
    } finally {
      vi.useRealTimers();
    }
  });
  it("no Vitest file starts a real worker without BRAIN_EMBED_PROVIDER off (guard)", () => {
    const files = readdirSync("tests/integration").filter((f) => f.endsWith(".test.ts")).map((f) => `tests/integration/${f}`);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      // Only a file that actually starts a worker process counts: it names run.mjs or the worker entry AND spawns something. A file that merely reads run.mjs (recall-key-isolation) is not a worker.
      const spawnsWorker = /scripts\/run\.mjs|apps\/worker\/main\.ts/u.test(text) && /\bspawn(?:Sync)?\(/u.test(text) && !/managed/iu.test(file);
      if (spawnsWorker) expect(text, `${file} must set BRAIN_EMBED_PROVIDER: "off" (or inject a fake probe) on the worker it starts`).toMatch(/BRAIN_EMBED_PROVIDER:\s*"off"|fakeProbe|probe:/u);
    }
    expect(readFileSync("playwright.config.ts", "utf8").match(/BRAIN_EMBED_PROVIDER: "off"/gu)).toHaveLength(5);
  });
});
