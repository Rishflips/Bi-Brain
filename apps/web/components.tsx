import type { Entity, Evidence } from "../../packages/contracts/index.ts";
export function CurrentKnowledge({
  pages,
  gates,
  openSource,
  review,
}: {
  pages: any[];
  gates: Entity[];
  openSource: (id: string) => void;
  review: (id: string, version: number, action: "accept" | "reject") => void;
}) {
  return (
    <div className="knowledge-workspace">
      <div className="section-heading">
        <h2>Current understanding</h2>
        <span className="muted">Accepted facts first · originals below</span>
      </div>
      {pages.length ? (
        pages.map((page) => (
          <article key={page.entity}>
            <h3>{page.entity}</h3>
            {page.current.map((claim: Entity) => (
              <div key={claim.id} className="claim-row">
                <strong>{claim.data.aspect}</strong>: {String(claim.data.value)}{" "}
                <small>
                  Current ·{" "}
                  {claim.data.authority === "owner_reviewed"
                    ? "reviewed by you"
                    : "literal source evidence"}
                </small>
                <EvidenceList
                  items={claim.data.evidence ?? []}
                  onOpen={openSource}
                />
              </div>
            ))}
            {page.conflicts.length ? (
              <p className="alert">
                Conflicting accepted values need your review.
              </p>
            ) : null}
            {page.uncertain.length ? (
              <p className="muted">
                {page.uncertain.length} proposed change
                {page.uncertain.length === 1 ? "" : "s"} awaits review.
              </p>
            ) : null}
            {page.open_intents.length ? (
              <p>
                Open intention:{" "}
                {page.open_intents.map((i: any) => i.title).join(", ")}
              </p>
            ) : null}
            <details>
              <summary>History and provenance</summary>
              {page.history.length ? (
                page.history.map((c: Entity) => (
                  <p key={c.id}>
                    {c.data.aspect}: {String(c.data.value)} · {c.data.status}{" "}
                    {c.data.valid_from}–{c.data.valid_to ?? "open"}
                  </p>
                ))
              ) : (
                <p>No retired claims in this view.</p>
              )}
            </details>
          </article>
        ))
      ) : (
        <article className="quiet">
          <h3>No accepted understanding yet.</h3>
          <p>
            Saved originals appear below. Recognized facts wait for your review
            before they become current understanding.
          </p>
        </article>
      )}
      {gates.length ? (
        <section>
          <h2>Needs your review</h2>
          {gates.map((g) => (
            <article key={g.id} data-proposal-id={g.id}>
              <h3>
                {g.data.entity ??
                  (g.data.type === "intent"
                    ? "Proposed intention"
                    : "New material")}
              </h3>
              <p>
                {g.data.type === "intent"
                  ? `${g.data.intent?.action ?? "Propose"} intention${g.data.intent?.target_id ? ` ${g.data.intent.target_id}` : ""}`
                  : g.data.field
                    ? `${g.data.field.aspect}: ${String(g.data.field.value)}`
                    : "No factual claim was inferred."}
              </p>
              <p className="muted">{g.data.reasons.join(" · ")}</p>
              <EvidenceList items={g.data.evidence ?? []} onOpen={openSource} />
              <div className="actions">
                {g.data.raw_id ? (
                  <button onClick={() => openSource(g.data.raw_id)}>
                    Read original
                  </button>
                ) : null}
                {g.data.type === "intent" && g.data.intent ? (
                  <button onClick={() => review(g.id, g.version, "accept")}>
                    Approve intention
                  </button>
                ) : g.data.field && g.data.evidence?.length ? (
                  <button onClick={() => review(g.id, g.version, "accept")}>
                    Accept reviewed claim
                  </button>
                ) : null}
                <button onClick={() => review(g.id, g.version, "reject")}>
                  Keep raw only
                </button>
              </div>
            </article>
          ))}
        </section>
      ) : null}
    </div>
  );
}
export function EvidenceList({
  items,
  onOpen,
}: {
  items: Evidence[];
  onOpen: (id: string) => void;
}) {
  return (
    <div className="evidence">
      {items.map((e, i) => (
        <blockquote key={`${e.source_id}-${i}`}>
          <p>{e.quote}</p>
          <button className="link" onClick={() => onOpen(e.source_id)}>
            See original · version {e.source_version}
          </button>
        </blockquote>
      ))}
    </div>
  );
}
export function ProposalCard({
  item,
  project,
  onReview,
  onSnooze,
}: {
  item: Entity;
  project: string;
  onReview: (item: Entity) => void;
  onSnooze: (item: Entity) => void;
}) {
  return (
    <article className="featured">
      <span className="pill">Ready to review · {project}</span>
      <h2>{item.data.title}</h2>
      <p>{item.data.reason}</p>
      <p className="muted">
        Based on {item.data.evidence.length} sources · Hypothesis · Prepared,
        not applied
      </p>
      <button className="primary" onClick={() => onReview(item)}>
        Review the plan
      </button>
      <button onClick={() => onSnooze(item)}>Later</button>
    </article>
  );
}
