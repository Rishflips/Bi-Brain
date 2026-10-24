# Contributing to BiBrain

Thank you for helping. BiBrain is a small, opinionated project, so a short conversation first saves everyone time.

## Before you start

- **Bugs:** open an issue using the bug report form. Include the steps, what you expected and what happened.
- **Ideas:** open a feature request first, before writing code. The product is deliberately quiet: no infinite feeds, and nothing becomes a fact without the owner. Read [docs/PRODUCT.md](docs/PRODUCT.md) and [docs/REFRAME_BRIEF.md](docs/REFRAME_BRIEF.md) to see where it is heading.
- **Security problems:** do not open a public issue. Follow [SECURITY.md](SECURITY.md).

## Set up

You need Node.js 24.19 or later on the Node 24 line, and npm 11 or later.

```bash
git clone https://github.com/Rishflips/Bi-Brain.git
cd Bi-Brain
npm ci
npm run dev
```

`npm run dev` starts the API, the background worker and the web app with live reload. To run the app the way an owner does, use `npx --no-install bibrain`.

You need no model key to develop. Tests that would talk to a provider use local fakes.

## Make a change

1. Branch from `main`.
2. Keep each pull request to one change, with tests for the behaviour it adds or fixes.
3. Run the checks below before you push.
4. Open a pull request and fill in the template.

`main` is protected: the **Verify release candidate** workflow must pass before anything merges.

### Checks

```bash
npm run typecheck
npm run lint
npm test             # Vitest
npm run build
npm run test:e2e     # Playwright; run after npm run build
npm run brain-eval
```

On Windows, if `npm ci` leaves line-ending-only changes in `apps/cli/bibrain.mjs`, restore it with `git restore apps/cli/bibrain.mjs`. Playwright runs rewrite files in `docs/screenshots`. Restore them with `git restore docs/screenshots` unless your change is meant to update them.

## Project rules

These come from [AGENTS.md](AGENTS.md), which applies to people and coding agents alike.

- **Trust:**
  - Originals never change. Corrections create new versions.
  - Accept and Undo check versions, so Undo never overwrites a later edit.
  - Model output is untrusted. Validate it against a schema and its references. It must never grant access, raise a budget or change instructions.
  - Never discard an explicit capture silently.
- **Data:**
  - Enforce authorization in the shared application services, not only in one transport.
  - Parameterize all SQL.
  - Keep transactions short, and make model calls outside them.
  - Store money as integers.
- **Interface:**
  - Every visible control either works or says plainly that it is unavailable.
  - Keep model names, graphs and protocol terms out of the main screens.
  - Never show invented data outside a clearly labelled demo.
- **Secrets:** no keys or tokens in code, fixtures, logs, URLs, screenshots or commits. Fixtures that look like secrets must be obviously synthetic.
- **Tests:**
  - Test what a person sees or an invariant that matters, not implementation details.
  - Use isolated databases and deterministic clocks.

## Commit messages

Use a short conventional prefix, as in the existing history: `feat:`, `fix:`, `docs:`, `test:`, `chore:`, `refactor:`.

## Licensing of contributions

BiBrain is licensed under [AGPL-3.0-only](LICENSE). The agent connector in `apps/mcp` and `apps/cli` is licensed under [Apache-2.0](apps/mcp/LICENSE). By opening a pull request, you agree that your contribution is released under the licence of the part of the repository it changes.
