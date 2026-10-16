# System 1 prepared-decision call contract — design

**Status: APPROVED for this narrow implementation — owner said "continue" after the
implementation approval request. Parent review clarifications below preserve that scope.**
Date: 2026-10-17. This is the narrow next G4 foundation: an **immutable one-shot prepared decision
adapter** around the existing real `SystemOneProvider`. Production paid decision remains **OFF**; no
telemetry records, policies, activation, storage or UI change in this slice. It does not claim G4
complete, and it is not an end-user semantic feature.

## Verified current state (inspected, not assumed)

- `packages/providers/system-one.ts` is a real bounded transport: `SystemOneProvider(config, fetcher)`
  with `upperBound(input)` and `decide(input, signal)`; config `provider:"typesafe"|"cloudflare"` with an
  official endpoint allowlist, versioned operator price, accepted returned models, bounded request/
  response bytes and a caller timeout; `SystemOneError` carries `dispatched` plus optional known
  `usage`/`actual_cost_micro_usd`. It validates option/probability sets, scans for secrets, validates
  usage independently of the answer, and rejects a cost above the bound with `dispatched:true`.
- `packages/providers/prepared.ts` is the existing prepared **reasoning** one-shot: `prepareCall(input)`
  is synchronous and no-I/O, freezes the exact request bytes and a config snapshot, and returns a
  `PreparedCall` whose `execute(signal)` performs exactly one fetch, with `PreparedAccounting`
  (`known{cost,usage,model}` | `unknown`) and `PreparedOutput`.
- The managed worker only ever dispatches `stage === "reasoning"` with the fixed `openai` profile. The
  `decision` stage is not authorized anywhere, so wiring a live decision call would bypass accounting.

## Approaches

1. **Recommended — immutable prepared-decision adapter, no live wiring.** A new
   `packages/providers/prepared-decision.ts` exposes a frozen one-shot `prepareDecision(input)` over
   the existing `SystemOneProvider`. No consumer/worker/activation/UI change. It is the safe next G4
   dependency for a later shadow **accounting** spec.
2. **Defer** any observation/policy telemetry (the superseded shadow draft) until there is actual
   worker shadow use and quality evidence. No invisible bookkeeping now.
3. **Rejected** — full production decision stage/activation now: it would change consent, budgets and
   an activation profile for a new provider/endpoint family before the prepared accounting contract is
   safe, and before a held-out quality/cost comparison justifies it.

## Module and exports (`packages/providers/prepared-decision.ts`, new)

Reuse `SystemOneProvider` with backward compatibility preserved and existing tests untouched. Extract pure helpers
from `system-one.ts` only if needed (e.g. a canonical request serializer / option-set hash); no generic
framework.

```ts
import type { DecisionInput, SystemOneConfig } from "./system-one.ts";

export interface PreparedDecisionCall {          // frozen; no mutation after prepare
  readonly identity: PreparedDecisionIdentity;
  readonly request_bytes: number;                // exact serialized UTF-8 length
  execute(signal: AbortSignal): Promise<PreparedDecisionEnvelope>;
}
export type PreparedDecisionIdentity = {
  provider: "typesafe" | "cloudflare";
  model: string;
  accepted_response_models: readonly string[];
  price_version: string;
  input_micro_usd_per_million: number;
  output_micro_usd_per_million: number;
  policy_version: string;                        // SYSTEM_ONE_POLICY_VERSION
  question_schema_version: string;
  options_hash: string;                          // canonical (id,description) hash
  request_hash: string;                          // sha256 of the exact request bytes
  config_hash: string;                           // endpoint/model/price/accepted/policy/bounds; NO key
  reserved_micro_usd: number;                    // frozen from upperBound at prepare
  max_request_bytes: number;
  max_response_bytes: number;
  request_overhead_bytes: number;                // framing allowance
};
export type PreparedDecisionAccounting =
  | { state: "known"; cost_micro_usd: number; usage: { input_tokens: number; output_tokens: number }; model: string }
  | { state: "unknown"; usage?: { input_tokens: number; output_tokens: number } };
export type PreparedDecisionOutput =
  | { ok: true; choice: string; confidence: number; probabilities: Readonly<Record<string, number>> }
  | { ok: false; code: string; reason: string };
export type PreparedDecisionEnvelope = {
  accounting: PreparedDecisionAccounting;
  output: PreparedDecisionOutput;
  /** Whether the request bytes may have reached the provider. */
  disposition: "not_dispatched" | "attempted";
};
export class PreparedDecisionProvider {
  constructor(config: SystemOneConfig, fetcher?: typeof fetch);
  prepareDecision(input: DecisionInput): PreparedDecisionCall;   // sync, no I/O
  upperBound(input: DecisionInput): number;                      // no-I/O convenience
}
```

- `prepareDecision` validates config and the caller's `DecisionInput` **synchronously with no I/O**
  (bounds, distinct option ids, secret scan), deep-freezes a copy of the question/options, snapshots
  the **exact** request bytes, price, accepted models, endpoint and bounds, and computes
  `reserved_micro_usd` from the frozen config (never re-reads mutable `this.config` at execute).
- The **key stays hidden**: never in `identity`, never persisted, never logged. Operator prices and
  accepted models are required and concrete; no inferred prices, no widened loopback paths.
- The new class does **not** implement the legacy `DecisionProvider` (`decide` is deliberately not
  exposed); the legacy class/interface remain usable. Helpers must share the actual request
  serializer/defaults rather than duplicate a body shape that could drift from the transport.

## One-shot semantics (strict, no resend, no false zero)

- `execute` may run at most once per `PreparedDecisionCall`; a second or concurrent call throws
  **before any I/O**. This is instance-level idempotence only — durable cross-process
  no-resend still requires a future coordinator fresh-mark; the adapter never claims durable dedupe.
- A cancel/abort observed **before** the request is sent yields `disposition:"not_dispatched"` with
  accounting `unknown` and a static output error — the caller may release a reservation because no
  bytes were sent. Once any attempt may have been sent, `disposition:"attempted"` and the accounting
  stays `unknown` unless the provider reported valid usage; a held/unknown charge is retained. The
  adapter **never** reports a known 0 for an uncertain failed call.
- Dispatch disposition follows an internal observation of the single fetch boundary, not a
  caller/transport-thrown error's claimed `dispatched` flag. Foreign errors cannot forge known
  charges or leak provider bodies. A pre-send-aborted call is consumed and cannot execute later.
- **Known accounting survives bad output.** Usage and the returned model are validated **before** the
  answer: a returned model that exactly matches an accepted id, with valid operator pricing, yields
  `known` cost even when choice/probability validation later fails. Preserve the exact accepted
  returned-model ID on both successful and known-cost error paths; never substitute the requested
  model for an accepted alias. Missing/invalid pricing fails synchronously at preparation with no
  I/O; unaccepted returned models or missing/invalid usage after an attempt yield `unknown` and
  the output cannot publish. A narrow optional validated-model field on `SystemOneError` may be
  added compatibly if needed. Known over-bound cost remains known while output is refused.
- No retry, fallback or repair, and no cross-provider switch. Output is a closed
  choice + probability schema over the prepared option set; probabilities are advisory and
  **uncalibrated**. No output authorizes any action, permission, capture change or budget change.
- Timeout/response byte bounds are finite and enforced for the whole request (fetch + bounded stream).

## Tests (design matrix — synthetic fetch only)

- Constructor and post-prepare caller mutations never change `identity`, `request_bytes`, the executed
  body or the bound (deep-freeze). The key is asserted to never appear in `identity`/logs/headers output.
- Duplicate/concurrent `execute` throws with **0** extra fetch calls; pre-abort and ignored-abort-after-
  headers/body paths return the correct `disposition`; finite timeout and max-bytes are enforced.
- Accepted usage with a malformed choice/probability set keeps the **known** charge and exact
  accepted returned-model ID; an unaccepted model yields **unknown**. Missing pricing refuses
  preparation with zero I/O. No evidence fields are invented for a pure choice question.
- Endpoint allowlist and config validation fail early for an unsupported provider/endpoint; an injected
  synthetic `fetch` with an explicit dummy key is used — never a real key or provider env.

## Trust boundaries

- The decision adapter cannot grant permission, change consent/budgets/captures/schedules, or alter
  system instructions; it returns an advisory judgment only.
- No secret is stored in the identity, the request, logs or fixtures; the key is used only in the
  in-memory header of the single fetch. Prices and accepted models are operator-supplied and concrete.
- Authorization is unchanged: the existing managed guard is untouched and no new endpoint/loopback
  path is accepted in production; only the existing official allowlist plus the injected test fetch.
- The adapter is not imported by the worker, HTTP, or any consumer in this slice, so it adds no runtime
  behavior and no reachable network path.

## What this can and cannot demonstrate

**Can:** a frozen, auditable one-shot decision contract with exact request/config hashes, a
conservative bound, strict one-shot/no-resend behavior, and known-charge-survives-bad-output
accounting — provable with an injected synthetic fetch. **Cannot:** real decision quality, calibration,
real per-decision cost, provider outage behavior, or any live shadow; and it is not a user-facing
feature. Those require a later shadow-accounting spec and, separately, real held-out evidence.

## Implementation plan and local verification

The [two-task plan](../plans/2026-10-17-system-one-prepared-call.md) records the implementation,
independent review, cancellation-message repair and test-first process deviation. Parent accepted
the narrow adapter locally after 645 passing tests (2 POSIX-only skips), 19 browser journeys,
4 offline evaluations, typecheck/lint/build and dependency audit. No dependencies were installed.
This verification does not authorize a production decision stage or establish real model quality.

## Deferred (explicitly out of scope now)

Policies, evaluation corpus, persisted observations, managed decision activation/accounting, billing,
native clients, hosting. A live paid smoke and any owner real key are also out of scope.

## Approved scope

The owner's continuation approved **this narrow prepared-decision contract only** (synthetic
verification, production paid decision OFF, no owner keys, no push/commit). A later design must
address shadow accounting/consent before any worker integration or live verification.
