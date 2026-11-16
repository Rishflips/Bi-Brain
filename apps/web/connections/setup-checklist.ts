import type { Grant } from "./types.ts";

export type SetupItem = { id: "open" | "approve" | "ask"; label: string; done: boolean };

/**
 * The three steps after Add, ticked only from what BiBrain has recorded for this connection.
 * - "Open … here" and "Approve BiBrain" share one signal, the first authenticated call (`last_verified_at`): nothing
 *   BiBrain records tells them apart, and neither can be true without it.
 * - "Ask anything" waits for the first recorded push when BiBrain wrote the prompt hook. Without that hook (a rule
 *   file, or a hook file that already existed) no push will ever arrive, and a call only happens in answer to a prompt,
 *   so the first call finishes the list.
 * Null when there is nothing to show: access has ended, or every step is done.
 */
export function setupChecklist(grant: Pick<Grant, "status" | "last_verified_at" | "client_name" | "files" | "recall">): SetupItem[] | null {
  if (grant.status !== "Connected" && grant.status !== "Not connected") return null;
  const called = grant.last_verified_at !== null;
  const hookWritten = grant.files.some((f) => f.role === "hook" && f.state === "written");
  const asked = hookWritten ? grant.recall.pushes > 0 : called;
  if (called && asked) return null;
  return [
    { id: "open", label: `Open ${grant.client_name} here`, done: called },
    { id: "approve", label: "Approve BiBrain", done: called },
    { id: "ask", label: "Ask anything", done: asked },
  ];
}
