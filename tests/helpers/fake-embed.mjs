// A deterministic stand-in for an embedding model, for CI only. It maps text to a
// 256-dimensional unit vector through a small fixed concept lexicon (synonym groups and
// English–Tamil pairs), so fusion, floors, pinning, authorization, staleness and fallback
// can be tested without a model. It keeps no state and never logs request bodies.
import { createHash } from "node:crypto";
import { createServer } from "node:http";

export const FAKE_EMBED_DIM = 256;
export const FAKE_EMBED_MODEL = "fake-concept-v1";
const CONCEPT_DIMS = 128;
const UNKNOWN_WEIGHT = 0.3;
const STOP = new Set("the and for with what when where who how does did are was were this that from each much can will there get got about into than then they them their its our your you".split(" "));

export const LEXICON = [
  ["colour", "color", "hue", "shade", "நிறம்"],
  ["launch", "release", "வெளியீடு", "வெளியீட்டு"],
  ["choose", "chosen", "pick", "picked", "settle", "settled", "decide", "decided"],
  ["price", "fee", "cost", "விலை"],
  ["month", "monthly", "மாத", "மாதம்"],
  ["design", "designer", "visual"],
  ["lead", "head", "chief", "தலைவர்"],
  ["work", "job", "வேலை"],
  ["beta", "trial", "preview"],
  ["open", "start", "begin", "திறக்கிறது", "தொடங்குகிறது"],
  ["invite", "invitation", "join", "rsvp"],
  ["waitlist", "signup", "queue"],
  ["cater", "caterer", "catering", "food", "meal"],
  ["party", "celebration"],
  ["vendor", "supplier"],
  ["spend", "spending", "allowance", "செலவு"],
  ["quarter", "quarterly", "காலாண்டு"],
  ["tooling", "software", "tool"],
  ["plan", "tier"],
  ["offer", "offered", "provide", "provided"],
  ["standup", "stand", "sync", "scrum", "huddle", "meet", "meeting", "சந்திக்கிறது", "சந்திப்பு"],
  ["team", "squad", "crew", "குழு", "அணி"],
  ["office", "அலுவலகம்"],
  ["new", "புதிய"],
  ["move", "relocate", "நகர்கிறது", "மாறுகிறது"],
  ["january", "ஜனவரி", "ஜனவரியில்"],
  // "statu" is "status" after fakeTokens strips the trailing s; both forms are listed so the raw and the stemmed word hit.
  ["status", "statu", "state", "standing", "நிலை"],
  ["active", "running", "live"],
  ["paused", "hold", "stopped"],
  ["deploy", "deployment"],
  ["thursday", "வியாழன்"],
  ["dollar", "டாலர்"],
  ["morning", "காலை"],
  ["daily", "everyday", "தினமும்"],
  ["ticket", "issue"],
  ["login", "signin"],
  ["outage", "downtime"],
  ["patch", "hotfix"],
];
const CONCEPT = new Map();
LEXICON.forEach((group, i) => group.forEach((w) => CONCEPT.set(w, i)));
if (LEXICON.length > CONCEPT_DIMS) throw new Error("fake-embed lexicon exceeds its concept dims");

/** Lowercased letter runs of 3+ code points, trailing "s" dropped (mirrors questionWords), minus a short stoplist. */
export function fakeTokens(text) {
  const words = String(text).toLocaleLowerCase().match(/[\p{L}\p{M}]+/gu) ?? [];
  return [...new Set(words.filter((w) => Array.from(w).length > 2 && !STOP.has(w)).map((w) => w.replace(/s$/u, "")))];
}

export function fakeEmbed(text) {
  const v = new Array(FAKE_EMBED_DIM).fill(0);
  for (const t of fakeTokens(text)) {
    const c = CONCEPT.get(t);
    if (c !== undefined) v[c] = 1;
    else {
      const h = createHash("sha256").update(t).digest();
      v[CONCEPT_DIMS + (h.readUInt16BE(0) % (FAKE_EMBED_DIM - CONCEPT_DIMS))] = UNKNOWN_WEIGHT;
    }
  }
  const norm = Math.hypot(...v);
  return norm === 0 ? v : v.map((x) => x / norm);
}

export function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export function ollamaBody(texts) {
  return { model: FAKE_EMBED_MODEL, embeddings: texts.map(fakeEmbed), prompt_eval_count: texts.reduce((n, t) => n + Math.ceil(Buffer.byteLength(t) / 4), 0) };
}

export function cloudflareBody(texts) {
  return { success: true, errors: [], messages: [], result: { shape: [texts.length, FAKE_EMBED_DIM], data: texts.map(fakeEmbed) } };
}

const textsOf = (body) => (Array.isArray(body?.input) ? body.input : Array.isArray(body?.text) ? body.text : typeof body?.input === "string" ? [body.input] : typeof body?.text === "string" ? [body.text] : []);

/** An in-process fetcher for Vitest: records every call, answers in the chosen shape, and can delay, fail or run a hook before answering. */
export function fakeEmbedFetcher(options = {}) {
  const calls = { n: 0, bodies: [], texts: [], headers: [] };
  const fetcher = async (_url, init) => {
    calls.n++;
    const body = JSON.parse(init.body);
    const texts = textsOf(body);
    calls.bodies.push(body);
    calls.texts.push(texts);
    calls.headers.push({ ...(init.headers ?? {}) });
    if (options.before) await options.before(texts);
    if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
    if (options.status && options.status !== 200) return new Response("", { status: options.status });
    // A provider that refuses an input: 400 for the whole request, so a batch holding one bad text fails as a batch.
    if (options.reject && options.reject(texts)) return new Response(JSON.stringify({ error: "input refused" }), { status: 400 });
    const payload = options.shape === "cloudflare" ? cloudflareBody(texts) : ollamaBody(texts);
    return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return { fetcher, calls };
}

const port = Number(process.env.BRAIN_FAKE_EMBED_PORT);
if (process.env.BRAIN_FAKE_EMBED_PORT) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error("BRAIN_FAKE_EMBED_PORT must be a port number.");
    process.exit(1);
  }
  const server = createServer((req, res) => {
    const ollama = req.method === "POST" && req.url === "/api/embed";
    const cloud = req.method === "POST" && /^\/client\/v4\/accounts\/[^/]+\/ai\/run\//u.test(req.url ?? "");
    if (!ollama && !cloud) {
      res.writeHead(404).end();
      return;
    }
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        res.writeHead(400).end();
        return;
      }
      const texts = textsOf(body);
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(ollama ? ollamaBody(texts) : cloudflareBody(texts)));
    });
  });
  server.listen(port, "127.0.0.1");
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
}
