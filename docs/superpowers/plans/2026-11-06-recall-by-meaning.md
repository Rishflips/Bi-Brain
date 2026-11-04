# Recall by Meaning (plan 10) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Better search turns itself on when a local Ollama with the search model is found (never Cloudflare), a hit found by meaning alone can lead a push only after the owner applies a measured threshold, and short or decision-shaped prompts ("continue", "what did we pick for the caterer") pull useful context without pushing on generic prompts.

**Architecture:** The worker probes loopback Ollama once at startup and publishes `detected` on the key-free status; the domain reads an absent `better_search` row as automatic when that flag is set. A pure `meaningLead` rule in `recall-push.ts` runs last in `recallPush`, gated on an owner-applied `meaning_lead` settings row bound to the model key. A pure `recall-intent.ts` module classifies prompts; `recallPush` reads a bounded per-session topic store for continuations and takes the louder of two deterministic readings for decision questions. No migration; every new value is a settings row or a status field.

**Tech Stack:** Node 24.19, TypeScript, Fastify 5, Zod 4, React 19, SQLite via `node:sqlite`, Vitest, Playwright. Tests use `tests/helpers/fake-embed.mjs` and fake fetchers only.

**Spec:** `docs/superpowers/specs/2026-11-06-recall-by-meaning-design.md`

## Global Constraints

- Work only in the worktree `C:/Users/Gowrishankar/Desktop/Bi Brain/.worktrees/meaning` (branch `reframe/recall-by-meaning`). Never touch the main checkout. Never `git add .`; add by explicit paths. No rebase, force-push, bare `git stash` or push.
- Frozen, byte for byte: `dodo*`, `billing*`, `managed*`, `paddle*` files and tests; `managedPreferencesPatchSchema`; applied migrations (this plan adds none); `docs/DODO_PAYMENTS.md`, `docs/RELEASE.md`, `docs/IMPLEMENTATION_PLAN.md`, `docs/PRICING_PROPOSAL_2026-10-21.md`, `docs/BUSINESS.md`.
- `tests/eval/recall-dense-off-snapshot.json` is never regenerated. After every task that touches `packages/domain/service.ts`, run `npx vitest run tests/integration/recall-dense.test.ts -t "plan 5 snapshot" --reporter=dot --maxWorkers=1` and it must pass. `tests/integration/bibrain-hook.test.ts` is not edited.
- Never run `npm run proof:search`, `npm run calibrate` against real data, any real agent, any real Ollama or Cloudflare. Never read the owner's `data/` or any `.env`. Never print a key.
- Neutral security wording (public repository). Copy follows `AGENTS.md`: no model names on the card except inside the one setup instruction the owner has to type; no status codes; every control has real behaviour or a labelled unavailable state; agents only suggest; never invent results.
- Names, verbatim: settings rows `meaning_lead` and `recall_session_topics`; status fields `detected` and `probe`; route `/api/v1/preferences/meaning-lead` (GET, PATCH, DELETE); log fields `lead`, `intent`, `topic`; environment value `BRAIN_EMBED_PROVIDER=off`; golden file `tests/eval/recall-short-golden-v1.json`.
- Numbers, verbatim: probe budget 1,500 ms and 1 MiB; lead threshold from the model's floor (0.45 for `bge-m3`) to 0.99, two decimals; sample at least 20; session topics 12 words, 20 sessions, 2 hours; hook floor 12 code points stays.
- Commit trailer: `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` on Sonnet tasks, `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` on Opus tasks (Tasks 2, 4 and 7).
- The machine is short on memory: run Vitest with `--maxWorkers=2` (single files with `--maxWorkers=1`), Playwright with `--workers=1`, never both at once. The frozen billing tests need `C:/Users/Gowrishankar/AppData/Local/Temp/opencode` to exist (`New-Item -ItemType Directory -Force`).

## Review Focus

1. Ollama answers `/api/tags` late, with a multi-megabyte body, or with garbage: the probe returns `no_ollama` inside 1,500 ms, nothing from the body is stored, and the worker starts as if Ollama were absent. (Pinned in Task 1.)
2. An owner who chose Off before this plan and has Ollama with the model running: Better search stays off, the status line says Off, and only a muted hint says the model is there. (Pinned in Task 2.)
3. A `meaning_lead` row measured for one model key after the owner switches models: it never leads, Settings says "Measured for another search model. Measure again.", and a PATCH below the floor, with a sample of 19, an unknown source or a future date is a plain 400. (Pinned in Task 4.)
4. "continue" as the first prompt on an empty brain, or later in a session with no topic: `none`, empty text, no digest, nothing invented. (Pinned in Tasks 7 and 8.)
5. A topic stored by one session is never read by another session, and a topic older than two hours is never read. (Pinned in Task 7.)

---

### Task 1: Loopback Ollama probe, worker setup and the fake server's `/api/tags` (Sonnet)

**Files:**
- Create: `packages/providers/ollama-detect.ts`
- Modify: `packages/domain/better-search.ts` (add `ProbeOutcome`, `EMBED_OFF_BY_SETUP`, `PROBE_REASONS`; extend `BetterSearchStatus`)
- Modify: `packages/providers/embed-env.ts` (add `embedSetup`)
- Modify: `apps/worker/embed.ts:27-44` (`publishBetterSearchStatus` input type)
- Modify: `apps/worker/main.ts:502-509` (use `embedSetup`)
- Modify: `tests/helpers/fake-embed.mjs:118-143` (answer `GET /api/tags`)
- Modify: `playwright.config.ts` (five servers get `BRAIN_EMBED_PROVIDER: "off"`)
- Test: `tests/integration/ollama-detect.test.ts` (new)

**Interfaces:**
- Produces: `ProbeOutcome = "found" | "no_ollama" | "no_model" | "skipped"`; `BetterSearchStatus.detected?: boolean`, `BetterSearchStatus.probe?: ProbeOutcome`; `detectOllamaModel({ endpoint?, model, fetcher?, timeoutMs? }) -> Promise<{ found: true; outcome: "found" } | { found: false; outcome: "no_ollama" | "no_model" }>`; `ollamaTagsUrl(endpoint) -> string | null`; `modelListed(body, model) -> boolean`; `embedSetup(env, probe?) -> Promise<EmbedSetup>` where `EmbedSetup = { config: EmbedConfig; label: string; key: string; detected: boolean; probe: ProbeOutcome } | { config: null; reason: string; probe: ProbeOutcome }`; `EMBED_OFF_BY_SETUP`, `PROBE_REASONS`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/integration/ollama-detect.test.ts
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../../packages/storage/index.ts";
import { Brain } from "../../packages/domain/service.ts";
import { BETTER_SEARCH_STATUS, EMBED_OFF_BY_SETUP, OLLAMA_EMBED_ENDPOINT, PROBE_REASONS, modelKey, type BetterSearchStatus } from "../../packages/domain/better-search.ts";
import { OLLAMA_PROBE_MAX_BYTES, detectOllamaModel, modelListed, ollamaTagsUrl } from "../../packages/providers/ollama-detect.ts";
import { embedSetup } from "../../packages/providers/embed-env.ts";
import { publishBetterSearchStatus } from "../../apps/worker/embed.ts";

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.reverse()) fn();
  cleanup = [];
});
const tags = (names: string[]) => JSON.stringify({ models: names.map((name) => ({ name, model: name, size: 1 })) });
/** A fetcher that records the URL it was given and answers as told. */
function answering(body: string | (() => Promise<Response>), status = 200) {
  const urls: string[] = [];
  const fetcher = (async (url: string | URL) => {
    urls.push(String(url));
    if (typeof body === "function") return body();
    return new Response(body, { status, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetcher, urls };
}

describe("the loopback Ollama probe", () => {
  it("derives the tags URL only for plain http on loopback", () => {
    expect(ollamaTagsUrl(OLLAMA_EMBED_ENDPOINT)).toBe("http://127.0.0.1:11434/api/tags");
    expect(ollamaTagsUrl("http://localhost:5555/api/embed")).toBe("http://localhost:5555/api/tags");
    expect(ollamaTagsUrl("https://127.0.0.1:11434/api/embed")).toBeNull();
    expect(ollamaTagsUrl("http://ollama.example.com/api/embed")).toBeNull();
    expect(ollamaTagsUrl("http://user:pw@127.0.0.1:11434/api/embed")).toBeNull();
    expect(ollamaTagsUrl("not a url")).toBeNull();
  });
  it("matches a listed model exactly, or by base name when the configured name carries no tag", () => {
    expect(modelListed(JSON.parse(tags(["bge-m3:latest"])), "bge-m3")).toBe(true);
    expect(modelListed(JSON.parse(tags(["bge-m3:567m"])), "bge-m3")).toBe(true);
    expect(modelListed(JSON.parse(tags(["bge-m3:latest"])), "bge-m3:567m")).toBe(false);
    expect(modelListed(JSON.parse(tags(["bge-m3-large:latest"])), "bge-m3")).toBe(false);
    expect(modelListed(JSON.parse(tags(["embeddinggemma:latest"])), "bge-m3")).toBe(false);
    expect(modelListed({ models: "nope" }, "bge-m3")).toBe(false);
    expect(modelListed([{ name: "bge-m3" }], "bge-m3")).toBe(false);
    expect(modelListed(null, "bge-m3")).toBe(false);
  });
  it("finds the model, reports a missing model, and reports no Ollama on an error, a refusal, garbage, an oversized body or silence, inside the budget", async () => {
    const found = answering(tags(["bge-m3:latest", "clef-flash:cloud"]));
    expect(await detectOllamaModel({ model: "bge-m3", fetcher: found.fetcher })).toEqual({ found: true, outcome: "found" });
    expect(found.urls).toEqual(["http://127.0.0.1:11434/api/tags"]);
    expect(await detectOllamaModel({ model: "bge-m3", fetcher: answering(tags(["embeddinggemma:latest"])).fetcher })).toEqual({ found: false, outcome: "no_model" });
    expect(await detectOllamaModel({ model: "bge-m3", fetcher: answering("", 404).fetcher })).toEqual({ found: false, outcome: "no_ollama" });
    expect(await detectOllamaModel({ model: "bge-m3", fetcher: answering("{not json").fetcher })).toEqual({ found: false, outcome: "no_ollama" });
    const refused = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    expect(await detectOllamaModel({ model: "bge-m3", fetcher: refused })).toEqual({ found: false, outcome: "no_ollama" });
    const huge = answering(`{"models":[{"name":"${"x".repeat(OLLAMA_PROBE_MAX_BYTES)}"}]}`);
    expect(await detectOllamaModel({ model: "bge-m3", fetcher: huge.fetcher })).toEqual({ found: false, outcome: "no_ollama" });
    const silent = answering(() => new Promise<Response>(() => {}));
    const t = Date.now();
    expect(await detectOllamaModel({ model: "bge-m3", fetcher: silent.fetcher, timeoutMs: 80 })).toEqual({ found: false, outcome: "no_ollama" });
    expect(Date.now() - t).toBeLessThan(1000);
    expect(await detectOllamaModel({ endpoint: "http://ollama.example.com/api/embed", model: "bge-m3", fetcher: found.fetcher })).toEqual({ found: false, outcome: "no_ollama" });
    expect(found.urls).toHaveLength(1);
  });
});

describe("embedSetup", () => {
  const probeFound = async () => ({ found: true as const, outcome: "found" as const });
  const probeNoModel = async () => ({ found: false as const, outcome: "no_model" as const });
  const probeNoOllama = async () => ({ found: false as const, outcome: "no_ollama" as const });
  it("skips the probe when the setup says off, and when the provider is Cloudflare", async () => {
    let probed = 0;
    const probe = (async () => { probed++; return { found: true as const, outcome: "found" as const }; }) as typeof detectOllamaModel;
    expect(await embedSetup({ BRAIN_EMBED_PROVIDER: "off" }, probe)).toEqual({ config: null, reason: EMBED_OFF_BY_SETUP, probe: "skipped" });
    const cloud = await embedSetup({ BRAIN_EMBED_PROVIDER: "cloudflare", BRAIN_CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef", BRAIN_DECISION_API_KEY: ["sk", "test", "never", "a", "real", "key", "0123456789abcdef"].join("-") }, probe);
    expect(cloud.config?.provider).toBe("cloudflare");
    expect(cloud).toMatchObject({ detected: false, probe: "skipped" });
    expect(probed).toBe(0);
  });
  it("with nothing set, configures Ollama on the default endpoint when the model is found, and says why when it is not", async () => {
    const on = await embedSetup({}, probeFound as typeof detectOllamaModel);
    expect(on.config).toMatchObject({ provider: "ollama", endpoint: OLLAMA_EMBED_ENDPOINT, model: "bge-m3" });
    expect(on).toMatchObject({ key: modelKey("ollama", "bge-m3"), label: "Ollama on this computer", detected: true, probe: "found" });
    expect(await embedSetup({}, probeNoModel as typeof detectOllamaModel)).toEqual({ config: null, reason: PROBE_REASONS.no_model, probe: "no_model" });
    expect(await embedSetup({}, probeNoOllama as typeof detectOllamaModel)).toEqual({ config: null, reason: PROBE_REASONS.no_ollama, probe: "no_ollama" });
    const custom = await embedSetup({ BRAIN_EMBED_MODEL: "embeddinggemma", BRAIN_EMBED_ENDPOINT: "http://127.0.0.1:5555/api/embed" }, probeFound as typeof detectOllamaModel);
    expect(custom.config).toMatchObject({ provider: "ollama", endpoint: "http://127.0.0.1:5555/api/embed", model: "embeddinggemma" });
    // A non-loopback override is refused before any probe, exactly as an explicit ollama setup is.
    let probed = 0;
    const counting = (async () => { probed++; return { found: true as const, outcome: "found" as const }; }) as typeof detectOllamaModel;
    const remote = await embedSetup({ BRAIN_EMBED_ENDPOINT: "http://ollama.example.com/api/embed" }, counting);
    expect(remote.config).toBeNull();
    expect(remote.probe).toBe("skipped");
    expect(probed).toBe(0);
  });
  it("keeps an explicit Ollama setup when the probe fails, marked not detected", async () => {
    const kept = await embedSetup({ BRAIN_EMBED_PROVIDER: "ollama" }, probeNoOllama as typeof detectOllamaModel);
    expect(kept.config?.provider).toBe("ollama");
    expect(kept).toMatchObject({ detected: false, probe: "no_ollama" });
    const on = await embedSetup({ BRAIN_EMBED_PROVIDER: "ollama", BRAIN_EMBED_MODEL: "fake-concept-v1" }, probeFound as typeof detectOllamaModel);
    expect(on).toMatchObject({ detected: true, probe: "found", key: modelKey("ollama", "fake-concept-v1") });
  });
  it("is published on the status, key-free, and carried across a restart with the same key", () => {
    const dir = mkdtempSync(join(tmpdir(), "probe-status-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const store = new Storage(join(dir, "brain.sqlite"));
    cleanup.push(() => store.close());
    const brain = new Brain(store);
    publishBetterSearchStatus(brain, { configured: true, provider: "ollama", model: "bge-m3", key: modelKey("ollama", "bge-m3"), label: "Ollama on this computer", detected: true, probe: "found" });
    const status = store.setting<BetterSearchStatus>(BETTER_SEARCH_STATUS, null as never);
    expect(status).toMatchObject({ configured: true, detected: true, probe: "found" });
    expect(JSON.stringify(status)).not.toMatch(/latest|size/u);
    publishBetterSearchStatus(brain, { configured: false, reason: PROBE_REASONS.no_ollama, probe: "no_ollama" });
    expect(store.setting<BetterSearchStatus>(BETTER_SEARCH_STATUS, null as never)).toMatchObject({ configured: false, probe: "no_ollama" });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/integration/ollama-detect.test.ts --reporter=dot --maxWorkers=1`
Expected: FAIL with "Cannot find module '../../packages/providers/ollama-detect.ts'" (or a missing export of `EMBED_OFF_BY_SETUP`).

- [ ] **Step 3: Add the domain types and sentences**

In `packages/domain/better-search.ts`, after `export const PROVIDER_LABELS = …`:

```ts
/** What the worker's startup probe of a loopback Ollama found. Key-free, like everything else on the status. */
export type ProbeOutcome = "found" | "no_ollama" | "no_model" | "skipped";
export const EMBED_OFF_BY_SETUP = "Better search is turned off by this computer's setup.";
export const PROBE_REASONS: Record<"no_ollama" | "no_model", string> = {
  no_ollama: "Ollama was not found on this computer when BiBrain started.",
  no_model: "Ollama is running on this computer, but its search model is not pulled.",
};
```

In `BetterSearchStatus`, after `paused_until?: string;`:

```ts
  /** The startup probe of a loopback Ollama: whether the configured model was listed, and what the probe saw. Absent before this version. */
  detected?: boolean;
  probe?: ProbeOutcome;
```

- [ ] **Step 4: Write the probe**

```ts
// packages/providers/ollama-detect.ts
import { OLLAMA_EMBED_ENDPOINT, type ProbeOutcome } from "../domain/better-search.ts";

export type OllamaProbe = { found: true; outcome: "found" } | { found: false; outcome: Exclude<ProbeOutcome, "found" | "skipped"> };
/** One request, inside this budget, at most this many bytes. */
export const OLLAMA_PROBE_MS = 1500;
export const OLLAMA_PROBE_MAX_BYTES = 1_048_576;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** The tags URL for an embed endpoint, or null unless the endpoint is plain http on loopback with no credentials. Nothing else is ever probed. */
export function ollamaTagsUrl(endpoint: string): string | null {
  try {
    const u = new URL(endpoint);
    if (u.protocol !== "http:" || !LOOPBACK.has(u.hostname) || u.username || u.password) return null;
    return `${u.origin}/api/tags`;
  } catch {
    return null;
  }
}

/** Whether a tags listing names the model: the exact name, or `<model>:<tag>` when the configured name carries no tag (Ollama lists `bge-m3:latest` after `ollama pull bge-m3`). */
export function modelListed(body: unknown, model: string): boolean {
  const models = body && typeof body === "object" && !Array.isArray(body) ? (body as { models?: unknown }).models : undefined;
  if (!Array.isArray(models)) return false;
  const tagged = model.includes(":");
  return models.some((m) => {
    const name = m && typeof m === "object" ? (m as { name?: unknown }).name : undefined;
    return typeof name === "string" && (name === model || (!tagged && name.startsWith(`${model}:`)));
  });
}

/** One loopback GET inside the budget. Never throws, never retries; nothing from the body is kept beyond the yes-or-no answer. */
export async function detectOllamaModel(opts: { endpoint?: string; model: string; fetcher?: typeof fetch; timeoutMs?: number }): Promise<OllamaProbe> {
  const url = ollamaTagsUrl(opts.endpoint ?? OLLAMA_EMBED_ENDPOINT);
  if (!url) return { found: false, outcome: "no_ollama" };
  const fetcher = opts.fetcher ?? fetch;
  try {
    const res = await fetcher(url, { method: "GET", signal: AbortSignal.timeout(opts.timeoutMs ?? OLLAMA_PROBE_MS), redirect: "error" });
    if (!res.ok) return { found: false, outcome: "no_ollama" };
    if (Number(res.headers.get("content-length") ?? 0) > OLLAMA_PROBE_MAX_BYTES) return { found: false, outcome: "no_ollama" };
    const text = await res.text();
    if (text.length > OLLAMA_PROBE_MAX_BYTES) return { found: false, outcome: "no_ollama" };
    return modelListed(JSON.parse(text), opts.model) ? { found: true, outcome: "found" } : { found: false, outcome: "no_model" };
  } catch {
    return { found: false, outcome: "no_ollama" };
  }
}
```

- [ ] **Step 5: Add `embedSetup` beside `embedFromEnv`**

Append to `packages/providers/embed-env.ts` (and add `EMBED_OFF_BY_SETUP, PROBE_REASONS, type ProbeOutcome` to its import from `../domain/better-search.ts`, plus `import { detectOllamaModel } from "./ollama-detect.ts";`):

```ts
export type EmbedSetup = { config: EmbedConfig; label: string; key: string; detected: boolean; probe: ProbeOutcome } | { config: null; reason: string; probe: ProbeOutcome };

/**
 * The worker's startup setup. `off` skips everything. Nothing set means: look for Ollama with the search model on loopback and,
 * if it is there, set up exactly as `BRAIN_EMBED_PROVIDER=ollama` would. An explicit Ollama setup is kept whatever the probe finds,
 * marked `detected` only when the model is listed; Cloudflare is never probed and never detected.
 */
export async function embedSetup(env: Record<string, string | undefined>, probe: typeof detectOllamaModel = detectOllamaModel): Promise<EmbedSetup> {
  const provider = (env.BRAIN_EMBED_PROVIDER ?? "").trim();
  if (provider === "off") return { config: null, reason: EMBED_OFF_BY_SETUP, probe: "skipped" };
  const base = embedFromEnv(provider ? env : { ...env, BRAIN_EMBED_PROVIDER: "ollama" });
  if (!base.config) return { ...base, probe: "skipped" };
  if (base.config.provider !== "ollama") return { ...base, detected: false, probe: "skipped" };
  const result = await probe({ endpoint: base.config.endpoint, model: base.config.model });
  if (result.found) return { ...base, detected: true, probe: "found" };
  if (provider) return { ...base, detected: false, probe: result.outcome };
  return { config: null, reason: PROBE_REASONS[result.outcome], probe: result.outcome };
}
```

- [ ] **Step 6: Carry the fields through the status and the worker**

In `apps/worker/embed.ts`, change the `from` parameter type of `publishBetterSearchStatus` to:

```ts
  from: { configured: true; provider: EmbedProvider; model: string; key: string; label: string; detected?: boolean; probe?: ProbeOutcome } | { configured: false; reason: string; probe?: ProbeOutcome },
```

and add `type ProbeOutcome` to the import from `../../packages/domain/better-search.ts`. The body spreads `from`, so nothing else changes.

In `apps/worker/main.ts`, replace the import `import { embedFromEnv } from "../../packages/providers/embed-env.ts";` with `import { embedSetup } from "../../packages/providers/embed-env.ts";`, and replace lines 502–509 with:

```ts
  // Better search is read from the worker's environment only; with nothing set, a loopback Ollama is probed once for the search model.
  // The published status carries the model key, a label and the probe's outcome, never a credential or anything from the probe's reply.
  const embed = await embedSetup(process.env);
  publishBetterSearchStatus(
    brain,
    embed.config
      ? { configured: true, provider: embed.config.provider, model: embed.config.model, key: embed.key, label: embed.label, detected: embed.detected, probe: embed.probe }
      : { configured: false, reason: embed.reason, probe: embed.probe },
  );
```

(The block is already inside the module's top-level `else`, where `await worker.tick()` runs, so top-level `await` is available.)

- [ ] **Step 7: Teach the fake server `/api/tags`, and keep every other Playwright server away from the owner's Ollama**

In `tests/helpers/fake-embed.mjs`, inside `createServer((req, res) => {`, before `const ollama = …`:

```js
    // Ollama's model listing: the plan 10 startup probe asks for it on loopback. The fake lists only its own model.
    if (req.method === "GET" && req.url === "/api/tags") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ models: [{ name: `${FAKE_EMBED_MODEL}:latest`, model: `${FAKE_EMBED_MODEL}:latest` }] }));
      return;
    }
```

In `playwright.config.ts`, add `BRAIN_EMBED_PROVIDER: "off",` to the `env` of the `port`, `emptyPort`, `todayPort`, `barPort` and `connectionsPort` servers (the five `npm start` entries that do not set `BRAIN_EMBED_PROVIDER`). The sorting server keeps `BRAIN_EMBED_PROVIDER: "ollama"` with the fake endpoint, so its probe hits the fake server and reports `found`.

- [ ] **Step 8: Run the tests**

Run: `npx vitest run tests/integration/ollama-detect.test.ts tests/integration/embed-provider.test.ts tests/integration/better-search-http.test.ts --reporter=dot --maxWorkers=1 && npm run typecheck && npm run lint`
Expected: PASS; typecheck and lint exit 0.

- [ ] **Step 9: Commit**

```bash
git add packages/providers/ollama-detect.ts packages/providers/embed-env.ts packages/domain/better-search.ts apps/worker/embed.ts apps/worker/main.ts tests/helpers/fake-embed.mjs playwright.config.ts tests/integration/ollama-detect.test.ts
git commit -m "feat: probe loopback Ollama for the search model at worker start

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Better search on automatically when detected, off when the owner said so (Opus)

**Files:**
- Modify: `packages/domain/better-search.ts` (`BetterSearchSetting.automatic?`)
- Modify: `packages/domain/service.ts:2047-2052` (`betterSearchSetting`), `:2069-2095` (`betterSearch` response)
- Test: `tests/integration/better-search-auto.test.ts` (new)

**Interfaces:**
- Consumes: `BetterSearchStatus.detected` (Task 1).
- Produces: `BetterSearchSetting.automatic?: boolean`; `Brain.betterSearch(p)` gains `automatic: boolean`, `detected: boolean | null`, `probe: ProbeOutcome | null`. `betterSearchSetting()` returns the automatic setting when no row is stored and the status is a detected Ollama.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/integration/better-search-auto.test.ts
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../../packages/storage/index.ts";
import { Brain } from "../../packages/domain/service.ts";
import { createApp } from "../../apps/server/app.ts";
import { publishBetterSearchStatus } from "../../apps/worker/embed.ts";
import { BETTER_SEARCH, EMBED_VISIBILITIES, modelKey } from "../../packages/domain/better-search.ts";
import { pendingEmbedRows, writeEmbeddings } from "../../packages/storage/recall-vectors.ts";
import { FAKE_EMBED_DIM, FAKE_EMBED_MODEL, fakeEmbed } from "../helpers/fake-embed.mjs";
import type { Principal } from "../../packages/contracts/index.ts";

const owner: Principal = { kind: "owner" };
const KEY = modelKey("ollama", FAKE_EMBED_MODEL);
let cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});
function brainWith(status: { detected: boolean; provider?: "ollama" | "cloudflare"; heartbeat?: boolean } | null) {
  const dir = mkdtempSync(join(tmpdir(), "better-search-auto-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const store = new Storage(join(dir, "brain.sqlite"));
  cleanup.push(() => store.close());
  const brain = new Brain(store);
  if (status) {
    const provider = status.provider ?? "ollama";
    publishBetterSearchStatus(brain, { configured: true, provider, model: FAKE_EMBED_MODEL, key: modelKey(provider, FAKE_EMBED_MODEL), label: provider, detected: status.detected, probe: status.detected ? "found" : "no_ollama" });
    if (status.heartbeat !== false) store.set("worker_heartbeat", brain.now());
  }
  return { store, brain };
}

describe("automatic Better search", () => {
  it("reads an absent choice as on when the worker found Ollama with the model, without writing a row, and queues the backfill", () => {
    const { store, brain } = brainWith({ detected: true });
    expect(brain.betterSearchSetting()).toEqual({ mode: "ollama", key: KEY, consented_at: null, automatic: true });
    expect(brain.betterSearchAllowed()).toMatchObject({ on: true, reason: "ready" });
    expect(store.setting(BETTER_SEARCH, null)).toBeNull();
    const card = brain.betterSearch(owner);
    expect(card).toMatchObject({ mode: "ollama", automatic: true, detected: true, probe: "found", effective: true, consented_at: null });
    brain.capture(owner, { title: "Morning rhythm", body: "The crew sync is at 9 every morning.", visibility: "project", separate: true });
    expect(store.get("SELECT 1 FROM jobs WHERE kind='embed_batch' AND status IN ('queued','retry_wait','running')")).toBeTruthy();
    expect(pendingEmbedRows(store, KEY, EMBED_VISIBILITIES.ollama, 10).length).toBeGreaterThan(0);
  });
  it("stays off when the model was not detected, when the provider is Cloudflare, or when no status exists; a stale heartbeat makes it words only", () => {
    expect(brainWith({ detected: false }).brain.betterSearchSetting().mode).toBe("off");
    expect(brainWith({ detected: true, provider: "cloudflare" }).brain.betterSearchSetting().mode).toBe("off");
    expect(brainWith(null).brain.betterSearchSetting().mode).toBe("off");
    const stale = brainWith({ detected: true, heartbeat: false });
    expect(stale.brain.betterSearchSetting().automatic).toBe(true);
    expect(stale.brain.betterSearchAllowed()).toMatchObject({ on: false, reason: expect.stringMatching(/background worker is not running/u) });
  });
  it("keeps an explicit Off whatever the probe found, and an explicit On keeps the vectors already prepared", () => {
    const { store, brain } = brainWith({ detected: true });
    brain.setBetterSearch(owner, { mode: "off" });
    expect(store.setting(BETTER_SEARCH, null)).toEqual({ mode: "off", key: null, consented_at: null });
    expect(brain.betterSearchSetting()).toEqual({ mode: "off", key: null, consented_at: null });
    expect(brain.betterSearch(owner)).toMatchObject({ mode: "off", automatic: false, detected: true, effective: false });
    // The owner chooses it explicitly: the row is stored with consent, and vectors under the same key are kept.
    store.run("DELETE FROM settings WHERE key=?", BETTER_SEARCH);
    brain.capture(owner, { title: "Morning rhythm", body: "The crew sync is at 9 every morning.", visibility: "project", separate: true });
    const rows = pendingEmbedRows(store, KEY, EMBED_VISIBILITIES.ollama, 32);
    store.transaction(() => writeEmbeddings(store, KEY, FAKE_EMBED_DIM, rows.map((r) => ({ ...r, vector: Float32Array.from(fakeEmbed(r.text)) }))));
    const embedded = () => Number(store.get<{ n: number }>("SELECT count(*) AS n FROM recall_chunks WHERE embedding IS NOT NULL")!.n);
    expect(embedded()).toBeGreaterThan(0);
    const chosen = brain.setBetterSearch(owner, { mode: "ollama" });
    expect(chosen).toMatchObject({ mode: "ollama", key: KEY });
    expect(typeof chosen.consented_at).toBe("string");
    expect(brain.betterSearchSetting().automatic).toBeUndefined();
    expect(embedded()).toBeGreaterThan(0);
  });
  it("serves the automatic state to the paired owner and turns it off on request", async () => {
    const { store, brain } = brainWith({ detected: true });
    const app = await createApp(brain, { pairSecret: "synthetic-auto", static: false });
    cleanup.push(() => app.close());
    const req = (method: any, url: string, payload?: any, headers: Record<string, string> = {}) => app.inject({ method, url, headers: { host: "127.0.0.1:4317", ...headers }, payload });
    const pairing = await req("POST", "/api/v1/session/pair", { secret: "synthetic-auto" });
    const cookie = pairing.cookies[0];
    const headers = { cookie: `${cookie.name}=${cookie.value}`, "x-brain-csrf": pairing.json().csrf };
    expect((await req("GET", "/api/v1/preferences/better-search", undefined, headers)).json()).toMatchObject({ mode: "ollama", automatic: true, detected: true, effective: true });
    expect((await req("PATCH", "/api/v1/preferences/better-search", { mode: "off" }, headers)).statusCode).toBe(200);
    expect(store.setting(BETTER_SEARCH, null)).toEqual({ mode: "off", key: null, consented_at: null });
    expect((await req("GET", "/api/v1/preferences/better-search", undefined, headers)).json()).toMatchObject({ mode: "off", automatic: false, detected: true });
    const token = brain.createGrant(owner, { projects: ["inbox"], operations: ["read"], expires_at: "2027-01-01T00:00:00.000Z" }).token;
    expect((await req("GET", "/api/v1/preferences/better-search", undefined, { authorization: `Bearer ${token}` })).statusCode).toBe(403);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/integration/better-search-auto.test.ts --reporter=dot --maxWorkers=1`
Expected: FAIL on the first `toEqual` (`mode: "off"` instead of the automatic setting).

- [ ] **Step 3: Add the flag and the automatic reading**

In `packages/domain/better-search.ts`, change `BetterSearchSetting` to:

```ts
export type BetterSearchSetting = { mode: BetterSearchMode; key: string | null; consented_at: string | null; /** True only for the reading of an absent row: on because the worker found Ollama with the model on this computer. Never stored. */ automatic?: boolean };
```

In `packages/domain/service.ts`, replace `betterSearchSetting()` (lines 2047–2052) with:

```ts
  /** The stored better-search choice. Its own setting, never a preference field: managed code round-trips `prefs()` into a strict schema. With no row at all, the automatic reading applies. */
  betterSearchSetting(): BetterSearchSetting {
    const raw = this.store.setting<Partial<BetterSearchSetting> | null>(BETTER_SEARCH, null);
    if (raw === null) return this.automaticBetterSearch();
    if (!raw || typeof raw !== "object" || (raw.mode !== "ollama" && raw.mode !== "cloudflare") || typeof raw.key !== "string") return { ...BETTER_SEARCH_OFF };
    return { mode: raw.mode, key: raw.key, consented_at: typeof raw.consented_at === "string" ? raw.consented_at : null };
  }
  /**
   * With no stored choice, Better search is on when the worker found Ollama with the search model on this computer (the probe only ever
   * reaches loopback, so nothing leaves it). Cloudflare is never automatic. A stored Off is the owner's choice and never reaches here.
   */
  private automaticBetterSearch(): BetterSearchSetting {
    if (this.tenantId !== undefined) return { ...BETTER_SEARCH_OFF };
    const status = this.store.setting<BetterSearchStatus | null>(BETTER_SEARCH_STATUS, null);
    if (!status || status.configured !== true || status.provider !== "ollama" || status.detected !== true || typeof status.key !== "string") return { ...BETTER_SEARCH_OFF };
    return { mode: "ollama", key: status.key, consented_at: null, automatic: true };
  }
```

In `betterSearch(p)`, add to the returned object after `consented_at: setting.consented_at,`:

```ts
      automatic: setting.automatic === true,
      detected: status?.detected ?? null,
      probe: status?.probe ?? null,
```

In `setBetterSearch`, inside the transaction, keep `const next: BetterSearchSetting = { mode: v.mode, key, consented_at: this.now() };` as is (it never carries `automatic`), and note that `previous` may be the automatic reading: the existing comparison `previous.mode !== next.mode || previous.key !== next.key` already keeps the vectors when the key is unchanged.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/integration/better-search-auto.test.ts tests/integration/better-search-http.test.ts tests/integration/recall-dense.test.ts tests/integration/embed-batch.test.ts --reporter=dot --maxWorkers=1 && npm run typecheck`
Expected: PASS, including "plan 5 snapshot" (no status is published there, so nothing is automatic).

- [ ] **Step 5: Commit**

```bash
git add packages/domain/better-search.ts packages/domain/service.ts tests/integration/better-search-auto.test.ts
git commit -m "feat: Better search on by default when a local Ollama has the search model

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Settings copy for the automatic state, and the end-to-end journey (Sonnet)

**Files:**
- Modify: `apps/web/better-search-copy.ts` (add `AUTOMATIC_NOTICE`, `DETECTED_HINT`, `plainProbe`; extend `known`)
- Modify: `apps/web/src.tsx:104-126` (type and status line), `:1499-1550` (card)
- Modify: `tests/integration/better-search-copy.test.ts` (new cases)
- Modify: `tests/e2e/better-search.spec.ts`
- Modify: `docs/UX.md:112`

**Interfaces:**
- Consumes: `automatic`, `detected`, `probe` on the GET reply (Task 2).
- Produces: `plainProbe(probe) -> string | null`, `AUTOMATIC_NOTICE`, `DETECTED_HINT`.

- [ ] **Step 1: Write the failing copy tests**

Append to `tests/integration/better-search-copy.test.ts` (add `AUTOMATIC_NOTICE, DETECTED_HINT, plainProbe` to the import from `../../apps/web/better-search-copy.ts` and `EMBED_OFF_BY_SETUP, PROBE_REASONS` to the import from `../../packages/domain/better-search.ts`):

```ts
describe("automatic Better search copy", () => {
  it("names Ollama only in the one setup instruction the owner has to type, and never a status code", () => {
    expect(plainProbe("no_ollama")).toBe("Ollama was not found on this computer when BiBrain started. Install Ollama, run `ollama pull bge-m3`, and restart BiBrain.");
    expect(plainProbe("no_model")).toBe("Ollama is running on this computer, but its search model is not pulled. Run `ollama pull bge-m3` and restart BiBrain.");
    expect(plainProbe("found")).toBeNull();
    expect(plainProbe("skipped")).toBeNull();
    expect(plainProbe(null)).toBeNull();
    for (const s of [AUTOMATIC_NOTICE, DETECTED_HINT]) {
      expect(s).not.toMatch(/bge|model name|BRAIN_|\b\d{3}\b|token|mcp/i);
      expect(s).toMatch(/this computer/u);
    }
    expect(AUTOMATIC_NOTICE).toContain("Nothing leaves your computer.");
    // The worker's probe sentences and the off-by-setup sentence map to the closed setup line, never to the generic one.
    expect(plainSearchReason(PROBE_REASONS.no_ollama)).toBe(SETUP);
    expect(plainSearchReason(PROBE_REASONS.no_model)).toBe(SETUP);
    expect(plainSearchReason(EMBED_OFF_BY_SETUP)).toBe(SETUP);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/integration/better-search-copy.test.ts --reporter=dot --maxWorkers=1`
Expected: FAIL, `plainProbe` is not exported.

- [ ] **Step 3: Write the copy**

In `apps/web/better-search-copy.ts`, add to `known` before the `not set up on this computer|…` line:

```ts
  if (/was not found on this computer|search model is not pulled|turned off by this computer's setup/i.test(text)) return "Better search is not set up correctly on this computer. See Providers in the docs.";
```

and append:

```ts
/** Shown once under the card while Better search is on by itself. */
export const AUTOMATIC_NOTICE = "BiBrain found a search model running in Ollama on this computer, so search by meaning is on. Nothing leaves your computer. Choose Off below to turn it off; it then stays off until you choose it again.";
/** Shown while the owner's choice is Off and the probe found the model. */
export const DETECTED_HINT = "A search model is running in Ollama on this computer. Choose On this computer to use it.";
/** The one place the model's name is allowed on the card: the instruction the owner has to type. Null when there is nothing to do. */
export function plainProbe(probe: string | null | undefined): string | null {
  if (probe === "no_ollama") return "Ollama was not found on this computer when BiBrain started. Install Ollama, run `ollama pull bge-m3`, and restart BiBrain.";
  if (probe === "no_model") return "Ollama is running on this computer, but its search model is not pulled. Run `ollama pull bge-m3` and restart BiBrain.";
  return null;
}
```

- [ ] **Step 4: Show it on the card**

In `apps/web/src.tsx`:

1. Extend the `BetterSearch` type (line 104) with `automatic: boolean; detected: boolean | null; probe: "found" | "no_ollama" | "no_model" | "skipped" | null;`.
2. In `betterSearchLine`, change the two `On ·` returns to use `const on = b.automatic ? "On (this computer)" : "On";` and return `` `${on} · ${label} · ${ready}; preparing the rest in the background` `` / `` `${on} · ${label} · ${ready}` ``.
3. Import `AUTOMATIC_NOTICE, DETECTED_HINT, plainProbe` from `./better-search-copy.ts`.
4. Under `<p className="status" role="status">{betterSearchLine(better)}</p>` add:

```tsx
                  {better.automatic ? <p className="muted">{AUTOMATIC_NOTICE}</p> : null}
                  {better.mode === "off" && better.detected === true ? <p className="muted">{DETECTED_HINT}</p> : null}
                  {better.mode === "off" && plainProbe(better.probe) ? <p className="muted">Last check: {plainProbe(better.probe)}</p> : null}
```

- [ ] **Step 5: Rewrite the end-to-end journey for the automatic state**

Replace the body of the one test in `tests/e2e/better-search.spec.ts` (keep `open`, `card`, `search`) with:

```ts
test("Better search is on by itself with a local model, turns off on request, and comes back when chosen", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Settings & privacy" }).click();
  await expect(card(page)).toBeVisible();
  // The worker's probe found the fake model on loopback, so the card opens on, labelled as automatic, with the notice.
  await expect(card(page).getByRole("status")).toHaveText(/^On \(this computer\) · Ollama on this computer · \d+ of \d+ passages ready/, { timeout: 20000 });
  await expect(card(page).getByText("BiBrain found a search model running in Ollama on this computer")).toBeVisible();
  await expect(card(page).getByRole("radio", { name: /^Cloudflare\./ })).toBeDisabled();

  await page.getByRole("button", { name: "Today", exact: true }).click();
  await page.getByLabel("Save to your brain").fill("The crew sync is at 9 every morning.");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText(/kept exactly as you wrote it/i)).toBeVisible();
  await expect(async () => {
    await search(page, "when does the stand-up happen");
    await expect(page.getByText(/The crew sync is at 9 every morning/).first()).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 45_000, intervals: [1000, 2000] });

  // One switch: Off is stored as the owner's choice and stays off.
  await page.getByRole("button", { name: "Settings & privacy" }).click();
  await card(page).getByRole("radio", { name: /^Off\./ }).check();
  await card(page).getByRole("button", { name: "Save better search" }).click();
  await expect(page.getByText("Better search is off.")).toBeVisible();
  await expect(card(page).getByRole("status")).toHaveText("Off. Search matches the words you used.");
  await expect(card(page).getByText("A search model is running in Ollama on this computer. Choose On this computer to use it.")).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Settings & privacy" }).click();
  await expect(card(page).getByRole("status")).toHaveText("Off. Search matches the words you used.");
  await search(page, "when does the stand-up happen");
  await expect(page.getByText(/The crew sync is at 9 every morning/)).toHaveCount(0, { timeout: 5000 });

  // Chosen by hand: on again, without the automatic label.
  await page.getByRole("button", { name: "Settings & privacy" }).click();
  await card(page).getByRole("radio", { name: /^On this computer \(Ollama\)\. Nothing leaves this computer\./ }).check();
  await card(page).getByRole("button", { name: "Save better search" }).click();
  await expect(page.getByText("Better search saved. Your notes are being prepared in the background.")).toBeVisible();
  await expect(card(page).getByRole("status")).toHaveText(/^On · Ollama on this computer · \d+ of \d+ passages ready/);
  await expect(card(page).getByText("BiBrain found a search model running in Ollama on this computer")).toHaveCount(0);
});
```

- [ ] **Step 6: Update the UX note**

In `docs/UX.md` line 112, after "Hidden in managed mode.", append: ` When BiBrain's background worker found Ollama with the search model on this computer and no choice is stored, the card opens on by itself: the status reads "On (this computer) · Ollama on this computer · N of M passages ready" and a paragraph says that BiBrain found a search model running in Ollama on this computer, that nothing leaves the computer, and that choosing Off turns it off and keeps it off. With Off stored and the model present, a muted hint offers "On this computer". When the probe found nothing, "Last check: …" gives the one-line setup instruction.`

- [ ] **Step 7: Run the gates for this task**

Run: `npx vitest run tests/integration/better-search-copy.test.ts --reporter=dot --maxWorkers=1 && npm run typecheck && npm run lint && npm run build`
Expected: PASS; all exit 0.

Then, alone: `npx playwright test --project=system1 --workers=1; git restore docs/screenshots`
Expected: the Better search and sorting-help specs pass (6 tests).

- [ ] **Step 8: Commit**

```bash
git add apps/web/better-search-copy.ts apps/web/src.tsx tests/integration/better-search-copy.test.ts tests/e2e/better-search.spec.ts docs/UX.md
git commit -m "feat: Settings shows Better search on (this computer) with one switch to turn it off

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: "Meaning matches can lead": the rule, the setting, the routes, the push (Opus)

**Files:**
- Modify: `packages/domain/better-search.ts` (`MEANING_LEAD*`, `MeaningLead`, `meaningLeadInputSchema`)
- Modify: `packages/domain/recall-push.ts` (`MeaningTop`, `meaningLead`)
- Modify: `packages/domain/service.ts` (`meaningLeadSetting`, `meaningLeadThreshold`, `meaningLead`, `setMeaningLead`, `clearMeaningLead`; `recallInternal` gains `denseScores`; `recallPush` applies the rule and logs `lead`)
- Modify: `apps/server/app.ts:897-898` (three routes after the better-search ones)
- Test: `tests/integration/meaning-lead.test.ts` (new)

**Interfaces:**
- Consumes: `betterSearchAllowed()` (unchanged), `denseFloor(key)`, `isUnreviewedAgent`, `hitKey` (module-level in `service.ts`).
- Produces: `MEANING_LEAD = "meaning_lead"`, `MEANING_LEAD_MIN_SAMPLE = 20`, `MEANING_LEAD_MAX = 0.99`, `MEANING_LEAD_SOURCES = ["proof:search", "calibrate"]`, `type MeaningLead = { threshold; key; sample; source; measured_at; applied_at }`; `meaningLead(level, top: MeaningTop | null, threshold: number | null) -> PushLevel` with `MeaningTop = { denseOnly: boolean; cosine: number | null; unreviewed: boolean }`; `Brain.meaningLeadSetting() -> MeaningLead | null`, `Brain.meaningLeadThreshold() -> number | null`, `Brain.meaningLead(p) -> { lead: MeaningLead | null; effective: number | null; reason: string }`, `Brain.setMeaningLead(p, input) -> MeaningLead`, `Brain.clearMeaningLead(p) -> { lead: null }`; `recallInternal(...)` returns `denseScores: Map<string, number>` keyed by `hitKey`; log rows carry `lead: true` only when the rule raised the level.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/integration/meaning-lead.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../apps/server/app.ts";
import { publishBetterSearchStatus } from "../../apps/worker/embed.ts";
import { MEANING_LEAD, MEANING_LEAD_MIN_SAMPLE, modelKey, type MeaningLead } from "../../packages/domain/better-search.ts";
import { meaningLead } from "../../packages/domain/recall-push.ts";
import { MIN_SAMPLE } from "../../packages/domain/calibration.ts";
import { buildFixture, owner, type Fixture } from "../eval/recall-fixture.ts";
import { embedFixture } from "../eval/dense-fixture.ts";
import { FAKE_EMBED_MODEL } from "../helpers/fake-embed.mjs";

let cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});
/** The embedded fixture with the query vector answered in-process, so recallPush runs the dense list without a worker. */
function dense() {
  const dir = mkdtempSync(join(tmpdir(), "meaning-lead-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const fx: Fixture = buildFixture(join(dir, "brain.sqlite"));
  cleanup.push(() => fx.store.close());
  const e = embedFixture(fx);
  vi.spyOn(fx.brain, "queryVector").mockImplementation(async (_p, q) => e.dense(q));
  return { fx, ...e };
}
const PARAPHRASE = "which hue was chosen for the release";
const push = (fx: Fixture, prompt: string, session = "e".repeat(64)) => fx.brain.recallPush(fx.agent, { prompt, session_id: session, first_prompt: false, seen: [] });
const lastLog = (fx: Fixture) => fx.brain.recallLog(owner).rows.at(-1)!;

describe("the meaning-lead rule", () => {
  it("raises only a dense-only, reviewed, leading hit at or above a set threshold, and nothing while unset", () => {
    const top = { denseOnly: true, cosine: 0.7, unreviewed: false };
    expect(meaningLead("none", top, null)).toBe("none");
    expect(meaningLead("pointer", top, null)).toBe("pointer");
    expect(meaningLead("none", top, 0.7)).toBe("full");
    expect(meaningLead("pointer", top, 0.6)).toBe("full");
    expect(meaningLead("none", top, 0.71)).toBe("none");
    expect(meaningLead("full", { ...top, cosine: 0.1 }, 0.6)).toBe("full");
    expect(meaningLead("none", null, 0.6)).toBe("none");
    expect(meaningLead("none", { ...top, denseOnly: false }, 0.6)).toBe("none");
    expect(meaningLead("pointer", { ...top, unreviewed: true }, 0.6)).toBe("pointer");
    expect(meaningLead("none", { ...top, cosine: null }, 0.6)).toBe("none");
    expect(MEANING_LEAD_MIN_SAMPLE).toBe(MIN_SAMPLE);
  });
  it("lets a paraphrase found by meaning alone lead a full push only after the owner applied a threshold it reaches", async () => {
    const { fx, dense: vec } = dense();
    const before = await push(fx, PARAPHRASE);
    expect(before.level).toBe("none");
    expect(lastLog(fx)).toMatchObject({ dense: true, level: "none" });
    expect(lastLog(fx)).not.toHaveProperty("lead");
    const internal = fx.brain.recallInternal(fx.agent, { query: PARAPHRASE, history: false, limit: 6 }, vec(PARAPHRASE));
    const top = internal.denseTop!;
    expect(top).toBeGreaterThanOrEqual(0.45);
    expect(internal.denseScores.size).toBeGreaterThan(0);
    const reach = Math.floor(top * 100) / 100;
    const applied = fx.brain.setMeaningLead(owner, { threshold: reach, sample: 54, source: "proof:search", measured_at: "2026-10-25" });
    expect(applied).toMatchObject({ threshold: reach, key: modelKey("ollama", FAKE_EMBED_MODEL), sample: 54, source: "proof:search", measured_at: "2026-10-25" });
    expect(fx.brain.meaningLeadThreshold()).toBe(reach);
    const after = await push(fx, PARAPHRASE, "f".repeat(64));
    expect(after.level).toBe("full");
    expect(after.hit_ids[0]).toBe(fx.ids["fact:launch-color"]);
    expect(after.text).toContain("Launch color: cobalt");
    expect(lastLog(fx)).toMatchObject({ dense: true, level: "full", lead: true });
    // Above the hit's score: today's behaviour again, and no lead field on the row.
    fx.brain.setMeaningLead(owner, { threshold: Math.min(0.99, Math.ceil(top * 100) / 100 + 0.01), sample: 54, source: "calibrate", measured_at: "2026-10-25" });
    const over = await push(fx, PARAPHRASE, "a".repeat(64));
    expect(over.level).toBe("none");
    expect(lastLog(fx)).not.toHaveProperty("lead");
    // A word match is never counted as a meaning lead.
    fx.brain.setMeaningLead(owner, { threshold: reach, sample: 54, source: "proof:search", measured_at: "2026-10-25" });
    const words = await push(fx, "launch color", "b".repeat(64));
    expect(words.level).toBe("full");
    expect(lastLog(fx)).not.toHaveProperty("lead");
  });
  it("never lets an unreviewed agent-written note lead, with the threshold set", async () => {
    const { fx } = dense();
    fx.brain.setMeaningLead(owner, { threshold: 0.45, sample: 20, source: "proof:search", measured_at: "2026-10-25" });
    const writer = fx.brain.createGrant(owner, { projects: [fx.ids["project:northstar"]], operations: ["read", "propose_memory"], expires_at: "2027-01-01T00:00:00.000Z", client: "codex" });
    const writerP = fx.brain.authenticateAgent(writer.token);
    // Only this agent note carries the standup/team concepts in Tamil; the fake embedder maps the English paraphrase onto it.
    fx.brain.sessionNote(writerP, { session_id: "9".repeat(64), client: "codex", text: "Decided: குழு சந்திப்பு: வியாழன் காலை" });
    // Re-embed what the note added, then ask by meaning only.
    const { embedFixture: embedAgain } = await import("../eval/dense-fixture.ts");
    embedAgain(fx);
    const r = await push(fx, "when does the squad huddle on thursday", "c".repeat(64));
    expect(r.level).not.toBe("full");
    expect(r.text).not.toContain("வியாழன்");
    expect(lastLog(fx)).not.toHaveProperty("lead");
  });
  it("is bound to the model key it was measured with, and refuses bad input and the wrong caller", async () => {
    const { fx } = dense();
    const app = await createApp(fx.brain, { pairSecret: "synthetic-lead", static: false });
    cleanup.push(() => app.close());
    const req = (method: any, url: string, payload?: any, headers: Record<string, string> = {}) => app.inject({ method, url, headers: { host: "127.0.0.1:4317", ...headers }, payload });
    const pairing = await req("POST", "/api/v1/session/pair", { secret: "synthetic-lead" });
    const cookie = pairing.cookies[0];
    const headers = { cookie: `${cookie.name}=${cookie.value}`, "x-brain-csrf": pairing.json().csrf };
    expect((await req("GET", "/api/v1/preferences/meaning-lead")).statusCode).toBe(401);
    expect((await req("GET", "/api/v1/preferences/meaning-lead", undefined, headers)).json()).toEqual({ lead: null, effective: null, reason: "Not yet calibrated." });
    const good = { threshold: 0.6, sample: 20, source: "proof:search", measured_at: "2026-10-25" };
    for (const bad of [{ ...good, threshold: 0.44 }, { ...good, threshold: 1 }, { ...good, sample: 19 }, { ...good, source: "guess" }, { ...good, measured_at: "2026-10-26" }, { ...good, measured_at: "yesterday" }, { ...good, extra: 1 }])
      expect((await req("PATCH", "/api/v1/preferences/meaning-lead", bad, headers)).statusCode, JSON.stringify(bad)).toBe(400);
    expect(fx.store.setting(MEANING_LEAD, null)).toBeNull();
    expect((await req("PATCH", "/api/v1/preferences/meaning-lead", good, { cookie: headers.cookie })).statusCode).toBe(403);
    expect((await req("PATCH", "/api/v1/preferences/meaning-lead", good, { authorization: `Bearer ${fx.agentToken}` })).statusCode).toBe(403);
    expect((await req("GET", "/api/v1/preferences/meaning-lead", undefined, { authorization: `Bearer ${fx.agentToken}` })).statusCode).toBe(403);
    const set = await req("PATCH", "/api/v1/preferences/meaning-lead", { ...good, threshold: 0.604 }, headers);
    expect(set.statusCode).toBe(200);
    expect(set.json()).toMatchObject({ threshold: 0.6, key: modelKey("ollama", FAKE_EMBED_MODEL), sample: 20, source: "proof:search", measured_at: "2026-10-25", applied_at: "2026-10-25T09:00:00.000Z" });
    expect((await req("GET", "/api/v1/preferences/meaning-lead", undefined, headers)).json()).toMatchObject({ effective: 0.6, reason: "ready" });
    // The worker's model changes: the line is kept but never leads, and Settings says to measure again.
    publishBetterSearchStatus(fx.brain, { configured: true, provider: "ollama", model: "other-model", key: modelKey("ollama", "other-model"), label: "Ollama on this computer", detected: true, probe: "found" });
    fx.store.set("worker_heartbeat", fx.brain.now());
    fx.brain.setBetterSearch(owner, { mode: "ollama" });
    expect(fx.brain.meaningLeadThreshold()).toBeNull();
    expect((await req("GET", "/api/v1/preferences/meaning-lead", undefined, headers)).json()).toMatchObject({ effective: null, reason: "Measured for another search model. Measure again." });
    expect((await req("DELETE", "/api/v1/preferences/meaning-lead", undefined, headers)).json()).toEqual({ lead: null });
    expect(fx.store.setting<MeaningLead | null>(MEANING_LEAD, null)).toBeNull();
    // With Better search off there is nothing to measure against.
    fx.brain.setBetterSearch(owner, { mode: "off" });
    expect((await req("PATCH", "/api/v1/preferences/meaning-lead", good, headers)).statusCode).toBe(409);
    expect((await req("GET", "/api/v1/preferences/meaning-lead", undefined, headers)).json()).toMatchObject({ effective: null, reason: "Turn Better search on first." });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/integration/meaning-lead.test.ts --reporter=dot --maxWorkers=1`
Expected: FAIL, `meaningLead` and `MEANING_LEAD` are not exported.

- [ ] **Step 3: The constants, the type and the schema**

In `packages/domain/better-search.ts`, add `import { z } from "zod";` at the top and append:

```ts
/** The owner-applied "meaning matches can lead" line (plan 10). Unset by default; set only by the owner from a measured suggestion; bound to the model key it was measured for. */
export const MEANING_LEAD = "meaning_lead";
export const MEANING_LEAD_MIN_SAMPLE = 20;
export const MEANING_LEAD_MAX = 0.99;
export const MEANING_LEAD_SOURCES = ["proof:search", "calibrate"] as const;
export type MeaningLeadSource = (typeof MEANING_LEAD_SOURCES)[number];
export type MeaningLead = { threshold: number; key: string; sample: number; source: MeaningLeadSource; measured_at: string; applied_at: string };
export const meaningLeadInputSchema = z
  .object({
    threshold: z.number().finite(),
    sample: z.number().int().min(MEANING_LEAD_MIN_SAMPLE),
    source: z.enum(MEANING_LEAD_SOURCES),
    measured_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  })
  .strict();
```

- [ ] **Step 4: The pure rule**

Append to `packages/domain/recall-push.ts`:

```ts
export type MeaningTop = { denseOnly: boolean; cosine: number | null; unreviewed: boolean };
/**
 * Meaning matches can lead (plan 10). Runs after every other rule on the hit that leads the push: with the owner-applied threshold set,
 * a hit found by meaning alone whose cosine reaches it makes the push full. With no threshold, or a hit found by words, or an
 * unreviewed agent note, or no cosine, the level is returned unchanged, so an unset line is exactly plan 5b's behaviour.
 */
export function meaningLead(level: PushLevel, top: MeaningTop | null, threshold: number | null): PushLevel {
  if (threshold === null || level === "full" || !top || !top.denseOnly || top.unreviewed || top.cosine === null) return level;
  return top.cosine >= threshold ? "full" : level;
}
```

- [ ] **Step 5: The setting in the domain**

In `packages/domain/service.ts`, add `MEANING_LEAD, MEANING_LEAD_MAX, MEANING_LEAD_SOURCES, meaningLeadInputSchema, type MeaningLead, type MeaningLeadSource` to the import from `./better-search.ts` and `meaningLead` to the import from `./recall-push.ts`. After `embedQueueOpen()` add:

```ts
  /** The stored "meaning matches can lead" line with its provenance, or null. Shape-checked on read; a malformed row reads as unset. */
  meaningLeadSetting(): MeaningLead | null {
    const raw = this.store.setting<Partial<MeaningLead> | null>(MEANING_LEAD, null);
    if (!raw || typeof raw !== "object" || typeof raw.threshold !== "number" || !Number.isFinite(raw.threshold) || typeof raw.key !== "string" || typeof raw.sample !== "number") return null;
    if (!MEANING_LEAD_SOURCES.includes(raw.source as MeaningLeadSource) || typeof raw.measured_at !== "string" || typeof raw.applied_at !== "string") return null;
    return { threshold: raw.threshold, key: raw.key, sample: raw.sample, source: raw.source as MeaningLeadSource, measured_at: raw.measured_at, applied_at: raw.applied_at };
  }
  /** The threshold a push may use right now: only while Better search is effective and the line was measured for the current model key. */
  meaningLeadThreshold(): number | null {
    const lead = this.meaningLeadSetting();
    if (!lead) return null;
    const allowed = this.betterSearchAllowed();
    return allowed.on && allowed.setting.key === lead.key ? lead.threshold : null;
  }
  /** What the Settings line reads: the stored line, whether it applies now, and one plain reason when it does not. */
  meaningLead(p: Principal): { lead: MeaningLead | null; effective: number | null; reason: string } {
    this.owner(p);
    const lead = this.meaningLeadSetting();
    const allowed = this.betterSearchAllowed();
    if (!allowed.on) return { lead, effective: null, reason: "Turn Better search on first." };
    if (!lead) return { lead: null, effective: null, reason: "Not yet calibrated." };
    if (lead.key !== allowed.setting.key) return { lead, effective: null, reason: "Measured for another search model. Measure again." };
    return { lead, effective: lead.threshold, reason: "ready" };
  }
  /** The one owner action that sets the line. The key and the applied time come from the server, never from the caller. */
  setMeaningLead(p: Principal, input: unknown): MeaningLead {
    this.owner(p);
    const v = meaningLeadInputSchema.parse(input);
    if (this.tenantId !== undefined) throw new BrainError("BUDGET_BLOCKED", "Better search runs on the local app only.", 409);
    const allowed = this.betterSearchAllowed();
    if (!allowed.on || !allowed.setting.key) throw new BrainError("BUDGET_BLOCKED", "Turn Better search on first.", 409);
    const key = allowed.setting.key;
    const floor = denseFloor(key);
    const threshold = Number(v.threshold.toFixed(2));
    if (threshold < floor || threshold > MEANING_LEAD_MAX) throw new BrainError("INVALID_INPUT", `The value must be between ${floor} (the floor for this search model) and ${MEANING_LEAD_MAX}.`, 400);
    const today = this.now().slice(0, 10);
    if (Number.isNaN(Date.parse(`${v.measured_at}T00:00:00.000Z`)) || v.measured_at > today) throw new BrainError("INVALID_INPUT", "The measured date must be a real date and not in the future.", 400);
    const lead: MeaningLead = { threshold, key, sample: v.sample, source: v.source, measured_at: v.measured_at, applied_at: this.now() };
    this.store.set(MEANING_LEAD, lead);
    return lead;
  }
  clearMeaningLead(p: Principal): { lead: null } {
    this.owner(p);
    this.store.run("DELETE FROM settings WHERE key=?", MEANING_LEAD);
    return { lead: null };
  }
```

(`denseFloor` is already imported in `service.ts` for the dense list.)

- [ ] **Step 6: The cosine per dense-only hit, and the rule in the push**

In `recallInternal`:
- In the early `if (!fts.match) return { … }` add `denseScores: new Map<string, number>()`.
- Before the `for (const candidate of fused)` loop add `const denseScores = new Map<string, number>();`.
- In both `authorized.push({ candidate, hit: … })` branches, immediately after the push, add: `if (!fromBm25(candidate)) denseScores.set(hitKey(authorized[authorized.length - 1].hit), candidate.row.score);` (for a dense-only key `fuse` keeps the dense row, whose `score` is the cosine).
- Add `denseScores` to the final `return { … }`.

In `recallPush`, after the block `if (level === "full" && hits.length < judge.hits.length) { … }` and before `if (level === "full" && !hits.length) …`, add:

```ts
    // Meaning matches can lead (plan 10): only with the owner-applied line, only for the hit that leads, after every rule above. R5.
    let led = false;
    const leadLine = this.meaningLeadThreshold();
    if (leadLine !== null && level !== "full" && hits.length) {
      const key = hitKey(hits[0]);
      const raised = meaningLead(level, { denseOnly: internal.denseOnly.has(key), cosine: internal.denseScores.get(key) ?? null, unreviewed: isUnreviewedAgent(hits[0]) }, leadLine);
      led = raised !== level;
      level = raised;
    }
```

Extend the `finish` extra type with `lead?: boolean` and add `...(extra.lead ? { lead: true } : {}),` to the log row after the `judge` spread. Pass `lead: led` in the final `finish(...)` call and in the secret-quietened call before it (`lead: led` there too, since the level was computed; the quiet row records `none`, and `led` is then false in practice because the text was dropped, so pass `lead: false` on that line to keep the row plain).

- [ ] **Step 7: The routes**

In `apps/server/app.ts`, after the two better-search routes (line 898):

```ts
  // Meaning matches can lead: an owner-applied line with its provenance, bound to the search model it was measured for. Never set by a tool or an agent.
  app.get("/api/v1/preferences/meaning-lead", (req) => req.brain.meaningLead(req.principal));
  app.patch("/api/v1/preferences/meaning-lead", (req) => req.brain.setMeaningLead(req.principal, req.body));
  app.delete("/api/v1/preferences/meaning-lead", (req) => req.brain.clearMeaningLead(req.principal));
```

- [ ] **Step 8: Run the tests and the snapshot**

Run: `npx vitest run tests/integration/meaning-lead.test.ts tests/integration/recall-dense.test.ts tests/integration/recall-push.test.ts tests/integration/recall-judge.test.ts tests/eval/recall.test.ts --reporter=dot --maxWorkers=1 && npm run typecheck && npm run lint`
Expected: PASS, "plan 5 snapshot" included (no `meaning_lead` row exists there, so `leadLine` is null and no row gains a field). If the agent-note case cannot be made dense-only with the lexicon as written, adjust the note's words and the prompt to a pair the lexicon joins (for example a note with "deployment hotfix" and a prompt "the patch went out") rather than loosening the assertion.

- [ ] **Step 9: Commit**

```bash
git add packages/domain/better-search.ts packages/domain/recall-push.ts packages/domain/service.ts apps/server/app.ts tests/integration/meaning-lead.test.ts
git commit -m "feat: meaning matches can lead a push once the owner applies a measured threshold

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The suggested threshold in `proof:search` and `calibrate` (Sonnet)

**Files:**
- Modify: `packages/domain/calibration.ts` (`suggestMeaningLead`, `meaningLeadFromLog`, report fields, render)
- Modify: `scripts/better-search-proof.ts:147-150` (print the suggestion)
- Modify: `scripts/calibrate.ts:52-57` (read `meaning_lead`, pass it)
- Modify: `tests/integration/calibration-report.test.ts` (new cases)

**Interfaces:**
- Produces: `suggestMeaningLead({ highestNegative, lowestWanted, floor, sample }) -> Suggestion`, `meaningLeadFromLog(rows, floor, current) -> Suggestion`, `Suggestion.current: number | null`, `CalibrationInput.meaning_lead?: MeaningLead | null`, `CalibrationReport.recall.meaning_lead: MeaningLead | null`, the id `search.meaning_lead`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/integration/calibration-report.test.ts` (add `meaningLeadFromLog, suggestMeaningLead` to the calibration import, and `import type { MeaningLead } from "../../packages/domain/better-search.ts";`):

```ts
describe("meaning-lead suggestions", () => {
  it("from the proof: 0.05 above the loudest no-answer cosine, only when every wanted hit still qualifies and the floor is kept", () => {
    expect(suggestMeaningLead({ highestNegative: 0.58, lowestWanted: 0.71, floor: 0.45, sample: 54 })).toMatchObject({ threshold: "search.meaning_lead", current: null, suggested: 0.63, sample: 54 });
    expect(suggestMeaningLead({ highestNegative: 0.3, lowestWanted: 0.71, floor: 0.45, sample: 54 }).suggested).toBe(0.45);
    const overlap = suggestMeaningLead({ highestNegative: 0.7, lowestWanted: 0.71, floor: 0.45, sample: 54 });
    expect(overlap.suggested).toBeNull();
    expect(overlap.reason).toMatch(/no safe value/u);
    expect(suggestMeaningLead({ highestNegative: 0.58, lowestWanted: 0.71, floor: 0.45, sample: 19 })).toMatchObject({ suggested: null, reason: expect.stringMatching(/Not enough data yet/u) });
    expect(suggestMeaningLead({ highestNegative: -1, lowestWanted: 1, floor: 0.45, sample: 54 }).suggested).toBe(0.45);
  });
  it("from the log: the 90th percentile of none-level top cosines plus 0.05, with at least 20 rows on each side and no overlap with full pushes", () => {
    const none = Array.from({ length: 25 }, (_, i) => row({ dense: true, dense_top: 0.46 + (i % 10) * 0.01, level: "none" }));
    const full = Array.from({ length: 25 }, (_, i) => row({ dense: true, dense_top: 0.7 + (i % 10) * 0.01, level: "full" }));
    const s = meaningLeadFromLog([...none, ...full, row({ level: "pointer" })], 0.45, null);
    expect(s).toMatchObject({ threshold: "search.meaning_lead", current: null, suggested: 0.6, sample: 50 });
    expect(meaningLeadFromLog([...none.slice(0, 19), ...full], 0.45, null)).toMatchObject({ suggested: null, reason: expect.stringMatching(/Not enough data yet/u) });
    const overlapping = Array.from({ length: 25 }, (_, i) => row({ dense: true, dense_top: 0.5 + (i % 10) * 0.01, level: "full" }));
    expect(meaningLeadFromLog([...none, ...overlapping], 0.45, 0.6)).toMatchObject({ current: 0.6, suggested: null, reason: expect.stringMatching(/overlap/u) });
  });
  it("prints the applied line with its provenance, or not set, and lists the log suggestion as a suggestion only", () => {
    const lead: MeaningLead = { threshold: 0.63, key: "ollama:bge-m3:none", sample: 54, source: "proof:search", measured_at: "2026-11-06", applied_at: "2026-11-07T09:12:00.000Z" };
    const text = renderCalibration(calibrationReport({ ...empty, meaning_lead: lead }));
    expect(text).toContain("Meaning matches can lead: 0.63, applied 2026-11-07 from proof:search (54 queries measured 2026-11-06, model ollama:bge-m3:none).");
    expect(text).toMatch(/search\.meaning_lead = 0\.63: hold\. Not enough data yet/u);
    expect(text).toContain("Each is weaker evidence than npm run proof:search");
    const unset = renderCalibration(calibrationReport(empty));
    expect(unset).toContain("Meaning matches can lead: not set (a match found by meaning alone never leads a push).");
    expect(unset).toMatch(/search\.meaning_lead = unset: hold\./u);
    expect(calibrationReport(empty).recall.meaning_lead).toBeNull();
  });
});
```

Also extend the existing spawn test of `scripts/calibrate.ts` (the one that writes a synthetic brain and runs the script): after it asserts the report, set `store.set("meaning_lead", lead)` with the object above on the synthetic brain before the run, and assert the printed text contains `Meaning matches can lead: 0.63, applied 2026-11-07`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/integration/calibration-report.test.ts --reporter=dot --maxWorkers=1`
Expected: FAIL, `suggestMeaningLead` is not exported.

- [ ] **Step 3: The pure arithmetic and the report fields**

In `packages/domain/calibration.ts`:

1. Import `type MeaningLead` from `./better-search.ts` (beside `DENSE_FLOORS, DENSE_WEIGHT`).
2. Change `Suggestion` to `{ threshold: string; current: number | null; suggested: number | null; sample: number; reason: string }`.
3. Add `meaning_lead?: MeaningLead | null` to `CalibrationInput`, and `meaning_lead: MeaningLead | null` to `CalibrationReport["recall"]`.
4. Add after `fileSuggestion`:

```ts
const round2 = (x: number) => Number(x.toFixed(2));
const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
const LEAD = "search.meaning_lead";
/** From npm run proof:search: 0.05 above the loudest no-answer cosine, never under the floor, only while every wanted hit still reaches it. */
export function suggestMeaningLead(input: { highestNegative: number; lowestWanted: number; floor: number; sample: number }): Suggestion {
  const { sample } = input;
  if (sample < MIN_SAMPLE) return { threshold: LEAD, current: null, suggested: null, sample, reason: `Not enough data yet (${sample} of ${MIN_SAMPLE} queries scanned).` };
  const candidate = round2(Math.max(input.floor, input.highestNegative + 0.05));
  if (candidate > input.lowestWanted) return { threshold: LEAD, current: null, suggested: null, sample, reason: `no safe value: the highest no-answer cosine (${round2(input.highestNegative)}) plus 0.05 is above the lowest wanted hit (${round2(input.lowestWanted)}), so no line keeps every wanted hit while refusing every no-answer query.` };
  return { threshold: LEAD, current: null, suggested: candidate, sample, reason: `The highest cosine of a no-answer query was ${round2(input.highestNegative)}; 0.05 above it (and at least the floor ${input.floor}) every wanted hit (lowest ${round2(input.lowestWanted)}) still qualifies.` };
}
/** From the recall log: pushes that used Better search, split by level. No ground truth: the report says so. */
export function meaningLeadFromLog(rows: RecallLogRow[], floor: number, current: number | null): Suggestion {
  const tops = (level: PushLevel) => rows.filter((r) => r?.dense && typeof r.dense_top === "number" && Number.isFinite(r.dense_top) && r.level === level).map((r) => r.dense_top as number).sort((a, b) => a - b);
  const none = tops("none");
  const full = tops("full");
  const sample = none.length + full.length;
  if (none.length < MIN_SAMPLE || full.length < MIN_SAMPLE) return { threshold: LEAD, current, suggested: null, sample, reason: `Not enough data yet (${none.length} quiet and ${full.length} full pushes with a top cosine; ${MIN_SAMPLE} of each are needed).` };
  const candidate = round2(Math.max(floor, percentile(none, 0.9) + 0.05));
  const median = percentile(full, 0.5);
  if (candidate >= median) return { threshold: LEAD, current, suggested: null, sample, reason: `The top cosines of quiet and full pushes overlap (90th percentile of quiet ${round2(percentile(none, 0.9))}, median of full ${round2(median)}), so the log cannot separate them; the line holds.` };
  return { threshold: LEAD, current, suggested: candidate, sample, reason: `9 in 10 pushes where words found nothing had a top cosine under ${round2(percentile(none, 0.9))}; 0.05 above it stays below the median full push (${round2(median)}).` };
}
```

5. In `calibrationReport`, after `const dense_near_floor = …`, add `const meaning_lead = input.meaning_lead ?? null;` and append `meaningLeadFromLog(input.recall_log, floor, meaning_lead?.threshold ?? null)` to the `suggestions` array (it is built earlier; move its construction after this point or push onto it). Add `meaning_lead` to the returned `recall` object. Push one more gap: `"The log does not record whether a push was right, so the meaning-lead suggestion from it is weaker evidence than npm run proof:search, which measures a real model on known texts."`.

6. In `renderCalibration`, after the `embedded passages` line add:

```ts
  const lead = r.recall.meaning_lead;
  lines.push(lead ? `  Meaning matches can lead: ${lead.threshold}, applied ${lead.applied_at.slice(0, 10)} from ${lead.source} (${lead.sample} queries measured ${lead.measured_at}, model ${lead.key}).` : "  Meaning matches can lead: not set (a match found by meaning alone never leads a push).");
```

and change the suggestions line to print `current` as `unset` when null: `` `- ${s.threshold} = ${s.current ?? "unset"}: …` ``. After the suggestions loop add `lines.push("Each is weaker evidence than npm run proof:search when it comes from the log alone; apply a value only in Settings → Better search → Meaning matches can lead.");`.

(The `MeaningLead.key` is a model key, printed exactly as the `embedded passages` line already prints one; `SAFE_KEY` guards grouping keys from rows, and the setting's `key` is written by the server from the worker's published key, so it is printed as is.)

- [ ] **Step 4: The scripts (edit, do not run)**

In `scripts/better-search-proof.ts`, import `suggestMeaningLead` from `../packages/domain/calibration.ts`, count scanned queries (`let scanned = 0;` incremented once per case where a cosine was read, in both branches), and after the `lowest cosine …` line add:

```ts
    const lead = suggestMeaningLead({ highestNegative, lowestWanted, floor: denseFloor(key), sample: scanned });
    console.log("\nMeaning matches can lead (a suggestion only; apply it yourself in Settings → Better search → Meaning matches can lead):");
    console.log(lead.suggested === null ? `  no value suggested. ${lead.reason}` : `  threshold ${lead.suggested}  sample ${lead.sample} queries  source proof:search  measured ${new Date().toISOString().slice(0, 10)}  model ${key}\n  Why: ${lead.reason}`);
    console.log("  This measures the real model on BiBrain's synthetic golden texts, not on your notes.");
```

In `scripts/calibrate.ts`, after `const recall_log = …`, add `const meaning_lead = setting<MeaningLead | null>("meaning_lead", null);` (import `type MeaningLead` from `../packages/domain/better-search.ts`) and pass `meaning_lead` in `input`.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/integration/calibration-report.test.ts --reporter=dot --maxWorkers=1 && npm run typecheck && npm run lint`
Expected: PASS; exit 0. Do not run `npm run proof:search` or `npm run calibrate` without `--db` on a synthetic file; the spawn test already covers the script on a synthetic brain.

- [ ] **Step 6: Commit**

```bash
git add packages/domain/calibration.ts scripts/better-search-proof.ts scripts/calibrate.ts tests/integration/calibration-report.test.ts
git commit -m "feat: proof:search and calibrate suggest a meaning-lead threshold with its sample size

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The Settings control for "Meaning matches can lead" (Sonnet)

**Files:**
- Modify: `apps/web/better-search-copy.ts` (`meaningLeadLine`)
- Modify: `apps/web/src.tsx` (type, load, form under the Better search card)
- Modify: `tests/integration/better-search-copy.test.ts`
- Modify: `tests/e2e/better-search.spec.ts` (the line and the form)

**Interfaces:**
- Consumes: `GET/PATCH/DELETE /api/v1/preferences/meaning-lead` (Task 4).
- Produces: `meaningLeadLine(m: { lead: MeaningLead | null; effective: number | null; reason: string }) -> string`.

- [ ] **Step 1: Write the failing copy test**

Append to `tests/integration/better-search-copy.test.ts` (import `meaningLeadLine`):

```ts
describe("meaning-lead copy", () => {
  const lead = { threshold: 0.63, key: "ollama:bge-m3:none", sample: 54, source: "proof:search" as const, measured_at: "2026-11-06", applied_at: "2026-11-07T09:12:00.000Z" };
  it("says plainly whether a meaning match may lead, and why not", () => {
    expect(meaningLeadLine({ lead: null, effective: null, reason: "Not yet calibrated." })).toBe("Not yet calibrated. A match found by meaning alone never leads a push to your agents. Run npm run proof:search or npm run calibrate for a suggested value, then enter it here.");
    expect(meaningLeadLine({ lead, effective: 0.63, reason: "ready" })).toBe("Calibrated at 0.63: a match found by meaning alone can lead a push when its score is 0.63 or higher. From proof:search, 54 queries measured on 2026-11-06, applied 2026-11-07.");
    expect(meaningLeadLine({ lead, effective: null, reason: "Measured for another search model. Measure again." })).toBe("Measured for another search model. Measure again. Until then a match found by meaning alone never leads a push.");
    expect(meaningLeadLine({ lead: null, effective: null, reason: "Turn Better search on first." })).toBe("Turn Better search on first.");
    for (const s of [meaningLeadLine({ lead, effective: 0.63, reason: "ready" }), meaningLeadLine({ lead: null, effective: null, reason: "Not yet calibrated." })]) expect(s).not.toMatch(/bge|ollama|BRAIN_|token|mcp/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/integration/better-search-copy.test.ts --reporter=dot --maxWorkers=1`
Expected: FAIL, `meaningLeadLine` is not exported.

- [ ] **Step 3: The copy**

Append to `apps/web/better-search-copy.ts`:

```ts
export type MeaningLeadView = { lead: { threshold: number; sample: number; source: string; measured_at: string; applied_at: string } | null; effective: number | null; reason: string };
/** The one line under "Meaning matches can lead". The model key is never shown. */
export function meaningLeadLine(m: MeaningLeadView): string {
  if (m.reason === "Turn Better search on first.") return m.reason;
  if (m.effective !== null && m.lead) return `Calibrated at ${m.lead.threshold}: a match found by meaning alone can lead a push when its score is ${m.lead.threshold} or higher. From ${m.lead.source}, ${m.lead.sample} queries measured on ${m.lead.measured_at}, applied ${m.lead.applied_at.slice(0, 10)}.`;
  if (m.lead) return "Measured for another search model. Measure again. Until then a match found by meaning alone never leads a push.";
  return "Not yet calibrated. A match found by meaning alone never leads a push to your agents. Run npm run proof:search or npm run calibrate for a suggested value, then enter it here.";
}
```

- [ ] **Step 4: The form**

In `apps/web/src.tsx`:

1. Import `meaningLeadLine, type MeaningLeadView` from `./better-search-copy.ts`.
2. Beside the Better search state add `const [lead, setLead] = useState<MeaningLeadView | null>(null);` and `const [leadForm, setLeadForm] = useState({ threshold: "", sample: "", source: "proof:search", measured_at: "" });`.
3. Where Settings loads `/preferences/better-search` (line 474), also load `api<MeaningLeadView>("/preferences/meaning-lead").catch(() => null)` into `setLead`.
4. Inside the Better search `<article>`, after the existing `</form>` and before `</article>`, add:

```tsx
                  {lead ? (
                    <section aria-labelledby="meaning-lead-heading">
                      <h3 id="meaning-lead-heading">Meaning matches can lead</h3>
                      <p className="status" role="status">{meaningLeadLine(lead)}</p>
                      {lead.reason !== "Turn Better search on first." ? (
                        <form
                          onSubmit={(e) => {
                            e.preventDefault();
                            void act(async () => {
                              await api("/preferences/meaning-lead", { threshold: Number(leadForm.threshold), sample: Number(leadForm.sample), source: leadForm.source, measured_at: leadForm.measured_at }, "PATCH");
                              setLead(await api<MeaningLeadView>("/preferences/meaning-lead"));
                              setNotice("Meaning matches can now lead a push at the value you entered.");
                            });
                          }}
                        >
                          <label>Score (from the tool's suggestion) <input type="number" step="0.01" min="0" max="0.99" required value={leadForm.threshold} onChange={(e) => setLeadForm({ ...leadForm, threshold: e.target.value })} /></label>
                          <label>Queries measured <input type="number" step="1" min="20" required value={leadForm.sample} onChange={(e) => setLeadForm({ ...leadForm, sample: e.target.value })} /></label>
                          <label>Measured by <select value={leadForm.source} onChange={(e) => setLeadForm({ ...leadForm, source: e.target.value })}><option value="proof:search">npm run proof:search</option><option value="calibrate">npm run calibrate</option></select></label>
                          <label>Measured on <input type="date" required value={leadForm.measured_at} onChange={(e) => setLeadForm({ ...leadForm, measured_at: e.target.value })} /></label>
                          <div className="actions">
                            <button type="submit" disabled={busy}>Apply this value</button>
                            {lead.lead ? <button type="button" disabled={busy} onClick={() => void act(async () => { await api("/preferences/meaning-lead", undefined, "DELETE"); setLead(await api<MeaningLeadView>("/preferences/meaning-lead")); setNotice("Meaning matches no longer lead a push."); })}>Clear</button> : null}
                          </div>
                          <small className="muted">Nothing is applied by itself. Enter the value a measurement printed, with its sample size and date.</small>
                        </form>
                      ) : null}
                    </section>
                  ) : null}
```

(`api` sends `DELETE` with no body when `method` is given; check its `headers` branch sends the CSRF header for every non-GET, as the PATCH already relies on.)

- [ ] **Step 5: Extend the journey**

In `tests/e2e/better-search.spec.ts`, after the first `await expect(card(page).getByRole("radio", { name: /^Cloudflare\./ })).toBeDisabled();` add:

```ts
  const leadLine = card(page).getByRole("status").nth(1);
  await expect(leadLine).toHaveText(/^Not yet calibrated\./);
  await card(page).getByLabel("Score (from the tool's suggestion)").fill("0.6");
  await card(page).getByLabel("Queries measured").fill("20");
  await card(page).getByLabel("Measured on").fill("2026-11-06");
  await card(page).getByRole("button", { name: "Apply this value" }).click();
  await expect(page.getByText("Meaning matches can now lead a push at the value you entered.")).toBeVisible();
  await expect(leadLine).toHaveText(/^Calibrated at 0\.6: .* From proof:search, 20 queries measured on 2026-11-06/);
  await card(page).getByRole("button", { name: "Clear" }).click();
  await expect(leadLine).toHaveText(/^Not yet calibrated\./);
```

and, after the Off step's status assertion, `await expect(leadLine).toHaveText("Turn Better search on first.");`.

- [ ] **Step 6: Run the gates for this task**

Run: `npx vitest run tests/integration/better-search-copy.test.ts --reporter=dot --maxWorkers=1 && npm run typecheck && npm run lint && npm run build`
Then, alone: `npx playwright test --project=system1 --workers=1; git restore docs/screenshots`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/better-search-copy.ts apps/web/src.tsx tests/integration/better-search-copy.test.ts tests/e2e/better-search.spec.ts
git commit -m "feat: Settings control to apply a measured meaning-lead value

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Prompt intent, the session topic, the continuation exception in the hook, and the decision reading (Opus)

**Files:**
- Create: `packages/domain/recall-intent.ts`
- Modify: `apps/cli/lib.mjs:47-66` (`CONTINUATION_PROMPTS`, `normalizePrompt`, `isContinuationPrompt`, `hookSkipReason`), `apps/cli/lib.d.mts`
- Modify: `packages/domain/service.ts` (`recallInternal` gains `levelTerms`; `recallPush` reads intent and topics)
- Test: `tests/integration/recall-intent.test.ts` (new)

**Interfaces:**
- Produces: `promptIntent(prompt) -> { kind: "ack" | "continuation" | "decision" | "plain"; topicTerms: string[] }`, `normalizePrompt`, `CONTINUATION_PROMPTS`, `ACK_PROMPTS`, `DECISION_WORDS`, `RECALL_SESSION_TOPICS = "recall_session_topics"`, `SESSION_TOPIC_TTL_MS = 7_200_000`, `SESSION_TOPICS_MAX = 20`, `rememberTopic(topics, session, terms, now) -> SessionTopics`, `topicFor(topics, session, now) -> string[] | null`; CLI `isContinuationPrompt(prompt) -> boolean`, `CONTINUATION_PROMPTS`; `recallInternal(p, v, dense?, levelTerms?)` returns `topicSignals: DeterministicSignals | null`; log rows carry `intent` and `topic` only on the rows the spec names.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/integration/recall-intent.test.ts
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { ACK_PROMPTS, CONTINUATION_PROMPTS, DECISION_WORDS, RECALL_SESSION_TOPICS, SESSION_TOPICS_MAX, SESSION_TOPIC_TTL_MS, normalizePrompt, promptIntent, rememberTopic, topicFor, type SessionTopics } from "../../packages/domain/recall-intent.ts";
import { hashId } from "../../packages/domain/recall-push.ts";
import { CONTINUATION_PROMPTS as CLI_CONTINUATION, hookSkipReason, isContinuationPrompt, normalizePrompt as cliNormalize } from "../../apps/cli/lib.mjs";
import { Storage } from "../../packages/storage/index.ts";
import { Brain } from "../../packages/domain/service.ts";
import { buildFixture, owner, type Fixture } from "../eval/recall-fixture.ts";

let cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

describe("prompt intent", () => {
  it("sorts acknowledgements, continuations, decision questions and everything else", () => {
    for (const p of ["thanks", "Thanks!", "ok", "OK.", "yes", "lgtm", "got it", "sounds good", "  thank you  "]) expect(promptIntent(p).kind, p).toBe("ack");
    for (const p of ["continue", "Continue.", "go on", "OK, continue", "please continue", "keep going…", "where were we?", "what did we decide", "What was decided?", "what did we pick", "recap", "and then"]) expect(promptIntent(p), p).toEqual({ kind: "continuation", topicTerms: [] });
    expect(promptIntent("what did we pick for the caterer")).toEqual({ kind: "decision", topicTerms: ["caterer"] });
    expect(promptIntent("what color did we pick for the launch")).toEqual({ kind: "decision", topicTerms: ["color", "launch"] });
    expect(promptIntent("What color did we settle on for the launch?")).toEqual({ kind: "decision", topicTerms: ["color", "launch"] });
    expect(promptIntent("what was decided about Marco")).toEqual({ kind: "decision", topicTerms: ["marco"] });
    expect(promptIntent("did we choose a price")).toEqual({ kind: "decision", topicTerms: ["price"] });
    expect(promptIntent("what did we go with for auth?")).toEqual({ kind: "decision", topicTerms: ["auth"] });
    expect(promptIntent("the decision on pricing")).toEqual({ kind: "decision", topicTerms: ["pricing"] });
    for (const p of ["which hue was chosen for the release", "how did Northstar status change", "should we pick React", "write a function that picks the best route", "how do I reverse a linked list in Python", "What does the git rebase --onto flag do?", "what is the zephyr cadence we settled on", "Thanks a lot for that!", "launch color"])
      expect(promptIntent(p).kind, p).toBe("plain");
    expect(normalizePrompt("  OK, Continue!!  ")).toBe("continue");
    for (const w of ["decide", "picked", "chosen", "agreed"]) expect(DECISION_WORDS.has(w)).toBe(true);
    expect(ACK_PROMPTS.some((a) => CONTINUATION_PROMPTS.includes(a))).toBe(false);
  });
  it("keeps the CLI's copy of the continuation list and its normalisation equal to the domain's", () => {
    expect(CLI_CONTINUATION).toEqual(CONTINUATION_PROMPTS);
    for (const p of ["  OK, Continue!!  ", "please go on.", "What did we decide?", "thanks"]) expect(cliNormalize(p)).toBe(normalizePrompt(p));
    for (const p of CONTINUATION_PROMPTS) expect(isContinuationPrompt(p), p).toBe(true);
    for (const p of ["continue", "next", "go on", "recap"]) expect(hookSkipReason(p), p).toBeNull();
    for (const p of ["thanks", "ok", "yes", "short", "hi there"]) expect(hookSkipReason(p), p).toBe("short");
    expect(hookSkipReason("/continue")).toBe("command");
  });
  it("keeps at most 20 live sessions, 12 words each, for two hours, and never answers for another session", () => {
    const now = new Date("2026-10-25T09:00:00.000Z");
    let topics: SessionTopics = {};
    for (let i = 0; i < 25; i++) topics = rememberTopic(topics, String(i).padStart(64, "0"), ["beta", "open"], new Date(now.getTime() + i * 1000));
    expect(Object.keys(topics)).toHaveLength(SESSION_TOPICS_MAX);
    expect(topicFor(topics, "0".repeat(64), now)).toBeNull();
    expect(topicFor(topics, "24".padStart(64, "0"), now)).toEqual(["beta", "open"]);
    const many = rememberTopic({}, "a".repeat(64), Array.from({ length: 20 }, (_, i) => `w${i}`), now);
    expect(topicFor(many, "a".repeat(64), now)).toHaveLength(12);
    expect(topicFor(many, "b".repeat(64), now)).toBeNull();
    expect(topicFor(many, "a".repeat(64), new Date(now.getTime() + SESSION_TOPIC_TTL_MS - 1))).toEqual(topicFor(many, "a".repeat(64), now));
    expect(topicFor(many, "a".repeat(64), new Date(now.getTime() + SESSION_TOPIC_TTL_MS))).toBeNull();
    expect(Object.keys(rememberTopic(many, "c".repeat(64), ["x"], new Date(now.getTime() + SESSION_TOPIC_TTL_MS)))).toEqual(["c".repeat(64)]);
    expect(topicFor({ ["d".repeat(64)]: { terms: "nope" as unknown as string[], at: now.toISOString() } }, "d".repeat(64), now)).toBeNull();
  });
});

describe("the push with intent", () => {
  function fixture(clock: () => Date) {
    const dir = mkdtempSync(join(tmpdir(), "recall-intent-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const fx = buildFixture(join(dir, "brain.sqlite"));
    cleanup.push(() => fx.store.close());
    const brain = new Brain(fx.store, clock);
    return { fx, brain, agent: brain.authenticateAgent(fx.agentToken) };
  }
  const row = (brain: Brain) => brain.recallLog(owner).rows.at(-1)!;
  it("remembers the topic of a push that found something, reads it for a continuation in the same session only, and forgets it after two hours", async () => {
    let at = new Date("2026-10-25T09:00:00.000Z");
    const { fx, brain, agent } = fixture(() => at);
    const s1 = "1".repeat(64);
    const first = await brain.recallPush(agent, { prompt: "when does the beta open", session_id: s1, first_prompt: true, seen: [] });
    expect(first.level).toBe("full");
    expect(row(brain)).not.toHaveProperty("intent");
    expect(fx.store.setting<SessionTopics>(RECALL_SESSION_TOPICS, {})[s1]?.terms).toEqual(["beta", "open"]);
    const again = await brain.recallPush(agent, { prompt: "continue", session_id: s1, first_prompt: false, seen: first.hit_ids.map(hashId) });
    expect(again.level).not.toBe("full");
    expect(row(brain)).toMatchObject({ intent: "continuation", topic: "session" });
    const other = await brain.recallPush(agent, { prompt: "continue", session_id: "2".repeat(64), first_prompt: false, seen: [] });
    expect(other).toEqual({ level: "none", text: "", hit_ids: [], digest: false });
    expect(row(brain)).toMatchObject({ intent: "continuation", topic: "none", candidates: 0 });
    at = new Date(at.getTime() + SESSION_TOPIC_TTL_MS);
    const late = await brain.recallPush(agent, { prompt: "continue", session_id: s1, first_prompt: false, seen: [] });
    expect(late.level).toBe("none");
    expect(row(brain)).toMatchObject({ intent: "continuation", topic: "none" });
    // A generic prompt stores no topic, and an acknowledgement never searches.
    await brain.recallPush(agent, { prompt: "how do I reverse a linked list in Python", session_id: "3".repeat(64), first_prompt: true, seen: [] });
    expect(fx.store.setting<SessionTopics>(RECALL_SESSION_TOPICS, {})["3".repeat(64)]).toBeUndefined();
    expect(await brain.recallPush(agent, { prompt: "thanks", session_id: s1, first_prompt: false, seen: [] })).toEqual({ level: "none", text: "", hit_ids: [], digest: false });
    expect(row(brain)).toMatchObject({ intent: "ack", candidates: 0 });
  });
  it("opens a session that starts with a continuation on the digest, as a pointer, and on nothing for an empty brain", async () => {
    const { brain, agent } = fixture(() => new Date("2026-10-25T09:00:00.000Z"));
    const r = await brain.recallPush(agent, { prompt: "continue", session_id: "4".repeat(64), first_prompt: true, seen: [] });
    expect(r.level).toBe("pointer");
    expect(r.digest).toBe(true);
    expect(r.text).toContain("The owner's brain (bibrain) covers Northstar");
    expect(r.hit_ids).toEqual([]);
    expect(row(brain)).toMatchObject({ intent: "continuation", topic: "digest", hits: 0 });
    const dir = mkdtempSync(join(tmpdir(), "recall-intent-empty-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const store = new Storage(join(dir, "brain.sqlite"));
    cleanup.push(() => store.close());
    const empty = new Brain(store);
    const grant = empty.createGrant(owner, { projects: ["inbox"], operations: ["read"], expires_at: "2027-01-01T00:00:00.000Z" });
    const e = await empty.recallPush(empty.authenticateAgent(grant.token), { prompt: "continue", session_id: "5".repeat(64), first_prompt: true, seen: [] });
    expect(e).toEqual({ level: "none", text: "", hit_ids: [], digest: false });
  });
  it("reads a decision question without its decision words when that is louder, and never quieter", async () => {
    const { fx, brain, agent } = fixture(() => new Date("2026-10-25T09:00:00.000Z"));
    const r = await brain.recallPush(agent, { prompt: "what did we pick for the caterer", session_id: "6".repeat(64), first_prompt: false, seen: [] });
    expect(r.level).toBe("full");
    expect(r.hit_ids[0]).toBe(fx.ids["fact:caterer"]);
    expect(row(brain)).toMatchObject({ intent: "decision" });
    expect(fx.store.setting<SessionTopics>(RECALL_SESSION_TOPICS, {})["6".repeat(64)]?.terms).toEqual(["caterer"]);
    const same = await brain.recallPush(agent, { prompt: "what color did we pick for the launch", session_id: "7".repeat(64), first_prompt: false, seen: [] });
    expect(same.level).toBe("full");
    expect(row(brain)).not.toHaveProperty("intent");
    const nothing = await brain.recallPush(agent, { prompt: "what did we decide for auth", session_id: "8".repeat(64), first_prompt: false, seen: [] });
    expect(nothing).toEqual({ level: "none", text: "", hit_ids: [], digest: false });
    expect(row(brain)).not.toHaveProperty("intent");
  });
});

describe("the hook sends a continuation phrase", () => {
  const cli = resolve("apps/cli/bibrain.mjs");
  const ID = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";
  function dataDir(api: string) {
    const dir = mkdtempSync(join(tmpdir(), "bibrain-continue-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, "agent-keys"));
    writeFileSync(join(dir, "agent-keys", `${ID}.json`), JSON.stringify({ api, key: "f".repeat(64) }));
    return dir;
  }
  async function fake() {
    const bodies: any[] = [];
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ level: "pointer", text: "The owner's brain (bibrain) has notes on Northstar that may bear on this; brain_recall searches it.", hit_ids: [], digest: true }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    cleanup.push(() => new Promise<void>((r) => server.close(() => r())));
    return { port: (server.address() as { port: number }).port, bodies };
  }
  function run(prompt: string, dir: string) {
    return new Promise<{ status: number | null; stdout: string }>((resolveRun) => {
      const child = spawn(process.execPath, [cli, "hook", "claude-code", "--connection", ID, "--data", dir], { windowsHide: true });
      let stdout = "";
      child.stdout.on("data", (c) => (stdout += c));
      child.on("close", (status) => resolveRun({ status, stdout }));
      child.stdin.end(JSON.stringify({ prompt, session_id: "S" }));
    });
  }
  it("calls BiBrain for 'continue' and still skips 'thanks'", async () => {
    const f = await fake();
    const dir = dataDir(`http://127.0.0.1:${f.port}`);
    const r = await run("continue", dir);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toContain("brain_recall searches it");
    expect(f.bodies).toHaveLength(1);
    expect(f.bodies[0].prompt).toBe("continue");
    expect(await run("thanks", dir)).toMatchObject({ status: 0, stdout: "" });
    expect(f.bodies).toHaveLength(1);
  }, 20_000);
});
```

(`seen` carries `sha256(id)` exactly as the hook sends it; `hashId` from `recall-push.ts` is that function.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/integration/recall-intent.test.ts --reporter=dot --maxWorkers=1`
Expected: FAIL, `packages/domain/recall-intent.ts` is missing.

- [ ] **Step 3: The pure module**

```ts
// packages/domain/recall-intent.ts
import { questionWords } from "./ask.ts";
import { MAX_TERMS } from "./recall.ts";

export const RECALL_SESSION_TOPICS = "recall_session_topics";
export const SESSION_TOPIC_TTL_MS = 7_200_000;
export const SESSION_TOPICS_MAX = 20;
export type PromptIntent = { kind: "ack" | "continuation" | "decision" | "plain"; topicTerms: string[] };

/** Closed lists, compared after normalisation. The CLI keeps a copy of CONTINUATION_PROMPTS in apps/cli/lib.mjs; a test keeps them equal. */
export const CONTINUATION_PROMPTS: readonly string[] = [
  "continue", "go on", "keep going", "carry on", "proceed", "next", "resume", "pick up where we left off", "where were we", "where did we leave off",
  "what were we doing", "what did we decide", "what was decided", "what did we agree", "what did we pick", "what did we choose", "remind me where we are",
  "recap", "summarise where we are", "summarize where we are", "and then", "go ahead with that", "do that", "continue from there",
];
export const ACK_PROMPTS: readonly string[] = ["thanks", "thank you", "ok", "okay", "yes", "no", "sure", "great", "nice", "cool", "done", "lgtm", "good", "fine", "yep", "nope", "got it", "k", "ty", "thx", "perfect", "sounds good"];
/** The words a decision question is read without (after questionWords' trailing-s strip). */
export const DECISION_WORDS: ReadonlySet<string> = new Set(["decide", "decided", "decision", "pick", "picked", "choose", "chose", "chosen", "settle", "settled", "agree", "agreed"]);
const DECISION_INTENT = /\b(?:did|have|had|do|were|was)\s+(?:we|you|i)\s+(?:\S+\s+){0,2}?(?:decide|pick|choose|settle|agree|go with)\b|\bwhat\s+(?:was|were|is|got)\s+(?:decided|chosen|picked|agreed|settled)\b|\b(?:our|the)\s+decision\s+(?:on|about|for)\b/iu;

/** Lowercase, one space between words, no leading "ok," / "okay," / "please", no trailing punctuation. The same function lives in the CLI. */
export function normalizePrompt(prompt: string): string {
  return prompt.toLocaleLowerCase().replace(/\s+/gu, " ").trim().replace(/^(?:ok(?:ay)?,?\s+|please\s+)/u, "").replace(/[\s.!?…,:;]+$/u, "").trim();
}

export function promptIntent(prompt: string): PromptIntent {
  const n = normalizePrompt(prompt);
  if (ACK_PROMPTS.includes(n)) return { kind: "ack", topicTerms: [] };
  if (CONTINUATION_PROMPTS.includes(n)) return { kind: "continuation", topicTerms: [] };
  if (DECISION_INTENT.test(prompt)) {
    const topic = questionWords(prompt).filter((w) => !DECISION_WORDS.has(w)).slice(0, MAX_TERMS);
    return topic.length ? { kind: "decision", topicTerms: topic } : { kind: "continuation", topicTerms: [] };
  }
  return { kind: "plain", topicTerms: [] };
}

/** Per session hash: the content words of the last prompt that found something, and when. Never the prompt, an id or a passage. */
export type SessionTopics = Record<string, { terms: string[]; at: string }>;
const live = (t: { at: string } | undefined, now: Date) => !!t && typeof t.at === "string" && Number.isFinite(Date.parse(t.at)) && now.getTime() - Date.parse(t.at) < SESSION_TOPIC_TTL_MS;
const wordsOf = (t: { terms: unknown }) => (Array.isArray(t.terms) ? t.terms.filter((w): w is string => typeof w === "string").slice(0, MAX_TERMS) : []);

/** Drops expired and malformed entries, replaces this session's, and keeps the 20 most recent. */
export function rememberTopic(topics: SessionTopics, session: string, terms: string[], now: Date): SessionTopics {
  const kept = Object.entries(topics ?? {}).filter(([k, t]) => k !== session && live(t, now) && wordsOf(t).length > 0);
  kept.push([session, { terms: terms.slice(0, MAX_TERMS), at: now.toISOString() }]);
  kept.sort((a, b) => Date.parse(b[1].at) - Date.parse(a[1].at));
  return Object.fromEntries(kept.slice(0, SESSION_TOPICS_MAX));
}

export function topicFor(topics: SessionTopics, session: string, now: Date): string[] | null {
  const t = topics?.[session];
  if (!live(t, now)) return null;
  const words = wordsOf(t!);
  return words.length ? words : null;
}
```

- [ ] **Step 4: The CLI's copy and the exception**

In `apps/cli/lib.mjs`, after `export const HOOK_CLIENTS = …`:

```js
/** The same list and normalisation as packages/domain/recall-intent.ts; a test keeps them equal. These pass the 12-character floor. */
export const CONTINUATION_PROMPTS = [
  "continue", "go on", "keep going", "carry on", "proceed", "next", "resume", "pick up where we left off", "where were we", "where did we leave off",
  "what were we doing", "what did we decide", "what was decided", "what did we agree", "what did we pick", "what did we choose", "remind me where we are",
  "recap", "summarise where we are", "summarize where we are", "and then", "go ahead with that", "do that", "continue from there",
];
export function normalizePrompt(prompt) {
  return prompt.toLocaleLowerCase().replace(/\s+/gu, " ").trim().replace(/^(?:ok(?:ay)?,?\s+|please\s+)/u, "").replace(/[\s.!?…,:;]+$/u, "").trim();
}
export function isContinuationPrompt(prompt) {
  return CONTINUATION_PROMPTS.includes(normalizePrompt(prompt));
}
```

and change the first line of `hookSkipReason` to `if (Array.from(trimmed).length < HOOK_MIN_PROMPT && !isContinuationPrompt(trimmed)) return "short";`.

In `apps/cli/lib.d.mts` add:

```ts
export const CONTINUATION_PROMPTS: string[];
export function normalizePrompt(prompt: string): string;
export function isContinuationPrompt(prompt: string): boolean;
```

- [ ] **Step 5: `recallInternal` reads a second term set**

In `packages/domain/service.ts`, import `RECALL_SESSION_TOPICS, promptIntent, rememberTopic, topicFor, type SessionTopics` from `./recall-intent.ts`.

Change the signature to `recallInternal(p: Principal, v: { … }, dense: QueryVector | null = null, levelTerms?: string[])`. In the early return add `topicSignals: null as DeterministicSignals | null`. Replace the signals block with:

```ts
    let signals = deterministicSignals(fts.terms, ranked, entityNames);
    // A decision question's second reading (plan 10): the same candidates, read over the topic words alone. Null unless asked for.
    let topicSignals: DeterministicSignals | null = levelTerms ? deterministicSignals(levelTerms, ranked, entityNames) : null;
    let namesRanked = ranked;
    if (lists.dense!.length) {
      const byWords = new Set(ranked.filter(fromBm25).map((c) => c.key));
      const wordRanked = fuse({ facts: lists.facts, originals: lists.originals, phrase: lists.phrase }, now).filter((c) => byWords.has(c.key));
      signals = { ...deterministicSignals(fts.terms, wordRanked, entityNames), candidates: ranked.length };
      topicSignals = levelTerms ? { ...deterministicSignals(levelTerms, wordRanked, entityNames), candidates: ranked.length } : null;
      namesRanked = wordRanked;
    }
```

and add `topicSignals` to the final return. (`DeterministicSignals` is already imported as a type via `recall.ts`; add it if not.)

- [ ] **Step 6: `recallPush` with intent**

Replace `recallPush` from its signature to the final `return finish(...)` with this version (it includes Task 4's lead block; keep `finish`'s body as it is apart from the three new spreads):

```ts
  /** The per-prompt push for a hook: deterministic recall as the grant, a level, bounded text, and a content-free log row. */
  async recallPush(p: Principal, input: unknown) {
    if (p.kind !== "agent") throw new BrainError("FORBIDDEN", "Use an agent token.", 403);
    const grant = this.grant(p)!;
    if (!grant.operations.includes("read")) throw new BrainError("NOT_FOUND", "Item unavailable.", 404);
    const v = recallPushSchema.parse(input);
    const started = Date.now();
    const quiet = { level: "none" as PushLevel, text: "", hit_ids: [] as string[], digest: false };
    type Extra = { candidates: number; judged: boolean; dense: boolean; dense_top?: number | null; judge?: JudgeSignals | null; intent?: "ack" | "continuation" | "decision"; topic?: "session" | "digest" | "none"; lead?: boolean };
    const finish = (out: typeof quiet, extra: Extra) => {
      // A push that reached the brain proves the connection works, exactly like /agent/verify.
      // `dense`, `dense_top`, `judge`, `intent`, `topic` and `lead` are written only when that feature ran, so with everything off
      // the row is plan 5's, field for field (the dense-off snapshot pins this). Every value is a number, a level or a fixed word, never text.
      this.store.run("UPDATE grants SET last_verified_at=? WHERE id=?", this.now(), p.grant_id);
      const round3 = (n: number) => Number(n.toFixed(3));
      const log = this.store.setting<unknown[]>("recall_log", []);
      log.push({
        at: this.now(), grant_id: p.grant_id, client: v.client, level: out.level, candidates: extra.candidates, hits: out.hit_ids.length, latency_ms: Date.now() - started, judged: extra.judged,
        ...(extra.dense ? { dense: true, ...(typeof extra.dense_top === "number" ? { dense_top: extra.dense_top } : {}) } : {}),
        ...(extra.judged && extra.judge ? { judge: { owner_world: round3(extra.judge.ownerWorld), general: round3(extra.judge.general), answered: extra.judge.answered } } : {}),
        ...(extra.intent ? { intent: extra.intent } : {}),
        ...(extra.topic ? { topic: extra.topic } : {}),
        ...(extra.lead ? { lead: true } : {}),
      });
      this.store.set("recall_log", log.slice(-RECALL_LOG_MAX));
      return out;
    };
    if (detectSecrets(v.prompt).length) return finish(quiet, { candidates: 0, judged: false, dense: false });
    // Prompt intent (plan 10, R7 to R10): an acknowledgement never searches; a continuation reads this session's recent topic, then the digest, then nothing.
    const intent = promptIntent(v.prompt);
    if (intent.kind === "ack") return finish(quiet, { candidates: 0, judged: false, dense: false, intent: "ack" });
    const now = this.clock();
    const topics = this.store.setting<SessionTopics>(RECALL_SESSION_TOPICS, {});
    let query = v.prompt;
    let topic: "session" | "digest" | "none" | undefined;
    if (intent.kind === "continuation") {
      const terms = topicFor(topics, v.session_id, now);
      if (terms) {
        query = terms.join(" ");
        topic = "session";
      } else if (v.first_prompt) {
        // A session that opens with "continue" gets the map of the brain as a pointer, never evidence it did not ask for.
        const scope = (this.projects(p) as { id: string; title: string }[]).map(({ id, title }) => ({ id, title }));
        const d = scope.length ? this.digestFor(scope, scope.map((s) => s.title)) : "";
        if (!d || detectSecrets(d).length) return finish(quiet, { candidates: 0, judged: false, dense: false, intent: "continuation", topic: "none" });
        return finish({ level: "pointer", text: d, hit_ids: [], digest: true }, { candidates: 0, judged: false, dense: false, intent: "continuation", topic: "digest" });
      } else return finish(quiet, { candidates: 0, judged: false, dense: false, intent: "continuation", topic: "none" });
    }
    // The vector first (at most 400 ms), then the judge (at most 900 ms): the 1,500 ms hook budget holds.
    const dense = await this.denseFor(p, query);
    const internal = this.recallInternal(p, { query, history: false, limit: PUSH_HITS_MAX }, dense, intent.kind === "decision" ? intent.topicTerms : undefined);
    const candidates = internal.result.searched.candidates;
    // A decision question is read with and without its decision words; the louder deterministic reading is the one every later step uses (R9). Never quieter.
    const louderTopic = internal.topicSignals !== null && LEVEL_RANK[deterministicLevel(internal.topicSignals)] > LEVEL_RANK[deterministicLevel(internal.signals)];
    const signals = louderTopic ? internal.topicSignals! : internal.signals;
    // The push level is term-based (R2). With no candidate found by words the judge is not asked at all: the level is the
    // deterministic one (none, or pointer for an exact entity), so meaning alone can never make a push louder without the owner-applied line below.
    const judge = internal.ranked.some(fromBm25) ? await this.judgeForPush(p, internal) : { signals: null, hits: internal.result.hits, judged: false };
    let level = pushLevel(signals, judge.signals);
    // Unreviewed agent-written originals the agent may see: another agent's notes, never the owner's evidence (spec A1, R2).
    const blocked = new Set(internal.authorized.filter(isUnreviewedAgent).map((h) => h.id));
    const isBlocked = (c: Candidate) => c.row.kind === "original" && blocked.has(c.row.ref_id);
    // Such notes never reach the judge (judgeRankedOnce leaves them out), so a judged level rests on the owner's candidates alone.
    const seen = filterSeen(judge.hits, v.seen);
    // An unreviewed agent-written original never rides in a full push.
    const hits = seen.filter((h) => !isUnreviewedAgent(h));
    // When the judge's order leaves a hit found by meaning alone on top, the level is capped at the words level.
    if (hits.length && internal.denseOnly.has(hitKey(hits[0]))) level = quieter(level, pushLevel(signals, null));
    // Everything the agent already holds from this session, and every unreviewed agent note, is left out. When that removed hits, the level is re-read
    // on what is left: `full` only while the best remaining hit is itself a strong match, `pointer` for an exact entity match or a remaining related hit, else quiet.
    if (level === "full" && hits.length < judge.hits.length) {
      const terms = signals.terms;
      if (!hits.length || !hitIsStrong(terms, hits[0])) level = signals.exactEntity || seen.some((h) => hitIsRelated(terms, h)) ? "pointer" : "none";
    }
    // Meaning matches can lead (plan 10): only with the owner-applied line, only for the hit that leads, after every rule above. R5.
    let led = false;
    const leadLine = this.meaningLeadThreshold();
    if (leadLine !== null && level !== "full" && hits.length) {
      const key = hitKey(hits[0]);
      const raised = meaningLead(level, { denseOnly: internal.denseOnly.has(key), cosine: internal.denseScores.get(key) ?? null, unreviewed: isUnreviewedAgent(hits[0]) }, leadLine);
      led = raised !== level;
      level = raised;
    }
    // A judge may rate a candidate relevant that did not survive into the hits; a full push with nothing to show is never sent.
    if (level === "full" && !hits.length) level = signals.exactEntity ? "pointer" : "none";
    // Names for the pointer and the digest: the top three candidates exactly as deterministicSignals builds topNames (from the same list), except that
    // an unreviewed agent original is skipped first: its title is agent-chosen text and never a name here. With no such original this is plan 5's list.
    const top = [...new Set(internal.namesRanked.filter((c) => !isBlocked(c)).slice(0, 3).map((c) => (c.row.kind === "fact" ? c.row.prefix.split(" · ").at(-1)! : c.row.prefix.split(" · ")[0])))];
    // When only an unreviewed note matched, there is no name to give: the pointer names the projects searched, as the digest does.
    const names = top.length ? top : internal.entityNames.length ? internal.entityNames : blocked.size ? internal.scope.map((s) => s.title) : [];
    let text = "";
    let used: RecallHit[] = [];
    if (level === "full") {
      const fit = fitFull(hits, internal.result.as_of);
      text = fit.text;
      used = fit.used;
    } else if (level === "pointer") text = renderPointer(names);
    let digest = false;
    // The digest rides only on a pointer or full push: a `none` prompt stays completely quiet, first prompt or not.
    if (v.first_prompt && level !== "none") {
      const d = this.digestFor(internal.scope, names);
      if (d) {
        digest = true;
        // The digest normally ends with the same pointer line, so a pointer push is then the digest alone.
        text = level === "pointer" && d.includes(text) ? d : `${d}\n\n${text}`;
      }
    }
    const extra: Extra = {
      candidates, judged: judge.judged, dense: internal.dense, dense_top: internal.denseTop, judge: judge.signals,
      ...(intent.kind === "continuation" ? { intent: "continuation" as const, topic } : louderTopic ? { intent: "decision" as const } : {}),
      ...(led ? { lead: true } : {}),
    };
    if (text && detectSecrets(text).length) return finish(quiet, { ...extra, lead: false });
    // Remember the topic of a prompt that found something, so "continue" in this session can mean it (R8). Content words only; a continuation never overwrites it.
    if (level !== "none" && intent.kind !== "continuation") this.store.set(RECALL_SESSION_TOPICS, rememberTopic(topics, v.session_id, intent.kind === "decision" ? intent.topicTerms : signals.terms, now));
    return finish({ level, text, hit_ids: used.map((h) => h.id), digest }, extra);
  }
```

(`deterministicLevel` must be imported from `./recall.ts` in `service.ts` if it is not already; `LEVEL_RANK`, `quieter` and `hitKey` are module-level constants above the class.)

- [ ] **Step 7: Run the tests and the snapshot**

Run: `npx vitest run tests/integration/recall-intent.test.ts tests/integration/recall-dense.test.ts tests/integration/recall-push.test.ts tests/integration/bibrain-hook.test.ts tests/integration/bibrain-contract.test.ts tests/integration/meaning-lead.test.ts tests/eval/recall.test.ts --reporter=dot --maxWorkers=1 && npm run typecheck && npm run lint`
Expected: PASS, "plan 5 snapshot" byte-identical: no golden prompt is an acknowledgement or a continuation phrase; the two golden decision questions (`pos-02`, `long-02`) are already `full` under both readings, so `louderTopic` is false and their rows gain no field. If the snapshot test fails, the cause is a changed level on a golden push: report which case and why, and fix the rule rather than regenerating the snapshot.

- [ ] **Step 8: Commit**

```bash
git add packages/domain/recall-intent.ts packages/domain/service.ts apps/cli/lib.mjs apps/cli/lib.d.mts tests/integration/recall-intent.test.ts
git commit -m "feat: short and decision-shaped prompts pull context without pushing on generic ones

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The "short and paraphrase" golden bucket (Sonnet)

**Files:**
- Create: `tests/eval/recall-short-golden-v1.json`
- Create: `tests/eval/recall-short.test.ts`
- Modify: `scripts/brain-eval.mjs:35-41` (name the new golden file), `:60` (the `recall_gates` sentence)

**Interfaces:**
- Consumes: `recallPush`, `recallLog`, `embedFixture`, `hashId`.

- [ ] **Step 1: Write the golden file**

```json
{
  "version": 1,
  "note": "Short, continuation, acknowledgement and decision-shaped prompts, run through recallPush as session sequences, with Better search off and with the fake embedder on. A failing case is a finding to report, never a reason to widen a list or lower a line.",
  "cases": [
    { "id": "short-01", "tags": ["short", "continuation", "first"], "session": "s1", "steps": [
      { "prompt": "continue", "first_prompt": true, "expect": { "level": "pointer", "digest": true, "text_includes": "The owner's brain (bibrain) covers Northstar", "hit_ids": [], "log": { "intent": "continuation", "topic": "digest" } } } ] },
    { "id": "short-02", "tags": ["short", "continuation", "no-repeat"], "session": "s2", "steps": [
      { "prompt": "what did we pick for the caterer", "first_prompt": true, "expect": { "level": "full", "hit_includes": ["fact:caterer"], "log": { "intent": "decision" } } },
      { "prompt": "continue", "first_prompt": false, "seen_previous": true, "expect": { "level_in": ["none", "pointer"], "hit_excludes": ["fact:caterer"], "log": { "intent": "continuation", "topic": "session" } } } ] },
    { "id": "short-03", "tags": ["short", "continuation", "no-repeat"], "session": "s3", "steps": [
      { "prompt": "when does the beta open", "first_prompt": true, "expect": { "level": "full", "hit_includes": ["fact:beta-opens"] } },
      { "prompt": "what did we decide", "first_prompt": false, "seen_previous": true, "expect": { "level_in": ["none", "pointer"], "hit_excludes": ["fact:beta-opens"], "log": { "intent": "continuation", "topic": "session" } } } ] },
    { "id": "short-04", "tags": ["short", "continuation", "no-topic"], "session": "s4", "steps": [
      { "prompt": "how do I reverse a linked list in Python", "first_prompt": true, "expect": { "level": "none" } },
      { "prompt": "continue", "first_prompt": false, "expect": { "level": "none", "text": "", "digest": false, "log": { "intent": "continuation", "topic": "none" } } } ] },
    { "id": "short-05", "tags": ["short", "ack"], "session": "s5", "steps": [
      { "prompt": "thanks", "first_prompt": true, "expect": { "level": "none", "text": "", "log": { "intent": "ack" } } },
      { "prompt": "ok", "first_prompt": false, "expect": { "level": "none", "text": "" } },
      { "prompt": "Thanks a lot for that!", "first_prompt": false, "expect": { "level": "none", "text": "" } } ] },
    { "id": "dec-01", "tags": ["short", "decision"], "session": "d1", "steps": [ { "prompt": "what did we pick for the caterer", "first_prompt": false, "expect": { "level": "full", "hit_includes": ["fact:caterer"], "log": { "intent": "decision" } } } ] },
    { "id": "dec-02", "tags": ["short", "decision"], "session": "d2", "steps": [ { "prompt": "what did we agree for the beta", "first_prompt": false, "expect": { "level": "full", "hit_includes": ["fact:beta-opens"], "log": { "intent": "decision" } } } ] },
    { "id": "dec-03", "tags": ["short", "decision"], "session": "d3", "steps": [ { "prompt": "what was decided about Marco", "first_prompt": false, "expect": { "level": "full", "hit_includes": ["fact:marco-role"], "log": { "intent": "decision" } } } ] },
    { "id": "dec-04", "tags": ["short", "decision"], "session": "d4", "steps": [ { "prompt": "did we choose a price", "first_prompt": false, "expect": { "level": "full", "hit_includes": ["fact:price"], "log": { "intent": "decision" } } } ] },
    { "id": "dec-05", "tags": ["short", "decision", "nothing-recorded"], "session": "d5", "steps": [ { "prompt": "what did we decide for auth", "first_prompt": false, "expect": { "level": "none", "text": "", "hit_ids": [] } } ] },
    { "id": "dec-06", "tags": ["short", "decision", "nothing-recorded"], "session": "d6", "steps": [ { "prompt": "which database did we pick", "first_prompt": false, "expect": { "level": "none", "text": "" } } ] },
    { "id": "dec-07", "tags": ["short", "generic"], "session": "d7", "steps": [ { "prompt": "which sorting algorithm should we pick for this list", "first_prompt": true, "expect": { "level": "none", "text": "", "digest": false } } ] },
    { "id": "lead-01", "tags": ["short", "paraphrase", "lead-unset"], "session": "l1", "steps": [ { "prompt": "which hue was chosen for the release", "first_prompt": false, "expect": { "level": "none", "text": "" } } ] }
  ]
}
```

- [ ] **Step 2: Write the test**

```ts
// tests/eval/recall-short.test.ts
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFixture, owner, type Fixture } from "./recall-fixture.ts";
import { embedFixture } from "./dense-fixture.ts";
import { hashId } from "../../packages/domain/recall-push.ts";

type Step = { prompt: string; first_prompt: boolean; seen_previous?: boolean; expect: { level?: string; level_in?: string[]; digest?: boolean; text?: string; text_includes?: string; hit_ids?: string[]; hit_includes?: string[]; hit_excludes?: string[]; log?: Record<string, string> } };
type Case = { id: string; tags: string[]; session: string; steps: Step[] };
const golden = JSON.parse(readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "recall-short-golden-v1.json"), "utf8")) as { cases: Case[] };
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
let dir: string;
const fixtures: Record<"off" | "dense", Fixture> = {} as never;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "recall-short-"));
  fixtures.off = buildFixture(join(dir, "off.sqlite"));
  fixtures.dense = buildFixture(join(dir, "dense.sqlite"));
  const { dense } = embedFixture(fixtures.dense);
  vi.spyOn(fixtures.dense.brain, "queryVector").mockImplementation(async (_p, q) => dense(q));
});
afterAll(() => {
  vi.restoreAllMocks();
  fixtures.off.store.close();
  fixtures.dense.store.close();
  rmSync(dir, { recursive: true, force: true });
});

for (const mode of ["off", "dense"] as const) {
  describe(`short and paraphrase golden set (Better search ${mode})`, () => {
    it("has the four buckets", () => {
      const tagged = (t: string) => golden.cases.filter((c) => c.tags.includes(t)).length;
      expect(tagged("continuation")).toBeGreaterThanOrEqual(4);
      expect(tagged("ack")).toBe(1);
      expect(tagged("decision")).toBeGreaterThanOrEqual(6);
      expect(tagged("paraphrase")).toBe(1);
    });
    for (const c of golden.cases) {
      it(`${c.id}: ${c.steps.map((s) => JSON.stringify(s.prompt)).join(" → ")}`, async () => {
        const fx = fixtures[mode];
        const session = sha(`${mode}:${c.session}`);
        let previous: string[] = [];
        for (const step of c.steps) {
          const out = await fx.brain.recallPush(fx.agent, { prompt: step.prompt, session_id: session, first_prompt: step.first_prompt, seen: step.seen_previous ? previous.map(hashId) : [] });
          const e = step.expect;
          const label = `${c.id} ${JSON.stringify(step.prompt)}`;
          if (e.level) expect(out.level, label).toBe(e.level);
          if (e.level_in) expect(e.level_in, label).toContain(out.level);
          if (e.digest !== undefined) expect(out.digest, label).toBe(e.digest);
          if (e.text !== undefined) expect(out.text, label).toBe(e.text);
          if (e.text_includes) expect(out.text, label).toContain(e.text_includes);
          if (e.hit_ids) expect(out.hit_ids, label).toEqual(e.hit_ids);
          for (const k of e.hit_includes ?? []) expect(out.hit_ids, `${label} includes ${k}`).toContain(fx.ids[k]);
          for (const k of e.hit_excludes ?? []) expect(out.hit_ids, `${label} excludes ${k}`).not.toContain(fx.ids[k]);
          const row = fx.brain.recallLog(owner).rows.at(-1)!;
          for (const [k, v] of Object.entries(e.log ?? {})) expect((row as Record<string, unknown>)[k], `${label} log.${k}`).toBe(v);
          if (!e.log?.intent) expect(row, label).not.toHaveProperty("intent");
          // Nothing in a push is ever a prompt echo: the row holds counts and fixed words only.
          expect(JSON.stringify(row), label).not.toContain(step.prompt);
          previous = out.hit_ids;
        }
      });
    }
  });
}
```

- [ ] **Step 3: Run it**

Run: `npx vitest run tests/eval/recall-short.test.ts --reporter=dot --maxWorkers=1`
Expected: PASS in both modes. A failing case is a finding: write down the case, the level and the hit ids seen, and report it to the reviewer; do not edit `recall-intent.ts`, the lists, or `recallPush` in this task. (Reading hint: in `short-02` and `short-03` the second step's `hit_excludes` and `level_in` hold because the fact was already shown and the only other passage folds into it.)

- [ ] **Step 4: Name the bucket in the eval report**

In `scripts/brain-eval.mjs`, under `fixture_size`, add `recall_short_golden: "tests/eval/recall-short-golden-v1.json",` and append to the `recall_gates` sentence: `; short and paraphrase bucket (tests/eval/recall-short.test.ts): continuation reads the session topic, then the digest, then nothing; acknowledgements never push; decision questions over recorded facts reach full; a meaning-only paraphrase stays none while the lead line is unset`.

Run: `npm run brain-eval`
Expected: every test passed (25 plus the new file's cases); the count is recorded in Task 10.

- [ ] **Step 5: Commit**

```bash
git add tests/eval/recall-short-golden-v1.json tests/eval/recall-short.test.ts scripts/brain-eval.mjs
git commit -m "test: short and paraphrase golden bucket for the recall push

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Docs, README, changelog and build state (Sonnet)

**Files:**
- Modify: `docs/PROVIDERS.md` (the Better search section and the calibration report section)
- Modify: `docs/AGENT_INTEGRATION.md:50-52`
- Modify: `docs/CONNECT_ANY_AGENT.md:94`
- Modify: `docs/SECURITY_PRIVACY.md` (one paragraph in the agents or data section)
- Modify: `README.md:49`, `:124-139`, `:162`
- Modify: `CHANGELOG.md` (Unreleased)
- Modify: `BUILD_STATE.md` (At a glance rows; a new plan 10 section with `TBD counts from Task 10` markers)

- [ ] **Step 1: PROVIDERS.md**

In "Better search (embeddings, local)":
- Replace "It is off by default; with it off nothing is sent anywhere…" with: "It is on by itself when BiBrain's background worker finds Ollama with the `bge-m3` model on this computer (one request to `http://127.0.0.1:11434/api/tags` at worker start, inside 1.5 seconds; nothing else is contacted), and off otherwise. Cloudflare is never turned on by itself. An Off you choose in Settings is kept whatever the worker finds. With it off nothing is sent anywhere, no embedding model is called, no job is written and every result is byte-identical to recall without it (a committed snapshot, `tests/eval/recall-dense-off-snapshot.json`, holds that)."
- In the Choices list, change "**Off** (default)." to "**Off.**" and add to the Ollama bullet: "Chosen for you when the worker found the model; the card then says so and Off turns it off for good."
- In the Setup table, change the `BRAIN_EMBED_PROVIDER` row to: "`ollama`, `cloudflare`, or `off`. Unset means: look for Ollama with the search model on this computer and use it when found."
- Add a bullet after "Status": "**Meaning matches can lead.** A hit found by meaning alone appears in `brain_recall` and on your screens, but leads a `full` push to an agent only when you have applied a measured score in Settings (Better search, Meaning matches can lead). The score is unset until you set it; `npm run proof:search` suggests one from a real model on the synthetic golden texts (0.05 above the loudest no-answer cosine, while every wanted hit still qualifies), `npm run calibrate` suggests one from your recall log (weaker evidence: the log does not know which pushes were right), and each prints its sample size. The applied score is stored with the date, the sample, the tool and the model key; a changed model needs a new measurement. An unreviewed agent-written note never leads."
- In the calibration section's "What it prints", add to Recall pushes: "the applied meaning-lead score with its provenance, or not set"; to Suggestions: "and `search.meaning_lead` from the log, labelled as weaker evidence than the proof".
- In "What to do with a suggestion", add: "The meaning-lead score is the one line you apply in Settings rather than in code."

- [ ] **Step 2: Agent docs**

`docs/AGENT_INTEGRATION.md` line 50: after "skips prompts shorter than 12 characters" insert "(except a closed list of continuation phrases such as `continue`, `go on` and `what did we decide`, which are sent)". Add after line 52 a paragraph:

"**Short and decision-shaped prompts.** An acknowledgement (`thanks`, `ok`, `yes` and a closed list like them) is never pushed, on either side. A continuation phrase reads the session's recent topic: the server keeps, per session hash, the content words of the last prompt that found something (at most 12 words, 20 sessions, two hours; never the prompt, an id or a passage) and runs recall on them, so `continue` brings only what is new; on the first prompt of a session with no topic it answers with the digest as a `pointer`; otherwise it is `none`. A decision question that names a topic (`what did we pick for the caterer`) is also read without its decision words, and the louder reading wins, so a current fact about the topic can reach `full`. The content-free log marks these rows with `intent` (`ack`, `continuation`, `decision`) and `topic` (`session`, `digest`, `none`), and `lead: true` when the owner-applied meaning-lead score raised a push (see `docs/PROVIDERS.md`); every other row is unchanged."

`docs/CONNECT_ANY_AGENT.md` line 94: "Do not send prompts shorter than 12 characters, except the continuation phrases the hook sends (`continue`, `go on`, `keep going`, `carry on`, `proceed`, `next`, `resume`, `where were we`, `what did we decide`, `recap` and the rest of the list in `apps/cli/lib.mjs`), slash, bang or hash commands, or anything that looks like a secret."

`docs/SECURITY_PRIVACY.md`: one paragraph where agent data is described: "For `continue`-style prompts the server keeps a session topic: the lowercase content words of the last agent prompt that found something, per session hash, at most 12 words and 20 sessions, dropped after two hours. It never holds the prompt, an id or a passage, is never logged or shown, and is deleted with the brain. The Better search startup probe contacts only Ollama on this computer and keeps nothing from its reply."

- [ ] **Step 3: README and changelog**

`README.md` line 49: "Off by default." becomes "On by itself when Ollama with the search model is found on your computer; never with Cloudflare unless you choose it." Lines 124–139: change the heading's first paragraph to "Better search finds a note by what it means, not only by the words you used. When Ollama with `bge-m3` is on your computer, BiBrain turns it on for you and says so in Settings; one switch turns it off. Everything works without it." and change step 1 to say the `.env` lines are needed only for Cloudflare or a different model. Line 162: "Built and gated against a fake embedder; on by itself with a local Ollama; a live run and the meaning-lead score are owner-run (`npm run proof:search`)".

`CHANGELOG.md`, Unreleased, add under Added: "Better search turns itself on when Ollama with the search model is found on this computer (loopback only, never Cloudflare), with a notice in Settings and one switch to turn it off."; "Meaning matches can lead: an owner-applied score (Settings, Better search) that lets a hit found by meaning alone lead a full push; `proof:search` and `calibrate` suggest a value with its sample size; unset by default."; "Continuation phrases (`continue`, `what did we decide`) read the session's recent topic or the first-prompt digest; decision questions are read without their decision words; acknowledgements never push." Under Changed: "The hook sends the continuation phrases even under 12 characters."

- [ ] **Step 4: BUILD_STATE.md**

In "At a glance": change the Better search row to "On by itself with a local Ollama (plan 10); fake-embedder gates in CI; the meaning-lead score is unset until the owner applies a measured one; live run owner-run (`npm run proof:search`)"; the Recall row gains "; short and decision-shaped prompts pinned by a second golden bucket". Add a section "## 2026-11-06 — Plan 10: recall by meaning by default (branch reframe/recall-by-meaning)" before plan 9's, with the spec and plan paths, a "What changed" list in the four parts of the spec, a "Verified" block whose every number reads `TBD counts from Task 10`, and "Known limits": no owner run of `proof:search` (the lead score stays unset; the suggestion code is untested against a real model); the probe runs once at worker start; the golden buckets are synthetic.

- [ ] **Step 5: Check and commit**

Run: `grep -rn "Off by default" README.md docs/PROVIDERS.md | grep -i "better search"`
Expected: no line still says Better search is off by default.

```bash
git add docs/PROVIDERS.md docs/AGENT_INTEGRATION.md docs/CONNECT_ANY_AGENT.md docs/SECURITY_PRIVACY.md README.md CHANGELOG.md BUILD_STATE.md
git commit -m "docs: recall by meaning by default, the meaning-lead score and short prompts

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 10: The full gate (Sonnet)

**Files:**
- Modify: `BUILD_STATE.md` (replace the count markers)

- [ ] **Step 1: Prepare**

Run (PowerShell): `New-Item -ItemType Directory -Force C:/Users/Gowrishankar/AppData/Local/Temp/opencode | Out-Null; git status --short`
Expected: the folder exists; the tree is clean.

- [ ] **Step 2: Static checks**

Run: `npm run typecheck && npm run lint && npm run build && npm audit --audit-level=high`
Expected: every command exits 0.

- [ ] **Step 3: Vitest, alone**

Run: `npx vitest run --reporter=dot --maxWorkers=2`
Expected: 0 failed; record files, passed, skipped and seconds. `git status --short tests/eval/recall-dense-off-snapshot.json tests/integration/bibrain-hook.test.ts` prints nothing.

- [ ] **Step 4: Brain eval**

Run: `npm run brain-eval`
Expected: all passed; record the total (25 plus the short bucket's cases in both modes).

- [ ] **Step 5: Playwright, alone, after Vitest has finished**

Run: `npx playwright test --workers=1; git restore docs/screenshots`
Expected: 0 failed; record the per-project counts.

- [ ] **Step 6: Fill in the build state and commit**

Replace every `TBD counts from Task 10` marker in `BUILD_STATE.md` with the real numbers and the date; `grep -n TBD BUILD_STATE.md` prints nothing.

```bash
git add BUILD_STATE.md
git commit -m "docs: record plan 10 verification counts

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

Report, in the words of `AGENTS.md`: what changed, the commands actually run, what passed, and the limits (no real Ollama, Cloudflare or agent was called; `proof:search` and `calibrate` were not run on real data, so the meaning-lead score stays unset and its suggestion code is unproven against a real model; nothing pushed).

---

## Self-review

- **Spec coverage.** Part 1 (probe, automatic reading, copy, privacy): Tasks 1, 2, 3. Part 2 (rule, setting and routes, provenance, suggestions, control): Tasks 4, 5, 6. Part 3 (intent, session topic, hook exception, decision reading, golden bucket): Tasks 7, 8. Part 4 (docs): Task 9. Gate: Task 10. The parked items need no task.
- **Placeholders.** `BUILD_STATE.md` markers are replaced in Task 10 and checked by grep. Task 4's agent-note case names a fallback word pair rather than leaving the choice open. Task 7's test uses `hashId` from `recall-push.ts` for the `seen` hashes.
- **Type consistency.** `ProbeOutcome`, `detected` and `probe` (Task 1) are the names read in Tasks 2, 3 and 4. `BetterSearchSetting.automatic` (Task 2) is the field the card reads (Task 3). `MeaningLead`, `meaningLeadThreshold()`, `denseScores` and `lead` (Task 4) are the names used in Task 7's full `recallPush` and in Task 5's report. `promptIntent`, `topicFor`, `rememberTopic`, `RECALL_SESSION_TOPICS` (Task 7) are the names Task 8's expectations rest on through the log fields `intent` and `topic`. `recallInternal`'s fourth parameter `levelTerms` and its `topicSignals` return match between Steps 5 and 6 of Task 7.
- **Review Focus.** Item 1 is pinned in Task 1 (late, huge, garbage, refused, silent); item 2 in Task 2 (explicit Off with a detected model) and Task 3's journey; item 3 in Task 4 (changed key never leads; floor, sample, source and date refusals); item 4 in Task 7 (empty brain, no topic later in a session) and Task 8 (`short-04`, `dec-07`); item 5 in Task 7 (other session null, expiry at exactly two hours).
- **Snapshot.** Tasks 2, 4 and 7 each run the plan 5 snapshot test; the reasoning for why it holds is written at each run step, so a failure is diagnosed against a stated expectation rather than regenerated.
