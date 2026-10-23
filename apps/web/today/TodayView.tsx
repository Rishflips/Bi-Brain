import { useCallback, useEffect, useRef, useState } from "react";
import { BriefCard, friendlyError } from "./BriefCard.tsx";
import { ProjectCards } from "./ProjectCards.tsx";
import { SaveAskBar } from "./SaveAskBar.tsx";
import type { Brief, TodayProps } from "./types.ts";
import { useUndoToast } from "./useUndoToast.tsx";

export function TodayView(props: TodayProps) {
  const { api, sourceCount, backgroundOn, onNavigate } = props;
  const [brief, setBrief] = useState<Brief | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);
  // Bumped when the owner changes something, so project fact counts are read again.
  const [changes, setChanges] = useState(0);
  const { toast, show } = useUndoToast();
  const mounted = useRef(true);
  const pending = useRef(
    new Map<string, { timer: number; send: () => Promise<unknown> }>(),
  );
  const listRef = useRef<HTMLDivElement>(null);
  const focusIndex = useRef<number | null>(null);

  const loadBrief = useCallback(async () => {
    try {
      const next = await api<Brief>("/brief");
      if (!mounted.current) return;
      setBrief(next);
      props.onBriefCount?.(next.items.length);
      setLoadError(null);
    } catch (e) {
      if (!mounted.current) return;
      props.onBriefCount?.("unavailable");
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

  // When the card that held focus goes away, focus its replacement, or the
  // Brief heading when no card is left (the list itself may be gone).
  useEffect(() => {
    const index = focusIndex.current;
    if (index === null) return;
    const list = listRef.current;
    const active = document.activeElement;
    if (list && active && active !== document.body && list.contains(active))
      return;
    focusIndex.current = null;
    const cards = list ? Array.from(list.querySelectorAll("article")) : [];
    const card = cards[Math.min(index, cards.length - 1)];
    (
      card?.querySelector<HTMLElement>("button") ??
      document.getElementById("tv-brief-h")
    )?.focus();
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
          notes={props.notes}
          retiredSourceIds={props.retiredSourceIds}
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
        notes={props.notes}
        retiredSourceIds={props.retiredSourceIds}
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
            onFocusCapture={(e) => {
              const card = (e.target as HTMLElement).closest("article");
              const cards = Array.from(
                listRef.current?.querySelectorAll("article") ?? [],
              );
              focusIndex.current = card ? cards.indexOf(card) : null;
            }}
            onBlurCapture={(e) => {
              if (e.relatedTarget) focusIndex.current = null;
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
                  setChanges((n) => n + 1);
                  show(
                    message,
                    undo
                      ? async () => {
                          try {
                            await undo();
                          } catch (e) {
                            setActionError(friendlyError(e));
                            throw e;
                          } finally {
                            setChanges((n) => n + 1);
                            await loadBrief();
                            props.onChanged();
                          }
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
                        setActionError(friendlyError(e, "Could not dismiss."));
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
      <div className="tv-section" aria-labelledby="tv-proj-h">
        <div className="tv-section-head">
          <h2 id="tv-proj-h">Projects</h2>
        </div>
        <ProjectCards
          api={api}
          projects={props.projects}
          agentNamesByProject={props.agentNamesByProject}
          refreshKey={`${props.sourceCount}:${changes}`}
          onOpen={props.onOpenProject}
        />
      </div>
    </section>
  );
}
