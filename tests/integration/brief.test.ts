import { describe, expect, it } from "vitest";
import { buildBrief, BRIEF_LIMIT, type BriefInput } from "../../packages/domain/brief.ts";
import type { Entity } from "../../packages/contracts/index.ts";

const now = new Date("2026-10-23T09:00:00Z");
const ev = (source_id: string, quote: string) => ({ source_id, source_version: 1, start: 0, end: quote.length, quote });
const entity = (kind: string, id: string, data: Record<string, any>, created_at = "2026-10-22T09:00:00Z"): Entity => ({
  id, project_id: "p1", kind, version: 1, data, created_at,
});
const empty = (): BriefInput => ({
  gates: [], proposals: [], claims: [], failedJobs: [], sources: [],
  dismissed: [], confirmations: {}, agentNames: {},
});

describe("buildBrief", () => {
  it("returns a quiet result when nothing needs review", () => {
    expect(buildBrief(empty(), now)).toEqual({ items: [], waiting: 0 });
  });

  it("ranks corrections before proposals before agent memories, and caps at three", () => {
    const input = empty();
    input.gates.push(
      entity("gate", "g-owner", { status: "queued", entity: "Beta", field: { aspect: "statement", value: "invite only" }, evidence: [ev("s1", "Beta is invite only")], actor: "owner" }),
      entity("gate", "g-agent", { status: "queued", entity: "Pricing", field: { aspect: "statement", value: "one plan" }, evidence: [ev("s2", "one plan")], actor: "agent:grant-1" }),
      entity("gate", "g-fix", { status: "queued", correction: true, conflicts: [{ id: "c1", version: 1, value: "agent first" }], entity: "Onboarding", field: { aspect: "statement", value: "one conversation first" }, evidence: [ev("s3", "one conversation first")], actor: "owner" }),
    );
    input.proposals.push(entity("proposal", "pr1", { status: "ready", title: "Review new evidence for Launch", reason: "New saved material may affect this goal.", evidence: [ev("s4", "two interviews")] }));
    input.agentNames["grant-1"] = "Claude Code";
    const out = buildBrief(input, now);
    expect(out.items.map((i) => i.target.id)).toEqual(["g-fix", "pr1", "g-agent"]);
    expect(out.items).toHaveLength(BRIEF_LIMIT);
    expect(out.waiting).toBe(1);
    expect(out.items[0]).toMatchObject({ kind: "correction", before: "agent first" });
    expect(out.items[2]).toMatchObject({ kind: "agent_memory", why: expect.stringContaining("Claude Code") });
  });

  it("flags a fact as stale only when it is old and newer originals mention it", () => {
    const input = empty();
    input.claims.push(entity("claim", "c-beta", { status: "current", entity: "beta launch", aspect: "statement", value: "opens November 14", recorded_at: "2026-09-20T09:00:00Z", evidence: [ev("s5", "opens November 14")] }));
    input.sources.push(
      { id: "s6", project_id: "p1", body: "Talked about the beta launch again.", captured_at: "2026-10-10T09:00:00Z" },
      { id: "s7", project_id: "p1", body: "Beta launch invites drafted.", captured_at: "2026-10-12T09:00:00Z" },
    );
    const out = buildBrief(input, now);
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({ kind: "stale", target: { type: "claim", id: "c-beta" } });
    expect(out.items[0].why).toContain("2 originals");
  });

  it("does not flag a recently confirmed fact, and respects dismissal until new mentions arrive", () => {
    const input = empty();
    input.claims.push(entity("claim", "c-beta", { status: "current", entity: "beta launch", aspect: "statement", value: "opens November 14", recorded_at: "2026-09-20T09:00:00Z", evidence: [ev("s5", "opens November 14")] }));
    input.sources.push(
      { id: "s6", project_id: "p1", body: "beta launch", captured_at: "2026-10-10T09:00:00Z" },
      { id: "s7", project_id: "p1", body: "beta launch", captured_at: "2026-10-12T09:00:00Z" },
    );
    const first = buildBrief(input, now).items[0];
    input.dismissed.push(first.signature);
    expect(buildBrief(input, now).items).toEqual([]);
    input.sources.push({ id: "s8", project_id: "p1", body: "beta launch date?", captured_at: "2026-10-20T09:00:00Z" });
    expect(buildBrief(input, now).items).toHaveLength(1);
    input.confirmations["c-beta"] = "2026-10-21T09:00:00Z";
    expect(buildBrief(input, now).items).toEqual([]);
  });

  it("reports a failed preparation job in plain language", () => {
    const input = empty();
    input.failedJobs.push({ id: "j1", project_id: "p1", kind: "derive_brief", attempts: 3, created_at: "2026-10-22T08:00:00Z" });
    const [item] = buildBrief(input, now).items;
    expect(item).toMatchObject({ kind: "failed_job", title: "A saved note could not be prepared.", target: { type: "job", id: "j1" } });
    expect(item.why).toContain("original is safe");
  });

  it("never returns an item without evidence except failed jobs", () => {
    const input = empty();
    input.gates.push(entity("gate", "g-none", { status: "queued", entity: "X", field: { aspect: "statement", value: "y" }, evidence: [], actor: "owner" }));
    expect(buildBrief(input, now).items).toEqual([]);
  });
});
