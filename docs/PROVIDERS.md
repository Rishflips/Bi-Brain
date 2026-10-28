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

### Recall help (System 1, local)

Recall help is the second local, advisory use of Clef. After the deterministic retrieval of [recall](AGENT_INTEGRATION.md#recall-push) has produced its candidates, it sends one request per agent question (a `brain_recall` call or a per-prompt push) through the same sorting adapter.

**State.** Bounded and built from the retrieved set only: today's date, the request (up to 500 code points), up to 40 known project and topic names, and up to 12 candidates of 300 code points each (kind, date, project, title and passage). Private-visibility sources are never candidates, the adapter refuses secret-looking text, and candidate text is described to the model as data.

**Questions.** Three kinds in one request: `about_owner` (owner world, general, or unclear), one `rel_n` per candidate (does it help answer the request), and `answered` (answered, partial or none).

**Thresholds.** `full` push needs P(owner world) of 0.6 or more, `answered` or `partial`, and one candidate rated 0.5 or more; `pointer` for P(owner world) from 0.35 to below 0.6, or 0.6 or more with no relevant candidate; `none` needs P(general) of 0.6 or more and no exact name match. A candidate rated below 0.2 moves to near misses; `found` needs `answered` with a margin of 0.2 or more between the top two choices. These are initial bands, uncalibrated until the recall log has data.

**Advisory only.** The judge can reorder candidates, demote them to near misses, and lower or raise the push level, but only among candidates BiBrain already found and the agent is allowed to see. It never adds a hit, never changes which projects are searched, never hides an exact name match below a pointer, and never changes caps or consent. Its answers pass schema and reference validation like every other model output.

**Consent and limits.** It needs sorting help on plus its own "Recall help" consent in Settings (its own setting, not a background preference, off by default). It shares the daily micro-USD cap with sorting and adds a hard cap of 2,000 judge calls per UTC day. Calls run only in the background worker over the `jobs` table (`recall_judge`); the server waits at most 900 ms and then answers from the deterministic result, cancels the queued job and deletes its state. A job past its deadline is never paid. The worker keeps an identical request's answers in memory for ten minutes, and every judged hit is still one the deterministic recall already authorized for that connection.

**Owner screens never use it.** The Ask bar and Your brain search call the deterministic recall only, so an owner query or private note never reaches the sorting service.

**Live proof is the owner's.** No live Clef call has been made for recall help on this branch; tests use a loopback fake server. The deterministic behaviour is the default and the fallback.

### Better search (embeddings, local)

Better search adds meaning to recall: each current passage and fact is turned into a vector by an embedding model, and a question is matched by vector as well as by words. Words stay the backbone and the fallback. It is off by default; with it off nothing is sent anywhere, no embedding model is called, no job is written and every result is byte-identical to recall without it (a committed snapshot, `tests/eval/recall-dense-off-snapshot.json`, holds that).

**Choices.** The owner chooses in Settings, "Better search", one of three:

- **Off** (default). Search matches the words you used.
- **On this computer (Ollama).** Uses the `bge-m3` model through a local Ollama. It needs Ollama installed and the model pulled (`ollama pull bge-m3`, about 1.2 GB). The endpoint must be on this computer (loopback only); nothing leaves it, so private notes are embedded too. Ollama Cloud does not serve embeddings, so there is no hosted Ollama choice.
- **Cloudflare.** Workers AI `@cf/baai/bge-m3` (1024 dimensions, 100+ languages), worker-only, using the same `BRAIN_CLOUDFLARE_ACCOUNT_ID` and `BRAIN_DECISION_API_KEY` as sorting help. The card names what is sent: the text of notes, searches and the questions connected agents ask, turned into numbers that stay on this computer. Private notes are never sent. It shows the cost: "About 1 cent for every 250,000 words of English text; other languages can cost more, counted against your daily limit." The ledger counts bytes, so a script such as Tamil costs several times more per word than English.

**Setup.** Read by the background worker only; the credential never reaches the server, the browser, a URL or a log. The server learns only a key-free status (whether a provider is set up and its label).

| Variable | Meaning |
| --- | --- |
| `BRAIN_EMBED_PROVIDER` | `ollama` or `cloudflare`. Unset means better search is not set up. |
| `BRAIN_EMBED_MODEL` | Ollama: any pulled embedding model, default `bge-m3`. Cloudflare: `@cf/baai/bge-m3` only. |
| `BRAIN_EMBED_ENDPOINT` | Ollama: a loopback `/api/embed` URL, default `http://127.0.0.1:11434/api/embed`. Cloudflare: a local test server only. |
| `BRAIN_CLOUDFLARE_ACCOUNT_ID`, `BRAIN_DECISION_API_KEY` | Cloudflare only, shared with sorting help. |

A computer is set up for exactly one provider (`BRAIN_EMBED_PROVIDER`); the Settings card shows all three choices and disables the one this computer is not set up for with "Not set up on this computer."

- **Cloudflare privacy and spend.** Private notes, owner-only facts (names, preferences, facts with private evidence) and quarantined notes are never sent and stay words-only. About $0.012 per million tokens, estimated as half the UTF-8 bytes of each text and settled at the usage Cloudflare reports when it reports one; counted in whole micro-USD against the daily and per-preparation limits through the same spend ledger as sorting help. Both limits must be above $0 (background help and sorting consent are not required). Query embedding goes through the ledger too, so every paid call is bounded.
- **Model key.** Each vector is stored with `<provider>:<model>:<prefix-scheme>`. A changed provider or model needs choosing Better search again in Settings ("The search setup changed. Choose Better search again."); nothing runs meanwhile, and choosing again clears the old vectors and starts the preparation over. Rows with another key are ignored at search time, and a search never mixes keys or sizes.
- **Indexing.** A background job embeds up to 32 passages per call, outside any transaction; writes are fenced and guarded so an edited note never keeps a stale vector. Capture and edit queue a batch; a rebuild, import or crash is caught by a 5-second check. Passages are capped at 2,000 characters and sent with `truncate`/`truncate_inputs` so an overlong one never blocks a batch. A passage that looks like a secret is never sent. A batch whose input the service refuses (400, 413 or 422) is retried one passage at a time, and a passage refused on its own stays words-only until its text changes; if the service refuses every passage sent alone, none is withheld and it counts as a failure, because the request itself is the likely cause. A refused key (401, 403), a rate limit (429), a timeout (408) or any other error status is an ordinary failure: nothing is withheld, the next batch waits for the back-off, and the third failure in a row pauses Better search for 15 minutes. A refused key shows "Better search could not sign in to the search service. Check its key."
- **Outages and spending limits.** An error response costs nothing; a request that timed out after it was sent keeps its hold. A failed call waits 60 seconds before the next, doubling to 15 minutes; after three failures in a row Better search pauses for 15 minutes and Settings says "Better search paused: the service is not answering." Search keeps working by words meanwhile. A spending-cap refusal waits instead of retrying hot: a per-preparation refusal for the back-off, the daily cap until the next accounting day.
- **Searching.** The worker embeds the question on a dedicated lane (the server waits at most 400 ms; the call is bounded at 2 seconds; Cloudflare skips a call with under 150 ms left; the answer is cached for ten minutes). The server scans the vectors the caller may see, keeps cosines of 0.45 or more for `bge-m3` (the floor is per model), and fuses at most 60 of them as a fourth reciprocal-rank list with weight 0.7. Every dense candidate passes the same authorization as every other candidate. An exact name match stays first. A hit found only by meaning reaches `brain_recall` and the owner's screens, but never makes a hook push louder, also when the recall judge is on. When the worker is cold or slow, the first search of a new question is words-only; the vector is cached for the next one.
- **Owner screens.** Ask and Your brain search use the vector when Better search is on; the recall judge still never sees them.
- **Status.** The worker publishes whether better search is set up (never the key or any text) and the last outcome; Settings reads it and says "Words only right now: …" when the choice cannot work.

**What CI measured, and what it did not.** The golden set (62 synthetic questions) runs with a deterministic fake embedder, not a real model: paraphrase recall at 5 goes from 0.125 to 1.0, cross-language from 0 to 1.0, lexical and names stay at 1.0, and no-answer queries stay quiet (1.0). That proves the plumbing, the fusion and the gates; it says nothing about how a real model does on your notes or in Tamil. Whether Cloudflare accepts `truncate_inputs` for `bge-m3` is also unverified offline.

**Live proof is the owner's.** No live embedding call has been made on this branch; tests use the fake embedder. After setting the variables above, put `BRAIN_SEARCH_LIVE=1` on its own line in `.env` and run `npm run proof:search` (or `$env:BRAIN_SEARCH_LIVE=1; npm run proof:search` in PowerShell, then `Remove-Item Env:BRAIN_SEARCH_LIVE`); remove the line afterwards. It embeds the synthetic golden texts in a temporary folder outside the repository, prints the model key, calls, tokens, cost, recall at 5 per bucket and the cosine room around the floor (the lowest cosine of a wanted hit and the highest of a no-answer query, so you can judge 0.45), never prints the key or account id, refuses a loopback Cloudflare endpoint, and exits 0 only when paraphrase and cross-language reach 0.8 with no regression on lexical and names. Without `BRAIN_SEARCH_LIVE=1` it prints these instructions and exits 1 (nothing was proven). With Cloudflare it makes about 50 small requests, roughly 3,000 tokens, inside the free daily allowance. The floor (0.45) and weight (0.7) are initial values, not tuned on live data.

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
