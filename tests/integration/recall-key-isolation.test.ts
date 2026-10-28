import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") || path.endsWith(".tsx") || path.endsWith(".mjs") ? [path] : [];
  });
}
describe("the Clef key and the better-search setup stay in the worker", () => {
  it("no server or domain file names the key variables, and run.mjs strips them from the server child", () => {
    for (const dir of ["apps/server", "packages/domain", "apps/mcp", "apps/cli", "apps/web"])
      for (const file of files(dir)) {
        const text = readFileSync(file, "utf8");
        expect(text, file).not.toMatch(/BRAIN_DECISION_API_KEY|OLLAMA_API_KEY|BRAIN_CLOUDFLARE_ACCOUNT_ID|BRAIN_EMBED_/);
      }
    const run = readFileSync("scripts/run.mjs", "utf8");
    expect(run).toContain("if (!isWorker(args)) delete env.BRAIN_DECISION_API_KEY;");
    expect(run).toContain("if (!isWorker(args)) delete env.OLLAMA_API_KEY;");
  });
});
