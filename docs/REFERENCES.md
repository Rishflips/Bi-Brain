# Reference register

Prepared 2026-09-27. Product decisions are recommendations. Verify evolving APIs and versions using primary documentation during implementation.

## Product inspirations

- GBrain: https://github.com/garrytan/gbrain — portable memory and maintenance.
- gstack: https://github.com/garrytan/gstack — workflow packaging and verification.
- Karpathy LLM Wiki: https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f — sources and maintained knowledge.
- Supermemory: https://github.com/supermemoryai/supermemory — context interfaces.
- Mem0: https://github.com/mem0ai/mem0 — memory infrastructure.
- TypeSafe: https://docs.typesafe.ai/introduction — typed decision primitives.
- Confidence: https://docs.typesafe.ai/confidence — provider uncertainty semantics.

The user's Grok text informed synthesis but is not authoritative evidence about competitors, prices, latency, licenses, or novelty. Its personal project examples are not copied into this build specification.

## Implementation references

- Codex models: https://learn.chatgpt.com/docs/models
- GPT-6 Sol: https://developers.openai.com/api/docs/models/gpt-6-sol
- Vite: https://vite.dev/guide/
- React: https://react.dev/learn
- Fastify: https://fastify.dev/docs/latest/
- SQLite FTS5: https://www.sqlite.org/fts5.html
- SQLite WAL: https://www.sqlite.org/wal.html
- SQLite backup: https://www.sqlite.org/backup.html
- MCP architecture: https://modelcontextprotocol.io/docs/learn/architecture
- MCP SDKs: https://modelcontextprotocol.io/docs/sdk
- Open Source Definition: https://opensource.org/osd

## Limits

Competitor benchmarks were not reproduced. No quoted competitor subscription price sets a Bi Brain price. No paid runtime calls were made for this pack and no integration is claimed as implemented.

## Additional first-party references reviewed 2026-10-16

The following are reference patterns, not adopted dependencies or production endorsements. Repository README capabilities and vendor benchmarks are self-reports unless separately reproduced. Recheck current per-file licenses before reusing source; open weights, open-source software and a hosted service are different artifacts.

| Area | References | Transferable pattern |
| --- | --- | --- |
| Cross-agent continuity | [Open Second Brain](https://github.com/itechmeat/open-second-brain), [OneBrain](https://github.com/onebrain-ai/onebrain) | Portable knowledge, corrections, client lifecycle integration; do not require an Obsidian vault in the user flow. |
| Governed harness | [SecondBrain-collab](https://github.com/contextosai/SecondBrain-collab), [OpenHuman](https://github.com/tinyhumansai/openhuman) | Bounded execution and inspectable improvement; avoid cloning an entire agent OS. |
| Approachable personal workspace | [Memos](https://github.com/usememos/memos), [Khoj](https://github.com/khoj-ai/khoj), [AnythingLLM](https://github.com/Mintplex-Labs/anything-llm), [AFFiNE](https://github.com/toeverything/AFFiNE), [AppFlowy](https://github.com/AppFlowy-IO/AppFlowy), [Open WebUI](https://github.com/open-webui/open-webui) | Capture first, integrated readable workspace and controlled preparation. Not a recommendation to copy broad feature sets or licensing. |
| Temporal/evidence memory | [Graphiti](https://github.com/getzep/graphiti), [Hindsight](https://github.com/vectorize-io/hindsight) | Fact validity, source provenance, evidence-backed derived pages. External graph/Postgres stacks are not automatically justified here. |
| Memory interfaces | [Mem0](https://github.com/mem0ai/mem0), [Supermemory](https://github.com/supermemoryai/supermemory), [LangMem](https://github.com/langchain-ai/langmem), [Acontext](https://github.com/memodb-io/Acontext), [MemOS](https://github.com/MemTensor/MemOS), [MemMachine](https://github.com/MemMachine/MemMachine), [Cognee](https://github.com/topoteretes/cognee), [Letta](https://github.com/letta-ai/letta) / [Letta Code](https://github.com/letta-ai/letta-code) | Scoped memory types, hot-path versus background learning, inspectability and provider boundaries. |
| Capture | [Karakeep](https://github.com/karakeep-app/karakeep), [Paperless-ngx](https://github.com/paperless-ngx/paperless-ngx), [Screenpipe](https://github.com/mediar-ai/screenpipe) | Archive before enrichment and visible freshness. Ambient screen/audio capture is not a default BiBrain capability. |
| Durable work | [Trigger.dev](https://github.com/triggerdotdev/trigger.dev), [LangGraph](https://github.com/langchain-ai/langgraph) | Recovery, checkpoints, idempotency and explicit human interruption. |
| Evaluation | [LongMemEval](https://github.com/xiaowu0162/LongMemEval), [LongMemEval-V2](https://github.com/xiaowu0162/LongMemEval-V2), [LoCoMo](https://github.com/snap-research/locomo), [ConvoMem](https://github.com/SalesforceAIResearch/ConvoMem), [MemEval](https://github.com/ProsusAI/MemEval), [AgentDojo](https://github.com/ethz-spylab/agentdojo) | Compare updates/time/abstention/cost and injection resistance; never substitute a vendor leaderboard for BiBrain's own release evidence. |

System One implementation references: [TypeSafe HTTP contract](https://docs.typesafe.ai/api.md), [Cloudflare Clef-flash runtime documentation](https://developers.cloudflare.com/workers-ai/models/clef-flash/). Provider runtime limits can differ from launch posts or weight model cards; use conservative explicit application limits and verify the actual endpoint.

Managed identity reference: [openid-client maintained API documentation](https://github.com/panva/openid-client/tree/main/docs). Use library validation with issuer/subject identity, PKCE, state, nonce, signature checks and server-side expiring single-use correlation; not browser identity headers or hand-built password recovery.
