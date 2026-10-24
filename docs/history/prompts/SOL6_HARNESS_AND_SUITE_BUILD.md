# Bi Brain: harness V1 and product suite build order

Owner-directed implementation brief for GPT-6 Sol · 2026-09-28

## Start here

Build this in the existing Bi Brain repository. Evolve the running application; preserve user data and working features. This file is a build specification, not a claim that any feature is implemented. Use GPT-6 Sol as requested by the owner; do not claim to switch the current model through prose or alter global settings.

Read AGENTS.md, BUILD_STATE.md, this file, the verification review, and existing architecture, data, API, UX, and testing documents. The owner's latest requirements below supersede conflicting earlier product specifications. Record resulting decisions and update the older documents as each milestone lands. Do not implement two competing authorities or leave contradictory completion claims.

The repository now records repairs to the three review findings. Verify those regressions first rather than assuming the earlier findings remain open or blindly reimplementing their fixes.

Work through the ordered milestones without stopping after a visual mockup or a planning pass. Complete independent work when credentials or external clients block a narrow verification gate. Report the blocked gate honestly. Do not deploy, buy services, message other chats, or publish under an invented license as part of this brief.

## Product vision

Bi Brain is the personal knowledge and continuity suite that every supported agent can use. It remembers evidence, keeps an inspectable current understanding, carries work between agents, and prepares useful next steps around explicit intentions. Its promise is Save → Continue → Get ahead. Its internal contract is Capture → Gate → Compile → Bind → Prepare → Review → Learn.

The GUI must feel like one designed suite of connected workspaces. The first value is still saving one real conversation and continuing from it. Avoid a giant settings dashboard, a chat-only wrapper, or an endless feed of generated suggestions. Every surface uses the same real records and permissions.

V1 ships the seven harness requirements plus secret scanning, minimum intent support, portable vault specification, folder/chat import, handoff, and the release evals they depend on. More advanced scoring, coordination, classifier routing, graph exploration, and compression follow in that order. Do not build all differentiators before proving V1.

## Non-negotiable contracts

### 1. Evidence, secrets, and the write gate

An authorized capture is durably saved in `raw/` before any classification or derivation. Original bytes are immutable except explicit permanent deletion. Assign a stable source ID, content hash, source time, ingestion time, project scope, and origin agent. Imported instructions are evidence, never authority.

Run secret detection before content can enter tracked vault files, sync, model requests, telemetry, previews that reveal detected secrets, or agent packs. Suspected-secret raw bytes remain in a local protected, untracked `raw/quarantine/` area with restrictive permissions and an owner-visible warning. Do not silently redact the only original or reject an otherwise authorized capture as low value. Derived copies may redact with explicit provenance. Quarantined material must be outside the shareable Git root, not merely protected by a best-effort ignore pattern. Test private-key blocks and representative API credential patterns without using real keys. Scanner coverage is bounded; do not claim perfect secret detection.

Agents call `brain.propose`, never an unrestricted write tool. Return:

```ts
type GateResult = {
  proposal_id: string;
  raw_id: string;
  disposition: 'commit' | 'queue' | 'drop';
  type: 'fact' | 'decision' | 'identity' | 'intent' | 'rule' | 'hypothesis' | 'unknown';
  confidence: number; // calibrated classifier confidence, not probability of truth
  reason_codes: string[];
  policy_version: string;
  classifier_version: string;
  claim_ids: string[];
};
```

`drop` means no compiled promotion; it never discards the captured raw evidence. Decisions and identity changes always require owner review. Facts may auto-commit only if supported by exact accessible evidence, above a calibrated threshold, nonconflicting, nonsensitive, and authorized for that scope. Confidence alone is insufficient. Self-reported identity and preferences cannot evade review by being labeled facts. Model or policy failure defaults to queue, not commit. Human decisions are versioned and auditable.

### 2. Current truth and a claim ledger

Each topic page starts with current accepted understanding, then uncertainty/conflicts, open intents, and provenance/history. Default search, ask, and binding use current truth. `include_retired: true` is explicit and never bypasses permissions. Historical answers label valid intervals. Raw source search is a distinct requested mode.

Every compiled factual statement references ledger entries with at least `(entity, aspect, value, source, agent, ts, valid_from, valid_to)`. Add stable claim ID, project, source version/span, status, authority, recorded-at time, and supersession/conflict links. Multi-source support uses explicit evidence links. Identity is owner-wide private by default; sharing requires explicit field allowlisting.

Define normalized aspect schemas and value semantics. Incompatible values for the same entity/aspect with overlapping validity intervals become a conflict set; temporal succession is not automatically contradiction. Do not silently use newest-wins. Deterministic conflict checks handle typed fields; uncertain semantic conflicts go to review. Hypotheses never compile as accepted facts. Retiring a claim closes its validity without erasing its evidence.

### 3. Forced binding, with a real integration boundary

Before a supported client starts model work, its session adapter injects an authorized pack containing `who-i-am`, up to three relevant current pages, and open intents. Use three when available; never fabricate or duplicate missing pages. Rebuild/revalidate before risky actions through a supported client pre-action hook. Use a bounded pack, stable hash, source versions, expiry, exclusions, and omission reasons.

An MCP server alone cannot force arbitrary clients to inject context. Provide client-specific session/pre-action adapters and a tested wrapper where necessary. Classify integrations as enforced, cooperative, or manual. Do not claim universal forced binding from a prompt or an optional search call. Fail closed for policy-designated risky operations in enforced adapters if binding cannot be validated; show the recovery path. Imported content never becomes a system instruction.

Log pack delivery separately from use. The binding eval must demonstrate behavior on a task requiring pack-only context; an acknowledgement or tool invocation alone is not evidence of use.

### 4. Exactly eight public agent tools

| Tool | Contract |
| --- | --- |
| `brain.search` | Scoped current-truth retrieval; explicit historical/raw modes and pagination |
| `brain.get` | Fetch authorized page, source, claim, intent, receipt, or handoff by stable ID |
| `brain.propose` | Capture raw and request gated promotion; idempotent, typed result |
| `brain.forget` | Authorized deletion request and verifiable proof; never silently expand scope |
| `brain.link` | Propose typed relations through the same gate; expected versions required |
| `brain.ask` | Grounded answer with claim/source references, uncertainty, and abstention |
| `brain.intent` | Typed list/get/propose/update/close operations on open loops; gated mutations |
| `brain.diff` | Authorized comparison of revisions, proposed changes, and receipts |

Read-only tokens see only search/get/ask/diff. Intent reads remain available through get/search; do not expose a mutating intent schema to read-only clients. Write-capable grants expose only the permitted subset, never automatically all eight. Forget requires a dedicated scope and owner approval or explicitly preauthorized deletion scope. Read filtering and method authorization also occur in shared services, not just tools/list. Owner GUI endpoints may be richer than the eight public tools.

### 5. Dream with a receipt and safe revert

An opted-in nightly/catch-up job interprets changes against current claims and open intents, stages useful updates, passes them through the gate, and writes `dreams/YYYY-MM-DD.md`. Multiple runs append separately identified entries rather than overwriting the day's history. Include run ID, input hashes, model/policy versions, what changed, refused/queued/abstained items, evidence references, before/after diffs, cost/usage status, and resulting commit IDs. Do not copy secret or deleted text into receipts.

Use the existing durable worker, leases, fencing, and budgets. Activity heartbeats cancel publication while the owner is actively using the workspace or an agent session holds an active work lease. Check activity before provider dispatch and again atomically before publication. An already dispatched provider call may still incur cost: record it and discard cancelled output. Quiet hours and catch-up must not cause duplicate daily notifications.

Committed dream changes are reversible through `git revert` on the managed vault with conflict handling; never use a destructive hard reset. Owner edits made later must survive. Revert is an audited transaction, updates indexes, and reruns the secret and deletion barriers. An old revision cannot resurrect forgotten material. Physical erasure takes precedence over indefinite reversibility.

### 6. Forget proof

Return an operation ID, per-store evidence, verification timestamp, deletion generation, and:

```ts
{ file_gone: boolean; index_gone: boolean;
  embedding_gone: boolean; graph_edge_gone: boolean }
```

Any false bit means incomplete deletion, never success. Verify absence by reads after deletion, not because a delete call returned. Track capability and evidence separately: if embeddings/graph are not configured, report that fact and prove no such active artifacts exist; do not imply a nonexistent subsystem was tested.

Traverse source/claim dependencies across projects, old revisions, receipts, handoffs, packs, caches, search, embeddings, edges, and in-flight jobs. Revoke stale pack generations and invalidate outputs. Previously transmitted client/provider copies cannot be recalled; report that boundary. Tombstones prevent resurrection during restore/import/revert. Backups and Git history are part of the explicit retention report. Do not set `file_gone` true while managed vault history still holds the content. Provide controlled history sanitation when permanent forgetting requires it; explain effects on historical revert. Unmanaged copies remain an explicitly reported limitation, never a fabricated proof.

### 7. Intent, outcomes, claims, and handoff

Open loops live in `intent/`, separate from wiki prose, with owner, goal, status, due/review time, permission to prepare, evidence links, next step, and last-notified date. The dreamer maintains proposed progress; it cannot invent completion. Proactive pings originate only from eligible open intents, pass S1, obey quiet hours, and are capped at one per local day across the brain. Operational failures are separate UI status, not loopholes for promotional pings.

Record rule use as success/fail/unknown with actor, evidence, task context, and timestamp. Unknown is not failure. Down-rank repeatedly failing rules for pack selection using a documented conservative score; never erase evidence or treat noisy feedback as ground truth. Show owner override and minimum-sample behavior.

Session claims lease a page for 20 minutes with holder, expiry, heartbeat, base revision, and fencing token. Another agent receives the last committed page labeled as claimed/stale, with holder identity permitted by scope. Claim leases do not replace optimistic version checks; expired writers cannot overwrite a successor. Claim management is adapter/session infrastructure, not a ninth public tool.

Generate `handoff/current.md` plus retained revisions: goal, done, blocked, files touched, decisions today, outstanding intents, source references, and next action. Label observations versus agent reports. Generate per authorized project/session, not by combining private projects. Switching agents should be a first-class GUI action with exact pack/handoff preview.

## Portable vault and migration decision

The previous SQLite-only authority is insufficient for this new request. Introduce a versioned, documented vault where evidence, claims, accepted pages, intents, receipts, links, and handoffs can be read without Bi Brain's server. SQLite remains the rebuildable query projection plus operational state for jobs, grants, leases, and budgets; secrets never enter portable content.

Suggested layout (final names belong in `bi-brain-vault.md`):

```text
vault/
  bi-brain-vault.md
  manifest.json
  raw/                 # immutable permitted evidence; excludes quarantine
  claims/              # append-only ledger events, subject to explicit erasure
  wiki/                # compiled current pages, IDs and evidence frontmatter
  identity/            # field-level disclosure policy
  intent/
  links/
  handoff/
  dreams/
  tombstones/          # IDs/generations, no deleted source text
```

Managed Git lives inside the runtime vault, never the application-code repository. No automatic remote push. Quarantine and credentials live outside that Git root. Sensitive identity content requires explicit sharing policy; portable does not mean public.

Define authoritative file formats, stable IDs, schema version, timestamps, reference syntax, lifecycle states, content hashes, path normalization, portability, and rebuild semantics. File reads must be useful to a simple Markdown-capable agent; machine records preserve precise semantics. External edits are staged as proposals on import/reconciliation; external files do not bypass the gate.

Implement a journal/outbox protocol for DB/files/Git rather than claiming an impossible cross-system transaction. Stage validated files, atomically publish a generation manifest, and project idempotently. Readers see a complete generation; interrupted stages recover or roll back. Rebuild search and claims projections from portable records. Back up and migrate existing data with a dry run, stable ID preservation, reconciliation counts, and a tested rollback. No destructive migration without a recoverable backup.

## Product suite: visual and interaction direction

Preserve familiar primary navigation: **Today · Your brain · Connections**. Make each a substantial workspace with contextual subnavigation, consistent shell, project switcher, global capture, search/command palette, and a right-side evidence inspector. Add a clear Continue action. On small screens, use a compact navigation bar and full-screen inspector with a reliable back path.

| Workspace | What the user does | Required surfaces |
| --- | --- | --- |
| Today | Resume and review | One focused next step, current handoff, intent agenda, review queue, latest dream receipt |
| Your brain | Understand and correct | Current pages, Claims, Sources, Intents, History; shared project scope and search |
| Connections | Bring knowledge and agents | Folder drop/chat import, agent setup, tested binding level, grants, handoff preview |
| Settings | Control behavior | Background help, local privacy/forget proof, vault location/export, spending, appearance |

These are connected workspaces, not seven equal-weight dashboard cards. Retain user's project/filter/navigation state, support deep links and browser back/forward, and provide meaningful empty states. A claim opens its evidence; an intent opens its preparation; a receipt opens its diff; a handoff opens exactly what the next agent receives.

Design language: warm neutral canvas, restrained green accent, strong readable type hierarchy, generous rhythm, clear borders and selected states, focused content columns, and a polished light/dark pair. Use actual product content, not gradients, fake charts, brain-shaped decoration, or a graph as the home screen. Refactor reusable shell, navigation, list/detail, editor, inspector, diff, and status components out of the oversized page component as needed.

Current page layout: title and current-status line; short accepted understanding above the fold; visible conflicts/unknowns; next relevant intent; evidence and history below. Review uses side-by-side before/after when space permits and stacked comparison on mobile. Technical IDs, classifier routing, and tokens stay in an expandable details layer.

First run: paste/import → saved confirmation → useful page → Continue preview. Offer integration and background help after value. No mandatory taxonomy, tutorial carousel, account OAuth, or model selection. Every button must work or be clearly unavailable with an explanation. No fictional activity outside labeled sample mode.

If a public marketing site is later requested, show the actual suite and its verified workflows. This task prioritizes the working application, not a replacement landing page or speculative pricing cards.

## Implementation order and acceptance gates

### S0 — Baseline and migration design

Recheck the three repaired regressions and current test suite. Inventory implemented versus missing requirements. Write the vault authority/migration ADR, threat boundaries, eight-tool contracts, and a dependency map. Update BUILD_STATE without calling a planned item delivered.

Gate: current capture/prepare/agent flows remain working; review regressions pass; migration and authority are unambiguous.

### S1 — Evidence vault, secret scanner, and deletion foundation

Implement portable versioned evidence and migration, protected quarantine, generation journal, managed local Git, rebuild, and deletion tombstones/history policy. Establish a minimal vertical save → raw → rebuild → retrieve flow before expanding the UI.

Gate: crash injection between publish steps loses no acknowledged capture; reindex reproduces content; known secret fixtures never enter tracked objects/provider payloads; migration/rollback round trip preserves IDs. A mounted folder is readable without a running server.

### S2 — Claim ledger, gate, and current pages

Implement typed claims, conflicts, retirement, policy-based propose, review queue, deterministic compilation, and current-default retrieval. Start rules-first S1 with a versioned small-classifier interface. Provide and evaluate a runnable offline classifier before claiming offline classification complete; missing/uncertain classification queues safely. Add paid/hard-call routing later, not as a prerequisite for capture.

Gate: decisions/identity queue despite high confidence; supported nonconflicting facts can commit; raw survives drop; retired facts do not appear in default results/packs; conflicting claims remain inspectable and are not silently resolved.

### S3 — Suite shell and knowledge workspaces

Build the persistent shell and the Today/Your brain workspaces over S1/S2 records. Deliver real current-page, claims, evidence, review, and history views, not placeholder tabs. Preserve existing functionality while breaking the large UI into coherent components.

Gate: keyboard-complete capture → page → evidence → correction → review flow; deep links, back navigation, light/dark, reduced motion, and 320/360/768/1280px layouts. A new user needs no explanation to save and reuse material. Record human usability separately from browser tests.

### S4 — Eight tools, binding adapters, and handoff

Replace/transition the old five-tool interface with documented compatibility behavior. Enforce grants in discovery and invocation. Build session/pre-action binding, scoped identity, open-intent pack, handoff, and Connections setup/status. Add minimal intent storage here; S5 builds its scheduling behavior.

Gate: read-only tokens see no write tools and direct mutation attempts fail. Two supported native clients demonstrate the same current understanding, correction, revocation, and handoff. Record exact adapter support; missing client availability leaves that gate unverified. Enforced binding eval proves pack use without a search call.

### S5 — Real dream reasoning, intents, receipts, and revert

Wire the reasoning provider to goal/intent preparation, replacing the fixed extractive template when configured. Preserve an honestly labeled offline fallback. Use structured candidate claims/actions, schema/reference validation, conflict checks, calibrated S1 admission, and abstention. Add daily intent eligibility, active-user cancellation, receipts, diffs, and safe Git revert.

Gate: an explicit open loop produces a useful prepared next step within 24h on an available running host without a new prompt; fabricated evidence cannot publish; active-user race cancels publication; one-ping cap survives restart/DST; revert preserves intervening edits and cannot resurrect deleted evidence. Real-provider quality has separate live evidence.

### S6 — Forget proof and brain-eval release gate

Finish end-to-end dependency purge and per-store proof on top of S1. Publish automated forget tests and a `brain-eval` command with versioned fixtures and machine-readable results. Include adapters/worker/export/import/restore, not just database rows.

Required headline evals: unprompted open loop within 24h; retired-fact withholding; forget proof; contradiction flag; demonstrated injected-pack use. Add adversarial/no-action controls so notification spam and forced guesses cannot improve scores. Use simulated clocks for CI and a separately recorded real-time soak. Report fixture size, false positives/negatives, abstentions, latency, cost, and supported-client coverage. Provider mocks prove orchestration only, not reasoning quality.

Gate: no cross-project or private disclosure; all proof bits supported by evidence; all critical evals pass their documented assertions; limitations visible. Live/native/fresh-install gates cannot be replaced with green mock results.

### S7 — V1 packaging and minimum adapters

Finish folder-drop import and chat-export adapters through one interface: discover/parse/checkpoint/import/permission/revoke/delete-propagation. Treat symlinks, path traversal, size limits, duplicates, attachments, parser failures, and unknown formats explicitly. No Gmail OAuth dependency. Publish vault spec, install/restore instructions, actual screenshots, and capability matrix. Complete human first-use pilot and clean-install verification where available.

Gate: usable local V1 suite with harness S1–S6, folder/chat ingestion, and all supported operations documented. Public licensing and managed-service launch remain explicit owner decisions.

### S8 — High-leverage follow-up

In order: session page claims → outcome-scored rules → paid/hard-call S1 routing. Retain the offline rules/classifier path and deterministic policy vetoes. A Jev-equivalent adapter must define type/conflict/wake-S2/notify outputs, privacy, latency, cost, fallback, and calibration. Verify a real provider's contract before selecting it; the owner's reference is not proof of an available integration.

Gate: expired claims cannot overwrite; unknown outcomes do not punish rules; classifier outages do not lose capture or authorize unsafe writes; routing improves measured outcomes within budget.

### S9 — Differentiators after the core is proven

1. Causal why-walk: typed causes/blocks/supersedes/retired_by links with evidence, uncertainty, direction, and cycle handling. Optional graph, never inferred causation from embedding proximity.
2. Compression: cold pages become stubs pointing to retained raw/claims; age/usage ranking controls pack inclusion, not destruction. Evaluate stale-important-rule recall and allow pinning.
3. V1.5 adapters: calendar plus one mail provider using the existing interface. Voice/card capture later. No external sending by default.

Gate: each addition improves a named workflow/eval; no connector catalog or graph feature delays the harness release.

## Coverage of the owner's 18 requirements

| # | Requirement | Primary delivery |
| --- | --- | --- |
| 1 | Write gate | S2 |
| 2 | Current truth + evidence | S1–S3 |
| 3 | Claim ledger | S2 |
| 4 | Forced binding | S4 |
| 5 | Eight tools | S4 |
| 6 | Dream receipt + revert | S1 foundation, S5 |
| 7 | Forget proof | S1 foundation, S6 |
| 8 | Intent layer | S4–S5 |
| 9 | Outcome-scored dream | S8 |
| 10 | Session claims | S8 |
| 11 | Two-speed S1 | S2 offline, S8 paid routing |
| 12 | Handoff card | S4 |
| 13 | Connector adapters | S7 minimum, S9 expansion |
| 14 | Causal why-walk | S9 |
| 15 | Compression without deletion | S9 |
| 16 | Category eval pack | S6, regressions from S1 onward |
| 17 | Vault specification | S0–S1, published with S7 |
| 18 | Secret scanner | S1, enforced at every publication boundary |

Named inspirations supplied by the owner (GBrain, gstack, open-second-brain, Engram, ai-memory, brAIn, Karpathy, Jev) are design references, not verified implementation or licensing claims. Before reusing code or making comparative claims, inspect the exact repository/version and license. Do not import license restrictions or marketing assertions by analogy.

## Completion discipline

At each milestone update BUILD_STATE and affected contracts/docs with implemented behavior, commands actually run, new regression/eval evidence, screenshots where relevant, and remaining limits. Run tests appropriate to actual changes. Preserve meaningful baseline tests, adding the failure scenarios above rather than assertions that merely mirror code.

Final handoff must say which S-milestones are verified, what remains extractive/mock-only, supported client binding levels, where the vault lives, how to run/rebuild/restore/evaluate, and what the owner can try. Never call a good-looking suite the finished harness until the evidence and agent workflows pass.
