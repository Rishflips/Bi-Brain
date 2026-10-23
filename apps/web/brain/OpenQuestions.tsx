// apps/web/brain/OpenQuestions.tsx
import { useEffect, useRef, useState } from "react";
import { friendlyError } from "../today/BriefCard.tsx";
import { shortDate } from "./format.ts";
import type { Api, Done, OpenQuestion, OpenSourceOptions } from "./types.ts";

type Props = {
  api: Api;
  projectId: string;
  questions: OpenQuestion[];
  total: number;
  onOpenSource: (id: string, opts?: OpenSourceOptions) => void;
  onDone: Done;
  onError: (message: string | null) => void;
};

// After an answer: the signature that left the list, and the neighbour that takes focus.
type FocusTarget = { answered: string; next: string | null };

export function OpenQuestions({ api, projectId, questions, total, onOpenSource, onDone, onError }: Props) {
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<FocusTarget | null>(null);
  const lock = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());

  // Runs once the re-read has rendered. Only the question this person just answered moves
  // focus, so an unrelated refresh never does.
  useEffect(() => {
    if (!pending) return;
    if (!questions.some((q) => q.signature === pending.answered)) {
      const target = pending.next ? buttons.current.get(pending.next) : undefined;
      (target ?? heading.current)?.focus();
    }
    setPending(null);
  }, [pending, questions]);

  async function answer(q: OpenQuestion) {
    if (lock.current) return;
    lock.current = true;
    const at = questions.findIndex((x) => x.signature === q.signature);
    const neighbour = questions[at + 1] ?? questions[at - 1];
    setBusy(true);
    onError(null);
    try {
      await api("/questions/answer", { project_id: projectId, signature: q.signature, answered: true });
      await onDone("Marked as answered.", async () => {
        await api("/questions/answer", { project_id: projectId, signature: q.signature, answered: false });
      });
      setPending({ answered: q.signature, next: neighbour?.signature ?? null });
    } catch (e) {
      onError(friendlyError(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="tv-section" aria-labelledby="yb-q-h">
      <div className="tv-section-head">
        <h3 id="yb-q-h" ref={heading} tabIndex={-1}>
          Open questions
        </h3>
        <span className="tv-faint">Found in your originals</span>
      </div>
      {questions.length === 0 ? (
        <p className="tv-faint">
          Nothing open. A line that starts with “Open question:”, or a question in a short note, shows up here.
        </p>
      ) : (
        <ul className="yb-list">
          {questions.map((q) => (
            <li key={q.signature} className="yb-item">
              <div className="yb-item-row">
                <p className="yb-fact">{q.text}</p>
                <button
                  ref={(el) => {
                    if (el) buttons.current.set(q.signature, el);
                    else buttons.current.delete(q.signature);
                  }}
                  type="button"
                  className="tv-btn tv-ghost tv-sm"
                  disabled={busy}
                  onClick={() => void answer(q)}
                >
                  Mark answered
                </button>
              </div>
              <div className="yb-meta">
                <span className="tv-faint">
                  {q.source_title} · {shortDate(q.captured_at)}
                </span>
                <button
                  type="button"
                  className="tv-link"
                  onClick={() => onOpenSource(q.evidence.source_id, { quote: q.evidence.quote })}
                >
                  Open the original
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {total > questions.length && (
        <p className="tv-faint">
          Showing {questions.length} of {total} open questions.
        </p>
      )}
    </section>
  );
}
