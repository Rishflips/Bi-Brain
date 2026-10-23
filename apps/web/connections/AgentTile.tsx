import { useState } from "react";
import { friendlyError } from "../today/BriefCard.tsx";
import { shortDate } from "../brain/format.ts";
import { AddAgent } from "./AddAgent.tsx";
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

const live = (g: Grant) => g.status === "Connected" || g.status === "Not connected";

export function AgentTile({ api, info, available, reason, loading, projects, projectId, grants, onChanged }: Props) {
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = grants.filter(live);
  const ended = grants.filter((g) => !live(g));
  const title = (ids: string[]) => ids.map((id) => projects.find((p) => p.id === id)?.title ?? "Project").join(", ");
  const headingId = `cx-${info.client}-h`;

  async function revoke(id: string) {
    setBusy(id);
    setError(null);
    try {
      await api(`/agent-grants/${id}`, {}, "DELETE");
      await onChanged();
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(null);
    }
  }

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
      {current.length > 0 && (
        <ul className="cx-list">
          {current.map((g) => (
            <li key={g.id} className="cx-row">
              <div className="cx-row-text">
                <p className="cx-strong">
                  {g.status === "Connected" ? `Connected · last used ${shortDate(g.last_verified_at!)}` : "Waiting for its first call"}
                </p>
                <p className="tv-faint">
                  Reads {title(g.projects)} · {g.operations.includes("propose_memory") ? "suggests memories" : "read only"}
                  {g.folder ? ` · ${g.folder}` : ""}
                </p>
                {g.status !== "Connected" && info.hint && <p className="tv-faint">{info.hint}</p>}
              </div>
              <button type="button" className="tv-btn tv-ghost tv-sm" disabled={busy === g.id} onClick={() => void revoke(g.id)}>
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p className="tv-error" role="alert">
          {error}
        </p>
      )}
      {available && !adding && (
        <button type="button" className="tv-btn tv-primary tv-sm" onClick={() => setAdding(true)}>
          Add to {info.name}
        </button>
      )}
      {available && adding && (
        <AddAgent
          api={api}
          info={info}
          projects={projects}
          projectId={projectId}
          lastFolder={current.find((g) => g.folder)?.folder ?? ended.find((g) => g.folder)?.folder ?? ""}
          onCancel={() => setAdding(false)}
          onAdded={async () => {
            setAdding(false);
            await onChanged();
          }}
        />
      )}
      {ended.length > 0 && (
        <details className="cx-ended">
          <summary>Earlier connections ({ended.length})</summary>
          <ul className="cx-list">
            {ended.map((g) => (
              <li key={g.id} className="cx-row">
                <p className="tv-faint">
                  {title(g.projects)} · {g.status === "Revoked" ? "access ended" : "this access expired"}
                  {g.folder ? ` · ${g.folder}` : ""}
                </p>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
