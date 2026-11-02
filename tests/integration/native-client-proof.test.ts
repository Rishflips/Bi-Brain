import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { isAgentRecallStep } from "../../scripts/proof-steps.ts";

const native = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((n) => n.startsWith("native-") || n.startsWith("bibrain-native-ws-")) : []);

describe("the native proof's step counter", () => {
  it("counts the agent's own brain_recall call and never the prompt hook's push", () => {
    expect(isAgentRecallStep("/api/v1/agent/recall")).toBe(true);
    expect(isAgentRecallStep("/api/v1/agent/recall?query=launch%20color")).toBe(true);
    expect(isAgentRecallStep("/api/v1/agent/recall-push")).toBe(false);
    expect(isAgentRecallStep("/api/v1/agent/recall/")).toBe(false);
    expect(isAgentRecallStep("/api/v1/agent/open?id=x")).toBe(false);
  });
});

describe("scripts/native-client-proof.ts", () => {
  it("refuses to run without its explicit flag, refuses an unknown client, and creates nothing", () => {
    const before = [...native(resolve("test-results")), ...native(tmpdir())];
    const env = { ...process.env };
    delete env.BRAIN_NATIVE_PROOF;
    const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/native-client-proof.ts", "codex"], { encoding: "utf8", env, timeout: 60_000 });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("Explicitly set BRAIN_NATIVE_PROOF=1 and choose codex or claude. This uses native subscription quota.");
    const wrongClient = spawnSync(process.execPath, ["--import", "tsx", "scripts/native-client-proof.ts", "cursor"], { encoding: "utf8", env: { ...env, BRAIN_NATIVE_PROOF: "1" }, timeout: 60_000 });
    expect(wrongClient.status).not.toBe(0);
    expect(wrongClient.stderr).toContain("choose codex or claude");
    expect([...native(resolve("test-results")), ...native(tmpdir())]).toEqual(before);
  });
});
