// apps/web/brain/TrueNow.tsx
import { useRef, useState } from "react";
import { friendlyError } from "../today/BriefCard.tsx";
import { shortDate } from "./format.ts";
import type { Api, Done, Fact, OpenSourceOptions } from "./types.ts";

type Props = {
  api: Api;
  facts: Fact[];
  onOpenSource: (id: string, opts?: OpenSourceOptions) => void;
  onDone: Done;
  onError: (message: string | null) => void;
};

export function TrueNow({ api, facts, onOpenSource, onDone, onError }: Props) {
  return (
    <section className="tv-section" aria-labelledby="yb-true-h">
      <div className="tv-section-head">
        <h3 id="yb-true-h">True now</h3>
        <span className="tv-faint">Each fact links to its original</span>
      </div>
      {facts.length === 0 ? (
        <p className="tv-faint">No reviewed facts yet. Keep a suggestion on Today, or add a fact from an original.</p>
      ) : (
        <ul className="yb-list">
          {facts.map((f) => (
            <FactRow key={f.id} fact={f} api={api} onOpenSource={onOpenSource} onDone={onDone} onError={onError} />
          ))}
        </ul>
      )}
    </section>
  );
}

function FactRow({ fact, api, onOpenSource, onDone, onError }: Omit<Props, "facts"> & { fact: Fact }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(fact.value);
  // The page re-reads every few seconds. An open edit stays pinned to the version
  // it started from, so a change made elsewhere meanwhile is refused, not overwritten.
  const [base, setBase] = useState({ version: fact.version, value: fact.value });
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const evidence = fact.evidence[0];

  async function run(fn: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    onError(null);
    try {
      await fn();
    } catch (e) {
      onError(friendlyError(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  const save = () =>
    run(async () => {
      const value = draft.trim();
      if (!value) throw new Error("Write the fact before saving it.");
      if (value.length > 1000) throw new Error("Keep a fact under 1,000 characters.");
      const before = base.value;
      const r = await api<{ id: string; version: number; unchanged: boolean }>(`/claims/${fact.id}/revise`, {
        expected_version: base.version,
        value,
      });
      setEditing(false);
      if (r.unchanged) {
        await onDone("Nothing changed.");
        return;
      }
      await onDone(`Saved as version ${r.version}.`, async () => {
        await api(`/claims/${fact.id}/revise`, { expected_version: r.version, value: before });
      });
    });

  const stillTrue = () =>
    run(async () => {
      await api(`/claims/${fact.id}/confirm`, {});
      await onDone("Marked as still true.");
    });

  if (editing)
    return (
      <li className="yb-item">
        <div className="yb-fix">
          <label className="yb-eyebrow" htmlFor={`yb-ef-${fact.id}`}>
            Edit fact
          </label>
          <textarea
            id={`yb-ef-${fact.id}`}
            rows={2}
            maxLength={1000}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setEditing(false);
            }}
          />
          <div className="tv-actions">
            <button type="button" className="tv-btn tv-primary tv-sm" disabled={busy} onClick={() => void save()}>
              Save as version {base.version + 1}
            </button>
            <button type="button" className="tv-btn tv-ghost tv-sm" disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
          <p className="tv-faint">The original stays as it was. Earlier versions stay in history.</p>
        </div>
      </li>
    );

  return (
    <li className="yb-item">
      <div className="yb-item-row">
        <p className="yb-fact">{fact.text}</p>
        {fact.editable && (
          <button
            type="button"
            className="tv-btn tv-ghost tv-sm"
            onClick={() => {
              setDraft(fact.value);
              setBase({ version: fact.version, value: fact.value });
              setEditing(true);
            }}
          >
            Edit
          </button>
        )}
      </div>
      <div className="yb-meta">
        {fact.stale ? (
          <span className="tv-tag tv-attn">Not checked since {shortDate(fact.checked_at)}</span>
        ) : (
          <span className="tv-tag tv-ok">Checked {shortDate(fact.checked_at)}</span>
        )}
        <span className="tv-faint">version {fact.version}</span>
        {fact.stale && (
          <button type="button" className="tv-link" disabled={busy} onClick={() => void stillTrue()}>
            Still true
          </button>
        )}
        {evidence && (
          <button
            type="button"
            className="tv-link"
            onClick={() => onOpenSource(evidence.source_id, { quote: evidence.quote, factId: fact.id })}
          >
            Open the original
          </button>
        )}
      </div>
    </li>
  );
}
