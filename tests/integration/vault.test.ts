import { it, expect } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  existsSync,
  readdirSync,
  rmSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Storage } from "../../packages/storage/index.ts";
import { Brain } from "../../packages/domain/service.ts";
import { Vault } from "../../packages/storage/vault.ts";
import { Worker } from "../../apps/worker/engine.ts";
import { purgeRetainedDeletedSource } from "../../packages/storage/restore-policy.ts";
it("vault capture, rebuild, crash recovery, quarantine and managed-history forget", async () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-vault-"));
  const path = join(dir, "brain.sqlite"),
    root = join(dir, "vault");
  const owner = { kind: "owner" } as const;
  let open: Storage | undefined;
  try {
    let s = new Storage(path, { vault: root });
    open = s;
    let b = new Brain(s);
    const source = b.capture(owner, {
      title: "Launch",
      body: "VAULT_PURGE_SENTINEL launch is Tuesday",
    }) as any;
    const before = s.vault!.read();
    expect(before.sources.some((v) => v.id === source.source_id)).toBe(true);
    expect(
      readFileSync(
        join(
          root,
          "generations",
          JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"))
            .generation,
          "raw",
          `${source.source_id}-v1.txt`,
        ),
        "utf8",
      ),
    ).toContain("VAULT_PURGE_SENTINEL");
    const secret = b.capture(owner, {
      title: "Credential",
      body: "-----BEGIN PRIVATE KEY-----\nSYNTHETIC-TEST-ONLY\n-----END PRIVATE KEY-----",
    }) as any;
    expect(secret.quarantined).toBe(true);
    expect(JSON.stringify(s.vault!.read())).not.toContain(
      "SYNTHETIC-TEST-ONLY",
    );
    expect(
      readdirSync(join(root + "-protected", "raw", "quarantine")).some((name) =>
        name.startsWith(secret.source_id),
      ),
    ).toBe(true);
    s.run("DELETE FROM source_fts");
    s.rebuild();
    expect(b.sources(owner, "inbox", "VAULT_PURGE_SENTINEL")).toHaveLength(1);
    s.close();
    open = undefined;
    const tampered = new DatabaseSync(path);
    tampered
      .prepare(
        "UPDATE source_versions SET body=? WHERE source_id=? AND version=1",
      )
      .run("TAMPERED_QUERY_PROJECTION", source.source_id);
    tampered.close();
    s = new Storage(path, { vault: root });
    open = s;
    b = new Brain(s);
    expect(b.source(owner, source.source_id).body).toContain(
      "VAULT_PURGE_SENTINEL",
    );
    expect(b.source(owner, source.source_id).body).not.toContain(
      "TAMPERED_QUERY_PROJECTION",
    );
    const worker = new Worker(b);
    while (await worker.tick()) {}
    const brief = b.entities(owner, "brief")[0];
    b.editBrief(owner, brief.id, {
      expected_version: brief.version,
      items: [
        {
          text: "My reviewed understanding",
          epistemic_status: "user_assertion",
          evidence: brief.data.items[0].evidence,
        },
      ],
      unknowns: [],
    });
    b.editSource(owner, source.source_id, {
      expected_version: 1,
      title: "Launch",
      body: "VAULT_PURGE_SENTINEL launch is Friday",
    });
    while (await worker.tick()) {}
    const forgotten = b.removeSource(owner, source.source_id, 2, true) as any;
    expect(forgotten.proof).toMatchObject({
      file_gone: true,
      index_gone: true,
      embedding_gone: true,
      graph_edge_gone: true,
    });
    expect(b.forgetProof(owner, forgotten.proof.operation_id)).toEqual(
      forgotten.proof,
    );
    expect(forgotten.proof.per_store.migration_backup.absent).toBe(true);
    expect(JSON.stringify(s.vault!.read())).not.toContain(
      "VAULT_PURGE_SENTINEL",
    );
    expect(s.vault!.git("log", "-p", "--all")).not.toContain(
      "VAULT_PURGE_SENTINEL",
    );
    expect(
      existsSync(
        join(root + "-protected", "raw", `${source.source_id}-v1.txt`),
      ),
    ).toBe(false);
    s.close();
    open = undefined;
    const staged = new Vault(join(dir, "crash-vault"), (step) => {
      if (step === "files_written") throw new Error("injected crash");
    });
    const j = staged.stage({
      projects: [],
      sources: [],
      source_versions: [],
      entities: [],
      entity_versions: [],
    });
    expect(() => staged.publish(j)).toThrow("injected crash");
    new Vault(staged.root).recover();
    expect(new Vault(staged.root).read().projects).toEqual([]);
  } finally {
    try {
      open?.close();
    } catch {}
    rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
});
it("restore barrier sanitizes a backup whose tombstone still retains raw versions", () => {
  const store = new Storage(":memory:");
  try {
    const brain = new Brain(store);
    const result = brain.capture(
      { kind: "owner" },
      { title: "Old", body: "RESTORE_ERASURE_SENTINEL", project_id: "inbox" },
    ) as any;
    brain.createEntity("inbox", "brief", {
      title: "Old",
      status: "current",
      evidence: [
        {
          source_id: result.source_id,
          source_version: 1,
          start: 0,
          end: 8,
          quote: "RESTORE_",
        },
      ],
    });
    store.run(
      "UPDATE sources SET state='deleted' WHERE id=?",
      result.source_id,
    );
    purgeRetainedDeletedSource(store, result.source_id);
    expect(
      store.get("SELECT state FROM sources WHERE id=?", result.source_id)
        ?.state,
    ).toBe("deleted");
    expect(
      store.all(
        "SELECT * FROM source_versions WHERE source_id=?",
        result.source_id,
      ),
    ).toEqual([]);
    expect(
      store.all("SELECT * FROM source_fts WHERE source_id=?", result.source_id),
    ).toEqual([]);
    expect(store.all("SELECT * FROM entities")).toEqual([]);
  } finally {
    store.close();
  }
});
it("revoking an identity field removes managed handoff revisions without deleting the owner's original", () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-disclosure-"));
  const store = new Storage(join(dir, "brain.sqlite"), {
    vault: join(dir, "brain.vault"),
  });
  const owner = { kind: "owner" } as const;
  try {
    const brain = new Brain(store);
    const proposed = brain.propose(owner, {
      project_id: "inbox",
      title: "Identity",
      text: "My name is Mara",
      type: "identity",
      entity: "me",
      field: { aspect: "name", value: "Mara" },
    });
    const reviewed = brain.reviewGate(owner, proposed.proposal_id, {
      action: "accept",
      expected_version: 1,
    });
    brain.identityDisclosure(owner, "inbox", reviewed.claim_ids);
    brain.handoff(owner, "inbox");
    expect(
      store
        .vault!.read()
        .entities.some(
          (entity) => entity.kind === "handoff" && entity.data.includes("Mara"),
        ),
    ).toBe(true);
    brain.identityDisclosure(owner, "inbox", []);
    expect(
      store
        .vault!.read()
        .entities.some(
          (entity) => entity.kind === "handoff" && entity.data.includes("Mara"),
        ),
    ).toBe(false);
    expect(readdirSync(join(store.vault!.root, "generations"))).toHaveLength(1);
    expect(brain.source(owner, proposed.raw_id).body).toContain("Mara");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
it.each(["staged", "files_written", "manifest_published"])(
  "capture journal recovers or rolls back after %s interruption",
  (step) => {
    const dir = mkdtempSync(join(tmpdir(), "brain-crash-matrix-"));
    const path = join(dir, "brain.sqlite"),
      root = join(dir, "brain.vault");
    const owner = { kind: "owner" } as const;
    let store: Storage | undefined;
    try {
      store = new Storage(path, { vault: root });
      store.vault = new Vault(root, (at) => {
        if (at === step) throw new Error(`crash:${step}`);
      });
      expect(() =>
        new Brain(store!).capture(
          owner,
          { project_id: "inbox", title: "Crash", body: `CRASH_${step}` },
          `key-${step}`,
        ),
      ).toThrow(`crash:${step}`);
      store.close();
      store = new Storage(path, { vault: root });
      const brain = new Brain(store);
      const sources = brain.sources(owner, "inbox", `CRASH_${step}`);
      expect(sources).toHaveLength(step === "staged" ? 0 : 1);
      expect(
        store
          .vault!.read()
          .sources.filter((source) => source.id === sources[0]?.id),
      ).toHaveLength(sources.length);
      if (sources.length) {
        const retry = brain.capture(
          owner,
          { project_id: "inbox", title: "Crash", body: `CRASH_${step}` },
          `key-${step}`,
        ) as any;
        expect(retry.source_id).toBe(sources[0].id);
      }
    } finally {
      store?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
it("representative synthetic credentials remain outside tracked vault and query previews", () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-secret-fixtures-"));
  const store = new Storage(join(dir, "brain.sqlite"), {
    vault: join(dir, "brain.vault"),
  });
  try {
    const brain = new Brain(store);
    const fixtures = [
      "sk-proj-" + "A".repeat(24),
      "ghp_" + "B".repeat(24),
      "AKIA" + "C".repeat(16),
      "password=" + "D".repeat(24),
    ];
    for (const [index, body] of fixtures.entries()) {
      const result = brain.capture(
        { kind: "owner" },
        { title: `Synthetic credential ${index}`, body, project_id: "inbox" },
      ) as any;
      expect(result.quarantined).toBe(true);
      expect(
        brain.source({ kind: "owner" }, result.source_id).body,
      ).not.toContain(body);
    }
    const tracked =
      store.vault!.git("log", "-p", "--all") +
      JSON.stringify(store.vault!.read());
    for (const body of fixtures) expect(tracked).not.toContain(body);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
it("an interrupted history purge can be finalized after the source is already tombstoned", () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-forget-retry-"));
  const store = new Storage(join(dir, "brain.sqlite"), {
    vault: join(dir, "brain.vault"),
  });
  const owner = { kind: "owner" } as const;
  try {
    const brain = new Brain(store);
    const saved = brain.capture(owner, {
      title: "Retry",
      body: "ERASURE_RETRY_SENTINEL",
      project_id: "inbox",
    }) as any;
    const vault = store.vault!;
    const original = vault.forget;
    vault.forget = () => {
      throw new Error("injected erasure interruption");
    };
    expect(() => brain.removeSource(owner, saved.source_id, 1, true)).toThrow(
      "managed erasure needs retry",
    );
    expect(
      store.get("SELECT state FROM sources WHERE id=?", saved.source_id)?.state,
    ).toBe("deleted");
    vault.forget = original;
    const proof = brain.finalizeForget(owner, saved.source_id);
    expect(proof.file_gone && proof.index_gone).toBe(true);
    expect(vault.git("log", "-p", "--all")).not.toContain(
      "ERASURE_RETRY_SENTINEL",
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
it("startup resumes a sanitation interrupted after the deletion transaction", () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-sanitize-recover-"));
  const path = join(dir, "brain.sqlite"),
    root = join(dir, "brain.vault");
  const owner = { kind: "owner" } as const;
  let store: Storage | undefined;
  try {
    store = new Storage(path, { vault: root });
    const brain = new Brain(store);
    const saved = brain.capture(owner, {
      title: "Crash",
      body: "SANITIZE_RECOVERY_SENTINEL",
      project_id: "inbox",
    }) as any;
    let sanitizing = false;
    const vault = new Vault(root, (step) => {
      if (sanitizing && step === "files_written")
        throw new Error("interrupted sanitation");
    });
    const originalForget = vault.forget;
    vault.forget = (id, state) => {
      sanitizing = true;
      return originalForget.call(vault, id, state);
    };
    store.vault = vault;
    expect(() => brain.removeSource(owner, saved.source_id, 1, true)).toThrow(
      "managed erasure needs retry",
    );
    store.close();
    store = new Storage(path, { vault: root });
    expect(store.vault!.verifyForget(saved.source_id).file_gone).toBe(true);
    expect(existsSync(join(root + "-protected", "sanitize.pending"))).toBe(
      false,
    );
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
it("managed Git revert of the latest accepted plan preserves an earlier owner edit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-git-revert-"));
  const store = new Storage(join(dir, "brain.sqlite"), {
    vault: join(dir, "brain.vault"),
  });
  const owner = { kind: "owner" } as const;
  const brain = new Brain(store);
  async function accept(project: string, title: string) {
    brain.capture(owner, {
      title: "Evidence",
      body: `${title} needs an initial test.`,
      project_id: project,
    });
    brain.capture(owner, {
      title: "Evidence",
      body: `${title} should record blockers.`,
      project_id: project,
    });
    const worker = new Worker(brain);
    while (await worker.tick()) {}
    const goal = brain.goal(owner, {
      project_id: project,
      title,
      success_criteria: "Choose a test",
    });
    brain.editGoal(owner, goal.id, {
      expected_version: 1,
      preparation_enabled: true,
    });
    brain.prepare(owner, goal.id);
    while (await worker.tick()) {}
    const proposal = brain
      .entities(owner, "proposal")
      .find((item) => item.data.goal_id === goal.id)!;
    const result = brain.review(owner, proposal.id, "accept", {
      expected_version: proposal.version,
    }) as any;
    return { goal, receipt: result.receipt };
  }
  try {
    const first = await accept("inbox", "First pilot");
    const current = brain.entity(owner, first.goal.id);
    brain.editGoal(owner, first.goal.id, {
      expected_version: current.version,
      plan: "Later owner edit remains.",
    });
    const project = brain.createProject(owner, "Second");
    const second = await accept(project.id, "Second pilot");
    const result = brain.revertAcceptedVaultCommit(owner, second.receipt.id);
    expect(result.reverted).toBe(true);
    expect(brain.entity(owner, first.goal.id).data.plan).toBe(
      "Later owner edit remains.",
    );
    expect(brain.entity(owner, second.goal.id).data.plan).toBe("");
    expect(() =>
      brain.revertAcceptedVaultCommit(owner, first.receipt.id),
    ).toThrow("changed");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 20000);
it("migrates existing SQLite IDs with protected backup and verified rollback copy", () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-migrate-"));
  const path = join(dir, "brain.sqlite"),
    root = join(dir, "vault");
  try {
    let s = new Storage(path);
    const id = (
      new Brain(s).capture(
        { kind: "owner" },
        { title: "Legacy", body: "Original legacy value" },
      ) as any
    ).source_id;
    s.close();
    s = new Storage(path, { vault: root });
    expect(s.vault!.read().sources.some((row) => row.id === id)).toBe(true);
    const backup = join(root + "-protected", "pre-vault.sqlite");
    expect(existsSync(backup)).toBe(true);
    s.close();
    const rollback = join(dir, "rollback.sqlite");
    copyFileSync(backup, rollback);
    const restored = new Storage(rollback);
    expect(new Brain(restored).source({ kind: "owner" }, id).body).toBe(
      "Original legacy value",
    );
    restored.close();
  } finally {
    rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
});
it("replays a committed but unacknowledged vault journal after injected publish failure", () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-journal-"));
  const path = join(dir, "brain.sqlite"),
    root = join(dir, "vault");
  try {
    let s = new Storage(path, { vault: root });
    s.vault = new Vault(root, (step) => {
      if (step === "manifest_published")
        throw new Error("injected publish stop");
    });
    expect(() =>
      new Brain(s).capture(
        { kind: "owner" },
        { title: "Crash", body: "JOURNAL_RECOVERY_SENTINEL" },
      ),
    ).toThrow("injected publish stop");
    expect(s.all("SELECT id FROM sources WHERE origin='manual'")).toHaveLength(
      1,
    );
    s.close();
    s = new Storage(path, { vault: root });
    const recovered = s.vault!.read();
    expect(JSON.stringify(recovered)).toContain("JOURNAL_RECOVERY_SENTINEL");
    expect(existsSync(join(root + "-protected", "journal.json"))).toBe(false);
    expect(s.vault!.git("log", "-1", "--format=%s")).toContain(
      "Publish generation",
    );
    s.close();
  } finally {
    rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
});
