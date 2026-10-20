export type ProactiveGoalState =
  "choose" | "selected" | "preparing" | "watching" | "paused";

export function ProactiveGoal({
  state,
  goalTitle,
  projectTitle,
  stayAhead,
  workerOnline,
  onChoose,
  onPrepare,
  onEnableStayAhead,
  onResume,
  onViewGoal,
}: {
  state: ProactiveGoalState;
  goalTitle?: string;
  projectTitle: string;
  stayAhead: boolean;
  workerOnline: boolean;
  onChoose: () => void;
  onPrepare: () => void;
  onEnableStayAhead: () => void;
  onResume: () => void;
  onViewGoal: () => void;
}) {
  const title =
    state === "choose"
      ? "What should BiBrain help you move forward?"
      : state === "preparing"
        ? "Preparing one useful review."
        : state === "paused"
          ? "This goal is paused."
          : stayAhead
            ? "BiBrain is keeping this goal in view."
            : "Your goal is chosen. You stay in control.";

  const detail =
    state === "choose"
      ? "Choose one outcome. BiBrain will use only the saved work in that project and will ask before changing anything."
      : state === "preparing"
        ? workerOnline
          ? "Your originals are safe while BiBrain checks the selected project. A source-linked suggestion will appear only if there is enough evidence."
          : "The request is safely queued. It will continue when preparation is available."
        : state === "paused"
          ? "Nothing is being prepared for it. Resume only when this outcome matters again."
          : stayAhead
            ? "BiBrain will stay quiet unless selected evidence produces something worth your review."
            : "Request one review now, or turn on Stay ahead when you want quiet background preparation.";

  return (
    <section
      className="proactive-goal"
      data-ui="proactive-goal"
      data-state={state}
      aria-labelledby="proactive-goal-title"
    >
      <div className="proactive-goal-copy">
        <p className="section-kicker">STAY AHEAD</p>
        <h2 id="proactive-goal-title">{title}</h2>
        <p>{detail}</p>
      </div>

      {goalTitle ? (
        <div className="proactive-goal-selection">
          <span>Chosen goal · {projectTitle}</span>
          <strong>{goalTitle}</strong>
        </div>
      ) : null}

      <div className="proactive-goal-actions">
        {state === "choose" ? (
          <button type="button" className="primary" onClick={onChoose}>
            Choose a goal
          </button>
        ) : state === "selected" ? (
          <button type="button" className="primary" onClick={onPrepare}>
            Prepare a first review
          </button>
        ) : state === "paused" ? (
          <button type="button" className="primary" onClick={onResume}>
            Resume this goal
          </button>
        ) : state === "preparing" ? (
          <span className="proactive-goal-status" role="status">
            {workerOnline ? "Preparing now" : "Waiting safely"}
          </span>
        ) : stayAhead ? (
          <button type="button" onClick={onPrepare}>
            Check this goal now
          </button>
        ) : (
          <button type="button" className="primary" onClick={onEnableStayAhead}>
            Turn on Stay ahead
          </button>
        )}

        {state !== "choose" && state !== "preparing" ? (
          <button type="button" className="link" onClick={onViewGoal}>
            View goal
          </button>
        ) : null}
      </div>
    </section>
  );
}
