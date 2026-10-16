import { createHash } from "node:crypto";
import { canonical } from "../domain/logic.ts";
import {
  DECISION_QUESTION_ID,
  PROBABILITY_SUM_TOLERANCE,
  REQUEST_OVERHEAD_BYTES,
  SYSTEM_ONE_POLICY_VERSION,
  SystemOneError,
  prepareSystemOneRequest,
  resolveSystemOneConfig,
  systemOneCostBound,
  type DecisionInput,
  type DecisionUsage,
  type PreparedSystemOneRequest,
  type ResolvedSystemOneConfig,
  type SystemOneConfig,
} from "./system-one.ts";

/**
 * Immutable one-shot prepared decision call over the existing real
 * `SystemOneProvider` transport.
 *
 * It deliberately does NOT implement the legacy `DecisionProvider` (`decide` is
 * absent) and is not imported by any runtime consumer here. `prepareDecision` is
 * synchronous and no-I/O; `execute` performs exactly one fetch through the injected
 * fetcher under one deadline and returns an accounting/output/disposition envelope
 * instead of throwing for provider outcomes. It never trusts a thrown error, never
 * sends the key anywhere except the in-memory request header, and never reports a
 * known 0 for an uncertain call.
 */

export const DECISION_QUESTION_SCHEMA_VERSION = "decision-question-v1";

const PROBABILITY_EPSILON = 1e-9;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const STATIC_REASONS: Record<string, string> = {
  PROVIDER_ABORTED: "The decision request was cancelled.",
  PROVIDER_TIMEOUT: "The provider did not answer within the configured timeout.",
  PROVIDER_UNAVAILABLE: "The provider request failed. Any charge remains unknown.",
  PROVIDER_INVALID: "The provider returned an unusable decision. Any charge remains unknown.",
  INVALID_OUTPUT: "The provider decision did not match the required schema.",
  COST_EXCEEDED: "The provider reported a cost above the reserved bound.",
};

export interface PreparedDecisionIdentity {
  provider: "typesafe" | "cloudflare";
  model: string;
  accepted_response_models: readonly string[];
  price_version: string;
  input_micro_usd_per_million: number;
  output_micro_usd_per_million: number;
  policy_version: string;
  question_schema_version: string;
  options_hash: string;
  request_hash: string;
  config_hash: string;
  reserved_micro_usd: number;
  max_request_bytes: number;
  max_response_bytes: number;
  request_overhead_bytes: number;
}

export type PreparedDecisionAccounting =
  | {
      state: "known";
      cost_micro_usd: number;
      usage: DecisionUsage;
      model: string;
    }
  | { state: "unknown"; usage?: DecisionUsage };

export type PreparedDecisionOutput =
  | {
      ok: true;
      choice: string;
      confidence: number;
      probabilities: Readonly<Record<string, number>>;
    }
  | { ok: false; code: string; reason: string };

export type PreparedDecisionEnvelope = {
  accounting: PreparedDecisionAccounting;
  output: PreparedDecisionOutput;
  disposition: "not_dispatched" | "attempted";
};

export interface PreparedDecisionCall {
  readonly identity: PreparedDecisionIdentity;
  readonly request_bytes: number;
  execute(signal: AbortSignal): Promise<PreparedDecisionEnvelope>;
}

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value))
      deepFreeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

function envelope(value: PreparedDecisionEnvelope): PreparedDecisionEnvelope {
  return deepFreeze(value);
}

function notDispatched(code: string): PreparedDecisionEnvelope {
  return envelope({
    disposition: "not_dispatched",
    accounting: { state: "unknown" },
    output: { ok: false, code, reason: STATIC_REASONS[code] ?? "Unavailable." },
  });
}

function attemptedUnknown(
  code: string,
  usage?: DecisionUsage,
): PreparedDecisionEnvelope {
  return envelope({
    disposition: "attempted",
    accounting: usage ? { state: "unknown", usage } : { state: "unknown" },
    output: { ok: false, code, reason: STATIC_REASONS[code] ?? "Unavailable." },
  });
}

function knownRefused(
  accounting: Extract<PreparedDecisionAccounting, { state: "known" }>,
  code: string,
): PreparedDecisionEnvelope {
  return envelope({
    disposition: "attempted",
    accounting,
    output: { ok: false, code, reason: STATIC_REASONS[code] ?? "Unavailable." },
  });
}

async function readBounded(
  response: Response,
  limit: number,
  signal: AbortSignal,
): Promise<string> {
  const body = response.body;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  let finished = false;
  const cancelReader = () => {
    reader.cancel().catch(() => undefined);
  };
  const onAbort = () => cancelReader();
  if (signal.aborted) cancelReader();
  else signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      if (signal.aborted) {
        cancelReader();
        break;
      }
      const { value, done } = await reader.read();
      if (done) {
        finished = true;
        break;
      }
      if (value && value.byteLength > 0) {
        total += value.byteLength;
        if (total > limit) {
          cancelReader();
          throw new SystemOneError(
            "PROVIDER_INVALID",
            "The provider response was larger than the configured limit.",
            502,
            true,
          );
        }
        chunks.push(Buffer.from(value));
      }
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (!finished) cancelReader();
  }
  return Buffer.concat(chunks).toString("utf8");
}

export class PreparedDecisionProvider {
  private readonly resolved: ResolvedSystemOneConfig;
  private readonly fetcher: typeof fetch;

  constructor(config: SystemOneConfig, fetcher: typeof fetch = fetch) {
    // Defensive copy BEFORE preparation so later caller mutation of the config can
    // never change the endpoint, model, key, accepted set or price.
    const resolved = resolveSystemOneConfig(config);
    resolved.accepted_response_models = Object.freeze([
      ...resolved.accepted_response_models,
    ]) as string[];
    resolved.price = Object.freeze({ ...resolved.price });
    this.resolved = Object.freeze(resolved);
    this.fetcher = fetcher;
  }

  /** No-I/O convenience bound; no legacy `.decide` is exposed. */
  upperBound(input: DecisionInput): number {
    return systemOneCostBound(
      prepareSystemOneRequest(input, this.resolved),
      this.resolved,
    );
  }

  prepareDecision(input: DecisionInput): PreparedDecisionCall {
    const resolved = this.resolved;
    const prepared: PreparedSystemOneRequest = prepareSystemOneRequest(
      input,
      resolved,
    );
    const bound = systemOneCostBound(prepared, resolved);
    const request_hash = sha256(prepared.json);
    const options_hash = sha256(
      canonical(prepared.input.options.map((option) => [option.id, option.description])),
    );
    const config_hash = sha256(
      canonical({
        provider: resolved.provider,
        endpoint: resolved.endpoint,
        model: resolved.model,
        price_version: resolved.price.version,
        input_micro_usd_per_million: resolved.price.input_micro_usd_per_million,
        output_micro_usd_per_million: resolved.price.output_micro_usd_per_million,
        accepted_response_models: [...resolved.accepted_response_models],
        policy_version: SYSTEM_ONE_POLICY_VERSION,
        question_schema_version: DECISION_QUESTION_SCHEMA_VERSION,
        timeout_ms: resolved.timeout_ms,
        max_request_bytes: resolved.max_request_bytes,
        max_response_bytes: resolved.max_response_bytes,
        request_overhead_bytes: REQUEST_OVERHEAD_BYTES,
      }),
    );

    const identity: PreparedDecisionIdentity = deepFreeze({
      provider: resolved.provider,
      model: resolved.model,
      accepted_response_models: Object.freeze([
        ...resolved.accepted_response_models,
      ]),
      price_version: resolved.price.version,
      input_micro_usd_per_million: resolved.price.input_micro_usd_per_million,
      output_micro_usd_per_million: resolved.price.output_micro_usd_per_million,
      policy_version: SYSTEM_ONE_POLICY_VERSION,
      question_schema_version: DECISION_QUESTION_SCHEMA_VERSION,
      options_hash,
      request_hash,
      config_hash,
      reserved_micro_usd: bound,
      max_request_bytes: resolved.max_request_bytes,
      max_response_bytes: resolved.max_response_bytes,
      request_overhead_bytes: REQUEST_OVERHEAD_BYTES,
    });

    const interpret = (payload: unknown): PreparedDecisionEnvelope => {
      const ids = prepared.input.options.map((option) => option.id);
      try {
        const root = asRecord(payload);
        if (!root) return attemptedUnknown("PROVIDER_INVALID");
        let node: Record<string, unknown> = root;
        if (resolved.provider === "cloudflare") {
          if (root.success === false)
            return attemptedUnknown("PROVIDER_UNAVAILABLE");
          const result = asRecord(root.result);
          if (root.success !== true || !result)
            return attemptedUnknown("PROVIDER_INVALID");
          node = result;
        }

        const usageRec = asRecord(node.usage);
        if (!usageRec) return attemptedUnknown("PROVIDER_INVALID");
        const inputTokens = usageRec.input_tokens;
        const outputTokens = usageRec.output_tokens;
        if (
          !Number.isSafeInteger(inputTokens) ||
          (inputTokens as number) < 0 ||
          !Number.isSafeInteger(outputTokens) ||
          (outputTokens as number) < 0
        )
          return attemptedUnknown("PROVIDER_INVALID");
        const usage: DecisionUsage = {
          input_tokens: inputTokens as number,
          output_tokens: outputTokens as number,
        };

        const model = node.model;
        if (
          typeof model !== "string" ||
          !model.trim() ||
          model.length > 200 ||
          CONTROL_CHARS.test(model) ||
          !resolved.accepted_response_models.includes(model)
        )
          return attemptedUnknown("PROVIDER_INVALID", usage);

        const micro =
          usage.input_tokens * resolved.price.input_micro_usd_per_million +
          usage.output_tokens * resolved.price.output_micro_usd_per_million;
        if (!Number.isSafeInteger(micro))
          return attemptedUnknown("PROVIDER_UNAVAILABLE", usage);
        const cost = Math.ceil(micro / 1_000_000);
        if (!Number.isSafeInteger(cost) || cost < 0)
          return attemptedUnknown("PROVIDER_UNAVAILABLE", usage);
        const known = {
          state: "known" as const,
          cost_micro_usd: cost,
          usage,
          model,
        };

        const answers = asRecord(node.answers);
        const answerKeys = answers ? Object.keys(answers) : [];
        if (
          !answers ||
          answerKeys.length !== 1 ||
          answerKeys[0] !== DECISION_QUESTION_ID
        )
          return knownRefused(known, "INVALID_OUTPUT");
        const answer = asRecord(answers[DECISION_QUESTION_ID]);
        if (!answer || answer.type !== "choice")
          return knownRefused(known, "INVALID_OUTPUT");

        const rawProbabilities = asRecord(answer.probabilities);
        if (!rawProbabilities) return knownRefused(known, "INVALID_OUTPUT");
        const probabilityKeys = Object.keys(rawProbabilities);
        if (
          probabilityKeys.length !== ids.length ||
          ids.some(
            (id) =>
              !Object.prototype.hasOwnProperty.call(rawProbabilities, id),
          )
        )
          return knownRefused(known, "INVALID_OUTPUT");

        const entries: Array<[string, number]> = [];
        let sum = 0;
        for (const id of ids) {
          const value = rawProbabilities[id];
          if (
            typeof value !== "number" ||
            !Number.isFinite(value) ||
            value < 0 ||
            value > 1
          )
            return knownRefused(known, "INVALID_OUTPUT");
          entries.push([id, value]);
          sum += value;
        }
        if (Math.abs(sum - 1) > PROBABILITY_SUM_TOLERANCE)
          return knownRefused(known, "INVALID_OUTPUT");
        const probabilities = Object.fromEntries(entries);

        const choice = answer.choice;
        if (typeof choice !== "string" || !ids.includes(choice))
          return knownRefused(known, "INVALID_OUTPUT");
        const highest = Math.max(...entries.map(([, value]) => value));
        if (probabilities[choice] < highest - PROBABILITY_EPSILON)
          return knownRefused(known, "INVALID_OUTPUT");

        const confidence = answer.confidence;
        if (
          typeof confidence !== "number" ||
          !Number.isFinite(confidence) ||
          confidence < 0 ||
          confidence > 1
        )
          return knownRefused(known, "INVALID_OUTPUT");

        if (cost > bound) return knownRefused(known, "COST_EXCEEDED");

        return envelope({
          disposition: "attempted",
          accounting: known,
          output: { ok: true, choice, confidence, probabilities },
        });
      } catch {
        return attemptedUnknown("PROVIDER_INVALID");
      }
    };

    let used = false;
    const execute = async (
      signal: AbortSignal,
    ): Promise<PreparedDecisionEnvelope> => {
      if (used)
        throw new SystemOneError(
          "INVALID_STATE",
          "This prepared decision was already executed.",
          409,
          false,
        );
      used = true;
      if (signal.aborted) return notDispatched("PROVIDER_ABORTED");

      const controller = new AbortController();
      let timedOut = false;
      let attempted = false;
      const onAbort = () => controller.abort();
      signal.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, resolved.timeout_ms);

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (resolved.key) headers.Authorization = `Bearer ${resolved.key}`;

      const perform = async (): Promise<PreparedDecisionEnvelope> => {
        let response: Response;
        try {
          response = await this.fetcher(resolved.endpoint, {
            method: "POST",
            headers,
            body: prepared.json,
            signal: controller.signal,
            redirect: "error",
          });
        } catch {
          return attemptedUnknown("PROVIDER_UNAVAILABLE");
        }
        const cancelBody = () => {
          response.body?.cancel().catch(() => undefined);
        };
        if (controller.signal.aborted) {
          cancelBody();
          return attemptedUnknown("PROVIDER_ABORTED");
        }
        if (response.status >= 300 && response.status < 400) {
          cancelBody();
          return attemptedUnknown("PROVIDER_UNAVAILABLE");
        }
        if (!response.ok) {
          cancelBody();
          return attemptedUnknown("PROVIDER_UNAVAILABLE");
        }
        let raw: string;
        try {
          raw = await readBounded(response, resolved.max_response_bytes, controller.signal);
        } catch {
          return attemptedUnknown("PROVIDER_UNAVAILABLE");
        }
        if (controller.signal.aborted)
          return attemptedUnknown("PROVIDER_ABORTED");
        let payload: unknown;
        try {
          payload = JSON.parse(raw);
        } catch {
          return attemptedUnknown("PROVIDER_INVALID");
        }
        return interpret(payload);
      };

      const work = Promise.resolve()
        .then(async () => {
          if (controller.signal.aborted)
            return notDispatched("PROVIDER_ABORTED");
          attempted = true;
          return perform();
        })
        .catch(() =>
          attempted
            ? attemptedUnknown(
                timedOut ? "PROVIDER_TIMEOUT" : "PROVIDER_UNAVAILABLE",
              )
            : notDispatched("PROVIDER_ABORTED"),
        );

      const expired = new Promise<PreparedDecisionEnvelope>((resolve) => {
        controller.signal.addEventListener(
          "abort",
          () =>
            resolve(
              attempted
                ? attemptedUnknown(
                    timedOut ? "PROVIDER_TIMEOUT" : "PROVIDER_ABORTED",
                  )
                : notDispatched("PROVIDER_ABORTED"),
            ),
          { once: true },
        );
      });

      try {
        return await Promise.race([work, expired]);
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
      }
    };

    return Object.freeze({
      identity,
      request_bytes: prepared.bytes,
      execute,
    });
  }
}
