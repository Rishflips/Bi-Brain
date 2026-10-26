import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const output = resolve("data/brain-eval-results.json");
mkdirSync(resolve("data"), { recursive: true });
const vitest = resolve("node_modules/vitest/vitest.mjs");
const run = spawnSync(
  process.execPath,
  [vitest, "run", "tests/eval", "--reporter=json", `--outputFile=${output}`],
  {
    cwd: process.cwd(),
    stdio: "inherit",
    windowsHide: true,
  },
);
const raw = JSON.parse(readFileSync(output, "utf8"));
const recall = existsSync(resolve("data/recall-eval-metrics.json")) ? JSON.parse(readFileSync(resolve("data/recall-eval-metrics.json"), "utf8")) : null;
if (!raw.numTotalTests) throw new Error("Brain eval selected no fixtures.");
const report = {
  schema_version: 1,
  fixture_version: 2,
  generated_at: new Date().toISOString(),
  mode: "synthetic deterministic offline; no live-provider or native-client quality evidence",
  total: raw.numTotalTests,
  passed: raw.numPassedTests,
  failed: raw.numFailedTests,
  fixture_size: {
    scenarios: raw.numTotalTests,
    versioned_source: "tests/eval/fixtures-v1.json",
    recall_golden: "tests/eval/recall-golden-v1.json",
  },
  observed_controls: {
    false_positives: raw.numFailedTests ? "see failed assertions" : 0,
    false_negatives: raw.numFailedTests ? "see failed assertions" : 0,
    abstentions: "one unrelated-intent no-action control asserted",
    note: "Tiny synthetic set; not a calibrated population error rate.",
  },
  latency: {
    measured_assertion_ms: raw.testResults
      .flatMap((suite) => suite.assertionResults)
      .reduce((sum, test) => sum + (test.duration ?? 0), 0),
    per_assertion_ms_in_results: true,
  },
  cost: { provider_calls: 0, micro_usd: 0, live_cost_unmeasured: true },
  supported_client_coverage: ["local enforced wrapper"],
  recall: recall ?? "not run",
  results: raw.testResults.flatMap((suite) =>
    suite.assertionResults.map((test) => ({
      name: test.fullName,
      status: test.status,
      duration_ms: test.duration,
      failure_messages: test.failureMessages,
    })),
  ),
  coverage: {
    unprompted_open_loop: "simulated clock and offline fallback",
    retired_fact_withholding: "service, answer, and enforced pack",
    contradiction_flag: "typed overlapping status",
    injected_pack_use: "local wrapper; no native client",
    forget_proof: "managed vault, SQLite projection, local backup",
    no_action_control: "unrelated intent produces no review prompt",
    recall_gates: "recall@5 ≥ 0.90, MRR ≥ 0.75, no_match ≥ 0.85, replaced/stale/authorization/generic-level hard gates, p95 < 300 ms; asserted in tests/eval/recall.test.ts",
  },
};
writeFileSync(output, JSON.stringify(report, null, 2));
console.log(`Brain eval: ${report.passed}/${report.total} passed; ${output}`);
process.exit(run.status ?? 1);
