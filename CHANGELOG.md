# Changelog

All notable changes to BiBrain are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] - 2026-11-02

First public release. BiBrain is a local-first second brain that keeps AI coding agents caught up. You save a note, or a connected agent writes one when it finishes work. BiBrain keeps the original, works out what changed, and nothing becomes a fact until you keep it.

### Added

**Today**
- One bar that saves a note or answers a question from what you have kept. The answer quotes the saved original.
- A Brief of at most three things worth a decision. Each shows its evidence. You can Keep, Fix or Dismiss it, and Undo.
- Project cards, each with a Watch switch. A project that is not watched goes quiet on Today and stays in Your brain.
- When nothing needs you, Today says so. There is no endless feed.

**Your brain**
- A project list and one page per project: the facts that are true now, open questions, originals and goals.
- Edit a fact as a new version, and Undo. Open any fact to see the exact passage it came from, highlighted, with its history.
- Search across facts and originals in all projects. It uses the same ranked recall that agents use.

**Connections and agent recall**
- One tile each for Codex, Claude Code and Cursor. **Add** writes the agent's project files in one step and never changes an existing file. **Revoke** ends access at once. Any other agent gets a copied handoff or setup by hand.
- A tile says Connected only after the agent's first real call.
- Recall on every prompt: Claude Code and Codex get a prompt hook. Cursor gets an always-on rule file that tells it to call `brain_recall`. Codex runs a project hook only after you trust it once.
- A connector with seven tools (`brain_recall`, `brain_open`, `brain_note`, `brain_propose`, `brain_intent`, `brain_link`, `brain_forget`). `brain_recall` returns ranked, cited hits, or says plainly that nothing is recorded.
- Session notes: when an agent finishes, it can leave its decisions, open questions and next step. They arrive as suggestions for your review.
- `npx --no-install bibrain` builds and starts BiBrain and opens your browser already signed in through a one-time link. `bibrain open` opens it again.

**Sorting help (optional, off by default)**
- A small decision model, Clef, looks at each new note through Ollama or Cloudflare Workers AI.
- It can suggest "File in Northstar?" (Northstar is an example project; a move happens only on Keep), rank a low-value card lower, or wake a review you already planned.
- It runs only with your consent and within the daily and per-note limits you set.

**Better search (optional, off by default)**
- Finds notes by meaning as well as by words, including across languages such as English and Tamil. It runs with Ollama on your computer or with Cloudflare Workers AI.
- With it off, nothing is sent anywhere and results are the same as without it.
- An optional "Recall help" judge can reorder what recall already found. It is off by default and needs sorting help on.

**Calibration report**
- `npm run calibrate` reads your brain (it changes none of your data; a read-only open can leave empty `-wal` and `-shm` files) and prints every threshold, how sorting answers and kept or dropped cards fall around them, pushes by agent and level, and the signals it cannot see. Where there are fewer than 20 samples it says "Not enough data yet".

**Self-hosting**
- A Docker Compose package with an HTTPS proxy, for one owner on one always-on Linux host. See [Self-hosting](docs/SELF_HOSTING.md).
- `npm run backup` takes a database snapshot. It does not include Git history or quarantined originals. For a full copy, stop BiBrain and copy the whole data folder.
- The one-click sign-in link and one-step Add are not available on a self-hosted copy; sign in with the installation code.

**Licences**
- The app is AGPL-3.0-only. The agent connector (`apps/mcp` and `apps/cli`) is Apache-2.0.

### Changed

- Updated `@hono/node-server` to 2.1.5 to fix GHSA-rmxm-3fg6-px4f. It is a patch-level update of a dependency of the MCP SDK. No other package moved.

### Security and privacy

- **Originals never change.** A correction creates a new version, and Undo does not overwrite a later edit. You can still delete a note permanently.
- **Agents only suggest.** Their notes and proposals wait for your review. An agent cannot accept its own suggestion. An agent can delete only notes it wrote itself, and only with a separate deletion grant that one-step connections never get.
- **Access is scoped and revocable.** An agent sees only the projects you pick. One-step connections last 90 days unless you revoke them.
- **Keys stay out of the browser and your projects.** Provider keys are read only by the background worker. An agent's access key rests in BiBrain's data folder, not in the project file.
- **Model output is untrusted.** It is checked against a fixed schema and cannot grant access, raise a limit or change instructions.
- **Spending is bounded.** Paid calls stay within your daily and per-note limits and are counted in whole micro-dollars.
- **The calibration report is read-only.** It opens the database read-only, changes nothing, sends nothing and never prints note text.
- **Local by default.** Started with `npx --no-install bibrain` or `npm start`, the app listens only on 127.0.0.1 (this computer). The Docker image listens on all interfaces inside its container, and the provided Compose file publishes only the HTTPS proxy. No account, subscription or model key is needed.

### Known limits

- **Owner-run checks are still owed.**
  - `npm run proof:search` (Better search) has not been run, and `npm run calibrate` has run only against a synthetic brain.
  - `scripts/native-client-proof.ts` has not been re-run after its fixes.
  - Cursor has not been run natively.
  - No live Recall help judge call has been made.
  - Better search has never called a real embedding model, so its quality, including in Tamil, is unmeasured. Its results come from a fake embedder.
- **Run live by the maintainer on Windows (2026-10-27):** recall in Claude Code 2.1.283 and Codex 0.156.1, with the hook on and off, and one Clef sorting check through Ollama Cloud that validated 3 of 3 answers. Cloudflare and a local Ollama have not been run live. The Codex run skipped the one-time hook-trust prompt with a test flag, so what you see when you trust the hook yourself has not been observed. Cursor's rule file has not been run in Cursor.
- **Hosted edition and payments are paused.** The code is kept but not deployed. No real payment has been processed.
- **Platforms.** Tests run in CI on Ubuntu (ubuntu-latest, Node 24.19.0) and locally on Windows. macOS is untested. Self-hosting has been checked only in CI containers, not on a live server with real DNS and TLS.
- **First-run browser sign-in has not been observed on a real machine.** The automatic step that opens your browser already signed in through a one-time `#pair=` link is covered by tests with a stubbed browser. If the browser does not open or shows the sign-in screen, run `npx --no-install bibrain open`, or sign in by hand with the pairing code in `data/owner-secret` (see the README).
- **Dependencies.** `npm audit` reports moderate advisories in `glob` and `minimatch`, reached through `@fastify/static` and ESLint. Fixing them needs a breaking change. There are no high or critical findings.
- **One-step Add works only in the app on your own computer.** A self-hosted copy (HTTPS) or the paused hosted edition uses setup by hand.
- Open questions on Your brain are found by simple rules, not by a model. The Ask bar answers only from saved material and does not call a model.
- **Hook pushes follow your words.** A note found only by meaning reaches `brain_recall` and your screens but does not make a hook push louder. The first search of a new question can be words-only while the worker warms up.
- **Sorting help.** A call that fails after it was sent is not retried, and the monthly cap is not built yet.
- **Better search.** It runs on the local app only. Its vectors reload from SQLite after each index write, which is fine to about 100,000 passages.
- **Windows hook quoting.** Quoting of the hook command under `cmd.exe /c` has not been observed. Both native hook runs went through each client's own shell.
- `bibrain` is not published to npm. Run it from inside the BiBrain folder.
- Self-hosting gives one owner on one host: no multi-user isolation and no password recovery.

### Requirements

Node.js 24.19 or later on the Node 24 line, and npm 11 or later.

### Verified

Vitest 1,953 passed (8 skipped) and Playwright 107 passed, on Windows with Node 24.19.0. Typecheck, lint and build pass, and `npm run brain-eval` passes 25 of 25. These counts come from the main branch before this release branch's `@hono/node-server` update; the suites also passed in CI on Ubuntu at the last merge into main. CI on the release pull request re-runs everything. Details and commands: [BUILD_STATE.md](BUILD_STATE.md).

### Development history

[BUILD_STATE.md](BUILD_STATE.md) and [docs/history/](docs/history/README.md).
