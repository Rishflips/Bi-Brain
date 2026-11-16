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
