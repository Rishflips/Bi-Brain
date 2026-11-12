// Walks BiBrain's core paths in a real Chromium at three widths, on a fresh,
// throwaway brain, and records what a design audit needs: one full-page
// screenshot per state and width, plus measured layout and accessibility checks.
//
//   node scripts/design-audit-walk.mjs <out-dir> [--only=name,name] [--dark]
//
// It starts its own server (BRAIN_EMBED_PROVIDER=off, a test pairing code, a
// temporary database and a fake home) and stops it afterwards. Nothing in the
// owner's data folder is read or written.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const out = resolve(process.argv[2] ?? "design-audit-out");
const dark = process.argv.includes("--dark");
const only = (process.argv.find((a) => a.startsWith("--only=")) ?? "").slice(7).split(",").filter(Boolean);
const port = Number(process.env.AUDIT_PORT ?? 4517);
const base = `http://127.0.0.1:${port}`;
const code = "audit-local-only";
const widths = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "tablet", width: 820, height: 1180 },
  { name: "phone", width: 390, height: 844 },
];

mkdirSync(out, { recursive: true });
const work = mkdtempSync(join(tmpdir(), "bibrain-audit-"));
const home = join(work, "home");
mkdirSync(join(home, ".codex"), { recursive: true });
mkdirSync(join(home, ".claude"), { recursive: true });

const server = spawn(process.execPath, ["scripts/run.mjs", "production"], {
  env: {
    ...process.env,
    BRAIN_PORT: String(port),
    BRAIN_DB: join(work, "brain.sqlite"),
    BRAIN_OWNER_SECRET: code,
    BRAIN_EMBED_PROVIDER: "off",
    BRAIN_AGENT_HOME: home,
    BRAIN_AGENT_PATH: "",
  },
  stdio: "ignore",
});

async function waitForServer() {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${base}/api/v1/health/live`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("server did not start");
}

// Measured checks, run inside the page.
function measure() {
  const vw = document.documentElement.clientWidth;
  const issues = [];
  const hscroll = document.documentElement.scrollWidth - vw;
  if (hscroll > 0) issues.push({ kind: "horizontal-scroll", detail: `${hscroll}px` });
  const label = (el) =>
    (el.getAttribute("aria-label") || el.textContent || el.getAttribute("placeholder") || el.tagName)
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 48);
  const visible = (el) => {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0 && r.width > 0 && r.height > 0;
  };
  for (const el of document.querySelectorAll("main *, header *, aside *, [role=dialog] *")) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.right > vw + 1 && getComputedStyle(el).position !== "fixed") {
      const clipped = el.closest("[style*=overflow], pre, code, .tv-scroll");
      if (!clipped) issues.push({ kind: "past-viewport", detail: `${label(el)} right=${Math.round(r.right)}` });
    }
  }
  const targets = document.querySelectorAll("button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button]");
  for (const el of targets) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    const inline = el.matches("a, button.link") && getComputedStyle(el).display === "inline";
    // A checkbox or radio inside its label is hit through the whole label (WCAG 2.5.8 exception).
    if (el.matches("input[type=checkbox], input[type=radio]") && el.closest("label")) continue;
    if (!inline && (r.width < 24 || r.height < 24))
      issues.push({ kind: "target-under-24", detail: `${label(el)} ${Math.round(r.width)}x${Math.round(r.height)}` });
    else if (vw < 600 && !inline && r.height < 40 && !el.matches("input[type=checkbox], input[type=radio]"))
      issues.push({ kind: "touch-under-40", detail: `${label(el)} ${Math.round(r.width)}x${Math.round(r.height)}` });
    const name = el.getAttribute("aria-label") || el.getAttribute("aria-labelledby") || el.textContent?.trim() || el.title;
    const labelled = el.labels?.length || el.closest("label");
    if (!name && !labelled) issues.push({ kind: "no-accessible-name", detail: el.outerHTML.slice(0, 80) });
  }
  // Contrast for visible text, against the nearest opaque background.
  const parse = (c) => {
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 };
  };
  const lum = ({ r, g, b }) => {
    const f = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const bgOf = (el) => {
    for (let n = el; n; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c.a >= 0.9) return c;
    }
    return parse(getComputedStyle(document.body).backgroundColor) ?? { r: 255, g: 255, b: 255 };
  };
  const seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    const el = t.parentElement;
    if (!el || !t.textContent.trim() || seen.has(el) || !visible(el)) continue;
    seen.add(el);
    const s = getComputedStyle(el);
    const fg = parse(s.color);
    if (!fg) continue;
    const bg = bgOf(el);
    const mixed = { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a) };
    const [hi, lo] = [lum(mixed), lum(bg)].sort((a, b) => b - a);
    const ratio = (hi + 0.05) / (lo + 0.05);
    const size = parseFloat(s.fontSize);
    const large = size >= 24 || (size >= 18.66 && Number(s.fontWeight) >= 700);
    const opacity = Number(s.opacity);
    if (ratio < (large ? 3 : 4.5) && opacity > 0.5 && !el.closest("button:disabled, [aria-hidden=true]"))
      issues.push({ kind: "contrast", detail: `${ratio.toFixed(2)} ${size}px "${t.textContent.trim().slice(0, 40)}"` });
    if (size < 12) issues.push({ kind: "text-under-12px", detail: `${size}px "${t.textContent.trim().slice(0, 40)}"` });
  }
  return issues;
}

const report = [];
// Dialog states are captured at the viewport only: a full-page capture of a modal
// repeats the sticky header and misplaces the backdrop.
async function capture(page, state, { dialog = false } = {}) {
  if (only.length && !only.includes(state)) return;
  for (const w of widths) {
    await page.setViewportSize({ width: w.width, height: w.height });
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(out, `${state}--${w.name}.png`), fullPage: !dialog });
    const issues = await page.evaluate(measure);
    report.push({ state, viewport: w.name, issues });
  }
  // 200% browser zoom on a 1440x900 screen leaves a 720x450 CSS-pixel viewport.
  await page.setViewportSize({ width: 720, height: 450 });
  await page.waitForTimeout(250);
  const zoomed = await page.evaluate(measure);
  report.push({ state, viewport: "zoom-200", issues: zoomed.filter((i) => i.kind !== "contrast") });
  await page.screenshot({ path: join(out, `${state}--zoom200.png`), fullPage: !dialog });
  const shift = await page.evaluate(() => {
    const total = { value: globalThis.__cls ?? 0, sources: globalThis.__clsSrc ?? [] };
    globalThis.__cls = 0;
    globalThis.__clsSrc = [];
    return total;
  });
  if (shift.value > 0.05)
    report.push({ state, viewport: "layout-shift", issues: [{ kind: "layout-shift", detail: `${shift.value.toFixed(3)} (${shift.sources.join(" | ").slice(0, 300)})` }] });
  await page.setViewportSize(widths[0]);
}

// Focus starts inside an open dialog, Tab stays inside it, and Escape returns focus to the opener.
async function keyboardCheck(page, state, opener) {
  const issues = [];
  const inside = () => page.evaluate(() => !!document.activeElement?.closest("dialog[open]"));
  if (!(await inside())) issues.push({ kind: "dialog-focus-start", detail: "focus is not in the dialog" });
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press("Tab");
    if (!(await inside())) {
      issues.push({ kind: "dialog-focus-escapes", detail: `after ${i + 1} Tab presses` });
      break;
    }
  }
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  const back = await page.evaluate(() => (document.activeElement?.textContent ?? "").trim());
  if (!back.startsWith(opener)) issues.push({ kind: "dialog-focus-return", detail: `focus went to "${back.slice(0, 40)}"` });
  report.push({ state, viewport: "keyboard", issues });
}

async function csrf(page) {
  return page.evaluate(async () => (await (await fetch("/api/v1/session")).json()).csrf);
}
async function post(page, path, body, method = "POST") {
  const token = await csrf(page);
  return page.evaluate(
    async ({ path, body, token, method }) => {
      const res = await fetch(path, {
        method,
        headers: { "Content-Type": "application/json", "X-Brain-CSRF": token, "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    { path, body, token, method },
  );
}

try {
  await waitForServer();
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: widths[0], reducedMotion: "reduce" });
  const page = await context.newPage();
  globalThis.__pages = [page];
  // Sum unexpected layout shifts between captures (shifts within 500ms of input are excluded by the browser).
  if (dark) await page.addInitScript(() => localStorage.setItem("brain-theme", "dark"));
  await page.addInitScript(() => {
    globalThis.__cls = 0;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.hadRecentInput) continue;
        globalThis.__cls += e.value;
        if (e.value > 0.05)
          (globalThis.__clsSrc ??= []).push(
            `${e.value.toFixed(2)}: ` +
              e.sources.map((x) => `${x.node?.className || x.node?.nodeName} ${Math.round(x.previousRect.y)}→${Math.round(x.currentRect.y)}`).join(", "),
          );
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
  await page.goto(base);
  await page.getByLabel("Installation code").waitFor();
  await capture(page, "01-first-run");
  await page.keyboard.press("Tab");
  const first = await page.evaluate(() => document.activeElement?.className ?? "");
  report.push({ state: "01-first-run", viewport: "keyboard", issues: first.includes("skip-link") ? [] : [{ kind: "skip-link", detail: `first Tab reached "${first}"` }] });

  await page.getByLabel("Installation code").fill(code);
  await page.getByRole("button", { name: "Open my brain" }).click();
  await page.getByRole("navigation", { name: "Main navigation" }).waitFor();
  await page.getByRole("heading", { name: "Welcome to BiBrain." }).waitFor();
  await capture(page, "02-today-empty");

  const bar = page.getByLabel(/save to your brain|ask your brain/i);
  await bar.fill("We decided that Northstar beta is invite only.");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText(/kept exactly as you wrote it/i).waitFor();
  await capture(page, "03-today-saved");

  const card = page.getByRole("article").filter({ hasText: "invite only" });
  await card.waitFor({ timeout: 20000 });
  await page.waitForTimeout(600);
  await capture(page, "04-today-brief");

  await card.getByRole("button", { name: "Fix" }).click();
  await capture(page, "05-brief-fix");
  await card.getByRole("button", { name: "Cancel" }).click();
  await card.getByRole("button", { name: "Keep as true" }).click();
  await page.getByText(/kept as a fact/i).waitFor();
  await capture(page, "06-brief-undo");

  const project = await post(page, "/api/v1/projects", { name: "Northstar" });
  const northstar = project.body?.id ?? project.body?.project?.id;
  await post(page, "/api/v1/sources", {
    title: "Northstar launch notes",
    body: "Northstar launch notes.\nWe decided the pricing page ships with three plans.\nOpen question: who writes the onboarding copy?\nThe invite list closes on Friday.",
    project_id: northstar ?? "inbox",
    visibility: "shareable",
  });
  await page.reload();
  await page.getByRole("navigation", { name: "Main navigation" }).waitFor();
  await bar.fill("Is the beta invite only?");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1500);
  await capture(page, "07-today-ask");

  // Your brain, with a note an agent wrote so "Mark as reviewed" is real.
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  const codex = page.getByRole("region", { name: "Codex" });
  await codex.waitFor();
  await capture(page, "11-connections");
  await codex.getByRole("button", { name: "Add to Codex" }).click();
  await capture(page, "12-connections-add");
  const folder = mkdtempSync(join(tmpdir(), "bibrain-audit-repo-"));
  await codex.getByLabel("Project", { exact: true }).selectOption({ label: "Inbox" });
  await codex.getByLabel("Project folder on this computer").fill(folder);
  await codex.getByRole("button", { name: "Add to Codex", exact: true }).last().click();
  await codex.getByText("Waiting for its first call").waitFor();
  const written = readFileSync(join(folder, ".codex", "config.toml"), "utf8");
  const id = /"--connection", "([0-9a-f-]{36})"/.exec(written)[1];
  const { key } = JSON.parse(readFileSync(join(work, "agent-keys", `${id}.json`), "utf8"));
  await page.request.post(`${base}/api/v1/agent/note`, {
    headers: { Authorization: `Bearer ${key}` },
    data: { project_id: "inbox", open_questions: ["Which lease length is right for the office?"] },
  });
  await page.reload();
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  await codex.waitFor();
  await capture(page, "13-connections-waiting");
  await page.getByRole("button", { name: "Set up by hand" }).click();
  await page.waitForTimeout(300);
  await capture(page, "14-connections-by-hand", { dialog: true });
  await keyboardCheck(page, "14-connections-by-hand", "Set up by hand");

  await page.getByRole("button", { name: "Your brain", exact: true }).click();
  await page.getByRole("heading", { name: "Your brain", level: 1 }).waitFor();
  await page.waitForTimeout(500);
  await capture(page, "08-brain-project");
  await page.getByRole("button", { name: "Session note from Codex" }).first().click();
  await page.getByRole("button", { name: "Mark as reviewed" }).waitFor();
  await capture(page, "09-brain-source", { dialog: true });
  await keyboardCheck(page, "09-brain-source", "Session note from Codex");
  await page.getByPlaceholder("Search facts and originals").fill("invite");
  await page.waitForTimeout(1200);
  await capture(page, "10-brain-search");
  await page.getByPlaceholder("Search facts and originals").fill("");

  await page.getByRole("button", { name: /settings/i }).first().click();
  await page.getByRole("heading", { name: /settings/i, level: 1 }).waitFor();
  await page.waitForTimeout(500);
  await capture(page, "15-settings");

  await browser.close();
} catch (error) {
  for (const p of globalThis.__pages ?? []) await p.screenshot({ path: join(out, "failure.png"), fullPage: true }).catch(() => {});
  throw error;
} finally {
  // The supervisor starts the API and the worker; on Windows end the whole tree.
  if (process.platform === "win32") spawn("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
  else server.kill();
  writeFileSync(join(out, "checks.json"), JSON.stringify(report, null, 2));
}
