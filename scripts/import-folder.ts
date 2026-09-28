import { resolve } from "node:path";
import { Brain } from "../packages/domain/service.ts";
import { Storage } from "../packages/storage/index.ts";
import { discoverFolder } from "../packages/importers/folder.ts";
const [folder, project, flag] = process.argv.slice(2);
if (!folder || !project || (flag && flag !== "--apply"))
  throw new Error(
    "Usage: npm run import:folder -- <folder> <project-id> [--apply]",
  );
const found = discoverFolder(resolve(folder));
const store = new Storage();
try {
  const brain = new Brain(store);
  const selection = {
    kind: "folder" as const,
    project_id: project,
    entries: found.entries,
  };
  const preview = brain.previewLocalImport({ kind: "owner" }, selection);
  console.log(
    JSON.stringify(
      {
        ready: preview.items.map((item) => item.path),
        warnings: [...found.warnings, ...preview.warnings],
        applied: flag === "--apply",
      },
      null,
      2,
    ),
  );
  if (flag === "--apply") {
    const result = brain.applyLocalImport(
      { kind: "owner" },
      selection,
      preview.checkpoint,
    );
    console.log(
      JSON.stringify({
        imported: result.imported,
        duplicates: result.duplicates,
      }),
    );
  }
} finally {
  store.close();
}
