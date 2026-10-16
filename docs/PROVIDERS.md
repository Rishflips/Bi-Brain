# Provider interfaces

The product runtime is model-agnostic. The owner's development orchestration choices (parent review, Astra Medium advice only, Ollama DeepSeek execution) do not select Bi Brain's runtime providers.

## Adapter boundaries

Current reasoning: `PreparedProvider.prepareCall(input)` synchronously freezes request/configuration and returns identity, a reservation bound and one-shot `execute(signal)`. Execution returns accounting separately from validated output. `packages/providers/prepared.ts` contains the Responses adapter; the legacy `openai.ts` path is removed.

Current decision transport: `DecisionProvider.upperBound(input)` and `decide(input, signal)` in `system-one.ts`. Decision policy and worker routing are not yet integrated. General triage/connector interfaces remain design targets, not proof of installed integrations.

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

The local worker reserves one stable reasoning dispatch per job, marks it before network I/O and settles validated known usage before checking whether output may publish. Invalid output or later cancellation cannot erase a known charge. Missing/unaccepted usage or returned-model pricing leaves an unresolved hold; explicit retry and restart never resend that dispatch. Unknown is not zero. Legacy reservations remain counted alongside new dispatches, including unresolved holds from older days. A durable overrun/recovery block prevents ordinary preferences from re-enabling paid work while keeping labeled extractive processing useful. Central managed account/service accounting and Phase 1 reconciliation safeguards are verified locally and in merged-main CI. Managed paid processing still remains denied until the separately approved shared server/worker activation path is implemented and verified; a configured key or allowance does not enable it.

Versioned prices must match operator-accepted concrete returned models; the default accepts only the requested model identifier. Unexpected aliases retain observed tokens but leave money unknown. The byte-based reservation covers the complete serialized Responses request plus a 4096-byte framing allowance and the configured output limit; it is an explicit adapter assumption, not a guarantee for arbitrary models/providers or verified invoice pricing. Requests are bounded to 1 MiB; output defaults to 2000 tokens (operator range 1–8000). No live-provider quality or pricing result is implied by fixture tests.

### Permanent System 1 capability

The 2026-10-16 owner direction makes the bounded decision layer a core release requirement, not a later optional feature. Rules are first; use a decision provider only at justified judgment points, and deeper reasoning for open-ended synthesis. A replaceable Jev/Clef-shaped transport is not an evaluated policy or proof of live integration. Self-hosted operation retains an honest degraded path when the provider is not configured.

Do not hardcode unverified pricing, speed, probability calibration, or model capabilities from brainstorming notes. Benchmark suppression errors as well as accepted classifications; initially keep uncalibrated judgments advisory rather than silently suppressing useful work. Confidence is not authorization, semantic proof, or permission to accept claims.

Reserve each provider dispatch and enforce aggregate job/tenant/service limits before integrating decision calls with deeper reasoning. Existing job-keyed reservations are not sufficient to account for multiple paid stages. Preserve uncertain usage after ambiguous failures. No external provider fallback without explicit consent, no model calls in storage transactions, and no classifier-driven loss of saved originals.

## Output contract

Require JSON matching an explicit schema. Factual items need evidence IDs/versions and exact quotes. Unknowns and hypotheses are separate fields.
Reject invented source IDs, cross-project references, stale versions, malformed enums, oversized outputs, and unverifiable quoted spans.
One bounded repair call is permitted inside the same job budget. Otherwise abstain with a readable receipt.

## Prompt boundary

System instructions define the task and allowed output. Source text is delimited untrusted data. Instructions inside a source cannot alter tool access, budgets, or system rules.
Ask for concise rationale, not chain-of-thought.
The model can propose a revision; domain code performs state changes.

## Evaluation

Use deterministic fake adapters for unit tests and failure injection.
Use live providers only in opt-in, budgeted evaluation runs.
Report citation validity, semantic support, temporal reasoning, abstention, latency, input/output usage, and cost.
Do not substitute fixture success for live-provider quality evidence.
