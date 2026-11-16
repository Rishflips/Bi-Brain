import { describe, expect, it } from "vitest";
import { backgroundSteps, choiceDisabled, stepNote } from "../../apps/web/settings/background-steps.ts";

const off = { enabled: false, daily_cap_micro_usd: 0, per_job_cap_micro_usd: 0 };

describe("background help steps", () => {
  it("opens one step at a time", () => {
    expect(backgroundSteps(off)).toEqual({ limitsOpen: false, choicesOpen: false, current: 1 });
    expect(backgroundSteps({ ...off, enabled: true })).toEqual({ limitsOpen: true, choicesOpen: false, current: 2 });
    expect(backgroundSteps({ enabled: true, daily_cap_micro_usd: 50_000, per_job_cap_micro_usd: 0 })).toEqual({ limitsOpen: true, choicesOpen: false, current: 2 });
    expect(backgroundSteps({ enabled: true, daily_cap_micro_usd: 50_000, per_job_cap_micro_usd: 10_000 })).toEqual({ limitsOpen: true, choicesOpen: true, current: 3 });
  });
  it("closes the later steps again when an earlier one is undone, even with limits still set", () => {
    expect(backgroundSteps({ enabled: false, daily_cap_micro_usd: 50_000, per_job_cap_micro_usd: 10_000 })).toEqual({ limitsOpen: false, choicesOpen: false, current: 1 });
  });
  it("never traps a choice that is on: it stays operable so it can be turned off", () => {
    expect(choiceDisabled(true, false)).toBe(false);
    expect(choiceDisabled(true, false, true)).toBe(false);
    expect(choiceDisabled(false, false)).toBe(true);
    expect(choiceDisabled(false, true, true)).toBe(true);
    expect(choiceDisabled(false, true)).toBe(false);
  });
  it("a block on spending locks an unticked paid consent but never a ticked one", () => {
    // The page passes "step 3 open and spending not blocked" as the open flag for the paid consent.
    const open = backgroundSteps({ enabled: true, daily_cap_micro_usd: 50_000, per_job_cap_micro_usd: 10_000 }).choicesOpen;
    const paidOpen = (blocked: boolean) => open && !blocked;
    expect(choiceDisabled(true, paidOpen(true))).toBe(false);
    expect(choiceDisabled(false, paidOpen(true))).toBe(true);
    expect(choiceDisabled(false, paidOpen(false))).toBe(false);
  });
  it("says which step is missing, and nothing once a step is open", () => {
    const closed = backgroundSteps(off);
    expect(stepNote(2, closed)).toBe("Allow background help in step 1 first.");
    expect(stepNote(3, closed)).toBe("Allow background help in step 1 first.");
    const limits = backgroundSteps({ ...off, enabled: true });
    expect(stepNote(2, limits)).toBeNull();
    expect(stepNote(3, limits)).toBe("Set a daily limit and a per-preparation limit above $0 in step 2 first.");
    expect(stepNote(3, backgroundSteps({ enabled: true, daily_cap_micro_usd: 1, per_job_cap_micro_usd: 1 }))).toBeNull();
  });
});
