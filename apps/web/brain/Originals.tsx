import { useState } from "react";
import { shortDate } from "./format.ts";
import type { OpenSourceOptions, Original } from "./types.ts";

const FROM: Record<Original["from"], string> = {
  you: "Saved by you",
  agent: "From an agent",
  import: "Imported",
};

type Props = {
  originals: Original[];
  total: number;
  onOpenSource: (id: string, opts?: OpenSourceOptions) => void;
  onSave: () => void;
};

export function Originals({ originals, total, onOpenSource, onSave }: Props) {
  const [shown, setShown] = useState(50);
  return (
    <section className="tv-section" aria-labelledby="yb-orig-h">
      <div className="tv-section-head">
        <h3 id="yb-orig-h">Originals</h3>
        <span className="tv-faint">Kept exactly as saved</span>
        <button type="button" className="tv-link" onClick={onSave}>
          Save to this project
        </button>
      </div>
      {originals.length === 0 ? (
        <p className="tv-faint">Nothing saved here yet.</p>
      ) : (
        <ol className="yb-timeline">
          {originals.slice(0, shown).map((o) => (
            <li key={o.id}>
              <time className="yb-when" dateTime={o.captured_at}>
                {shortDate(o.captured_at)}
              </time>
              <div className="yb-orig">
                <button type="button" className="yb-src" onClick={() => onOpenSource(o.id)}>
                  {o.title}
                </button>
                <span className="tv-faint">
                  {FROM[o.from]}
                  {o.private ? " · Private" : ""}
                  {o.version > 1 ? ` · version ${o.version}` : ""}
                </span>
              </div>
            </li>
          ))}
        </ol>
      )}
      {shown < originals.length && (
        <button type="button" className="tv-btn tv-sm" onClick={() => setShown((n) => n + 50)}>
          Show 50 more
        </button>
      )}
      {total > originals.length && shown >= originals.length && (
        <p className="tv-faint">
          Showing the newest {originals.length} of {total}. Search finds the rest.
        </p>
      )}
    </section>
  );
}
