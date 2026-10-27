import { it, expect } from "vitest";
import { Storage } from "../../packages/storage/index.ts";
import { Brain } from "../../packages/domain/service.ts";
const owner = { kind: "owner" } as const;
it("gates identity/decisions, commits literal facts, keeps conflicting and retired truth out of default retrieval", () => {
  const s = new Storage(":memory:");
  try {
    const b = new Brain(s);
    const fact = b.propose(
      owner,
      {
        project_id: "inbox",
        title: "Schedule",
        text: "Beta status active",
        type: "fact",
        entity: "beta",
        field: { aspect: "status", value: "active" },
      },
      "same-fact",
    );
    expect(fact.disposition).toBe("commit");
    expect(
      b.propose(
        owner,
        {
          project_id: "inbox",
          title: "Schedule",
          text: "Beta status active",
          type: "fact",
          entity: "beta",
          field: { aspect: "status", value: "active" },
        },
        "same-fact",
      ),
    ).toEqual(fact);
    expect(() =>
      b.propose(
        owner,
        {
          project_id: "inbox",
          title: "Other",
          text: "Beta status done",
          type: "fact",
          entity: "beta",
          field: { aspect: "status", value: "done" },
        },
        "same-fact",
      ),
    ).toThrow();
    const conflict = b.propose(owner, {
      project_id: "inbox",
      title: "Update",
      text: "Beta status done",
      type: "fact",
      entity: "beta",
      field: { aspect: "status", value: "done" },
    });
    expect(conflict.disposition).toBe("queue");
    expect(conflict.reason_codes).toContain("overlapping_conflict");
    const identity = b.propose(owner, {
      project_id: "inbox",
      title: "Identity",
      text: "My name is Alex",
      type: "identity",
      entity: "me",
      field: { aspect: "name", value: "Alex" },
    });
    expect(identity.disposition).toBe("queue");
    const decision = b.propose(owner, {
      project_id: "inbox",
      title: "Decision",
      text: "Decision: active",
      type: "decision",
      entity: "beta",
      field: { aspect: "status", value: "active" },
    });
    expect(decision.disposition).toBe("queue");
    const unknown = b.propose(owner, {
      project_id: "inbox",
      title: "Loose note",
      text: "Maybe we should look at beta",
      type: "unknown",
    });
    expect(unknown.disposition).toBe("queue");
    expect(b.source(owner, unknown.raw_id).body).toContain("Maybe");
    expect(b.currentClaims(owner, "inbox").map((c) => c.id)).toEqual(
      fact.claim_ids,
    );
    expect(
      b
        .pages(owner, "inbox", "beta")[0]
        .uncertain.some((g) => g.id === conflict.proposal_id),
    ).toBe(true);
    const c = b.entity(owner, fact.claim_ids[0]);
    b.retireClaim(owner, c.id, c.version);
    expect(b.currentClaims(owner, "inbox")).toHaveLength(0);
    expect(b.currentClaims(owner, "inbox", true)).toHaveLength(1);
    expect(
      b.pages(owner, "inbox", "beta", true)[0].history[0].data.status,
    ).toBe("retired");
    b.reviewGate(owner, identity.proposal_id, {
      action: "accept",
      expected_version: 1,
    });
    expect(b.currentClaims(owner, "inbox")).toHaveLength(1);
    const grant = b.createGrant(owner, {
      projects: ["inbox"],
      operations: ["read"],
      expires_at: new Date(Date.now() + 86400000).toISOString(),
    });
    const agent = b.authenticateAgent(grant.token);
    expect(b.currentClaims(agent, "inbox")).toHaveLength(0);
    const raw = b.source(owner, fact.raw_id);
    b.editSource(owner, raw.id, {
      expected_version: raw.version,
      title: raw.title,
      body: "Beta status paused",
    });
    expect(
      b.currentClaims(owner, "inbox").some((c) => c.id === fact.claim_ids[0]),
    ).toBe(false);
    expect(
      b
        .currentClaims(owner, "inbox", true)
        .some((c) => c.id === fact.claim_ids[0]),
    ).toBe(true);
    b.removeSource(owner, identity.raw_id, 1, true);
    expect(
      b
        .currentClaims(owner, "inbox", true)
        .some((c) => c.data.value === "Alex"),
    ).toBe(false);
    expect(
      JSON.stringify(s.all("SELECT data FROM entity_versions")),
    ).not.toContain("Alex");
  } finally {
    s.close();
  }
});
it("agent identity proposals stay owner-private even when mislabeled as facts", () => {
  const s = new Storage(":memory:");
  try {
    const b = new Brain(s, () => new Date("2026-09-28T06:00:00Z"));
    const grant = b.createGrant(owner, {
      projects: ["inbox"],
      operations: ["read", "propose_memory"],
      expires_at: "2026-09-29T06:00:00Z",
    });
    const agent = b.authenticateAgent(grant.token);
    const proposed = b.propose(agent, {
      project_id: "inbox",
      title: "Identity",
      text: "My name is Alex",
      type: "fact",
      entity: "me",
      field: { aspect: "statement", value: "Alex" },
    });
    expect(proposed.disposition).toBe("queue");
    expect(b.source(owner, proposed.raw_id).visibility).toBe("private");
    expect(() => b.source(agent, proposed.raw_id)).toThrow("unavailable");
    expect(JSON.stringify(b.sources(agent, "inbox", "Alex"))).not.toContain(
      "Alex",
    );
  } finally {
    s.close();
  }
});
