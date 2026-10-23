/** "Oct 23", or "Oct 23, 2025" outside the current year. */
export function shortDate(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "Unknown date";
  const d = new Date(t);
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(d.getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }),
  });
}
