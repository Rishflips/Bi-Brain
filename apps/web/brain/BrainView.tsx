import { useCallback, useEffect, useRef, useState } from "react";
import { friendlyError } from "../today/BriefCard.tsx";
import { useUndoToast } from "../today/useUndoToast.tsx";
import { GoalsSection } from "./GoalsSection.tsx";
import { OpenQuestions } from "./OpenQuestions.tsx";
import { Originals } from "./Originals.tsx";
import { PendingReview } from "./PendingReview.tsx";
import { ProjectList } from "./ProjectList.tsx";
import { TrueNow } from "./TrueNow.tsx";
import type { BrainProps, Done, ProjectView } from "./types.ts";

export function BrainView(props: BrainProps) {
  const { api, projectId, refreshKey } = props;
  const [view, setView] = useState<ProjectView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const { toast, show } = useUndoToast();
  // Only the newest read may land, and none after the view is gone.
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const next = await api<ProjectView>(`/brain/projects/${encodeURIComponent(projectId)}`);
      if (mine !== seq.current) return;
      setView(next);
      setLoadError(null);
    } catch (e) {
      if (mine !== seq.current) return;
      setLoadError(friendlyError(e));
    }
  }, [api, projectId]);

  useEffect(() => {
    setView(null);
    setActionError(null);
  }, [projectId]);
  useEffect(() => {
    void load();
  }, [load, refreshKey]);
  useEffect(
    () => () => {
      seq.current += 1;
    },
    [],
  );

  const done = useCallback<Done>(
    async (message, undo) => {
      setActionError(null);
      await load();
      show(
        message,
        undo &&
          (async () => {
            try {
              await undo();
            } catch (e) {
              setActionError(friendlyError(e));
              throw e;
            } finally {
              await load();
            }
          }),
      );
    },
    [load, show],
  );

  const title =
    view?.project.title ?? props.projects.find((p) => p.id === projectId)?.title ?? "Project";
  const agents = (props.agentNamesByProject[projectId] ?? []).length;
  const waiting = view?.waiting_for_review ?? 0;

  return (
    <section className="yb" aria-labelledby="yb-h">
      <h1 id="yb-h" className="tv-title">
        Your brain
      </h1>
      {/* Task 9 adds BrainSearch here. */}
      <div className="yb-layout">
        <ProjectList
          projects={props.projects}
          current={projectId}
          onSelect={props.onSelectProject}
          onNew={props.onNewProject}
        />
        <div className="yb-detail">
          <header className="yb-head">
            <div className="yb-head-text">
              <h2>{title}</h2>
              <p className="tv-faint">
                {agents ? `${agents} ${agents === 1 ? "agent" : "agents"} connected` : "No agent connected"}
              </p>
            </div>
            <button type="button" className="tv-btn tv-sm" onClick={() => props.onPreviewHandoff(projectId)}>
              Preview handoff
            </button>
          </header>
          {loadError && (
            <p className="tv-error" role="alert">
              {loadError}
            </p>
          )}
          {actionError && (
            <p className="tv-error" role="alert">
              {actionError}
            </p>
          )}
          {!view && !loadError && (
            <p className="tv-faint" role="status">
              Loading…
            </p>
          )}
          {view && (
            <>
              {waiting > 0 && (
                <p className="yb-waiting">
                  <span>
                    {waiting} {waiting === 1 ? "thing" : "things"} to look at on Today.
                  </span>
                  <button type="button" className="tv-link" onClick={() => props.onNavigate("Today")}>
                    Review on Today
                  </button>
                </p>
              )}
              <TrueNow
                api={api}
                facts={view.facts}
                onOpenSource={props.onOpenSource}
                onDone={done}
                onError={setActionError}
              />
              <OpenQuestions
                api={api}
                projectId={projectId}
                questions={view.questions}
                total={view.questions_total}
                onOpenSource={props.onOpenSource}
                onDone={done}
                onError={setActionError}
              />
              <Originals
                originals={view.originals}
                total={view.originals_total}
                onOpenSource={props.onOpenSource}
                onSave={props.onSave}
              />
              <PendingReview
                api={api}
                needsDecision={view.needs_decision}
                history={view.decision_history}
                onOpenSource={props.onOpenSource}
                onDone={(m) => done(m)}
                onError={setActionError}
              />
              <GoalsSection
                goals={props.goals.filter((g) => g.project_id === projectId)}
                busy={props.busy}
                projectId={projectId}
                actions={props.goalActions}
              />
            </>
          )}
        </div>
      </div>
      {toast}
    </section>
  );
}
