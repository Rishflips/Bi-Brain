import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { betterSearchCanSave, plainSearchProblem, plainSearchReason } from "../../apps/web/better-search-copy.ts";
import { Storage } from "../../packages/storage/index.ts";
import { Brain } from "../../packages/domain/service.ts";
import { BETTER_SEARCH_PAUSED, modelKey } from "../../packages/domain/better-search.ts";
import { embedFromEnv } from "../../packages/providers/embed-env.ts";
import { publishBetterSearchStatus } from "../../apps/worker/embed.ts";
import type { Principal } from "../../packages/contracts/index.ts";

const owner: Principal = { kind: "owner" };
const GENERIC = "Something went wrong preparing passages.";
const WORDS_ONLY = "Search is using words only right now.";
const SETUP = "Better search is not set up correctly on this computer. See Providers in the docs.";
const LIMITS_NOT_SET = "Set a daily limit and a per-preparation limit above $0 below.";
const NEEDS_LIMITS = "Better search with Cloudflare needs a daily limit and a per-preparation limit above $0 in Background help & spending.";
// Nothing the card shows may carry a service, model, credential, setting name or status code.
const LEAKS = /model|token|mcp|cloudflare|ollama|bge|BRAIN_|credential|endpoint|api\b|https?:|\b\d{3}\b/i;

const root = join(__dirname, "..", "..");
/** Each string below is quoted from the worker, provider, ledger or domain source: if one is reworded there, this test names it. */
function inSource(file: string, text: string) {
  expect(readFileSync(join(root, file), "utf8").replace(/\r\n/g, "\n"), `${file} no longer contains: ${text}`).toContain(text);
}

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.reverse()) fn();
  cleanup = [];
});

describe("Better search card copy", () => {
  it("turns each real worker problem into plain words, matched to its source string", () => {
    // [source file, fragment that must still be in it, the stored last problem, what the card says]
    const cases: [string, string, string, string][] = [
      ["packages/providers/embed.ts", "The search model answered ", "The search model answered 503.", "The search service did not answer."],
      ["packages/providers/embed.ts", "The search model answered ", "The search model answered 429.", "The search service did not answer."],
      ["packages/providers/embed.ts", "Better search could not sign in to the search service. Check its key.", "Better search could not sign in to the search service. Check its key.", "Better search could not sign in to the search service. Check its key."],
      ["packages/providers/embed.ts", "The search model did not answer in time.", "The search model did not answer in time.", "The search service did not answer."],
      ["packages/providers/embed.ts", "The search model request failed.", "The search model request failed.", "The search service did not answer."],
      ["packages/providers/embed.ts", "The search model reported an error.", "The search model reported an error.", "The search service did not answer."],
      ["packages/providers/embed.ts", "The search model used more than its estimate.", "The search model used more than its estimate.", "A preparation cost more than expected and was stopped."],
      ["apps/worker/embed.ts", "Better search could not reserve its spending.", "Better search could not reserve its spending.", "A preparation went over its spending limit."],
      ["packages/storage/spend.ts", "This job has reached its spending cap.", "Better search with Cloudflare is paused: This job has reached its spending cap.", "A preparation went over its spending limit."],
      ["packages/storage/spend.ts", "Today's spending cap is reached. Your original is saved.", "Better search with Cloudflare is paused: Today's spending cap is reached. Your original is saved.", "Today's spending limit was reached."],
      ["packages/domain/service.ts", NEEDS_LIMITS, NEEDS_LIMITS, LIMITS_NOT_SET],
      ["apps/worker/embed.ts", "The search service refused every passage. Better search will try again later.", "The search service refused every passage. Better search will try again later.", "The search service refused every passage. Better search will try again later."],
      ["apps/worker/embed.ts", "Better search is waiting before it tries again.", "Better search is waiting before it tries again.", "Better search is waiting a little before it tries again."],
      ["apps/worker/embed.ts", "refused by the search service and will be skipped until it changes.", "1 passage was refused by the search service and will be skipped until it changes.", "The search service refused a passage."],
      ["apps/worker/embed.ts", "refused by the search service and will be skipped until it changes.", "3 passages were refused by the search service and will be skipped until it changes.", "The search service refused some passages."],
      ["packages/domain/better-search.ts", "BiBrain's background worker is not running.", "BiBrain's background worker is not running.", "BiBrain's background helper is not running."],
      ["packages/domain/better-search.ts", "Better search paused: the service is not answering.", BETTER_SEARCH_PAUSED, BETTER_SEARCH_PAUSED],
      ["packages/domain/better-search.ts", "The search model changed. Choose Better search again.", "The search model changed. Choose Better search again.", "The search setup changed. Choose Better search again."],
      ["apps/worker/embed.ts", "Better search could not prepare a batch.", "Better search could not prepare a batch.", GENERIC],
      ["packages/storage/spend.ts", "The accounting time zone is frozen and cannot change without an explicit migration.", "Better search with Cloudflare is paused: The accounting time zone is frozen and cannot change without an explicit migration.", GENERIC],
    ];
    for (const [file, fragment, raw, plain] of cases) {
      inSource(file, fragment);
      expect(plainSearchProblem(raw), raw).toBe(plain);
      expect(plain).not.toMatch(LEAKS);
    }
    expect(plainSearchProblem("Cloudflare returned something odd for @cf/baai/bge-m3 (HTTP 418)")).toBe(GENERIC);
    expect(plainSearchProblem("")).toBe(GENERIC);
    expect(plainSearchProblem(null)).toBe(GENERIC);
  });

  it("shows one closed sentence for every setup reason the environment or the provider can produce", () => {
    const bases: Record<string, string>[] = [
      {},
      { BRAIN_EMBED_PROVIDER: "openai" },
      { BRAIN_EMBED_PROVIDER: "ollama", BRAIN_EMBED_MODEL: "bad model!" },
      { BRAIN_EMBED_PROVIDER: "ollama", BRAIN_EMBED_ENDPOINT: "http://example.com/api/embed" },
      { BRAIN_EMBED_PROVIDER: "ollama", BRAIN_EMBED_ENDPOINT: "http://user:pw@127.0.0.1:11434/api/embed" },
      { BRAIN_EMBED_PROVIDER: "cloudflare", BRAIN_EMBED_MODEL: "other-model" },
      { BRAIN_EMBED_PROVIDER: "cloudflare", BRAIN_EMBED_ENDPOINT: "http://example.com/x" },
      { BRAIN_EMBED_PROVIDER: "cloudflare", BRAIN_CLOUDFLARE_ACCOUNT_ID: "nope", BRAIN_DECISION_API_KEY: "k" },
      { BRAIN_EMBED_PROVIDER: "cloudflare", BRAIN_CLOUDFLARE_ACCOUNT_ID: "0123456789abcdef0123456789abcdef" },
    ];
    const reasons = bases.map((env) => embedFromEnv(env)).flatMap((r) => (r.config ? [] : [r.reason]));
    expect(reasons.length).toBe(bases.length);
    expect(new Set(reasons).size).toBeGreaterThan(6);
    for (const reason of reasons) {
      expect(plainSearchReason(reason), reason).toBe(SETUP);
      expect(plainSearchProblem(reason), reason).toBe(SETUP);
    }
    // The strings the provider refuses a configuration with, read from the source.
    for (const text of [
      "The better-search endpoint is not a valid URL.",
      "The better-search endpoint may not carry credentials or a query.",
      "Better search with Ollama must point at an Ollama on this computer.",
      "Better search with Cloudflare must use api.cloudflare.com.",
      "A server-side credential is required for Cloudflare.",
      "The better-search model name is not allowed.",
      "The better-search timeout is out of range.",
      "The better-search response bound is out of range.",
      "The better-search price is invalid.",
    ]) {
      inSource("packages/providers/embed.ts", text);
      expect(plainSearchReason(text), text).toBe(SETUP);
    }
  });

  it("never lets a reason the domain produces leak, and falls back to words only for anything else", () => {
    const dir = mkdtempSync(join(tmpdir(), "better-search-copy-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const store = new Storage(join(dir, "brain.sqlite"));
    cleanup.push(() => store.close());
    const time = { now: new Date("2026-10-25T09:00:00.000Z") };
    const brain = new Brain(store, () => time.now);
    const seen: string[] = [];
    const record = () => seen.push(brain.betterSearch(owner).reason);
    publishBetterSearchStatus(brain, { configured: true, provider: "ollama", model: "m1", key: modelKey("ollama", "m1"), label: "Ollama on this computer" });
    store.set("worker_heartbeat", brain.now());
    brain.setBetterSearch(owner, { mode: "ollama" });
    time.now = new Date("2026-10-25T09:10:00.000Z");
    record(); // the worker's heartbeat is stale
    store.set("worker_heartbeat", brain.now());
    publishBetterSearchStatus(brain, { configured: true, provider: "ollama", model: "m2", key: modelKey("ollama", "m2"), label: "Ollama on this computer" });
    record(); // the service's model changed
    publishBetterSearchStatus(brain, { configured: true, provider: "cloudflare", model: "x", key: modelKey("cloudflare", "x"), label: "Cloudflare" });
    record(); // another service published
    publishBetterSearchStatus(brain, { configured: false, reason: "Add your Cloudflare account id (32 letters and numbers) to turn on better search with Cloudflare." });
    record(); // a setup problem
    store.set("better_search_status", null);
    record(); // nothing published yet
    expect(seen.length).toBe(5);
    for (const reason of seen) expect(plainSearchReason(reason), reason).not.toMatch(LEAKS);
    expect(plainSearchReason(seen[0])).toBe("BiBrain's background helper is not running.");
    expect(plainSearchReason(seen[1])).toBe("The search setup changed. Choose Better search again.");
    expect(plainSearchReason(seen[2])).toBe(SETUP);
    expect(plainSearchReason(seen[3])).toBe(SETUP);
    expect(plainSearchReason(seen[4])).toBe("Waiting for BiBrain's background helper to start.");
    expect(plainSearchReason(BETTER_SEARCH_PAUSED)).toBe(BETTER_SEARCH_PAUSED);
    inSource("packages/domain/service.ts", NEEDS_LIMITS);
    expect(plainSearchReason(NEEDS_LIMITS)).toBe(LIMITS_NOT_SET);
    expect(plainSearchReason("Something nobody wrote for, HTTP 500 at api.cloudflare.com with BRAIN_DECISION_API_KEY")).toBe(WORDS_ONLY);
    expect(plainSearchReason("")).toBe(WORDS_ONLY);
  });

  it("states the cost for English text and says other languages can cost more", () => {
    const src = readFileSync(join(root, "apps/web/src.tsx"), "utf8");
    expect(src).toContain("About 1 cent for every 250,000 words of English text; other languages can cost more, counted against your daily limit.");
    expect(src).not.toContain("500,000");
  });

  it("lets the saved choice be saved again only when the service's key moved", () => {
    const base = { mode: "ollama", key: "ollama:a:none", status: { key: "ollama:a:none" } };
    expect(betterSearchCanSave(base, "ollama")).toBe(false);
    expect(betterSearchCanSave(base, "off")).toBe(true);
    expect(betterSearchCanSave({ ...base, status: { key: "ollama:b:none" } }, "ollama")).toBe(true);
    expect(betterSearchCanSave({ mode: "off", key: null, status: { key: "ollama:b:none" } }, "off")).toBe(false);
    expect(betterSearchCanSave({ ...base, status: null }, "ollama")).toBe(false);
  });
});
