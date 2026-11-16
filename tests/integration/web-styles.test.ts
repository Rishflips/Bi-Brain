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
