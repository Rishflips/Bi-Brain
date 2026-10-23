import { useState } from "react";
import type { Entity } from "../../../packages/contracts/index.ts";
import { EvidenceList } from "../components.tsx";
import { friendlyError } from "../today/BriefCard.tsx";
import type { Api, OpenSourceOptions } from "./types.ts";

type Props = {
  api: Api;
  needsDecision: Entity[];
  history: Entity[];
  onOpenSource: (id: string, opts?: OpenSourceOptions) => void;
  onDone: (message: string) => Promise<void>;
  onError: (message: string | null) => void;
};

export function PendingReview({ api, needsDecision, history, onOpenSource, onDone, onError }: Props) {
  const [busy, setBusy] = useState(false);
  if (!needsDecision.length && !history.length) return null;
  async function review(g: Entity, action: "accept" | "reject" | "undo") {
    if (busy) return;
    setBusy(true);
    onError(null);
    try {
      await api(`/proposals/gate/${g.id}/review`, { expected_version: g.version, action });
      await onDone(
        action === "undo"
          ? "Correction undone without erasing history."
          : action === "accept"
            ? "Approved."
            : "Kept as an original only.",
      );
    } catch (e) {
      onError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="tv-section" aria-label="Needs a decision here">
      {needsDecision.length > 0 && (
        <>
          <div className="tv-section-head">
            <h3>Needs a decision here</h3>
            <span className="tv-faint">These are not single facts, so they wait here instead of on Today.</span>
          </div>
          <ul className="yb-list">
            {needsDecision.map((g) => (
              <li key={g.id}>
                <article className="yb-item" data-proposal-id={g.id}>
                  <h4 className="yb-fact">
                    {g.data.entity ?? (g.data.type === "intent" ? "Proposed intention" : "New material")}
                  </h4>
                  <p className="tv-faint">
                    {g.data.type === "intent"
                      ? `${g.data.intent?.action ?? "Propose"} intention`
                      : g.data.field
                        ? `${g.data.field.aspect}: ${String(g.data.field.value)}`
                        : "No single fact was found in this."}
                  </p>
                  <EvidenceList items={g.data.evidence ?? []} onOpen={(id) => onOpenSource(id)} />
                  <div className="tv-actions">
                    {g.data.raw_id ? (
                      <button type="button" className="tv-btn tv-sm" onClick={() => onOpenSource(g.data.raw_id)}>
                        Read original
                      </button>
                    ) : null}
                    {g.data.type === "intent" && g.data.intent ? (
                      <button type="button" className="tv-btn tv-primary tv-sm" disabled={busy} onClick={() => void review(g, "accept")}>
                        Approve intention
                      </button>
                    ) : g.data.field && g.data.evidence?.length ? (
                      <button type="button" className="tv-btn tv-primary tv-sm" disabled={busy} onClick={() => void review(g, "accept")}>
                        Accept reviewed claim
                      </button>
                    ) : null}
                    <button type="button" className="tv-btn tv-ghost tv-sm" disabled={busy} onClick={() => void review(g, "reject")}>
                      Keep raw only
                    </button>
                  </div>
                </article>
              </li>
            ))}
          </ul>
        </>
      )}
      {history.length > 0 && (
        <details className="yb-details">
          <summary>Reviewed decision history</summary>
          <ul className="yb-list">
            {history.map((g) => (
              <li key={g.id}>
                <article className="yb-item">
                  <h4 className="yb-fact">
                    {g.data.entity}: {String(g.data.field?.value ?? "")}
                  </h4>
                  <p className="tv-faint">
                    {g.data.status === "accepted"
                      ? "Approved by you"
                      : g.data.status === "reverted"
                        ? "Undone by you"
                        : "Earlier decision kept"}
                  </p>
                  <EvidenceList items={g.data.evidence ?? []} onOpen={(id) => onOpenSource(id)} />
                  {g.data.status === "accepted" ? (
                    <button type="button" className="tv-btn tv-sm" disabled={busy} onClick={() => void review(g, "undo")}>
                      Undo correction
                    </button>
                  ) : null}
                  <p className="tv-faint">Undo is refused if a later edit or a changed original makes it unsafe.</p>
                </article>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
