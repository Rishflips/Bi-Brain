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

  it("reports a failed preparation job in plain language, linking the original only when known", () => {
    const input = empty();
    input.failedJobs.push(
      { id: "j1", project_id: "p1", kind: "derive_brief", attempts: 3, created_at: "2026-10-22T08:00:00Z", source_id: "s9" },
      { id: "j2", project_id: "p1", kind: "derive_brief", attempts: 1, created_at: "2026-10-21T08:00:00Z" },
    );
    const [withSource, without] = buildBrief(input, now).items;
    expect(withSource).toMatchObject({ kind: "failed_job", title: "A saved note could not be prepared.", target: { type: "job", id: "j1" }, source_id: "s9", evidence: [] });
    expect(withSource.why).toBe("Your original is safe. Try again, or open the original.");
    expect(without.why).toBe("Your original is safe. Try again.");
    expect(without.source_id).toBeUndefined();
  });

  it("survives malformed conflicts on a correction gate", () => {
    const base = { status: "queued", correction: true, entity: "Onboarding", field: { aspect: "statement", value: "v" }, evidence: [ev("s3", "v")], actor: "owner" };
    const input = empty();
    input.gates.push(
      entity("gate", "g-bad", { ...base, conflicts: "oops" }),
      entity("gate", "g-mixed", { ...base, conflicts: [null, 5, { value: { a: 1 } }, { value: 7 }, { value: "x" }] }, "2026-10-21T09:00:00Z"),
    );
    const out = buildBrief(input, now);
    const bad = out.items.find((i) => i.target.id === "g-bad");
    const mixed = out.items.find((i) => i.target.id === "g-mixed");
    expect(bad).toBeDefined();
    expect(bad?.before).toBeUndefined();
    expect(mixed?.before).toBe('{"a":1}; 7; x');
  });

  it("ignores items with missing fields instead of printing undefined", () => {
    const input = empty();
    const good = { status: "queued", entity: "X", field: { aspect: "statement", value: "y" }, evidence: [ev("s1", "y")], actor: "owner" };
    input.gates.push(
      entity("gate", "g1", { ...good, entity: undefined }),
      entity("gate", "g2", { ...good, entity: "  " }),
      entity("gate", "g3", { ...good, field: { value: "y" } }),
    );
    input.proposals.push(
      entity("proposal", "p-notitle", { status: "ready", reason: "r", evidence: [ev("s1", "y")] }),
      entity("proposal", "p-noreason", { status: "ready", title: "Look at this", evidence: [ev("s1", "y")] }),
    );
    input.claims.push(entity("claim", "c-noaspect", { status: "current", entity: "beta launch", value: "v", recorded_at: "2026-09-20T09:00:00Z", evidence: [ev("s5", "v")] }));
    input.sources.push(
      { id: "s6", project_id: "p1", body: "beta launch", captured_at: "2026-10-10T09:00:00Z" },
      { id: "s7", project_id: "p1", body: "beta launch", captured_at: "2026-10-12T09:00:00Z" },
    );
    const out = buildBrief(input, now);
    expect(out.items.map((i) => i.target.id)).toEqual(["p-noreason"]);
    expect(out.items[0].why).toBe("New saved material may affect this goal.");
    for (const i of out.items) expect(`${i.title} ${i.why}`).not.toContain("undefined");
  });

  it("orders newest first within one kind", () => {
    const input = empty();
    const mk = (id: string, at: string) => entity("gate", id, { status: "queued", entity: id, field: { aspect: "statement", value: "v" }, evidence: [ev("s", "v")], actor: "owner" }, at);
    input.gates.push(mk("old", "2026-10-01T09:00:00Z"), mk("new", "2026-10-22T09:00:00Z"), mk("mid", "2026-10-10T09:00:00Z"));
    expect(buildBrief(input, now).items.map((i) => i.target.id)).toEqual(["new", "mid", "old"]);
  });

  it("does not trust an agent name that is an inherited property", () => {
    const input = empty();
    input.gates.push(entity("gate", "g", { status: "queued", entity: "X", field: { aspect: "statement", value: "v" }, evidence: [ev("s", "v")], actor: "agent:constructor" }));
    expect(buildBrief(input, now).items[0].why).toContain("A connected agent");
  });

  describe("stale facts", () => {
    const claim = (over: Record<string, any> = {}, created_at?: string) =>
      entity("claim", "c-beta", { status: "current", entity: "beta launch", aspect: "statement", value: "opens November 14", recorded_at: "2026-09-20T09:00:00Z", evidence: [ev("s5", "opens November 14")], ...over }, created_at);
    const mention = (id: string, at: string, project_id = "p1", body = "beta launch") => ({ id, project_id, body, captured_at: at });
    const staleInput = () => {
      const input = empty();
      input.claims.push(claim());
      input.sources.push(mention("s6", "2026-10-10T09:00:00Z"), mention("s7", "2026-10-12T09:00:00Z"));
      return input;
    };

    it("is flagged in the baseline setup", () => {
      expect(buildBrief(staleInput(), now).items).toHaveLength(1);
    });

    it("ignores a recently recorded fact", () => {
      const input = staleInput();
      input.claims = [claim({ recorded_at: "2026-10-15T09:00:00Z" })];
      expect(buildBrief(input, now).items).toEqual([]);
    });

    it("needs at least two mentions", () => {
      const input = staleInput();
      input.sources.pop();
      expect(buildBrief(input, now).items).toEqual([]);
    });

    it("ignores mentions in another project", () => {
      const input = staleInput();
      input.sources = [mention("s6", "2026-10-10T09:00:00Z", "p2"), mention("s7", "2026-10-12T09:00:00Z", "p2")];
      expect(buildBrief(input, now).items).toEqual([]);
    });

    it("ignores mentions saved before the fact was last checked", () => {
      const input = staleInput();
      input.sources = [mention("s6", "2026-09-01T09:00:00Z"), mention("s7", "2026-09-10T09:00:00Z")];
      expect(buildBrief(input, now).items).toEqual([]);
    });

    it("matches whole words only", () => {
      const input = staleInput();
      input.claims = [claim({ entity: "beta" })];
      input.sources = [mention("s6", "2026-10-10T09:00:00Z", "p1", "A betamax review"), mention("s7", "2026-10-12T09:00:00Z", "p1", "alphabeta soup")];
      expect(buildBrief(input, now).items).toEqual([]);
      input.sources = [mention("s6", "2026-10-10T09:00:00Z", "p1", "The BETA, finally."), mention("s7", "2026-10-12T09:00:00Z", "p1", "beta?")];
      expect(buildBrief(input, now).items).toHaveLength(1);
    });

    it("treats regex characters in the name literally", () => {
      const input = staleInput();
      input.claims = [claim({ entity: "c++ (core)" })];
      input.sources = [mention("s6", "2026-10-10T09:00:00Z", "p1", "c++ (core) again"), mention("s7", "2026-10-12T09:00:00Z", "p1", "C++ (Core)")];
      expect(buildBrief(input, now).items).toHaveLength(1);
    });

    it("falls back across timestamps and skips a fact with none valid", () => {
      const input = staleInput();
      input.claims = [claim({ recorded_at: "nonsense" }, "2026-09-20T09:00:00Z")];
      expect(buildBrief(input, now).items).toHaveLength(1);
      input.confirmations["c-beta"] = "not a date";
      expect(buildBrief(input, now).items).toHaveLength(1);
      input.claims = [claim({ recorded_at: "nonsense" }, "also nonsense")];
      expect(buildBrief(input, now).items).toEqual([]);
    });

    it("stays quiet when a queued correction already covers the same fact", () => {
      const input = staleInput();
      input.gates.push(entity("gate", "g-fix", { status: "queued", correction: true, conflicts: [], entity: "Beta Launch", field: { aspect: "statement", value: "opens December 1" }, evidence: [ev("s8", "opens December 1")], actor: "owner" }));
      expect(buildBrief(input, now).items.map((i) => i.kind)).toEqual(["correction"]);
    });
  });

  it("never returns an item without evidence except failed jobs", () => {
    const input = empty();
    input.gates.push(entity("gate", "g-none", { status: "queued", entity: "X", field: { aspect: "statement", value: "y" }, evidence: [], actor: "owner" }));
    expect(buildBrief(input, now).items).toEqual([]);
  });
});
