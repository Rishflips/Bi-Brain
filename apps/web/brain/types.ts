import type { Entity } from "../../../packages/contracts/index.ts";
import type { Api, OpenSourceOptions } from "../today/types.ts";

export type { Api, OpenSourceOptions };

export type FactEvidence = {
  source_id: string;
  source_version: number;
  start: number;
  end: number;
  quote: string;
  source_title: string;
};
export type Fact = {
  id: string;
  version: number;
  text: string;
  aspect: string;
  value: string;
  editable: boolean;
  edited_by_owner: boolean;
  checked_at: string;
  stale: boolean;
  evidence: FactEvidence[];
};
export type OpenQuestion = {
  signature: string;
  text: string;
  source_title: string;
  captured_at: string;
  evidence: { source_id: string; source_version: number; start: number; end: number; quote: string };
};
export type Original = {
  id: string;
  version: number;
  title: string;
  captured_at: string;
  from: "you" | "agent" | "import";
  private: boolean;
};
export type ProjectView = {
  project: { id: string; title: string };
  facts: Fact[];
  questions: OpenQuestion[];
  questions_total: number;
  originals: Original[];
  originals_total: number;
  waiting_for_review: number;
  needs_decision: Entity[];
  decision_history: Entity[];
};
export type FactHistoryEntry = {
  version: number;
  text: string;
  status: string;
  edited_by_owner: boolean;
  at: string;
};
export type SearchResults = {
  facts: { id: string; project_id: string; text: string; evidence: Omit<FactEvidence, "source_title">[] }[];
  originals: { id: string; project_id: string; version: number; title: string; snippet: string }[];
};
export type Done = (message: string, undo?: () => Promise<void>) => Promise<void>;
export type GoalActions = {
  choose: (projectId: string) => void;
  setPreparation: (goal: Entity, enabled: boolean) => void;
  prepare: (goal: Entity) => void;
  toggleStatus: (goal: Entity) => void;
  editPlan: (goal: Entity) => void;
};
export type BrainProps = {
  api: Api;
  projects: { id: string; title: string; watched?: boolean }[];
  /** The project on screen. "inbox" when nothing else was chosen. */
  projectId: string;
  onSelectProject: (id: string) => void;
  agentNamesByProject: Record<string, string[]>;
  goals: Entity[];
  busy: boolean;
  /** Changing this value reads the project again. */
  refreshKey: unknown;
  /** A plain line under the search field, for example while search is using words only. */
  searchNote?: string | null;
  onOpenSource: (id: string, opts?: OpenSourceOptions) => void;
  onNewProject: () => void;
  onSave: () => void;
  onPreviewHandoff: (projectId: string) => void;
  onNavigate: (to: "Today") => void;
  goalActions: GoalActions;
  /** Called after something here changes what the rest of the app shows (for example Watch). */
  onChanged?: () => void | Promise<void>;
};
