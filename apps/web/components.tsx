import type { Entity, Evidence } from "../../packages/contracts/index.ts";
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
