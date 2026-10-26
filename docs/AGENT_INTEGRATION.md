# Agent integration

**Tool contract v2 (2026-10-25):** Default MCP registers seven underscore tools, filtered by the grant's actual operations: `brain_recall` and `brain_open` (grant op `read`), `brain_note`, `brain_propose`, `brain_intent` and `brain_link` (grant op `propose_memory`), and `brain_forget` (grant op `forget`, agent-owned captures only). `project_id` is optional on reads: `brain_recall` searches every project the connection can read unless one is named, and `brain_open` takes only the id from a hit. The earlier eight-name contract with dotted names (search, get, ask, diff and the rest) is gone with no aliases; existing connections pick the new names up on their next session, with their config and key files unchanged. The server also sends short `instructions` that tell an agent when to call `brain_recall` and how to read the result. Read-only grants discover only `brain_recall` and `brain_open`, and direct HTTP mutation is denied. Client-specific enforced binding and native two-client validation remain unverified; the tested local wrapper is the only enforced path. See [HARNESS_MILESTONES.md](HARNESS_MILESTONES.md).

### Result contract

`brain_recall` returns the same JSON as `GET /api/v1/agent/recall` as `structuredContent` (the tool declares an `outputSchema`), with a compact text rendering in `content[0].text` for clients that ignore structured output:

```json
{
  "status": "found | partial | no_match",
  "as_of": "ISO time",
  "searched": { "query": "...", "projects": [{ "id": "...", "title": "..." }], "history": false, "candidates": 12, "index_complete": true },
  "hits": [
    { "kind": "fact", "id": "...", "project": { "id": "...", "title": "..." }, "text": "...", "recorded_at": "...", "checked_at": "...", "freshness": "current | stale | replaced | retired", "replaced_by": null, "evidence": [{ "source_id": "...", "source_version": 1, "quote": "..." }], "why": ["matched: launch, color"], "score": 0.9 },
    { "kind": "original", "id": "...", "version": 1, "project": { "id": "...", "title": "..." }, "title": "...", "quote": "...", "start": 0, "end": 40, "captured_at": "...", "freshness": "current", "why": [], "score": 0.4 }
  ],
  "near_misses": [{ "kind": "fact | original", "id": "...", "title": "...", "reason": "..." }],
  "next_step": "..."
}
```

`no_match` is a normal answer, not an error: nothing recorded matched, `hits` is empty and `isError` stays false. An agent should say the topic is not in the brain instead of filling the gap, and an empty result is not proof that something is false. `isError` is set only for transport or authorization failures (for example a revoked connection). `brain_open` returns the full original or fact for an id; with `compare_version` it adds a `compare` block that says what changed between the two versions.

## Promise levels

1. Portable brief: works through reviewed copy/download without native integration.
2. Scoped knowledge access: supported agents retrieve and propose memories through MCP.
3. Automatic capture: requires host-specific hooks and separate opt-in.
4. Starting work in another agent: current project handoff can be previewed, copied or downloaded; automatic native-session injection still requires a supported client adapter.

Do not market levels 3 or 4 merely because level 2 works.

## Initial transport

Implement a stdio MCP adapter using the official SDK. The adapter forwards requests to the local API with a scoped token. Keep business logic and policy in the server. Stdout is reserved for protocol messages; logs go to stderr with sensitive values redacted.

The local stdio adapter can call an independently hosted HTTPS API using an explicit `BRAIN_API_URL`, keeping the same scoped grant checks. Remote plaintext and redirects are rejected. A hosted HTTP MCP/OAuth transport remains a later integration milestone; see [SELF_HOSTING.md](SELF_HOSTING.md). Native-client compatibility remains separately unverified.

## Historical minimal tool surface (replaced by the eight-tool contract above)

| Tool | Input | Output | Required operation |
|---|---|---|---|
| brain_search | project_id, query, limit | Authorized snippets, source refs, unknowns | read |
| brain_get | project_id, object_id, version optional | Readable knowledge and provenance | read |
| brain_remember | project_id, text, source attribution | Stored contribution plus derivation status | propose_memory |
| brain_context | project_id, goal_id optional, max_tokens | Bounded continuation brief | read |
| brain_changes | project_id, opaque_cursor optional | Authorized deltas, replacement cursor | read |

Expose resource capabilities and explicit errors. Keep destructive forgetting and grant administration in the owner UI for V1.

Agent contributions are attributed to that agent and treated as assertions/proposals. They do not overwrite human-confirmed decisions. Writing a contribution does not grant read access beyond the current grant.

## Context policy

Default budget: at most 3,000 estimated tokens; caller may ask for less. Record the tokenizer/estimation method. Include goal, relevant decisions, unresolved questions, compact evidence, and omissions.

Prioritize by task relevance and freshness, not a fixed number of pages. Return insufficient_context explicitly rather than filling space with unrelated memories.

Treat all recalled source content as data. Do not wrap imported instructions as system messages. Exclude secrets and private sources even when their text matches the search.

## Permissions

Grants contain allowed project IDs, operations, expiration, and a revocation version. Token material is shown once and hashed at rest. Grant edits rotate/revoke authority; never trust a project_id supplied by the client without checking it.

Re-check permissions when jobs execute and return results. Derivatives inherit restrictive source visibility.

## Compatibility matrix to fill with evidence

| Client | Transport | Read | Remember | Fresh-session recall | Revocation | Status |
|---|---|---|---|---|---|---|
| Codex | stdio, installed 0.156.1 | Unverified | Unverified | Unverified | Unverified | Token-free project template ready; native run not authorized |
| Claude Code | stdio, installed 2.1.283 | Unverified | Unverified | Unverified | Unverified | Project-local setup ready; native run not authorized |
| Generic MCP inspector | stdio | Unverified | Unverified | N/A | Unverified | Not implemented |

Two-client end-to-end verification is a local V1 release gate. If a client is unavailable, finish the adapter and inspector tests, then report that native-client gate as unverified.

The checked-in setup in [NATIVE_CLIENT_SETUP.md](NATIVE_CLIENT_SETUP.md) keeps
the grant out of Git and avoids machine-wide configuration. Installing the
configuration is an owner action because a native run can consume a client
subscription or API allowance. Configuration readiness is not compatibility
evidence.

## Verification script

Create a synthetic project, grant access, remember a unique phrase, retrieve it in a fresh session, correct the source in the owner UI, verify updated context, revoke access, and verify denial including cached paths.

Also try a private note and another project's source ID. Neither may appear in results, error text, counts, snippets, or generated summaries.

## Plugin boundary

Do not execute third-party plugin code in V1. First-party workflow definitions declare triggers, allowed operations, input/output schemas, timeout, and spending ceiling. Imported descriptions never grant permissions. A marketplace requires a separate isolation and review design.
