import { it, expect } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Storage } from "../../packages/storage/index.ts";
import { Brain } from "../../packages/domain/service.ts";
import { Worker } from "../../apps/worker/engine.ts";
import {
  runBoundTask,
  buildPack,
  validatePack,
} from "../../packages/domain/binding.ts";
const fixture = JSON.parse(
  readFileSync(
    join(fileURLToPath(new URL(".", import.meta.url)), "fixtures-v1.json"),
    "utf8",
  ),
);
const owner = { kind: "owner" } as const;
it("unprompted eligible loop prepares one reviewable next step in simulated 24h, while unrelated loop stays quiet", async () => {
  const s = new Storage(":memory:");
  try {
    const b = new Brain(s, () => new Date(fixture.clock));
    for (const text of fixture.passages)
      b.capture(owner, {
        title: "Saved conversation",
        body: text,
        project_id: fixture.project,
      });
    const positive = b.goal(owner, {
      project_id: fixture.project,
      ...fixture.goal,
    });
    const negative = b.goal(owner, {
      project_id: fixture.project,
      ...fixture.unrelated_goal,
    });
    for (const goal of [positive, negative])
      b.editGoal(owner, goal.id, {
        expected_version: 1,
        preparation_enabled: true,
      });
    b.prefs(owner, { ...b.prefs(owner), enabled: true });
    const worker = new Worker(b);
    for (let i = 0; i < 20 && (await worker.tick()); i++) {}
    expect(
      b
        .entities(owner, "proposal")
        .filter((p) => p.data.goal_id === positive.id),
    ).toHaveLength(1);
    expect(
      b
        .entities(owner, "proposal")
        .filter((p) => p.data.goal_id === negative.id),
    ).toHaveLength(0);
    worker.schedule();
    expect(b.entities(owner, "proposal")).toHaveLength(1);
  } finally {
    s.close();
  }
});
it("retired claim is withheld from default answers and packs, while contradiction remains queued", async () => {
  const s = new Storage(":memory:");
  try {
    const b = new Brain(s, () => new Date(fixture.clock));
    const input = (value: string) => ({
      project_id: fixture.project,
      title: "Beta status",
      text: `Beta status ${value}`,
      type: "fact" as const,
      entity: fixture.claim.entity,
      field: { aspect: "status" as const, value: value as "active" | "done" },
    });
    const accepted = b.propose(owner, input(fixture.claim.initial));
    expect(accepted.disposition).toBe("commit");
    const conflicting = b.propose(owner, input(fixture.claim.conflict));
    expect(conflicting.disposition).toBe("queue");
    expect(conflicting.reason_codes).toContain("overlapping_conflict");
    const claim = b.entity(owner, accepted.claim_ids[0]);
    b.retireClaim(owner, claim.id, claim.version);
    expect(b.currentClaims(owner, fixture.project)).toHaveLength(0);
    expect(b.currentClaims(owner, fixture.project, true)).toHaveLength(1);
    const answer = await runBoundTask(
      b,
      owner,
      fixture.project,
      "beta status",
      async (pack) => pack.pages,
    );
    expect(JSON.stringify(answer.result)).not.toContain("active");
  } finally {
    s.close();
  }
});
it("forget proof reads managed stores after deletion and quarantined secret never reaches shareable vault", () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-eval-"));
  const s = new Storage(join(dir, "brain.sqlite"), {
    vault: join(dir, "brain.vault"),
  });
  try {
    const b = new Brain(s, () => new Date(fixture.clock));
    const saved = b.capture(owner, {
      title: "Private key example",
      body: fixture.secret_fixture,
      project_id: fixture.project,
    }) as any;
    expect(saved.quarantined).toBe(true);
    expect(JSON.stringify(s.vault!.read())).not.toContain(
      "SYNTHETIC-EVAL-ONLY",
    );
    const result = b.removeSource(owner, saved.source_id, 1, true) as any;
    expect(result.proof).toMatchObject({
      file_gone: true,
      index_gone: true,
      embedding_gone: true,
      graph_edge_gone: true,
    });
    expect(s.vault!.git("log", "-p", "--all")).not.toContain(
      "SYNTHETIC-EVAL-ONLY",
    );
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
it("enforced local wrapper answers from delivered pack without retrieval and rejects revoked pre-action use", async () => {
  const s = new Storage(":memory:");
  try {
    const b = new Brain(s, () => new Date(fixture.clock));
    b.propose(owner, {
      project_id: fixture.project,
      title: "Beta status",
      text: "Beta status active",
      type: "fact",
      entity: "beta",
      field: { aspect: "status", value: "active" },
    });
    const grant = b.createGrant(owner, {
      projects: [fixture.project],
      operations: ["read"],
      expires_at: "2026-09-29T06:00:00Z",
    });
    const agent = b.authenticateAgent(grant.token);
    const result = await runBoundTask(
      b,
      agent,
      fixture.project,
      "What is beta status?",
      async (pack, preAction) => {
        preAction();
        return pack.pages
          .flatMap((page) => page.current)
          .find((claim) => claim.aspect === "status")?.value;
      },
    );
    expect(result.result).toBe("active");
    const pack = buildPack(b, agent, fixture.project, "beta status");
    b.revoke(owner, grant.id);
    expect(() => validatePack(b, agent, pack)).toThrow("revoked");
  } finally {
    s.close();
  }
});
