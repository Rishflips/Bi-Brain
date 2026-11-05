// Plain-language copy for the Better search card. Pure, so the mapping can be tested without a browser.
// The mapping is closed: a string the worker, provider, ledger or domain writes is matched to one fixed sentence,
// and anything else gets a generic one. No raw text (service, model, credential, setting name, status code) reaches the card.

const PAUSED = "Better search paused: the service is not answering.";
const SIGN_IN = "Better search could not sign in to the search service. Check its key.";
const ALL_REFUSED = "The search service refused every passage. Better search will try again later.";

/** The fixed sentence for a known string, or null when nothing here was written for it. */
function known(text: string): string | null {
  if (text === PAUSED) return PAUSED;
  if (/could not sign in to the search service/i.test(text)) return SIGN_IN;
  if (/^The search service refused every passage/i.test(text)) return ALL_REFUSED;
  if (/needs a daily limit and a per-preparation limit/i.test(text)) return "Set a daily limit and a per-preparation limit above $0 below.";
  if (/Today's spending cap is reached/i.test(text)) return "Today's spending limit was reached.";
  if (/spending cap|could not reserve its spending/i.test(text)) return "A preparation went over its spending limit.";
  if (/used more than its estimate/i.test(text)) return "A preparation cost more than expected and was stopped.";
  if (/^\d+ passages? (was|were) refused by the search service/i.test(text)) return /^1 /.test(text) ? "The search service refused a passage." : "The search service refused some passages.";
  if (/did not answer|search model answered|reported an error|request failed/i.test(text)) return "The search service did not answer.";
  if (/waiting before it tries again/i.test(text)) return "Better search is waiting a little before it tries again.";
  if (/background worker is not running/i.test(text)) return "BiBrain's background helper is not running.";
  if (/background worker starts/i.test(text)) return "Waiting for BiBrain's background helper to start.";
  if (/search model changed/i.test(text)) return "The search setup changed. Choose Better search again.";
  if (/^Better search is off\.$/.test(text)) return text;
  if (/^Better search is turned off by this computer's setup\.$/u.test(text)) return text;
  if (/was not found on this computer|search model is not pulled/i.test(text)) return "Better search is not set up correctly on this computer. See Providers in the docs.";
  if (/not set up on this computer|supports Ollama or Cloudflare|better-search |BRAIN_EMBED|search model must be|Add your Cloudflare|Add a Cloudflare|^Better search with (Ollama|Cloudflare) must|server-side credential|set up incorrectly/i.test(text))
    return "Better search is not set up correctly on this computer. See Providers in the docs.";
  return null;
}

/** What the card shows for the worker's last problem. */
export function plainSearchProblem(raw: string | null | undefined): string {
  return known((raw ?? "").trim()) ?? "Something went wrong preparing passages.";
}

/** What the words-only line shows for the reason better search cannot work right now. */
export function plainSearchReason(reason: string): string {
  return known((reason ?? "").trim()) ?? "Search is using words only right now.";
}

/** Save is for a different choice, or for re-confirming the saved one after the worker's service or model changed (the saved choice then needs choosing again). While the choice is automatic, Save pins it. */
export function betterSearchCanSave(better: { mode: string; key: string | null; status: { key?: string | null } | null; automatic?: boolean }, choice: string): boolean {
  if (choice !== better.mode) return true;
  if (better.automatic) return true;
  return better.mode !== "off" && !!better.status?.key && better.status.key !== better.key;
}

/** Shown once under the card while Better search is on by itself. */
export const AUTOMATIC_NOTICE = "BiBrain found a search model running in Ollama on this computer, so search by meaning is on. Nothing leaves your computer. Choose Off below to turn it off; it then stays off until you choose it again.";
/** Shown while the owner's choice is Off and the probe found the model. */
export const DETECTED_HINT = "A search model is running in Ollama on this computer. Choose On this computer to use it.";
/** The one place the model's name is allowed on the card: the instruction the owner has to type. Null when there is nothing to do. */
export function plainProbe(probe: string | null | undefined): string | null {
  if (probe === "no_ollama") return "Ollama was not found on this computer. Install Ollama and run `ollama pull bge-m3`; BiBrain checks again every 10 minutes.";
  if (probe === "no_model") return "Ollama is running on this computer, but its search model is not pulled. Run `ollama pull bge-m3`; BiBrain checks again every 10 minutes.";
  return null;
}

export type MeaningLeadView = { lead: { threshold: number; sample: number; source: string; measured_at: string; applied_at: string } | null; effective: number | null; reason: string };
/** The one line under "Meaning matches can lead". The model key is never shown. */
export function meaningLeadLine(m: MeaningLeadView): string {
  if (m.reason === "Turn Better search on first." || m.reason === "Better search is not running right now.") return m.reason;
  if (m.effective !== null && m.lead) return `Calibrated at ${m.lead.threshold}: a match found by meaning alone can lead a push when its score is ${m.lead.threshold} or higher. From ${m.lead.source}, ${m.lead.sample} ${m.lead.source === "calibrate" ? "pushes" : "queries"} measured on ${m.lead.measured_at}, applied ${m.lead.applied_at.slice(0, 10)}.`;
  if (m.lead) return "Measured for another search model. Measure again. Until then a match found by meaning alone never leads a push.";
  return "Not yet calibrated. A match found by meaning alone never leads a push to your agents. Run npm run proof:search or npm run calibrate for a suggested value, then enter it here.";
}
