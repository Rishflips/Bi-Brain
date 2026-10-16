# Worker Dispatch Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Ollama DeepSeek V4.1 Flash executes; the parent agent independently reviews/tests/verifies; GPT-6 Astra supplied the architecture. The parent reads this plan and then explicitly hands execution.

**Goal:** Switch the local worker's paid reasoning path from the legacy single `reservations` hold to the already-reviewed `DispatchLedger` per-dispatch primitives behind one new one-shot prepared-call contract, so a known charge is always retained, an unknown charge always holds conservatively, and no paid call is ever sent twice.

**Execution checkpoint:** All four tasks are locally verified: parent 303/303 tests, 16/16 browser journeys, 4/4 offline evaluations, typecheck/lint/build and clean audit. No live-provider or managed-paid activation is claimed. Historical code sketches below must be read with the parent amendments and final implementation, not copied over reviewed fixes. The recovery scope additionally covers `scripts/vault.ts` rollback and new operational-database reconstruction from an existing vault (`packages/storage/index.ts`). See `BUILD_STATE.md` for actual failures and repairs, including fractional-cent browser input precision and one scoped real-Git test deadline.

**Architecture:** A new provider-neutral module builds a synchronous, no-I/O `PreparedCall` (frozen request bytes + identity + reservation bound) whose `execute(signal)` performs exactly one `fetch`, parses usage independently of output validation, and always resolves an envelope of `accounting: known|unknown` plus `output: ok|failed`. A single worker helper runs the durable sequence guard → `reserve("reasoning")` → `markDispatched` (committed before I/O) → `execute` outside the transaction → `settle` when cost is known, releasing a hold only when the call was provably never sent. Shared status reads the authoritative ledger; restore disables paid processing behind a durable block that ordinary preferences cannot clear. System One routing, multi-stage processing, a global/service ledger and billing stay out of this batch.

**Tech Stack:** Existing strict TypeScript, Node 24.19 LTS, SQLite (`node:sqlite`), Fastify, React, Zod, Vitest, Playwright. No new service, dependency or graph database.

**Spec:** `docs/superpowers/specs/2026-10-16-managed-suite-design.md` (Core guarantees; "System 1 is a permanent capability"; release gates 2, 6). Prerequisite primitives plan: `docs/superpowers/plans/2026-10-16-dispatch-accounting.md`. Foundation plan: `docs/superpowers/plans/2026-10-16-managed-foundation.md`.

## Global Constraints

- Integer micro-USD only. All sums go through the existing `safeAdd`/`checkedSum` overflow guards. Deterministic clocks in tests.
- Short SQLite transactions; every model call stays **outside** a transaction. `reserve`/`markDispatched` commit before any network I/O.
- Known cost is never discarded. Unknown or ambiguous actual cost is never shown or recorded as zero; it remains a hold.
- A price version applies to an explicit snapshot of accepted **concrete** returned model identifiers. Never price an unrelated or alias-inferred model; never guess a prefix.
- Unknown or missing pricing/model fails closed **before** dispatch. The presence of an API key is not consent and never triggers a call by itself; `provider_enabled` is the explicit consent switch.
- No secrets in client bundles, URLs, logs, screenshots, exports, fixtures or commits. Request material is secret-scanned before it is sent.
- Preserve legacy `reservations` rows and values exactly. New dispatches never write shadow legacy rows. No automatic migration of owner data.
- Managed hosting stays blocked: the managed worker never adapts the new contract to a real paid provider, and a managed browser cannot enable paid processing through local caps.
- No real provider call, network paid request, deployment, commit or push by an implementer. Browser journeys keep using the real API/worker/build and disposable synthetic data, and tracked reference screenshots stay unchanged.
- Each task has exclusive file ownership. Run tasks sequentially in the order given; stop and report if a prerequisite interface differs rather than rewriting a neighbor.

## Release boundaries (explicitly out of scope for this batch)

- No System One decision routing, decision-policy evaluation or decision→reasoning chains.
- No multi-stage paid job (at most one paid `reasoning` dispatch per job attempt in this batch).
- No global/service-wide budget ledger, tenant control-plane settlement or reconciliation CLI.
- No billing, subscription, entitlement, webhook or payment work.
- No change to the extractive (no-key) path, capture, gate, review, undo, vault, or the existing browser journeys.

## File structure

| File | New/Modify/Delete | Responsibility |
|---|---|---|
| `packages/providers/prepared.ts` | New (Task 1) | Prepared-call contract + the single real OpenAI-Responses adapter. No storage/authorization. |
| `packages/providers/openai.ts` | Delete (Task 2) | Legacy `ReasoningProvider`. Removed so nothing can fall back to it at runtime. |
| `apps/worker/dispatch.ts` | New (Task 2) | One paid-call helper: guard → reserve → dispatch → execute → settle (release only if never sent). |
| `apps/worker/engine.ts` | Modify (Task 2) | Extractive path unchanged; paid branch uses prepared calls + ledger; receipts carry call id/usage status. |
| `apps/worker/managed.ts` | Modify (Task 2) | `providerFactory` type → `PreparedProvider`; default provider. |
| `apps/worker/main.ts` | Modify (Task 2) | Managed denial provider implements `PreparedProvider`. |
| `packages/domain/service.ts` | Modify (Task 3) | Authoritative `status().spend` from the ledger; `prefs` refuses to clear a block. |
| `apps/web/src.tsx` | Modify (Task 3) | Show settled + unresolved (unknown ≠ zero); disable re-enable while blocked. |
| `packages/storage/restore-policy.ts` | Modify (Task 4) | `applyRestoreSafetyBarrier` for a just-restored database. |
| `scripts/restore.ts` | Modify (Task 4) | Invoke the barrier immediately after opening the restored DB, before tombstone replay. |
| `tests/helpers/prepared-provider.ts` | New (Task 2) | Test-ONLY fake prepared provider. Never imported by production code. |
| `tests/integration/prepared-provider.test.ts` | New (Task 1) | Contract, bound, accounting and model-bound regressions. |
| `tests/integration/worker-dispatch.test.ts` | New (Task 2) | Ledger integration, retry/no-resend, hold survival, receipts. |
| `tests/integration/status-spend.test.ts` | New (Task 3) | New+legacy summary, aliases, blocked re-enable refusal. |
| `tests/integration/restore-barrier.test.ts` | New (Task 4) | Barrier ordering and preserved accounting. |
| `tests/integration/brain.test.ts` | Modify (Task 2) | Adapt paid-path fakes/assertions to the new contract. |
| `tests/integration/safety.test.ts` | Modify (Task 2) | Unknown-pricing fixture uses the new contract. |
| `tests/integration/managed-worker.test.ts` | Modify (Task 2) | Fakes use the test-only helper. |
| `BUILD_STATE.md` | Modify (final step only) | Record verified RED/GREEN and remaining limits. |

---

## Task 1: Prepared reasoning-call contract

> **Status: verified (2026-10-16).** Implemented `packages/providers/prepared.ts` + `tests/integration/prepared-provider.test.ts` (17) with the parent's `prepared-provider-review.test.ts` (6); constructor no-throw, `prepareCall` validation, frozen byte/evidence snapshots, model-bound accounting, unknown-cost hold; typecheck/lint clean.

Deliverable: a new, independently green provider module. The worker is **not** changed in this task, so the existing suite stays green.

**Files:**
- Create: `packages/providers/prepared.ts`
- Test: `tests/integration/prepared-provider.test.ts`

**Interfaces:**
- Consumes: `outputSchema`, `evidenceSchema`, `Source` from `packages/contracts/index.ts`; `detectSecrets` from `packages/storage/secrets.ts`; `BrainError` from `packages/domain/logic.ts`.
- Produces (used by Task 2 and the test helper):
  - `PreparedProvider { prepareCall(input: PrepareRequest): PreparedCall }`
  - `PreparedCall { identity: PreparedIdentity; request_bytes: number; execute(signal: AbortSignal): Promise<PreparedEnvelope> }`
  - `PreparedReasoningProvider implements PreparedProvider` (constructor `(config?: ReasoningConfig, fetcher?: typeof fetch)`)
  - constants `REASONING_REQUEST_FRAMING_BYTES`, `REASONING_MAX_REQUEST_BYTES`, `REASONING_MAX_OUTPUT_TOKENS`, `REASONING_PROMPT_VERSION_BRIEF`, `REASONING_PROMPT_VERSION_GOAL`

- [x] **Step 1: Write the failing test**

Create `tests/integration/prepared-provider.test.ts`. It uses an injected fetcher only; it never contacts a network.

```ts
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  PreparedReasoningProvider,
  REASONING_REQUEST_FRAMING_BYTES,
  type PrepareRequest,
  type ReasoningConfig,
} from "../../packages/providers/prepared.ts";
import { BrainError } from "../../packages/domain/logic.ts";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

const sources = [
  {
    id: "src-1",
    project_id: "inbox",
    version: 1,
    title: "Note",
    body: "SYNTHETIC note body about the beta.",
    visibility: "project" as const,
    state: "active",
    captured_at: "2026-10-16T09:00:00Z",
    origin: "owner",
  },
];

const brief = (): PrepareRequest => ({ kind: "brief", sources });

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

function reply(payload: unknown) {
  const state = { calls: 0, body: undefined as any };
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
                    end: 8,
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

describe("PreparedReasoningProvider", () => {
  it("builds a frozen, no-I/O call whose reservation is the checked byte+output bound", async () => {
    const { fetcher, state } = reply(goodBrief());
    const provider = new PreparedReasoningProvider(config(), fetcher);
    const call = provider.prepareCall(brief());
    // prepareCall performed no network I/O and froze its identity.
    expect(state.calls).toBe(0);
    expect(Number.isSafeInteger(call.request_bytes)).toBe(true);
    expect(call.request_bytes).toBeGreaterThan(0);
    expect(call.identity.request_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(call.identity.config_hash).toMatch(/^[0-9a-f]{64}$/);
    // Exact integer-ceil bound: input priced over bytes+framing, output over the cap.
    expect(call.identity.reserved_micro_usd).toBe(
      call.request_bytes + REASONING_REQUEST_FRAMING_BYTES + 4000,
    );
    expect(Object.isFrozen(call.identity)).toBe(true);
    const envelope = await call.execute(new AbortController().signal);
    expect(state.calls).toBe(1);
    expect(envelope.accounting).toEqual({
      state: "known",
      cost_micro_usd: Math.ceil((10 * 1_000_000 + 5 * 2_000_000) / 1_000_000),
      usage: { input_tokens: 10, output_tokens: 5 },
      model: "gpt-test-1",
    });
    expect(envelope.output.ok).toBe(true);
  });

  it("constructs without credentials, then fails closed in prepareCall before any I/O", () => {
    const { fetcher, state } = reply(goodBrief());
    // The default worker must construct with absent key/model/price and still run
    // extractive; validation happens at prepareCall, never in the constructor.
    const unconfigured = () => new PreparedReasoningProvider({}, fetcher);
    expect(unconfigured).not.toThrow();
    expect(() => new PreparedReasoningProvider({}, fetcher).prepareCall(brief())).toThrow(BrainError);
    const missingPrice = new PreparedReasoningProvider(config({ price: undefined }), fetcher);
    expect(() => missingPrice.prepareCall(brief())).toThrow(BrainError);
    const missingKey = new PreparedReasoningProvider(config({ key: undefined }), fetcher);
    expect(() => missingKey.prepareCall(brief())).toThrow(BrainError);
    const missingModel = new PreparedReasoningProvider(config({ model: "" as unknown as string }), fetcher);
    expect(() => missingModel.prepareCall(brief())).toThrow(BrainError);
    expect(state.calls).toBe(0);
  });

  it("freezes the exact bytes so mutating the caller's input after prepare cannot change the call", async () => {
    const { fetcher, state } = reply(goodBrief());
    const provider = new PreparedReasoningProvider(config(), fetcher);
    const input = brief();
    const call = provider.prepareCall(input);
    const beforeHash = call.identity.request_hash;
    const beforeBytes = call.request_bytes;
    input.sources[0].body = "MUTATED after prepareCall";
    (input.sources[0] as any).title = "MUTATED";
    await call.execute(new AbortController().signal);
    expect(call.identity.request_hash).toBe(beforeHash);
    expect(call.request_bytes).toBe(beforeBytes);
    expect(JSON.stringify(state.body.input)).toContain("SYNTHETIC note body");
    expect(JSON.stringify(state.body.input)).not.toContain("MUTATED");
  });

  it("derives a different config hash for different prices or accepted models", () => {
    const a = new PreparedReasoningProvider(config(), reply(goodBrief()).fetcher).prepareCall(brief());
    const b = new PreparedReasoningProvider(
      config({ price: { version: "synthetic-price-2026-10-16", input_micro_usd_per_million: 2_000_000, output_micro_usd_per_million: 2_000_000 } }),
      reply(goodBrief()).fetcher,
    ).prepareCall(brief());
    const c = new PreparedReasoningProvider(
      config({ accepted_response_models: ["gpt-test-1", "gpt-test-2"] }),
      reply(goodBrief()).fetcher,
    ).prepareCall(brief());
    expect(a.identity.config_hash).not.toBe(b.identity.config_hash);
    expect(a.identity.config_hash).not.toBe(c.identity.config_hash);
    // request_hash is over the request body only; the same brief has the same bytes.
    expect(a.identity.request_hash).toBe(b.identity.request_hash);
  });

  it("keeps a known cost even when the output schema or evidence is invalid", async () => {
    const invalid = {
      model: "gpt-test-1",
      output: [
        {
          content: [
            { type: "output_text", text: JSON.stringify({ nonsense: true }) },
          ],
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const { fetcher } = reply(invalid);
    const provider = new PreparedReasoningProvider(config(), fetcher);
    const envelope = await provider
      .prepareCall(brief())
      .execute(new AbortController().signal);
    expect(envelope.accounting.state).toBe("known");
    expect(envelope.output.ok).toBe(false);
  });

  it("preserves known usage but keeps money unknown for an unaccepted returned model", async () => {
    const { fetcher } = reply(goodBrief("gpt-test-1-variant"));
    const provider = new PreparedReasoningProvider(config(), fetcher);
    const envelope = await provider
      .prepareCall(brief())
      .execute(new AbortController().signal);
    expect(envelope.accounting).toEqual({
      state: "unknown",
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    expect(envelope.output.ok).toBe(false);
  });

  it("keeps accounting unknown for missing usage and never retries", async () => {
    const { fetcher, state } = reply({ model: "gpt-test-1" });
    const provider = new PreparedReasoningProvider(config(), fetcher);
    const envelope = await provider
      .prepareCall(brief())
      .execute(new AbortController().signal);
    expect(envelope.accounting.state).toBe("unknown");
    expect(envelope.output.ok).toBe(false);
    expect(state.calls).toBe(1);
  });

  it("keeps accounting unknown on a transport failure or redirect with one fetch", async () => {
    let calls = 0;
    const fetcher = (async () => {
      calls += 1;
      return new Response("nope", { status: 503 });
    }) as unknown as typeof fetch;
    const provider = new PreparedReasoningProvider(config(), fetcher);
    const envelope = await provider
      .prepareCall(brief())
      .execute(new AbortController().signal);
    expect(envelope.accounting.state).toBe("unknown");
    expect(envelope.output.ok).toBe(false);
    expect(calls).toBe(1);
  });

  it("sends the fixed JSON request contract for each kind", async () => {
    const { fetcher, state } = reply(goodBrief());
    const provider = new PreparedReasoningProvider(config(), fetcher);
    await provider.prepareCall(brief()).execute(new AbortController().signal);
    expect(state.body.store).toBe(false);
    expect(state.body.model).toBe("gpt-test-1");
    expect(state.body.text.format.name).toBe("brief");
    expect(JSON.stringify(state.body.input)).toContain("src-1");
  });

  it("validates usage before output, refusal or evidence, and retains it", async () => {
    const cases = [
      { model: "gpt-test-1", output: [], usage: { input_tokens: 4, output_tokens: 9 }, refusal: true },
      { model: "gpt-test-1", output: [{ content: [{ type: "output_text", text: JSON.stringify({ items: [{ text: "x", epistemic_status: "supported", evidence: [] }], unknowns: [] }) }] }], usage: { input_tokens: 4, output_tokens: 9 } },
      { model: "gpt-test-1", output: [{ content: [{ type: "output_text", text: JSON.stringify({ nonsense: true }) }] }], usage: { input_tokens: 4, output_tokens: 9 } },
    ];
    for (const payload of cases) {
      const provider = new PreparedReasoningProvider(config(), reply(payload).fetcher);
      const envelope = await provider.prepareCall(brief()).execute(new AbortController().signal);
      expect(envelope.accounting).toEqual({
        state: "known",
        cost_micro_usd: Math.ceil((4 * 1_000_000 + 9 * 2_000_000) / 1_000_000),
        usage: { input_tokens: 4, output_tokens: 9 },
        model: "gpt-test-1",
      });
      expect(envelope.output.ok).toBe(false);
    }
  });

  it("prices the whole serialized request and reserves the byte+framing+output bound", async () => {
    const { fetcher, state } = reply(goodBrief());
    const provider = new PreparedReasoningProvider(config(), fetcher);
    const call = provider.prepareCall(brief());
    await call.execute(new AbortController().signal);
    const expectedBytes = Buffer.byteLength(String((state as any).body ? JSON.stringify(state.body) : ""), "utf8");
    expect(expectedBytes).toBeLessThanOrEqual(call.request_bytes); // same-or-fewer bytes than the serialized request
    expect(call.identity.reserved_micro_usd).toBe(
      call.request_bytes + REASONING_REQUEST_FRAMING_BYTES + 4000,
    );
  });

  it("rejects an overflowing reservation bound instead of wrapping", () => {
    const provider = new PreparedReasoningProvider(
      config({ max_output_tokens: 8000, price: { version: "p", input_micro_usd_per_million: Number.MAX_SAFE_INTEGER, output_micro_usd_per_million: Number.MAX_SAFE_INTEGER } }),
      reply(goodBrief()).fetcher,
    );
    expect(() => provider.prepareCall(brief())).toThrow(BrainError);
  });

  it("supports the goal contract with a distinct prompt version and schema name", async () => {
    const goal = { title: "Beta", success_criteria: "Test", plan: "" };
    const goalReply = {
      model: "gpt-test-1",
      output: [{ content: [{ type: "output_text", text: JSON.stringify({ outcome: "abstain", artifact: "", evidence: [] }) }] }],
      usage: { input_tokens: 2, output_tokens: 2 },
    };
    const { fetcher, state } = reply(goalReply);
    const provider = new PreparedReasoningProvider(config(), fetcher);
    const envelope = await provider
      .prepareCall({ kind: "goal", goal, sources })
      .execute(new AbortController().signal);
    expect(state.body.text.format.name).toBe("goal_preparation");
    expect(JSON.stringify(state.body.input)).toContain("src-1");
    expect(envelope.output).toMatchObject({ ok: true, kind: "goal", outcome: "abstain" });
  });

  it("returns a conservative unknown envelope when the fetcher ignores abort on headers", async () => {
    let calls = 0;
    const fetcher = ((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        calls += 1;
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      })) as unknown as typeof fetch;
    const provider = new PreparedReasoningProvider(config({ timeout_ms: 20 }), fetcher);
    const envelope = await provider.prepareCall(brief()).execute(new AbortController().signal);
    expect(envelope).toEqual({ accounting: { state: "unknown" }, output: expect.objectContaining({ ok: false }) });
    expect(calls).toBe(1);
  });

  it("returns a conservative unknown envelope for a body that ignores abort, and cancels it", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        /* never yields data, never completes on abort */
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetcher = (async () =>
      new Response(stream, { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const provider = new PreparedReasoningProvider(config({ timeout_ms: 20 }), fetcher);
    const envelope = await provider.prepareCall(brief()).execute(new AbortController().signal);
    expect(envelope.accounting.state).toBe("unknown");
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
    expect(envelope.accounting.state).toBe("unknown");
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
    expect(JSON.stringify(envelope)).not.toContain(secret);
    expect(envelope.accounting.state).toBe("unknown");
  });
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/integration/prepared-provider.test.ts`
Expected: FAIL — `packages/providers/prepared.ts` does not exist / exports missing.

- [x] **Step 3: Write the contract and the real adapter**

Create `packages/providers/prepared.ts`. Keep it a focused provider module: no storage, no authorization, no ledger.

```ts
import { createHash } from "node:crypto";
import { outputSchema, evidenceSchema, type Source } from "../contracts/index.ts";
import { BrainError } from "../domain/logic.ts";
import { detectSecrets } from "../storage/secrets.ts";

export const REASONING_PROMPT_VERSION_BRIEF = "brief-v2";
export const REASONING_PROMPT_VERSION_GOAL = "goal-v2";
/** Conservative allowance for provider-side framing absent from the body. */
export const REASONING_REQUEST_FRAMING_BYTES = 4096;
export const REASONING_MAX_REQUEST_BYTES = 1_048_576;
export const REASONING_MAX_OUTPUT_TOKENS = 8000;
const DEFAULT_MAX_OUTPUT_TOKENS = 2000;
const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RESPONSE_BYTES = 262_144;
const MAX_RESPONSE_BYTES = 33_554_432;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export type ReasoningPrice = {
  version: string;
  input_micro_usd_per_million: number;
  output_micro_usd_per_million: number;
};

export type ReasoningConfig = {
  model: string;
  accepted_response_models?: string[];
  key?: string;
  price?: ReasoningPrice;
  max_output_tokens?: number;
  endpoint?: string;
  timeout_ms?: number;
  max_response_bytes?: number;
};

export type PrepareRequest =
  | { kind: "brief"; sources: Source[] }
  | {
      kind: "goal";
      goal: { title: string; success_criteria: string; plan: string };
      sources: Source[];
    };

export type PreparedIdentity = {
  provider: string;
  model: string;
  price_version: string;
  prompt_version: string;
  request_hash: string;
  config_hash: string;
  reserved_micro_usd: number;
};

export type PreparedUsage = { input_tokens: number; output_tokens: number };

export type PreparedAccounting =
  | { state: "known"; cost_micro_usd: number; usage: PreparedUsage; model: string }
  | { state: "unknown"; usage?: PreparedUsage };

export type PreparedItem = ReturnType<typeof outputSchema.parse>["items"][number];
export type PreparedEvidence = PreparedItem["evidence"];

export type PreparedOutput =
  | { ok: true; kind: "brief"; items: PreparedItem[]; unknowns: string[] }
  | {
      ok: true;
      kind: "goal";
      outcome: "proposal" | "abstain";
      artifact: string;
      evidence: PreparedEvidence;
    }
  | { ok: false; code: string; reason: string };

export type PreparedEnvelope = {
  accounting: PreparedAccounting;
  output: PreparedOutput;
};

export interface PreparedCall {
  readonly identity: PreparedIdentity;
  readonly request_bytes: number;
  execute(signal: AbortSignal): Promise<PreparedEnvelope>;
}

export interface PreparedProvider {
  prepareCall(input: PrepareRequest): PreparedCall;
}
```

Implement `PreparedReasoningProvider`:

- **Constructor never validates and never throws.** It stores the raw caller config merged over legacy-compatible defaults read from the environment (`OPENAI_API_KEY`, `BRAIN_MODEL`, `BRAIN_INPUT_MICRO_USD_PER_MILLION`, `BRAIN_OUTPUT_MICRO_USD_PER_MILLION`, `BRAIN_PRICE_VERSION`, `BRAIN_MAX_OUTPUT_TOKENS`). A worker with no key/model/price must still construct and run the extractive path.
- `prepareCall(input)` performs all validation synchronously, before any I/O, and throws `BrainError("PROVIDER_UNAVAILABLE", …, 503)` when: model is blank/too long/control chars; `key` is absent; `price` is absent; `price.version` blank or > 64 chars; `input_micro_usd_per_million` is not a positive safe integer; `output_micro_usd_per_million` is not a nonnegative safe integer; `max_output_tokens` is not a safe integer in `[1, REASONING_MAX_OUTPUT_TOKENS]`; timeout is not a positive safe integer ≤ `MAX_TIMEOUT_MS`; response bound is invalid. `accepted_response_models` defaults to `[model]`; each entry must be a distinct nonblank string without control chars. Endpoint rules: parse `endpoint` (default the official OpenAI Responses URL); reject userinfo, query, fragment; require HTTPS, except an explicit loopback `http://127.0.0.1`/`localhost` fixture endpoint. Remote plaintext and arbitrary hosts fail closed. `redirect:"error"` always.
- `prepareCall(input)` then:
  - **Deep-copies** the caller input and the evidence-validation context into frozen snapshots: sources are copied to `{ id, version, body }` arrays, goal copied to a plain frozen object. `execute` must never read `this.config` or any caller object again; it closes only over the frozen snapshot.
  - Builds the request object per kind:
    - brief: `{ model, max_output_tokens, store:false, instructions, input: JSON.stringify(snapshot.sources), text:{format:{type:"json_schema",name:"brief",strict:true,schema}} }` — keep the existing instructions/schema text from `packages/providers/openai.ts` `prepare` verbatim.
    - goal: same shape with `name:"goal_preparation"`, `input: JSON.stringify({goal: snapshot.goal, sources: snapshot.sources})`, and the existing `prepareGoal` goal schema verbatim.
  - `json = JSON.stringify(request)`; `bytes = Buffer.byteLength(json, "utf8")`; throw `BrainError("INVALID_INPUT", …, 400)` if `bytes > REASONING_MAX_REQUEST_BYTES`. The bound prices this whole serialized UTF-8 request.
  - Secret-scan the same concatenated string used by `SystemOneProvider.prepare` (title + all serialized source/goal text) and throw `INVALID_INPUT` without I/O when `detectSecrets` finds a hit.
  - `request_hash = sha256hex(json)`.
  - `config_hash = sha256hex(JSON.stringify({ provider:"openai", endpoint, model, price_version, input_micro_usd_per_million, output_micro_usd_per_million, accepted_response_models, prompt_version, max_output_tokens, bound_policy_version, framing: REASONING_REQUEST_FRAMING_BYTES }))`. It includes endpoint, numeric prices, price version, accepted returned models, model, prompt version, output cap and the bound policy/framing; it **excludes** the credential.
  - `reserved_micro_usd = boundMicroUsd(bytes, max_output_tokens, price)`.
  - Freezes `identity` and the returned call object; `execute` closes over the frozen snapshot only.
- `boundMicroUsd(bytes, maxOutput, price)` uses **BigInt** checked arithmetic so no float round drift is possible:
  ```ts
  const million = 1_000_000n;
  const inputMicro = BigInt(bytes + REASONING_REQUEST_FRAMING_BYTES) * BigInt(price.input_micro_usd_per_million);
  const outputMicro = BigInt(maxOutput) * BigInt(price.output_micro_usd_per_million);
  const total = inputMicro + outputMicro;
  const bound = (total + million - 1n) / million; // integer ceil
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  if (bound < 0n || bound > max)
    throw new BrainError("PROVIDER_UNAVAILABLE", "The cost bound exceeds the safe integer range.", 503);
  return Number(bound);
  ```
  Document explicitly that this is a bound for the OpenAI Responses JSON contract under the assumption that one input token is no more than one UTF-8 byte plus the framing allowance, and one output token is no more than the configured cap. It is **not** a claim of conservative pricing for arbitrary providers.
- `execute(signal)`:
  - Uses an explicit per-call `used` flag: the second invocation throws a content-free `BrainError("INVALID_STATE", "This prepared call was already executed.", 409)` **before** any network work (programmer misuse may throw; real HTTP failures must not).
  - If `signal.aborted` before the request: resolve `{ accounting:{state:"unknown"}, output:{ok:false, code:"PROVIDER_ABORTED", reason:"The provider request was cancelled before it was sent."} }` (never a zero cost).
  - Performs exactly one `this.fetcher(endpoint, { method:"POST", headers:{ Authorization:\`Bearer ${key}\`, "Content-Type":"application/json" }, body: json, signal, redirect:"error" })`. Copy the deadline race, `redirect:"error"` handling, hard-cap `readBounded` stream reader, and non-2xx/redirect body cancel from `packages/providers/system-one.ts` (`run`, `perform`, `readBounded`) so an injected fetcher or body that ignores its abort signal still cannot outlive the finite deadline. Any transport/abort/size failure resolves `{ accounting:{state:"unknown"}, output:{ok:false, code, reason} }`.
  - Parses `usage` and `model` from the JSON **before** touching `output`, retaining whatever is already known:
    - If `usage.input_tokens`/`output_tokens` are not nonnegative safe integers → `unknown`, output failed `PROVIDER_INVALID`.
    - If `model` is missing/blank/too long/control chars, or not in the accepted snapshot → `accounting:{ state:"unknown", usage: knownUsage }`, output failed `PROVIDER_INVALID` ("an unaccepted returned model; the charge is unknown and remains held").
    - Otherwise `cost =` integer ceil of `(usage.input_tokens * input_price + usage.output_tokens * output_price) / 1e6` using BigInt, checked to a safe integer → `accounting:{ state:"known", cost_micro_usd, usage, model }`.
    - Then validate output (`outputSchema.parse` / goal schema) and evidence; convert any thrown validation error into `output:{ ok:false, code:"INVALID_INPUT", reason }` **without** touching the accounting.
    - If the envelope's output is ok but `cost > reserved bound`, keep `accounting:{ state:"known", cost_micro_usd: cost, usage }` and return `output:{ ok:false, code:"PROVIDER_INVALID", reason:"The provider reported a cost above the reserved bound; the charge remains held." }` (Task 2 settles and blocks, then rejects publication even if the mock output is ok).

Use the same content-free error messages as `SystemOneProvider` so no provider text or secret can leak.

- [x] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/integration/prepared-provider.test.ts`
Expected: PASS.

- [x] **Step 5: Run the existing suite unchanged**

Run: `npm test -- tests/integration/system-one.test.ts tests/integration/spend.test.ts tests/integration/spend-contention.test.ts`
Expected: PASS. Task 1 adds a module and changes no existing file, so the worker and all existing tests stay green.

- [x] **Step 6: Report checkpoint**

Run: `npm run typecheck && npm run lint`
Expected: PASS. Report the RED/GREEN commands and exact outputs. Do not commit.

---

## Task 2: Worker switch to one-shot prepared dispatch

> **Status: verified (2026-10-16).** Implemented `apps/worker/dispatch.ts` + engine/managed/main switch + `tests/helpers/prepared-provider.ts`; deleted `packages/providers/openai.ts` after the atomic switch. Own `worker-dispatch.test.ts` (15) with the parent's `worker-dispatch-review.test.ts` (7), plus adapted `brain`/`safety`/`managed-worker` (52 total) green; full suite green; unknown/over-bound/legacy/cancellation regressions fixed; typecheck/lint clean.

Deliverable: the worker performs each paid call exactly once through the ledger, retains known cost, holds unknown cost, never resends, and records an accountable failure receipt. The legacy `ReasoningProvider` contract is removed so no runtime fallback exists.

**Files:**
- Create: `apps/worker/dispatch.ts`, `tests/helpers/prepared-provider.ts`, `tests/integration/worker-dispatch.test.ts`
- Modify: `apps/worker/engine.ts`, `apps/worker/managed.ts`, `apps/worker/main.ts`, `tests/integration/brain.test.ts`, `tests/integration/safety.test.ts`, `tests/integration/managed-worker.test.ts`
- Delete: `packages/providers/openai.ts`

**Interfaces:**
- Consumes from Task 1: `PreparedProvider`, `PrepareRequest`, `PreparedCall`, `PreparedEnvelope`, `PreparedAccounting`, `PreparedOutput`, `PreparedIdentity`, `PreparedUsage`, `PreparedEvidence`, `PreparedReasoningProvider`.
- Consumes from the primitives plan: `DispatchLedger`, `DispatchSpec`, `JobLease`, `SpendLimits`.
- Produces:
  - `apps/worker/dispatch.ts`: `dispatchPrepared(deps, input, job, leaseOwner, guard, signal): Promise<PreparedAttempt>` where `PreparedAttempt = { call_id; identity; output; accounting }`, `DispatchDeps = { brain; ledger; provider; owner }`. It re-runs `guard` before reserve and again before `markDispatched`, reads the persisted lease deadline, and throws after settling when the actual charge exceeded the reservation (so the caller rejects publication even if the output was ok).
  - `tests/helpers/prepared-provider.ts`: `fakePreparedProvider(spec): PreparedProvider & { calls: number }`.

- [x] **Step 1: Write the test-only fake provider helper**

Create `tests/helpers/prepared-provider.ts` (imported only by tests):

```ts
import { createHash } from "node:crypto";
import { extract } from "../../packages/domain/logic.ts";
import type {
  PrepareRequest,
  PreparedCall,
  PreparedEnvelope,
  PreparedProvider,
} from "../../packages/providers/prepared.ts";

export type FakePreparedSpec = {
  provider?: string;
  model?: string;
  price_version?: string;
  reserved_micro_usd?: number;
  /** Runs inside execute() before the envelope resolves (race/side effects). */
  onExecute?: (signal: AbortSignal) => void | Promise<void>;
  result?: (
    request: PrepareRequest,
  ) => PreparedEnvelope | Promise<PreparedEnvelope>;
};

export function fakePreparedProvider(
  spec: FakePreparedSpec = {},
): PreparedProvider & { calls: number } {
  const provider = { calls: 0 } as PreparedProvider & { calls: number };
  provider.prepareCall = (request: PrepareRequest): PreparedCall => {
    const json = JSON.stringify(request);
    const identity = Object.freeze({
      provider: spec.provider ?? "fake",
      model: spec.model ?? "test-model",
      price_version: spec.price_version ?? "test-price-1",
      prompt_version: "test-v1",
      request_hash: createHash("sha256").update(json).digest("hex"),
      config_hash: createHash("sha256").update("fake-config").digest("hex"),
      reserved_micro_usd: spec.reserved_micro_usd ?? 100,
    });
    return Object.freeze({
      identity,
      request_bytes: Buffer.byteLength(json, "utf8"),
      async execute(signal: AbortSignal): Promise<PreparedEnvelope> {
        provider.calls += 1;
        if (spec.onExecute) await spec.onExecute(signal);
        if (spec.result) return spec.result(request);
        const sources = request.kind === "brief" ? request.sources : request.sources;
        if (request.kind === "brief")
          return {
            accounting: {
              state: "known",
              cost_micro_usd: 10,
              usage: { input_tokens: 1, output_tokens: 1 },
              model: identity.model,
            },
            output: { ok: true, kind: "brief", ...extract(sources) },
          };
        return {
          accounting: {
            state: "known",
            cost_micro_usd: 10,
            usage: { input_tokens: 1, output_tokens: 1 },
            model: identity.model,
          },
          output: { ok: true, kind: "goal", outcome: "abstain", artifact: "", evidence: [] },
        };
      },
    });
  };
  return provider;
}
```

- [x] **Step 2: Write the failing worker-dispatch test**

Create `tests/integration/worker-dispatch.test.ts`. Use a real `Storage`/`Brain` on a temporary file, a real `DispatchLedger`, fixed clock, and the fake provider.

```ts
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../../packages/storage/index.ts";
import { Brain } from "../../packages/domain/service.ts";
import { Worker } from "../../apps/worker/engine.ts";
import { DispatchLedger } from "../../packages/storage/spend.ts";
import { fakePreparedProvider } from "../helpers/prepared-provider.ts";

const owner = { kind: "owner" } as const;
let current = "2026-10-16T09:00:00Z";
const clock = () => new Date(current);
const dirs: string[] = [];
afterEach(() => {
  current = "2026-10-16T09:00:00Z";
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "bibrain-dispatch-"));
  dirs.push(dir);
  const store = new Storage(join(dir, "brain.sqlite"));
  const b = new Brain(store, clock);
  b.prefs(owner, {
    ...b.prefs(owner),
    provider_enabled: true,
    daily_cap_micro_usd: 100000,
    per_job_cap_micro_usd: 10000,
  });
  const note = b.capture(owner, {
    title: "note",
    body: "SYNTHETIC dispatch integration note with two useful passages.",
  });
  return { dir, store, b, note };
}

const dispatches = (s: Storage) =>
  s.all("SELECT * FROM provider_dispatches ORDER BY created_at");
```

Tests to add (each with concrete expected values):

1. **Happy path settles and publishes.** Provider default. `await new Worker(b, provider).tick()` is `true`; `b.entities(owner, "brief")` has one item containing `"SYNTHETIC dispatch integration"`; `dispatches(store)[0].state === "settled"` and `actual_micro_usd === 10`; the succeeded receipt has `call_id === dispatches[0].call_id`, `usage_status === "settled"`, `cost_micro_usd === 10`; `provider.calls === 1`.

2. **Known cost survives output-evidence failure.** Provider returns a brief with an invented `source_id` (known accounting, `cost_micro_usd: 7`). After tick: no brief is published; the job is `failed`; `dispatches(store)[0].state === "settled"` with `actual_micro_usd === 7`; the failed receipt has that `call_id`, `usage_status === "settled"`, `cost_micro_usd === 7`.

3. **Unknown usage holds and survives restart.** Provider returns `{ accounting:{state:"unknown", usage:{input_tokens:3,output_tokens:2}}, output:{ok:false, code:"PROVIDER_UNAVAILABLE", reason:"unavailable"} }`. After tick: job `failed`; `dispatches(store)[0].state === "dispatched"` (hold); failed receipt `usage_status === "unknown"` and `cost_micro_usd === null`. Close and reopen the store; `new DispatchLedger(reopened, clock).summary(limits).unresolved_micro_usd` equals the reserved amount; `provider.calls === 1`.

4. **No resend after a hold, even across an explicit retry.** After test 3's state, call `b.jobAction(owner, jobId, "retry")` then `await new Worker(b, provider).tick()`; `provider.calls` stays `1`; no second `provider_dispatches` row; job ends non-succeeded with the "already exists; it will not be sent again" reason.

5. **Changed request content is rejected, not retried, and keeps the existing call.** Seed a held dispatch, then capture a second note so the request hash changes, retry, tick: a `DISPATCH_CONFLICT` failure receipt whose `call_id` equals the existing row's call id and whose `usage_status === "unknown"` (never `no_attempt`); `provider.calls` unchanged; still one row.

6. **Legacy reservation blocks a new paid dispatch.** Insert `INSERT INTO reservations VALUES(?,?,?,?,?)` (`job_id, day, reserved=5, actual=0, status='held'`) for the leased job's id; tick: no `provider_dispatches` row, `provider.calls === 0`, job fails with the legacy-record reason, and the legacy row is unchanged.

7. **Over-bound settlement settles, blocks, then rejects publication even with ok output.** Provider reports known cost above its reservation (`reserved_micro_usd: 1`, `cost_micro_usd: 999999`) and a valid brief. After tick: no brief published; job `failed`; `dispatches[0].settled` with `actual_micro_usd === 999999`; `store.setting("paid_processing_blocked", null)` is non-null; the failed receipt has `usage_status === "settled"` and `cost_micro_usd === 999999`; a second note's tick performs no further provider calls and its job fails with `BUDGET_BLOCKED`.

8. **Release happens only when the call was never sent.** Call `dispatchPrepared` directly with a `guard` that throws on its second invocation (use a counter). Expect the reject, `provider.calls === 0`, and `dispatches` row `state === "released"` with no `actual_micro_usd`.

- [x] **Step 3: Run the test to verify it fails**

Run: `npm test -- tests/integration/worker-dispatch.test.ts`
Expected: FAIL — `apps/worker/dispatch.ts` missing and the worker still uses the legacy contract.

- [x] **Step 4: Write the dispatch helper**

Create `apps/worker/dispatch.ts`:

```ts
import type { Brain } from "../../packages/domain/service.ts";
import type { Principal } from "../../packages/contracts/index.ts";
import { BrainError } from "../../packages/domain/logic.ts";
import type { DispatchLedger } from "../../packages/storage/spend.ts";
import type {
  DispatchSpec,
  JobLease,
  SpendLimits,
} from "../../packages/domain/spend.ts";
import type {
  PrepareRequest,
  PreparedAccounting,
  PreparedIdentity,
  PreparedOutput,
  PreparedProvider,
} from "../../packages/providers/prepared.ts";

export type DispatchDeps = {
  brain: Brain;
  ledger: DispatchLedger;
  provider: PreparedProvider;
  owner: Principal;
};

export type PreparedAttempt = {
  call_id: string;
  identity: PreparedIdentity;
  output: PreparedOutput;
  accounting: PreparedAccounting;
};

/** Reads the persisted lease deadline, never the stale in-memory job row. */
function currentLease(deps: DispatchDeps, job: { id: string; fence: number }, owner: string): JobLease {
  const row = deps.brain.store.get<{ status: string; lease_owner: string; lease_until: string | null; fence: number }>(
    "SELECT status,lease_owner,lease_until,fence FROM jobs WHERE id=?",
    job.id,
  );
  if (
    !row ||
    row.status !== "running" ||
    row.lease_owner !== owner ||
    row.fence !== job.fence ||
    !row.lease_until
  )
    throw new BrainError("JOB_CANCELLED", "This attempt is no longer current.", 409);
  return { job_id: job.id, owner, fence: job.fence, expires_at: row.lease_until };
}

export async function dispatchPrepared(
  deps: DispatchDeps,
  input: PrepareRequest,
  job: { id: string; fence: number },
  leaseOwner: string,
  guard: () => void,
  signal: AbortSignal,
): Promise<PreparedAttempt> {
  const { brain, ledger, provider, owner } = deps;
  const prefs = brain.prefs(owner);
  const limits: SpendLimits = {
    per_job_micro_usd: prefs.per_job_cap_micro_usd,
    daily_micro_usd: prefs.daily_cap_micro_usd,
    time_zone: prefs.time_zone,
  };
  const call = provider.prepareCall(input); // sync, no I/O; may throw -> no attempt
  const spec: DispatchSpec = {
    job_id: job.id,
    dispatch_key: "reasoning",
    stage: "reasoning",
    reserved_micro_usd: call.identity.reserved_micro_usd,
    provider: call.identity.provider,
    model: call.identity.model,
    price_version: call.identity.price_version,
    request_hash: call.identity.request_hash,
    config_hash: call.identity.config_hash,
  };
  const lease = currentLease(deps, job, leaseOwner);
  guard();
  const record = ledger.reserve(spec, lease, limits);
  if (record.state !== "reserved")
    throw new BrainError(
      "JOB_CANCELLED",
      "A paid call for this preparation already exists; it will not be sent again.",
      409,
    );
  try {
    guard();
    ledger.markDispatched(record.call_id, lease);
  } catch (error) {
    // The request was never sent, so releasing the hold cannot lose real spend.
    try {
      ledger.releaseUndispatched(record.call_id);
    } catch {
      /* A concurrent state change owns the record. */
    }
    throw error;
  }
  const envelope = await call.execute(signal);
  if (envelope.accounting.state === "known") {
    const settled = ledger.settle(record.call_id, envelope.accounting.cost_micro_usd);
    // Settle and block first; then refuse publication even if the output was ok.
    if (
      settled.actual_micro_usd !== null &&
      settled.actual_micro_usd > settled.reserved_micro_usd
    )
      throw new BrainError(
        "BUDGET_EXHAUSTED",
        "Provider usage exceeded its estimate; paid processing is blocked until reconciled.",
        409,
      );
  }
  return {
    call_id: record.call_id,
    identity: call.identity,
    output: envelope.output,
    accounting: envelope.accounting,
  };
}
```

- [x] **Step 5: Run the dispatch test to verify it passes**

Run: `npm test -- tests/integration/worker-dispatch.test.ts`
Expected: PASS.

- [x] **Step 6: Switch the engine to the helper and the ledger**

Modify `apps/worker/engine.ts`:

1. Replace the `openai.ts` import with:
   ```ts
   import {
     PreparedReasoningProvider,
     type PreparedEvidence,
     type PreparedProvider,
     type PreparedUsage,
   } from "../../packages/providers/prepared.ts";
   import { DispatchLedger } from "../../packages/storage/spend.ts";
   import { dispatchPrepared, type PreparedAttempt } from "./dispatch.ts";
   ```
2. Constructor: `readonly provider: PreparedProvider = new PreparedReasoningProvider()`. Add `private readonly ledger = new DispatchLedger(this.brain.store, this.brain.clock);`
3. Delete the entire `reserve(j, upper)` method.
4. In `tick()`, immediately after `const j = this.lease();` add `let attempt: PreparedAttempt | undefined;` (import `type PreparedAttempt` from `./dispatch.ts`).
5. Replace the paid branch (the current `if (prefs.provider_enabled && …)` block through the `exceeded` check at the old lines ~269–365) with:
   ```ts
   const guard = () => {
     // Runs before reserve and again before markDispatched, re-reading
     // authoritative state each time: access, consent, owner-activity
     // cancellation, source signature and goal version. The worker lease is
     // re-checked authoritatively inside the ledger transaction.
     b.access(principal, j.project_id, principal.kind === "agent" ? "propose_memory" : "read");
     if (!b.prefs(this.owner).provider_enabled)
       throw new BrainError("JOB_CANCELLED", "Paid processing was turned off before dispatch.", 409);
     if (j.kind === "review_changed_assumption" && !j.payload.manual && this.ownerActive())
       throw new BrainError("JOB_CANCELLED", "Owner is active; background preparation was cancelled.", 409);
     if (signature !== b.evidenceSignature(b.sources(this.owner, j.project_id).slice(0, 20)))
       throw new BrainError("SOURCE_STALE", "Sources changed before dispatch.", 409);
     if (j.kind === "review_changed_assumption") {
       const current = b.entity(this.owner, j.payload.goal_id);
       if (current.project_id !== j.project_id || current.kind !== "goal" || current.data.status !== "active" || !current.data.preparation_enabled)
         throw new BrainError("SOURCE_STALE", "Selected goal changed before dispatch.", 409);
     }
   };
   if (prefs.provider_enabled && sources.some((s) => s.visibility === "project") && (j.kind === "derive_brief" || (j.kind === "review_changed_assumption"))) {
     const selected = sources.filter((s) => s.visibility === "project");
     if (j.kind === "derive_brief") {
       const paid = await dispatchPrepared({ brain: b, ledger: this.ledger, provider: this.provider, owner: this.owner }, { kind: "brief", sources: selected }, j, this.id, guard, controller.signal);
       attempt = paid;
       if (!paid.output.ok) throw new BrainError(paid.output.code, paid.output.reason, 503);
       if (paid.output.kind !== "brief") throw new BrainError("PROVIDER_UNAVAILABLE", "The provider returned an unusable brief.", 503);
       output = outputSchema.parse({ items: paid.output.items, unknowns: paid.output.unknowns });
       output.items = [...output.items, ...extract(sources.filter((s) => s.visibility === "private")).items].slice(0, 30);
     } else {
       const goal = b.entity(this.owner, j.payload.goal_id);
       if (goal.project_id !== j.project_id || goal.kind !== "goal" || goal.data.status !== "active")
         throw new BrainError("SOURCE_STALE", "Selected goal changed.", 409);
       if (detectSecrets(`${goal.data.title}\n${goal.data.success_criteria}\n${goal.data.plan ?? ""}`).length)
         throw new BrainError("INVALID_INPUT", "Goal contains suspected secrets; connected preparation was not sent.");
       const goalInput = { title: goal.data.title, success_criteria: goal.data.success_criteria, plan: goal.data.plan_private ? "" : (goal.data.plan ?? "") };
       const paid = await dispatchPrepared({ brain: b, ledger: this.ledger, provider: this.provider, owner: this.owner }, { kind: "goal", goal: goalInput, sources: selected }, j, this.id, guard, controller.signal);
       attempt = paid;
       if (!paid.output.ok || paid.output.kind !== "goal") throw new BrainError(paid.output.ok ? "PROVIDER_UNAVAILABLE" : paid.output.code, paid.output.ok ? "The provider returned an unusable preparation." : paid.output.reason, 503);
       goalPrepared = {
         outcome: paid.output.outcome,
         artifact: paid.output.artifact,
         evidence: paid.output.evidence as PreparedEvidence,
         usage: paid.accounting.state === "known" ? paid.accounting.usage : undefined,
         metadata: { provider: paid.identity.provider, model: paid.identity.model, prompt_version: paid.identity.prompt_version },
         cost_micro_usd: paid.accounting.state === "known" ? paid.accounting.cost_micro_usd : 0,
       };
     }
     metadata = {
       provider: attempt.identity.provider,
       model: attempt.identity.model,
       prompt_version: attempt.identity.prompt_version,
       price_version: attempt.identity.price_version,
       usage: attempt.accounting.state === "known" ? attempt.accounting.usage : undefined,
     };
     cost = attempt.accounting.state === "known" ? attempt.accounting.cost_micro_usd : 0;
   }
   ```
   Declare `goalPrepared` with a local type:
   ```ts
   type GoalPrepared = {
     outcome: "proposal" | "abstain";
     artifact: string;
     evidence: PreparedEvidence;
     usage?: PreparedUsage;
     metadata: { provider: string; model: string; prompt_version: string };
     cost_micro_usd: number;
   };
   ```
   The old `metadata`/`cost` assignments now read from `attempt`. Keep the existing extractive default (`output = extract(sources)`, `metadata.provider = "extractive"`, `cost = 0`) for the no-provider path.
6. Rewrite the failed-receipt block (old lines ~583–590) so it never records a false zero and always resolves the authoritative call from the database, even when `execute` or `settle` threw after reserving:
   ```ts
   const accounted = !!b.store.get("SELECT 1 FROM provider_dispatches WHERE job_id=? AND state<>'released'", j.id);
   const legacy = !!b.store.get("SELECT 1 FROM reservations WHERE job_id=?", j.id);
   const persisted = b.store.get<{ call_id: string; state: string; actual_micro_usd: number | null }>(
     "SELECT call_id,state,actual_micro_usd FROM provider_dispatches WHERE job_id=? ORDER BY created_at DESC LIMIT 1",
     j.id,
   );
   const retry = code === "PROVIDER_UNAVAILABLE" && j.attempts < 3 && !accounted && !legacy;
   // …existing status selection…
   b.createEntity(j.project_id, "receipt", {
     job_id: j.id,
     outcome: "failed",
     reason: safe,
     code,
     // Never "no_attempt" while a persisted dispatch exists: a prior unknown
     // hold or a changed-request retry keeps its real call id and unknown cost.
     call_id: persisted?.call_id ?? null,
     usage_status: persisted
       ? persisted.state === "settled"
         ? "settled"
         : "unknown"
       : "no_attempt",
     cost_micro_usd: persisted?.state === "settled" ? persisted.actual_micro_usd : null,
     evidence: [],
   });
   ```
7. Rewrite the succeeded receipt (old lines ~532–544) so unknown accounting is never mapped to zero or "no provider call":
   ```ts
   const persisted = b.store.get<{ call_id: string; state: string; actual_micro_usd: number | null }>(
     "SELECT call_id,state,actual_micro_usd FROM provider_dispatches WHERE job_id=? ORDER BY created_at DESC LIMIT 1",
     j.id,
   );
   // …inside createEntity("receipt", { … })…
   call_id: persisted?.call_id ?? null,
   usage_status: persisted ? (persisted.state === "settled" ? "settled" : "unknown") : "no_provider_call",
   cost_micro_usd: persisted?.state === "settled" ? persisted.actual_micro_usd : 0,
   ```
   A successful publish only occurs after a known settlement (an unknown accounting yields `output.ok === false` and an over-bound charge throws before publication), so `"unknown"` here records a conservative hold rather than a fabricated zero.

- [x] **Step 7: Switch the managed worker, main denial and delete the legacy provider**

- `apps/worker/managed.ts`: replace the `openai.ts` import with `PreparedReasoningProvider, type PreparedProvider` from `../../packages/providers/prepared.ts`; change `providerFactory?: (brain: Brain) => PreparedProvider`; change the default to `new PreparedReasoningProvider()`.
- `apps/worker/main.ts`: change the import to `type PreparedProvider`; replace `unavailableProvider`'s `upperBound`/`prepare`/`prepareGoal` with a single `prepareCall(): never { throw new BrainError("PROVIDER_UNAVAILABLE", "Connected model processing is not available on managed hosting yet. Your saved work stays available and extractive.", 503); }`.
- Keep `packages/providers/openai.ts` until the worker/managed/main imports have all switched and the affected suites are green; then delete it (`git rm`) as the final step of this task. No inert reference is kept. Confirm no import remains: `grep -rn "providers/openai" .` returns nothing.

- [x] **Step 8: Adapt the existing paid-path tests**

- `tests/integration/managed-worker.test.ts`: import `fakePreparedProvider`; replace each inline `ReasoningProvider` object with `fakePreparedProvider({...})`. The "suspended during a provider call" test uses `onExecute: () => { called = true; runtime.control.setAccountState(a.id, "suspended"); }` and the default known envelope; keep the assertions (`called === true`, no brief, job `failed`).
- `tests/integration/safety.test.ts`: replace `new OpenAIProvider({ key:"not-a-real-key", model:"test", input_price:NaN, output_price:NaN, price_version:undefined }, fetcher)` with `new PreparedReasoningProvider({ model:"test", key:"not-a-real-key" /* price omitted */ }, fetcher)`. Keep `called === false` and the assertion that the job error includes `"pricing"`.
- `tests/integration/brain.test.ts`:
  - "malformed output and invented evidence do not publish or change budgets": use `new PreparedReasoningProvider({ model:"test", accepted_response_models:["test"], key:"test-not-real", price:{ version:"test", input_micro_usd_per_million:1_000_000, output_micro_usd_per_million:1_000_000 } }, fetcher)`; add `model: "test"` to the synthetic response body; keep `b.entities(owner,"brief")` empty and job `failed`; **replace** `expect(b.store.all("SELECT * FROM reservations")[0].status).toBe("held")` with `expect(b.store.all("SELECT state FROM provider_dispatches")).toEqual([{ state: "settled" }])` (known cost retained through the evidence failure) and keep `daily_cap_micro_usd === 1000`.
  - "changed source during a provider call cannot resurrect a deleted note": use `fakePreparedProvider({ onExecute: () => { b.removeSource(owner, n.source_id, 1, true); } })`.
  - "budget admission is atomic…": delete the `w1.reserve`/`w2.reserve` assertions and replace with ledger calls:
    ```ts
    const ledger = new DispatchLedger(b.store, b.clock);
    const leaseOf = (w: Worker, j: any): JobLease => ({
      job_id: j.id, owner: w.id, fence: j.fence,
      expires_at: b.store.get("SELECT lease_until FROM jobs WHERE id=?", j.id)!.lease_until,
    });
    const specFor = (id: string): DispatchSpec => ({
      job_id: id, dispatch_key: "reasoning", stage: "reasoning", reserved_micro_usd: 80,
      provider: "test", model: "test", price_version: "test",
      request_hash: hash("req:" + id), config_hash: hash("cfg:" + id),
    });
    const limits = { per_job_micro_usd: 100, daily_micro_usd: 100, time_zone: b.prefs(owner).time_zone };
    ledger.reserve(specFor(j1.id), leaseOf(w1, j1), limits);
    expect(() => ledger.reserve(specFor(j2.id), leaseOf(w2, j2), limits)).toThrow("cap");
    ```
    (`hash` is the existing `hash` helper; import `DispatchLedger`, `DispatchSpec`, `JobLease` from the storage/domain spend modules.)
  - "model-backed goal proposal…": use `fakePreparedProvider` with a `result` that returns a goal proposal for goal requests (including the `evidence` from the test) and an extractive brief for brief requests; keep the receipt assertion on `provider === "fake"`; the race variant uses `onExecute: () => s.set("owner_activity", b.now())`.
  - "structured goal provider rejects invented evidence…": use `new PreparedReasoningProvider({...})` and call `provider.prepareCall({ kind:"goal", goal:{...}, sources:[source] }).execute(new AbortController().signal)`; assert `envelope.output.ok === false`, `envelope.accounting.state === "known"`, `sent.store === false`, `sent.text.format.name === "goal_preparation"`, `JSON.stringify(sent.input)).toContain(source.id)`.

- [x] **Step 9: Run the affected suites and the whole test run**

Run: `npm test -- tests/integration/worker-dispatch.test.ts tests/integration/brain.test.ts tests/integration/safety.test.ts tests/integration/managed-worker.test.ts`
Expected: PASS.
Run: `npm test`
Expected: PASS (all files). Report the exact counts and any file that had to change for the contract switch.
Run: `npm run typecheck && npm run lint`
Expected: PASS. The parent owns all Playwright runs; run heavy `npm test`/typecheck/lint/build serially, never concurrently with another full run.

- [x] **Step 10: Report checkpoint**

Report the RED/GREEN commands, the deleted legacy provider, and that managed paid processing is still denied. Do not commit.

---

## Task 3: Authoritative spend status and blocked re-enable refusal

> **Status: verified (2026-10-16).** Implemented `Brain.status()` spend summary from the authoritative `DispatchLedger` and the `prefs` block guard (in `packages/domain/service.ts`) + the spending article in `apps/web/src.tsx`. Own `status-spend.test.ts` (5) reported green locally; the parent independently verified its `status-spend-review.test.ts` (2) and the combined `worker-dispatch`/`-review`/`status`/`status-review` set (27/27). Full suite and typecheck/lint/build reported green locally; final browser verification is the parent's.

Deliverable: `Brain.status()` reports settled + unresolved spend from the ledger across new and legacy rows with the existing API aliases preserved; an over-bound or restored block cannot be cleared by ordinary preferences; the UI shows unresolved (unknown) usage and does not offer a re-enable while blocked.

**Files:**
- Modify: `packages/domain/service.ts`, `apps/web/src.tsx`
- Test: `tests/integration/status-spend.test.ts`

**Interfaces:**
- Consumes from the primitives plan: `DispatchLedger.summary(limits)`, `paidProcessingBlockedSetting`.
- Produces: `status(p).spend = { actual, reserved, settled_micro_usd, unresolved_micro_usd, committed_micro_usd, remaining_micro_usd, blocked, budget_day, time_zone }`. `actual`/`reserved` are the preserved aliases (`actual → settled`, `reserved → unresolved`).

- [x] **Step 1: Write the failing test**

Create `tests/integration/status-spend.test.ts` using a real in-memory `Storage` and `Brain`, injecting a legacy `reservations` row and a new `provider_dispatches` row directly (the schema is public). Assertions:

```ts
// legacy settled today + legacy held (older day) + new settled today + new hold today
expect(status.spend.actual).toBe(legacySettled + newSettled);      // alias preserved
expect(status.spend.reserved).toBe(legacyHeld + newHold);           // alias preserved
expect(status.spend.unresolved_micro_usd).toBe(legacyHeld + newHold); // unknown counted, never zero
expect(status.spend.settled_micro_usd).toBe(legacySettled + newSettled);
expect(status.spend.budget_day).toBe("2026-10-16");
```

Add:
- **Blocked re-enable:** run a real `DispatchLedger` over-bound settle (`reserved_micro_usd: 1`, `actual: 50`); `expect(status.spend.blocked).toBe(true)`; `expect(() => b.prefs(owner, { ...b.prefs(owner), provider_enabled: true })).toThrow("blocked")`; and `expect(b.prefs(owner).provider_enabled).toBe(false)`.
- **Legacy-only still counted:** with only a legacy held row, `status.spend.reserved` is that value and `unresolved_micro_usd` matches.

- [x] **Step 2: Observe RED before implementation** — parent ran `status-spend-review.test.ts` and observed two real failures against legacy-only status and unblocked preferences. The executor did not claim a separate RED run of its own status file.

Run: `npm test -- tests/integration/status-spend.test.ts`
Expected: FAIL — `status().spend` has only the legacy `reserved`/`actual` fields and no blocked guard.

- [x] **Step 3: Implement the authoritative summary and the prefs guard**

In `packages/domain/service.ts`:
- Import `DispatchLedger` and `paidProcessingBlockedSetting` from `../storage/spend.ts`.
- `prefs(p, input?)`: `this.owner(p)`; parse with `preferencesSchema`; if the parsed value has `provider_enabled === true` and `this.store.setting(paidProcessingBlockedSetting, null) !== null`, throw `new BrainError("BUDGET_BLOCKED", "Paid processing is blocked until the recorded reason is reconciled.", 409)`. Then store and return. The `blocked` flag and this refusal reflect the recorded block reason (an over-bound settlement or `restored_backup`), not a blanket assumption that every block is an unknown charge.
- `status(p)`: keep the existing `worker_online`, `worker_last_seen`, `provider_configured`, `mode` and `jobs`; replace the raw `spend` SQL with:
  ```ts
  const ledger = new DispatchLedger(this.store, this.clock);
  const summary = ledger.summary({
    per_job_micro_usd: prefs.per_job_cap_micro_usd,
    daily_micro_usd: prefs.daily_cap_micro_usd,
    time_zone: prefs.time_zone,
  });
  const spend = {
    actual: summary.settled_micro_usd,
    reserved: summary.unresolved_micro_usd,
    settled_micro_usd: summary.settled_micro_usd,
    unresolved_micro_usd: summary.unresolved_micro_usd,
    committed_micro_usd: summary.committed_micro_usd,
    remaining_micro_usd: summary.remaining_micro_usd,
    blocked: summary.blocked,
    budget_day: summary.budget_day,
    time_zone: summary.time_zone,
  };
  ```
  Return `{ …, spend, jobs }`.

- [x] **Step 4: Show unknown usage and disable re-enable in the UI**

In `apps/web/src.tsx`, in the "Background help & spending" article:
- Replace the muted spend line with:
  ```tsx
  <p className="muted">
    Provider key {today.status.provider_configured ? "configured" : "not configured"} ·
    settled ${((today.status.spend?.settled_micro_usd ?? 0) / 1_000_000).toFixed(4)} ·
    unresolved (usage unknown) ${((today.status.spend?.unresolved_micro_usd ?? 0) / 1_000_000).toFixed(4)}
  </p>
  ```
- Disable the `provider_enabled` checkbox when blocked and show a plain-language notice:
  ```tsx
  disabled={runtime?.mode === "managed" || today.status.spend?.blocked}
  ```
  ```tsx
  {today.status.spend?.blocked ? (
    <p className="muted" role="status">
      Paid preparation is blocked because an earlier charge is unknown. Your saved work is unchanged;
      an operator must reconcile the account before paid processing can resume.
    </p>
  ) : null}
  ```
  Do not add any control that clears the block.

- [x] **Step 5: Run the test to verify it passes, then the shared suites**

Run: `npm test -- tests/integration/status-spend.test.ts tests/integration/worker-dispatch.test.ts`
Expected: PASS.
Run: `npm test && npm run typecheck && npm run lint && npm run build`
Expected: PASS. The parent owns all Playwright runs; do not run browser suites here (browser total is 15 = 9 local + 6 managed). Run heavy `npm test`/typecheck/lint/build serially, never concurrently with another full run.

- [x] **Step 6: Report checkpoint**

Report the RED/GREEN commands and that no browser journey was modified. Do not commit.

---

## Task 4: Restore safety barrier

> **Status: verified locally (2026-10-16), parent browser/rerun pending.** Implemented `applyRestoreSafetyBarrier` in `packages/storage/restore-policy.ts`, invoked first in `scripts/restore.ts`, plus the approved recovery extension: the `scripts/vault.ts` `rollback` copy is blocked, and `packages/storage/index.ts` blocks a fresh operational database rebuilt from an existing vault (constructor detection only; ledger/table schema untouched). Own `restore-barrier.test.ts` (8) RED-before-GREEN for the extension, then focused restore+operations+vault+brain (49) and full suite (303/303) reported green locally; typecheck/lint/build and `brain-eval` 4/4 reported green. `operations`/`vault` fixtures remain green. BUILD_STATE is intentionally left to the parent.

Deliverable: opening a restored database immediately disables paid processing behind a durable, reason-bearing block, before deletion tombstones are replayed, without deleting any accounting history; ordinary preferences cannot clear the block.

**Files:**
- Modify: `packages/storage/restore-policy.ts`, `scripts/restore.ts`
- Test: `tests/integration/restore-barrier.test.ts`

**Interfaces:**
- Consumes: `paidProcessingBlockedSetting` from `packages/storage/spend.ts`; the Task 3 `prefs` refusal (same setting).
- Produces: `applyRestoreSafetyBarrier(store: Storage, clock?: () => Date): void`.

- [x] **Step 1: Write the failing test**

Create `tests/integration/restore-barrier.test.ts`. It exercises the **actual** `scripts/restore.ts` CLI (like `operations.test.ts`) so the barrier's placement before tombstone replay is what is verified, and it uses valid job foreign-key fixtures.

```ts
import { expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { Storage } from "../../packages/storage/index.ts";
import { Brain } from "../../packages/domain/service.ts";
import { paidProcessingBlockedSetting } from "../../packages/storage/spend.ts";

it("the restore CLI applies the barrier before tombstone replay and preserves accounting", () => {
  const id = randomUUID();
  const dir = resolve("data", `restore-barrier-${id}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "brain.sqlite");
  const s = new Storage(path);
  const b = new Brain(s);
  const owner = { kind: "owner" } as const;
  const source = b.capture(owner, { title: "note", body: "RESTORE_BARRIER_SENTINEL" }) as any;
  // Valid FK fixtures: a real job row for the accounting rows to reference.
  const jobId = randomUUID();
  s.run(
    "INSERT INTO jobs(id,project_id,kind,payload,next_at,created_at) VALUES(?,?,?,?,?,?)",
    jobId, "inbox", "derive_brief", "{}", "2026-10-16T09:00:00Z", "2026-10-16T09:00:00Z",
  );
  s.set("preferences", { enabled: true, time_zone: "UTC", digest_hour: 9, quiet_start: 22, quiet_end: 8, daily_cap_micro_usd: 5000, per_job_cap_micro_usd: 500, provider_enabled: true });
  s.run("INSERT INTO reservations VALUES(?,?,?,?,?)", jobId, "2026-10-16", 5, 0, "held");
  s.run(
    "INSERT INTO provider_dispatches(call_id,job_id,dispatch_key,stage,state,reserved_micro_usd,actual_micro_usd,provider,model,price_version,request_hash,config_hash,identity_hash,budget_day,time_zone,created_at,dispatched_at,settled_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    "call-1", jobId, "reasoning", "reasoning", "settled", 10, 12, "openai", "m", "v",
    "a".repeat(64), "b".repeat(64), "c".repeat(64), "2026-10-16", "UTC",
    "2026-10-16T08:00:00Z", "2026-10-16T08:00:00Z", "2026-10-16T08:00:00Z",
  );
  const name = `restore-barrier-${id}.sqlite`;
  let restoredDir: string | undefined;
  try {
    const env = { ...process.env, BRAIN_DB: path };
    execFileSync(process.execPath, ["--import", "tsx", "scripts/backup.ts", name], { cwd: process.cwd(), env, windowsHide: true });
    // A tombstone created after the backup must be replayed on restore.
    b.removeSource(owner, source.source_id, 1, true);
    const before = new Set(readdirSync(resolve("data")));
    execFileSync(process.execPath, ["--import", "tsx", "scripts/restore.ts", name], { cwd: process.cwd(), env, windowsHide: true });
    restoredDir = readdirSync(resolve("data")).find((n) => n.startsWith("restored-") && !before.has(n));
    expect(restoredDir).toBeTruthy();
    const restored = new Storage(join("data", restoredDir!, "brain.sqlite"));
    try {
      const prefs = restored.setting<any>("preferences", {});
      expect(prefs.provider_enabled).toBe(false);
      expect(prefs.daily_cap_micro_usd).toBe(5000);
      expect(restored.setting(paidProcessingBlockedSetting, null)).toMatchObject({ reason: "restored_backup" });
      expect(restored.get("SELECT count(*) AS n FROM reservations")!.n).toBe(1);
      expect(restored.get("SELECT count(*) AS n FROM provider_dispatches")!.n).toBe(1);
      expect(() => new Brain(restored).prefs(owner, { ...new Brain(restored).prefs(owner), provider_enabled: true })).toThrow("blocked");
      expect(readFileSync(join("data", restoredDir!, "RESTORE_NOTICE.txt"), "utf8")).toContain("paid processing was disabled");
    } finally {
      restored.close();
    }
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
    if (restoredDir) rmSync(join("data", restoredDir), { recursive: true, force: true });
    rmSync(join("data/backups", name), { force: true });
    rmSync(join("data/backups", name + ".json"), { force: true });
  }
});
```

Also extend the existing `operations.test.ts` restore assertion to expect `next.status(owner).spend.blocked === true` on the restored database, proving the barrier ran during the real CLI without changing the notice assertions it already makes.

- [x] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/integration/restore-barrier.test.ts`
Expected: FAIL — `applyRestoreSafetyBarrier` is not exported.

- [x] **Step 3: Implement the barrier and invoke it first**

In `packages/storage/restore-policy.ts` add (keeping the existing `purgeRetainedDeletedSource`):

```ts
import { paidProcessingBlockedSetting } from "./spend.ts";

/**
 * The first thing applied to any just-restored database. It disables connected
 * paid processing and sets a durable block that ordinary preferences cannot
 * clear, without deleting or rewriting any accounting history. Call this
 * immediately after opening the restored store and before replaying deletion
 * tombstones, so a later replay cannot re-enable paid work.
 */
export function applyRestoreSafetyBarrier(
  store: Storage,
  clock: () => Date = () => new Date(),
): void {
  store.transaction(() => {
    const prefs = store.setting<Record<string, unknown> | null>("preferences", null);
    if (prefs) store.set("preferences", { ...prefs, provider_enabled: false });
    store.set(paidProcessingBlockedSetting, {
      reason: "restored_backup",
      at: clock().toISOString(),
    });
  });
}
```

In `scripts/restore.ts`: import `applyRestoreSafetyBarrier`; call `applyRestoreSafetyBarrier(restored);` on the line immediately after `const restored = new Storage(join(dir, "brain.sqlite"));` and before the `if (existsSync(currentPath) …)` tombstone replay. Extend the `RESTORE_NOTICE.txt` text with: `Connected paid processing was disabled and blocked until an operator reconciles accounted spend.`

- [x] **Step 4: Run the test to verify it passes, then the operations suite**

Run: `npm test -- tests/integration/restore-barrier.test.ts tests/integration/operations.test.ts tests/integration/vault.test.ts`
Expected: PASS (the CLI restore test now also observes the block; adjust its assertions only if they assert the exact notice string).

- [x] **Step 5: Run the full verification**

Run: `npm test && npm run typecheck && npm run lint && npm run build && npm run brain-eval`
Expected: PASS (brain-eval 4/4 synthetic offline). Do not run a real provider call.

- [x] **Step 6: Update BUILD_STATE and report** — parent recorded independent final 303-test/16-browser/4-offline verification, actual failure/repair evidence and the remaining managed/live/release gates in `BUILD_STATE.md`.

Update `BUILD_STATE.md` with the verified RED/GREEN commands, the exact test counts, and the still-open gates (System One routing, multi-stage, global/service ledger, billing, live provider, managed paid). Report: files changed, commands actually run, what passed, and the remaining limits. Do not commit or push.

---

## Verification references (smoke, must stay green and unchanged)

- Local browser journeys: `tests/e2e/app.spec.ts` and `tests/e2e/context-conflicts.spec.ts` — 9 journeys, unchanged by this batch.
- Managed browser journeys: `tests/e2e/managed.spec.ts` and `tests/e2e/managed-ui-review.spec.ts` — 6 journeys (browser total 15 = 9 local + 6 managed), unchanged; managed paid stays blocked. The parent owns all Playwright runs.
- Integration baseline: `tests/integration/spend.test.ts`, `tests/integration/spend-contention.test.ts`, `tests/integration/system-one.test.ts`, `tests/integration/managed-worker.test.ts`.
- Reference screenshots in `docs/screenshots/` must not change; if a browser run regenerates them, restore them.
- No live provider, no real key, no paid network request, no deployment, no commit, no push by implementers.

## Self-review

- **Spec coverage:** Core guarantees `integer monetary units / short transactions / durable leases / fenced writes` → all tasks. `Retain valid captures before classification` → extractive path untouched. `Providers receive only consented, bounded, scoped material` → `prepareCall` consent gate in `dispatchPrepared` + secret scan. `Unknown paid usage remains conservatively reserved` → Tasks 1–3. `Check authorization before publishing derived context` → existing fenced publish re-checked in Task 2. `System 1 permanent capability` → explicitly deferred, no routing added. Release gates 2 and 6 → advanced (unknown holds, no duplicate dispatch), not closed (no live provider, no multi-stage).
- **Placeholder scan:** no TBD/TODO; every step names concrete files, code and exact expected values (e.g. `reserved_micro_usd === request_bytes + 4096 + 4000`, `actual_micro_usd === 7`).
- **Type consistency:** `PreparedProvider.prepareCall` → `PreparedCall.execute` → `PreparedEnvelope { accounting, output }` is used identically in Task 1, the helper, `dispatchPrepared`, the engine and the tests. `DispatchSpec.stage` is `"reasoning"`; `dispatch_key` is `"reasoning"`. `PreparedAccounting.state` is `"known" | "unknown"`. `status.spend` field names match the UI and the test.

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-10-16-worker-dispatch-integration.md`. Two options for the parent:

1. **Subagent-driven (recommended):** dispatch a fresh subagent per task with a review gate between tasks. Required sub-skill: `executing-plans` (task-by-task) with parent review.
2. **Inline execution:** execute tasks sequentially in one session with checkpoints for review.

Either way, run tasks in the order 1 → 2 → 3 → 4, sequentially, with exclusive file ownership.

### Choices made
- New provider module `packages/providers/prepared.ts`; legacy `openai.ts` deleted (no runtime fallback); test-only helper for fakes.
- Worker logic extracted to `apps/worker/dispatch.ts` for an independently testable one-call helper instead of growing `engine.ts`.
- One paid `reasoning` dispatch per job attempt; `settle` before the fenced publish; over-bound settlement blocks the next dispatch.
- `paid_processing_blocked` is the single durable block shared by the ledger, `prefs`, the UI and the restore barrier.
- Restore barrier is its own task/file rather than folded into status.

### Resolved by the parent
- `packages/providers/openai.ts` stays until the Task 2 atomic import switch is green, then is deleted; no inert reference.
- Tests use the synthetic returned model `gpt-test-1`; live operator price/model configuration stays blocked and the owner is not asked for credentials now.
- The parent owns all Playwright runs; browser total is 15 (9 local + 6 managed) and no journey is changed.
- Heavy `npm test`/typecheck/lint/build run serially; no concurrent full runs.

### Remaining questions for the parent
- None blocking Task 1. Task 2 will need the parent's decision only if a real provider price/model ever becomes verified; until then it stays blocked.
