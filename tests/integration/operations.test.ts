import { it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Storage } from "../../packages/storage/index.ts";
import { Brain } from "../../packages/domain/service.ts";
import { Worker } from "../../apps/worker/engine.ts";
it("deleting accepted evidence purges copied plan text from current goal and goal history", async () => {
  const s = new Storage(":memory:");
  try {
    const b = new Brain(s);
    const owner = { kind: "owner" } as const;
    const a = b.capture(owner, {
      title: "Beta private",
      body: "Beta PRIVATE_PLAN_SENTINEL",
      visibility: "private",
    }) as any;
    b.capture(owner, {
      title: "Beta second",
      body: "Beta second supporting passage",
    });
    const g = b.goal(owner, {
      project_id: "inbox",
      title: "Beta",
      success_criteria: "Test beta",
    });
    b.editGoal(owner, g.id, { expected_version: 1, preparation_enabled: true });
    b.prepare(owner, g.id);
    const w = new Worker(b);
    while (await w.tick()) {}
    const p = b.entities(owner, "proposal")[0];
    b.review(owner, p.id, "accept", { expected_version: p.version });
    expect(b.entity(owner, g.id).data.plan).toContain("PRIVATE_PLAN_SENTINEL");
    const grant = b.createGrant(owner, {
      projects: ["inbox"],
      operations: ["read"],
      expires_at: new Date(Date.now() + 86400000).toISOString(),
    });
    expect(
      JSON.stringify(b.context(b.authenticateAgent(grant.token), "inbox")),
    ).not.toContain("PRIVATE_PLAN_SENTINEL");
    b.removeSource(owner, a.source_id, 1, true);
    expect(b.entity(owner, g.id).data.plan).toBe("");
    expect(
      JSON.stringify(s.all("SELECT data FROM entity_versions")),
    ).not.toContain("PRIVATE_PLAN_SENTINEL");
  } finally {
    s.close();
  }
});
it("backup and restore CLI apply available deletion tombstones and revoke restored access", () => {
  const id = randomUUID();
  const dir = resolve("data", `operations-${id}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "brain.sqlite");
  const s = new Storage(path);
  const b = new Brain(s);
  const owner = { kind: "owner" } as const;
  const source = b.capture(owner, {
    title: "Sensitive test",
    body: "RESTORE_DELETION_SENTINEL",
  }) as any;
  const grant = b.createGrant(owner, {
    projects: ["inbox"],
    operations: ["read"],
    expires_at: new Date(Date.now() + 86400000).toISOString(),
  });
  const name = `operations-${id}.sqlite`;
  let restoredDir: string | undefined;
  try {
    const env = { ...process.env, BRAIN_DB: path };
    execFileSync(
      process.execPath,
      ["--import", "tsx", "scripts/backup.ts", name],
      { cwd: process.cwd(), env, windowsHide: true },
    );
    b.removeSource(owner, source.source_id, 1, true);
    const before = new Set(readdirSync(resolve("data")));
    execFileSync(
      process.execPath,
      ["--import", "tsx", "scripts/restore.ts", name],
      { cwd: process.cwd(), env, windowsHide: true },
    );
    restoredDir = readdirSync(resolve("data")).find(
      (name) => name.startsWith("restored-") && !before.has(name),
    );
    expect(restoredDir).toBeTruthy();
    const restored = new Storage(join("data", restoredDir!, "brain.sqlite"));
    try {
      const next = new Brain(restored);
      expect(() => next.source(owner, source.source_id)).toThrow("unavailable");
      expect(() => next.authenticateAgent(grant.token)).toThrow("revoked");
      expect(restored.all("SELECT * FROM sessions")).toEqual([]);
      expect(
        readFileSync(join("data", restoredDir!, "RESTORE_NOTICE.txt"), "utf8"),
      ).toContain("Applied 1");
    } finally {
      restored.close();
    }
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
    if (restoredDir)
      rmSync(join("data", restoredDir), { recursive: true, force: true });
    rmSync(join("data/backups", name), { force: true });
    rmSync(join("data/backups", name + ".json"), { force: true });
  }
});
it("reviewed corrections survive new unrelated capture and unchanged relevant evidence stays quiet", async () => {
  const s = new Storage(":memory:");
  try {
    const b = new Brain(s);
    const owner = { kind: "owner" } as const;
    const w = new Worker(b);
    b.capture(owner, {
      title: "Beta original",
      body: "Beta launch needs careful onboarding.",
    });
    b.capture(owner, {
      title: "Beta interview",
      body: "Beta onboarding interview wants a trial first.",
    });
    while (await w.tick()) {}
    let brief = b.entities(owner, "brief")[0];
    b.editBrief(owner, brief.id, {
      expected_version: brief.version,
      items: [
        {
          text: "My reviewed correction",
          epistemic_status: "user_assertion",
          evidence: brief.data.items[0].evidence,
        },
      ],
      unknowns: [],
    });
    const goal = b.goal(owner, {
      project_id: "inbox",
      title: "Beta onboarding",
      success_criteria: "Test beta",
    });
    b.editGoal(owner, goal.id, {
      expected_version: 1,
      preparation_enabled: true,
    });
    b.prepare(owner, goal.id);
    while (await w.tick()) {}
    expect(b.entities(owner, "proposal")).toHaveLength(1);
    b.capture(owner, {
      title: "Unrelated gardening",
      body: "The garden needs watering.",
    });
    while (await w.tick()) {}
    brief = b.entities(owner, "brief")[0];
    expect(brief.data.items[0].text).toBe("My reviewed correction");
    b.prepare(owner, goal.id);
    while (await w.tick()) {}
    expect(b.entities(owner, "proposal")).toHaveLength(1);
  } finally {
    s.close();
  }
});
