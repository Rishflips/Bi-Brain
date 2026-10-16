import {
  lstatSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { BrainError } from "../domain/logic.ts";
import type { ControlEpoch } from "../domain/managed-reconciliation.ts";

/**
 * Trusted managed-root containment and the root generation marker.
 *
 * This is a small, shared operator preflight (used by the reconciliation store
 * now and the offline CLI later). It never creates a root, control database or
 * marker on a read path, and it binds a root marker to the EXACT control
 * database file so a marker copied from another root can never authorize it.
 */

export const MANAGED_ROOT_MARKER = "control-epoch.json";

export const rootMarkerSchema = z
  .object({
    schema: z.literal(1),
    epoch: z.number().int().min(1),
    nonce: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type RootEpochMarker = z.infer<typeof rootMarkerSchema>;

export interface ManagedRootBinding {
  root: string;
  controlPath: string;
}

function lstatOptional(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

/**
 * Rejects a path whose real self or any existing ancestor is a link (including a
 * dangling one) or a non-directory. It never follows a link to check. Used to
 * contain untrusted operator input files and directories.
 */
export function assertNonLinkedPathChain(path: string): void {
  const chain: string[] = [];
  for (let candidate = resolve(path); ; ) {
    chain.unshift(candidate);
    const parent = dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  for (const part of chain) {
    const stat = lstatOptional(part);
    if (!stat) continue;
    if (stat.isSymbolicLink())
      throw new BrainError(
        "UNAUTHORIZED",
        "The path passes through a link or junction.",
        401,
      );
    if (!stat.isDirectory())
      throw new BrainError(
        "UNAUTHORIZED",
        "The path passes through a non-directory.",
        401,
      );
  }
}

/**
 * Reads one bounded, regular, non-linked operator file as UTF-8 text. The size is
 * checked with `lstat` before any read, and no ancestor may be a link.
 */
export function readBoundedRegularFile(path: string, maxBytes: number): string {
  if (typeof path !== "string" || !isAbsolute(path))
    throw new BrainError(
      "INVALID_INPUT",
      "The operator file must be one absolute path.",
      400,
    );
  assertNonLinkedPathChain(dirname(resolve(path)));
  const stat = lstatOptional(resolve(path));
  if (!stat || stat.isSymbolicLink() || !stat.isFile())
    throw new BrainError(
      "UNAUTHORIZED",
      "The operator file must be a real file, not a link.",
      401,
    );
  if (stat.size > maxBytes)
    throw new BrainError(
      "INVALID_INPUT",
      "The operator file is too large.",
      400,
    );
  try {
    return readFileSync(resolve(path), "utf8");
  } catch {
    throw new BrainError(
      "INVALID_INPUT",
      "The operator file is unreadable.",
      400,
    );
  }
}

/**
 * Rejects a root (or any existing ancestor) that is a symlink or junction, and
 * confirms the root is its own real directory. When `controlPath` is supplied it
 * must be exactly `<root>/control.sqlite`.
 */
export function assertTrustedManagedRoot(
  root: string,
  controlPath?: string,
): ManagedRootBinding {
  if (typeof root !== "string" || !root || !isAbsolute(root))
    throw new BrainError(
      "INVALID_INPUT",
      "Managed root must be one explicit absolute path.",
      400,
    );
  const resolved = resolve(root);
  const chain: string[] = [];
  for (let dir = resolved; ; ) {
    chain.unshift(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  for (const candidate of chain) {
    const stat = lstatOptional(candidate);
    if (!stat) continue;
    if (stat.isSymbolicLink())
      throw new BrainError(
        "UNAUTHORIZED",
        "Managed root passes through a link or junction.",
        401,
      );
    if (!stat.isDirectory())
      throw new BrainError(
        "UNAUTHORIZED",
        "Managed root passes through a non-directory.",
        401,
      );
  }
  const rootStat = lstatOptional(resolved);
  if (!rootStat || rootStat.isSymbolicLink() || !rootStat.isDirectory())
    throw new BrainError(
      "UNAUTHORIZED",
      "Managed root must be an existing real directory.",
      401,
    );

  const derived = resolve(resolved, "control.sqlite");
  // Case folding is Windows-only: two POSIX roots that differ only by case are
  // distinct directories and must not be treated as identical.
  const norm = (path: string) =>
    process.platform === "win32" ? path.toLowerCase() : path;
  if (controlPath !== undefined) {
    const given = resolve(controlPath);
    if (
      norm(dirname(given)) !== norm(resolved) ||
      norm(given) !== norm(derived)
    )
      throw new BrainError(
        "UNAUTHORIZED",
        "This control database is not the one in this managed root.",
        401,
      );
  }
  const controlStat = lstatOptional(derived);
  if (!controlStat)
    throw new BrainError(
      "UNAUTHORIZED",
      "Managed root has no control database.",
      401,
    );
  if (controlStat.isSymbolicLink() || !controlStat.isFile())
    throw new BrainError(
      "UNAUTHORIZED",
      "Managed control database is not a real file.",
      401,
    );
  const markerStat = lstatOptional(markerPath(resolved));
  if (markerStat && markerStat.isSymbolicLink())
    throw new BrainError(
      "UNAUTHORIZED",
      "Managed root marker is a link.",
      401,
    );
  return { root: resolved, controlPath: derived };
}

export function markerPath(root: string): string {
  return resolve(root, MANAGED_ROOT_MARKER);
}

/**
 * Reads the root marker. Returns `undefined` when absent (an uninitialized
 * root), and refuses a link, unreadable or malformed marker.
 */
export function readRootMarker(root: string): RootEpochMarker | undefined {
  const path = markerPath(root);
  const stat = lstatOptional(path);
  if (!stat) return undefined;
  if (stat.isSymbolicLink() || !stat.isFile())
    throw new BrainError(
      "UNAUTHORIZED",
      "Managed root marker is not a real file.",
      401,
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new BrainError(
      "UNAUTHORIZED",
      "Managed root marker is unreadable.",
      401,
    );
  }
  const result = rootMarkerSchema.safeParse(parsed);
  if (!result.success)
    throw new BrainError(
      "UNAUTHORIZED",
      "Managed root marker is malformed.",
      401,
    );
  return result.data;
}

/** Atomically writes the marker (tmp + rename). Never follows a marker link. */
export function writeRootMarker(root: string, marker: RootEpochMarker): void {
  const path = markerPath(root);
  const stat = lstatOptional(path);
  if (stat?.isSymbolicLink())
    throw new BrainError("UNAUTHORIZED", "Managed root marker is a link.", 401);
  const tmp = resolve(
    root,
    `${MANAGED_ROOT_MARKER}.${randomBytes(6).toString("hex")}.tmp`,
  );
  rmSync(tmp, { force: true });
  writeFileSync(tmp, JSON.stringify(marker), { mode: 0o600 });
  renameSync(tmp, path);
}

export function rootEpochMatches(
  marker: RootEpochMarker | undefined,
  epoch: ControlEpoch,
): boolean {
  return (
    !!marker && marker.epoch === epoch.epoch && marker.nonce === epoch.nonce
  );
}
