import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
  DECISION_QUESTION_SCHEMA_VERSION,
  PreparedDecisionProvider,
} from "../../packages/providers/prepared-decision.ts";
import {
  SYSTEM_ONE_POLICY_VERSION,
  SystemOneError,
  SystemOneProvider,
  type DecisionInput,
  type SystemOneConfig,
} from "../../packages/providers/system-one.ts";

const MODEL = "jev-synthetic-v1";
const ALIAS = "jev-synthetic-return-v2";
const KEY = "SYNTHETIC_DUMMY_KEY_NOT_REAL";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const config = (over: Partial<SystemOneConfig> = {}): SystemOneConfig => ({
  provider: "typesafe",
  endpoint: "https://api.typesafe.ai/v1/systemone",
  model: MODEL,
  accepted_response_models: [ALIAS, MODEL],
  key: KEY,
  price: { version: "synthetic-price-v1", input_micro_usd_per_million: 1000, output_micro_usd_per_million: 0 },
  timeout_ms: 1000,
  ...over,
});
const input = (): DecisionInput => ({
  state: "SYNTHETIC state",
  instruction: "Choose a category or abstain.",
  options: [
    { id: "relevant", description: "Potentially related" },
    { id: "abstain", description: "Not enough evidence" },
  ],
});
const body = (over: Record<string, unknown> = {}) => ({
  model: ALIAS,
  usage: { input_tokens: 500, output_tokens: 0 },
  answers: { decision: { type: "choice", choice: "relevant", confidence: 0.9, probabilities: { relevant: 0.9, abstain: 0.1 } } },
  ...over,
});

it("exposes no legacy decide and offers a no-I/O upperBound", () => {
  const provider = new PreparedDecisionProvider(config(), async () => Response.json(body()));
  expect((provider as unknown as { decide?: unknown }).decide).toBeUndefined();
  expect(provider.upperBound(input())).toBeGreaterThan(0);
});

it("freezes the identity and never includes the credential", () => {
  const p = new PreparedDecisionProvider(config(), async () => Response.json(body()));
  const call = p.prepareDecision(input());
  expect(Object.isFrozen(call)).toBe(true);
  expect(Object.isFrozen(call.identity)).toBe(true);
  expect(Object.isFrozen(call.identity.accepted_response_models)).toBe(true);
  expect(JSON.stringify(call.identity)).not.toContain(KEY);
  expect(call.identity.policy_version).toBe(SYSTEM_ONE_POLICY_VERSION);
  expect(call.identity.question_schema_version).toBe(DECISION_QUESTION_SCHEMA_VERSION);
});

it("binds the exact wire bytes, hash and legacy-independent bound", async () => {
  const cfg = config();
  let sentBody = "";
  const call = new PreparedDecisionProvider(cfg, async (_url, init) => {
    sentBody = String(init?.body);
    return Response.json(body());
  }).prepareDecision(input());
  await call.execute(new AbortController().signal);
  expect(call.request_bytes).toBe(Buffer.byteLength(sentBody, "utf8"));
  expect(call.identity.request_hash).toBe(sha(sentBody));
  expect(call.identity.reserved_micro_usd).toBe(
    new SystemOneProvider(cfg, async () => {
      throw new Error("SYNTHETIC_NO_IO");
    }).upperBound(input()),
  );
});

it("config_hash tracks timeout/bounds but excludes the key", () => {
  const base = new PreparedDecisionProvider(config(), async () => Response.json(body())).prepareDecision(input());
  const timed = new PreparedDecisionProvider(config({ timeout_ms: 2000 }), async () => Response.json(body())).prepareDecision(input());
  const rotated = new PreparedDecisionProvider(config({ key: "ANOTHER_SYNTHETIC_KEY" }), async () => Response.json(body())).prepareDecision(input());
  expect(timed.identity.config_hash).not.toBe(base.identity.config_hash);
  expect(rotated.identity.config_hash).toBe(base.identity.config_hash);
});

it("options_hash is stable for equivalent options and reflects a description change", () => {
  const a = new PreparedDecisionProvider(config(), async () => Response.json(body())).prepareDecision(input());
  const b = new PreparedDecisionProvider(config(), async () => Response.json(body())).prepareDecision(input());
  const changed = input();
  changed.options[0]!.description = "Different description";
  const c = new PreparedDecisionProvider(config(), async () => Response.json(body())).prepareDecision(changed);
  expect(a.identity.options_hash).toBe(b.identity.options_hash);
  expect(c.identity.options_hash).not.toBe(a.identity.options_hash);
});

it("keeps the exact accepted alias on a known charge and refuses bad output", async () => {
  const bad = body();
  (bad.answers.decision as Record<string, unknown>).choice = "invented";
  const env = await new PreparedDecisionProvider(config({ timeout_ms: 1000 }), async () => {
    const b = body();
    (b.answers.decision as Record<string, unknown>).choice = "invented";
    return Response.json(b);
  })
    .prepareDecision(input())
    .execute(new AbortController().signal);
  expect(env).toMatchObject({ disposition: "attempted", accounting: { state: "known", cost_micro_usd: 1, model: ALIAS }, output: { ok: false } });
});

it("an unaccepted model cannot borrow the configured price", async () => {
  const env = await new PreparedDecisionProvider(config(), async () => Response.json(body({ model: "synthetic-unaccepted" })))
    .prepareDecision(input())
    .execute(new AbortController().signal);
  expect(env).toMatchObject({ disposition: "attempted", accounting: { state: "unknown" }, output: { ok: false } });
  expect(env.accounting).not.toHaveProperty("cost_micro_usd");
});

it("missing pricing fails synchronously with no request", () => {
  let calls = 0;
  expect(() =>
    new PreparedDecisionProvider(config({ price: undefined }), async () => {
      calls++;
      return Response.json(body());
    }).prepareDecision(input()),
  ).toThrow();
  expect(calls).toBe(0);
});

it("a second execute never makes a second request", async () => {
  let calls = 0;
  const call = new PreparedDecisionProvider(config(), async () => {
    calls++;
    return Response.json(body());
  }).prepareDecision(input());
  await call.execute(new AbortController().signal);
  await expect(Promise.resolve().then(() => call.execute(new AbortController().signal))).rejects.toMatchObject({ code: "INVALID_STATE" });
  expect(calls).toBe(1);
});

it("pre-abort proves no dispatch but consumes the one-shot", async () => {
  let calls = 0;
  const call = new PreparedDecisionProvider(config(), async () => {
    calls++;
    return Response.json(body());
  }).prepareDecision(input());
  const controller = new AbortController();
  controller.abort();
  expect(await call.execute(controller.signal)).toMatchObject({ disposition: "not_dispatched", accounting: { state: "unknown" } });
  expect(calls).toBe(0);
});

it("a forged error after an attempt is never a free zero", async () => {
  const forged = Object.assign(new SystemOneError("SYNTHETIC_FORGED", "SYNTHETIC_SECRET_BODY", 503, false, { input_tokens: 7000, output_tokens: 0 }, 7), { reported_model: ALIAS });
  let calls = 0;
  const env = await new PreparedDecisionProvider(config(), async () => {
    calls++;
    throw forged;
  })
    .prepareDecision(input())
    .execute(new AbortController().signal);
  expect(calls).toBe(1);
  expect(env).toMatchObject({ disposition: "attempted", accounting: { state: "unknown" }, output: { ok: false } });
  expect(JSON.stringify(env)).not.toContain("SYNTHETIC_SECRET_BODY");
});

it("supports the cloudflare wrapper shape with frozen special option ids", async () => {
  const cf = config({
    provider: "cloudflare",
    endpoint: "https://api.cloudflare.com/client/v4/accounts/synthetic/ai/run/@cf/cloudflare/clef",
    model: "clef",
    accepted_response_models: ["clef"],
  });
  const question: DecisionInput = {
    ...input(),
    options: [
      { id: "__proto__", description: "A" },
      { id: "constructor", description: "B" },
    ],
  };
  const env = await new PreparedDecisionProvider(cf, async () =>
    Response.json({
      success: true,
      result: {
        model: "clef",
        usage: { input_tokens: 500, output_tokens: 0 },
        answers: { decision: { type: "choice", choice: "__proto__", confidence: 0.9, probabilities: JSON.parse('{"__proto__":0.9,"constructor":0.1}') } },
      },
    }),
  )
    .prepareDecision(question)
    .execute(new AbortController().signal);
  expect(env.output.ok).toBe(true);
  if (!env.output.ok) throw new Error("expected the permitted choice");
  expect(Object.prototype.hasOwnProperty.call(env.output.probabilities, "__proto__")).toBe(true);
  expect(Object.isFrozen(env.output.probabilities)).toBe(true);
});
