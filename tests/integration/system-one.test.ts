import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { BrainError } from "../../packages/domain/logic.ts";
import {
  SYSTEM_ONE_POLICY_VERSION,
  SystemOneError,
  SystemOneProvider,
  decisionInputSchema,
  type DecisionInput,
  type DecisionProvider,
  type SystemOneConfig,
} from "../../packages/providers/system-one.ts";

// ---------------------------------------------------------------------------
// Synthetic fixtures. Nothing here contacts a real provider; the loopback
// fixture binds 127.0.0.1 only and returns canned synthetic bodies.
// ---------------------------------------------------------------------------

const OPTIONS = [
  { id: "billing", description: "Payments, invoices and refunds" },
  { id: "technical", description: "Outages, errors and configuration" },
  { id: "sales", description: "Plans and upgrades" },
];

function input(overrides: Partial<DecisionInput> = {}): DecisionInput {
  return {
    state: "SYNTHETIC: checkout has failed for every customer for the last hour.",
    instruction: "Which team should handle this request?",
    options: OPTIONS.map((option) => ({ ...option })),
    ...overrides,
  };
}

function officialBody(overrides: Record<string, unknown> = {}): unknown {
  return {
    model: "jev-1.13.0",
    answers: {
      decision: {
        type: "choice",
        choice: "technical",
        confidence: 0.81,
        probabilities: { billing: 0.12, technical: 0.88, sales: 0 },
        ...overrides,
      },
    },
    usage: { input_tokens: 318, output_tokens: 34 },
  };
}

function clefBody(overrides: Record<string, unknown> = {}): unknown {
  return {
    model: "clef-flash",
    answers: {
      decision: {
        type: "choice",
        choice: "technical",
        confidence: 0.81,
        probabilities: { billing: 0.12, technical: 0.88, sales: 0 },
        ...overrides,
      },
    },
    usage: { input_tokens: 318, output_tokens: 0 },
  };
}

function typesafeConfig(
  overrides: Partial<SystemOneConfig> = {},
): SystemOneConfig {
  return {
    provider: "typesafe",
    endpoint: "https://api.typesafe.ai/v1/systemone",
    model: "jev-latest",
    accepted_response_models: ["jev-1.13.0"],
    key: "synthetic-test-key",
    price: {
      version: "synthetic-price-2026-10-16",
      input_micro_usd_per_million: 1_000_000,
      output_micro_usd_per_million: 0,
    },
    ...overrides,
  };
}

function cloudflareConfig(
  overrides: Partial<SystemOneConfig> = {},
): SystemOneConfig {
  return {
    provider: "cloudflare",
    endpoint:
      "https://api.cloudflare.com/client/v4/accounts/synthetic-account/ai/run/@cf/cloudflare/clef-flash",
    model: "clef-flash",
    key: "synthetic-test-token",
    price: {
      version: "synthetic-price-2026-10-16",
      input_micro_usd_per_million: 38_000,
      output_micro_usd_per_million: 0,
    },
    ...overrides,
  };
}

function capturingFetcher(payload: unknown) {
  const captured: {
    url?: string;
    init?: RequestInit;
    body?: any;
    calls: number;
  } = { calls: 0 };
  const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
    captured.calls += 1;
    captured.url = String(url);
    captured.init = init;
    captured.body = init?.body ? JSON.parse(String(init.body)) : undefined;
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetcher: fetcher as unknown as typeof fetch, captured };
}

async function capture(run: () => Promise<unknown>): Promise<SystemOneError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof SystemOneError) return error;
    throw error;
  }
  throw new Error("expected the call to reject");
}

async function startFixture(
  handler: (
    req: IncomingMessage,
    res: ServerResponse,
    body: string,
  ) => void,
): Promise<{ endpoint: string; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => handler(req, res, Buffer.concat(chunks).toString("utf8")));
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}/clef`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe("SystemOneProvider typed transport", () => {
  it("parses the official choice response and sends a fixed option set", async () => {
    const { fetcher, captured } = capturingFetcher(officialBody());
    const provider = new SystemOneProvider(typesafeConfig(), fetcher);
    const result = await provider.decide(input(), new AbortController().signal);

    expect(result.choice).toBe("technical");
    expect(result.probabilities).toEqual({
      billing: 0.12,
      technical: 0.88,
      sales: 0,
    });
    expect(result.confidence).toBeCloseTo(0.81);
    expect(result.usage).toEqual({ input_tokens: 318, output_tokens: 34 });
    expect(result.cost_micro_usd).toBe(318);
    expect(Number.isSafeInteger(result.cost_micro_usd)).toBe(true);
    expect(result.metadata.provider).toBe("typesafe");
    expect(result.metadata.model).toBe("jev-1.13.0");
    expect(result.metadata.policy_version).toBe(SYSTEM_ONE_POLICY_VERSION);
    expect(result.metadata.price_version).toBe("synthetic-price-2026-10-16");

    expect(captured.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(captured.init?.method).toBe("POST");
    expect(captured.init?.redirect).toBe("error");
    expect(captured.init?.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer synthetic-test-key",
    });
    expect(captured.body.model).toBe("jev-latest");
    expect(captured.body.state).toBe(input().state);
    expect(captured.body.questions.decision.type).toBe("choice");
    expect(captured.body.questions.decision.instructions).toBe(
      input().instruction,
    );
    expect(Object.keys(captured.body.questions.decision.criteria)).toEqual([
      "billing",
      "technical",
      "sales",
    ]);
    expect(captured.calls).toBe(1);
  });

  it("returns a safe integer upper bound that covers the observed cost", async () => {
    const { fetcher } = capturingFetcher(officialBody());
    const provider = new SystemOneProvider(typesafeConfig(), fetcher);
    const bound = provider.upperBound(input());
    expect(Number.isSafeInteger(bound)).toBe(true);
    expect(bound).toBeGreaterThanOrEqual(318);
    const result = await provider.decide(input(), new AbortController().signal);
    expect(bound).toBeGreaterThanOrEqual(result.cost_micro_usd);
  });

  it("unwraps the Cloudflare Clef REST envelope", async () => {
    const { fetcher, captured } = capturingFetcher({
      success: true,
      errors: [],
      messages: [],
      result: clefBody(),
    });
    const provider = new SystemOneProvider(cloudflareConfig(), fetcher);
    const result = await provider.decide(input(), new AbortController().signal);
    expect(result.choice).toBe("technical");
    expect(result.metadata.provider).toBe("cloudflare");
    expect(result.metadata.model).toBe("clef-flash");
    expect(result.usage).toEqual({ input_tokens: 318, output_tokens: 0 });
    expect(captured.body.model).toBe("clef-flash");
    expect(captured.body.questions.decision.criteria).toEqual({
      billing: "Payments, invoices and refunds",
      technical: "Outages, errors and configuration",
      sales: "Plans and upgrades",
    });
  });

  it("satisfies the provider-neutral DecisionProvider contract", async () => {
    const neutral: DecisionProvider = {
      upperBound: () => 42,
      decide: async () => ({
        choice: "a",
        confidence: 1,
        probabilities: { a: 1, b: 0 },
        usage: { input_tokens: 0, output_tokens: 0 },
        metadata: {
          provider: "typesafe",
          model: "synthetic",
          policy_version: "p",
          price_version: "v",
        },
        cost_micro_usd: 0,
      }),
    };
    expect(neutral.upperBound(input())).toBe(42);
    const provider: DecisionProvider = new SystemOneProvider(
      typesafeConfig(),
      capturingFetcher(officialBody()).fetcher,
    );
    expect(
      await provider.decide(input(), new AbortController().signal),
    ).toBeTruthy();
  });

  it("validates the exported DecisionInput schema boundaries", () => {
    expect(() => decisionInputSchema.parse(input())).not.toThrow();
    const many = Array.from({ length: 17 }, (_, index) => ({
      id: `option_${index}`,
      description: "synthetic",
    }));
    for (const options of [
      [{ id: "only", description: "synthetic" }],
      many,
      [
        { id: "dup", description: "one" },
        { id: "dup", description: "two" },
      ],
      [
        { id: "a", description: "" },
        { id: "b", description: "two" },
      ],
      [
        { id: "bad id", description: "spaces" },
        { id: "b", description: "two" },
      ],
    ]) {
      expect(() =>
        decisionInputSchema.parse(input({ options: options as any })),
      ).toThrow();
    }
  });
});

// ---------------------------------------------------------------------------

describe("SystemOneProvider response validation", () => {
  const cases: Array<[string, unknown]> = [
    [
      "extra probability key",
      officialBody({
        probabilities: { billing: 0.12, technical: 0.88, sales: 0, ops: 0 },
      }),
    ],
    [
      "missing option probability",
      officialBody({ probabilities: { billing: 0.12, technical: 0.88 } }),
    ],
    ["unapproved choice", officialBody({ choice: "ops" })],
    [
      "choice is not the most probable option",
      officialBody({ choice: "billing" }),
    ],
    [
      "probabilities sum above one",
      officialBody({
        probabilities: { billing: 0.5, technical: 0.5, sales: 0.5 },
      }),
    ],
    [
      "probabilities sum below one",
      officialBody({
        probabilities: { billing: 0.1, technical: 0.1, sales: 0.1 },
      }),
    ],
    [
      "probability out of range",
      officialBody({
        probabilities: { billing: 1.4, technical: -0.4, sales: 0 },
      }),
    ],
    [
      "non numeric probability",
      officialBody({
        probabilities: { billing: "0.12", technical: 0.88, sales: 0 },
      }),
    ],
    ["confidence above one", officialBody({ confidence: 1.2 })],
    ["negative confidence", officialBody({ confidence: -0.1 })],
    ["missing confidence", officialBody({ confidence: undefined })],
    ["wrong answer type", officialBody({ type: "noul" })],
    [
      "missing decision answer",
      {
        model: "jev-1.13.0",
        answers: { other: { type: "choice" } },
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    ],
    [
      "extra answer key",
      {
        model: "jev-1.13.0",
        answers: {
          decision: {
            type: "choice",
            choice: "technical",
            confidence: 0.8,
            probabilities: { billing: 0.12, technical: 0.88, sales: 0 },
          },
          other: { type: "choice" },
        },
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    ],
    [
      "missing usage",
      {
        model: "jev-1.13.0",
        answers: {
          decision: {
            type: "choice",
            choice: "technical",
            confidence: 0.8,
            probabilities: { billing: 0.12, technical: 0.88, sales: 0 },
          },
        },
      },
    ],
    [
      "negative usage",
      {
        model: "jev-1.13.0",
        answers: (officialBody() as any).answers,
        usage: { input_tokens: -1, output_tokens: 0 },
      },
    ],
    [
      "fractional usage",
      {
        model: "jev-1.13.0",
        answers: (officialBody() as any).answers,
        usage: { input_tokens: 1.5, output_tokens: 0 },
      },
    ],
    [
      "unsafe usage",
      {
        model: "jev-1.13.0",
        answers: (officialBody() as any).answers,
        usage: { input_tokens: Number.MAX_SAFE_INTEGER + 2, output_tokens: 0 },
      },
    ],
    ["missing model", { ...(officialBody() as any), model: undefined }],
    ["non object payload", []],
  ];

  for (const [name, payload] of cases) {
    it(`rejects ${name} with a content-free error`, async () => {
      const provider = new SystemOneProvider(
        typesafeConfig(),
        capturingFetcher(payload).fetcher,
      );
      const error = await capture(() =>
        provider.decide(input(), new AbortController().signal),
      );
      expect(error.code).toBe("PROVIDER_INVALID");
      expect(error.dispatched).toBe(true);
    });
  }

  it("rejects malformed JSON without echoing the body", async () => {
    const canary = "SYNTHETIC_PROVIDER_BODY_CANARY";
    const fetcher = (async () =>
      new Response(`{"broken": ${canary}`, { status: 200 })) as unknown as typeof fetch;
    const provider = new SystemOneProvider(typesafeConfig(), fetcher);
    const error = await capture(() =>
      provider.decide(input(), new AbortController().signal),
    );
    expect(error.code).toBe("PROVIDER_INVALID");
    expect(error.message).not.toContain(canary);
  });

  it("rejects an explicit Cloudflare failure envelope", async () => {
    const provider = new SystemOneProvider(
      cloudflareConfig(),
      capturingFetcher({
        success: false,
        errors: [{ code: 7000, message: "synthetic failure" }],
        result: null,
      }).fetcher,
    );
    const error = await capture(() =>
      provider.decide(input(), new AbortController().signal),
    );
    expect(error.code).toBe("PROVIDER_UNAVAILABLE");
    expect(error.dispatched).toBe(true);
  });

  it("rejects a response over the configured byte bound", async () => {
    const provider = new SystemOneProvider(
      typesafeConfig({ max_response_bytes: 100 }),
      capturingFetcher(officialBody()).fetcher,
    );
    const error = await capture(() =>
      provider.decide(input(), new AbortController().signal),
    );
    expect(error.code).toBe("PROVIDER_INVALID");
  });
});

// ---------------------------------------------------------------------------

describe("SystemOneProvider configuration and dispatch guardrails", () => {
  it("rejects an input over the UTF-8 byte bound before dispatch", async () => {
    expect(Buffer.byteLength("€", "utf8")).toBe(3);
    const { fetcher, captured } = capturingFetcher(officialBody());
    const provider = new SystemOneProvider(
      typesafeConfig({ max_request_bytes: 2000 }),
      fetcher,
    );
    const oversized = input({ state: "€".repeat(600) });
    expect(() => provider.upperBound(oversized)).toThrow(SystemOneError);
    const error = await capture(() =>
      provider.decide(oversized, new AbortController().signal),
    );
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.dispatched).toBe(false);
    expect(captured.calls).toBe(0);
  });

  it("never sends secret-like content to a provider", async () => {
    const { fetcher, captured } = capturingFetcher(officialBody());
    const provider = new SystemOneProvider(typesafeConfig(), fetcher);
    const secret = "sk-proj-0123456789ABCDEFGHIJKLMNOP";
    const error = await capture(() =>
      provider.decide(
        input({ state: `token ${secret}` }),
        new AbortController().signal,
      ),
    );
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).not.toContain("sk-proj");
    expect(captured.calls).toBe(0);
  });

  it.each([
    ["remote plaintext", { endpoint: "http://api.typesafe.ai/v1/systemone" }],
    [
      "credentials in url",
      { endpoint: "https://user:pass@api.typesafe.ai/v1/systemone" },
    ],
    [
      "query in url",
      { endpoint: "https://api.typesafe.ai/v1/systemone?redirect=evil" },
    ],
    [
      "fragment in url",
      { endpoint: "https://api.typesafe.ai/v1/systemone#frag" },
    ],
    ["unapproved host", { endpoint: "https://evil.example/v1/systemone" }],
    [
      "nondefault remote port",
      { endpoint: "https://api.typesafe.ai:8443/v1/systemone" },
    ],
    [
      "unapproved typesafe path",
      { endpoint: "https://api.typesafe.ai/v1/other" },
    ],
    [
      "unapproved cloudflare path",
      {
        provider: "cloudflare" as const,
        endpoint: "https://api.cloudflare.com/client/v4/other",
      },
    ],
    [
      "cloudflare selector not matching the configured model",
      {
        provider: "cloudflare" as const,
        model: "clef",
        endpoint:
          "https://api.cloudflare.com/client/v4/accounts/synthetic-account/ai/run/@cf/cloudflare/clef-flash",
      },
    ],
  ])("rejects an insecure or unapproved endpoint: %s", (_name, overrides) => {
    expect(
      () =>
        new SystemOneProvider(
          typesafeConfig(overrides as Partial<SystemOneConfig>),
          capturingFetcher(officialBody()).fetcher,
        ),
    ).toThrow(SystemOneError);
  });

  it("allows an explicit local loopback endpoint without credentials", () => {
    expect(
      () =>
        new SystemOneProvider(
          typesafeConfig({
            endpoint: "http://127.0.0.1:8123/clef",
            key: undefined,
          }),
          capturingFetcher(officialBody()).fetcher,
        ),
    ).not.toThrow();
  });

  it("rejects paid dispatch without a verified price or key", () => {
    expect(
      () =>
        new SystemOneProvider(
          typesafeConfig({ price: undefined }),
          capturingFetcher(officialBody()).fetcher,
        ),
    ).toThrow(SystemOneError);
    expect(
      () =>
        new SystemOneProvider(
          typesafeConfig({ key: undefined }),
          capturingFetcher(officialBody()).fetcher,
        ),
    ).toThrow(SystemOneError);
  });

  it.each<[string, Partial<SystemOneConfig["price"]>]>([
    ["zero input price", { input_micro_usd_per_million: 0 }],
    ["negative output price", { output_micro_usd_per_million: -1 }],
    ["fractional input price", { input_micro_usd_per_million: 1.5 }],
    ["missing price version", { version: "" }],
    ["nonzero output price for remote dispatch", { output_micro_usd_per_million: 1000 }],
  ])("rejects invalid operator pricing: %s", (_name, bad) => {
    const base = typesafeConfig();
    expect(
      () =>
        new SystemOneProvider(
          typesafeConfig({ price: { ...base.price!, ...bad } }),
          capturingFetcher(officialBody()).fetcher,
        ),
    ).toThrow(SystemOneError);
  });

  it("accepts a zero output price for decision providers", () => {
    expect(
      () =>
        new SystemOneProvider(
          typesafeConfig({
            price: {
              version: "synthetic",
              input_micro_usd_per_million: 1000,
              output_micro_usd_per_million: 0,
            },
          }),
          capturingFetcher(officialBody()).fetcher,
        ),
    ).not.toThrow();
  });

  it("reserves a defensible output allowance from the response byte bound", () => {
    const provider = new SystemOneProvider(
      typesafeConfig({
        endpoint: "http://127.0.0.1:8123/clef",
        key: undefined,
        max_response_bytes: 1000,
        price: {
          version: "synthetic",
          input_micro_usd_per_million: 1,
          output_micro_usd_per_million: 1_000_000,
        },
      }),
      capturingFetcher(officialBody()).fetcher,
    );
    const bound = provider.upperBound(input());
    expect(Number.isSafeInteger(bound)).toBe(true);
    expect(bound).toBeGreaterThanOrEqual(1000);
  });

  it("rejects a remote endpoint with a nonzero output price", () => {
    expect(
      () =>
        new SystemOneProvider(
          typesafeConfig({
            price: {
              version: "synthetic",
              input_micro_usd_per_million: 1_000_000,
              output_micro_usd_per_million: 1_000,
            },
          }),
          capturingFetcher(officialBody()).fetcher,
        ),
    ).toThrow(SystemOneError);
  });

  it("does not price an unaccepted reported model but keeps validated usage", async () => {
    const provider = new SystemOneProvider(
      typesafeConfig(),
      capturingFetcher({ ...(officialBody() as any), model: "other-model" })
        .fetcher,
    );
    const error = await capture(() =>
      provider.decide(input(), new AbortController().signal),
    );
    expect(error.code).toBe("PROVIDER_INVALID");
    expect(error.dispatched).toBe(true);
    expect(error.usage).toEqual({ input_tokens: 318, output_tokens: 34 });
    expect(error.actual_cost_micro_usd).toBeUndefined();
  });

  it("requires an operator-declared returned identifier when requesting an alias", async () => {
    const provider = new SystemOneProvider(
      typesafeConfig({ accepted_response_models: undefined }),
      capturingFetcher(officialBody()).fetcher,
    );
    const error = await capture(() =>
      provider.decide(input(), new AbortController().signal),
    );
    expect(error.code).toBe("PROVIDER_INVALID");
    expect(error.actual_cost_micro_usd).toBeUndefined();
  });

  it("retains independently validated usage and known cost for an invalid decision", async () => {
    const provider = new SystemOneProvider(
      typesafeConfig(),
      capturingFetcher({
        model: "jev-1.13.0",
        answers: {
          decision: {
            type: "choice",
            choice: "invented",
            confidence: 1,
            probabilities: { invented: 1 },
          },
        },
        usage: { input_tokens: 10_000_000, output_tokens: 0 },
      }).fetcher,
    );
    const error = await capture(() =>
      provider.decide(input(), new AbortController().signal),
    );
    expect(error.dispatched).toBe(true);
    expect(error.usage).toEqual({ input_tokens: 10_000_000, output_tokens: 0 });
    expect(error.actual_cost_micro_usd).toBe(10_000_000);
  });

  it("cancels an unread streaming body on a failed provider response", async () => {
    let cancelled = false;
    const fetcher = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(stream) {
            stream.enqueue(new Uint8Array(32));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 500 },
      )) as unknown as typeof fetch;
    const provider = new SystemOneProvider(typesafeConfig(), fetcher);
    const error = await capture(() =>
      provider.decide(input(), new AbortController().signal),
    );
    expect(error.code).toBe("PROVIDER_UNAVAILABLE");
    expect(error.dispatched).toBe(true);
    expect(cancelled).toBe(true);
  });

  it("detects a secret at the end of a maximum-length state before dispatch", async () => {
    const { fetcher, captured } = capturingFetcher(officialBody());
    const provider = new SystemOneProvider(typesafeConfig(), fetcher);
    const secret = "sk-proj-0123456789ABCDEFGHIJKLMNOP";
    const state = "a".repeat(200000 - secret.length - 1) + " " + secret;
    expect(state.length).toBe(200000);
    const error = await capture(() =>
      provider.decide(input({ state }), new AbortController().signal),
    );
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.dispatched).toBe(false);
    expect(captured.calls).toBe(0);
  });

  it("does not bypass the safe-integer cost bound before dispatch", async () => {
    const { fetcher, captured } = capturingFetcher(officialBody());
    const provider = new SystemOneProvider(
      typesafeConfig({
        price: {
          version: "synthetic",
          input_micro_usd_per_million: Number.MAX_SAFE_INTEGER,
          output_micro_usd_per_million: 0,
        },
      }),
      fetcher,
    );
    expect(() => provider.upperBound(input())).toThrow(SystemOneError);
    const error = await capture(() =>
      provider.decide(input(), new AbortController().signal),
    );
    expect(error.code).toBe("PROVIDER_UNAVAILABLE");
    expect(error.dispatched).toBe(false);
    expect(captured.calls).toBe(0);
  });

  it("rejects a reported cost above the reserved bound without claiming zero cost", async () => {
    const provider = new SystemOneProvider(
      typesafeConfig(),
      capturingFetcher({
        model: "jev-1.13.0",
        answers: {
          decision: {
            type: "choice",
            choice: "technical",
            confidence: 0.8,
            probabilities: { billing: 0.12, technical: 0.88, sales: 0 },
          },
        },
        usage: { input_tokens: 10_000_000, output_tokens: 0 },
      }).fetcher,
    );
    const error = await capture(() =>
      provider.decide(input(), new AbortController().signal),
    );
    expect(error.dispatched).toBe(true);
    expect(["PROVIDER_UNAVAILABLE", "PROVIDER_INVALID"]).toContain(error.code);
    expect(error.usage).toEqual({ input_tokens: 10_000_000, output_tokens: 0 });
    expect(error.actual_cost_micro_usd).toBe(10_000_000);
  });

  it("wraps a foreign fetcher error instead of rethrowing it", async () => {
    const fetcher = (async () => {
      throw new BrainError("LEAK", "synthetic secret body", 500);
    }) as unknown as typeof fetch;
    const provider = new SystemOneProvider(typesafeConfig(), fetcher);
    const error = await capture(() =>
      provider.decide(input(), new AbortController().signal),
    );
    expect(error).toBeInstanceOf(SystemOneError);
    expect(error.code).toBe("PROVIDER_UNAVAILABLE");
    expect(error.dispatched).toBe(true);
    expect(error.message).not.toContain("synthetic secret body");
  });

  it("rejects a reported model name containing control characters", async () => {
    const provider = new SystemOneProvider(
      typesafeConfig(),
      capturingFetcher({ ...(officialBody() as any), model: "jev\u0000bad" })
        .fetcher,
    );
    const error = await capture(() =>
      provider.decide(input(), new AbortController().signal),
    );
    expect(error.code).toBe("PROVIDER_INVALID");
  });

  it("preserves a '__proto__' option id as an own key end to end", async () => {
    const { fetcher, captured } = capturingFetcher({
      model: "jev-1.13.0",
      answers: {
        decision: {
          type: "choice",
          choice: "__proto__",
          confidence: 0.8,
          probabilities: JSON.parse('{"__proto__":0.9,"note":0.1}'),
        },
      },
      usage: { input_tokens: 20, output_tokens: 0 },
    });
    const provider = new SystemOneProvider(typesafeConfig(), fetcher);
    const result = await provider.decide(
      input({
        options: [
          { id: "__proto__", description: "synthetic allowed category" },
          { id: "note", description: "synthetic note" },
        ],
      }),
      new AbortController().signal,
    );
    expect(
      Object.keys(captured.body.questions.decision.criteria).sort(),
    ).toEqual(["__proto__", "note"]);
    expect(Object.hasOwn(result.probabilities, "__proto__")).toBe(true);
    expect(result.probabilities["__proto__"]).toBe(0.9);
    expect(result.choice).toBe("__proto__");
  });

  it("refuses to follow a redirect", async () => {
    const fetcher = (async () =>
      new Response("", {
        status: 302,
        headers: { location: "https://evil.example/steal" },
      })) as unknown as typeof fetch;
    const provider = new SystemOneProvider(typesafeConfig(), fetcher);
    const error = await capture(() =>
      provider.decide(input(), new AbortController().signal),
    );
    expect(error.code).toBe("PROVIDER_UNAVAILABLE");
    expect(error.dispatched).toBe(true);
  });

  it("marks a transport failure as dispatched instead of zero cost", async () => {
    let calls = 0;
    const fetcher = (async () => {
      calls += 1;
      throw new TypeError("synthetic network failure");
    }) as unknown as typeof fetch;
    const provider = new SystemOneProvider(typesafeConfig(), fetcher);
    const error = await capture(() =>
      provider.decide(input(), new AbortController().signal),
    );
    expect(error.code).toBe("PROVIDER_UNAVAILABLE");
    expect(error.dispatched).toBe(true);
    expect(calls).toBe(1);
  });

  it("does not retry a failed dispatch", async () => {
    let calls = 0;
    const fetcher = (async () => {
      calls += 1;
      return new Response("synthetic", { status: 500 });
    }) as unknown as typeof fetch;
    const provider = new SystemOneProvider(typesafeConfig(), fetcher);
    const error = await capture(() =>
      provider.decide(input(), new AbortController().signal),
    );
    expect(error.code).toBe("PROVIDER_UNAVAILABLE");
    expect(calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe("SystemOneProvider timeout and cancellation", () => {
  it("enforces a finite timeout even when the fetcher ignores signals", async () => {
    const fetcher = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const provider = new SystemOneProvider(
      typesafeConfig({ timeout_ms: 25 }),
      fetcher,
    );
    const started = Date.now();
    const error = await capture(() =>
      provider.decide(input(), new AbortController().signal),
    );
    expect(error.code).toBe("PROVIDER_TIMEOUT");
    expect(error.dispatched).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("honours caller cancellation even when the fetcher ignores signals", async () => {
    const controller = new AbortController();
    const fetcher = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    const provider = new SystemOneProvider(typesafeConfig(), fetcher);
    const pending = capture(() => provider.decide(input(), controller.signal));
    controller.abort();
    const error = await pending;
    expect(error.code).toBe("PROVIDER_ABORTED");
    expect(error.dispatched).toBe(true);
  });

  it("rejects an already aborted caller before dispatch", async () => {
    const controller = new AbortController();
    controller.abort();
    const { fetcher, captured } = capturingFetcher(officialBody());
    const provider = new SystemOneProvider(typesafeConfig(), fetcher);
    const error = await capture(() =>
      provider.decide(input(), controller.signal),
    );
    expect(error.code).toBe("PROVIDER_ABORTED");
    expect(error.dispatched).toBe(false);
    expect(captured.calls).toBe(0);
  });

  it("clears its timeout timer after settling", async () => {
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    const provider = new SystemOneProvider(
      typesafeConfig(),
      capturingFetcher(officialBody()).fetcher,
    );
    await provider.decide(input(), new AbortController().signal);
    expect(clearSpy).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe("SystemOneProvider against a disposable loopback fixture", () => {
  it("dispatches to a real local HTTP endpoint without credentials", async () => {
    let seen = "";
    const fixture = await startFixture((_req, res, body) => {
      seen = body;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(officialBody()));
    });
    try {
      const provider = new SystemOneProvider(
        typesafeConfig({ endpoint: fixture.endpoint, key: undefined }),
        fetch,
      );
      const result = await provider.decide(input(), new AbortController().signal);
      expect(result.choice).toBe("technical");
      expect(result.cost_micro_usd).toBe(318);
      expect(seen).toContain('"decision"');
    } finally {
      await fixture.close();
    }
  });

  it("times out against a hung local endpoint", async () => {
    const fixture = await startFixture(() => {
      /* never respond */
    });
    try {
      const provider = new SystemOneProvider(
        typesafeConfig({
          endpoint: fixture.endpoint,
          key: undefined,
          timeout_ms: 40,
        }),
        fetch,
      );
      const error = await capture(() =>
        provider.decide(input(), new AbortController().signal),
      );
      expect(error.code).toBe("PROVIDER_TIMEOUT");
      expect(error.dispatched).toBe(true);
    } finally {
      await fixture.close();
    }
  });
});
