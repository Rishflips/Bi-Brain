import { createHash } from "node:crypto";
import { extract } from "../../packages/domain/logic.ts";
import type {
  PrepareRequest,
  PreparedCall,
  PreparedEnvelope,
  PreparedProvider,
} from "../../packages/providers/prepared.ts";

/**
 * TEST-ONLY prepared provider. Never imported by production code. It lets
 * existing paid-path tests keep their intent (side effects during the call,
 * custom outputs, known/unknown accounting) while speaking the new one-shot
 * contract, with no runtime legacy fallback.
 */
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
        const known = {
          accounting: {
            state: "known" as const,
            cost_micro_usd: 10,
            usage: { input_tokens: 1, output_tokens: 1 },
            model: identity.model,
          },
        };
        if (request.kind === "brief")
          return { ...known, output: { ok: true, kind: "brief", ...extract(request.sources) } };
        return {
          ...known,
          output: { ok: true, kind: "goal", outcome: "abstain", artifact: "", evidence: [] },
        };
      },
    });
  };
  return provider;
}
