# Security policy

BiBrain holds people's private notes and gives AI agents scoped access to them, so we take reports seriously.

## Reporting a vulnerability

Please **do not open a public issue**. Report it privately through GitHub instead:

1. Open the repository's **Security** tab.
2. Choose **Report a vulnerability**.

Please include:

- what an attacker can do, and what they need first (for example network access to the server, a connected agent, or a crafted note);
- steps or a proof of concept against a local install;
- the commit or version you tested.

Please do not include real personal data or real keys.

We aim to acknowledge reports within a few days and will keep you updated until there is a fix. We are glad to credit you in the advisory, unless you would rather stay anonymous.

## Supported versions

BiBrain is pre-1.0. Security fixes land on `main` only.

## Scope

In scope:

- the local server, worker and web app in this repository;
- the agent connector (`apps/mcp`, `apps/cli`);
- the self-hosting configuration in `deploy/`.

Of particular interest:

- authorization bypasses between projects or agents;
- an agent key or owner secret reaching the browser, a URL, a log or a project file;
- model output that changes permissions, budgets or instructions;
- an Undo that overwrites a later edit;
- spending beyond the owner's limits.

Out of scope:

- the paused hosted edition, which is not deployed;
- problems that require an attacker who already controls the owner's computer;
- reports from automated scanners with no demonstrated impact.

For how BiBrain is designed to protect data, see [docs/SECURITY_PRIVACY.md](docs/SECURITY_PRIVACY.md).
