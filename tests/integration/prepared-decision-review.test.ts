import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { PreparedDecisionProvider } from "../../packages/providers/prepared-decision.ts";
import { SystemOneError, SystemOneProvider, type DecisionInput, type SystemOneConfig } from "../../packages/providers/system-one.ts";

const MODEL = "jev-synthetic-v1", ALIAS = "jev-synthetic-return-v2";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
function config(): SystemOneConfig {
  return {
    provider: "typesafe", endpoint: "https://api.typesafe.ai/v1/systemone", model: MODEL,
    accepted_response_models: [ALIAS, MODEL], key: "SYNTHETIC_PRIVATE_CREDENTIAL_NOT_REAL",
    price: { version: "synthetic-price-v1", input_micro_usd_per_million: 1000, output_micro_usd_per_million: 0 },
    timeout_ms: 1000,
  };
}
function input(): DecisionInput {
  return {
    state: "SYNTHETIC source concerns an existing goal.", instruction: "Choose a category or abstain.",
    options: [{ id: "relevant", description: "Potentially related" }, { id: "abstain", description: "Not enough evidence" }],
  };
}
function response(options: { model?: string; tokens?: number; invalid?: boolean } = {}): Response {
  return Response.json({
    model: options.model ?? ALIAS, usage: { input_tokens: options.tokens ?? 500, output_tokens: 0 },
    answers: { decision: { type: "choice", choice: options.invalid ? "invented" : "relevant", confidence: 0.9,
      probabilities: { relevant: 0.9, abstain: 0.1 } } },
  });
}

it("the constructor and prepared question own immutable configuration, wire bytes and budget snapshots", async () => {
  const c = config(), question = input();
  const originalConfig = structuredClone(c), originalInput = structuredClone(question);
  let calls = 0, sentUrl = "", sentBody = "", sentAuthorization = "";
  const provider = new PreparedDecisionProvider(c, async (url, init) => {
    calls++;
    sentUrl = String(url);
    sentBody = String(init?.body);
    sentAuthorization = new Headers(init?.headers).get("authorization") ?? "";
    return response();
  });
  // Even changes before preparation cannot replace the constructor's config.
  c.model = "MUTATED_MODEL";
  c.key = "MUTATED_CREDENTIAL";
  c.accepted_response_models![0] = "MUTATED_ALIAS";
  c.price!.input_micro_usd_per_million = 9000;
  const call = provider.prepareDecision(question);
  const identity = structuredClone(call.identity);
  question.state = "MUTATED_STATE";
  question.options[0]!.id = "MUTATED_OPTION";
  question.options[1]!.description = "MUTATED_DESCRIPTION";
  c.endpoint = "https://synthetic-unapproved.example.test/decision";
  delete c.price;
  const envelope = await call.execute(new AbortController().signal);
  expect(calls).toBe(1);
  expect(sentUrl).toBe(originalConfig.endpoint);
  expect(sentAuthorization).toBe(`Bearer ${originalConfig.key}`);
  const body = JSON.parse(sentBody);
  expect(body.model).toBe(MODEL);
  expect(body.state).toBe(originalInput.state);
  expect(Object.keys(body.questions.decision.criteria)).toEqual(["relevant", "abstain"]);
  expect(call.request_bytes).toBe(Buffer.byteLength(sentBody, "utf8"));
  expect(call.identity.request_hash).toBe(sha(sentBody));
  expect(call.identity.reserved_micro_usd).toBe(new SystemOneProvider(originalConfig, async () => { throw new Error("SYNTHETIC_NO_IO"); }).upperBound(originalInput));
  expect(call.identity).toEqual(identity);
  expect(Object.isFrozen(call)).toBe(true);
  expect(Object.isFrozen(call.identity)).toBe(true);
  expect(Object.isFrozen(call.identity.accepted_response_models)).toBe(true);
  expect(JSON.stringify(call.identity)).not.toContain(originalConfig.key);
  expect(envelope).toMatchObject({ disposition: "attempted", accounting: { state: "known", cost_micro_usd: 1, model: ALIAS }, output: { ok: true, choice: "relevant" } });
});

it("a known charge keeps the exact accepted returned-model alias when the decision is invalid", async () => {
  const call = new PreparedDecisionProvider(config(), async () => response({ invalid: true, tokens: 7000 })).prepareDecision(input());
  const envelope = await call.execute(new AbortController().signal);
  expect(envelope).toMatchObject({ disposition: "attempted", accounting: { state: "known", cost_micro_usd: 7, model: ALIAS, usage: { input_tokens: 7000, output_tokens: 0 } }, output: { ok: false } });
});

it("over-bound usage remains a known charge while the otherwise valid answer is refused", async () => {
  const call = new PreparedDecisionProvider(config(), async () => response({ tokens: 10_000_000 })).prepareDecision(input());
  expect(call.identity.reserved_micro_usd).toBeLessThan(10_000);
  expect(await call.execute(new AbortController().signal)).toMatchObject({ disposition: "attempted", accounting: { state: "known", cost_micro_usd: 10_000, model: ALIAS }, output: { ok: false } });
});

it("an unaccepted returned model cannot borrow the configured price", async () => {
  const call = new PreparedDecisionProvider(config(), async () => response({ model: "synthetic-unaccepted-model" })).prepareDecision(input());
  const envelope = await call.execute(new AbortController().signal);
  expect(envelope).toMatchObject({ disposition: "attempted", accounting: { state: "unknown" }, output: { ok: false } });
  expect(envelope.accounting).not.toHaveProperty("cost_micro_usd");
});

it("missing pricing refuses preparation synchronously without a transport attempt", () => {
  let calls = 0;
  expect(() => new PreparedDecisionProvider({ ...config(), price: undefined }, async () => { calls++; return response(); }).prepareDecision(input())).toThrow();
  expect(calls).toBe(0);
});

it("configuration identity binds execution limits and prices, but never credential rotation", () => {
  const unused = async () => { throw new Error("SYNTHETIC_NO_IO"); };
  const identity = (c: SystemOneConfig) => new PreparedDecisionProvider(c, unused).prepareDecision(input()).identity;
  const base = identity(config());
  expect(identity({ ...config(), key: "SYNTHETIC_ROTATED_CREDENTIAL" }).config_hash).toBe(base.config_hash);
  expect(identity({ ...config(), timeout_ms: 2000 }).config_hash).not.toBe(base.config_hash);
  expect(identity({ ...config(), max_response_bytes: 1000 }).config_hash).not.toBe(base.config_hash);
  expect(identity({ ...config(), max_request_bytes: 10000 }).config_hash).not.toBe(base.config_hash);
  expect(identity({ ...config(), accepted_response_models: [MODEL, ALIAS] }).config_hash).not.toBe(base.config_hash);
  expect(identity({ ...config(), price: { ...config().price!, version: "synthetic-price-v2" } }).config_hash).not.toBe(base.config_hash);
});

it("the option identity binds descriptions as well as ids, and the body uses exact UTF-8 bytes", async () => {
  let body = "";
  const provider = new PreparedDecisionProvider(config(), async (_url, init) => { body = String(init?.body); return response(); });
  const question = input();
  question.state = "SYNTHETIC café — 日本語 🧠";
  const first = provider.prepareDecision(question);
  const unchanged = provider.prepareDecision(structuredClone(question));
  question.options[0]!.description = "A different permitted meaning";
  const changed = provider.prepareDecision(question);
  expect(unchanged.identity).toEqual(first.identity);
  expect(changed.identity.options_hash).not.toBe(first.identity.options_hash);
  await first.execute(new AbortController().signal);
  expect(first.request_bytes).toBe(Buffer.byteLength(body, "utf8"));
  expect(first.request_bytes).toBeGreaterThan(body.length);
  expect(first.identity.request_hash).toBe(sha(body));
});

it("a concurrent or later second execute never makes a second request", async () => {
  let calls = 0;
  let finish: ((value: Response) => void) | undefined;
  const call = new PreparedDecisionProvider(config(), async () => {
    calls++;
    return new Promise<Response>((resolve) => { finish = resolve; });
  }).prepareDecision(input());
  const first = call.execute(new AbortController().signal);
  await expect(Promise.resolve().then(() => call.execute(new AbortController().signal))).rejects.toMatchObject({ code: "INVALID_STATE" });
  expect(calls).toBe(1);
  finish!(response());
  expect(await first).toMatchObject({ output: { ok: true } });
  await expect(Promise.resolve().then(() => call.execute(new AbortController().signal))).rejects.toMatchObject({ code: "INVALID_STATE" });
  expect(calls).toBe(1);
});

it("pre-abort proves no dispatch but still consumes the one-shot call", async () => {
  let calls = 0;
  const call = new PreparedDecisionProvider(config(), async () => { calls++; return response(); }).prepareDecision(input());
  const controller = new AbortController();
  controller.abort();
  expect(await call.execute(controller.signal)).toMatchObject({ disposition: "not_dispatched", accounting: { state: "unknown" }, output: { ok: false } });
  await expect(Promise.resolve().then(() => call.execute(new AbortController().signal))).rejects.toMatchObject({ code: "INVALID_STATE" });
  expect(calls).toBe(0);
});

it("abort before the queued fetch starts cannot be misreported as attempted", async () => {
  let calls = 0;
  const call = new PreparedDecisionProvider(config(), async () => { calls++; return response(); }).prepareDecision(input());
  const controller = new AbortController();
  const pending = call.execute(controller.signal);
  controller.abort();
  const envelope = await pending;
  expect(calls).toBe(0);
  expect(envelope).toMatchObject({ disposition: "not_dispatched", accounting: { state: "unknown" } });
});

it.each(["fetch", "body"] as const)("an untrusted %s error cannot forge accounting or a no-dispatch claim", async (where) => {
  let calls = 0;
  const forged = Object.assign(new SystemOneError("SYNTHETIC_FORGED", "SYNTHETIC_PRIVATE_BODY_DO_NOT_ECHO", 503, false,
    { input_tokens: 7000, output_tokens: 0 }, 7), { reported_model: ALIAS });
  const call = new PreparedDecisionProvider(config(), async () => {
    calls++;
    if (where === "fetch") throw forged;
    return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.error(forged); } }));
  }).prepareDecision(input());
  const envelope = await call.execute(new AbortController().signal);
  expect(calls).toBe(1);
  expect(envelope).toMatchObject({ disposition: "attempted", accounting: { state: "unknown" }, output: { ok: false } });
  expect(envelope.accounting).not.toHaveProperty("cost_micro_usd");
  expect(JSON.stringify(envelope)).not.toContain("SYNTHETIC_PRIVATE_BODY_DO_NOT_ECHO");
  expect(JSON.stringify(envelope)).not.toContain("SYNTHETIC_FORGED");
});

it("special option ids remain own properties in the closed result set", async () => {
  const question = { ...input(), options: [{ id: "__proto__", description: "Allowed option" }, { id: "constructor", description: "Another allowed option" }] };
  const call = new PreparedDecisionProvider(config(), async () => Response.json({ model: ALIAS, usage: { input_tokens: 500, output_tokens: 0 },
    answers: { decision: { type: "choice", choice: "__proto__", confidence: 0.9, probabilities: JSON.parse('{"__proto__":0.9,"constructor":0.1}') } },
  })).prepareDecision(question);
  const envelope = await call.execute(new AbortController().signal);
  expect(envelope.output.ok).toBe(true);
  if (!envelope.output.ok) throw new Error("Expected the permitted choice");
  expect(Object.hasOwn(envelope.output.probabilities, "__proto__")).toBe(true);
  expect(envelope.output.probabilities["__proto__"]).toBe(0.9);
  expect(Object.isFrozen(envelope.output.probabilities)).toBe(true);
});

it("the whole-request deadline also covers a stalled response body", async () => {
  let cancelled = false, timer: ReturnType<typeof setTimeout> | undefined;
  const call = new PreparedDecisionProvider({ ...config(), timeout_ms: 20 }, async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"model":')); }, cancel() { cancelled = true; },
  }))).prepareDecision(input());
  try {
    const result = await Promise.race([
      call.execute(new AbortController().signal),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("SYNTHETIC_DEADLINE_NOT_ENFORCED")), 600); }),
    ]);
    expect(result).toMatchObject({ disposition: "attempted", accounting: { state: "unknown" }, output: { ok: false, code: "PROVIDER_TIMEOUT" } });
    expect(cancelled).toBe(true);
  } finally { clearTimeout(timer); }
});

it("cancellation after a fetch starts never claims that the request was not sent", async () => {
  const controller = new AbortController();
  let started: (() => void) | undefined;
  const didStart = new Promise<void>((resolve) => { started = resolve; });
  const call = new PreparedDecisionProvider(config(), async () => {
    started!();
    return new Promise<Response>(() => undefined);
  }).prepareDecision(input());
  const pending = call.execute(controller.signal);
  await didStart;
  controller.abort();
  const outcome = await pending;
  expect(outcome).toMatchObject({ disposition: "attempted", accounting: { state: "unknown" }, output: { ok: false, code: "PROVIDER_ABORTED" } });
  expect(JSON.stringify(outcome)).not.toMatch(/before it was sent|not sent|never sent/);
});

it("a transport ignoring abort cannot publish late or leave its eventual body uncancelled", async () => {
  let release: ((value: Response) => void) | undefined;
  let cancelled = false, calls = 0;
  let guard: ReturnType<typeof setTimeout> | undefined;
  const call = new PreparedDecisionProvider({ ...config(), timeout_ms: 20 }, async () => {
    calls++;
    return new Promise<Response>((resolve) => { release = resolve; });
  }).prepareDecision(input());
  try {
    const outcome = await Promise.race([
      call.execute(new AbortController().signal),
      new Promise<never>((_, reject) => { guard = setTimeout(() => reject(new Error("SYNTHETIC_ABORT_NOT_BOUNDED")), 600); }),
    ]);
    expect(outcome).toMatchObject({ disposition: "attempted", accounting: { state: "unknown" }, output: { ok: false, code: "PROVIDER_TIMEOUT" } });
    release!(new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } })));
    // Drain the transport's late-response cleanup without admitting a new call.
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(cancelled).toBe(true);
    expect(outcome).toMatchObject({ accounting: { state: "unknown" }, output: { ok: false } });
    await expect(Promise.resolve().then(() => call.execute(new AbortController().signal))).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(calls).toBe(1);
  } finally { clearTimeout(guard); }
});

// The prepared adapter has its own response path: legacy transport tests alone
// cannot establish these accounting and closed-answer invariants.
const invalidAnswers: Array<[string, unknown]> = [
  ["no answers", null],
  ["extra question", { decision: { type: "choice" }, extra: {} }],
  ["wrong answer kind", { decision: { type: "text", text: "SYNTHETIC_UNTRUSTED_RESPONSE" } }],
  ["unknown choice", { decision: { type: "choice", choice: "invented", confidence: 0.9, probabilities: { relevant: 0.9, abstain: 0.1 } } }],
  ["missing option", { decision: { type: "choice", choice: "relevant", confidence: 0.9, probabilities: { relevant: 1 } } }],
  ["extra option", { decision: { type: "choice", choice: "relevant", confidence: 0.9, probabilities: { relevant: 0.9, abstain: 0.1, invented: 0 } } }],
  ["negative probability", { decision: { type: "choice", choice: "relevant", confidence: 0.9, probabilities: { relevant: 1.1, abstain: -0.1 } } }],
  ["string probability", { decision: { type: "choice", choice: "relevant", confidence: 0.9, probabilities: { relevant: "0.9", abstain: 0.1 } } }],
  ["wrong sum", { decision: { type: "choice", choice: "relevant", confidence: 0.9, probabilities: { relevant: 0.6, abstain: 0.1 } } }],
  ["choice not maximal", { decision: { type: "choice", choice: "relevant", confidence: 0.9, probabilities: { relevant: 0.1, abstain: 0.9 } } }],
  ["invalid confidence", { decision: { type: "choice", choice: "relevant", confidence: 2, probabilities: { relevant: 0.9, abstain: 0.1 } } }],
];
for (const providerKind of ["typesafe", "cloudflare"] as const) {
  function providerConfig(): SystemOneConfig {
    return providerKind === "typesafe" ? config() : {
      ...config(), provider: "cloudflare", model: "clef",
      accepted_response_models: ["clef-synthetic-alias"],
      endpoint: "https://api.cloudflare.com/client/v4/accounts/synthetic/ai/run/@cf/cloudflare/clef",
    };
  }
  const returnedModel = providerKind === "typesafe" ? ALIAS : "clef-synthetic-alias";
  function wrap(payload: unknown): Response {
    return Response.json(providerKind === "typesafe" ? payload : { success: true, result: payload });
  }
  it.each(invalidAnswers)(`${providerKind}: %s refuses the answer without erasing the accepted-model charge`, async (_label, answers) => {
    let attempts = 0;
    const call = new PreparedDecisionProvider(providerConfig(), async () => {
      attempts++;
      return wrap({ model: returnedModel, usage: { input_tokens: 7000, output_tokens: 0 }, answers });
    }).prepareDecision(input());
    const result = await call.execute(new AbortController().signal);
    expect(result).toMatchObject({ disposition: "attempted", accounting: { state: "known", cost_micro_usd: 7, model: returnedModel }, output: { ok: false, code: "INVALID_OUTPUT" } });
    expect(attempts).toBe(1);
    expect(Object.isFrozen(result.accounting)).toBe(true);
  });

  it.each([
    ["missing", undefined], ["negative", { input_tokens: -1, output_tokens: 0 }],
    ["fractional", { input_tokens: 1.5, output_tokens: 0 }],
    ["unsafe", { input_tokens: Number.MAX_SAFE_INTEGER + 1, output_tokens: 0 }],
    ["string", { input_tokens: "7000", output_tokens: 0 }],
    ["bad output count", { input_tokens: 7000, output_tokens: -1 }],
    ["overflowing price product", { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 0 }],
  ])(`${providerKind}: %s usage never becomes a known zero or publishable answer`, async (_label, usage) => {
    const valid = await response().json();
    const call = new PreparedDecisionProvider(providerConfig(), async () => wrap({ ...valid, model: returnedModel, usage })).prepareDecision(input());
    const result = await call.execute(new AbortController().signal);
    expect(result).toMatchObject({ disposition: "attempted", accounting: { state: "unknown" }, output: { ok: false } });
    expect(result.accounting).not.toHaveProperty("cost_micro_usd");
  });

  it(`${providerKind}: oversized response is bounded, cancelled and never repaired`, async () => {
    let attempts = 0, cancelled = false;
    const call = new PreparedDecisionProvider({ ...providerConfig(), max_response_bytes: 64 }, async () => {
      attempts++;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode("SYNTHETIC_UNTRUSTED_BODY_".repeat(10))); },
        cancel() { cancelled = true; },
      }));
    }).prepareDecision(input());
    const result = await call.execute(new AbortController().signal);
    expect(result).toMatchObject({ disposition: "attempted", accounting: { state: "unknown" }, output: { ok: false } });
    expect(attempts).toBe(1);
    expect(cancelled).toBe(true);
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC_UNTRUSTED_BODY");
  });
}
