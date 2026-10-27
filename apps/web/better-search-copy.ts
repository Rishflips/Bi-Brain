// Plain-language copy for the Better search card. Pure, so the mapping can be tested without a browser.

/** What the card shows for the worker's last problem: never an HTTP code, a service name or a model name. */
export function plainSearchProblem(raw: string | null | undefined): string {
  const text = (raw ?? "").trim();
  if (/spending|spend|limit|budget|\bcap\b/i.test(text)) return "Today's spending limit was reached.";
  if (/^\d+ passages? (was|were) refused/i.test(text)) return /^1 /.test(text) ? "The search service refused a passage." : "The search service refused some passages.";
  if (/did not answer|in time|timed out|answered \d{3}|reported an error|request failed|not answering|unavailable|more than its estimate/i.test(text)) return "The search service did not answer.";
  if (/waiting before it tries again/i.test(text)) return "Better search is waiting a little before it tries again.";
  if (/background worker is not running/i.test(text)) return "BiBrain's background worker is not running.";
  if (/not set up on this computer/i.test(text)) return "Better search is not set up on this computer.";
  if (/changed\. choose better search again/i.test(text)) return "The search setup changed. Choose Better search again.";
  return "Something went wrong preparing passages.";
}

/** The domain's reasons are already plain apart from one that names the model; that one is reworded here. */
export function plainSearchReason(reason: string): string {
  return /search model changed/i.test(reason) ? "The search setup changed. Choose Better search again." : reason;
}

/** Save is for a different choice, or for re-confirming the saved one after the worker's service or model changed (the saved choice then needs choosing again). */
export function betterSearchCanSave(better: { mode: string; key: string | null; status: { key?: string | null } | null }, choice: string): boolean {
  if (choice !== better.mode) return true;
  return better.mode !== "off" && !!better.status?.key && better.status.key !== better.key;
}
