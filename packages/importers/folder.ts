import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { resolve, join, relative, isAbsolute } from "node:path";
import { BrainError } from "../domain/logic.ts";
export function discoverFolder(folder: string) {
  const root = resolve(folder);
  if (!lstatSync(root).isDirectory())
    throw new BrainError("INVALID_INPUT", "Choose a folder.");
  const entries: { path: string; content: string }[] = [];
  const warnings: string[] = [];
  let bytes = 0;
  function walk(dir: string, depth: number) {
    if (depth > 12)
      throw new BrainError(
        "INVALID_INPUT",
        "Folder nesting exceeds the import limit.",
      );
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const rel = relative(root, path);
      if (rel.startsWith("..") || isAbsolute(rel))
        throw new BrainError(
          "INVALID_INPUT",
          "Folder entry escapes the selected root.",
        );
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        warnings.push(`${rel}: symbolic link skipped`);
        continue;
      }
      if (stat.isDirectory()) {
        walk(path, depth + 1);
        continue;
      }
      if (!stat.isFile()) {
        warnings.push(`${rel}: special file skipped`);
        continue;
      }
      if (!/\.(txt|md)$/i.test(name)) {
        warnings.push(`${rel}: unsupported attachment skipped`);
        continue;
      }
      if (stat.size > 1048576) {
        warnings.push(`${rel}: exceeds 1 MiB`);
        continue;
      }
      bytes += stat.size;
      if (bytes > 4 * 1048576 || entries.length >= 50)
        throw new BrainError(
          "INVALID_INPUT",
          "Folder exceeds the 4 MiB or 50-file batch limit.",
          413,
        );
      entries.push({
        path: rel.replaceAll("\\", "/"),
        content: readFileSync(path, "utf8"),
      });
    }
  }
  walk(root, 0);
  return { entries, warnings };
}
