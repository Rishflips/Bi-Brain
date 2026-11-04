import { it, expect } from "vitest";
import { Storage } from "../../packages/storage/index.ts";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Brain } from "../../packages/domain/service.ts";
import { parseImport } from "../../packages/importers/local.ts";
import { discoverFolder } from "../../packages/importers/folder.ts";
import { isContextFile } from "../../packages/importers/context.ts";
import { createApp } from "../../apps/server/app.ts";
const owner = { kind: "owner" } as const;
it("folder and chat adapters preview, checkpoint, deduplicate and propagate deletion", () => {
  const s = new Storage(":memory:");
  try {
    const b = new Brain(s);
    const folder = {
      kind: "folder",
      project_id: "inbox",
      entries: [
        {
          path: "notes/meeting.md",
          content: "Meeting action: test import with real persistence.",
        },
        { path: "notes/image.png", content: "attachment" },
      ],
    };
    const preview = b.previewLocalImport(owner, folder);
    expect(preview.items).toHaveLength(1);
    expect(preview.warnings).toHaveLength(1);
    expect(() =>
      b.applyLocalImport(
        owner,
        {
          ...folder,
          entries: [{ path: "notes/meeting.md", content: "Changed" }],
        },
        preview.checkpoint,
      ),
    ).toThrow("changed");
    const first = b.applyLocalImport(owner, folder, preview.checkpoint);
    expect(first.imported).toBe(1);
    expect(
      b.applyLocalImport(owner, folder, preview.checkpoint).duplicates,
    ).toBe(1);
    const chat = {
      kind: "chat",
      project_id: "inbox",
      entries: [
        {
          path: "conversations.json",
          content: JSON.stringify([
            {
              title: "Planning",
              messages: [
                { role: "user", content: "What is next?" },
                { role: "assistant", content: "Test the pilot." },
              ],
            },
          ]),
        },
      ],
    };
    const imported = b.applyLocalImport(
      owner,
      chat,
      b.previewLocalImport(owner, chat).checkpoint,
    );
    expect(imported.imported).toBe(1);
    expect(b.source(owner, imported.results[0].source_id).body).toContain(
      "assistant: Test the pilot.",
    );
    b.removeSource(owner, first.results[0].source_id, 1, true);
    expect(
      b
        .sources(owner, "inbox")
        .some((source) => source.body.includes("Meeting action")),
    ).toBe(false);
  } finally {
    s.close();
  }
});
it("adapter rejects traversal and unknown chat structure without importing anything", () => {
  expect(() =>
    parseImport({
      kind: "folder",
      project_id: "inbox",
      entries: [{ path: "../escape.md", content: "bad" }],
    }),
  ).toThrow("within");
  expect(() =>
    parseImport({
      kind: "folder",
      project_id: "inbox",
      entries: [{ path: "C:\\secret.md", content: "bad" }],
    }),
  ).toThrow("within");
  expect(() =>
    parseImport({
      kind: "chat",
      project_id: "inbox",
      entries: [{ path: "chat.json", content: "{broken" }],
    }),
  ).toThrow("parsed");
  expect(() =>
    parseImport({
      kind: "chat",
      project_id: "inbox",
      entries: [{ path: "chat.json", content: "{}" }],
    }),
  ).toThrow("array");
});
it("local folder discovery reads nested text and reports unsupported attachments", () => {
  const dir = mkdtempSync(join(tmpdir(), "brain-folder-"));
  try {
    mkdirSync(join(dir, "notes"));
    writeFileSync(join(dir, "notes", "plan.md"), "Plan the pilot.");
    writeFileSync(join(dir, "image.png"), "not text");
    const found = discoverFolder(dir);
    expect(found.entries).toEqual([
      { path: "notes/plan.md", content: "Plan the pilot." },
    ]);
    expect(found.warnings).toContain(
      "image.png: unsupported attachment skipped",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("the context kind keeps only agent instruction files, on the page's rule and again on the server", () => {
  for (const ok of ["CLAUDE.md", "AGENTS.md", "docs/AGENTS.md", ".cursor/rules/style.mdc", ".cursorrules", ".github/copilot-instructions.md", "MEMORY.md", "CLAUDE.local.md", "GEMINI.md", ".windsurfrules"]) expect(isContextFile(ok), ok).toBe(true);
  for (const no of ["README.md", "node_modules/x/CLAUDE.md", ".git/AGENTS.md", "dist/CLAUDE.md", "src/index.ts", ".cursor/rules/notes.md", "claude.md.bak", "deep/a/b/c/d/e/AGENTS.md"]) expect(isContextFile(no), no).toBe(false);
  const s = new Storage(":memory:");
  try {
    const b = new Brain(s);
    const selection = {
      kind: "context",
      project_id: "inbox",
      entries: [
        { path: "CLAUDE.md", content: "# Northstar\nRun the tests before every commit." },
        { path: "README.md", content: "not an instruction file" },
        { path: ".cursor/rules/style.mdc", content: "---\nalwaysApply: true\n---\nUse two spaces." },
        { path: "AGENTS.md", content: "   " },
      ],
    };
    const preview = b.previewLocalImport(owner, selection);
    expect(preview.items.map((i) => i.title)).toEqual(["CLAUDE.md", ".cursor/rules/style.mdc"]);
    expect(preview.warnings).toEqual(["README.md: not an agent instruction file, skipped", "AGENTS.md: empty file skipped"]);
    const r = b.applyLocalImport(owner, selection, preview.checkpoint);
    expect(r.imported).toBe(2);
    const saved = b.sources(owner, "inbox");
    // Owner-imported, not "saved by you": a cloned repository's file was written by someone else.
    expect(saved.map((x) => [x.title, x.origin]).sort()).toEqual([[".cursor/rules/style.mdc", "import"], ["CLAUDE.md", "import"]]);
    expect(saved.find((x) => x.title === "CLAUDE.md")!.body).toBe("# Northstar\nRun the tests before every commit.");
    expect(b.writtenBy(saved[0])).toBeUndefined();
    expect(b.brainProject(owner, "inbox").originals.map((o) => o.from)).toEqual(["import", "import"]);
    // A plain folder import is unchanged.
    b.applyLocalImport(owner, { kind: "folder", project_id: "inbox", entries: [{ path: "notes/x.md", content: "plain folder note" }] }, b.previewLocalImport(owner, { kind: "folder", project_id: "inbox", entries: [{ path: "notes/x.md", content: "plain folder note" }] }).checkpoint);
    expect(b.sources(owner, "inbox").find((x) => x.title === "notes/x.md")!.origin).toBe("manual");
    expect(() => b.previewLocalImport(owner, { ...selection, entries: Array.from({ length: 51 }, (_, i) => ({ path: `p${i}/CLAUDE.md`, content: "x" })) })).toThrow();
  } finally {
    s.close();
  }
});

it("the context kind skips one oversize file with a warning and imports the rest; a plain folder import still refuses the batch", () => {
  const s = new Storage(":memory:");
  try {
    const b = new Brain(s);
    const big = "x".repeat(2 * 1048576);
    const long = "é".repeat(100_001);
    const selection = { kind: "context", project_id: "inbox", entries: [{ path: "AGENTS.md", content: big }, { path: "GEMINI.md", content: long }, { path: "CLAUDE.md", content: "small and kept" }] };
    const preview = b.previewLocalImport(owner, selection);
    expect(preview.items.map((i) => i.title)).toEqual(["CLAUDE.md"]);
    expect(preview.warnings).toEqual(["AGENTS.md: larger than 1 MiB, skipped", "GEMINI.md: longer than 100,000 characters, skipped"]);
    expect(b.applyLocalImport(owner, selection, preview.checkpoint).imported).toBe(1);
    expect(() => b.previewLocalImport(owner, { kind: "folder", project_id: "inbox", entries: [{ path: "a.md", content: big }] })).toThrow(/4 MiB batch limit|per-file/);
  } finally {
    s.close();
  }
});

it("an agent token cannot preview or apply a context import", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ctx-import-"));
  const s = new Storage(join(dir, "brain.sqlite"), { vault: join(dir, "vault") });
  try {
    const b = new Brain(s, () => new Date("2026-11-03T09:00:00Z"));
    const g = b.createGrant(owner, { projects: ["inbox"], operations: ["read", "propose_memory"], expires_at: "2026-12-03T09:00:00.000Z", client: "claude-code" });
    const app = await createApp(b, { pairSecret: "test-code", static: false });
    const selection = { kind: "context", project_id: "inbox", entries: [{ path: "CLAUDE.md", content: "agents must not import this" }] };
    const headers = { host: "127.0.0.1:4317", authorization: `Bearer ${g.token}` };
    expect((await app.inject({ method: "POST", url: "/api/v1/import-adapters/preview", headers, payload: selection })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/v1/import-adapters/apply", headers, payload: { checkpoint: "x", selection } })).statusCode).toBe(403);
    expect(b.sources(owner, "inbox")).toEqual([]);
    await app.close();
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("the context kind refuses a traversal or absolute path as that file's own outcome and imports the rest", () => {
  const s = new Storage(":memory:");
  try {
    const b = new Brain(s);
    const selection = {
      kind: "context",
      project_id: "inbox",
      entries: [
        { path: "../x/CLAUDE.md", content: "escapes" },
        { path: "/etc/AGENTS.md", content: "absolute" },
        { path: "C:\Users\me\CLAUDE.md", content: "drive" },
        { path: "CLAUDE.md", content: "kept" },
      ],
    };
    const preview = b.previewLocalImport(owner, selection);
    expect(preview.items.map((i) => i.title)).toEqual(["CLAUDE.md"]);
    expect(preview.warnings).toHaveLength(3);
    expect(b.applyLocalImport(owner, selection, preview.checkpoint).imported).toBe(1);
    // A plain folder import still refuses the whole batch for the same path.
    expect(() => b.previewLocalImport(owner, { kind: "folder", project_id: "inbox", entries: [{ path: "../a.md", content: "x" }] })).toThrow();
  } finally {
    s.close();
  }
});

it("a secret-looking context file is quarantined on apply, private, with its text kept out of the brain", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctx-import-"));
  const s = new Storage(join(dir, "brain.sqlite"), { vault: join(dir, "vault") });
  try {
    const b = new Brain(s);
    const selection = { kind: "context", project_id: "inbox", entries: [{ path: "CLAUDE.md", content: "Deploy with key: sk-proj-abcdefghijklmnopqrstuvwxyz123456" }, { path: "AGENTS.md", content: "Run the tests." }] };
    const r = b.applyLocalImport(owner, selection, b.previewLocalImport(owner, selection).checkpoint);
    expect(r.imported).toBe(2);
    const saved = b.sources(owner, "inbox");
    expect(JSON.stringify(saved)).not.toContain("sk-proj");
    const q = saved.find((x) => x.title === "Quarantined source")!;
    expect(q.visibility).toBe("private");
    expect(saved.find((x) => x.title === "AGENTS.md")!.body).toBe("Run the tests.");
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
