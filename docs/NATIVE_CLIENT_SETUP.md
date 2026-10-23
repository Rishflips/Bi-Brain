# Connect a native agent to BiBrain

## One step (recommended)

This works in the local app on your own computer. The hosted edition uses
[Set up by hand](#set-up-by-hand) below.

1. Run `npx bibrain` in the BiBrain folder. BiBrain opens in your browser already
   signed in. This runs the copy in your BiBrain folder; nothing is downloaded
   from npm.
2. Open **Connections** and choose **Add to Codex** (or **Add to Claude Code**
   or **Add to Cursor**).
3. Pick the project and the project folder where you open the agent.
4. Open **See the file BiBrain will add** and check it. BiBrain writes only that
   one file in the folder. If the file already exists, BiBrain changes nothing and
   shows the exact lines to add yourself.
5. Open the agent in that folder and approve BiBrain once.
6. The tile says **Waiting for its first call** until the agent really uses
   BiBrain, then **Connected**.
7. **Revoke** ends access at once, including in an agent that is already open.

The access key is created by BiBrain and rests in BiBrain's data folder
(`data/agent-keys`), never in the project file and never in the browser. The
project file holds only the paths needed to start BiBrain's connector and the
connection id. Revoking deletes the key file. One-step connections can read and
suggest (the recommended choice) or read only, and last 90 days unless you revoke
them sooner. Suggestions from agents wait for your review on Today.

Status, 2026-10-21: the bounded read-only workflow below passed in actual fresh
Codex CLI 0.156.1 and Claude Code 2.1.283 sessions. This does not certify arbitrary
native write/propose/forget workflows or every future client version.

## Recorded native acceptance

Both clients used their existing subscription sign-in, synthetic disposable SQLite
storage and an expiring read-only grant. No owner data, global client configuration,
paid API key, or BiBrain provider activation was used. Subscription quota was used.

| Observation                                               | Codex                | Claude Code          |
| --------------------------------------------------------- | -------------------- | -------------------- |
| Read-only tool discovery; no propose tool                 | Pass                 | Pass                 |
| Pending fact absent from current answer                   | Pass                 | Pass                 |
| Owner-reviewed fact returned with exact source citation   | Pass                 | Pass                 |
| Owner-reviewed correction replaces earlier current answer | Pass                 | Pass                 |
| Private and other-project original reads                  | 404 / 404            | 404 / 404            |
| Revocation during the open native session                 | Next verify/read 401 | Next verify/read 401 |

The native sessions called the real stdio adapter and loopback HTTP services.
An operator fixture accepted the two predefined synthetic review gates between
calls; the native model did not approve knowledge or change permissions. The
proof script checks observed backend responses rather than trusting a model's
completion claim. Original versions remain in the disposable store until cleanup.

The initial Codex attempt discovered tools but correctly refused invocation under
its approval policy: the server lacked read-only MCP annotations. Truthful
read-only/idempotent/destructive hints were added and the documented project
`default_tools_approval_mode="writes"` setting was applied. The fresh retest
passed without granting write access or bypassing approval. Claude's fresh run
used restricted mode, no built-in tools and only the supplied MCP configuration.

This recorded run used the manual setup below. `scripts/native-client-proof.ts`
now creates its connection through the one-step path (BiBrain writes the client's
project file in a disposable folder), so a fresh run exercises that path. That
updated script has not yet been run against native Codex or Claude Code; only
the owner runs it, because it consumes subscription quota.

Reproduce explicitly (consumes native subscription quota):

```powershell
$env:BRAIN_NATIVE_PROOF = '1'
node --import tsx scripts/native-client-proof.ts codex
node --import tsx scripts/native-client-proof.ts claude
```

Each client process has a 120-second timeout; generated grants are revoked and
disposable storage is removed. Reports remain under ignored `data/native-*-proof.json`;
they contain synthetic results and never the grant key. The script uses the
observed Windows npm installation paths by default; other installations can
set `BRAIN_NATIVE_CODEX_ENTRY` or `BRAIN_NATIVE_CLAUDE_BINARY` to explicit paths.
Codex uses GPT-6 Sol for this proof. The observed Claude subscription selected
`claude-opus-5-5`. These are compatibility observations, not recommendations or
BiBrain live reasoning quality/cost evidence.

## Set up by hand

Use this when the one-step Add is not available (the hosted edition, or a client
BiBrain does not list), or when you prefer to control each step.

### Before connecting

1. Start BiBrain with `npm start` and keep it running.
2. In **Connections**, open **Any other agent** and choose **Set up by hand**,
   which opens the Connect an agent dialog. Select Codex or Claude Code,
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

### Codex

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

### Claude Code

From the same PowerShell window, add a project-local server without putting the
key in the command:

```powershell
claude mcp add --scope local bibrain -- node node_modules/tsx/dist/cli.mjs apps/mcp/main.ts
```

Start Claude Code from that same window so the adapter inherits
`BRAIN_AGENT_TOKEN` and `BRAIN_API_URL`. The `local` scope keeps this connection
specific to the current project and out of the shared repository.

### Required native proof

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

### Remove the connection

For Codex, run `codex mcp remove bibrain`. For Claude Code, run
`claude mcp remove --scope local bibrain`. Also revoke the grant in BiBrain.
Removing a client entry does not revoke a copied key; revoking in BiBrain does.
