# Plan 6: cut dead code only (design)

Date: 2026-10-28. Branch `reframe/cleanup`, built on `reframe/recall-embeddings` (PR #32, head `ce6e9a0`).

## Scope

The owner chose "cut dead code only". This plan removes four things and nothing else:

1. **Paddle remnants.** Dodo replaced Paddle in commit `cfa94e8`. Production startup already throws when any `BRAIN_PADDLE_*` field is set, so every Paddle-only module, config branch, route branch, CSP branch and test is dead.
2. **Retired UI flows.** The old prepared-plan review modal, its "Review later" (snooze) modal and the "Your plan changed after acceptance" compare modal in `apps/web/src.tsx`. Nothing sets `dialog` to `"review"` or `"compare"`, and `"snooze"` is only set from inside the review modal. The Brief on Today replaced all three (plan 1).
3. **Test-only and dead code.** `rankAnswers` (and its private helpers) in `packages/domain/ask.ts`; `Brain.agentAsk`, `Brain.agentSearch` and `Brain.activeEvidence` in `packages/domain/service.ts`; `fillRecallIndex` in `packages/storage/recall-index.ts`.
4. **Stale docs.** The Paddle design spec moves to `docs/history/`; the Paddle configuration and checkout prose in `docs/MANAGED_RUN.md`, `docs/API.md`, `docs/ARCHITECTURE.md` and `docs/SECURITY_PRIVACY.md` is replaced by the Dodo facts that already live in `docs/DODO_PAYMENTS.md`.

No features, no refactors, no renames, no unrelated bug fixes. The `scripts/native-client-proof.ts` Codex trust fix stays out.

## Frozen boundaries

These do not change, byte for byte, and their tests run unmodified as the proof:

- Dodo: `apps/server/dodo-config.ts`, `packages/providers/dodo.ts`, `packages/providers/dodo-evidence.ts`, `packages/runtime/dodo-billing.ts`, `packages/storage/dodo-store.ts`, `packages/domain/dodo-webhook.ts`.
- Billing authority and the money ledger: everything under `packages/storage/billing-*`, `packages/domain/billing-*`, `packages/runtime/managed-*`, `apps/worker/managed*.ts`, `scripts/managed-*.ts`, and `managedPreferencesPatchSchema`.
- Docs the owner is editing on another branch: `docs/DODO_PAYMENTS.md`, `docs/PRICING_PROPOSAL_2026-10-21.md`, `docs/RELEASE.md`, `docs/IMPLEMENTATION_PLAN.md` (zero edits here; see rulings).
- Migrations and tables: no migration is dropped or altered. The `paddle_*` tables inside `paddle.sqlite` / `dodo.sqlite` (created by `PaddleStore`, extended by `DodoStore`) stay, and `managed-recovery.ts` keeps copying and quiescing `paddle.sqlite` in backups.
- Tests that are frozen: `tests/integration/dodo-authority.test.ts`, `tests/integration/dodo-billing.test.ts`, `tests/e2e/billing-ui.spec.ts`, every `managed-*` and `billing-*` test, `paddle-store.test.ts`, `paddle-authority-flow.test.ts`, `paddle-transport.test.ts` (these three test shared code that Dodo runs on; see rulings).

## Inventory

Evidence was gathered with `grep -rn` over `apps`, `packages`, `scripts`, `tests`, `evals`, `contracts`, `docs`, `README.md`, `.github` and `playwright.config.ts`, excluding `node_modules`. "Importers" counts files outside the module itself. Dynamic references were checked: Fastify route registration in `apps/server/app.ts` and `billing-routes.ts`, string-keyed job kinds in `apps/worker/main.ts`, MCP tool names in `apps/mcp/main.ts`, CLI commands in `apps/cli/bibrain.mjs`, `package.json` scripts, `playwright.config.ts` projects, `.github/workflows/verify.yml`, and Markdown links.

### Paddle

| File or symbol | Lines | Evidence | Verdict |
| --- | --- | --- | --- |
| `packages/runtime/paddle-billing.ts` (`PaddleBillingService`) | 200 | Imported as a type only by `apps/server/app.ts:22` and `apps/server/billing-routes.ts:5`; constructed only in `tests/integration/paddle-http.test.ts`. `apps/server/main.ts` never builds it. | **Cut** (after the wiring edit) |
| `packages/providers/paddle-evidence.ts` (`PaddleEvidenceSource`) | 113 | Zero non-test importers; only `tests/integration/paddle-evidence.test.ts`. | **Cut** |
| `packages/domain/paddle-signature.ts` (`verifyPaddleWebhook`, `PADDLE_WEBHOOK_MAX_BODY_BYTES`) | 92 | `verifyPaddleWebhook` used only by `paddle-billing.ts` and `paddle-boundary.test.ts`. The constant is used by `billing-routes.ts:68` as the webhook `bodyLimit`; `DODO_WEBHOOK_MAX_BODY_BYTES` in `dodo-webhook.ts:6` has the same value (`256 * 1024`). | **Cut-with-wiring-edit** (routes switch to the Dodo constant) |
| `packages/providers/paddle.ts` `PaddleClient`, `PaddleClientConfig`, `PaddleRequestRejectedError`, `PaddleCreatedButUnusableError`, response schemas | 447 of 464 | Used only by `paddle-billing.ts`, `paddle-evidence.ts` and the Paddle tests. | **Cut** the client; file stays |
| `packages/providers/paddle.ts` `PaddleTransport`, `PaddleMode` | 17 | `PaddleTransport` is implemented by `bounded-fetch.ts:14` and is the transport type in frozen `dodo.ts:3`; `PaddleMode` is imported by `paddle-store.ts:6`. | **Keep** (reason: frozen `dodo.ts` imports it from `./paddle.ts`) |
| `packages/domain/paddle-event.ts` `normalizePaddleEvent`, `eventSchema`, `optionalId`, `token`, `paddleId`, `invalid` | 86 of 108 | `normalizePaddleEvent` used only by `paddle-billing.ts` and `paddle-boundary.test.ts`. | **Cut** |
| `packages/domain/paddle-event.ts` `PaddleEventProjection` | 22 | Imported by frozen `dodo-webhook.ts:4` and by `paddle-store.ts:5`; `normalizeDodoEvent` produces it with the `transaction.completed` / `subscription.updated` / `adjustment.updated` values. | **Keep** (reason: frozen Dodo webhook returns this type) |
| `packages/storage/paddle-store.ts` (`PaddleStore`) | 783 | `DodoStore extends PaddleStore` (`dodo-store.ts:8`); `paddle-worker.ts` and `managed-recovery.ts` depend on its tables. | **Keep** (reason: base class of the frozen Dodo store; schema history) |
| `packages/runtime/paddle-worker.ts` (`PaddleBillingWorker` aliased `ProviderBillingWorker`, `createBillingAuthorityForProvider`) | 102 | Constructed in `apps/worker/main.ts:337-345` for Dodo; used by `dodo-authority.test.ts`, `dodo-billing.test.ts`, `paddle-authority-flow.test.ts`. | **Keep** (reason: the live Dodo reconciliation worker; renaming is a refactor) |
| `apps/server/config.ts` `RuntimePaddleConfig`, `paddleConfig`, `paddle?` field | 129 | `main.ts:19-20` and `worker/main.ts:56-57` throw if `config.paddle` is set; nothing else reads it. Tested only by `paddle-config.test.ts`. `runtime-config.test.ts` has no Paddle assertion. | **Cut** |
| `apps/server/main.ts:19-20`, `apps/worker/main.ts:56-57` "Paddle is retired" guards | 4 | Depend on the field above; no test asserts the message. | **Cut** |
| `scripts/run.mjs:23-24` `BRAIN_PADDLE_API_KEY` / `BRAIN_PADDLE_WEBHOOK_SECRET` scrub | 2 | Variables no longer read anywhere. | **Cut** |
| `apps/server/billing-routes.ts` Paddle branch (`paddle-signature` header path, `PaddleBillingService` union) | ~12 | `"provider" in billing` is always true for Dodo; the `else` branch is unreachable in production. | **Cut-with-wiring-edit** |
| `apps/server/app.ts:22,115-116,311-313` Paddle type import, union, Paddle CSP branch | ~5 | CSP branch only taken when `billing` lacks `provider`; no test asserts `Content-Security-Policy`. | **Cut-with-wiring-edit** |
| `tests/integration/paddle-config.test.ts` | 85 | Tests `paddleConfig` only. | **Cut** |
| `tests/integration/paddle-http.test.ts` | 345 | Builds `PaddleBillingService` + `PaddleClient`. | **Cut** |
| `tests/integration/paddle-provider.test.ts` | 166 | Tests `PaddleClient`. | **Cut** |
| `tests/integration/paddle-evidence.test.ts` | 182 | Tests `PaddleEvidenceSource`. | **Cut** |
| `tests/integration/paddle-boundary.test.ts` | 106 | Tests `verifyPaddleWebhook` and `normalizePaddleEvent`. | **Cut** |
| `tests/integration/paddle-store.test.ts` | 358 | Tests `PaddleStore`, the base of `DodoStore`. | **Keep** (shared store) |
| `tests/integration/paddle-authority-flow.test.ts` | 88 | Tests `PaddleBillingWorker` with a synthetic evidence source: the Dodo worker path. | **Keep** (shared worker) |
| `tests/integration/paddle-transport.test.ts` | 50 | Tests `BoundedFetchTransport`, which `main.ts` gives to `DodoClient`. | **Keep** (shared transport) |
| `tests/integration/billing-operator-lifecycle.test.ts:224-268` `PaddleStore` in a backup | — | Proves `managed-recovery` carries `paddle.sqlite`. | **Keep** (frozen managed test) |
| `packages/runtime/managed-recovery.ts` `paddle.sqlite` handling | ~40 | Backup manifest field `paddle_store`, restore quiesce of `paddle_*` tables; frozen managed behaviour. | **Keep** |
| `docs/superpowers/specs/2026-10-17-paddle-billing-design.md` | 317 | Linked only from `docs/history/BUILD_LOG.md` and `docs/history/NEXT_AGENT_HANDOFF.md` (kept word for word) and elided in the renewal-safe plan. | **Move** to `docs/history/PADDLE_BILLING_DESIGN_2026-10-17.md` |
| `docs/MANAGED_RUN.md:8,30-47,50-95,187` Paddle table and B1 section | ~70 | Describes `paddleConfig` and `PaddleBillingService`, both removed. | **Edit** (replace with the Dodo pointer) |
| `docs/API.md:6,86,88,96` | 4 | "raw signed Paddle webhook", "Paddle transaction", `Paddle-Signature`, "Paddle.js". | **Edit** |
| `docs/ARCHITECTURE.md:142-163` "The following Paddle paragraphs" | 22 | Describe the removed adapter. | **Edit** (one paragraph pointing to history) |
| `docs/SECURITY_PRIVACY.md:27` "fixed Paddle operations" | 1 | Row describes the provider adapter. | **Edit** (one word) |
| `docs/BUSINESS.md:45-101` Paddle provider direction | — | A dated business record (2026-10-17), not code; `DODO_PAYMENTS.md` and `ARCHITECTURE.md` already record the supersession. | **Keep** |
| `docs/DESIGN_BRIEF.md:738`, `design/BiBrain-HANDOFF_1.md:160`, `.env.example:23`, `docs/REFRAME_BRIEF.md:92` | — | One-word mentions in out-of-scope lists or history notes. | **Keep** |
| `docs/IMPLEMENTATION_PLAN.md:259-261,313-330` | — | Historical checklist with the owner's uncommitted edits on another branch. | **Keep** (see rulings) |

### Retired UI flows

| File or symbol | Lines | Evidence | Verdict |
| --- | --- | --- | --- |
| `apps/web/src.tsx:2653-2722` `dialog === "review"` modal | 70 | No `setDialog("review")` anywhere (`grep -n 'setDialog("' apps/web/src.tsx`); the only non-literal call is `setDialog(null)`. Calls `/proposals/:id/accept` and `/dismiss`, which `today/BriefCard.tsx` now owns. No e2e text match for "Prepared, not applied". | **Cut** |
| `apps/web/src.tsx:2723-2757` `dialog === "snooze"` modal and the `snooze` state (`:350`, `:557`) | 40 | `setDialog("snooze")` appears once, at `:2699`, inside the dead review modal. No test references "Review later" or `/snooze`. | **Cut** |
| `apps/web/src.tsx:2758-2788` `dialog === "compare"` modal and the `comparison` state (`:369-372`, `:537`) | 36 | No `setDialog("compare")`; `setComparison` is only ever called with `null`, so `comparison` is never non-null. | **Cut** |
| `POST /api/v1/proposals/:id/snooze` (`app.ts:815-816`, `service.ts:1667`) | — | No client after the modal goes; documented in `docs/API.md`; the loop also registers `accept` and `dismiss`, which the Brief uses. | **Keep** (reason: documented API route; removing it is an API change, not dead-code removal) |
| `apps/web/src.tsx` `proposal` state | — | Still used by `editPlan` (`:1161`) and the `"plan"` dialog (`:2898`). | **Keep** |
| Every file under `apps/web/brain`, `apps/web/today`, `apps/web/connections` | — | Each has exactly one importer; all render. | **Keep** |
| `tests/e2e/proactive-goal.spec.ts`, `docs/screenshots/*.png` | — | The spec tests the live "Choose a goal" flow; screenshots are either referenced or kept as synthetic evidence. | **Keep** |
| Unreferenced CSS classes left by the modals | — | Not inventoried; CSS pruning is not dead-code removal the owner asked for. | **Keep** |

### Test-only and dead code

| File or symbol | Lines | Evidence | Verdict |
| --- | --- | --- | --- |
| `packages/domain/ask.ts` `rankAnswers`, `overlap`, `bestSentence`, `factText` import | 47 | `rankAnswers` referenced only by `tests/integration/ask.test.ts`. `questionWords` (live: `recall.ts`, `recall-push.ts`, `service.ts`) and `AskHit` (live: `service.ts:5153`) stay. | **Cut** |
| `Brain.agentAsk` (`service.ts:3558-3591`) | 34 | Comment says "No HTTP route since surface v2". Callers: `tests/eval/brain-eval.test.ts:82`, `build-review-fixes.test.ts:97`, `context-conflicts.test.ts:68,99`, `memory-understanding.test.ts:63`. Not in `app.ts`, `apps/mcp/main.ts`, `apps/cli`, `contracts/brain.schema.json` or `scripts/brain-eval.mjs`. | **Cut**; the tests assert the same facts through `currentClaims` |
| `Brain.agentSearch` (`service.ts:3430-3463`) | 35 | Same comment. Callers: `build-review-fixes.test.ts:98-103`, `context-conflicts.test.ts:71-75,102-106`, `gate.test.ts:162`. It wraps `pages()` and `sources()`, both public and used by HTTP routes. | **Cut**; the tests call `pages` / `sources` directly |
| `Brain.activeEvidence` (`service.ts:5396-5398`) | 3 | Zero references outside its definition, in code or tests. | **Cut** |
| `fillRecallIndex` (`recall-index.ts:327-334`) | 8 | Zero callers; `rebuildRecallIndex` is the production path. Noted as dead in `docs/superpowers/plans/2026-10-25-recall-followups.md:74`. | **Cut** |
| `excerpt` helper in `service.ts` | — | Still used at `service.ts:4157` after the cuts. | **Keep** |
| `Brain.agentGet` | — | Six internal calls. | **Keep** |
| `Brain.decisionAdvisoriesForGoal` | — | Zero non-test callers, four managed test files. | **Keep** (reason: managed behaviour and its tests are frozen) |
| `source_fts` writes and count-reads | — | No `MATCH` reads remain, but every source insert, edit, purge, vault rebuild and forget-proof count still touches the table and the DDL is schema history. | **Keep** (reason: schema and forget proof; BUILD_STATE already records it as retained) |
| `apps/web/src.tsx` `dialog === "review"` API calls to `/proposals/:id/accept` | — | Routes stay (Brief uses them). | **Keep** |

### Other scans (nothing found)

- Every module under `packages/` and `apps/` has at least one non-test importer except `paddle-evidence.ts` (listed above).
- Every `package.json` script resolves to a file. No script references a removed file.
- `playwright.config.ts` projects and `tests/e2e/*.spec.ts` reference no removed symbol or text.
- `.github/workflows/verify.yml` runs the whole suites, never a file by name.
- No Markdown link checker exists in the repo; the final docs task greps links by hand.

## Rulings

1. **Shared Paddle-named modules stay under their names.** `paddle-store.ts`, `paddle-worker.ts`, the `PaddleTransport` / `PaddleMode` types in `paddle.ts` and the `PaddleEventProjection` type in `paddle-event.ts` are load-bearing for frozen Dodo code (`dodo-store.ts`, `dodo.ts`, `dodo-webhook.ts`, `apps/worker/main.ts`). Renaming them would touch frozen files, so they keep their names and get a one-line comment saying why.
2. **Paddle-specific parts are stripped from non-Dodo files only** (`config.ts`, `main.ts`, `worker/main.ts`, `run.mjs`, `billing-routes.ts`, `app.ts`, `paddle.ts`, `paddle-event.ts`). Every such task is **Opus implementer + Opus reviewer** and must end with `dodo-authority`, `dodo-billing`, `paddle-store`, `paddle-authority-flow`, `paddle-transport`, `billing-operator-lifecycle`, `managed-recovery`, `runtime-config` and `deployment` tests green, unmodified.
3. **The webhook body limit changes constant, not value.** `billing-routes.ts` moves from `PADDLE_WEBHOOK_MAX_BODY_BYTES` to `DODO_WEBHOOK_MAX_BODY_BYTES`; both are `256 * 1024`. No test asserts the limit, so the Task 3 reviewer checks the two constant definitions in the diff (pre-flight F6).
4. **The Paddle CSP branch goes.** With `PaddleBillingService` gone the condition `!("provider" in options.billing)` can never be true; the plain CSP is the only one left. No test asserts the header; the reviewer checks the string is byte-identical to the former `else` branch.
5. **`docs/IMPLEMENTATION_PLAN.md` is not edited.** The owner has uncommitted edits to it on another branch; its Paddle lines are a dated checklist. The controller should decide whether to touch it after the owner's edits land.
6. **`docs/BUSINESS.md` is not edited.** It records why Paddle was chosen on 2026-10-17; the supersession is recorded next to it. Business history, not code.
7. **Test rewrites replace `agentAsk` / `agentSearch` with the primitives they wrapped**, asserting the same fact with the same principal: `currentClaims(p, project)` for `agentAsk`, `pages(p, project, query, includeRetired)` for current/historical search, `sources(p, project, query)` for raw search. No assertion is weakened; in `gate.test.ts` the raw check becomes stricter (it inspects full sources, not excerpts).
8. **Only `.test.ts` files that test removed code are deleted** (`paddle-config`, `paddle-http`, `paddle-provider`, `paddle-evidence`, `paddle-boundary`). `ask.test.ts` keeps its `questionWords` cases.
9. **Migrations and tables are untouched.** `PaddleStore` creates `paddle_checkout_intents`, `paddle_events`, `paddle_bindings` (and `DodoStore` adds `dodo_sessions`) inside the provider SQLite file. They stay. `managed-recovery.ts` keeps the `paddle_store` manifest field.
10. **`apps/cli/bibrain.mjs` line endings.** If a task shows it as modified with no content change, `git restore apps/cli/bibrain.mjs` before committing.

## Verification gates

Per task: `npm run typecheck`, `npm run lint`, the targeted Vitest files named in the task. Tasks near billing add `npx vitest run tests/integration/dodo-authority.test.ts tests/integration/dodo-billing.test.ts tests/integration/paddle-store.test.ts tests/integration/paddle-authority-flow.test.ts tests/integration/paddle-transport.test.ts tests/integration/billing-operator-lifecycle.test.ts tests/integration/managed-recovery.test.ts tests/integration/runtime-config.test.ts tests/integration/deployment.test.ts`.

Whole branch, in this order, before the final docs commit:

```
npm run typecheck
npm run lint
npm run build
npm audit --audit-level=high
npx vitest run --reporter=dot --maxWorkers=3
npm run brain-eval
npx playwright test --workers=1
git restore docs/screenshots
```

Expected deltas against the counts in `BUILD_STATE.md` (189 Vitest files, 1,955 passed, 8 skipped; 107 Playwright passed): five Vitest files fewer (184) and about 25 fewer Vitest tests (the 21 Paddle-only cases plus 4 `rankAnswers` cases dropped); Playwright unchanged at 107.
