import { useEffect, useState, type ReactNode } from "react";
import type { Source } from "../../../packages/contracts/index.ts";
import { friendlyError } from "../today/BriefCard.tsx";
import { shortDate } from "./format.ts";
import { evidenceRanges, findQuote, highlightSegments } from "./highlight.ts";
import type { Api, Fact, FactHistoryEntry, ProjectView } from "./types.ts";

type Props = {
  api: Api;
  source: Source;
  quote?: string;
  factId?: string;
  projectTitle: string;
  /** The existing original actions: correct, add a fact, delete, earlier version. */
  actions: ReactNode;
};

const from = (origin: string) =>
  origin === "manual" ? "Saved by you" : origin.startsWith("agent:") ? "From an agent" : "Imported";

function historyNote(h: FactHistoryEntry, first: boolean) {
  if (h.status !== "current") return "No longer current";
  if (first) return h.edited_by_owner ? "Kept in your words" : "Kept from this original";
  return "You edited this";
}

export function SourceView({ api, source, quote, factId, projectTitle, actions }: Props) {
  const [facts, setFacts] = useState<Fact[] | null>(null);
  const [history, setHistory] = useState<FactHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setFacts(null);
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
  const ranges = evidenceRanges(source.body, cited);
  const quoted = quote ? findQuote(source.body, quote) : null;
  if (quoted) ranges.push(quoted);
  const segments = highlightSegments(source.body, ranges);

  return (
    <div className="yb-source">
      <p className="tv-faint">
        {projectTitle} · {from(source.origin)} · Original version {source.version} ·{" "}
        {source.visibility === "private" ? "Private" : "Shareable within project"}
        {source.state !== "active" ? ` · ${source.state}` : ""}
      </p>
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
