import { expect, it } from "vitest";
import { Storage } from "../../packages/storage/index.ts";
import { Brain } from "../../packages/domain/service.ts";
import { buildPack, validatePack } from "../../packages/domain/binding.ts";
import { Worker } from "../../apps/worker/engine.ts";

const owner = { kind: "owner" } as const;
const fact = (text: string, entity = "beta", value = "active") => ({
  project_id: "inbox",
  title: "Evidence",
  text,
  type: "fact" as const,
  entity,
  field: { aspect: "status" as const, value: value as "active" },
});

it("F1 queues negation, quoted examples, wrong entities and substrings while retaining raw", () => {
  const store = new Storage(":memory:");
  try {
    const brain = new Brain(store);
    for (const text of [
      "Beta is inactive. Do not describe it as active.",
      'Example: "Beta status active" is false.',
      "Gamma status active",
      "Someone said Beta status active",
      "I status active",
    ]) {
      const result = brain.propose(owner, fact(text));
      expect(result.disposition).toBe("queue");
      expect(result.confidence).toBe(0);
      expect(brain.source(owner, result.raw_id).body).toBe(text);
    }
    expect(brain.propose(owner, fact("I status active", "I")).disposition).toBe(
      "queue",
    );
    expect(
      brain.propose(owner, fact("not beta status active", "not beta"))
        .disposition,
    ).toBe("queue");
    expect(brain.currentClaims(owner, "inbox")).toHaveLength(0);
    expect(brain.propose(owner, fact("Beta status active")).disposition).toBe(
      "commit",
    );
  } finally {
    store.close();
  }
});

it("F2 invalidates delivered packs after retirement, conflict and intent closure", () => {
  const store = new Storage(":memory:");
  try {
    const brain = new Brain(store);
    const accepted = brain.propose(owner, fact("Beta status active"));
    const pack = buildPack(brain, owner, "inbox", "beta status");
    brain.retireClaim(owner, accepted.claim_ids[0], 1);
    expect(() => validatePack(brain, owner, pack)).toThrow("changed");

    brain.propose(owner, fact("Beta status active"));
    const beforeConflict = buildPack(brain, owner, "inbox", "beta status");
    const conflict = brain.propose(owner, {
      ...fact("Beta status done", "beta", "done"),
      field: { aspect: "status", value: "done" },
    });
    brain.reviewGate(owner, conflict.proposal_id, {
      action: "accept",
      expected_version: 1,
    });
    expect(() => validatePack(brain, owner, beforeConflict)).toThrow("changed");

    const goal = brain.goal(owner, {
      project_id: "inbox",
      title: "Review beta",
      success_criteria: "Choose next step",
    });
    const beforeClose = buildPack(brain, owner, "inbox", "beta status");
    brain.editGoal(owner, goal.id, {
      expected_version: goal.version,
      status: "done",
    });
    expect(() => validatePack(brain, owner, beforeClose)).toThrow("changed");
  } finally {
    store.close();
  }
});

it("F3 current truth obeys half-open validity intervals including owner review", () => {
  const store = new Storage(":memory:");
  try {
    let now = new Date("2026-09-29T00:00:00Z");
    const brain = new Brain(store, () => now);
    brain.propose(owner, {
      ...fact("Beta status active"),
      valid_from: "2026-01-01T00:00:00Z",
      valid_to: "2026-01-02T00:00:00Z",
    });
    expect(brain.currentClaims(owner, "inbox")).toHaveLength(0);
    expect(brain.agentAsk(owner, "inbox", "beta status").abstained).toBe(true);
    expect(
      brain.agentSearch(owner, "inbox", "beta", "current").items,
    ).toHaveLength(0);
    expect(
      brain.agentSearch(owner, "inbox", "beta", "historical").items,
    ).toMatchObject([{ history: [{ data: { value: "active" } }] }]);
    expect(buildPack(brain, owner, "inbox", "beta").pages).toHaveLength(0);

    now = new Date("2026-09-29T23:59:00Z");
    const queued = brain.propose(owner, {
      ...fact("Gamma status active today", "gamma"),
      valid_from: "2026-09-30T00:00:00Z",
      valid_to: "2026-09-30T00:01:00Z",
    });
    brain.reviewGate(owner, queued.proposal_id, {
      action: "accept",
      expected_version: 1,
    });
    expect(brain.currentClaims(owner, "inbox")).toHaveLength(0);
    const beforeValidityStart = buildPack(
      brain,
      owner,
      "inbox",
      "gamma status",
    );
    now = new Date("2026-09-30T00:00:00Z");
    expect(() => validatePack(brain, owner, beforeValidityStart)).toThrow(
      "changed",
    );
    expect(
      brain.currentClaims(owner, "inbox").map((c) => c.data.entity),
    ).toEqual(["gamma"]);
    now = new Date("2026-09-30T00:01:00Z");
    expect(brain.currentClaims(owner, "inbox")).toHaveLength(0);
    expect(() =>
      brain.propose(owner, {
        ...fact("Delta status active", "delta"),
        valid_from: "2026-10-02T00:00:00Z",
        valid_to: "2026-10-01T00:00:00Z",
      }),
    ).toThrow();
  } finally {
    store.close();
  }
});

it("F4 reviewed agent intentions create, update and close versioned actionable goals", () => {
  const store = new Storage(":memory:");
  try {
    const brain = new Brain(store, () => new Date("2026-09-29T06:00:00Z"));
    const grant = brain.createGrant(owner, {
      projects: ["inbox"],
      operations: ["read", "propose_memory"],
      expires_at: new Date(Date.now() + 86400000).toISOString(),
    });
    const agent = brain.authenticateAgent(grant.token);
    const proposed = brain.agentIntent(agent, "inbox", "propose", {
      text: "Review beta onboarding tomorrow",
      due_at: "2026-10-01T10:00:00Z",
    }) as any;
    expect(brain.agentIntent(agent, "inbox", "list", {})).toHaveLength(0);
    const created = brain.reviewGate(owner, proposed.proposal_id, {
      action: "accept",
      expected_version: 1,
    });
    const goal = brain.entity(owner, created.intent_id!);
    expect(goal.data.title).toBe("Review beta onboarding tomorrow");
    expect(goal.data.preparation_enabled).toBe(true);
    expect(goal.data.due_at).toBe("2026-10-01T10:00:00Z");
    brain.prefs(owner, { ...brain.prefs(owner), enabled: true });
    new Worker(brain).schedule();
    expect(
      store
        .all("SELECT payload FROM jobs WHERE kind='review_changed_assumption'")
        .some((job: any) => JSON.parse(job.payload).goal_id === goal.id),
    ).toBe(true);
    const update = brain.agentIntent(agent, "inbox", "update", {
      id: goal.id,
      expected_version: goal.version,
      text: "Check five users",
    }) as any;
    brain.reviewGate(owner, update.proposal_id, {
      action: "accept",
      expected_version: 1,
    });
    const updated = brain.entity(owner, goal.id);
    expect(updated.data.plan).toBe("Check five users");
    const staleUpdate = brain.agentIntent(agent, "inbox", "update", {
      id: goal.id,
      expected_version: updated.version,
      text: "Outdated agent edit",
    }) as any;
    brain.editGoal(owner, goal.id, {
      expected_version: updated.version,
      plan: "Owner's newer plan",
    });
    expect(() =>
      brain.reviewGate(owner, staleUpdate.proposal_id, {
        action: "accept",
        expected_version: 1,
      }),
    ).toThrow();
    expect(brain.entity(owner, goal.id).data.plan).toBe("Owner's newer plan");
    const close = brain.agentIntent(agent, "inbox", "close", {
      id: goal.id,
      expected_version: brain.entity(owner, goal.id).version,
    }) as any;
    brain.reviewGate(owner, close.proposal_id, {
      action: "accept",
      expected_version: 1,
    });
    expect(brain.entity(owner, goal.id).data.status).toBe("done");
    expect(brain.agentIntent(agent, "inbox", "list", {})).toHaveLength(0);
    const privateIntent = brain.agentIntent(agent, "inbox", "propose", {
      text: "I prefer to keep my private identity off agent packs",
    }) as any;
    expect(brain.source(owner, privateIntent.raw_id).visibility).toBe(
      "private",
    );
    expect(() =>
      brain.reviewGate(owner, privateIntent.proposal_id, {
        action: "accept",
        expected_version: 1,
      }),
    ).toThrow("Private or quarantined");
  } finally {
    store.close();
  }
});

it("F5 ordinary capture and folder import reach reviewed pages, search and agent pack", () => {
  const store = new Storage(":memory:");
  try {
    const brain = new Brain(store);
    const saved = brain.capture(owner, {
      project_id: "inbox",
      title: "Beta note",
      body: "Beta status active",
    }) as any;
    const gate = brain
      .entities(owner, "gate")
      .find((g) => g.data.raw_id === saved.source_id)!;
    expect(gate.data.status).toBe("queued");
    expect(gate.data.evidence[0].quote).toBe("Beta status active");
    brain.reviewGate(owner, gate.id, {
      action: "accept",
      expected_version: gate.version,
    });
    expect(brain.agentSearch(owner, "inbox", "beta").items).toMatchObject([
      { current: [{ data: { value: "active" } }] },
    ]);
    const grant = brain.createGrant(owner, {
      projects: ["inbox"],
      operations: ["read"],
      expires_at: new Date(Date.now() + 86400000).toISOString(),
    });
    const pack = buildPack(
      brain,
      brain.authenticateAgent(grant.token),
      "inbox",
      "beta status",
    );
    expect(pack.pages[0].current[0].value).toBe("active");
    const selection = {
      kind: "folder",
      project_id: "inbox",
      entries: [{ path: "notes/gamma.md", content: "Gamma status planned" }],
    };
    const imported = brain.applyLocalImport(
      owner,
      selection,
      brain.previewLocalImport(owner, selection).checkpoint,
    );
    const importedGate = brain
      .entities(owner, "gate")
      .find((g) => g.data.raw_id === imported.results[0].source_id)!;
    brain.reviewGate(owner, importedGate.id, {
      action: "accept",
      expected_version: importedGate.version,
    });
    expect(brain.agentSearch(owner, "inbox", "gamma").items).toMatchObject([
      { current: [{ data: { value: "planned" } }] },
    ]);
    const prose = brain.capture(owner, {
      project_id: "inbox",
      title: "Meeting note",
      body: "In the meeting, delta was paused for safety.",
    }) as any;
    expect(() =>
      brain.proposeSourceClaim(owner, prose.source_id, {
        expected_version: 1,
        entity: "delta",
        field: { aspect: "status", value: "paused" },
        quote: "a passage that is not there",
      }),
    ).toThrow("exact passage");
    const selected = brain.proposeSourceClaim(owner, prose.source_id, {
      expected_version: 1,
      entity: "delta",
      field: { aspect: "status", value: "paused" },
      quote: "delta was paused",
    });
    brain.reviewGate(owner, selected.id, {
      action: "accept",
      expected_version: selected.version,
    });
    expect(brain.agentSearch(owner, "inbox", "delta").items).toMatchObject([
      { current: [{ data: { value: "paused" } }] },
    ]);
  } finally {
    store.close();
  }
});
