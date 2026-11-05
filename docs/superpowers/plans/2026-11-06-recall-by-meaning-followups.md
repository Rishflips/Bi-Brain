# Plan 10 (recall by meaning): rulings and follow-ups

Recorded while executing `docs/superpowers/plans/2026-11-06-recall-by-meaning.md`.

- Ruling: accept R2 (existing brains with no stored choice get automatic local Better search; a stored Off wins; never Cloudflare) — local only, nothing leaves the machine — if wrong, background embedding uses CPU on old brains; the notice and one switch cover it.
- Ruling: amend R1 — the worker re-probes loopback Ollama every 10 minutes while not detected (same 1.5 s and 1 MiB bounds), so Ollama started after BiBrain is picked up without a restart — negligible cost.
- Ruling: accept the promotion design — unset by default; owner-only PATCH with provenance (source, sample >= 20, measured_at, model key); never automatic; reviewed dense-only leading hits only.
- Ruling: B1-B8 — fix as the pre-flight says (the probe enforces its own deadline instead of trusting abort; paraphrase/agent-note tests use the leader's cosine and a scenario where the agent note truly leads; expected values computed, not rounded literals; /continue expectation; ack rows; DELETE sends a valid body or uses PATCH {threshold:null}; e2e strict-mode, stale state and dates from the test clock) — none.
- Ruling: I1 — add the 10-minute re-probe while not detected (spec 1.1/1.3/1.4/R1/Parked; Tasks 1, 3, 9); the worker rebuilds its embed client when detection changes — none.
- Ruling: I2 — a promoted push renders only dense-only hits at or above the threshold (plus word-found hits as before), never sub-threshold dense-only neighbours — none.
- Ruling: I3 — no test may probe a real Ollama: restart.test and any test that starts a real worker set BRAIN_EMBED_PROVIDER=off or inject a fake probe — protects the owner's machine.
- Ruling: I4 — narrow the decision regex, include participles ("have we decided"), and pin it against a varied list of ordinary prompts with zero false positives — none.
- Ruling: I5 — proof:search reports the negative-query count separately and prints "not enough evidence" below 20 negatives; calibrate suggests only from log rows recorded while no threshold was applied (never circular); both stay labelled suggestions — no invented confidence.
- Ruling: the Minors are applied where they are a few lines.
- Ruling: parked — the restored test depends on running before the journey test (order within one serial file, workers=1) — if wrong, it becomes flaky under parallel runs; make it set its own state later.
- Ruling: decision questions require a first-person subject; passive "what was decided" becomes plain (precision over recall — that phrasing falls back to normal recall); verb+particle is not a decision. The decision reading reaches full only by the normal two-term evidence rule; a single incidental word gives at most pointer. Surviving mutations are pinned with tests.
- Ruling: I1 — the 20 extra no-answer queries feed only the threshold-suggestion scan; the plan-5b PASS gate scores its original set unchanged — the proof's meaning must not shift silently.
- Ruling: I2 — calibrate reads the effective (automatic or stored) search model key — the new default state must be supported.
- Ruling: the Minors are fixed in the same wave where they take a few lines: filler words (far/again/right/why/over) become stop words; API.md/AGENT_INTEGRATION add lead_at/lead_cos; document the judge-override consequence; CHANGELOG Unreleased heading; clearMeaningLead returns 409 on managed brains; tighten the guard token; better copy when the automatic state lapsed.
- Ruling: the meaning-lead line is read when Settings opens and after apply/clear, never polled — it changes only on an owner action; also protects owners with several tabs open.
- Ruling: integrations/hermes/** is eol=lf in .gitattributes, and the manifest test normalises CRLF — the plugin is copied to Linux servers.

## Owner-run steps still owed

- Run `npm run proof:search` against real `bge-m3` (Ollama or Cloudflare). If it prints a suggestion, apply it in Settings → Better search → Meaning matches can lead.
- Use BiBrain with local Ollama running and check that Better search turns on by itself ("On (this computer)").
- After real use, `npm run calibrate` can suggest a value from your own pushes. This is weaker evidence than proof:search.
