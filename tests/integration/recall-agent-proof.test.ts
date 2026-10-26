import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

describe("scripts/recall-agent-proof.ts", () => {
  it("refuses to run without its explicit flag and creates nothing", () => {
    const before = existsSync(resolve("test-results")) ? readdirSync(resolve("test-results")).filter((n) => n.startsWith("recall-")) : [];
    const env = { ...process.env };
    delete env.BRAIN_RECALL_PROOF;
    const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/recall-agent-proof.ts", "claude"], { encoding: "utf8", env, timeout: 60_000 });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("Explicitly set BRAIN_RECALL_PROOF=1 and choose codex or claude. This uses native subscription quota.");
    const after = existsSync(resolve("test-results")) ? readdirSync(resolve("test-results")).filter((n) => n.startsWith("recall-")) : [];
    expect(after).toEqual(before);
    const wrongClient = spawnSync(process.execPath, ["--import", "tsx", "scripts/recall-agent-proof.ts", "cursor"], { encoding: "utf8", env: { ...env, BRAIN_RECALL_PROOF: "1" }, timeout: 60_000 });
    expect(wrongClient.status).not.toBe(0);
    expect(wrongClient.stderr).toContain("choose codex or claude");
  });
});
