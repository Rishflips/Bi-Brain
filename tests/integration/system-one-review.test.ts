import { expect, it } from "vitest";
import { SystemOneProvider } from "../../packages/providers/system-one.ts";

const config = {
  provider: "typesafe" as const,
  endpoint: "https://api.typesafe.ai/v1/systemone",
  model: "jev-1.13.0",
  key: "synthetic-review-credential",
  price: {
    version: "synthetic-review-price",
    input_micro_usd_per_million: 1000,
    output_micro_usd_per_million: 0,
  },
  timeout_ms: 20,
};
const input = {
  state: "SYNTHETIC review fixture",
  instruction: "Select the matching category.",
  options: [
    { id: "note", description: "A saved note" },
    { id: "question", description: "An unresolved question" },
  ],
};

it("decision deadline covers a stalled response body after successful headers", async () => {
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"model":')); },
  }));
  const provider = new SystemOneProvider(config, async () => response);
  let guard: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      provider.decide(input, new AbortController().signal).then(
        () => "unexpected-success",
        (error: unknown) => error,
      ),
      new Promise((resolve) => { guard = setTimeout(() => resolve("deadline-not-enforced"), 150); }),
    ]);
    expect(result).toMatchObject({ code: "PROVIDER_TIMEOUT", dispatched: true });
  } finally {
    clearTimeout(guard);
  }
});

it("oversized streaming response is cancelled before it finishes downloading", async () => {
  let cancelled = false;
  let pulls = 0;
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      if (pulls < 10) controller.enqueue(new Uint8Array(128).fill(32));
      else controller.close();
    },
    cancel() { cancelled = true; },
  }));
  const provider = new SystemOneProvider({ ...config, max_response_bytes: 128 }, async () => response);
  await expect(provider.decide(input, new AbortController().signal)).rejects.toMatchObject({ dispatched: true });
  expect(cancelled).toBe(true);
  expect(pulls).toBeLessThan(10);
});

it("special object-property option IDs survive as actual own keys without changing the closed option set", async () => {
  let sent: any;
  const provider = new SystemOneProvider(config, async (_url, init) => {
    sent = JSON.parse(String(init?.body));
    return Response.json({
      model: "jev-1.13.0",
      answers: { decision: {
        type: "choice", choice: "__proto__", confidence: 0.8,
        probabilities: JSON.parse('{"__proto__":0.9,"note":0.1}'),
      } },
      usage: { input_tokens: 20, output_tokens: 0 },
    });
  });
  const result = await provider.decide({ ...input, options: [
    { id: "__proto__", description: "An allowed synthetic category" },
    { id: "note", description: "A note" },
  ] }, new AbortController().signal);
  expect(Object.keys(sent.questions.decision.criteria).sort()).toEqual(["__proto__", "note"]);
  expect(Object.hasOwn(result.probabilities, "__proto__")).toBe(true);
  expect(result.probabilities["__proto__"]).toBe(0.9);
});

it("cancellation before the scheduled fetch prevents even a signal-ignoring transport dispatch", async () => {
  let calls = 0;
  const provider = new SystemOneProvider(config, async () => {
    calls += 1;
    throw new Error("synthetic transport must not run");
  });
  const controller = new AbortController();
  const pending = provider.decide(input, controller.signal);
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: "PROVIDER_ABORTED" });
  expect(calls).toBe(0);
});

it("invalid decisions still retain independently validated known expenditure", async () => {
  const provider = new SystemOneProvider(config, async () => Response.json({
    model: "jev-1.13.0",
    answers: { decision: { type: "choice", choice: "invented", confidence: 1, probabilities: { invented: 1 } } },
    usage: { input_tokens: 10_000_000, output_tokens: 0 },
  }));
  await expect(provider.decide(input, new AbortController().signal)).rejects.toMatchObject({
    dispatched: true, usage: { input_tokens: 10_000_000, output_tokens: 0 },
    actual_cost_micro_usd: 10_000,
  });
});

it("a different reported model cannot silently use the configured model's price", async () => {
  const provider = new SystemOneProvider(config, async () => Response.json({
    model: "unapproved-model",
    answers: { decision: { type: "choice", choice: "note", confidence: 0.8, probabilities: { note: 0.9, question: 0.1 } } },
    usage: { input_tokens: 20, output_tokens: 0 },
  }));
  await expect(provider.decide(input, new AbortController().signal)).rejects.toMatchObject({
    dispatched: true, usage: { input_tokens: 20, output_tokens: 0 },
    actual_cost_micro_usd: undefined,
  });
});

it("failed provider responses cancel an unread streaming body", async () => {
  let cancelled = false;
  const provider = new SystemOneProvider(config, async () => new Response(new ReadableStream<Uint8Array>({
    start(stream) { stream.enqueue(new Uint8Array(32)); },
    cancel() { cancelled = true; },
  }), { status: 500 }));
  await expect(provider.decide(input, new AbortController().signal)).rejects.toMatchObject({ dispatched: true });
  expect(cancelled).toBe(true);
});
