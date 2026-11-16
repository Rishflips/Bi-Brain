import { describe, expect, it } from "vitest";
import { setupChecklist } from "../../apps/web/connections/setup-checklist.ts";

const none = { pushes: 0, last_push_at: null, last_level: null } as const;
const pushed = { pushes: 1, last_push_at: "2026-11-16T09:00:00.000Z", last_level: "full" } as const;
const hook = [{ path: ".codex/hooks.json", role: "hook", state: "written", contents: "{}" }] as const;
const hookExists = [{ path: ".codex/hooks.json", role: "hook", state: "exists", contents: "{}" }] as const;
const rule = [{ path: ".cursor/rules/bibrain.mdc", role: "rule", state: "written", contents: "" }] as const;
const waiting: Parameters<typeof setupChecklist>[0] = { status: "Not connected", last_verified_at: null, client_name: "Codex", files: [...hook], recall: none };
const done = (grant: Parameters<typeof setupChecklist>[0]) => setupChecklist(grant)?.map((i) => i.done);

describe("connection setup checklist", () => {
  it("starts with three plain steps and no tick", () => {
    expect(setupChecklist(waiting)).toEqual([
      { id: "open", label: "Open Codex here", done: false },
      { id: "approve", label: "Approve BiBrain", done: false },
      { id: "ask", label: "Ask anything", done: false },
    ]);
  });
  it("ticks the first two from the first recorded call, and the third only from a recorded push when BiBrain wrote the hook", () => {
    expect(done({ ...waiting, status: "Connected", last_verified_at: "2026-11-16T09:00:00.000Z" })).toEqual([true, true, false]);
  });
  it("is finished, and shown no more, once a push is recorded", () => {
    expect(setupChecklist({ ...waiting, status: "Connected", last_verified_at: "2026-11-16T09:00:00.000Z", recall: pushed })).toBeNull();
  });
  it("without a hook BiBrain wrote, the first call is the only signal there will ever be, so it finishes the list", () => {
    for (const files of [[...rule], [...hookExists], []])
      expect(setupChecklist({ ...waiting, client_name: "Cursor", files, status: "Connected", last_verified_at: "2026-11-16T09:00:00.000Z" })).toBeNull();
    expect(done({ ...waiting, client_name: "Cursor", files: [...rule] })).toEqual([false, false, false]);
  });
  it("never ticks from a key alone, and shows nothing for access that has ended", () => {
    expect(done({ ...waiting, recall: none })).toEqual([false, false, false]);
    expect(setupChecklist({ ...waiting, status: "Revoked" })).toBeNull();
    expect(setupChecklist({ ...waiting, status: "Needs attention" })).toBeNull();
  });
  it("names the agent the connection belongs to", () => {
    expect(setupChecklist({ ...waiting, client_name: "Claude Code" })![0].label).toBe("Open Claude Code here");
  });
});
