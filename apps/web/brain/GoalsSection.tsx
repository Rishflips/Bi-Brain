import type { Entity } from "../../../packages/contracts/index.ts";
import type { GoalActions } from "./types.ts";

type Props = { goals: Entity[]; busy: boolean; projectId: string; actions: GoalActions };

export function GoalsSection({ goals, busy, projectId, actions }: Props) {
  return (
    <section className="tv-section" aria-labelledby="yb-goals-h">
      <div className="tv-section-head">
        <h3 id="yb-goals-h">Goals</h3>
        <button type="button" className="tv-link" onClick={() => actions.choose(projectId)}>
          Choose a goal
        </button>
      </div>
      {goals.length === 0 ? (
        <p className="tv-faint">No goal for this project. Goals are optional.</p>
      ) : (
        goals.map((g) => (
          <article key={g.id} className="yb-item">
            <span className="tv-faint">{g.data.status}</span>
            <h4 className="yb-fact">{g.data.title}</h4>
            <p className="yb-fact">{g.data.success_criteria}</p>
            {g.data.plan ? (
              <>
                <h5 className="yb-eyebrow">
                  {g.data.plan_stale
                    ? "Earlier plan · sources changed; review before reuse"
                    : "Current plan · your accepted understanding"}
                </h5>
                <pre className="yb-original">{g.data.plan}</pre>
              </>
            ) : null}
            <div className="tv-actions">
              <label>
                <input
                  type="checkbox"
                  checked={!!g.data.preparation_enabled}
                  disabled={busy}
                  onChange={(e) => actions.setPreparation(g, e.target.checked)}
                />{" "}
                Keep this up to date
              </label>
              <button
                type="button"
                className="tv-btn tv-sm"
                disabled={!g.data.preparation_enabled || g.data.status !== "active"}
                onClick={() => actions.prepare(g)}
              >
                Prepare now
              </button>
              <button type="button" className="tv-btn tv-sm" onClick={() => actions.toggleStatus(g)}>
                {g.data.status === "active" ? "Pause goal" : "Resume goal"}
              </button>
              <button type="button" className="tv-btn tv-sm" onClick={() => actions.editPlan(g)}>
                Edit plan
              </button>
            </div>
          </article>
        ))
      )}
    </section>
  );
}
