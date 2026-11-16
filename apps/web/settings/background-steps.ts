// The order of the Background help card in Settings: allow it, set its limits, then choose what it may do.
// Pure, so the gating can be tested without a browser. It only decides what the page lets a person reach;
// the server keeps its own checks and is not changed by any of this.

export type StepInputs = { enabled: boolean; daily_cap_micro_usd: number; per_job_cap_micro_usd: number };
export type Steps = { limitsOpen: boolean; choicesOpen: boolean; current: 1 | 2 | 3 };

export function backgroundSteps(p: StepInputs): Steps {
  const limitsSet = p.daily_cap_micro_usd > 0 && p.per_job_cap_micro_usd > 0;
  return { limitsOpen: p.enabled, choicesOpen: p.enabled && limitsSet, current: !p.enabled ? 1 : !limitsSet ? 2 : 3 };
}

/** A choice that is already on stays operable, so it can always be turned off. */
export function choiceDisabled(checked: boolean, open: boolean, unavailable = false): boolean {
  return !checked && (!open || unavailable);
}

/** The one sentence shown on a step that is not open yet. */
export function stepNote(step: 2 | 3, steps: Steps): string | null {
  if (!steps.limitsOpen) return "Allow background help in step 1 first.";
  if (step === 3 && !steps.choicesOpen) return "Set a daily limit and a per-preparation limit above $0 in step 2 first.";
  return null;
}
