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

  it("reports a provider failure as dispatched with no answers", async () => {
    const ask = prepareAsk(config, "note: x", questions, respond({ success: false, errors: [{ code: 5006 }] }, 400));
    await expect(ask.execute(new AbortController().signal)).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE", dispatched: true });
  });
});
