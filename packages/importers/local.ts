import { createHash } from "node:crypto";
import { z } from "zod";
import { BrainError } from "../domain/logic.ts";
import { CONTEXT_FILE_MAX_BYTES, CONTEXT_FILE_MAX_CHARS, isContextFile } from "./context.ts";
export const importInput = z
  .object({
    kind: z.enum(["folder", "chat", "context"]),
    project_id: z.string().min(1).max(100),
    entries: z
      .array(
        z
          .object({
            path: z.string().min(1).max(500),
            content: z.string().max(4 * 1048576),
          })
          .strict(),
      )
      .min(1)
      .max(50),
  })
  .strict();
export type ImportInput = z.infer<typeof importInput>;
export function safeImportPath(path: string) {
  const normalized = path.replaceAll("\\", "/");
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new BrainError(
      "INVALID_INPUT",
      "Import path must stay within the selected folder.",
    );
  return normalized;
}
export function parseImport(value: unknown) {
  const input = importInput.parse(value);
  let totalBytes = 0;
  const items: { title: string; body: string; path: string }[] = [];
  const warnings: string[] = [];
  const paths = new Set<string>();
  for (const entry of input.entries) {
    let path: string;
    try {
      path = safeImportPath(entry.path);
    } catch (e) {
      // A context file with a bad path is its own outcome; the rest of the batch still imports.
      if (input.kind !== "context") throw e;
      warnings.push(`${entry.path.slice(0, 80)}: path outside the chosen folder, skipped`);
      continue;
    }
    if (paths.has(path))
      throw new BrainError("INVALID_INPUT", "Duplicate import path.");
    paths.add(path);
    const size = Buffer.byteLength(entry.content, "utf8");
    if (input.kind === "context") {
      // Each instruction file gets its own outcome: one big file never stops the rest.
      if (!isContextFile(path)) {
        warnings.push(`${path}: not an agent instruction file, skipped`);
        continue;
      }
      if (size > CONTEXT_FILE_MAX_BYTES) {
        warnings.push(`${path}: larger than 1 MiB, skipped`);
        continue;
      }
      if (Array.from(entry.content).length > CONTEXT_FILE_MAX_CHARS) {
        warnings.push(`${path}: longer than 100,000 characters, skipped`);
        continue;
      }
    }
    totalBytes += size;
    if (size > 1048576 || totalBytes > 4 * 1048576)
      throw new BrainError(
        "INVALID_INPUT",
        "Import exceeds the per-file or 4 MiB batch limit.",
        413,
      );
    if (input.kind === "folder" || input.kind === "context") {
      if (input.kind === "folder" && !/\.(txt|md)$/i.test(path)) {
        warnings.push(`${path}: unsupported attachment skipped`);
        continue;
      }
      if (!entry.content.trim()) {
        warnings.push(`${path}: empty file skipped`);
        continue;
      }
      items.push({ title: path, body: entry.content, path });
    } else {
      if (!/\.json$/i.test(path))
        throw new BrainError("INVALID_INPUT", "Choose a JSON chat export.");
      let parsed: unknown;
      try {
        parsed = JSON.parse(entry.content);
      } catch {
        throw new BrainError("INVALID_INPUT", "Chat JSON could not be parsed.");
      }
      if (!Array.isArray(parsed))
        throw new BrainError(
          "INVALID_INPUT",
          "Chat export must contain a conversation array.",
        );
      for (const [index, conversation] of parsed.entries()) {
        if (!conversation || typeof conversation !== "object") {
          warnings.push(`${path}: conversation ${index + 1} skipped`);
          continue;
        }
        const record = conversation as Record<string, any>;
        const title =
          typeof record.title === "string" && record.title.trim()
            ? record.title.slice(0, 200)
            : `Conversation ${index + 1}`;
        const messages = Array.isArray(record.messages)
          ? record.messages
          : record.mapping && typeof record.mapping === "object"
            ? Object.values(record.mapping)
                .map((node: any) => node?.message)
                .filter(Boolean)
            : [];
        const lines = messages.flatMap((message: any) => {
          const role = message?.role ?? message?.author?.role;
          const content = message?.content;
          const body =
            typeof content === "string"
              ? content
              : Array.isArray(content?.parts)
                ? content.parts
                    .filter((part: unknown) => typeof part === "string")
                    .join("\n")
                : "";
          return ["user", "assistant", "system", "developer", "tool"].includes(
            role,
          ) && body.trim()
            ? [`${role}: ${body}`]
            : [];
        });
        if (!lines.length) {
          warnings.push(`${path}: ${title} has no supported text messages`);
          continue;
        }
        const body = lines.join("\n\n");
        if (Buffer.byteLength(body, "utf8") > 1048576) {
          warnings.push(`${path}: ${title} exceeds the capture limit`);
          continue;
        }
        items.push({ title, body, path: `${path}#${index + 1}` });
      }
    }
    if (items.length > 50)
      throw new BrainError(
        "INVALID_INPUT",
        "Import batch exceeds 50 items.",
        413,
      );
  }
  const checkpoint = createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex");
  return {
    kind: input.kind,
    project_id: input.project_id,
    items,
    warnings,
    checkpoint,
  };
}
