# Your brain v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current Your brain screen with the reframed one. It has projects on the left, and each project page shows True now, Open questions and Originals. Any fact opens its original with the exact passage highlighted and the fact's history. All of it runs on the real services.

**Architecture:**
- **Pure domain modules** compute what a project page shows:
  - `facts.ts` holds the shared fact wording.
  - `questions.ts` finds open questions in originals, deterministically.
  - `project-view.ts` builds the project page.
  - `brain-search.ts` does substring search over facts and originals.
- **`Brain`** gains five owner-only service methods: `brainProject`, `answerQuestion`, `reviseClaim`, `claimHistory` and `searchBrain`. Each has a thin HTTP route.
- **The web app** mounts a new `apps/web/brain/` module in place of the old Your brain JSX in `apps/web/src.tsx`. It replaces the body of the source dialog with a calmer view that highlights the cited passage.
- **Unchanged:** the worker, the goal pipeline, billing and managed code.

**Tech Stack:** TypeScript (strict), React 19, Fastify 5, SQLite through `packages/storage`, Zod 4, Vitest 5, Playwright 1.63. No new dependencies.

**Spec:** `docs/REFRAME_BRIEF.md`, approved by the owner on 2026-10-23. The Your brain row of its "One calm surface" table says:
> "Projects on the left. Each project shows what is true now, open questions and a timeline of originals. Any fact opens its original with the exact passage highlighted and its history."

The visual and copy reference is `design/reframe/bibrain-reframe-prototype.html`: the `viewBrain`, `projectDetail` and `renderOverlay` drawer code. It holds sample data only; do not copy its data or its simulated behaviour.

## Plan sequence

This is plan 2 of the reframe:

1. Today v2 on real services: shipped, PR #20, merged 2026-10-23.
2. **Your brain v2** (this plan).
3. Plug-and-play Connections: `npx bibrain`, one-step "Add to Codex/Claude Code/Cursor", and agent write-back of session notes.
4. System 1 with **Clef**: typed routing on every capture and write-back, a project suggestion after saving, the **Watch for changes** switch that replaces goals, and a decision log built from Keep, Fix and Dismiss.
5. Memory: keyword plus embedding retrieval, valid-from and replaced-by facts, and a retrieval test set.
6. Cleanup: remove the Paddle code, replace the 283 KB `BUILD_STATE.md` with a one-page status file, rewrite `AGENTS.md`, and add the licence files.

## Rulings made while writing this plan

Each ruling reads: what was decided, why, and what it costs if it is wrong.

1. **Goals stay as they are, moved into a quiet "Goals" section of the project page.**
   - Why: the brief wants "one switch" instead of goal ceremony, but plan 4 owns Watch for changes. The goal job runs through the managed decision and spending path, which is paused. Removing goals now would delete the only working proactive feature.
   - Cost if wrong: one more section on the project page until plan 4.
2. **Reviewing suggestions stays on Today.**
   - Your brain shows "N suggestions wait for your review on Today" with a link.
   - It keeps a small **Needs a decision here** section for what Today cannot show:
     - agent intentions
     - queued items that are not a single named fact
     - the reviewed-correction history with **Undo correction**
   - The rule for what Today can show is the existing Brief rule, exported as `gateFitsBrief`, so both screens agree.
   - Cost if wrong: an owner clearing a large import does it three cards at a time on Today.
3. **Open questions are found deterministically, with exact evidence.** A question is either of these:
   - a line that starts with `Open question:`, `Question:`, `Unclear:` or `Still unclear:`
   - a sentence ending in `?`, in an original that has at most 3 such sentences, so a pasted chat does not flood the list

   No model is involved. "Mark answered" is stored per project, and Undo brings the question back. Cost if wrong: some real questions in long chats are missed until System 1 (plan 4).
4. **A fact is edited as a new version of the same fact.**
   - Only current facts written as a sentence (aspect `statement`) can be edited, within 1,000 characters, with a version check.
   - The original passage is untouched, and every version stays in `entity_versions` as the history.
   - Today's Undo for the kept memory is then refused, because it already refuses once the claim is past version 1.
   - Cost if wrong: status, date and count facts need a new note to change them.
5. **A fact always rests on the current version of its original.** `currentClaims` already drops a fact whose original was corrected or withdrawn, so the drawer never needs to show an old version. If a quote cannot be found in the original (a stale page), the drawer says so instead of highlighting the wrong text.
6. **Search is substring search over fact text and the full original title and body**, across all projects, 20 of each at most.
   - The old search also matched deep inside long bodies, and tests rely on that.
   - Ranked and embedding search are plan 5.
7. **"Continue in another agent" and "Edit understanding" leave the source dialog.**
   - The extractive brief they showed was a copy of the passages, not understanding.
   - The project page's **Preview handoff** opens the existing "Project handoff" dialog with Copy and Download. Editing facts replaces editing the brief.

## Global Constraints

- **Runtime and dependencies:** Node `>=24.19.0 <25`, npm `>=11`. No new runtime or dev dependencies.
- **Billing is paused** (owner decision, 2026-10-23):
  - Do not touch `packages/**/billing*`, `dodo*`, `paddle*`, `managed*`, `apps/server/billing-routes.ts` or `apps/worker/**`.
  - Test files may get label-only updates.
- **Branch:** work on branch `reframe/your-brain-v2` in `.worktrees/your-brain-v2`, made from `main` at 1190852.
- **The main Desktop checkout is off limits.** It is on `codex/dodo-payments` and holds the owner's uncommitted price-lock edits. Never touch it.
- **Navigation:** primary navigation stays **Today, Your brain, Connections**.
- **No internals in Your brain:** never show model names, tokens, queues, classifiers, graphs or MCP terminology.
- **Every fact links to its original.** A fact with no evidence is not shown.
- **No dead controls:** every visible control has real behaviour or says why it is unavailable. No simulated success.
- **Edits and undo:**
  - Edits and undo use version checks.
  - Undo never overwrites a later edit; it returns 409 and the UI says so once, in an alert.
  - A failed edit keeps the draft.
- **Server input:**
  - All HTTP input is validated with Zod `.strict()` schemas.
  - New service methods call `this.owner(p)` and `this.access(p, project)` before reading.
- **Copy:** plain, active voice, no em-dash asides. Button labels say exactly what happens. Reuse Today's words where they exist: "Open the original", "Undo", "Still true".
- **UI quality:**
  - Keyboard complete.
  - Usable at 320px with no horizontal page scroll.
  - Reduced motion respected.
  - Light and dark appearance.
- **Tests** use isolated databases or `firstNoteFixture`, deterministic clocks in Vitest, and synthetic fixtures.
- **Styling:** reuse the `tv-` classes from `apps/web/today/today.css` (buttons, links, tags, toast, alerts). New layout classes are prefixed `yb-` and live in `apps/web/brain/brain.css`.
- **Screenshots:** after any Playwright run, restore regenerated `docs/screenshots/*.png` with `git restore docs/screenshots` before committing.
- **Staging:** never `git add .`. Stage named files only.

## Review Focus

1. **Editing a fact from two tabs, or twice quickly.** The second save gets 409. The alert says "This item changed since you opened it. Refresh to compare." The draft stays in the box.
   - The app re-reads the page every 2.5 seconds, so an open edit must stay pinned to the version it started from. Otherwise it would quietly pick up the newer version and overwrite it.
   - Pinned in Task 3 (service) and Task 6 (browser, with a wait past one re-read).
2. **Today's Undo after the fact was edited in Your brain.** Undo is refused with "Current decision changed. Undo will not overwrite it." and the edit survives. Pinned in Task 3.
3. **A pasted conversation full of questions.** Open questions takes only the marked lines from it, and never shows more than 20 questions. Pinned in Task 1.
4. **An original that is withdrawn, quarantined or holds a secret-looking line.** Its questions and facts never appear in Open questions, True now, search or the drawer. Pinned in Task 1, Task 2 and Task 4.
5. **Search with one character, or a late response from an earlier query.** One character shows "Type at least two letters." and sends nothing. A late response never replaces newer results. Pinned in Task 4 (validation) and Task 9 (browser).

---

### Task 0: Baseline and the plan on the branch

**Files:**
- Already present: worktree `.worktrees/your-brain-v2` on `reframe/your-brain-v2` from `origin/main` 1190852, with `npm ci` done
- Commit: this plan file

- [ ] **Step 1: Confirm the parked checkout is untouched**

Run: `git -C "C:/Users/Gowrishankar/Desktop/Bi Brain" status --short | head -20`
Expected: the Dodo price-lock files are still modified, along with the untracked design and licensing files. Do not stage, stash or reset any of them.

- [ ] **Step 2: Baseline in the worktree**

```bash
cd "C:/Users/Gowrishankar/Desktop/Bi Brain/.worktrees/your-brain-v2"
npm run typecheck && npm run lint && npx vitest run --reporter=dot
```

Expected:
- typecheck and lint are clean.
- Vitest passes. Record the counts in the ledger.
- `spend-contention.test.ts` failed once under full-suite load on 2026-10-23 and passed alone 3 of 3. If it fails, rerun it alone before treating it as real.

- [ ] **Step 3: Commit the plan**

```bash
git add docs/superpowers/plans/2026-10-23-your-brain-v2.md
git commit -m "docs: plan Your brain v2"
```

---

### Task 1: Shared fact wording, open questions, and the Brief fit rule

**Files:**
- Create: `packages/domain/facts.ts`, `packages/domain/questions.ts`
- Modify: `packages/domain/brief.ts` (move `text`/`factText` out, export `gateFitsBrief`), `packages/domain/ask.ts` (use `factText`)
- Test: `tests/integration/your-brain-pure.test.ts`

**Interfaces:**
- Produces:
  - `export function valueText(v: unknown): string`
  - `export function factText(entityName: string, aspect: string, value: unknown): string`
  - `export const QUESTION_LIMIT = 20`
  - `export type QuestionSource = { id: string; version: number; title: string; body: string; captured_at: string; state: string }`
  - `export type QuestionEvidence = { source_id: string; source_version: number; start: number; end: number; quote: string }`
  - `export type OpenQuestion = { signature: string; text: string; source_title: string; captured_at: string; evidence: QuestionEvidence }`
  - `export function questionSignature(text: string): string`
  - `export function findOpenQuestions(sources: QuestionSource[], answered: ReadonlySet<string>, limit?: number): { items: OpenQuestion[]; total: number }`
  - `export function gateFitsBrief(g: Entity): boolean` (in `brief.ts`)

- [ ] **Step 1: Write the failing tests**

```ts
// tests/integration/your-brain-pure.test.ts
import { describe, expect, it } from "vitest";
import type { Entity } from "../../packages/contracts/index.ts";
import { gateFitsBrief } from "../../packages/domain/brief.ts";
import { factText } from "../../packages/domain/facts.ts";
import {
  QUESTION_LIMIT,
  findOpenQuestions,
  questionSignature,
} from "../../packages/domain/questions.ts";

const source = (
  id: string,
  body: string,
  captured_at = "2026-10-20T09:00:00Z",
  extra: { state?: string; title?: string; version?: number } = {},
) => ({
  id,
  version: extra.version ?? 1,
  title: extra.title ?? `Note ${id}`,
  body,
  captured_at,
  state: extra.state ?? "active",
});
const quoteAt = (body: string, e: { start: number; end: number }) =>
  Array.from(body).slice(e.start, e.end).join("");

describe("factText", () => {
  it("reads a status as a sentence and anything else as name: value", () => {
    expect(factText("Northstar beta", "status", "active")).toBe("Northstar beta is active.");
    expect(factText("Northstar beta", "statement", "invite only")).toBe("Northstar beta: invite only");
    expect(factText("Seats", "count", 50)).toBe("Seats: 50");
    expect(factText("Odd", "statement", { a: 1 })).toBe('Odd: {"a":1}');
  });
});

describe("findOpenQuestions", () => {
  it("finds marked lines and short-note questions with exact code-point evidence", () => {
    const body =
      "🙂 Plan for the week.\nOpen question: which benchmark has dated facts?\nDo we ship the self-hosted page first?";
    const { items, total } = findOpenQuestions([source("a", body)], new Set());
    expect(total).toBe(2);
    expect(items.map((q) => q.text)).toEqual([
      "which benchmark has dated facts?",
      "Do we ship the self-hosted page first?",
    ]);
    for (const q of items) expect(quoteAt(body, q.evidence)).toBe(q.evidence.quote);
    expect(items[0].evidence).toMatchObject({ source_id: "a", source_version: 1 });
    expect(items[0].source_title).toBe("Note a");
  });

  it("keeps a marked line that has no question mark", () => {
    const { items } = findOpenQuestions(
      [source("a", "Question: pricing for teams\nEverything else is settled.")],
      new Set(),
    );
    expect(items.map((q) => q.text)).toEqual(["pricing for teams"]);
  });

  it("takes only marked lines from an original full of questions, like a pasted chat", () => {
    const chat = [
      "Can you help?",
      "What do you need?",
      "Is the beta open?",
      "Who is invited?",
      "Open question: when does billing start?",
    ].join("\n");
    const { items } = findOpenQuestions([source("chat", chat)], new Set());
    expect(items.map((q) => q.text)).toEqual(["when does billing start?"]);
  });

  it("shows a question once, from the newest original, and hides answered ones", () => {
    const older = source("old", "Do we ship the self-hosted page first?", "2026-10-01T09:00:00Z");
    const newer = source("new", "Do we ship the  self-hosted page first ?", "2026-10-21T09:00:00Z");
    const first = findOpenQuestions([older, newer], new Set());
    expect(first.items).toHaveLength(1);
    expect(first.items[0].evidence.source_id).toBe("new");
    const answered = new Set([first.items[0].signature]);
    expect(findOpenQuestions([older, newer], answered).items).toEqual([]);
    expect(questionSignature("Do we ship it?")).toBe(questionSignature("do we   ship it"));
  });

  it("ignores withdrawn originals, quarantine placeholders, secret-looking lines and very short questions", () => {
    const secret = "Open question: should api_key = " + "a".repeat(20) + " go in the config?";
    const { items } = findOpenQuestions(
      [
        source("w", "Open question: is this withdrawn?", undefined, { state: "withdrawn" }),
        source(
          "q",
          "[Quarantined: suspected secret. Original retained outside the vault.]",
          undefined,
          { title: "Quarantined source" },
        ),
        source("s", secret),
        source("short", "Why?"),
      ],
      new Set(),
    );
    expect(items).toEqual([]);
  });

  it("caps the list and reports how many there are", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      source(
        `n${i}`,
        `Open question: topic number ${i} still open?`,
        `2026-10-${String(1 + (i % 28)).padStart(2, "0")}T09:00:00Z`,
      ),
    );
    const { items, total } = findOpenQuestions(many, new Set());
    expect(items).toHaveLength(QUESTION_LIMIT);
    expect(total).toBe(30);
  });
});

const gate = (data: Record<string, unknown>): Entity => ({
  id: "g",
  project_id: "inbox",
  kind: "gate",
  version: 1,
  created_at: "2026-10-20T09:00:00Z",
  data,
});
const evidence = [{ source_id: "s", source_version: 1, start: 0, end: 4, quote: "Beta" }];

describe("gateFitsBrief", () => {
  it("fits a named fact with evidence and leaves intentions and raw text to Your brain", () => {
    expect(
      gateFitsBrief(gate({ status: "queued", entity: "Beta", field: { aspect: "statement", value: "invite only" }, evidence })),
    ).toBe(true);
    expect(gateFitsBrief(gate({ status: "queued", type: "intent", intent: { action: "propose" }, evidence }))).toBe(false);
    expect(
      gateFitsBrief(gate({ status: "queued", entity: "Beta", field: { aspect: "statement", value: "" }, evidence })),
    ).toBe(false);
    expect(
      gateFitsBrief(gate({ status: "queued", entity: "Beta", field: { aspect: "statement", value: "x" }, evidence: [] })),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/integration/your-brain-pure.test.ts`
Expected: FAIL. It cannot resolve `../../packages/domain/facts.ts`.

- [ ] **Step 3: Write `facts.ts`**

```ts
// packages/domain/facts.ts
/** A stored value as plain text. Never "undefined" or "[object Object]". */
export function valueText(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return "";
  }
}

/** The sentence a fact reads as, everywhere BiBrain shows one. */
export function factText(entityName: string, aspect: string, value: unknown): string {
  return aspect === "status"
    ? `${entityName} is ${valueText(value)}.`
    : `${entityName}: ${valueText(value)}`;
}
```

- [ ] **Step 4: Point `brief.ts` and `ask.ts` at it, and export the fit rule**

In `packages/domain/brief.ts`:
1. Delete the local `const text = (v: unknown): string => { … };` block.
2. Delete the local `function factText(entityName: string, aspect: string, value: unknown) { … }`.
3. Add this import at the top:

```ts
import { factText, valueText as text } from "./facts.ts";
```

Add this after the `factKey` helper:

```ts
/** Whether a queued review can be a Brief card: it needs evidence, a named fact and a value. */
export function gateFitsBrief(g: Entity): boolean {
  const field = g.data.field;
  return (
    evidenceOf(g.data.evidence).length > 0 &&
    !!field &&
    nonEmpty(g.data.entity) &&
    nonEmpty(field.aspect) &&
    field.value !== undefined &&
    field.value !== null &&
    text(field.value).trim().length > 0
  );
}
```

In `buildBrief`'s gate loop, replace these two lines:

```ts
    const evidence = evidenceOf(g.data.evidence);
    const field = g.data.field;
    if (!evidence.length || !field || !nonEmpty(g.data.entity) || !nonEmpty(field.aspect)) continue;
    if (field.value === undefined || field.value === null || !text(field.value).trim()) continue;
```

with:

```ts
    if (!gateFitsBrief(g)) continue;
    const evidence = evidenceOf(g.data.evidence);
    const field = g.data.field;
```

In `packages/domain/ask.ts`:
1. Add `import { factText } from "./facts.ts";`.
2. Replace the inline text expression in `rankAnswers`:

```ts
      const text = c.data.aspect === "status" ? `${c.data.entity} is ${c.data.value}.` : `${c.data.entity}: ${c.data.value}`;
```

with:

```ts
      const text = factText(String(c.data.entity), String(c.data.aspect), c.data.value);
```

- [ ] **Step 5: Write `questions.ts`**

```ts
// packages/domain/questions.ts
import { detectSecrets } from "../storage/secrets.ts";

export const QUESTION_LIMIT = 20;
/** An original with more unmarked questions than this is probably a pasted chat. */
const MAX_UNMARKED_PER_SOURCE = 3;
const MARKED = /^(?:open question|still unclear|question|unclear)\s*[:\-–]\s*/iu;

export type QuestionSource = {
  id: string;
  version: number;
  title: string;
  body: string;
  captured_at: string;
  state: string;
};
export type QuestionEvidence = {
  source_id: string;
  source_version: number;
  start: number;
  end: number;
  quote: string;
};
export type OpenQuestion = {
  signature: string;
  text: string;
  source_title: string;
  captured_at: string;
  evidence: QuestionEvidence;
};

/** Sentences with code-point offsets into the body. A line break always ends one. */
function sentences(body: string): { quote: string; start: number }[] {
  const chars = Array.from(body);
  const out: { quote: string; start: number }[] = [];
  let start = 0;
  const flush = (end: number) => {
    const raw = chars.slice(start, end).join("");
    const quote = raw.trim();
    if (!quote) return;
    const lead = Array.from(raw).length - Array.from(raw.trimStart()).length;
    out.push({ quote, start: start + lead });
  };
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (c === "\n" || c === "\r") {
      flush(i);
      start = i + 1;
    } else if (
      (c === "?" || c === "." || c === "!") &&
      (i + 1 === chars.length || /\s/u.test(chars[i + 1]))
    ) {
      flush(i + 1);
      start = i + 1;
    }
  }
  flush(chars.length);
  return out;
}

/** The same question written twice, or with different spacing, gets one signature. */
export function questionSignature(text: string): string {
  return text
    .toLocaleLowerCase()
    .replace(/\s+/gu, " ")
    .replace(/[\s?.!]+$/u, "")
    .trim()
    .slice(0, 300);
}

export function findOpenQuestions(
  sources: QuestionSource[],
  answered: ReadonlySet<string>,
  limit = QUESTION_LIMIT,
): { items: OpenQuestion[]; total: number } {
  const seen = new Set<string>();
  const items: OpenQuestion[] = [];
  const newestFirst = sources
    .filter((s) => s.state === "active")
    .sort((a, b) => b.captured_at.localeCompare(a.captured_at));
  for (const s of newestFirst) {
    const parts = sentences(s.body);
    const unmarked = parts.filter((p) => p.quote.endsWith("?") && !MARKED.test(p.quote));
    const allowUnmarked = unmarked.length <= MAX_UNMARKED_PER_SOURCE;
    for (const part of parts) {
      const marked = MARKED.test(part.quote);
      if (!marked && !(allowUnmarked && part.quote.endsWith("?"))) continue;
      const text = part.quote.replace(MARKED, "").trim();
      const length = Array.from(text).length;
      if (length < 6 || length > 300) continue;
      if (detectSecrets(part.quote).length) continue;
      const signature = questionSignature(text);
      if (!signature || seen.has(signature) || answered.has(signature)) continue;
      seen.add(signature);
      items.push({
        signature,
        text,
        source_title: s.title,
        captured_at: s.captured_at,
        evidence: {
          source_id: s.id,
          source_version: s.version,
          start: part.start,
          end: part.start + Array.from(part.quote).length,
          quote: part.quote,
        },
      });
    }
  }
  return { items: items.slice(0, limit), total: items.length };
}
```

- [ ] **Step 6: Run the new tests and the Brief and Ask tests**

Run: `npx vitest run tests/integration/your-brain-pure.test.ts tests/integration/brief.test.ts tests/integration/brief-service.test.ts tests/integration/ask.test.ts`
Expected: all PASS. The Brief and Ask tests show the refactor kept their behaviour.

- [ ] **Step 7: Typecheck, lint, commit**

```bash
npm run typecheck && npm run lint
git add packages/domain/facts.ts packages/domain/questions.ts packages/domain/brief.ts packages/domain/ask.ts tests/integration/your-brain-pure.test.ts
git commit -m "feat: shared fact wording and deterministic open questions"
```

---

### Task 2: The project view service and routes

**Files:**
- Create: `packages/domain/project-view.ts`
- Modify: `packages/domain/service.ts` (add `brainProject`, `answerQuestion` after `confirmClaim`), `apps/server/app.ts` (two routes next to `/api/v1/claims/:id/confirm`)
- Test: `tests/integration/brain-project.test.ts`

**Interfaces:**
- Consumes: `factText` (Task 1), `findOpenQuestions`, `OpenQuestion` (Task 1), `gateFitsBrief` (Task 1), `STALE_DAYS` from `brief.ts`, and the existing `currentClaims`, `sources`, `entities`, `evidenceCurrent` and `claim_confirmations` setting.
- Produces:
  - `export const ORIGINALS_LIMIT = 200`
  - `export type FactEvidence = { source_id: string; source_version: number; start: number; end: number; quote: string; source_title: string }`
  - `export type FactView = { id: string; version: number; text: string; aspect: string; value: string; editable: boolean; edited_by_owner: boolean; checked_at: string; stale: boolean; evidence: FactEvidence[] }`
  - `export type OriginalView = { id: string; version: number; title: string; captured_at: string; from: "you" | "agent" | "import"; private: boolean }`
  - `export type ProjectView = { project: { id: string; title: string }; facts: FactView[]; questions: OpenQuestion[]; questions_total: number; originals: OriginalView[]; originals_total: number; waiting_for_review: number; needs_decision: Entity[]; decision_history: Entity[] }`
  - `export function buildProjectView(input: ProjectViewInput, now: Date): ProjectView`
  - `Brain.brainProject(p: Principal, project: string): ProjectView`
  - `Brain.answerQuestion(p: Principal, input: unknown): { signature: string; answered: boolean }`
  - `GET /api/v1/brain/projects/:id` and `POST /api/v1/questions/answer` (body `{ project_id, signature, answered }`)

- [ ] **Step 1: Write the failing tests**

```ts
// tests/integration/brain-project.test.ts
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../../packages/storage/index.ts";
import { Brain } from "../../packages/domain/service.ts";
import { createApp } from "../../apps/server/app.ts";
import type { Principal } from "../../packages/contracts/index.ts";

const owner: Principal = { kind: "owner" };
const agent = { kind: "agent", grant_id: "nope" } as Principal;
const DECISION = "We decided that Northstar beta is invite only.";
const QUESTION_NOTE = "Launch notes\nOpen question: who writes the launch post?";
let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.reverse()) fn();
  cleanup = [];
});
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "brain-project-test-"));
  const s = new Storage(join(dir, "brain.sqlite"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  cleanup.push(() => {
    try {
      s.close();
    } catch {}
  });
  let date = new Date("2026-10-23T09:00:00Z");
  const b = new Brain(s, () => date);
  return { b, advance: (ms: number) => { date = new Date(date.getTime() + ms); } };
}
function keepFirst(b: Brain) {
  const [item] = b.brief(owner).items;
  b.reviewGate(owner, item.target.id, { action: "accept", expected_version: item.target.version });
  return b.currentClaims(owner, "inbox")[0];
}

describe("Brain.brainProject", () => {
  it("shows kept facts with evidence, open questions and originals newest first", () => {
    const { b, advance } = setup();
    b.capture(owner, { title: "Decision", body: DECISION });
    const claim = keepFirst(b);
    advance(60_000);
    b.capture(owner, { title: "Launch notes", body: QUESTION_NOTE });
    const view = b.brainProject(owner, "inbox");
    expect(view.project).toMatchObject({ id: "inbox" });
    expect(view.facts).toHaveLength(1);
    expect(view.facts[0]).toMatchObject({ id: claim.id, version: 1, editable: true, stale: false });
    expect(view.facts[0].text).toContain("invite only");
    expect(view.facts[0].evidence[0]).toMatchObject({ source_title: "Decision" });
    expect(view.facts[0].evidence[0].quote).toContain("invite only");
    expect(view.questions.map((q) => q.text)).toEqual(["who writes the launch post?"]);
    expect(view.originals.map((o) => o.title)).toEqual(["Launch notes", "Decision"]);
    expect(view.originals[0].from).toBe("you");
    expect(view.waiting_for_review).toBe(0);
    expect(view.needs_decision).toEqual([]);
  });

  it("marks a fact not checked after 21 days until the owner confirms it", () => {
    const { b, advance } = setup();
    b.capture(owner, { title: "Decision", body: DECISION });
    const claim = keepFirst(b);
    advance(22 * 86_400_000);
    expect(b.brainProject(owner, "inbox").facts[0].stale).toBe(true);
    b.confirmClaim(owner, claim.id);
    expect(b.brainProject(owner, "inbox").facts[0].stale).toBe(false);
  });

  it("drops the facts and questions of a withdrawn original", () => {
    const { b } = setup();
    const saved = b.capture(owner, { title: "Decision", body: DECISION + "\nOpen question: who signs off?" }) as any;
    keepFirst(b);
    expect(b.brainProject(owner, "inbox").questions).toHaveLength(1);
    b.removeSource(owner, saved.source_id, 1, false);
    const view = b.brainProject(owner, "inbox");
    expect(view.facts).toEqual([]);
    expect(view.questions).toEqual([]);
    expect(view.originals).toEqual([]);
  });

  it("counts suggestions for this project only, and lists what only Your brain can decide", () => {
    const { b } = setup();
    b.capture(owner, { title: "Decision", body: DECISION });
    const other = b.createProject(owner, "Hydra");
    expect(b.brainProject(owner, "inbox").waiting_for_review).toBe(1);
    expect(b.brainProject(owner, other.id).waiting_for_review).toBe(0);
    b.propose(owner, { project_id: other.id, title: "Raw note", text: "Something an agent wrote down." });
    const view = b.brainProject(owner, other.id);
    expect(view.needs_decision).toHaveLength(1);
    expect(view.needs_decision[0].data.field).toBeUndefined();
  });

  it("refuses other principals and unknown projects", () => {
    const { b } = setup();
    expect(() => b.brainProject(agent, "inbox")).toThrow();
    expect(() => b.brainProject(owner, "missing-project")).toThrow(/unavailable/i);
  });
});

describe("Brain.answerQuestion", () => {
  it("hides a question until it is brought back, for the owner only", () => {
    const { b } = setup();
    b.capture(owner, { title: "Launch notes", body: QUESTION_NOTE });
    const [q] = b.brainProject(owner, "inbox").questions;
    expect(b.answerQuestion(owner, { project_id: "inbox", signature: q.signature, answered: true })).toEqual({
      signature: q.signature,
      answered: true,
    });
    expect(b.brainProject(owner, "inbox").questions).toEqual([]);
    b.answerQuestion(owner, { project_id: "inbox", signature: q.signature, answered: false });
    expect(b.brainProject(owner, "inbox").questions).toHaveLength(1);
    expect(() => b.answerQuestion(agent, { project_id: "inbox", signature: q.signature, answered: true })).toThrow();
    expect(() => b.answerQuestion(owner, { project_id: "inbox", signature: "", answered: true })).toThrow();
    expect(() => b.answerQuestion(owner, { project_id: "nope", signature: q.signature, answered: true })).toThrow();
  });
});

describe("Your brain routes", () => {
  it("serve the project view and answers to the paired owner only", async () => {
    const { b } = setup();
    const app = await createApp(b, { pairSecret: "test-code", static: false });
    cleanup.push(() => void app.close());
    const req = (method: any, url: string, payload?: any, headers: Record<string, string> = {}) =>
      app.inject({ method, url, headers: { host: "127.0.0.1:4317", ...headers }, payload });
    expect((await req("GET", "/api/v1/brain/projects/inbox")).statusCode).toBe(401);
    const pairing = await req("POST", "/api/v1/session/pair", { secret: "test-code" });
    const cookie = pairing.cookies[0];
    const headers = { cookie: `${cookie.name}=${cookie.value}`, "x-brain-csrf": pairing.json().csrf };
    await req("POST", "/api/v1/sources", { title: "Launch notes", body: QUESTION_NOTE }, headers);
    const view = await req("GET", "/api/v1/brain/projects/inbox", undefined, headers);
    expect(view.statusCode).toBe(200);
    const [q] = view.json().questions;
    const extra = await req(
      "POST",
      "/api/v1/questions/answer",
      { project_id: "inbox", signature: q.signature, answered: true, extra: 1 },
      headers,
    );
    expect(extra.statusCode).toBe(400);
    const ok = await req("POST", "/api/v1/questions/answer", { project_id: "inbox", signature: q.signature, answered: true }, headers);
    expect(ok.statusCode).toBe(200);
    expect((await req("GET", "/api/v1/brain/projects/inbox", undefined, headers)).json().questions).toEqual([]);
    expect((await req("GET", "/api/v1/brain/projects/nope", undefined, headers)).statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/integration/brain-project.test.ts`
Expected: FAIL with `b.brainProject is not a function`.

- [ ] **Step 3: Write `project-view.ts`**

```ts
// packages/domain/project-view.ts
import type { Entity, Source } from "../contracts/index.ts";
import { STALE_DAYS } from "./brief.ts";
import { factText, valueText } from "./facts.ts";
import { findOpenQuestions, type OpenQuestion } from "./questions.ts";

export const ORIGINALS_LIMIT = 200;

export type FactEvidence = {
  source_id: string;
  source_version: number;
  start: number;
  end: number;
  quote: string;
  source_title: string;
};
export type FactView = {
  id: string;
  version: number;
  text: string;
  aspect: string;
  value: string;
  editable: boolean;
  edited_by_owner: boolean;
  checked_at: string;
  stale: boolean;
  evidence: FactEvidence[];
};
export type OriginalView = {
  id: string;
  version: number;
  title: string;
  captured_at: string;
  from: "you" | "agent" | "import";
  private: boolean;
};
export type ProjectView = {
  project: { id: string; title: string };
  facts: FactView[];
  questions: OpenQuestion[];
  questions_total: number;
  originals: OriginalView[];
  originals_total: number;
  waiting_for_review: number;
  needs_decision: Entity[];
  decision_history: Entity[];
};
export type ProjectViewInput = {
  project: { id: string; title: string };
  claims: Entity[];
  confirmations: Record<string, string>;
  sources: Source[];
  answered: ReadonlySet<string>;
  waiting: number;
  needsDecision: Entity[];
  decisionHistory: Entity[];
};

export function originFrom(origin: string): OriginalView["from"] {
  if (origin === "manual") return "you";
  return origin.startsWith("agent:") ? "agent" : "import";
}

const validTime = (t: unknown): t is string =>
  typeof t === "string" && !Number.isNaN(Date.parse(t));

export function buildProjectView(input: ProjectViewInput, now: Date): ProjectView {
  const staleBefore = now.getTime() - STALE_DAYS * 86_400_000;
  const titles = new Map(input.sources.map((s) => [s.id, s.title]));
  const facts = input.claims
    .filter((c) => Array.isArray(c.data.evidence) && c.data.evidence.length > 0)
    .map((c): FactView => {
      const times = [c.data.recorded_at, c.data.edited_at, input.confirmations[c.id]].filter(validTime);
      const checked_at = times.sort().at(-1) ?? c.created_at;
      return {
        id: c.id,
        version: c.version,
        text: factText(String(c.data.entity), String(c.data.aspect), c.data.value),
        aspect: String(c.data.aspect),
        value: valueText(c.data.value),
        editable: c.data.aspect === "statement",
        edited_by_owner: c.data.edited_by_owner === true,
        checked_at,
        stale: Date.parse(checked_at) < staleBefore,
        evidence: (c.data.evidence as Omit<FactEvidence, "source_title">[]).map((e) => ({
          source_id: e.source_id,
          source_version: e.source_version,
          start: e.start,
          end: e.end,
          quote: e.quote,
          source_title: titles.get(e.source_id) ?? "Original",
        })),
      };
    })
    .sort((a, b) => b.checked_at.localeCompare(a.checked_at));
  const questions = findOpenQuestions(input.sources, input.answered);
  const originals = input.sources
    .filter((s) => s.state === "active")
    .sort((a, b) => b.captured_at.localeCompare(a.captured_at))
    .map((s): OriginalView => ({
      id: s.id,
      version: s.version,
      title: s.title,
      captured_at: s.captured_at,
      from: originFrom(s.origin),
      private: s.visibility === "private",
    }));
  return {
    project: input.project,
    facts,
    questions: questions.items,
    questions_total: questions.total,
    originals: originals.slice(0, ORIGINALS_LIMIT),
    originals_total: originals.length,
    waiting_for_review: input.waiting,
    needs_decision: input.needsDecision,
    decision_history: input.decisionHistory,
  };
}
```

- [ ] **Step 4: Add the service methods**

In `packages/domain/service.ts`:
1. Add `gateFitsBrief` to the existing `./brief.ts` import, making it `import { buildBrief, gateFitsBrief, type BriefJob } from "./brief.ts";`.
2. Add `import { buildProjectView } from "./project-view.ts";`.
3. Add these methods right after `confirmClaim`:

```ts
  brainProject(p: Principal, project: string) {
    this.owner(p);
    project = z.string().min(1).max(100).parse(project);
    this.access(p, project);
    const row = this.store.get<{ id: string; title: string }>(
      "SELECT id,title FROM projects WHERE id=?",
      project,
    )!;
    const current = (list: unknown) =>
      Array.isArray(list) &&
      list.length > 0 &&
      (list as Evidence[]).every((e) => this.evidenceCurrent(project, e));
    const gates = this.entities(p, "gate").filter((g) => g.project_id === project);
    const queued = gates.filter((g) => g.data.status === "queued");
    const waiting =
      queued.filter((g) => gateFitsBrief(g) && current(g.data.evidence)).length +
      this.entities(p, "proposal").filter(
        (x) => x.project_id === project && x.data.status === "ready" && current(x.data.evidence),
      ).length;
    return buildProjectView(
      {
        project: row,
        claims: this.currentClaims(p, project),
        confirmations: this.store.setting<Record<string, string>>("claim_confirmations", {}),
        sources: this.sources(p, project),
        answered: new Set(this.store.setting<string[]>(`answered_questions:${project}`, [])),
        waiting,
        needsDecision: queued.filter((g) => !gateFitsBrief(g)),
        decisionHistory: gates.filter(
          (g) => g.data.correction === true && ["accepted", "rejected", "reverted"].includes(g.data.status),
        ),
      },
      this.clock(),
    );
  }
  answerQuestion(p: Principal, input: unknown) {
    this.owner(p);
    const v = z
      .object({
        project_id: z.string().min(1).max(100),
        signature: z.string().trim().min(1).max(300),
        answered: z.boolean(),
      })
      .strict()
      .parse(input);
    this.access(p, v.project_id);
    const key = `answered_questions:${v.project_id}`;
    const list = this.store.setting<string[]>(key, []).filter((s) => s !== v.signature);
    if (v.answered) list.push(v.signature);
    this.store.set(key, list.slice(-500));
    return { signature: v.signature, answered: v.answered };
  }
```

If `Evidence` is not already imported in `service.ts`, use the type its `brief()` method uses for the same `current` helper.

- [ ] **Step 5: Add the routes**

In `apps/server/app.ts`, right after the `/api/v1/claims/:id/confirm` route:

```ts
  app.get("/api/v1/brain/projects/:id", (req) =>
    req.brain.brainProject(req.principal, params(req)),
  );
  app.post("/api/v1/questions/answer", (req) =>
    req.brain.answerQuestion(req.principal, req.body),
  );
```

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/integration/brain-project.test.ts tests/integration/your-brain-pure.test.ts`
Expected: all PASS.

If `propose` with only `{ project_id, title, text }` is refused, read the `proposeSchema` in `packages/domain/claims.ts`. Pass the smallest valid input that still has no `field`, then rerun.

- [ ] **Step 7: Typecheck, lint, commit**

```bash
npm run typecheck && npm run lint
git add packages/domain/project-view.ts packages/domain/service.ts apps/server/app.ts tests/integration/brain-project.test.ts
git commit -m "feat: project view with facts, open questions and originals"
```

---

### Task 3: Edit a fact as a new version, and read its history

**Files:**
- Modify: `packages/domain/service.ts` (add `reviseClaim`, `claimHistory` after `answerQuestion`), `apps/server/app.ts` (two routes)
- Test: `tests/integration/fact-edit.test.ts`

**Interfaces:**
- Consumes: `factText` (Task 1), and the existing `requireVersion`, `revise`, `checkEvidence`, `entity` and `retireClaim`.
- Produces:
  - `Brain.reviseClaim(p: Principal, id: string, input: unknown): { id: string; version: number; unchanged: boolean }`
  - `Brain.claimHistory(p: Principal, id: string): { version: number; text: string; status: string; edited_by_owner: boolean; at: string }[]`, oldest first
  - `POST /api/v1/claims/:id/revise` (body `{ expected_version, value }`) and `GET /api/v1/claims/:id/history`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/integration/fact-edit.test.ts
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../../packages/storage/index.ts";
import { Brain } from "../../packages/domain/service.ts";
import { createApp } from "../../apps/server/app.ts";
import type { Principal } from "../../packages/contracts/index.ts";

const owner: Principal = { kind: "owner" };
const DECISION = "We decided that Northstar beta is invite only.";
let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.reverse()) fn();
  cleanup = [];
});
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "fact-edit-test-"));
  const s = new Storage(join(dir, "brain.sqlite"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  cleanup.push(() => {
    try {
      s.close();
    } catch {}
  });
  const b = new Brain(s, () => new Date("2026-10-23T09:00:00Z"));
  const saved = b.capture(owner, { title: "Decision", body: DECISION }) as any;
  const [item] = b.brief(owner).items;
  const kept = b.reviewGate(owner, item.target.id, {
    action: "accept",
    expected_version: item.target.version,
  }) as any;
  const [claim] = b.currentClaims(owner, "inbox");
  return { b, saved, claim, gateId: item.target.id, gateVersion: kept.gate_version as number };
}

describe("Brain.reviseClaim", () => {
  it("saves the owner's wording as a new version and keeps the history", () => {
    const { b, claim } = setup();
    expect(b.reviseClaim(owner, claim.id, { expected_version: 1, value: "invite only until launch" })).toEqual({
      id: claim.id,
      version: 2,
      unchanged: false,
    });
    expect(b.currentClaims(owner, "inbox")[0].data).toMatchObject({
      value: "invite only until launch",
      edited_by_owner: true,
    });
    expect(b.brainProject(owner, "inbox").facts[0]).toMatchObject({ version: 2, edited_by_owner: true });
    const history = b.claimHistory(owner, claim.id);
    expect(history.map((h) => h.version)).toEqual([1, 2]);
    expect(history[0].text).toContain("invite only");
    expect(history[1]).toMatchObject({ edited_by_owner: true, status: "current" });
    expect(history[1].text).toContain("until launch");
  });

  it("refuses a stale version, so a second tab or a late undo cannot overwrite a later edit", () => {
    const { b, claim } = setup();
    b.reviseClaim(owner, claim.id, { expected_version: 1, value: "invite only until launch" });
    expect(() => b.reviseClaim(owner, claim.id, { expected_version: 1, value: "open to everyone" })).toThrow(
      /changed since you opened it/i,
    );
    expect(b.currentClaims(owner, "inbox")[0].data.value).toBe("invite only until launch");
  });

  it("makes Today's Undo for the kept memory refuse once the fact was edited", () => {
    const { b, claim, gateId, gateVersion } = setup();
    b.reviseClaim(owner, claim.id, { expected_version: 1, value: "invite only until launch" });
    expect(() => b.reviewGate(owner, gateId, { action: "undo", expected_version: gateVersion })).toThrow(
      /will not overwrite/i,
    );
    expect(b.currentClaims(owner, "inbox")[0].data.value).toBe("invite only until launch");
  });

  it("edits only current statements, within 1,000 characters, for the owner", () => {
    const { b, claim } = setup();
    expect(() => b.reviseClaim(owner, claim.id, { expected_version: 1, value: "x".repeat(1001) })).toThrow();
    expect(() => b.reviseClaim(owner, claim.id, { expected_version: 1, value: "   " })).toThrow();
    expect(() =>
      b.reviseClaim({ kind: "agent", grant_id: "nope" } as Principal, claim.id, { expected_version: 1, value: "x" }),
    ).toThrow();
    expect(b.reviseClaim(owner, claim.id, { expected_version: 1, value: String(claim.data.value) })).toEqual({
      id: claim.id,
      version: 1,
      unchanged: true,
    });
    b.retireClaim(owner, claim.id, 1);
    expect(() => b.reviseClaim(owner, claim.id, { expected_version: 2, value: "x" })).toThrow(/replaced or retired/i);
    expect(b.claimHistory(owner, claim.id).at(-1)).toMatchObject({ status: "retired" });
  });

  it("refuses an edit once the original was withdrawn", () => {
    const { b, saved, claim } = setup();
    b.removeSource(owner, saved.source_id, 1, false);
    expect(() => b.reviseClaim(owner, claim.id, { expected_version: 1, value: "x" })).toThrow();
  });
});

describe("fact routes", () => {
  it("serve edits and history to the paired owner only", async () => {
    const { b, claim } = setup();
    const app = await createApp(b, { pairSecret: "test-code", static: false });
    cleanup.push(() => void app.close());
    const req = (method: any, url: string, payload?: any, headers: Record<string, string> = {}) =>
      app.inject({ method, url, headers: { host: "127.0.0.1:4317", ...headers }, payload });
    expect((await req("GET", `/api/v1/claims/${claim.id}/history`)).statusCode).toBe(401);
    const pairing = await req("POST", "/api/v1/session/pair", { secret: "test-code" });
    const cookie = pairing.cookies[0];
    const headers = { cookie: `${cookie.name}=${cookie.value}`, "x-brain-csrf": pairing.json().csrf };
    const ok = await req("POST", `/api/v1/claims/${claim.id}/revise`, { expected_version: 1, value: "invite only until launch" }, headers);
    expect(ok.statusCode).toBe(200);
    const stale = await req("POST", `/api/v1/claims/${claim.id}/revise`, { expected_version: 1, value: "again" }, headers);
    expect(stale.statusCode).toBe(409);
    const extra = await req("POST", `/api/v1/claims/${claim.id}/revise`, { expected_version: 2, value: "x", y: 1 }, headers);
    expect(extra.statusCode).toBe(400);
    const history = await req("GET", `/api/v1/claims/${claim.id}/history`, undefined, headers);
    expect(history.json().map((h: any) => h.version)).toEqual([1, 2]);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/integration/fact-edit.test.ts`
Expected: FAIL with `b.reviseClaim is not a function`.

- [ ] **Step 3: Add the service methods**

In `packages/domain/service.ts`, add `import { factText } from "./facts.ts";`, then add after `answerQuestion`:

```ts
  reviseClaim(p: Principal, id: string, input: unknown) {
    this.owner(p);
    id = z.string().min(1).max(100).parse(id);
    const v = z
      .object({
        expected_version: z.number().int().positive(),
        value: z.string().trim().min(1).max(1000),
      })
      .strict()
      .parse(input);
    return this.store.transaction(() => {
      const c = this.entity(p, id);
      if (c.kind !== "claim") throw new BrainError("NOT_FOUND", "Fact unavailable.", 404);
      requireVersion(c.version, v.expected_version);
      if (c.data.status !== "current")
        throw new BrainError(
          "VERSION_CONFLICT",
          "This fact was replaced or retired. Refresh to see the current one.",
          409,
        );
      if (c.data.aspect !== "statement")
        throw new BrainError("INVALID_INPUT", "Only a fact written as a sentence can be edited here.");
      this.checkEvidence(p, c.project_id, c.data.evidence ?? []);
      if (v.value === c.data.value) return { id: c.id, version: c.version, unchanged: true };
      this.revise(c, { ...c.data, value: v.value, edited_by_owner: true, edited_at: this.now() });
      return { id: c.id, version: c.version + 1, unchanged: false };
    });
  }
  claimHistory(p: Principal, id: string) {
    this.owner(p);
    id = z.string().min(1).max(100).parse(id);
    const c = this.entity(p, id);
    if (c.kind !== "claim") throw new BrainError("NOT_FOUND", "Fact unavailable.", 404);
    return this.store
      .all<{ version: number; data: string; created_at: string }>(
        "SELECT version,data,created_at FROM entity_versions WHERE entity_id=? ORDER BY version",
        id,
      )
      .map((row) => {
        const data = JSON.parse(row.data);
        return {
          version: row.version,
          text: factText(String(data.entity), String(data.aspect), data.value),
          status: String(data.status),
          edited_by_owner: data.edited_by_owner === true,
          at: row.created_at,
        };
      });
  }
```

- [ ] **Step 4: Add the routes**

In `apps/server/app.ts`, after the two routes from Task 2:

```ts
  app.post("/api/v1/claims/:id/revise", (req) =>
    req.brain.reviseClaim(req.principal, params(req), req.body),
  );
  app.get("/api/v1/claims/:id/history", (req) =>
    req.brain.claimHistory(req.principal, params(req)),
  );
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/integration/fact-edit.test.ts tests/integration/gate-review-edit.test.ts tests/integration/brain-project.test.ts`
Expected: all PASS.

- [ ] **Step 6: Typecheck, lint, commit**

```bash
npm run typecheck && npm run lint
git add packages/domain/service.ts apps/server/app.ts tests/integration/fact-edit.test.ts
git commit -m "feat: edit a fact as a new version and read its history"
```

---

### Task 4: Search facts and originals

**Files:**
- Create: `packages/domain/brain-search.ts`
- Modify: `packages/domain/service.ts` (add `searchBrain` after `claimHistory`), `apps/server/app.ts` (one route)
- Test: `tests/integration/brain-search.test.ts`

**Interfaces:**
- Consumes: `factText` (Task 1)
- Produces:
  - `export const SEARCH_LIMIT = 20`
  - `export type FactHit = { id: string; project_id: string; text: string; evidence: { source_id: string; source_version: number; start: number; end: number; quote: string }[] }`
  - `export type OriginalHit = { id: string; project_id: string; version: number; title: string; snippet: string }`
  - `export function findInBrain(query: string, claims: Entity[], sources: Source[], limit?: number): { facts: FactHit[]; originals: OriginalHit[] }`
  - `export function snippetFor(body: string, title: string, query: string): string`
  - `Brain.searchBrain(p: Principal, input: unknown)` and `GET /api/v1/brain/search?q=`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/integration/brain-search.test.ts
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../../packages/storage/index.ts";
import { Brain } from "../../packages/domain/service.ts";
import { createApp } from "../../apps/server/app.ts";
import type { Entity, Principal, Source } from "../../packages/contracts/index.ts";
import { findInBrain, snippetFor } from "../../packages/domain/brain-search.ts";

const owner: Principal = { kind: "owner" };
const src = (id: string, title: string, body: string, state = "active"): Source => ({
  id,
  project_id: "inbox",
  version: 1,
  title,
  body,
  visibility: "project",
  state,
  captured_at: "2026-10-20T09:00:00Z",
  origin: "manual",
});
const claim = (id: string, entity: string, value: string, evidence: unknown[] = [{ source_id: "a", source_version: 1, start: 0, end: 4, quote: "Beta" }]): Entity => ({
  id,
  project_id: "inbox",
  kind: "claim",
  version: 1,
  created_at: "2026-10-20T09:00:00Z",
  data: { entity, aspect: "statement", value, evidence },
});

describe("findInBrain", () => {
  it("finds facts by their wording and originals by title or body, ignoring case", () => {
    const out = findInBrain(
      "MÜLLER",
      [claim("c1", "Interview with Müller", "keep the free plan")],
      [src("a", "Notes", "We met Herr Müller on Monday."), src("b", "Müller call", "Short.")],
    );
    expect(out.facts.map((f) => f.id)).toEqual(["c1"]);
    expect(out.originals.map((o) => o.id)).toEqual(["a", "b"]);
    expect(out.originals[0].snippet).toBe("We met Herr Müller on Monday.");
  });

  it("skips facts without evidence and originals that are no longer active", () => {
    const out = findInBrain(
      "beta",
      [claim("c1", "Beta", "invite only", [])],
      [src("a", "Beta", "withdrawn note", "withdrawn")],
    );
    expect(out).toEqual({ facts: [], originals: [] });
  });

  it("returns nothing for a blank query and cuts long snippets on code points", () => {
    expect(findInBrain("   ", [], [src("a", "x", "y")])).toEqual({ facts: [], originals: [] });
    const long = "🧠".repeat(300) + " needle";
    const snippet = snippetFor(long, "t", "needle");
    expect(Array.from(snippet).length).toBe(238);
    expect(snippet.endsWith("…")).toBe(true);
  });
});

describe("Brain.searchBrain", () => {
  let cleanup: (() => void)[] = [];
  afterEach(() => {
    for (const fn of cleanup.reverse()) fn();
    cleanup = [];
  });
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), "brain-search-test-"));
    const s = new Storage(join(dir, "brain.sqlite"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    cleanup.push(() => {
      try {
        s.close();
      } catch {}
    });
    return new Brain(s, () => new Date("2026-10-23T09:00:00Z"));
  }

  it("searches every project, validates the query and is owner-only", () => {
    const b = setup();
    const hydra = b.createProject(owner, "Hydra");
    b.capture(owner, { title: "Hydra", body: "The ZEBRA_SENTINEL lives here.", project_id: hydra.id });
    const gone = b.capture(owner, { title: "Gone", body: "ZEBRA_SENTINEL withdrawn." }) as any;
    b.removeSource(owner, gone.source_id, 1, false);
    const out = b.searchBrain(owner, { q: "zebra_sentinel" });
    expect(out.originals.map((o) => o.project_id)).toEqual([hydra.id]);
    expect(() => b.searchBrain(owner, { q: "z" })).toThrow();
    expect(() => b.searchBrain(owner, { q: "z".repeat(201) })).toThrow();
    expect(() => b.searchBrain(owner, { q: "zebra", extra: 1 })).toThrow();
    expect(() => b.searchBrain({ kind: "agent", grant_id: "nope" } as Principal, { q: "zebra" })).toThrow();
  });

  it("is served over HTTP to the paired owner only", async () => {
    const b = setup();
    const app = await createApp(b, { pairSecret: "test-code", static: false });
    cleanup.push(() => void app.close());
    const req = (method: any, url: string, payload?: any, headers: Record<string, string> = {}) =>
      app.inject({ method, url, headers: { host: "127.0.0.1:4317", ...headers }, payload });
    expect((await req("GET", "/api/v1/brain/search?q=zebra")).statusCode).toBe(401);
    const pairing = await req("POST", "/api/v1/session/pair", { secret: "test-code" });
    const cookie = pairing.cookies[0];
    const headers = { cookie: `${cookie.name}=${cookie.value}`, "x-brain-csrf": pairing.json().csrf };
    await req("POST", "/api/v1/sources", { title: "Zebra", body: "A zebra note." }, headers);
    const ok = await req("GET", "/api/v1/brain/search?q=zebra", undefined, headers);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().originals).toHaveLength(1);
    expect((await req("GET", "/api/v1/brain/search?q=z", undefined, headers)).statusCode).toBe(400);
  });
});
```

`capture` accepts `project_id`. If it uses a different key, read `captureSchema` and adjust the test, not the schema.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run tests/integration/brain-search.test.ts`
Expected: FAIL. It cannot resolve `brain-search.ts`.

- [ ] **Step 3: Write `brain-search.ts`**

```ts
// packages/domain/brain-search.ts
import type { Entity, Source } from "../contracts/index.ts";
import { factText } from "./facts.ts";

export const SEARCH_LIMIT = 20;

export type FactHit = {
  id: string;
  project_id: string;
  text: string;
  evidence: { source_id: string; source_version: number; start: number; end: number; quote: string }[];
};
export type OriginalHit = {
  id: string;
  project_id: string;
  version: number;
  title: string;
  snippet: string;
};

const fold = (text: string) => text.toLocaleLowerCase();

/** The sentence or line that matched, cut to 240 code points. */
export function snippetFor(body: string, title: string, query: string): string {
  const q = fold(query);
  const parts = body.split(/(?<=[.?!])\s+|\n+/u).filter((part) => part.trim());
  const hit = parts.find((part) => fold(part).includes(q)) ?? parts[0] ?? title;
  const points = Array.from(hit.trim());
  return points.length > 240 ? points.slice(0, 237).join("") + "…" : points.join("");
}

export function findInBrain(
  query: string,
  claims: Entity[],
  sources: Source[],
  limit = SEARCH_LIMIT,
): { facts: FactHit[]; originals: OriginalHit[] } {
  const raw = query.trim();
  const q = fold(raw);
  if (!q) return { facts: [], originals: [] };
  const facts = claims
    .filter((c) => Array.isArray(c.data.evidence) && c.data.evidence.length > 0)
    .map((c) => ({ c, text: factText(String(c.data.entity), String(c.data.aspect), c.data.value) }))
    .filter(({ text }) => fold(text).includes(q))
    .slice(0, limit)
    .map(({ c, text }) => ({
      id: c.id,
      project_id: c.project_id,
      text,
      evidence: (c.data.evidence as FactHit["evidence"]).map((e) => ({
        source_id: e.source_id,
        source_version: e.source_version,
        start: e.start,
        end: e.end,
        quote: e.quote,
      })),
    }));
  const originals = sources
    .filter((s) => s.state === "active" && fold(`${s.title}\n${s.body}`).includes(q))
    .slice(0, limit)
    .map((s) => ({
      id: s.id,
      project_id: s.project_id,
      version: s.version,
      title: s.title,
      snippet: snippetFor(s.body, s.title, raw),
    }));
  return { facts, originals };
}
```

- [ ] **Step 4: Add the service method and route**

In `packages/domain/service.ts`, add `import { SEARCH_LIMIT, findInBrain } from "./brain-search.ts";` and, after `claimHistory`:

```ts
  searchBrain(p: Principal, input: unknown) {
    this.owner(p);
    const v = z.object({ q: z.string().trim().min(2).max(200) }).strict().parse(input);
    const projects = this.projects(p) as { id: string }[];
    const claims = projects.flatMap((project) => this.currentClaims(p, project.id));
    return findInBrain(v.q, claims, this.sources(p), SEARCH_LIMIT);
  }
```

In `apps/server/app.ts`, after the Task 3 routes:

```ts
  app.get("/api/v1/brain/search", (req) =>
    req.brain.searchBrain(req.principal, req.query),
  );
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/integration/brain-search.test.ts`
Expected: all PASS.

- [ ] **Step 6: Typecheck, lint, commit**

```bash
npm run typecheck && npm run lint
git add packages/domain/brain-search.ts packages/domain/service.ts apps/server/app.ts tests/integration/brain-search.test.ts
git commit -m "feat: search facts and originals across projects"
```

---

### Task 5: The Your brain shell: projects, header, originals, goals and decisions

**Files:**
- Create:
  - `apps/web/brain/types.ts`
  - `apps/web/brain/format.ts`
  - `apps/web/brain/BrainView.tsx`
  - `apps/web/brain/ProjectList.tsx`
  - `apps/web/brain/Originals.tsx`
  - `apps/web/brain/GoalsSection.tsx`
  - `apps/web/brain/PendingReview.tsx`
  - `apps/web/brain/brain.css`
- Modify: `apps/web/src.tsx` (mount `BrainView`, remove what only the old screen read)
- Test: `tests/e2e/your-brain-v2.spec.ts` (new; runs in the `main` Playwright project on `firstNoteFixture`, so each journey has its own brain)

**Interfaces:**
- Consumes:
  - `GET /api/v1/brain/projects/:id` (Task 2)
  - the existing `POST /api/v1/proposals/gate/:id/review`
  - the existing dialogs in `src.tsx`: `project`, `goal`, `plan`, `handoff` and `save`
  - `Api` and the `tv-` classes from Today
- Produces:
  - `export type OpenSourceOptions = { quote?: string; factId?: string }`, added to `apps/web/today/types.ts` and re-exported from `apps/web/brain/types.ts`
  - `export function BrainView(props: BrainProps): JSX.Element`
  - `BrainProps` as defined in Step 3
  - `done(message, undo?)`: the refresh-then-toast callback that later sections use

- [ ] **Step 1: Write the failing browser tests**

```ts
// tests/e2e/your-brain-v2.spec.ts
import { expect, test, type Browser, type Page } from "@playwright/test";
import { firstNoteFixture } from "../helpers/first-note-browser.ts";

// Each journey gets its own brain, so nothing another spec saved can crowd the Brief.
async function journey(browser: Browser, run: (page: Page) => Promise<void>) {
  const context = await browser.newContext();
  const fixture = await firstNoteFixture(context);
  const page = await context.newPage();
  try {
    await fixture.open(page);
    await run(page);
  } finally {
    await fixture.close();
  }
}
async function save(page: Page, text: string) {
  const bar = page.getByLabel(/save to your brain|ask your brain/i);
  await bar.fill(text);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(bar).toHaveValue("");
}
async function keepOnToday(page: Page, hasText: string) {
  await page.getByRole("button", { name: "Today", exact: true }).click();
  const card = page.getByRole("article").filter({ hasText });
  await card.getByRole("button", { name: "Keep as true" }).click();
  await expect(card).toHaveCount(0);
}
async function openBrain(page: Page) {
  await page.getByRole("button", { name: "Your brain", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your brain", level: 1 })).toBeVisible();
}

test("Your brain shows the open project, its originals newest first, and switches projects", async ({ browser }) => {
  await journey(browser, async (page) => {
    await save(page, "First note about the Hydra launch.");
    await save(page, "Second note about the Hydra launch.");
    await openBrain(page);
    await expect(page.getByRole("heading", { name: "Inbox", level: 2 })).toBeVisible();
    await expect(page.getByText("No agent connected")).toBeVisible();
    const originals = page.getByRole("region", { name: "Originals" });
    const titles = originals.getByRole("listitem").getByRole("button");
    await expect(titles.first()).toHaveText(/Second note/);
    await expect(titles.nth(1)).toHaveText(/First note/);
    await titles.first().click();
    await expect(page.getByTestId("original")).toHaveText("Second note about the Hydra launch.");
    await page.getByRole("button", { name: "Close dialog" }).click();
    const projects = page.getByRole("navigation", { name: "Projects" });
    await projects.getByRole("button", { name: "New project" }).click();
    await page.getByLabel("Project name").fill("Hydra");
    await page.getByRole("button", { name: "Create project", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Hydra", level: 2 })).toBeVisible();
    await expect(originals).toContainText("Nothing saved here yet.");
    await projects.getByRole("button", { name: "Inbox" }).click();
    await expect(page.getByRole("heading", { name: "Inbox", level: 2 })).toBeVisible();
  });
});

test("a suggestion is counted here and reviewed on Today", async ({ browser }) => {
  await journey(browser, async (page) => {
    await save(page, "We decided that Northstar beta is invite only.");
    await openBrain(page);
    await expect(page.getByText("1 suggestion waits for your review on Today.")).toBeVisible();
    await page.getByRole("button", { name: "Review on Today" }).click();
    await expect(page.getByRole("article").filter({ hasText: "invite only" })).toBeVisible();
  });
});

test("Your brain fits a 320px screen in dark appearance", async ({ browser }) => {
  await journey(browser, async (page) => {
    await save(page, "A note with a long unbroken word Supercalifragilisticexpialidocious_and_more_words_here.");
    await page.setViewportSize({ width: 320, height: 760 });
    await page.emulateMedia({ colorScheme: "dark" });
    await openBrain(page);
    await expect(page.getByRole("navigation", { name: "Projects" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm run build && npx playwright test tests/e2e/your-brain-v2.spec.ts --workers=1`
Expected: FAIL. There is no heading "Your brain" at level 1 inside a page with a "Projects" navigation. The old screen has a toolbar and a project select.

- [ ] **Step 3: Write the types and helpers**

In `apps/web/today/types.ts`, add `OpenSourceOptions` and widen the prop type:

```ts
export type OpenSourceOptions = {
  /** An exact passage to highlight in the original. */
  quote?: string;
  /** The fact this original was opened from, so its history is shown. */
  factId?: string;
};
```

Change `onOpenSource: (id: string) => void;` in `TodayProps` to `onOpenSource: (id: string, opts?: OpenSourceOptions) => void;`.

```ts
// apps/web/brain/types.ts
import type { Entity } from "../../../packages/contracts/index.ts";
import type { Api, OpenSourceOptions } from "../today/types.ts";

export type { Api, OpenSourceOptions };

export type FactEvidence = {
  source_id: string;
  source_version: number;
  start: number;
  end: number;
  quote: string;
  source_title: string;
};
export type Fact = {
  id: string;
  version: number;
  text: string;
  aspect: string;
  value: string;
  editable: boolean;
  edited_by_owner: boolean;
  checked_at: string;
  stale: boolean;
  evidence: FactEvidence[];
};
export type OpenQuestion = {
  signature: string;
  text: string;
  source_title: string;
  captured_at: string;
  evidence: { source_id: string; source_version: number; start: number; end: number; quote: string };
};
export type Original = {
  id: string;
  version: number;
  title: string;
  captured_at: string;
  from: "you" | "agent" | "import";
  private: boolean;
};
export type ProjectView = {
  project: { id: string; title: string };
  facts: Fact[];
  questions: OpenQuestion[];
  questions_total: number;
  originals: Original[];
  originals_total: number;
  waiting_for_review: number;
  needs_decision: Entity[];
  decision_history: Entity[];
};
export type FactHistoryEntry = {
  version: number;
  text: string;
  status: string;
  edited_by_owner: boolean;
  at: string;
};
export type SearchResults = {
  facts: { id: string; project_id: string; text: string; evidence: Omit<FactEvidence, "source_title">[] }[];
  originals: { id: string; project_id: string; version: number; title: string; snippet: string }[];
};
export type Done = (message: string, undo?: () => Promise<void>) => Promise<void>;
export type GoalActions = {
  choose: (projectId: string) => void;
  setPreparation: (goal: Entity, enabled: boolean) => void;
  prepare: (goal: Entity) => void;
  toggleStatus: (goal: Entity) => void;
  editPlan: (goal: Entity) => void;
};
export type BrainProps = {
  api: Api;
  projects: { id: string; title: string }[];
  /** The project on screen. "inbox" when nothing else was chosen. */
  projectId: string;
  onSelectProject: (id: string) => void;
  agentNamesByProject: Record<string, string[]>;
  goals: Entity[];
  busy: boolean;
  /** Changing this value reads the project again. */
  refreshKey: unknown;
  onOpenSource: (id: string, opts?: OpenSourceOptions) => void;
  onNewProject: () => void;
  onSave: () => void;
  onPreviewHandoff: (projectId: string) => void;
  onNavigate: (to: "Today") => void;
  goalActions: GoalActions;
};
```

```ts
// apps/web/brain/format.ts
/** "Oct 23", or "Oct 23, 2025" outside the current year. */
export function shortDate(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "Unknown date";
  const d = new Date(t);
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(d.getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }),
  });
}
```

- [ ] **Step 4: Write the components**

```tsx
// apps/web/brain/ProjectList.tsx
type Props = {
  projects: { id: string; title: string }[];
  current: string;
  onSelect: (id: string) => void;
  onNew: () => void;
};

export function ProjectList({ projects, current, onSelect, onNew }: Props) {
  return (
    <nav className="yb-plist" aria-label="Projects">
      <ul>
        {projects.map((p) => (
          <li key={p.id}>
            <button
              type="button"
              aria-current={p.id === current ? "page" : undefined}
              onClick={() => onSelect(p.id)}
            >
              {p.title}
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="tv-link" onClick={onNew}>
        New project
      </button>
    </nav>
  );
}
```

```tsx
// apps/web/brain/Originals.tsx
import { useState } from "react";
import { shortDate } from "./format.ts";
import type { OpenSourceOptions, Original } from "./types.ts";

const FROM: Record<Original["from"], string> = {
  you: "Saved by you",
  agent: "From an agent",
  import: "Imported",
};

type Props = {
  originals: Original[];
  total: number;
  onOpenSource: (id: string, opts?: OpenSourceOptions) => void;
  onSave: () => void;
};

export function Originals({ originals, total, onOpenSource, onSave }: Props) {
  const [shown, setShown] = useState(50);
  return (
    <section className="tv-section" aria-labelledby="yb-orig-h">
      <div className="tv-section-head">
        <h3 id="yb-orig-h">Originals</h3>
        <span className="tv-faint">Kept exactly as saved</span>
        <button type="button" className="tv-link" onClick={onSave}>
          Save to this project
        </button>
      </div>
      {originals.length === 0 ? (
        <p className="tv-faint">Nothing saved here yet.</p>
      ) : (
        <ol className="yb-timeline">
          {originals.slice(0, shown).map((o) => (
            <li key={o.id}>
              <time className="yb-when" dateTime={o.captured_at}>
                {shortDate(o.captured_at)}
              </time>
              <div className="yb-orig">
                <button type="button" className="yb-src" onClick={() => onOpenSource(o.id)}>
                  {o.title}
                </button>
                <span className="tv-faint">
                  {FROM[o.from]}
                  {o.private ? " · Private" : ""}
                  {o.version > 1 ? ` · version ${o.version}` : ""}
                </span>
              </div>
            </li>
          ))}
        </ol>
      )}
      {shown < originals.length && (
        <button type="button" className="tv-btn tv-sm" onClick={() => setShown((n) => n + 50)}>
          Show 50 more
        </button>
      )}
      {total > originals.length && shown >= originals.length && (
        <p className="tv-faint">
          Showing the newest {originals.length} of {total}. Search finds the rest.
        </p>
      )}
    </section>
  );
}
```

`GoalsSection` keeps the old goal controls and their exact labels, so the goal journeys keep working until plan 4 replaces them with Watch:

```tsx
// apps/web/brain/GoalsSection.tsx
import type { Entity } from "../../../packages/contracts/index.ts";
import type { GoalActions } from "./types.ts";

type Props = { goals: Entity[]; busy: boolean; projectId: string; actions: GoalActions };

export function GoalsSection({ goals, busy, projectId, actions }: Props) {
  return (
    <section className="tv-section" aria-labelledby="yb-goals-h">
      <div className="tv-section-head">
        <h3 id="yb-goals-h">Goals</h3>
        <button type="button" className="tv-link" onClick={() => actions.choose(projectId)}>
          Choose a goal
        </button>
      </div>
      {goals.length === 0 ? (
        <p className="tv-faint">No goal for this project. Goals are optional.</p>
      ) : (
        goals.map((g) => (
          <article key={g.id} className="yb-item">
            <span className="tv-faint">{g.data.status}</span>
            <h4 className="yb-fact">{g.data.title}</h4>
            <p className="yb-fact">{g.data.success_criteria}</p>
            {g.data.plan ? (
              <>
                <h5 className="yb-eyebrow">
                  {g.data.plan_stale
                    ? "Earlier plan · sources changed; review before reuse"
                    : "Current plan · your accepted understanding"}
                </h5>
                <pre className="yb-original">{g.data.plan}</pre>
              </>
            ) : null}
            <div className="tv-actions">
              <label>
                <input
                  type="checkbox"
                  checked={!!g.data.preparation_enabled}
                  disabled={busy}
                  onChange={(e) => actions.setPreparation(g, e.target.checked)}
                />{" "}
                Keep this up to date
              </label>
              <button
                type="button"
                className="tv-btn tv-sm"
                disabled={!g.data.preparation_enabled || g.data.status !== "active"}
                onClick={() => actions.prepare(g)}
              >
                Prepare now
              </button>
              <button type="button" className="tv-btn tv-sm" onClick={() => actions.toggleStatus(g)}>
                {g.data.status === "active" ? "Pause goal" : "Resume goal"}
              </button>
              <button type="button" className="tv-btn tv-sm" onClick={() => actions.editPlan(g)}>
                Edit plan
              </button>
            </div>
          </article>
        ))
      )}
    </section>
  );
}
```

`PendingReview` holds what Today cannot show (Ruling 2). Its labels and the `data-proposal-id` attribute match the old panel, so the intention and correction-history journeys keep their names:

```tsx
// apps/web/brain/PendingReview.tsx
import { useState } from "react";
import type { Entity } from "../../../packages/contracts/index.ts";
import { EvidenceList } from "../components.tsx";
import { friendlyError } from "../today/BriefCard.tsx";
import type { Api, OpenSourceOptions } from "./types.ts";

type Props = {
  api: Api;
  needsDecision: Entity[];
  history: Entity[];
  onOpenSource: (id: string, opts?: OpenSourceOptions) => void;
  onDone: (message: string) => Promise<void>;
  onError: (message: string | null) => void;
};

export function PendingReview({ api, needsDecision, history, onOpenSource, onDone, onError }: Props) {
  const [busy, setBusy] = useState(false);
  if (!needsDecision.length && !history.length) return null;
  async function review(g: Entity, action: "accept" | "reject" | "undo") {
    if (busy) return;
    setBusy(true);
    onError(null);
    try {
      await api(`/proposals/gate/${g.id}/review`, { expected_version: g.version, action });
      await onDone(
        action === "undo"
          ? "Correction undone without erasing history."
          : action === "accept"
            ? "Approved."
            : "Kept as an original only.",
      );
    } catch (e) {
      onError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="tv-section" aria-label="Needs a decision here">
      {needsDecision.length > 0 && (
        <>
          <div className="tv-section-head">
            <h3>Needs a decision here</h3>
            <span className="tv-faint">These are not single facts, so they wait here instead of on Today.</span>
          </div>
          <ul className="yb-list">
            {needsDecision.map((g) => (
              <li key={g.id}>
                <article className="yb-item" data-proposal-id={g.id}>
                  <h4 className="yb-fact">
                    {g.data.entity ?? (g.data.type === "intent" ? "Proposed intention" : "New material")}
                  </h4>
                  <p className="tv-faint">
                    {g.data.type === "intent"
                      ? `${g.data.intent?.action ?? "Propose"} intention`
                      : g.data.field
                        ? `${g.data.field.aspect}: ${String(g.data.field.value)}`
                        : "No single fact was found in this."}
                  </p>
                  <EvidenceList items={g.data.evidence ?? []} onOpen={(id) => onOpenSource(id)} />
                  <div className="tv-actions">
                    {g.data.raw_id ? (
                      <button type="button" className="tv-btn tv-sm" onClick={() => onOpenSource(g.data.raw_id)}>
                        Read original
                      </button>
                    ) : null}
                    {g.data.type === "intent" && g.data.intent ? (
                      <button type="button" className="tv-btn tv-primary tv-sm" disabled={busy} onClick={() => void review(g, "accept")}>
                        Approve intention
                      </button>
                    ) : g.data.field && g.data.evidence?.length ? (
                      <button type="button" className="tv-btn tv-primary tv-sm" disabled={busy} onClick={() => void review(g, "accept")}>
                        Accept reviewed claim
                      </button>
                    ) : null}
                    <button type="button" className="tv-btn tv-ghost tv-sm" disabled={busy} onClick={() => void review(g, "reject")}>
                      Keep raw only
                    </button>
                  </div>
                </article>
              </li>
            ))}
          </ul>
        </>
      )}
      {history.length > 0 && (
        <details className="yb-details">
          <summary>Reviewed decision history</summary>
          <ul className="yb-list">
            {history.map((g) => (
              <li key={g.id}>
                <article className="yb-item">
                  <h4 className="yb-fact">
                    {g.data.entity}: {String(g.data.field?.value ?? "")}
                  </h4>
                  <p className="tv-faint">
                    {g.data.status === "accepted"
                      ? "Approved by you"
                      : g.data.status === "reverted"
                        ? "Undone by you"
                        : "Earlier decision kept"}
                  </p>
                  <EvidenceList items={g.data.evidence ?? []} onOpen={(id) => onOpenSource(id)} />
                  {g.data.status === "accepted" ? (
                    <button type="button" className="tv-btn tv-sm" disabled={busy} onClick={() => void review(g, "undo")}>
                      Undo correction
                    </button>
                  ) : null}
                  <p className="tv-faint">Undo is refused if a later edit or a changed original makes it unsafe.</p>
                </article>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
```

`BrainView` owns loading, the alert region and the toast. Later tasks add `TrueNow`, `OpenQuestions` and `BrainSearch` at the marked lines:

```tsx
// apps/web/brain/BrainView.tsx
import { useCallback, useEffect, useRef, useState } from "react";
import { friendlyError } from "../today/BriefCard.tsx";
import { useUndoToast } from "../today/useUndoToast.tsx";
import { GoalsSection } from "./GoalsSection.tsx";
import { Originals } from "./Originals.tsx";
import { PendingReview } from "./PendingReview.tsx";
import { ProjectList } from "./ProjectList.tsx";
import type { BrainProps, Done, ProjectView } from "./types.ts";

export function BrainView(props: BrainProps) {
  const { api, projectId, refreshKey } = props;
  const [view, setView] = useState<ProjectView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const { toast, show } = useUndoToast();
  // Only the newest read may land, and none after the view is gone.
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const next = await api<ProjectView>(`/brain/projects/${encodeURIComponent(projectId)}`);
      if (mine !== seq.current) return;
      setView(next);
      setLoadError(null);
    } catch (e) {
      if (mine !== seq.current) return;
      setLoadError(friendlyError(e));
    }
  }, [api, projectId]);

  useEffect(() => {
    setView(null);
    setActionError(null);
  }, [projectId]);
  useEffect(() => {
    void load();
  }, [load, refreshKey]);
  useEffect(
    () => () => {
      seq.current += 1;
    },
    [],
  );

  const done = useCallback<Done>(
    async (message, undo) => {
      setActionError(null);
      await load();
      show(
        message,
        undo &&
          (async () => {
            try {
              await undo();
            } catch (e) {
              setActionError(friendlyError(e));
              throw e;
            } finally {
              await load();
            }
          }),
      );
    },
    [load, show],
  );

  const title =
    view?.project.title ?? props.projects.find((p) => p.id === projectId)?.title ?? "Project";
  const agents = (props.agentNamesByProject[projectId] ?? []).length;
  const waiting = view?.waiting_for_review ?? 0;

  return (
    <section className="yb" aria-labelledby="yb-h">
      <h1 id="yb-h" className="tv-title">
        Your brain
      </h1>
      {/* Task 9 adds BrainSearch here. */}
      <div className="yb-layout">
        <ProjectList
          projects={props.projects}
          current={projectId}
          onSelect={props.onSelectProject}
          onNew={props.onNewProject}
        />
        <div className="yb-detail">
          <header className="yb-head">
            <div className="yb-head-text">
              <h2>{title}</h2>
              <p className="tv-faint">
                {agents ? `${agents} ${agents === 1 ? "agent" : "agents"} connected` : "No agent connected"}
              </p>
            </div>
            <button type="button" className="tv-btn tv-sm" onClick={() => props.onPreviewHandoff(projectId)}>
              Preview handoff
            </button>
          </header>
          {loadError && (
            <p className="tv-error" role="alert">
              {loadError}
            </p>
          )}
          {actionError && (
            <p className="tv-error" role="alert">
              {actionError}
            </p>
          )}
          {!view && !loadError && (
            <p className="tv-faint" role="status">
              Loading…
            </p>
          )}
          {view && (
            <>
              {waiting > 0 && (
                <p className="yb-waiting">
                  <span>
                    {waiting} {waiting === 1 ? "suggestion waits" : "suggestions wait"} for your review on Today.
                  </span>
                  <button type="button" className="tv-link" onClick={() => props.onNavigate("Today")}>
                    Review on Today
                  </button>
                </p>
              )}
              {/* Task 6 adds TrueNow here. */}
              {/* Task 7 adds OpenQuestions here. */}
              <Originals
                originals={view.originals}
                total={view.originals_total}
                onOpenSource={props.onOpenSource}
                onSave={props.onSave}
              />
              <PendingReview
                api={api}
                needsDecision={view.needs_decision}
                history={view.decision_history}
                onOpenSource={props.onOpenSource}
                onDone={(m) => done(m)}
                onError={setActionError}
              />
              <GoalsSection
                goals={props.goals.filter((g) => g.project_id === projectId)}
                busy={props.busy}
                projectId={projectId}
                actions={props.goalActions}
              />
            </>
          )}
        </div>
      </div>
      {toast}
    </section>
  );
}
```

```css
/* apps/web/brain/brain.css */
/* Your brain v2. Layout classes are prefixed yb-. Buttons, links, tags, alerts and the toast reuse the tv- classes from today.css. */
.yb { display: grid; gap: 24px; min-width: 0; }
.yb .tv-section-head h3 { margin: 0; font-size: 18px; }
.yb-layout { display: grid; grid-template-columns: minmax(150px, 220px) minmax(0, 1fr); gap: 28px; align-items: start; }
.yb-plist { display: grid; gap: 10px; min-width: 0; }
.yb-plist ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.yb-plist li button { width: 100%; text-align: left; font: inherit; padding: 8px 10px; border-radius: 8px; border: 1px solid transparent; background: none; color: inherit; cursor: pointer; overflow-wrap: anywhere; }
.yb-plist li button:hover { border-color: var(--line); }
.yb-plist li button[aria-current="page"] { background: var(--surface); border-color: var(--line); font-weight: 700; }
.yb-plist button:focus-visible, .yb-src:focus-visible, .yb-hit:focus-visible, .yb-field:focus-visible { outline: 2px solid var(--green); outline-offset: 2px; }
.yb-detail { display: grid; gap: 24px; min-width: 0; }
.yb-head { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: flex-start; gap: 12px; }
.yb-head-text { display: grid; gap: 4px; min-width: 0; }
.yb-head h2 { margin: 0; font-size: 26px; letter-spacing: -0.02em; overflow-wrap: anywhere; }
.yb-waiting { margin: 0; display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: baseline; }
.yb-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.yb-item { display: grid; gap: 8px; min-width: 0; padding: 12px 14px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); }
.yb-item-row { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.yb-fact { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.yb-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; }
.yb-eyebrow { margin: 0; font-size: 12px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); }
.yb-timeline { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.yb-timeline li { display: grid; grid-template-columns: 72px minmax(0, 1fr); gap: 12px; align-items: baseline; }
.yb-when { color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; }
.yb-orig { display: grid; gap: 2px; min-width: 0; }
.yb-src { justify-self: start; text-align: left; font: inherit; font-weight: 650; padding: 0; border: 0; background: none; color: inherit; cursor: pointer; text-decoration: underline; text-underline-offset: 3px; overflow-wrap: anywhere; }
.yb-details summary { cursor: pointer; font-weight: 650; }
.yb-details[open] summary { margin-bottom: 10px; }
.yb-original { margin: 0; font: inherit; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
@media (max-width: 720px) {
  .yb-layout { grid-template-columns: minmax(0, 1fr); gap: 16px; }
  .yb-plist ul { display: flex; flex-wrap: wrap; gap: 6px; }
  .yb-plist li button { width: auto; border-color: var(--line); }
  .yb-timeline li { grid-template-columns: minmax(0, 1fr); gap: 2px; }
}
```

- [ ] **Step 5: Mount it in `src.tsx`**

1. Add `import { BrainView } from "./brain/BrainView.tsx";` and `import "./brain/brain.css";` next to the Today imports.
2. Replace the whole `) : nav === "Your brain" ? ( <section className="brain-view" data-ui="brain-library"> … </section>` branch (it starts with `<p className="eyebrow">SAVE → CONTINUE</p>` and ends just before `) : nav === "Connections" ? (`) with:

```tsx
          ) : nav === "Your brain" ? (
            <BrainView
              key={accountId ?? "local"}
              api={api}
              projects={projects.map((p: any) => ({ id: p.id, title: p.title }))}
              projectId={scope || "inbox"}
              onSelectProject={(id) => setScope(id)}
              agentNamesByProject={agentNamesByProject}
              goals={today.goals}
              busy={busy}
              refreshKey={today}
              onOpenSource={(id) => void openSource(id)}
              onNewProject={() => setDialog("project")}
              onSave={saveDialog}
              onPreviewHandoff={(projectId) =>
                void act(async () => {
                  setHandoff(await api("/handoffs", { project_id: projectId }));
                  setDialog("handoff");
                })
              }
              onNavigate={(to) => setNav(to)}
              goalActions={{
                choose: (projectId) => {
                  setCaptureScope(projectId);
                  setDialog("goal");
                },
                setPreparation: (g, enabled) => {
                  setToday((current: any) => ({
                    ...current,
                    goals: current.goals.map((goal: Entity) =>
                      goal.id === g.id
                        ? { ...goal, data: { ...goal.data, preparation_enabled: enabled } }
                        : goal,
                    ),
                  }));
                  void act(async () => {
                    try {
                      await api(
                        `/goals/${g.id}`,
                        { expected_version: g.version, preparation_enabled: enabled },
                        "PATCH",
                      );
                    } finally {
                      await refresh();
                    }
                  });
                },
                prepare: (g) =>
                  void act(async () => {
                    await api(`/goals/${g.id}/prepare`, {});
                    setNotice("Preparation requested. It will appear in Today when ready.");
                  }),
                toggleStatus: (g) =>
                  void act(async () => {
                    await api(
                      `/goals/${g.id}`,
                      {
                        expected_version: g.version,
                        status: g.data.status === "active" ? "paused" : "active",
                      },
                      "PATCH",
                    );
                    await refresh();
                  }),
                editPlan: (g) => {
                  setProposal(g);
                  setArtifact(g.data.plan);
                  setDialog("plan");
                },
              }}
            />
```

3. Leave `openSource` as it is. Task 8 gives it the highlight options; until then, a one-argument handler satisfies the wider prop type.

4. Remove everything that only the old screen read, and only when `grep -n "<name>" apps/web/src.tsx` shows no other reader. `npm run lint` (no-unused-vars) and `npm run typecheck` tell you what is left. The expected list:
   - `search`/`setSearch`, `searchResults`/`setSearchResults`, `queryPage`/`setQueryPage` and the effect that calls `/search?q=…&offset=…`
   - `knowledgePages`, `knowledgeProject`, `gateQueue`, `knowledgeReadSeq` and the effect that reads `/pages` and `/gates`
   - `visibleNotes`, `scopedKnowledgePages`, `scopedGateQueue`, `focusProject`, `focusSources`, `focusBrief`, `focusGoal`, `focusReadyReviews`, `projectSummaries` and `target`
   - the `ProjectFocus`, `ProjectOverview` and `CurrentKnowledge` imports
   - the setter calls for removed state inside `resetPersonalState` and the managed-mode reset effect

   If `accountId` is not a state name in `src.tsx`, use the existing account identifier that `resetPersonalState` clears.

`EvidenceList` stays exported from `components.tsx`, because `PendingReview` uses it. Task 11 deletes the files that end up unused.

- [ ] **Step 6: Run the browser tests, typecheck and lint**

Run: `npm run typecheck && npm run lint && npm run build && npx playwright test tests/e2e/your-brain-v2.spec.ts tests/e2e/today-v2.spec.ts --workers=1`
Expected: the three new tests PASS. `today-v2.spec.ts` still passes, including the project-card test, which expects heading "Your brain" and the project at level 2.

- [ ] **Step 7: Commit**

```bash
git restore docs/screenshots 2>/dev/null || true
git add apps/web/brain apps/web/today/types.ts apps/web/src.tsx tests/e2e/your-brain-v2.spec.ts
git commit -m "feat: Your brain v2 shell with projects, originals, goals and decisions"
```

---

### Task 6: True now

**Files:**
- Create: `apps/web/brain/TrueNow.tsx`
- Modify: `apps/web/brain/BrainView.tsx` (mount it), `apps/web/brain/brain.css` (edit box)
- Test: `tests/e2e/your-brain-v2.spec.ts`

**Interfaces:**
- Consumes:
  - `ProjectView.facts`
  - `POST /api/v1/claims/:id/revise` (Task 3)
  - the existing `POST /api/v1/claims/:id/confirm`
  - `Done` and `OpenSourceOptions` (Task 5)
- Produces: `export function TrueNow(props: { api: Api; facts: Fact[]; onOpenSource: (id: string, opts?: OpenSourceOptions) => void; onDone: Done; onError: (message: string | null) => void }): JSX.Element`

- [ ] **Step 1: Add the failing browser tests**

Append to `tests/e2e/your-brain-v2.spec.ts`:

```ts
test("a kept fact shows under True now and can be edited, with Undo", async ({ browser }) => {
  await journey(browser, async (page) => {
    await save(page, "We decided that Northstar beta is invite only.");
    await keepOnToday(page, "invite only");
    await openBrain(page);
    const facts = page.getByRole("region", { name: "True now" });
    const row = facts.getByRole("listitem").filter({ hasText: "invite only" });
    await expect(row).toContainText("version 1");
    await expect(row).toContainText("Checked");
    await row.getByRole("button", { name: "Edit" }).click();
    await facts.getByLabel("Edit fact").fill("invite only until launch");
    await facts.getByRole("button", { name: "Save as version 2" }).click();
    await expect(facts).toContainText("invite only until launch");
    const toast = page.locator(".tv-toast");
    await expect(toast).toContainText("Saved as version 2.");
    await toast.getByRole("button", { name: "Undo" }).click();
    await expect(toast).toContainText("Undone.");
    await expect(facts).not.toContainText("until launch");
    await expect(facts.getByRole("listitem").filter({ hasText: "invite only" })).toContainText("version 3");
    await page.getByRole("button", { name: "Preview handoff" }).click();
    await expect(page.getByRole("dialog", { name: "Project handoff" })).toContainText("invite only");
  });
});

test("an edit from a second tab is refused and keeps the draft", async ({ browser }) => {
  const context = await browser.newContext();
  const fixture = await firstNoteFixture(context);
  const first = await context.newPage();
  try {
    await fixture.open(first);
    await save(first, "We decided that Northstar beta is invite only.");
    await keepOnToday(first, "invite only");
    await openBrain(first);
    const second = await context.newPage();
    await fixture.open(second);
    await openBrain(second);
    // The second tab starts its edit first, from version 1.
    const secondFacts = second.getByRole("region", { name: "True now" });
    await secondFacts.getByRole("button", { name: "Edit" }).click();
    await secondFacts.getByLabel("Edit fact").fill("open to everyone");
    const firstFacts = first.getByRole("region", { name: "True now" });
    await firstFacts.getByRole("button", { name: "Edit" }).click();
    await firstFacts.getByLabel("Edit fact").fill("invite only until launch");
    await firstFacts.getByRole("button", { name: "Save as version 2" }).click();
    await expect(first.locator(".tv-toast")).toContainText("Saved as version 2.");
    // The page re-reads every 2.5 seconds; let it, so the test proves the edit stays pinned.
    await second.waitForTimeout(3000);
    await secondFacts.getByRole("button", { name: "Save as version 2" }).click();
    await expect(second.getByRole("alert").filter({ hasText: /changed since you opened it/i })).toBeVisible();
    await expect(secondFacts.getByLabel("Edit fact")).toHaveValue("open to everyone");
    await expect(firstFacts).toContainText("invite only until launch");
  } finally {
    await fixture.close();
  }
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm run build && npx playwright test tests/e2e/your-brain-v2.spec.ts --workers=1 -g "True now|second tab"`
Expected: FAIL. There is no region "True now".

- [ ] **Step 3: Write `TrueNow.tsx`**

```tsx
// apps/web/brain/TrueNow.tsx
import { useRef, useState } from "react";
import { friendlyError } from "../today/BriefCard.tsx";
import { shortDate } from "./format.ts";
import type { Api, Done, Fact, OpenSourceOptions } from "./types.ts";

type Props = {
  api: Api;
  facts: Fact[];
  onOpenSource: (id: string, opts?: OpenSourceOptions) => void;
  onDone: Done;
  onError: (message: string | null) => void;
};

export function TrueNow({ api, facts, onOpenSource, onDone, onError }: Props) {
  return (
    <section className="tv-section" aria-labelledby="yb-true-h">
      <div className="tv-section-head">
        <h3 id="yb-true-h">True now</h3>
        <span className="tv-faint">Each fact links to its original</span>
      </div>
      {facts.length === 0 ? (
        <p className="tv-faint">No reviewed facts yet. Keep a suggestion on Today, or add a fact from an original.</p>
      ) : (
        <ul className="yb-list">
          {facts.map((f) => (
            <FactRow key={f.id} fact={f} api={api} onOpenSource={onOpenSource} onDone={onDone} onError={onError} />
          ))}
        </ul>
      )}
    </section>
  );
}

function FactRow({ fact, api, onOpenSource, onDone, onError }: Omit<Props, "facts"> & { fact: Fact }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(fact.value);
  // The page re-reads every few seconds. An open edit stays pinned to the version
  // it started from, so a change made elsewhere meanwhile is refused, not overwritten.
  const [base, setBase] = useState({ version: fact.version, value: fact.value });
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const evidence = fact.evidence[0];

  async function run(fn: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    onError(null);
    try {
      await fn();
    } catch (e) {
      onError(friendlyError(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  const save = () =>
    run(async () => {
      const value = draft.trim();
      if (!value) throw new Error("Write the fact before saving it.");
      if (value.length > 1000) throw new Error("Keep a fact under 1,000 characters.");
      const before = base.value;
      const r = await api<{ id: string; version: number; unchanged: boolean }>(`/claims/${fact.id}/revise`, {
        expected_version: base.version,
        value,
      });
      setEditing(false);
      if (r.unchanged) {
        await onDone("Nothing changed.");
        return;
      }
      await onDone(`Saved as version ${r.version}.`, async () => {
        await api(`/claims/${fact.id}/revise`, { expected_version: r.version, value: before });
      });
    });

  const stillTrue = () =>
    run(async () => {
      await api(`/claims/${fact.id}/confirm`, {});
      await onDone("Marked as still true.");
    });

  if (editing)
    return (
      <li className="yb-item">
        <div className="yb-fix">
          <label className="yb-eyebrow" htmlFor={`yb-ef-${fact.id}`}>
            Edit fact
          </label>
          <textarea
            id={`yb-ef-${fact.id}`}
            rows={2}
            maxLength={1000}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setEditing(false);
            }}
          />
          <div className="tv-actions">
            <button type="button" className="tv-btn tv-primary tv-sm" disabled={busy} onClick={() => void save()}>
              Save as version {base.version + 1}
            </button>
            <button type="button" className="tv-btn tv-ghost tv-sm" disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
          <p className="tv-faint">The original stays as it was. Earlier versions stay in history.</p>
        </div>
      </li>
    );

  return (
    <li className="yb-item">
      <div className="yb-item-row">
        <p className="yb-fact">{fact.text}</p>
        {fact.editable && (
          <button
            type="button"
            className="tv-btn tv-ghost tv-sm"
            onClick={() => {
              setDraft(fact.value);
              setBase({ version: fact.version, value: fact.value });
              setEditing(true);
            }}
          >
            Edit
          </button>
        )}
      </div>
      <div className="yb-meta">
        {fact.stale ? (
          <span className="tv-tag tv-attn">Not checked since {shortDate(fact.checked_at)}</span>
        ) : (
          <span className="tv-tag tv-ok">Checked {shortDate(fact.checked_at)}</span>
        )}
        <span className="tv-faint">version {fact.version}</span>
        {fact.stale && (
          <button type="button" className="tv-link" disabled={busy} onClick={() => void stillTrue()}>
            Still true
          </button>
        )}
        {evidence && (
          <button
            type="button"
            className="tv-link"
            onClick={() => onOpenSource(evidence.source_id, { quote: evidence.quote, factId: fact.id })}
          >
            Open the original
          </button>
        )}
      </div>
    </li>
  );
}
```

Add to `apps/web/brain/brain.css`:

```css
.yb-fix { display: grid; gap: 8px; }
.yb-fix textarea { width: 100%; box-sizing: border-box; font: inherit; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--line); background: var(--surface); color: inherit; resize: vertical; }
.yb-fix textarea:focus-visible { outline: 2px solid var(--green); outline-offset: 2px; }
```

- [ ] **Step 4: Mount it**

In `BrainView.tsx`:
1. Import `TrueNow`.
2. Replace `{/* Task 6 adds TrueNow here. */}` with:

```tsx
              <TrueNow
                api={api}
                facts={view.facts}
                onOpenSource={props.onOpenSource}
                onDone={done}
                onError={setActionError}
              />
```

- [ ] **Step 5: Run the tests, typecheck, lint**

Run: `npm run typecheck && npm run lint && npm run build && npx playwright test tests/e2e/your-brain-v2.spec.ts --workers=1`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git restore docs/screenshots 2>/dev/null || true
git add apps/web/brain/TrueNow.tsx apps/web/brain/BrainView.tsx apps/web/brain/brain.css tests/e2e/your-brain-v2.spec.ts
git commit -m "feat: True now with versioned edits, Undo and Still true"
```

---

### Task 7: Open questions

**Files:**
- Create: `apps/web/brain/OpenQuestions.tsx`
- Modify: `apps/web/brain/BrainView.tsx` (mount it)
- Test: `tests/e2e/your-brain-v2.spec.ts`

**Interfaces:**
- Consumes: `ProjectView.questions` and `questions_total`, `POST /api/v1/questions/answer` (Task 2), `Done` (Task 5)
- Produces: `export function OpenQuestions(props: { api: Api; projectId: string; questions: OpenQuestion[]; total: number; onOpenSource: (id: string, opts?: OpenSourceOptions) => void; onDone: Done; onError: (message: string | null) => void }): JSX.Element`

- [ ] **Step 1: Add the failing browser test**

```ts
test("an open question can be marked answered and brought back", async ({ browser }) => {
  await journey(browser, async (page) => {
    await save(page, "Launch notes\nOpen question: who writes the launch post?");
    await openBrain(page);
    const questions = page.getByRole("region", { name: "Open questions" });
    const item = questions.getByRole("listitem").filter({ hasText: "who writes the launch post?" });
    await expect(item).toBeVisible();
    await item.getByRole("button", { name: "Mark answered" }).click();
    const toast = page.locator(".tv-toast");
    await expect(toast).toContainText("Marked as answered.");
    await expect(item).toHaveCount(0);
    await expect(questions).toContainText("Nothing open.");
    await toast.getByRole("button", { name: "Undo" }).click();
    await expect(item).toHaveCount(1);
    await item.getByRole("button", { name: "Mark answered" }).click();
    await expect(item).toHaveCount(0);
    await page.reload();
    await openBrain(page);
    await expect(questions).toContainText("Nothing open.");
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npm run build && npx playwright test tests/e2e/your-brain-v2.spec.ts --workers=1 -g "open question"`
Expected: FAIL. There is no region "Open questions".

- [ ] **Step 3: Write `OpenQuestions.tsx`**

```tsx
// apps/web/brain/OpenQuestions.tsx
import { useState } from "react";
import { friendlyError } from "../today/BriefCard.tsx";
import { shortDate } from "./format.ts";
import type { Api, Done, OpenQuestion, OpenSourceOptions } from "./types.ts";

type Props = {
  api: Api;
  projectId: string;
  questions: OpenQuestion[];
  total: number;
  onOpenSource: (id: string, opts?: OpenSourceOptions) => void;
  onDone: Done;
  onError: (message: string | null) => void;
};

export function OpenQuestions({ api, projectId, questions, total, onOpenSource, onDone, onError }: Props) {
  const [busy, setBusy] = useState(false);
  async function answer(q: OpenQuestion) {
    if (busy) return;
    setBusy(true);
    onError(null);
    try {
      await api("/questions/answer", { project_id: projectId, signature: q.signature, answered: true });
      await onDone("Marked as answered.", async () => {
        await api("/questions/answer", { project_id: projectId, signature: q.signature, answered: false });
      });
    } catch (e) {
      onError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="tv-section" aria-labelledby="yb-q-h">
      <div className="tv-section-head">
        <h3 id="yb-q-h">Open questions</h3>
        <span className="tv-faint">Found in your originals</span>
      </div>
      {questions.length === 0 ? (
        <p className="tv-faint">
          Nothing open. A line that starts with “Open question:”, or a question in a short note, shows up here.
        </p>
      ) : (
        <ul className="yb-list">
          {questions.map((q) => (
            <li key={q.signature} className="yb-item">
              <div className="yb-item-row">
                <p className="yb-fact">{q.text}</p>
                <button type="button" className="tv-btn tv-ghost tv-sm" disabled={busy} onClick={() => void answer(q)}>
                  Mark answered
                </button>
              </div>
              <div className="yb-meta">
                <span className="tv-faint">
                  {q.source_title} · {shortDate(q.captured_at)}
                </span>
                <button
                  type="button"
                  className="tv-link"
                  onClick={() => onOpenSource(q.evidence.source_id, { quote: q.evidence.quote })}
                >
                  Open the original
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {total > questions.length && (
        <p className="tv-faint">
          Showing {questions.length} of {total} open questions.
        </p>
      )}
    </section>
  );
}
```

- [ ] **Step 4: Mount it**

In `BrainView.tsx`:
1. Import `OpenQuestions`.
2. Replace `{/* Task 7 adds OpenQuestions here. */}` with:

```tsx
              <OpenQuestions
                api={api}
                projectId={projectId}
                questions={view.questions}
                total={view.questions_total}
                onOpenSource={props.onOpenSource}
                onDone={done}
                onError={setActionError}
              />
```

- [ ] **Step 5: Run, typecheck, lint, commit**

```bash
npm run typecheck && npm run lint && npm run build && npx playwright test tests/e2e/your-brain-v2.spec.ts --workers=1
git restore docs/screenshots 2>/dev/null || true
git add apps/web/brain/OpenQuestions.tsx apps/web/brain/BrainView.tsx tests/e2e/your-brain-v2.spec.ts
git commit -m "feat: open questions with Mark answered and Undo"
```

---

### Task 8: The source view: highlighted passage, fact history, and facts taken from it

**Files:**
- Create: `apps/web/brain/highlight.ts`, `apps/web/brain/SourceView.tsx`
- Modify:
  - `apps/web/src.tsx`: the source dialog body, and removal of the "Current understanding" block and the `edit-brief` and `continue` dialogs
  - `apps/web/today/BriefCard.tsx` and `apps/web/today/SaveAskBar.tsx`: pass the quote and fact through
  - `apps/web/brain/brain.css`
- Test: `tests/integration/highlight.test.ts`, `tests/e2e/your-brain-v2.spec.ts`

**Interfaces:**
- Consumes:
  - `GET /api/v1/brain/projects/:id` (Task 2), used to find the facts that cite this original
  - `GET /api/v1/claims/:id/history` (Task 3)
  - `OpenSourceOptions` (Task 5)
- Produces:
  - `export type Range = { start: number; end: number }`
  - `export type Segment = { text: string; mark: boolean }`
  - `export function highlightSegments(body: string, ranges: Range[]): Segment[]`
  - `export function findQuote(body: string, quote: string): Range | null`
  - `export function evidenceRanges(body: string, evidence: { start: number; end: number; quote: string }[]): Range[]`
  - `export function SourceView(props: { api: Api; source: Source; quote?: string; factId?: string; projectTitle: string; actions: React.ReactNode }): JSX.Element`

- [ ] **Step 1: Write the failing unit test**

```ts
// tests/integration/highlight.test.ts
import { describe, expect, it } from "vitest";
import { evidenceRanges, findQuote, highlightSegments } from "../../apps/web/brain/highlight.ts";

describe("highlightSegments", () => {
  it("marks code-point ranges, merging overlaps, and keeps the whole text", () => {
    const body = "🧠 alpha beta gamma";
    const segs = highlightSegments(body, [
      { start: 2, end: 7 },
      { start: 5, end: 12 },
    ]);
    expect(segs).toEqual([
      { text: "🧠 ", mark: false },
      { text: "alpha beta", mark: true },
      { text: " gamma", mark: false },
    ]);
    expect(segs.map((s) => s.text).join("")).toBe(body);
  });

  it("ignores ranges outside the body and returns the plain body when nothing is marked", () => {
    expect(highlightSegments("short", [{ start: 3, end: 99 }, { start: 4, end: 2 }])).toEqual([
      { text: "short", mark: false },
    ]);
  });
});

describe("findQuote and evidenceRanges", () => {
  it("finds an exact quote in code points, and says null when it is gone", () => {
    expect(findQuote("🧠🧠 We decided that X.", "We decided")).toEqual({ start: 3, end: 13 });
    expect(findQuote("corrected text", "We decided")).toBeNull();
    expect(findQuote("anything", "")).toBeNull();
  });

  it("keeps only evidence whose text still matches its quote", () => {
    const body = "Alpha beta.";
    expect(
      evidenceRanges(body, [
        { start: 0, end: 5, quote: "Alpha" },
        { start: 0, end: 5, quote: "Other" },
      ]),
    ).toEqual([{ start: 0, end: 5 }]);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/integration/highlight.test.ts`
Expected: FAIL. It cannot resolve `highlight.ts`.

- [ ] **Step 3: Write `highlight.ts`**

```ts
// apps/web/brain/highlight.ts
export type Range = { start: number; end: number };
export type Segment = { text: string; mark: boolean };

/** Splits a body into plain and highlighted runs. Offsets count code points, like the server's evidence. */
export function highlightSegments(body: string, ranges: Range[]): Segment[] {
  const chars = Array.from(body);
  const valid = ranges
    .filter(
      (r) =>
        Number.isInteger(r.start) &&
        Number.isInteger(r.end) &&
        r.start >= 0 &&
        r.end > r.start &&
        r.end <= chars.length,
    )
    .sort((a, b) => a.start - b.start);
  const merged: Range[] = [];
  for (const r of valid) {
    const last = merged.at(-1);
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  const out: Segment[] = [];
  let at = 0;
  for (const r of merged) {
    if (r.start > at) out.push({ text: chars.slice(at, r.start).join(""), mark: false });
    out.push({ text: chars.slice(r.start, r.end).join(""), mark: true });
    at = r.end;
  }
  if (at < chars.length || out.length === 0) out.push({ text: chars.slice(at).join(""), mark: false });
  return out;
}

/** Where an exact quote first appears, in code points. Null when it is not there. */
export function findQuote(body: string, quote: string): Range | null {
  if (!quote) return null;
  const at = body.indexOf(quote);
  if (at < 0) return null;
  const start = Array.from(body.slice(0, at)).length;
  return { start, end: start + Array.from(quote).length };
}

/** Keeps only evidence whose text still matches the quote it claims to show. */
export function evidenceRanges(body: string, evidence: { start: number; end: number; quote: string }[]): Range[] {
  const chars = Array.from(body);
  return evidence
    .filter((e) => chars.slice(e.start, e.end).join("") === e.quote)
    .map((e) => ({ start: e.start, end: e.end }));
}
```

Run: `npx vitest run tests/integration/highlight.test.ts`
Expected: PASS.

- [ ] **Step 4: Add the failing browser tests**

```ts
test("a fact opens its original with the passage highlighted and its history", async ({ browser }) => {
  await journey(browser, async (page) => {
    const body = "Kickoff notes.\nWe decided that Northstar beta is invite only.\nEverything else waits.";
    await save(page, body);
    await keepOnToday(page, "invite only");
    await openBrain(page);
    const facts = page.getByRole("region", { name: "True now" });
    await facts.getByRole("button", { name: "Edit" }).click();
    await facts.getByLabel("Edit fact").fill("invite only until launch");
    await facts.getByRole("button", { name: "Save as version 2" }).click();
    await expect(page.locator(".tv-toast")).toContainText("Saved as version 2.");
    await facts.getByRole("button", { name: "Open the original" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByTestId("original")).toHaveText(body);
    await expect(dialog.locator("mark")).toHaveCount(1);
    await expect(dialog.locator("mark")).toContainText("invite only");
    await expect(dialog.locator("mark")).not.toContainText("Everything else");
    const history = dialog.getByRole("region", { name: "History of this fact" });
    await expect(history.getByRole("listitem")).toHaveCount(2);
    await expect(history.getByRole("listitem").first()).toContainText("You edited this");
    await expect(history.getByRole("listitem").last()).toContainText("Kept from this original");
    await expect(dialog.getByRole("region", { name: "Facts taken from this" })).toContainText("invite only until launch");
    await expect(dialog.getByRole("button", { name: "Correct or move source" })).toBeVisible();
  });
});

test("a Brief card's quote opens the original with that passage highlighted", async ({ browser }) => {
  await journey(browser, async (page) => {
    await save(page, "Kickoff notes.\nWe decided that Northstar beta is invite only.");
    const card = page.getByRole("article").filter({ hasText: "invite only" });
    await card.locator(".tv-quote").first().click();
    await expect(page.getByRole("dialog").locator("mark")).toContainText("invite only");
  });
});
```

Run: `npm run build && npx playwright test tests/e2e/your-brain-v2.spec.ts --workers=1 -g "highlighted"`
Expected: FAIL. There is no `mark` in the dialog.

- [ ] **Step 5: Write `SourceView.tsx`**

```tsx
// apps/web/brain/SourceView.tsx
import { useEffect, useState, type ReactNode } from "react";
import type { Source } from "../../../packages/contracts/index.ts";
import { friendlyError } from "../today/BriefCard.tsx";
import { shortDate } from "./format.ts";
import { evidenceRanges, findQuote, highlightSegments } from "./highlight.ts";
import type { Api, Fact, FactHistoryEntry, ProjectView } from "./types.ts";

type Props = {
  api: Api;
  source: Source;
  quote?: string;
  factId?: string;
  projectTitle: string;
  /** The existing original actions: correct, add a fact, delete, earlier version. */
  actions: ReactNode;
};

const from = (origin: string) =>
  origin === "manual" ? "Saved by you" : origin.startsWith("agent:") ? "From an agent" : "Imported";

function historyNote(h: FactHistoryEntry, first: boolean) {
  if (h.status !== "current") return "No longer current";
  if (first) return h.edited_by_owner ? "Kept in your words" : "Kept from this original";
  return "You edited this";
}

export function SourceView({ api, source, quote, factId, projectTitle, actions }: Props) {
  const [facts, setFacts] = useState<Fact[] | null>(null);
  const [history, setHistory] = useState<FactHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setFacts(null);
    setError(null);
    api<ProjectView>(`/brain/projects/${encodeURIComponent(source.project_id)}`)
      .then((v) => {
        if (!live) return;
        setFacts(
          v.facts.filter((f) =>
            f.evidence.some((e) => e.source_id === source.id && e.source_version === source.version),
          ),
        );
      })
      .catch((e) => {
        if (!live) return;
        setFacts([]);
        setError(friendlyError(e));
      });
    return () => {
      live = false;
    };
  }, [api, source.id, source.version, source.project_id]);

  useEffect(() => {
    let live = true;
    setHistory(null);
    if (factId)
      api<FactHistoryEntry[]>(`/claims/${encodeURIComponent(factId)}/history`)
        .then((h) => {
          if (live) setHistory(h);
        })
        .catch(() => {
          if (live) setHistory([]);
        });
    return () => {
      live = false;
    };
  }, [api, factId]);

  const cited = (facts ?? []).flatMap((f) =>
    f.evidence.filter((e) => e.source_id === source.id && e.source_version === source.version),
  );
  const ranges = evidenceRanges(source.body, cited);
  const quoted = quote ? findQuote(source.body, quote) : null;
  if (quoted) ranges.push(quoted);
  const segments = highlightSegments(source.body, ranges);

  return (
    <div className="yb-source">
      <p className="tv-faint">
        {projectTitle} · {from(source.origin)} · Original version {source.version} ·{" "}
        {source.visibility === "private" ? "Private" : "Shareable within project"}
        {source.state !== "active" ? ` · ${source.state}` : ""}
      </p>
      <section className="yb-drawer-section" aria-labelledby="yb-src-orig-h">
        <h3 id="yb-src-orig-h" className="yb-eyebrow">
          Original
        </h3>
        {quote && !quoted && (
          <p className="tv-faint" role="note">
            That passage is no longer in this original. It may have been corrected.
          </p>
        )}
        <pre data-testid="original" className="yb-original">
          {segments.map((s, i) => (s.mark ? <mark key={i}>{s.text}</mark> : <span key={i}>{s.text}</span>))}
        </pre>
      </section>
      {actions}
      {error && (
        <p className="tv-error" role="alert">
          {error}
        </p>
      )}
      {factId && (
        <section className="yb-drawer-section" aria-labelledby="yb-src-hist-h">
          <h3 id="yb-src-hist-h" className="yb-eyebrow">
            History of this fact
          </h3>
          {history === null ? (
            <p className="tv-faint">Loading…</p>
          ) : history.length === 0 ? (
            <p className="tv-faint">History is unavailable right now.</p>
          ) : (
            <ol className="yb-history">
              {[...history].reverse().map((h) => (
                <li key={h.version}>
                  <span className="yb-v">v{h.version}</span>
                  <span>
                    <b>{h.text}</b>
                    <br />
                    <span className="tv-faint">
                      {historyNote(h, h.version === history[0].version)} · {shortDate(h.at)}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}
      <section className="yb-drawer-section" aria-labelledby="yb-src-facts-h">
        <h3 id="yb-src-facts-h" className="yb-eyebrow">
          Facts taken from this
        </h3>
        {facts === null ? (
          <p className="tv-faint">Loading…</p>
        ) : facts.length === 0 ? (
          <p className="tv-faint">None yet.</p>
        ) : (
          <ul className="yb-list">
            {facts.map((f) => (
              <li key={f.id} className="yb-item">
                <p className="yb-fact">{f.text}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
```

Add to `apps/web/brain/brain.css`:

```css
.yb-source { display: grid; gap: 18px; min-width: 0; }
.yb-drawer-section { display: grid; gap: 8px; min-width: 0; }
.yb-original mark { background: color-mix(in srgb, var(--green) 24%, transparent); color: inherit; border-radius: 3px; padding: 0 1px; }
.yb-history { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.yb-history li { display: grid; grid-template-columns: 34px minmax(0, 1fr); gap: 10px; }
.yb-v { color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; }
```

- [ ] **Step 6: Use it in the source dialog**

In `apps/web/src.tsx`:
1. Import `SourceView` from `./brain/SourceView.tsx` and `OpenSourceOptions` from `./today/types.ts`.
2. Let `openSource` carry the options:

```ts
  const [sourceView, setSourceView] = useState<OpenSourceOptions>({});
  async function openSource(id: string, opts: OpenSourceOptions = {}) {
    await act(async () => {
      setSource(await api(`/sources/${id}`));
      setSourceView(opts);
      setDialog("source");
    });
  }
```

   Pass `onOpenSource={(id, opts) => void openSource(id, opts)}` to both `TodayView` and `BrainView`. Every other `openSource(id)` call stays as it is; it opens with no highlight, which is correct for "Return to current original" and receipts.
3. In the `dialog === "source" && source` modal, replace everything between `<Modal … dataUi="source-viewer">` and `</Modal>` with the code below. Keep the four action buttons exactly as they are today, moved into `actions`.

```tsx
              <SourceView
                api={api}
                source={source}
                quote={sourceView.quote}
                factId={sourceView.factId}
                projectTitle={projectName(source.project_id)}
                actions={
                  <div className="actions">
                    <button
                      onClick={() => {
                        setBody(source.body);
                        setNewTitle(source.title);
                        setCaptureScope(source.project_id);
                        setVisibility(source.visibility);
                        setDialog("edit-source");
                      }}
                    >
                      Correct or move source
                    </button>
                    <button
                      onClick={() => {
                        setClaimEntity("");
                        setClaimKind("status");
                        setClaimStatus("active");
                        setClaimMeaning("");
                        setClaimQuote(source.body.slice(0, 300));
                        setDialog("propose-claim");
                      }}
                    >
                      Add a fact for review
                    </button>
                    <button
                      onClick={() => {
                        setConfirmation("");
                        setDialog("delete");
                      }}
                    >
                      Delete / withdraw
                    </button>
                    {source.version > 1 ? (
                      <button
                        onClick={() =>
                          void act(async () => {
                            setSource(await api(`/sources/${source.id}?version=${source.version - 1}`));
                            setDialog("history");
                          })
                        }
                      >
                        Earlier version
                      </button>
                    ) : null}
                  </div>
                }
              />
```

These four buttons are the existing ones, moved unchanged. Check them against the current file before deleting the old block.

This removes:
- the `<details open><summary>Retained original</summary>…` block, which `SourceView` replaces
- the `<hr />`, the "Current understanding" heading, the brief items, "Edit understanding", "Continue in another agent" and "Rebuild preview"

Then delete the `dialog === "edit-brief"` and `dialog === "continue"` modals. Delete any state, helper or import left without a reader, checking each with `grep` before deleting: `brief`/`setBrief`, `briefText`/`setBriefText`, `currentBrief` and `markdown` if unused. `npm run lint` and `npm run typecheck` decide.

In `apps/web/today/BriefCard.tsx`:
1. Widen the prop to `onOpenSource: (id: string, opts?: OpenSourceOptions) => void;` and import `OpenSourceOptions` from `./types.ts`.
2. Change the quote button to `onClick={() => onOpenSource(e.source_id, { quote: e.quote })}`.
3. In the `t.type === "claim"` branch, change it to `if (source) onOpenSource(source, { quote: item.evidence[0]?.quote, factId: t.id });`.

In `apps/web/today/SaveAskBar.tsx`:
1. Widen the prop the same way.
2. Change the hit button to `onClick={() => (quote ? onOpenSource(quote.source_id, { quote: quote.quote, factId: h.id }) : onOpenSource(h.id))}`.

- [ ] **Step 7: Run the tests, typecheck, lint**

Run: `npm run typecheck && npm run lint && npm run build && npx playwright test tests/e2e/your-brain-v2.spec.ts tests/e2e/today-v2.spec.ts tests/e2e/today-v2-bar.spec.ts tests/e2e/first-note-lifecycle-review.spec.ts --workers=1`
Expected: all PASS. The bar spec's withdraw test still finds "Delete / withdraw" and "Withdraw from active use".

- [ ] **Step 8: Commit**

```bash
git restore docs/screenshots 2>/dev/null || true
git add apps/web/brain/highlight.ts apps/web/brain/SourceView.tsx apps/web/brain/brain.css apps/web/src.tsx apps/web/today/BriefCard.tsx apps/web/today/SaveAskBar.tsx tests/integration/highlight.test.ts tests/e2e/your-brain-v2.spec.ts
git commit -m "feat: originals open with the cited passage highlighted and the fact's history"
```

---

### Task 9: Search your brain

**Files:**
- Create: `apps/web/brain/BrainSearch.tsx`
- Modify: `apps/web/brain/BrainView.tsx` (mount it and hide the project layout while searching), `apps/web/brain/brain.css`
- Test: `tests/e2e/your-brain-v2.spec.ts`

**Interfaces:**
- Consumes: `GET /api/v1/brain/search?q=` (Task 4), `SearchResults` (Task 5)
- Produces: `export function BrainSearch(props: { api: Api; projects: { id: string; title: string }[]; query: string; onQuery: (q: string) => void; onOpenSource: (id: string, opts?: OpenSourceOptions) => void }): JSX.Element`

- [ ] **Step 1: Add the failing browser test**

```ts
test("search finds facts and originals and opens them; one letter sends nothing", async ({ browser }) => {
  await journey(browser, async (page) => {
    await save(page, "We decided that Northstar beta is invite only.");
    await keepOnToday(page, "invite only");
    await save(page, "Long retained passage. ".repeat(60) + "ZEBRA_SENTINEL lives at the end.");
    await openBrain(page);
    let sent = 0;
    await page.route("**/api/v1/brain/search*", (route) => {
      sent += 1;
      return route.fallback();
    });
    const search = page.getByLabel("Search your brain");
    await search.fill("n");
    await expect(page.getByText("Type at least two letters.")).toBeVisible();
    await page.waitForTimeout(400);
    expect(sent).toBe(0);
    await search.fill("northstar");
    await expect(page.getByRole("heading", { name: "Facts" })).toBeVisible();
    await expect(page.getByRole("region", { name: /match/ })).toContainText("invite only");
    await search.fill("ZEBRA_SENTINEL");
    const hit = page.getByRole("button", { name: /ZEBRA_SENTINEL/ });
    await expect(hit).toBeVisible();
    await hit.click();
    await expect(page.getByTestId("original")).toContainText("ZEBRA_SENTINEL lives at the end.");
    await page.getByRole("button", { name: "Close dialog" }).click();
    await search.fill("nothing-like-this-anywhere");
    await expect(page.getByText("No matches. Try a different word, or save something new.")).toBeVisible();
    await page.getByRole("button", { name: "Clear search" }).click();
    await expect(page.getByRole("heading", { name: "Inbox", level: 2 })).toBeVisible();
  });
});

test("a late answer to an earlier search never replaces newer results", async ({ browser }) => {
  await journey(browser, async (page) => {
    await save(page, "Northstar beta note.");
    await save(page, "Zebra archive note.");
    await openBrain(page);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route(
      (url) => url.pathname === "/api/v1/brain/search" && url.searchParams.get("q") === "northstar",
      async (route) => {
        await held;
        await route.fallback();
      },
    );
    const search = page.getByLabel("Search your brain");
    await search.fill("northstar");
    await page.waitForTimeout(400);
    await search.fill("zebra");
    await expect(page.getByRole("button", { name: /Zebra archive/ })).toBeVisible();
    release();
    await page.waitForTimeout(500);
    await expect(page.getByRole("button", { name: /Zebra archive/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Northstar beta/ })).toHaveCount(0);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npm run build && npx playwright test tests/e2e/your-brain-v2.spec.ts --workers=1 -g "search"`
Expected: FAIL. There is no field labelled "Search your brain".

- [ ] **Step 3: Write `BrainSearch.tsx`**

```tsx
// apps/web/brain/BrainSearch.tsx
import { useEffect, useRef, useState } from "react";
import { friendlyError } from "../today/BriefCard.tsx";
import type { Api, OpenSourceOptions, SearchResults } from "./types.ts";

type Props = {
  api: Api;
  projects: { id: string; title: string }[];
  query: string;
  onQuery: (q: string) => void;
  onOpenSource: (id: string, opts?: OpenSourceOptions) => void;
};

export function BrainSearch({ api, projects, query, onQuery, onOpenSource }: Props) {
  const [results, setResults] = useState<SearchResults | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Only the response to the newest query may land.
  const seq = useRef(0);
  const q = query.trim();

  useEffect(() => {
    const mine = ++seq.current;
    setError(null);
    setResults(null);
    if (q.length < 2) return;
    const timer = window.setTimeout(() => {
      api<SearchResults>(`/brain/search?q=${encodeURIComponent(q)}`)
        .then((r) => {
          if (mine === seq.current) setResults(r);
        })
        .catch((e) => {
          if (mine === seq.current) setError(friendlyError(e));
        });
    }, 200);
    return () => window.clearTimeout(timer);
  }, [api, q]);
  useEffect(
    () => () => {
      seq.current += 1;
    },
    [],
  );

  const title = (id: string) => projects.find((p) => p.id === id)?.title ?? "Project";
  const count = results ? results.facts.length + results.originals.length : 0;
  return (
    <div className="yb-search">
      <label className="tv-sr" htmlFor="yb-q">
        Search your brain
      </label>
      <input
        id="yb-q"
        className="yb-field"
        type="search"
        placeholder="Search facts and originals"
        maxLength={200}
        value={query}
        onChange={(e) => onQuery(e.target.value)}
      />
      {q && (
        <section className="tv-section" aria-labelledby="yb-results-h" aria-live="polite">
          <div className="tv-section-head">
            <h2 id="yb-results-h">
              {q.length < 2 ? "Search" : results ? `${count} ${count === 1 ? "match" : "matches"}` : "Searching…"}
            </h2>
            <button type="button" className="tv-link" onClick={() => onQuery("")}>
              Clear search
            </button>
          </div>
          {q.length < 2 && <p className="tv-faint">Type at least two letters.</p>}
          {error && (
            <p className="tv-error" role="alert">
              {error}
            </p>
          )}
          {results && count === 0 && (
            <p className="tv-faint">No matches. Try a different word, or save something new.</p>
          )}
          {results && results.facts.length > 0 && (
            <>
              <h3 className="yb-eyebrow">Facts</h3>
              <ul className="yb-list">
                {results.facts.map((f) => {
                  const e = f.evidence[0];
                  return (
                    <li key={f.id} className="yb-item">
                      <div className="yb-meta">
                        <span className="tv-tag tv-ok">Fact</span>
                        <span className="tv-faint">{title(f.project_id)}</span>
                      </div>
                      <p className="yb-fact">{f.text}</p>
                      {e && (
                        <button
                          type="button"
                          className="tv-link"
                          onClick={() => onOpenSource(e.source_id, { quote: e.quote, factId: f.id })}
                        >
                          Open the original
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
          {results && results.originals.length > 0 && (
            <>
              <h3 className="yb-eyebrow">Originals</h3>
              <ul className="yb-list">
                {results.originals.map((o) => (
                  <li key={o.id}>
                    <button type="button" className="yb-hit" onClick={() => onOpenSource(o.id)}>
                      <span className="yb-hit-title">{o.title}</span>
                      <span className="yb-hit-snippet">{o.snippet}</span>
                      <span className="tv-faint">{title(o.project_id)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}
    </div>
  );
}
```

The "Facts" heading is an `h3` with the eyebrow style, so `getByRole("heading", { name: "Facts" })` finds it.

Add to `apps/web/brain/brain.css`:

```css
.yb-search { display: grid; gap: 14px; min-width: 0; }
.yb-field { width: 100%; box-sizing: border-box; font: inherit; padding: 11px 14px; border-radius: 10px; border: 1px solid var(--line); background: var(--surface); color: inherit; }
.yb-hit { width: 100%; display: grid; gap: 4px; min-width: 0; text-align: left; font: inherit; padding: 12px 14px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); color: inherit; cursor: pointer; }
.yb-hit-title { font-weight: 700; overflow-wrap: anywhere; }
.yb-hit-snippet { overflow-wrap: anywhere; }
```

- [ ] **Step 4: Mount it**

In `BrainView.tsx`:
1. Import `BrainSearch`.
2. Add `const [query, setQuery] = useState("");` and reset it when the project changes: add `setQuery("")` to the `[projectId]` effect.
3. Replace `{/* Task 9 adds BrainSearch here. */}` with:

```tsx
      <BrainSearch
        api={api}
        projects={props.projects}
        query={query}
        onQuery={setQuery}
        onOpenSource={props.onOpenSource}
      />
```

4. Wrap the `<div className="yb-layout">…</div>` as `{query.trim() ? null : ( <div className="yb-layout">…</div> )}`.

- [ ] **Step 5: Run, typecheck, lint, commit**

```bash
npm run typecheck && npm run lint && npm run build && npx playwright test tests/e2e/your-brain-v2.spec.ts --workers=1
git restore docs/screenshots 2>/dev/null || true
git add apps/web/brain/BrainSearch.tsx apps/web/brain/BrainView.tsx apps/web/brain/brain.css tests/e2e/your-brain-v2.spec.ts
git commit -m "feat: search facts and originals from Your brain"
```

---

### Task 10: Bring the old browser tests in line

**Files:**
- Create: `tests/e2e/review-journeys.spec.ts`. Tests that keep a suggestion move here from shared-server files, so Today's Brief holds only their own items.
- Modify:
  - `tests/e2e/app.spec.ts`
  - `tests/e2e/context-conflicts.spec.ts` (moved into `review-journeys.spec.ts`, then deleted)
  - `tests/e2e/memory-understanding.spec.ts` (moved into `review-journeys.spec.ts`, then deleted)
  - `tests/e2e/agent-continuity.spec.ts`
  - `tests/e2e/proactive-goal.spec.ts`
  - `tests/e2e/first-note.spec.ts`
  - `tests/e2e/capture-boundaries-review.spec.ts`
  - `tests/e2e/capture-release-review.spec.ts`
  - `tests/e2e/managed.spec.ts` (label-only)
- Delete: `tests/e2e/project-focus.spec.ts` (retired; see Step 6)

**Interfaces:**
- Consumes: Your brain v2 labels from Tasks 5–9, and Today's "Keep as true" and "Dismiss" from Today v2.

Rules for every port:

1. **Accepting a memory** moves from Your brain to Today: `page.getByRole("article").filter({ hasText: <the fact's words> }).getByRole("button", { name: "Keep as true" })`. Wait for that card to disappear (`toHaveCount(0)`) before asserting anything else.
2. **Isolated tests only.** A test that keeps a suggestion must run on `firstNoteFixture`. Tests already on the fixture just switch to Today. Tests on the shared `main` server move into `review-journeys.spec.ts` and use the fixture there.
3. **`page.request` does not go through the fixture's routes.** Replace it with the in-page helper below. If an agent endpoint refuses the owner session under the fixture, assert the same invariant through True now instead, and say so in the commit message.

```ts
const getJson = (page: Page, url: string) =>
  page.evaluate(async (u) => (await fetch(u, { credentials: "same-origin" })).json(), url);
```

4. **Label renames:**

| Old | New |
| --- | --- |
| `getByLabel("Search saved material")` | `getByLabel("Search your brain")` |
| `getByPlaceholder("Find a note or conversation…")` | `getByLabel("Search your brain")` |
| heading "No matching notes." | text "No matches. Try a different word, or save something new." |
| `getByLabel("Project", { exact: true }).selectOption({ label: X })` | `page.getByRole("navigation", { name: "Projects" }).getByRole("button", { name: X }).click()` |

5. **A test that fails for any other reason is a real finding.** Report it. Do not loosen it.

- [ ] **Step 1: Create `review-journeys.spec.ts` with the shared helpers**

```ts
// tests/e2e/review-journeys.spec.ts
import { expect, test, type Browser, type Page } from "@playwright/test";
import { firstNoteFixture } from "../helpers/first-note-browser.ts";

// Journeys that keep a suggestion run on their own brain, so Today's Brief holds only their items.
async function journey(browser: Browser, run: (page: Page) => Promise<void>) {
  const context = await browser.newContext();
  const fixture = await firstNoteFixture(context);
  const page = await context.newPage();
  try {
    await fixture.open(page);
    await run(page);
  } finally {
    await fixture.close();
  }
}
const getJson = (page: Page, url: string) =>
  page.evaluate(async (u) => (await fetch(u, { credentials: "same-origin" })).json(), url);
async function saveInDialog(page: Page, title: string, body: string) {
  await page.getByRole("button", { name: "Save something", exact: false }).first().click();
  await page.getByLabel("Title", { exact: true }).fill(title);
  await page.getByLabel("Paste something you are working on").fill(body);
  await page.getByRole("dialog").getByRole("button", { name: "Save to my brain", exact: true }).click();
  await expect(page.getByTestId("original")).toContainText(body);
  await page.getByRole("button", { name: "Close dialog" }).click();
}
async function keep(page: Page, hasText: string) {
  await page.getByRole("button", { name: "Today", exact: true }).click();
  const card = page.getByRole("article").filter({ hasText });
  await card.getByRole("button", { name: "Keep as true" }).click();
  await expect(card).toHaveCount(0);
}
```

- [ ] **Step 2: Port the shared-server review journeys into it**

**`app.spec.ts` "ordinary capture becomes reviewed current truth and agent retrieval".** Move it here, worked in full as the pattern for the others:

```ts
test("ordinary capture becomes reviewed current truth and agent retrieval", async ({ browser }) => {
  await journey(browser, async (page) => {
    const entity = `browser${Date.now()}`;
    await saveInDialog(page, "Current truth evidence", `${entity} status active`);
    await keep(page, entity);
    await page.getByRole("button", { name: "Your brain", exact: true }).click();
    await expect(page.getByRole("region", { name: "True now" })).toContainText(`${entity} is active.`);
    const search = await getJson(page, `/api/v1/agent/search?project_id=inbox&query=${entity}`);
    expect(JSON.stringify(search)).toContain('"value":"active"');
    const ask = await getJson(page, `/api/v1/agent/ask?project_id=inbox&question=${entity}%20status`);
    expect(ask.abstained).toBe(false);
  });
});
```

Then remove the test from `app.spec.ts`.

**`app.spec.ts` "owner promotes an exact passage from ordinary prose through review".**
- Move it here the same way.
- Its "Add a fact for review" dialog is unchanged.
- The suggestion it creates is kept on Today with `keep(page, <entity>)` instead of "Accept reviewed claim" in Your brain.

**`context-conflicts.spec.ts`.** Move its one test here as "browser keeps, compares, dismisses and undoes source-cited decision corrections". Port its steps as follows:

| Old step | New step |
| --- | --- |
| `save(value)` | `saveInDialog(page, \`Browser decision ${value}\`, \`${key}: ${value}\`)` |
| Accepting the first value | `keep(page, \`${key}: free\`)` |
| `current(v)` | `getJson(page, \`/api/v1/agent/ask?project_id=inbox&question=${encodeURIComponent(key)}\`)` and assert `answer` contains `statement: ${v}` |
| After saving "paid": `pending()` showed both values | On Today, `page.getByRole("article").filter({ hasText: "paid" })` contains `free` (the earlier value) and `paid` |
| "Approve exact correction" | `keep(page, "paid")` |
| "Reviewed decision history" and "Undo correction" | Unchanged labels, now in Your brain: open Your brain, click the "Reviewed decision history" summary, then "Undo correction" in the article headed `${key.toLowerCase()}: paid`. Assert `current("free")` and that the article says "Undone by you". |
| "Keep earlier decision" for "sponsored" | On Today, the correction card's "Dismiss". Then wait for the 6-second undo window to pass while staying on Today (`await page.waitForTimeout(6500)`), and assert `current("free")` |

Delete `context-conflicts.spec.ts` once its test passes here.

**`memory-understanding.spec.ts`.** Move both tests here. In each, replace the Your brain `candidate` lookup and "Accept reviewed claim" with:
- before keeping: assert the Today card is visible (`page.getByRole("article").filter({ hasText: entity })`) and contains the value
- then `keep(page, entity)`

Keep the agent `abstained` before and after checks through `getJson`. In the first test, replace `getByText("Current · reviewed by you")` with True now containing `November 12`. The "Found in ordinary language" and "Meaning supplied by you" labels belonged to the old panel. Drop those two assertions and say why in the commit message: Today cards explain where a suggestion came from in their own words, which Today v2 tests cover. Delete `memory-understanding.spec.ts` once both pass here.

- [ ] **Step 3: Port the fixture-based journeys in place**

**`proactive-goal.spec.ts`.** Replace the Your brain `memory` lookup and "Accept reviewed claim" with `keep`. It does not need the helper file: inline a two-line keep on Today with `getByRole("article")` and "Keep as true". Then click "Your brain" before "Choose a goal". The goal controls keep their labels in the Goals section.

**`agent-continuity.spec.ts`.** After "Review before sharing", accept on Today with "Keep as true" (inline, as above) instead of Your brain. The rest is unchanged: "New project", "Project name" and "Create project" are the same labels.

- [ ] **Step 4: Port the shared-server tests that only read or search**

**`app.spec.ts`:**

1. **"owner approves an agent intention into an actionable goal".** No change is expected: the intention is in "Needs a decision here" with the same `data-proposal-id` and "Approve intention". If `page.reload()` lands on Today, click "Your brain" again after the reload.
2. **"chat JSON import…".** Line 151 uses the placeholder. Rename it per rule 4.
3. **"real capture, evidence, editable understanding, download, correction, delete and reload".**
   - Rename it to "real capture, evidence, handoff download, correction, delete and reload".
   - Replace the `Continue in another agent`, `Edit understanding`, `Your understanding`, `Save understanding` and `bi-brain-brief.md` download steps with the code below. Ruling 7 removed those features; editing facts is covered in `your-brain-v2.spec.ts`.

```ts
  await page.getByRole("button", { name: "Close dialog" }).click();
  await page.getByRole("button", { name: "Your brain", exact: true }).click();
  await page.getByRole("button", { name: "Preview handoff" }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("dialog", { name: "Project handoff" }).getByRole("button", { name: "Download Markdown" }).click();
  expect((await downloadPromise).suggestedFilename()).toBe("bi-brain-handoff.md");
  await page.getByRole("button", { name: "Close dialog" }).click();
```

   - Keep the `source-preview.png` screenshot line before it; it now shows the new source view.
   - Rename the search label and the "No matching notes." heading per rule 4.
4. **"chosen goal prepares a hypothesis…".** Unchanged until line 332. Replace the `selectOption` with the Projects-list click (rule 4). "Edit plan" is in the Goals section.
5. **"invalid input remains editable, Markdown files persist…".**
   - Delete the "Continue in another agent", "Copy brief" and clipboard lines (411–417). The brief copy is gone (Ruling 7).
   - Keep the test's own invariants: the oversized draft stays, the Markdown file persists, and search matches beyond preview snippets.
   - Rename the search label per rule 4.

**Label-only ports (rule 4):**
- `first-note.spec.ts` lines 74–75
- `capture-boundaries-review.spec.ts` line 288
- `capture-release-review.spec.ts` line 43
- `managed.spec.ts`: the `searchBrain` helper at line 195, and the "No matching notes." heading at line 208

- [ ] **Step 5: Run every touched spec**

```bash
npm run build
npx playwright test tests/e2e/review-journeys.spec.ts tests/e2e/app.spec.ts tests/e2e/proactive-goal.spec.ts tests/e2e/agent-continuity.spec.ts tests/e2e/first-note.spec.ts tests/e2e/capture-boundaries-review.spec.ts tests/e2e/capture-release-review.spec.ts tests/e2e/managed.spec.ts tests/e2e/managed-ui-review.spec.ts --workers=1
```

Expected: all PASS. `managed-ui-review.spec.ts` needs no change. It opens "Synthetic private A note" from the Originals list by its title, and its account-switch tests must still find no dialog and no private text afterwards.

- [ ] **Step 6: Retire `project-focus.spec.ts`**

Delete it. Its invariants are now covered in `your-brain-v2.spec.ts`:

| Invariant | Covered by |
| --- | --- |
| The project page shows reviewed facts with their words | "True now" test |
| The handoff preview contains them | "Preview handoff" step |
| An original opens from the page | shell test |
| 320px dark with no horizontal scroll | shell test |

Its "Set project direction", "Open recent original 1" and overview checks were the old ProjectFocus component, which this plan removes.

- [ ] **Step 7: Commit, naming every retired or moved test and its reason**

```bash
git restore docs/screenshots 2>/dev/null || true
git add tests/e2e/review-journeys.spec.ts tests/e2e/app.spec.ts tests/e2e/proactive-goal.spec.ts tests/e2e/agent-continuity.spec.ts tests/e2e/first-note.spec.ts tests/e2e/capture-boundaries-review.spec.ts tests/e2e/capture-release-review.spec.ts tests/e2e/managed.spec.ts
git rm tests/e2e/context-conflicts.spec.ts tests/e2e/memory-understanding.spec.ts tests/e2e/project-focus.spec.ts
git commit -m "test: port browser journeys to Your brain v2 and review on Today

Moved to review-journeys.spec.ts on isolated brains: ordinary capture to
current truth, promoting an exact passage, decision corrections, and both
memory-understanding journeys. Retired project-focus.spec.ts (ProjectFocus
removed; its invariants are covered in your-brain-v2.spec.ts). Removed the
brief copy and Edit understanding steps (features removed in Ruling 7)."
```

---

### Task 11: Remove dead code, update the docs, verify everything

**Files:**
- Delete:
  - `apps/web/project-focus.tsx`, if no import remains
  - `CurrentKnowledge` from `apps/web/components.tsx`; keep `EvidenceList`
  - old Your brain CSS rules in `apps/web/style.css` and `apps/web/refinement.css` that match no element any more (`.brain-view`, `.knowledge-workspace`, `.claim-row`, `.project-focus*`, `.project-overview*`), checked with grep across `apps/web`
- Modify: `README.md`, `BUILD_STATE.md` (top section only)

- [ ] **Step 1: Delete what nothing imports**

```bash
grep -rn "project-focus.tsx\|ProjectFocus\|ProjectOverview\|CurrentKnowledge" apps/web
```

Delete each file or export only when grep shows no import outside its own file. For each CSS selector you delete, run `grep -rn "<class name>" apps/web --include=*.tsx` first, and delete only when nothing uses it.

- [ ] **Step 2: Update the docs**

In `README.md`, add a sentence after the Today v2 sentence: "Your brain shows each project's facts that are true now, its open questions and its originals, and opens any fact on its original with the passage highlighted and its history."

In `BUILD_STATE.md`, add a new top section "## 2026-10-23 — Your brain v2 (branch reframe/your-brain-v2)" with:
- what changed, three bullets
- the commands from Step 3 and their real counts
- known limits:
  - goals remain until Watch in plan 4
  - open questions are found by rule, not by a model
  - search is substring only until plan 5

- [ ] **Step 3: Full verification**

```bash
npm run typecheck
npm run lint
npm run build
npm run brain-eval
npx vitest run --reporter=dot
npx playwright test --workers=1
git restore docs/screenshots
```

Expected:
- typecheck, lint and build are clean, and brain-eval is 4/4.
- Vitest passes. If `spend-contention.test.ts` or `managed-decision-advisory-process.test.ts` fails under full-suite load, rerun it alone and record both results.
- Playwright passes every test in all four projects. Record the total.

- [ ] **Step 4: Commit**

```bash
git add README.md BUILD_STATE.md apps/web/components.tsx apps/web/style.css apps/web/refinement.css
git rm apps/web/project-focus.tsx
git commit -m "chore: remove the old Your brain components and record Your brain v2"
```

Leave the branch unpushed. The controller runs the final review and decides on the PR.
