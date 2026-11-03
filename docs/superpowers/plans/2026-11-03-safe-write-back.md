# Plan 8: Safe Write-Back Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every agent-written original a visible, enforced provenance (never pushed to another agent as the owner's evidence until reviewed), key the rate limiter on the real client and the session behind a proxy, close five small hardening gaps, then close the loop: a `Stop` hook that proposes a session note through the existing write-back path, and a "Bring in what you already have" import of the owner's existing agent instruction files on the empty Today.

**Architecture:** Provenance is derived from the existing `sources.origin` column plus one `settings` key per reviewed source (`source_reviewed:<id>`), read by one helper (`Brain.writtenBy`) and surfaced as an optional `written_by` field that exists only on agent-written items, so owner-only data and the plan-5 snapshot are byte-identical. The push cap reuses the level re-read that already handles already-seen hits. The session-end hook is a second command in the existing CLI (`bibrain hook-end`), posts raw marker-line text to one new agent route, and the server parses it by rule and hands it to the existing `agentNote` path, so the note is an ordinary agent-written original with ordinary Brief cards. The import is a third `kind` for the existing import adapter with one shared allowlist module.

**Tech Stack:** TypeScript, Node 24.19, Fastify 5 (`@fastify/rate-limit` `keyGenerator`, `trustProxy`), React 19, Vitest, Playwright, plain `.mjs` for the CLI.

**Spec:** `docs/superpowers/specs/2026-11-03-safe-write-back-design.md`. Read it first: it holds the invariants A1–A3, the parked list A4, the hook design B1 with the documentation citations, the import design B2 and the rulings R1–R10. The plan argues from it.

## Global Constraints

- Work only in the worktree `C:/Users/Gowrishankar/Desktop/Bi Brain/.worktrees/loop` on branch `reframe/safe-write-back`. Never write, create, delete or run git in the main checkout `C:/Users/Gowrishankar/Desktop/Bi Brain` outside `.worktrees/loop`.
- Never read `C:/Users/Gowrishankar/Desktop/Bi Brain/data/`, any `brain.sqlite` outside a test temp folder, or any `.env`. Never print a key.
- Never run the owner-only proof scripts (`scripts/native-client-proof.ts`, `scripts/system-one-live-proof.ts`, `scripts/recall-agent-proof.ts`, `scripts/better-search-proof.ts` with their live flag) or `npm run calibrate`.
- Zero edits to: any `dodo*`, `billing*`, `managed*`, `paddle*` file or test, `managedPreferencesPatchSchema`, any applied migration or `CREATE TABLE`, `docs/DODO_PAYMENTS.md`, `docs/RELEASE.md`, `docs/IMPLEMENTATION_PLAN.md`, `docs/PRICING_PROPOSAL_2026-10-21.md`, `docs/BUSINESS.md`.
- `tests/eval/recall-dense-off-snapshot.json` is not regenerated. If the snapshot test fails, the change is wrong, not the snapshot (R3).
- The repo is public: no exploit walkthroughs in code comments, tests or docs. State the invariant ("an unreviewed agent-written original never appears in a full push"), never a scenario.
- Copy rule (AGENTS.md): plain language in owner-facing text; no model names, no "MCP", no "token" in the page; uncertainty stated plainly. Agent-facing text states facts, never imperatives aimed at the agent, except the one sentence that asks for marker lines.
- Commit with explicit paths (`git add <file> ...`, never `git add .`). No rebase, no force-push, no bare `git stash`, no push. End every commit message with the trailer for the task's model: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` for Opus tasks, `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` for Sonnet tasks.
- If `git status` shows `apps/cli/bibrain.mjs` modified with no content change (line endings), run `git restore apps/cli/bibrain.mjs` before committing.
- Full Vitest runs use `npx vitest run --reporter=dot --maxWorkers=3`. After any Playwright run: `git restore docs/screenshots`. Before the full Vitest run, make sure `C:/Users/Gowrishankar/AppData/Local/Temp/opencode` exists (`mkdir -p`), or three frozen billing files fail on a missing fixture folder.
- ESLint treats unused variables as errors; typecheck is `tsc --noEmit` over the whole repo including tests.

## Review Focus

Classes most likely to bite a person, in order. Each has its pinning test in the task that owns the code.

1. **A `Stop` event that repeats the same message, or fires while a stop hook is already continuing the turn.** Claude Code and Codex send `Stop` at the end of every turn; a chatty session must not produce a note per turn and a continued turn must not be re-posted. Pinned in Task 10: the same message twice posts once; `stop_hook_active: true` posts nothing; the 13th distinct note in one session posts nothing.
2. **A forwarded address locally, and more than one proxy hop.** `X-Forwarded-For` from a local client must not move a request into another bucket, and behind a proxy only the proxy's hop is trusted. Pinned in Task 4: in local mode six requests with six different forwarded addresses share one bucket; in secure mode the address Caddy appends is the key and a forwarded Host is still refused.
3. **A session note whose marker line carries a secret-shaped value.** It must be quarantined by the existing capture rule and produce no Brief card and no recall hit, and the hook must have stayed quiet if the whole message looked like a secret. Pinned in Task 9 (server) and Task 10 (CLI).
4. **A picked folder that is a whole repository.** Thousands of files under `node_modules`, more than 50 instruction files, a 2 MiB `AGENTS.md`: only allowlisted paths are read, the batch limit yields one plain sentence, the big file is skipped with a warning and the rest import. Pinned in Task 12 (server rule) and Task 13 (page filter before any read).
5. **Review that does not stick, or sticks too widely.** Keeping a card whose evidence cites an agent note reviews that note and only that note; Dismiss reviews nothing; Undo does not un-review; an owner note is never marked. Pinned in Task 1.

---

### Task 1: Provenance in the domain (Opus)

**Files:**
- Create: `packages/domain/provenance.ts`
- Modify: `packages/domain/recall.ts:124-127` (`OriginalHit`), `:228-239` (`renderRecallText`)
- Modify: `packages/domain/service.ts` — constructor `:163-185`, `issueSession` `:271-281` (I1 rides here, one line), `source()` `:400-420`, `editSourceTx` `:1105-1130`, `removeSource` `:1180-1192`, `reviewGate` accept branch (search `v.action === "accept" && gate.data.field && gate.data.entity`), `recallInternal` original branch `:3880`, `agentOpen` `:3919-3950`
- Modify: `apps/mcp/surface.ts:49-52` (`originalHit` schema)
- Test: `tests/integration/provenance.test.ts` (new)

**Interfaces:**
- Consumes: `Brain.capture`, `Brain.agentNote`, `Brain.propose`, `Brain.reviewGate`, `Brain.recallCore`, `Brain.agentOpen`, `agentDisplayName` (`packages/domain/agents.ts`).
- Produces (later tasks rely on these exact names):
  - `packages/domain/provenance.ts`: `REVIEWED_KEY(id: string): string`, `BACKFILL_KEY = "provenance_backfill"`, `type WrittenBy = { agent: string; reviewed: boolean }`, `writtenByLabel(w: WrittenBy): string` → `"From <agent> · not yet reviewed"` / `"From <agent> · reviewed"`, `isUnreviewedAgent(h: { kind: string; written_by?: WrittenBy }): boolean`.
  - `OriginalHit.written_by?: WrittenBy`.
  - `Brain.sourceReviewedAt(id: string): string | null`, `Brain.writtenBy(source: { origin: string; id: string }): WrittenBy | undefined`, `Brain.markSourceReviewed(p: Principal, id: string): { source_id: string; reviewed_at: string }`, `Brain.sourceView(p: Principal, id: string, version?: number): Source & { written_by?: WrittenBy }`.

- [ ] **Step 1: Write the failing tests**

Create `tests/integration/provenance.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../../packages/storage/index.ts";
import { Brain } from "../../packages/domain/service.ts";
import { REVIEWED_KEY, writtenByLabel } from "../../packages/domain/provenance.ts";
import type { Principal } from "../../packages/contracts/index.ts";

const owner: Principal = { kind: "owner" };
let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.reverse()) fn();
  cleanup = [];
});
function setup(clock = "2026-11-03T09:00:00Z") {
  const dir = mkdtempSync(join(tmpdir(), "provenance-test-"));
  const s = new Storage(join(dir, "brain.sqlite"), { vault: join(dir, "vault") });
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  cleanup.push(() => {
    try {
      s.close();
    } catch {}
  });
  const b = new Brain(s, () => new Date(clock));
  const g = b.createGrant(owner, { projects: ["inbox"], operations: ["read", "propose_memory"], expires_at: "2026-12-03T09:00:00.000Z", client: "codex" });
  return { b, s, dir, grant: g, agent: b.authenticateAgent(g.token) };
}
const note = { project_id: "inbox", decisions: [{ topic: "queue", decision: "SQLite with leases" }], next_step: "Wire the lease recovery test." };

describe("provenance of agent-written originals", () => {
  it("labels an agent note unreviewed in recall and open, and leaves an owner note unlabelled", () => {
    const { b, agent } = setup();
    const mine = b.capture(owner, { title: "Queue plan", body: "The queue uses SQLite with leases, decided by me." }) as { source_id: string };
    const theirs = b.agentNote(agent, note);
    expect(b.sourceReviewedAt(theirs.source_id)).toBeNull();
    expect(b.writtenBy({ id: mine.source_id, origin: "manual" })).toBeUndefined();
    const hits = b.recallCore(owner, { query: "queue SQLite leases" }).hits;
    const agentHit = hits.find((h) => h.id === theirs.source_id)!;
    const ownerHit = hits.find((h) => h.id === mine.source_id)!;
    expect(agentHit).toMatchObject({ kind: "original", written_by: { agent: "Codex", reviewed: false } });
    expect(ownerHit).not.toHaveProperty("written_by");
    expect(JSON.stringify(ownerHit)).not.toContain("written_by");
    const opened = b.agentOpen(agent, { id: theirs.source_id }) as { item: { written_by?: unknown } };
    expect(opened.item.written_by).toEqual({ agent: "Codex", reviewed: false });
    expect(b.sourceView(owner, mine.source_id)).not.toHaveProperty("written_by");
    expect(writtenByLabel({ agent: "Codex", reviewed: false })).toBe("From Codex · not yet reviewed");
  });

  it("Keep reviews exactly the note the card cites; Dismiss reviews nothing; Undo does not un-review", () => {
    const { b, agent } = setup();
    const first = b.agentNote(agent, note);
    const second = b.agentNote(agent, { project_id: "inbox", decisions: [{ topic: "deploy", decision: "Thursdays" }] });
    const cards = b.brief(owner).items;
    const deploy = cards.find((c) => c.title.startsWith("deploy"))!;
    b.reviewGate(owner, deploy.target.id, { action: "reject", expected_version: deploy.target.version });
    expect(b.sourceReviewedAt(second.source_id)).toBeNull();
    const queue = cards.find((c) => c.title.startsWith("queue"))!;
    const r = b.reviewGate(owner, queue.target.id, { action: "accept", expected_version: queue.target.version });
    expect(b.sourceReviewedAt(first.source_id)).toBe("2026-11-03T09:00:00.000Z");
    expect(b.sourceReviewedAt(second.source_id)).toBeNull();
    expect(b.recallCore(agent, { query: "queue SQLite leases" }).hits.find((h) => h.id === first.source_id)).toMatchObject({ written_by: { agent: "Codex", reviewed: true } });
    b.reviewGate(owner, queue.target.id, { action: "undo", expected_version: r.gate_version });
    expect(b.sourceReviewedAt(first.source_id)).toBe("2026-11-03T09:00:00.000Z");
  });

  it("an owner edit or Mark as reviewed reviews the note; an owner note cannot be marked; a forgotten note loses its mark", () => {
    const { b, s, agent } = setup();
    const a = b.agentNote(agent, note);
    const c = b.agentNote(agent, { project_id: "inbox", open_questions: ["Which lease length?"] });
    const mine = b.capture(owner, { title: "Mine", body: "Owner text." }) as { source_id: string };
    expect(b.markSourceReviewed(owner, a.source_id)).toEqual({ source_id: a.source_id, reviewed_at: "2026-11-03T09:00:00.000Z" });
    expect(() => b.markSourceReviewed(agent, a.source_id)).toThrow(/Owner access required/);
    expect(() => b.markSourceReviewed(owner, mine.source_id)).toThrow(/not written by an agent/i);
    expect(() => b.markSourceReviewed(owner, "missing")).toThrow(/unavailable/i);
    const src = b.source(owner, c.source_id);
    b.editSource(owner, c.source_id, { title: src.title, body: src.body + "\nOwner addition.", expected_version: src.version });
    expect(b.sourceReviewedAt(c.source_id)).toBe("2026-11-03T09:00:00.000Z");
    b.removeSource(owner, c.source_id, 2, true);
    expect(s.get("SELECT value FROM settings WHERE key=?", REVIEWED_KEY(c.source_id))).toBeUndefined();
  });

  it("backfills once: agent notes cited by an accepted gate are reviewed, the rest stay unreviewed", () => {
    const { b, s, dir, agent } = setup();
    const kept = b.agentNote(agent, note);
    const open = b.agentNote(agent, { project_id: "inbox", decisions: [{ topic: "deploy", decision: "Thursdays" }] });
    const card = b.brief(owner).items.find((c) => c.title.startsWith("queue"))!;
    b.reviewGate(owner, card.target.id, { action: "accept", expected_version: card.target.version });
    // A brain from before this plan: no review marks and no backfill flag.
    s.run("DELETE FROM settings WHERE key LIKE 'source_reviewed:%' OR key='provenance_backfill'");
    s.close();
    const again = new Brain(new Storage(join(dir, "brain.sqlite"), { vault: join(dir, "vault") }), () => new Date("2026-11-04T09:00:00Z"));
    cleanup.push(() => again.store.close());
    expect(again.sourceReviewedAt(kept.source_id)).toBe("2026-11-03T09:00:00.000Z");
    expect(again.sourceReviewedAt(open.source_id)).toBeNull();
    expect(again.store.setting("provenance_backfill", 0)).toBe(1);
  });

  it("deletes expired owner sessions when a new one is issued", () => {
    const { b, s } = setup();
    s.run("INSERT INTO sessions VALUES('old','x','2026-11-01T00:00:00.000Z')");
    b.issueSession();
    expect(s.all("SELECT token_hash FROM sessions").map((r: any) => r.token_hash)).not.toContain("old");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/integration/provenance.test.ts`
Expected: FAIL (`provenance.ts` not found; `sourceReviewedAt` is not a function).

- [ ] **Step 3: Create the pure module**

Create `packages/domain/provenance.ts`:

```ts
/** Where the owner's review of an agent-written original is recorded: one settings key per source, an ISO time. Local state like Watch; never exported. */
export const REVIEWED_KEY = (sourceId: string) => `source_reviewed:${sourceId}`;
/** Set to 1 once the one-time backfill (agent originals cited by an accepted gate count as reviewed) has run on this database. */
export const BACKFILL_KEY = "provenance_backfill";
/** Present only on agent-written items. Owner-captured items never carry it. */
export type WrittenBy = { agent: string; reviewed: boolean };

export const isAgentOrigin = (origin: string) => origin.startsWith("agent:");
export const grantOfOrigin = (origin: string) => (isAgentOrigin(origin) ? origin.slice("agent:".length) : null);

export function writtenByLabel(w: WrittenBy): string {
  return `From ${w.agent} · ${w.reviewed ? "reviewed" : "not yet reviewed"}`;
}

/** An original hit another agent wrote that the owner has not reviewed: never the owner's evidence. */
export function isUnreviewedAgent(h: { kind: string; written_by?: WrittenBy }): boolean {
  return h.kind === "original" && h.written_by !== undefined && !h.written_by.reviewed;
}
```

- [ ] **Step 4: Extend the hit type and the text rendering**

In `packages/domain/recall.ts` add the import at the top:

```ts
import type { WrittenBy } from "./provenance.ts";
```

Change `OriginalHit` (lines 123-126) to:

```ts
export type OriginalHit = {
  kind: "original"; id: string; version: number; project: { id: string; title: string }; title: string; quote: string; start: number; end: number;
  captured_at: string; freshness: "current"; why: string[]; score: number;
  /** Only on agent-written originals: who wrote it and whether the owner has reviewed it. */
  written_by?: WrittenBy;
};
```

In `renderRecallText` (line 234) change the original line to:

```ts
        : `original ${h.id} v${h.version} · ${h.captured_at.slice(0, 10)} · ${h.freshness} · ${h.title}: ${h.quote}${h.written_by ? ` · written by ${h.written_by.agent}, ${h.written_by.reviewed ? "reviewed" : "not yet reviewed"}` : ""}`,
```

In `apps/mcp/surface.ts` change `originalHit` to add the optional field:

```ts
const originalHit = z.object({
  kind: z.literal("original"), id: z.string(), version: z.number(), project: projectRef, title: z.string(), quote: z.string(), start: z.number(), end: z.number(),
  captured_at: z.string(), freshness: z.literal("current"), why: z.array(z.string()), score: z.number(),
  written_by: z.object({ agent: z.string(), reviewed: z.boolean() }).optional(),
});
```

- [ ] **Step 5: Add the Brain helpers, the review marks and the backfill**

In `packages/domain/service.ts` add to the imports:

```ts
import { BACKFILL_KEY, REVIEWED_KEY, grantOfOrigin, type WrittenBy } from "./provenance.ts";
```

Give the constructor a body (replace the trailing `) {}` at line 185 with):

```ts
  ) {
    this.backfillProvenance();
  }
```

Add these methods right after `ownerPrincipal()`:

```ts
  /** When the owner reviewed an agent-written original, or null. Owner-captured originals are never marked. */
  sourceReviewedAt(sourceId: string): string | null {
    return this.store.setting<string | null>(REVIEWED_KEY(sourceId), null);
  }
  /** Who wrote an original, for agent-written ones only; undefined for the owner's own captures and imports. */
  writtenBy(source: { id: string; origin: string }): WrittenBy | undefined {
    const grantId = grantOfOrigin(source.origin);
    if (grantId === null) return undefined;
    const client = this.store.get<{ client: string | null }>("SELECT client FROM grants WHERE id=?", grantId)?.client;
    return { agent: agentDisplayName(client), reviewed: this.sourceReviewedAt(source.id) !== null };
  }
  /** Records the owner's review of an agent-written original. The first time stands; a second call changes nothing. */
  private reviewSource(sourceId: string) {
    const row = this.store.get<{ origin: string }>("SELECT origin FROM sources WHERE id=? AND state!='deleted'", sourceId);
    if (!row || grantOfOrigin(row.origin) === null) return;
    if (this.sourceReviewedAt(sourceId) === null) this.store.set(REVIEWED_KEY(sourceId), this.now());
  }
  markSourceReviewed(p: Principal, id: string) {
    this.owner(p);
    const s = this.source(p, z.string().min(1).max(100).parse(id));
    if (grantOfOrigin(s.origin) === null) throw new BrainError("INVALID_INPUT", "This original was not written by an agent.", 400);
    return this.store.transaction(() => {
      this.reviewSource(s.id);
      return { source_id: s.id, reviewed_at: this.sourceReviewedAt(s.id)! };
    });
  }
  /** An original with its provenance beside it, for the page and for brain_open. */
  sourceView(p: Principal, id: string, version?: number): Source & { written_by?: WrittenBy } {
    const s = this.source(p, id, version);
    const by = this.writtenBy(s);
    return by ? { ...s, written_by: by } : s;
  }
  /** One-time: an agent-written original that an accepted review cites counts as reviewed at that review's time. Everything else stays unreviewed. */
  private backfillProvenance() {
    if (this.store.setting<number>(BACKFILL_KEY, 0) === 1) return;
    this.store.transaction(() => {
      const gates = this.store.all<{ data: string; created_at: string }>("SELECT data,created_at FROM entities WHERE kind='gate'");
      for (const g of gates) {
        let d: any;
        try {
          d = JSON.parse(g.data);
        } catch {
          continue;
        }
        if (d?.status !== "accepted") continue;
        const at = typeof d.reviewed_at === "string" ? d.reviewed_at : g.created_at;
        const ids = new Set<string>([d.raw_id, ...((d.evidence ?? []) as { source_id?: unknown }[]).map((e) => e?.source_id)].filter((x): x is string => typeof x === "string"));
        for (const id of ids) {
          const row = this.store.get<{ origin: string }>("SELECT origin FROM sources WHERE id=?", id);
          if (row && grantOfOrigin(row.origin) !== null && this.sourceReviewedAt(id) === null) this.store.set(REVIEWED_KEY(id), at);
        }
      }
      this.store.set(BACKFILL_KEY, 1);
    });
  }
```

Check what `reviewGate` stores on accept: search `reviewed_at:` in the accept branch; if the gate data records `reviewed_at`, the backfill above reads it, otherwise `created_at` is used (both are fine; say which in the commit message).

In `issueSession()` add, before the `INSERT`:

```ts
    this.store.run("DELETE FROM sessions WHERE expires_at<=?", this.now());
```

In `reviewGate`, inside the `if (v.action === "accept" && gate.data.field && gate.data.entity) {` block, after `this.checkEvidence(p, gate.project_id, gate.data.evidence);` add:

```ts
        // Keeping or fixing a card is the owner's review of the originals it cites.
        for (const id of new Set<string>([gate.data.raw_id, ...(gate.data.evidence as Evidence[]).map((e) => e.source_id)].filter((x): x is string => typeof x === "string"))) this.reviewSource(id);
```

In `editSourceTx`, after the new version row is written (find the `INSERT INTO source_versions` in that method), add:

```ts
      this.reviewSource(id);
```

In `removeSource`, after `purgeRef(this.store, "original", id);` add:

```ts
        this.store.run("DELETE FROM settings WHERE key=?", REVIEWED_KEY(id));
```

In `recallInternal` (line 3880) change the pushed hit to carry the field only when present:

```ts
          const by = this.writtenBy(s);
          authorized.push({ candidate, hit: { kind: "original", id: s.id, version: s.version, project, title: s.title, quote, start: r.start, end: r.end, captured_at: s.captured_at, freshness: "current", why: [...whyFor(fts.terms, `${s.title} ${quote}`), ...denseWhy(candidate)], score: candidate.fused, ...(by ? { written_by: by } : {}) } });
```

In `agentOpen`, after `let item: { kind: string; item: unknown } = raw;` add:

```ts
    if (raw.kind === "source") {
      const by = this.writtenBy(raw.item as Source);
      if (by) item = { kind: "source", item: { ...(raw.item as Source), written_by: by } };
    }
```

Note that the `compare` block compares `before` against `raw` (the stored items), so the added field does not change `changed`.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/integration/provenance.test.ts tests/integration/recall-dense.test.ts tests/integration/agent-note.test.ts tests/integration/agent-recall-http.test.ts tests/integration/mcp-surface.test.ts`
Expected: PASS, including "equal the committed plan 5 snapshot byte for byte".

- [ ] **Step 7: Typecheck and commit**

Run: `npm run typecheck`
Expected: exit 0.

```bash
git add packages/domain/provenance.ts packages/domain/recall.ts packages/domain/service.ts apps/mcp/surface.ts tests/integration/provenance.test.ts
git commit -m "feat(provenance): agent-written originals carry written_by and a review state

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The push cap and the digest labels (Opus)

**Files:**
- Modify: `packages/domain/recall-push.ts:95-107` (`renderDigest`)
- Modify: `packages/domain/service.ts` — `recallPush` (the block from `const hits = filterSeen(...)` to `fitFull(hits, ...)`), `digestFor` `:3634-3645`
- Modify: `apps/mcp/surface.ts:7-17` (`SERVER_INSTRUCTIONS`, one sentence)
- Test: `tests/integration/recall-push.test.ts` (append), `tests/integration/mcp-surface.test.ts` (one assertion)

**Interfaces:**
- Consumes: `isUnreviewedAgent` (Task 1), `hitIsStrong`, `hitIsRelated`, `fitFull`, `renderDigest`.
- Produces: `renderDigest(d: { ...; agent_unreviewed?: number; recent: { title: string; at: string; agent?: string }[] })`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/integration/recall-push.test.ts`, inside the `describe("recall push over HTTP")` block (reuse its `setup()`; it builds the recall fixture whose grant is read-only, so create a second grant with `propose_memory` in the test):

```ts
  it("never puts an unreviewed agent-written original in a full push, counts and labels it in the digest, and pushes it once the owner reviewed it", async () => {
    const { f, push, session } = await setup();
    const writer = f.brain.createGrant(owner, { projects: [f.ids["project:northstar"]], operations: ["read", "propose_memory"], expires_at: "2027-01-01T00:00:00.000Z", client: "codex" });
    const writerP = f.brain.authenticateAgent(writer.token);
    const note = f.brain.agentNote(writerP, { project_id: f.ids["project:northstar"], decisions: [{ topic: "zephyr cadence", decision: "the zephyr cadence is fortnightly" }] });
    // Only the agent note mentions zephyr: by words alone it would be a strong hit.
    const quiet = (await push({ prompt: "what is the zephyr cadence we settled on", session_id: session, first_prompt: true, seen: [] })).json();
    expect(quiet.level).toBe("pointer");
    expect(quiet.text).not.toContain("fortnightly");
    expect(quiet.hit_ids).toEqual([]);
    expect(quiet.digest).toBe(true);
    expect(quiet.text).toContain("1 of them written by agents and not yet reviewed");
    expect(quiet.text).toContain("Session note from Codex (2026-10-25, from Codex, not yet reviewed)");
    // The same hit through brain_recall is returned, labelled.
    const recalled = f.brain.recallCore(f.agent, { query: "zephyr cadence" });
    expect(recalled.hits[0]).toMatchObject({ id: note.source_id, written_by: { agent: "Codex", reviewed: false } });
    // The owner keeps the card: the note is reviewed and pushes like any original.
    const card = f.brain.brief(owner).items.find((c) => c.title.startsWith("zephyr"))!;
    f.brain.reviewGate(owner, card.target.id, { action: "accept", expected_version: card.target.version });
    const loud = (await push({ prompt: "what is the zephyr cadence we settled on", session_id: "c".repeat(64), first_prompt: true, seen: [] })).json();
    expect(loud.level).toBe("full");
    expect(loud.text).toContain("fortnightly");
    expect(loud.text).not.toContain("not yet reviewed");
  });
```

Add to `tests/integration/mcp-surface.test.ts` inside the instructions test, and raise its length bound from 1400 to 1700 (the two new sentences are the only addition; nothing else in the instructions changes):

```ts
    expect(SERVER_INSTRUCTIONS).toContain("written_by");
    expect(SERVER_INSTRUCTIONS).toContain("Decided: <topic>: <decision>");
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/integration/recall-push.test.ts tests/integration/mcp-surface.test.ts`
Expected: FAIL (`level` is `full`; the digest has no count line; the instructions lack the sentences).

- [ ] **Step 3: Cap the push and label the digest**

In `packages/domain/service.ts`, add `isUnreviewedAgent` to the provenance import from Task 1. In `recallPush`, replace the block that starts with `const hits = filterSeen(judge.hits, v.seen);` and ends with the `if (level === "full" && !hits.length)` line with:

```ts
    const seen = filterSeen(judge.hits, v.seen);
    // An unreviewed agent-written original is another agent's note, not the owner's evidence: it never rides in a full push (spec A1, R2).
    const hits = seen.filter((h) => !isUnreviewedAgent(h));
    // When the judge's order leaves a hit found by meaning alone on top, the level is capped at the words level.
    if (hits.length && internal.denseOnly.has(hitKey(hits[0]))) level = quieter(level, pushLevel(internal.signals, null));
    // Everything the agent already holds from this session, and every unreviewed agent note, is left out. When that removed hits, the level is re-read
    // on what is left: `full` only while the best remaining hit is itself a strong match, `pointer` for an exact entity match or a remaining related hit, else quiet.
    if (level === "full" && hits.length < judge.hits.length) {
      const terms = internal.signals.terms;
      if (!hits.length || !hitIsStrong(terms, hits[0])) level = internal.signals.exactEntity || seen.some((h) => hitIsRelated(terms, h)) ? "pointer" : "none";
    }
    // A judge may rate a candidate relevant that did not survive into the hits; a full push with nothing to show is never sent.
    if (level === "full" && !hits.length) level = internal.signals.exactEntity ? "pointer" : "none";
```

(`seen.some(hitIsRelated)` keeps the pointer when the only related hit is the agent note: the pointer names topics, not evidence.)

Replace `digestFor` with:

```ts
  /** Counts and three recent titles by SQL (no bodies, no claim verification): the digest is a map of the brain, not evidence. Only what an agent may see: project-visible originals and facts the recall index marks project-visible. Agent-written originals the owner has not reviewed are counted and labelled. */
  private digestFor(scope: { id: string; title: string }[], names: string[]): string {
    if (!scope.length) return "";
    const ids = scope.map((s) => s.id);
    const marks = ids.map(() => "?").join(",");
    const facts = Number(this.store.get<{ n: number }>(`SELECT count(DISTINCT ref_id) AS n FROM recall_chunks WHERE kind='fact' AND status='current' AND visibility='project' AND project_id IN (${marks})`, ...ids)?.n ?? 0);
    const originals = Number(this.store.get<{ n: number }>(`SELECT count(*) AS n FROM sources WHERE state='active' AND visibility='project' AND project_id IN (${marks})`, ...ids)?.n ?? 0);
    const agentUnreviewed = Number(
      this.store.get<{ n: number }>(
        `SELECT count(*) AS n FROM sources s WHERE s.state='active' AND s.visibility='project' AND s.project_id IN (${marks}) AND s.origin LIKE 'agent:%' AND NOT EXISTS (SELECT 1 FROM settings k WHERE k.key='source_reviewed:'||s.id)`,
        ...ids,
      )?.n ?? 0,
    );
    const recent = this.store
      .all<{ title: string; at: string; id: string; origin: string }>(
        `SELECT v.title AS title, s.captured_at AS at, s.id AS id, s.origin AS origin FROM sources s JOIN source_versions v ON v.source_id=s.id AND v.version=s.version WHERE s.state='active' AND s.visibility='project' AND s.project_id IN (${marks}) ORDER BY s.captured_at DESC, s.rowid DESC LIMIT 3`,
        ...ids,
      )
      .map(({ title, at, id, origin }) => {
        const by = this.writtenBy({ id, origin });
        return by && !by.reviewed ? { title, at, agent: by.agent } : { title, at };
      });
    return renderDigest({ projects: scope, facts, originals, recent, names, agent_unreviewed: agentUnreviewed });
  }
```

In `packages/domain/recall-push.ts` replace `renderDigest` with:

```ts
/** The first-prompt digest: projects, counts, three recent items, and the pointer line. Empty for an empty brain. Agent-written items the owner has not reviewed are counted and named as such; with none, the text is plan 5's. */
export function renderDigest(d: { projects: { title: string }[]; facts: number; originals: number; recent: { title: string; at: string; agent?: string }[]; names: string[]; agent_unreviewed?: number }): string {
  if (d.facts + d.originals === 0 || !d.projects.length) return "";
  const projects = d.projects.map((p) => oneLine(p.title, NAME_MAX)).join(", ");
  const recent = d.recent
    .slice(0, 3)
    .map((r) => `${oneLine(r.title, NAME_MAX)} (${r.at.slice(0, 10)}${r.agent ? `, from ${oneLine(r.agent, NAME_MAX)}, not yet reviewed` : ""})`)
    .join(", ");
  const unreviewed = d.agent_unreviewed ? `, ${d.agent_unreviewed} of them written by agents and not yet reviewed` : "";
  const parts = [
    `The owner's brain (bibrain) covers ${projects}: ${d.facts} current facts and ${d.originals} originals${unreviewed}.`,
    recent ? `Recent: ${recent}.` : "",
    renderPointer(d.names.length ? d.names : d.projects.map((p) => p.title)),
  ].filter(Boolean);
  let text = parts.join(" ");
  if (cpLength(text) >= DIGEST_MAX) text = Array.from(text).slice(0, DIGEST_MAX - 2).join("") + "…";
  return text;
}
```

In `apps/mcp/surface.ts` `SERVER_INSTRUCTIONS`, replace the paragraph that begins "When you finish a piece of work" with:

```
When you finish a piece of work, write a brain_note with the decisions, open questions and next step; it waits for the owner's review. Where a session hook is set up, the same happens when you end a substantive reply with lines of the form "Decided: <topic>: <decision>", "Open question: ..." and "Next step: ...". A hit that carries written_by is another agent's note the owner has not reviewed yet, not the owner's statement.
```

Keep `SERVER_INSTRUCTIONS.length <= 1700` (the bound the test now pins); if it exceeds, shorten the new sentences, not the old ones.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/integration/recall-push.test.ts tests/integration/recall-dense.test.ts tests/integration/mcp-surface.test.ts tests/eval`
Expected: PASS, snapshot still byte-identical, golden set unchanged.

- [ ] **Step 5: Commit**

```bash
git add packages/domain/recall-push.ts packages/domain/service.ts apps/mcp/surface.ts tests/integration/recall-push.test.ts tests/integration/mcp-surface.test.ts
git commit -m "feat(recall): unreviewed agent notes never ride in a full push and are labelled in the digest

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Provenance on the page and the review route (Sonnet)

**Files:**
- Modify: `packages/domain/project-view.ts:28-35,58-61,95-106` (`OriginalView`, `ProjectViewInput`), `packages/domain/service.ts` `brainProject` (search `buildProjectView(`)
- Modify: `apps/server/app.ts:688-694` (`GET /api/v1/sources/:id`), add `POST /api/v1/sources/:id/reviewed`
- Modify: `apps/web/brain/types.ts:33-40`, `apps/web/brain/Originals.tsx:5-9,45-49`, `apps/web/brain/SourceView.tsx:18-19,81-86`
- Modify: `docs/API.md` (two rows), `docs/UX.md` "Your brain" section (one sentence)
- Test: `tests/integration/your-brain-pure.test.ts` (append), `tests/integration/provenance.test.ts` (append one HTTP test), `tests/e2e/provenance.spec.ts` (new)

**Interfaces:**
- Consumes: `Brain.sourceView`, `Brain.markSourceReviewed`, `Brain.writtenBy`, `writtenByLabel`, `WrittenBy` (Task 1).
- Produces: `OriginalView.written_by?: WrittenBy`; `ProjectViewInput.writtenBy: (s: Source) => WrittenBy | undefined`; route `POST /api/v1/sources/:id/reviewed` → `{ source_id, reviewed_at }`; `GET /api/v1/sources/:id` adds `written_by` when agent-written.

- [ ] **Step 1: Write the failing tests**

Append to `tests/integration/your-brain-pure.test.ts` (import `buildProjectView` from `../../packages/domain/project-view.ts` at the top; build the minimal `ProjectViewInput` the way the file's other tests do, adding the new `writtenBy` field):

```ts
describe("originals carry provenance", () => {
  it("labels agent-written originals by agent and review state, and owner originals as before", () => {
    const view = buildProjectView(
      {
        project: { id: "inbox", title: "Inbox" },
        claims: [],
        confirmations: {},
        sources: [
          { id: "a", project_id: "inbox", version: 1, title: "Session note from Codex", body: "Decided: queue: SQLite", visibility: "project", state: "active", captured_at: "2026-11-03T09:00:00Z", origin: "agent:g1" },
          { id: "b", project_id: "inbox", version: 1, title: "Mine", body: "text", visibility: "project", state: "active", captured_at: "2026-11-02T09:00:00Z", origin: "manual" },
        ],
        answered: new Set(),
        waiting: 0,
        needsDecision: [],
        decisionHistory: [],
        writtenBy: (s) => (s.origin === "agent:g1" ? { agent: "Codex", reviewed: false } : undefined),
      },
      new Date("2026-11-03T10:00:00Z"),
    );
    expect(view.originals[0]).toMatchObject({ id: "a", from: "agent", written_by: { agent: "Codex", reviewed: false } });
    expect(view.originals[1]).not.toHaveProperty("written_by");
  });
});
```

Append to `tests/integration/provenance.test.ts` (import `createApp` from `../../apps/server/app.ts`):

```ts
  it("the page reads the provenance and can mark an agent note reviewed over HTTP", async () => {
    const { b, agent } = setup();
    const a = b.agentNote(agent, note);
    const app = await createApp(b, { pairSecret: "test-code", static: false });
    cleanup.push(() => void app.close());
    const paired = await app.inject({ method: "POST", url: "/api/v1/session/pair", headers: { host: "127.0.0.1:4317" }, payload: { secret: "test-code" } });
    const headers = { host: "127.0.0.1:4317", cookie: paired.headers["set-cookie"]!.toString().split(";")[0], "x-brain-csrf": paired.json().csrf };
    expect((await app.inject({ url: `/api/v1/sources/${a.source_id}`, headers })).json().written_by).toEqual({ agent: "Codex", reviewed: false });
    const marked = await app.inject({ method: "POST", url: `/api/v1/sources/${a.source_id}/reviewed`, headers, payload: {} });
    expect(marked.statusCode).toBe(200);
    expect(marked.json()).toEqual({ source_id: a.source_id, reviewed_at: "2026-11-03T09:00:00.000Z" });
    expect((await app.inject({ url: `/api/v1/sources/${a.source_id}`, headers })).json().written_by).toEqual({ agent: "Codex", reviewed: true });
    const view = (await app.inject({ url: "/api/v1/brain/projects/inbox", headers })).json();
    expect(view.originals[0]).toMatchObject({ written_by: { agent: "Codex", reviewed: true } });
    // An agent cannot review on the owner's behalf.
    expect((await app.inject({ method: "POST", url: `/api/v1/sources/${a.source_id}/reviewed`, headers: { host: "127.0.0.1:4317", authorization: `Bearer ${"f".repeat(64)}` }, payload: {} })).statusCode).toBe(401);
  });
```

Create `tests/e2e/provenance.spec.ts` (runs in the `main` project; the `testIgnore` pattern in `playwright.config.ts` does not match it):

```ts
import { expect, test, type Page } from "@playwright/test";

async function pair(page: Page) {
  await page.goto("/");
  await page.getByLabel("Installation code").fill("e2e-local-only");
  await page.getByRole("button", { name: "Open my brain" }).click();
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
}

test("an agent note shows who wrote it and that it is not yet reviewed, until the owner marks it", async ({ page, request }) => {
  await pair(page);
  const csrf = await page.evaluate(() => (window as any).__csrf ?? "");
  // A connected agent writes a note through the API, as the hook would.
  const grant = await request.post("/api/v1/agent-grants", { headers: { "X-Brain-CSRF": csrf }, data: { projects: ["inbox"], operations: ["read", "propose_memory"], expires_at: new Date(Date.now() + 86_400_000).toISOString(), client: "codex" } });
  expect(grant.ok()).toBe(true);
  const { token } = await grant.json();
  const note = await request.post("/api/v1/agent/note", { headers: { Authorization: `Bearer ${token}` }, data: { project_id: "inbox", open_questions: ["Which lease length is right for the provenance e2e?"] } });
  expect(note.ok()).toBe(true);
  await page.reload();
  await page.getByRole("button", { name: "Your brain", exact: true }).click();
  await expect(page.getByText("From Codex · not yet reviewed").first()).toBeVisible();
  await page.getByRole("button", { name: "Session note from Codex" }).first().click();
  await page.getByRole("button", { name: "Mark as reviewed" }).click();
  await expect(page.getByText("From Codex · reviewed").first()).toBeVisible();
});
```

If the page does not expose the CSRF value on `window`, read it the way `tests/e2e/connections-v2.spec.ts` obtains an agent key instead (create the grant through the page's "Set up by hand" dialog) and keep the rest of the journey; the assertion that matters is the label before and after "Mark as reviewed".

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/integration/your-brain-pure.test.ts tests/integration/provenance.test.ts`
Expected: FAIL (`writtenBy` is not a known input; the route is 404).

- [ ] **Step 3: Carry provenance through the project view**

In `packages/domain/project-view.ts` add `import type { WrittenBy } from "./provenance.ts";`, add `written_by?: WrittenBy;` to `OriginalView`, add `writtenBy: (s: Source) => WrittenBy | undefined;` to `ProjectViewInput`, and in the `originals` map add after `private: s.visibility === "private",`:

```ts
      ...(input.writtenBy(s) ? { written_by: input.writtenBy(s) } : {}),
```

In `service.ts` `brainProject`, add `writtenBy: (s) => this.writtenBy(s),` to the object passed to `buildProjectView`.

- [ ] **Step 4: The routes**

In `apps/server/app.ts` change the `GET /api/v1/sources/:id` handler to call `req.brain.sourceView(req.principal, params(req), query.version)` and add next to it:

```ts
  app.post("/api/v1/sources/:id/reviewed", (req) =>
    req.brain.markSourceReviewed(req.principal, params(req)),
  );
```

- [ ] **Step 5: The page**

In `apps/web/brain/types.ts` add `written_by?: { agent: string; reviewed: boolean };` to `Original`. In `apps/web/brain/Originals.tsx` replace `{FROM[o.from]}` with `{o.written_by ? `From ${o.written_by.agent} · ${o.written_by.reviewed ? "reviewed" : "not yet reviewed"}` : FROM[o.from]}`.

In `apps/web/brain/SourceView.tsx`: the `source` prop type becomes `Source & { written_by?: { agent: string; reviewed: boolean } }`; replace `from(source.origin)` in the header with `source.written_by ? `From ${source.written_by.agent} · ${source.written_by.reviewed ? "reviewed" : "not yet reviewed"}` : from(source.origin)`; add a prop `onReviewed?: () => void | Promise<void>` and, right after the header paragraph, when `source.written_by && !source.written_by.reviewed`:

```tsx
      {source.written_by && !source.written_by.reviewed && (
        <p>
          <button
            type="button"
            className="tv-btn tv-sm"
            onClick={() =>
              void api(`/sources/${encodeURIComponent(source.id)}/reviewed`, {})
                .then(() => onReviewed?.())
                .catch((e) => setError(friendlyError(e)))
            }
          >
            Mark as reviewed
          </button>
          <span className="tv-faint"> Reviewed notes can be pushed to your agents as evidence.</span>
        </p>
      )}
```

In `apps/web/src.tsx`, where `<SourceView` is rendered, pass `onReviewed={() => void openSource(source.id, sourceView)}` so the drawer reloads the source (`openSource` already fetches `/sources/:id`). Remove the `from` helper in `SourceView.tsx` only if it becomes unused (ESLint).

- [ ] **Step 6: Docs**

`docs/API.md`: in the route table add after `GET /sources/:id` (or the nearest sources row):

```
| GET /sources/:id                  | version optional                              | The original; agent-written ones add `written_by: {agent, reviewed}` |
| POST /sources/:id/reviewed        | None                                          | Owner + CSRF; records the owner's review of an agent-written original (400 for an owner note); `{source_id, reviewed_at}` |
```

`docs/UX.md`, "Your brain" section, after "Recent originals open the retained source directly.": add

```
- An original written by a connected agent says "From <agent> · not yet reviewed" until the owner keeps a card from it, edits it, or presses "Mark as reviewed" on it; then "From <agent> · reviewed". Until then it is never pushed to an agent as evidence.
```

- [ ] **Step 7: Run the tests, then the one browser journey**

Run: `npx vitest run tests/integration/your-brain-pure.test.ts tests/integration/provenance.test.ts tests/integration/brain-project.test.ts && npm run typecheck && npm run lint && npm run build && npx playwright test tests/e2e/provenance.spec.ts --workers=1 && git restore docs/screenshots`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/domain/project-view.ts packages/domain/service.ts apps/server/app.ts apps/web/brain/types.ts apps/web/brain/Originals.tsx apps/web/brain/SourceView.tsx apps/web/src.tsx docs/API.md docs/UX.md tests/integration/your-brain-pure.test.ts tests/integration/provenance.test.ts tests/e2e/provenance.spec.ts
git commit -m "feat(your-brain): originals say which agent wrote them and whether they were reviewed

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Rate limiting behind a proxy (Opus)

**Files:**
- Create: `apps/server/rate-limit-key.ts`
- Modify: `apps/server/app.ts:175-182` (Fastify options, rate-limit registration), `createApp` options type (add `rateLimitMax?: number`)
- Modify: `docs/SELF_HOSTING.md` (one sentence near line 33)
- Test: `tests/integration/rate-limit.test.ts` (new)

**Interfaces:**
- Consumes: `hash` from `packages/domain/logic.ts`, `deploymentPolicy(...).secure`.
- Produces: `rateLimitKey(req: { ip: string; headers: Record<string, string | string[] | undefined>; cookies?: Record<string, string | undefined> }): string`; `createApp(..., { rateLimitMax })`.

- [ ] **Step 1: Write the failing tests**

Create `tests/integration/rate-limit.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { Storage } from "../../packages/storage/index.ts";
import { Brain } from "../../packages/domain/service.ts";
import { createApp } from "../../apps/server/app.ts";
import { rateLimitKey } from "../../apps/server/rate-limit-key.ts";

let closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.reverse()) await c();
  closers = [];
});
async function app(publicOrigin?: string) {
  const store = new Storage(":memory:");
  const brain = new Brain(store);
  const a = await createApp(brain, { pairSecret: "synthetic-owner-code-at-least-32-chars", publicOrigin, static: false, rateLimitMax: 5 });
  closers.push(async () => {
    await a.close();
    store.close();
  });
  return { a, brain };
}
const secret = "synthetic-owner-code-at-least-32-chars";

describe("rate limiting", () => {
  it("keys on the session or the bearer first, then on the address", () => {
    expect(rateLimitKey({ ip: "10.0.0.1", headers: {}, cookies: {} })).toBe("ip:10.0.0.1");
    const a = rateLimitKey({ ip: "10.0.0.1", headers: { authorization: `Bearer ${"a".repeat(64)}` }, cookies: {} });
    expect(a.startsWith("agent:")).toBe(true);
    expect(a).not.toContain("a".repeat(64));
    const s = rateLimitKey({ ip: "10.0.0.1", headers: {}, cookies: { brain_session: "cookie-value" } });
    expect(s.startsWith("session:")).toBe(true);
    expect(s).not.toContain("cookie-value");
    expect(rateLimitKey({ ip: "10.0.0.1", headers: { authorization: "Bearer not-a-token" }, cookies: {} })).toBe("ip:10.0.0.1");
  });

  it("behind the proxy, one client's flood does not touch the owner's bucket, and a forwarded Host is still refused", async () => {
    const { a } = await app("https://brain.example.test");
    const headers = { host: "brain.example.test" };
    for (let i = 0; i < 5; i++) expect((await a.inject({ url: "/api/v1/health/live", headers: { ...headers, "x-forwarded-for": "203.0.113.9" }, remoteAddress: "172.18.0.2" })).statusCode).toBe(200);
    expect((await a.inject({ url: "/api/v1/health/live", headers: { ...headers, "x-forwarded-for": "203.0.113.9" }, remoteAddress: "172.18.0.2" })).statusCode).toBe(429);
    // Another client, same proxy hop, fresh bucket.
    expect((await a.inject({ url: "/api/v1/health/live", headers: { ...headers, "x-forwarded-for": "198.51.100.4" }, remoteAddress: "172.18.0.2" })).statusCode).toBe(200);
    // The owner pairs from a third address and then has a bucket of their own.
    const paired = await a.inject({ method: "POST", url: "/api/v1/session/pair", headers: { ...headers, origin: "https://brain.example.test", "x-forwarded-for": "192.0.2.7" }, remoteAddress: "172.18.0.2", payload: { secret } });
    expect(paired.statusCode).toBe(200);
    const owner = { ...headers, cookie: paired.headers["set-cookie"]!.toString().split(";")[0], "x-forwarded-for": "192.0.2.7" };
    for (let i = 0; i < 5; i++) expect((await a.inject({ url: "/api/v1/today", headers: owner, remoteAddress: "172.18.0.2" })).statusCode).toBe(200);
    expect((await a.inject({ url: "/api/v1/today", headers: owner, remoteAddress: "172.18.0.2" })).statusCode).toBe(429);
    // The flood from 203.0.113.9 is still refused while the owner was served.
    expect((await a.inject({ url: "/api/v1/health/live", headers: { ...headers, "x-forwarded-for": "203.0.113.9" }, remoteAddress: "172.18.0.2" })).statusCode).toBe(429);
    // Forwarded headers never change the Host check.
    expect((await a.inject({ url: "/api/v1/health/live", headers: { host: "evil.test", "x-forwarded-host": "brain.example.test", "x-forwarded-for": "192.0.2.8" }, remoteAddress: "172.18.0.2" })).statusCode).toBe(403);
  });

  it("locally, a forwarded address is ignored and every unauthenticated loopback request shares one bucket", async () => {
    const { a } = await app();
    const headers = { host: "127.0.0.1:4317" };
    for (let i = 0; i < 5; i++) expect((await a.inject({ url: "/api/v1/health/live", headers: { ...headers, "x-forwarded-for": `203.0.113.${i}` }, remoteAddress: "127.0.0.1" })).statusCode).toBe(200);
    expect((await a.inject({ url: "/api/v1/health/live", headers: { ...headers, "x-forwarded-for": "203.0.113.99" }, remoteAddress: "127.0.0.1" })).statusCode).toBe(429);
    // The owner's session still gets its own bucket locally.
    const paired = await a.inject({ method: "POST", url: "/api/v1/session/pair", headers, remoteAddress: "127.0.0.1", payload: { secret } });
    expect(paired.statusCode).toBe(200);
    const owner = { ...headers, cookie: paired.headers["set-cookie"]!.toString().split(";")[0] };
    expect((await a.inject({ url: "/api/v1/today", headers: owner, remoteAddress: "127.0.0.1" })).statusCode).toBe(200);
  });
});
```

Note: the pairing route has its own 10-per-minute bucket (`config.rateLimit`), so the pair call above succeeds after the global bucket for that key is spent only if the route-level limit replaces the global one for that route; if the pair call returns 429, move the pairing before the flood in that test and keep the assertions.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/integration/rate-limit.test.ts`
Expected: FAIL (`rate-limit-key.ts` not found).

- [ ] **Step 3: Implement**

Create `apps/server/rate-limit-key.ts`:

```ts
import { hash } from "../../packages/domain/logic.ts";

type KeyRequest = { ip: string; headers: Record<string, string | string[] | undefined>; cookies?: Record<string, string | undefined> };

/**
 * One bucket per owner session, one per agent token, one per client address for everything else.
 * The session and the token are hashed before they become a key: the limiter's memory never holds a credential.
 */
export function rateLimitKey(req: KeyRequest): string {
  const auth = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
  const bearer = /^Bearer ([a-f0-9]{64})$/.exec(auth);
  if (bearer) return `agent:${hash(bearer[1])}`;
  const session = req.cookies?.brain_session;
  if (typeof session === "string" && session) return `session:${hash(session)}`;
  return `ip:${req.ip}`;
}
```

In `apps/server/app.ts` add `import { rateLimitKey } from "./rate-limit-key.ts";`, add to the options type:

```ts
    /** Tests only: a small global limit so the buckets can be observed. */
    rateLimitMax?: number;
```

and change the Fastify construction and the limiter registration to:

```ts
  const app = Fastify({
    bodyLimit: 4 * 1048576,
    logger: false,
    // Behind the configured TLS proxy, exactly one hop is trusted for the client address, so the limiter
    // keys on the client and not on the proxy. The Host and Origin checks below read the raw headers.
    ...(deployment.secure ? { trustProxy: 1 } : {}),
  });
  await app.register(cookie);
  // The active local UI polls several authenticated views; keep the global
  // abuse guard above that normal traffic while pairing retains its tight cap.
  // Each owner session, each agent token and each client address has its own bucket.
  await app.register(rateLimit, { max: options.rateLimitMax ?? 1000, timeWindow: 60000, keyGenerator: (req) => rateLimitKey(req) });
```

`docs/SELF_HOSTING.md` line 33, after "Preserve the public Host when substituting another trusted TLS proxy.": add "The app trusts exactly one proxy hop for the client address (`X-Forwarded-For`), so the request limiter counts each client separately; put no second proxy in front without adjusting that."

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/integration/rate-limit.test.ts tests/integration/deployment.test.ts tests/integration/pair-link.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/rate-limit-key.ts apps/server/app.ts docs/SELF_HOSTING.md tests/integration/rate-limit.test.ts
git commit -m "fix(server): rate limiter keys on the client behind the proxy and on the session or token

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: HTTP hardening: navigations, headers, key bound, dev origins (Opus)

**Files:**
- Modify: `apps/server/app.ts:301-311` (headers), the `onRequest` hook (navigation refusal), `:875-881` (gate idempotency key)
- Modify: `apps/server/deployment.ts:33-38` (dev origins) and its signature
- Test: `tests/integration/http-hardening.test.ts` (new), `tests/integration/deployment.test.ts` (one assertion)

**Interfaces:**
- Consumes: `key(req)` helper in `app.ts`, `BrainError`.
- Produces: `deploymentPolicy(publicOrigin?: string, port = 4317, devOrigins = process.env.NODE_ENV !== "production")`.

- [ ] **Step 1: Write the failing tests**

Create `tests/integration/http-hardening.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { Storage } from "../../packages/storage/index.ts";
import { Brain } from "../../packages/domain/service.ts";
import { createApp } from "../../apps/server/app.ts";

let closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.reverse()) await c();
  closers = [];
});
async function paired() {
  const store = new Storage(":memory:");
  const brain = new Brain(store);
  const app = await createApp(brain, { pairSecret: "test-code", static: false });
  closers.push(async () => {
    await app.close();
    store.close();
  });
  const host = { host: "127.0.0.1:4317" };
  const session = await app.inject({ method: "POST", url: "/api/v1/session/pair", headers: host, payload: { secret: "test-code" } });
  const headers = { ...host, cookie: session.headers["set-cookie"]!.toString().split(";")[0], "x-brain-csrf": session.json().csrf };
  return { app, brain, host, headers };
}

describe("HTTP hardening", () => {
  it("refuses a browser navigation to the API except the liveness check", async () => {
    const { app, host, headers } = await paired();
    const nav = { ...headers, "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };
    const refused = await app.inject({ url: "/api/v1/agent/recall?query=anything", headers: nav });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.message).toBe("Open BiBrain from its own page.");
    expect((await app.inject({ url: "/api/v1/today", headers: nav })).statusCode).toBe(403);
    expect((await app.inject({ url: "/api/v1/health/live", headers: { ...host, "sec-fetch-mode": "navigate" } })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/v1/today", headers: { ...headers, "sec-fetch-mode": "cors" } })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/v1/today", headers })).statusCode).toBe(200);
  });

  it("sends frame and content-security headers in every mode", async () => {
    const { app, host, headers } = await paired();
    for (const res of [await app.inject({ url: "/api/v1/health/live", headers: host }), await app.inject({ url: "/api/v1/today", headers })]) {
      expect(res.headers["x-frame-options"]).toBe("DENY");
      expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
    }
  });

  it("bounds the retry key on the owner's proposal route like every other route", async () => {
    const { app, headers } = await paired();
    const payload = { project_id: "inbox", title: "Status", text: "northstar status active", type: "fact", entity: "northstar", field: { aspect: "status", value: "active" } };
    expect((await app.inject({ method: "POST", url: "/api/v1/proposals/gate", headers: { ...headers, "idempotency-key": "k".repeat(201) }, payload })).statusCode).toBe(400);
    const ok = await app.inject({ method: "POST", url: "/api/v1/proposals/gate", headers: { ...headers, "idempotency-key": "k".repeat(200) }, payload });
    expect(ok.statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/api/v1/proposals/gate", headers: { ...headers, "idempotency-key": "k".repeat(200) }, payload })).json()).toEqual(ok.json());
  });
});
```

Add to `tests/integration/deployment.test.ts`, inside the test "deployment configuration rejects insecure or ambiguous public origins" (or as a new `it`):

```ts
  expect(deploymentPolicy(undefined, 4317, true).allowsOrigin("http://localhost:5173")).toBe(true);
  expect(deploymentPolicy(undefined, 4317, false).allowsOrigin("http://localhost:5173")).toBe(false);
  expect(deploymentPolicy(undefined, 4317, false).allowsOrigin("http://127.0.0.1:4317")).toBe(true);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/integration/http-hardening.test.ts tests/integration/deployment.test.ts`
Expected: FAIL (navigation returns 200; no `x-frame-options`; 201-character key accepted; third argument ignored).

- [ ] **Step 3: Implement**

In `apps/server/app.ts` `onRequest` hook, replace the header block (lines 301-311) with:

```ts
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .header("Cache-Control", "no-store")
      .header("X-Frame-Options", "DENY")
      .header(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self'",
      );
    if (deployment.secure)
      reply.header("Strict-Transport-Security", "max-age=31536000");
    // The API answers page fetches and agent calls, never a page of its own: a top-level navigation to it is refused.
    if (
      req.url.startsWith("/api/v1/") &&
      req.url !== "/api/v1/health/live" &&
      req.headers["sec-fetch-mode"] === "navigate"
    )
      throw new BrainError("FORBIDDEN", "Open BiBrain from its own page.", 403);
```

(The dev page is served by Vite on 5173, which carries its own headers; this policy on API responses and the production shell is the same in every mode.)

Change the gate route to use the bounded helper:

```ts
  app.post("/api/v1/proposals/gate", (req) =>
    req.brain.propose(req.principal, req.body, key(req)),
  );
```

In `apps/server/deployment.ts` change the signature to `export function deploymentPolicy(publicOrigin?: string, port = 4317, devOrigins = process.env.NODE_ENV !== "production")` and build the local origins as:

```ts
  const localOrigins = new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    ...(devOrigins ? ["http://127.0.0.1:5173", "http://localhost:5173"] : []),
  ]);
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/integration/http-hardening.test.ts tests/integration/deployment.test.ts tests/integration/gate.test.ts tests/integration/safety.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/app.ts apps/server/deployment.ts tests/integration/http-hardening.test.ts tests/integration/deployment.test.ts
git commit -m "fix(server): refuse API navigations, always send frame headers, bound the gate retry key, gate dev origins

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The adapter's environment allowlist (Sonnet)

**Files:**
- Modify: `apps/cli/lib.mjs` (add `adapterEnv`), `apps/cli/lib.d.mts` (declaration), `apps/cli/bibrain.mjs:144-152` (`connect`)
- Test: `tests/integration/bibrain-hook.test.ts` (append to "hook helpers")

**Interfaces:**
- Produces: `adapterEnv(env: NodeJS.ProcessEnv, api: string, key: string): Record<string, string>`.

- [ ] **Step 1: Write the failing test**

Append to the `describe("hook helpers")` block in `tests/integration/bibrain-hook.test.ts` (add `adapterEnv` to the import from `../../apps/cli/lib.mjs`):

```ts
  it("starts the adapter with an allowlisted environment: paths and locale in, every secret out", () => {
    const env = {
      PATH: "/usr/bin", Path: "C:\\Windows", HOME: "/home/ana", USERPROFILE: "C:\\Users\\ana", TEMP: "C:\\tmp", SYSTEMROOT: "C:\\Windows", APPDATA: "C:\\Users\\ana\\AppData\\Roaming", LANG: "en_US.UTF-8",
      BRAIN_OWNER_SECRET: "owner", BRAIN_DECISION_API_KEY: "decision", OLLAMA_API_KEY: "ollama", BRAIN_DODO_API_KEY: "dodo", BRAIN_DODO_WEBHOOK_SECRET: "whs", BRAIN_OIDC_CLIENT_SECRET: "oidc", BRAIN_EMBED_API_KEY: "embed", NODE_OPTIONS: "--inspect", BRAIN_DB: "data/x.sqlite", BRAIN_PORT: "4317",
    };
    const out = adapterEnv(env, "http://127.0.0.1:4317", "k".repeat(64));
    expect(Object.keys(out).sort()).toEqual(["APPDATA", "BRAIN_AGENT_TOKEN", "BRAIN_API_URL", "HOME", "LANG", "PATH", "Path", "SYSTEMROOT", "TEMP", "USERPROFILE"]);
    expect(out.BRAIN_API_URL).toBe("http://127.0.0.1:4317");
    expect(out.BRAIN_AGENT_TOKEN).toBe("k".repeat(64));
    for (const v of ["owner", "decision", "ollama", "dodo", "whs", "oidc", "embed", "--inspect"]) expect(JSON.stringify(out)).not.toContain(v);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/integration/bibrain-hook.test.ts -t "allowlisted environment"`
Expected: FAIL (`adapterEnv` is not exported).

- [ ] **Step 3: Implement**

Add to `apps/cli/lib.mjs`:

```js
/** What the agent adapter is allowed to inherit: locating programs, temp and home folders, locale and certificates. Compared case-insensitively, since Windows spells PATH as Path. */
const ADAPTER_ENV = new Set(["PATH", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR", "APPDATA", "LOCALAPPDATA", "COMSPEC", "PATHEXT", "LANG", "LC_ALL", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"]);

/** The adapter's environment: the allowlist above plus its own two variables. Provider, billing, sign-in and owner secrets never reach it. */
export function adapterEnv(env, api, key) {
  const out = {};
  for (const [name, value] of Object.entries(env)) if (typeof value === "string" && ADAPTER_ENV.has(name.toUpperCase())) out[name] = value;
  out.BRAIN_API_URL = api;
  out.BRAIN_AGENT_TOKEN = key;
  return out;
}
```

Add to `apps/cli/lib.d.mts`: `export function adapterEnv(env: NodeJS.ProcessEnv, api: string, key: string): Record<string, string>;`

In `apps/cli/bibrain.mjs` import `adapterEnv` from `./lib.mjs` and replace the four lines from `const env = { ...process.env };` to `env.BRAIN_API_URL = api;` with:

```js
  const env = adapterEnv(process.env, api, key);
```

Confirm with `grep -n "process.env" apps/mcp/main.ts apps/mcp/api-url.ts` that the adapter reads only `BRAIN_API_URL` and `BRAIN_AGENT_TOKEN` (it does at the time of writing).

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/integration/bibrain-hook.test.ts tests/integration/bibrain-cli.test.ts`
Expected: PASS (the CLI test spawns the real adapter through `connect`, which proves the allowlist is enough to start it).

- [ ] **Step 5: Commit**

```bash
git add apps/cli/lib.mjs apps/cli/lib.d.mts apps/cli/bibrain.mjs tests/integration/bibrain-hook.test.ts
git commit -m "fix(cli): the agent adapter inherits an allowlisted environment, never a secret

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The .gitignore lines in Add (Sonnet)

**Files:**
- Modify: `apps/server/agent-connect.ts` (`AgentPreview`, `AgentConnected`, `filesFor` callers), `apps/web/connections/types.ts` (`Preview`), `apps/web/connections/AddAgent.tsx` (preview block)
- Modify: `packages/domain/agents.ts` (`AGENT_HINTS`, one phrase)
- Test: `tests/integration/agent-connect.test.ts` (append), `tests/e2e/connections-v2.spec.ts` (two assertions in the Codex test)

**Interfaces:**
- Produces: `AgentPreview.ignore: { lines: string[]; listed: boolean }` and the same on `AgentConnected`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/integration/agent-connect.test.ts`:

```ts
  it("tells the owner the exact .gitignore lines for the files it wrote, and whether they are already listed", () => {
    const { svc, folder } = setup();
    const pv = svc.preview(owner, { client: "claude-code", project_id: "inbox", folder });
    expect(pv.ignore).toEqual({ lines: [".mcp.json", ".claude/settings.local.json"], listed: false });
    writeFileSync(join(folder, ".gitignore"), "node_modules/\n.mcp.json\n.claude/settings.local.json\n");
    expect(svc.preview(owner, { client: "claude-code", project_id: "inbox", folder }).ignore.listed).toBe(true);
    writeFileSync(join(folder, ".gitignore"), ".mcp.json\n");
    const done = svc.connect(owner, { connection_id: pv.connection_id, client: "claude-code", project_id: "inbox", folder, access: "read" });
    expect(done.ignore).toEqual({ lines: [".mcp.json", ".claude/settings.local.json"], listed: false });
    // BiBrain wrote nothing into .gitignore.
    expect(readFileSync(join(folder, ".gitignore"), "utf8")).toBe(".mcp.json\n");
    expect(svc.preview(owner, { client: "codex", project_id: "inbox", folder }).ignore.lines).toEqual([".codex/config.toml", ".codex/hooks.json"]);
  });
```

In `tests/e2e/connections-v2.spec.ts`, in the first test after `await expect(preview).toContainText("[mcp_servers.bibrain]");` add:

```ts
  await expect(codex.getByText("Keep these out of shared version control")).toBeVisible();
  await expect(codex.getByTestId("agent-ignore")).toHaveText(".codex/config.toml\n.codex/hooks.json");
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/integration/agent-connect.test.ts -t "gitignore"`
Expected: FAIL (`ignore` is undefined).

- [ ] **Step 3: Implement**

In `apps/server/agent-connect.ts` add `readFileSync` to the `node:fs` import, add `ignore: { lines: string[]; listed: boolean }` to both `AgentPreview` and `AgentConnected`, and add inside `agentConnect` next to `filesFor`:

```ts
  /** The relative paths BiBrain writes, as .gitignore lines, and whether the folder's .gitignore already lists every one. Read only; never written. */
  const ignoreFor = (client: AgentClient, real: string) => {
    const lines = [configTarget(client).file.join("/"), ...(secondFileTarget(client) ? [secondFileTarget(client)!.file.join("/")] : [])];
    let listed = false;
    try {
      const present = new Set(readFileSync(join(real, ".gitignore"), "utf8").split(/\r?\n/u).map((l) => l.trim().replace(/^\//u, "")));
      listed = lines.every((l) => present.has(l));
    } catch {
      listed = false;
    }
    return { lines, listed };
  };
```

Return `ignore: ignoreFor(v.client, real)` from both `preview` and `connect`.

In `apps/web/connections/types.ts` add `ignore: { lines: string[]; listed: boolean };` to `Preview`. In `AddAgent.tsx`, after the "The access key stays in BiBrain..." paragraph, add:

```tsx
            <p className="tv-faint">
              {preview.ignore.listed ? "Already in this folder's .gitignore." : "Keep these out of shared version control: add these lines to the folder's .gitignore."}
            </p>
            {!preview.ignore.listed && (
              <p>
                <pre className="cx-file" data-testid="agent-ignore">{preview.ignore.lines.join("\n")}</pre>
                <button type="button" className="tv-btn tv-ghost tv-sm" onClick={() => void navigator.clipboard.writeText(preview.ignore.lines.join("\n") + "\n")}>
                  Copy
                </button>
              </p>
            )}
```

(Use a `div` instead of `p` around the `pre` if React warns about nesting.)

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/integration/agent-connect.test.ts && npm run typecheck && npm run lint && npm run build && npx playwright test tests/e2e/connections-v2.spec.ts --workers=1 && git restore docs/screenshots`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/agent-connect.ts apps/web/connections/types.ts apps/web/connections/AddAgent.tsx tests/integration/agent-connect.test.ts tests/e2e/connections-v2.spec.ts
git commit -m "feat(connections): show the .gitignore lines for the files Add writes

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Security docs for Part A (Sonnet)

**Files:**
- Modify: `docs/SECURITY_PRIVACY.md` (controls table, local assumptions), `docs/AGENT_INTEGRATION.md` (recall push section, result contract), `docs/API.md` (recall rows)
- Create: `docs/superpowers/plans/2026-11-03-safe-write-back-followups.md`

- [ ] **Step 1: Write the docs**

`docs/SECURITY_PRIVACY.md`, add to the controls table:

```
| Agent-written content presented as the owner's | Agent-written originals carry `written_by` in recall and open results, are counted and labelled in the first-prompt digest, never appear in a `full` push until the owner reviewed them, and are labelled in Your brain |
| Pre-authentication request floods | One limiter bucket per owner session, per agent token and per client address; behind the configured TLS proxy exactly one hop is trusted for the client address |
| API opened as a page | Top-level navigations to `/api/v1/` (except the liveness check) are refused; frame and content-security headers are sent in every mode |
```

Under "Local assumptions" add: "On Windows, file modes are not enforced by the filesystem; keep `data/` under your own user profile on a shared machine."

`docs/AGENT_INTEGRATION.md`: in "Result contract" add after the `original` example: "An agent-written original adds `written_by: { agent, reviewed }`; owner-captured originals have no such field. Until the owner reviews it, it is another agent's note, not the owner's statement." In "Recall push" add after the digest paragraph: "An agent-written original the owner has not reviewed never appears in a `full` push and cannot raise the level; the digest counts such originals (`N of them written by agents and not yet reviewed`) and labels a recent one. Once the owner keeps a card from it, edits it or marks it reviewed in Your brain, it is pushed like any other."

`docs/API.md`: in the `GET /agent/recall` and `GET /agent/open` rows add "agent-written originals carry `written_by`".

Create `docs/superpowers/plans/2026-11-03-safe-write-back-followups.md` with the parked items from spec section A4 and B2 (L2 with the versions checked on 2026-11-03, L4, L7, I3, I4, I5, git log import, empty-brain pointer), each with its reason in one line.

- [ ] **Step 2: Commit**

```bash
git add docs/SECURITY_PRIVACY.md docs/AGENT_INTEGRATION.md docs/API.md docs/superpowers/plans/2026-11-03-safe-write-back-followups.md
git commit -m "docs: provenance, proxy rate limiting and the parked security items

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: The session note in the domain and over HTTP (Opus)

**Files:**
- Create: `packages/domain/session-note.ts`
- Modify: `packages/domain/service.ts` (add `sessionNote`, `sessionNoteLog`; extend `connections()` with `writeback`)
- Modify: `apps/server/app.ts` (route `POST /api/v1/agent/session-note`)
- Modify: `apps/web/connections/types.ts` (`Grant.writeback`)
- Test: `tests/integration/session-note.test.ts` (new)

**Interfaces:**
- Consumes: `Brain.agentNote(p, input, key)`, `detectSecrets`, `hash`.
- Produces:
  - `packages/domain/session-note.ts`: `SESSION_NOTE_MAX = 4000`, `SESSION_NOTES_PER_SESSION = 12`, `SESSION_NOTE_LOG_MAX = 2000`, `MARKER_LINE: RegExp` (the client-side cheap check, mirrored in the CLI), `type ParsedSessionNote = { decisions: { topic: string; decision: string }[]; open_questions: string[]; next_step?: string }`, `parseSessionNote(text: string): ParsedSessionNote | null`, `sessionNoteSchema` (zod: `{ session_id: /^[0-9a-f]{64}$/, client: "claude-code" | "codex" | "cursor" | "other" (default "other"), text: string (1..SESSION_NOTE_MAX code points) }`).
  - `Brain.sessionNote(p, input): { saved: true; source_id: string; suggestions: number; open_questions: number; duplicate: boolean } | { saved: false; reason: "secret" | "nothing" | "limit" }`.
  - `Brain.sessionNoteLog(p)` (owner): `{ rows: { at, grant_id, client, saved, reason?, suggestions, latency_ms }[] }`.
  - `connections()[i].writeback: { notes: number; last_at: string | null }`.

- [ ] **Step 1: Write the failing tests**

Create `tests/integration/session-note.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../../packages/storage/index.ts";
import { Brain } from "../../packages/domain/service.ts";
import { createApp } from "../../apps/server/app.ts";
import { MARKER_LINE, SESSION_NOTES_PER_SESSION, parseSessionNote } from "../../packages/domain/session-note.ts";
import type { Principal } from "../../packages/contracts/index.ts";

const owner: Principal = { kind: "owner" };
let cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "session-note-test-"));
  const s = new Storage(join(dir, "brain.sqlite"), { vault: join(dir, "vault") });
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  cleanup.push(() => {
    try {
      s.close();
    } catch {}
  });
  const b = new Brain(s, () => new Date("2026-11-03T09:00:00Z"));
  const g = b.createGrant(owner, { projects: ["inbox"], operations: ["read", "propose_memory"], expires_at: "2026-12-03T09:00:00.000Z", client: "claude-code" });
  return { b, agent: b.authenticateAgent(g.token), grant: g };
}
const session = "a".repeat(64);
const reply = [
  "I finished the queue work. Here is what changed.",
  "- **Decided: lease length: 90 seconds**",
  "* Decided: no topic here so this line is kept out",
  "Open question: should the worker retry twice?",
  "Next step: run the lease recovery test on Windows.",
  "Some trailing prose that is not a marker line.",
].join("\n");

describe("parseSessionNote", () => {
  it("keeps only marker lines, strips bullets and bold, and returns null without any", () => {
    expect(parseSessionNote(reply)).toEqual({ decisions: [{ topic: "lease length", decision: "90 seconds" }], open_questions: ["should the worker retry twice?"], next_step: "run the lease recovery test on Windows." });
    expect(parseSessionNote("All done, nothing to record.")).toBeNull();
    expect(parseSessionNote("Still unclear: which port.\nQuestion: who owns it?")).toEqual({ decisions: [], open_questions: ["which port.", "who owns it?"] });
    expect(parseSessionNote("Decided: a: b\n".repeat(30))!.decisions).toHaveLength(10);
    expect(MARKER_LINE.test(reply)).toBe(true);
    expect(MARKER_LINE.test("plain prose\nmore prose")).toBe(false);
  });
});

describe("Brain.sessionNote", () => {
  it("saves a note from marker lines as an unreviewed agent original with cards, once per session and text", () => {
    const { b, agent } = setup();
    const r = b.sessionNote(agent, { session_id: session, client: "claude-code", text: reply });
    expect(r).toMatchObject({ saved: true, suggestions: 1, open_questions: 1, duplicate: false });
    const src = b.source(owner, (r as any).source_id);
    expect(src.title).toBe("Session note from Claude Code");
    expect(src.body).toBe("Session note from Claude Code.\nDecided: lease length: 90 seconds\nOpen question: should the worker retry twice?\nNext step: run the lease recovery test on Windows.");
    expect(src.body).not.toContain("trailing prose");
    expect(b.writtenBy(src)).toEqual({ agent: "Claude Code", reviewed: false });
    expect(b.brief(owner).items[0]).toMatchObject({ kind: "agent_memory", title: "lease length: 90 seconds", why: "Claude Code wrote this down while it worked." });
    expect(b.currentClaims(owner, "inbox")).toEqual([]);
    expect(b.sessionNote(agent, { session_id: session, client: "claude-code", text: reply })).toEqual(r);
    expect(b.sources(owner, "inbox")).toHaveLength(1);
    const again = b.sessionNote(agent, { session_id: "b".repeat(64), client: "claude-code", text: reply });
    expect(again).toMatchObject({ saved: true, duplicate: true });
    expect(b.sources(owner, "inbox")).toHaveLength(1);
    expect(b.connections(owner)[0].writeback).toEqual({ notes: 1, last_at: "2026-11-03T09:00:00.000Z" });
  });

  it("stays quiet on prose, on secrets and past the per-session limit, and logs nothing but counts", () => {
    const { b, agent } = setup();
    expect(b.sessionNote(agent, { session_id: session, client: "codex", text: "All done." })).toEqual({ saved: false, reason: "nothing" });
    expect(b.sessionNote(agent, { session_id: session, client: "codex", text: "Decided: api key: sk-proj-abcdefghijklmnopqrstuvwxyz123456" })).toEqual({ saved: false, reason: "secret" });
    expect(b.sources(owner, "inbox")).toEqual([]);
    for (let i = 0; i < SESSION_NOTES_PER_SESSION; i++) expect(b.sessionNote(agent, { session_id: session, client: "codex", text: `Next step: item ${i}` })).toMatchObject({ saved: true });
    expect(b.sessionNote(agent, { session_id: session, client: "codex", text: "Next step: one too many" })).toEqual({ saved: false, reason: "limit" });
    const log = JSON.stringify(b.sessionNoteLog(owner));
    for (const word of ["item", "api key", "sk-proj", "All done"]) expect(log).not.toContain(word);
    expect(b.sessionNoteLog(owner).rows.map((r) => r.reason ?? "saved")).toEqual(["nothing", "secret", ...Array(SESSION_NOTES_PER_SESSION).fill("saved"), "limit"]);
  });

  it("needs an agent that may suggest, refuses bad input, and keeps a secret-shaped value out of the Brief", () => {
    const { b, agent } = setup();
    expect(() => b.sessionNote(owner, { session_id: session, client: "codex", text: "Next step: x" })).toThrow(/agent/i);
    const ro = b.createGrant(owner, { projects: ["inbox"], operations: ["read"], expires_at: "2026-12-03T09:00:00.000Z", client: "codex" });
    expect(() => b.sessionNote(b.authenticateAgent(ro.token), { session_id: session, client: "codex", text: "Next step: x" })).toThrow();
    expect(() => b.sessionNote(agent, { session_id: "short", client: "codex", text: "Next step: x" })).toThrow();
    expect(() => b.sessionNote(agent, { session_id: session, client: "codex", text: "x".repeat(4001) })).toThrow();
    // A marker line whose decision looks like a credential is refused before capture: no card, no recall hit, nothing stored.
    const r = b.sessionNote(agent, { session_id: session, client: "codex", text: "Decided: deploy: password = hunter2hunter2hunter2\nNext step: rotate" });
    expect(r).toMatchObject({ saved: false, reason: "secret" });
    expect(b.brief(owner).items).toEqual([]);
    expect(b.recallCore(agent, { query: "hunter2hunter2hunter2" }).hits).toEqual([]);
  });

  it("is reachable over HTTP with the agent's bearer only", async () => {
    const { b, grant } = setup();
    const app = await createApp(b, { pairSecret: "test-code", static: false });
    cleanup.push(() => app.close());
    const res = await app.inject({ method: "POST", url: "/api/v1/agent/session-note", headers: { host: "127.0.0.1:4317", authorization: `Bearer ${grant.token}` }, payload: { session_id: session, client: "claude-code", text: reply } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ saved: true });
    expect((await app.inject({ method: "POST", url: "/api/v1/agent/session-note", headers: { host: "127.0.0.1:4317" }, payload: { session_id: session, client: "claude-code", text: reply } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: "/api/v1/agent/session-note", headers: { host: "127.0.0.1:4317", authorization: `Bearer ${grant.token}` }, payload: { session_id: session, text: reply, extra: 1 } })).statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/integration/session-note.test.ts`
Expected: FAIL (`session-note.ts` not found).

- [ ] **Step 3: The pure module**

Create `packages/domain/session-note.ts`:

```ts
import { z } from "zod";

/** Code points of assistant text the hook may send; the CLI cuts to this before posting. */
export const SESSION_NOTE_MAX = 4000;
/** Saved notes per session; a chatty session stops writing after this many. */
export const SESSION_NOTES_PER_SESSION = 12;
export const SESSION_NOTE_LOG_MAX = 2000;
const DECISIONS_MAX = 10;
const QUESTIONS_MAX = 10;
const TOPIC_MAX = 120;
const LINE_MAX = 1000;

/** The cheap client-side check, mirrored in apps/cli/lib.mjs (a test keeps them equal): does any line start with a marker? */
export const MARKER_LINE = /^\s*(?:[-*•]\s*)?(?:\*\*)?(?:decided|open question|still unclear|question|unclear|next step)\s*:/imu;

export const sessionNoteSchema = z
  .object({
    session_id: z.string().regex(/^[0-9a-f]{64}$/u),
    client: z.enum(["claude-code", "codex", "cursor", "other"]).default("other"),
    text: z.string().min(1).refine((v) => Array.from(v).length <= SESSION_NOTE_MAX, "The text is cut to 4,000 characters before it is sent."),
  })
  .strict();

export type ParsedSessionNote = { decisions: { topic: string; decision: string }[]; open_questions: string[]; next_step?: string };

const clean = (line: string) =>
  line
    .trim()
    .replace(/^[-*•]\s*/u, "")
    .replace(/\*\*/gu, "")
    .trim();
const fits = (s: string) => s.length > 0 && Array.from(s).length <= LINE_MAX;

/**
 * Marker lines only: "Decided: <topic>: <decision>", "Open question: ..." (also Question, Unclear, Still unclear) and "Next step: ...".
 * A Decided line without a topic before its second colon is left out. Free text is never copied. Null when no line qualifies.
 */
export function parseSessionNote(text: string): ParsedSessionNote | null {
  const out: ParsedSessionNote = { decisions: [], open_questions: [] };
  for (const raw of text.split(/\r?\n/u)) {
    const line = clean(raw);
    const decided = /^decided\s*:\s*(.+)$/iu.exec(line);
    if (decided) {
      const m = /^([^:\r\n]{1,120})\s*:\s*(.+)$/u.exec(decided[1].trim());
      if (m && out.decisions.length < DECISIONS_MAX && Array.from(m[1].trim()).length <= TOPIC_MAX && fits(m[2].trim())) out.decisions.push({ topic: m[1].trim(), decision: m[2].trim() });
      continue;
    }
    const question = /^(?:open question|still unclear|question|unclear)\s*:\s*(.+)$/iu.exec(line);
    if (question) {
      if (out.open_questions.length < QUESTIONS_MAX && fits(question[1].trim())) out.open_questions.push(question[1].trim());
      continue;
    }
    const next = /^next step\s*:\s*(.+)$/iu.exec(line);
    if (next && out.next_step === undefined && fits(next[1].trim())) out.next_step = next[1].trim();
  }
  if (!out.decisions.length && !out.open_questions.length && out.next_step === undefined) return null;
  return out;
}
```

- [ ] **Step 4: The Brain method, the log and the connections field**

In `service.ts` add the import `import { SESSION_NOTES_PER_SESSION, SESSION_NOTE_LOG_MAX, parseSessionNote, sessionNoteSchema } from "./session-note.ts";` and add after `agentNote`:

```ts
  /** The session hook's write-back: marker lines from the agent's last reply become an ordinary agent note (unreviewed, cards on Today). Quiet otherwise. */
  sessionNote(p: Principal, input: unknown) {
    if (p.kind !== "agent") throw new BrainError("FORBIDDEN", "Use an agent token.", 403);
    const v = sessionNoteSchema.parse(input);
    const grant = this.grant(p)!;
    const project = grant.projects[0];
    this.access(p, project, "propose_memory");
    const started = Date.now();
    type Row = { at: string; grant_id: string; client: string; saved: boolean; reason?: "secret" | "nothing" | "limit"; suggestions: number; latency_ms: number };
    const log = (row: Omit<Row, "at" | "grant_id" | "client" | "latency_ms">) => {
      const rows = this.store.setting<Row[]>("session_note_log", []);
      rows.push({ at: this.now(), grant_id: p.grant_id, client: v.client, latency_ms: Date.now() - started, ...row });
      this.store.set("session_note_log", rows.slice(-SESSION_NOTE_LOG_MAX));
    };
    const quiet = (reason: "secret" | "nothing" | "limit") => {
      log({ saved: false, reason, suggestions: 0 });
      return { saved: false as const, reason };
    };
    if (detectSecrets(v.text).length) return quiet("secret");
    const parsed = parseSessionNote(v.text);
    if (!parsed) return quiet("nothing");
    const key = `session:${v.session_id}:${hash(v.text)}`;
    const repeat = this.store.get("SELECT 1 FROM idempotency WHERE principal=? AND operation=? AND key=?", p.grant_id, `agent_note:${project}`, key);
    if (!repeat) {
      const saved = Number(this.store.get<{ n: number }>("SELECT count(*) AS n FROM idempotency WHERE principal=? AND operation=? AND key LIKE ?", p.grant_id, `agent_note:${project}`, `session:${v.session_id}:%`)?.n ?? 0);
      if (saved >= SESSION_NOTES_PER_SESSION) return quiet("limit");
    }
    const r = this.agentNote(p, { project_id: project, ...parsed }, key) as { source_id: string; suggestions: number; open_questions: number; quarantined: boolean; duplicate?: boolean };
    if (r.quarantined) return quiet("secret");
    // A note already in the brain (same body from another session) is not a new note: nothing is counted.
    if (!repeat && r.duplicate !== true) log({ saved: true, suggestions: r.suggestions });
    return { saved: true as const, source_id: r.source_id, suggestions: r.suggestions, open_questions: r.open_questions, duplicate: r.duplicate === true };
  }
  /** What the session hook did and when: counts and reasons, never text or ids. */
  sessionNoteLog(p: Principal) {
    this.owner(p);
    return { rows: this.store.setting<{ at: string; grant_id: string; client: string; saved: boolean; reason?: string; suggestions: number; latency_ms: number }[]>("session_note_log", []) };
  }
```

In `writeAgentNote` (`service.ts:955-975`), the early return for a quarantined or duplicate capture returns `{ source_id, suggestions: 0, open_questions, quarantined }`; add `duplicate: !!captured.duplicate` to that object so `sessionNote` can tell the two apart. A quarantined capture inside `agentNote` is stored as the quarantined placeholder (private, as today) and is reported here as `secret`; that is the existing capture rule, not a new discard.

In `connections()`, add beside `recall:`:

```ts
        writeback: (() => {
          const rows = this.store.setting<{ at: string; grant_id: string; saved: boolean }[]>("session_note_log", []).filter((r) => r.grant_id === g.id && r.saved);
          return { notes: rows.length, last_at: rows.at(-1)?.at ?? null };
        })(),
```

In `apps/server/app.ts` add after the `recall-push` route:

```ts
  app.post("/api/v1/agent/session-note", (req) => req.brain.sessionNote(req.principal, req.body));
```

In `apps/web/connections/types.ts` add `writeback: { notes: number; last_at: string | null };` to `Grant`.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/integration/session-note.test.ts tests/integration/agent-note.test.ts tests/integration/agent-connect.test.ts tests/integration/agent-grants.test.ts && npm run typecheck`
Expected: PASS. If `agent-grants.test.ts` compares a connection row with `toEqual`, extend its expected object with `writeback: { notes: 0, last_at: null }`.

- [ ] **Step 6: Commit**

```bash
git add packages/domain/session-note.ts packages/domain/service.ts apps/server/app.ts apps/web/connections/types.ts tests/integration/session-note.test.ts
git commit -m "feat(write-back): session notes from marker lines land as unreviewed agent notes, bounded per session

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: `bibrain hook-end` (Sonnet)

**Files:**
- Modify: `apps/cli/lib.mjs` (constants, `parseStopStdin`, `hasMarkerLine`, `noteSessionEnd`, `hookEndOutput`), `apps/cli/lib.d.mts`, `apps/cli/bibrain.mjs` (`hookEnd()`, dispatch, help text)
- Test: `tests/integration/bibrain-hook.test.ts` (new `describe("bibrain hook-end")`), `tests/integration/session-note.test.ts` (one mirror assertion)

**Interfaces:**
- Consumes: `POST /api/v1/agent/session-note` (Task 9), `readHookState`/`writeHookState`/`hookStatePath`/`keyFilePath`/`loopbackApi`/`looksLikeSecret`/`sha256` (existing).
- Produces: `HOOK_END_BUDGET_MS = 2500`, `HOOK_END_TEXT_MAX = 4000`, `HOOK_END_PER_SESSION = 12`, `parseStopStdin(raw): { session_id: string; message: string; active: boolean } | null`, `hasMarkerLine(text): boolean`, `noteSessionEnd(state, sessionHash, messageHash, now): state` (adds the hash to `sessions[h].notes`, capped at 12), `hookEndOutput(): "{}"`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/integration/bibrain-hook.test.ts` a new block (import the new helpers from `../../apps/cli/lib.mjs`; `fake`, `dataDir`, `cleanup` and `ID` are already there):

```ts
const stop = (message: string, session = "sess-1", active = false) => JSON.stringify({ hook_event_name: "Stop", session_id: session, stop_hook_active: active, last_assistant_message: message, cwd: "C:/Users/Ana/Bi Brain", transcript_path: "x" });
function runEnd(args: string[], stdin: string | null, dir: string) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((done) => {
    const child = spawn(process.execPath, [cli, "hook-end", ...args, "--connection", ID, "--data", dir], { stdio: [stdin === null ? "ignore" : "pipe", "pipe", "pipe"], env: { ...process.env, BRAIN_DB: join(dir, "brain.sqlite") } });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (d) => (stdout += d));
    child.stderr!.on("data", (d) => (stderr += d));
    if (stdin !== null) child.stdin!.end(stdin);
    child.on("close", (status) => done({ status, stdout, stderr }));
  });
}
const saved = (_req: any, res: any) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ saved: true, source_id: "s1", suggestions: 1, open_questions: 0, duplicate: false }));
};

describe("hook-end helpers", () => {
  it("parses a Stop event, sees marker lines, and keeps per-session note hashes without text", () => {
    expect(parseStopStdin(stop("Next step: x", "s", true))).toEqual({ session_id: "s", message: "Next step: x", active: true });
    expect(parseStopStdin('{"hook_event_name":"Stop","session_id":"s"}')).toBeNull();
    expect(parseStopStdin("nope")).toBeNull();
    expect(hasMarkerLine("done\n- **Decided: a: b**")).toBe(true);
    expect(hasMarkerLine("I decided nothing")).toBe(false);
    let state = { sessions: {} };
    for (let i = 0; i < 15; i++) state = noteSessionEnd(state, sha256("s"), sha256(`m${i}`), 1000 + i);
    expect(state.sessions[sha256("s")].notes).toHaveLength(12);
    expect(JSON.stringify(state)).not.toContain("m1");
    expect(hookEndOutput()).toBe("{}");
  });
});

describe("bibrain hook-end", () => {
  it("posts the message once per session, prints {}, exits 0, and never posts a continued turn or a repeat", async () => {
    const f = await fake(saved);
    const dir = dataDir(`http://127.0.0.1:${f.port}`);
    const message = "Done.\nDecided: lease length: 90 seconds\nNext step: run the recovery test.";
    const r = await runEnd(["claude-code"], stop(message, "session-A"), dir);
    expect(r).toMatchObject({ status: 0, stdout: "{}", stderr: "" });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].headers.authorization).toBe(`Bearer ${"f".repeat(64)}`);
    expect(f.calls[0].body).toEqual({ session_id: sha256("session-A"), client: "claude-code", text: message });
    const state = JSON.parse(readFileSync(join(dir, "hook-state", `${ID}.json`), "utf8"));
    expect(state.sessions[sha256("session-A")].notes).toEqual([sha256(message)]);
    expect(readFileSync(join(dir, "hook-state", `${ID}.json`), "utf8")).not.toContain("lease");
    expect((await runEnd(["claude-code"], stop(message, "session-A"), dir)).stdout).toBe("{}");
    expect((await runEnd(["codex"], stop(message, "session-B", true), dir)).stdout).toBe("{}");
    expect(f.calls).toHaveLength(1);
  });
  it("stays quiet without marker lines, on secrets, on bad stdin, when the server is down, and past twelve notes", async () => {
    const f = await fake(saved);
    const dir = dataDir(`http://127.0.0.1:${f.port}`);
    for (const [input, why] of [
      [stop("All done, nothing to record."), "prose"],
      [stop("Decided: api key: sk-proj-abcdefghijklmnopqrstuvwxyz123456"), "secret"],
      ["not json", "bad stdin"],
      [JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "Next step: x", session_id: "s" }), "wrong event"],
    ] as const) {
      const r = await runEnd(["claude-code"], input, dir);
      expect(r.status, why).toBe(0);
      expect(r.stdout, why).toBe("{}");
    }
    expect(f.calls).toHaveLength(0);
    for (let i = 0; i < 12; i++) await runEnd(["codex"], stop(`Next step: item ${i}`, "session-C"), dir);
    expect(f.calls).toHaveLength(12);
    await runEnd(["codex"], stop("Next step: one too many", "session-C"), dir);
    expect(f.calls).toHaveLength(12);
    f.server.close();
    const down = await runEnd(["codex"], stop("Next step: with the server down", "session-D"), dir);
    expect(down).toMatchObject({ status: 0, stdout: "{}" });
  });
  it("bounds the text to 4,000 code points and finishes inside its budget", async () => {
    const f = await fake(saved);
    const dir = dataDir(`http://127.0.0.1:${f.port}`);
    const started = Date.now();
    await runEnd(["claude-code"], stop("Next step: " + "é".repeat(5000)), dir);
    expect(Date.now() - started).toBeLessThan(4000);
    expect(Array.from(f.calls[0].body.text).length).toBe(4000);
  });
});
```

Add to `tests/integration/session-note.test.ts` (import `hasMarkerLine` from `../../apps/cli/lib.mjs`):

```ts
  it("the CLI's marker check equals the domain's", () => {
    for (const s of [reply, "plain prose", "- Open question: x", "**Next step:** y", "  question: z", "decidedly not"]) expect(hasMarkerLine(s)).toBe(MARKER_LINE.test(s));
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/integration/bibrain-hook.test.ts -t "hook-end"`
Expected: FAIL (`parseStopStdin` is not exported; the CLI prints help for an unknown command).

- [ ] **Step 3: Implement the helpers**

Add to `apps/cli/lib.mjs`:

```js
export const HOOK_END_BUDGET_MS = 2500;
export const HOOK_END_TEXT_MAX = 4000;
export const HOOK_END_PER_SESSION = 12;
/** The same marker test as packages/domain/session-note.ts MARKER_LINE; a test keeps them equal. */
const MARKER = /^\s*(?:[-*•]\s*)?(?:\*\*)?(?:decided|open question|still unclear|question|unclear|next step)\s*:/imu;

export function hasMarkerLine(text) {
  return MARKER.test(text);
}

/** One Stop event. Anything that is not a Stop with a string last_assistant_message is null. */
export function parseStopStdin(raw) {
  let value;
  try {
    value = JSON.parse(raw.replace(/^\uFEFF/u, "").trim());
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || value.hook_event_name !== "Stop" || typeof value.last_assistant_message !== "string") return null;
  return { session_id: typeof value.session_id === "string" ? value.session_id : "", message: value.last_assistant_message, active: value.stop_hook_active === true };
}

/** Remembers the hash of a message already sent for a session (12 per session), beside the push hashes. Never the text. */
export function noteSessionEnd(state, sessionHash, messageHash, now) {
  const current = state.sessions[sessionHash] ?? { first_seen: now, last_seen: now, hashes: [] };
  const notes = [...(current.notes ?? []), messageHash].slice(-HOOK_END_PER_SESSION);
  const sessions = { ...state.sessions, [sessionHash]: { ...current, last_seen: now, hashes: current.hashes ?? [], notes } };
  const kept = Object.entries(sessions)
    .sort((a, b) => (b[1].last_seen ?? b[1].first_seen) - (a[1].last_seen ?? a[1].first_seen))
    .slice(0, HOOK_SESSIONS);
  return { sessions: Object.fromEntries(kept) };
}

/** Valid JSON with no decision: the agent stops as it would have. Codex requires JSON on stdout for this event. */
export function hookEndOutput() {
  return "{}";
}
```

Declare them in `apps/cli/lib.d.mts`.

- [ ] **Step 4: The command**

In `apps/cli/bibrain.mjs` import the new helpers and add after `hook()`:

```js
// The end-of-turn hook: it may add nothing and block nothing. Any problem ends with "{}" and exit 0.
async function hookEnd() {
  try {
    const client = String(positional[0] ?? "");
    if (!HOOK_CLIENTS.includes(client)) return;
    const raw = await readStdin(HOOK_STDIN_MS);
    if (raw === null) return;
    const event = parseStopStdin(raw);
    if (!event || event.active || !hasMarkerLine(event.message) || looksLikeSecret(event.message)) return;
    const text = firstCodePoints(event.message, HOOK_END_TEXT_MAX);
    const file = keyFilePath(String(flags.data ?? ""), String(flags.connection ?? ""));
    const { api, key } = JSON.parse(readFileSync(file, "utf8"));
    if (typeof key !== "string") return;
    const origin = loopbackApi(api);
    const statePath = hookStatePath(String(flags.data), String(flags.connection));
    const state = readHookState(statePath);
    const sessionHash = sha256(event.session_id);
    const messageHash = sha256(text);
    const notes = state.sessions[sessionHash]?.notes ?? [];
    if (notes.includes(messageHash) || notes.length >= HOOK_END_PER_SESSION) return;
    const remaining = Math.max(50, Math.floor(HOOK_END_BUDGET_MS - (Date.now() - startedAt)));
    const res = await fetch(`${origin}/api/v1/agent/session-note`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionHash, client, text }),
      signal: AbortSignal.timeout(remaining),
      redirect: "error",
    });
    if (!res.ok) return;
    writeHookState(statePath, noteSessionEnd(state, sessionHash, messageHash, Date.now()));
  } catch {
    /* silent by design */
  } finally {
    process.stdout.write(hookEndOutput());
    process.exitCode = 0;
  }
}
```

Add `else if (command === "hook-end") await hookEnd();` to the dispatch and a help line: `  npx --no-install bibrain hook-end <agent>  Used by the agent's end-of-turn hook; proposes a session note`. Note the `finally` prints `{}` on every path, including the early `return`s, so the fake-server tests see `{}` each time.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/integration/bibrain-hook.test.ts tests/integration/session-note.test.ts tests/integration/bibrain-cli.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/lib.mjs apps/cli/lib.d.mts apps/cli/bibrain.mjs tests/integration/bibrain-hook.test.ts tests/integration/session-note.test.ts
git commit -m "feat(cli): bibrain hook-end proposes a session note at the end of a turn, quietly and once

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Add writes the Stop hook; Connections shows it (Sonnet)

**Files:**
- Modify: `packages/domain/agents.ts` (`hookCommand` gets a `kind`, `secondFileContents`, `AGENT_HINTS`)
- Modify: `apps/web/connections/second-file.ts` (add `writebackLabel`), `apps/web/connections/ConnectionList.tsx` (one line per hook file)
- Modify: `docs/AGENT_INTEGRATION.md` (new "Session notes" subsection with citations), `docs/UX.md` (Connections "Waiting" paragraph), `docs/API.md` (route row), `README.md:42`
- Test: `tests/integration/agent-setup.test.ts:116-124` (update the pinned object), `tests/integration/second-file-copy.test.ts` (append), `tests/e2e/connections-v2.spec.ts` (two assertions)

**Interfaces:**
- Consumes: `Grant.writeback` (Task 9).
- Produces: `hookCommand(client, launch, kind: "hook" | "hook-end" = "hook")`; `writebackLabel(grant: Pick<Grant, "client" | "writeback">, file: Pick<WrittenFile, "role" | "state" | "contents">): string`.

- [ ] **Step 1: Write the failing tests**

In `tests/integration/agent-setup.test.ts` replace the `expect(parsed).toEqual({...})` for Claude Code with:

```ts
    expect(parsed).toEqual({
      permissions: { allow: ["mcp__bibrain__brain_recall", "mcp__bibrain__brain_open"] },
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: "command", command: hookCommand("claude-code", launch), timeout: 5 }] }],
        Stop: [{ hooks: [{ type: "command", command: hookCommand("claude-code", launch, "hook-end"), timeout: 5 }] }],
      },
    });
    expect(hookCommand("claude-code", launch, "hook-end")).toContain(" hook-end claude-code ");
    expect(text).not.toContain("SessionEnd");
```

and in the Codex branch add `expect(JSON.parse(secondFileContents("codex", launch)!).hooks.Stop[0].hooks[0].command).toContain(" hook-end codex ");`.

Append to `tests/integration/second-file-copy.test.ts`:

```ts
  it("says plainly whether session notes are on, waiting, missing from an older file, or by hand", () => {
    const none = { notes: 0, last_at: null };
    const some = { notes: 3, last_at: "2026-11-03T09:00:00.000Z" };
    const withStop = { role: "hook", state: "written", contents: '{"hooks":{"UserPromptSubmit":[],"Stop":[]}}' } as const;
    const without = { role: "hook", state: "written", contents: '{"hooks":{"UserPromptSubmit":[]}}' } as const;
    expect(writebackLabel({ client: "claude-code", writeback: none }, withStop)).toBe("Session notes: on after your next session");
    expect(writebackLabel({ client: "codex", writeback: none }, withStop)).toBe("Session notes: on after Codex trusts the hook");
    expect(writebackLabel({ client: "codex", writeback: some }, withStop)).toBe("Session notes: 3 saved · last 3 Nov 2026");
    expect(writebackLabel({ client: "claude-code", writeback: none }, { ...withStop, state: "exists" })).toBe("Session notes: add the hook yourself");
    expect(writebackLabel({ client: "claude-code", writeback: none }, without)).toBe("Session notes: not set up for this connection. Add the agent again to get them.");
    expect(writebackLabel({ client: "cursor", writeback: none }, { role: "rule", state: "written", contents: "" })).toBe("Session notes: by hand (Cursor has no end-of-turn hook)");
    for (const c of ["claude-code", "cursor", "codex"] as const) expect(writebackLabel({ client: c, writeback: none }, withStop)).not.toMatch(/\b(model|MCP|token)\b/i);
  });
```

(Match the date format `shortDate` in `apps/web/brain/format.ts` produces; adjust "3 Nov 2026" to its exact output.)

In `tests/e2e/connections-v2.spec.ts`, after `await expect(claude).toContainText("Recall on every prompt: on after your next prompt");` add `await expect(claude).toContainText("Session notes: on after your next session");` and after `expect(hook).toContain('"timeout": 5');` add `expect(hook).toContain('"Stop"');`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/integration/agent-setup.test.ts tests/integration/second-file-copy.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `packages/domain/agents.ts` change `hookCommand` to:

```ts
export function hookCommand(client: "claude-code" | "codex", launch: LaunchSpec, kind: "hook" | "hook-end" = "hook"): string {
  const q = (s: string) => `"${forwardSlashes(s)}"`;
  const exe = forwardSlashes(launch.node);
  const first = /[\s"'`$&|;<>()^!*?[\]{}~#%]/u.test(exe) ? "node" : exe;
  return `${first} ${q(launch.cli)} ${kind} ${client} --connection ${launch.connectionId} --data ${q(launch.dataDir)}`;
}
```

and in `secondFileContents` build:

```ts
  const command = (kind: "hook" | "hook-end") => ({ hooks: [{ type: "command", command: hookCommand(client, launch, kind), timeout: 5 }] });
  // UserPromptSubmit: recall on every prompt. Stop: a session note from the marker lines of the reply that just ended
  // (Claude Code: https://code.claude.com/docs/en/hooks "Stop"; Codex: https://learn.chatgpt.com/codex/hooks "Stop"; both carry last_assistant_message).
  const hooks = { UserPromptSubmit: [command("hook")], Stop: [command("hook-end")] };
```

Update the comment above `CODEX_HOOKS_CONFIRMED` to say the `Stop` event (fields `stop_hook_active`, `last_assistant_message`, JSON required on stdout) was confirmed on 2026-11-03 at `https://learn.chatgpt.com/codex/hooks`.

In `AGENT_HINTS`, append to the `codex` and `"claude-code"` strings: ` To get a session note, end a reply with lines like "Decided: <topic>: <decision>", "Open question: …" and "Next step: …".` (Keep `agentHint("codex")` ending as the test expects: the hooks sentence is appended after the hint.)

In `apps/web/connections/second-file.ts` add:

```ts
import { shortDate } from "../brain/format.ts";

/** The line under a connection about its session notes. Only a hook file that carries the Stop entry can produce them; "on" waits for the first saved note. */
export function writebackLabel(grant: Pick<Grant, "client" | "writeback">, file: Pick<WrittenFile, "role" | "state" | "contents">): string {
  if (file.role === "rule") return "Session notes: by hand (Cursor has no end-of-turn hook)";
  if (!/"Stop"\s*:/u.test(file.contents)) return "Session notes: not set up for this connection. Add the agent again to get them.";
  if (file.state === "exists") return "Session notes: add the hook yourself";
  if (grant.writeback.notes === 0) return grant.client === "codex" ? "Session notes: on after Codex trusts the hook" : "Session notes: on after your next session";
  return `Session notes: ${grant.writeback.notes} saved · last ${shortDate(grant.writeback.last_at!)}`;
}
```

In `ConnectionList.tsx`, inside the `.map((f) => ...)` of non-server files, add a second paragraph after the existing one:

```tsx
                    <p key={`${f.path}-notes`} className="tv-faint cx-second">
                      {writebackLabel(g, f)}
                    </p>
```

(Wrap the two paragraphs in a fragment keyed by `f.path`.)

Docs:
- `docs/AGENT_INTEGRATION.md`: add a "## Session notes (write-back hook)" section after "Recall push" that states: both hooks live in the same file; the `Stop` event for Claude Code (cite `https://code.claude.com/docs/en/hooks`, "Stop input": `stop_hook_active`, `last_assistant_message`) and Codex (cite `https://learn.chatgpt.com/codex/hooks`: 14 events, `Stop` with the same two fields, "expects JSON on `stdout`"); `SessionEnd` not used (no message, 1.5 s / 1 s budgets); Cursor has no hooks and keeps the rule; what the hook sends (first 4,000 code points, loopback only, 2,500 ms budget, `{}` on stdout, exit 0 always, hashes only in state, 12 per session); what the server keeps (marker lines only), and the Connections wording.
- `docs/UX.md` Connections "Waiting" paragraph: add the "Session notes: …" lines as in `writebackLabel`.
- `docs/API.md`: add `| POST /agent/session-note | session_id (hash), client, text (4,000 chars) | Agent grant with \`propose_memory\`: marker lines become a session note (\`{saved, source_id, suggestions, open_questions, duplicate}\`) or \`{saved: false, reason}\`; one content-free log row |` and `| GET /connections | ... | adds \`writeback: {notes, last_at}\` |`.
- `README.md` line 42: append "With the hook written by Add, a reply that ends with `Decided:`, `Open question:` and `Next step:` lines becomes that note on its own."

- [ ] **Step 4: Run the tests and the browser journey**

Run: `npx vitest run tests/integration/agent-setup.test.ts tests/integration/second-file-copy.test.ts tests/integration/agent-connect.test.ts tests/integration/bibrain-hook.test.ts && npm run typecheck && npm run lint && npm run build && npx playwright test tests/e2e/connections-v2.spec.ts --workers=1 && git restore docs/screenshots`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/domain/agents.ts apps/web/connections/second-file.ts apps/web/connections/ConnectionList.tsx docs/AGENT_INTEGRATION.md docs/UX.md docs/API.md README.md tests/integration/agent-setup.test.ts tests/integration/second-file-copy.test.ts tests/e2e/connections-v2.spec.ts
git commit -m "feat(connections): Add writes the end-of-turn hook and the tile says what it does

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 12: The `context` import kind (Sonnet)

**Files:**
- Create: `packages/importers/context.ts`
- Modify: `packages/importers/local.ts:4-7,56-66`
- Test: `tests/integration/importer.test.ts` (append)

**Interfaces:**
- Produces: `isContextFile(relPath: string): boolean`, `CONTEXT_FILE_NAMES: readonly string[]`, `SKIPPED_FOLDERS: readonly string[]`; `parseImport` accepts `kind: "context"`.

- [ ] **Step 1: Write the failing test**

Append to `tests/integration/importer.test.ts` (import `isContextFile` from `../../packages/importers/context.ts`):

```ts
it("the context kind keeps only agent instruction files, on the page's rule and again on the server", () => {
  for (const ok of ["CLAUDE.md", "AGENTS.md", "docs/AGENTS.md", ".cursor/rules/style.mdc", ".cursorrules", ".github/copilot-instructions.md", "MEMORY.md", "CLAUDE.local.md", "GEMINI.md", ".windsurfrules"]) expect(isContextFile(ok), ok).toBe(true);
  for (const no of ["README.md", "node_modules/x/CLAUDE.md", ".git/AGENTS.md", "dist/CLAUDE.md", "src/index.ts", ".cursor/rules/notes.md", "claude.md.bak", "deep/a/b/c/d/e/AGENTS.md"]) expect(isContextFile(no), no).toBe(false);
  const s = new Storage(":memory:");
  try {
    const b = new Brain(s);
    const selection = {
      kind: "context",
      project_id: "inbox",
      entries: [
        { path: "CLAUDE.md", content: "# Northstar\nRun the tests before every commit." },
        { path: "README.md", content: "not an instruction file" },
        { path: ".cursor/rules/style.mdc", content: "---\nalwaysApply: true\n---\nUse two spaces." },
        { path: "AGENTS.md", content: "   " },
      ],
    };
    const preview = b.previewLocalImport(owner, selection);
    expect(preview.items.map((i) => i.title)).toEqual(["CLAUDE.md", ".cursor/rules/style.mdc"]);
    expect(preview.warnings).toEqual(["README.md: not an agent instruction file, skipped", "AGENTS.md: empty file skipped"]);
    const r = b.applyLocalImport(owner, selection, preview.checkpoint);
    expect(r.imported).toBe(2);
    const saved = b.sources(owner, "inbox");
    expect(saved.map((x) => [x.title, x.origin]).sort()).toEqual([[".cursor/rules/style.mdc", "manual"], ["CLAUDE.md", "manual"]]);
    expect(saved.find((x) => x.title === "CLAUDE.md")!.body).toBe("# Northstar\nRun the tests before every commit.");
    expect(() => b.previewLocalImport(owner, { ...selection, entries: Array.from({ length: 51 }, (_, i) => ({ path: `p${i}/CLAUDE.md`, content: "x" })) })).toThrow();
  } finally {
    s.close();
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/integration/importer.test.ts`
Expected: FAIL (`context.ts` not found; `kind` rejected).

- [ ] **Step 3: Implement**

Create `packages/importers/context.ts`:

```ts
/** The instruction files a developer already keeps for agents. Shared by the page (which reads nothing else) and the server (which refuses anything else). */
export const CONTEXT_FILE_NAMES = ["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", "GEMINI.md", "MEMORY.md", ".cursorrules", ".windsurfrules", "copilot-instructions.md"] as const;
export const SKIPPED_FOLDERS = ["node_modules", ".git", "dist", "build", "vendor", "target", "out"] as const;
const MAX_DEPTH = 5;

export function isContextFile(relPath: string): boolean {
  const parts = relPath.replaceAll("\\", "/").split("/").filter(Boolean);
  if (!parts.length || parts.length > MAX_DEPTH + 1) return false;
  if (parts.slice(0, -1).some((p) => (SKIPPED_FOLDERS as readonly string[]).includes(p))) return false;
  const name = parts[parts.length - 1];
  if ((CONTEXT_FILE_NAMES as readonly string[]).includes(name)) return name !== "copilot-instructions.md" || parts[parts.length - 2] === ".github";
  return /\.mdc$/u.test(name) && parts.length >= 3 && parts[parts.length - 3] === ".cursor" && parts[parts.length - 2] === "rules";
}
```

In `packages/importers/local.ts`: import `isContextFile`; change `kind: z.enum(["folder", "chat"])` to `z.enum(["folder", "chat", "context"])`; in the loop replace `if (input.kind === "folder") {` with `if (input.kind === "folder" || input.kind === "context") {` and inside it, before the extension check, add:

```ts
      if (input.kind === "context" && !isContextFile(path)) {
        warnings.push(`${path}: not an agent instruction file, skipped`);
        continue;
      }
      if (input.kind === "folder" && !/\.(txt|md)$/i.test(path)) {
```

(so the `.txt|.md` extension rule applies to `folder` only; `context` relies on `isContextFile`).

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/integration/importer.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/importers/context.ts packages/importers/local.ts tests/integration/importer.test.ts
git commit -m "feat(import): a context kind that keeps only agent instruction files

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 13: "Bring in what you already have" on the empty Today (Sonnet)

**Files:**
- Modify: `apps/web/today/TodayView.tsx:99-166` (empty state), `apps/web/today/types.ts` (`TodayProps.onBringIn`)
- Modify: `apps/web/src.tsx` (`previewAdapter` filter for `context`, pass `onBringIn`, the adapter-import dialog copy for `context`)
- Modify: `docs/UX.md` "Today" new-brain line
- Test: `tests/e2e/today-v2-empty.spec.ts` (append one test)

**Interfaces:**
- Consumes: `isContextFile` (Task 12), `previewAdapter(kind, list)` in `src.tsx`.
- Produces: `TodayProps.onBringIn: (files: FileList) => Promise<void>`.

- [ ] **Step 1: Write the failing test**

Append to `tests/e2e/today-v2-empty.spec.ts`:

```ts
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("bring in what you already have: only instruction files are read, shown first, then saved as your originals", async ({ page }) => {
  await pair(page);
  const repo = mkdtempSync(join(tmpdir(), "bibrain-repo-"));
  writeFileSync(join(repo, "CLAUDE.md"), "# Northstar\nRun the tests before every commit. BRING_IN_E2E_CANARY");
  writeFileSync(join(repo, "README.md"), "# Not an instruction file");
  mkdirSync(join(repo, ".cursor", "rules"), { recursive: true });
  writeFileSync(join(repo, ".cursor", "rules", "style.mdc"), "Use two spaces.");
  mkdirSync(join(repo, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(repo, "node_modules", "pkg", "CLAUDE.md"), "never read");
  await expect(page.getByRole("heading", { name: "Bring in what you already have" })).toBeVisible();
  await page.getByLabel("Choose a project folder").setInputFiles(repo);
  const dialog = page.getByRole("dialog", { name: "Review import" });
  await expect(dialog).toContainText("2 agent instruction files ready for Inbox");
  await expect(dialog).toContainText("CLAUDE.md");
  await expect(dialog).toContainText(".cursor/rules/style.mdc");
  await expect(dialog).not.toContainText("README.md");
  await expect(dialog).not.toContainText("node_modules");
  await dialog.getByRole("button", { name: "Save selected items" }).click();
  await expect(page.getByRole("heading", { name: "Good to see you." })).toBeVisible();
  await page.getByRole("button", { name: "Your brain", exact: true }).click();
  await expect(page.getByText("Saved by you").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "CLAUDE.md" })).toBeVisible();
});
```

Playwright's `setInputFiles` with a directory path fills a `webkitdirectory` input with that folder's files and their relative paths. The two tests in this spec share one empty server; this one runs second and leaves the brain non-empty, so keep it last in the file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx playwright test tests/e2e/today-v2-empty.spec.ts --workers=1; git restore docs/screenshots`
Expected: FAIL (no such heading).

- [ ] **Step 3: Implement the page**

In `apps/web/today/types.ts` add to `TodayProps`: `/** The empty-state folder pick: the page keeps only agent instruction files and previews them before anything is saved. */ onBringIn: (files: FileList) => Promise<void>;`

In `TodayView.tsx`, replace the third `tv-step` (the "Import a folder" card) with:

```tsx
            <div className="tv-step">
              <span className="tv-step-n">Two minutes</span>
              <h3>Bring in what you already have</h3>
              <p>
                Your CLAUDE.md, AGENTS.md and Cursor rules already describe
                your projects. Pick a project folder; BiBrain reads only those
                files and shows them before anything is saved. Your agent's
                own memory folder works too.
              </p>
              <label className="tv-btn tv-file">
                Choose a project folder
                <input
                  type="file"
                  aria-label="Choose a project folder"
                  multiple
                  {...({ webkitdirectory: "" } as Record<string, string>)}
                  onChange={(e) => {
                    const files = e.target.files;
                    if (files) void props.onBringIn(files);
                    e.target.value = "";
                  }}
                />
              </label>
            </div>
```

Add to `apps/web/today/today.css` a rule that visually hides the input inside `.tv-file` while keeping it focusable (`position:absolute; width:1px; height:1px; opacity:0;`), and keep the label focusable with `tabIndex={0}` if the design system needs it.

In `apps/web/src.tsx`:
- import `isContextFile` from `../../packages/importers/context.ts`;
- in `previewAdapter`, widen `kind` to `"folder" | "chat" | "context"` and, right after `picked` is built, add `const kept = kind === "context" ? picked.filter(({ path }) => isContextFile(path)) : picked;` and use `kept` for the count, size checks and `entries` (so no file outside the allowlist is ever read); for `context` make the "at most 50" error read "This folder has more than 50 instruction files. Pick a smaller folder.";
- pass `onBringIn={(files) => act(() => previewAdapter("context", files))}` to `<TodayView>`;
- in the adapter-import dialog, when `adapterSelection.kind === "context"` render the first paragraph as `{adapterPreview.items.length} agent instruction files ready for {projectName(adapterSelection.project_id)}. They are saved exactly as written, as your own originals.`

`docs/UX.md` Today section: change "New brain: a welcome with three ways to start (plug in an agent, paste something, import a folder)." to "(plug in an agent, paste something, bring in the instruction files a project folder already holds: CLAUDE.md, AGENTS.md, Cursor rules and the agent's memory file, previewed before saving)."

- [ ] **Step 4: Run the tests**

Run: `npm run typecheck && npm run lint && npm run build && npx playwright test tests/e2e/today-v2-empty.spec.ts tests/e2e/today-v2.spec.ts --workers=1; git restore docs/screenshots`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/today/TodayView.tsx apps/web/today/types.ts apps/web/today/today.css apps/web/src.tsx docs/UX.md tests/e2e/today-v2-empty.spec.ts
git commit -m "feat(today): bring in the instruction files a project folder already holds

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 14: Full verification and BUILD_STATE (Sonnet)

**Files:**
- Modify: `BUILD_STATE.md` ("At a glance" rows for Agent connections and Recall; a new "## 2026-11-03 — Plan 8: security hardening and the safe write-back loop" section above plan 7), `NEXT_AGENT_HANDOFF.md` if it lists the next plan

- [ ] **Step 1: Run every gate, in this order, and keep the real counts**

```bash
mkdir -p "C:/Users/Gowrishankar/AppData/Local/Temp/opencode"
npm run typecheck
npm run lint
npm run build
npm audit --audit-level=high
npx vitest run --reporter=dot --maxWorkers=3
npm run brain-eval
npx playwright test --workers=1
git restore docs/screenshots
```

Expected: every command exits 0; the snapshot test and the golden set unchanged. If a Playwright test fails under load, rerun that file alone three times and record both results.

- [ ] **Step 2: Write the BUILD_STATE section**

Record, in the style of the plan-7 section: the spec and plan paths; what shipped (A1 provenance with the four review paths and the push cap; A2 limiter keys and `trustProxy: 1`; the five small items; the `Stop` hook for both clients with the two documentation URLs and the date they were read; the context import); the exact commands and counts from Step 1; and Known limits: the `Stop` hook has not been run natively in Claude Code or Codex (owner-run, same gate as the recall proof: `scripts/native-client-proof.ts` can be extended later); no real model run; the parked items are in `docs/superpowers/plans/2026-11-03-safe-write-back-followups.md`. Update the "Agent connections" and "Recall" rows in "At a glance" in one clause each, and "Next plans" to name the native run of the end-of-turn hook.

- [ ] **Step 3: Commit**

```bash
git add BUILD_STATE.md NEXT_AGENT_HANDOFF.md
git commit -m "docs: record plan 8 (security hardening and the safe write-back loop) verification counts

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Self-review notes

- Spec coverage: A1 → Tasks 1, 2, 3; A2 → Task 4; A3 L1/L3/L5/I2 → Task 5, I1 → Task 1, L6 → Task 6, L8 → Task 7; A4 → Task 8; B1 → Tasks 9, 10, 11; B2 → Tasks 12, 13; verification → Task 14.
- Names used across tasks: `written_by`, `WrittenBy`, `isUnreviewedAgent`, `Brain.writtenBy`, `Brain.sourceView`, `Brain.markSourceReviewed`, `Brain.sessionNote`, `Grant.writeback`, `hookCommand(client, launch, kind)`, `parseSessionNote`, `MARKER_LINE`, `hasMarkerLine`, `isContextFile`, `rateLimitKey`, `deploymentPolicy(origin, port, devOrigins)`.
- Review Focus 1 → Task 10; 2 → Task 4; 3 → Tasks 9 and 10; 4 → Tasks 12 and 13; 5 → Task 1.
