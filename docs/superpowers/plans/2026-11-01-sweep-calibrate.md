# Plan 7: Sweep and Calibrate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the ten small "do" items from the sweep, move one threshold on the owner-run evidence that exists (`DURABLE_LOW` 0.25 → 0.20), and give the owner a read-only calibration report (`npm run calibrate`) that prints distributions beside every other threshold with suggestions, so the next thresholds move on real data instead of guesses.

**Architecture:** The thresholds stay in the modules that own them; a new pure module `packages/domain/calibration.ts` imports them into a registry and turns rows into counts, histograms and suggestions. `scripts/calibrate.ts` opens the owner's SQLite file read-only through `node:sqlite` (never through `Storage`, whose constructor writes), reduces the rows to numbers, and prints. Two content-free fields join the recall log only when their feature was used (`dense_top`, `judge`), so Better search off and Recall help off stay byte-identical to plan 5. The sweep fixes are one-line edits plus one doc rewrite.

**Tech Stack:** TypeScript, Node 24 (`node:sqlite` `DatabaseSync`, `readOnly: true`), Vitest, ESLint (`no-unused-vars` is an error), Playwright for the final gate only.

**Spec:** `docs/superpowers/specs/2026-11-01-sweep-calibrate-design.md`. Read it first: it holds the inventory, the calibration table, the rulings R1–R10 and the report's privacy rules. The plan argues from it.

## Global Constraints

- Work only in the worktree `C:/Users/Gowrishankar/Desktop/Bi Brain/.worktrees/sweep` on branch `reframe/sweep-calibrate`. Never write, create, delete or run git in the main checkout `C:/Users/Gowrishankar/Desktop/Bi Brain` outside `.worktrees/sweep`.
- Never read `C:/Users/Gowrishankar/Desktop/Bi Brain/data/`, any `brain.sqlite` outside a test temp folder, or any `.env`. Never print a key.
- Never run `scripts/native-client-proof.ts`, `scripts/system-one-live-proof.ts`, `scripts/recall-agent-proof.ts` or `scripts/better-search-proof.ts` with their live flag. The refusal tests spawn them without the flag only.
- Zero edits to: any `dodo*`, `billing*`, `managed*`, `paddle*` file or test, `managedPreferencesPatchSchema`, any migration or `CREATE TABLE`, `docs/DODO_PAYMENTS.md`, `docs/RELEASE.md`, `docs/IMPLEMENTATION_PLAN.md`, `docs/PRICING_PROPOSAL_2026-10-21.md`, `docs/BUSINESS.md`.
- `tests/eval/recall-dense-off-snapshot.json` is not regenerated. If the snapshot test fails, the change is wrong, not the snapshot.
- No features, no refactors, no renames beyond what a task names. Every task's model is **Sonnet 5.5**; no task touches worker leases, the dispatch ledger or concurrency (Ruling R10).
- Commit with explicit paths (`git add <file> ...`, never `git add .`). End every commit message with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. No rebase, no force-push, no bare `git stash`, no push.
- If `git status` shows `apps/cli/bibrain.mjs` modified with no content change (line endings), run `git restore apps/cli/bibrain.mjs` before committing.
- Full Vitest runs use `npx vitest run --reporter=dot --maxWorkers=3`. After any Playwright run: `git restore docs/screenshots`.
- Copy rule (AGENTS.md): plain language, no model names or MCP terms in owner-facing output; uncertainty stated plainly. The report's every suggestion ends with "Nothing changes unless you edit the code."

## Review Focus

Classes most likely to bite a person, in order. Each has its pinning test in the task that owns the code.

1. **A read-only open of a WAL database.** The owner's `brain.sqlite` is in WAL mode; the server may be running (`-wal` and `-shm` present) or stopped (neither present). Both must open read-only and print the same report; a failure must say what to do, not stack-trace. Pinned in Task 6 by running the script once with the fixture closed and once while a `Storage` handle holds it open, and by the missing-file case.
2. **Older log rows.** Pushes recorded before this plan have `judged: true` without `judge`, or `dense: true` without `dense_top`; a dense push with no passage over the floor also has no `dense_top`. The report must count them and name the gap, never throw. Pinned in Task 4.
3. **Malformed sorting answers.** An `s1_answer` with no `answers` array, a `noul` whose probability is not a number, or a feedback row with a string confidence must be skipped, not crash the report. Pinned in Task 4.
4. **A database from a newer BiBrain** (migrations version above 7) must be refused with a plain sentence and exit 2, exactly as `Storage` refuses it. Pinned in Task 6.
5. **Note text in the output.** No path in the report may print a word from a note, in text or `--json` mode. Pinned in Task 6 with a canary word captured into the fixture and asserted absent from both outputs, and by the sha-256 of the database file before and after a run.

---

### Task 1: Sweep batch: eight small fixes (Sonnet)

**Files:**
- Modify: `tests/integration/agent-grants.test.ts:41,45`
- Modify: `packages/domain/service.ts:4613` (one comment)
- Modify: `apps/web/today/types.ts:17-41` (`BriefItem`)
- Modify: `tests/integration/watch.test.ts:22-40`
- Modify: `docs/UX.md:41-61`, `:46`, `:146`, `:159`

**Interfaces:**
- Consumes: `Brain.capture`, `Brain.entities(owner, "gate")`, `Brain.reviewGate(owner, id, { action: "accept", expected_version })` (all public).
- Produces: nothing new.

- [ ] **Step 1: Escape the Windows path in the grants test**

In `tests/integration/agent-grants.test.ts`, both occurrences (lines 41 and 45) of

```ts
folder: "C:\work\northstar",
```

become

```ts
folder: "C:\\work\\northstar",
```

- [ ] **Step 2: Run the grants test**

Run: `npx vitest run tests/integration/agent-grants.test.ts`
Expected: PASS (`createGrant` validates `folder` only as a string of at most 1,000 characters; the displayed folder is the stored string).

- [ ] **Step 3: Correct the `briefInput` comment**

In `packages/domain/service.ts` at line 4613 replace

```ts
    // Grants carry no display name, so every connected agent is named generically.
```

with

```ts
    // A grant records which client connected, not a free display name, so each agent is named by its client.
```

- [ ] **Step 4: Mirror `quiet` on the web `BriefItem` type**

In `apps/web/today/types.ts`, inside `export type BriefItem = { ... }`, after the line `created_at: string;` add

```ts
  /** Set when sorting help judged the card not worth today's short list; it ranks last and is never hidden. */
  quiet?: true;
```

- [ ] **Step 5: Make the watch test's facts comparison real**

In `tests/integration/watch.test.ts`, replace the first `it` block (lines 23–40) with:

```ts
  it("is on by default, and an unwatched project's cards leave Today but stay in Your brain", () => {
    const b = setup();
    const p = b.createProject(owner, "Northstar");
    b.capture(owner, { project_id: p.id, title: "Status", body: "northstar status active", visibility: "project" });
    // A second note is reviewed and kept, so the project has a real fact and the comparison below compares something.
    const kept = b.capture(owner, { project_id: p.id, title: "Launch", body: "The launch color is amber.", visibility: "project", separate: true }) as any;
    const gate = b.entities(owner, "gate").find((g) => g.data.raw_id === kept.source_id)!;
    b.reviewGate(owner, gate.id, { action: "accept", expected_version: gate.version });
    expect(b.projects(owner).find((x) => x.id === p.id)?.watched).toBe(true);
    expect(b.brief(owner).items).toHaveLength(1);
    const before = b.brainProject(owner, p.id);
    expect(before.facts).toHaveLength(1);
    expect(b.watchProject(owner, p.id, { watched: false })).toEqual({ id: p.id, watched: false });
    expect(b.brief(owner).items).toEqual([]);
    const view = b.brainProject(owner, p.id);
    expect(view.waiting_for_review).toBe(0);
    expect(view.originals).toHaveLength(2);
    expect(view.facts).toEqual(before.facts);
    expect(view.needs_decision).toEqual(before.needs_decision);
    b.watchProject(owner, p.id, { watched: true });
    expect(b.brief(owner).items).toHaveLength(1);
    expect(b.brainProject(owner, p.id).waiting_for_review).toBeGreaterThan(0);
  });
```

- [ ] **Step 6: Run the watch test**

Run: `npx vitest run tests/integration/watch.test.ts`
Expected: PASS. If `expect(b.brief(owner).items).toHaveLength(1)` fails with 2 items, the accepted gate left a card; read `b.brief(owner).items` in a scratch `console.log`, and if the extra card is a `stale` or `correction` card for the kept fact, change the kept body to `"Ana is the design lead."` (a statement with no status aspect) and re-run. Do not weaken the `facts` assertions.

- [ ] **Step 7: Bring `docs/UX.md` in line with Today v2 and Your brain v2**

Replace lines 41–61 (from `After save:` through the paragraph ending `a generated key is not completion.`) with:

```markdown
After save:

1. Confirm the save immediately. The note is in Your brain's Originals at once.
2. When BiBrain finds something in the note worth keeping, a card appears in the Brief on Today with Keep, Fix and Dismiss. Nothing becomes a fact until the owner keeps it.
3. When sorting help is on, an Inbox note may also get a "File in …?" card. Otherwise the Brief stays quiet, and quiet is normal.
4. Open it shows the saved original. Facts kept from it appear in Your brain under True now, and the project page has Preview handoff.
```

Keep the paragraph that begins `Do not force sign-up in the local application.` as the next paragraph.

At line 146 (after the edit above the number shifts; find the line by text) replace

```markdown
No-result state: No matching notes. Try a different word or save something new.
```

with

```markdown
No-result state: No matches. Try a different word, or save something new.
```

At the line beginning `- Preview agent handoff uses the existing server-built project handoff;` replace `Preview agent handoff` with `Preview handoff`.

- [ ] **Step 8: Check the copy against the app**

Run: `grep -n "No matches. Try a different word, or save something new." apps/web/brain/BrainSearch.tsx docs/UX.md` and `grep -n "Preview handoff" apps/web/brain/BrainView.tsx docs/UX.md`
Expected: one hit in each code file and one in `docs/UX.md` per grep; `grep -n "first useful\|Preview agent handoff\|No matching notes" docs/UX.md` prints nothing.

- [ ] **Step 9: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: both exit 0.

- [ ] **Step 10: Commit**

```bash
git add tests/integration/agent-grants.test.ts packages/domain/service.ts apps/web/today/types.ts tests/integration/watch.test.ts docs/UX.md
git commit -m "chore(sweep): eight small fixes from the parked follow-ups

Escape the Windows path in the grants test, correct the briefInput comment,
mirror quiet on the web BriefItem type, seed a kept fact in the watch test so
its facts comparison is real, and bring docs/UX.md in line with Today v2 and
Your brain v2 (after-save flow, no-result copy, Preview handoff).

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Native proof harness: Codex trust fix and a refusal test (Sonnet)

**Files:**
- Modify: `scripts/native-client-proof.ts:1-35`, `:185-215`, `:325-335`
- Create: `tests/integration/native-client-proof.test.ts`

**Interfaces:**
- Consumes: nothing new. The edit copies PR #30's fix from `scripts/recall-agent-proof.ts:21-29` and `:104-112`.
- Produces: nothing other tasks use. **The script is never run with `BRAIN_NATIVE_PROOF=1` in this plan.**

- [ ] **Step 1: Write the refusal test**

Create `tests/integration/native-client-proof.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const native = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((n) => n.startsWith("native-") || n.startsWith("bibrain-native-ws-")) : []);

describe("scripts/native-client-proof.ts", () => {
  it("refuses to run without its explicit flag, refuses an unknown client, and creates nothing", () => {
    const before = [...native(resolve("test-results")), ...native(tmpdir())];
    const env = { ...process.env };
    delete env.BRAIN_NATIVE_PROOF;
    const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/native-client-proof.ts", "codex"], { encoding: "utf8", env, timeout: 60_000 });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("Explicitly set BRAIN_NATIVE_PROOF=1 and choose codex or claude. This uses native subscription quota.");
    const wrongClient = spawnSync(process.execPath, ["--import", "tsx", "scripts/native-client-proof.ts", "cursor"], { encoding: "utf8", env: { ...env, BRAIN_NATIVE_PROOF: "1" }, timeout: 60_000 });
    expect(wrongClient.status).not.toBe(0);
    expect(wrongClient.stderr).toContain("choose codex or claude");
    expect([...native(resolve("test-results")), ...native(tmpdir())]).toEqual(before);
  });
});
```

- [ ] **Step 2: Run it to see it pass on the current script (the guard already exists)**

Run: `npx vitest run tests/integration/native-client-proof.test.ts`
Expected: PASS. This pins the guard before the harness edit.

- [ ] **Step 3: Move the Codex workspace out of the repository**

In `scripts/native-client-proof.ts`, add to the imports (after the `node:fs` import):

```ts
import { tmpdir } from "node:os";
```

Replace

```ts
const root = mkdtempSync(join(base, `native-${client}-`));
const workspace = join(root, "workspace");
const dataDir = join(root, "data");
mkdirSync(workspace);
mkdirSync(dataDir);
```

with

```ts
const root = mkdtempSync(join(base, `native-${client}-`));
// The workspace lives outside this repository: inside it, Codex would treat the BiBrain
// repo as the project (reading its AGENTS.md and looking for .codex/ at the repo root).
const workspaceBase = realpathSync.native(tmpdir());
const workspacePrefix = join(workspaceBase, "bibrain-native-ws-");
const workspace = realpathSync.native(mkdtempSync(workspacePrefix));
const dataDir = join(root, "data");
mkdirSync(dataDir);
```

- [ ] **Step 4: Trust the disposable workspace and bypass the one-time hook review**

Still in `scripts/native-client-proof.ts`, directly before `const args =` (inside the `try`, after `const executable = ...`), add:

```ts
  // Codex loads a project's .codex/ layer only when the project is trusted, and trust lives
  // in the user config that --ignore-user-config skips. A -c override trusts this disposable
  // workspace; its key path is split on dots, so the folder path must not contain one.
  // The one-step connect writes .codex/hooks.json, and --dangerously-bypass-hook-trust stands
  // in for the one-time /hooks review a person does.
  if (client === "codex" && folder.includes(".")) throw new Error(`The temporary folder ${folder} contains a dot, so Codex cannot be told to trust it. Set TEMP to a folder without dots and run again.`);
  const codexTrust = client === "codex" ? ["-c", `projects.${folder}.trust_level="trusted"`, "--dangerously-bypass-hook-trust"] : [];
```

and in the Codex branch of `args`, after `"--ignore-user-config", // the project's .codex/config.toml written above carries BiBrain` insert the spread so the array reads:

```ts
          "exec",
          "--ignore-user-config", // the project's .codex/config.toml written above carries BiBrain
          ...codexTrust,
          "--ephemeral",
```

- [ ] **Step 5: Clean the workspace up, guarded**

In the `finally` block, after

```ts
  if (!resolve(root).startsWith(base + sep))
    throw new Error("Refusing cleanup outside the disposable proof directory.");
  rmSync(root, { recursive: true, force: true });
```

add

```ts
  if (!workspace.startsWith(workspacePrefix))
    throw new Error("Refusing cleanup outside the disposable proof workspace.");
  rmSync(workspace, { recursive: true, force: true });
```

- [ ] **Step 6: Typecheck, lint, and re-run the refusal test**

Run: `npm run typecheck && npm run lint && npx vitest run tests/integration/native-client-proof.test.ts`
Expected: all exit 0. `mkdirSync` is still used (for `base` and `dataDir`), so no unused import.

- [ ] **Step 7: Commit**

```bash
git add scripts/native-client-proof.ts tests/integration/native-client-proof.test.ts
git commit -m "fix(native-proof): run Codex in a trusted workspace outside the repo

Apply the recall proof's PR #30 fix to the native acceptance script: the
workspace moves to the system temp folder, Codex is told to trust it with a
-c override, and the hook trust review is bypassed for the disposable run.
A refusal test pins the guard without ever spending quota. The proof itself
stays owner-run and was not executed.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Ruling R1: the durable demotion line moves to 0.20 (Sonnet)

**Files:**
- Modify: `packages/storage/recall-index.ts:34-36`
- Modify: `tests/integration/recall-index.test.ts:10-16`, `:101-104`
- Modify: `tests/integration/recall-capture-hints.test.ts:45`

**Interfaces:**
- Produces: `export const DURABLE_HIGH = 0.6`, `export const DURABLE_LOW = 0.2`, `export const TOPIC_MIN_CONFIDENCE = 0.7` from `packages/storage/recall-index.ts`. Task 4's registry imports all three.

- [ ] **Step 1: Write the failing tests**

In `tests/integration/recall-index.test.ts`, add `DURABLE_LOW` to the import list from `../../packages/storage/recall-index.ts` (the list that holds `durableBoost`), and after line 104 (`expect(durableBoost(null)).toBe(1);`) add:

```ts
    // Ruling R1 (plan 7): the one live decision under the old 0.25 line scored 0.23 and must not be demoted.
    expect(DURABLE_LOW).toBe(0.2);
    expect(durableBoost(0.23)).toBe(1);
    expect(durableBoost(0.2)).toBe(1);
    expect(durableBoost(0.19)).toBe(0.9);
```

In `tests/integration/recall-capture-hints.test.ts` line 45, extend the tuple list so it reads:

```ts
    for (const [body, durable, boost] of [["Keep: the launch colour is cobalt.", 0.9, 1.15], ["Lunch at noon.", 0.1, 0.9], ["Maybe later.", 0.4, 1], ["We decided Northstar ships with one plan.", 0.23, 1]] as const) {
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/integration/recall-index.test.ts tests/integration/recall-capture-hints.test.ts`
Expected: FAIL: `DURABLE_LOW` is not exported (typecheck error in the test) and `durableBoost(0.23)` returns 0.9.

- [ ] **Step 3: Export the three constants and move the line**

In `packages/storage/recall-index.ts` replace lines 34–36

```ts
const DURABLE_HIGH = 0.6;
const DURABLE_LOW = 0.25;
const TOPIC_MIN_CONFIDENCE = 0.7;
```

with

```ts
/** At or above this capture-time durable probability an original's chunks rank ×1.15. */
export const DURABLE_HIGH = 0.6;
/**
 * Below this durable probability an original's chunks rank ×0.9 (never excluded). 0.25 until plan 7; the one live
 * decision recorded under that line scored 0.23 and a decision should count as lasting (spec 2026-11-01, ruling R1).
 */
export const DURABLE_LOW = 0.2;
/** A capture-time topic joins a chunk's prefix only at or above this confidence. */
export const TOPIC_MIN_CONFIDENCE = 0.7;
```

- [ ] **Step 4: Run the tests and the golden gates**

Run: `npx vitest run tests/integration/recall-index.test.ts tests/integration/recall-capture-hints.test.ts tests/integration/recall-dense.test.ts tests/eval`
Expected: all PASS. The golden fixture carries no durable hints, so recall results and the dense-off snapshot are unchanged.

- [ ] **Step 5: Commit**

```bash
git add packages/storage/recall-index.ts tests/integration/recall-index.test.ts tests/integration/recall-capture-hints.test.ts
git commit -m "feat(recall): move the durable demotion line to 0.20 on the live evidence

The 2026-10-27 sorting run scored a real decision durable 0.23, under the
0.25 line, though a decision should count as lasting. The line moves to 0.20;
the demotion is only x0.9 and never an exclusion, the golden set has no durable
hints, and tests pin 0.23 -> 1 and 0.19 -> 0.9 (ruling R1). The three hint
constants are exported for the calibration registry.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The threshold registry and the calibration module (Sonnet)

**Files:**
- Create: `packages/domain/calibration.ts`
- Create: `tests/integration/calibration-report.test.ts` (the pure-module half; Task 6 adds the script half to the same file)

**Interfaces:**
- Consumes: `S1_THRESHOLDS` (`./system-one.ts`), `PUSH_THRESHOLDS`, `PushLevel` (`./recall-push.ts`), `JUDGE_THRESHOLDS` (`./recall-judge.ts`), `DENSE_FLOORS`, `DENSE_WEIGHT` (`./better-search.ts`), `DURABLE_HIGH`, `DURABLE_LOW`, `TOPIC_MIN_CONFIDENCE` (`../storage/recall-index.ts`, Task 3).
- Produces (Task 6 depends on these exact names):
  - `THRESHOLDS: readonly Threshold[]` with `Threshold = { id: string; value: number; where: string; meaning: string }`.
  - `MIN_SAMPLE = 20`, `BINS = 10`.
  - `RecallLogRow`, `S1Answer`, `S1AnswerRow = { answers: S1Answer[] }`, `S1FeedbackRow = { question: string; choice: string | number; confidence: number; action: string }`, `CalibrationInput = { recall_log: RecallLogRow[]; s1_answers: S1AnswerRow[]; s1_feedback: S1FeedbackRow[]; embedded: { model: string; rows: number }[] }`.
  - `histogram(values: number[]): Histogram`, `calibrationReport(input: CalibrationInput): CalibrationReport`, `renderCalibration(report: CalibrationReport): string`.

- [ ] **Step 1: Write the failing tests**

Create `tests/integration/calibration-report.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { BINS, MIN_SAMPLE, THRESHOLDS, calibrationReport, histogram, renderCalibration, type CalibrationInput, type RecallLogRow, type S1AnswerRow } from "../../packages/domain/calibration.ts";
import { S1_THRESHOLDS } from "../../packages/domain/system-one.ts";
import { PUSH_THRESHOLDS } from "../../packages/domain/recall-push.ts";
import { JUDGE_THRESHOLDS } from "../../packages/domain/recall-judge.ts";
import { DENSE_FLOORS, DENSE_WEIGHT } from "../../packages/domain/better-search.ts";
import { DURABLE_LOW } from "../../packages/storage/recall-index.ts";

const value = (id: string) => THRESHOLDS.find((t) => t.id === id)?.value;
const answer = (over: { kind?: string; durable?: number; show?: number; review?: number }): S1AnswerRow => ({
  answers: [
    { id: "kind", type: "choice", choice: over.kind ?? "note", confidence: 0.8 },
    { id: "show", type: "noul", probability: over.show ?? 0.9 },
    { id: "review", type: "noul", probability: over.review ?? 0.1 },
    { id: "durable", type: "noul", probability: over.durable ?? 0.5 },
  ],
});
const row = (over: Partial<RecallLogRow>): RecallLogRow => ({ at: "2026-11-01T09:00:00.000Z", grant_id: "g", client: "codex", level: "none", candidates: 0, hits: 0, latency_ms: 3, judged: false, ...over });
const empty: CalibrationInput = { recall_log: [], s1_answers: [], s1_feedback: [], embedded: [] };

describe("the threshold registry", () => {
  it("reads every value from the module that owns it and has unique ids", () => {
    expect(value("recall.durable_low")).toBe(DURABLE_LOW);
    expect(value("recall.durable_low")).toBe(0.2);
    expect(value("sorting.quiet")).toBe(S1_THRESHOLDS.quiet);
    expect(value("sorting.file")).toBe(S1_THRESHOLDS.file);
    expect(value("sorting.review")).toBe(S1_THRESHOLDS.review);
    expect(value("push.owner_world_full")).toBe(PUSH_THRESHOLDS.owner_world_full);
    expect(value("judge.rel_keep")).toBe(JUDGE_THRESHOLDS.rel_keep);
    expect(value("search.dense_weight")).toBe(DENSE_WEIGHT);
    expect(value("search.dense_floor.bge-m3")).toBe(DENSE_FLOORS["bge-m3"]);
    expect(new Set(THRESHOLDS.map((t) => t.id)).size).toBe(THRESHOLDS.length);
    for (const t of THRESHOLDS) expect(t.where).toMatch(/^packages\//u);
  });
});

describe("histogram", () => {
  it("has ten bins over [0, 1], puts 1.0 in the last bin and skips non-numbers", () => {
    const h = histogram([0, 0.05, 0.1, 0.99, 1, Number.NaN, Number.POSITIVE_INFINITY]);
    expect(h.n).toBe(5);
    expect(h.bins).toHaveLength(BINS);
    expect(h.bins[0]).toBe(2);
    expect(h.bins[1]).toBe(1);
    expect(h.bins[9]).toBe(2);
  });
});

describe("the calibration report", () => {
  it("holds every suggestion while the sample is small, and says how much is missing", () => {
    const r = calibrationReport({ ...empty, s1_answers: [answer({ kind: "decision", durable: 0.23 })] });
    expect(r.sorting.answers).toBe(1);
    expect(r.sorting.decisions).toEqual({ n: 1, under_durable_low: 0, near_durable_low: 1 });
    const durable = r.suggestions.find((s) => s.threshold === "recall.durable_low")!;
    expect(durable.suggested).toBeNull();
    expect(durable.reason).toContain(`1 of ${MIN_SAMPLE}`);
    for (const s of r.suggestions) expect(s.suggested).toBeNull();
  });
  it("suggests a lower durable line only when a quarter or more of decisions fall under it", () => {
    const many = [...Array.from({ length: 8 }, () => answer({ kind: "decision", durable: 0.17 })), ...Array.from({ length: 16 }, () => answer({ kind: "decision", durable: 0.9 }))];
    const r = calibrationReport({ ...empty, s1_answers: many });
    const s = r.suggestions.find((x) => x.threshold === "recall.durable_low")!;
    expect(s.sample).toBe(24);
    expect(s.suggested).toBe(0.15);
    expect(s.reason).toContain("8 of 24");
    const few = [...Array.from({ length: 2 }, () => answer({ kind: "decision", durable: 0.17 })), ...Array.from({ length: 22 }, () => answer({ kind: "decision", durable: 0.9 }))];
    expect(calibrationReport({ ...empty, s1_answers: few }).suggestions.find((x) => x.threshold === "recall.durable_low")!.suggested).toBeNull();
  });
  it("reads kept and dropped show feedback by bucket and suggests raising the quiet line when the band above it is mostly dropped", () => {
    const fb = [
      ...Array.from({ length: 10 }, () => ({ question: "show", choice: 0.35, confidence: 0.35, action: "dismiss" })),
      ...Array.from({ length: 2 }, () => ({ question: "show", choice: 0.35, confidence: 0.35, action: "accept" })),
      ...Array.from({ length: 8 }, () => ({ question: "show", choice: 0.9, confidence: 0.9, action: "fix" })),
    ];
    const r = calibrationReport({ ...empty, s1_feedback: fb });
    expect(r.sorting.feedback.show.kept[3]).toBe(2);
    expect(r.sorting.feedback.show.dropped[3]).toBe(10);
    expect(r.sorting.feedback.show.kept[9]).toBe(8);
    const s = r.suggestions.find((x) => x.threshold === "sorting.quiet")!;
    expect(s.suggested).toBe(0.4);
    expect(s.reason).toContain("2 of 12");
  });
  it("never suggests lowering the file line, because cards under it are never shown", () => {
    const r = calibrationReport({ ...empty, s1_feedback: Array.from({ length: 25 }, () => ({ question: "project", choice: "p1", confidence: 0.9, action: "keep_file" })) });
    const s = r.suggestions.find((x) => x.threshold === "sorting.file")!;
    expect(s.suggested).toBeNull();
    expect(s.reason).toContain("never shown");
  });
  it("counts pushes by client and level, judged and dense shares, and names older rows as gaps instead of throwing", () => {
    const log: RecallLogRow[] = [
      row({ client: "claude-code", level: "full", candidates: 5, hits: 3 }),
      row({ client: "claude-code", level: "pointer", candidates: 2, hits: 1, judged: true, judge: { owner_world: 0.42, general: 0.5, answered: "partial" } }),
      row({ client: "codex", level: "none", candidates: 12, hits: 0, judged: true }),
      row({ client: "codex", level: "none", candidates: 1, hits: 0, dense: true, dense_top: 0.47 }),
      row({ client: "codex", level: "none", candidates: 0, hits: 0, dense: true }),
    ];
    const r = calibrationReport({ ...empty, recall_log: log, embedded: [{ model: "ollama:bge-m3:none", rows: 40 }] });
    expect(r.recall.pushes).toBe(5);
    expect(r.recall.by_client["claude-code"]).toEqual({ full: 1, pointer: 1, none: 0 });
    expect(r.recall.by_client.codex).toEqual({ full: 0, pointer: 0, none: 3 });
    expect(r.recall.candidates).toEqual({ "0": 1, "1-3": 2, "4-10": 1, "11+": 1 });
    expect(r.recall.judged).toBe(2);
    expect(r.recall.judge_answered).toEqual({ partial: 1 });
    expect(r.recall.judge_owner_world.n).toBe(1);
    expect(r.recall.dense).toBe(2);
    expect(r.recall.dense_top.n).toBe(1);
    expect(r.recall.dense_near_floor).toBe(1);
    expect(r.recall.embedded).toEqual([{ model: "ollama:bge-m3:none", rows: 40 }]);
    expect(r.gaps.some((g) => g.includes("1 judged push"))).toBe(true);
    expect(r.gaps.some((g) => g.includes("1 push") && g.includes("Better search"))).toBe(true);
  });
  it("skips malformed sorting rows instead of throwing", () => {
    const r = calibrationReport({
      ...empty,
      s1_answers: [{ answers: [] }, { answers: [{ id: "show", type: "noul", probability: "x" as unknown as number }] }, { answers: undefined as unknown as never }],
      s1_feedback: [{ question: "show", choice: 0.5, confidence: "0.5" as unknown as number, action: "accept" }],
    });
    expect(r.sorting.answers).toBe(3);
    expect(r.sorting.noul.show.n).toBe(0);
    expect(r.sorting.feedback.show).toBeUndefined();
  });
  it("renders plain text that states it changes nothing, lists every threshold, and ends every suggestion the same way", () => {
    const text = renderCalibration(calibrationReport(empty));
    expect(text).toContain("This report only reads your brain. It changes nothing and sends nothing.");
    for (const t of THRESHOLDS) expect(text).toContain(`${t.id} = ${t.value}`);
    const suggestionLines = text.split("\n").filter((l) => l.startsWith("- recall.") || l.startsWith("- sorting."));
    expect(suggestionLines.length).toBeGreaterThan(0);
    for (const l of suggestionLines) expect(l.endsWith("Nothing changes unless you edit the code.")).toBe(true);
    expect(text).not.toMatch(/model|mcp|token/iu);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/integration/calibration-report.test.ts`
Expected: FAIL: cannot find module `../../packages/domain/calibration.ts`.

- [ ] **Step 3: Write the module**

Create `packages/domain/calibration.ts`:

```ts
/**
 * The calibration registry and report. Pure: rows in, counts and suggestions out. Nothing here opens a database,
 * prints, sends, or changes a threshold. The values are imported from the modules that own them, so the table cannot
 * drift. `scripts/calibrate.ts` feeds it the owner's rows from a read-only handle; the tests feed it synthetic rows.
 * It never sees note text: callers pass answers, feedback numbers and log rows only.
 */
import { S1_THRESHOLDS } from "./system-one.ts";
import { PUSH_THRESHOLDS, type PushLevel } from "./recall-push.ts";
import { JUDGE_THRESHOLDS } from "./recall-judge.ts";
import { DENSE_FLOORS, DENSE_WEIGHT } from "./better-search.ts";
import { DURABLE_HIGH, DURABLE_LOW, TOPIC_MIN_CONFIDENCE } from "../storage/recall-index.ts";

export type Threshold = { id: string; value: number; where: string; meaning: string };
/** Every tunable line, read from the module that owns it. Ids are stable: the report, its docs and its tests name them. */
export const THRESHOLDS: readonly Threshold[] = [
  { id: "sorting.file", value: S1_THRESHOLDS.file, where: "packages/domain/system-one.ts S1_THRESHOLDS.file", meaning: 'A "File in …?" card needs at least this project confidence.' },
  { id: "sorting.review", value: S1_THRESHOLDS.review, where: "packages/domain/system-one.ts S1_THRESHOLDS.review", meaning: "A review is queued for a project with an active goal at or above this." },
  { id: "sorting.quiet", value: S1_THRESHOLDS.quiet, where: "packages/domain/system-one.ts S1_THRESHOLDS.quiet", meaning: "A card is quiet (ranks last, never hidden) below this show probability." },
  { id: "sorting.changes", value: S1_THRESHOLDS.changes, where: "packages/domain/system-one.ts S1_THRESHOLDS.changes", meaning: "A note counts as changing a recorded fact at or above this." },
  { id: "recall.durable_low", value: DURABLE_LOW, where: "packages/storage/recall-index.ts DURABLE_LOW", meaning: "An original's passages rank ×0.9 in recall below this durable probability." },
  { id: "recall.durable_high", value: DURABLE_HIGH, where: "packages/storage/recall-index.ts DURABLE_HIGH", meaning: "An original's passages rank ×1.15 at or above this durable probability." },
  { id: "recall.topic_min_confidence", value: TOPIC_MIN_CONFIDENCE, where: "packages/storage/recall-index.ts TOPIC_MIN_CONFIDENCE", meaning: "A topic name joins a passage's prefix at or above this confidence." },
  { id: "push.owner_world_full", value: PUSH_THRESHOLDS.owner_world_full, where: "packages/domain/recall-push.ts PUSH_THRESHOLDS.owner_world_full", meaning: "A judged push is full at or above this owner-world probability, when answered and one candidate is relevant." },
  { id: "push.owner_world_pointer", value: PUSH_THRESHOLDS.owner_world_pointer, where: "packages/domain/recall-push.ts PUSH_THRESHOLDS.owner_world_pointer", meaning: "A judged push is at least a pointer at or above this owner-world probability." },
  { id: "push.general_none", value: PUSH_THRESHOLDS.general_none, where: "packages/domain/recall-push.ts PUSH_THRESHOLDS.general_none", meaning: "A judged push is none at or above this general probability, unless an exact name matched." },
  { id: "push.rel_relevant", value: PUSH_THRESHOLDS.rel_relevant, where: "packages/domain/recall-push.ts PUSH_THRESHOLDS.rel_relevant", meaning: "A candidate counts as relevant for a full push at or above this." },
  { id: "judge.rel_keep", value: JUDGE_THRESHOLDS.rel_keep, where: "packages/domain/recall-judge.ts JUDGE_THRESHOLDS.rel_keep", meaning: "A judged candidate below this moves to near misses (exact names stay)." },
  { id: "judge.rel_relevant", value: JUDGE_THRESHOLDS.rel_relevant, where: "packages/domain/recall-judge.ts JUDGE_THRESHOLDS.rel_relevant", meaning: "A judged candidate at or above this counts as relevant." },
  { id: "judge.answered_margin", value: JUDGE_THRESHOLDS.answered_margin, where: "packages/domain/recall-judge.ts JUDGE_THRESHOLDS.answered_margin", meaning: "A judged result is found only when answered leads the next choice by this margin." },
  { id: "search.dense_weight", value: DENSE_WEIGHT, where: "packages/domain/better-search.ts DENSE_WEIGHT", meaning: "The weight of the meaning list in reciprocal-rank fusion (the word lists weigh 1)." },
  { id: "search.dense_floor.bge-m3", value: DENSE_FLOORS["bge-m3"], where: "packages/domain/better-search.ts DENSE_FLOORS", meaning: "A passage needs at least this cosine to be a meaning candidate for bge-m3." },
];

/** Suggestions need at least this many answers or feedback rows per question (ruling R5). */
export const MIN_SAMPLE = 20;
export const BINS = 10;
const HOLD = "Nothing changes unless you edit the code.";

export type RecallLogRow = {
  at: string;
  grant_id: string;
  client: string;
  level: PushLevel;
  candidates: number;
  hits: number;
  latency_ms: number;
  judged: boolean;
  dense?: boolean;
  dense_top?: number;
  judge?: { owner_world: number; general: number; answered: "answered" | "partial" | "none" };
};
export type S1Answer = { id: string; type: "choice"; choice: string; confidence: number } | { id: string; type: "noul"; probability: number };
export type S1AnswerRow = { answers: S1Answer[] };
export type S1FeedbackRow = { question: string; choice: string | number; confidence: number; action: string };
export type CalibrationInput = { recall_log: RecallLogRow[]; s1_answers: S1AnswerRow[]; s1_feedback: S1FeedbackRow[]; embedded: { model: string; rows: number }[] };

export type Histogram = { n: number; bins: number[] };
export type KeptBuckets = { kept: number[]; dropped: number[] };
export type Suggestion = { threshold: string; current: number; suggested: number | null; sample: number; reason: string };
export type CalibrationReport = {
  thresholds: Threshold[];
  sorting: {
    answers: number;
    noul: Record<string, Histogram>;
    kind: Record<string, { n: number; mean_confidence: number }>;
    decisions: { n: number; under_durable_low: number; near_durable_low: number };
    review_near_line: number;
    feedback: Record<string, KeptBuckets>;
  };
  recall: {
    pushes: number;
    by_client: Record<string, Record<PushLevel, number>>;
    candidates: Record<"0" | "1-3" | "4-10" | "11+", number>;
    hits: Record<string, number>;
    judged: number;
    judge_answered: Record<string, number>;
    judge_owner_world: Histogram;
    dense: number;
    dense_top: Histogram;
    dense_near_floor: number;
    embedded: { model: string; rows: number }[];
  };
  suggestions: Suggestion[];
  gaps: string[];
};

const zeros = () => Array.from({ length: BINS }, () => 0);
/** Bin i holds [i/10, (i+1)/10); 1.0 falls in the last bin. */
const binOf = (v: number) => Math.min(BINS - 1, Math.max(0, Math.floor(v * BINS)));
/** The bin whose lower edge is a threshold (0.3 → 3), robust to 0.3 × 10 = 2.9999. */
const bandAbove = (line: number) => Math.min(BINS - 1, Math.max(0, Math.round(line * BINS)));
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const value = (id: string) => THRESHOLDS.find((t) => t.id === id)!.value;
const KEPT = new Set(["accept", "fix", "keep_file"]);
const DROPPED = new Set(["dismiss", "reject", "dismiss_file"]);

/** Ten bins over [0, 1]; non-finite values are skipped and not counted. */
export function histogram(values: number[]): Histogram {
  const bins = zeros();
  let n = 0;
  for (const v of values) {
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    bins[binOf(v)]++;
    n++;
  }
  return { n, bins };
}

const answersOf = (r: S1AnswerRow): S1Answer[] => (Array.isArray(r?.answers) ? r.answers : []);
const noul = (a: S1Answer[], id: string): number | null => {
  const x = a.find((q) => q?.id === id);
  return x?.type === "noul" && typeof x.probability === "number" && Number.isFinite(x.probability) ? x.probability : null;
};
const choice = (a: S1Answer[], id: string) => {
  const x = a.find((q) => q?.id === id);
  return x?.type === "choice" && typeof x.choice === "string" ? x : null;
};

function durableSuggestion(decisionDurables: number[], low: number): Suggestion {
  const threshold = "recall.durable_low";
  const sample = decisionDurables.length;
  if (sample < MIN_SAMPLE) return { threshold, current: low, suggested: null, sample, reason: `Not enough data yet (${sample} of ${MIN_SAMPLE} decisions with a durable answer).` };
  const under = decisionDurables.filter((d) => d < low).length;
  if (under * 4 < sample) return { threshold, current: low, suggested: null, sample, reason: `${under} of ${sample} decisions scored under ${low}; fewer than a quarter, so the line holds.` };
  const sorted = [...decisionDurables].sort((a, b) => a - b);
  const p10 = sorted[Math.min(sorted.length - 1, Math.floor(0.1 * sorted.length))];
  const suggested = Number(Math.max(0.1, Math.floor(p10 / 0.05) * 0.05).toFixed(2));
  return { threshold, current: low, suggested, sample, reason: `${under} of ${sample} decisions scored under ${low}, and a decision should count as lasting. The 10th percentile of decision durables, rounded down to 0.05, is ${suggested}.` };
}

function quietSuggestion(fb: KeptBuckets | undefined, quiet: number): Suggestion {
  const threshold = "sorting.quiet";
  const sample = fb ? sum(fb.kept) + sum(fb.dropped) : 0;
  if (!fb || sample < MIN_SAMPLE) return { threshold, current: quiet, suggested: null, sample, reason: `Not enough data yet (${sample} of ${MIN_SAMPLE} reviewed show answers).` };
  const above = bandAbove(quiet);
  const aboveN = fb.kept[above] + fb.dropped[above];
  const hi = Number((quiet + 0.1).toFixed(2));
  const lo = Number((quiet - 0.1).toFixed(2));
  if (aboveN >= 5 && fb.kept[above] * 4 < aboveN) return { threshold, current: quiet, suggested: hi, sample, reason: `Only ${fb.kept[above]} of ${aboveN} cards with show in [${quiet}, ${hi}) were kept; raising the quiet line to ${hi} would rank them last too.` };
  const below = above - 1;
  const belowN = below >= 0 ? fb.kept[below] + fb.dropped[below] : 0;
  if (below >= 0 && belowN >= 5 && fb.kept[below] * 2 >= belowN) return { threshold, current: quiet, suggested: lo, sample, reason: `${fb.kept[below]} of ${belowN} quiet cards with show in [${lo}, ${quiet}) were kept; lowering the line to ${lo} would show them in order.` };
  return { threshold, current: quiet, suggested: null, sample, reason: `Kept and dropped cards around ${quiet} do not point one way, so the line holds.` };
}

function fileSuggestion(fb: KeptBuckets | undefined, file: number): Suggestion {
  const threshold = "sorting.file";
  const sample = fb ? sum(fb.kept) + sum(fb.dropped) : 0;
  const note = `Cards under ${file} are never shown, so no evidence for lowering the line can appear here.`;
  if (!fb || sample < MIN_SAMPLE) return { threshold, current: file, suggested: null, sample, reason: `Not enough data yet (${sample} of ${MIN_SAMPLE} answered File in cards). ${note}` };
  const above = bandAbove(file);
  const aboveN = fb.kept[above] + fb.dropped[above];
  const hi = Number((file + 0.1).toFixed(2));
  if (aboveN >= 5 && fb.kept[above] * 2 < aboveN) return { threshold, current: file, suggested: hi, sample, reason: `Only ${fb.kept[above]} of ${aboveN} File in cards with confidence in [${file}, ${hi}) were kept; raising the line to ${hi} would skip most of them. ${note}` };
  return { threshold, current: file, suggested: null, sample, reason: `${sum(fb.kept)} of ${sample} File in cards were kept; the line holds. ${note}` };
}

export function calibrationReport(input: CalibrationInput): CalibrationReport {
  const gaps: string[] = [];
  // Sorting help: one answer per sorted note version; every number is a probability or a confidence, never a word.
  const answers = input.s1_answers.map(answersOf);
  const nouls: Record<string, Histogram> = {};
  for (const q of ["show", "review", "changes_fact", "durable"]) nouls[q] = histogram(answers.map((a) => noul(a, q)).filter((v): v is number => v !== null));
  const kind: Record<string, { n: number; mean_confidence: number }> = {};
  const decisionDurables: number[] = [];
  for (const a of answers) {
    const k = choice(a, "kind");
    if (!k) continue;
    const slot = (kind[k.choice] ??= { n: 0, mean_confidence: 0 });
    const c = typeof k.confidence === "number" && Number.isFinite(k.confidence) ? k.confidence : 0;
    slot.mean_confidence = (slot.mean_confidence * slot.n + c) / (slot.n + 1);
    slot.n++;
    const d = noul(a, "durable");
    if (k.choice === "decision" && d !== null) decisionDurables.push(d);
  }
  for (const k of Object.values(kind)) k.mean_confidence = Number(k.mean_confidence.toFixed(3));
  const low = value("recall.durable_low");
  const decisions = {
    n: decisionDurables.length,
    under_durable_low: decisionDurables.filter((d) => d < low).length,
    near_durable_low: decisionDurables.filter((d) => d >= low && d < low + 0.05).length,
  };
  const reviewLine = value("sorting.review");
  const review_near_line = answers.map((a) => noul(a, "review")).filter((v): v is number => v !== null && v >= reviewLine - 0.1 && v < reviewLine).length;
  const feedback: Record<string, KeptBuckets> = {};
  for (const f of input.s1_feedback) {
    if (typeof f?.question !== "string" || typeof f.confidence !== "number" || !Number.isFinite(f.confidence)) continue;
    if (!KEPT.has(f.action) && !DROPPED.has(f.action)) continue;
    const slot = (feedback[f.question] ??= { kept: zeros(), dropped: zeros() });
    (KEPT.has(f.action) ? slot.kept : slot.dropped)[binOf(f.confidence)]++;
  }
  const suggestions = [durableSuggestion(decisionDurables, low), quietSuggestion(feedback.show, value("sorting.quiet")), fileSuggestion(feedback.project, value("sorting.file"))];
  gaps.push("No owner action records whether a review wake (sorting.review) was right, so that line has only a distribution.");
  gaps.push("durable and kind answers receive no owner feedback; the report shows their distributions only.");

  // Recall pushes: the content-free log (level, counts, latency, and the judge and meaning fields when those ran).
  const by_client: Record<string, Record<PushLevel, number>> = {};
  const candidates = { "0": 0, "1-3": 0, "4-10": 0, "11+": 0 };
  const hits: Record<string, number> = {};
  const ownerWorld: number[] = [];
  const denseTop: number[] = [];
  const judge_answered: Record<string, number> = {};
  let judged = 0;
  let dense = 0;
  let judgedWithout = 0;
  let denseWithout = 0;
  for (const r of input.recall_log) {
    if (!r || typeof r.client !== "string") continue;
    const c = (by_client[r.client] ??= { full: 0, pointer: 0, none: 0 });
    if (r.level === "full" || r.level === "pointer" || r.level === "none") c[r.level]++;
    const n = typeof r.candidates === "number" ? r.candidates : 0;
    candidates[n <= 0 ? "0" : n <= 3 ? "1-3" : n <= 10 ? "4-10" : "11+"]++;
    hits[String(typeof r.hits === "number" ? r.hits : 0)] = (hits[String(typeof r.hits === "number" ? r.hits : 0)] ?? 0) + 1;
    if (r.judged) {
      judged++;
      if (r.judge && typeof r.judge.owner_world === "number") {
        ownerWorld.push(r.judge.owner_world);
        judge_answered[r.judge.answered] = (judge_answered[r.judge.answered] ?? 0) + 1;
      } else judgedWithout++;
    }
    if (r.dense) {
      dense++;
      if (typeof r.dense_top === "number") denseTop.push(r.dense_top);
      else denseWithout++;
    }
  }
  const floor = value("search.dense_floor.bge-m3");
  const dense_near_floor = denseTop.filter((v) => v >= floor && v < floor + 0.05).length;
  if (judgedWithout) gaps.push(`${judgedWithout} judged push${judgedWithout === 1 ? "" : "es"} carr${judgedWithout === 1 ? "ies" : "y"} no judge answers (recorded before this version); counted under judged only.`);
  if (denseWithout) gaps.push(`${denseWithout} push${denseWithout === 1 ? "" : "es"} used Better search with no passage over the floor, or before the top cosine was recorded; counted under dense only.`);
  gaps.push("The cosine floor hides every passage under it, so this report sees only what passed. npm run proof:search prints the room around the floor.");
  gaps.push("The recall log keeps the last 2,000 pushes. Your own searches (Ask, Your brain) are never logged.");

  return {
    thresholds: [...THRESHOLDS],
    sorting: { answers: input.s1_answers.length, noul: nouls, kind, decisions, review_near_line, feedback },
    recall: { pushes: input.recall_log.length, by_client, candidates, hits, judged, judge_answered, judge_owner_world: histogram(ownerWorld), dense, dense_top: histogram(denseTop), dense_near_floor, embedded: input.embedded },
    suggestions,
    gaps,
  };
}

const bar = (n: number, max: number) => "#".repeat(max > 0 ? Math.round((n / max) * 30) : 0);
function renderHistogram(label: string, h: Histogram): string[] {
  if (h.n === 0) return [`${label}: no data yet`];
  const max = Math.max(...h.bins);
  return [`${label} (n = ${h.n})`, ...h.bins.map((n, i) => `  ${(i / BINS).toFixed(1)}–${((i + 1) / BINS).toFixed(1)} | ${bar(n, max).padEnd(30)} ${n}`)];
}
function renderBuckets(label: string, b: KeptBuckets): string[] {
  const n = sum(b.kept) + sum(b.dropped);
  if (n === 0) return [`${label}: no reviewed cards yet`];
  return [`${label}: kept / dropped by confidence (n = ${n})`, ...b.kept.map((k, i) => `  ${(i / BINS).toFixed(1)}–${((i + 1) / BINS).toFixed(1)} | kept ${k}, dropped ${b.dropped[i]}`)];
}

/** Plain text for the terminal. Counts and numbers only; no note text can reach this function. */
export function renderCalibration(r: CalibrationReport): string {
  const lines: string[] = [];
  lines.push("BiBrain calibration report");
  lines.push("This report only reads your brain. It changes nothing and sends nothing.");
  lines.push("");
  lines.push("Current thresholds");
  for (const t of r.thresholds) lines.push(`  ${t.id} = ${t.value}  (${t.where})`, `      ${t.meaning}`);
  lines.push("", `Sorting help: ${r.sorting.answers} sorted notes`);
  for (const [q, h] of Object.entries(r.sorting.noul)) lines.push(...renderHistogram(`  ${q}`, h));
  const kinds = Object.entries(r.sorting.kind);
  lines.push(kinds.length ? `  kind: ${kinds.map(([k, v]) => `${k} ${v.n} (mean confidence ${v.mean_confidence})`).join(", ")}` : "  kind: no data yet");
  lines.push(`  decisions: ${r.sorting.decisions.n}; under recall.durable_low: ${r.sorting.decisions.under_durable_low}; within 0.05 above it: ${r.sorting.decisions.near_durable_low}`);
  lines.push(`  review answers within 0.1 under sorting.review: ${r.sorting.review_near_line}`);
  for (const [q, b] of Object.entries(r.sorting.feedback)) lines.push(...renderBuckets(`  ${q}`, b));
  lines.push("", `Recall pushes: ${r.recall.pushes} (the last 2,000 at most)`);
  for (const [client, levels] of Object.entries(r.recall.by_client)) lines.push(`  ${client}: full ${levels.full}, pointer ${levels.pointer}, none ${levels.none}`);
  lines.push(`  candidates: 0 → ${r.recall.candidates["0"]}, 1–3 → ${r.recall.candidates["1-3"]}, 4–10 → ${r.recall.candidates["4-10"]}, 11+ → ${r.recall.candidates["11+"]}`);
  lines.push(`  hits: ${Object.entries(r.recall.hits).sort(([a], [b]) => Number(a) - Number(b)).map(([k, v]) => `${k} → ${v}`).join(", ") || "no data yet"}`);
  lines.push(`  judged: ${r.recall.judged}; answered: ${Object.entries(r.recall.judge_answered).map(([k, v]) => `${k} ${v}`).join(", ") || "no data yet"}`);
  lines.push(...renderHistogram("  judge owner-world probability", r.recall.judge_owner_world));
  lines.push(`  with Better search: ${r.recall.dense}; near the floor (within 0.05 above it): ${r.recall.dense_near_floor}`);
  lines.push(...renderHistogram("  top cosine per push", r.recall.dense_top));
  lines.push(r.recall.embedded.length ? `  embedded passages: ${r.recall.embedded.map((e) => `${e.rows} (${e.model})`).join(", ")}` : "  embedded passages: none");
  lines.push("", "Suggestions (each is a suggestion only)");
  for (const s of r.suggestions) lines.push(`- ${s.threshold} = ${s.current}: ${s.suggested === null ? "hold." : `consider ${s.suggested}.`} ${s.reason} ${HOLD}`);
  lines.push("", "What this report cannot see");
  for (const g of r.gaps) lines.push(`- ${g}`);
  return lines.join("\n");
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/integration/calibration-report.test.ts`
Expected: PASS. If the render test's `not.toMatch(/model|mcp|token/iu)` fails, the word is in a `meaning` or `where` string: reword it (the `where` strings name files, none of which contain those words).

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/domain/calibration.ts tests/integration/calibration-report.test.ts
git commit -m "feat(calibration): threshold registry and a pure report over sorting answers and the recall log

One documented table imports every tunable line from the module that owns it,
so nothing is copied by hand. calibrationReport turns s1 answers, feedback
rows and recall-log rows into counts, histograms and deterministic suggestions
that need at least 20 samples; renderCalibration prints plain text that states
it changes nothing. Older rows and malformed answers are counted or skipped,
never thrown on.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Two content-free calibration fields in the recall log (Sonnet)

**Files:**
- Modify: `packages/domain/service.ts:3556-3608` (`recallPush` and its `finish`), `:3641-3644` (`recallLog` type), `:3843` and `:3907` (`recallInternal` returns)
- Modify: `tests/integration/recall-dense.test.ts:241`
- Modify: `tests/integration/recall-judge.test.ts:183`
- Modify: `tests/integration/recall-push.test.ts:152`

**Interfaces:**
- Consumes: `JudgeSignals` (already imported as a type at service.ts:102), `lists.dense` inside `recallInternal` (`RecallMatch[]`, `score` is the cosine).
- Produces: `recallInternal(...)` return gains `denseTop: number | null`; recall-log rows gain `dense_top?: number` (only when `dense` is true and a candidate passed the floor) and `judge?: { owner_world: number; general: number; answered: "answered" | "partial" | "none" }` (only when `judged` is true). These are the shapes `RecallLogRow` in Task 4 declares.

- [ ] **Step 1: Write the failing tests**

In `tests/integration/recall-dense.test.ts`, replace line 241

```ts
    expect(j.brain.recallLog(owner).rows.at(-1)).toMatchObject({ level: "none", judged: false, dense: true });
```

with

```ts
    const logged = j.brain.recallLog(owner).rows.at(-1)!;
    expect(logged).toMatchObject({ level: "none", judged: false, dense: true });
    // The highest cosine among the meaning candidates is kept for calibration; it is a number, never text.
    expect(logged.dense_top).toBeGreaterThanOrEqual(0.45);
    expect(logged.dense_top).toBeLessThanOrEqual(1);
    expect(logged).not.toHaveProperty("judge");
```

In `tests/integration/recall-judge.test.ts`, replace line 183

```ts
    expect(t.brain.recallLog(owner).rows.at(-1)).toMatchObject({ judged: true, level: "pointer" });
```

with

```ts
    const logged = t.brain.recallLog(owner).rows.at(-1)!;
    expect(logged).toMatchObject({ judged: true, level: "pointer", judge: { answered: "none" } });
    // The judge's three numbers ride along for calibration; the owner-world probability here is the fake's 0.1.
    expect(logged.judge!.owner_world).toBeLessThan(0.35);
    expect(typeof logged.judge!.general).toBe("number");
    expect(JSON.stringify(logged)).not.toContain("Northstar");
```

In `tests/integration/recall-push.test.ts`, after line 152 (`expect(typeof log.rows[0].latency_ms).toBe("number");`) add:

```ts
    // With Better search and Recall help off the row is plan 5's, field for field (the dense-off snapshot pins this too).
    expect(log.rows[0]).not.toHaveProperty("dense");
    expect(log.rows[0]).not.toHaveProperty("dense_top");
    expect(log.rows[0]).not.toHaveProperty("judge");
```

- [ ] **Step 2: Run them to see the new assertions fail**

Run: `npx vitest run tests/integration/recall-dense.test.ts tests/integration/recall-judge.test.ts tests/integration/recall-push.test.ts`
Expected: the dense `dense_top` assertion and the judge `judge` assertion FAIL (`undefined`); the push test PASSES (nothing added yet).

- [ ] **Step 3: Return the top cosine from `recallInternal`**

In `packages/domain/service.ts` line 3843 (the early return when `!fts.match`), add `denseTop: null as number | null` so it reads:

```ts
    if (!fts.match) return { result: empty("no_match", 0), ranked: [] as Candidate[], authorized: [] as RecallHit[], signals: deterministicSignals([], [], entityNames), entityNames, scope, dense: false, denseOnly: new Set<string>(), denseTop: null as number | null };
```

At line 3907 replace the return with:

```ts
    // The highest cosine among the meaning candidates, three decimals, for the content-free recall log; null when none passed the floor.
    const denseTop = lists.dense!.length ? Number(Math.max(...lists.dense!.map((r) => r.score)).toFixed(3)) : null;
    return { result, ranked, authorized: authorized.map((a) => a.hit), signals, entityNames, scope, dense: dense !== null, denseOnly, denseTop };
```

- [ ] **Step 4: Write the two fields in `recallPush`**

Replace the `finish` helper (service.ts:3560-3568) with:

```ts
    const finish = (out: typeof quiet, extra: { candidates: number; judged: boolean; dense: boolean; dense_top?: number | null; judge?: JudgeSignals | null }) => {
      // A push that reached the brain proves the connection works, exactly like /agent/verify.
      // `dense`, `dense_top` and `judge` are written only when that feature ran, so with Better search and Recall help off
      // the row is plan 5's, field for field (the dense-off snapshot pins this). Every value is a number or a level, never text.
      this.store.run("UPDATE grants SET last_verified_at=? WHERE id=?", this.now(), p.grant_id);
      const round3 = (n: number) => Number(n.toFixed(3));
      const log = this.store.setting<unknown[]>("recall_log", []);
      log.push({
        at: this.now(), grant_id: p.grant_id, client: v.client, level: out.level, candidates: extra.candidates, hits: out.hit_ids.length, latency_ms: Date.now() - started, judged: extra.judged,
        ...(extra.dense ? { dense: true, ...(typeof extra.dense_top === "number" ? { dense_top: extra.dense_top } : {}) } : {}),
        ...(extra.judged && extra.judge ? { judge: { owner_world: round3(extra.judge.ownerWorld), general: round3(extra.judge.general), answered: extra.judge.answered } } : {}),
      });
      this.store.set("recall_log", log.slice(-RECALL_LOG_MAX));
      return out;
    };
```

Then change the two `finish(...)` calls at the end of `recallPush` (lines 3607–3608) to pass the new values:

```ts
    if (text && detectSecrets(text).length) return finish(quiet, { candidates, judged: judge.judged, dense: internal.dense, dense_top: internal.denseTop, judge: judge.signals });
    return finish({ level, text, hit_ids: used.map((h) => h.id), digest }, { candidates, judged: judge.judged, dense: internal.dense, dense_top: internal.denseTop, judge: judge.signals });
```

The early secret return (`return finish(quiet, { candidates: 0, judged: false, dense: false });`) stays as it is.

- [ ] **Step 5: Widen the `recallLog` row type**

Replace the `recallLog` method (service.ts:3641-3644) with:

```ts
  /** What was pushed to agents and when: levels, counts and latency, plus the judge's answers and the top cosine when those ran. Never a prompt, an id or a passage. */
  recallLog(p: Principal) {
    this.owner(p);
    return {
      rows: this.store.setting<{ at: string; grant_id: string; client: string; level: PushLevel; candidates: number; hits: number; latency_ms: number; judged: boolean; dense?: boolean; dense_top?: number; judge?: { owner_world: number; general: number; answered: "answered" | "partial" | "none" } }[]>("recall_log", []),
    };
  }
```

- [ ] **Step 6: Run the recall tests, including the dense-off snapshot**

Run: `npx vitest run tests/integration/recall-dense.test.ts tests/integration/recall-judge.test.ts tests/integration/recall-push.test.ts tests/integration/agent-recall-http.test.ts tests/eval`
Expected: all PASS, including "with Better search off, recall and the hook push equal the committed plan 5 snapshot byte for byte". If the snapshot test fails, a field leaked into an off row: fix the conditionals; do not regenerate the snapshot.

- [ ] **Step 7: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add packages/domain/service.ts tests/integration/recall-dense.test.ts tests/integration/recall-judge.test.ts tests/integration/recall-push.test.ts
git commit -m "feat(recall): log the top cosine and the judge's answers per push, only when they ran

The content-free recall log gains dense_top (highest cosine among meaning
candidates) when a vector was used and judge {owner_world, general, answered}
when a push was judged, so the floor and the judge bands can be read from real
use. Rows with Better search and Recall help off are unchanged; the plan 5
dense-off snapshot still matches byte for byte (ruling R6).

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: `npm run calibrate`: the owner-run report script (Sonnet)

**Files:**
- Create: `scripts/calibrate.ts`
- Modify: `package.json` (one script line, after `"proof:search"`)
- Modify: `tests/integration/calibration-report.test.ts` (append the script half)

**Interfaces:**
- Consumes: `calibrationReport`, `renderCalibration`, `CalibrationInput` from `packages/domain/calibration.ts` (Task 4); `node:sqlite` `DatabaseSync(path, { readOnly: true })`.
- Produces: the command `npm run calibrate [-- --db <path>] [--json]`; exit 0 after a report, 2 when the database is missing, cannot be opened, or is from a newer BiBrain.

- [ ] **Step 1: Write the failing script tests**

Append to `tests/integration/calibration-report.test.ts` (add the imports at the top of the file):

```ts
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach } from "vitest";
import { Storage } from "../../packages/storage/index.ts";
import { Brain } from "../../packages/domain/service.ts";
import type { Principal } from "../../packages/contracts/index.ts";
import type { AskResult } from "../../packages/providers/system-one-ask.ts";
```

and at the end of the file:

```ts
const owner: Principal = { kind: "owner" };
const CANARY = "ZIRCON_SENTINEL";
let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.reverse()) fn();
  cleanup = [];
});
const ask = (over: { kind?: string; durable?: number; show?: number; review?: number }): AskResult => ({
  model: "clef-flash", usage: { input_tokens: 300, output_tokens: 0 }, cost_micro_usd: 27, price_version: "cf-clef-flash-2026-10-01", policy_version: "system-one-ask-v1",
  answers: [
    { id: "kind", type: "choice", choice: over.kind ?? "note", confidence: 0.9, probabilities: { decision: 0.025, fact: 0.025, question: 0.025, task: 0.025, note: 0.9 } },
    { id: "review", type: "noul", probability: over.review ?? 0.1 },
    { id: "show", type: "noul", probability: over.show ?? 0.9 },
    { id: "durable", type: "noul", probability: over.durable ?? 0.5 },
  ],
});
/** A synthetic brain written through the real paths: three sorted notes (one a decision at durable 0.23, one quiet), one kept and one dismissed review, and six recall-log rows. */
function syntheticBrain(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "calibrate-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "brain.sqlite");
  const s = new Storage(path, { vault: join(dir, "vault") });
  const b = new Brain(s, () => new Date("2026-11-01T09:00:00Z"), undefined, undefined, undefined, undefined, () => ({ ready: true, reason: "test" }));
  b.prefs(owner, { ...b.prefs(owner), enabled: true, decision_provider_enabled: true, daily_cap_micro_usd: 50_000, per_job_cap_micro_usd: 5_000 });
  const p = b.createProject(owner, "Northstar");
  const note = (title: string, body: string) => b.capture(owner, { project_id: p.id, title, body, visibility: "project", separate: true }) as any;
  const decision = note("Plan", `We decided Northstar ships with one plan ${CANARY}.`);
  b.recordSystemOneResult({ id: "j1", project_id: p.id }, decision.source_id, 1, ask({ kind: "decision", durable: 0.23 }));
  // A status statement, so the capture surely creates a review gate that the dismissal below can log against.
  const lunch = note("Hydra", "Hydra status paused.");
  b.recordSystemOneResult({ id: "j2", project_id: p.id }, lunch.source_id, 1, ask({ kind: "fact", show: 0.2, review: 0.68 }));
  const status = note("Status", "The launch color is amber.");
  b.recordSystemOneResult({ id: "j3", project_id: p.id }, status.source_id, 1, ask({ kind: "fact", show: 0.9 }));
  // One kept review and one dismissed card, so s1_feedback has a kept and a dropped row for `show`.
  const kept = b.entities(owner, "gate").find((g) => g.data.raw_id === status.source_id)!;
  b.reviewGate(owner, kept.id, { action: "accept", expected_version: kept.version });
  const quietGate = b.entities(owner, "gate").find((g) => g.data.raw_id === lunch.source_id)!;
  const quietCard = b.brief(owner).items.find((i) => i.target.id === quietGate.id)!;
  b.dismissBriefItem(owner, { signature: quietCard.signature });
  s.set("recall_log", [
    { at: "2026-11-01T08:00:00.000Z", grant_id: "g1", client: "codex", level: "full", candidates: 5, hits: 3, latency_ms: 2, judged: false },
    { at: "2026-11-01T08:01:00.000Z", grant_id: "g1", client: "codex", level: "none", candidates: 0, hits: 0, latency_ms: 2, judged: false },
    { at: "2026-11-01T08:02:00.000Z", grant_id: "g2", client: "claude-code", level: "pointer", candidates: 2, hits: 1, latency_ms: 3, judged: true, judge: { owner_world: 0.4, general: 0.5, answered: "partial" } },
    { at: "2026-11-01T08:03:00.000Z", grant_id: "g2", client: "claude-code", level: "none", candidates: 3, hits: 0, latency_ms: 3, judged: true },
    { at: "2026-11-01T08:04:00.000Z", grant_id: "g2", client: "claude-code", level: "none", candidates: 1, hits: 0, latency_ms: 4, judged: false, dense: true, dense_top: 0.47 },
    { at: "2026-11-01T08:05:00.000Z", grant_id: "g2", client: "claude-code", level: "none", candidates: 0, hits: 0, latency_ms: 4, judged: false, dense: true },
  ]);
  s.close();
  return { dir, path };
}
const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const run = (args: string[], env: Record<string, string | undefined> = {}) => {
  const e = { ...process.env, ...env };
  delete e.BRAIN_DB;
  for (const [k, v] of Object.entries(env)) if (v !== undefined) e[k] = v;
  return spawnSync(process.execPath, ["--import", "tsx", "scripts/calibrate.ts", ...args], { encoding: "utf8", env: e, timeout: 60_000, windowsHide: true });
};

describe("npm run calibrate", () => {
  it("prints the report from a synthetic brain, never a word of a note, and leaves the file byte-identical", () => {
    const { path } = syntheticBrain();
    const before = sha(path);
    const r = run(["--db", path]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("This report only reads your brain. It changes nothing and sends nothing.");
    expect(r.stdout).toContain("Sorting help: 3 sorted notes");
    expect(r.stdout).toContain("decisions: 1; under recall.durable_low: 0; within 0.05 above it: 1");
    expect(r.stdout).toContain("review answers within 0.1 under sorting.review: 1");
    expect(r.stdout).toContain("show: kept / dropped by confidence (n = 2)");
    expect(r.stdout).toContain("Recall pushes: 6");
    expect(r.stdout).toContain("codex: full 1, pointer 0, none 1");
    expect(r.stdout).toContain("claude-code: full 0, pointer 1, none 3");
    expect(r.stdout).toContain("judged: 2; answered: partial 1");
    expect(r.stdout).toContain("with Better search: 2; near the floor (within 0.05 above it): 1");
    expect(r.stdout).toContain("recall.durable_low = 0.2");
    expect(r.stdout).toContain("Nothing changes unless you edit the code.");
    expect(r.stdout + r.stderr).not.toContain(CANARY);
    expect(r.stdout + r.stderr).not.toContain("Hydra status paused");
    expect(r.stdout + r.stderr).not.toContain("launch color");
    expect(sha(path)).toBe(before);
    expect(existsSync(path + "-journal")).toBe(false);
    const json = run(["--db", path, "--json"]);
    expect(json.status).toBe(0);
    const parsed = JSON.parse(json.stdout);
    expect(parsed.sorting.answers).toBe(3);
    expect(parsed.suggestions.find((s: any) => s.threshold === "recall.durable_low").suggested).toBeNull();
    expect(json.stdout).not.toContain(CANARY);
    expect(sha(path)).toBe(before);
  });
  it("reads the same report while another process holds the brain open in WAL mode, and honours BRAIN_DB", () => {
    const { path, dir } = syntheticBrain();
    const held = new Storage(path, { vault: join(dir, "vault") });
    cleanup.push(() => held.close());
    const r = run([], { BRAIN_DB: path });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Sorting help: 3 sorted notes");
    expect(r.stdout).toContain("Recall pushes: 6");
  });
  it("explains a missing brain and refuses one from a newer BiBrain, both with exit 2", () => {
    const missing = run(["--db", join(tmpdir(), "no-such-folder-" + Date.now(), "brain.sqlite")]);
    expect(missing.status).toBe(2);
    expect(missing.stdout).toContain("No brain found at");
    expect(missing.stdout).toContain("--db");
    const { path, dir } = syntheticBrain();
    const newer = join(dir, "newer.sqlite");
    copyFileSync(path, newer);
    const db = new DatabaseSync(newer);
    db.exec("INSERT INTO migrations VALUES(99,'2099-01-01T00:00:00.000Z')");
    db.close();
    const r = run(["--db", newer]);
    expect(r.status).toBe(2);
    expect(r.stdout).toContain("newer BiBrain");
    expect(existsSync(resolve("data/calibration.json"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/integration/calibration-report.test.ts -t "npm run calibrate"`
Expected: FAIL: `scripts/calibrate.ts` does not exist (non-zero status, stderr "Cannot find module").

- [ ] **Step 3: Write the script**

Create `scripts/calibrate.ts`:

```ts
/**
 * OWNER-RUN calibration report: `npm run calibrate [-- --db <path>] [--json]`.
 *
 * Reads your local brain through a READ-ONLY handle and prints counts, histograms, the current thresholds and
 * suggestions. It changes nothing, writes nothing and sends nothing. It never reads or prints note text: the sorting
 * answers are reduced to their numbers before the report runs, and source_versions is never opened. The database is
 * opened with node:sqlite directly (not through Storage, whose constructor applies migrations), so SQLite enforces
 * read-only. Exit 0 after a report; 2 when the brain is missing, cannot be opened, or is from a newer BiBrain.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { calibrationReport, renderCalibration, type CalibrationInput, type RecallLogRow, type S1AnswerRow, type S1FeedbackRow } from "../packages/domain/calibration.ts";

const args = process.argv.slice(2);
const dbFlag = args.indexOf("--db");
const path = resolve(dbFlag >= 0 && args[dbFlag + 1] ? args[dbFlag + 1] : (process.env.BRAIN_DB ?? "data/brain.sqlite"));
const asJson = args.includes("--json");
/** The schema version this reader understands; the same ceiling Storage applies. */
const KNOWN_MIGRATION = 7;

function main(): number {
  if (!existsSync(path)) {
    console.log(`No brain found at ${path}. Start BiBrain once, or pass --db <path to brain.sqlite>.`);
    return 2;
  }
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch {
    console.log(`Could not open ${path} read-only. If BiBrain is not running, start it once, or copy brain.sqlite elsewhere and pass --db.`);
    return 2;
  }
  try {
    const version = Number((db.prepare("SELECT max(version) AS v FROM migrations").get() as { v?: number } | undefined)?.v ?? 0);
    if (version > KNOWN_MIGRATION) {
      console.log("This brain is from a newer BiBrain. Run the calibration report from that version.");
      return 2;
    }
    const table = (name: string) => !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
    const setting = <T>(key: string, fallback: T): T => {
      const row = db.prepare("SELECT value FROM settings WHERE key=?").get(key) as { value: string } | undefined;
      return row ? (JSON.parse(row.value) as T) : fallback;
    };
    const entities = (kind: string): any[] => (db.prepare("SELECT data FROM entities WHERE kind=? ORDER BY created_at, rowid").all(kind) as { data: string }[]).map((r) => JSON.parse(r.data));
    // Only numbers and ids leave this block: no source id, no job id, no words.
    const s1_answers: S1AnswerRow[] = entities("s1_answer").map((a) => ({ answers: Array.isArray(a?.answers) ? a.answers : [] }));
    const s1_feedback: S1FeedbackRow[] = entities("s1_feedback").map((f) => ({ question: f?.question, choice: f?.choice, confidence: f?.confidence, action: f?.action }));
    const recall_log = setting<RecallLogRow[]>("recall_log", []);
    const embedded = table("recall_chunks")
      ? (db.prepare("SELECT embedding_model AS model, count(*) AS rows FROM recall_chunks WHERE embedding IS NOT NULL GROUP BY embedding_model").all() as { model: string | null; rows: number }[]).map((e) => ({ model: String(e.model ?? "unknown"), rows: Number(e.rows) }))
      : [];
    const input: CalibrationInput = { recall_log: Array.isArray(recall_log) ? recall_log : [], s1_answers, s1_feedback, embedded };
    const report = calibrationReport(input);
    console.log(asJson ? JSON.stringify(report, null, 2) : renderCalibration(report));
    return 0;
  } finally {
    db.close();
  }
}

// exitCode, not exit(): piped output is flushed before the process ends.
process.exitCode = main();
```

- [ ] **Step 4: Wire the npm script**

In `package.json`, after the line `"proof:search": "node --import tsx scripts/better-search-proof.ts",` add:

```json
    "calibrate": "node --env-file-if-exists=.env --import tsx scripts/calibrate.ts",
```

- [ ] **Step 5: Run the script tests**

Run: `npx vitest run tests/integration/calibration-report.test.ts`
Expected: all PASS. If the WAL test fails with "unable to open database file", the read-only open needs the `-shm` file and the temp directory was not writable for it; that is an environment fault, not a code fault: confirm by reading `r.stderr`, then keep the test and report it in the task summary.

If `dismissBriefItem` logged no `show` row (the `show: kept / dropped` line says `n = 1`), the quiet card is not in the Brief at the moment of the lookup (`quietCard` undefined): print `b.brief(owner).items.map((i) => [i.kind, i.target.id, i.signature])` once in a scratch run to find the card for `quietGate.id`, then use its real signature. Do not weaken the `n = 2` assertion.

- [ ] **Step 6: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: exit 0 (`tsconfig.json` includes `scripts`).

- [ ] **Step 7: Commit**

```bash
git add scripts/calibrate.ts package.json tests/integration/calibration-report.test.ts
git commit -m "feat(calibrate): npm run calibrate prints a read-only calibration report of the owner's brain

Opens brain.sqlite read-only through node:sqlite (never Storage, whose
constructor writes), reduces sorting answers and feedback to numbers, reads
the content-free recall log and embedded-passage counts, and prints the
registry, histograms, suggestions and gaps. Never prints note text. Exit 2
with a plain sentence when the brain is missing, locked or newer. Tested
against a synthetic brain built through the real write paths, closed and
held open, with a canary word and a byte-for-byte file check.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Docs, build state, README and the full gate (Sonnet)

**Files:**
- Modify: `docs/PROVIDERS.md` (new subsection after "### Better search (embeddings, local)", before "### Prepared decision contract…")
- Modify: `docs/NATIVE_CLIENT_SETUP.md:113-135`
- Modify: `docs/superpowers/plans/2026-10-25-recall-followups.md:142-147`
- Modify: `BUILD_STATE.md` (the "At a glance" table and a new plan section)
- Modify: `README.md` (the Status table)

**Interfaces:** none.

- [ ] **Step 1: Document the calibration report for the owner**

In `docs/PROVIDERS.md`, directly before `### Prepared decision contract and default-off managed consumer`, insert (the outer fence here is four backticks only so the inner PowerShell fence survives; copy the content between them):

````markdown
### Calibration report (owner-run)

Sorting help, recall help and Better search each work with a few fixed lines (for example "quiet below 0.3", "file at 0.7 or more", "a meaning match needs a cosine of 0.45"). Most of them are still first guesses. `npm run calibrate` reads your own brain and shows you how your real answers and pushes fall around each line, so you can decide whether a line should move. It never decides for you.

```powershell
npm run calibrate            # reads data/brain.sqlite (or BRAIN_DB)
npm run calibrate -- --json  # the same as JSON
npm run calibrate -- --db C:\path\to\a\copy\brain.sqlite
```

**What it does.** It opens the database read-only, so it cannot change anything; it sends nothing anywhere; and it never reads or prints the words of a note. It prints: every line with its value and the file that holds it; for sorting help, how many notes were sorted and the spread of each answer (show, review, changes, durable), what kinds Clef saw, how many decisions scored under the durable line, and for each reviewed card whether you kept or dropped it, grouped by Clef's confidence; for recall, how many pushes each agent received at each level, how many were judged and how the judge answered, how many used Better search and the spread of their top cosine. It ends with suggestions and with a list of what it cannot see.

**What to do with a suggestion.** A suggestion appears only when at least 20 answers or reviewed cards exist for that question and the rule in `packages/domain/calibration.ts` is met; the line states the counts it rests on. If you agree, change the named constant in the file the report names, run `npx vitest run tests/integration` and `npm run brain-eval` (the golden gates must still pass), add a test that pins the new value on your evidence case, and record the change and its reason in `BUILD_STATE.md`. Nothing changes unless you edit the code. "Not enough data yet" means exactly that: keep using BiBrain and run the report again later.

**What it cannot see.** Nothing records whether a review wake was right, so the review line only gets a spread. `durable` and `kind` get no feedback. Pushes recorded before 2026-11-01 carry no judge answers or top cosine. The cosine floor hides every passage under it, so the report sees only what passed; `npm run proof:search` prints the room around the floor. Your own searches (Ask, Your brain) are never logged.

**The one line that moved so far.** On 2026-11-01 the durable demotion line moved from 0.25 to 0.20, because the one live decision recorded under it (2026-10-27) scored 0.23 and a decision should count as lasting. Every other line keeps its first value until the report shows real evidence.
````

- [ ] **Step 2: Note the Codex trust fix in the native setup doc**

In `docs/NATIVE_CLIENT_SETUP.md`, after the paragraph that ends `only the owner runs it, because it consumes subscription quota.` (line 117) add:

```markdown
Since 2026-11-01 the script runs Codex the way the recall proof does: the disposable
workspace is created in the system temp folder (outside this repository, so Codex does not
take BiBrain itself as the project), the run adds `-c projects.<folder>.trust_level="trusted"`
because `--ignore-user-config` hides the trust a person would normally grant, and
`--dangerously-bypass-hook-trust` stands in for the one-time `/hooks` review. The temp
folder's path must contain no dot; the script says so and stops if it does.
```

- [ ] **Step 3: Update the recall follow-ups' owed list**

In `docs/superpowers/plans/2026-10-25-recall-followups.md`, replace the "Owner-run checks still owed" section (lines 142–146) with:

```markdown
## Owner-run checks still owed

- `scripts/native-client-proof.ts`. Plan 7 (2026-11-01) gave it the Codex trust fix PR #30 gave the recall proof and a refusal test; the run itself is still owed.
- `npm run proof:search` (plan 5b).
- Done: `npm run proof:recall` for both clients, hook on and off (2026-10-27); `npm run proof:sorting` (2026-10-27). Their calibration notes are ruled on in `docs/superpowers/specs/2026-11-01-sweep-calibrate-design.md`: the durable line moved to 0.20; everything else is read from `npm run calibrate`.
```

- [ ] **Step 4: Run the full gate**

Run, in this order, and record each real count:

```bash
npm run typecheck
npm run lint
npm run build
npm audit --audit-level=high
npx vitest run --reporter=dot --maxWorkers=3
npm run brain-eval
npx playwright test --workers=1
git restore docs/screenshots
git status --short
```

Expected: typecheck, lint, build and audit exit 0; Vitest 0 failed (new files: `native-client-proof.test.ts`, `calibration-report.test.ts`; load timeouts in `managed-*` files are re-run alone and reported as such); brain-eval all passed; Playwright 0 failed. If `apps/cli/bibrain.mjs` shows as modified with no content change, `git restore apps/cli/bibrain.mjs`.

- [ ] **Step 5: Record the plan in BUILD_STATE.md**

Update the "At a glance" table rows:

```markdown
| Sorting help (System 1, Clef via Ollama or Cloudflare) | Live call through Ollama Cloud with clef-flash validated 3 of 3 answers (2026-10-27). The durable demotion line moved to 0.20 on that run's evidence (2026-11-01); every other line keeps its first value and is read from `npm run calibrate` |
| Next plans | Owner-run: `npm run calibrate` once the brain has real answers and pushes, `npm run proof:search`, `scripts/native-client-proof.ts`; the next reframe plan is the owner's choice |
```

and change `Updated: 2026-10-28` to `Updated: 2026-11-01`. Then insert, directly after the "At a glance" table and before `## 2026-10-28 — Plan 6`, a section with the real counts from Step 4 in place of the `<...>` markers:

```markdown
## 2026-11-01 — Plan 7: sweep and calibrate (branch reframe/sweep-calibrate)

Spec: `docs/superpowers/specs/2026-11-01-sweep-calibrate-design.md`. Plan: `docs/superpowers/plans/2026-11-01-sweep-calibrate.md`.

- **Sweep.** Every parked item in the six follow-ups files and the Known limits above was classified (10 do, 18 obsolete, the rest kept parked with a reason). Applied: the grants test's Windows path is escaped; the `briefInput` comment is true again; the web `BriefItem` type carries `quiet?`; the watch test compares a real kept fact; `docs/UX.md` describes Today v2's after-save flow, the real no-result copy and "Preview handoff"; `scripts/native-client-proof.ts` runs Codex in a trusted temp workspace outside the repo (the fix PR #30 gave the recall proof) and has a refusal test. The proof was not run.
- **Calibrate.** One ruling on evidence: the durable demotion line (`DURABLE_LOW`) moved from 0.25 to 0.20, because the one live decision recorded under it scored 0.23 (2026-10-27). Tests pin 0.23 → no demotion and 0.19 → ×0.9; the golden set is unchanged. Every other threshold keeps its value: the push bands behaved as intended in four owner runs, and the judge and the embeddings have never been called live.
- **Calibration report.** `npm run calibrate` opens the owner's brain read-only (through `node:sqlite`, never `Storage`), prints every threshold from one registry (`packages/domain/calibration.ts`), histograms of the sorting answers and of kept-versus-dropped cards by confidence, pushes by agent and level, judged and Better search shares, suggestions that need at least 20 samples, and the signals it cannot see. It never prints note text and has no option to. The recall log now also records the top cosine and the judge's answers per push, only when those ran; rows with both off are byte-identical to plan 5 (the committed dense-off snapshot still matches).
- **Gaps the report names.** No owner action records whether a review wake was right; `durable` and `kind` get no feedback; older rows carry no judge or cosine fields; the floor hides what it cuts (use `proof:search`); owner searches are never logged.

Verified in this worktree on 2026-11-01 (Windows, Node 24.19.0):

- `npm run typecheck`, `npm run lint`, `npm run build`: all exit 0.
- `npm audit --audit-level=high`: <n> vulnerabilities.
- `npx vitest run --reporter=dot --maxWorkers=3`: <files> files, <passed> passed, <skipped> skipped, <failed> failed (<seconds> s).
- `npm run brain-eval`: <passed>/<total> passed. The golden set is unchanged.
- `npx playwright test --workers=1`: <passed> passed, <failed> failed (<minutes>). `docs/screenshots` was restored afterwards.

Known limits:

- `npm run calibrate` has been run only against the synthetic test brain. The owner runs it against real data; until the brain holds 20 answers per question every suggestion reads "Not enough data yet".
- The owner-run proofs still owed: `scripts/native-client-proof.ts` (harness fixed here) and `npm run proof:search`.
- Local V1 only; no real model run in this plan.
```

- [ ] **Step 6: Update the README status table**

In `README.md`, replace the Sorting help row of the Status table with:

```markdown
| Sorting help with Clef | One live check through Ollama Cloud validated 3 of 3 answers; one threshold moved on that evidence, and `npm run calibrate` shows how your own answers fall around the rest |
```

and change `This table is the honest state as of 2026-10-28.` to `as of 2026-11-01`.

- [ ] **Step 7: Check the Markdown links you touched**

Run: `grep -n "2026-11-01-sweep-calibrate" BUILD_STATE.md docs/superpowers/plans/2026-10-25-recall-followups.md` and confirm both files named exist with `ls docs/superpowers/specs/2026-11-01-sweep-calibrate-design.md docs/superpowers/plans/2026-11-01-sweep-calibrate.md`.
Expected: the references and the files match.

- [ ] **Step 8: Commit**

```bash
git add docs/PROVIDERS.md docs/NATIVE_CLIENT_SETUP.md docs/superpowers/plans/2026-10-25-recall-followups.md BUILD_STATE.md README.md
git commit -m "docs: calibration report for owners, native proof note, plan 7 build state

Explain npm run calibrate (what it reads, what it prints, what to do with a
suggestion, what it cannot see), note the Codex trust fix in the native setup
doc, update the owed owner-run checks, and record plan 7 with its real
verification counts in BUILD_STATE and the README status.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Self-review notes

- **Spec coverage.** Part A's nine "do" items: Task 1 (seven edits), Task 2 (native proof harness), Part B consumes the calibration notes (Task 3). Part B's table: Task 3 (R1), Task 4 (registry R8, report rules R4, R5), Task 5 (R6, R7), Task 6 (R3, CLI, privacy tests), Task 7 (docs, BUILD_STATE, README). Every ruling R1–R10 is implemented or stated (R2 and R10 are constraints).
- **Placeholders.** None. The BUILD_STATE `<...>` markers are explicitly the real counts from Step 4 of Task 7, which the implementer must fill.
- **Type consistency.** `RecallLogRow`, `S1AnswerRow`, `S1FeedbackRow`, `CalibrationInput` (Task 4) are what Task 6 imports; `dense_top` and `judge` (Task 5) match `RecallLogRow`; `DURABLE_LOW`, `DURABLE_HIGH`, `TOPIC_MIN_CONFIDENCE` (Task 3) are what Task 4 imports; `recallInternal` gains `denseTop`, read by `recallPush` only.
- **Review Focus.** 1 → Task 6 (closed, held-open WAL, missing file); 2 → Task 4 (older rows); 3 → Task 4 (malformed rows); 4 → Task 6 (migration 99 copy); 5 → Task 6 (canary in text and `--json`, sha-256 before and after).
