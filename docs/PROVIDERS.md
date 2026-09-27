# Provider interfaces

The product runtime is model-agnostic. The owner requested GPT-6 Sol as the coding model, not as a mandatory paid backend for Bi Brain.

## Adapter boundaries

TriageProvider.classify(event, candidates, limits) → typed labels, uncertainty, usage.
ReasoningProvider.prepare(task, evidence, output_schema, limits, abort_signal) → typed result, usage, provider metadata.
ConnectorAdapter.pull(cursor, granted_scope, limits) → bounded events and next cursor.

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

### Optional System 1 backend

Rules are first. A Jev-shaped adapter is optional after an evaluation corpus exists. Do not hardcode unverified pricing, speed, probability calibration, or model capabilities from brainstorming notes.
Benchmark suppression errors as well as accepted classifications.

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
