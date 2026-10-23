export type Api = <T = any>(
  path: string,
  body?: unknown,
  method?: string,
) => Promise<T>;
export type BriefEvidence = {
  source_id: string;
  source_version: number;
  quote: string;
};
export type BriefItem = {
  signature: string;
  kind:
    | "correction"
    | "proposal"
    | "failed_job"
    | "agent_memory"
    | "memory"
    | "stale";
  project_id: string;
  title: string;
  why: string;
  before?: string;
  evidence: BriefEvidence[];
  target: {
    type: "gate" | "proposal" | "job" | "claim";
    id: string;
    version: number;
  };
  created_at: string;
  source_id?: string;
  aspect?: string;
  value?: string;
};
export type Brief = { items: BriefItem[]; waiting: number };
export type AskHit =
  | {
      type: "fact";
      id: string;
      project_id: string;
      text: string;
      evidence: BriefEvidence[];
    }
  | {
      type: "original";
      id: string;
      project_id: string;
      title: string;
      snippet: string;
      source_version: number;
    };
export type TodayProps = {
  api: Api;
  projects: { id: string; title: string }[];
  sourceCount: number;
  /** The current saved notes. The receipt follows these, never its own copy. */
  notes: { id: string; title: string }[];
  /** Sources whose receipt must go now (for example after a correction). */
  retiredSourceIds: string[];
  backgroundOn: boolean;
  agentNamesByProject: Record<string, string[]>;
  onOpenSource: (id: string) => void;
  onOpenProject: (projectId: string) => void;
  onNavigate: (to: "Your brain" | "Connections") => void;
  onChanged: () => void;
  /** null: not loaded yet. "unavailable": the last check failed. */
  onBriefCount?: (n: number | null | "unavailable") => void;
};
