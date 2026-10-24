const PAIR = /^#pair=([0-9a-f]{64})$/u;

/** Takes a one-time pairing token from "#pair=…" and removes it from the address bar and history. */
export function takePairToken(
  loc: { hash: string; pathname: string; search: string },
  hist: { replaceState(data: unknown, unused: string, url: string): void },
): string | null {
  // Read everything first: window.location is live, and replaceState empties its hash.
  const { hash, pathname, search } = loc;
  if (!hash.startsWith("#pair=")) return null;
  hist.replaceState(null, "", pathname + search);
  return PAIR.exec(hash)?.[1] ?? null;
}
