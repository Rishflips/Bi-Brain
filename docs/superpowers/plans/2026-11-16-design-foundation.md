# Design Foundation and L3 Proposals (plan 11) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the six L3 proposals of the November 2026 design audit: one stylesheet foundation with honest token names and a rem type scale, one save affordance on Today, a one-row phone header, one "Background help" card in Settings, and a self-ticking setup checklist on Connections.

**Architecture:** Web only (`apps/web`); no server, storage, permission, budget or API change. The stylesheet fold is proven neutral by a computed-style snapshot of every element in 21 walked states at three widths and both appearances, compared before and after by a script; the UI changes that follow are small recompositions of existing controls over existing endpoints, each with pure logic in its own module and a browser test.

**Tech Stack:** React 19, TypeScript 6, Vite 8, plain CSS with custom properties, Vitest 5, Playwright 1.63 (Chromium, plus one CDP session in the walk script). No new dependency.

**Spec:** `docs/design/AUDIT-2026-11.md` (section 4 is the scope; sections 1, 5 and 7 are the taste baseline, the correctness floor and the limits). Supporting: `docs/DESIGN_SYSTEM.md`, `docs/UX.md`, `AGENTS.md`.

## Global Constraints

- Work only in the worktree `C:/Users/Gowrishankar/Desktop/Bi Brain/.worktrees/design` (branch `reframe/design-foundation`, from main `4730d25`). Never touch `C:/Users/Gowrishankar/Desktop/Bi Brain` itself. Never read `data/` in the main checkout or any `.env`.
- Never `git add .`; add explicit paths. No rebase, no force-push, no bare `git stash`, no push. Commit trailer on every commit: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Frozen, never touch: any `dodo*`, `billing*`, `managed*`, `paddle*` file (source and tests, including `tests/e2e/managed*.spec.ts` and `tests/e2e/billing-ui.spec.ts`); `managedPreferencesPatchSchema`; applied migrations; `docs/DODO_PAYMENTS.md`, `docs/RELEASE.md`, `docs/IMPLEMENTATION_PLAN.md`, `docs/PRICING_PROPOSAL_2026-10-21.md`, `docs/BUSINESS.md`. The billing card's CSS (`.billing-card`, `.plan-actions`) lives in the shared stylesheet and must keep working; the frozen specs must pass unedited.
- No server change of any kind: nothing under `apps/server`, `apps/worker`, `apps/mcp`, `apps/cli`, `packages/` is edited. No permission, budget, preference schema or API contract changes.
- Do NOT add any request to the web `refresh()` poll in `apps/web/src.tsx` (it runs every 2.5 s against a 1,000-a-minute limit; adding one broke the browser tests before). New UI reads data `refresh()` already fetches (`/connections`, `/preferences/background`, `/system-one/status`, `/preferences/recall-help`, `/preferences/better-search`, `/today`), or loads only while its own view is open.
- Primary navigation stays exactly Today, Your brain, Connections. Every visible control has real behaviour or a plainly stated unavailable reason. No invented ticks or state. Plain language; no model names, MCP, tokens or queues in the primary flow (existing Settings copy that names a service is moved verbatim, not rewritten).
- Accessibility: native semantic controls, visible focus (`--focus`, 2px solid, 2px offset), contrast AA in both appearances, 44px touch targets at 760px and below, nothing under 12px at the default text size, text follows the browser's text-size setting, no horizontal scroll at 320px.
- Token names, verbatim: `--canvas`, `--surface`, `--line`, `--line-strong`, `--muted`, `--subtle`, `--ink`, `--on-ink`, `--signal`, `--gold`, `--gold-wash`, `--attention`, `--focus`, `--shadow`, `--radius-control` (9px), `--radius-card` (14px). Old names that must not survive: `--green`, `--green-deep`, `--on-green`, `--pulse`, `--pulse-soft`, `--lime`, `--amber`, `--surface-glass`.
- Tests: Vitest with `--maxWorkers=2` (a single file with `--maxWorkers=1`), Playwright with `--workers=1`, never both at once, always sequential. Run `npm run build` before any Playwright run or walk (the server serves `dist/web`). After every Playwright run: `git restore docs/screenshots`. The frozen billing tests need the folder `C:/Users/Gowrishankar/AppData/Local/Temp/opencode` (`New-Item -ItemType Directory -Force`). Every run uses its own throwaway `BRAIN_DB` (the Playwright config and the walk script already do) with `BRAIN_EMBED_PROVIDER=off` or the fake embedder. Never call a real Ollama or Cloudflare.
- Pairing is limited to 10 a minute per server: new browser tests go into the existing spec files named in each task and use that file's shared sign-in helper. Do not add a new spec file.
- The repository is public: neutral wording in code, comments, commits and docs. A committed image must not show a local path or a user name; look at each before `git add`.
- Owner's standing rule: every decision must make it better for the person using it, the developer and the agent together, without breaking anything.
- Gate baseline (BUILD_STATE.md, 2026-11-12): Vitest 2,118–2,121 passed and 8 skipped across 199 files; Playwright 111 passed; `npm run brain-eval` 57/57; `npm run typecheck`, `npm run lint`, `npm run build` exit 0.
- Evidence folder outside the repository (large JSON never committed): `C:/Users/Gowrishankar/AppData/Local/Temp/bibrain-plan11/` (called `$EVID` below).

## Rulings made while planning

1. **The header's Save something is hidden on Today in the local app only.** The frozen `managed*.spec.ts` files wait for that button right after sign-in, and the disconnected and sample states keep it (disabled) as today. Condition: `paired && !demo && nav === "Today" && runtime?.mode === "local"`.
2. **The status line moves into Today's header at every width**, not only on phones. It is computed from Today's Brief, so it is only fresh there; one element, one place.
3. **The one "Background help" card is the local app's.** Managed mode keeps the existing "Background help & spending" card with identical markup, because frozen specs pin its heading, labels and order.
4. **Gating never traps a consent.** A choice that is already on stays operable so it can be turned off. Better search's "Off" and "On this computer" are never gated (nothing leaves the computer and nothing is spent; plan 10 turns it on by itself); only "Cloudflare" waits for saved steps 1 and 2.
5. **Checklist signals.** "Open the agent here" and "Approve BiBrain" both tick from the first recorded call (`last_verified_at`); BiBrain records nothing that separates them. "Ask anything" ticks from the first recorded push (`recall.pushes > 0`) when BiBrain wrote the prompt hook, otherwise from the first call (a tool call only happens in answer to a prompt).
6. **Committed screenshots are six states** at three widths in both appearances, before and after, plus one picture of the checklist per appearance (74 PNG). All 21 states are compared by the script; its report is committed.

## Review Focus

1. **A screen the walk does not open loses its styling in the fold** (the paused billing card, a typo'd token that silently falls back). Expected: every `var(--x)` resolves in both appearances and the billing selectors exist. Pinned by the static stylesheet test in Task 2, plus the six extra walked states in Task 1.
2. **A person with a larger default text size on a 390px phone.** Expected: text grows, nothing scrolls sideways, the bar stays usable. Pinned in Task 3.
3. **Sorting help is already on and the person turns off step 1 or sets a limit to 0.** Expected: the ticked choices stay operable so they can be turned off, and Save sends the same request body as before. Pinned in Task 6 (unit and browser).
4. **A connection whose hook file already existed, an expired or revoked connection, or a push that arrives before any tool call.** Expected: no tick without a recorded signal, no checklist on ended access, and the checklist goes away when complete. Pinned in Task 7.
5. **A 320px phone with the longest status ("Couldn't check for changes") and a header holding both Save something and Settings.** Expected: the header stays one row, the status wraps under the title, nothing is clipped. Pinned in Tasks 4 and 5.

## File Structure

| File | Responsibility | Task |
| --- | --- | --- |
| `scripts/design-audit-walk.mjs` (modify) | Walk; gains `--stable`, `--sizes`, `--styles`, six more states | 1, 7 |
| `scripts/design-compare.mjs` (create) | Compares two walk outputs: computed styles, forced states, pixels | 1 |
| `apps/web/styles/tokens.css` (create) | Every custom property, light and dark, nothing else | 2 |
| `apps/web/styles/app.css` (create) | The one base stylesheet (replaces `style.css` and `refinement.css`) | 2, 3, 5, 6 |
| `apps/web/style.css`, `apps/web/refinement.css` (delete) | | 2 |
| `apps/web/today/today.css`, `brain/brain.css`, `connections/connections.css` (modify) | Screen sheets, loaded after the base | 2, 3, 4, 7 |
| `tests/integration/web-styles.test.ts` (create) | Static invariants of the stylesheets | 2, 3 |
| `apps/web/src.tsx` (modify) | Imports; masthead; Settings card composition | 2, 4, 5, 6 |
| `apps/web/today/TodayView.tsx`, `today/types.ts` (modify) | Today's header with the status | 4 |
| `apps/web/settings/background-steps.ts` (create) | Pure step gating for the Background help card | 6 |
| `tests/integration/background-steps.test.ts` (create) | | 6 |
| `apps/web/better-search-copy.ts` (modify) | One sentence that said "below" | 6 |
| `apps/web/connections/setup-checklist.ts` (create) | Pure checklist from a connection's recorded signals | 7 |
| `apps/web/connections/SetupChecklist.tsx` (create) | The checklist and its Details disclosure | 7 |
| `apps/web/connections/ConnectionList.tsx` (modify) | Renders the checklist in place of the hint | 7 |
| `tests/integration/setup-checklist.test.ts` (create) | | 7 |
| `tests/e2e/today-v2.spec.ts`, `system-one.spec.ts`, `better-search.spec.ts`, `connections-v2.spec.ts`, `app.spec.ts`, `review-journeys.spec.ts`, `spending-review.spec.ts` (modify) | Browser tests | 3–7 |
| `docs/DESIGN_SYSTEM.md`, `docs/UX.md` (modify) | Tokens, type scale, Today, Settings, Connections copy | 2–7 |
| `docs/design/plan-11/` (create) | `before/`, `after/`, `REPORT.md` | 1, 8 |
| `BUILD_STATE.md`, `README.md`, `CHANGELOG.md`, `docs/design/AUDIT-2026-11.md` (modify) | Final state | 8 |

---

### Task 1: Visual-regression tooling and the baseline (Sonnet)

**Files:**
- Modify: `scripts/design-audit-walk.mjs`
- Create: `scripts/design-compare.mjs`
- Create: `docs/design/plan-11/before/light/*.png`, `docs/design/plan-11/before/dark/*.png` (18 each)

**Interfaces:**
- Produces: `node scripts/design-audit-walk.mjs <out> [--dark] [--only=a,b] [--stable] [--sizes=WxH,WxH,WxH] [--styles|--styles=full]`, writing `<state>--<viewport>.png` and, with `--styles`, `<state>--<viewport>.styles.json` of shape `{ elements: { [path]: { all, rect, ...kept properties, "::before"?, "::after"? } }, forced?: { ["<path> :hover|:focus|:active"]: hash } }`.
- Produces: `node scripts/design-compare.mjs <before> <after> [--report=file.md] [--expect-changes]`; exit code 1 when any style, forced-state or DOM difference exists and `--expect-changes` is absent.
- Produces: baseline folders `$EVID/before-light` and `$EVID/before-dark`, captured on the untouched stylesheets.

No CSS or app source changes in this task.

- [ ] **Step 1: Add the flags and the stable work folder to the walk**

In `scripts/design-audit-walk.mjs`, change the `node:fs` import to include `rmSync`:

```js
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
```

Replace the `widths` constant and the `work` line with:

```js
const stable = process.argv.includes("--stable");
const stylesArg = process.argv.find((a) => a === "--styles" || a.startsWith("--styles="));
// "hash": one hash of every computed property per element plus a kept list in clear. "full": also the text behind each hash.
const styles = stylesArg ? (stylesArg.includes("=") ? stylesArg.split("=")[1] : "hash") : null;
const sizes = (process.argv.find((a) => a.startsWith("--sizes=")) ?? "").slice(8).split(",").filter(Boolean);
const widths = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "tablet", width: 820, height: 1180 },
  { name: "phone", width: 390, height: 844 },
].map((w, i) => {
  const m = /^(\d+)x(\d+)$/.exec(sizes[i] ?? "");
  return m ? { ...w, width: Number(m[1]), height: Number(m[2]) } : w;
});

mkdirSync(out, { recursive: true });
// --stable: the same folder every run, so a path shown on screen is the same text in two runs.
const work = stable ? join(tmpdir(), "bibrain-audit-stable") : mkdtempSync(join(tmpdir(), "bibrain-audit-"));
if (stable) {
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
}
```

(Delete the original `mkdirSync(out, { recursive: true });` and `const work = mkdtempSync(...)` lines so each appears once.) Update the usage comment at the top of the file to list the new flags. In the Connections part, replace `const folder = mkdtempSync(join(tmpdir(), "bibrain-audit-repo-"));` with:

```js
  const folder = stable ? join(work, "repo") : mkdtempSync(join(tmpdir(), "bibrain-audit-repo-"));
  mkdirSync(folder, { recursive: true });
```

- [ ] **Step 2: Add the computed-style snapshot**

Add these two functions after `measure()`:

```js
// Every element's computed style, keyed by its position in the tree. Runs inside the page.
function styleSnapshot(mode) {
  const KEEP = ["display", "position", "box-sizing", "width", "height", "min-width", "min-height", "max-width", "margin-top", "margin-right", "margin-bottom", "margin-left", "padding-top", "padding-right", "padding-bottom", "padding-left", "border-top-width", "border-right-width", "border-bottom-width", "border-left-width", "border-top-style", "border-top-color", "border-right-color", "border-bottom-color", "border-left-color", "border-top-left-radius", "border-top-right-radius", "border-bottom-right-radius", "border-bottom-left-radius", "background-color", "background-image", "color", "font-family", "font-size", "font-weight", "line-height", "letter-spacing", "text-transform", "text-align", "text-decoration-line", "white-space", "opacity", "box-shadow", "outline-style", "outline-width", "outline-color", "outline-offset", "row-gap", "column-gap", "flex-direction", "flex-wrap", "justify-content", "align-items", "grid-template-columns", "order", "z-index", "overflow-x", "overflow-y", "cursor", "visibility", "accent-color"];
  const hash = (text) => {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
  };
  // Custom properties are left out: renaming a token must not read as a change.
  const all = (s) => {
    let t = "";
    for (const p of s) if (!p.startsWith("--")) t += `${p}:${s.getPropertyValue(p)};`;
    return t;
  };
  const pathOf = (el) => {
    const parts = [];
    for (let n = el; n && n !== document.body; n = n.parentElement) parts.unshift(`${n.tagName.toLowerCase()}:${Array.prototype.indexOf.call(n.parentElement.children, n)}`);
    return parts.join(">") || "body";
  };
  const elements = {};
  for (const el of document.querySelectorAll("body, body *")) {
    const tag = el.tagName.toLowerCase();
    if (tag === "script" || tag === "style" || (el.closest("svg") && tag !== "svg")) continue;
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const text = all(s);
    const row = { all: hash(text), rect: [r.x, r.y, r.width, r.height].map((v) => Math.round(v * 2) / 2).join(" ") };
    for (const p of KEEP) row[p] = s.getPropertyValue(p);
    if (mode === "full") row.text = text;
    for (const pseudo of ["::before", "::after"]) {
      const ps = getComputedStyle(el, pseudo);
      if (ps.content !== "none" && ps.content !== "normal") row[pseudo] = mode === "full" ? all(ps) : hash(all(ps));
    }
    elements[pathOf(el)] = row;
  }
  return { elements };
}

// Hover, keyboard focus and pressed styles of every control, forced through the DevTools protocol.
const INTERACTIVE = "button, a[href], input, select, textarea, summary, label";
async function forcedStates(page, mode) {
  const paths = await page.evaluate((selector) => {
    const pathOf = (el) => {
      const parts = [];
      for (let n = el; n && n !== document.body; n = n.parentElement) parts.unshift(`${n.tagName.toLowerCase()}:${Array.prototype.indexOf.call(n.parentElement.children, n)}`);
      return parts.join(">") || "body";
    };
    return [...document.querySelectorAll(selector)].map(pathOf);
  }, INTERACTIVE);
  const client = await page.context().newCDPSession(page);
  await client.send("DOM.enable");
  await client.send("CSS.enable");
  const { root } = await client.send("DOM.getDocument", { depth: 0 });
  const { nodeIds } = await client.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector: INTERACTIVE });
  if (nodeIds.length !== paths.length) throw new Error(`forced states: ${nodeIds.length} nodes, ${paths.length} paths`);
  const hash = (text) => {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
  };
  const out = {};
  for (let i = 0; i < nodeIds.length; i++) {
    for (const [name, forced] of [["hover", ["hover"]], ["focus", ["focus", "focus-visible"]], ["active", ["hover", "active"]]]) {
      await client.send("CSS.forcePseudoState", { nodeId: nodeIds[i], forcedPseudoClasses: forced });
      const { computedStyle } = await client.send("CSS.getComputedStyleForNode", { nodeId: nodeIds[i] });
      const text = computedStyle.filter((p) => !p.name.startsWith("--")).map((p) => `${p.name}:${p.value};`).join("");
      out[`${paths[i]} :${name}`] = mode === "full" ? text : hash(text);
    }
    await client.send("CSS.forcePseudoState", { nodeId: nodeIds[i], forcedPseudoClasses: [] });
  }
  await client.detach();
  return out;
}
```

In `capture()`, inside the `for (const w of widths)` loop, after `report.push({ state, viewport: w.name, issues });` add:

```js
    if (styles) {
      const snap = await page.evaluate(styleSnapshot, styles);
      // Forced states once per state, at the widest size.
      if (w.name === "desktop") snap.forced = await forcedStates(page, styles);
      writeFileSync(join(out, `${state}--${w.name}.styles.json`), JSON.stringify(snap));
    }
```

- [ ] **Step 3: Add six states the walk did not open**

After the `01-first-run` keyboard check (before `await page.getByLabel("Installation code").fill(code);`) add:

```js
  // The sample view, reachable only before pairing.
  await page.getByRole("button", { name: "Explore a safe example" }).click();
  await page.getByRole("heading", { name: "Try one conversation first." }).waitFor();
  await capture(page, "01b-sample");
  await page.getByRole("button", { name: "Return to my brain" }).click();
  await page.getByLabel("Installation code").waitFor();
```

After `await capture(page, "15-settings");` add:

```js
  // Dialogs and views the earlier steps do not open, so the stylesheet fold is checked on them too.
  const openDialog = async (state, open) => {
    await open();
    await page.locator("dialog[open]").waitFor();
    await page.waitForTimeout(300);
    await capture(page, state, { dialog: true });
    await page.keyboard.press("Escape");
    await page.locator("dialog[open]").waitFor({ state: "detached" });
  };
  await openDialog("16-settings-import", () => page.getByRole("button", { name: "Import an export" }).click());
  await page.getByRole("button", { name: "Your brain", exact: true }).click();
  await page.getByRole("heading", { name: "Your brain", level: 1 }).waitFor();
  await openDialog("17-save-dialog", () => page.locator("header.masthead").getByRole("button", { name: /Save something/ }).click());
  await openDialog("18-project-dialog", () => page.getByRole("button", { name: "New project", exact: true }).click());
  await openDialog("19-goal-dialog", () => page.getByRole("button", { name: "Choose a goal" }).first().click());
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  await openDialog("20-handoff-dialog", () => page.getByRole("button", { name: "Preview handoff" }).click());
```

If a dialog does not close on Escape (the `detached` wait times out), close it with its own Close or Cancel button instead and keep the state.

- [ ] **Step 4: Write the compare script**

Create `scripts/design-compare.mjs`:

```js
// Compares two outputs of scripts/design-audit-walk.mjs run with --styles.
//
//   node scripts/design-compare.mjs <before-dir> <after-dir> [--report=file.md] [--expect-changes]
//
// Styles: every element's computed style, its box, its ::before and ::after, and the forced hover, focus and pressed
// styles of every control. Pixels: every PNG, counted in a browser canvas. Exit code 1 on any style, forced-state or
// tree difference, unless --expect-changes is given (then the differences are only reported).
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const [beforeDir, afterDir] = process.argv.slice(2, 4).map((p) => resolve(p));
if (!beforeDir || !afterDir) throw new Error("usage: design-compare.mjs <before-dir> <after-dir> [--report=file.md] [--expect-changes]");
const reportPath = (process.argv.find((a) => a.startsWith("--report=")) ?? "").slice(9);
const expectChanges = process.argv.includes("--expect-changes");
const SKIP = new Set(["rect", "all", "text"]);

const rows = [];
const notes = [];
let failing = 0;
for (const file of readdirSync(beforeDir).filter((f) => f.endsWith(".styles.json")).sort()) {
  const name = file.replace(".styles.json", "");
  if (!existsSync(join(afterDir, file))) {
    rows.push({ name, tree: "missing", style: "", forced: "", rect: "" });
    failing++;
    continue;
  }
  const a = JSON.parse(readFileSync(join(beforeDir, file), "utf8"));
  const b = JSON.parse(readFileSync(join(afterDir, file), "utf8"));
  let tree = 0;
  let style = 0;
  let rect = 0;
  let forced = 0;
  const note = (text) => {
    if (notes.length < 300) notes.push(`${name}: ${text}`);
  };
  for (const path of new Set([...Object.keys(a.elements), ...Object.keys(b.elements)])) {
    const x = a.elements[path];
    const y = b.elements[path];
    if (!x || !y) {
      tree++;
      note(`${x ? "removed" : "added"} ${path}`);
      continue;
    }
    const changed = Object.keys({ ...x, ...y }).filter((k) => !SKIP.has(k) && x[k] !== y[k]);
    if (changed.length || x.all !== y.all) {
      style++;
      note(`${path} ${changed.length ? changed.map((k) => `${k}: ${x[k]} -> ${y[k]}`).join("; ") : `a property outside the kept list differs (rerun both sides with --styles=full --only=${name.split("--")[0]})`}`);
    } else if (x.rect !== y.rect) {
      rect++;
      note(`${path} box ${x.rect} -> ${y.rect}`);
    }
  }
  const fa = a.forced ?? {};
  const fb = b.forced ?? {};
  for (const key of new Set([...Object.keys(fa), ...Object.keys(fb)]))
    if (fa[key] !== fb[key]) {
      forced++;
      note(`${key} differs`);
    }
  failing += tree + style + forced + rect;
  rows.push({ name, tree, style, forced, rect });
}

const browser = await chromium.launch();
const page = await browser.newPage();
const pixels = [];
for (const file of readdirSync(beforeDir).filter((f) => f.endsWith(".png")).sort()) {
  if (!existsSync(join(afterDir, file))) {
    pixels.push({ file, result: "missing after" });
    continue;
  }
  const result = await page.evaluate(
    async ([a, b]) => {
      const load = async (b64) => createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
      const [x, y] = await Promise.all([load(a), load(b)]);
      if (x.width !== y.width || x.height !== y.height) return `size ${x.width}x${x.height} -> ${y.width}x${y.height}`;
      const data = (img) => {
        const g = new OffscreenCanvas(img.width, img.height).getContext("2d");
        g.drawImage(img, 0, 0);
        return g.getImageData(0, 0, img.width, img.height).data;
      };
      const p = data(x);
      const q = data(y);
      let diff = 0;
      for (let i = 0; i < p.length; i += 4) if (Math.abs(p[i] - q[i]) > 2 || Math.abs(p[i + 1] - q[i + 1]) > 2 || Math.abs(p[i + 2] - q[i + 2]) > 2) diff++;
      return diff === 0 ? "same" : `${diff} of ${p.length / 4} pixels (${((diff * 400) / p.length).toFixed(3)}%)`;
    },
    [readFileSync(join(beforeDir, file)).toString("base64"), readFileSync(join(afterDir, file)).toString("base64")],
  );
  pixels.push({ file, result });
}
await browser.close();

const changedPixels = pixels.filter((p) => p.result !== "same");
const lines = [
  `Compared ${rows.length} style snapshots and ${pixels.length} screenshots.`,
  "",
  `Snapshots with a difference: ${rows.filter((r) => r.tree || r.style || r.forced || r.rect).length}. Screenshots with a difference: ${changedPixels.length}.`,
  "",
  "| Snapshot | Tree | Style | Forced state | Box only |",
  "| --- | ---: | ---: | ---: | ---: |",
  ...rows.filter((r) => r.tree || r.style || r.forced || r.rect).map((r) => `| ${r.name} | ${r.tree} | ${r.style} | ${r.forced} | ${r.rect} |`),
  "",
  "| Screenshot | Pixels |",
  "| --- | --- |",
  ...changedPixels.map((p) => `| ${p.file} | ${p.result} |`),
  "",
  "First differences:",
  "",
  ...notes.slice(0, 60).map((n) => `- ${n}`),
];
if (reportPath) writeFileSync(resolve(reportPath), lines.join("\n") + "\n");
console.log(lines.join("\n"));
if (failing && !expectChanges) process.exitCode = 1;
```

- [ ] **Step 5: Lint and build**

Run: `npm run lint` then `npm run build`
Expected: both exit 0.

- [ ] **Step 6: Capture the baseline twice and prove the walk is repeatable**

Run, one after the other (PowerShell; each takes several minutes):

```powershell
$EVID = "C:/Users/Gowrishankar/AppData/Local/Temp/bibrain-plan11"
$flags = "--stable", "--styles", "--sizes=1280x900,768x1024,390x844"
node scripts/design-audit-walk.mjs "$EVID/before-light" @flags
node scripts/design-audit-walk.mjs "$EVID/selfcheck-light" @flags
node scripts/design-compare.mjs "$EVID/before-light" "$EVID/selfcheck-light"
node scripts/design-audit-walk.mjs "$EVID/before-dark" @flags --dark
node scripts/design-audit-walk.mjs "$EVID/selfcheck-dark" @flags --dark
node scripts/design-compare.mjs "$EVID/before-dark" "$EVID/selfcheck-dark"
```

Expected: both compares print "Snapshots with a difference: 0" and exit 0. If a state differs between two identical runs, it is timing, not style: lengthen the wait before that state's `capture()` (or wait for a specific element) until two runs agree. Do not exclude a state. Record in the commit message any wait you changed.

- [ ] **Step 7: Commit the six-state "before" set**

```powershell
$states = "01-first-run", "02-today-empty", "04-today-brief", "08-brain-project", "11-connections", "15-settings"
foreach ($theme in "light", "dark") {
  New-Item -ItemType Directory -Force "docs/design/plan-11/before/$theme" | Out-Null
  foreach ($s in $states) { foreach ($w in "desktop", "tablet", "phone") { Copy-Item "$EVID/before-$theme/$s--$w.png" "docs/design/plan-11/before/$theme/" } }
}
```

Open each of the 36 files; none may show a local path or a user name (state `13-connections-waiting` does and is deliberately not in the list).

- [ ] **Step 8: Commit**

```bash
git add scripts/design-audit-walk.mjs scripts/design-compare.mjs docs/design/plan-11/before
git commit -m "test(design): style-snapshot walk, compare script and the plan 11 baseline" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: One stylesheet foundation with honest token names (Opus)

**Files:**
- Create: `apps/web/styles/tokens.css`, `apps/web/styles/app.css`, `tests/integration/web-styles.test.ts`
- Delete: `apps/web/style.css`, `apps/web/refinement.css`
- Modify: `apps/web/src.tsx` (imports at lines 19–36; `className` on the main `<nav>`), `apps/web/today/today.css`, `apps/web/brain/brain.css`, `apps/web/connections/connections.css`, `docs/DESIGN_SYSTEM.md`

**Interfaces:**
- Consumes: Task 1's walk flags, compare script and `$EVID/before-light`, `$EVID/before-dark`.
- Produces: the token names in Global Constraints; class `primary-nav` on the main navigation element; import order `tokens.css`, font, `app.css`, `today.css`, `brain.css`, `connections.css`.

This task gives a procedure and a machine gate instead of the final file text, because the final text is the result of reducing 2,732 lines while a proof holds. **The gate after every pass:** `npm run build`, capture light and dark with the Task 1 flags into `$EVID/fold-light` and `$EVID/fold-dark`, and both `node scripts/design-compare.mjs "$EVID/before-<theme>" "$EVID/fold-<theme>"` runs exit 0 with "Snapshots with a difference: 0". A pass that cannot reach 0 is reverted, not argued with. While iterating you may capture with `--only=<states>` for speed; the full capture decides. No font size changes in this task (Task 3).

- [ ] **Step 1: Write the failing static test**

Create `tests/integration/web-styles.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";

const read = (path: string) => readFileSync(`apps/web/${path}`, "utf8");
const SHEETS = ["styles/tokens.css", "styles/app.css", "today/today.css", "brain/brain.css", "connections/connections.css"];
const everything = () => SHEETS.map(read).join("\n");
/** The declarations of the first rule whose selector is exactly `selector`. */
const block = (css: string, selector: string) => {
  const at = css.indexOf(`${selector} {`);
  return at < 0 ? "" : css.slice(at, css.indexOf("}", at));
};
const COLOR_TOKENS = ["--canvas", "--surface", "--line", "--line-strong", "--muted", "--subtle", "--ink", "--on-ink", "--signal", "--gold", "--gold-wash", "--attention", "--focus"];

describe("web stylesheet foundation", () => {
  it("is one token file and one base stylesheet", () => {
    expect(existsSync("apps/web/style.css")).toBe(false);
    expect(existsSync("apps/web/refinement.css")).toBe(false);
    for (const sheet of SHEETS) expect(existsSync(`apps/web/${sheet}`), sheet).toBe(true);
  });
  it("defines every token a stylesheet uses, and every colour in both appearances", () => {
    const tokens = read("styles/tokens.css");
    const light = block(tokens, ":root");
    const dark = block(tokens, ':root[data-theme="dark"]');
    const used = new Set([...everything().matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]));
    expect(used.size).toBeGreaterThan(8);
    for (const name of used) expect(light, `${name} is used but not defined`).toContain(`${name}:`);
    for (const name of COLOR_TOKENS) expect(dark, `${name} has no dark value`).toContain(`${name}:`);
    for (const name of ["--radius-control: 9px", "--radius-card: 14px"]) expect(light).toContain(name);
  });
  it("declares tokens only in the token file", () => {
    for (const sheet of SHEETS.slice(1)) expect(read(sheet), sheet).not.toMatch(/^\s*--[a-z0-9-]+\s*:/m);
  });
  it("has no earlier-era names, dead selectors or specificity hacks", () => {
    expect(everything()).not.toMatch(/--green|--on-green|--pulse|--lime|--amber|--surface-glass|:root:root|\.today-hero|\.mark\b|\.brain-network|\.entry-orbit|\.saved-note|!important/);
  });
  it("keeps the selectors the paused billing card uses", () => {
    const app = read("styles/app.css");
    expect(app).toContain(".billing-card");
    expect(app).toContain(".plan-actions");
  });
  it("loads tokens, then the base, then the screens", () => {
    const src = read("src.tsx");
    const order = ["./styles/tokens.css", "./styles/app.css", "./today/today.css", "./brain/brain.css", "./connections/connections.css"].map((p) => src.indexOf(`import "${p}"`));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `npx vitest run tests/integration/web-styles.test.ts --reporter=dot --maxWorkers=1`
Expected: FAIL (`apps/web/style.css` exists; `styles/tokens.css` is missing).

- [ ] **Step 3: Pass A, one file by concatenation**

```bash
mkdir -p apps/web/styles
cat apps/web/style.css apps/web/refinement.css > apps/web/styles/app.css
git rm -q apps/web/style.css apps/web/refinement.css
```

In `apps/web/src.tsx` replace the two lines `import "./style.css";` and `import "./refinement.css";` with `import "./styles/app.css";` (leave every other import where it is for now). Run the gate. Expected: 0 differences (this proves the pipeline before anything is reduced). Commit:

```bash
git add apps/web/styles/app.css apps/web/src.tsx
git commit -m "refactor(web): one base stylesheet file (mechanical concatenation)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Pass B, the token file**

Create `apps/web/styles/tokens.css` with exactly:

```css
/* BiBrain design tokens. Every custom property lives here and nowhere else.
   Names say what a value is for, not what colour it once was (docs/DESIGN_SYSTEM.md). */
:root {
  --canvas: #f7f5ef;
  --surface: #fffefa;
  --line: #d9d5ca;
  --line-strong: #bdb6a8;
  --muted: #6a6861;
  --subtle: #eeebe3;
  /* Ink: text and the one dark button per region. */
  --ink: #181817;
  --on-ink: #ffffff;
  /* Signal: gold dark enough to read as text and links on paper. */
  --signal: #866400;
  /* Gold: the brand colour as a fill or a stroke, never as text. */
  --gold: #e3b500;
  --gold-wash: #fff3bd;
  --attention: #9b4b1b;
  /* Focus must reach 3:1 against every surface, so it is solid, never a tint. */
  --focus: #7a5c00;
  --shadow: 0 12px 32px rgb(31 27 17 / 8%);
  /* One radius for controls, one for cards and dialogs. */
  --radius-control: 9px;
  --radius-card: 14px;
}
:root[data-theme="dark"] {
  --canvas: #111111;
  --surface: #191918;
  --line: #34332f;
  --line-strong: #555149;
  --muted: #aaa69d;
  --subtle: #232321;
  --ink: #f8f6ef;
  --on-ink: #111111;
  --signal: #f2c735;
  --gold: #f2c735;
  --gold-wash: #3b3319;
  --attention: #f0a986;
  --focus: #ffd247;
}
```

These are the values that win the cascade today (the last `:root` and `:root[data-theme="dark"]` blocks of `refinement.css`); confirm each against the concatenated file before deleting anything, and correct this file, not the gate, if one differs.

In `apps/web/src.tsx` add `import "./styles/tokens.css";` immediately before `import "@fontsource-variable/manrope/wght.css";`.

Remove every custom-property declaration (`--name: value;`) from `apps/web/styles/app.css`, keeping the other declarations in those `:root` blocks (`font-family`, `color`, `background`, `font-size`, `font-synthesis`, `color-scheme`). Then rename uses in all four sheets (Bash tool; the longer names first):

```bash
cd "C:/Users/Gowrishankar/Desktop/Bi Brain/.worktrees/design/apps/web"
sed -i -e 's/var(--green-deep)/var(--ink)/g' -e 's/var(--on-green)/var(--on-ink)/g' -e 's/var(--green)/var(--signal)/g' \
  -e 's/var(--pulse-soft)/var(--gold-wash)/g' -e 's/var(--pulse)/var(--gold)/g' -e 's/var(--lime)/var(--gold)/g' \
  -e 's/var(--surface-glass)/var(--surface)/g' styles/app.css today/today.css brain/brain.css connections/connections.css
grep -n "var(--amber)\|--green\|--pulse\|--lime\|--surface-glass" styles/app.css today/today.css brain/brain.css connections/connections.css
```

Expected: the grep prints nothing. Run the gate (0 differences), then commit `apps/web/styles/tokens.css`, `apps/web/styles/app.css`, `apps/web/src.tsx` and the three screen sheets as `refactor(web): one token file with honest names`.

- [ ] **Step 5: Pass C, delete dead selectors**

List class selectors no source file uses (Bash tool):

```bash
cd "C:/Users/Gowrishankar/Desktop/Bi Brain/.worktrees/design/apps/web"
grep -o "\.[a-zA-Z][a-zA-Z0-9_-]*" styles/app.css | sort -u | while read c; do n=${c#.}; grep -rqE "[\"'\` ]$n[\"'\` ]" --include=*.tsx --include=*.ts --include=*.html . || printf "%s\n" "$n"; done
```

Planning found these candidates: `brain-network capture-entry dot-one dot-two dot-three entry-brain entry-neural-ring entry-orbit lede mark network-path note-icon note-preview orbit-dot orbit-one orbit-two orbit-three resume saved-note section-heading small-mark tick today-hero today-intro today-view toolbar connection-heading connection-history connection-status-connected connection-status-copy connection-status-needs-attention handoff-card section-kicker`. `layout` is a false positive (it is built in a template string in `src.tsx`) and stays.

Rules for deleting:
1. For each candidate run `grep -rn "<name>" apps/web --include=*.tsx --include=*.ts` and confirm no hit, including template strings such as `` `connection-status-${...}` ``. A name with any hit stays.
2. Delete a rule only when every selector in its list needs a dead class. In a selector list with live and dead members, remove only the dead members.
3. Delete an `@keyframes` only when no remaining rule names it.
4. Never delete `.billing-card`, `.plan-actions`, or a rule that styles a bare element.
5. Delete the `body::before` dotted layer and every gradient on `body` and on `:root[data-theme="dark"] body` that a later rule already resets to `none` (the earlier-era page background). The gate confirms `background-image` stays `none`.

Run the gate (0 differences) and commit as `refactor(web): remove selectors nothing uses`.

- [ ] **Step 6: Pass D, collapse the two layers into one**

The file is still the earlier layer followed by the layer that overrides it. Rewrite it as one layer, in this section order, each under a one-line comment: 1 Page and reset; 2 Type; 3 Controls (buttons, links, inputs, choice controls, focus); 4 Shell (masthead, rail, navigation, layout, footer); 5 Surfaces (article, pill, banner, alert, status, job row, details); 6 First use; 7 Settings and the plan card; 8 Dialogs and the source viewer; 9 Setting up an agent by hand (`connection-*`, `setup-steps`); 10 Narrow screens (the `@media` blocks, widest first); 11 Dark appearance; 12 Reduced motion.

Rules for the rewrite:
1. For each selector that appears more than once outside media queries, write one rule that holds, per property, the declaration that wins today. Drop the losers. Do the same inside each media condition and inside the dark blocks.
2. Keep every distinct `@media` condition and its order relative to the others (`max-width: 1080px`, `800px`, `760px`, `560px`, `420px`, `pointer: fine`, `prefers-reduced-motion`). Where two blocks share a condition, merge them only if no rule between them depends on the order.
3. Remove each `!important` by making the selector specific enough to win without it; the gate decides whether you did. The two in `today/today.css` go in Pass E, once the base loads before the screens.
4. Replace a hard-coded colour with a token only where the token's value is identical in both appearances at that spot. Otherwise leave the literal.
5. Work one section per pass and run the gate after each. Commit after each section that reaches 0 (`refactor(web): one layer for <section>`).

- [ ] **Step 7: Pass E, base before screens, and no specificity hack**

In `apps/web/src.tsx`, move the three screen imports so the block reads, in this order:

```ts
import "./styles/tokens.css";
import "@fontsource-variable/manrope/wght.css";
import "./styles/app.css";
import "./today/today.css";
import "./brain/brain.css";
import "./connections/connections.css";
```

(The component imports stay where they are; only the three `import "./…/….css";` lines move.) Add `className="primary-nav"` to the element `<nav aria-label="Main navigation" data-ui="primary-navigation">`. In `apps/web/styles/app.css`, rewrite every selector that targets the bare `nav` element or `nav button` (including the dark and media variants) to `.primary-nav` and `.primary-nav button`, so the base no longer styles the project list in Your brain. In `apps/web/brain/brain.css` replace every `:root:root nav.yb-plist` with `.yb-plist`, and delete from those rules each declaration that existed only to undo the base's `nav button` styling (the gate tells you which are still needed). Remove the two `!important` in `today/today.css` the same way. Update the first-line comments of `today.css` so they no longer name deleted files.

Run the gate. Where a screen rule now wins a tie it used to lose, restore today's rendering by deleting the losing declaration from the screen sheet. Expected: 0 differences.

- [ ] **Step 8: Document the tokens**

In `docs/DESIGN_SYSTEM.md`, replace the "Core tokens" table with one that has a `Token` column holding the CSS names and the values from `tokens.css` (rows: `--canvas`, `--surface`, `--line`, `--line-strong`, `--muted`, `--subtle`, `--ink`, `--on-ink`, `--signal`, `--gold`, `--gold-wash`, `--attention`, `--focus`), and add under it:

```markdown
Every custom property is declared in `apps/web/styles/tokens.css` and nowhere else. `apps/web/styles/app.css` is the one base stylesheet; the screen sheets (`today/today.css`, `brain/brain.css`, `connections/connections.css`) load after it. `--signal` is gold dark enough to read as text; `--gold` is the brand colour as a fill or stroke and is never used for text. `tests/integration/web-styles.test.ts` fails if a stylesheet uses a token that is not defined in both appearances.
```

- [ ] **Step 9: Run the test, the type check, the lint and the frozen billing spec**

```powershell
npx vitest run tests/integration/web-styles.test.ts --reporter=dot --maxWorkers=1
npm run typecheck
npm run lint
npm run build
New-Item -ItemType Directory -Force C:/Users/Gowrishankar/AppData/Local/Temp/opencode | Out-Null
npx playwright test tests/e2e/billing-ui.spec.ts tests/e2e/consumer-first-use-review.spec.ts tests/e2e/your-brain-v2.spec.ts --workers=1
git restore docs/screenshots
```

Expected: the Vitest file passes (6 tests), the rest exit 0, the three specs pass.

- [ ] **Step 10: Final full gate for this task and commit**

Capture light and dark in full into `$EVID/fold-light` and `$EVID/fold-dark` and run both compares with `--report="$EVID/fold-<theme>.md"`. Expected: 0 differences in both. Print `wc -l apps/web/styles/app.css` and put the line count in the commit body.

```bash
git add apps/web/styles/app.css apps/web/src.tsx apps/web/today/today.css apps/web/brain/brain.css apps/web/connections/connections.css tests/integration/web-styles.test.ts docs/DESIGN_SYSTEM.md
git commit -m "refactor(web): base loads before screens; main navigation scoped; stylesheet invariants tested" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Type scale in rem (Sonnet)

**Files:**
- Modify: `apps/web/styles/app.css`, `apps/web/today/today.css`, `apps/web/brain/brain.css`, `apps/web/connections/connections.css`, `tests/integration/web-styles.test.ts`, `tests/e2e/today-v2.spec.ts`, `docs/DESIGN_SYSTEM.md`

**Interfaces:**
- Consumes: Task 2's file layout; the gate from Task 2 against `$EVID/before-*`.
- Produces: no `px` in any `font-size`; `:root` sets no `font-size`.

- [ ] **Step 1: Write the failing tests**

Add to the `describe` block in `tests/integration/web-styles.test.ts`:

```ts
  it("sets type in rem so it follows the person's text-size setting", () => {
    for (const sheet of SHEETS) {
      const css = read(sheet);
      expect(css, sheet).not.toMatch(/font-size:[^;}]*\dpx/);
      expect(css, sheet).not.toMatch(/font:\s*[\d.]+px/);
    }
    expect(block(read("styles/app.css"), ":root")).not.toContain("font-size");
  });
```

Add to `tests/e2e/today-v2.spec.ts` (uses the file's own `pair`):

```ts
test("text follows a larger default text size on a phone without sideways scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // A larger text size in the browser arrives as a larger root font size. A root pinned to px would win over this rule.
  await page.addInitScript(() => {
    addEventListener("DOMContentLoaded", () => {
      const style = document.createElement("style");
      style.textContent = "html { font-size: 20px; }";
      document.head.prepend(style);
    });
  });
  await pair(page);
  await expect(page.locator("body")).toHaveCSS("font-size", "20px");
  const title = await page.locator(".tv-title").evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(title).toBeGreaterThan(30);
  const bar = page.getByLabel(/save to your brain|ask your brain/i);
  await expect(bar).toBeVisible();
  expect(await bar.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(20);
  for (const tab of ["Today", "Your brain", "Connections"]) {
    await page.getByRole("button", { name: tab, exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), tab).toBe(true);
  }
  await page.getByRole("button", { name: "Settings & privacy" }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
```

- [ ] **Step 2: Run them to see them fail**

```powershell
npx vitest run tests/integration/web-styles.test.ts --reporter=dot --maxWorkers=1
npm run build
npx playwright test tests/e2e/today-v2.spec.ts -g "larger default text size" --workers=1
git restore docs/screenshots
```

Expected: the Vitest case fails on a `px` font size; the browser test fails at `toHaveCSS("font-size", "20px")` (the root is pinned to 16px).

- [ ] **Step 3: Convert**

Run (Bash tool):

```bash
cd "C:/Users/Gowrishankar/Desktop/Bi Brain/.worktrees/design/apps/web"
node -e '
const fs = require("fs");
for (const file of process.argv.slice(1)) {
  const css = fs.readFileSync(file, "utf8").replace(/(font-size:\s*)([^;}]+)/g, (m, head, value) => head + value.replace(/(\d*\.?\d+)px/g, (_, n) => Number(n) / 16 + "rem"));
  fs.writeFileSync(file, css);
}' styles/app.css today/today.css brain/brain.css connections/connections.css
grep -n "font-size:[^;}]*px\|font: *[0-9]" styles/app.css today/today.css brain/brain.css connections/connections.css
```

Expected: the grep prints nothing except, possibly, a `font: 14px/1.8 inherit` line. That declaration is invalid CSS and browsers drop it; delete the line. Then delete `font-size: 16px;` from the `:root` rule in `styles/app.css` (the browser's default now applies). A `clamp(38px, 4.2vw, 58px)` has become `clamp(2.375rem, 4.2vw, 3.625rem)`; leave the `vw` term. Do not convert paddings, heights, borders, radii or media-query widths.

- [ ] **Step 4: Prove it is neutral at the default size**

`npm run build`, capture light and dark with the Task 1 flags into `$EVID/rem-light` and `$EVID/rem-dark`, compare against `$EVID/before-light` and `$EVID/before-dark`.
Expected: 0 differences (computed sizes are the same pixels at a 16px default).

- [ ] **Step 5: Make the larger size fit**

Run both tests from Step 2. If the browser test reports sideways scroll at a 20px root, find the element (`[...document.querySelectorAll("*")].filter((el) => el.getBoundingClientRect().right > innerWidth + 1)` in the page) and fix it with `min-width: 0`, `overflow-wrap: anywhere` or `flex-wrap: wrap` on that element; do not shrink text and do not add a fixed width. Repeat Step 4 after any such fix.
Expected: both tests pass; Step 4 still reports 0 differences.

- [ ] **Step 6: Document and commit**

In `docs/DESIGN_SYSTEM.md`, under the type table, add:

```markdown
Sizes are written in rem (px ÷ 16), so the scale follows the text size the person set in their browser; the px figures above are what a default 16px setting renders. The root sets no font size. Spacing, borders, radii and breakpoints stay in px.
```

```bash
git add apps/web/styles/app.css apps/web/today/today.css apps/web/brain/brain.css apps/web/connections/connections.css tests/integration/web-styles.test.ts tests/e2e/today-v2.spec.ts docs/DESIGN_SYSTEM.md
git commit -m "feat(web): type scale in rem follows the browser's text-size setting" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Today, one save affordance and its own status (Sonnet)

**Files:**
- Modify: `apps/web/src.tsx` (masthead JSX near `className="masthead"`; the `<TodayView` element), `apps/web/today/TodayView.tsx` (both `<h1 id="tv-h"` blocks), `apps/web/today/types.ts`, `apps/web/today/today.css` (the `.tv-state` rule and the `@media (max-width: 420px)` block after it)
- Test: `tests/e2e/today-v2.spec.ts`; update `tests/e2e/app.spec.ts`, `tests/e2e/review-journeys.spec.ts`, `tests/e2e/spending-review.spec.ts`
- Modify: `docs/UX.md`

**Interfaces:**
- Produces: `TodayProps.stateLine: string` (empty string renders nothing); markup `<div class="tv-head"><h1 id="tv-h" class="tv-title">…</h1><p class="tv-state" role="status">…</p></div>`; no `.tv-state` in the masthead.

- [ ] **Step 1: Write the failing test**

Add to `tests/e2e/today-v2.spec.ts`:

```ts
test("Today has one way to save and carries its own status; other pages keep Save something", async ({ page }) => {
  await pair(page);
  const header = page.locator("header.masthead");
  await expect(page.locator("main .tv-head .tv-state")).toHaveText(/Caught up|\d+ to look at|Background help off/);
  await expect(page.locator(".tv-state")).toHaveCount(1);
  await expect(header.getByRole("button", { name: /Save something/ })).toHaveCount(0);
  for (const tab of ["Your brain", "Connections"]) {
    await page.getByRole("button", { name: tab, exact: true }).click();
    await expect(header.getByRole("button", { name: /Save something/ })).toBeVisible();
    await expect(page.locator(".tv-state")).toHaveCount(0);
  }
  // The header button still opens the save dialog and takes focus back.
  await header.getByRole("button", { name: /Save something/ }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(header.getByRole("button", { name: /Save something/ })).toBeFocused();
});

test("the status wraps under the title on a 320px screen", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.route("**/api/v1/brief", (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: { code: "INTERNAL", message: "Down." } }) }),
  );
  await pair(page);
  const state = page.locator(".tv-state");
  await expect(state).toHaveText("Couldn't check for changes");
  expect(await state.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});
```

- [ ] **Step 2: Run to see it fail**

Run: `npm run build; npx playwright test tests/e2e/today-v2.spec.ts -g "one way to save|wraps under the title" --workers=1; git restore docs/screenshots`
Expected: FAIL (`main .tv-head .tv-state` does not exist).

- [ ] **Step 3: Implement**

`apps/web/today/types.ts`, in `TodayProps` after `backgroundOn: boolean;`:

```ts
  /** One plain line about what the brain is doing. Empty while it is not known yet. */
  stateLine: string;
```

`apps/web/today/TodayView.tsx`: replace each of the two blocks

```tsx
        <h1 id="tv-h" className="tv-title">
          Welcome to BiBrain.
        </h1>
```

(and the same with `Good to see you.`) with, keeping each one's own title text:

```tsx
        <div className="tv-head">
          <h1 id="tv-h" className="tv-title">
            Welcome to BiBrain.
          </h1>
          {props.stateLine ? (
            <p className="tv-state" role="status">
              {props.stateLine}
            </p>
          ) : null}
        </div>
```

`apps/web/src.tsx`: delete the masthead block

```tsx
          {brainState ? (
            <span className="tv-state" role="status">
              {brainState}
            </span>
          ) : null}
```

add `stateLine={brainState}` to the `<TodayView` element, and wrap the header button so it reads:

```tsx
          {/* On Today the bar is the capture, so the header carries no second one (local app; the hosted edition's flows still start here). */}
          {paired && !demo && nav === "Today" && runtime?.mode === "local" ? null : (
            <button
              className="primary"
              data-ui="save-something"
              disabled={!paired || demo}
              onClick={saveDialog}
            >
              ＋ Save something
            </button>
          )}
```

`apps/web/today/today.css`: replace the `.tv-state { … }` rule and the `@media (max-width: 420px) { .masthead { flex-wrap: wrap; } .tv-state { … } }` block that follows it with:

```css
.tv-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 4px 16px;
  min-width: 0;
  margin: 0 0 12px;
}
.layout:not(.entry-layout) main .tv-head h1 {
  margin: 0;
}
.tv-state {
  margin: 0;
  color: var(--muted);
  font-size: 0.8125rem;
  overflow-wrap: anywhere;
}
```

(The page title's own 12px bottom margin moves to `.tv-head`, so the space above the bar is unchanged.)

- [ ] **Step 4: Update the tests that opened the dialog from Today**

The dialog is reached from the header on Your brain. In `tests/e2e/app.spec.ts` and `tests/e2e/review-journeys.spec.ts`, before each `getByRole("button", { name: "Save something", exact: false }).first()` use that runs while Today is showing, add:

```ts
  // The header's Save something is not shown on Today, where the bar is the capture.
  await page.getByRole("button", { name: "Your brain", exact: true }).click();
```

and, where the following lines of that test assert something on Today, add `await page.getByRole("button", { name: "Today", exact: true }).click();` after the dialog closes. In `tests/e2e/spending-review.spec.ts` (line 147–149) the button is only a "signed in" signal; replace that expectation with:

```ts
    await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
```

Do not edit any `managed*.spec.ts`.

- [ ] **Step 5: Run the affected specs**

```powershell
npm run typecheck
npm run build
npx playwright test tests/e2e/today-v2.spec.ts tests/e2e/today-v2-bar.spec.ts tests/e2e/today-v2-empty.spec.ts tests/e2e/app.spec.ts tests/e2e/review-journeys.spec.ts tests/e2e/spending-review.spec.ts tests/e2e/managed-ui-review.spec.ts tests/e2e/managed.spec.ts --workers=1
git restore docs/screenshots
```

Expected: all pass, including the frozen managed specs.

- [ ] **Step 6: Update the spec text and commit**

In `docs/UX.md`: under "Navigation" replace `Global action: Save something.` with `Global action: Save something, in the header on Your brain, Connections and Settings. On Today the bar is the capture, so the header shows no second one.` Under "Today" replace the "Header:" paragraph's first sentence with `Header: "Good to see you." A small status in the same header, beside the title and under it on a narrow screen, says what the brain is doing`.

```bash
git add apps/web/src.tsx apps/web/today/TodayView.tsx apps/web/today/types.ts apps/web/today/today.css tests/e2e/today-v2.spec.ts tests/e2e/app.spec.ts tests/e2e/review-journeys.spec.ts tests/e2e/spending-review.spec.ts docs/UX.md
git commit -m "feat(today): one save affordance; the status sits in Today's own header" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Phone header in one row with a Settings icon button (Sonnet)

**Files:**
- Modify: `apps/web/src.tsx` (`NavGlyph`, masthead JSX), `apps/web/styles/app.css` (Shell and Narrow screens sections)
- Test: `tests/e2e/today-v2.spec.ts`
- Modify: `docs/UX.md`, `docs/DESIGN_SYSTEM.md`

**Interfaces:**
- Consumes: Task 4's masthead (the conditional Save button).
- Produces: `<div class="masthead-actions">` holding the Save button and `<button class="masthead-settings" aria-label="Settings & privacy">`; the rail's `button.link.settings` is `display: none` at 760px and below, the masthead one is `display: none` above it. Exactly one is exposed at any width.

- [ ] **Step 1: Write the failing test**

Add to `tests/e2e/today-v2.spec.ts`:

```ts
test("on a phone the header is one row and Settings is an icon button in it", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await pair(page);
  const header = page.locator("header.masthead");
  const settings = header.getByRole("button", { name: "Settings & privacy" });
  await expect(settings).toBeVisible();
  await expect(page.locator("aside").getByRole("button", { name: "Settings & privacy" })).toHaveCount(0);
  const box = (await settings.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);
  for (const tab of ["Today", "Your brain", "Connections"]) {
    await page.getByRole("button", { name: tab, exact: true }).click();
    expect((await header.boundingBox())!.height, tab).toBeLessThanOrEqual(72);
  }
  await settings.click();
  await expect(page.getByRole("heading", { name: "Settings & privacy", level: 1 })).toBeVisible();
  await expect(settings).toHaveAttribute("aria-current", "page");
  // The narrowest screen, with both header actions present.
  await page.setViewportSize({ width: 320, height: 720 });
  await expect(header.getByRole("button", { name: /Save something/ })).toBeVisible();
  expect((await header.boundingBox())!.height).toBeLessThanOrEqual(72);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});

test("on a wide screen Settings stays in the side rail", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await pair(page);
  await expect(page.locator("header.masthead").getByRole("button", { name: "Settings & privacy" })).toHaveCount(0);
  await expect(page.locator("aside").getByRole("button", { name: "Settings & privacy" })).toBeVisible();
});
```

- [ ] **Step 2: Run to see it fail**

Run: `npm run build; npx playwright test tests/e2e/today-v2.spec.ts -g "header is one row|stays in the side rail" --workers=1; git restore docs/screenshots`
Expected: the phone test fails (no Settings button in the header).

- [ ] **Step 3: Implement the markup**

In `apps/web/src.tsx`, add to `NavGlyph` before its final `return`:

```tsx
  if (name === "Settings")
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
      </svg>
    );
```

Replace the Task 4 header button block with:

```tsx
          <div className="masthead-actions">
            {/* On Today the bar is the capture, so the header carries no second one (local app; the hosted edition's flows still start here). */}
            {paired && !demo && nav === "Today" && runtime?.mode === "local" ? null : (
              <button
                className="primary"
                data-ui="save-something"
                aria-label="Save something"
                disabled={!paired || demo}
                onClick={saveDialog}
              >
                ＋ Save<span className="masthead-save-rest"> something</span>
              </button>
            )}
            {/* Phones only: the rail's Settings link is hidden there, so exactly one is exposed at any width. */}
            <button
              type="button"
              className="masthead-settings"
              aria-label="Settings & privacy"
              aria-current={nav === "Settings" ? "page" : undefined}
              disabled={!paired || demo}
              onClick={() => setNav("Settings")}
            >
              <NavGlyph name="Settings" />
            </button>
          </div>
```

- [ ] **Step 4: Implement the styles**

In `apps/web/styles/app.css`, Shell section, add:

```css
.masthead-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.masthead-settings {
  display: none;
}
```

In the `@media (max-width: 760px)` block: delete the `.settings { … }` rules (width, margin, centred text, 12px size, `display: block`, 44px height, padding) and add:

```css
  aside .settings {
    display: none;
  }
  .masthead-settings {
    display: inline-grid;
    place-items: center;
    flex: none;
    width: 44px;
    height: 44px;
    padding: 0;
    border: 1px solid transparent;
    border-radius: var(--radius-control);
    background: transparent;
    color: inherit;
  }
  .masthead-settings[aria-current="page"] {
    border-color: var(--line);
    background: var(--subtle);
  }
```

and after the `@media (max-width: 420px)` block add:

```css
/* The narrowest phones: the header keeps one row by shortening the visible label; its name stays "Save something". */
@media (max-width: 360px) {
  .masthead-save-rest {
    display: none;
  }
}
```

If the dark appearance needs it for 3:1 on the selected state, add a `:root[data-theme="dark"] .masthead-settings[aria-current="page"]` rule using tokens only.

- [ ] **Step 5: Run the tests and the static test**

```powershell
npm run typecheck
npx vitest run tests/integration/web-styles.test.ts --reporter=dot --maxWorkers=1
npm run build
npx playwright test tests/e2e/today-v2.spec.ts tests/e2e/first-note-layout-review.spec.ts tests/e2e/system-one.spec.ts tests/e2e/better-search.spec.ts tests/e2e/managed-ui-review.spec.ts --workers=1
git restore docs/screenshots
```

Expected: all pass (the two 320px Settings tests in the system1 project now run with the icon button).

- [ ] **Step 6: Update the docs and commit**

`docs/UX.md`, "Navigation": after the Settings line add `On a phone (760px and narrower) Settings is an icon button in the header, named "Settings & privacy"; on wider screens it is the link under the navigation.` `docs/DESIGN_SYSTEM.md`, "Layout", mobile paragraph: add `The header is one row: the logo, then Save something where it applies, then the Settings icon button.`

```bash
git add apps/web/src.tsx apps/web/styles/app.css tests/e2e/today-v2.spec.ts docs/UX.md docs/DESIGN_SYSTEM.md
git commit -m "feat(web): one-row phone header with a Settings icon button" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Settings, one "Background help" card in three steps (Opus)

**Files:**
- Create: `apps/web/settings/background-steps.ts`, `tests/integration/background-steps.test.ts`
- Modify: `apps/web/src.tsx` (`sortingLine`; the Settings section from `{better && runtime?.mode !== "managed" ? (` to the end of the `<h2>Background help & spending</h2>` article), `apps/web/better-search-copy.ts` (one sentence), `apps/web/styles/app.css` (Settings section), `tests/integration/better-search-copy.test.ts` (the `LIMITS_NOT_SET` constant), `tests/e2e/system-one.spec.ts`, `tests/e2e/better-search.spec.ts`, `docs/UX.md`

**Interfaces:**
- Produces:

```ts
export type StepInputs = { enabled: boolean; daily_cap_micro_usd: number; per_job_cap_micro_usd: number };
export type Steps = { limitsOpen: boolean; choicesOpen: boolean; current: 1 | 2 | 3 };
export function backgroundSteps(p: StepInputs): Steps;
export function choiceDisabled(checked: boolean, open: boolean, unavailable?: boolean): boolean;
export function stepNote(step: 2 | 3, steps: Steps): string | null;
```

- Endpoints used, all existing and unchanged: `PATCH /preferences/background` (steps 1 and 2, the prepared-reviews consent and the sorting consent), `PATCH /preferences/recall-help`, `GET /system-one/status`, `GET /system-one/log`, `GET|PATCH /preferences/better-search`, `GET|PATCH|DELETE /preferences/meaning-lead`. No request is added to `refresh()`.

**What must not change:** the request bodies; the managed-mode card (heading "Background help & spending", every label, the order of controls, "Save preferences", "Background preferences saved."); the label texts "Turn on background help (sorting new notes and preparing reviews)", "Daily cap (USD)", "Per preparation cap (USD)", "I authorize selected text to be processed by OpenAI within these caps", the Recall help label, "Save preferences", "Save better search".

- [ ] **Step 1: Write the failing unit test**

Create `tests/integration/background-steps.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { backgroundSteps, choiceDisabled, stepNote } from "../../apps/web/settings/background-steps.ts";

const off = { enabled: false, daily_cap_micro_usd: 0, per_job_cap_micro_usd: 0 };

describe("background help steps", () => {
  it("opens one step at a time", () => {
    expect(backgroundSteps(off)).toEqual({ limitsOpen: false, choicesOpen: false, current: 1 });
    expect(backgroundSteps({ ...off, enabled: true })).toEqual({ limitsOpen: true, choicesOpen: false, current: 2 });
    expect(backgroundSteps({ enabled: true, daily_cap_micro_usd: 50_000, per_job_cap_micro_usd: 0 })).toEqual({ limitsOpen: true, choicesOpen: false, current: 2 });
    expect(backgroundSteps({ enabled: true, daily_cap_micro_usd: 50_000, per_job_cap_micro_usd: 10_000 })).toEqual({ limitsOpen: true, choicesOpen: true, current: 3 });
  });
  it("closes the later steps again when an earlier one is undone, even with limits still set", () => {
    expect(backgroundSteps({ enabled: false, daily_cap_micro_usd: 50_000, per_job_cap_micro_usd: 10_000 })).toEqual({ limitsOpen: false, choicesOpen: false, current: 1 });
  });
  it("never traps a choice that is on: it stays operable so it can be turned off", () => {
    expect(choiceDisabled(true, false)).toBe(false);
    expect(choiceDisabled(true, false, true)).toBe(false);
    expect(choiceDisabled(false, false)).toBe(true);
    expect(choiceDisabled(false, true, true)).toBe(true);
    expect(choiceDisabled(false, true)).toBe(false);
  });
  it("says which step is missing, and nothing once a step is open", () => {
    const closed = backgroundSteps(off);
    expect(stepNote(2, closed)).toBe("Allow background help in step 1 first.");
    expect(stepNote(3, closed)).toBe("Allow background help in step 1 first.");
    const limits = backgroundSteps({ ...off, enabled: true });
    expect(stepNote(2, limits)).toBeNull();
    expect(stepNote(3, limits)).toBe("Set a daily limit and a per-preparation limit above $0 in step 2 first.");
    expect(stepNote(3, backgroundSteps({ enabled: true, daily_cap_micro_usd: 1, per_job_cap_micro_usd: 1 }))).toBeNull();
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run tests/integration/background-steps.test.ts --reporter=dot --maxWorkers=1`
Expected: FAIL (module not found).

- [ ] **Step 3: Write the module**

Create `apps/web/settings/background-steps.ts`:

```ts
// The order of the Background help card in Settings: allow it, set its limits, then choose what it may do.
// Pure, so the gating can be tested without a browser. It only decides what the page lets a person reach;
// the server keeps its own checks and is not changed by any of this.

export type StepInputs = { enabled: boolean; daily_cap_micro_usd: number; per_job_cap_micro_usd: number };
export type Steps = { limitsOpen: boolean; choicesOpen: boolean; current: 1 | 2 | 3 };

export function backgroundSteps(p: StepInputs): Steps {
  const limitsSet = p.daily_cap_micro_usd > 0 && p.per_job_cap_micro_usd > 0;
  return { limitsOpen: p.enabled, choicesOpen: p.enabled && limitsSet, current: !p.enabled ? 1 : !limitsSet ? 2 : 3 };
}

/** A choice that is already on stays operable, so it can always be turned off. */
export function choiceDisabled(checked: boolean, open: boolean, unavailable = false): boolean {
  return !checked && (!open || unavailable);
}

/** The one sentence shown on a step that is not open yet. */
export function stepNote(step: 2 | 3, steps: Steps): string | null {
  if (!steps.limitsOpen) return "Allow background help in step 1 first.";
  if (step === 3 && !steps.choicesOpen) return "Set a daily limit and a per-preparation limit above $0 in step 2 first.";
  return null;
}
```

Run the test again. Expected: PASS (4 tests).

- [ ] **Step 4: Write the failing browser tests**

In `tests/e2e/system-one.spec.ts`, insert as the first test of the file (it changes nothing on the server, so the serial story after it is unaffected):

```ts
test("Background help opens one step at a time and never locks a choice that is on", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "Settings & privacy" }).click();
  const card = page.locator('[data-ui="background-help"]');
  await expect(card.getByRole("heading", { name: "Background help", level: 2 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sorting help", level: 2 })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Better search", level: 2 })).toHaveCount(0);
  for (const name of ["1. Allow background help", "2. Set the limits", "3. Choose what it may do"]) await expect(card.getByRole("heading", { name, level: 3 })).toBeVisible();
  const allow = page.getByLabel("Turn on background help (sorting new notes and preparing reviews)");
  const daily = page.getByLabel("Daily cap (USD)");
  const each = page.getByLabel("Per preparation cap (USD)");
  const sort = page.getByLabel(/Let BiBrain sort new notes with/);
  const paid = page.getByRole("checkbox", { name: /I authorize selected text/ });
  await expect(allow).not.toBeChecked();
  await expect(daily).toBeDisabled();
  await expect(card.getByText("Allow background help in step 1 first.").first()).toBeVisible();
  await expect(sort).toBeDisabled();
  await expect(paid).toBeDisabled();
  await allow.check();
  await expect(daily).toBeEnabled();
  await expect(card.getByText("Set a daily limit and a per-preparation limit above $0 in step 2 first.")).toBeVisible();
  await expect(sort).toBeDisabled();
  await daily.fill("0.05");
  await each.fill("0.01");
  // The worker publishes its status a moment after start; the box enables once it has.
  await expect(sort).toBeEnabled({ timeout: 20000 });
  await sort.check();
  // Undo step 1: the limits close, an unticked choice closes, and the ticked one can still be turned off.
  await allow.uncheck();
  await expect(daily).toBeDisabled();
  await expect(paid).toBeDisabled();
  await expect(sort).toBeEnabled();
  await sort.uncheck();
  await expect(sort).toBeDisabled();
  // Better search on this computer is never gated: nothing leaves the computer and nothing is spent.
  const search = page.getByRole("region", { name: "Better search" });
  await expect(search.getByRole("radio", { name: /^Off\./ })).toBeEnabled();
});
```

In the existing test "sorting help is switched on in Settings and a note is filed with Keep", change three things: the card locator to `const card = page.getByRole("region", { name: "Sorting help" });`; the first status expectation to `await expect(card.getByText("Needs a daily limit above $0 in step 2.")).toBeVisible();`; the accessible name to `` `Let BiBrain sort new notes with ${LABEL}. Costs count against the limits in step 2.` ``. And replace the first `await page.getByRole("button", { name: "Save preferences" }).click();` of that test with a check that the request is the one the old card sent:

```ts
  const [saved] = await Promise.all([
    page.waitForRequest((r) => r.url().endsWith("/api/v1/preferences/background") && r.method() === "PATCH"),
    page.getByRole("button", { name: "Save preferences" }).click(),
  ]);
  expect(Object.keys(saved.postDataJSON()).sort()).toEqual(["daily_cap_micro_usd", "decision_provider_enabled", "digest_hour", "enabled", "per_job_cap_micro_usd", "provider_enabled", "quiet_end", "quiet_start", "time_zone"]);
  expect(saved.postDataJSON()).toMatchObject({ enabled: true, daily_cap_micro_usd: 50000, per_job_cap_micro_usd: 10000, decision_provider_enabled: true });
```

In the test "Sorting help fits a 320px dark screen" change the card locator the same way. In `tests/e2e/better-search.spec.ts` change the helper to:

```ts
const card = (page: Page) => page.getByRole("region", { name: "Better search" });
```

In `tests/integration/better-search-copy.test.ts` change the constant to `const LIMITS_NOT_SET = "Set a daily limit and a per-preparation limit above $0 in step 2.";`.

- [ ] **Step 5: Run to see them fail**

Run: `npm run build; npx playwright test tests/e2e/system-one.spec.ts -g "one step at a time" --workers=1; git restore docs/screenshots`
Expected: FAIL (no `[data-ui="background-help"]`).

- [ ] **Step 6: Share what both cards need, without changing the managed card**

In `apps/web/src.tsx`, inside `App` before `return`:

1. Move the body of the existing form `onSubmit` (everything inside `void act(async () => { … });`, from `const body = backgroundPatchBody(` to `setNotice("Background preferences saved.");`) verbatim into a function, and make the existing form call it:

```tsx
  function saveBackgroundPreferences() {
    void act(async () => {
      /* the moved body, unchanged */
    });
  }
```

```tsx
                    onSubmit={(e) => {
                      e.preventDefault();
                      saveBackgroundPreferences();
                    }}
```

2. Lift the six `field(...)` calls out of `<div className="grid">` into two fragments, unchanged inside, and render `<div className="grid">{scheduleFields}{capFields}</div>` in the existing card (same DOM as before: fragments add no element):

```tsx
  const scheduleFields = prefs ? (
    <>
      {/* Time zone, Daily check hour (0–23), Quiet hours start, Quiet hours end: the four existing field(...) calls */}
    </>
  ) : null;
  const capFields = prefs ? (
    <>
      {/* Daily cap (USD), Per preparation cap (USD): the two existing field(...) calls with their comments */}
    </>
  ) : null;
  const steps = backgroundSteps(prefs ?? { enabled: false, daily_cap_micro_usd: 0, per_job_cap_micro_usd: 0 });
```

Add `import { backgroundSteps, choiceDisabled, stepNote } from "./settings/background-steps.ts";` at the top.

3. Change the existing card's condition from `{prefs ? (` to `{prefs && runtime?.mode === "managed" ? (`, and delete from it only the block that starts `{runtime?.mode !== "managed" && sorting ? (` and ends at its `) : null}` (the sorting and recall checkboxes; they move to the new card). Leave every other line of that card as it is, including its `runtime?.mode === "managed" ? … : …` ternaries.

4. Delete the two local-only cards (`{better && runtime?.mode !== "managed" ? ( <article> <h2>Better search</h2> …` and `{prefs && savedPrefs && (sorting || sortingUnavailable) && runtime?.mode !== "managed" ? ( <article> <h2>Sorting help</h2> …`) after their contents have been moved in Step 7.

- [ ] **Step 7: Compose the local card**

Where the "Background help & spending" card stood, before it, add the local card. Blocks marked "verbatim" are moved from the deleted cards or copied from the managed card's local branch without rewording:

```tsx
              {prefs && runtime?.mode !== "managed" ? (
                <article className="bh" data-ui="background-help">
                  <h2>Background help</h2>
                  <p>
                    BiBrain can sort new notes, prepare reviews and help your agents find the right notes while this
                    computer is awake. It stays off until you allow it, and it stays inside the limits you set.
                  </p>
                  <form
                    id="background-help-form"
                    onChange={() => {
                      preferencesDirty.current = true;
                    }}
                    onSubmit={(e) => {
                      e.preventDefault();
                      saveBackgroundPreferences();
                    }}
                  >
                    <section className="bh-step" aria-labelledby="bh-allow-h">
                      <h3 id="bh-allow-h">1. Allow background help</h3>
                      <label>
                        <input type="checkbox" checked={prefs.enabled} onChange={(e) => setPrefs({ ...prefs, enabled: e.target.checked })} />{" "}
                        Turn on background help (sorting new notes and preparing reviews)
                      </label>
                      <p className="muted">Preparation runs while this computer and the worker are awake. One bounded daily catch-up follows missed checks.</p>
                    </section>
                    <section className="bh-step" aria-labelledby="bh-limits-h">
                      <h3 id="bh-limits-h">2. Set the limits</h3>
                      {stepNote(2, steps) ? <p className="muted" id="bh-limits-note">{stepNote(2, steps)}</p> : null}
                      <fieldset className="bh-fields" disabled={!steps.limitsOpen} aria-describedby={steps.limitsOpen ? undefined : "bh-limits-note"}>
                        <legend>How much it may spend, and when it runs</legend>
                        <div className="grid">
                          {capFields}
                          {scheduleFields}
                        </div>
                      </fieldset>
                    </section>
                  </form>
                  <section className="bh-step" aria-labelledby="bh-choices-h">
                    <h3 id="bh-choices-h">3. Choose what it may do</h3>
                    {stepNote(3, steps) ? <p className="muted">{stepNote(3, steps)}</p> : null}
                    {/* These boxes sit outside the form (a form cannot hold Better search's own form), so they mark the preferences as edited themselves. */}
                    <div
                      className="bh-consents"
                      onChange={() => {
                        preferencesDirty.current = true;
                      }}
                    >
                      <section aria-labelledby="bh-prepare-h">
                        <h4 id="bh-prepare-h">Prepared reviews</h4>
                        {/* verbatim: the <p> that begins "OpenAI receives selected shareable source text" */}
                        <label>
                          <input
                            type="checkbox"
                            checked={prefs.provider_enabled}
                            disabled={!!today.status.spend?.blocked || choiceDisabled(prefs.provider_enabled, steps.choicesOpen)}
                            onChange={(e) => setPrefs({ ...prefs, provider_enabled: e.target.checked })}
                          />{" "}
                          I authorize selected text to be processed by OpenAI within these caps
                        </label>
                      </section>
                      {savedPrefs && (sorting || sortingUnavailable) ? (
                        <section aria-labelledby="bh-sorting-h">
                          <h4 id="bh-sorting-h">Sorting help</h4>
                          {/* verbatim from the Sorting help card: the intro <p>, the status <p role="status">, the "Save to apply." line,
                              the "Recall help: on/off" line and the "Last problem" line */}
                          {sorting ? (
                            <>
                              <label>
                                <input
                                  type="checkbox"
                                  checked={prefs.decision_provider_enabled}
                                  disabled={choiceDisabled(prefs.decision_provider_enabled, steps.choicesOpen, !sorting.configured)}
                                  onChange={(e) => {
                                    sortingConsentTouched.current = true;
                                    setPrefs({ ...prefs, decision_provider_enabled: e.target.checked });
                                  }}
                                />{" "}
                                Let BiBrain sort new notes with {sorting.label ?? "the sorting service"}. Costs count against the limits in step 2.
                              </label>
                              <label>
                                <input
                                  type="checkbox"
                                  checked={recallHelp}
                                  disabled={choiceDisabled(recallHelp, steps.choicesOpen, !(sorting.configured && prefs.decision_provider_enabled))}
                                  onChange={(e) => {
                                    recallConsentTouched.current = true;
                                    setRecallHelp(e.target.checked);
                                  }}
                                />{" "}
                                {/* verbatim: the Recall help label text and its "Needs sorting help on first." span with its existing condition */}
                              </label>
                            </>
                          ) : null}
                          {/* verbatim from the Sorting help card: the "Download the review log" actions div and the <small> under it */}
                        </section>
                      ) : null}
                      <div className="actions">
                        <button className="primary" type="submit" form="background-help-form" disabled={busy}>
                          Save preferences
                        </button>
                      </div>
                    </div>
                    {better ? (
                      <section aria-labelledby="bh-search-h">
                        <h4 id="bh-search-h">Better search</h4>
                        {/* verbatim from the Better search card: everything after its <h2>, with the three edits listed below */}
                      </section>
                    ) : null}
                  </section>
                  {/* verbatim, local branch only: the <p className="muted"> that begins `Provider key ${…}` and the blocked-message <p> */}
                </article>
              ) : null}
```

The three edits inside the moved Better search block:

1. Above the `.map`, add `const cloudflareOpen = !!savedPrefs?.enabled && better.caps_ok;` (inside the `.map` callback, next to `available`).
2. The radio's `disabled` becomes `disabled={betterChoice !== mode && (!available || (mode === "cloudflare" && !cloudflareOpen))}`, and the Cloudflare hint becomes `{mode === "cloudflare" && available && !cloudflareOpen ? <span className="muted"> Needs steps 1 and 2 saved first.</span> : null}`.
3. `<h3 id="meaning-lead-heading">` becomes `<h5 id="meaning-lead-heading">` (with its closing tag).

Update the copy that pointed "below", now that the limits are above:

- `sortingLine` in `src.tsx`: `"Needs a daily limit above $0 in step 2."`, `"Needs a per-note limit above $0 in step 2."`, `"Needs background help allowed in step 1."`, `"Waiting for your consent here."`.
- `apps/web/better-search-copy.ts`, in `known()`: the limits sentence returns `"Set a daily limit and a per-preparation limit above $0 in step 2."`.

- [ ] **Step 8: Style the steps**

In `apps/web/styles/app.css`, Settings section, add:

```css
/* Settings, Background help: three steps in one card. */
.bh-step {
  display: grid;
  gap: 10px;
  min-width: 0;
  padding-top: 18px;
  margin-top: 18px;
  border-top: 1px solid var(--line);
}
.bh-step h3,
.bh-step h4,
.bh-step h5 {
  margin: 0;
}
.bh-step h4 {
  font-size: 1rem;
}
.bh-fields {
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}
.bh-fields legend {
  padding: 0;
  margin-bottom: 8px;
  color: var(--muted);
  font-size: 0.8125rem;
}
.bh-fields:disabled {
  opacity: 0.6;
}
.bh-consents {
  display: grid;
  gap: 16px;
  min-width: 0;
}
.bh-consents > section,
.bh-step > section {
  display: grid;
  gap: 8px;
  min-width: 0;
}
```

Check in a browser at 1280, 390 and 320px, light and dark: one dark button in the card ("Save preferences"); every checkbox and radio at the start of its label with a hanging indent; the disabled limits still at 4.5:1 for their labels (if 0.6 opacity fails AA on the legend or labels, dim only the inputs: replace the `:disabled` rule with `.bh-fields:disabled input { opacity: 0.6; }`).

- [ ] **Step 9: Run everything this touches**

```powershell
npm run typecheck
npm run lint
npx vitest run tests/integration/background-steps.test.ts tests/integration/better-search-copy.test.ts tests/integration/web-styles.test.ts --reporter=dot --maxWorkers=1
npm run build
New-Item -ItemType Directory -Force C:/Users/Gowrishankar/AppData/Local/Temp/opencode | Out-Null
npx playwright test tests/e2e/system-one.spec.ts tests/e2e/better-search.spec.ts tests/e2e/spending-review.spec.ts tests/e2e/managed-consent-review.spec.ts tests/e2e/managed-decision-consent-review.spec.ts tests/e2e/managed-spending-review.spec.ts tests/e2e/managed.spec.ts tests/e2e/billing-ui.spec.ts --workers=1
git restore docs/screenshots
git diff --stat main -- apps/server apps/worker apps/mcp apps/cli packages
```

Expected: all pass; the frozen managed and billing specs pass unedited; the last command prints nothing.

- [ ] **Step 10: Update the spec text and commit**

In `docs/UX.md`, "Watch and sorting help": rewrite the three Settings bullets so they describe one card. Sorting help: `**Background help card (Settings, local app).** One card with three steps: "1. Allow background help", "2. Set the limits" (daily and per-preparation caps, time zone, daily check hour, quiet hours) and "3. Choose what it may do" (Prepared reviews, Sorting help with Recall help, Better search). A step opens when the one before it is set; a step that is not open says which step is missing. A choice that is already on can always be turned off. Sorting help says in plain words whether it is on, off, waiting for the background worker or missing setup, shows the last problem if any, and downloads the review log. The hosted edition keeps its own "Background help & spending" card.` Recall help: keep the label and behaviour text, replace "A separate checkbox under the sorting-help one" with "A checkbox under the sorting-help one in step 3". Better search: replace "Its own card with three choices and its own Save" with "The last part of step 3, with three choices and its own Save", and replace the Cloudflare "Needs a daily limit … below" sentence with `Cloudflare waits for steps 1 and 2 to be saved and says "Needs steps 1 and 2 saved first."; Off and "On this computer" are never gated`.

```bash
git add apps/web/settings/background-steps.ts tests/integration/background-steps.test.ts apps/web/src.tsx apps/web/better-search-copy.ts apps/web/styles/app.css tests/integration/better-search-copy.test.ts tests/e2e/system-one.spec.ts tests/e2e/better-search.spec.ts docs/UX.md
git commit -m "feat(settings): one Background help card in three steps" -m "Composition only: the same endpoints and request bodies. The hosted edition's card is unchanged." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Connections, a setup checklist that ticks from recorded signals (Sonnet)

**Files:**
- Create: `apps/web/connections/setup-checklist.ts`, `apps/web/connections/SetupChecklist.tsx`, `tests/integration/setup-checklist.test.ts`
- Modify: `apps/web/connections/ConnectionList.tsx` (the line `{g.status !== "Connected" && g.folder && hint && <p className="tv-faint">{hint}</p>}`), `apps/web/connections/connections.css`, `tests/e2e/connections-v2.spec.ts`, `scripts/design-audit-walk.mjs`, `docs/UX.md`

**Interfaces:**
- Consumes: `Grant` from `apps/web/connections/types.ts` (`status`, `last_verified_at`, `client_name`, `files`, `recall.pushes`), all of it already delivered by `GET /connections` inside `refresh()`. No new request.
- Produces:

```ts
export type SetupItem = { id: "open" | "approve" | "ask"; label: string; done: boolean };
export function setupChecklist(grant: Pick<Grant, "status" | "last_verified_at" | "client_name" | "files" | "recall">): SetupItem[] | null;
```

`null` means "show no checklist" (access ended, or every item is done).

- [ ] **Step 1: Write the failing unit test**

Create `tests/integration/setup-checklist.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { setupChecklist } from "../../apps/web/connections/setup-checklist.ts";

const none = { pushes: 0, last_push_at: null, last_level: null } as const;
const pushed = { pushes: 1, last_push_at: "2026-11-16T09:00:00.000Z", last_level: "full" } as const;
const hook = [{ path: ".codex/hooks.json", role: "hook", state: "written", contents: "{}" }] as const;
const hookExists = [{ path: ".codex/hooks.json", role: "hook", state: "exists", contents: "{}" }] as const;
const rule = [{ path: ".cursor/rules/bibrain.mdc", role: "rule", state: "written", contents: "" }] as const;
const waiting = { status: "Not connected", last_verified_at: null, client_name: "Codex", files: [...hook], recall: none } as const;
const done = (grant: Parameters<typeof setupChecklist>[0]) => setupChecklist(grant)?.map((i) => i.done);

describe("connection setup checklist", () => {
  it("starts with three plain steps and no tick", () => {
    expect(setupChecklist(waiting)).toEqual([
      { id: "open", label: "Open Codex here", done: false },
      { id: "approve", label: "Approve BiBrain", done: false },
      { id: "ask", label: "Ask anything", done: false },
    ]);
  });
  it("ticks the first two from the first recorded call, and the third only from a recorded push when BiBrain wrote the hook", () => {
    expect(done({ ...waiting, status: "Connected", last_verified_at: "2026-11-16T09:00:00.000Z" })).toEqual([true, true, false]);
  });
  it("is finished, and shown no more, once a push is recorded", () => {
    expect(setupChecklist({ ...waiting, status: "Connected", last_verified_at: "2026-11-16T09:00:00.000Z", recall: pushed })).toBeNull();
  });
  it("without a hook BiBrain wrote, the first call is the only signal there will ever be, so it finishes the list", () => {
    for (const files of [[...rule], [...hookExists], []])
      expect(setupChecklist({ ...waiting, client_name: "Cursor", files, status: "Connected", last_verified_at: "2026-11-16T09:00:00.000Z" })).toBeNull();
    expect(done({ ...waiting, client_name: "Cursor", files: [...rule] })).toEqual([false, false, false]);
  });
  it("never ticks from a key alone, and shows nothing for access that has ended", () => {
    expect(done({ ...waiting, recall: none })).toEqual([false, false, false]);
    expect(setupChecklist({ ...waiting, status: "Revoked" })).toBeNull();
    expect(setupChecklist({ ...waiting, status: "Needs attention" })).toBeNull();
  });
  it("names the agent the connection belongs to", () => {
    expect(setupChecklist({ ...waiting, client_name: "Claude Code" })![0].label).toBe("Open Claude Code here");
  });
});
```

- [ ] **Step 2: Run to see it fail**

Run: `npx vitest run tests/integration/setup-checklist.test.ts --reporter=dot --maxWorkers=1`
Expected: FAIL (module not found).

- [ ] **Step 3: Write the module and the component**

Create `apps/web/connections/setup-checklist.ts`:

```ts
import type { Grant } from "./types.ts";

export type SetupItem = { id: "open" | "approve" | "ask"; label: string; done: boolean };

/**
 * The three steps after Add, ticked only from what BiBrain has recorded for this connection.
 * - "Open … here" and "Approve BiBrain" share one signal, the first authenticated call (`last_verified_at`): nothing
 *   BiBrain records tells them apart, and neither can be true without it.
 * - "Ask anything" waits for the first recorded push when BiBrain wrote the prompt hook. Without that hook (a rule
 *   file, or a hook file that already existed) no push will ever arrive, and a call only happens in answer to a prompt,
 *   so the first call finishes the list.
 * Null when there is nothing to show: access has ended, or every step is done.
 */
export function setupChecklist(grant: Pick<Grant, "status" | "last_verified_at" | "client_name" | "files" | "recall">): SetupItem[] | null {
  if (grant.status !== "Connected" && grant.status !== "Not connected") return null;
  const called = grant.last_verified_at !== null;
  const hookWritten = grant.files.some((f) => f.role === "hook" && f.state === "written");
  const asked = hookWritten ? grant.recall.pushes > 0 : called;
  if (called && asked) return null;
  return [
    { id: "open", label: `Open ${grant.client_name} here`, done: called },
    { id: "approve", label: "Approve BiBrain", done: called },
    { id: "ask", label: "Ask anything", done: asked },
  ];
}
```

Create `apps/web/connections/SetupChecklist.tsx`:

```tsx
import { setupChecklist } from "./setup-checklist.ts";
import type { Grant } from "./types.ts";

/** What is left to do after Add, with the agent's own instructions behind Details. Ticks come from recorded signals only. */
export function SetupChecklist({ grant, hint }: { grant: Grant; hint: string }) {
  const items = setupChecklist(grant);
  if (!items) return null;
  return (
    <div className="cx-setup">
      <ol className="cx-steps" aria-label={`Getting ${grant.client_name} started`}>
        {items.map((item) => (
          <li key={item.id} className="cx-step" data-done={item.done ? "true" : "false"}>
            <span className="cx-tick" aria-hidden="true">
              {item.done ? "✓" : ""}
            </span>
            <span>
              {item.label}
              <span className="tv-sr"> {item.done ? "(done)" : "(not yet)"}</span>
            </span>
          </li>
        ))}
      </ol>
      <details className="cx-details">
        <summary>Details</summary>
        <p className="tv-faint">{hint}</p>
      </details>
    </div>
  );
}
```

In `apps/web/connections/ConnectionList.tsx` add `import { SetupChecklist } from "./SetupChecklist.tsx";` and replace

```tsx
                {g.status !== "Connected" && g.folder && hint && <p className="tv-faint">{hint}</p>}
```

with

```tsx
                {g.folder && hint && <SetupChecklist grant={g} hint={hint} />}
```

Append to `apps/web/connections/connections.css`:

```css
.cx-setup { display: grid; gap: 6px; min-width: 0; margin-top: 6px; }
.cx-steps { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.cx-step { display: flex; gap: 8px; align-items: center; min-width: 0; font-size: 0.875rem; }
.cx-tick { flex: none; display: grid; place-items: center; width: 18px; height: 18px; border: 1px solid var(--line-strong); border-radius: 50%; font-size: 0.75rem; line-height: 1; }
.cx-step[data-done="true"] .cx-tick { border-color: var(--ink); background: var(--ink); color: var(--on-ink); }
.cx-step[data-done="true"] { color: var(--muted); }
.cx-details summary { cursor: pointer; font-size: 0.8125rem; color: var(--muted); }
.cx-details summary:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.cx-details p { margin: 4px 0 0; overflow-wrap: anywhere; }
```

Run the unit test. Expected: PASS (6 tests).

- [ ] **Step 4: Write the browser test**

Add to `tests/e2e/connections-v2.spec.ts`:

```ts
test("the waiting checklist ticks only from what BiBrain recorded, then goes away", async ({ page, request }) => {
  await open(page);
  const folder = mkdtempSync(join(tmpdir(), "bibrain-steps-"));
  const codex = tile(page, "Codex");
  await codex.getByRole("button", { name: "Add to Codex" }).click();
  await codex.getByLabel("Project", { exact: true }).selectOption({ label: "Inbox" });
  await codex.getByLabel("Project folder on this computer").fill(folder);
  await codex.getByRole("button", { name: "Add to Codex", exact: true }).last().click();
  const row = codex.getByRole("listitem").filter({ hasText: folder });
  await expect(row).toContainText("Waiting for its first call");
  const steps = row.getByRole("list", { name: "Getting Codex started" });
  await expect(steps.getByRole("listitem")).toHaveText([/^Open Codex here \(not yet\)$/, /^Approve BiBrain \(not yet\)$/, /^Ask anything \(not yet\)$/]);
  // The long instructions are behind Details, closed until asked for.
  const hint = row.getByText("Open Codex in this folder.", { exact: false });
  await expect(hint).toBeHidden();
  await row.getByText("Details", { exact: true }).click();
  await expect(hint).toBeVisible();

  const written = readFileSync(join(folder, ".codex", "config.toml"), "utf8");
  const id = /"--connection", "([0-9a-f-]{36})"/.exec(written)![1];
  const { key } = JSON.parse(readFileSync(join("data", "agent-keys", `${id}.json`), "utf8"));
  const auth = { Authorization: `Bearer ${key}` };
  // The first call: the agent was opened here and approved. No push yet, so the third step stays open.
  expect((await request.post("/api/v1/agent/verify", { headers: auth, data: {} })).ok()).toBe(true);
  await expect(steps.getByRole("listitem")).toHaveText([/\(done\)$/, /\(done\)$/, /^Ask anything \(not yet\)$/], { timeout: 10_000 });
  await expect(row).toContainText("Connected");
  // The first push, as the prompt hook sends it.
  const push = await request.post("/api/v1/agent/recall-push", { headers: auth, data: { prompt: "What did we decide about the launch?", session_id: "a".repeat(64), first_prompt: true, client: "codex" } });
  expect(push.ok()).toBe(true);
  await expect(steps).toHaveCount(0, { timeout: 10_000 });
  await expect(row).toContainText(/Recall on every prompt: on(?! after)/);
  await row.getByRole("button", { name: `Revoke access for ${folder}` }).click();
});
```

If the row locator needs adjusting (the folder text is inside the row's second line), keep the assertions and change only the locator.

- [ ] **Step 5: Run it and the neighbouring specs**

```powershell
npm run typecheck
npm run lint
npx vitest run tests/integration/setup-checklist.test.ts tests/integration/second-file-copy.test.ts --reporter=dot --maxWorkers=1
npm run build
npx playwright test tests/e2e/connections-v2.spec.ts tests/e2e/provenance.spec.ts tests/e2e/agent-connection-review.spec.ts --workers=1
git restore docs/screenshots
```

Expected: all pass.

- [ ] **Step 6: Give the walk a path-free picture of the checklist**

In `scripts/design-audit-walk.mjs`, directly after `await capture(page, "13-connections-waiting");` add:

```js
  // A picture of the checklist alone: the whole tile also shows the project folder's path.
  if (!only.length || only.includes("13-connections-waiting")) await codex.locator(".cx-setup").first().screenshot({ path: join(out, "13-checklist.png") });
```

- [ ] **Step 7: Update the spec text and commit**

In `docs/UX.md`, "Connections", replace the first paragraph of **Waiting.** up to "and approve BiBrain once." with:

```markdown
**Waiting.** After Add, the connection reads "Waiting for its first call", with
the project, the access level and the folder. A key that exists is never treated
as an active agent. Under it a three-step checklist says what is left: "Open
{agent} here", "Approve BiBrain" and "Ask anything". A step is ticked only from
what BiBrain has recorded for that connection: the first two from its first
authenticated call, the third from its first recorded push (or, where BiBrain
wrote no prompt hook, from that same first call). The agent's own instructions
sit behind "Details". The checklist goes away once every step is ticked, and it
is never shown for access that has ended.
```

Leave the rest of the section (the "Recall on every prompt" and "Session notes" lines) as it is.

```bash
git add apps/web/connections/setup-checklist.ts apps/web/connections/SetupChecklist.tsx apps/web/connections/ConnectionList.tsx apps/web/connections/connections.css tests/integration/setup-checklist.test.ts tests/e2e/connections-v2.spec.ts scripts/design-audit-walk.mjs docs/UX.md
git commit -m "feat(connections): a setup checklist that ticks from recorded calls and pushes" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: After screenshots, documents and the full gate (Sonnet)

**Files:**
- Create: `docs/design/plan-11/after/light/*.png`, `docs/design/plan-11/after/dark/*.png` (19 each), `docs/design/plan-11/REPORT.md`
- Modify: `BUILD_STATE.md`, `README.md`, `CHANGELOG.md`, `docs/design/AUDIT-2026-11.md`

- [ ] **Step 1: Capture "after" and compare**

```powershell
npm run build
$EVID = "C:/Users/Gowrishankar/AppData/Local/Temp/bibrain-plan11"
$flags = "--stable", "--styles", "--sizes=1280x900,768x1024,390x844"
node scripts/design-audit-walk.mjs "$EVID/after-light" @flags
node scripts/design-audit-walk.mjs "$EVID/after-dark" @flags --dark
node scripts/design-compare.mjs "$EVID/before-light" "$EVID/after-light" --expect-changes --report="$EVID/after-light.md"
node scripts/design-compare.mjs "$EVID/before-dark" "$EVID/after-dark" --expect-changes --report="$EVID/after-dark.md"
```

Read both reports. Every snapshot with a difference must be one of: Today (title row and header), every signed-in state's header (Save button on Today; nothing else at 1280 and 768; the icon button at 390), Settings, Connections after Add. A difference anywhere else (first use, the sample, a dialog, Your brain's body) is a regression: stop and fix it in the task that caused it.

- [ ] **Step 2: Check the correctness floor did not move**

Open `$EVID/after-light/checks.json` and `$EVID/after-dark/checks.json`. Expected: no issue of kind `contrast`, `text-under-12px`, `target-under-24`, `horizontal-scroll`, `past-viewport`, `no-accessible-name`, `dialog-focus-escapes` or `dialog-focus-return`; `touch-under-40` only for the inline links the audit already accepted ("Open it", "Open the original"). Fix anything else before going on.

- [ ] **Step 3: Commit the "after" set and the report**

```powershell
$states = "01-first-run", "02-today-empty", "04-today-brief", "08-brain-project", "11-connections", "15-settings"
foreach ($theme in "light", "dark") {
  New-Item -ItemType Directory -Force "docs/design/plan-11/after/$theme" | Out-Null
  foreach ($s in $states) { foreach ($w in "desktop", "tablet", "phone") { Copy-Item "$EVID/after-$theme/$s--$w.png" "docs/design/plan-11/after/$theme/" } }
  Copy-Item "$EVID/after-$theme/13-checklist.png" "docs/design/plan-11/after/$theme/"
}
```

Look at each file; none may show a local path or a user name. Write `docs/design/plan-11/REPORT.md` with: how to repeat it (the commands above); the foundation result (the numbers from `$EVID/fold-light.md` and `$EVID/fold-dark.md` and from Task 3's compare: snapshots compared, differences found, which must read 0); the table of intended changes from `$EVID/after-light.md` and `$EVID/after-dark.md`, each row with the task that explains it; a before and after image table for the six states at three widths (relative links into `before/` and `after/`); and the limits (Chromium only; computed styles were captured with reduced motion on, so transition timing was not compared; forced hover, focus and pressed states were captured at 1280px only; the hosted edition's plan card cannot be walked and rests on the static stylesheet test and the frozen browser spec).

- [ ] **Step 4: Run the full gate, sequentially**

```powershell
New-Item -ItemType Directory -Force C:/Users/Gowrishankar/AppData/Local/Temp/opencode | Out-Null
npm run typecheck
npm run lint
npm run build
$env:CI = "true"; npx vitest run --reporter=dot --maxWorkers=2
npm run brain-eval
npx playwright test --workers=1
git restore docs/screenshots
git status --short
git diff --stat main -- apps/server apps/worker apps/mcp apps/cli packages
git diff main -- apps/web/src.tsx | Select-String -Pattern '^\+.*api[<(]'
```

Expected: typecheck, lint and build exit 0. Vitest: about 2,138 passed (2,121 plus 6 stylesheet, 1 type scale, 4 steps, 6 checklist) and 8 skipped, 0 failed; if the three known timeout cases in `managed-recovery-review` or `provenance` appear, rerun those two files alone with `--maxWorkers=1` and record both results. brain-eval: 57/57. Playwright: 111 plus the new tests (1 in Task 3, 2 in Task 4, 2 in Task 5, 1 in Task 6, 1 in Task 7 = 118), 0 failed. `git status` shows only files this task is about to commit. The server diff prints nothing. The last command prints only lines that were moved (the Better search and sorting handlers), and none inside `refresh`; confirm by reading `refresh` and seeing its `Promise.all` still lists the same nine requests.

Record the real numbers; never the expected ones.

- [ ] **Step 5: Update the state documents with the real numbers**

`BUILD_STATE.md`: set `Updated:` to the day of the run; add a section above "2026-11-12 — Design audit" titled `## <date> — Plan 11: design foundation and the audit's L3 proposals (branch reframe/design-foundation)` with: Plan and report paths; "What changed (web only; no server, data, permission or API change)" as six bullets, one per proposal, each with its commit; "Verified in this worktree on <date> (Windows, Node 24.19.0)" with the commands from Step 4 and their real counts; "Known limits" (the hosted edition keeps the header Save on Today and its own background card; steps 1 and 2 of the checklist share one signal; Chromium only; the residual 0.08–0.12 Connections layout shift and the unexplained disabled "Add to Codex" from the audit remain open). In "At a glance", change the "Next plans" cell only if a count or state it names changed. In the 2026-11-12 section, change the last known limit to say type is now in rem (plan 11).

`README.md` line 158: replace the two counts with the real Vitest and Playwright totals.

`CHANGELOG.md`, under `## [Unreleased]`, add to `### Changed`:

```markdown
- Today has one way to save: the bar. The header's Save something stays on Your brain, Connections and Settings.
- Today's status ("Caught up", "2 to look at") sits beside Today's title. On a phone the header is one row, with Settings as an icon button.
- Settings has one Background help card in three steps: allow it, set the limits, choose what it may do. A choice that is on can always be turned off. Nothing about what is sent, spent or stored changed.
- After you add an agent, Connections shows a three-step checklist that ticks from the agent's first recorded call and first recorded push; the long instructions are behind Details.
- Text size follows your browser's text-size setting.
```

and to a `### Internal` heading (create it after `### Changed` if absent): `- One stylesheet foundation: \`apps/web/styles/tokens.css\` and \`apps/web/styles/app.css\` replace two layered stylesheets; a script compares computed styles before and after (\`scripts/design-compare.mjs\`).`

`docs/design/AUDIT-2026-11.md`: retitle section 4 `## 4. L3 proposals (implemented in plan 11)`; replace its first line with `Implemented on branch \`reframe/design-foundation\`; evidence in [plan-11/REPORT.md](plan-11/REPORT.md). Each item below ends with the commit that did it.`; append to each of the six items a line `- **Done:** \`<short sha>\`` (item 3 lists the Task 2 commits, item 4 the Task 3 commit) and, where a ruling narrowed it, one sentence (item 1: local app only; item 5: local app only, and Better search on this computer is never gated). In section 5's table change the "Type in px" row's status to `Fixed (plan 11)`.

- [ ] **Step 6: Commit**

```bash
git add docs/design/plan-11/after docs/design/plan-11/REPORT.md BUILD_STATE.md README.md CHANGELOG.md docs/design/AUDIT-2026-11.md
git commit -m "docs: plan 11 evidence, build state and changelog" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Do not push. Report the commit list, the real gate numbers and anything in Step 1 or Step 2 that needed a fix.
