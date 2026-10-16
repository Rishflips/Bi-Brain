// TEST-ONLY worker fetch interceptor. Loaded with `--import` in the trusted worker
// subprocess only (never the server). It allows EXACTLY the official OpenAI
// Responses endpoint over POST and throws for every other network call, so no
// unhandled request can ever reach the internet. It records at most a bounded
// counter line with only synthetic metadata (event + model) — never a header, key,
// prompt or source body. Modes/release are TEST-ONLY env switches.
import { appendFileSync, existsSync } from "node:fs";

const OFFICIAL = "https://api.openai.com/v1/responses";
const counter = process.env.FAKE_PROVIDER_COUNTER;
const mode = process.env.FAKE_PROVIDER_MODE ?? "ok";
const release = process.env.FAKE_PROVIDER_RELEASE;
const MAX_COUNTER_LINES = 32;

let count = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input?.url;
  const method = String(
    init?.method ?? (typeof input === "string" ? "GET" : input?.method ?? "GET"),
  ).toUpperCase();
  let href = "";
  try {
    href = new URL(String(url)).href;
  } catch {
    throw new Error("TEST_NETWORK_DENIED");
  }
  // Exact endpoint AND method; no credentials, query or path drift allowed.
  if (href !== OFFICIAL || method !== "POST") throw new Error("TEST_NETWORK_DENIED");

  let body = {};
  try {
    body = JSON.parse(String(init?.body ?? "{}"));
  } catch {
    body = {};
  }
  const requested =
    typeof body.model === "string" ? body.model : "synthetic-model-v1";

  if (counter && count < MAX_COUNTER_LINES)
    appendFileSync(counter, JSON.stringify({ event: "call", model: requested }) + "\n");
  count += 1;

  // Scenario A: hold the call open (bounded) until a test-only release file exists.
  if (release) {
    const deadline = Date.now() + 35_000;
    while (!existsSync(release) && Date.now() < deadline) await sleep(100);
  }

  let sources = [];
  try {
    sources = JSON.parse(body.input);
  } catch {
    sources = [];
  }
  const s = Array.isArray(sources) && sources[0] ? sources[0] : undefined;
  const quote = s ? String(s.body).slice(0, Math.min(9, String(s.body).length)) : "";
  const validOutput = s
    ? {
        items: [
          {
            text: "Synthetic supported statement",
            epistemic_status: "supported",
            evidence: [
              {
                source_id: String(s.id),
                source_version: Number(s.version),
                start: 0,
                end: quote.length,
                quote,
              },
            ],
          },
        ],
        unknowns: [],
      }
    : { items: [], unknowns: [] };

  const returnedModel =
    mode === "wrongmodel" ? "synthetic-unenrolled-return-v1" : requested;
  const text = mode === "malformed" ? "NOT_JSON_PAYLOAD" : JSON.stringify(validOutput);

  const payload = {
    model: returnedModel,
    usage: { input_tokens: 500, output_tokens: 200 },
    output: [{ type: "message", content: [{ type: "output_text", text }] }],
  };
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
