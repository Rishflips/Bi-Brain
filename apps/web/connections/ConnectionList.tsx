import { useState } from "react";
import { friendlyError } from "../today/BriefCard.tsx";
import { shortDate } from "../brain/format.ts";
import type { Api, Grant } from "./types.ts";

type Props = {
  api: Api;
  grants: Grant[];
  projects: { id: string; title: string }[];
  hint?: string;
  onChanged: () => Promise<void> | void;
};

const live = (g: Grant) => g.status === "Connected" || g.status === "Not connected";

/** Current connections with Revoke, then ended ones folded away. Shared by every tile. */
export function ConnectionList({ api, grants, projects, hint = "", onChanged }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = grants.filter(live);
  const ended = grants.filter((g) => !live(g));
  const title = (ids: string[]) => ids.map((id) => projects.find((p) => p.id === id)?.title ?? "Project").join(", ");

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
    <>
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
                {g.status !== "Connected" && g.folder && hint && <p className="tv-faint">{hint}</p>}
              </div>
              <button
                type="button"
                className="tv-btn tv-ghost tv-sm"
                aria-label={g.folder ? `Revoke access for ${g.folder}` : "Revoke"}
                disabled={busy === g.id}
                onClick={() => void revoke(g.id)}
              >
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
    </>
  );
}
