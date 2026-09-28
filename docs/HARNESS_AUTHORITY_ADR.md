# Harness authority and migration — S0

The owner's SOL6_HARNESS_AND_SUITE_BUILD brief supersedes the earlier SQLite-only canonical-state section. Portable schema-v1 records are the committed knowledge authority. SQLite is the operational state and query projection. Sources retain stable IDs and immutable versions; no model or external file edit can update authority directly.

A local write journal bridges SQLite, files and Git: capture original bytes before classification; stage a complete validated generation; commit the operational transaction; atomically replace the manifest; make a local vault commit; acknowledge only after publication. A crash after SQLite commit is recovered from the pending journal before serving reads. Git failure is visible and retried, never reported as a completed vault commit. Process writers serialize through a vault file lock and SQLite's write lock. External readers use manifest-listed generations; app services read a SQLite projection reconciled from the manifest at startup. External edits fail hash validation. A reviewed external-edit reconciliation importer is still pending.

The runtime vault has its own Git repository. No remote is configured or pushed. Quarantine, credentials, journals and backups are siblings outside that repository. Detected secret bytes never enter shareable generations, provider requests, query projection, or previews. The scanner is bounded, not a guarantee of detecting arbitrary secrets. Private content remains private even if stored in portable files.

Migration requires a consistent backup, dry-run counts, stable-ID reconciliation and tested rollback before changing a real installation. Deletion tombstones override old imports/restores/reverts. Permanent forgetting may sanitize managed Git history and lose historical reversibility. Unmanaged backups and already transmitted copies cannot be recalled and are explicitly reported.

## Dependency map

S0 baseline/contracts → S1 raw/quarantine/journal/migration → S2 claims/gate/current pages → S3 suite workspaces → S4 scoped eight tools/binding/handoff → S5 intent dream/revert → S6 proof/evals → S7 ingestion/packaging. S8 leases/outcomes/routing and S9 causal/compression/connector extensions follow the verified core.

## Eight-tool authority

Read grants discover search/get/ask/diff only. Propose/link/intent require separately authorized mutations; forget requires its own scope and owner approval unless explicitly preauthorized. Shared services repeat authorization even for direct HTTP calls. Legacy remember must transition through propose and never bypass review. Native integration support is manual/cooperative/enforced per adapter, never inferred from MCP availability. Delivery and demonstrated use are separate evidence.

## Baseline inventory

Verified existing: source capture/revisions, extractive briefs, goals, reviewed plans, durable queue/budgets, scoped five-tool SDK transport, backups and cross-project purge. Missing at S0: portable authority, scanner, typed ledger/current truth, eight tools, client hooks, identity disclosure, dream reasoning/revert, comprehensive forget proof, eval runner, folder/chat interface, and suite subworkspaces. Existing generated briefs are previews, not accepted ledger facts.

Baseline `npm test` on 2026-09-28: 29 tests in five files passed. External live/native/human gates remain unverified. Later milestone records must state actual implementation, not inherit this design as delivered.
