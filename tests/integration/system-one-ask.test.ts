import { describe, expect, it } from "vitest";
import { prepareAsk, type AskQuestion } from "../../packages/providers/system-one-ask.ts";
import { SystemOneError } from "../../packages/providers/system-one.ts";

const config = {
  provider: "cloudflare" as const,
  endpoint: "http://127.0.0.1:9/client/v4/accounts/test/ai/run/@cf/cloudflare/clef-flash",
  model: "clef-flash",
  price: { version: "cf-clef-2026-10-01", input_micro_usd_per_million: 90_000, output_micro_usd_per_million: 0 },
};
const questions: AskQuestion[] = [
  { id: "kind", type: "choice", instructions: "What kind of item is `note`?", options: [
    { id: "decision", description: "A decision" }, { id: "note", description: "Anything else" } ] },
  { id: "show", type: "noul", instructions: "Is `note` worth showing the owner today?" },
];
function respond(body: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}
const ok = {
  success: true,
  result: {
    model: "clef-flash",
    usage: { input_tokens: 400, output_tokens: 0 },
    answers: {
      kind: { type: "choice", choice: "decision", confidence: 0.9, probabilities: { decision: 0.9, note: 0.1 } },
      show: { type: "noul", noul: 0.82 },
    },
  },
};

describe("prepareAsk", () => {
  it("sends every question in one request and returns validated answers with their cost", async () => {
    let sent: any;
    const fetcher = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return new Response(JSON.stringify(ok));
    }) as unknown as typeof fetch;
    const ask = prepareAsk(config, "note: We decided to ship one plan.", questions, fetcher);
    expect(ask.reserved_micro_usd).toBeGreaterThan(0);
    expect(ask.request_hash).toMatch(/^[0-9a-f]{64}$/);
    const r = await ask.execute(new AbortController().signal);
    expect(sent).toEqual({
      model: "clef-flash",
      state: "note: We decided to ship one plan.",
      questions: {
        kind: { type: "choice", instructions: "What kind of item is `note`?", criteria: { decision: "A decision", note: "Anything else" } },
        show: { type: "noul", instructions: "Is `note` worth showing the owner today?" },
      },
    });
    expect(r.answers).toEqual([
      { id: "kind", type: "choice", choice: "decision", confidence: 0.9, probabilities: { decision: 0.9, note: 0.1 } },
      { id: "show", type: "noul", probability: 0.82 },
    ]);
    expect(r.cost_micro_usd).toBe(Math.ceil((400 * 90_000) / 1_000_000));
    expect(r.model).toBe("clef-flash");
  });

  it.each([
    ["an unoffered option", { kind: { type: "choice", choice: "task", confidence: 0.9, probabilities: { task: 0.9, note: 0.1 } }, show: { type: "noul", noul: 0.5 } }],
    ["a missing answer", { kind: { type: "choice", choice: "note", confidence: 0.6, probabilities: { decision: 0.4, note: 0.6 } } }],
    ["an extra answer", { ...ok.result.answers, extra: { type: "noul", noul: 0.5 } }],
    ["probabilities that do not sum to one", { kind: { type: "choice", choice: "note", confidence: 0.6, probabilities: { decision: 0.7, note: 0.6 } }, show: { type: "noul", noul: 0.5 } }],
    ["a yes/no outside 0..1", { ...ok.result.answers, show: { type: "noul", noul: 1.4 } }],
    ["a choice that is not the most probable", { kind: { type: "choice", choice: "note", confidence: 0.6, probabilities: { decision: 0.7, note: 0.3 } }, show: { type: "noul", noul: 0.5 } }],
  ])("rejects %s as a whole, keeping the known usage", async (_label, answers) => {
    const ask = prepareAsk(config, "note: x", questions, respond({ ...ok, result: { ...ok.result, answers } }));
    const err = await ask.execute(new AbortController().signal).catch((e) => e);
    expect(err).toBeInstanceOf(SystemOneError);
    expect(err).toMatchObject({ code: "PROVIDER_INVALID", dispatched: true });
    expect(err.usage).toEqual({ input_tokens: 400, output_tokens: 0 });
  });

  it("refuses to send secret-looking text or an out-of-bounds question set", () => {
    expect(() => prepareAsk(config, "api_key = " + "a".repeat(32), questions)).toThrow(/secret/);
    expect(() => prepareAsk(config, "note: x", [])).toThrow(SystemOneError);
    expect(() => prepareAsk(config, "note: x", [questions[0], questions[0]])).toThrow(SystemOneError);
    const many = Array.from({ length: 17 }, (_, i) => ({ id: `q${i}`, type: "noul" as const, instructions: "?" }));
    expect(() => prepareAsk(config, "note: x", many)).toThrow(SystemOneError);
  });

  describe("Ollama", () => {
    const ollama = {
      provider: "ollama" as const,
      endpoint: "http://127.0.0.1:9/v1/systemone",
      model: "clef-flash",
      price: { version: "ollama-1", input_micro_usd_per_million: 90_000, output_micro_usd_per_million: 0 },
    };
    const plain = { ...ok.result, usage: { input_tokens: 400, output_tokens: 3 } };

    it("reads the plain top-level answer from a local Ollama without a key and prices input only", async () => {
      const ask = prepareAsk(ollama, "note: x", questions, respond(plain));
      const r = await ask.execute(new AbortController().signal);
      expect(r.answers).toHaveLength(2);
      expect(r.cost_micro_usd).toBe(Math.ceil((400 * 90_000) / 1_000_000));
    });

    it("accepts the base model name when a tagged model is configured", async () => {
      const ask = prepareAsk({ ...ollama, model: "clef-flash:cloud" }, "note: x", questions, respond(plain));
      const r = await ask.execute(new AbortController().signal);
      expect(r.model).toBe("clef-flash");
    });

    it("needs a key for ollama.com and sends it as a bearer token", async () => {
      const remote = { ...ollama, endpoint: "https://ollama.com/v1/systemone" };
      expect(() => prepareAsk(remote, "note: x", questions)).toThrow(SystemOneError);
      let headers: any;
      const fetcher = (async (_u: string, init: RequestInit) => {
        headers = init.headers;
        return new Response(JSON.stringify(plain));
      }) as unknown as typeof fetch;
      const key = "k".repeat(40);
      await prepareAsk({ ...remote, key }, "note: x", questions, fetcher).execute(new AbortController().signal);
      expect(headers.Authorization).toBe(`Bearer ${key}`);
    });

    it.each([
      ["another host", { endpoint: "https://evil.example/v1/systemone", key: "k".repeat(40) }],
      ["another path", { endpoint: "https://ollama.com/api/chat", key: "k".repeat(40) }],
      ["a non-Clef model", { model: "llama3" }],
    ])("refuses %s", (_label, patch) => {
      expect(() => prepareAsk({ ...ollama, ...patch }, "note: x", questions)).toThrow(SystemOneError);
    });
  });

  describe("deadline and transport bounds", () => {
    const fast = { ...config, timeout_ms: 30 };
    const never = () => new Promise<Response>(() => undefined);
    const stuckBody = () =>
      new Response(new ReadableStream({ start() {} }), { status: 200 });

    it("times out a fetcher that ignores its signal", async () => {
      const started = Date.now();
      const ask = prepareAsk(fast, "note: x", questions, never as unknown as typeof fetch);
      await expect(ask.execute(new AbortController().signal)).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT", dispatched: true });
      expect(Date.now() - started).toBeLessThan(500);
    });

    it("times out a body that never delivers or closes", async () => {
      const ask = prepareAsk(fast, "note: x", questions, (async () => stuckBody()) as unknown as typeof fetch);
      await expect(ask.execute(new AbortController().signal)).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT", dispatched: true });
    });

    it("reports a caller abort mid-flight as dispatched, and one before sending as not dispatched", async () => {
      const ask = prepareAsk({ ...config, timeout_ms: 5000 }, "note: x", questions, never as unknown as typeof fetch);
      const c = new AbortController();
      const pending = ask.execute(c.signal);
      setTimeout(() => c.abort(), 10);
      await expect(pending).rejects.toMatchObject({ code: "PROVIDER_ABORTED", dispatched: true });
      const pre = new AbortController();
      pre.abort();
      await expect(ask.execute(pre.signal)).rejects.toMatchObject({ code: "PROVIDER_ABORTED", dispatched: false });
    });

    it("rejects a response larger than the configured limit", async () => {
      const ask = prepareAsk({ ...config, max_response_bytes: 256 }, "note: x", questions, respond({ pad: "x".repeat(1000) }));
      await expect(ask.execute(new AbortController().signal)).rejects.toMatchObject({ code: "PROVIDER_INVALID", dispatched: true });
    });

    it("rejects an unaccepted model but keeps the usage", async () => {
      const ask = prepareAsk(config, "note: x", questions, respond({ ...ok, result: { ...ok.result, model: "other" } }));
      const err = await ask.execute(new AbortController().signal).catch((e) => e);
      expect(err).toMatchObject({ code: "PROVIDER_INVALID", dispatched: true });
      expect(err.usage).toEqual({ input_tokens: 400, output_tokens: 0 });
    });

    it("rejects a reported cost above the reserved bound but keeps the usage", async () => {
      const usage = { input_tokens: 1_000_000_000, output_tokens: 0 };
      const ask = prepareAsk(config, "note: x", questions, respond({ ...ok, result: { ...ok.result, usage } }));
      const err = await ask.execute(new AbortController().signal).catch((e) => e);
      expect(err).toMatchObject({ code: "PROVIDER_UNAVAILABLE", dispatched: true });
      expect(err.usage).toEqual(usage);
    });

    it("never leaks the credential through a transport error", async () => {
      const key = "k".repeat(40);
      const fetcher = (async () => {
        throw new Error(`connect failed for Bearer ${key}`);
      }) as unknown as typeof fetch;
      const ask = prepareAsk({ ...config, key }, "note: x", questions, fetcher);
      const err = await ask.execute(new AbortController().signal).catch((e) => e);
      expect(err).toMatchObject({ code: "PROVIDER_UNAVAILABLE", dispatched: true });
      expect(String(err.message)).not.toContain(key);
    });
  });

  it("reports a provider failure as dispatched with no answers", async () => {
    const ask = prepareAsk(config, "note: x", questions, respond({ success: false, errors: [{ code: 5006 }] }, 400));
    await expect(ask.execute(new AbortController().signal)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", dispatched: true });
  });
});
