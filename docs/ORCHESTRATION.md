# BiBrain delivery orchestration

This is the operating method for building BiBrain without blurring ownership,
trust boundaries, or release evidence. It is deliberately lightweight: the
repository is the source of truth, and one delivery owner integrates every
change.

## Default operating mode

One owner works a vertical slice from a written acceptance statement through
independent verification. Do not create parallel agents or worktrees unless the
owner explicitly asks for delegation. That keeps the default workflow simple
and makes every edit attributable.

For each slice:

1. Read `AGENTS.md`, the required product documents, `BUILD_STATE.md`, and the
   current handoff before making changes.
2. Record the target, user-visible outcome, authorization/trust boundaries,
   files expected to change, and exact acceptance evidence.
3. Check `git status`, preserve unrelated work, then implement the smallest
   complete persistence-to-UI path.
4. Run the focused tests first, then the relevant quality gates. Inspect the
   final diff and test a user-visible path when the slice has a UI surface.
5. Update `BUILD_STATE.md` and the relevant implementation-plan checkbox only
   with commands that actually passed. State live-service and native-client
   gaps explicitly.

## Work card

Before coding, put this compact work card in the task description, handoff, or
PR body:

```text
Outcome: <observable user result>
Scope: <packages/files and do-not-touch areas>
Trust constraints: <authorization, evidence, mutation, secret boundaries>
Acceptance: <tests and manual behavior that must pass>
Blocked external proof: <credentials/service/client, or none>
```

This is enough detail to prevent a task from becoming a vague "improve it"
request while remaining easy to hand over.

## Delegated work (only with explicit owner approval)

Use three non-overlapping lanes. Each lane owns a file set; no two editors
modify the same files.

| Lane | Suitable work | Required return |
| --- | --- | --- |
| Discovery | Read-only architecture, tests, integration options, risk review | Evidence-backed recommendation; no edits |
| Implementation | One bounded service, UI, migration, or test area | Diff, focused tests, known limits |
| Verification | Independent review, regression, browser or process checks | Commands, outcomes, repro steps for failures |

The delivery owner defines the work cards, starts all independent discovery or
implementation lanes together, resolves shared interfaces before integration,
and runs the final repository-wide gates. A reviewer must not self-certify the
same trust-sensitive behavior they implemented.

For supervised Orca work, create one Run per delivery objective and one Task
per work card. Wait for explicit worker settlement, validate the reported
evidence against the working tree, then release or retain each worker. Do not
treat a timeout, missing message, or screenshot as success.

## Gates for this repository

Use the narrowest meaningful evidence first. A normal code slice should finish
with the applicable commands below, not merely a production build:

```powershell
npm run typecheck
npm run lint
npm test
npm run build
```

Add the focused test file(s), `npm run brain-eval`, or `npm run test:e2e` when
the changed behavior reaches the corresponding boundary. For authorization,
revocation, deletion, billing, worker recovery, or native-agent claims, run the
specific regression and record the environment. Synthetic fixtures prove only
synthetic behavior; live provider, payment, hosted, and fresh-native-client
proof stay open until actually performed.

## Handoff and recovery

Every handoff states: current branch and clean/dirty status; completed outcome;
modified files; commands run and results; remaining external gate; and the one
safe next action. Never include secrets, pairing codes, tokens, personal data,
or external configuration values.

If a check fails, stop at the smallest reproducible failure, preserve the
evidence, and either repair it in the same slice or create a new work card with
the failing command as acceptance. Do not downgrade a failed live check into a
claimed synthetic success.
