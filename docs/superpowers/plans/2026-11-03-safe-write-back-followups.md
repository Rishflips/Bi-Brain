# Plan 8 (safe write-back): parked items

Recorded while executing `docs/superpowers/plans/2026-11-03-safe-write-back.md`. Each item is parked with its reason.

## Security (spec A4)

- **L2, dependency advisories.** Checked on 2026-11-03: `@fastify/static@10.1.8` (latest) still depends on `glob@^13`, and the fix for `glob` is `>=14.0.2`; `npm audit` offers only a breaking downgrade. `minimatch <11.0.1` reaches the tree through ESLint and typescript-eslint, which have not moved. An `overrides` entry would ship the static file server on a dependency its author has not validated. All advisories are moderate and CI gates at `high`. Revisit when `@fastify/static` or ESLint publish a release on the fixed versions.
- **L4, secret scanner breadth.** It needs its own plan: the server list and the CLI mirror must move together, every new pattern needs false-positive evidence from real notes, and a wrong rule quarantines a real note.
- **L7, Windows file modes.** The ACL helper lives in a frozen `billing*` file. Documented instead: keep `data/` under your own user profile on a shared Windows machine.
- **I3, "prompts leave the computer" copy.** A wording change in the Recall help label, pinned by UX copy and tests; not security code. Noted for the Settings plan.
- **I4, I5.** Hosted internals and the stale `OPENAI_API_KEY` wiring belong to the hosted plan.

## Bring in what you already have (spec B2)

- **Git log import.** The browser cannot run git, and the server must not run commands on an owner-supplied path from a page request. A `bibrain import-git` CLI command is a separate plan.
- **Empty-brain pointer on the first prompt.** The push says only what is recorded. A pointer on an empty brain would be an imperative aimed at the agent, which the push never carries.
