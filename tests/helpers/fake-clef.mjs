// A loopback stand-in for the sorting service, for browser tests only.
// It speaks the plain Ollama-style shape: POST /v1/systemone answers every
// question in the body. Anything else is a 404. It keeps no state and never
// logs request bodies.
import { createServer } from "node:http";

const port = Number(process.env.BRAIN_FAKE_CLEF_PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("BRAIN_FAKE_CLEF_PORT must be a port number.");
  process.exit(1);
}

function answerFor(question) {
  if (question?.type === "choice") {
    const ids = Object.keys(question.criteria ?? {});
    const first = ids.find((id) => id !== "stay") ?? ids[0];
    const rest = ids.length - 1;
    const probabilities = Object.fromEntries(
      ids.map((id) => [id, id === first ? (rest > 0 ? 0.9 : 1) : 0.1 / rest]),
    );
    return { type: "choice", choice: first, confidence: 0.9, probabilities };
  }
  return { type: "noul", noul: 0.8 };
}

const server = createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/v1/systemone") {
    res.writeHead(404).end();
    return;
  }
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const answers = Object.fromEntries(
      Object.entries(body.questions ?? {}).map(([id, q]) => [id, answerFor(q)]),
    );
    const payload = JSON.stringify({
      model: body.model,
      answers,
      usage: { input_tokens: Math.ceil(Buffer.byteLength(raw) / 4), output_tokens: 0 },
    });
    res.writeHead(200, { "Content-Type": "application/json" }).end(payload);
  });
});

server.listen(port, "127.0.0.1");
// Playwright stops this with SIGTERM when the run ends.
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
