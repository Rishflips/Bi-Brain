import { useEffect, useState, type ReactNode } from "react";
import type { Source } from "../../../packages/contracts/index.ts";
import { friendlyError } from "../today/BriefCard.tsx";
import { shortDate } from "./format.ts";
import { findQuote, highlightSegments, markedRanges } from "./highlight.ts";
import type { Api, Fact, FactHistoryEntry, ProjectView } from "./types.ts";

type Props = {
  api: Api;
  source: Source & { written_by?: { agent: string; reviewed: boolean } };
  quote?: string;
  factId?: string;
  projectTitle: string;
  /** The existing original actions: correct, add a fact, delete, earlier version. */
  actions: ReactNode;
  /** Called after the owner marks an agent-written original as reviewed. */
  onReviewed?: () => void | Promise<void>;
};

const from = (origin: string) =>
  origin === "manual" ? "Saved by you" : origin.startsWith("agent:") ? "From an agent" : origin.startsWith("import:") && origin.length > 7 ? `Imported from ${origin.slice(7)}` : "Imported";

function historyNote(h: FactHistoryEntry, first: boolean) {
  if (h.status !== "current") return "No longer current";
  if (first) return h.edited_by_owner ? "Kept in your words" : "Kept from this original";
  return h.edited_by_owner ? "You edited this" : "Updated";
}

export function SourceView({ api, source, quote, factId, projectTitle, actions, onReviewed }: Props) {
  const [facts, setFacts] = useState<Fact[] | null>(null);
  const [history, setHistory] = useState<FactHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [factsFailed, setFactsFailed] = useState(false);

  useEffect(() => {
    let live = true;
    setFacts(null);
    setFactsFailed(false);
    setError(null);
    api<ProjectView>(`/brain/projects/${encodeURIComponent(source.project_id)}`)
      .then((v) => {
        if (!live) return;
        setFacts(
          v.facts.filter((f) =>
            f.evidence.some((e) => e.source_id === source.id && e.source_version === source.version),
          ),
        );
      })
      .catch((e) => {
        if (!live) return;
        setFacts([]);
        setFactsFailed(true);
        setError(friendlyError(e));
      });
    return () => {
      live = false;
    };
  }, [api, source.id, source.version, source.project_id]);

  useEffect(() => {
    let live = true;
    setHistory(null);
    if (factId)
      api<FactHistoryEntry[]>(`/claims/${encodeURIComponent(factId)}/history`)
        .then((h) => {
          if (live) setHistory(h);
        })
        .catch(() => {
          if (live) setHistory([]);
        });
    return () => {
      live = false;
    };
  }, [api, factId]);

  const cited = (facts ?? []).flatMap((f) =>
    f.evidence.filter((e) => e.source_id === source.id && e.source_version === source.version),
  );
  const quoted = quote ? findQuote(source.body, quote) : null;
  const ranges = markedRanges(source.body, cited, quote);
  const segments = highlightSegments(source.body, ranges);

  return (
    <div className="yb-source">
      <p className="tv-faint">
        {projectTitle} · {source.written_by
          ? `From ${source.written_by.agent} · ${source.written_by.reviewed ? "reviewed" : "not yet reviewed"}`
          : from(source.origin)}{" "}
        · Original version {source.version} ·{" "}
        {source.visibility === "private" ? "Private" : "Shareable within project"}
        {source.state !== "active" ? ` · ${source.state}` : ""}
      </p>
      {source.written_by && !source.written_by.reviewed && (
        <p className="yb-review">
          <button
            type="button"
            className="tv-btn tv-sm"
            onClick={() =>
              void api(`/sources/${encodeURIComponent(source.id)}/reviewed`, {})
                .then(() => onReviewed?.())
                .catch((e) => setError(friendlyError(e)))
            }
          >
            Mark as reviewed
          </button>
          <span className="tv-faint">Reviewed notes can be pushed to your agents as evidence.</span>
        </p>
      )}
      <section className="yb-drawer-section" aria-labelledby="yb-src-orig-h">
        <h3 id="yb-src-orig-h" className="yb-eyebrow">
          Original
        </h3>
        {quote && !quoted && (
          <p className="tv-faint" role="note">
            That passage is no longer in this original. It may have been corrected.
          </p>
        )}
        <pre data-testid="original" className="yb-original">
          {segments.map((s, i) => (s.mark ? <mark key={i}>{s.text}</mark> : <span key={i}>{s.text}</span>))}
        </pre>
      </section>
      {actions}
      {error && (
        <p className="tv-error" role="alert">
          {error}
        </p>
      )}
      {factId && (
        <section className="yb-drawer-section" aria-labelledby="yb-src-hist-h">
          <h3 id="yb-src-hist-h" className="yb-eyebrow">
            History of this fact
          </h3>
          {history === null ? (
            <p className="tv-faint">Loading…</p>
          ) : history.length === 0 ? (
            <p className="tv-faint">History is unavailable right now.</p>
          ) : (
            <ol className="yb-history">
              {[...history].reverse().map((h) => (
                <li key={h.version}>
                  <span className="yb-v">v{h.version}</span>
                  <span>
                    <b>{h.text}</b>
                    <br />
                    <span className="tv-faint">
                      {historyNote(h, h.version === history[0].version)} · {shortDate(h.at)}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}
      <section className="yb-drawer-section" aria-labelledby="yb-src-facts-h">
        <h3 id="yb-src-facts-h" className="yb-eyebrow">
          Facts taken from this
        </h3>
        {facts === null ? (
          <p className="tv-faint">Loading…</p>
        ) : factsFailed ? (
          <p className="tv-faint">These could not be loaded right now.</p>
        ) : facts.length === 0 ? (
          <p className="tv-faint">None yet.</p>
        ) : (
          <ul className="yb-list">
            {facts.map((f) => (
              <li key={f.id} className="yb-item">
                <p className="yb-fact">{f.text}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
