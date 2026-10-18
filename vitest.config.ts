import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts", "tests/eval/**/*.test.ts"],
    fileParallelism: false,
    // Real Windows integration cases exercise child processes, SQLite, Git and
    // cold backup/restore. Keep them bounded without misclassifying ordinary
    // host filesystem latency as a product failure.
    testTimeout: 15_000,
  },
});
