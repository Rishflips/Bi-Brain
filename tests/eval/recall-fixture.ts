import { Storage } from "../../packages/storage/index.ts";
import { Brain } from "../../packages/domain/service.ts";
import type { Principal } from "../../packages/contracts/index.ts";

export const FIXTURE_CLOCK = "2026-10-25T09:00:00.000Z";
export const owner: Principal = { kind: "owner" };
export type Fixture = { store: Storage; brain: Brain; ids: Record<string, string>; agentToken: string; agent: Principal };

/** Code-point evidence for an exact quote inside a body. */
export function quoteRange(body: string, quote: string) {
  const points = Array.from(body);
  const q = Array.from(quote);
  outer: for (let i = 0; i + q.length <= points.length; i++) {
    for (let j = 0; j < q.length; j++) if (points[i + j] !== q[j]) continue outer;
    return { start: i, end: i + q.length };
  }
  throw new Error(`quote not found: ${quote}`);
}

/** A current (or retired) claim with exact evidence, written through the entity path so the index follows. */
export function claim(b: Brain, key: string, ids: Record<string, string>, project: string, source: { id: string; body: string; version: number }, c: { entity: string; aspect: string; value: unknown; quote: string; recorded_at: string; status?: "current" | "retired"; supersedes?: string[]; authority?: string; valid_to?: string }) {
  const range = quoteRange(source.body, c.quote);
  const id = `11111111-0000-4000-8000-${String(Object.keys(ids).length + 1).padStart(12, "0")}` as `${string}-${string}-${string}-${string}-${string}`;
  b.createEntity(project, "claim", {
    entity: c.entity, aspect: c.aspect, value: c.value, status: c.status ?? "current", authority: c.authority ?? "owner_reviewed",
    valid_from: c.recorded_at, recorded_at: c.recorded_at, source_id: source.id, source_version: source.version, agent: "owner", ts: c.recorded_at,
    evidence: [{ source_id: source.id, source_version: source.version, start: range.start, end: range.end, quote: c.quote }],
    supersedes: c.supersedes ?? [], conflicts_with: [],
    ...(c.status === "retired" ? { valid_to: "2026-10-20T00:00:00.000Z", retirement_reason: "owner_corrected" } : c.valid_to ? { valid_to: c.valid_to } : {}),
  }, id);
  ids[key] = id;
  return id;
}

export function buildFixture(dbPath: string): Fixture {
  const store = new Storage(dbPath);
  const brain = new Brain(store, () => new Date(FIXTURE_CLOCK));
  const ids: Record<string, string> = {};
  const northstar = brain.createProject(owner, "Northstar");
  const hydra = brain.createProject(owner, "Hydra");
  ids["project:northstar"] = northstar.id;
  ids["project:hydra"] = hydra.id;
  const note = (key: string, project: string, title: string, body: string, visibility: "project" | "private" = "project") => {
    const r = brain.capture(owner, { project_id: project, title, body, visibility, separate: true }) as any;
    ids[key] = r.source_id;
    return { id: r.source_id as string, body, version: 1 };
  };
  const launch = note("src:launch-notes", northstar.id, "Launch notes", "We met on Tuesday to settle the palette. After a long debate the launch color is cobalt. Ana wants the banner shipped by Friday.");
  const palette = note("src:palette-review", northstar.id, "Palette review", "Marco reviewed three palettes. He preferred the warm one, and the amber accent was kept for icons only.");
  const beta = note("src:beta-timeline", northstar.id, "Beta timeline", "The Northstar beta opens on November 14. Invites go out the week before.\n\nOpen question: do we need a waitlist?");
  const pricing = note("src:pricing", northstar.id, "Pricing call", "Northstar ships with one plan. The price stays at nine dollars a month until the beta ends.");
  const marco = note("src:marco", northstar.id, "People", "Marco is the design lead for Northstar. He works from Lisbon and prefers async reviews.");
  const paragraph = "Routine meeting notes about scheduling, room bookings and travel that carry no decision. ";
  const buried = note("src:buried", northstar.id, "Weekly notes", paragraph.repeat(28) + "\n\n" + paragraph.repeat(28) + "\n\nThe vendor for the launch party is Lumen Catering, confirmed by Ana.\n\n" + paragraph.repeat(10));
  const hydraNote = note("src:hydra-deploy", hydra.id, "Hydra deploy", "Hydra deploys from the release branch every Thursday. HYDRA_CANARY_TOKEN_TEXT marks this note.");
  note("src:private-journal", northstar.id, "Journal", "PRIVATE_CANARY_TEXT I am not sure the launch color was the right call.", "private");
  const oldStatus = note("src:old-status", northstar.id, "Status in September", "Northstar status paused while the team was on leave.");
  const newStatus = note("src:new-status", northstar.id, "Status in October", "Northstar status active again since the team returned.");
  // Identity text lives only in a PRIVATE source: an agent never sees this original, so "Ana Costa" and "short answers" are clean canaries.
  const prefs = note("src:prefs", northstar.id, "Owner preferences", "Owner preference: short answers. Owner name: Ana Costa.", "private");
  claim(brain, "fact:launch-color", ids, northstar.id, launch, { entity: "Launch color", aspect: "statement", value: "cobalt", quote: "the launch color is cobalt", recorded_at: "2026-10-20T10:00:00.000Z" });
  claim(brain, "fact:amber-icons", ids, northstar.id, palette, { entity: "Amber accent", aspect: "statement", value: "kept for icons only", quote: "the amber accent was kept for icons only", recorded_at: "2026-10-19T10:00:00.000Z" });
  claim(brain, "fact:beta-opens", ids, northstar.id, beta, { entity: "Northstar beta", aspect: "statement", value: "opens November 14", quote: "The Northstar beta opens on November 14", recorded_at: "2026-10-18T10:00:00.000Z" });
  claim(brain, "fact:price", ids, northstar.id, pricing, { entity: "Northstar price", aspect: "statement", value: "nine dollars a month until the beta ends", quote: "The price stays at nine dollars a month until the beta ends", recorded_at: "2026-09-10T10:00:00.000Z" });
  claim(brain, "fact:marco-role", ids, northstar.id, marco, { entity: "Marco", aspect: "statement", value: "design lead for Northstar, works from Lisbon", quote: "Marco is the design lead for Northstar", recorded_at: "2026-08-30T10:00:00.000Z" });
  claim(brain, "fact:caterer", ids, northstar.id, buried, { entity: "Launch party caterer", aspect: "statement", value: "Lumen Catering", quote: "The vendor for the launch party is Lumen Catering", recorded_at: "2026-10-21T10:00:00.000Z" });
  const old = claim(brain, "fact:status-old", ids, northstar.id, oldStatus, { entity: "northstar", aspect: "status", value: "paused", quote: "Northstar status paused", recorded_at: "2026-09-01T10:00:00.000Z", status: "retired" });
  claim(brain, "fact:status-new", ids, northstar.id, newStatus, { entity: "northstar", aspect: "status", value: "active", quote: "Northstar status active", recorded_at: "2026-10-22T10:00:00.000Z", supersedes: [old] });
  claim(brain, "fact:hydra-deploy", ids, hydra.id, hydraNote, { entity: "Hydra deploy", aspect: "statement", value: "release branch every Thursday", quote: "Hydra deploys from the release branch every Thursday", recorded_at: "2026-10-23T10:00:00.000Z" });
  claim(brain, "fact:owner-pref", ids, northstar.id, prefs, { entity: "Owner", aspect: "preference", value: "short answers", quote: "Owner preference: short answers", recorded_at: "2026-10-23T10:00:00.000Z" });
  claim(brain, "fact:owner-name", ids, northstar.id, prefs, { entity: "Owner", aspect: "name", value: "Ana Costa", quote: "Owner name: Ana Costa", recorded_at: "2026-10-23T10:00:00.000Z" });
  claim(brain, "fact:stale-pricing-note", ids, northstar.id, pricing, { entity: "Northstar plan", aspect: "statement", value: "one plan", quote: "Northstar ships with one plan", recorded_at: "2026-09-15T10:00:00.000Z" });
  const grant = brain.createGrant(owner, { projects: [northstar.id], operations: ["read"], expires_at: "2027-01-01T00:00:00.000Z", client: "claude-code" });
  ids["grant:northstar-read"] = grant.id;
  return { store, brain, ids, agentToken: grant.token, agent: brain.authenticateAgent(grant.token) };
}
