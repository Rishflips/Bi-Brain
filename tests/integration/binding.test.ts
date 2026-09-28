import { it, expect } from "vitest";
import { Storage } from "../../packages/storage/index.ts";
import { Brain } from "../../packages/domain/service.ts";
import {
  buildPack,
  validatePack,
  runBoundTask,
} from "../../packages/domain/binding.ts";
it("enforced wrapper uses pack-only current facts and pre-action validation fails after revocation", async () => {
  const s = new Storage(":memory:");
  try {
    let now = new Date("2026-09-28T10:00:00Z");
    const b = new Brain(s, () => now),
      owner = { kind: "owner" } as const;
    for (const [entity, value] of [
      ["alpha", "active"],
      ["beta", "paused"],
      ["gamma", "planned"],
      ["delta", "done"],
    ] as const)
      b.propose(owner, {
        project_id: "inbox",
        title: entity,
        text: `${entity} status ${value}`,
        type: "fact",
        entity,
        field: { aspect: "status", value },
      });
    const identity = b.propose(owner, {
      project_id: "inbox",
      title: "Identity",
      text: "Name is Mara",
      type: "identity",
      entity: "me",
      field: { aspect: "name", value: "Mara" },
    });
    const grant = b.createGrant(owner, {
      projects: ["inbox"],
      operations: ["read"],
      expires_at: "2026-09-29T10:00:00Z",
    });
    const agent = b.authenticateAgent(grant.token);
    const result = await runBoundTask(
      b,
      agent,
      "inbox",
      "What is alpha status?",
      async (pack, preAction) => {
        expect(pack.pages.length).toBe(1);
        expect(pack.who_i_am).toEqual([]);
        preAction();
        return pack.pages[0].current[0].value;
      },
    );
    expect(result.result).toBe("active");
    const pack = buildPack(b, agent, "inbox", "alpha");
    expect(pack.hash).toHaveLength(64);
    const handoff = b.handoff(owner, "inbox");
    const delivered = b.agentGet(agent, "inbox", handoff.id);
    expect(delivered.kind).toBe("handoff");
    expect(JSON.stringify(delivered)).toContain("alpha");
    expect(JSON.stringify(delivered)).not.toContain("Mara");
    const acceptedIdentity = b.reviewGate(owner, identity.proposal_id, {
      action: "accept",
      expected_version: 1,
    });
    const disclosure = b.identityDisclosure(
      owner,
      "inbox",
      acceptedIdentity.claim_ids,
    );
    expect(disclosure.selected).toEqual(acceptedIdentity.claim_ids);
    const disclosedPack = buildPack(b, agent, "inbox", "alpha");
    expect(disclosedPack.who_i_am).toContain("name: Mara");
    const disclosedHandoff = b.handoff(owner, "inbox");
    expect(
      JSON.stringify(b.agentGet(agent, "inbox", disclosedHandoff.id)),
    ).toContain("Mara");
    b.identityDisclosure(owner, "inbox", []);
    expect(() => validatePack(b, agent, disclosedPack)).toThrow("changed");
    expect(() => b.agentGet(agent, "inbox", disclosedHandoff.id)).toThrow(
      "unavailable",
    );
    b.revoke(owner, grant.id);
    expect(() => validatePack(b, agent, pack)).toThrow("revoked");
    now = new Date("2026-09-28T11:00:00Z");
    expect(() =>
      validatePack(b, owner, buildPack(b, owner, "inbox", "alpha")),
    ).not.toThrow();
  } finally {
    s.close();
  }
});
