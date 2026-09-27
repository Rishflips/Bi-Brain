# Agent integration

## Promise levels

1. Portable brief: works through reviewed copy/download without native integration.
2. Scoped knowledge access: supported agents retrieve and propose memories through MCP.
3. Automatic capture: requires host-specific hooks and separate opt-in.
4. Starting work in another agent: future capability, not implied by MCP connection.

Do not market levels 3 or 4 merely because level 2 works.

## Initial transport

Implement a stdio MCP adapter using the official SDK. The adapter forwards requests to the local API with a scoped token. Keep business logic and policy in the server. Stdout is reserved for protocol messages; logs go to stderr with sensitive values redacted.

Remote HTTP/OAuth is a later integration milestone. Verify current protocol and client support against official documentation at implementation time.

## Minimal tool surface

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
| Codex | stdio, version to record | Unverified | Unverified | Unverified | Unverified | Not implemented |
| Claude Code | stdio, version to record | Unverified | Unverified | Unverified | Unverified | Not implemented |
| Generic MCP inspector | stdio | Unverified | Unverified | N/A | Unverified | Not implemented |

Two-client end-to-end verification is a local V1 release gate. If a client is unavailable, finish the adapter and inspector tests, then report that native-client gate as unverified.

## Verification script

Create a synthetic project, grant access, remember a unique phrase, retrieve it in a fresh session, correct the source in the owner UI, verify updated context, revoke access, and verify denial including cached paths.

Also try a private note and another project's source ID. Neither may appear in results, error text, counts, snippets, or generated summaries.

## Plugin boundary

Do not execute third-party plugin code in V1. First-party workflow definitions declare triggers, allowed operations, input/output schemas, timeout, and spending ceiling. Imported descriptions never grant permissions. A marketplace requires a separate isolation and review design.
