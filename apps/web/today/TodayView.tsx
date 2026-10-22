import { useCallback, useEffect, useState } from "react";
import { SaveAskBar } from "./SaveAskBar.tsx";
import type { Brief, TodayProps } from "./types.ts";

export function TodayView(props: TodayProps) {
  const { api, sourceCount, backgroundOn, onNavigate } = props;
  const [brief, setBrief] = useState<Brief | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadBrief = useCallback(async () => {
    try {
      const next = await api<Brief>("/brief");
      setBrief(next);
      props.onBriefCount?.(next.items.length);
      setLoadError(null);
    } catch (e) {
      setLoadError(
        e instanceof Error ? e.message : "Your brain is unavailable.",
      );
    }
  }, [api]);

  useEffect(() => {
    void loadBrief();
    const onFocus = () => void loadBrief();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [loadBrief, sourceCount]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (document.activeElement as HTMLElement | null)?.tagName ?? "";
      if (e.key === "/" && !/^(INPUT|TEXTAREA|SELECT)$/u.test(tag)) {
        e.preventDefault();
        document.getElementById("tv-bar")?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (sourceCount === 0)
    return (
      <section className="tv" aria-labelledby="tv-h">
        <h1 id="tv-h" className="tv-title">
          Welcome to BiBrain.
        </h1>
        <SaveAskBar
          api={api}
          projects={props.projects}
          onOpenSource={props.onOpenSource}
          onSaved={() => {
            props.onChanged();
            void loadBrief();
          }}
        />
        <div className="tv-section">
          <div className="tv-section-head">
            <h2>Three ways to fill your brain</h2>
            <span className="tv-faint">Pick any one. The others can wait.</span>
          </div>
          <div className="tv-steps">
            <div className="tv-step">
              <span className="tv-step-n">Fastest</span>
              <h3>Plug in an agent</h3>
              <p>
                Claude Code or Codex can recall your projects and suggest what
                to remember.
              </p>
              <button
                className="tv-btn tv-primary"
                onClick={() => onNavigate("Connections")}
              >
                Choose an agent
              </button>
            </div>
            <div className="tv-step">
              <span className="tv-step-n">One minute</span>
              <h3>Paste something</h3>
              <p>
                A note, a decision or a whole conversation. The original is kept
                exactly as you saved it.
              </p>
              <button
                className="tv-btn"
                onClick={() => document.getElementById("tv-bar")?.focus()}
              >
                Use the bar above
              </button>
            </div>
            <div className="tv-step">
              <span className="tv-step-n">Bring history</span>
              <h3>Import a folder</h3>
              <p>
                Text and Markdown files. You review what comes in before
                anything counts as true.
              </p>
              <button
                className="tv-btn"
                onClick={() => onNavigate("Connections")}
              >
                Import files
              </button>
            </div>
          </div>
        </div>
      </section>
    );

  return (
    <section className="tv" aria-labelledby="tv-h">
      <h1 id="tv-h" className="tv-title">
        Good to see you.
      </h1>
      <SaveAskBar
        api={api}
        projects={props.projects}
        onOpenSource={props.onOpenSource}
        onSaved={() => {
          props.onChanged();
          void loadBrief();
        }}
      />
      <div className="tv-section" aria-labelledby="tv-brief-h">
        <div className="tv-section-head">
          <h2 id="tv-brief-h">Since you were last here</h2>
          <span className="tv-faint">
            At most three. Nothing changes until you choose.
          </span>
        </div>
        {loadError ? (
          <p className="tv-error" role="alert">
            {loadError}{" "}
            <button className="tv-link" onClick={() => void loadBrief()}>
              Try again
            </button>
          </p>
        ) : !brief ? (
          <p className="tv-faint" role="status">
            Checking for changes…
          </p>
        ) : !backgroundOn && brief.items.length === 0 ? (
          <div className="tv-quiet">
            <h3>Background help is off</h3>
            <p>
              BiBrain still saves and answers. It will not look for changes
              until you turn it on in Settings.
            </p>
          </div>
        ) : brief.items.length === 0 ? (
          <div className="tv-quiet">
            <h3>You are caught up.</h3>
            <p>
              BiBrain will speak up when an agent records something new or a
              fact goes stale. Quiet is normal.
            </p>
          </div>
        ) : (
          <p className="tv-faint">{brief.items.length} to look at.</p>
        )}
      </div>
    </section>
  );
}
