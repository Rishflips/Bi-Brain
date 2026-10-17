// TEST-ONLY fetch interceptor for the real managed worker process. It allows
// EXACTLY the two official enrolled endpoints over POST — the TypeSafe decision
// URL and the OpenAI Responses URL — and throws for every other network call, so
// no unhandled request can reach the internet. It records at most a bounded
// counter line with only synthetic metadata (event + model); it never records a
// header, key, prompt or source body. It NEVER intercepts storage, accounting,
// readiness or application services. Modes/release/tamper are TEST-ONLY env
// switches used only to make a synthetic call slow or to negatively invalidate a
// readiness file; no guard, profile or monetary check is ever bypassed.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const DECISION = "https://api.typesafe.ai/v1/systemone";
const REASONING = "https://api.openai.com/v1/responses";
const counter = process.env.FAKE_PROVIDER_COUNTER;
const decisionMode = process.env.FAKE_DECISION_MODE ?? "ok";
const reasoningMode = process.env.FAKE_REASONING_MODE ?? "ok";
const choice = process.env.FAKE_DECISION_CHOICE ?? "related";
const release = process.env.FAKE_DECISION_RELEASE;
const tamperReadiness = process.env.FAKE_DECISION_TAMPER_REASONING_READINESS;
const reasoningReadiness = process.env.FAKE_REASONING_READINESS;
const MAX_COUNTER_LINES = 64;

let count = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const denied = () => new Error("TEST_NETWORK_DENIED");

function record(event, model) {
  if (counter && count < MAX_COUNTER_LINES)
    appendFileSync(counter, JSON.stringify({ event, model }) + "\n");
}

/** Negative tamper only: replace a readiness record's worker_id with a foreign
 * UUID so the worker's own readiness comparison fails closed. Never enables. */
function tamperWorkerId(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    parsed.worker_id = randomUUID();
    writeFileSync(path, JSON.stringify(parsed));
    return true;
  } catch {
    return false;
  }
}

globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input?.url;
  const method = String(
    init?.method ?? (typeof input === "string" ? "GET" : input?.method ?? "GET"),
  ).toUpperCase();
  let href = "";
  try {
    href = new URL(String(url)).href;
  } catch {
    throw denied();
  }

  let body = {};
  try {
    body = JSON.parse(String(init?.body ?? "{}"));
  } catch {
    body = {};
  }
  const requested =
    typeof body.model === "string" ? body.model : "synthetic-model-v1";

  if (href === DECISION && method === "POST") {
    record("decision", requested);
    count += 1;
    if (release) {
      const deadline = Date.now() + 60_000;
      while (!existsSync(release) && Date.now() < deadline) await sleep(100);
    }
    if (tamperReadiness) tamperWorkerId(tamperReadiness);
    const probabilities = { related: 0.1, unrelated: 0.1, abstain: 0.1 };
    probabilities[choice] = 0.8;
    const answerChoice = decisionMode === "malformed" ? "grant_permission" : choice;
    const payload = {
      model: requested,
      answers: {
        decision: {
          type: "choice",
          choice: answerChoice,
          confidence: 0.8,
          probabilities,
        },
      },
    };
    if (decisionMode !== "unknown") payload.usage = { input_tokens: 700, output_tokens: 0 };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  if (href === REASONING && method === "POST") {
    record("reasoning", requested);
    count += 1;
    if (reasoningReadiness) tamperWorkerId(reasoningReadiness);
    let parsedInput;
    try {
      parsedInput = JSON.parse(body.input);
    } catch {
      parsedInput = undefined;
    }
    const sources = Array.isArray(parsedInput)
      ? parsedInput
      : parsedInput && Array.isArray(parsedInput.sources)
        ? parsedInput.sources
        : [];
    const s = sources[0];
    const quote = s ? String(s.body).slice(0, Math.min(23, String(s.body).length)) : "";
    const output = s
      ? {
          outcome: "proposal",
          artifact: "SYNTHETIC process next beta experiment",
          evidence: [
            {
              source_id: String(s.id),
              source_version: Number(s.version),
              start: 0,
              end: quote.length,
              quote,
            },
          ],
        }
      : { outcome: "abstain", artifact: "", evidence: [] };
    const payload = {
      model: requested,
      output: [
        { content: [{ type: "output_text", text: JSON.stringify(output) }] },
      ],
    };
    // The reasoning preload may also be asked to produce unknown usage.
    if (reasoningMode !== "unknown") payload.usage = { input_tokens: 100, output_tokens: 0 };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  throw denied();
};
