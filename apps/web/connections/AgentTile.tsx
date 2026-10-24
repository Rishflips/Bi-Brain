import { useRef, useState } from "react";
import { AddAgent } from "./AddAgent.tsx";
import { ConnectionList } from "./ConnectionList.tsx";
import type { AgentInfo, Api, Grant } from "./types.ts";

type Props = {
  api: Api;
  info: AgentInfo;
  available: boolean;
  reason: string | null;
  loading: boolean;
  projects: { id: string; title: string }[];
  projectId: string;
  grants: Grant[];
  onChanged: () => Promise<void> | void;
};

export function AgentTile({ api, info, available, reason, loading, projects, projectId, grants, onChanged }: Props) {
  const [adding, setAdding] = useState(false);
  const addButton = useRef<HTMLButtonElement>(null);
  const headingId = `cx-${info.client}-h`;
  const lastFolder = grants.find((g) => g.folder)?.folder ?? "";

  return (
    <section className="cx-tile" aria-labelledby={headingId}>
      <div className="cx-head">
        <span className="cx-mark" aria-hidden="true">
          {info.name.split(" ").map((w) => w[0]).join("")}
        </span>
        <div className="cx-head-text">
          <h2 id={headingId}>{info.name}</h2>
          <p className="tv-faint">
            {loading ? "Checking this computer…" : !available ? reason : info.found ? "Found on this computer" : "Not found on this computer"}
          </p>
        </div>
      </div>
      <ConnectionList api={api} grants={grants} projects={projects} hint={info.hint} onChanged={onChanged} />
      {available && !adding && (
        <button ref={addButton} type="button" className="tv-btn tv-primary tv-sm" onClick={() => setAdding(true)}>
          Add to {info.name}
        </button>
      )}
      {available && adding && (
        <AddAgent
          api={api}
          info={info}
          projects={projects}
          projectId={projectId}
          lastFolder={lastFolder}
          onCancel={() => {
            setAdding(false);
            requestAnimationFrame(() => addButton.current?.focus());
          }}
          onAdded={async () => {
            setAdding(false);
            await onChanged();
          }}
        />
      )}
    </section>
  );
}
