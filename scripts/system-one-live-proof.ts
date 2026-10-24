/**
 * OWNER-RUN live proof of sorting help against the real service. It SPENDS QUOTA
 * (Ollama Cloud or Cloudflare Workers AI): three small requests with synthetic notes.
 * Agents and CI never run it; they use a loopback fake server instead.
 *
 * Put BRAIN_SYSTEM1_LIVE=1 on its own line in .env and run `npm run proof:sorting`, or in
 * PowerShell: $env:BRAIN_SYSTEM1_LIVE=1; npm run proof:sorting
 * Remove the line from .env afterwards so it is never left on.
 *
 * Configure it like the app does (see docs/PROVIDERS.md): BRAIN_SYSTEM1_PROVIDER plus the key,
 * and for Cloudflare BRAIN_CLOUDFLARE_ACCOUNT_ID. It prints answers, model, input tokens and cost,
 * and never the key or the account id. Exit 0 only when all three answers validate.
 */
import { buildQuestions, type S1Context } from "../packages/domain/system-one.ts";
import { prepareAsk } from "../packages/providers/system-one-ask.ts";
import { systemOneFromEnv } from "../packages/providers/system-one-env.ts";

try {
  process.loadEnvFile(".env");
} catch (error) {
  // A missing file is normal. A malformed one gets one line and no contents.
  if ((error as NodeJS.ErrnoException)?.code !== "ENOENT")
    console.log("Could not read .env; continuing with the environment as is.");
}

async function run(): Promise<number> {
  if (process.env.BRAIN_SYSTEM1_LIVE !== "1") {
    console.log("This proof sends three real requests and spends your sorting-help quota.");
    console.log("Run it yourself: put BRAIN_SYSTEM1_LIVE=1 on its own line in .env and run npm run proof:sorting,");
    console.log("or in PowerShell: $env:BRAIN_SYSTEM1_LIVE=1; npm run proof:sorting. Remove the line from .env afterwards.");
    return 0;
  }

  const setup = systemOneFromEnv(process.env);
  if (!setup.config) {
    console.error(`Not ready: ${setup.reason}`);
    return 2;
  }
  const { config, label } = setup;
  let host = "";
  try {
    host = new URL(config.endpoint).hostname;
  } catch {
    /* resolveAskConfig already validated the endpoint. */
  }
  if (["127.0.0.1", "localhost", "[::1]", "::1"].includes(host)) {
    console.error("Not a live proof: the endpoint is this computer. Remove BRAIN_SYSTEM1_ENDPOINT to test the real service.");
    return 2;
  }

  const projects = [
    { id: "inbox", title: "Inbox" },
    { id: "northstar", title: "Northstar" },
    { id: "hydra", title: "Hydra" },
  ];
  const notes: { name: string; ctx: S1Context }[] = [
    { name: "A decision, in the Inbox", ctx: { note: "We decided Northstar ships with one plan.", title: "Plan decision", project_id: "inbox", projects, hasCurrentFacts: false } },
    { name: "An open question, in Northstar", ctx: { note: "Still unclear: who owns the launch email?", title: "Launch email", project_id: "northstar", projects, hasCurrentFacts: true } },
    { name: "Small talk, in Hydra", ctx: { note: "Lunch was good.", title: "Lunch", project_id: "hydra", projects, hasCurrentFacts: false } },
  ];
  const estimated = config.provider === "ollama";
  console.log(`Service: ${label}  model: ${config.model}`);

  let passed = 0;
  for (const { name, ctx } of notes) {
    console.log(`\n${name}`);
    try {
      const { state, questions } = buildQuestions(ctx);
      const result = await prepareAsk(config, state, questions).execute(new AbortController().signal);
      const asked = questions.map((q) => q.id).sort().join(",");
      const got = result.answers.map((a) => a.id).sort().join(",");
      if (asked !== got) throw new Error(`Answered ${got || "nothing"} but asked ${asked}.`);
      for (const a of result.answers) {
        if (a.type === "choice") {
          const odds = Object.entries(a.probabilities).map(([id, p]) => `${id} ${p.toFixed(2)}`).join(", ");
          console.log(`  ${a.id}: ${a.choice} (confidence ${a.confidence.toFixed(2)}; ${odds})`);
        } else console.log(`  ${a.id}: ${a.probability.toFixed(2)}`);
      }
      console.log(`  model ${result.model}, input_tokens ${result.usage.input_tokens}, cost ${result.cost_micro_usd} micro-USD${estimated ? " (estimated)" : ""}`);
      passed += 1;
    } catch (error) {
      console.log(`  FAILED: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }
  console.log(`\n${passed} of ${notes.length} answers validated.`);
  return passed === notes.length ? 0 : 1;
}

// exitCode, not exit(): piped output is flushed before the process ends.
process.exitCode = await run();
