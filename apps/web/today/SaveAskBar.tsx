import { useRef, useState } from "react";
import type { Api, AskHit } from "./types.ts";

type Props = {
  api: Api;
  projects: { id: string; title: string }[];
  onSaved: (sourceId: string) => void;
  onOpenSource: (id: string) => void;
};
type Result =
  | { kind: "saved"; sourceId: string; title: string; project: string }
  | { kind: "answer"; question: string; hits: AskHit[] }
  | null;

const LIMIT = 100_000;

export function SaveAskBar({ api, projects, onSaved, onOpenSource }: Props) {
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"save" | "ask">("save");
  const [project, setProject] = useState("inbox");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const inFlight = useRef(false);
  const ask = mode === "ask";

  function change(value: string) {
    setText(value);
    setError(null);
    if (/\?\s*$/u.test(value)) setMode("ask");
  }

  async function submit() {
    const value = text.trim();
    if (inFlight.current) return;
    if (!value) {
      setError(
        ask ? "Type a question first." : "Type or paste something first.",
      );
      return;
    }
    if (!ask && Array.from(value).length > LIMIT) {
      setError("That is over 100,000 characters. Split it into smaller notes.");
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      if (ask) {
        const out = await api<{ question: string; hits: AskHit[] }>(
          `/ask?q=${encodeURIComponent(value)}`,
        );
        setResult({ kind: "answer", question: out.question, hits: out.hits });
        setText("");
        setMode("save");
      } else {
        const firstLine = value.split("\n")[0];
        const title =
          Array.from(firstLine).length > 80
            ? Array.from(firstLine).slice(0, 79).join("") + "…"
            : firstLine;
        const saved = await api<{ source_id: string }>("/sources", {
          title,
          body: value,
          project_id: project,
        });
        setResult({
          kind: "saved",
          sourceId: saved.source_id,
          title,
          project: projects.find((p) => p.id === project)?.title ?? "Inbox",
        });
        setText("");
        onSaved(saved.source_id);
      }
    } catch (e) {
      const message =
        e instanceof Error ? e.message : "Your brain is unavailable.";
      setError(
        ask ? message : `Not saved. ${message} Your text is still here.`,
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="tv-bar-wrap">
      <form
        className="tv-bar"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="tv-sr" htmlFor="tv-bar">
          {ask ? "Ask your brain" : "Save to your brain"}
        </label>
        <div className="tv-bar-row">
          <textarea
            id="tv-bar"
            ref={area}
            rows={2}
            value={text}
            placeholder={
              ask
                ? "Ask what your brain knows…"
                : "Paste a note, a decision, or a conversation…"
            }
            onChange={(e) => change(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                void submit();
              }
            }}
          />
          <button className="tv-btn tv-primary" type="submit" disabled={busy}>
            {busy ? (ask ? "Asking…" : "Saving…") : ask ? "Ask" : "Save"}
          </button>
        </div>
        <div className="tv-bar-foot">
          <div className="tv-seg" role="group" aria-label="What the bar does">
            <button
              type="button"
              aria-pressed={!ask}
              onClick={() => {
                setMode("save");
                area.current?.focus();
              }}
            >
              Save
            </button>
            <button
              type="button"
              aria-pressed={ask}
              onClick={() => {
                setMode("ask");
                area.current?.focus();
              }}
            >
              Ask
            </button>
          </div>
          {!ask && (
            <label className="tv-faint">
              Save to{" "}
              <select
                value={project}
                onChange={(e) => setProject(e.target.value)}
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                  </option>
                ))}
              </select>
            </label>
          )}
          <span className="tv-faint">
            Enter to {ask ? "ask" : "save"} · Shift+Enter for a new line
          </span>
        </div>
      </form>
      {error && (
        <p className="tv-error" role="alert">
          {error}
        </p>
      )}
      {result?.kind === "saved" && (
        <div className="tv-panel" aria-live="polite">
          <span className="tv-eyebrow">Saved</span>
          <p>
            <b>{result.title}</b>
          </p>
          <p className="tv-faint">
            In {result.project}. The original is kept exactly as you wrote it.{" "}
            <button
              type="button"
              className="tv-link"
              onClick={() => onOpenSource(result.sourceId)}
            >
              Open it
            </button>
          </p>
        </div>
      )}
      {result?.kind === "answer" && (
        <div className="tv-panel" aria-live="polite">
          <div className="tv-section-head">
            <span className="tv-eyebrow">From your brain</span>
            <button
              type="button"
              className="tv-btn tv-ghost"
              onClick={() => setResult(null)}
            >
              Close
            </button>
          </div>
          <p className="tv-faint">
            You asked: <b>{result.question}</b>
          </p>
          {result.hits.length === 0 ? (
            <p>Nothing in your brain answers that yet.</p>
          ) : (
            result.hits.map((h) => {
              const quote = h.type === "fact" ? h.evidence[0] : undefined;
              // A fact is never shown without its quote.
              if (h.type === "fact" && !quote) return null;
              return (
                <div className="tv-hit" key={`${h.type}:${h.id}`}>
                  <span
                    className={h.type === "fact" ? "tv-tag tv-ok" : "tv-tag"}
                  >
                    {h.type === "fact"
                      ? "Reviewed"
                      : "Original, not reviewed yet"}
                  </span>
                  <p>{h.type === "fact" ? h.text : h.snippet}</p>
                  <button
                    type="button"
                    className="tv-cite"
                    onClick={() => onOpenSource(quote ? quote.source_id : h.id)}
                  >
                    {quote
                      ? `“${quote.quote}”`
                      : h.type === "original"
                        ? h.title
                        : ""}
                  </button>
                </div>
              );
            })
          )}
          <p className="tv-faint">Answers come only from what is saved here.</p>
        </div>
      )}
    </div>
  );
}
