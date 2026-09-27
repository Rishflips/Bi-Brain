import { createHash } from "node:crypto";
import type { Evidence, Source, Item } from "../contracts/index.ts";
export const hash = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, v]) => JSON.stringify(key) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export class BrainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
export function requireVersion(current: number, expected: number) {
  if (current !== expected)
    throw new BrainError(
      "VERSION_CONFLICT",
      "This item changed since you opened it. Refresh to compare.",
      409,
    );
}
export function excerpt(source: Source): Evidence {
  const chars = Array.from(source.body);
  const quote = chars.slice(0, Math.min(chars.length, 600)).join("");
  return {
    source_id: source.id,
    source_version: source.version,
    start: 0,
    end: Array.from(quote).length,
    quote,
  };
}
export function extract(sources: Source[]): {
  items: Item[];
  unknowns: string[];
} {
  return {
    items: sources.slice(0, 20).map((source) => {
      const ev = excerpt(source);
      return {
        text: ev.quote,
        epistemic_status: source.origin.startsWith("agent:")
          ? "user_assertion"
          : "supported",
        evidence: [ev],
      };
    }),
    unknowns: [
      "These are original passages, not an inferred plan. Add your own understanding or configure a provider in Settings.",
    ],
  };
}
export function validateEvidence(
  evidence: Evidence[],
  sources: Source[],
  project: string,
) {
  for (const e of evidence) {
    const source = sources.find(
      (s) =>
        s.id === e.source_id &&
        s.version === e.source_version &&
        s.project_id === project &&
        s.state === "active",
    );
    if (
      !source ||
      e.end <= e.start ||
      e.end > Array.from(source.body).length ||
      Array.from(source.body).slice(e.start, e.end).join("") !== e.quote
    )
      throw new BrainError(
        "SOURCE_STALE",
        "Evidence no longer matches current saved sources.",
        409,
      );
  }
}
export function localSchedule(
  now: Date,
  prefs: {
    time_zone: string;
    digest_hour: number;
    quiet_start: number;
    quiet_end: number;
  },
) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: prefs.time_zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (key: string) => parts.find((p) => p.type === key)!.value;
  const hour = Number(get("hour"));
  const quiet =
    prefs.quiet_start === prefs.quiet_end
      ? false
      : prefs.quiet_start < prefs.quiet_end
        ? hour >= prefs.quiet_start && hour < prefs.quiet_end
        : hour >= prefs.quiet_start || hour < prefs.quiet_end;
  return {
    day: `${get("year")}-${get("month")}-${get("day")}`,
    eligible: hour >= prefs.digest_hour && !quiet,
  };
}
