import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../../packages/storage/index.ts";
import { Brain } from "../../packages/domain/service.ts";
import type { Principal } from "../../packages/contracts/index.ts";

const owner: Principal = { kind: "owner" };
let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.reverse()) fn();
  cleanup = [];
});
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "s1-status-test-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const s = new Storage(join(dir, "brain.sqlite"), { vault: join(dir, "vault") });
  cleanup.push(() => {
    try {
      s.close();
    } catch {}
  });
  return new Brain(s, () => new Date("2026-10-24T09:00:00Z"));
}

describe("sorting help status", () => {
  it("says the worker has not reported yet, and ignores this process's environment", () => {
    const previous = process.env.BRAIN_SYSTEM1_PROVIDER;
    process.env.BRAIN_SYSTEM1_PROVIDER = "cloudflare";
    try {
      expect(setup().systemOneStatus(owner)).toEqual({
        configured: false,
        label: null,
        reason: "Sorting help status appears once BiBrain's background worker starts.",
        wanted: false,
        answers: 0,
        reviewed: 0,
        last_error: null,
      });
    } finally {
      if (previous === undefined) delete process.env.BRAIN_SYSTEM1_PROVIDER;
      else process.env.BRAIN_SYSTEM1_PROVIDER = previous;
    }
  });

  it("reports what the worker published and whether the owner has asked for it", () => {
    const b = setup();
    b.store.set("system_one_status", { configured: true, label: "Cloudflare (fast)", updated_at: "2026-10-24T08:59:00Z", last_error: "The sorting service answered 503." });
    expect(b.systemOneStatus(owner)).toMatchObject({ configured: true, label: "Cloudflare (fast)", reason: null, wanted: false, last_error: "The sorting service answered 503." });
    b.store.set("preferences", { ...b.prefs(owner), enabled: true, decision_provider_enabled: true, daily_cap_micro_usd: 50_000, per_job_cap_micro_usd: 5_000 });
    expect(b.systemOneStatus(owner).wanted).toBe(true);
    b.store.set("system_one_status", { configured: false, reason: "Add your Ollama API key to turn on sorting help.", updated_at: "2026-10-24T09:00:00Z" });
    expect(b.systemOneStatus(owner)).toMatchObject({ configured: false, label: null, reason: "Add your Ollama API key to turn on sorting help." });
  });

  it("is for the owner only", () => {
    const b = setup();
    expect(() => b.systemOneStatus({ kind: "agent" } as unknown as Principal)).toThrow();
  });
});
