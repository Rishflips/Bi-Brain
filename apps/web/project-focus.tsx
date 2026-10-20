import type { Entity, Source } from "../../packages/contracts/index.ts";

type ProjectSummary = {
  id: string;
  title: string;
  openQuestions: number;
  activeGoals: number;
};

export function ProjectOverview({
  projects,
  onSelect,
  onCreate,
}: {
  projects: ProjectSummary[];
  onSelect: (id: string) => void;
  onCreate: () => void;
}) {
  return (
    <section
      className="project-overview"
      data-ui="project-overview"
      aria-labelledby="project-overview-title"
    >
      <div className="project-focus-heading">
        <div>
          <p className="section-kicker">PROJECTS</p>
          <h2 id="project-overview-title">Pick up where you left off.</h2>
          <p>
            Open one project to see its current understanding, unanswered
            questions, chosen direction, and originals together.
          </p>
        </div>
        <button type="button" onClick={onCreate}>
          New project
        </button>
      </div>

      <div className="project-overview-grid">
        {projects.map((project) => (
          <button
            type="button"
            className="project-overview-card"
            key={project.id}
            onClick={() => onSelect(project.id)}
          >
            <span className="project-overview-title">
              <strong>{project.title}</strong>
              <span aria-hidden="true">→</span>
            </span>
            <span className="project-overview-meta">
              {project.activeGoals
                ? project.activeGoals +
                  " active " +
                  (project.activeGoals === 1 ? "goal" : "goals")
                : "No active goal"}
              {project.openQuestions
                ? " · " +
                  project.openQuestions +
                  " open " +
                  (project.openQuestions === 1 ? "question" : "questions")
                : " · No open questions"}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}

export function ProjectFocus({
  projectTitle,
  sources,
  pages,
  brief,
  goal,
  readyReviews,
  onSave,
  onOpenSource,
  onPreviewHandoff,
  onChooseGoal,
  onViewGoal,
}: {
  projectTitle: string;
  sources: Source[];
  pages: any[];
  brief: Entity | null;
  goal: Entity | null;
  readyReviews: number;
  onSave: () => void;
  onOpenSource: (id: string) => void;
  onPreviewHandoff: () => void;
  onChooseGoal: () => void;
  onViewGoal: () => void;
}) {
  const claims = pages.flatMap((page) => page.current ?? []);
  const understanding = claims.length
    ? claims.slice(0, 4).map((claim: Entity) => ({
        id: claim.id,
        label: String(claim.data.entity ?? "Current understanding"),
        text:
          claim.data.aspect === "statement"
            ? String(claim.data.value)
            : String(claim.data.aspect) + ": " + String(claim.data.value),
        evidence: claim.data.evidence?.length ?? 0,
        reviewed: claim.data.authority === "owner_reviewed",
      }))
    : (brief?.data.items ?? []).slice(0, 4).map((item: any, index: number) => ({
        id: (brief?.id ?? "brief") + "-" + index,
        label:
          item.epistemic_status === "hypothesis"
            ? "Possibility"
            : "Source-linked understanding",
        text: String(item.text),
        evidence: item.evidence?.length ?? 0,
        reviewed: false,
      }));
  const questions: string[] = (brief?.data.unknowns ?? []).slice(0, 4);
  const recentSources = [...sources]
    .sort(
      (left, right) =>
        Date.parse(right.captured_at) - Date.parse(left.captured_at),
    )
    .slice(0, 3);

  return (
    <section
      className="project-focus"
      data-ui="project-focus"
      aria-labelledby="project-focus-title"
    >
      <header className="project-focus-heading">
        <div>
          <p className="section-kicker">PROJECT FOCUS</p>
          <h2 id="project-focus-title">{projectTitle}</h2>
          <p>
            Showing {sources.length} recent{" "}
            {sources.length === 1 ? "original" : "originals"} · {claims.length}{" "}
            reviewed {claims.length === 1 ? "memory" : "memories"}
            {readyReviews
              ? " · " + readyReviews + " ready to review"
              : " · Nothing waiting for review"}
          </p>
        </div>
        <div className="project-focus-actions">
          <button type="button" className="primary" onClick={onSave}>
            Add to this project
          </button>
          <button type="button" onClick={onPreviewHandoff}>
            Preview agent handoff
          </button>
        </div>
      </header>

      <div className="project-focus-grid">
        <section className="project-focus-panel" aria-labelledby="known-title">
          <div className="project-focus-panel-heading">
            <p className="section-kicker">WHAT’S TRUE NOW</p>
            <span>{understanding.length}</span>
          </div>
          <h3 id="known-title">Current understanding</h3>
          {understanding.length ? (
            <ul className="project-focus-list">
              {understanding.map((item: any) => (
                <li key={item.id}>
                  <span>{item.label}</span>
                  <strong>{item.text}</strong>
                  <small>
                    {item.reviewed
                      ? "Reviewed by you"
                      : "From the current brief"}
                    {item.evidence
                      ? " · " +
                        item.evidence +
                        " " +
                        (item.evidence === 1 ? "source" : "sources")
                      : ""}
                  </small>
                </li>
              ))}
            </ul>
          ) : (
            <div className="project-focus-empty">
              <p>No current understanding yet.</p>
              <span>
                Save an original. BiBrain will keep it intact and ask before
                promoting any meaning.
              </span>
            </div>
          )}
        </section>

        <section
          className="project-focus-panel project-focus-questions"
          aria-labelledby="questions-title"
        >
          <div className="project-focus-panel-heading">
            <p className="section-kicker">STILL UNCLEAR</p>
            <span>{questions.length}</span>
          </div>
          <h3 id="questions-title">Open questions</h3>
          {questions.length ? (
            <ol className="project-question-list">
              {questions.map((question) => (
                <li key={question}>{question}</li>
              ))}
            </ol>
          ) : (
            <div className="project-focus-empty">
              <p>No open questions in the current brief.</p>
              <span>BiBrain will stay quiet until the saved work changes.</span>
            </div>
          )}
        </section>

        <section
          className="project-focus-panel project-focus-direction"
          aria-labelledby="direction-title"
        >
          <div className="project-focus-panel-heading">
            <p className="section-kicker">CHOSEN DIRECTION</p>
            {goal ? <span>{goal.data.status}</span> : null}
          </div>
          <h3 id="direction-title">
            {goal
              ? goal.data.title
              : "Choose what this project should move toward"}
          </h3>
          {goal ? (
            <>
              <p>{goal.data.success_criteria}</p>
              <small>
                {goal.data.plan
                  ? goal.data.plan_stale
                    ? "The earlier plan needs review because its sources changed."
                    : "An accepted plan is ready."
                  : goal.data.preparation_enabled
                    ? "BiBrain is allowed to prepare reviewable next steps for this goal."
                    : "No background preparation. You remain in control."}
              </small>
              <button type="button" className="link" onClick={onViewGoal}>
                View goal and plan
              </button>
            </>
          ) : (
            <>
              <p>
                A goal gives this project a useful direction without changing
                any saved material.
              </p>
              <button type="button" onClick={onChooseGoal}>
                Set project direction
              </button>
            </>
          )}
        </section>

        <section
          className="project-focus-panel project-focus-originals"
          aria-labelledby="originals-title"
        >
          <div className="project-focus-panel-heading">
            <p className="section-kicker">RECENT ORIGINALS</p>
            <span>{sources.length}</span>
          </div>
          <h3 id="originals-title">What this is based on</h3>
          {recentSources.length ? (
            <ul className="project-source-list">
              {recentSources.map((source, index) => (
                <li key={source.id}>
                  <button
                    type="button"
                    aria-label={"Open recent original " + (index + 1)}
                    aria-describedby={"recent-original-" + source.id}
                    onClick={() => onOpenSource(source.id)}
                  >
                    <span id={"recent-original-" + source.id}>
                      Original · {source.title}
                    </span>
                    <small aria-hidden="true">
                      {new Date(source.captured_at).toLocaleDateString()} · v
                      {source.version}
                    </small>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="project-focus-empty">
              <p>Nothing saved here yet.</p>
              <span>Add the first note, conversation, or unfinished idea.</span>
            </div>
          )}
        </section>
      </div>
    </section>
  );
}
