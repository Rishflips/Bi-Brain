import type { Evidence } from "../../packages/contracts/index.ts";

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
            See original · version {e.source_version} · passage {e.start}–
            {e.end}
          </button>
        </blockquote>
      ))}
    </div>
  );
}
