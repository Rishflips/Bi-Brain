import { describe, expect, it } from "vitest";
import {
  PreparedReasoningProvider,
  REASONING_REQUEST_FRAMING_BYTES,
  type PrepareRequest,
  type ReasoningConfig,
} from "../../packages/providers/prepared.ts";
import { BrainError } from "../../packages/domain/logic.ts";
import type { Source } from "../../packages/contracts/index.ts";

// ---------------------------------------------------------------------------
// Synthetic fixtures only. The injected fetcher never contacts a network.
// Each fixture is a fresh clone so a mutation in one test cannot leak into or
// mask the evidence-validation behaviour of another.
// ---------------------------------------------------------------------------

const sourceFixture = (over: Partial<Source> = {}): Source => ({
  id: "src-1",
  project_id: "inbox",
  version: 1,
  title: "Note",
  body: "SYNTHETIC note body about the beta.",
  visibility: "project",
  state: "active",
  captured_at: "2026-10-16T09:00:00Z",
  origin: "owner",
  ...over,
});

const brief = (): PrepareRequest => ({ kind: "brief", sources: [sourceFixture()] });

function config(over: Partial<ReasoningConfig> = {}): ReasoningConfig {
  return {
    model: "gpt-test-1",
    accepted_response_models: ["gpt-test-1"],
    key: "synthetic-not-real",
    price: {
      version: "synthetic-price-2026-10-16",
      input_micro_usd_per_million: 1_000_000,
      output_micro_usd_per_million: 2_000_000,
    },
    max_output_tokens: 2000,
    ...over,
  };
}

type Capture = { calls: number; body: any };
function reply(payload: unknown): { fetcher: typeof fetch; state: Capture } {
  const state: Capture = { calls: 0, body: undefined };
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
    state.calls += 1;
    state.body = init?.body ? JSON.parse(String(init.body)) : undefined;
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetcher, state };
}

const goodBrief = (model = "gpt-test-1") => ({
  model,
  output: [
    {
      content: [
        {
          type: "output_text",
          text: JSON.stringify({
            items: [
              {
                text: "The beta uses a synthetic note.",
                epistemic_status: "supported",
                evidence: [
                  {
                    source_id: "src-1",
                    source_version: 1,
                    start: 0,
                    end: 9,
                    quote: "SYNTHETIC",
                  },
                ],
              },
            ],
            unknowns: [],
          }),
        },
      ],
    },
  ],
  usage: { input_tokens: 10, output_tokens: 5 },
});

const expectedBound = (input: number, output: number) =>
  Math.ceil((input * 1_000_000 + output * 2_000_000) / 1_000_000);

describe("PreparedReasoningProvider", () => {
  it("builds a frozen, no-I/O call with the exact checked byte+output bound", async () => {
    const { fetcher, state } = reply(goodBrief());
    const provider = new PreparedReasoningProvider(config(), fetcher);
    const call = provider.prepareCall(brief());
    expect(state.calls).toBe(0);
    expect(Number.isSafeInteger(call.request_bytes)).toBe(true);
    expect(call.request_bytes).toBeGreaterThan(0);
    expect(call.identity.request_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(call.identity.config_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(call.identity.reserved_micro_usd).toBe(
      call.request_bytes + REASONING_REQUEST_FRAMING_BYTES + 4000,
    );
    expect(Object.isFrozen(call.identity)).toBe(true);
    const envelope = await call.execute(new AbortController().signal);
    expect(state.calls).toBe(1);
    expect(envelope.accounting).toEqual({
      state: "known",
      cost_micro_usd: expectedBound(10, 5),
      usage: { input_tokens: 10, output_tokens: 5 },
      model: "gpt-test-1",
    });
    expect(envelope.output).toMatchObject({ ok: true, kind: "brief" });
  });

  it("constructs without credentials, then fails closed in prepareCall before any I/O", () => {
    const { fetcher, state } = reply(goodBrief());
    expect(() => new PreparedReasoningProvider({}, fetcher)).not.toThrow();
    expect(() =>
      new PreparedReasoningProvider({}, fetcher).prepareCall(brief()),
    ).toThrow(BrainError);
    expect(() =>
      new PreparedReasoningProvider(config({ price: undefined }), fetcher).prepareCall(brief()),
    ).toThrow(BrainError);
    expect(() =>
      new PreparedReasoningProvider(config({ key: undefined }), fetcher).prepareCall(brief()),
    ).toThrow(BrainError);
    expect(() =>
      new PreparedReasoningProvider(config({ model: "" }), fetcher).prepareCall(brief()),
    ).toThrow(BrainError);
    expect(state.calls).toBe(0);
  });

  it("freezes exact bytes so mutating the caller's input after prepare changes nothing", async () => {
    const { fetcher, state } = reply(goodBrief());
    const provider = new PreparedReasoningProvider(config(), fetcher);
    const input = brief();
    const call = provider.prepareCall(input);
    const beforeHash = call.identity.request_hash;
    const beforeBytes = call.request_bytes;
    input.sources[0]!.body = "MUTATED after prepareCall";
    input.sources[0]!.title = "MUTATED";
    await call.execute(new AbortController().signal);
    expect(call.identity.request_hash).toBe(beforeHash);
    expect(call.request_bytes).toBe(beforeBytes);
    expect(JSON.stringify(state.body.input)).toContain("SYNTHETIC note body");
    expect(JSON.stringify(state.body.input)).not.toContain("MUTATED");
  });

  it("derives a different config hash for different prices or accepted models", () => {
    const a = new PreparedReasoningProvider(config(), reply(goodBrief()).fetcher).prepareCall(brief());
    const b = new PreparedReasoningProvider(
      config({
        price: {
          version: "synthetic-price-2026-10-16",
          input_micro_usd_per_million: 2_000_000,
          output_micro_usd_per_million: 2_000_000,
        },
      }),
      reply(goodBrief()).fetcher,
    ).prepareCall(brief());
    const c = new PreparedReasoningProvider(
      config({ accepted_response_models: ["gpt-test-1", "gpt-test-2"] }),
      reply(goodBrief()).fetcher,
    ).prepareCall(brief());
    expect(a.identity.config_hash).not.toBe(b.identity.config_hash);
    expect(a.identity.config_hash).not.toBe(c.identity.config_hash);
    expect(a.identity.request_hash).toBe(b.identity.request_hash);
  });

  it("keeps a known cost even when the output schema or evidence is invalid", async () => {
    const invalid = {
      model: "gpt-test-1",
      output: [
        { content: [{ type: "output_text", text: JSON.stringify({ nonsense: true }) }] },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const provider = new PreparedReasoningProvider(config(), reply(invalid).fetcher);
    const envelope = await provider.prepareCall(brief()).execute(new AbortController().signal);
    expect(envelope.accounting).toEqual({
      state: "known",
      cost_micro_usd: expectedBound(10, 5),
      usage: { input_tokens: 10, output_tokens: 5 },
      model: "gpt-test-1",
    });
    expect(envelope.output.ok).toBe(false);
  });

  it("validates usage before output, refusal or evidence and retains it", async () => {
    const cases = [
      { model: "gpt-test-1", output: [], usage: { input_tokens: 4, output_tokens: 9 }, refusal: "policy" },
      {
        model: "gpt-test-1",
        output: [
          {
            content: [
              {
                type: "output_text",
                text: JSON.stringify({
                  items: [
                    { text: "x", epistemic_status: "supported", evidence: [{ source_id: "invented", source_version: 1, start: 0, end: 1, quote: "q" }] },
                  ],
                  unknowns: [],
                }),
              },
            ],
          },
        ],
        usage: { input_tokens: 4, output_tokens: 9 },
      },
      { model: "gpt-test-1", output: [{ content: [{ type: "output_text", text: "{not json" }] }], usage: { input_tokens: 4, output_tokens: 9 } },
    ];
    for (const payload of cases) {
      const provider = new PreparedReasoningProvider(config(), reply(payload).fetcher);
      const envelope = await provider.prepareCall(brief()).execute(new AbortController().signal);
      expect(envelope.accounting).toEqual({
        state: "known",
        cost_micro_usd: expectedBound(4, 9),
        usage: { input_tokens: 4, output_tokens: 9 },
        model: "gpt-test-1",
      });
      expect(envelope.output.ok).toBe(false);
    }
  });

  it("preserves observed usage but keeps money unknown for an unaccepted returned model", async () => {
    const provider = new PreparedReasoningProvider(config(), reply(goodBrief("gpt-test-1-variant")).fetcher);
    const envelope = await provider.prepareCall(brief()).execute(new AbortController().signal);
    expect(envelope.accounting).toEqual({
      state: "unknown",
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    expect(envelope.output.ok).toBe(false);
  });

  it("keeps accounting unknown for missing usage and never retries", async () => {
    const provider = new PreparedReasoningProvider(config(), reply({ model: "gpt-test-1" }).fetcher);
    const envelope = await provider.prepareCall(brief()).execute(new AbortController().signal);
    expect(envelope.accounting).toEqual({ state: "unknown" });
    expect(envelope.output.ok).toBe(false);
  });

  it("prices the whole serialized UTF-8 request", async () => {
    const { fetcher, state } = reply(goodBrief());
    const provider = new PreparedReasoningProvider(config(), fetcher);
    const call = provider.prepareCall(brief());
    await call.execute(new AbortController().signal);
    expect(call.request_bytes).toBe(Buffer.byteLength(JSON.stringify(state.body), "utf8"));
    expect(call.identity.reserved_micro_usd).toBe(
      call.request_bytes + REASONING_REQUEST_FRAMING_BYTES + 4000,
    );
  });

  it("rejects an overflowing reservation bound instead of wrapping", () => {
    const provider = new PreparedReasoningProvider(
      config({
        max_output_tokens: 8000,
        price: {
          version: "p",
          input_micro_usd_per_million: Number.MAX_SAFE_INTEGER,
          output_micro_usd_per_million: Number.MAX_SAFE_INTEGER,
        },
      }),
      reply(goodBrief()).fetcher,
    );
    const huge: PrepareRequest = {
      kind: "brief",
      sources: [sourceFixture({ body: "a".repeat(1_040_000) })],
    };
    expect(() => provider.prepareCall(huge)).toThrow(BrainError);
  });

  it("supports the goal contract with its own schema name and prompt version", async () => {
    const goalReply = {
      model: "gpt-test-1",
      output: [{ content: [{ type: "output_text", text: JSON.stringify({ outcome: "abstain", artifact: "", evidence: [] }) }] }],
      usage: { input_tokens: 2, output_tokens: 2 },
    };
    const { fetcher, state } = reply(goalReply);
    const provider = new PreparedReasoningProvider(config(), fetcher);
    const envelope = await provider
      .prepareCall({ kind: "goal", goal: { title: "Beta", success_criteria: "Test", plan: "" }, sources: [sourceFixture()] })
      .execute(new AbortController().signal);
    expect(state.body.text.format.name).toBe("goal_preparation");
    expect(JSON.stringify(state.body.input)).toContain("src-1");
    expect(envelope.output).toMatchObject({ ok: true, kind: "goal", outcome: "abstain" });
  });

  it("returns a conservative unknown envelope when a deferred response arrives after the deadline", async () => {
    // The fetcher never rejects on abort: it resolves a Response only after the
    // deadline has already fired, so the deadline race, not the fetch signal,
    // is what must bound the call.
    let calls = 0;
    let cancelled = false;
    let resolveFetch!: (response: Response) => void;
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        /* never yields data; never completes on its own */
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetcher = ((_url: string | URL | Request, _init?: RequestInit) => {
      calls += 1;
      return new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });
    }) as unknown as typeof fetch;
    const provider = new PreparedReasoningProvider(config({ timeout_ms: 20 }), fetcher);
    const pending = provider.prepareCall(brief()).execute(new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 40));
    resolveFetch(new Response(stream, { status: 200, headers: { "content-type": "application/json" } }));
    const envelope = await pending;
    expect(envelope.accounting).toEqual({ state: "unknown" });
    expect(envelope.output.ok).toBe(false);
    expect(calls).toBe(1);
    // The late body is cancelled by the aborted work branch, with no logging.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(cancelled).toBe(true);
  });

  it("returns a conservative unknown envelope and cancels a body that ignores abort", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        /* never yields data; never completes on its own */
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetcher = (async () =>
      new Response(stream, { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const provider = new PreparedReasoningProvider(config({ timeout_ms: 20 }), fetcher);
    const envelope = await provider.prepareCall(brief()).execute(new AbortController().signal);
    expect(envelope.accounting).toEqual({ state: "unknown" });
    expect(envelope.output.ok).toBe(false);
    expect(cancelled).toBe(true);
  });

  it("cancels an oversized stream and keeps accounting unknown", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(64));
        controller.enqueue(new Uint8Array(4096));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetcher = (async () => new Response(stream, { status: 200 })) as unknown as typeof fetch;
    const provider = new PreparedReasoningProvider(config({ max_response_bytes: 64 }), fetcher);
    const envelope = await provider.prepareCall(brief()).execute(new AbortController().signal);
    expect(envelope.accounting).toEqual({ state: "unknown" });
    expect(cancelled).toBe(true);
  });

  it("returns unknown and never touches the network for a pre-aborted signal", async () => {
    const { fetcher, state } = reply(goodBrief());
    const provider = new PreparedReasoningProvider(config(), fetcher);
    const controller = new AbortController();
    controller.abort();
    const envelope = await provider.prepareCall(brief()).execute(controller.signal);
    expect(envelope.accounting).toEqual({ state: "unknown" });
    expect(envelope.output.ok).toBe(false);
    expect(state.calls).toBe(0);
  });

  it("executes at most once and rejects a second execution before the network", async () => {
    const { fetcher, state } = reply(goodBrief());
    const provider = new PreparedReasoningProvider(config(), fetcher);
    const call = provider.prepareCall(brief());
    await call.execute(new AbortController().signal);
    expect(state.calls).toBe(1);
    await expect(call.execute(new AbortController().signal)).rejects.toThrow();
    expect(state.calls).toBe(1);
  });

  it("keeps failure messages content-free", async () => {
    const secret = "sk-live-SYNTHETICNOTREAL000000000000";
    const fetcher = (async () => new Response(secret, { status: 500 })) as unknown as typeof fetch;
    const provider = new PreparedReasoningProvider(config(), fetcher);
    const envelope = await provider.prepareCall(brief()).execute(new AbortController().signal);
    expect(envelope.accounting).toEqual({ state: "unknown" });
    expect(JSON.stringify(envelope)).not.toContain(secret);
  });
});
