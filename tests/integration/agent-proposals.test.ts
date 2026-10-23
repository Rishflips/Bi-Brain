import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../../packages/storage/index.ts";
import { Brain } from "../../packages/domain/service.ts";
import type { Principal } from "../../packages/contracts/index.ts";

const owner: Principal = { kind: "owner" };
let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.reverse()) fn();
  cleanup = [];
});
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "agent-proposals-test-"));
  const s = new Storage(join(dir, "brain.sqlite"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  cleanup.push(() => {
    try {
      s.close();
    } catch {}
  });
  const b = new Brain(s, () => new Date("2026-10-23T09:00:00Z"));
  const g = b.createGrant(owner, {
    projects: ["inbox"],
    operations: ["read", "propose_memory"],
    expires_at: "2026-11-23T09:00:00.000Z",
    client: "codex",
  });
  return { b, agent: b.authenticateAgent(g.token) };
}
const exact = {
  project_id: "inbox",
  title: "Status",
  text: "northstar status active",
  type: "fact" as const,
  entity: "northstar",
  field: { aspect: "status" as const, value: "active" as const },
};

describe("agent proposals", () => {
  it("queues even an exact structured fact from an agent, until the owner keeps it", () => {
    const { b, agent } = setup();
    const r = b.propose(agent, exact);
    expect(r.disposition).toBe("queue");
    expect(r.claim_ids).toEqual([]);
    expect(b.currentClaims(owner, "inbox")).toEqual([]);
    const [card] = b.brief(owner).items;
    expect(card.title).toBe("northstar is active.");
    b.reviewGate(owner, card.target.id, { action: "accept", expected_version: card.target.version });
    expect(b.currentClaims(owner, "inbox")[0].data).toMatchObject({ value: "active", authority: "owner_reviewed" });
  });

  it("still lets the owner record an exact structured fact directly", () => {
    const { b } = setup();
    const r = b.propose(owner, exact);
    expect(r.disposition).toBe("commit");
    expect(b.currentClaims(owner, "inbox")).toHaveLength(1);
  });
});
