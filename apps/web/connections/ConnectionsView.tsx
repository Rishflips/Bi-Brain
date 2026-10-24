import { useCallback, useEffect, useRef, useState } from "react";
import { friendlyError } from "../today/BriefCard.tsx";
import { AgentTile } from "./AgentTile.tsx";
import { ConnectionList } from "./ConnectionList.tsx";
import type { AgentInfo, AgentsStatus, Api, Grant } from "./types.ts";

const KNOWN: AgentInfo[] = [
  { client: "codex", name: "Codex", found: false, file: ".codex/config.toml", hint: "" },
  { client: "claude-code", name: "Claude Code", found: false, file: ".mcp.json", hint: "" },
  { client: "cursor", name: "Cursor", found: false, file: ".cursor/mcp.json", hint: "" },
];

type Props = {
  api: Api;
  projects: { id: string; title: string }[];
  projectId: string;
  grants: Grant[];
  onChanged: () => Promise<void> | void;
  onPreviewHandoff: (projectId: string) => void;
  onManualSetup: () => void;
};

export function ConnectionsView({ api, projects, projectId, grants, onChanged, onPreviewHandoff, onManualSetup }: Props) {
  const [status, setStatus] = useState<AgentsStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  // One detection request at a time. A request asked for while one runs is
  // queued once, and an answer that arrives after unmount is ignored.
  const inFlight = useRef(false);
  const again = useRef(false);
  const mounted = useRef(true);
  const refresh = useCallback(async () => {
    if (inFlight.current) {
      again.current = true;
      return;
    }
    inFlight.current = true;
    try {
      const s = await api<AgentsStatus>("/agents");
      if (mounted.current) {
        setStatus(s);
        setError(null);
      }
    } catch (e) {
      if (mounted.current) setError(friendlyError(e));
    } finally {
      inFlight.current = false;
      if (again.current && mounted.current) {
        again.current = false;
        void refresh();
      }
    }
  }, [api]);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    // The person may install an agent in another window, then come back.
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      mounted.current = false;
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);
  const changed = useCallback(async () => {
    await onChanged();
    void refresh();
  }, [onChanged, refresh]);
  const clients = status?.clients.length ? status.clients : KNOWN;
  // "Other" and any client this screen has no tile for end up with the handoff tile, so no live access is hidden.
  const otherGrants = grants.filter((g) => !clients.some((c) => c.client === g.client));
  return (
    <section className="cx" aria-labelledby="cx-h">
      <h1 id="cx-h" className="tv-title">
        Connections
      </h1>
      <p className="tv-faint">Agents that read your brain and write back what they learn. Each one sees only the projects you pick.</p>
      {error && (
        <p className="tv-error" role="alert">
          {error}
        </p>
      )}
      <div className="cx-tiles">
        {clients.map((info) => (
          <AgentTile
            key={info.client}
            api={api}
            info={info}
            available={!!status?.available}
            reason={status?.reason ?? null}
            loading={!status && !error}
            projects={projects}
            projectId={projectId}
            grants={grants.filter((g) => g.client === info.client)}
            onChanged={changed}
          />
        ))}
        <section className="cx-tile" aria-labelledby="cx-other-h">
          <h2 id="cx-other-h">Any other agent</h2>
          <p className="tv-faint">Copy a handoff of one project and paste it in. It gives no ongoing access.</p>
          <ConnectionList api={api} grants={otherGrants} projects={projects} onChanged={changed} />
          <div className="tv-actions">
            <button type="button" className="tv-btn tv-sm" onClick={() => onPreviewHandoff(projectId)}>
              Preview handoff
            </button>
            <button type="button" className="tv-btn tv-ghost tv-sm" onClick={onManualSetup}>
              Set up by hand
            </button>
          </div>
        </section>
      </div>
    </section>
  );
}
