import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("the better-search live proof", () => {
  it("refuses to run without BRAIN_SEARCH_LIVE=1, prints the owner's instructions, sends nothing and is wired as proof:search", () => {
    const env = { ...process.env };
    // Set to empty rather than deleted: Node's loadEnvFile never overrides a variable that is already set, so a .env line cannot switch the live proof on under this test.
    env.BRAIN_SEARCH_LIVE = "";
    env.BRAIN_EMBED_PROVIDER = "cloudflare";
    env.BRAIN_CLOUDFLARE_ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
    env.BRAIN_DECISION_API_KEY = ["not", "a", "real", "token"].join("-");
    const run = spawnSync(process.execPath, ["--import", "tsx", "scripts/better-search-proof.ts"], { env, encoding: "utf8", windowsHide: true, timeout: 60_000 });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("BRAIN_SEARCH_LIVE=1");
    expect(run.stdout).toContain("npm run proof:search");
    expect(run.stdout + run.stderr).not.toContain(env.BRAIN_DECISION_API_KEY);
    expect(run.stdout + run.stderr).not.toContain(env.BRAIN_CLOUDFLARE_ACCOUNT_ID);
    expect(existsSync(resolve("data/better-search-proof.json"))).toBe(false);
    const pkg = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
    expect(pkg.scripts["proof:search"]).toBe("node --import tsx scripts/better-search-proof.ts");
  });
});
