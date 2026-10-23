// apps/web/brain/BrainSearch.tsx
import { useEffect, useRef, useState } from "react";
import { friendlyError } from "../today/BriefCard.tsx";
import type { Api, OpenSourceOptions, SearchResults } from "./types.ts";

type Props = {
  api: Api;
  projects: { id: string; title: string }[];
  query: string;
  onQuery: (q: string) => void;
  onOpenSource: (id: string, opts?: OpenSourceOptions) => void;
};

export function BrainSearch({ api, projects, query, onQuery, onOpenSource }: Props) {
  const [results, setResults] = useState<SearchResults | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Only the response to the newest query may land.
  const seq = useRef(0);
  const field = useRef<HTMLInputElement>(null);
  const q = query.trim();

  useEffect(() => {
    const mine = ++seq.current;
    setError(null);
    setResults(null);
    if (q.length < 2) return;
    const timer = window.setTimeout(() => {
      api<SearchResults>(`/brain/search?q=${encodeURIComponent(q)}`)
        .then((r) => {
          if (mine === seq.current) setResults(r);
        })
        .catch((e) => {
          if (mine === seq.current) setError(friendlyError(e));
        });
    }, 200);
    return () => window.clearTimeout(timer);
  }, [api, q]);
  useEffect(
    () => () => {
      seq.current += 1;
    },
    [],
  );

  const title = (id: string) => projects.find((p) => p.id === id)?.title ?? "Project";
  const count = results ? results.facts.length + results.originals.length : 0;
  return (
    <div className="yb-search">
      <label className="tv-sr" htmlFor="yb-q">
        Search your brain
      </label>
      <input
        id="yb-q"
        ref={field}
        className="yb-field"
        type="search"
        placeholder="Search facts and originals"
        maxLength={200}
        value={query}
        onChange={(e) => onQuery(e.target.value)}
      />
      {q && (
        <section className="tv-section" aria-labelledby="yb-results-h" aria-live="polite">
          <div className="tv-section-head">
            <h2 id="yb-results-h">
              {q.length < 2 ? "Search" : results ? `${count} ${count === 1 ? "match" : "matches"}` : "Searching…"}
            </h2>
            <button
              type="button"
              className="tv-link"
              onClick={() => {
                onQuery("");
                field.current?.focus();
              }}
            >
              Clear search
            </button>
          </div>
          {q.length < 2 && <p className="tv-faint">Type at least two letters.</p>}
          {error && (
            <p className="tv-error" role="alert">
              {error}
            </p>
          )}
          {results && count === 0 && (
            <p className="tv-faint">No matches. Try a different word, or save something new.</p>
          )}
          {results && results.facts.length > 0 && (
            <>
              <h3 className="yb-eyebrow">Facts</h3>
              <ul className="yb-list">
                {results.facts.map((f) => {
                  const e = f.evidence[0];
                  return (
                    <li key={f.id} className="yb-item">
                      <div className="yb-meta">
                        <span className="tv-tag tv-ok">Fact</span>
                        <span className="tv-faint">{title(f.project_id)}</span>
                      </div>
                      <p className="yb-fact">{f.text}</p>
                      {e && (
                        <button
                          type="button"
                          className="tv-link"
                          onClick={() => onOpenSource(e.source_id, { quote: e.quote, factId: f.id })}
                        >
                          Open the original
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
          {results && results.originals.length > 0 && (
            <>
              <h3 className="yb-eyebrow">Originals</h3>
              <ul className="yb-list">
                {results.originals.map((o) => (
                  <li key={o.id}>
                    <button type="button" className="yb-hit" onClick={() => onOpenSource(o.id)}>
                      <span className="yb-hit-title">{o.title}</span>
                      <span className="yb-hit-snippet">{o.snippet}</span>
                      <span className="tv-faint">{title(o.project_id)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}
    </div>
  );
}
