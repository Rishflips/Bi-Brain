import { useEffect, useMemo, useState } from "react";
import type { Api } from "./types.ts";

type Props = {
  api: Api;
  projects: { id: string; title: string }[];
  agentNamesByProject: Record<string, string[]>;
  onOpen: (projectId: string) => void;
  /** Changing this value counts the facts again. */
  refreshKey?: unknown;
};

type Counts = Record<string, number | "error">;

export function ProjectCards({
  api,
  projects,
  agentNamesByProject,
  onOpen,
  refreshKey,
}: Props) {
  const [facts, setFacts] = useState<Counts>({});
  // Callers build a new array on every render; depend on the ids only.
  const ids = projects.map((p) => p.id).join("|");
  const idList = useMemo(() => (ids ? ids.split("|") : []), [ids]);

  useEffect(() => {
    let live = true;
    void Promise.all(
      idList.map(async (id) => {
        try {
          const rows = await api<unknown[]>(
            `/claims?project_id=${encodeURIComponent(id)}`,
          );
          return [id, rows.length] as const;
        } catch {
          return [id, "error"] as const;
        }
      }),
    ).then((rows) => {
      if (live) setFacts(Object.fromEntries(rows));
    });
    return () => {
      live = false;
    };
  }, [api, idList, refreshKey]);

  return (
    <div className="tv-projects">
      {projects.map((p) => {
        const n = facts[p.id];
        const agents = (agentNamesByProject[p.id] ?? []).length;
        return (
          <div className="tv-proj" key={p.id}>
            <button
              type="button"
              className="tv-proj-name"
              onClick={() => onOpen(p.id)}
            >
              {p.title}
            </button>
            <p className="tv-faint">
              {n === undefined
                ? "Counting…"
                : n === "error"
                  ? "Facts unavailable right now"
                  : `${n} ${n === 1 ? "fact" : "facts"}`}
            </p>
            <p className="tv-faint">
              {agents === 0
                ? "No agent connected"
                : `${agents} ${agents === 1 ? "agent" : "agents"} connected`}
            </p>
          </div>
        );
      })}
    </div>
  );
}
