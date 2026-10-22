import { useCallback, useEffect, useRef, useState } from "react";
import { BriefCard } from "./BriefCard.tsx";
import { SaveAskBar } from "./SaveAskBar.tsx";
import type { Brief, TodayProps } from "./types.ts";
import { useUndoToast } from "./useUndoToast.tsx";

export function TodayView(props: TodayProps) {
  const { api, sourceCount, backgroundOn, onNavigate } = props;
  const [brief, setBrief] = useState<Brief | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);
  const { toast, show } = useUndoToast();
  const mounted = useRef(true);
  const pending = useRef(
    new Map<string, { timer: number; send: () => Promise<unknown> }>(),
  );
  const listRef = useRef<HTMLDivElement>(null);
  const hadFocus = useRef(false);

  const loadBrief = useCallback(async () => {
    try {
      const next = await api<Brief>("/brief");
      if (!mounted.current) return;
      setBrief(next);
      props.onBriefCount?.(next.items.length);
      setLoadError(null);
    } catch (e) {
      if (!mounted.current) return;
      setLoadError(
        e instanceof Error ? e.message : "Your brain is unavailable.",
      );
    }
  }, [api]);

  // A dismissal the owner chose is sent if they leave before the timer ends.
  // Nothing here touches state, because the view is gone.
  useEffect(() => {
    mounted.current = true;
    const waiting = pending.current;
    return () => {
      mounted.current = false;
      for (const { timer, send } of waiting.values()) {
        window.clearTimeout(timer);
        void send().catch(() => {});
      }
      waiting.clear();
    };
  }, []);

  const visible = brief
    ? brief.items.filter((i) => !hidden.has(i.signature))
    : [];
  const visibleKey = visible.map((i) => i.signature).join("|");

  useEffect(() => {
    const list = listRef.current;
    if (!list || !hadFocus.current) return;
    const active = document.activeElement;
    if (active && active !== document.body && list.contains(active)) return;
    hadFocus.current = false;
    const next = list.querySelector<HTMLElement>("article button");
    (next ?? document.getElementById("tv-brief-h"))?.focus();
  }, [visibleKey]);

  useEffect(() => {
    void loadBrief();
    const onFocus = () => void loadBrief();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [loadBrief, sourceCount]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const el = document.activeElement as HTMLElement | null;
      const tag = el?.tagName ?? "";
      if (el?.isContentEditable) return;
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
          <h2 id="tv-brief-h" tabIndex={-1}>
            Since you were last here
          </h2>
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
        ) : !backgroundOn && visible.length === 0 ? (
          <div className="tv-quiet">
            <h3>Background help is off</h3>
            <p>
              BiBrain still saves and answers. It will not look for changes
              until you turn it on in Settings.
            </p>
          </div>
        ) : visible.length === 0 ? (
          <div className="tv-quiet">
            <h3>You are caught up.</h3>
            <p>
              BiBrain will speak up when an agent records something new or a
              fact goes stale. Quiet is normal.
            </p>
          </div>
        ) : (
          <div
            className="tv-brief"
            ref={listRef}
            onFocusCapture={() => {
              hadFocus.current = true;
            }}
            onBlurCapture={(e) => {
              if (e.relatedTarget) hadFocus.current = false;
            }}
          >
            {visible.map((item) => (
              <BriefCard
                key={item.signature}
                item={item}
                projectTitle={
                  props.projects.find((p) => p.id === item.project_id)?.title ??
                  "Inbox"
                }
                api={api}
                onOpenSource={props.onOpenSource}
                onDone={(message, undo) => {
                  setActionError(null);
                  show(
                    message,
                    undo
                      ? async () => {
                          await undo();
                          await loadBrief();
                          props.onChanged();
                        }
                      : undefined,
                  );
                  void loadBrief();
                  props.onChanged();
                }}
                onDeferredDismiss={(it, send) => {
                  setHidden((h) => new Set(h).add(it.signature));
                  const release = () =>
                    setHidden((h) => {
                      const n = new Set(h);
                      n.delete(it.signature);
                      return n;
                    });
                  const timer = window.setTimeout(async () => {
                    pending.current.delete(it.signature);
                    try {
                      await send();
                    } catch (e) {
                      if (mounted.current)
                        setActionError(
                          e instanceof Error ? e.message : "Could not dismiss.",
                        );
                    }
                    await loadBrief();
                    if (mounted.current) release();
                  }, 6000);
                  pending.current.set(it.signature, { timer, send });
                  show(
                    "Dismissed. It comes back only if something new appears.",
                    async () => {
                      window.clearTimeout(timer);
                      pending.current.delete(it.signature);
                      release();
                    },
                  );
                }}
                onError={(message) => {
                  setActionError(message);
                  void loadBrief();
                }}
              />
            ))}
            {brief.waiting > 0 && (
              <p className="tv-faint">
                {brief.waiting} more waiting. They appear as you clear these.
              </p>
            )}
          </div>
        )}
        {actionError && (
          <p className="tv-error" role="alert">
            {actionError}
          </p>
        )}
        {toast}
      </div>
    </section>
  );
}
