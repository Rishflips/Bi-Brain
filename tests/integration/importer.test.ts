import { it, expect } from "vitest";
import { Storage } from "../../packages/storage/index.ts";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Brain } from "../../packages/domain/service.ts";
import { parseImport } from "../../packages/importers/local.ts";
import { discoverFolder } from "../../packages/importers/folder.ts";
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
