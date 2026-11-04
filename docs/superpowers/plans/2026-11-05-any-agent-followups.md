# Plan 9 (any agent): rulings and follow-ups

Recorded while executing `docs/superpowers/plans/2026-11-05-any-agent.md`.

- Ruling: accept R4 (stateless, bearer-only, JSON POST-only Streamable HTTP MCP routed through app.inject), R5 (post_llm_call for notes), R7 (Hermes under Set up by hand).
- Ruling: R9 is tightened — the Python plugin tests may skip locally when Python 3.10+ is absent, but must FAIL rather than skip when CI=true — so a broken plugin can never pass silently in CI.
- Ruling: B1 — the Hermes harness runs async (spawn, not spawnSync) so the in-process fake server can answer — none.
- Ruling: B2/B3 — type the inject payload and route correctly; Task 3's test reaches "Connected" through the real path (verify or a recall push), not tools/list alone — none.
- Ruling: I1 — the plugin enforces a wall-clock deadline that covers DNS (e.g. a worker thread joined with a timeout) and caps response reads (64 KiB) — a slow server can never hold a Hermes turn.
- Ruling: I2 — inner app.inject calls carry the outer caller's IP (remoteAddress), so rate buckets stay per caller — if wrong, callers share a bucket.
- Ruling: I3 — JSON-RPC batches are refused (one message per request) — no bypass of the per-minute bound.
- Ruling: I4 — the route limit is enforced in addition to the global limit (the stricter wins), with a 429 test — none.
- Ruling: I5 — use the documented Hermes manifest keys (`secret: true`; no undocumented `label`) — none.
- Ruling: I6 — implement R9 as tightened (fail when CI=true and Python is missing) and make the plaintext/credentialed-URL test non-vacuous (mutation-proof) — none.
- Ruling: the Minors are applied where they are a few lines.
- Ruling: parked for the final review — the logged client and any label derived from the request body are self-declared by the agent (pre-existing); check whether the owner-facing "From <agent>" label uses the grant's client or the body — if the body, an agent could mislabel its own notes.
- Ruling: parked — a trickling server leaves a daemon thread alive past the deadline (the turn is unaffected; the thread ends with the socket); _settings() is called twice; rare regex edge differences between Python and JS — Minor.
- Ruling: parked — M2 (log rows record the body client); changing it touches recall_log rows that the dense-off snapshot pins — content-free internal log — low.

## Owner-run checks still owed

- Run the Hermes plugin in a real Hermes session, next to a self-hosted BiBrain.
- Connect a real remote MCP client to `POST /api/v1/agent/mcp`.
- Run the end-of-turn Stop hook in real Claude Code and Codex sessions (owed since plan 8).
