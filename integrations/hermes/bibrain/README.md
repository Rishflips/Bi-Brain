# BiBrain plugin for Hermes Agent

Recall from your BiBrain in front of every turn and leave a session note after it. Hermes usually runs on a server next to a self-hosted BiBrain, so the address is your BiBrain's HTTPS domain.

1. Copy this folder to `~/.hermes/plugins/bibrain/` on the Hermes machine.
2. In BiBrain, open Connections → Any other agent → Set up by hand → Hermes, and copy the one-time key.
3. Put two lines in `~/.hermes/.env`: `BRAIN_AGENT_TOKEN=<the key>` and `BRAIN_API_URL=https://your-bibrain-domain.example`.
4. Run `hermes plugins enable bibrain`.
5. For the tools (`brain_recall` and the rest), add the `mcp_servers` entry BiBrain shows in the same dialog to `~/.hermes/config.yaml`.

What leaves Hermes: the first 500 characters of your turn and a hash of the session id; after a reply, only its `Decided:`, `Open question:` and `Next step:` lines. Nothing is logged but a level and a count. If BiBrain is unreachable the turn goes on without it; the plugin never blocks or fails a turn.

Tested against the documented hook contract with a fake Hermes (`tests/integration/hermes-plugin.test.ts`); not yet run in a real Hermes session. The contract is in `docs/CONNECT_ANY_AGENT.md`.
