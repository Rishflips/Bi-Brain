# Provider interfaces

The product runtime is model-agnostic. The owner's development orchestration choices (parent review, Astra Medium advice only, Ollama DeepSeek execution) do not select Bi Brain's runtime providers.

## Adapter boundaries

Current reasoning: `PreparedProvider.prepareCall(input)` synchronously freezes request/configuration and returns identity, a reservation bound and one-shot `execute(signal)`. Execution returns accounting separately from validated output. `packages/providers/prepared.ts` contains the Responses adapter; the legacy `openai.ts` path is removed.

Current decision transport: the legacy `DecisionProvider.upperBound(input)` / `decide(input, signal)` in `system-one.ts` remains compatible. `PreparedDecisionProvider` in `prepared-decision.ts` provides a separate one-shot contract for the same bounded TypeSafe/Cloudflare request format; it deliberately exposes no `decide` shortcut. Decision policy, worker routing and managed decision accounting/activation are not integrated. General triage/connector interfaces remain design targets, not proof of installed integrations.

Provider calls are server/worker only. No API keys in browser code, context packages, or agent prompts.

## Modes

### Demo

Synthetic fixture content and deterministic results. Label every screen clearly as a sample. Do not mix demo objects with private user data.

### Extractive local preview

Works with no model key. Save original text, show selected original passages, allow manual title/brief editing, search, and copy/download.
Label it Extractive preview. Do not claim it inferred goals, found contradictions, or generated an intelligent plan.
Preserve source references. It is a useful degraded mode, not a simulated production AI run.

### Connected model

Implement one real reasoning adapter after storage and queue foundations. Select the provider using available legitimate credentials and official documentation, without exposing keys or silently causing paid usage.
Make model ID configurable. Confirm structured output support and usage accounting against the chosen API.
Record provider/model/prompt versions with results.

The local worker reserves one stable reasoning dispatch per job, marks it before network I/O and settles validated known usage before checking whether output may publish. Invalid output or later cancellation cannot erase a known charge. Missing/unaccepted usage or returned-model pricing leaves an unresolved hold; explicit retry and restart never resend that dispatch. Unknown is not zero. Legacy reservations remain counted alongside new dispatches, including unresolved holds from older days. A durable overrun/recovery block prevents ordinary preferences from re-enabling paid work while keeping labeled extractive processing useful. Central managed accounting, reconciliation and the shared server/worker activation path have synthetic local and merged-main CI verification. Managed reasoning remains default-off behind separate audited profile, deployment, worker readiness, account policy, consent and financial gates; a configured key or allowance does not enable it. The profile admits OpenAI reasoning only, not decision calls. No owner account or real provider has been activated.

Versioned prices must match operator-accepted concrete returned models; the default accepts only the requested model identifier. Unexpected aliases retain observed tokens but leave money unknown. The byte-based reservation covers the complete serialized Responses request plus a 4096-byte framing allowance and the configured output limit; it is an explicit adapter assumption, not a guarantee for arbitrary models/providers or verified invoice pricing. Requests are bounded to 1 MiB; output defaults to 2000 tokens (operator range 1–8000). No live-provider quality or pricing result is implied by fixture tests.

### Permanent System 1 capability

The 2026-10-16 owner direction makes the bounded decision layer a core release requirement, not a later optional feature. Rules are first; use a decision provider only at justified judgment points, and deeper reasoning for open-ended synthesis. A replaceable Jev/Clef-shaped transport is not an evaluated policy or proof of live integration. Self-hosted operation retains an honest degraded path when the provider is not configured.

Do not hardcode unverified pricing, speed, probability calibration, or model capabilities from brainstorming notes. Benchmark suppression errors as well as accepted classifications; initially keep uncalibrated judgments advisory rather than silently suppressing useful work. Confidence is not authorization, semantic proof, or permission to accept claims.

Reserve each provider dispatch and enforce aggregate job/tenant/service limits before integrating decision calls with deeper reasoning. Existing job-keyed reservations are not sufficient to account for multiple paid stages. Preserve uncertain usage after ambiguous failures. No external provider fallback without explicit consent, no model calls in storage transactions, and no classifier-driven loss of saved originals.

### Prepared decision contract (not wired into production)

`new PreparedDecisionProvider(config, fetcher?).prepareDecision(input)` performs no
I/O. Configuration is defensively copied at construction; preparation fixes the
question, exact UTF-8 request bytes, accepted returned models, operator pricing
and reservation bound. Its frozen identity contains request/options/config
hashes, policy/schema versions and byte limits, never the credential. Changing a
credential alone does not change the configuration hash.

`execute(signal)` consumes the call even on pre-send cancellation. It permits
one fetch attempt, with a whole-request deadline and bounded response body, and
returns accounting independently of output:

- `not_dispatched` means the adapter did not invoke fetch; accounting remains
  unknown rather than a fabricated known zero.
- `attempted` means bytes may have reached the provider. Transport failure,
  invalid usage or an unaccepted returned model leaves money unknown.
- Accepted-model, valid usage retains its known integer-micro-USD charge even
  when the answer is malformed or cost exceeds the reservation. The actual
  accepted returned-model ID is retained, including aliases; refused output
  cannot erase a charge.

Throws from fetch/body streams cannot assert known accounting or no-dispatch
status. Error output is static; response bodies and credentials are not echoed.
Choices/probabilities must match the closed prepared option set; probabilities
remain uncalibrated and advisory. There is no retry, fallback or repair.

The adapter's one-shot latch is **instance-local**, not durable deduplication or
spending authority. A future coordinator must obtain fresh financial marks and
enforce consent/authorization before I/O. No worker, HTTP or UI imports this
module yet. Synthetic transport tests establish these contract properties, not
live endpoint compatibility, real pricing, semantic quality or a completed G4.

## Output contract

Require JSON matching an explicit schema. Factual items need evidence IDs/versions and exact quotes. Unknowns and hypotheses are separate fields.
Reject invented source IDs, cross-project references, stale versions, malformed enums, oversized outputs, and unverifiable quoted spans.
Current prepared calls never retry, fall back or make repair calls. Any future repair strategy needs its own explicitly admitted dispatch and consent/accounting design; it cannot be hidden inside a one-shot execution.

## Prompt boundary

System instructions define the task and allowed output. Source text is delimited untrusted data. Instructions inside a source cannot alter tool access, budgets, or system rules.
Ask for concise rationale, not chain-of-thought.
The model can propose a revision; domain code performs state changes.

## Evaluation

Use deterministic fake adapters for unit tests and failure injection.
Use live providers only in opt-in, budgeted evaluation runs.
Report citation validity, semantic support, temporal reasoning, abstention, latency, input/output usage, and cost.
Do not substitute fixture success for live-provider quality evidence.
