# Connect a native agent to BiBrain

Status: configuration path implemented; native end-to-end certification still
requires an explicitly authorized client run. These steps do not prove that a
named client has recalled or corrected anything.

## Before connecting

1. Start BiBrain with `npm start` and keep it running.
2. In **Connections**, choose **Connect an agent**, select Codex or Claude Code,
   keep the default read-only access unless suggestions are needed, and choose a
   short duration. BiBrain defaults to the current project and one day.
3. Copy the connection key when BiBrain shows it. The key is displayed once.
   Do not put it in Git, a URL, a screenshot, a prompt, or a shared terminal log.
4. Use **Copy setup** for the chosen client and paste it into a new private
   PowerShell window opened in the BiBrain repository. The generated setup asks
   for the key with `Read-Host`; it never includes the key itself. The manual
   equivalent is:

   ```powershell
   $env:BRAIN_AGENT_TOKEN = Read-Host "Paste the BiBrain connection key"
   $env:BRAIN_API_URL = "http://127.0.0.1:4317"
   ```

The local adapter rejects remote plaintext addresses, URL credentials and
redirects. Use an exact trusted HTTPS origin for an independently hosted API.

## Codex

BiBrain includes a token-free project configuration template at
`.codex/config.toml.example`. Copy it to `.codex/config.toml` in this trusted
checkout, then start Codex from the same PowerShell window. The real config is
ignored by Git; it forwards the two named environment variables instead of
storing the connection key in the repository. The guided setup never overwrites
an existing `.codex/config.toml`; compare it with the example if BiBrain is not
already listed.

Alternatively, add it with the Codex CLI. This form stores the supplied value
in the local Codex configuration, so use a short-lived grant and revoke it when
finished:

```powershell
codex mcp add bibrain --env BRAIN_AGENT_TOKEN=$env:BRAIN_AGENT_TOKEN --env BRAIN_API_URL=$env:BRAIN_API_URL -- node node_modules/tsx/dist/cli.mjs apps/mcp/main.ts
```

Confirm discovery with `codex mcp list` or `/mcp`. Codex, the Codex IDE
extension and the ChatGPT desktop app share MCP configuration on the same host.

## Claude Code

From the same PowerShell window, add a project-local server without putting the
key in the command:

```powershell
claude mcp add --scope local bibrain -- node node_modules/tsx/dist/cli.mjs apps/mcp/main.ts
```

Start Claude Code from that same window so the adapter inherits
`BRAIN_AGENT_TOKEN` and `BRAIN_API_URL`. The `local` scope keeps this connection
specific to the current project and out of the shared repository.

## Required native proof

Use synthetic content only. Record the exact client version and prove each item
in a fresh session:

1. The client discovers only the tools allowed by the grant.
2. A public synthetic fact is absent before owner review and available with its
   evidence after approval.
3. A reviewed correction replaces the old current answer without deleting
   history.
4. A private note and another project's source never appear in content, counts,
   snippets, summaries, or errors.
5. After revocation, the next operation is denied, including from an already
   open client session.

Do not label a client supported until all five checks pass. Revoke and remove
the disposable grant after the run.

## Remove the connection

For Codex, run `codex mcp remove bibrain`. For Claude Code, run
`claude mcp remove --scope local bibrain`. Also revoke the grant in BiBrain.
Removing a client entry does not revoke a copied key; revoking in BiBrain does.
