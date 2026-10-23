/** A stored value as plain text. Never "undefined" or "[object Object]". */
export function valueText(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return "";
  }
}

/** The sentence a fact reads as, everywhere BiBrain shows one. */
export function factText(entityName: string, aspect: string, value: unknown): string {
  return aspect === "status"
    ? `${entityName} is ${valueText(value)}.`
    : `${entityName}: ${valueText(value)}`;
}
