# Connect a native agent to BiBrain

## One step (recommended)

This works in the local app on your own computer. The hosted edition uses
[Set up by hand](#set-up-by-hand) below.

1. In the BiBrain folder, run `npx --no-install bibrain`. BiBrain opens in your
   browser already signed in. This runs the copy in your BiBrain folder;
   `--no-install` makes npx refuse to download anything, so running it from
   another folder fails instead of fetching a package from npm.
2. Open **Connections** and choose **Add to Codex** (or **Add to Claude Code**
   or **Add to Cursor**).
3. Pick the project and the project folder where you open the agent.
4. Open **See the file BiBrain will add** and check both files: the server entry
   and, for Claude Code and Codex, a prompt hook (`.claude/settings.local.json`
   or `.codex/hooks.json`) that runs BiBrain's recall on every prompt. Claude
   Code's file pre-approves only the two read-only tools (`brain_recall`,
   `brain_open`). Cursor gets `.cursor/rules/bibrain.mdc` instead. BiBrain writes
   only new files. If a file already exists, BiBrain changes nothing and the tile
   shows "Recall on every prompt: add it yourself" with a **Copy** button; paste
   the lines into the file or, in Claude Code, run `/hooks`. The files point at
   BiBrain on this computer, so keep them out of shared version control.
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

## Hooks

The prompt hook is a small command, `bibrain hook <agent>`, that the agent runs
before it handles each prompt.

- It sends the first 500 characters of the prompt and a hash of the session id to
  BiBrain on this computer, never anywhere else (it refuses any address that is
  not loopback). It skips very short prompts, slash or bang commands, and
  anything that looks like a secret.
- It writes `data/hook-state/<connection>.json`: hashes of the ids already shown
  in each of the 20 most recent sessions, so a repeated prompt adds nothing new.
  Never a prompt, a passage or the access key.
- Its total budget is 1,500 ms, including starting Node. It never blocks a prompt:
  on any problem it prints nothing and exits successfully.
- What comes back is a short factual note (or nothing) that the agent receives
  with the prompt. Ordinary prompts, such as coding questions, get nothing.

Codex: BiBrain writes `.codex/hooks.json` because the format is confirmed in the
official Codex documentation (`CODEX_HOOKS_CONFIRMED` in
`packages/domain/agents.ts`). Codex loads a project hook only after you trust
the folder's `.codex/` layer and the hook itself in `/hooks`, so the tile says
"Recall on every prompt: on after Codex trusts the hook" until BiBrain has
recorded a push. Until you trust it, Codex relies on the server instructions and
tool descriptions.

Windows: the hook command is written with forward slashes and double quotes
(`"C:/Program Files/nodejs/node.exe" "C:/.../bibrain.mjs" hook ...`) so that Git
Bash, PowerShell and `cmd.exe` parse it the same way. It has not yet been observed
running in any shell, including Claude Code's own, and tests only assert the
string. How `cmd.exe /c` treats a line that both starts and ends with a quote is
likewise untested. The owner-run recall proof below decides.

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

That run was made on 2026-10-21, before the agent tools were renamed to
`brain_recall`, `brain_open`, `brain_note`, `brain_propose`, `brain_intent`,
`brain_link` and `brain_forget`; the earlier dotted names are gone. The read
rows above describe the earlier surface and have not been re-observed with
`brain_recall` and `brain_open`. `scripts/native-client-proof.ts` now uses the new
names and is owner-run.

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

## Recall proof (owner-run)

`scripts/recall-agent-proof.ts` measures whether a real agent uses BiBrain. It
connects through the real one-step path in a disposable folder (so the hook is
written too), seeds six reviewed facts and three originals plus a private note
and another project's note as canaries, then runs ten prompts (six that need the
brain, four that do not) three times each (`BRAIN_PROOF_REPEATS`, 1 to 5). It
counts what the loopback server saw, not what the model says about itself. It
spends subscription quota, so only the owner runs it, and it refuses to start
without `BRAIN_RECALL_PROOF=1`.

```powershell
$env:BRAIN_RECALL_PROOF = '1'
node --import tsx scripts/recall-agent-proof.ts claude
$env:BRAIN_PROOF_NO_HOOK = '1'; node --import tsx scripts/recall-agent-proof.ts claude; Remove-Item Env:BRAIN_PROOF_NO_HOOK
node --import tsx scripts/recall-agent-proof.ts codex
Remove-Item Env:BRAIN_RECALL_PROOF
```

`BRAIN_PROOF_NO_HOOK=1` removes the `hooks` key from the written file before the
run, so only the tool surface is measured; compare the tool-call rates between
the two runs. `npm run proof:recall` runs the same script. For Codex, the
headless run only loads the project hook if Codex has been told to trust it, so
the bar below also requires that the hook fired at least once when it is on.

Pass bar, per client: at least 5 of the 6 should-retrieve prompts answered
correctly with a cited id in at least one run; no `full` push and at most one
`pointer` push across the four should-not prompts; and neither canary appears
anywhere. With the hook on, at least one push must have reached BiBrain
(`hook_fired`); otherwise the two should-not checks would pass without measuring
anything and the run fails. The report also records pass-all-runs counts, the tool-call rate and the
median hook latency. Reports land in `data/recall-<client>-<hook|nohook>-proof.json`
(file mode 0600, ignored by Git, never containing the key). The script prints one
JSON line and exits 1 when the bar is not met.

Status: not yet run against native Codex or Claude Code. CI and agents only
exercise the refusal path.

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
