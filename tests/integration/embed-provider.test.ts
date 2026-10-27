import { describe, expect, it } from "vitest";
import {
  BETTER_SEARCH_OFF, DENSE_FLOOR_DEFAULT, EMBED_TEXT_MAX, betterSearchEffective, decodeVector, denseFloor, embedText, encodeVector,
  estimateMicroUsd, estimateTokens, modelKey, normalize, vectorFromBase64, vectorToBase64,
} from "../../packages/domain/better-search.ts";
import { EmbedError, prepareEmbed, resolveEmbedConfig } from "../../packages/providers/embed.ts";
import { embedFromEnv } from "../../packages/providers/embed-env.ts";
import { FAKE_EMBED_DIM, cosine, fakeEmbed, fakeEmbedFetcher } from "../helpers/fake-embed.mjs";

const account = "0123456789abcdef0123456789abcdef";
const KEY = ["sk", "test", "never", "a", "real", "key", "0123456789abcdef"].join("-");
const signal = () => new AbortController().signal;

describe("better-search pure helpers", () => {
  it("builds the model key, keeps a floor per model, caps the embedded text at 2,000 code points and prices in whole micro-USD", () => {
    expect(modelKey("ollama", "bge-m3")).toBe("ollama:bge-m3:none");
    expect(modelKey("cloudflare", "@cf/baai/bge-m3")).toBe("cloudflare:@cf/baai/bge-m3:none");
    expect(denseFloor("cloudflare:@cf/baai/bge-m3:none")).toBe(0.45);
    expect(denseFloor("ollama:bge-m3:latest:none")).toBe(0.45);
    expect(denseFloor("ollama:embeddinggemma:none")).toBe(DENSE_FLOOR_DEFAULT);
    const text = embedText("Launch notes · Northstar · 2026-10-18", "🧠".repeat(3000));
    expect(text.startsWith("Launch notes · Northstar · 2026-10-18\n🧠")).toBe(true);
    expect(Array.from(text).length).toBe(EMBED_TEXT_MAX);
    expect(estimateTokens(["abcd", "தமிழ்"])).toBe(2 + Math.ceil(Buffer.byteLength("தமிழ்") / 2));
    expect(estimateMicroUsd(1_000_000, 12_000)).toBe(12_000);
    expect(estimateMicroUsd(1, 12_000)).toBe(1);
    expect(estimateMicroUsd(0, 12_000)).toBe(0);
  });
  it("encodes little-endian Float32, normalises in place and leaves a zero vector alone", () => {
    const v = normalize(Float32Array.from([3, 4]));
    expect([...v]).toEqual([0.6000000238418579, 0.800000011920929]);
    const buf = encodeVector(Float32Array.from([1]));
    expect([...buf]).toEqual([0, 0, 0x80, 0x3f]);
    expect([...decodeVector(buf, 1)]).toEqual([1]);
    expect([...normalize(Float32Array.from([0, 0]))]).toEqual([0, 0]);
    const back = vectorFromBase64(vectorToBase64(v), 2)!;
    expect([...back]).toEqual([...v]);
    expect(vectorFromBase64(vectorToBase64(v), 3)).toBeNull();
    expect(vectorFromBase64("not base64!!", 2)).toBeNull();
  });
  it("is effective only when the stored consent matches what the worker published and the worker runs", () => {
    const status = { configured: true as const, provider: "ollama" as const, model: "bge-m3", key: "ollama:bge-m3:none", label: "Ollama on this computer", updated_at: "x" };
    const on = { mode: "ollama" as const, key: "ollama:bge-m3:none", consented_at: "x" };
    expect(betterSearchEffective(BETTER_SEARCH_OFF, status, true)).toMatchObject({ on: false, reason: "Better search is off." });
    expect(betterSearchEffective(on, null, true).reason).toBe("Better search status appears once BiBrain's background worker starts.");
    expect(betterSearchEffective(on, { configured: false, reason: "Add your Cloudflare account id.", updated_at: "x" }, true).reason).toBe("Add your Cloudflare account id.");
    expect(betterSearchEffective({ ...on, mode: "cloudflare" }, status, true).reason).toBe("Cloudflare is not set up on this computer.");
    expect(betterSearchEffective({ ...on, key: "ollama:embeddinggemma:none" }, status, true).reason).toBe("The search model changed. Choose Better search again.");
    expect(betterSearchEffective(on, status, false).reason).toBe("BiBrain's background worker is not running.");
    expect(betterSearchEffective(on, status, true)).toEqual({ on: true, reason: "ready" });
  });
});

describe("embedFromEnv", () => {
  it("is off with a plain reason until a provider is chosen, and never names the key", () => {
    expect(embedFromEnv({})).toEqual({ config: null, reason: "Better search is not set up on this computer." });
    expect(embedFromEnv({ BRAIN_EMBED_PROVIDER: "openai" })).toEqual({ config: null, reason: "Better search supports Ollama or Cloudflare only." });
    const r = embedFromEnv({ BRAIN_EMBED_PROVIDER: "cloudflare", BRAIN_CLOUDFLARE_ACCOUNT_ID: account, BRAIN_DECISION_API_KEY: KEY });
    expect(r.config).toMatchObject({ provider: "cloudflare", model: "@cf/baai/bge-m3", endpoint: `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/@cf/baai/bge-m3`, key: KEY, price: { version: "cf-bge-m3-2026-10-27", input_micro_usd_per_million: 12_000 } });
    expect("label" in r && r.label).toBe("Cloudflare");
    expect("key" in r && r.key).toBe("cloudflare:@cf/baai/bge-m3:none");
    expect(JSON.stringify({ ...r, config: { ...(r.config ?? {}), key: undefined } })).not.toContain(KEY);
  });
  it.each([
    [{ BRAIN_EMBED_PROVIDER: "cloudflare" }, /account id/i],
    [{ BRAIN_EMBED_PROVIDER: "cloudflare", BRAIN_CLOUDFLARE_ACCOUNT_ID: account }, /token/i],
    [{ BRAIN_EMBED_PROVIDER: "cloudflare", BRAIN_CLOUDFLARE_ACCOUNT_ID: account, BRAIN_DECISION_API_KEY: KEY, BRAIN_EMBED_MODEL: "@cf/baai/bge-small-en-v1.5" }, /@cf\/baai\/bge-m3/],
    [{ BRAIN_EMBED_PROVIDER: "cloudflare", BRAIN_CLOUDFLARE_ACCOUNT_ID: account, BRAIN_DECISION_API_KEY: KEY, BRAIN_EMBED_ENDPOINT: "https://evil.example/x" }, /test server/i],
    [{ BRAIN_EMBED_PROVIDER: "ollama", BRAIN_EMBED_ENDPOINT: "https://ollama.com/api/embed" }, /this computer/i],
    [{ BRAIN_EMBED_PROVIDER: "ollama", BRAIN_EMBED_MODEL: "../x" }, /model name/i],
  ])("explains a bad setup plainly: %j", (env, reason) => {
    const r = embedFromEnv(env);
    expect(r.config).toBeNull();
    expect("reason" in r && r.reason).toMatch(reason);
  });
  it("defaults Ollama to loopback bge-m3 with no key, and accepts a loopback test server for Cloudflare without a token", () => {
    const o = embedFromEnv({ BRAIN_EMBED_PROVIDER: "ollama", BRAIN_DECISION_API_KEY: KEY });
    expect(o.config).toMatchObject({ provider: "ollama", model: "bge-m3", endpoint: "http://127.0.0.1:11434/api/embed", price: { input_micro_usd_per_million: 0 } });
    expect(o.config?.key).toBeUndefined();
    expect("label" in o && o.label).toBe("Ollama on this computer");
    expect(embedFromEnv({ BRAIN_EMBED_PROVIDER: "ollama", BRAIN_EMBED_MODEL: "embeddinggemma:300m", BRAIN_EMBED_ENDPOINT: "http://localhost:11434/api/embed" }).config).toMatchObject({ model: "embeddinggemma:300m" });
    const c = embedFromEnv({ BRAIN_EMBED_PROVIDER: "cloudflare", BRAIN_EMBED_ENDPOINT: "http://127.0.0.1:4999/client/v4/accounts/test/ai/run/@cf/baai/bge-m3" });
    expect(c.config).toMatchObject({ provider: "cloudflare", endpoint: "http://127.0.0.1:4999/client/v4/accounts/test/ai/run/@cf/baai/bge-m3" });
  });
});

describe("prepareEmbed", () => {
  const ollama = { provider: "ollama" as const, endpoint: "http://127.0.0.1:9/api/embed", model: "fake-concept-v1", price: { version: "zero", input_micro_usd_per_million: 0 } };
  const cloud = { provider: "cloudflare" as const, endpoint: `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/@cf/baai/bge-m3`, model: "@cf/baai/bge-m3", key: KEY, price: { version: "cf-bge-m3-2026-10-27", input_micro_usd_per_million: 12_000 } };
  it("embeds a batch through Ollama's shape: one request, normalised vectors in order, no credential to loopback, cost 0", async () => {
    const { fetcher, calls } = fakeEmbedFetcher();
    const texts = ["Launch color: cobalt", "The daily sync is at 9 in the morning."];
    const prepared = prepareEmbed({ ...ollama, key: KEY }, texts, fetcher);
    expect(prepared.key).toBe("ollama:fake-concept-v1:none");
    expect(prepared.reserved_micro_usd).toBe(0);
    const out = await prepared.execute(signal());
    expect(calls.n).toBe(1);
    expect(calls.texts[0]).toEqual(texts);
    expect(calls.headers[0].Authorization).toBeUndefined();
    expect((calls.bodies[0] as any).truncate).toBe(true);
    expect(out.vectors).toHaveLength(2);
    expect(out.dim).toBe(FAKE_EMBED_DIM);
    for (const v of out.vectors) expect(Math.abs(Math.hypot(...v) - 1)).toBeLessThan(1e-5);
    expect(out.cost_micro_usd).toBe(0);
    expect(cosine([...out.vectors[0]], fakeEmbed(texts[0]))).toBeGreaterThan(0.999);
  });
  it("embeds through Cloudflare's envelope with a bearer token, reserves the estimate and settles it when no usage is reported", async () => {
    const { fetcher, calls } = fakeEmbedFetcher({ shape: "cloudflare" });
    const prepared = prepareEmbed(cloud, ["a".repeat(1000)], fetcher);
    expect(prepared.estimated_tokens).toBe(500);
    expect(prepared.reserved_micro_usd).toBe(Math.ceil((500 * 12_000) / 1_000_000));
    const out = await prepared.execute(signal());
    expect(calls.headers[0].Authorization).toBe(`Bearer ${KEY}`);
    expect((calls.bodies[0] as any).truncate_inputs).toBe(true);
    expect(out.reported_tokens).toBeNull();
    expect(out.cost_micro_usd).toBe(prepared.reserved_micro_usd);
    expect(out.key).toBe("cloudflare:@cf/baai/bge-m3:none");
  });
  it("refuses secret-looking text before any request, and rejects bad answers after it", async () => {
    const { fetcher, calls } = fakeEmbedFetcher();
    expect(() => prepareEmbed(ollama, [`api_key = ${KEY}`], fetcher)).toThrow(EmbedError);
    try { prepareEmbed(ollama, [`api_key = ${KEY}`], fetcher); } catch (e) { expect((e as EmbedError).dispatched).toBe(false); }
    expect(calls.n).toBe(0);
    expect(() => prepareEmbed(ollama, [], fetcher)).toThrow(/between 1 and 32/);
    expect(() => prepareEmbed(ollama, Array.from({ length: 33 }, () => "x"), fetcher)).toThrow(/between 1 and 32/);
    const wrongCount = (async (_u: any, _i: any) => new Response(JSON.stringify({ embeddings: [[0.1, 0.2]] }), { status: 200 })) as unknown as typeof fetch;
    await expect(prepareEmbed(ollama, ["a", "b"], wrongCount).execute(signal())).rejects.toMatchObject({ code: "PROVIDER_INVALID", dispatched: true });
    const ragged = (async () => new Response(JSON.stringify({ embeddings: [Array(16).fill(0.1), Array(8).fill(0.1)] }), { status: 200 })) as unknown as typeof fetch;
    await expect(prepareEmbed(ollama, ["a", "b"], ragged).execute(signal())).rejects.toMatchObject({ code: "PROVIDER_INVALID" });
    const down = fakeEmbedFetcher({ status: 503 });
    await expect(prepareEmbed(ollama, ["a"], down.fetcher).execute(signal())).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", dispatched: true, actual_cost_micro_usd: 0, upstream_status: 503 });
    const refused = fakeEmbedFetcher({ reject: () => true });
    await expect(prepareEmbed(ollama, ["a"], refused.fetcher).execute(signal())).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", actual_cost_micro_usd: 0, upstream_status: 400 });
    const slow = fakeEmbedFetcher({ delayMs: 400 });
    await expect(prepareEmbed({ ...ollama, timeout_ms: 50 }, ["a"], slow.fetcher).execute(signal())).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT", dispatched: true });
    const huge = (async () => new Response(JSON.stringify({ embeddings: [Array(4096).fill(0.001)] }), { status: 200 })) as unknown as typeof fetch;
    await expect(prepareEmbed({ ...ollama, max_response_bytes: 1024 }, ["a"], huge).execute(signal())).rejects.toMatchObject({ code: "PROVIDER_INVALID" });
    const failed = (async () => new Response(JSON.stringify({ success: false, errors: [{ message: "nope" }] }), { status: 200 })) as unknown as typeof fetch;
    await expect(prepareEmbed(cloud, ["a"], failed).execute(signal())).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", actual_cost_micro_usd: 0 });
    const slowSend = fakeEmbedFetcher({ delayMs: 400 });
    const timeout = await prepareEmbed({ ...cloud, timeout_ms: 50 }, ["a"], slowSend.fetcher).execute(signal()).catch((e: EmbedError) => e);
    expect(timeout).toMatchObject({ code: "PROVIDER_TIMEOUT", dispatched: true });
    expect((timeout as EmbedError).actual_cost_micro_usd).toBeUndefined();
  });
  it("validates the endpoint rules: loopback-only Ollama, Cloudflare with a key or a loopback test server", () => {
    expect(() => resolveEmbedConfig({ ...ollama, endpoint: "https://ollama.com/api/embed" })).toThrow(/this computer/);
    expect(() => resolveEmbedConfig({ ...cloud, key: undefined })).toThrow(/credential/i);
    expect(resolveEmbedConfig({ ...cloud, endpoint: "http://127.0.0.1:4999/x", key: undefined }).loopback).toBe(true);
    expect(() => resolveEmbedConfig({ ...ollama, endpoint: "http://user:pw@127.0.0.1:11434/api/embed" })).toThrow();
    expect(() => resolveEmbedConfig({ ...ollama, timeout_ms: 0 })).toThrow();
  });
});

describe("the fake embedder", () => {
  it("puts paraphrases and English–Tamil pairs above the floor and unrelated text below it", () => {
    const above = [
      ["which hue was chosen for the release", "Northstar · Launch color\nLaunch color: cobalt"],
      ["வெளியீட்டு நிறம் என்ன", "Northstar · Launch color\nLaunch color: cobalt"],
      ["when does the stand-up happen", "Morning rhythm · Northstar · 2026-10-25\nThe crew sync is at 9 every morning."],
      ["குழு எப்போது சந்திக்கிறது", "Morning rhythm · Northstar · 2026-10-25\nThe crew sync is at 9 every morning."],
      ["where is the new office", "புதிய அலுவலகம் · Northstar · 2026-10-25\nபுதிய அலுவலகம் சென்னையில் திறக்கிறது. குழு ஜனவரியில் நகர்கிறது."],
    ];
    for (const [q, t] of above) expect(cosine(fakeEmbed(q), fakeEmbed(t)), q).toBeGreaterThanOrEqual(0.5);
    const below = [
      ["Zephyr budget for Q3", "Allowance · Northstar · 2026-10-25\nThe quarterly tooling allowance is two thousand dollars, approved by Ana."],
      ["Orion rollout checklist", "Northstar · Launch color\nLaunch color: cobalt"],
      ["fix the TypeScript error cannot find module", "Support · Northstar · 2026-10-25\nTicket NS-4471 tracks the login outage; the patch went out in release 2.3.1."],
      ["what is the office wifi password", "புதிய அலுவலகம் · Northstar · 2026-10-25\nபுதிய அலுவலகம் சென்னையில் திறக்கிறது. குழு ஜனவரியில் நகர்கிறது."],
    ];
    for (const [q, t] of below) expect(cosine(fakeEmbed(q), fakeEmbed(t)), q).toBeLessThan(0.45);
    expect(fakeEmbed("")).toEqual(Array(FAKE_EMBED_DIM).fill(0));
    expect(fakeEmbed("NS-4471")).toEqual(Array(FAKE_EMBED_DIM).fill(0));
    expect(fakeEmbed("Launch color")).toEqual(fakeEmbed("launch COLOR"));
  });
});
