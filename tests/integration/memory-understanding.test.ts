import { expect, it } from "vitest";
import { Brain } from "../../packages/domain/service.ts";
import {
  extractReviewableMemory,
  type ReviewableMemory,
} from "../../packages/domain/memory-understanding.ts";
import { Storage } from "../../packages/storage/index.ts";

const owner = { kind: "owner" } as const;
const clock = () => new Date("2026-10-19T08:00:00Z");

function save(brain: Brain, body: string) {
  const result = brain.capture(owner, {
    project_id: "inbox",
    title: "Working note",
    body,
    visibility: "project",
  });
  return brain
    .entities(owner, "gate")
    .find((gate) => gate.data.raw_id === result.source_id);
}

it("extracts one bounded ordinary-language memory with exact Unicode evidence", () => {
  const body = "Notes from today.\nThe launch date is 12 नवंबर 2026.";
  expect(extractReviewableMemory(body)).toEqual<ReviewableMemory>({
    type: "fact",
    entity: "launch date",
    field: { aspect: "statement", value: "12 नवंबर 2026" },
    quote: "The launch date is 12 नवंबर 2026.",
    start: 18,
    end: 51,
    reason: "ordinary_language_needs_owner_review",
    classifier_version: "ordinary-language-memory-v1",
  });
});

it("recognizes a plainly stated decision but never silently applies it", () => {
  const store = new Storage(":memory:");
  try {
    const brain = new Brain(store, clock);
    const gate = save(brain, "We decided that beta pricing is paid.");
    expect(gate?.data).toMatchObject({
      type: "decision",
      entity: "beta pricing",
      field: { aspect: "statement", value: "paid" },
      status: "queued",
      reasons: ["ordinary_language_needs_owner_review"],
      evidence: [{ quote: "We decided that beta pricing is paid." }],
    });
    expect(brain.currentClaims(owner, "inbox")).toHaveLength(0);

    brain.reviewGate(owner, gate!.id, {
      action: "accept",
      expected_version: gate!.version,
    });
    const grant = brain.createGrant(owner, {
      projects: ["inbox"],
      operations: ["read"],
      expires_at: "2026-10-20T08:00:00Z",
    });
    const agent = brain.authenticateAgent(grant.token);
    expect(
      brain.currentClaims(agent, "inbox").map((c) => c.data.value),
    ).toEqual(["paid"]);
  } finally {
    store.close();
  }
});

it("turns a changed natural sentence into a cited, undo-safe correction", () => {
  const store = new Storage(":memory:");
  try {
    const brain = new Brain(store, clock);
    const first = save(brain, "The beta pricing is free.")!;
    brain.reviewGate(owner, first.id, {
      action: "accept",
      expected_version: first.version,
    });
    const next = save(brain, "We decided that beta pricing is paid.")!;
    expect(next.data).toMatchObject({
      correction: true,
      conflicts: [{ value: "free" }],
      evidence: [{ quote: "We decided that beta pricing is paid." }],
    });
    brain.reviewGate(owner, next.id, {
      action: "accept",
      expected_version: next.version,
    });
    expect(
      brain.currentClaims(owner, "inbox").map((claim) => claim.data.value),
    ).toEqual(["paid"]);
    brain.reviewGate(owner, next.id, {
      action: "undo",
      expected_version: 2,
    });
    expect(
      brain.currentClaims(owner, "inbox").map((claim) => claim.data.value),
    ).toEqual(["free"]);
  } finally {
    store.close();
  }
});

it("stays quiet for questions, conditionals, vague pronouns and multi-claim text", () => {
  expect(extractReviewableMemory("Is the launch date Friday?")).toBeNull();
  expect(extractReviewableMemory("If the launch date is Friday, call Sam.")).toBeNull();
  expect(extractReviewableMemory("It is ready.")).toBeNull();
  expect(
    extractReviewableMemory(
      "According to my note, the launch is paused this week.",
    ),
  ).toBeNull();
  expect(
    extractReviewableMemory(
      "According to my note the launch is paused this week.",
    ),
  ).toBeNull();
  expect(
    extractReviewableMemory(
      "The launch date is Friday. The launch location is Chennai.",
    ),
  ).toBeNull();
});

it("keeps only the owner-taught meaning pending for the same exact passage", () => {
  const store = new Storage(":memory:");
  try {
    const brain = new Brain(store, clock);
    const body = "The launch scope is small.";
    const saved = brain.capture(owner, {
      project_id: "inbox",
      title: "Scope",
      body,
      visibility: "project",
    });
    const automatic = brain
      .entities(owner, "gate")
      .find((gate) => gate.data.status === "queued")!;
    const taught = brain.proposeSourceClaim(
      owner,
      saved.source_id as string,
      {
        expected_version: 1,
        type: "decision",
        entity: "release scope",
        field: { aspect: "statement", value: "small" },
        quote: body,
      },
    );
    expect(taught.data.status).toBe("queued");
    expect(brain.entity(owner, automatic.id).data).toMatchObject({
      status: "rejected",
      resolution: "replaced_by_owner_taught_meaning",
    });
    expect(
      brain
        .entities(owner, "gate")
        .filter((gate) => gate.data.status === "queued"),
    ).toHaveLength(1);
  } finally {
    store.close();
  }
});

it("lets the owner teach a meaning from any exact passage and keeps it pending", () => {
  const store = new Storage(":memory:");
  try {
    const brain = new Brain(store, clock);
    const saved = brain.capture(owner, {
      project_id: "inbox",
      title: "Call note",
      body: "After discussion, the team leaned toward the smaller launch.",
      visibility: "project",
    });
    const gate = brain.proposeSourceClaim(owner, saved.source_id as string, {
      expected_version: 1,
      type: "decision",
      entity: "launch scope",
      field: { aspect: "statement", value: "smaller launch" },
      quote: "the team leaned toward the smaller launch",
    });
    expect(gate.data).toMatchObject({
      type: "decision",
      status: "queued",
      reasons: ["owner_taught_meaning_needs_review"],
      field: { aspect: "statement", value: "smaller launch" },
    });
    expect(brain.currentClaims(owner, "inbox")).toHaveLength(0);
  } finally {
    store.close();
  }
});
