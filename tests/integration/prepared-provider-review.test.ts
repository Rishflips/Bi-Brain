import { expect, it } from "vitest";
import { PreparedReasoningProvider, type ReasoningConfig } from "../../packages/providers/prepared.ts";
import type { Source } from "../../packages/contracts/index.ts";

const source = (): Source => ({
  id: "synthetic-source", project_id: "inbox", version: 1,
  title: "Synthetic evidence", body: "SYNTHETIC evidence", visibility: "project", state: "active",
  captured_at: "2026-10-16T09:00:00Z", origin: "owner",
});
const evidence = () => ({ source_id: "synthetic-source", source_version: 1, start: 0, end: 9, quote: "SYNTHETIC" });
const config = (): ReasoningConfig => ({
  model: "synthetic-model", accepted_response_models: ["synthetic-model"], key: "synthetic-key",
  price: { version: "synthetic-v1", input_micro_usd_per_million: 1_000_000, output_micro_usd_per_million: 2_000_000 },
});
const fetcher = (output: unknown): typeof fetch => (async () => new Response(JSON.stringify({
  model: "synthetic-model", usage: { input_tokens: 3, output_tokens: 2 },
  output: [{ content: [{ type: "output_text", text: JSON.stringify(output) }] }],
}))) as typeof fetch;
const expectKnownRejection = (result: Awaited<ReturnType<ReturnType<PreparedReasoningProvider["prepareCall"]>["execute"]>>) => {
  expect(result.accounting).toMatchObject({ state: "known", cost_micro_usd: 7 });
  expect(result.output.ok).toBe(false);
};

it.each(["supported", "user_assertion"])("retains charges but rejects an unevidenced %s brief assertion", async (status) => {
  const provider = new PreparedReasoningProvider(config(), fetcher({
    items: [{ text: "An unsupported invented fact", epistemic_status: status, evidence: [] }], unknowns: [],
  }));
  expectKnownRejection(await provider.prepareCall({ kind: "brief", sources: [source()] }).execute(new AbortController().signal));
});

it.each([
  { outcome: "proposal", artifact: "An unsupported proposed plan", evidence: [] },
  { outcome: "proposal", artifact: "   ", evidence: [evidence()] },
  { outcome: "abstain", artifact: "", evidence: [{ ...evidence(), source_id: "invented" }] },
])("retains charges but rejects invalid goal output %#", async (output) => {
  const provider = new PreparedReasoningProvider(config(), fetcher(output));
  expectKnownRejection(await provider.prepareCall({
    kind: "goal", goal: { title: "Synthetic goal", success_criteria: "Use evidence", plan: "" }, sources: [source()],
  }).execute(new AbortController().signal));
});

it("snapshots prices, credentials and evidence validation context before execution", async () => {
  const settings = config();
  const original = source();
  let authorization: string | null = null;
  const reply = fetcher({ items: [{ text: "An evidenced assertion", epistemic_status: "supported", evidence: [evidence()] }], unknowns: [] });
  const provider = new PreparedReasoningProvider(settings, (async (url, init) => {
    authorization = new Headers(init?.headers).get("authorization");
    return reply(url, init);
  }) as typeof fetch);
  const call = provider.prepareCall({ kind: "brief", sources: [original] });
  settings.key = "synthetic-replacement";
  settings.price!.input_micro_usd_per_million = 99_000_000;
  settings.accepted_response_models!.splice(0, 1, "other-model");
  original.body = "Changed after preparation";
  const result = await call.execute(new AbortController().signal);
  expect(authorization).toBe("Bearer synthetic-key");
  expect(result.accounting).toMatchObject({ state: "known", cost_micro_usd: 7 });
  expect(result.output.ok).toBe(true);
});
