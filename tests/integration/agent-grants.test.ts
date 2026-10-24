import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Storage } from "../../packages/storage/index.ts";
import { Brain } from "../../packages/domain/service.ts";
import { agentDisplayName } from "../../packages/domain/agents.ts";
import type { Principal } from "../../packages/contracts/index.ts";

const owner: Principal = { kind: "owner" };
let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.reverse()) fn();
  cleanup = [];
});
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "agent-grants-test-"));
  const path = join(dir, "brain.sqlite");
  const s = new Storage(path);
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  cleanup.push(() => {
    try {
      s.close();
    } catch {}
  });
  return { s, b: new Brain(s, () => new Date("2026-10-23T09:00:00Z")), path };
}
const later = "2026-11-23T09:00:00.000Z";

describe("agent grants", () => {
  it("records the client and folder and lists them with a display name", () => {
    const { b } = setup();
    const id = randomUUID();
    const g = b.createGrant(owner, {
      id,
      projects: ["inbox"],
      operations: ["read", "propose_memory"],
      expires_at: later,
      client: "codex",
      folder: "C:\work\northstar",
    });
    expect(g.id).toBe(id);
    const [row] = b.connections(owner);
    expect(row).toMatchObject({ id, client: "codex", client_name: "Codex", folder: "C:\work\northstar", status: "Not connected" });
    const manual = b.createGrant(owner, { projects: ["inbox"], operations: ["read"], expires_at: later });
    expect(b.connections(owner).find((r: any) => r.id === manual.id)).toMatchObject({ client: "other", client_name: "A connected agent", folder: null });
  });

  it("names the agent on Today's card", () => {
    const { b } = setup();
    const g = b.createGrant(owner, { projects: ["inbox"], operations: ["read", "propose_memory"], expires_at: later, client: "claude-code" });
    const agent = b.authenticateAgent(g.token);
    b.propose(agent, {
      project_id: "inbox",
      title: "Pricing",
      text: "The pricing page ships with one plan.",
      type: "decision",
      entity: "pricing page",
      field: { aspect: "statement", value: "ships with one plan" },
    });
    const [card] = b.brief(owner).items;
    expect(card.why).toBe("Claude Code wrote this down while it worked.");
  });

  it("upgrades a database created before migration 6", () => {
    const { s, path } = setup();
    s.run("ALTER TABLE grants DROP COLUMN client");
    s.run("ALTER TABLE grants DROP COLUMN folder");
    s.run("DELETE FROM migrations WHERE version=6");
    s.close();
    const reopened = new Storage(path);
    cleanup.push(() => reopened.close());
    const cols = reopened.all("PRAGMA table_info(grants)").map((c: any) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["client", "folder"]));
    expect(reopened.get("SELECT max(version) AS v FROM migrations")?.v).toBe(6);
  });

  it("keeps unknown clients generic", () => {
    expect(agentDisplayName("codex")).toBe("Codex");
    expect(agentDisplayName("cursor")).toBe("Cursor");
    expect(agentDisplayName(null)).toBe("A connected agent");
    expect(agentDisplayName("__proto__")).toBe("A connected agent");
  });
});
