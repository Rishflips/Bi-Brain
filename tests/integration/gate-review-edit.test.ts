import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../../packages/storage/index.ts";
import { Brain } from "../../packages/domain/service.ts";
import type { Principal } from "../../packages/contracts/index.ts";

const owner: Principal = { kind: "owner" };
let cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.reverse()) fn(); cleanup = []; });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "gate-edit-"));
  const s = new Storage(join(dir, "brain.sqlite"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  cleanup.push(() => { try { s.close(); } catch {} });
  const b = new Brain(s, () => new Date("2026-10-23T09:00:00Z"));
  b.capture(owner, { title: "Decision", body: "We decided that Northstar beta is invite only." });
  const [item] = b.brief(owner).items;
  return { b, gateId: item.target.id, version: item.target.version };
}
const current = (b: Brain) => b.currentClaims(owner, "inbox");

describe("gate review", () => {
  it("keeps the owner's wording and records that it was edited", () => {
    const { b, gateId, version } = setup();
    const r = b.reviewGate(owner, gateId, { action: "accept", expected_version: version, value: "invite only until November" }) as any;
    expect(r.gate_version).toBe(version + 1);
    const [claim] = current(b);
    expect(claim.data.value).toBe("invite only until November");
    expect(claim.data.edited_by_owner).toBe(true);
    expect(claim.data.evidence[0].quote).toContain("invite only");
  });

  it("refuses a second accept of the same item", () => {
    const { b, gateId, version } = setup();
    b.reviewGate(owner, gateId, { action: "accept", expected_version: version });
    expect(() => b.reviewGate(owner, gateId, { action: "accept", expected_version: version })).toThrow(/changed|reviewed/i);
    expect(current(b)).toHaveLength(1);
  });

  it("undoes a plain kept memory", () => {
    const { b, gateId, version } = setup();
    const r = b.reviewGate(owner, gateId, { action: "accept", expected_version: version }) as any;
    b.reviewGate(owner, gateId, { action: "undo", expected_version: r.gate_version });
    expect(current(b)).toEqual([]);
  });

  it("will not undo after the kept fact changed", () => {
    const { b, gateId, version } = setup();
    const r = b.reviewGate(owner, gateId, { action: "accept", expected_version: version }) as any;
    const [claim] = current(b);
    b.retireClaim(owner, claim.id, claim.version);
    expect(() => b.reviewGate(owner, gateId, { action: "undo", expected_version: r.gate_version })).toThrow(/changed/i);
  });

  it("refuses to keep a memory whose original was withdrawn", () => {
    const { b, gateId, version } = setup();
    const [source] = b.sources(owner, "inbox");
    b.removeSource(owner, source.id, source.version, false);
    expect(() => b.reviewGate(owner, gateId, { action: "accept", expected_version: version })).toThrow(/no longer active/i);
    expect(current(b)).toEqual([]);
  });

  it("rejects an edited value for a status memory", () => {
    const { b } = setup();
    const gate = b.propose(owner, {
      project_id: "inbox",
      title: "Orion",
      text: "We decided Orion is paused.",
      type: "decision",
      entity: "Orion",
      field: { aspect: "status", value: "paused" },
    });
    expect(gate.disposition).toBe("queue");
    expect(() =>
      b.reviewGate(owner, gate.proposal_id, { action: "accept", expected_version: 1, value: "anything" }),
    ).toThrow(/wording/i);
    expect(current(b).filter((c) => c.data.aspect === "status")).toEqual([]);
  });
});
