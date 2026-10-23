export type Range = { start: number; end: number };
export type Segment = { text: string; mark: boolean };

/** Splits a body into plain and highlighted runs. Offsets count code points, like the server's evidence. */
export function highlightSegments(body: string, ranges: Range[]): Segment[] {
  const chars = Array.from(body);
  const valid = ranges
    .filter(
      (r) =>
        Number.isInteger(r.start) &&
        Number.isInteger(r.end) &&
        r.start >= 0 &&
        r.end > r.start &&
        r.end <= chars.length,
    )
    .sort((a, b) => a.start - b.start);
  const merged: Range[] = [];
  for (const r of valid) {
    const last = merged.at(-1);
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  const out: Segment[] = [];
  let at = 0;
  for (const r of merged) {
    if (r.start > at) out.push({ text: chars.slice(at, r.start).join(""), mark: false });
    out.push({ text: chars.slice(r.start, r.end).join(""), mark: true });
    at = r.end;
  }
  if (at < chars.length || out.length === 0) out.push({ text: chars.slice(at).join(""), mark: false });
  return out;
}

/** Where an exact quote first appears, in code points. Null when it is not there. */
export function findQuote(body: string, quote: string): Range | null {
  if (!quote) return null;
  const at = body.indexOf(quote);
  if (at < 0) return null;
  const start = Array.from(body.slice(0, at)).length;
  return { start, end: start + Array.from(quote).length };
}

/** Keeps only evidence whose text still matches the quote it claims to show. */
export function evidenceRanges(body: string, evidence: { start: number; end: number; quote: string }[]): Range[] {
  const chars = Array.from(body);
  return evidence
    .filter((e) => chars.slice(e.start, e.end).join("") === e.quote)
    .map((e) => ({ start: e.start, end: e.end }));
}

/**
 * The ranges to mark: the exact evidence of the cited facts, plus the first
 * place the quote appears only when no cited evidence already shows that quote.
 */
export function markedRanges(
  body: string,
  evidence: { start: number; end: number; quote: string }[],
  quote?: string,
): Range[] {
  const ranges = evidenceRanges(body, evidence);
  if (!quote) return ranges;
  const chars = Array.from(body);
  const shown = evidence.some((e) => e.quote === quote && chars.slice(e.start, e.end).join("") === quote);
  if (shown) return ranges;
  const found = findQuote(body, quote);
  return found ? [...ranges, found] : ranges;
}
