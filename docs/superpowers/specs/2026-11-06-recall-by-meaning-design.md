# Plan 10: recall by meaning by default (design)

Date: 2026-11-06. Branch `reframe/recall-by-meaning`, built on `main` at `1767741` (plans 1 to 9 merged).

## Scope

The owner's words: "My agent has everything it needs but it does guesswork instead of retrieving from the base."

Recall is proven live, but the push level is lexical. Short or paraphrased prompts ("continue", "what did we pick for auth?") often land on `pointer` or `none`. Plan 5b's Better search can find matches by meaning, but it is off by default, and a match found by meaning alone never raises the push level. Plan 5b ruled that pending evidence: the dense floor 0.45 and weight 0.7 are uncalibrated, and `npm run proof:search` has not been run.

Four parts:

1. **Turn Better search on automatically when it is safe and local.** When Ollama answers on loopback and the search model is present, Better search is on by default, with a plain notice and one switch to turn it off. Cloudflare is never automatic.
2. **Matches by meaning can lead a push, gated on calibrated evidence.** A new owner-applied line, "meaning matches can lead", lets a hit found by meaning alone reach `full`. The line is unset by default, is suggested only by the two measurement tools, and is applied only by one explicit owner action.
3. **Short and paraphrased prompts.** "continue", "what did we decide" and "what did we pick for the caterer" pull useful context, through the session's recent topic, the first-prompt digest, or a deterministic reading of decision questions. Generic prompts and acknowledgements stay quiet.
4. **Plain owner copy and docs.**

Standing rules: `AGENTS.md` (agents only suggest; never invent data or results; show uncertainty plainly; every control has real behaviour or a labelled unavailable state), and the owner's rule that every decision improves user, developer and agent experience together without breaking anything.

Out of scope: hosted and payments (paused), periodic re-detection of Ollama while the worker runs, cross-encoder re-ranking, any change to the dense floor or weight, an automatic application of any threshold, running the owner-only proofs.

## Frozen boundaries

Untouched, byte for byte: every `dodo*`, `billing*`, `managed*` and `paddle*` file and test, `managedPreferencesPatchSchema`, every migration already applied (this plan adds none: every new value is a settings row), and `docs/DODO_PAYMENTS.md`, `docs/RELEASE.md`, `docs/IMPLEMENTATION_PLAN.md`, `docs/PRICING_PROPOSAL_2026-10-21.md`, `docs/BUSINESS.md`.

Never run: `npm run proof:search`, `npm run calibrate` on real data, any real agent, any real Ollama or Cloudflare call. Tests use the fake embedder (`tests/helpers/fake-embed.mjs`) and fake fetchers. Never read: the owner's `data/`, any `.env`.

`tests/eval/recall-dense-off-snapshot.json` is not regenerated; every change must leave it byte-identical. `tests/integration/bibrain-hook.test.ts` is not edited (new hook cases go in a new file). The existing golden sets keep passing unchanged.

## Part 1: Better search on by default when it is safe and local

### 1.1 Detection

The background worker probes once at startup, before it publishes `better_search_status`:

- `GET <ollama origin>/api/tags` on the configured Ollama endpoint, which `embed-env.ts` already restricts to loopback (`127.0.0.1`, `localhost`, `[::1]`, `http:` only). The default is `http://127.0.0.1:11434`. No other host is ever contacted.
- 1,500 ms budget, one request, no retry, response body capped at 1 MiB and parsed as JSON `{ models: [{ name }] }`. The model counts as present when a listed `name` equals the configured model, or equals `<model>:<tag>` when the configured name carries no tag (Ollama lists `bge-m3:latest` for a plain `ollama pull bge-m3`).
- Outcome, published key-free on the status: `detected: true | false` and `probe: "found" | "no_ollama" | "no_model" | "skipped"`. Nothing from the response body is stored or logged.
- `BRAIN_EMBED_PROVIDER=off` skips the probe entirely and publishes "Better search is turned off by this computer's setup." Playwright gives every server that is not the Better search one this value, so no test server ever probes the owner's real Ollama.
- `BRAIN_EMBED_PROVIDER` unset (the common case) means: probe the default endpoint for `BRAIN_EMBED_MODEL` or `bge-m3`. Found: the worker is configured for Ollama exactly as if the owner had set `BRAIN_EMBED_PROVIDER=ollama`. Not found: the status says why, in one sentence ("Ollama was not found on this computer when BiBrain started." or "Ollama is running on this computer, but its search model is not pulled."), and Better search is not set up.
- `BRAIN_EMBED_PROVIDER=ollama`: configured from the environment as today; the probe still runs and sets `detected`.
- `BRAIN_EMBED_PROVIDER=cloudflare`: no probe, `detected: false`, `probe: "skipped"`.

Detection is cheap (one loopback GET, cached in the published status for the worker's lifetime), makes no network call beyond loopback, and is quiet when Ollama is absent (one status sentence, no log line, no retry).

### 1.2 The automatic choice

The stored setting `better_search` keeps its shape. The rule that changes is how an **absent** row is read:

- **No row stored** (the owner has never chosen): when the status says `configured`, `provider: "ollama"` and `detected: true`, the effective setting is `{ mode: "ollama", key: <status key>, consented_at: null, automatic: true }`. Otherwise it is Off, as today.
- **A row stored with mode `off`**: the owner turned it off. It stays off, whatever the probe found. ("An owner who explicitly turned it off must stay off.")
- **A row stored with a provider**: as today.
- **Cloudflare is never automatic**, because it sends text off the machine. The automatic rule checks `provider === "ollama"` and the worker's loopback-only configuration guarantees the endpoint.
- **Managed brains** never get the automatic rule (Better search already runs on the local app only).

Everything downstream reads the effective setting through `betterSearchSetting()` and `betterSearchAllowed()`, so the backfill (32 rows a batch, outside transactions, fenced, with back-off and the circuit breaker), the query lane, the owner's screens and the hook push all follow without a second code path. Turning it off in Settings stores the explicit Off and clears every vector, as today; choosing "On this computer (Ollama)" explicitly stores the explicit choice without clearing, because the key is unchanged.

**Applies to existing brains too.** Ruling: yes. Reasons: nothing leaves the computer; the only cost is local CPU for the backfill, which runs in 32-row batches with the existing back-off; the state is visible in Settings with one switch; and an owner who chose Off before this plan keeps that choice, because the stored row wins.

### 1.3 Owner copy

Settings, Better search card, status line when automatic: `On (this computer) · Ollama on this computer · N of M passages ready` (with "; preparing the rest in the background" while it works). Under it, one paragraph:

> BiBrain found a search model running in Ollama on this computer, so search by meaning is on. Nothing leaves your computer. Choose Off below to turn it off; it then stays off until you choose it again.

When the owner has stored Off and the probe found the model, a muted line under the choices: "A search model is running in Ollama on this computer. Choose On this computer to use it."

When the probe did not find Ollama: the status line reads as today ("Off. Search matches the words you used.") and the "On this computer (Ollama)" choice says "Not set up on this computer." with the probe's sentence under the card as "Last check: Ollama was not found on this computer when BiBrain started. Install Ollama, run `ollama pull bge-m3`, and restart BiBrain." The model name appears only in that setup instruction, where the owner has to type it.

The card never names the model otherwise, never shows a status code, and the copy mapping in `better-search-copy.ts` stays closed.

### 1.4 Privacy rules

- Only loopback is probed. The probe URL is derived from the endpoint `embed-env.ts` already validated.
- The response body is parsed for model names and discarded. No name, version or body reaches the status, a log or the browser; the status carries `detected` and `probe` only.
- Cloudflare is never automatic, and the automatic rule cannot select it.
- Private notes are embedded under Ollama exactly as plan 5b ruled (nothing leaves the machine), and the agent-side authorization is unchanged.
- The probe runs only at worker startup. An Ollama installed later needs a BiBrain restart; Settings says so.

## Part 2: meaning matches can lead, gated on calibrated evidence

### 2.1 The rule

A new pure rule in `packages/domain/recall-push.ts`:

```
meaningLead(level, top, threshold):
  threshold is null            -> level (today's behaviour, exactly)
  level is already full        -> level
  top is null                  -> level
  top was found by words too   -> level
  top is an unreviewed agent note -> level
  top has no cosine            -> level
  top.cosine >= threshold      -> full
  otherwise                    -> level
```

`top` is the first hit that survives every existing step of `recallPush`: the deterministic or judged level, the plan 5b cap ("a hit found by meaning alone on top is capped at the words level"), the `seen` filter, and the plan 8 removal of unreviewed agent-written notes. The rule runs after all of them and before the final "a full push with nothing to show is never sent" check. It can only raise `pointer` or `none` to `full`, and only for the hit that leads; the rendered push is the same `fitFull` text every full push uses.

While the threshold is unset, behaviour is byte for byte today's: a dense-only hit is never above `pointer`, the judge is skipped when no candidate was found by words, and the dense-off snapshot is unchanged. The content-free recall log gains `lead: true` only on a push the rule raised; every other row is unchanged.

The plan 8 caps hold: an unreviewed agent-written original is removed from `hits` before the rule runs, and the rule refuses it again on its own.

### 2.2 The threshold and its provenance

Setting `meaning_lead`, its own row, never a preference field:

```json
{ "threshold": 0.63, "key": "ollama:bge-m3:none", "sample": 54, "source": "proof:search", "measured_at": "2026-11-06", "applied_at": "2026-11-07T09:12:00.000Z" }
```

- **Unset by default.** `null` means never lead.
- **Set only by the owner,** through `PATCH /api/v1/preferences/meaning-lead` with `{ threshold, sample, source, measured_at }` (owner session with the page's CSRF header; agents get 403; a managed brain 409). The server fills `key` from the effective Better search key and `applied_at` from its clock. `DELETE` on the same route clears it. The Settings card is the control; there is no CLI apply and no automatic application.
- **Validation.** `threshold` is a finite number from the model's cosine floor (0.45 for `bge-m3`) to 0.99, rounded to two decimals; `sample` is an integer of at least 20 (the calibration report's minimum, `MIN_SAMPLE`); `source` is `proof:search` or `calibrate`; `measured_at` is a calendar date not after today. Better search must be effective at the time, so the key is real.
- **Effective only for the model it was measured with.** `meaningLeadThreshold()` returns the stored threshold only while Better search is effective and the stored `key` equals the current key; otherwise `null`. A changed model shows "Measured for another search model. Measure again." in Settings and never leads.
- **Owner copy.** "Meaning matches can lead" under the Better search card:
  - unset: "Not yet calibrated. A match found by meaning alone never leads a push to your agents. Run `npm run proof:search` or `npm run calibrate` for a suggested value, then enter it here."
  - set: "Calibrated at 0.63: a match found by meaning alone can lead a push when its score is 0.63 or higher. From proof:search, 54 queries measured on 2026-11-06, applied 2026-11-07."
  - another model: "Measured for another search model. Measure again."
  - Better search not effective: "Turn Better search on first."

### 2.3 How the suggested value is measured

Both measurement tools print a suggestion with its sample size and source. Neither applies it.

- **`npm run proof:search`** (owner-run, real model, the synthetic golden texts). It already scans the lowest cosine of a wanted hit (`lowestWanted`) and the highest cosine of any passage for a no-answer query (`highestNegative`). The suggestion is `round2(highestNegative + 0.05)`, only when that value is at or above the floor and at or below `lowestWanted`; otherwise "no safe value" with the two numbers. `sample` is the number of queries scanned. It prints the model key and the date, ready to copy into Settings.
- **`npm run calibrate`** (owner-run, the owner's real recall log, no ground truth). From rows that carry `dense_top`, split by level: `none` (words found nothing worth a push) and `full`. With at least 20 rows in each group, the suggestion is `round2(p90(dense_top of none rows) + 0.05)`, only when it is at or above the floor and below the median `dense_top` of `full` rows; otherwise "hold" with the reason. Fewer rows: "Not enough data yet". The report also prints the applied line with its provenance, or "not set".
- The two are different kinds of evidence, and the report says so: the proof measures a real model on synthetic texts; the report measures real prompts without knowing which pushes were right. The owner chooses which to trust.

The shared arithmetic lives in `packages/domain/calibration.ts` (`suggestMeaningLead`, `meaningLeadFromLog`), pure and unit-tested; the scripts only print.

## Part 3: short and paraphrased prompts

### 3.1 Prompt intent

A new pure module `packages/domain/recall-intent.ts` reads a prompt into one of four kinds:

| Kind | Rule | Push behaviour |
| --- | --- | --- |
| `ack` | A closed list after normalisation (lowercase, trimmed, trailing punctuation removed, leading "ok," / "okay," / "please" removed): thanks, thank you, ok, okay, yes, no, sure, great, nice, cool, done, lgtm, good, fine, yep, nope, got it, k, ty, thx, perfect, sounds good | `none`, no recall, no vector. |
| `continuation` | A closed list: continue, go on, keep going, carry on, proceed, next, resume, pick up where we left off, where were we, where did we leave off, what were we doing, what did we decide, what was decided, what did we agree, what did we pick, what did we choose, remind me where we are, recap, summarise where we are, summarize where we are, and then, go ahead with that, do that, continue from there. Also any decision question (below) with no topic words left. | See 3.2. |
| `decision` | The prompt asks what was decided and names a topic: `did/have/had/do/were/was we/you/I … decide/pick/choose/settle/agree/go with`, `what was/were/is decided/chosen/picked/agreed/settled`, or `our/the decision on/about/for`; and at least one content word remains after the decision words (decide, decided, decision, pick, picked, choose, chose, chosen, settle, settled, agree, agreed) are removed. | See 3.3. |
| `plain` | Everything else. | Today's rules. |

The lists are closed and small on purpose: a prompt outside them is `plain`, and `plain` is today's behaviour.

### 3.2 Continuation: the session's recent topic, or the digest

The server keeps a bounded **session topic**: setting `recall_session_topics`, `{ [session hash]: { terms: [...], at } }`, written after a `plain` or `decision` push whose level was `pointer` or `full`. It holds the prompt's content words only (the same lowercase words the FTS query uses, at most 12), never the prompt, never an id or a passage; at most 20 sessions; entries older than 2 hours are dropped on the next write and never read.

A continuation prompt:

1. **With a topic for this session:** recall runs on the topic's words as the query, with today's rules (words first, the vector when Better search is on, the judge when it is on, the `seen` filter, every cap). Because the agent already received that topic's hits in this session, the `seen` filter usually leaves only what is new, and the level is re-read on what is left. "Continue" therefore never repeats a push and never invents one.
2. **Without a topic, on the first prompt of a session:** level `pointer` with the first-prompt digest (projects, counts, three recent titles, the pointer line), when the brain holds anything the connection may see. An agent that opens a new session with "continue" gets the map of the brain; it does not get evidence it did not ask for.
3. **Without a topic, later in a session:** `none`.

The recall log gains `intent: "continuation"` on those rows and `topic: "session" | "digest" | "none"`; nothing else.

Bounded and quiet: the topic store is capped, the digest is already capped at 600 code points, and an acknowledgement never pushes.

### 3.3 Decision questions: the two-term rule, read without the decision words

Today a prompt needs two of its words in a candidate to reach `pointer`, and a current fact covering two words (or the single word of a one-word prompt) to be `strong` and reach `full`. "what did we pick for the caterer" has the words `pick` and `caterer`; the fact "Launch party caterer: Lumen Catering" covers one of them, so the push is `none`.

The rule: for a `decision` prompt, the deterministic signals are also computed over the topic words alone (`caterer`), and the **louder** of the two readings is used. Everything after that step is unchanged (judge, caps, `seen`, re-check). Search itself is unchanged: the FTS query still carries every word, so the candidate list is the same; only the reading of it can get louder. A decision question with nothing recorded about its topic still has no candidate and stays `none`.

The log gains `intent: "decision"` only when the topic reading was the louder one.

The hook's 12-character floor stays (it keeps "ok", "yes" and "thanks" from ever leaving the agent), with one exception: the continuation phrases pass even when shorter. The CLI keeps its own copy of the list (it must not import the domain), and a test keeps the two lists equal, as the marker-line regex is kept today.

### 3.4 Golden cases

A new bucket, `tests/eval/recall-short-golden-v1.json`, run by `tests/eval/recall-short.test.ts` through `recallPush` with session sequences, with Better search off and with the fake embedder on. The cases pin: a first-prompt "continue" gets the digest as a pointer; "continue" after a full push never repeats a shown id and is never louder than `pointer`; a later "continue" with no topic is `none`; every acknowledgement is `none`; the four decision questions over recorded facts reach `full`; decision questions about nothing recorded stay `none`; a paraphrase found by meaning alone stays `none` while the lead line is unset. The existing golden sets and the dense-off snapshot stay as they are.

## Part 4: owner copy and docs

- Settings (3 places): the automatic status line and notice; the "Meaning matches can lead" line and its form; the probe sentence.
- `docs/PROVIDERS.md`: Better search "on by default when local", the probe, the lead line and both suggestions; the calibration report's new section.
- `docs/AGENT_INTEGRATION.md` and `docs/CONNECT_ANY_AGENT.md`: the continuation exception to the 12-character rule, the session topic, the lead rule and the new log fields.
- `docs/SECURITY_PRIVACY.md`: one paragraph on what the session topic holds and for how long.
- `docs/UX.md`: the Better search card paragraph.
- `README.md`, `CHANGELOG.md`, `BUILD_STATE.md`: the last task.

## What is calibrated and what is not

| Line | State after this plan |
| --- | --- |
| Dense floor 0.45, weight 0.7 | Unchanged, still uncalibrated; `proof:search` prints the room around the floor as before. |
| Meaning matches can lead | Unset. Suggested by `proof:search` (real model, synthetic texts) and by `calibrate` (real log, no ground truth). Applied only by the owner in Settings, with provenance. |
| Push bands, judge bands, durable lines | Unchanged. |
| Continuation and decision lists | Closed lists, not thresholds; pinned by the new golden bucket. |

## Rulings

- **R1. Detection at worker startup only.** No periodic re-probe and no mutable worker client: an Ollama installed later needs a restart, and Settings says so. Cost if wrong: one restart.
- **R2. Automatic applies to existing brains.** A stored Off wins; an absent row reads as automatic. Cost if wrong: an owner who never opened the card finds search by meaning on, labelled, with one switch.
- **R3. Cloudflare is never automatic,** and the probe never leaves loopback.
- **R4. The lead line is unset by default, set only by the owner, stored with provenance, and bound to the model key it was measured for.** No tool applies it. Cost if wrong: the owner has to type four values.
- **R5. The lead rule runs last** (after the words level, the judge, the dense cap, the `seen` filter and the plan 8 removal), raises only the leading hit, and never touches an unreviewed agent note.
- **R6. The suggestion from the log is weaker evidence than the proof,** and both tools say so. Neither is a population error rate.
- **R7. Continuation reads the session topic, then the digest, then nothing.** It never pushes evidence the agent did not ask for and never repeats a shown id.
- **R8. The session topic holds content words only,** at most 12 a session, 20 sessions, 2 hours. It is never logged and never shown.
- **R9. A decision question takes the louder of two deterministic readings** and changes no candidate list. The judge, caps and snapshot are untouched.
- **R10. The 12-character floor stays;** only the closed continuation list passes under it. Acknowledgements are refused on the server too, so a harness that sends everything still cannot make "thanks" push.
- **R11. Golden pins over tuning.** The new bucket pins behaviour; if a pinned case fails during implementation, the implementer reports it rather than widening a list or lowering a line.
- **R12. No migration.** Every new value is a settings row (`meaning_lead`, `recall_session_topics`) or a field on the published status.

## Parked

- Periodic re-detection of Ollama while the worker runs (R1).
- A CLI apply (`bibrain calibrate --apply`): the Settings control is the one action; a second path would need its own authorization story.
- Using the project's recent decisions as a topic source for a cold "continue": the digest already lists recent titles; a decisions-first digest is a product question for the owner.
- Embedding the previous turn's reply (not only its prompt) as the session topic: the end-of-turn note already captures marker lines; merging the two is a later plan.
- Calibrating the floor and the weight: still waiting on `proof:search`.
