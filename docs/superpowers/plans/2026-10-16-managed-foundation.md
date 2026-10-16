# Managed Suite Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The owner explicitly selected Ollama DeepSeek V4.1 Flash execution, parent review/verification and GPT-6 Astra consultation.

**Goal:** Establish a real isolated personal-brain boundary for managed accounts without regressing local operation, and add the first validated real System One transport.

**Architecture:** Keep one SQLite database and Git vault per account, with a separate small control database holding trusted account/session/token routing. Bind every managed principal and request to its selected brain. Keep model adapters independent of authorization and storage; do not route paid work until the existing single-reservation budget has been extended and tested.

**Tech Stack:** Existing strict TypeScript, Node 24.19 LTS, Fastify, SQLite, React, Zod, Vitest and Playwright. No new service or graph database. Standards-based OIDC follows the isolation boundary, not home-grown passwords.

**Spec:** `docs/superpowers/specs/2026-10-16-managed-suite-design.md`

## Global Constraints

- Primary navigation remains Today, Your brain, Connections; Save something is global.
- Retain valid explicit user captures before classification. Classification cannot silently discard them.
- No secrets in client bundles, URLs, logs, screenshots, exports or commits.
- Do not adopt the existing local database into a managed account.
- Tests use disposable, explicitly synthetic data. Keep tracked reference screenshots unchanged.
- Record observed RED and GREEN commands; parent independently verifies output.
- No commits, pushes, account creation, public deployment, owner-data migration or live paid requests by implementers.
- Each implementation task has exclusive file ownership. Stop and report if its prerequisite interface differs; do not rewrite a neighbor's implementation.

## Task 1: Isolated managed capture and retrieval

**Files:**
- Create `packages/storage/control.ts`: SQLite control-plane identities, lifecycle, opaque hashed sessions and agent-token routing.
- Create `packages/runtime/managed.ts`: validated managed root, per-account SQLite/vault provisioning and bounded pinned runtime handles.
- Modify `packages/contracts/index.ts`: optional managed tenant binding on owner/agent principals, retaining local compatibility.
- Modify `packages/domain/service.ts`: enforce tenant binding in shared authorization and construct bound internal principals.
- Modify `apps/server/app.ts`: request-bound brain and managed browser/agent authentication; local pairing remains local only.
- Test `tests/integration/managed.test.ts`.

**Interfaces:**
- Produce a `ControlStore` with idempotent trusted `(issuer, subject)` account provisioning, account state lookup, opaque expiring sessions with CSRF, logout, and hash-indexed agent-token routing. Account and tenant IDs are server-created UUIDs; email is not an identity key.
- Produce `ManagedRuntime` owning the control store and an explicit managed filesystem root, account provisioning, `acquire(tenantId)` returning a pinned `{ brain, release }`, bounded idle eviction and `close()`.
- Produce `Brain.ownerPrincipal()` and `Brain` tenant binding. A managed A principal must fail against B and against a local brain; an unbound local principal must fail against a managed brain. `authenticateAgent` returns the correct binding. Update internal owner literals to the helper without changing permission semantics.
- `createApp` accepts an explicit managed runtime option. It must never instantiate default local storage in managed mode. Every handler uses its request-bound brain, not shared mutable state. The application does not own a caller-supplied runtime lifecycle.
- Managed pairing is unavailable. Session and agent authentication select a tenant from the control store, then repeat local service checks. Ignore tenant headers, query parameters and payload claims as routing authority. Register newly created agent token hashes in the control store and recheck revoked grants locally.
- Release request runtime handles on all response/error paths; do not evict pinned handles. No browser identity-header bypass, even in development.

- [x] Write and run a failing real-service test before implementation. The essential assertions are:

```ts
const a = await runtime.provision("https://issuer.example.test", "subject-a");
const b = await runtime.provision("https://issuer.example.test", "subject-b");
const sa = control.issueSession(a.id);
const sb = control.issueSession(b.id);
// Use actual Fastify injection and opaque cookies, not identity headers.
// POST each note with project_id:'inbox' and the same Idempotency-Key.
expect(savedA.statusCode).toBe(201);
expect(savedB.statusCode).toBe(201);
expect((await app.inject({url:`/api/v1/sources/${sourceA}`,headers:headersB})).statusCode).toBe(404);
expect((await app.inject({url:'/api/v1/search',headers:headersB})).body).not.toContain('SYNTHETIC_ACCOUNT_A');
```

- [x] Implement the smallest control store/runtime and shared-service binding needed for the test. Explicitly pass `{vault: tenantVaultPath}` when opening each `Storage`.
- [x] Extend tests for direct wrong-tenant services, spoofed tenant inputs, local-to-managed principal denial, separate real vault and protected directories, same-email/different-subject separation, suspension, expired/logout sessions, CSRF, agent token routing/revocation, export isolation and restart persistence.
- [x] Test containment against traversal, unknown tenant IDs and symlink/junction/file substitutions. Unknown or partially provisioned accounts cannot acquire runtimes. Do not use test-only branches in production.
- [x] Run `npm test -- tests/integration/managed.test.ts`, `npm run typecheck`, `npm run lint`, and the full existing suite. Parent verified the six-file foundation batch (108 tests), then the full integrated tree (239 tests, 26 files) plus typecheck/lint. Subsequent UI repair verification is still required.

## Task 2: Real typed System One transport (independent of Task 1)

**Files:**
- Create `packages/providers/system-one.ts`.
- Test `tests/integration/system-one.test.ts`.
- Do not modify worker/domain/app/UI while Task 1 is running.

**Interfaces:**
- Export a bounded `DecisionInput` containing a text state, one instruction, and a closed record of 2–16 distinct allowed option IDs/descriptions.
- Export `DecisionResult` with chosen option, confidence, exact per-option probabilities, token usage, provider/model/policy/price metadata and integer micro-USD cost.
- Export a `DecisionProvider` with `upperBound(input)` and `decide(input, signal)` and a `SystemOneProvider` real HTTP implementation using an injected `fetch` only for tests.
- Support official TypeSafe endpoint `https://api.typesafe.ai/v1/systemone` and explicit operator-selected Cloudflare Clef REST endpoint with its documented envelope; no arbitrary browser-provided URL or automatic provider fallback. Secrets server-side only. Allow explicit local loopback endpoints without credentials; reject remote plaintext, credentials/query/fragment in URLs, and redirects. Validate configuration before dispatch.
- Official request: `{model,state,questions:{decision:{type:'choice',instructions,criteria:options}}}`. Official Jev response: `{model,answers:{decision:{type:'choice',choice,confidence,probabilities}},usage:{input_tokens,output_tokens}}`. Cloudflare wraps that result in `{success:true,result:...}`. Verify official documentation rather than guessing variants.
- Validate exact option-key set, selected option membership and maximum probability consistency, finite 0–1 values, sum tolerance at most 0.001, confidence, nonnegative safe-integer usage, bounded response bytes and request bytes. Reject unavailable/error envelopes or malformed JSON with content-free errors.
- Versioned operator pricing is mandatory for paid remote dispatch. Zero output-token price is valid for decision providers. Conservative input bound uses UTF-8 payload bytes plus a documented overhead allowance; validate safe-integer total cost. Unknown pricing prevents requests. A transport failure after dispatch must not be described as zero-cost; the caller retains its reservation.
- Strict finite timeout and caller cancellation apply even if an injected fetcher ignores signals; no hidden retries or repair calls.
- Never claim probability calibration or semantic correctness from schema validation.

- [x] Write and run a failing test for the documented choice response, outbound fixed option set and integer usage/cost. These are protocol fixtures, not a live-provider response claim.
- [x] Implement only after the observed failure.
- [x] Extend tests for Clef envelope, unapproved option/extra probability key, invalid sum/choice/confidence, usage bounds, oversized input/response, secrets in input, insecure URLs, redirects, missing pricing/key, aborted/hung request, and content-free errors. Use a disposable local HTTP fixture where transport behavior matters.
- [x] Run `npm test -- tests/integration/system-one.test.ts`, typecheck and lint. Parent verified both provider suites in the 108-test foundation batch and full 239-test run. No live provider or calibration claim.

## Task 3: Standards-based managed login (depends on Task 1 review)

**Files:** `packages/identity/oidc.ts`, `apps/server/main.ts`, `apps/server/app.ts`, `apps/web/src.tsx`, `tests/integration/identity.test.ts`, `.env.example`, `docs/MANAGED_RUN.md`, resolved dependency lockfile.

- [x] Pin a maintained OIDC client after checking official package documentation. Use authorization code with PKCE S256, state, nonce, issuer/audience validation and exact configured callback; identity is `(issuer, subject)`.
- [x] Before implementation, write a local fake-issuer integration test exercising real redirect/callback/session/capture/logout and rejected replay/state/nonce/code cases. The fake issuer is isolated test infrastructure, not a production authentication bypass.
- [x] Store short-lived callback correlation server-side; use Secure HttpOnly SameSite=Lax callback cookie, rotate into opaque managed session with CSRF and expiry. No provider access/refresh tokens or auth codes in logs or UI. Reject arbitrary return URLs; fixed post-login destination only.
- [x] Add public runtime-mode metadata so local UI shows installation pairing and managed UI shows a real sign-in link or explicitly unavailable setup. Unknown metadata stays unavailable with real retry. Parent browser regressions verify account-switch clearing, late-response rejection and deferred-folder isolation; 15/15 combined journeys passed.
- [x] Managed startup requires explicit HTTPS origin, control DB/root and OIDC settings; missing config fails closed. Real entry-point tests verify refusal before opening local storage. Self-host default stays unchanged. Operator uses the identity provider for recovery/MFA; live provider operation remains unverified.
- [x] Verify two identities, account isolation, expiry/logout, restart and local regressions. Parent independently verified 245/245 tests, including real server/worker process capture and forced-restart persistence, plus 15/15 Chromium journeys. Live provider login, TLS and target-host graceful shutdown remain separate gates.

## Task 4: Tenant-bound durable worker (depends on Task 1 interfaces)

**Files:** modify `apps/worker/engine.ts`; create `apps/worker/managed.ts`, `tests/integration/managed-worker.test.ts`. Do not change reservation accounting in this task; the separately reviewed dispatch-accounting plan owns that transition.

**Interfaces:**
- `Worker` retains its existing constructor/tick interface but derives its internal owner via `brain.ownerPrincipal()`, never a module-global unbound owner. Persisted agent-originated job principals retain their scopes and must not be upgraded.
- `ManagedWorker(runtime, options?)` exposes `tick(): Promise<boolean>` and `stop(): Promise<void>`. It resolves the next active account exclusively from the control database by keyset cursor, wrapping for round-robin fairness; no client-supplied tenant or unbounded open-database scan. One tenant/job at a time initially, no new queue service.
- Pin `runtime.acquire(account.id)` across the full asynchronous worker call and release in `finally`. Invalid/corrupt account provisioning fails closed for that account without falling back to local data. Concurrent tick attempts do not dispatch overlapping jobs. `stop` prevents new work and awaits active work before runtime close.
- Provider factory injection is only for explicit operator policy/testing; no automatic external provider fallback. Default extractive operation must be useful without a key and clearly labeled.

- [x] Write and run a failing real runtime test before modifying engine. Capture in two managed brains, process through the scheduler, assert each source-linked brief contains only its own synthetic marker, and reopen to prove persistence.
- [x] Add deterministic fairness, scope/revocation, suspension-during-provider, pin-lifetime and stop/no-new-work tests. Test the existing Worker directly on a managed brain; old unbound-owner behavior must demonstrably fail before the change.
- [x] Verify focused managed-worker tests, existing local worker tests, typecheck and lint. Parent verified the worker suite in the 108-test foundation batch and full 239-test run. Startup/shutdown wiring exists, but actual managed process lifecycle remains a separate verification gate.

## Subsequent gated batches

Prepare separate concrete plans after reviewing the foundations: fair tenant-local workers and shutdown; per-dispatch/aggregate/global budget reservations; System One advisory receipts and evaluated policy integration; conversational evidence-backed understanding and recall; guided native adapters; billing/webhooks/entitlements; final approachable UI and release operations. Their gates remain unchecked in the release spec and milestone tracker. This foundation plan does not claim those independent subsystems are implemented.
