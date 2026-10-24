# Provider interfaces

The product runtime is model-agnostic. The owner's development orchestration choices (parent review, Astra Medium advice only, Ollama DeepSeek execution) do not select Bi Brain's runtime providers.

## Adapter boundaries

Current reasoning: `PreparedProvider.prepareCall(input)` synchronously freezes request/configuration and returns identity, a reservation bound and one-shot `execute(signal)`. Execution returns accounting separately from validated output. `packages/providers/prepared.ts` contains the Responses adapter; the legacy `openai.ts` path is removed.

Current decision transport: the legacy `DecisionProvider.upperBound(input)` / `decide(input, signal)` in `system-one.ts` remains compatible. `PreparedDecisionProvider` in `prepared-decision.ts` provides a separate one-shot contract for the same bounded TypeSafe/Cloudflare request format; it deliberately exposes no `decide` shortcut. S1's separate default-off managed activation/accounting/consent and S2's advisory worker are locally accepted with synthetic transport, including actual worker-process restart/readiness tests. This is not live endpoint, pricing or semantic-quality verification. General triage/connector interfaces remain design targets, not proof of installed integrations.

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

### Sorting help (System 1, local)

Sorting help is the local, advisory use of Clef. For each new note it asks one small model one request with up to five questions. It is separate from the managed decision path above and from the reasoning adapter.

**Setup.** The settings are read by the background worker only; the key never reaches the server process, the browser, a URL or a log.

| Variable | Meaning |
| --- | --- |
| `BRAIN_SYSTEM1_PROVIDER` | `ollama` or `cloudflare`. Unset means sorting help is off. |
| `BRAIN_DECISION_API_KEY` | The key or token. For Ollama, `OLLAMA_API_KEY` is used when this is empty. |
| `BRAIN_CLOUDFLARE_ACCOUNT_ID` | Cloudflare only: the 32-character account id. |
| `BRAIN_SYSTEM1_MODEL` | `clef-flash` (default) or `clef`. Ollama also accepts a tagged name such as `clef-flash:cloud`. |
| `BRAIN_SYSTEM1_ENDPOINT` | Local test servers only: a loopback URL. Any other host is refused. |
| `BRAIN_SYSTEM1_INPUT_MICRO_USD_PER_MILLION`, `BRAIN_SYSTEM1_PRICE_VERSION` | Override the built-in input price (a positive whole number) and its version label. |

- **Ollama.** `https://ollama.com/v1/systemone` with the key as a bearer token, or a local Ollama on loopback with no key (set `BRAIN_SYSTEM1_ENDPOINT=http://127.0.0.1:11434/v1/systemone`; not yet tested against a real local Ollama). Ollama bills by plan, so the cost is a built-in estimate based on Cloudflare's published Clef input price (as of 2026-10-01); it exists so the daily and per-note limits still bound calls.
- **Cloudflare.** Workers AI at `api.cloudflare.com` for the account in `BRAIN_CLOUDFLARE_ACCOUNT_ID`, with a token that has Workers AI access.
- **Status.** The worker publishes whether sorting help is configured (never the key) and the last outcome. Settings reads that status. The consent switch works only when the worker is configured and running with a recent heartbeat.

**Design.** One request, up to five questions, never one call per question:

1. `kind`: decision, fact, question, task or note.
2. `project`: only for Inbox notes when other projects exist; up to 15 projects plus `stay`.
3. `changes_fact`: only when the note's project has current facts.
4. `review`: whether a deeper review should look at the note.
5. `show`: whether the note is worth showing on Today.

Every answer must name an option the request offered; one invalid answer rejects the whole response. The adapter refuses secret-looking text before any request and bounds the question set, the state and the response size.

**Advisory only.** Answers never discard a capture, grant access, accept a fact or move an original. Effects, all shown to the owner: a "File in Northstar?" suggestion (project choice other than `stay`, confidence 0.7 or more) that moves a note only on Keep; a quiet card (`show` below 0.3) that ranks last but is never hidden; and a queued review for a watched project with an active preparation goal (`review` 0.7 or more).

**Limits and money.** Sorting help runs only when background help and its own consent are on, the daily and per-note limits are above $0, the project is watched, and the note is a project-visible, unquarantined original. Cost is integer micro-USD on the existing daily and per-job limits. A call that fails after it was sent is not retried: the note stays unsorted and the hold stays. A monthly cap is deferred.

**Review log.** Each Keep, Fix, Dismiss or rejection logs the judged question (`show`, `changes_fact` or `project`, never `kind`) with the choice, confidence and action. It holds no note text and can be downloaded from Settings.

**Live proof is the owner's.** No live Clef or Ollama call has been made on this branch. After setting the variables above, the owner runs it: Put `BRAIN_SYSTEM1_LIVE=1` on its own line in `.env` and run `npm run proof:sorting`, or in PowerShell run `$env:BRAIN_SYSTEM1_LIVE=1; npm run proof:sorting`, then run `Remove-Item Env:BRAIN_SYSTEM1_LIVE` (or close the window). Remove the line from `.env` afterwards so it is never left on. It sends three synthetic notes as three requests, prints the answers, model, input tokens and cost (labelled estimated for Ollama), never prints the key or account id, refuses a loopback endpoint, and exits 0 only when all three answers validate. It spends quota, so agents and CI never run it; their tests use a loopback fake server.

### Prepared decision contract and default-off managed consumer

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
spending authority. The S1 account-bound decision coordinator obtains fresh
financial marks and checks consent, installed policy, job/goal binding and lease
before I/O. S2's managed worker explicitly runs the decision and reasoning stages
on the same opted-in goal-review job with separate coordinators and paid slots.
It rechecks the exact bounded source/goal context before reserve, mark and I/O,
then checks both known-settled financial projections before publication/recovery.
Unknown usage retains its shared hold; no resend or external-provider fallback
occurs. A decision result is an internal hypothesis, never dispatch permission or
a reason to suppress reasoning. Its extra cost can still exhaust the ordinary
shared job budget; this is not a claim of a cost-saving policy.

The worker freezes its enrolled decision profile and worker-only
`BRAIN_DECISION_API_KEY` at startup. Its own separate readiness is checked at
prepare/execute and refreshed by the existing heartbeat. Missing decision setup
does not install a decision path or change baseline reasoning. Rotation requires
a worker restart, not a live configuration/key reload. Synthetic transport tests
establish these properties, not
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
