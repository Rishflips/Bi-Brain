import { expect, it } from "vitest";
import { Storage } from "../../packages/storage/index.ts";
import { Brain } from "../../packages/domain/service.ts";
import { buildPack, validatePack } from "../../packages/domain/binding.ts";

it("managed agent context packs keep the bound account and fail after revocation", () => {
  const store = new Storage(":memory:");
  const otherStore = new Storage(":memory:");
  const clock = () => new Date("2026-10-16T10:00:00Z");
  const brain = new Brain(store, clock, "11111111-1111-4111-8111-111111111111");
  const other = new Brain(otherStore, clock, "22222222-2222-4222-8222-222222222222");
  try {
    const owner = brain.ownerPrincipal();
    brain.propose(owner, {
      project_id: "inbox", title: "Alpha", text: "alpha status active", type: "fact",
      entity: "alpha", field: { aspect: "status", value: "active" },
    });
    const grant = brain.createGrant(owner, {
      projects: ["inbox"], operations: ["read"], expires_at: "2026-10-17T10:00:00Z",
    });
    const agent = brain.authenticateAgent(grant.token);
    const pack = buildPack(brain, agent, "inbox", "alpha status");
    expect(pack.pages[0].current[0].value).toBe("active");
    expect(validatePack(brain, agent, pack)).toBe(true);
    expect(() => validatePack(other, agent, pack)).toThrow();
    brain.revoke(owner, grant.id);
    expect(() => validatePack(brain, agent, pack)).toThrow();
  } finally {
    store.close();
    otherStore.close();
  }
});

it("managed agent packs disclose only explicitly approved identity and reject cross-account or changed identity", () => {
  const store = new Storage(":memory:");
  const otherStore = new Storage(":memory:");
  const clock = () => new Date("2026-10-16T10:00:00Z");
  const brain = new Brain(store, clock, "11111111-1111-4111-8111-111111111111");
  const other = new Brain(
    otherStore,
    clock,
    "22222222-2222-4222-8222-222222222222",
  );
  try {
    const owner = brain.ownerPrincipal();
    brain.propose(owner, {
      project_id: "inbox", title: "Alpha", text: "alpha status active", type: "fact",
      entity: "alpha", field: { aspect: "status", value: "active" },
    });
    const identity = brain.propose(owner, {
      project_id: "inbox", title: "Identity", text: "Name is Mara", type: "identity",
      entity: "me", field: { aspect: "name", value: "Mara" },
    });
    const grant = brain.createGrant(owner, {
      projects: ["inbox"], operations: ["read"], expires_at: "2026-10-17T10:00:00Z",
    });
    const agent = brain.authenticateAgent(grant.token);
    // Before any owner approval the bound agent must not see identity.
    const privatePack = buildPack(brain, agent, "inbox", "alpha");
    expect(privatePack.who_i_am).toEqual([]);
    expect(validatePack(brain, agent, privatePack)).toBe(true);
    // Explicit owner approval is required before the identity is disclosed.
    const accepted = brain.reviewGate(owner, identity.proposal_id, {
      action: "accept",
      expected_version: 1,
    });
    const disclosure = brain.identityDisclosure(
      owner,
      "inbox",
      accepted.claim_ids,
    );
    expect(disclosure.selected).toEqual(accepted.claim_ids);
    const disclosedPack = buildPack(brain, agent, "inbox", "alpha");
    expect(disclosedPack.who_i_am).toContain("name: Mara");
    expect(validatePack(brain, agent, disclosedPack)).toBe(true);
    // A different managed account cannot validate this tenant's pack.
    expect(() => validatePack(other, agent, disclosedPack)).toThrow(
      "cannot access that brain",
    );
    // Withdrawing the disclosure invalidates the previously issued pack.
    brain.identityDisclosure(owner, "inbox", []);
    expect(() => validatePack(brain, agent, disclosedPack)).toThrow("changed");
  } finally {
    store.close();
    otherStore.close();
  }
});
