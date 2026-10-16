import { z } from "zod";
import { BrainError } from "../domain/logic.ts";
import { detectSecrets } from "../storage/secrets.ts";

/**
 * Provider-neutral System One decision transport.
 *
 * This module performs schema, boundary and accounting validation on one
 * bounded choice question. Passing validation proves the answer is
 * well-formed for the declared option set only: it does NOT establish that
 * the probabilities are calibrated or that the decision is semantically
 * correct. Callers must keep decision output advisory and never treat it as
 * permission, a secret-detection barrier or an authorization result.
 *
 * No provider fallback, retry or repair call is performed here. Configuration
 * is validated before dispatch, the caller timeout/cancellation deadline
 * covers the whole request including streaming the bounded response body, and
 * any failure after the request was sent is reported with `dispatched: true`
 * so the caller keeps its reservation rather than recording a false zero
 * cost.
 */

/** Question id sent to the provider; answers must return this same key. */
export const DECISION_QUESTION_ID = "decision";

/** Policy version describing how a choice answer is validated. */
export const SYSTEM_ONE_POLICY_VERSION = "system-one-choice-v1";

/** Conservative per-request accounting overhead added to serialized bytes. */
export const REQUEST_OVERHEAD_BYTES = 1024;

/** Maximum tolerated deviation of the probability sum from 1. */
export const PROBABILITY_SUM_TOLERANCE = 0.001;

/** Upper bound on the UTF-8 byte length of a decision state. */
export const MAX_STATE_BYTES = 500_000;

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_REQUEST_BYTES = 1_048_576;
const DEFAULT_MAX_RESPONSE_BYTES = 262_144;
const HARD_MAX_BODY_BYTES = 33_554_432;
const MIN_BODY_BYTES = 64;
const PROBABILITY_EPSILON = 1e-9;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export const optionSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/),
    description: z.string().min(1).max(2000),
  })
  .strict();

/**
 * Bounded decision input: one text state, one instruction and a closed record
 * of 2-16 distinct allowed options.
 */
export const decisionInputSchema = z
  .object({
    state: z.string().min(1).max(200000),
    instruction: z.string().min(1).max(20000),
    options: z.array(optionSchema).min(2).max(16),
  })
  .strict()
  .refine(
    (value) =>
      new Set(value.options.map((option) => option.id)).size ===
      value.options.length,
    { message: "Decision options must have distinct ids." },
  )
  .refine(
    (value) => Buffer.byteLength(value.state, "utf8") <= MAX_STATE_BYTES,
    { message: "Decision state exceeds the byte bound." },
  );

export type DecisionOption = z.infer<typeof optionSchema>;
export type DecisionInput = z.infer<typeof decisionInputSchema>;

export type DecisionUsage = {
  input_tokens: number;
  output_tokens: number;
};

export type DecisionMetadata = {
  provider: SystemOneProviderKind;
  model: string;
  policy_version: string;
  price_version: string;
};

/**
 * Integer micro-USD cost derived from reported usage and the operator price
 * version. `dispatched` failures carry no cost: usage after a transport
 * failure is unknown and must stay reserved by the caller.
 */
export type DecisionResult = {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
  usage: DecisionUsage;
  metadata: DecisionMetadata;
  cost_micro_usd: number;
};

/** Provider-neutral contract implemented by every decision transport. */
export interface DecisionProvider {
  upperBound(input: DecisionInput): number;
  decide(input: DecisionInput, signal: AbortSignal): Promise<DecisionResult>;
}

export type SystemOneProviderKind = "typesafe" | "cloudflare";

/** Operator-verified price in integer micro-USD per million tokens. */
export type SystemOnePrice = {
  version: string;
  input_micro_usd_per_million: number;
  output_micro_usd_per_million: number;
};

export type SystemOneConfig = {
  provider: SystemOneProviderKind;
  /**
   * Explicit operator-selected endpoint. Remote endpoints must be the
   * official provider URL over HTTPS on the default port; only loopback may
   * use plaintext HTTP.
   */
  endpoint: string;
  model: string;
  /**
   * Returned model identifiers this price version is accepted for. Defaults
   * to the requested model, so an alias such as `jev-latest` must declare the
   * concrete identifiers it resolves to.
   */
  accepted_response_models?: string[];
  /** Server-side credential. Required for remote dispatch only. */
  key?: string;
  /** Mandatory versioned pricing; unknown pricing prevents requests. */
  price?: SystemOnePrice;
  timeout_ms?: number;
  max_request_bytes?: number;
  max_response_bytes?: number;
};

/**
 * Failure raised by the transport. `dispatched` is true once the request
 * bytes may have reached the provider, meaning usage is unknown and any
 * reservation must remain held.
 *
 * When a provider-reported cost is rejected, the already-known `usage` and
 * `actual_cost_micro_usd` are carried here so a caller ledger can retain the
 * actual charge and block the next dispatch; they stay undefined when usage
 * was never known.
 */
export class SystemOneError extends BrainError {
  constructor(
    code: string,
    message: string,
    status: number,
    readonly dispatched: boolean,
    readonly usage?: DecisionUsage,
    readonly actual_cost_micro_usd?: number,
  ) {
    super(code, message, status);
    this.name = "SystemOneError";
  }
}

type ResolvedConfig = {
  provider: SystemOneProviderKind;
  endpoint: string;
  url: URL;
  model: string;
  accepted_response_models: string[];
  key: string | null;
  loopback: boolean;
  price: Required<SystemOnePrice>;
  timeout_ms: number;
  max_request_bytes: number;
  max_response_bytes: number;
};

type Prepared = {
  input: DecisionInput;
  json: string;
  bytes: number;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "::1") return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return match !== null && Number(match[1]) === 127;
}

export function parseDecisionInput(value: unknown): DecisionInput {
  const parsed = decisionInputSchema.safeParse(value);
  if (!parsed.success)
    throw new SystemOneError(
      "INVALID_INPUT",
      "The decision input is out of bounds.",
      400,
      false,
    );
  return parsed.data;
}

function resolveConfig(config: SystemOneConfig): ResolvedConfig {
  const unavailable: (message: string) => never = (message) => {
    throw new SystemOneError("PROVIDER_UNAVAILABLE", message, 503, false);
  };

  if (config.provider !== "typesafe" && config.provider !== "cloudflare")
    unavailable("An unknown decision provider was configured.");

  const price = config.price;
  if (
    !price ||
    typeof price.version !== "string" ||
    !price.version.trim() ||
    price.version.length > 64
  )
    unavailable("A versioned operator price is required for dispatch.");
  if (
    !Number.isSafeInteger(price.input_micro_usd_per_million) ||
    price.input_micro_usd_per_million <= 0
  )
    unavailable("A positive integer input price is required for dispatch.");
  if (
    !Number.isSafeInteger(price.output_micro_usd_per_million) ||
    price.output_micro_usd_per_million < 0
  )
    unavailable("A nonnegative integer output price is required for dispatch.");

  if (
    typeof config.model !== "string" ||
    !config.model.trim() ||
    config.model.length > 100 ||
    CONTROL_CHARS.test(config.model)
  )
    unavailable("A valid decision model name is required.");
  if (
    config.provider === "cloudflare" &&
    !/^(clef|clef-flash)$/.test(config.model)
  )
    unavailable("The Cloudflare decision model must be clef or clef-flash.");

  let url: URL;
  try {
    url = new URL(config.endpoint);
  } catch {
    unavailable("The provider endpoint must be an absolute URL.");
  }
  if (url.username || url.password)
    unavailable("Provider endpoints must not contain credentials.");
  if (url.search)
    unavailable("Provider endpoints must not contain query parameters.");
  if (url.hash)
    unavailable("Provider endpoints must not contain a fragment.");

  const loopback = isLoopbackHost(url.hostname);
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:"))
    unavailable("Remote provider endpoints must use HTTPS.");
  if (!loopback) {
    if (url.port !== "")
      unavailable("Remote provider endpoints must use the default port.");
    if (config.provider === "typesafe") {
      if (
        url.hostname !== "api.typesafe.ai" ||
        url.pathname !== "/v1/systemone"
      )
        unavailable(
          "The TypeSafe endpoint must be https://api.typesafe.ai/v1/systemone.",
        );
    } else {
      const selector =
        /^\/client\/v4\/accounts\/[^/]+\/ai\/run\/@cf\/cloudflare\/(clef|clef-flash)$/.exec(
          url.pathname,
        );
      if (url.hostname !== "api.cloudflare.com" || !selector)
        unavailable(
          "The Cloudflare endpoint must be an official Clef run endpoint.",
        );
      if (selector[1] !== config.model)
        unavailable(
          "The Cloudflare endpoint selector must match the configured model.",
        );
    }
  }

  let key: string | null = null;
  if (config.key !== undefined && config.key !== null) {
    if (
      typeof config.key !== "string" ||
      !config.key.trim() ||
      config.key.length > 4096 ||
      CONTROL_CHARS.test(config.key)
    )
      unavailable("The server-side provider credential is invalid.");
    key = config.key;
  }
  if (!loopback && !key)
    unavailable("A server-side credential is required for remote dispatch.");

  // Paid remote dispatch is limited to input-priced, output-free providers
  // (the official Jev and Clef decision endpoints do not bill output tokens).
  // Without a provider-enforced output bound we must not pretend a byte-derived
  // output allowance is a hard guarantee, so a nonzero remote output price
  // fails closed.
  if (!loopback && price.output_micro_usd_per_million !== 0)
    unavailable(
      "Remote decision providers must be output-free; a nonzero output price is not accepted.",
    );

  const accepted = config.accepted_response_models ?? [config.model];
  if (!Array.isArray(accepted) || accepted.length === 0 || accepted.length > 16)
    unavailable("At least one accepted returned model identifier is required.");
  for (const identifier of accepted)
    if (
      typeof identifier !== "string" ||
      !identifier.trim() ||
      identifier.length > 200 ||
      CONTROL_CHARS.test(identifier)
    )
      unavailable("An accepted returned model identifier is invalid.");
  if (new Set(accepted).size !== accepted.length)
    unavailable("Accepted returned model identifiers must be distinct.");

  const timeout = config.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > MAX_TIMEOUT_MS)
    unavailable(
      "The provider timeout must be a positive integer of milliseconds.",
    );

  const maxRequest = config.max_request_bytes ?? DEFAULT_MAX_REQUEST_BYTES;
  if (
    !Number.isSafeInteger(maxRequest) ||
    maxRequest < MIN_BODY_BYTES ||
    maxRequest > HARD_MAX_BODY_BYTES
  )
    unavailable("The configured request byte bound is invalid.");
  const maxResponse = config.max_response_bytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (
    !Number.isSafeInteger(maxResponse) ||
    maxResponse < MIN_BODY_BYTES ||
    maxResponse > HARD_MAX_BODY_BYTES
  )
    unavailable("The configured response byte bound is invalid.");

  return {
    provider: config.provider,
    endpoint: config.endpoint,
    url,
    model: config.model,
    accepted_response_models: accepted,
    key,
    loopback,
    price: {
      version: price.version,
      input_micro_usd_per_million: price.input_micro_usd_per_million,
      output_micro_usd_per_million: price.output_micro_usd_per_million,
    },
    timeout_ms: timeout,
    max_request_bytes: maxRequest,
    max_response_bytes: maxResponse,
  };
}

/** Real HTTP transport for an explicit operator-configured decision endpoint. */
export class SystemOneProvider implements DecisionProvider {
  private readonly settings: ResolvedConfig;
  private readonly fetcher: typeof fetch;

  constructor(config: SystemOneConfig, fetcher: typeof fetch = fetch) {
    this.settings = resolveConfig(config);
    this.fetcher = fetcher;
  }

  /**
   * Conservative integer micro-USD reservation: the full serialized UTF-8
   * request plus a documented overhead, priced at the operator input rate,
   * plus a response-byte-derived output allowance priced at the operator
   * output rate.
   *
   * Paid remote dispatch requires an output-free provider (the official Jev
   * and Clef decision endpoints do not bill output tokens), so the output term
   * is zero for remote and this is an exact input-price bound. The
   * byte-derived output allowance is used only for unpriced local loopback and
   * is a local estimate, not a vendor guarantee. If a provider reports a cost
   * above the bound, `decide` rejects it with `dispatched: true` (carrying the
   * known actual usage/cost) so the caller keeps its reservation. Throws when
   * input, pricing or the safe-integer range is violated.
   */
  upperBound(input: DecisionInput): number {
    return this.costBound(this.prepare(input));
  }

  async decide(
    input: DecisionInput,
    signal: AbortSignal,
  ): Promise<DecisionResult> {
    const prepared = this.prepare(input);
    // The dispatch path must never bypass the safe-integer reservation check.
    const bound = this.costBound(prepared);
    return this.run(prepared, bound, signal);
  }

  private costBound(prepared: Prepared): number {
    const price = this.settings.price;
    const inputUpperTokens = prepared.bytes + REQUEST_OVERHEAD_BYTES;
    const outputUpperTokens = this.settings.max_response_bytes;
    const micro =
      inputUpperTokens * price.input_micro_usd_per_million +
      outputUpperTokens * price.output_micro_usd_per_million;
    if (!Number.isSafeInteger(micro))
      throw new SystemOneError(
        "PROVIDER_UNAVAILABLE",
        "The cost bound exceeds the safe integer range.",
        503,
        false,
      );
    const bound = Math.ceil(micro / 1_000_000);
    if (!Number.isSafeInteger(bound) || bound < 0)
      throw new SystemOneError(
        "PROVIDER_UNAVAILABLE",
        "The cost bound exceeds the safe integer range.",
        503,
        false,
      );
    return bound;
  }

  private prepare(input: DecisionInput): Prepared {
    const parsed = parseDecisionInput(input);
    // Bounded best-effort secret scan over the whole accepted input (state,
    // instruction and options). It is not a guarantee of arbitrary protection,
    // but it does cover the full bounded payload rather than a prefix.
    const checked = [
      parsed.state,
      parsed.instruction,
      ...parsed.options.map((option) => `${option.id}: ${option.description}`),
    ].join("\n");
    if (detectSecrets(checked).length > 0)
      throw new SystemOneError(
        "INVALID_INPUT",
        "This content looks like it may contain a secret, so it was not sent to the provider.",
        400,
        false,
      );
    const criteria = Object.fromEntries(
      parsed.options.map((option) => [option.id, option.description]),
    );
    const json = JSON.stringify({
      model: this.settings.model,
      state: parsed.state,
      questions: {
        [DECISION_QUESTION_ID]: {
          type: "choice",
          instructions: parsed.instruction,
          criteria,
        },
      },
    });
    const bytes = Buffer.byteLength(json, "utf8");
    if (bytes > this.settings.max_request_bytes)
      throw new SystemOneError(
        "INVALID_INPUT",
        "The decision request is larger than the configured limit.",
        400,
        false,
      );
    return { input: parsed, json, bytes };
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.settings.key) headers.Authorization = `Bearer ${this.settings.key}`;
    return headers;
  }

  /**
   * Runs the whole request - fetch, bounded streaming read and interpretation
   * - under one deadline. The timeout and caller cancellation are enforced by
   * a promise race, so an injected fetcher or stream that ignores its abort
   * signal still cannot outlive the deadline.
   */
  private async run(
    prepared: Prepared,
    bound: number,
    signal: AbortSignal,
  ): Promise<DecisionResult> {
    if (signal.aborted)
      throw new SystemOneError(
        "PROVIDER_ABORTED",
        "The decision request was cancelled before it was sent.",
        499,
        false,
      );
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.settings.timeout_ms);

    const work = Promise.resolve().then(() =>
      this.perform(prepared, bound, controller.signal),
    );
    work.catch(() => undefined);

    const expired = new Promise<never>((_, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => {
          reject(
            timedOut
              ? new SystemOneError(
                  "PROVIDER_TIMEOUT",
                  "The provider did not answer within the configured timeout. Any reservation remains held.",
                  504,
                  true,
                )
              : new SystemOneError(
                  "PROVIDER_ABORTED",
                  "The decision request was cancelled. Any reservation remains held.",
                  499,
                  true,
                ),
          );
        },
        { once: true },
      );
    });
    expired.catch(() => undefined);

    try {
      return await Promise.race([work, expired]);
    } catch (error) {
      // Only our own transport errors may cross the boundary: a foreign
      // error could leak provider/model content or a wrong dispatched flag.
      if (error instanceof SystemOneError) throw error;
      throw new SystemOneError(
        "PROVIDER_UNAVAILABLE",
        "The provider request failed. Any reservation remains held.",
        503,
        true,
      );
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }

  private async perform(
    prepared: Prepared,
    bound: number,
    signal: AbortSignal,
  ): Promise<DecisionResult> {
    // The dispatch is scheduled on a microtask; re-check the caller signal at
    // the boundary so cancelled input is never sent, even by a transport that
    // ignores its abort signal.
    if (signal.aborted)
      throw new SystemOneError(
        "PROVIDER_ABORTED",
        "The decision request was cancelled before it was sent.",
        499,
        false,
      );
    const response = await this.fetcher(this.settings.endpoint, {
      method: "POST",
      headers: this.headers(),
      body: prepared.json,
      signal,
      redirect: "error",
    });
    if (response.status >= 300 && response.status < 400) {
      // Release the unread body without awaiting it.
      response.body?.cancel().catch(() => undefined);
      throw new SystemOneError(
        "PROVIDER_UNAVAILABLE",
        "The provider tried to redirect the request, which is not allowed. Any reservation remains held.",
        503,
        true,
      );
    }
    if (!response.ok) {
      response.body?.cancel().catch(() => undefined);
      throw new SystemOneError(
        "PROVIDER_UNAVAILABLE",
        `The provider request failed (${response.status}). Any reservation remains held.`,
        503,
        true,
      );
    }
    const raw = await this.readBounded(response, signal);
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new SystemOneError(
        "PROVIDER_INVALID",
        "The provider returned unreadable data.",
        502,
        true,
      );
    }
    return this.interpret(payload, prepared.input, bound);
  }

  /**
   * Streams the response with a hard byte cap. The advertised content length
   * is untrusted: only the actual streamed bytes are counted. On overflow the
   * download is cancelled immediately and the caller keeps its reservation.
   */
  private async readBounded(
    response: Response,
    signal: AbortSignal,
  ): Promise<string> {
    const limit = this.settings.max_response_bytes;
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

  private interpret(
    payload: unknown,
    input: DecisionInput,
    bound: number,
  ): DecisionResult {
    const known: { usage?: DecisionUsage; cost?: number } = {};
    const invalid: (message: string) => never = (message) => {
      throw new SystemOneError(
        "PROVIDER_INVALID",
        message,
        502,
        true,
        known.usage,
        known.cost,
      );
    };
    const unavailable: (message: string) => never = (message) => {
      throw new SystemOneError(
        "PROVIDER_UNAVAILABLE",
        message,
        503,
        true,
        known.usage,
        known.cost,
      );
    };

    const root = asRecord(payload);
    if (!root) invalid("The provider returned an unusable decision.");
    let node: Record<string, unknown> = root;
    if (this.settings.provider === "cloudflare") {
      if (root.success === false)
        unavailable("The provider reported an unavailable result.");
      const result = asRecord(root.result);
      if (root.success !== true || !result)
        invalid("The provider returned an unusable decision.");
      node = result;
    }

    // Token usage is validated independently of the decision so a known
    // expenditure is never lost when the choice itself is invalid.
    const usage = asRecord(node.usage);
    if (!usage) invalid("The provider decision did not report token usage.");
    const inputTokens = usage.input_tokens;
    const outputTokens = usage.output_tokens;
    if (
      !Number.isSafeInteger(inputTokens) ||
      (inputTokens as number) < 0 ||
      !Number.isSafeInteger(outputTokens) ||
      (outputTokens as number) < 0
    )
      invalid("The provider decision reported invalid token usage.");
    const knownUsage: DecisionUsage = {
      input_tokens: inputTokens as number,
      output_tokens: outputTokens as number,
    };
    known.usage = knownUsage;

    // A price version applies only to explicitly accepted returned model
    // identifiers: an unrelated model is rejected with its usage but no cost
    // rather than being silently priced.
    if (
      typeof node.model !== "string" ||
      !node.model.trim() ||
      node.model.length > 200 ||
      CONTROL_CHARS.test(node.model)
    )
      invalid("The provider decision did not identify a usable model.");
    if (!this.settings.accepted_response_models.includes(node.model))
      invalid("The provider decision returned an unaccepted model identifier.");

    const price = this.settings.price;
    const micro =
      knownUsage.input_tokens * price.input_micro_usd_per_million +
      knownUsage.output_tokens * price.output_micro_usd_per_million;
    if (!Number.isSafeInteger(micro))
      unavailable("The reported usage exceeds the safe cost range.");
    const cost = Math.ceil(micro / 1_000_000);
    if (!Number.isSafeInteger(cost) || cost < 0)
      unavailable("The reported usage exceeds the safe cost range.");
    known.cost = cost;

    const answers = asRecord(node.answers);
    if (!answers) invalid("The provider decision is missing answers.");
    const answerKeys = Object.keys(answers);
    if (answerKeys.length !== 1 || answerKeys[0] !== DECISION_QUESTION_ID)
      invalid("The provider decision did not answer the requested question.");

    const answer = asRecord(answers[DECISION_QUESTION_ID]);
    if (!answer || answer.type !== "choice")
      invalid("The provider decision was not a choice answer.");

    const ids = input.options.map((option) => option.id);
    const rawProbabilities = asRecord(answer.probabilities);
    if (!rawProbabilities)
      invalid("The provider decision is missing probabilities.");
    const probabilityKeys = Object.keys(rawProbabilities);
    if (
      probabilityKeys.length !== ids.length ||
      ids.some(
        (id) => !Object.prototype.hasOwnProperty.call(rawProbabilities, id),
      )
    )
      invalid("The provider decision used an unapproved option set.");

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
        invalid("The provider decision contained an invalid probability.");
      entries.push([id, value]);
      sum += value;
    }
    if (Math.abs(sum - 1) > PROBABILITY_SUM_TOLERANCE)
      invalid("The provider decision probabilities do not sum to one.");
    const probabilities = Object.fromEntries(entries);

    const choice = answer.choice;
    if (typeof choice !== "string" || !ids.includes(choice))
      invalid("The provider decision selected an unapproved option.");
    const highest = Math.max(...entries.map(([, value]) => value));
    if (probabilities[choice] < highest - PROBABILITY_EPSILON)
      invalid("The provider decision choice is not its most probable option.");

    const confidence = answer.confidence;
    if (
      typeof confidence !== "number" ||
      !Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 1
    )
      invalid("The provider decision contained an invalid confidence.");

    if (cost > bound)
      unavailable(
        "The provider reported a cost above the reserved bound. Any reservation remains held.",
      );

    return {
      choice,
      confidence,
      probabilities,
      usage: {
        input_tokens: inputTokens as number,
        output_tokens: outputTokens as number,
      },
      metadata: {
        provider: this.settings.provider,
        model: node.model,
        policy_version: SYSTEM_ONE_POLICY_VERSION,
        price_version: price.version,
      },
      cost_micro_usd: cost,
    };
  }
}
