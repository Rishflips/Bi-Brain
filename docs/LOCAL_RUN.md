# Run Bi Brain locally

**Current supported local path:** See [BUILD_STATE.md](../BUILD_STATE.md) and
[bi-brain-vault.md](bi-brain-vault.md) before upgrading existing data. The portable
vault is supported by the tested local workflow, but production-host migration,
recovery, and deletion gates remain separate. Vault CLI commands are
`npm run vault:dry-run`, `npm run vault:migrate`, `npm run vault:rebuild`, and
`npm run vault:rollback`. Independent HTTPS deployment is documented in
[SELF_HOSTING.md](SELF_HOSTING.md).

The implemented delivery is a single-owner local application. It does not publish a site, sell plans, or connect accounts. Official source repository: https://github.com/Rishflips/Bi-Brain.

## Requirements and installation

Implementation environment: Windows, Node **24.19.0**, npm **11.17.0**. Supported runtime: Node 24.19 or later in the 24 LTS line; npm 11 or later. SQLite is provided by Node's built-in `node:sqlite`; no native SQLite package or database server is needed. Dependencies are exact versions in package.json and package-lock.json. The lockfile resolves React 19.3.0, Vite 8.3.1, Fastify 5.12.5, Zod 4.6.5 and the official MCP SDK 1.32.1. The maintained v1 SDK line was chosen for familiar stdio client support; this does not claim verification of Codex or Claude Code.

From the repository root:

```powershell
npm ci
npm run db:migrate
npm run build
npm start
```

Open http://127.0.0.1:4317. The supervisor starts API and worker and stops both if either exits. Ctrl+C stops the supervisor. Restart with `npm start`; captured data survives. For development, `npm run dev` also starts Vite at http://127.0.0.1:5173. The API always runs on 4317.

The installation pairing code is generated in **data/owner-secret**. Read it locally and paste it into the first-use screen. It is never logged or exported. The resulting browser session is HttpOnly, SameSite Strict, expires after seven days, and requires a CSRF header for changes. Keep the file and data folder private to your OS account. Windows inherits folder ACLs; the Unix 0600 creation mode is not a promise of Windows encryption or additional ACL isolation.

SQLite storage is **data/brain.sqlite** plus WAL/SHM files. `BRAIN_DB` can select a different database for an isolated installation. Storage is unencrypted. No external telemetry or remote URL fetching is implemented.

## Available workflow

Save arbitrary text or `.txt`/`.md` files into Inbox or a project. Originals persist before preparation. Without a provider, the separate worker produces a labeled **Extractive preview** from exact retained passages. Inspect evidence, edit understanding as your own assertion, copy or download a Markdown brief. Correcting a source creates an immutable new version; old context becomes stale and is rebuilt. Private sources remain owner-only.

Create a goal, enable preparation for that goal, and optionally enable background help. “Prepare now” requests a manual bounded check. Extractive preparation offers a **hypothesis / review prompt**, using lexical relevance and at least two passages, never a claimed inference of contradiction. Today supports editing, acceptance, compensating undo, dismissal, and a real snooze time. Later user plan edits open a comparison instead of letting undo overwrite the current plan. Repeated unchanged evidence stays quiet. Quiet hours and daily checks use the configured IANA time zone, and a waking worker does one bounded catch-up.

Search checks full retained text before producing bounded snippets; the UI pages through results. Search excludes inactive/deleted material. Permanent deletion purges original versions, staged imports, affected briefs/proposals/receipts, and accepted plan text plus goal history that depended on the deleted evidence. Withdrawal keeps originals but immediately excludes them from active context. Portable JSON export contains source versions, current knowledge and goal plans, without credentials. Import preview displays source excerpts and historical plans, detects conflicting originals/knowledge, preserves source and knowledge IDs, keeps reviewed corrections, disables imported goal preparation, invalidates pending proposals, and rebuilds understanding. Imported historical receipts cannot undo local work. Export/import is conservative recovery, not a merge engine for divergent accepted histories; operational backup preserves the full database. JSON imports have a 4 MiB decoded request limit. The portable envelope is versioned separately from the build-pack example schema.

## Optional paid provider

Paid processing is off by default. No key was supplied or live call performed during implementation. Configure backend environment variables only:

```text
OPENAI_API_KEY
BRAIN_MODEL
BRAIN_INPUT_MICRO_USD_PER_MILLION
BRAIN_OUTPUT_MICRO_USD_PER_MILLION
BRAIN_PRICE_VERSION
```

Prices are integer **micro-USD per million tokens**, not dollars. Verify a concrete model identifier and its current prices with the provider; unknown prices prevent dispatch, and an unexpected returned model leaves an unresolved charge rather than guessing alias prices. npm runtime commands load `.env` if present; `.env.example` lists the consumed backend variables. Settings requires explicit permission to send selected shareable sources to OpenAI and nonzero daily/per-job spending caps. Private originals are never sent. The complete serialized request is capped at 1 MiB; output defaults to 2,000 tokens (`BRAIN_MAX_OUTPUT_TOKENS`, integer 1–8,000). These adapter bounds need live-provider verification. No automatic provider fallback occurs. Source text is untrusted data. Output must pass schema, current-version, project, and exact-quote validation before publication. Known usage settles even when output is rejected or the job is cancelled; unknown charges remain held and the same dispatch cannot be resent automatically or by retry. Spending status includes new dispatches and legacy reservations across unresolved days. A durable spending block cannot be cleared through ordinary preferences; labeled extractive work remains available. There is no automated reconciliation of ambiguous provider charges yet.

## Native agent configuration

In Connections, create a project-scoped expiring grant. The token is displayed once and stored as SHA-256. Private material is always excluded. Grant operations are read and optionally propose_memory. A configured token remains “Not connected” until a successful API round trip. This badge proves a scoped round trip, not compatibility certification of a named native client.

Configure your client's stdio MCP server with this command, using absolute paths and the repository root as its working directory:

```text
command: node
args: ["C:/path/to/Bi Brain/node_modules/tsx/dist/cli.mjs", "C:/path/to/Bi Brain/apps/mcp/main.ts"]
env: { "BRAIN_AGENT_TOKEN": "<token from Connections>", "BRAIN_API_URL": "http://127.0.0.1:4317" }
```

Do not commit the client configuration containing the token. API and worker must be running. The eight tools are `brain.search`, `brain.get`, `brain.propose`, `brain.forget`, `brain.link`, `brain.ask`, `brain.intent`, and `brain.diff`, filtered by the grant's actual operations. Read-only grants discover search/get/ask/diff. Typed proposals return commit or queue; agent intentions require owner review before changing goals. Returned source content is data, never agent instructions. Context is bounded at 3,000 estimated tokens with explicit omissions. Revocation is immediate on every operation; there is no cache bypass. For an independently hosted server, set `BRAIN_API_URL` to its exact trusted HTTPS origin. The adapter rejects remote plaintext, URL credentials/paths, and redirects; it remains a local stdio process, not a hosted HTTP MCP endpoint.

The official SDK test client verifies fresh-session recall, correction, private and cross-project denial, and revocation. Codex and Claude Code native clients still require separate verification; no client configuration or global Codex settings were changed.

## Backup and restore

```powershell
npm run backup
npm run restore -- <backup-name.sqlite>
```

Backup uses SQLite's supported online backup API, including WAL state. Backups go only inside data/backups, never overwrite existing files, and are sensitive. Restore validates integrity and foreign keys, then writes a new `data/restored-<timestamp>/brain.sqlite`. It reapplies deleted/withdrawn source IDs from the currently available `BRAIN_DB`, purges dependent restored text, and revokes all restored browser sessions and agent grants. A new pairing code is generated beside the restored database on first startup. Stop all processes before switching `BRAIN_DB` to the restored path. Review later deletions from other inaccessible copies before retrieval; such copies cannot be retroactively purged. Backup retention is manual; remove obsolete backup files intentionally.

Restore disables paid processing behind a durable reconciliation block before tombstone replay; even a later replay failure leaves that block in the restored artifact. A stale backup with an empty ledger is not evidence of unused allowance. Verified migration-rollback copies and a new operational database reconstructed from an existing vault receive the same block. Normal fresh first use and rebuild of an existing operational database retain their behavior/accounting. Capture and labeled extractive preparation remain available; ordinary settings cannot resume paid processing. Operator reconciliation is still a separate gate, with no unsafe automatic resume control.

## Verification

```powershell
npm run typecheck
npm run lint
npm test
npm run build
npm run db:migrate
npx playwright install chromium
npm run test:e2e
```

Tests use temporary databases, deterministic clocks and clearly synthetic material. Browser tests use a separate ignored data/e2e database and start the real API plus worker. Live provider quality, native client verification, clean-machine setup, Docker operation, and a five-person usability pilot have independent gates. See BUILD_STATE.md for actual results rather than treating a successful build as completion.

## Container and release boundaries

Dockerfile and compose.yaml provide a pinned Node image, Git, and supervised API/worker with a persistent named volume. Run `docker compose up --build`, then retrieve the owner pairing file from the mounted volume without publishing it. This root compose file maps the host port to loopback only. The container bind is explicit via BRAIN_CONTAINER; default native execution binds loopback. For independent HTTPS hosting use `deploy/compose.yaml` and [SELF_HOSTING.md](SELF_HOSTING.md), which configure one exact public origin, Secure cookies and a persistent TLS proxy. Check BUILD_STATE for actual container and hosted evidence; a supplied compose file is not runtime proof.

The local application does not create a public hosted release. License and
commercial distribution remain unresolved. A default-off Paddle boundary exists,
but real Sandbox acceptance and activation remain external gates. Managed OAuth
connectors, notifications outside Today, and automatic external actions are not
part of the current release.

# Harness commands added in the SOL6 build

With Node 24.19+ and npm 11+, run `npm ci`, then `npm start`. The local vault for the default database is `data/brain.vault/`, with quarantined originals and the migration backup in `data/brain.vault-protected/`. Stop API and worker processes before using `npm run vault:dry-run`, `npm run vault:migrate`, `npm run vault:rebuild`, or `npm run vault:rollback`. Rollback creates a separate database copy; inspect it before switching paths. `npm run brain-eval` writes a synthetic offline JSON report to `data/brain-eval-results.json`; it is not a live-model or native-client certification.

In Connections, choose a project, then select a folder of `.txt`/`.md` files or JSON conversations. Preview the detected records and skipped files before saving. The browser selection is a one-time import, not a folder watcher or account sync. The JSON adapter accepts conversation arrays with text messages, including common `messages` and `mapping` shapes; unrecognized structures are rejected or warned. Previously delivered client/provider copies cannot be recalled by local deletion.

For a local folder with an explicit symlink policy, stop the app and run `npm run import:folder -- <folder> <project-id>` to inspect the selection; repeat with `--apply` to save it. The CLI skips symbolic links, special files and attachments, and bounds depth, file count and bytes. It does not watch for changes. A later import of the same body is deduplicated; deleting an imported source removes it from active retrieval. Keep unmanaged original folder copies under your own retention policy.

If a permanent deletion reports `FORGET_INCOMPLETE`, the source is already out of active use but managed erasure needs another pass. Retry in the open deletion dialog, or after stopping the app run `npm run vault:finalize-forget -- <deleted-source-id>`. The command returns a new read-after-delete proof and exits nonzero if any managed proof bit is false. Do not restore an older backup without applying current tombstones.

